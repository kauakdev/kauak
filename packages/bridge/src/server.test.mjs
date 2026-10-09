// The bridge as a page sees it: the real server.ts, started in this process
// with createBridge against a fake Herdr (fixtures/fake-herdr.mjs), with a
// WebSocket client in the page's place. What crosses the WebSocket must be
// the Kauak protocol and nothing of Herdr's. main.ts, which runs the bridge as
// a process of its own, is started as one.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { resolveConfig } from "./config.ts";
import { FIXTURE, fakeHerdr, herdrError } from "./fixtures/fake-herdr.mjs";
import { toSnapshot } from "./herdr.ts";
import { createBridge } from "./server.ts";

// Every message type the bridge may send (BridgeMessage in @kauak/protocol).
const BRIDGE_TYPES = new Set([
  "machines",
  "machine_added",
  "machine_error",
  "snapshot",
  "prints",
  "print",
  "uncommitted",
  "pane_output",
  "input_ack",
  "commands",
  "created",
  "create_error",
  "error",
]);
// Herdr's names, which must never reach a page (`truncated` is not one: printer sheets have their own).
const HERDR_FIELDS = [
  "terminal_id",
  "terminal_title",
  "terminal_title_stripped",
  "foreground_cwd",
  "tab_id",
  "tabs",
  "layouts",
  "scroll",
  "worktree",
  "repo_key",
  "checkout_path",
  "agent_session",
  "revision",
  "protocol",
  "event",
  "agents",
  "active_tab_id",
];

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

/** The settings for a bridge on a free port, with this floor only, and nothing read from the user's own config or agents. */
async function testEnv(t, herdrSocket) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kauak-bridge-test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const port = await freePort();
  const env = {
    KAUAK_PORT: String(port),
    KAUAK_HOST: "127.0.0.1",
    HERDR_SOCKET_PATH: herdrSocket,
    KAUAK_CONFIG: path.join(home, "machines.json"),
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    CODEX_HOME: path.join(home, ".codex"),
  };
  return { home, env, url: `ws://127.0.0.1:${port}` };
}

/** The bridge, in this process, until the test ends. */
async function startBridge(t, herdr) {
  const { env, url } = await testEnv(t, herdr.socketPath);
  const bridge = createBridge(resolveConfig(env));
  t.after(() => bridge.close());
  await bridge.listen();
  return url;
}

/** A page's connection: every message it got, and a way to wait for the next one that matches. */
async function connect(t, url) {
  const ws = new WebSocket(url);
  const got = [];
  ws.on("message", (data) => got.push(JSON.parse(data.toString())));
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  t.after(() => ws.close());
  return {
    got,
    send: (msg) => ws.send(JSON.stringify(msg)),
    next: (match) =>
      waitFor(
        () => got.find(match),
        () => `no matching message; got ${JSON.stringify(got.map((m) => m.type))}`,
      ),
  };
}

async function waitFor(check, why, ms = 5000) {
  for (const until = Date.now() + ms; Date.now() < until; await new Promise((r) => setTimeout(r, 20))) {
    const v = check();
    if (v) return v;
  }
  throw new Error(why());
}

function assertKauak(msg) {
  assert.ok(BRIDGE_TYPES.has(msg.type), `unknown message type ${msg.type}`);
  const keys = new Set();
  JSON.stringify(msg, (k, v) => {
    keys.add(k);
    return v;
  });
  for (const f of HERDR_FIELDS) assert.ok(!keys.has(f), `"${f}" reached the page in ${JSON.stringify(msg)}`);
}

test("a page gets the floors and their snapshots in the Kauak protocol", async (t) => {
  const herdr = await fakeHerdr();
  t.after(() => herdr.close());
  const page = await connect(t, await startBridge(t, herdr));

  const machines = await page.next((m) => m.type === "machines" && m.machines[0]?.state === "live");
  assert.deepEqual(machines.machines, [
    { id: "local", label: "local", ssh: null, state: "live", message: "", runtime: { name: "Herdr", version: "0.9.3" } },
  ]);
  const snapshot = await page.next((m) => m.type === "snapshot");
  assert.equal(snapshot.machine, "local");
  assert.deepEqual(snapshot.snapshot, toSnapshot(FIXTURE));

  // A Herdr event is not passed on: it comes out as a fresh snapshot.
  herdr.snapshot = structuredClone(FIXTURE);
  herdr.snapshot.panes[2].agent_status = "done";
  herdr.emit("pane.updated", { pane_id: "w2:p1" });
  await page.next((m) => m.type === "snapshot" && m.snapshot.panes[2].agent_status === "done");
  for (const msg of page.got) assertKauak(msg);
});

test("a page's requests reach Herdr as Herdr requests, and only Kauak comes back", async (t) => {
  const herdr = await fakeHerdr({
    handlers: {
      "pane.read": (p) => ({
        read: {
          pane_id: p.pane_id,
          workspace_id: "w1",
          tab_id: "w1:t1",
          source: p.source,
          format: "ansi",
          text: "$ ls\r\nREADME.md",
          revision: 3,
          truncated: false,
        },
      }),
      "pane.focus": (p) => {
        if (p.pane_id !== "w1:p1") throw herdrError("pane_not_found", `pane ${p.pane_id} not found`);
        return {};
      },
      "tab.create": () => ({ root_pane: { pane_id: "w1:p9" } }),
      "agent.start": () => {
        throw herdrError("agent_not_ready", "agent did not become ready");
      },
    },
  });
  t.after(() => herdr.close());
  const page = await connect(t, await startBridge(t, herdr));
  await page.next((m) => m.type === "snapshot");

  page.send({ type: "read", machine: "local", pane_id: "w1:p1", lines: 1040, seq: 7 });
  const out = await page.next((m) => m.type === "pane_output");
  assert.deepEqual(out, { type: "pane_output", machine: "local", pane_id: "w1:p1", text: "$ ls\r\nREADME.md", seq: 7 });
  assert.deepEqual(herdr.calls("pane.read"), [{ pane_id: "w1:p1", source: "recent", format: "ansi", strip_ansi: false, lines: 1040 }]);

  page.send({ type: "input", machine: "local", pane_id: "w1:p1", ops: [{ text: "ls" }, { keys: ["enter", "not-a-key"] }], id: 3 });
  assert.deepEqual(await page.next((m) => m.type === "input_ack"), { type: "input_ack", machine: "local", pane_id: "w1:p1", id: 3 });
  assert.deepEqual(herdr.calls("pane.send_text"), [{ pane_id: "w1:p1", text: "ls" }]);
  assert.deepEqual(herdr.calls("pane.send_keys"), [{ pane_id: "w1:p1", keys: ["enter"] }]);

  page.send({ type: "focus", machine: "local", pane_id: "w3:p9" });
  assert.deepEqual(await page.next((m) => m.type === "error"), { type: "error", machine: "local", message: "pane w3:p9 not found" });

  page.send({ type: "create_desk", machine: "local", workspace_id: "w1", agent: "claude", id: 1 });
  assert.deepEqual(await page.next((m) => m.type === "created"), { type: "created", machine: "local", id: 1, pane_id: "w1:p9" });
  const failed = await page.next((m) => m.type === "create_error");
  assert.deepEqual(failed, {
    type: "create_error",
    machine: "local",
    id: 1,
    pane_id: "w1:p9",
    message: "The desk is ready, but claude did not start: agent did not become ready",
  });

  page.send({ type: "create_room", machine: "local", room: { kind: "folder", cwd: "/nonexistent/kauak-test" }, agent: null, id: 2 });
  assert.equal((await page.next((m) => m.type === "create_error" && m.id === 2)).message, "There is no folder at /nonexistent/kauak-test.");
  assert.equal(herdr.calls("workspace.create").length, 0);

  // Herdr's own methods are not something a page can ask for.
  page.send({ method: "pane.send_text", params: { pane_id: "w1:p1", text: "rm -rf /" } });
  page.send({ type: "pane.send_text", machine: "local", pane_id: "w1:p1", text: "rm -rf /" });
  page.send({ type: "refresh", machine: "local" });
  await waitFor(
    () => herdr.calls("session.snapshot").length >= 3,
    () => "no refresh",
  );
  assert.equal(herdr.calls("pane.send_text").length, 1);
  for (const msg of page.got) assertKauak(msg);
});

test("pnpm bridge (main.ts) serves pages, and stops with exit 0 on SIGINT and SIGTERM", { timeout: 20_000 }, async (t) => {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const { home, env, url } = await testEnv(t, "/nonexistent/kauak-test/herdr.sock");
    const child = spawn(process.execPath, [fileURLToPath(new URL("./main.ts", import.meta.url))], {
      env: { PATH: process.env.PATH, HOME: home, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => child.kill("SIGKILL"));
    let log = "";
    child.stdout.on("data", (d) => {
      log += d;
    });
    child.stderr.on("data", (d) => {
      log += d;
    });
    const exit = once(child, "exit");
    await waitFor(
      () => log.includes("websocket listening"),
      () => `the bridge did not start:\n${log}`,
    );
    const page = await connect(t, url);
    const machines = await page.next((m) => m.type === "machines");
    assert.deepEqual(
      machines.machines.map((m) => m.id),
      ["local"],
    );
    child.kill(signal);
    assert.deepEqual(await exit, [0, null], log);
  }
});
