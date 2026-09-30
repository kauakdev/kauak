// Bridge between Herdr servers and browser WebSocket clients.
//
// Each Herdr server is a floor of the office: this machine is always floor 1,
// and remote machines (reached over SSH, see machine.js) are saved in
// ~/.config/agent-office/machines.json. The bridge keeps things simple and
// robust: on every Herdr event it re-fetches that machine's full
// `session.snapshot` (a few KB) and broadcasts it to all clients.
//
// The same port also serves the built office page (dist/, `pnpm build`), so
// `npx agentoffice` is one process and one URL. `pnpm dev` serves the page
// from Vite instead.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { LOCAL_SOCKET, Machine } from "./machine.js";

const WS_PORT = Number(process.env.AGENT_OFFICE_PORT ?? 7788);
// The bridge can type into terminals, create panes and worktrees, and open SSH
// connections, so by default only this computer may connect, and only pages
// served from it.
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

// ---------------------------------------------------------------- page

const DIST_DIR = fileURLToPath(new URL("../dist/", import.meta.url));
const HAS_PAGE = fs.existsSync(path.join(DIST_DIR, "index.html"));
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2",
};

/** Static files from dist/. Nothing here is secret; the WebSocket is what needs guarding. */
function servePage(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") return res.writeHead(405).end();
  let rel;
  try { rel = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname); } catch { return res.writeHead(400).end(); }
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.resolve(DIST_DIR, "." + rel);
  if (!file.startsWith(DIST_DIR)) return res.writeHead(404).end();
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      return res.end(HAS_PAGE ? "Not found\n" : "The office page is not built. Run `pnpm build`, or `pnpm dev` for the Vite dev server.\n");
    }
    res.writeHead(200, {
      "content-type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
      "content-length": st.size,
      // Vite puts a content hash in every asset name; index.html must always be fresh.
      "cache-control": rel.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
      "x-content-type-options": "nosniff",
    });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

// ---------------------------------------------------------------- WS server

const server = http.createServer(servePage);

const wss = new WebSocketServer({
  server,
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
    } else if (msg.type === "create_desk" || msg.type === "create_room") {
      build(ws, m, msg);
    }
  });
});

// ---------------------------------------------------------------- build mode
//
// New desks (a new tab in a room) and new rooms (a
// workspace in a folder, or a git worktree on a new branch), each with an
// optional agent. `created` goes out as soon as the pane exists, after a fresh
// snapshot, so the page can open it right away; the agent starts afterwards
// (Herdr waits until it is ready, which can take seconds), and a failure
// there is a `create_error` that carries the pane id.

// Agent kinds are Herdr's own names (`herdr agent`), in its agent-name alphabet.
const AGENT_KIND = /^[a-z][a-z0-9_-]{0,31}$/;
// A branch or base as typed in the build form, never starting with "-".
const GIT_REF = /^[A-Za-z0-9_.][A-Za-z0-9_./-]{0,199}$/;

async function build(ws, m, msg) {
  const id = typeof msg.id === "number" ? msg.id : undefined;
  const reply = (o) => ws.send(JSON.stringify({ machine: m.id, id, ...o }));
  const agent = typeof msg.agent === "string" && msg.agent ? msg.agent : null;
  let paneId;
  try {
    if (agent && !AGENT_KIND.test(agent)) throw new Error(`Unknown agent kind "${agent}".`);
    paneId = msg.type === "create_desk" ? await createDesk(m, msg.workspace_id) : await createRoom(m, msg.room);
    await m.refresh();
  } catch (err) {
    reply({ type: "create_error", message: herdrMessage(err) });
    return;
  }
  reply({ type: "created", pane_id: paneId });
  if (!agent) return;
  try {
    await startAgent(m, agent, paneId);
  } catch (err) {
    reply({ type: "create_error", pane_id: paneId, message: `The desk is ready, but ${agent} did not start: ${herdrMessage(err)}` });
  }
}

// A new pane's shell is not "available" to Herdr until its prompt is up
// (verified on 0.9.1: agent.start answers agent_pane_busy for up to ~1 s).
const AGENT_WAIT_MS = 10_000;
const AGENT_RETRY_MS = 300;

async function startAgent(m, kind, paneId) {
  // Agent names must be unique among live agents; the kind plus a random tag is.
  const name = `${kind}-${Math.random().toString(36).slice(2, 6)}`.slice(0, 32);
  for (const started = Date.now(); ; await new Promise((r) => setTimeout(r, AGENT_RETRY_MS))) {
    try {
      return await m.request("agent.start", { name, kind, pane_id: paneId });
    } catch (err) {
      if (!err.message.includes("agent_pane_busy") || Date.now() - started > AGENT_WAIT_MS) throw err;
    }
  }
}

/**
 * A new tab in the room, in the room's folder. Returns its pane's id. A tab
 * rather than a split: a split pane gets only part of the Herdr window, and
 * the side panel mirrors a pane at its real size, so a desk split off another
 * came out as a narrow strip with the rest of the panel empty.
 */
async function createDesk(m, workspaceId) {
  const snap = m.snapshot;
  const room = snap?.workspaces.find((w) => w.workspace_id === workspaceId);
  if (!room) throw new Error("That room is gone.");
  const panes = snap.panes.filter((p) => p.workspace_id === room.workspace_id);
  const cwd = room.worktree?.checkout_path ?? (panes.find((p) => p.tab_id === room.active_tab_id) ?? panes[0])?.cwd ?? null;
  const res = await m.request("tab.create", { workspace_id: room.workspace_id, cwd, focus: false });
  return res.root_pane.pane_id;
}

/** A workspace in a folder, or a git worktree on a new branch. Returns its first pane's id. */
async function createRoom(m, room) {
  if (room?.kind !== "worktree" && room?.kind !== "folder") throw new Error("Pick a git branch or a folder.");
  const cwd = roomPath(m, room.cwd);
  const label = typeof room.label === "string" && room.label.trim() ? room.label.trim().slice(0, 60) : null;
  if (room.kind === "worktree") {
    const branch = typeof room.branch === "string" ? room.branch.trim() : "";
    const base = typeof room.base === "string" ? room.base.trim() : "";
    if (!GIT_REF.test(branch)) throw new Error("Enter a branch name like feat/my-change.");
    if (base && !GIT_REF.test(base)) throw new Error(`"${base}" is not a branch or commit.`);
    const res = await m.request("worktree.create", { cwd, branch, base: base || null, label, focus: false });
    return res.root_pane.pane_id;
  }
  const res = await m.request("workspace.create", { cwd, label, focus: false });
  return res.root_pane.pane_id;
}

/**
 * The folder a new room opens in. Herdr neither expands `~` nor rejects a
 * missing folder (it opens the home directory instead), so this machine's
 * paths are expanded and checked here; a remote one needs an absolute path.
 */
function roomPath(m, raw) {
  let p = typeof raw === "string" ? raw.trim() : "";
  if (!p || p.length > 1024) throw new Error("Enter a folder.");
  if (!m.ssh && (p === "~" || p.startsWith("~/"))) p = path.join(os.homedir(), p.slice(1));
  if (!p.startsWith("/")) throw new Error(`Use an absolute path${m.ssh ? ` on ${m.label}` : ""}, like /home/you/code/project.`);
  if (!m.ssh && !fs.statSync(p, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`There is no folder at ${p}.`);
  return p;
}

/** Herdr errors read "method: code message"; git ones end with the line that says what went wrong. */
function herdrMessage(err) {
  const text = err.message.replace(/^[\w.]+: [a-z_]+ /, "");
  return text.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? text;
}

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
function shutdown(code = 0) {
  for (const m of machines.values()) m.stop();
  process.exit(code);
}
process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());
process.on("exit", () => { for (const m of machines.values()) m.stop(); });

// ---------------------------------------------------------------- listen

/** Resolves with the office's URL once the port is open (null when dist/ is not built). */
export const ready = new Promise((resolve) => {
  // ws re-emits the HTTP server's errors (EADDRINUSE…) on the WebSocket server.
  wss.once("error", (err) => {
    console.error(err.code === "EADDRINUSE"
      ? `[bridge] port ${WS_PORT} is already in use. Is the office already running? Pick another port with --port or AGENT_OFFICE_PORT.`
      : `[bridge] cannot listen on ${WS_HOST}:${WS_PORT}: ${err.message}`);
    shutdown(1);
  });
  server.listen(WS_PORT, WS_HOST, () => {
    const host = WS_HOST.includes(":") ? `[${WS_HOST}]` : WS_HOST;
    const floors = `${machines.size} floor${machines.size === 1 ? "" : "s"} (${CONFIG_PATH})`;
    console.log(`[bridge] websocket listening on ws://${host}:${WS_PORT} · ${floors}`);
    resolve(HAS_PAGE ? `http://${host === "0.0.0.0" || host === "[::]" ? "127.0.0.1" : host}:${WS_PORT}/` : null);
  });
});
