// Read-only terminal side panel backed by xterm.js. Polls the bridge for the
// selected pane's visible viewport and only redraws when Herdr's revision moves.

import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { PaneInfo, Snapshot } from "./types";

const POLL_MS = 400;

export class TerminalPanel {
  private el = document.getElementById("panel")!;
  private titleEl = document.getElementById("panel-title")!;
  private metaEl = document.getElementById("panel-meta")!;
  private host = document.getElementById("panel-term")!;
  private term: Terminal;
  private pane: PaneInfo | null = null;
  private revision = -1;
  private timer: number | null = null;
  private snapshot: Snapshot | null = null;

  onRead: (paneId: string) => void = () => {};
  onFocus: (paneId: string) => void = () => {};

  constructor() {
    this.term = new Terminal({
      disableStdin: true,
      cursorBlink: false,
      cursorStyle: "bar",
      fontSize: 12,
      fontFamily: "ui-monospace, 'JetBrains Mono', Menlo, monospace",
      convertEol: false,
      scrollback: 0,
      theme: { background: "#0f1118", foreground: "#e8e9f0" },
    });
    this.term.open(this.host);
    document.getElementById("panel-close")!.addEventListener("click", () => this.close());
    document.getElementById("panel-focus")!.addEventListener("click", () => { if (this.pane) this.onFocus(this.pane.pane_id); });
    addEventListener("keydown", (e) => { if (e.key === "Escape") this.close(); });
  }

  setSnapshot(s: Snapshot) {
    this.snapshot = s;
    if (!this.pane) return;
    const fresh = s.panes.find((p) => p.pane_id === this.pane!.pane_id);
    if (!fresh) { this.close(); return; }
    this.pane = fresh;
    this.renderHeader();
    this.resizeToPane();
  }

  open(pane: PaneInfo) {
    const switching = this.pane?.pane_id !== pane.pane_id;
    this.pane = pane;
    this.el.classList.add("open");
    this.renderHeader();
    if (switching) { this.revision = -1; this.term.reset(); this.resizeToPane(); }
    if (this.timer === null) {
      this.poll();
      this.timer = window.setInterval(() => this.poll(), POLL_MS);
    }
  }

  close() {
    this.el.classList.remove("open");
    this.pane = null;
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
  }

  get selectedPaneId(): string | null { return this.pane?.pane_id ?? null; }

  receive(paneId: string, text: string, revision: number) {
    if (!this.pane || paneId !== this.pane.pane_id) return;
    if (revision === this.revision) return;
    this.revision = revision;
    // Redraw from the top-left without clearing to avoid a blank flash.
    this.term.write("\x1b[H" + text + "\x1b[J");
  }

  private poll() { if (this.pane) this.onRead(this.pane.pane_id); }

  private renderHeader() {
    if (!this.pane) return;
    const p = this.pane;
    const who = p.agent ? `${p.agent} · ${p.agent_status}` : "shell";
    this.titleEl.textContent = p.terminal_title_stripped || p.terminal_title || p.pane_id;
    this.metaEl.textContent = `${who} · ${p.pane_id} · ${(p.foreground_cwd || p.cwd).replace(/^\/home\/[^/]+/, "~")}`;
    this.el.dataset.status = p.agent_status;
  }

  private resizeToPane() {
    if (!this.pane || !this.snapshot) return;
    for (const l of this.snapshot.layouts) {
      const lp = l.panes.find((x) => x.pane_id === this.pane!.pane_id);
      if (lp) { this.term.resize(Math.max(20, lp.rect.width), Math.max(5, lp.rect.height)); return; }
    }
  }
}
