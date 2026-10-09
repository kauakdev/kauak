// The bridge's core: the floors, and the pages connected over the WebSocket.
//
// Each floor is a runtime (a Herdr server, for now): this machine is always
// floor 1, and remote machines (reached over SSH) are saved in
// ~/.config/kauak/machines.json. The bridge keeps things simple and robust:
// every time a floor has a new snapshot (the whole floor, a few KB), it
// broadcasts it to all clients, decorated by the floor's enrichers: each
// agent's context use, and each room's git checkout, whose edits its printer
// prints as they happen.
//
// Pages speak the Kauak protocol (@kauak/protocol, docs/protocol.md), and so
// does this file. It knows a floor only through the Runtime port
// (ports/runtime.ts) and what the bridge adds to it only through the Enricher
// port (ports/enricher.ts); which runtime and which enrichers they are is
// server.ts's business, and the core imports none of them.
//
// The same port also serves the built office page (config.pageDir, `pnpm
// build`), so `npx kauak serve` is one process and one URL. `pnpm dev` serves
// the page from Vite instead.
//
// Loading this file starts nothing. An entry point (`kauak serve`, or main.ts)
// resolves the config (config.ts), calls createBridge (server.ts), then
// `listen()`, and owns the process: its signals and its exit code.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
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
import type { BridgeConfig } from "../config.ts";
import type { FloorEnrichers, SlashCommands } from "../ports/enricher.ts";
import type { MachineConfig, Runtime } from "../ports/runtime.ts";

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

/** What the core uses of the bridge's config: where it listens, which pages may connect, the saved floors, the page. */
export type CoreSettings = Pick<BridgeConfig, "port" | "host" | "origins" | "machinesFile" | "pageDir">;

/**
 * What the core is given (server.ts): how to make a floor's runtime and what
 * the bridge adds to it, neither of them started, and the slash commands.
 */
export interface BridgeDeps {
  runtime(floor: MachineConfig): Runtime;
  enrichers(floor: Runtime): FloorEnrichers;
  commands: SlashCommands;
}

/** Ops for one pane from one connection, merged while they wait; `id` is the last message's. */
interface InputBatch {
  ws: WebSocket;
  ops: InputOp[];
  id: number | undefined;
}

/**
 * The floors are made with the bridge, none of them started: `listen()`
 * starts them and opens the port, and `close()` stops them and closes it.
 */
export class Bridge {
  config: CoreSettings;
  deps: BridgeDeps;
  /** id → Runtime, in floor order. */
  machines: Map<string, Runtime>;
  /** id → what the bridge adds to the floor */
  enriched: Map<string, FloorEnrichers>;
  /** "machine/pane" → promise chain (see queueInput) */
  inputQueues: Map<string, Promise<void>>;
  /** "machine/pane" → batch still waiting for its turn */
  openBatches: Map<string, InputBatch>;
  /** The built page's folder, ending in a separator so nothing beside it can pass for a file in it; null for none. */
  pageDir: string | null;
  hasPage: boolean;
  allowedOrigins: Set<string>;
  server: http.Server;
  wss: WebSocketServer;
  closing: Promise<void> | null;

  constructor(config: CoreSettings, deps: BridgeDeps) {
    this.config = config;
    this.deps = deps;
    this.machines = new Map();
    this.enriched = new Map();
    this.inputQueues = new Map();
    this.openBatches = new Map();
    this.pageDir = config.pageDir === null ? null : path.resolve(config.pageDir) + path.sep;
    this.hasPage = this.pageDir !== null && fs.existsSync(path.join(this.pageDir, "index.html"));
    this.allowedOrigins = new Set(config.origins);
    this.server = http.createServer((req, res) => this.servePage(req, res));
    this.wss = new WebSocketServer({
      server: this.server,
      // Browsers let any web page open a WebSocket to 127.0.0.1; only accept our own page.
      verifyClient: ({ origin }: { origin: string }) => {
        if (!origin) return true; // not a browser
        try {
          return this.allowedOrigins.has(new URL(origin).hostname);
        } catch {
          return false;
        }
      },
    });
    this.wss.on("connection", (ws) => this.connected(ws));
    this.closing = null;
    this.addFloors();
  }

  // -------------------------------------------------------------- machines

  /** The saved floors, as saveConfig writes them; each is checked before it is used. */
  loadConfig(): MachineConfig[] {
    const file = this.config.machinesFile;
    try {
      const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
      return Array.isArray(cfg.machines) ? cfg.machines : [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error(`[bridge] ignoring ${file}: ${(err as Error).message}`);
      return [];
    }
  }

  saveConfig() {
    const list = [...this.machines.values()].filter((m) => m.id !== "local").map((m) => m.config);
    fs.mkdirSync(path.dirname(this.config.machinesFile), { recursive: true });
    fs.writeFileSync(this.config.machinesFile, `${JSON.stringify({ machines: list }, null, 2)}\n`);
  }

  /** This machine's floor (its runtime's default socket), then the saved ones. */
  addFloors() {
    this.addMachine({ id: "local", label: "local" });
    for (const c of this.loadConfig()) {
      if (typeof c?.label !== "string" || (c.ssh ? !SSH_TARGET.test(c.ssh) : typeof c.socket !== "string")) {
        console.error(`[bridge] skipping machine in ${this.config.machinesFile}: ${JSON.stringify(c)}`);
        continue;
      }
      this.addMachine({ ...c, id: typeof c.id === "string" && !this.machines.has(c.id) ? c.id : this.uniqueId(c.label) });
    }
  }

  /** A floor's runtime and what the bridge adds to it, not started. */
  addMachine(cfg: MachineConfig) {
    const m = this.deps.runtime(cfg);
    this.machines.set(m.id, m);
    this.enriched.set(m.id, this.deps.enrichers(m));
    return m;
  }

  /**
   * The enrichers start first, so they hear of each snapshot before the
   * pages are sent it; then the runtime, which connects.
   */
  startMachine(m: Runtime) {
    const { enrichers, printers } = this.enriched.get(m.id)!;
    for (const e of enrichers) {
      e.start();
      e.on("change", () => this.broadcast(this.snapshotMessage(m)));
    }
    printers.on("print", (sheet) => this.broadcast({ type: "print", machine: m.id, sheet }));
    m.on("status", () => this.broadcastMachines());
    m.on("snapshot", () => this.broadcast(this.snapshotMessage(m)));
    m.start();
  }

  removeMachine(m: Runtime) {
    m.stop();
    for (const e of this.enriched.get(m.id)?.enrichers ?? []) e.stop();
    this.enriched.delete(m.id);
    this.machines.delete(m.id);
  }

  uniqueId(base: string) {
    const slug =
      base
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "machine";
    let id = slug,
      n = 2;
    while (this.machines.has(id)) id = `${slug}-${n++}`;
    return id;
  }

  machineInfos() {
    return [...this.machines.values()].map((m) => m.info);
  }

  /** The floor's snapshot, decorated by each of its enrichers in turn. */
  snapshotMessage(m: Runtime) {
    let snapshot = m.snapshot;
    if (snapshot) for (const e of this.enriched.get(m.id)?.enrichers ?? []) snapshot = e.decorate(snapshot);
    return { type: "snapshot", machine: m.id, snapshot };
  }

  // -------------------------------------------------------------- page

  /** Static files from the built page. Nothing here is secret; the WebSocket is what needs guarding. */
  servePage(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.method !== "GET" && req.method !== "HEAD") return res.writeHead(405).end();
    let rel: string;
    try {
      rel = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    } catch {
      return res.writeHead(400).end();
    }
    if (rel.endsWith("/")) rel += "index.html";
    const notFound = () => {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end(this.hasPage ? "Not found\n" : "The office page is not built. Run `pnpm build`, or `pnpm dev` for the Vite dev server.\n");
    };
    if (this.pageDir === null) return notFound();
    const file = path.resolve(this.pageDir, `.${rel}`);
    if (!file.startsWith(this.pageDir)) return res.writeHead(404).end();
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return notFound();
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

  // -------------------------------------------------------------- WS server

  broadcast(msg: object) {
    const data = JSON.stringify(msg);
    for (const client of this.wss.clients) if (client.readyState === 1) client.send(data);
  }

  broadcastMachines() {
    this.broadcast({ type: "machines", machines: this.machineInfos() });
  }

  connected(ws: WebSocket) {
    console.log(`[bridge] client connected (${this.wss.clients.size})`);
    ws.send(JSON.stringify({ type: "machines", machines: this.machineInfos() }));
    for (const m of this.machines.values()) {
      if (m.snapshot) ws.send(JSON.stringify(this.snapshotMessage(m)));
      ws.send(JSON.stringify({ type: "prints", machine: m.id, sheets: this.enriched.get(m.id)?.printers.history() ?? [] }));
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
        if ([...this.machines.values()].some((m) => m.ssh === ssh)) {
          ws.send(JSON.stringify({ type: "machine_error", message: `${ssh} already has a floor.` }));
          return;
        }
        const label = msg.label || ssh.split("@").pop()!;
        const m = this.addMachine({ id: this.uniqueId(label), label: label.slice(0, 40), ssh });
        this.startMachine(m);
        this.saveConfig();
        this.broadcastMachines();
        ws.send(JSON.stringify({ type: "machine_added", machine: m.id }));
        return;
      }
      if (msg.type === "remove_machine") {
        const m = this.machines.get(msg.machine);
        if (!m || m.id === "local") return;
        this.removeMachine(m);
        this.saveConfig();
        this.broadcastMachines();
        return;
      }

      const m = this.machines.get(msg.machine);
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
        this.queueInput(ws, m, msg.pane_id, msg.ops, msg.id);
      } else if (msg.type === "commands") {
        // The message box's "/" menu. The agent and its folder come from the
        // snapshot, not the page; only this machine's files are read.
        const pane = m.snapshot?.panes.find((p) => p.pane_id === msg.pane_id);
        if (!pane) return;
        const commands = await this.deps.commands(pane.agent, pane.cwd, !m.ssh);
        ws.send(JSON.stringify({ type: "commands", machine: m.id, pane_id: msg.pane_id, agent: pane.agent, commands }));
      } else if (msg.type === "uncommitted") {
        // A printer's uncommitted view. Only checkouts a room is in are read (the floor's Printers).
        const reply = (o: object) => ws.send(JSON.stringify({ type: "uncommitted", machine: m.id, root: msg.root, id: msg.id, ...o }));
        reply(await this.enriched.get(m.id)!.printers.uncommitted(msg.root));
      } else if (msg.type === "refresh") {
        m.scheduleRefresh();
      } else if (msg.type === "create_desk" || msg.type === "create_room") {
        build(ws, m, msg);
      }
    });
  }

  // -------------------------------------------------------------- input
  //
  // Input is serialized per pane so fast typing cannot reorder across
  // connections. Every Herdr request takes ~100 ms, so keystrokes that arrive
  // while a batch is in flight are merged into the next one ("hello" typed fast
  // becomes one send_text). `input_ack` carries the id of the last message sent.
  // The ops come checked and trimmed from parseClientMessage.

  enqueueInput(key: string, job: () => Promise<void>) {
    const prev = this.inputQueues.get(key) ?? Promise.resolve();
    const next = prev.then(job, job).finally(() => {
      if (this.inputQueues.get(key) === next) this.inputQueues.delete(key);
    });
    this.inputQueues.set(key, next);
  }

  queueInput(ws: WebSocket, machine: Runtime, paneId: string, ops: InputOp[], id: number | undefined) {
    const key = `${machine.id}/${paneId}`;
    let batch = this.openBatches.get(key);
    if (!batch || batch.ws !== ws) {
      batch = { ws, ops: [], id };
      this.openBatches.set(key, batch);
      const b = batch;
      this.enqueueInput(key, async () => {
        if (this.openBatches.get(key) === b) this.openBatches.delete(key); // closed to merging once it runs
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

  // -------------------------------------------------------------- listen and close

  listen() {
    for (const m of this.machines.values()) this.startMachine(m);
    const { port, host } = this.config;
    return new Promise<string | null>((resolve, reject) => {
      // ws re-emits the HTTP server's errors (EADDRINUSE…) on the WebSocket server.
      this.wss.once("error", (err: NodeJS.ErrnoException) => {
        console.error(
          err.code === "EADDRINUSE"
            ? `[bridge] port ${port} is already in use. Is the office already running? Pick another port with --port or KAUAK_PORT.`
            : `[bridge] cannot listen on ${host}:${port}: ${err.message}`,
        );
        reject(err);
      });
      this.server.listen(port, host, () => {
        const shown = host.includes(":") ? `[${host}]` : host;
        const floors = `${this.machines.size} floor${this.machines.size === 1 ? "" : "s"} (${this.config.machinesFile})`;
        console.log(`[bridge] websocket listening on ws://${shown}:${port} · ${floors}`);
        resolve(this.hasPage ? `http://${shown === "0.0.0.0" || shown === "[::]" ? "127.0.0.1" : shown}:${port}/` : null);
      });
    });
  }

  // The floors stop before the first await, so a process "exit" handler that
  // cannot wait still takes the SSH tunnels and remote helpers down with it.
  close() {
    if (this.closing) return this.closing;
    for (const m of this.machines.values()) m.stop();
    for (const { enrichers } of this.enriched.values()) for (const e of enrichers) e.stop();
    for (const ws of this.wss.clients) ws.terminate();
    this.closing = new Promise<void>((resolve) => {
      this.wss.close();
      // Resolves on an error too: a port that never opened has nothing to close.
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
    return this.closing;
  }
}

// ---------------------------------------------------------------- build mode
//
// New desks (a new tab in a room) and new rooms (a
// workspace in a folder, or a git worktree on a new branch), each with an
// optional agent. `created` goes out as soon as the pane exists, after a fresh
// snapshot, so the page can open it right away; the agent starts afterwards
// (Herdr waits until it is ready, which can take seconds), and a failure
// there is a `create_error` that carries the pane id.

async function build(ws: WebSocket, m: Runtime, msg: Extract<ClientMessage, { type: "create_desk" | "create_room" }>) {
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
function roomSpec(m: Runtime, room: RoomSpec): RoomSpec {
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
function roomPath(m: Runtime, raw: string) {
  let p = raw.trim();
  if (!p || p.length > 1024) throw new Error("Enter a folder.");
  if (!m.ssh && (p === "~" || p.startsWith("~/"))) p = path.join(os.homedir(), p.slice(1));
  if (!p.startsWith("/")) throw new Error(`Use an absolute path${m.ssh ? ` on ${m.label}` : ""}, like /home/you/code/project.`);
  if (!m.ssh && !fs.statSync(p, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`There is no folder at ${p}.`);
  return p;
}
