// resolveConfig: the bridge's settings from an environment and the entry
// point's flags, with the defaults, every variable, the AGENT_OFFICE_* names
// from before the rename, and the saved floors' legacy folder.

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

test("each AGENT_OFFICE_* variable still works, and its KAUAK_* name wins", () => {
  const old = {
    AGENT_OFFICE_PORT: "8124",
    AGENT_OFFICE_HOST: "::",
    AGENT_OFFICE_ORIGINS: "old.lan",
    AGENT_OFFICE_CONFIG: "/srv/agent-office/machines.json",
    AGENT_OFFICE_SSH: "/opt/ssh",
  };
  const config = resolveConfig(old);
  assert.equal(config.port, 8124);
  assert.equal(config.host, "::");
  assert.deepEqual(config.origins, ["localhost", "127.0.0.1", "[::1]", "old.lan"]);
  assert.equal(config.machinesFile, "/srv/agent-office/machines.json");
  assert.equal(config.sshCommand, "/opt/ssh");

  const both = resolveConfig({
    ...old,
    KAUAK_PORT: "8125",
    KAUAK_HOST: "127.0.0.1",
    KAUAK_ORIGINS: "new.lan",
    KAUAK_CONFIG: "/srv/kauak/machines.json",
    KAUAK_SSH: "ssh",
  });
  assert.equal(both.port, 8125);
  assert.equal(both.host, "127.0.0.1");
  assert.deepEqual(both.origins, ["localhost", "127.0.0.1", "[::1]", "new.lan"]);
  assert.equal(both.machinesFile, "/srv/kauak/machines.json");
  assert.equal(both.sshCommand, "ssh");
});

test("floors saved before the rename are used until the kauak folder has its own", (t) => {
  withHome(t, (home) => {
    const kauak = path.join(home, ".config", "kauak", "machines.json");
    const legacy = path.join(home, ".config", "agent-office", "machines.json");
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, '{ "machines": [] }\n');
    assert.equal(resolveConfig({}).machinesFile, legacy);
    assert.equal(resolveConfig({ KAUAK_CONFIG: "/srv/kauak/floors.json" }).machinesFile, "/srv/kauak/floors.json");
    fs.mkdirSync(path.dirname(kauak), { recursive: true });
    fs.writeFileSync(kauak, '{ "machines": [] }\n');
    assert.equal(resolveConfig({}).machinesFile, kauak);
  });
});

test("the entry point's flags: --port over the environment, and the page's folder", () => {
  const config = resolveConfig({ KAUAK_PORT: "8123", AGENT_OFFICE_PORT: "8124" }, { port: 9001, pageDir: "/opt/kauak/dist" });
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
