import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

// Compile the public contracts in isolation; no browser, scene or bridge dependency.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kauak-appearance-tests-"));
const compiler = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const build = spawnSync(
  process.execPath,
  [
    compiler,
    path.join(import.meta.dirname, "registry.ts"),
    "--outDir",
    temp,
    "--module",
    "commonjs",
    "--target",
    "ES2022",
    "--strict",
    "--skipLibCheck",
  ],
  { encoding: "utf8" },
);
if (build.status !== 0) {
  fs.rmSync(temp, { recursive: true });
  throw new Error(build.stdout + build.stderr);
}
const {
  AppearanceRegistry,
  parsePackage,
  validateManifest,
  loadPreferences,
  savePreferences,
  defaults,
  resolveAnchor,
  SETTINGS_KEY,
  LEGACY_SETTINGS_KEY,
  validateBanner,
} = createRequire(import.meta.url)(path.join(temp, "registry.js"));
const read = (name) => JSON.parse(fs.readFileSync(new URL(name, import.meta.url), "utf8"));
const builtins = ["classic", "orbital", "basecamp"].map((n) => read(`../packages/${n}.json`));
const custom = () => read("../../../docs/appearance/harbor.json");
test.after(() => fs.rmSync(temp, { recursive: true }));

test("included and imported packages share one registry, while each capability is listed and resolved on its own", () => {
  const r = new AppearanceRegistry(builtins, [custom()]);
  assert.equal(r.list("office.theme").length, 4);
  assert.equal(r.list("office.characters").length, 3);
  assert.equal(r.resolve("office.characters", "example.harbor").fallback, true);
});
test("imports reject incompatible APIs, unknown capabilities, code/URLs and reserved identities", () => {
  for (const change of [
    (p) => (p.schemaVersion = 2),
    (p) => (p.capabilities["office.theme"].apiVersion = 99),
    (p) => (p.capabilities.actions = {}),
    (p) => (p.script = "evil.js"),
    (p) => (p.id = "kauak.classic"),
    (p) => (p.id = "agent-office.classic"),
    (p) => (p.capabilities["office.theme"].materials.wood = "url(https://x)"),
  ]) {
    const p = custom();
    change(p);
    assert.throws(() => parsePackage(JSON.stringify(p)));
  }
  assert.throws(() => parsePackage("{"), /valid JSON/);
  assert.throws(() => parsePackage(" ".repeat(65537)), /64 KB/);
});
test("bounds reject unsafe geometry and invalid animation data before any rendering", () => {
  const p = custom();
  p.capabilities["office.theme"].bannerAnchors[0].width = 1000;
  assert.throws(() => validateManifest(p), /width/);
  const c = structuredClone(builtins[1]);
  c.id = "example.robots";
  c.capabilities["office.characters"].animation.tempo.blocked = -1;
  assert.throws(() => validateManifest(c), /tempo.blocked/);
  assert.throws(() => parsePackage('{"schemaVersion":1,"__proto__":{"script":"x"}}'), /unsupported field/);
});
test("the basecamp templates are accepted for custom packages, and unknown templates are not", () => {
  const p = structuredClone(builtins[2]);
  p.id = "example.basecamp";
  const v = validateManifest(p);
  assert.equal(v.capabilities["office.theme"].architecture.decor, "alpine");
  assert.equal(v.capabilities["office.theme"].architecture.floorPattern, "planks");
  assert.equal(v.capabilities["office.characters"].model, "climber");
  for (const change of [
    (q) => (q.capabilities["office.characters"].model = "yeti"),
    (q) => (q.capabilities["office.theme"].architecture.decor = "arctic"),
    (q) => (q.capabilities["office.theme"].architecture.floorPattern = "ice"),
  ]) {
    const q = structuredClone(p);
    change(q);
    assert.throws(() => validateManifest(q), /expected/);
  }
});
test("registry rejects collisions and preserves the default when saved packages fail validation", () => {
  const bad = custom();
  bad.capabilities["office.theme"].apiVersion = 2;
  const r = new AppearanceRegistry(builtins, [bad]);
  assert.equal(r.warnings.length, 1);
  assert.equal(r.resolve("office.theme", bad.id).package.id, "kauak.classic");
  r.register(custom());
  assert.throws(() => r.register(custom()), /already installed/);
});
test("preferences round-trip custom packages and banner independently; a saved terminal.provider selection is dropped", () => {
  let raw = null;
  const storage = { getItem: () => raw, setItem: (_k, v) => (raw = v) };
  const p = defaults();
  p.packages = [custom()];
  p.selections["office.theme"] = "example.harbor";
  p.banner = {
    dataUrl: "data:image/png;base64,aGVsbG8=",
    name: "Example",
    width: 200,
    height: 50,
    visible: true,
    anchorId: "entrance",
    background: "dark",
  };
  assert.equal(savePreferences(storage, p), null);
  assert.deepEqual(loadPreferences(storage).value, p);
  p.selections["office.theme"] = "kauak.orbital";
  savePreferences(storage, p);
  assert.deepEqual(loadPreferences(storage).value.banner, p.banner);
  const older = JSON.parse(raw);
  older.selections["terminal.provider"] = "agent-office.herdr";
  raw = JSON.stringify(older);
  assert.deepEqual(loadPreferences(storage), { value: p, warnings: [] });
  const removed = new AppearanceRegistry(builtins);
  assert.equal(removed.resolve("office.theme", "example.harbor").fallback, true);
  assert.equal(SETTINGS_KEY, "kauak.appearance.v1");
});
test("bad local data and blocked/quota storage are recoverable and never report a successful save", () => {
  const broken = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("quota");
    },
  };
  assert.deepEqual(loadPreferences(broken).value, defaults());
  assert.ok(loadPreferences(broken).warnings.length);
  assert.match(savePreferences(broken, defaults()), /could not save/);
  const p = defaults();
  p.packages = [{ script: "bad" }, custom()];
  p.banner = { dataUrl: "https://remote/image.png" };
  const recovered = loadPreferences({ getItem: () => JSON.stringify(p) });
  assert.equal(recovered.value.packages.length, 1);
  assert.equal(recovered.value.banner, null);
  assert.equal(recovered.warnings.length, 2);
});
test("anchors fall back without rewriting a user's preferred location; banner URLs and SVG are rejected", () => {
  const t = builtins[0].capabilities["office.theme"];
  assert.equal(resolveAnchor(t, "entrance").id, "entrance");
  assert.equal(resolveAnchor(t, "missing").id, "entrance");
  for (const dataUrl of ["https://example/image.png", "data:image/svg+xml;base64,PHN2Zz4=", "javascript:alert(1)"])
    assert.throws(() => validateBanner({ dataUrl, name: "x", width: 50, height: 50, anchorId: "entrance", visible: true }));
});

// A localStorage that records the keys read and written.
function memory(items = {}) {
  const store = new Map(Object.entries(items)),
    reads = [],
    writes = [];
  return {
    store,
    reads,
    writes,
    getItem: (k) => {
      reads.push(k);
      return store.get(k) ?? null;
    },
    setItem: (k, v) => {
      writes.push(k);
      store.set(k, v);
    },
  };
}
// Settings as an earlier version saved them, with the imported Harbor office and a banner.
const legacySettings = (selections) =>
  JSON.stringify({
    schemaVersion: 1,
    selections: {
      "office.theme": "example.harbor",
      "office.characters": "agent-office.orbital",
      "terminal.provider": "agent-office.herdr",
      ...selections,
    },
    packages: [custom()],
    banner: {
      dataUrl: "data:image/png;base64,aGVsbG8=",
      name: "Example",
      width: 200,
      height: 50,
      anchorId: "entrance",
      visible: true,
      background: "dark",
    },
  });
test("settings saved before the rename are copied to the new key once, and the old key is left as it was", () => {
  const old = legacySettings(),
    storage = memory({ [LEGACY_SETTINGS_KEY]: old });
  const first = loadPreferences(storage);
  assert.deepEqual(first.warnings, []);
  assert.equal(first.value.packages[0].id, "example.harbor");
  assert.equal(first.value.banner.name, "Example");
  assert.deepEqual(storage.writes, [SETTINGS_KEY]);
  assert.deepEqual(JSON.parse(storage.store.get(SETTINGS_KEY)), first.value);
  assert.equal(storage.store.get(LEGACY_SETTINGS_KEY), old);
  storage.reads.length = 0;
  assert.deepEqual(loadPreferences(storage), first);
  assert.deepEqual(storage.reads, [SETTINGS_KEY]);
  assert.deepEqual(storage.writes, [SETTINGS_KEY]);
});
test("settings under the new key win over the old key, which is then not read, even when they are broken", () => {
  for (const current of [JSON.stringify(defaults()), "{"]) {
    const storage = memory({ [SETTINGS_KEY]: current, [LEGACY_SETTINGS_KEY]: legacySettings() });
    const loaded = loadPreferences(storage);
    assert.deepEqual(loaded.value, defaults());
    assert.equal(loaded.warnings.length, current === "{" ? 1 : 0);
    assert.deepEqual(storage.reads, [SETTINGS_KEY]);
    assert.deepEqual(storage.writes, []);
  }
});
test("broken settings under the old key give the defaults, as broken settings always have, and nothing is written", () => {
  const notSettings = JSON.parse(legacySettings());
  notSettings.selections = "agent-office.orbital";
  for (const old of [
    "{",
    JSON.stringify({ ...JSON.parse(legacySettings()), schemaVersion: 2 }),
    JSON.stringify(notSettings),
    " ".repeat(3_100_000),
  ]) {
    const storage = memory({ [LEGACY_SETTINGS_KEY]: old });
    const loaded = loadPreferences(storage);
    assert.deepEqual(loaded.value, defaults());
    assert.match(loaded.warnings.join(), /could not be read/);
    assert.deepEqual(storage.writes, []);
    assert.equal(storage.store.get(LEGACY_SETTINGS_KEY), old);
  }
});
test("selections of the included packages' old ids are copied with their new ids", () => {
  const storage = memory({
    [LEGACY_SETTINGS_KEY]: legacySettings({ "office.theme": "agent-office.basecamp", "office.characters": "agent-office.classic" }),
  });
  const { value } = loadPreferences(storage);
  assert.deepEqual(value.selections, { "office.theme": "kauak.basecamp", "office.characters": "kauak.classic" });
  const r = new AppearanceRegistry(builtins, value.packages);
  for (const [cap, id] of Object.entries(value.selections))
    assert.deepEqual([r.resolve(cap, id).package.id, r.resolve(cap, id).fallback], [id, false]);
  assert.deepEqual(loadPreferences(memory({ [LEGACY_SETTINGS_KEY]: legacySettings() })).value.selections, {
    "office.theme": "example.harbor",
    "office.characters": "kauak.orbital",
  });
});
test("the terminal.provider selection an earlier version saved is dropped from the copy", () => {
  const storage = memory({ [LEGACY_SETTINGS_KEY]: legacySettings() });
  assert.deepEqual(Object.keys(loadPreferences(storage).value.selections), ["office.theme", "office.characters"]);
  assert.deepEqual(Object.keys(JSON.parse(storage.store.get(SETTINGS_KEY)).selections), ["office.theme", "office.characters"]);
});
test("a copy the browser cannot save still loads, and is tried again on the next load", () => {
  const storage = memory({ [LEGACY_SETTINGS_KEY]: legacySettings() }),
    blocked = {
      getItem: storage.getItem,
      setItem: () => {
        throw new Error("quota");
      },
    };
  const loaded = loadPreferences(blocked);
  assert.deepEqual(loaded.warnings, []);
  assert.equal(loaded.value.selections["office.characters"], "kauak.orbital");
  assert.equal(storage.store.has(SETTINGS_KEY), false);
  assert.deepEqual(loadPreferences(storage), loaded);
  assert.deepEqual(storage.writes, [SETTINGS_KEY]);
});
