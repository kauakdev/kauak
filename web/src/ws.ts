import { keyOf, splitKey } from "./floors";
import type { BridgeMessage, InputOp, MachineInfo, Snapshot } from "./types";

/** Pane arguments and callbacks use floor keys ("machine/pane_id", see floors.ts). */
export interface BridgeHandlers {
  onMachines(machines: MachineInfo[]): void;
  onSnapshot(machine: string, s: Snapshot): void;
  onStatus(connected: boolean): void;
  onPaneOutput(pane: string, text: string, seq: number): void;
  onInputAck?(pane: string, id: number | undefined): void;
  onError?(message: string, pane?: string, id?: number): void;
  onMachineAdded?(machine: string): void;
  onMachineError?(message: string): void;
}

/** What the page needs from a bridge: the real one below, or the simulated one in demo.ts. */
export interface BridgeApi {
  focusPane(pane: string): void;
  readPane(pane: string, seq: number): void;
  sendInput(pane: string, ops: InputOp[], id: number): boolean;
  addMachine(ssh: string, label: string): boolean;
  removeMachine(machine: string): void;
}

// The bridge only listens on 127.0.0.1 by default; "localhost" may resolve to ::1 first.
const HOST = ["localhost", "::1", "[::1]"].includes(location.hostname) ? "127.0.0.1" : location.hostname;
// A built page is served by the bridge itself (`npx agentoffice`), so it connects
// back to the port it came from; the Vite dev server has a port of its own.
const PORT = import.meta.env.VITE_BRIDGE_PORT ?? (import.meta.env.DEV ? 7788 : location.port);
const URL = `ws://${HOST}:${PORT}`;

export class Bridge implements BridgeApi {
  private ws: WebSocket | null = null;
  constructor(private handlers: BridgeHandlers) { this.connect(); }

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
      } else if (msg.type === "machine_added") {
        this.handlers.onMachineAdded?.(msg.machine);
      } else if (msg.type === "machine_error") {
        this.handlers.onMachineError?.(msg.message);
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

  /** `seq` is echoed back on the reply. */
  readPane(pane: string, seq: number) {
    const { machine, id } = splitKey(pane);
    this.send({ type: "read", machine, pane_id: id, source: "visible", seq });
  }

  /** Send keystrokes to a pane; `id` comes back on the ack. Returns false if the bridge is offline (input is dropped, not queued). */
  sendInput(pane: string, ops: InputOp[], id: number): boolean {
    if (ops.length === 0) return false;
    const { machine, id: paneId } = splitKey(pane);
    return this.send({ type: "input", machine, pane_id: paneId, ops, id });
  }

  /** Add a machine as a new floor; answered with onMachineAdded or onMachineError. */
  addMachine(ssh: string, label: string): boolean {
    return this.send({ type: "add_machine", ssh, label });
  }

  removeMachine(machine: string) {
    this.send({ type: "remove_machine", machine });
  }
}
