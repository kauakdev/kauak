// Bridge between Herdr servers and browser WebSocket clients.
//
// Each Herdr server is a floor of the office: this machine is always floor 1,
// and remote machines (reached over SSH, see machine.js) are saved in
// ~/.config/agent-office/machines.json. The bridge keeps things simple and
// robust: on every Herdr event it re-fetches that machine's full
// `session.snapshot` (a few KB) and broadcasts it to all clients.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { LOCAL_SOCKET, Machine } from "./machine.js";

const WS_PORT = Number(process.env.AGENT_OFFICE_PORT ?? 7788);
// The bridge can type into terminals and open SSH connections, so by default
// only this computer may connect, and only pages served from it.
const WS_HOST = process.env.AGENT_OFFICE_HOST ?? "127.0.0.1";
const ALLOWED_ORIGIN_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]",
  ...(process.env.AGENT_OFFICE_ORIGINS ?? "").split(",").map((h) => h.trim()).filter(Boolean)]);
const CONFIG_PATH = process.env.AGENT_OFFICE_CONFIG ?? path.join(os.homedir(), ".config", "agent-office", "machines.json");
// An SSH destination as typed in the UI: `host`, `user@host` or an alias from
// ~/.ssh/config. Never starting with "-", so it cannot be read as an ssh option.
const SSH_TARGET = /^[A-Za-z0-9_][A-Za-z0-9._@-]{0,127}$/;

// ---------------------------------------------------------------- machines

/** id → Machine, in floor order. */
const machines = new Map();

function loadConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return Array.isArray(cfg.machines) ? cfg.machines : [];
  } catch (err) {
    if (err.code !== "ENOENT") console.error(`[bridge] ignoring ${CONFIG_PATH}: ${err.message}`);
    return [];
  }
}

function saveConfig() {
  const list = [...machines.values()].filter((m) => m.id !== "local").map((m) => m.config);
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ machines: list }, null, 2) + "\n");
}

function addMachine(cfg) {
  const m = new Machine(cfg);
  machines.set(m.id, m);
  m.on("status", () => broadcastMachines());
  m.on("snapshot", (snapshot) => broadcast({ type: "snapshot", machine: m.id, snapshot }));
  m.on("event", (event, data) => broadcast({ type: "event", machine: m.id, event, data }));
  m.start();
  return m;
}

function uniqueId(base) {
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "machine";
  let id = slug, n = 2;
  while (machines.has(id)) id = `${slug}-${n++}`;
  return id;
}

addMachine({ id: "local", label: "local", socket: LOCAL_SOCKET });
for (const c of loadConfig()) {
  if (typeof c?.label !== "string" || (c.ssh ? !SSH_TARGET.test(c.ssh) : typeof c.socket !== "string")) {
    console.error(`[bridge] skipping machine in ${CONFIG_PATH}: ${JSON.stringify(c)}`);
    continue;
  }
  addMachine({ ...c, id: typeof c.id === "string" && !machines.has(c.id) ? c.id : uniqueId(c.label) });
}

function machineInfos() {
  return [...machines.values()].map((m) => m.info);
}

// ---------------------------------------------------------------- WS server

const wss = new WebSocketServer({
  host: WS_HOST,
  port: WS_PORT,
  // Browsers let any web page open a WebSocket to 127.0.0.1; only accept our own page.
  verifyClient: ({ origin }) => {
    if (!origin) return true; // not a browser
    try { return ALLOWED_ORIGIN_HOSTS.has(new URL(origin).hostname); } catch { return false; }
  },
});

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) if (client.readyState === 1) client.send(data);
}

function broadcastMachines() {
  broadcast({ type: "machines", machines: machineInfos() });
}

wss.on("connection", (ws) => {
  console.log(`[bridge] client connected (${wss.clients.size})`);
  ws.send(JSON.stringify({ type: "machines", machines: machineInfos() }));
  for (const m of machines.values()) {
    if (m.snapshot) ws.send(JSON.stringify({ type: "snapshot", machine: m.id, snapshot: m.snapshot }));
  }

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "add_machine") {
      const ssh = typeof msg.ssh === "string" ? msg.ssh.trim() : "";
      if (!SSH_TARGET.test(ssh)) {
        ws.send(JSON.stringify({ type: "machine_error", message: "Use an SSH host, user@host, or a Host alias from ~/.ssh/config." }));
        return;
      }
      if ([...machines.values()].some((m) => m.ssh === ssh)) {
        ws.send(JSON.stringify({ type: "machine_error", message: `${ssh} already has a floor.` }));
        return;
      }
      const label = (typeof msg.label === "string" && msg.label.trim()) || ssh.split("@").pop();
      const m = addMachine({ id: uniqueId(label), label: label.slice(0, 40), ssh });
      saveConfig();
      broadcastMachines();
      ws.send(JSON.stringify({ type: "machine_added", machine: m.id }));
      return;
    }
    if (msg.type === "remove_machine") {
      const m = machines.get(msg.machine);
      if (!m || m.id === "local") return;
      m.stop();
      machines.delete(m.id);
      saveConfig();
      broadcastMachines();
      return;
    }

    const m = machines.get(msg.machine);
    if (!m) return;
    if (msg.type === "focus" && typeof msg.pane_id === "string") {
      try {
        await m.request("pane.focus", { pane_id: msg.pane_id });
      } catch (err) {
        ws.send(JSON.stringify({ type: "error", machine: m.id, message: err.message }));
      }
    } else if (msg.type === "read" && typeof msg.pane_id === "string") {
      // Terminal view. `visible` = the pane's rendered viewport. Reads run in
      // parallel (each Herdr request takes ~100 ms); `seq` is echoed so the
      // client can drop replies that arrive out of order.
      try {
        const res = await m.request("pane.read", {
          pane_id: msg.pane_id,
          source: msg.source ?? "visible",
          format: "ansi",
          strip_ansi: false,
          lines: msg.lines ?? null,
        });
        ws.send(JSON.stringify({
          type: "pane_output",
          machine: m.id,
          pane_id: msg.pane_id,
          text: res.read.text,
          revision: res.read.revision,
          truncated: res.read.truncated,
          seq: typeof msg.seq === "number" ? msg.seq : undefined,
        }));
      } catch (err) {
        ws.send(JSON.stringify({ type: "error", machine: m.id, pane_id: msg.pane_id, message: err.message }));
      }
    } else if (msg.type === "input" && typeof msg.pane_id === "string" && Array.isArray(msg.ops)) {
      // Keystrokes from the browser terminal. `ops` is an ordered list of
      // { text } (literal bytes, pane.send_text) and { keys } (named keys such
      // as "enter" or "ctrl+c", pane.send_keys).
      queueInput(ws, m, msg.pane_id, msg.ops.slice(0, MAX_INPUT_OPS), typeof msg.id === "number" ? msg.id : undefined);
    } else if (msg.type === "refresh") {
      m.scheduleRefresh();
    }
  });
});

// Input is serialized per pane so fast typing cannot reorder across
// connections. Every Herdr request takes ~100 ms, so keystrokes that arrive
// while a batch is in flight are merged into the next one ("hello" typed fast
// becomes one send_text). `input_ack` carries the id of the last message sent.
const MAX_INPUT_OPS = 256;
const MAX_INPUT_TEXT = 64 * 1024;
const MAX_KEYS_PER_CALL = 64;
const inputQueues = new Map();  // "machine/pane" → promise chain
const openBatches = new Map();  // "machine/pane" → batch still waiting for its turn

function enqueueInput(key, job) {
  const prev = inputQueues.get(key) ?? Promise.resolve();
  const next = prev.then(job, job).finally(() => { if (inputQueues.get(key) === next) inputQueues.delete(key); });
  inputQueues.set(key, next);
}

function queueInput(ws, machine, paneId, ops, id) {
  const key = `${machine.id}/${paneId}`;
  let batch = openBatches.get(key);
  if (!batch || batch.ws !== ws) {
    batch = { ws, ops: [], id };
    openBatches.set(key, batch);
    const b = batch;
    enqueueInput(key, async () => {
      if (openBatches.get(key) === b) openBatches.delete(key); // closed to merging once it runs
      try {
        for (const op of b.ops) {
          if ("text" in op) await machine.request("pane.send_text", { pane_id: paneId, text: op.text });
          else for (let i = 0; i < op.keys.length; i += MAX_KEYS_PER_CALL) {
            await machine.request("pane.send_keys", { pane_id: paneId, keys: op.keys.slice(i, i + MAX_KEYS_PER_CALL) });
          }
        }
        b.ws.send(JSON.stringify({ type: "input_ack", machine: machine.id, pane_id: paneId, id: b.id }));
      } catch (err) {
        b.ws.send(JSON.stringify({ type: "error", machine: machine.id, pane_id: paneId, id: b.id, message: err.message }));
      }
    });
  }
  batch.id = id;
  for (const op of ops) {
    const last = batch.ops[batch.ops.length - 1];
    if (typeof op?.text === "string" && op.text.length > 0) {
      const text = op.text.slice(0, MAX_INPUT_TEXT);
      if (last && "text" in last && last.text.length + text.length <= MAX_INPUT_TEXT) last.text += text;
      else batch.ops.push({ text });
    } else if (Array.isArray(op?.keys)) {
      const keys = op.keys.filter((k) => typeof k === "string" && k.length > 0 && k.length <= 24);
      if (!keys.length) continue;
      if (last && "keys" in last) last.keys.push(...keys);
      else batch.ops.push({ keys });
    }
  }
}

// ---------------------------------------------------------------- shutdown

// SSH tunnels are child processes; take them down with the bridge.
function shutdown() {
  for (const m of machines.values()) m.stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", () => { for (const m of machines.values()) m.stop(); });

console.log(`[bridge] websocket listening on ws://${WS_HOST}:${WS_PORT} · ${machines.size} floor${machines.size === 1 ? "" : "s"} (${CONFIG_PATH})`);
