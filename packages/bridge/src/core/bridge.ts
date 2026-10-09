// The bridge's core: the floors, and what the pages connected to it say.
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
// server.ts's business, and the core imports none of them. The pages reach it
// through transport/ws.ts, which also serves the built page.
//
// Loading this file starts nothing. An entry point (`kauak serve`, or main.ts)
// resolves the config (config.ts), calls createBridge (server.ts), then
// `listen()`, and owns the process: its signals and its exit code.

import fs from "node:fs";
import path from "node:path";
import { type BridgeMessage, type ClientMessage, SSH_TARGET, type Snapshot, parseClientMessage } from "@kauak/protocol";
import type { BridgeConfig } from "../config.ts";
import type { FloorEnrichers, SlashCommands } from "../ports/enricher.ts";
import type { MachineConfig, Runtime } from "../ports/runtime.ts";
import { type Connection, WsServer } from "../transport/ws.ts";
import { handle } from "./handlers.ts";
import { InputQueue } from "./input.ts";

/** What the core uses of the bridge's config: the saved floors, and for its transport where it listens, which pages may connect, the page and the appearance packages. */
export type CoreSettings = Pick<
  BridgeConfig,
  "port" | "host" | "origins" | "machinesFile" | "pageDir" | "appearanceDir" | "appearanceFiles"
>;

/**
 * What the core is given (server.ts): how to make a floor's runtime and what
 * the bridge adds to it, neither of them started, and the slash commands.
 */
export interface BridgeDeps {
  runtime(floor: MachineConfig): Runtime;
  enrichers(floor: Runtime): FloorEnrichers;
  commands: SlashCommands;
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
  /** Every page's input, queued per pane. */
  input: InputQueue;
  /** The HTTP server, the page and the WebSocket. */
  transport: WsServer;
  closing: Promise<void> | null;

  constructor(config: CoreSettings, deps: BridgeDeps) {
    this.config = config;
    this.deps = deps;
    this.machines = new Map();
    this.enriched = new Map();
    this.input = new InputQueue();
    this.transport = new WsServer(config, (page) => this.connected(page));
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
      // Enrichers only change a floor they have a snapshot of; one with none has nothing to send.
      e.on("change", () => {
        if (m.snapshot) this.broadcast(this.snapshotMessage(m, m.snapshot));
      });
    }
    printers.on("print", (sheet) => this.broadcast({ type: "print", machine: m.id, sheet }));
    m.on("status", () => this.broadcastMachines());
    m.on("snapshot", (snapshot) => this.broadcast(this.snapshotMessage(m, snapshot)));
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
  snapshotMessage(m: Runtime, snapshot: Snapshot): BridgeMessage {
    for (const e of this.enriched.get(m.id)?.enrichers ?? []) snapshot = e.decorate(snapshot);
    return { type: "snapshot", machine: m.id, snapshot };
  }

  // -------------------------------------------------------------- pages

  broadcast(msg: BridgeMessage) {
    this.transport.broadcast(msg);
  }

  broadcastMachines() {
    this.broadcast({ type: "machines", machines: this.machineInfos() });
  }

  /** A page connected: it is sent the floors, their snapshots and their sheets; then each message from it goes to its handler (handlers.ts). */
  connected(page: Connection) {
    page.send({ type: "machines", machines: this.machineInfos() });
    for (const m of this.machines.values()) {
      if (m.snapshot) page.send(this.snapshotMessage(m, m.snapshot));
      page.send({ type: "prints", machine: m.id, sheets: this.enriched.get(m.id)?.printers.history() ?? [] });
    }

    return async (data: string) => {
      let msg: ClientMessage | null;
      try {
        msg = parseClientMessage(JSON.parse(data));
      } catch {
        return;
      }
      if (msg) await handle(msg, page, this);
    };
  }

  // -------------------------------------------------------------- listen and close

  /** Starts the floors and opens the port; resolves with the office's URL, null when there is no built page. */
  listen() {
    for (const m of this.machines.values()) this.startMachine(m);
    return this.transport.listen().then(({ address, page }) => {
      const floors = `${this.machines.size} floor${this.machines.size === 1 ? "" : "s"} (${this.config.machinesFile})`;
      console.log(`[bridge] websocket listening on ${address} · ${floors}`);
      return page;
    });
  }

  // The floors stop before the first await, so a process "exit" handler that
  // cannot wait still takes the SSH tunnels and remote helpers down with it.
  close() {
    if (this.closing) return this.closing;
    for (const m of this.machines.values()) m.stop();
    for (const { enrichers } of this.enriched.values()) for (const e of enrichers) e.stop();
    this.closing = this.transport.close();
    return this.closing;
  }
}
