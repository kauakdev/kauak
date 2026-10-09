// resolveConfig: the bridge's settings from an environment and the entry
// point's flags, with the defaults and every variable. copyLegacyFloors: the
// floors saved before the rename, copied to the kauak folder once.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { copyLegacyFloors, resolveConfig } from "./config.ts";

/** A throwaway home folder, as HOME for os.homedir() while `fn` runs. */
function withHome(t, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kauak-config-test-"));
  const before = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (before === undefined) delete process.env.HOME;
    else process.env.HOME = before;
    fs.rmSync(home, { recursive: true, force: true });
  });
  return fn(home);
}

test("with nothing set: this computer only, the kauak folder, Herdr's own socket", (t) => {
  withHome(t, (home) => {
    assert.deepEqual(resolveConfig({}), {
      port: 7788,
      host: "127.0.0.1",
      origins: ["localhost", "127.0.0.1", "[::1]"],
      machinesFile: path.join(home, ".config", "kauak", "machines.json"),
      herdrSocket: path.join(home, ".config", "herdr", "herdr.sock"),
      sshCommand: "ssh",
      tunnelDir: path.join(os.tmpdir(), `kauak-${process.getuid?.() ?? "user"}`),
      claudeDir: path.join(home, ".claude"),
      codexDir: path.join(home, ".codex"),
      pageDir: null,
    });
  });
});

test("each variable sets its field", () => {
  const config = resolveConfig({
    KAUAK_PORT: "8123",
    KAUAK_HOST: "0.0.0.0",
    KAUAK_ORIGINS: " office.lan, ,box.local ",
    KAUAK_CONFIG: "/srv/kauak/floors.json",
    HERDR_SOCKET_PATH: "/run/herdr.sock",
    KAUAK_SSH: "/usr/local/bin/ssh",
    CLAUDE_CONFIG_DIR: "/srv/claude",
    CODEX_HOME: "/srv/codex",
  });
  assert.equal(config.port, 8123);
  assert.equal(config.host, "0.0.0.0");
  assert.deepEqual(config.origins, ["localhost", "127.0.0.1", "[::1]", "office.lan", "box.local"]);
  assert.equal(config.machinesFile, "/srv/kauak/floors.json");
  assert.equal(config.herdrSocket, "/run/herdr.sock");
  assert.equal(config.sshCommand, "/usr/local/bin/ssh");
  assert.equal(config.claudeDir, "/srv/claude");
  assert.equal(config.codexDir, "/srv/codex");
  assert.equal(resolveConfig({ HERDR_SOCKET: "/run/old-herdr.sock" }).herdrSocket, "/run/old-herdr.sock");
  assert.equal(resolveConfig({ HERDR_SOCKET_PATH: "/run/herdr.sock", HERDR_SOCKET: "/run/old-herdr.sock" }).herdrSocket, "/run/herdr.sock");
});

test("the AGENT_OFFICE_* names from before the rename are not read", (t) => {
  withHome(t, () => {
    const old = {
      AGENT_OFFICE_PORT: "8124",
      AGENT_OFFICE_HOST: "::",
      AGENT_OFFICE_ORIGINS: "old.lan",
      AGENT_OFFICE_CONFIG: "/srv/agent-office/machines.json",
      AGENT_OFFICE_SSH: "/opt/ssh",
    };
    assert.deepEqual(resolveConfig(old), resolveConfig({}));
  });
});

/** The two places floors are saved under `home`: the kauak folder's, and the one from before the rename. */
function floorFiles(home) {
  return {
    kauak: path.join(home, ".config", "kauak", "machines.json"),
    legacy: path.join(home, ".config", "agent-office", "machines.json"),
  };
}

/** Writes `text` to `file`, making its folder. */
function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** What `fn` logs, line by line, with nothing printed. */
function logged(t, fn) {
  const log = t.mock.method(console, "log", () => {});
  const error = t.mock.method(console, "error", () => {});
  fn();
  const lines = (m) => m.mock.calls.map((c) => c.arguments.join(" "));
  const out = { log: lines(log), error: lines(error) };
  log.mock.restore();
  error.mock.restore();
  return out;
}

const LEGACY_FLOORS = '{ "machines": [ { "id": "devbox", "label": "devbox", "ssh": "devbox" } ] }\n';

test("resolveConfig names the kauak file and copies nothing, even with floors from before the rename", (t) => {
  withHome(t, (home) => {
    const { kauak, legacy } = floorFiles(home);
    write(legacy, LEGACY_FLOORS);
    assert.equal(resolveConfig({}).machinesFile, kauak);
    assert.equal(fs.existsSync(path.join(home, ".config", "kauak")), false);
  });
});

test("floors saved before the rename are copied to the kauak folder once, and the old file is left as it was", (t) => {
  withHome(t, (home) => {
    const { kauak, legacy } = floorFiles(home);
    write(legacy, LEGACY_FLOORS);
    const before = fs.statSync(legacy);

    assert.deepEqual(
      logged(t, () => copyLegacyFloors({})),
      { log: [`[bridge] copied the saved floors from ${legacy} to ${kauak}; the old file is left as it was`], error: [] },
    );
    assert.equal(fs.readFileSync(kauak, "utf8"), LEGACY_FLOORS);
    assert.equal(fs.readFileSync(legacy, "utf8"), LEGACY_FLOORS);
    assert.equal(fs.statSync(legacy).mtimeMs, before.mtimeMs);
    assert.deepEqual(fs.readdirSync(path.dirname(legacy)), ["machines.json"]);
    assert.equal(resolveConfig({}).machinesFile, kauak);

    // Started again, after an older version saved a floor in the old file: nothing is copied or said.
    fs.writeFileSync(legacy, '{ "machines": [] }\n');
    assert.deepEqual(
      logged(t, () => copyLegacyFloors({})),
      { log: [], error: [] },
    );
    assert.equal(fs.readFileSync(kauak, "utf8"), LEGACY_FLOORS);
  });
});

test("a kauak file that exists is never overwritten", (t) => {
  withHome(t, (home) => {
    const { kauak, legacy } = floorFiles(home);
    write(legacy, LEGACY_FLOORS);
    write(kauak, '{ "machines": [] }\n');
    assert.deepEqual(
      logged(t, () => copyLegacyFloors({})),
      { log: [], error: [] },
    );
    assert.equal(fs.readFileSync(kauak, "utf8"), '{ "machines": [] }\n');
    assert.equal(fs.readFileSync(legacy, "utf8"), LEGACY_FLOORS);
  });
});

test("with KAUAK_CONFIG set, nothing is copied", (t) => {
  withHome(t, (home) => {
    const { legacy } = floorFiles(home);
    write(legacy, LEGACY_FLOORS);
    const env = { KAUAK_CONFIG: path.join(home, "floors.json") };
    assert.deepEqual(
      logged(t, () => copyLegacyFloors(env)),
      { log: [], error: [] },
    );
    assert.equal(fs.existsSync(env.KAUAK_CONFIG), false);
    assert.equal(fs.existsSync(path.join(home, ".config", "kauak")), false);
    assert.equal(resolveConfig(env).machinesFile, env.KAUAK_CONFIG);
  });
});

test("a copy that fails says why in one line, and the bridge goes on with the kauak file, as a fresh install", (t) => {
  const failures = {
    "the kauak folder cannot be made": ({ kauak }) => write(path.dirname(kauak), "a file, not a folder"),
    "the old file is a folder": ({ legacy }) => {
      fs.rmSync(legacy);
      fs.mkdirSync(legacy);
    },
    // root reads any file, so the old file's permissions stop only another user.
    ...(process.getuid?.() !== 0 && { "the old file cannot be read": ({ legacy }) => fs.chmodSync(legacy, 0) }),
  };
  for (const [why, fail] of Object.entries(failures)) {
    withHome(t, (home) => {
      const files = floorFiles(home);
      write(files.legacy, LEGACY_FLOORS);
      fail(files);
      const out = logged(t, () => copyLegacyFloors({}));
      assert.deepEqual(out.log, [], why);
      assert.equal(out.error.length, 1, why);
      assert.match(out.error[0], /^\[bridge\] could not copy the saved floors from .+: \w+: /, why);
      assert.ok(out.error[0].includes(files.legacy) && out.error[0].includes(files.kauak), why);
      assert.equal(fs.existsSync(files.kauak), false, why);
      assert.equal(resolveConfig({}).machinesFile, files.kauak, why);
    });
  }
});

test("the entry point's flags: --port over the environment, and the page's folder", () => {
  const config = resolveConfig({ KAUAK_PORT: "8123" }, { port: 9001, pageDir: "/opt/kauak/dist" });
  assert.equal(config.port, 9001);
  assert.equal(config.pageDir, "/opt/kauak/dist");
  assert.equal(resolveConfig({ KAUAK_PORT: "8123" }, {}).port, 8123);
});

test("the config is frozen, origins included, and the environment is only read", () => {
  const env = Object.freeze({ KAUAK_ORIGINS: "office.lan" });
  const config = resolveConfig(env);
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.origins));
  assert.throws(() => {
    config.port = 1;
  }, TypeError);
  assert.throws(() => config.origins.push("evil.example"), TypeError);
  assert.deepEqual(env, { KAUAK_ORIGINS: "office.lan" });
});
