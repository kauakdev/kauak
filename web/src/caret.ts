// Where to draw the terminal cursor, and what to show before the pane echoes.
// Herdr 0.9.1 reports no cursor position, and every Herdr request takes
// ~100 ms, so the real echo of a keystroke shows up a few hundred ms later.
// The panel therefore tracks the cursor itself:
//
//   - Keystrokes move the caret right away (text → right, backspace and ← →
//     left). The keystrokes are the source of truth for the column: screens
//     lag behind them, and some apps (Claude Code) drop trailing spaces.
//   - Typing at the end of the line is echoed locally at once (like mosh)
//     until a screen read shows the real echo.
//   - Keys whose effect cannot be predicted (history, word moves…) let the
//     next changed screen place the caret: right after whatever changed.
//   - After Enter (and other keys that redraw the prompt) it re-finds the
//     input line: the last row that looks like a prompt ("❯", "›", "➜", "$ "…).
//   - When typing stops, it checks the prediction against the screen, and
//     follows its row if the screen scrolls. Rows that change on their own
//     (spinners, timers) never attract it.
//
// Rows are compared as plain text with dim text blanked out: that is how
// agents draw placeholders ("Try …" in Claude Code), which the cursor sits before.

import type { InputOp } from "./types";

const ECHO_WINDOW_MS = 800; // screen changes this soon after a keystroke are its echo
const REANCHOR_MS = 1500; // after Enter & co, keep re-finding the prompt this long
const NOISE_MS = 4000; // rows that changed on their own are ignored this long
const ECHO_TTL_MS = 1000; // a local echo the pane never confirms is dropped after this

// Start of the input line of common agents and shells, or a prompt ending in "$ " / "# " / "% " / "> ".
const PROMPT_RE = /^\s*[❯›»➜λ>$](?:[\s\u00a0]|$)|[$#%>][\s\u00a0]$/;
// A prompt with nothing typed after it.
const BARE_PROMPT_RE = /^\s*[❯›»➜λ>$]$/;
// Keys after which the prompt may be redrawn somewhere else, and those of them that start a fresh, empty input line.
const REANCHOR_KEYS = new Set(["enter", "ctrl+c", "ctrl+d", "ctrl+j", "ctrl+l", "ctrl+m", "ctrl+z", "esc", "tab", "shift+tab"]);
const NEW_LINE_KEYS = new Set(["enter", "ctrl+c", "ctrl+d", "ctrl+j", "ctrl+m", "ctrl+z"]);
const HOME_SEQS = new Set(["\x1b[H", "\x1b[1~", "\x1bOH"]);
const END_SEQS = new Set(["\x1b[F", "\x1b[4~", "\x1bOF"]);

/** Local echo: from `col` on, row `row` shows `text` and then nothing. */
type Echo = { row: number; col: number; text: string; at: number };

export class Caret {
  /** Viewport row, or -1 when unknown (cursor hidden). */
  row = -1;
  col = 0;
  cols = 80;
  private rowText = ""; // right-trimmed text of the caret row in the last settled screen
  private floor = 0; // leftmost column of the input (end of the prompt), when known
  private typed = ""; // text appended at the end of the line since the caret was last placed
  private atEnd = false; // the caret is at the end of the input line
  private uncertain = false; // a key moved the caret in a way only the screen can tell
  private screen: string[] = [];
  private noisyUntil: number[] = [];
  private lastInputAt = -Infinity;
  private reanchorUntil = 0;
  private freshLine = false; // the pending re-anchor follows Enter & co, so the input line starts empty
  private echo: Echo | null = null;

  reset() {
    this.row = -1; this.col = 0; this.rowText = ""; this.floor = 0; this.echo = null; this.freshLine = false;
    this.typed = ""; this.atEnd = false; this.uncertain = false;
    this.screen = []; this.noisyUntil = []; this.lastInputAt = -Infinity; this.reanchorUntil = 0;
  }

  /** Escape sequence that paints the pending local echo (empty when there is none). */
  overlay(): string {
    const e = this.echo;
    return e ? `\x1b[0m\x1b[${e.row + 1};${e.col + 1}H${e.text}\x1b[K` : "";
  }

  /** Keystrokes were just sent: move the caret and echo them. */
  input(ops: InputOp[], now: number) {
    this.lastInputAt = now;
    if (this.row < 0) return;
    for (const op of ops) {
      if ("text" in op) {
        if (/[\r\n]/.test(op.text)) this.reanchor(now, true);
        else if (op.text.includes("\x1b")) {
          this.leaveEnd();
          if (HOME_SEQS.has(op.text)) this.col = this.floor;
          else if (END_SEQS.has(op.text)) this.col = this.lineEnd();
        } else this.type(op.text, now);
        continue;
      }
      for (const k of op.keys) {
        if (REANCHOR_KEYS.has(k)) this.reanchor(now, NEW_LINE_KEYS.has(k));
        else if (k === "backspace") this.erase(now);
        else {
          this.leaveEnd();
          if (k === "left") this.col = Math.max(this.floor, this.col - 1);
          else if (k === "right") this.col = Math.min(this.col + 1, Math.max(this.col, this.lineEnd()));
          else if (k === "ctrl+a" || k === "ctrl+u") this.col = this.floor;
          else if (k === "ctrl+e") this.col = this.lineEnd();
          else this.uncertain = true;
        }
      }
    }
    this.clamp();
  }

  /**
   * A new viewport arrived, as plain rows (see `plainRow`). `settled` means
   * the read was sent after Herdr acked every keystroke so far.
   */
  update(plain: string[], settled: boolean, now: number) {
    const prev = this.screen;
    this.screen = plain;
    const e = this.echo;
    if (e && (trimEnd(fromCol(plain[e.row] ?? "", e.col)) === trimEnd(e.text) || now - e.at > ECHO_TTL_MS)) this.echo = null;
    if (!settled) return;
    const idle = now - this.lastInputAt > ECHO_WINDOW_MS;
    const changed = (i: number) => prev.length > 0 && (prev[i] ?? "") !== (plain[i] ?? "");
    if (idle) for (let i = 0; i < Math.max(prev.length, plain.length); i++) if (changed(i)) this.noisyUntil[i] = now + NOISE_MS;

    if (this.row < 0 || now < this.reanchorUntil) { this.anchor(now); this.clamp(); return; }

    const cur = trimEnd(plain[this.row] ?? "");
    if (!idle) {
      // Echo of an unpredictable key: the caret goes right after what changed.
      if (this.uncertain && cur !== this.rowText) {
        this.col = diffEnd(this.rowText, cur);
        this.uncertain = false;
        this.typed = "";
        this.atEnd = this.col >= width(cur);
      }
      this.rowText = cur;
    } else {
      const prompt = lastPromptRow(plain);
      if (prompt >= 0 && prompt !== this.row && changed(prompt)) { this.anchor(now); this.clamp(); return; } // a new prompt showed up
      if (cur !== this.rowText) {
        const j = this.rowText ? nearest(plain, this.rowText, this.row) : -1;
        if (j >= 0) { this.row = j; this.rowText = trimEnd(plain[j]!); } // the screen scrolled: follow the row
        else if (commonPrefix(this.rowText, cur) >= 2) { // a late echo on the same line
          if (this.uncertain) this.col = diffEnd(this.rowText, cur);
          this.rowText = cur;
        } else { this.anchor(now); this.clamp(); return; } // the line is gone: start over
      }
      this.uncertain = false;
      if (this.atEnd && !this.echo) {
        // Typing at the end of the line: the caret belongs right after the
        // text, plus any trailing spaces typed (apps may not draw those).
        const spaces = /( *)$/.exec(this.typed)![1]!.length;
        this.col = Math.max(this.floor, width(this.rowText) + spaces);
      }
    }
    this.clamp();
  }

  private reanchor(now: number, freshLine: boolean) {
    if (now >= this.reanchorUntil) this.freshLine = false;
    this.freshLine ||= freshLine;
    this.reanchorUntil = now + REANCHOR_MS;
    this.leaveEnd();
  }

  private leaveEnd() { this.echo = null; this.typed = ""; this.atEnd = false; }

  /** Printable text: at the end of the line it is echoed at once; mid-line it shifts text we leave to the screen. */
  private type(text: string, now: number) {
    const w = width(text);
    const end = this.col >= this.lineEnd() && this.col + w < this.cols;
    if (end) {
      const e = this.echo;
      if (e && e.row === this.row && e.col + width(e.text) === this.col) { e.text += text; e.at = now; }
      else this.echo = { row: this.row, col: this.col, text, at: now };
      this.typed += text;
      this.atEnd = true;
    } else this.leaveEnd();
    this.col += w;
  }

  /** Backspace: at the end of the line the last cell is blanked at once. */
  private erase(now: number) {
    const c = this.col - 1;
    if (c < this.floor) return;
    if (this.col >= this.lineEnd()) {
      const e = this.echo;
      if (e && e.row === this.row && e.col <= c) { e.text = sliceCols(e.text, c - e.col); e.at = now; }
      else this.echo = { row: this.row, col: c, text: "", at: now };
      this.typed = Array.from(this.typed).slice(0, -1).join("");
      this.atEnd = true;
    } else { this.echo = null; this.typed = ""; this.atEnd = false; }
    this.col = c;
  }

  /** Put the caret at the end of the input line: the last prompt-looking row, else the last steady non-empty row. */
  private anchor(now: number) {
    const plain = this.screen;
    let r = lastPromptRow(plain);
    const isPrompt = r >= 0;
    if (r < 0) for (let i = plain.length - 1; i >= 0 && r < 0; i--) if (plain[i]!.trim() && !((this.noisyUntil[i] ?? 0) > now)) r = i;
    if (r < 0) r = Math.max(0, plain.length - 1);
    const text = plain[r] ?? "";
    const sameRow = r === this.row;
    this.row = r;
    this.rowText = trimEnd(text);
    // Prompts end in a space the input starts after ("❯ ", "$ ").
    this.col = width(this.rowText) + (text.length > this.rowText.length ? 1 : 0);
    // Right after Enter, or on a bare prompt, the input is empty: this is where it begins.
    if (isPrompt && ((now < this.reanchorUntil && this.freshLine) || BARE_PROMPT_RE.test(this.rowText))) this.floor = this.col;
    else if (!sameRow) this.floor = 0;
    this.typed = ""; this.atEnd = false; this.uncertain = false;
  }

  /** End of the input line: the pending echo when there is one (it blanks what follows), else the screen. */
  private lineEnd(): number {
    const e = this.echo;
    if (e && e.row === this.row) return e.col + width(trimEnd(e.text));
    return width(trimEnd(this.screen[this.row] ?? ""));
  }

  private clamp() { this.col = Math.max(0, Math.min(this.col, this.cols - 1)); }
}

function lastPromptRow(plain: string[]): number {
  for (let i = plain.length - 1; i >= 0; i--) if (PROMPT_RE.test(plain[i]!)) return i;
  return -1;
}

function nearest(plain: string[], text: string, from: number): number {
  for (let d = 1; d < plain.length; d++) {
    if (trimEnd(plain[from + d] ?? "") === text) return from + d;
    if (from - d >= 0 && trimEnd(plain[from - d]!) === text) return from - d;
  }
  return -1;
}

function commonPrefix(a: string, b: string): number {
  const A = Array.from(a), B = Array.from(b);
  let p = 0;
  while (p < A.length && p < B.length && A[p] === B[p]) p++;
  return p;
}

/** Column right after the part of `b` that differs from `a` (common prefix and suffix removed). */
function diffEnd(a: string, b: string): number {
  const A = Array.from(a), B = Array.from(b);
  let p = 0;
  while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let s = 0;
  while (s < A.length - p && s < B.length - p && A[A.length - 1 - s] === B[B.length - 1 - s]) s++;
  return width(B.slice(0, B.length - s).join(""));
}

const trimEnd = (s: string) => s.replace(/[\s\u00a0]+$/, "");

/** The first `cols` cells of `s`. */
function sliceCols(s: string, cols: number): string {
  let w = 0, out = "";
  for (const ch of s) { w += width(ch); if (w > cols) break; out += ch; }
  return out;
}

/** What `s` shows from cell `col` on. */
function fromCol(s: string, col: number): string {
  let w = 0, i = 0;
  for (const ch of s) { if (w >= col) break; w += width(ch); i += ch.length; }
  return s.slice(i);
}

const ESC_RE = /\x1b(?:\[([0-9;:?]*)[ -\/]*([@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][A-Za-z0-9]|.)/y;

/** One ANSI row as plain text, with dim (SGR 2) text blanked: agents draw placeholders dim. */
export function plainRow(s: string): string {
  let out = "", dim = false, i = 0;
  while (i < s.length) {
    if (s.charCodeAt(i) === 0x1b) {
      ESC_RE.lastIndex = i;
      const m = ESC_RE.exec(s);
      if (!m) { i++; continue; }
      if (m[2] === "m") dim = sgrDim(m[1] ?? "", dim);
      i += m[0].length;
      continue;
    }
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    i += ch.length;
    out += dim ? " ".repeat(width(ch)) : ch;
  }
  return out;
}

function sgrDim(params: string, dim: boolean): boolean {
  const ps = params.split(/[;:]/);
  for (let k = 0; k < ps.length; k++) {
    const p = ps[k] === "" ? 0 : Number(ps[k]);
    if (p === 0 || p === 22) dim = false;
    else if (p === 2) dim = true;
    else if (p === 38 || p === 48 || p === 58) k += ps[k + 1] === "5" ? 2 : ps[k + 1] === "2" ? 4 : 0; // skip color arguments
  }
  return dim;
}

/** Terminal cell width: wide CJK and emoji take two cells, combining marks none. */
export function width(s: string): number {
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
