import type { BridgeMessage, Snapshot } from "./types";

export interface BridgeHandlers {
  onSnapshot(s: Snapshot): void;
  onStatus(connected: boolean, text: string): void;
  onPaneOutput(pane_id: string, text: string, revision: number): void;
  onError?(message: string, pane_id?: string): void;
}

const URL = `ws://${location.hostname}:${import.meta.env.VITE_BRIDGE_PORT ?? 7788}`;

export class Bridge {
  private ws: WebSocket | null = null;
  constructor(private handlers: BridgeHandlers) { this.connect(); }

  private connect() {
    this.handlers.onStatus(false, "connecting…");
    const ws = new WebSocket(URL);
    this.ws = ws;
    ws.onopen = () => this.handlers.onStatus(true, "live");
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data) as BridgeMessage;
      if (msg.type === "snapshot") {
        this.handlers.onStatus(true, `live · herdr ${msg.snapshot.version}`);
        this.handlers.onSnapshot(msg.snapshot);
      } else if (msg.type === "herdr_down") {
        this.handlers.onStatus(false, `herdr unreachable: ${msg.message}`);
      } else if (msg.type === "pane_output") {
        this.handlers.onPaneOutput(msg.pane_id, msg.text, msg.revision);
      } else if (msg.type === "error") {
        console.warn("[bridge]", msg.message);
        this.handlers.onError?.(msg.message, msg.pane_id);
      }
    };
    ws.onclose = () => {
      this.handlers.onStatus(false, "bridge offline · retrying");
      setTimeout(() => this.connect(), 1500);
    };
    ws.onerror = () => ws.close();
  }

  focusPane(pane_id: string) {
    this.ws?.send(JSON.stringify({ type: "focus", pane_id }));
  }

  readPane(pane_id: string) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "read", pane_id, source: "visible" }));
  }
}
