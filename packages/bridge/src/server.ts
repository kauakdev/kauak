// Bridge between Herdr servers and browser WebSocket clients.
//
// Each Herdr server is a floor of the office: this machine is always floor 1,
// and remote machines (reached over SSH, see machine.ts) are saved in
// ~/.config/kauak/machines.json. The bridge keeps things simple and
// robust: on every Herdr event it re-fetches that machine's full snapshot (a
// few KB) and broadcasts it to all clients, with each agent's context use
// added (see context.ts) and each room's git checkout, whose edits its
// printer prints as they happen (see diffs.ts).
//
// Pages speak the Kauak protocol (@kauak/protocol, docs/protocol.md), and so
// does this file: it knows a floor only through its Machine (machine.ts, the
// Herdr adapter), never Herdr's methods, fields or errors.
//
// The same port also serves the built office page (dist/, `pnpm build`), so
// `npx kauak serve` is one process and one URL. `pnpm dev` serves the page
// from Vite instead.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_KIND,
  type ClientMessage,
  GIT_REF,
  type InputOp,
  MAX_INPUT_TEXT,
  type RoomSpec,
  SSH_TARGET,
  parseClientMessage,
} from "@kauak/protocol";
import { type WebSocket, WebSocketServer } from "ws";
import { slashCommands } from "./commands.ts";
import { ContextTracker } from "./context.ts";
import { DiffTracker } from "./diffs.ts";
import { LOCAL_SOCKET, Machine, type MachineConfig } from "./machine.ts";

const WS_PORT = Number(process.env.KAUAK_PORT ?? process.env.AGENT_OFFICE_PORT ?? 7788);
// The bridge can type into terminals, create panes and worktrees, and open SSH
// connections, so by default only this computer may connect, and only pages
// served from it.
const WS_HOST = process.env.KAUAK_HOST ?? process.env.AGENT_OFFICE_HOST ?? "127.0.0.1";
const ALLOWED_ORIGIN_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  ...(process.env.KAUAK_ORIGINS ?? process.env.AGENT_OFFICE_ORIGINS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean),
]);
const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".config", "kauak", "machines.json");
const LEGACY_CONFIG_PATH = path.join(os.homedir(), ".config", "agent-office", "machines.json");
// Reuse existing floors after the rename; fresh installs use the kauak directory.
const CONFIG_PATH =
  process.env.KAUAK_CONFIG ??
  process.env.AGENT_OFFICE_CONFIG ??
  (!fs.existsSync(DEFAULT_CONFIG_PATH) && fs.existsSync(LEGACY_CONFIG_PATH) ? LEGACY_CONFIG_PATH : DEFAULT_CONFIG_PATH);

// ---------------------------------------------------------------- machines

/** id → Machine, in floor order. */
const machines = new Map<string, Machine>();
/** id → ContextTracker */
const contexts = new Map<string, ContextTracker>();
/** id → DiffTracker */
const diffs = new Map<string, DiffTracker>();

/** The saved floors, as saveConfig writes them; each is checked before it is used. */
function loadConfig(): MachineConfig[] {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return Array.isArray(cfg.machines) ? cfg.machines : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error(`[bridge] ignoring ${CONFIG_PATH}: ${(err as Error).message}`);
    return [];
  }
}

function saveConfig() {
  const list = [...machines.values()].filter((m) => m.id !== "local").map((m) => m.config);
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify({ machines: list }, null, 2)}\n`);
}

function addMachine(cfg: MachineConfig) {
  const m = new Machine(cfg);
  machines.set(m.id, m);
  const c = new ContextTracker(m);
  contexts.set(m.id, c);
  c.on("change", () => broadcast(snapshotMessage(m)));
  const d = new DiffTracker(m);
  diffs.set(m.id, d);
  d.on("change", () => broadcast(snapshotMessage(m)));
  d.on("print", (sheet) => broadcast({ type: "print", machine: m.id, sheet }));
  m.on("status", () => broadcastMachines());
  m.on("snapshot", () => broadcast(snapshotMessage(m)));
  m.start();
  return m;
}

function uniqueId(base: string) {
  const slug =
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "machine";
  let id = slug,
    n = 2;
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

function snapshotMessage(m: Machine) {
  const snapshot = contexts.get(m.id)?.annotate(m.snapshot) ?? m.snapshot;
  return { type: "snapshot", machine: m.id, snapshot: diffs.get(m.id)?.annotate(snapshot) ?? snapshot };
}

// ---------------------------------------------------------------- page

// In the npm package the page is beside the bridge's copy (dist/); in a checkout the bridge runs
// from packages/bridge/src and the page is built into packages/kauak/dist.
const DIST_DIRS = [new URL("../dist/", import.meta.url), new URL("../../kauak/dist/", import.meta.url)].map((u) => fileURLToPath(u));
const DIST_DIR = DIST_DIRS.find((d) => fs.existsSync(path.join(d, "index.html"))) ?? DIST_DIRS[0]!;
const HAS_PAGE = fs.existsSync(path.join(DIST_DIR, "index.html"));
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

/** Static files from dist/. Nothing here is secret; the WebSocket is what needs guarding. */
function servePage(req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.method !== "GET" && req.method !== "HEAD") return res.writeHead(405).end();
  let rel: string;
  try {
    rel = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  } catch {
    return res.writeHead(400).end();
  }
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.resolve(DIST_DIR, `.${rel}`);
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
  verifyClient: ({ origin }: { origin: string }) => {
    if (!origin) return true; // not a browser
    try {
      return ALLOWED_ORIGIN_HOSTS.has(new URL(origin).hostname);
    } catch {
      return false;
    }
  },
});

function broadcast(msg: object) {
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
    if (m.snapshot) ws.send(JSON.stringify(snapshotMessage(m)));
    ws.send(JSON.stringify({ type: "prints", machine: m.id, sheets: diffs.get(m.id)?.history() ?? [] }));
  }

  ws.on("message", async (raw) => {
    let msg: ClientMessage | null;
    try {
      msg = parseClientMessage(JSON.parse(raw.toString()));
    } catch {
      return;
    }
    if (!msg) return;

    if (msg.type === "add_machine") {
      const ssh = msg.ssh;
      if (!SSH_TARGET.test(ssh)) {
        ws.send(JSON.stringify({ type: "machine_error", message: "Use an SSH host, user@host, or a Host alias from ~/.ssh/config." }));
        return;
      }
      if ([...machines.values()].some((m) => m.ssh === ssh)) {
        ws.send(JSON.stringify({ type: "machine_error", message: `${ssh} already has a floor.` }));
        return;
      }
      const label = msg.label || ssh.split("@").pop()!;
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
      contexts.get(m.id)?.stop();
      contexts.delete(m.id);
      diffs.get(m.id)?.stop();
      diffs.delete(m.id);
      machines.delete(m.id);
      saveConfig();
      broadcastMachines();
      return;
    }

    const m = machines.get(msg.machine);
    if (!m) return;
    if (msg.type === "focus") {
      try {
        await m.focusPane(msg.pane_id);
      } catch (err) {
        ws.send(JSON.stringify({ type: "error", machine: m.id, message: (err as Error).message }));
      }
    } else if (msg.type === "read") {
      // Terminal view: the pane's screen, or with `lines` the last `lines`
      // rows of its history and screen. Reads run in parallel (each Herdr
      // request takes ~100 ms); `seq` is echoed so the client can drop
      // replies that arrive out of order.
      try {
        const text = await m.readPane(msg.pane_id, msg.lines);
        ws.send(JSON.stringify({ type: "pane_output", machine: m.id, pane_id: msg.pane_id, text, seq: msg.seq }));
      } catch (err) {
        ws.send(JSON.stringify({ type: "error", machine: m.id, pane_id: msg.pane_id, message: (err as Error).message }));
      }
    } else if (msg.type === "input") {
      // Keystrokes from the browser terminal. `ops` is an ordered list of
      // { text } (literal bytes) and { keys } (named keys such as "enter" or
      // "ctrl+c").
      queueInput(ws, m, msg.pane_id, msg.ops, msg.id);
    } else if (msg.type === "commands") {
      // The message box's "/" menu. The agent and its folder come from the
      // snapshot, not the page; only this machine's files are read.
      const pane = m.snapshot?.panes.find((p) => p.pane_id === msg.pane_id);
      if (!pane) return;
      const commands = await slashCommands(pane.agent, pane.cwd, !m.ssh);
      ws.send(JSON.stringify({ type: "commands", machine: m.id, pane_id: msg.pane_id, agent: pane.agent, commands }));
    } else if (msg.type === "uncommitted") {
      // A printer's uncommitted view. Only checkouts a room is in are read (diffs.ts).
      const reply = (o: object) => ws.send(JSON.stringify({ type: "uncommitted", machine: m.id, root: msg.root, id: msg.id, ...o }));
      reply(await diffs.get(m.id)!.uncommitted(msg.root));
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

async function build(ws: WebSocket, m: Machine, msg: Extract<ClientMessage, { type: "create_desk" | "create_room" }>) {
  const reply = (o: object) => ws.send(JSON.stringify({ machine: m.id, id: msg.id, ...o }));
  const agent = msg.agent;
  let paneId: string;
  try {
    if (agent && !AGENT_KIND.test(agent)) throw new Error(`Unknown agent kind "${agent}".`);
    paneId = msg.type === "create_desk" ? await m.createDesk(msg.workspace_id) : await m.createRoom(roomSpec(m, msg.room));
    await m.refresh();
  } catch (err) {
    reply({ type: "create_error", message: (err as Error).message });
    return;
  }
  reply({ type: "created", pane_id: paneId });
  if (!agent) return;
  try {
    await m.startAgent(agent, paneId);
  } catch (err) {
    reply({ type: "create_error", pane_id: paneId, message: `The desk is ready, but ${agent} did not start: ${(err as Error).message}` });
  }
}

/** A room from the build form, checked: its folder (see roomPath), branch, base and label. */
function roomSpec(m: Machine, room: RoomSpec): RoomSpec {
  const cwd = roomPath(m, room.cwd);
  const label = room.label?.trim() ? room.label.trim().slice(0, 60) : undefined;
  if (room.kind === "folder") return { kind: "folder", cwd, label };
  const branch = room.branch.trim();
  const base = room.base?.trim() || undefined;
  if (!GIT_REF.test(branch)) throw new Error("Enter a branch name like feat/my-change.");
  if (base && !GIT_REF.test(base)) throw new Error(`"${base}" is not a branch or commit.`);
  return { kind: "worktree", cwd, branch, base, label };
}

/**
 * The folder a new room opens in. Herdr neither expands `~` nor rejects a
 * missing folder (it opens the home directory instead), so this machine's
 * paths are expanded and checked here; a remote one needs an absolute path.
 */
function roomPath(m: Machine, raw: string) {
  let p = raw.trim();
  if (!p || p.length > 1024) throw new Error("Enter a folder.");
  if (!m.ssh && (p === "~" || p.startsWith("~/"))) p = path.join(os.homedir(), p.slice(1));
  if (!p.startsWith("/")) throw new Error(`Use an absolute path${m.ssh ? ` on ${m.label}` : ""}, like /home/you/code/project.`);
  if (!m.ssh && !fs.statSync(p, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`There is no folder at ${p}.`);
  return p;
}

// Input is serialized per pane so fast typing cannot reorder across
// connections. Every Herdr request takes ~100 ms, so keystrokes that arrive
// while a batch is in flight are merged into the next one ("hello" typed fast
// becomes one send_text). `input_ack` carries the id of the last message sent.
// The ops come checked and trimmed from parseClientMessage.
const inputQueues = new Map<string, Promise<void>>(); // "machine/pane" → promise chain
const openBatches = new Map<string, InputBatch>(); // "machine/pane" → batch still waiting for its turn

/** Ops for one pane from one connection, merged while they wait; `id` is the last message's. */
interface InputBatch {
  ws: WebSocket;
  ops: InputOp[];
  id: number | undefined;
}

function enqueueInput(key: string, job: () => Promise<void>) {
  const prev = inputQueues.get(key) ?? Promise.resolve();
  const next = prev.then(job, job).finally(() => {
    if (inputQueues.get(key) === next) inputQueues.delete(key);
  });
  inputQueues.set(key, next);
}

function queueInput(ws: WebSocket, machine: Machine, paneId: string, ops: InputOp[], id: number | undefined) {
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
          if ("text" in op) await machine.sendText(paneId, op.text);
          else await machine.sendKeys(paneId, op.keys);
        }
        b.ws.send(JSON.stringify({ type: "input_ack", machine: machine.id, pane_id: paneId, id: b.id }));
      } catch (err) {
        b.ws.send(JSON.stringify({ type: "error", machine: machine.id, pane_id: paneId, id: b.id, message: (err as Error).message }));
      }
    });
  }
  batch.id = id;
  for (const op of ops) {
    const last = batch.ops[batch.ops.length - 1];
    if ("text" in op) {
      if (last && "text" in last && last.text.length + op.text.length <= MAX_INPUT_TEXT) last.text += op.text;
      else batch.ops.push({ text: op.text });
    } else if (last && "keys" in last) last.keys.push(...op.keys);
    else batch.ops.push({ keys: [...op.keys] });
  }
}

// ---------------------------------------------------------------- shutdown

// SSH tunnels and remote context readers are child processes; take them down with the bridge.
function stopAll() {
  for (const m of machines.values()) m.stop();
  for (const c of contexts.values()) c.stop();
  for (const d of diffs.values()) d.stop();
}
function shutdown(code = 0) {
  stopAll();
  process.exit(code);
}
process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());
process.on("exit", stopAll);

// ---------------------------------------------------------------- listen

/** Resolves with the office's URL once the port is open (null when dist/ is not built). */
export const ready = new Promise<string | null>((resolve) => {
  // ws re-emits the HTTP server's errors (EADDRINUSE…) on the WebSocket server.
  wss.once("error", (err: NodeJS.ErrnoException) => {
    console.error(
      err.code === "EADDRINUSE"
        ? `[bridge] port ${WS_PORT} is already in use. Is the office already running? Pick another port with --port or KAUAK_PORT.`
        : `[bridge] cannot listen on ${WS_HOST}:${WS_PORT}: ${err.message}`,
    );
    shutdown(1);
  });
  server.listen(WS_PORT, WS_HOST, () => {
    const host = WS_HOST.includes(":") ? `[${WS_HOST}]` : WS_HOST;
    const floors = `${machines.size} floor${machines.size === 1 ? "" : "s"} (${CONFIG_PATH})`;
    console.log(`[bridge] websocket listening on ws://${host}:${WS_PORT} · ${floors}`);
    resolve(HAS_PAGE ? `http://${host === "0.0.0.0" || host === "[::]" ? "127.0.0.1" : host}:${WS_PORT}/` : null);
  });
});
