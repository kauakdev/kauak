import { keyOf, splitKey } from "./floors";
import type { BridgeMessage, DiffSheet, InputOp, MachineInfo, RoomSpec, SlashCommand, Snapshot, Uncommitted } from "@kauak/protocol";

/** Pane arguments and callbacks use floor keys ("machine/pane_id", see floors.ts). */
export interface BridgeHandlers {
  onMachines(machines: MachineInfo[]): void;
  onSnapshot(machine: string, s: Snapshot): void;
  onStatus(connected: boolean): void;
  onPaneOutput(pane: string, text: string, seq: number): void;
  onInputAck?(pane: string, id: number | undefined): void;
  /** The "/" menu's commands for a pane, answering listCommands. */
  onCommands?(pane: string, commands: SlashCommand[]): void;
  onError?(message: string, pane?: string, id?: number): void;
  onMachineAdded?(machine: string): void;
  onMachineError?(message: string): void;
  /** A desk or room from createDesk/createRoom exists; `id` is the request's. */
  onCreated?(pane: string, id: number | undefined): void;
  /** It failed, or (with `pane`) the desk exists but its agent did not start. */
  onCreateError?(message: string, id: number | undefined, pane?: string): void;
  /** Everything a floor's printers hold, on (re)connecting. */
  onPrints?(machine: string, sheets: DiffSheet[]): void;
  /** A printer printed a new sheet. */
  onPrint?(machine: string, sheet: DiffSheet): void;
  /** A printer's uncommitted view, answering requestUncommitted (`printer` as in prints.ts). */
  onUncommitted?(printer: string, id: number | undefined, result: Uncommitted): void;
}

/** What the page needs from a bridge: the real one below, or the simulated one in demo.ts. */
export interface BridgeApi {
  focusPane(pane: string): void;
  readPane(pane: string, seq: number, lines: number): void;
  sendInput(pane: string, ops: InputOp[], id: number): boolean;
  /** Ask which slash commands the pane's agent has; answered with onCommands. */
  listCommands(pane: string): void;
  addMachine(ssh: string, label: string): boolean;
  removeMachine(machine: string): void;
  /** A new desk in a room (`workspace` is a floor key), with an optional agent kind. */
  createDesk(workspace: string, agent: string | null, id: number): boolean;
  createRoom(machine: string, room: RoomSpec, agent: string | null, id: number): boolean;
  /** Everything not committed in a printer's checkout (`printer` as in prints.ts); answered with onUncommitted. */
  requestUncommitted(printer: string, id: number): boolean;
}

// The bridge only listens on 127.0.0.1 by default; "localhost" may resolve to ::1 first.
const HOST = ["localhost", "::1", "[::1]"].includes(location.hostname) ? "127.0.0.1" : location.hostname;
// A built page is served by the bridge itself (`npx kauak serve`), so it connects
// back to the port it came from; the Vite dev server has a port of its own.
const PORT = import.meta.env.VITE_BRIDGE_PORT ?? (import.meta.env.DEV ? 7788 : location.port);
const URL = `ws://${HOST}:${PORT}`;

export class Bridge implements BridgeApi {
  private ws: WebSocket | null = null;
  constructor(private handlers: BridgeHandlers) {
    this.connect();
  }

  private connect() {
    this.handlers.onStatus(false);
    const ws = new WebSocket(URL);
    this.ws = ws;
    ws.onopen = () => this.handlers.onStatus(true);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data) as BridgeMessage;
      if (msg.type === "machines") {
        this.handlers.onMachines(msg.machines);
      } else if (msg.type === "snapshot") {
        this.handlers.onSnapshot(msg.machine, msg.snapshot);
      } else if (msg.type === "pane_output") {
        this.handlers.onPaneOutput(keyOf(msg.machine, msg.pane_id), msg.text, msg.seq ?? 0);
      } else if (msg.type === "input_ack") {
        this.handlers.onInputAck?.(keyOf(msg.machine, msg.pane_id), msg.id);
      } else if (msg.type === "commands") {
        this.handlers.onCommands?.(keyOf(msg.machine, msg.pane_id), msg.commands);
      } else if (msg.type === "machine_added") {
        this.handlers.onMachineAdded?.(msg.machine);
      } else if (msg.type === "machine_error") {
        this.handlers.onMachineError?.(msg.message);
      } else if (msg.type === "created") {
        this.handlers.onCreated?.(keyOf(msg.machine, msg.pane_id), msg.id);
      } else if (msg.type === "create_error") {
        this.handlers.onCreateError?.(msg.message, msg.id, msg.pane_id ? keyOf(msg.machine, msg.pane_id) : undefined);
      } else if (msg.type === "prints") {
        this.handlers.onPrints?.(msg.machine, msg.sheets);
      } else if (msg.type === "print") {
        this.handlers.onPrint?.(msg.machine, msg.sheet);
      } else if (msg.type === "uncommitted") {
        const { files, incomplete, error } = msg;
        this.handlers.onUncommitted?.(keyOf(msg.machine, msg.root), msg.id, { files, incomplete, error });
      } else if (msg.type === "error") {
        console.warn("[bridge]", msg.message);
        const pane = msg.machine && msg.pane_id ? keyOf(msg.machine, msg.pane_id) : undefined;
        this.handlers.onError?.(msg.message, pane, msg.id);
      }
    };
    ws.onclose = () => {
      this.handlers.onStatus(false);
      setTimeout(() => this.connect(), 1500);
    };
    ws.onerror = () => ws.close();
  }

  private send(msg: object): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  focusPane(pane: string) {
    const { machine, id } = splitKey(pane);
    this.send({ type: "focus", machine, pane_id: id });
  }

  /** The last `lines` rows: the pane's screen and the history above it. `seq` is echoed back on the reply. */
  readPane(pane: string, seq: number, lines: number) {
    const { machine, id } = splitKey(pane);
    this.send({ type: "read", machine, pane_id: id, lines, seq });
  }

  /** Send keystrokes to a pane; `id` comes back on the ack. Returns false if the bridge is offline (input is dropped, not queued). */
  sendInput(pane: string, ops: InputOp[], id: number): boolean {
    if (ops.length === 0) return false;
    const { machine, id: paneId } = splitKey(pane);
    return this.send({ type: "input", machine, pane_id: paneId, ops, id });
  }

  listCommands(pane: string) {
    const { machine, id } = splitKey(pane);
    this.send({ type: "commands", machine, pane_id: id });
  }

  /** Add a machine as a new floor; answered with onMachineAdded or onMachineError. */
  addMachine(ssh: string, label: string): boolean {
    return this.send({ type: "add_machine", ssh, label });
  }

  removeMachine(machine: string) {
    this.send({ type: "remove_machine", machine });
  }

  /** Answered with onCreated, then onCreateError if the agent does not start; or onCreateError alone. */
  createDesk(workspace: string, agent: string | null, id: number): boolean {
    const { machine, id: workspaceId } = splitKey(workspace);
    return this.send({ type: "create_desk", machine, workspace_id: workspaceId, agent, id });
  }

  createRoom(machine: string, room: RoomSpec, agent: string | null, id: number): boolean {
    return this.send({ type: "create_room", machine, room, agent, id });
  }

  requestUncommitted(printer: string, id: number): boolean {
    const { machine, id: root } = splitKey(printer);
    return this.send({ type: "uncommitted", machine, root, id });
  }
}
