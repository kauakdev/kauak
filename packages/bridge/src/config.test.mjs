// resolveConfig: the bridge's settings from an environment and the entry
// point's flags, with the defaults and every variable.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfig } from "./config.ts";

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
      appearanceDir: path.join(home, ".config", "kauak", "appearances"),
      appearanceFiles: [],
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
    KAUAK_APPEARANCES: "/srv/kauak/looks",
  });
  assert.equal(config.port, 8123);
  assert.equal(config.host, "0.0.0.0");
  assert.deepEqual(config.origins, ["localhost", "127.0.0.1", "[::1]", "office.lan", "box.local"]);
  assert.equal(config.machinesFile, "/srv/kauak/floors.json");
  assert.equal(config.herdrSocket, "/run/herdr.sock");
  assert.equal(config.sshCommand, "/usr/local/bin/ssh");
  assert.equal(config.claudeDir, "/srv/claude");
  assert.equal(config.codexDir, "/srv/codex");
  assert.equal(config.appearanceDir, "/srv/kauak/looks");
  assert.equal(resolveConfig({ HERDR_SOCKET: "/run/old-herdr.sock" }).herdrSocket, "/run/old-herdr.sock");
  assert.equal(resolveConfig({ HERDR_SOCKET_PATH: "/run/herdr.sock", HERDR_SOCKET: "/run/old-herdr.sock" }).herdrSocket, "/run/herdr.sock");
});

test("a blank KAUAK_APPEARANCES is unset, not the working folder", (t) => {
  withHome(t, (home) => {
    assert.equal(resolveConfig({ KAUAK_APPEARANCES: "" }).appearanceDir, path.join(home, ".config", "kauak", "appearances"));
  });
});

test("the entry point's flags: --port over the environment, the page's folder and the --appearance files", () => {
  const files = ["/home/me/harbor.json"];
  const config = resolveConfig({ KAUAK_PORT: "8123" }, { port: 9001, pageDir: "/opt/kauak/dist", appearanceFiles: files });
  assert.equal(config.port, 9001);
  assert.equal(config.pageDir, "/opt/kauak/dist");
  assert.deepEqual(config.appearanceFiles, ["/home/me/harbor.json"]);
  assert.ok(Object.isFrozen(config.appearanceFiles));
  files.push("/home/me/other.json");
  assert.deepEqual(config.appearanceFiles, ["/home/me/harbor.json"]);
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
