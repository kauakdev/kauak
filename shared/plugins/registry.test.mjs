import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

// Compile the public contracts in isolation; no browser, scene or bridge dependency.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-office-plugin-tests-"));
const compiler = path.resolve("node_modules/typescript/bin/tsc");
const build = spawnSync(process.execPath, [compiler, "shared/plugins/registry.ts", "--outDir", temp, "--module", "commonjs", "--target", "ES2022", "--strict", "--skipLibCheck"], { encoding: "utf8" });
if (build.status !== 0) { fs.rmSync(temp, { recursive: true }); throw new Error(build.stdout + build.stderr); }
const { PluginRegistry, parsePackage, validateManifest, loadPreferences, savePreferences, defaults, resolveAnchor, SETTINGS_KEY, validateBanner } = createRequire(import.meta.url)(path.join(temp, "registry.js"));
const read = name => JSON.parse(fs.readFileSync(path.resolve(name), "utf8"));
const builtins = ["classic", "orbital", "basecamp", "herdr"].map(n => read(`plugins/${n}.json`));
const custom = () => read("docs/plugins/harbor.json");
test.after(() => fs.rmSync(temp, { recursive: true }));

test("included capabilities share one registry while keeping browser and bridge selections independent", () => {
  const r = new PluginRegistry(builtins, [custom()]);
  assert.equal(r.list("office.theme").length, 4);
  assert.equal(r.list("office.characters").length, 3);
  assert.equal(r.resolve("terminal.provider", "agent-office.orbital").plugin.id, "agent-office.herdr");
  assert.equal(r.resolve("office.characters", "example.harbor").fallback, true);
});
test("imports reject incompatible APIs, unknown capabilities, code/URLs and reserved identities", () => {
  for (const change of [
    p => p.schemaVersion = 2, p => p.capabilities["office.theme"].apiVersion = 99,
    p => p.capabilities.actions = {}, p => p.script = "evil.js", p => p.id = "agent-office.classic",
    p => p.capabilities["office.theme"].materials.wood = "url(https://x)",
    p => p.capabilities["terminal.provider"] = builtins[3].capabilities["terminal.provider"],
  ]) { const p = custom(); change(p); assert.throws(() => parsePackage(JSON.stringify(p))); }
  assert.throws(() => parsePackage("{"), /valid JSON/);
  assert.throws(() => parsePackage(" ".repeat(65537)), /64 KB/);
});
test("bounds reject unsafe geometry and invalid animation data before any rendering", () => {
  const p = custom(); p.capabilities["office.theme"].bannerAnchors[0].width = 1000;
  assert.throws(() => validateManifest(p), /width/);
  const c = structuredClone(builtins[1]); c.id = "example.robots";
  c.capabilities["office.characters"].animation.tempo.blocked = -1;
  assert.throws(() => validateManifest(c), /tempo.blocked/);
  assert.throws(() => parsePackage('{"schemaVersion":1,"__proto__":{"script":"x"}}'), /unsupported field/);
});
test("the basecamp templates are accepted for custom packages, and unknown templates are not", () => {
  const p = structuredClone(builtins[2]); p.id = "example.basecamp";
  const v = validateManifest(p);
  assert.equal(v.capabilities["office.theme"].architecture.decor, "alpine");
  assert.equal(v.capabilities["office.theme"].architecture.floorPattern, "planks");
  assert.equal(v.capabilities["office.characters"].model, "climber");
  for (const change of [
    q => q.capabilities["office.characters"].model = "yeti",
    q => q.capabilities["office.theme"].architecture.decor = "arctic",
    q => q.capabilities["office.theme"].architecture.floorPattern = "ice",
  ]) { const q = structuredClone(p); change(q); assert.throws(() => validateManifest(q), /expected/); }
});
test("registry rejects collisions and preserves the default when saved packages fail validation", () => {
  const bad = custom(); bad.capabilities["office.theme"].apiVersion = 2;
  const r = new PluginRegistry(builtins, [bad]);
  assert.equal(r.warnings.length, 1);
  assert.equal(r.resolve("office.theme", bad.id).plugin.id, "agent-office.classic");
  r.register(custom()); assert.throws(() => r.register(custom()), /already installed/);
});
test("preferences round-trip custom packages and banner independently; provider cannot be replaced by storage", () => {
  let raw = null; const storage = { getItem: () => raw, setItem: (_k, v) => raw = v };
  const p = defaults(); p.packages = [custom()]; p.selections["office.theme"] = "example.harbor";
  p.banner = { dataUrl: "data:image/png;base64,aGVsbG8=", name: "Example", width: 200, height: 50, visible: true, anchorId: "entrance", background: "dark" };
  assert.equal(savePreferences(storage, p), null); assert.deepEqual(loadPreferences(storage).value, p);
  p.selections["office.theme"] = "agent-office.orbital"; savePreferences(storage, p);
  assert.deepEqual(loadPreferences(storage).value.banner, p.banner);
  const unsafe = JSON.parse(raw); unsafe.selections["terminal.provider"] = "unknown"; raw = JSON.stringify(unsafe);
  assert.equal(loadPreferences(storage).value.selections["terminal.provider"], "agent-office.herdr");
  const removed = new PluginRegistry(builtins); assert.equal(removed.resolve("office.theme", "example.harbor").fallback, true);
  assert.equal(SETTINGS_KEY, "agent-office.plugins.v1");
});
test("bad local data and blocked/quota storage are recoverable and never report a successful save", () => {
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("quota"); } };
  assert.deepEqual(loadPreferences(broken).value, defaults());
  assert.ok(loadPreferences(broken).warnings.length);
  assert.match(savePreferences(broken, defaults()), /could not save/);
  const p = defaults(); p.packages = [{ script: "bad" }, custom()]; p.banner = { dataUrl: "https://remote/image.png" };
  const recovered = loadPreferences({ getItem: () => JSON.stringify(p) });
  assert.equal(recovered.value.packages.length, 1); assert.equal(recovered.value.banner, null);
  assert.equal(recovered.warnings.length, 2);
});
test("anchors fall back without rewriting a user's preferred location; banner URLs and SVG are rejected", () => {
  const t = builtins[0].capabilities["office.theme"];
  assert.equal(resolveAnchor(t, "entrance").id, "entrance");
  assert.equal(resolveAnchor(t, "missing").id, "entrance");
  for (const dataUrl of ["https://example/image.png", "data:image/svg+xml;base64,PHN2Zz4=", "javascript:alert(1)"])
    assert.throws(() => validateBanner({ dataUrl, name: "x", width: 50, height: 50, anchorId: "entrance", visible: true }));
});
