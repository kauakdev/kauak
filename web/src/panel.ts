// Terminal side panel. The top is a read-only xterm.js mirror of the selected
// pane's screen and the history above it (polled from the bridge, redrawn
// only when the text changes). Below it, a message box and a row of key
// buttons send input to the pane through the bridge.
//
// History is Herdr's scrollback, so a program on the alternate screen (Claude
// Code's fullscreen mode) has none: its transcript is its own, and the wheel
// scrolls it with Page Up and Page Down.
//
// Herdr hands out snapshots of the screen, with no cursor position and no
// output stream, so the mirror does not pretend to be a live terminal: you
// type into an ordinary text box, and nothing reaches the pane until Enter or
// a key button.
//
// The box borrows two things from agents' own prompts: a "/" menu of the
// agent's commands (slash.ts), and Claude Code's shadow text, the dim
// suggestion in its empty prompt, which Tab takes (shadow.ts).

import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { contextLevel, contextPercent, contextText } from "./context";
import { promptShadow, type Shadow } from "./shadow";
import { SlashMenu } from "./slash";
import type { InputOp, PaneInfo, SlashCommand, Snapshot } from "./types";

const POLL_MS = 400;
// Rows of history read above the pane's screen. Every poll carries them
// (~75 KB for 1000 styled rows), so this is how far back the mirror goes.
const HISTORY_ROWS = 1000;
// A page key scrolls Claude Code's transcript by about 40% of its screen; a
// wheel turn that far over the mirror sends one.
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const WHEEL_PAGE = 0.4;
const WHEEL_LINE_PX = 16;
// Once Herdr has the input, read right away, then again once the program has
// had time to react.
const AFTER_INPUT_READS_MS = [0, 120];
// The pane is mirrored at its real size; the font shrinks so its full width
// fits the panel, and a pane taller than the panel scrolls.
const FONT_MAX = 13;
const FONT_MIN = 8;
// While the message box is empty these go straight to the pane (menus,
// history, agent modes). Esc always does, and Enter sends the box.
const PASS_KEYS: Record<string, string> = { ArrowUp: "up", ArrowDown: "down", Tab: "tab" };
// Pasting a multi-line message into an agent: bracketed paste keeps the
// newlines from submitting it line by line (agents and modern shells all turn it on).
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
// Dragging the panel's left edge: no narrower than its header needs, and
// the roster (280px wide, 12px in) stays clear of it.
const WIDTH_KEY = "agent-office.panel-width";
const WIDTH_MIN = 420;
const OFFICE_MIN = 300;

export class TerminalPanel {
  private el = document.getElementById("panel")!;
  private titleEl = document.getElementById("panel-title")!;
  private metaEl = document.getElementById("panel-meta")!;
  private hintEl = document.getElementById("panel-hint")!;
  private host = document.getElementById("panel-term")!;
  private form = document.getElementById("panel-input") as HTMLFormElement;
  private box = document.getElementById("panel-text") as HTMLTextAreaElement;
  private sendBtn = document.getElementById("panel-send") as HTMLButtonElement;
  private takeBtn = document.getElementById("panel-take") as HTMLButtonElement;
  private liveBtn = document.getElementById("panel-live") as HTMLButtonElement;
  private menu = new SlashMenu(document.getElementById("panel-slash")!, this.box);
  private term: Terminal;
  private pane: PaneInfo | null = null;
  private lastText: string | null = null;
  private drafts = new Map<string, string>(); // unsent text per pane
  private commands = new Map<string, SlashCommand[]>(); // the "/" menu per pane
  private commandsFor = ""; // pane, agent and folder the menu was last asked for
  private shadow: Shadow | null = null; // Claude Code's dim prompt text, on the latest read
  private fontCap = FONT_MAX; // largest font known to fit the current panel size
  private fitFor = "";
  private readRows = 0; // rows in the last read of this pane
  private readCols = 0; // widest row read from this pane so far
  private pinned = true; // the mirror stays scrolled to the bottom, where the prompt is
  private history = false; // the pane has scrollback above its screen
  private held: string | null = null; // a read that came in while scrolled back into history
  private wheel = 0; // wheel travel toward the next page key
  // Reads are numbered so late, out-of-order replies are dropped.
  private readSeq = 0;
  private appliedSeq = 0;
  private inputId = 0;
  private timer: number | null = null;
  private snapshot: Snapshot | null = null;
  private hintTimer: number | null = null;

  onRead: (paneId: string, seq: number, lines: number) => void = () => {};
  onInput: (paneId: string, ops: InputOp[], id: number) => boolean = () => false;
  onListCommands: (paneId: string) => void = () => {};
  onFocus: (paneId: string) => void = () => {};
  onClose: () => void = () => {};
  onResize: () => void = () => {};

  constructor() {
    this.term = new Terminal({
      disableStdin: true,
      cursorBlink: false,
      cursorInactiveStyle: "none",
      fontSize: FONT_MAX,
      fontFamily: "ui-monospace, 'JetBrains Mono', Menlo, monospace",
      convertEol: false,
      scrollback: 0,
      theme: { background: "#0f1118", foreground: "#e8e9f0" },
    });
    this.term.open(this.host);
    // With no scrollback of its own, xterm turns the wheel into arrow keys and
    // cancels it, so the mirror would never scroll. The panel scrolls instead.
    this.term.attachCustomWheelEventHandler(() => false);

    document.getElementById("panel-close")!.addEventListener("click", () => this.close());
    document.getElementById("panel-focus")!.addEventListener("click", () => { if (this.pane) this.onFocus(this.pane.pane_id); });
    for (const b of this.el.querySelectorAll<HTMLButtonElement>("[data-key]")) b.addEventListener("click", () => this.sendKey(b.dataset.key!));
    // Buttons must not take keyboard focus: it stays in the message box, and a
    // later Space would click them instead of typing.
    for (const b of this.el.querySelectorAll("button")) b.addEventListener("mousedown", (e) => e.preventDefault());
    this.form.addEventListener("submit", (e) => { e.preventDefault(); this.submit(); });
    this.box.addEventListener("keydown", (e) => this.onKey(e));
    this.box.addEventListener("input", () => this.changed());
    // The menu shows only while the box has focus.
    this.box.addEventListener("blur", () => this.changed());
    this.box.addEventListener("focus", () => this.changed());
    this.menu.onPick = (cmd) => this.complete(cmd);
    this.takeBtn.addEventListener("click", () => this.takeSuggestion());
    addEventListener("resize", () => this.autosize()); // the panel's width follows the window's
    // A pane wider than the panel gets small text: dragging the edge makes room.
    const grip = document.getElementById("panel-resize")!;
    this.setWidth(Number(load(WIDTH_KEY)) || null);
    grip.addEventListener("pointerdown", (e) => this.dragWidth(e, grip));
    grip.addEventListener("dblclick", () => { this.setWidth(null); save(WIDTH_KEY, ""); this.onResize(); });
    // A click on the mirror means "I want to type", unless it selected text to copy.
    this.host.addEventListener("click", () => { if (!this.term.hasSelection() && finePointer()) this.box.focus(); });
    this.host.addEventListener("scroll", () => {
      this.pinned = this.atEdge(1);
      if (this.pinned) this.release();
      this.renderLive();
    });
    this.host.addEventListener("wheel", (e) => this.onWheel(e), { passive: true });
    this.liveBtn.addEventListener("click", () => this.toBottom());
    const ro = new ResizeObserver(() => { this.fit(); this.keepBottom(); });
    ro.observe(this.host);
    ro.observe(this.host.querySelector(".xterm-screen")!);
    // Esc in the message box goes to the pane (agents use it); Esc elsewhere closes the panel.
    addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.isTyping()) this.close();
    });
    this.changed();
  }

  /** True while keyboard focus is in the message box, so global shortcuts must stay out of the way. */
  isTyping(): boolean {
    return this.pane !== null && document.activeElement === this.box;
  }

  setSnapshot(s: Snapshot) {
    this.snapshot = s;
    if (!this.pane) return;
    const fresh = s.panes.find((p) => p.pane_id === this.pane!.pane_id);
    if (!fresh) { this.close(); return; }
    this.pane = fresh;
    this.renderHeader();
    this.resizeToPane();
    this.askCommands(); // an agent may have started or quit in the pane
  }

  open(pane: PaneInfo) {
    const switching = this.pane?.pane_id !== pane.pane_id;
    if (switching) this.saveDraft();
    this.pane = pane;
    this.el.classList.add("open");
    document.body.classList.add("panel-open");
    this.renderHeader();
    if (switching) {
      this.lastText = null;
      this.readRows = this.readCols = 0;
      this.pinned = true;
      this.history = false;
      this.held = null;
      this.renderLive();
      this.term.reset();
      this.resizeToPane();
      this.shadow = null;
      this.menu.setCommands(this.commands.get(pane.pane_id) ?? []);
      this.box.value = this.drafts.get(pane.pane_id) ?? "";
      this.changed();
    }
    this.askCommands();
    if (this.timer === null) {
      this.poll();
      this.timer = window.setInterval(() => this.poll(), POLL_MS);
    }
    // On a phone, focusing would pop the keyboard up over the terminal.
    if (finePointer()) this.box.focus();
    requestAnimationFrame(() => this.fit());
  }

  close() {
    const wasOpen = this.pane !== null;
    this.saveDraft();
    this.el.classList.remove("open");
    document.body.classList.remove("panel-open");
    this.pane = null;
    this.commandsFor = "";
    this.box.blur();
    if (wasOpen) this.onClose();
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
  }

  get selectedPaneId(): string | null { return this.pane?.pane_id ?? null; }

  /** The "/" menu's commands for a pane, from the bridge. */
  setCommands(paneId: string, cmds: SlashCommand[]) {
    this.commands.set(paneId, cmds);
    if (paneId !== this.pane?.pane_id) return;
    this.menu.setCommands(cmds);
    this.renderHint();
  }

  receive(paneId: string, text: string, seq: number) {
    if (!this.pane || paneId !== this.pane.pane_id || seq <= this.appliedSeq) return;
    this.appliedSeq = seq;
    // Scrolled back into history, the mirror holds still: new rows at the
    // bottom would push the ones being read off the top of the read.
    if (!this.pinned && this.history) {
      if (text !== this.lastText) this.held = text;
      this.renderLive();
      return;
    }
    this.show(text);
  }

  private show(text: string) {
    if (!this.pane) return;
    const rows = text.split("\r\n");
    const screenRows = this.pane.scroll?.viewport_rows ?? rows.length;
    this.history = rows.length > screenRows || (this.pane.scroll?.max_offset_from_bottom ?? 0) > 0;
    this.readRows = rows.length;
    this.readCols = Math.max(this.readCols, ...rows.map((r) => width(stripAnsi(r))));
    const resized = this.resizeToPane();
    // Herdr's `revision` does not move on plain output (verified on 0.9.1: it
    // stayed at 0 after typing and command output), so diff the text.
    if (text === this.lastText && !resized) return;
    this.lastText = text;
    // Rows come back only as long as their content, so a row that got shorter
    // would leave its old tail behind: clear the screen in the same write
    // (xterm paints once per frame, so there is no blank flash). Auto-wrap is
    // off (?7l) so a row wider than xterm is clipped instead of pushing every
    // row below it down a line. The cursor stays hidden (?25l): Herdr does not
    // say where it is.
    this.term.write("\x1b[?7l\x1b[H\x1b[2J" + text + "\x1b[?25l", () => this.keepBottom());
    // Only the screen: an old prompt up in the history is not the current one.
    this.setShadow(this.pane.agent === "claude" ? promptShadow(rows.slice(-screenRows).join("\r\n")) : null);
  }

  /** Input reached Herdr: read again soon to show what it did. */
  inputAcked(paneId: string, id: number | undefined) {
    if (!this.pane || paneId !== this.pane.pane_id || id !== this.inputId) return;
    for (const ms of AFTER_INPUT_READS_MS) window.setTimeout(() => this.poll(), ms);
  }

  inputFailed(paneId: string, message: string, _id?: number) {
    if (!this.pane || paneId !== this.pane.pane_id) return;
    this.flashHint(`input failed: ${message}`);
  }

  private onKey(e: KeyboardEvent) {
    if (e.isComposing) return;
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
    if (this.menu.open && plain && this.menuKey(e)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.altKey) { e.preventDefault(); this.submit(); return; }
    const empty = this.box.value === "";
    if (empty && plain && !e.shiftKey && e.key === "Tab" && this.shadow?.suggestion) {
      e.preventDefault();
      this.takeSuggestion();
      return;
    }
    let key: string | undefined;
    if (e.key === "Escape") key = "esc";
    else if (empty && e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "c") key = "ctrl+c";
    else if (empty && plain && e.key === "Tab") key = e.shiftKey ? "shift+tab" : "tab";
    else if (empty && plain && !e.shiftKey) key = PASS_KEYS[e.key];
    if (!key) return;
    e.preventDefault();
    e.stopPropagation();
    this.sendKey(key);
  }

  /** ↑ ↓ pick, Tab completes, Enter runs, Esc closes. Returns whether the menu took the key. */
  private menuKey(e: KeyboardEvent): boolean {
    const cmd = this.menu.current;
    if (!cmd) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") this.menu.move(e.key === "ArrowDown" ? 1 : -1);
    else if (e.key === "Tab") { if (e.shiftKey) this.menu.move(-1); else this.complete(cmd); }
    else if (e.key === "Enter" && !e.shiftKey) this.submit();
    else if (e.key === "Escape") { this.menu.dismiss(); this.changed(); }
    else return false;
    return true;
  }

  /** Put a command in the box, ready for its arguments. */
  private complete(cmd: SlashCommand) {
    this.box.value = `/${cmd.name} `;
    this.box.setSelectionRange(this.box.value.length, this.box.value.length);
    this.box.focus();
    this.changed();
  }

  /** Tab on an empty box: the agent's suggestion becomes the message, to send or edit. */
  private takeSuggestion() {
    if (!this.shadow?.suggestion || this.box.value) return;
    this.box.value = this.shadow.text;
    this.box.setSelectionRange(this.box.value.length, this.box.value.length);
    this.box.focus();
    this.changed();
  }

  /** The shadow text on the latest read shows through the empty box, as it does in the agent's prompt. */
  private setShadow(shadow: Shadow | null) {
    if (shadow?.text === this.shadow?.text && shadow?.suggestion === this.shadow?.suggestion) return;
    this.shadow = shadow;
    this.renderPlaceholder();
    this.changed();
  }

  /** Ask the bridge for the menu when the pane, its agent or its folder is new. */
  private askCommands() {
    const p = this.pane;
    const key = p?.agent ? `${p.pane_id}|${p.agent}|${p.foreground_cwd || p.cwd}` : "";
    if (key === this.commandsFor) return;
    this.commandsFor = key;
    if (!p) return;
    if (p.agent) this.onListCommands(p.pane_id);
    else this.setCommands(p.pane_id, []);
  }

  /**
   * Enter: the box's text (if any) and then Enter. An empty box just presses
   * Enter. With the "/" menu open, the highlighted command is what goes.
   */
  private submit() {
    const cmd = this.menu.current;
    if (cmd) this.box.value = `/${cmd.name}`;
    const text = this.box.value.replace(/\s+$/, "");
    const ops: InputOp[] = [];
    if (text) ops.push({ text: text.includes("\n") ? PASTE_START + text.replace(/\r?\n/g, "\r") + PASTE_END : text });
    ops.push({ keys: ["enter"] });
    if (!this.send(ops)) return;
    this.box.value = "";
    this.changed();
    this.toBottom();
  }

  private sendKey(key: string) { if (this.send([{ keys: [key] }])) this.toBottom(); }

  private send(ops: InputOp[]): boolean {
    if (!this.pane) return false;
    if (this.onInput(this.pane.pane_id, ops, ++this.inputId)) return true;
    this.flashHint("bridge offline · nothing was sent");
    return false;
  }

  private saveDraft() {
    if (!this.pane) return;
    if (this.box.value) this.drafts.set(this.pane.pane_id, this.box.value);
    else this.drafts.delete(this.pane.pane_id);
  }

  /** After any change to the box's text: size, menu, buttons and hint follow it. */
  private changed() {
    if (document.activeElement === this.box) this.menu.update(this.box.value);
    else this.menu.close();
    this.autosize();
    this.takeBtn.hidden = !(this.shadow?.suggestion && this.box.value === "");
    this.renderHint();
  }

  /** Grow the box with its text (CSS caps it), and say what the send button will do. */
  private autosize() {
    this.box.style.height = "";
    if (this.box.value) this.box.style.height = `${this.box.scrollHeight}px`;
    const empty = this.box.value.trim() === "";
    const cmd = this.menu.current;
    this.sendBtn.textContent = cmd ? "Run" : empty ? "Enter ↵" : "Send";
    this.sendBtn.title = cmd ? "Run the highlighted command (Enter)" : empty ? "Press Enter in the pane (to accept a prompt, say)" : "Send the message, then Enter (Enter)";
  }

  private renderHint() {
    if (this.hintTimer !== null) return; // a flashed message has the line for now
    this.hintEl.classList.remove("warn");
    const typed = /^\/([\w.:-]+) /.exec(this.box.value);
    const usage = typed && this.menu.find(typed[1]!)?.hint;
    this.hintEl.textContent = this.menu.open ? "↑ ↓ pick · Tab completes · Enter runs · Esc closes"
      : usage ? `/${typed[1]} ${usage}`
      : this.box.value === "" && this.shadow?.suggestion ? "Tab takes the suggestion · Esc, and ↑ ↓ ⌃C in an empty box, go to the pane"
      : `Enter sends · Shift+Enter new line${this.menu.any ? " · / for commands" : ""} · Esc, and ↑ ↓ Tab ⌃C in an empty box, go to the pane`;
  }

  private flashHint(text: string) {
    this.hintEl.textContent = text;
    this.hintEl.classList.add("warn");
    if (this.hintTimer !== null) clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => { this.hintTimer = null; this.renderHint(); }, 2500);
  }

  private poll() {
    if (this.pane) this.onRead(this.pane.pane_id, ++this.readSeq, (this.pane.scroll?.viewport_rows ?? 0) + HISTORY_ROWS);
  }

  private renderHeader() {
    if (!this.pane) return;
    const p = this.pane;
    this.titleEl.textContent = p.terminal_title_stripped || p.terminal_title || p.pane_id;
    this.metaEl.textContent = `${p.pane_id} · ${(p.foreground_cwd || p.cwd).replace(/^\/home\/[^/]+/, "~")}`;
    const kind = document.getElementById("panel-kind")!;
    kind.textContent = p.agent ?? "shell";
    kind.dataset.kind = p.agent ?? "";
    document.getElementById("panel-status")!.textContent = p.agent ? p.agent_status : "no agent";
    const ctx = document.getElementById("panel-ctx")!;
    ctx.hidden = !p.context;
    if (p.context) {
      ctx.title = `Context: ${contextText(p.context)}`;
      ctx.querySelector(".ctx")!.className = `ctx ${contextLevel(p.context)}`;
      ctx.querySelector<HTMLElement>(".ctx i")!.style.width = contextPercent(p.context);
      ctx.querySelector(".pct")!.textContent = `${contextPercent(p.context)} context`;
    }
    this.el.dataset.status = p.agent_status;
    this.renderPlaceholder();
  }

  private renderPlaceholder() {
    const p = this.pane;
    this.box.placeholder = this.shadow?.text ?? (p?.agent ? `Message ${p.agent}` : "Run a command");
  }

  /**
   * Give xterm the pane's size. A read with more rows than xterm has scrolls
   * the whole screen up and, with no scrollback, drops the top rows. Reads
   * leave out blank rows at the bottom, so the rows come from the reads, else
   * the pane's `viewport_rows`. The columns are the layout rect's width when
   * the rect is the pane's real size (its height matches `viewport_rows`; on
   * Herdr 0.9.1 it stayed at 120×40 whatever size the attached client gave
   * the pane). Otherwise they grow to fit the widest row read. Returns whether
   * xterm was resized.
   */
  private resizeToPane(): boolean {
    if (!this.pane) return false;
    const id = this.pane.pane_id;
    const rect = this.snapshot?.layouts.flatMap((l) => l.panes).find((p) => p.pane_id === id)?.rect;
    const rows = Math.max(5, this.readRows || this.pane.scroll?.viewport_rows || rect?.height || this.term.rows);
    const real = rect !== undefined && rect.height === this.pane.scroll?.viewport_rows;
    const cols = Math.max(20, real ? rect.width : Math.max(this.readCols, rect?.width ?? 0));
    if (cols === this.term.cols && rows === this.term.rows) return false;
    this.term.resize(cols, rows);
    this.fit();
    return true;
  }

  /**
   * Pick the largest font (up to FONT_MAX) at which the pane's full width fits
   * the panel. Not its height: since reads leave out blank rows, the text
   * would shrink as the pane filled up, and a full pane would need a tiny
   * font. A pane taller than the panel scrolls, kept at the bottom (the
   * prompt). Runs again whenever the panel or xterm's screen changes size.
   */
  private fit() {
    const screen = this.host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen || !this.el.classList.contains("open")) return;
    // The scrollbar's gutter is always reserved (scrollbar-gutter: stable), so
    // the width does not change when the pane starts to overflow the height.
    const cs = getComputedStyle(this.host);
    const w = this.host.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const r = screen.getBoundingClientRect();
    if (w <= 0 || !r.width) return;
    const key = `${w}:${this.term.cols}`;
    if (key !== this.fitFor) { this.fitFor = key; this.fontCap = FONT_MAX; }
    const size = this.term.options.fontSize ?? FONT_MAX;
    // Cells are rounded to whole pixels, so the estimate can overshoot: when
    // it does, step down and never try that size again for this panel width.
    if (r.width > w + 0.5) this.fontCap = Math.min(this.fontCap, size - 0.5);
    const estimate = Math.floor(size * (w / r.width) * 2) / 2;
    const next = Math.max(FONT_MIN, Math.min(this.fontCap, estimate));
    if (next !== size) this.term.options.fontSize = next;
  }

  /** Follow the pointer while the panel's edge is dragged, and keep the width for next time. */
  private dragWidth(e: PointerEvent, grip: HTMLElement) {
    if (e.button !== 0) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing-panel");
    let width: number | null = null;
    const move = (ev: PointerEvent) => { width = this.setWidth(innerWidth - ev.clientX); };
    const end = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", end);
      grip.removeEventListener("pointercancel", end);
      document.body.classList.remove("resizing-panel");
      if (width === null) return; // a click, not a drag
      save(WIDTH_KEY, String(width));
      this.onResize();
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
  }

  /**
   * Set the panel's width in px, or null for the default. The window can
   * shrink later, so CSS caps it again. Returns the width set.
   */
  private setWidth(px: number | null): number | null {
    const root = document.documentElement.style;
    if (px === null) { root.removeProperty("--panel-custom"); return null; }
    const width = Math.round(Math.max(WIDTH_MIN, Math.min(innerWidth - OFFICE_MIN, px)));
    root.setProperty("--panel-custom", `min(${width}px, calc(100vw - ${OFFICE_MIN}px))`);
    return width;
  }

  /** If the pane is taller than the panel, keep its bottom rows (the prompt) in view. */
  private keepBottom() {
    if (this.pinned) this.host.scrollTop = this.host.scrollHeight;
  }

  /** Whether the mirror is scrolled all the way down (1) or up (-1). */
  private atEdge(dir: 1 | -1): boolean {
    const h = this.host;
    return dir < 0 ? h.scrollTop <= 0 : h.scrollTop + h.clientHeight >= h.scrollHeight - 2;
  }

  /** Back to the latest rows: after input, or from the button. */
  private toBottom() {
    this.pinned = true;
    this.host.scrollTop = this.host.scrollHeight;
    this.release();
    this.renderLive();
  }

  /** Show the read that waited while the mirror was scrolled back. */
  private release() {
    const text = this.held;
    this.held = null;
    if (text !== null) this.show(text);
  }

  private renderLive() {
    this.liveBtn.hidden = this.pinned || !this.history;
    this.liveBtn.textContent = this.held !== null ? "New output ↓" : "Jump to bottom ↓";
  }

  /**
   * A program on the alternate screen has no scrollback here, so a wheel turn
   * past the mirror's edge goes to an agent as Page Up or Page Down, which
   * scroll Claude Code's fullscreen transcript (and do nothing much elsewhere).
   * Not to a shell: it would type them.
   */
  private onWheel(e: WheelEvent) {
    if (!this.pane?.agent || this.history || e.ctrlKey) return;
    const screen = this.host.querySelector<HTMLElement>(".xterm-screen")!;
    const dy = e.deltaY * (e.deltaMode === 1 ? WHEEL_LINE_PX : e.deltaMode === 2 ? this.host.clientHeight : 1);
    if (dy === 0 || !this.atEdge(dy < 0 ? -1 : 1)) { this.wheel = 0; return; }
    if (Math.sign(dy) !== Math.sign(this.wheel)) this.wheel = 0;
    this.wheel += dy;
    const page = Math.max(40, screen.getBoundingClientRect().height * WHEEL_PAGE);
    const pages = Math.trunc(this.wheel / page);
    if (!pages) return;
    this.wheel -= pages * page;
    this.send([{ text: (pages < 0 ? PAGE_UP : PAGE_DOWN).repeat(Math.min(Math.abs(pages), 5)) }]);
  }
}

function finePointer(): boolean {
  return matchMedia("(hover: hover) and (pointer: fine)").matches;
}

// localStorage can be missing or throw (private windows, blocked site data).
function load(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function save(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch {}
}

const ESC_RE = /\x1b(?:\[[0-9;:?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][A-Za-z0-9]|.)/g;

function stripAnsi(s: string): string {
  return s.replace(ESC_RE, "");
}

/** Terminal cell width: wide CJK and emoji take two cells, combining marks none. */
function width(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x300) w += 1;
    else if ((c <= 0x36f) || c === 0x200d || (c >= 0xfe00 && c <= 0xfe0f)) continue;
    else w += isWide(c) ? 2 : 1;
  }
  return w;
}

function isWide(c: number): boolean {
  return (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd);
}
