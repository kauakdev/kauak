// Terminal side panel backed by xterm.js. Mirrors the selected pane's visible
// viewport (polled from the bridge, redrawn only when the text changes)
// and forwards keystrokes typed into it to the pane via the bridge.

import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { encodeInput } from "./keys";
import type { InputOp, PaneInfo, Snapshot } from "./types";

const POLL_MS = 400;
const AFTER_INPUT_READ_MS = 120;

export class TerminalPanel {
  private el = document.getElementById("panel")!;
  private titleEl = document.getElementById("panel-title")!;
  private metaEl = document.getElementById("panel-meta")!;
  private hintEl = document.getElementById("panel-hint")!;
  private lockBtn = document.getElementById("panel-lock") as HTMLButtonElement;
  private host = document.getElementById("panel-term")!;
  private term: Terminal;
  private pane: PaneInfo | null = null;
  private lastText: string | null = null;
  private lastRows: string[] | null = null;
  private timer: number | null = null;
  private snapshot: Snapshot | null = null;
  private locked = false;
  private hintTimer: number | null = null;

  onRead: (paneId: string) => void = () => {};
  onInput: (paneId: string, ops: InputOp[]) => boolean = () => false;
  onFocus: (paneId: string) => void = () => {};
  onClose: () => void = () => {};

  constructor() {
    this.term = new Terminal({
      disableStdin: false,
      cursorBlink: true,
      cursorStyle: "bar",
      cursorInactiveStyle: "outline",
      fontSize: 12,
      fontFamily: "ui-monospace, 'JetBrains Mono', Menlo, monospace",
      convertEol: false,
      scrollback: 0,
      theme: { background: "#0f1118", foreground: "#e8e9f0", cursor: "#ffd166", cursorAccent: "#0f1118" },
    });
    this.term.open(this.host);
    this.term.onData((data) => this.send(data));
    this.term.onBinary((data) => this.send(data));
    this.term.textarea?.addEventListener("focus", () => this.el.classList.add("typing"));
    this.term.textarea?.addEventListener("blur", () => this.el.classList.remove("typing"));

    document.getElementById("panel-close")!.addEventListener("click", () => this.close());
    document.getElementById("panel-focus")!.addEventListener("click", () => { if (this.pane) this.onFocus(this.pane.pane_id); });
    this.lockBtn.addEventListener("click", () => this.setLocked(!this.locked));
    this.host.addEventListener("mousedown", () => { if (!this.locked) this.term.focus(); });
    // Esc inside the terminal goes to the pane (agents use it); Esc elsewhere closes the panel.
    addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.isTyping()) this.close();
    });
    this.setLocked(false);
  }

  /** True while keyboard focus is inside the terminal, so global shortcuts must stay out of the way. */
  isTyping(): boolean {
    return this.pane !== null && document.activeElement === this.term.textarea;
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
    document.body.classList.add("panel-open");
    this.renderHeader();
    if (switching) { this.lastText = null; this.lastRows = null; this.term.reset(); this.resizeToPane(); }
    if (this.timer === null) {
      this.poll();
      this.timer = window.setInterval(() => this.poll(), POLL_MS);
    }
    if (!this.locked) this.term.focus();
  }

  close() {
    const wasOpen = this.pane !== null;
    this.el.classList.remove("open");
    document.body.classList.remove("panel-open");
    this.pane = null;
    this.term.blur();
    if (wasOpen) this.onClose();
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
  }

  get selectedPaneId(): string | null { return this.pane?.pane_id ?? null; }

  receive(paneId: string, text: string, _revision: number) {
    if (!this.pane || paneId !== this.pane.pane_id) return;
    // Herdr's `revision` does not move on plain output (verified on 0.9.1: it
    // stayed at 0 after typing and command output), so diff the viewport text.
    if (text === this.lastText) return;
    const rows = text.split("\r\n");
    const plain = rows.map(stripAnsi);
    // Herdr gives no cursor position. Best guess: the end of the row that
    // changed most recently (the input line while typing); on first draw, the
    // last non-empty row.
    let caret = -1;
    if (this.lastRows) for (let i = 0; i < plain.length; i++) if (plain[i] !== this.lastRows[i]) caret = i;
    if (caret === -1) { caret = plain.length - 1; while (caret > 0 && !plain[caret]!.trim()) caret--; }
    this.lastText = text;
    this.lastRows = plain;
    // Rows come back only as long as their content, so a row that got shorter
    // (backspace in a TUI) would leave its old tail behind. Clear the screen in
    // the same write: xterm paints once per frame, so there is no blank flash.
    let out = "\x1b[H\x1b[2J";
    for (let i = 0; i < rows.length; i++) {
      if (i > 0) out += "\r\n";
      out += i === caret ? trimRowTail(rows[i]!) + "\x1b7" : rows[i];
    }
    this.term.write(out + "\x1b8");
  }

  /** Bridge confirmed the keystrokes reached Herdr: fetch the new viewport right away. */
  inputAcked(paneId: string) {
    if (!this.pane || paneId !== this.pane.pane_id) return;
    this.poll();
    window.setTimeout(() => this.poll(), AFTER_INPUT_READ_MS);
  }

  inputFailed(paneId: string, message: string) {
    if (!this.pane || paneId !== this.pane.pane_id) return;
    this.flashHint(`input failed: ${message}`);
  }

  setLocked(locked: boolean) {
    this.locked = locked;
    this.term.options.disableStdin = locked;
    this.el.classList.toggle("locked", locked);
    this.lockBtn.textContent = locked ? "Read-only" : "Live input";
    this.lockBtn.title = locked ? "Typing is off. Click to send keystrokes to this pane." : "Typing here sends keystrokes to the pane. Click to make it read-only.";
    this.lockBtn.setAttribute("aria-pressed", String(!locked));
    this.renderHint();
    if (locked) this.term.blur(); else if (this.pane) this.term.focus();
  }

  private renderHint() {
    this.hintEl.classList.remove("warn");
    this.hintEl.textContent = this.locked
      ? "read-only mirror of the pane's viewport · refreshes when Herdr reports new output"
      : "keystrokes go to the pane · Esc, arrows and Ctrl combos are forwarded · caret is a best guess · click outside the terminal, then Esc to close";
  }

  private send(data: string) {
    if (!this.pane || this.locked) return;
    const ops = encodeInput(data);
    if (ops.length === 0) return;
    if (!this.onInput(this.pane.pane_id, ops)) this.flashHint("bridge offline · keystrokes dropped");
  }

  private flashHint(text: string) {
    this.hintEl.textContent = text;
    this.hintEl.classList.add("warn");
    if (this.hintTimer !== null) clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => { this.hintTimer = null; this.renderHint(); }, 2500);
  }

  private poll() { if (this.pane) this.onRead(this.pane.pane_id); }

  private renderHeader() {
    if (!this.pane) return;
    const p = this.pane;
    this.titleEl.textContent = p.terminal_title_stripped || p.terminal_title || p.pane_id;
    this.metaEl.textContent = `${p.pane_id} · ${(p.foreground_cwd || p.cwd).replace(/^\/home\/[^/]+/, "~")}`;
    const kind = document.getElementById("panel-kind")!;
    kind.textContent = p.agent ?? "shell";
    kind.dataset.kind = p.agent ?? "";
    document.getElementById("panel-status")!.textContent = p.agent ? p.agent_status : "no agent";
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

const ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]/g;
function stripAnsi(s: string): string { return s.replace(ANSI_RE, "").replace(/\s+$/, ""); }
/** Drop trailing blanks (and any escape codes after them) so the caret lands right after the text. */
function trimRowTail(row: string): string {
  return row.replace(/[ \t]+((?:\x1b\[[0-9;?]*[@-~])*)$/, "$1");
}
