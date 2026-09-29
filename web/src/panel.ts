// Terminal side panel backed by xterm.js. Mirrors the selected pane's visible
// viewport (polled from the bridge, redrawn only when the text changes)
// and forwards keystrokes typed into it to the pane via the bridge.
// Herdr reports no cursor position, so `Caret` decides where to draw it.

import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Caret, plainRow, width } from "./caret";
import { encodeInput } from "./keys";
import type { InputOp, PaneInfo, Snapshot } from "./types";

const POLL_MS = 400;
// Once Herdr has the keystrokes, read right away, then again once the program
// has had time to echo them.
const AFTER_INPUT_READS_MS = [0, 120];
// The pane is mirrored at its real size; the font shrinks so all of it fits the panel.
const FONT_MAX = 13;
const FONT_MIN = 8;

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
  private caret = new Caret();
  private shownEcho = "";
  private shownCursor = "";
  private fontCap = FONT_MAX; // largest font known to fit the current panel size
  private fitFor = "";
  private readRows = 0; // rows in the last read of this pane
  private readCols = 0; // widest row read from this pane so far
  // Reads are numbered so late, out-of-order replies are dropped. A reply
  // reflects every keystroke only if its read was sent after Herdr acked the
  // last one: `settledAfter` is the last read sent before that.
  private readSeq = 0;
  private appliedSeq = 0;
  private settledAfter = 0;
  private inputId = 0;
  private timer: number | null = null;
  private snapshot: Snapshot | null = null;
  private locked = false;
  private hintTimer: number | null = null;

  onRead: (paneId: string, seq: number) => void = () => {};
  onInput: (paneId: string, ops: InputOp[], id: number) => boolean = () => false;
  onFocus: (paneId: string) => void = () => {};
  onClose: () => void = () => {};

  constructor() {
    this.term = new Terminal({
      disableStdin: false,
      cursorBlink: true,
      cursorStyle: "bar",
      cursorInactiveStyle: "outline",
      fontSize: FONT_MAX,
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
    // Header buttons must not take keyboard focus: a later Space would click them instead of typing.
    for (const b of this.el.querySelectorAll("header button")) b.addEventListener("mousedown", (e) => e.preventDefault());
    this.host.addEventListener("mousedown", () => { if (!this.locked) this.term.focus(); });
    const ro = new ResizeObserver(() => this.fit());
    ro.observe(this.host);
    ro.observe(this.host.querySelector(".xterm-screen")!);
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
    if (switching) { this.lastText = null; this.readRows = this.readCols = 0; this.caret.reset(); this.term.reset(); this.resizeToPane(); }
    if (this.timer === null) {
      this.poll();
      this.timer = window.setInterval(() => this.poll(), POLL_MS);
    }
    if (!this.locked) this.term.focus();
    requestAnimationFrame(() => this.fit());
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

  receive(paneId: string, text: string, seq: number) {
    if (!this.pane || paneId !== this.pane.pane_id || seq <= this.appliedSeq) return;
    this.appliedSeq = seq;
    const plain = text.split("\r\n").map(plainRow);
    this.readRows = plain.length;
    this.readCols = Math.max(this.readCols, ...plain.map(width));
    const resized = this.resizeToPane();
    this.caret.update(plain, seq > this.settledAfter, performance.now());
    // Herdr's `revision` does not move on plain output (verified on 0.9.1: it
    // stayed at 0 after typing and command output), so diff the viewport text.
    const changed = text !== this.lastText;
    this.lastText = text;
    this.write(changed || resized);
  }

  /** Draw the latest screen (when it or the local echo changed), then put xterm's cursor at the caret. */
  private write(screenChanged = false) {
    const c = this.caret;
    const echo = c.overlay();
    const cursor = this.locked || c.row < 0 ? "\x1b[?25l" : `\x1b[?25h\x1b[${c.row + 1};${c.col + 1}H`;
    const redraw = screenChanged || echo !== this.shownEcho;
    if (!redraw && cursor === this.shownCursor) return;
    let out = "";
    // Rows come back only as long as their content, so a row that got shorter
    // (backspace in a TUI) would leave its old tail behind. Clear the screen in
    // the same write: xterm paints once per frame, so there is no blank flash.
    // Repainting the screen under the echo also wipes an echo that went away.
    // Auto-wrap is off (?7l) so a row wider than xterm is clipped instead of
    // wrapping and pushing every row below it down a line.
    if (redraw) out = (this.lastText === null ? "" : "\x1b[?7l\x1b[H\x1b[2J" + this.lastText) + echo;
    this.shownEcho = echo;
    this.shownCursor = cursor;
    this.term.write(out + cursor, () => this.revealCaret());
  }

  /** Keystrokes reached Herdr. Once the last one has, reads reflect them all. */
  inputAcked(paneId: string, id: number | undefined) {
    if (!this.pane || paneId !== this.pane.pane_id || id !== this.inputId) return;
    this.settledAfter = this.readSeq;
    for (const ms of AFTER_INPUT_READS_MS) window.setTimeout(() => this.poll(), ms);
  }

  inputFailed(paneId: string, message: string, id?: number) {
    if (!this.pane || paneId !== this.pane.pane_id) return;
    if (id === this.inputId) this.settledAfter = this.readSeq;
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
    this.write(true);
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
    if (!this.onInput(this.pane.pane_id, ops, ++this.inputId)) { this.flashHint("bridge offline · keystrokes dropped"); return; }
    this.settledAfter = Number.MAX_SAFE_INTEGER; // until the ack
    this.caret.input(ops, performance.now());
    this.write();
  }

  private flashHint(text: string) {
    this.hintEl.textContent = text;
    this.hintEl.classList.add("warn");
    if (this.hintTimer !== null) clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => { this.hintTimer = null; this.renderHint(); }, 2500);
  }

  private poll() { if (this.pane) this.onRead(this.pane.pane_id, ++this.readSeq); }

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

  /**
   * Give xterm the pane's size. A read with more rows than xterm has scrolls
   * the whole screen up and, with no scrollback, drops the top rows. Herdr's
   * layout rect is not the pane's real size (on 0.9.1 it stays at 120×40
   * whatever size the attached client gives the pane), so the rows come from
   * the reads, else the pane's `viewport_rows`, and the columns grow to fit
   * the widest row read. Returns whether xterm was resized.
   */
  private resizeToPane(): boolean {
    if (!this.pane) return false;
    const id = this.pane.pane_id;
    const rect = this.snapshot?.layouts.flatMap((l) => l.panes).find((p) => p.pane_id === id)?.rect;
    const rows = Math.max(5, this.readRows || this.pane.scroll?.viewport_rows || rect?.height || this.term.rows);
    const cols = Math.max(20, this.readCols, rect?.width ?? 0);
    this.caret.cols = cols;
    if (cols === this.term.cols && rows === this.term.rows) return false;
    this.term.resize(cols, rows);
    this.fit();
    return true;
  }

  /**
   * Pick the largest font (up to FONT_MAX) at which the whole pane fits the
   * panel. Runs again whenever the panel or xterm's screen changes size.
   */
  private fit() {
    const screen = this.host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen || !this.el.classList.contains("open")) return;
    // Measure the box itself, not clientWidth/Height: a scrollbar showing up
    // while it overflows must not change the target.
    const cs = getComputedStyle(this.host);
    const box = this.host.getBoundingClientRect();
    const w = box.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const h = box.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const r = screen.getBoundingClientRect();
    if (w <= 0 || h <= 0 || !r.width || !r.height) return;
    const key = `${w}x${h}:${this.term.cols}x${this.term.rows}`;
    if (key !== this.fitFor) { this.fitFor = key; this.fontCap = FONT_MAX; }
    const size = this.term.options.fontSize ?? FONT_MAX;
    // Cells are rounded to whole pixels, so the estimate can overshoot: when
    // it does, step down and never try that size again for this panel size.
    const overflow = r.width > w + 0.5 || r.height > h + 0.5;
    if (overflow) this.fontCap = Math.min(this.fontCap, size - 0.5);
    const estimate = Math.floor(size * Math.min(w / r.width, h / r.height) * 2) / 2;
    const next = Math.max(FONT_MIN, Math.min(this.fontCap, estimate));
    if (next === size) return;
    this.term.options.fontSize = next;
    this.shownCursor = ""; // re-place the cursor (and xterm's input box) at the new cell size
    this.write();
  }

  /** If the pane is still taller than the panel at the smallest font, scroll so the caret row shows. */
  private revealCaret() {
    const h = this.host;
    if (h.scrollHeight <= h.clientHeight || this.caret.row < 0) return;
    const screen = h.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) return;
    const cell = screen.getBoundingClientRect().height / this.term.rows;
    const top = this.caret.row * cell;
    if (top < h.scrollTop || top + 2 * cell > h.scrollTop + h.clientHeight) h.scrollTop = Math.max(0, top - h.clientHeight / 2);
  }
}

