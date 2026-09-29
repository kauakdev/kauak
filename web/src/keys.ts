// Turns the byte stream xterm.js emits for keystrokes into Herdr input ops.
//
// xterm already encodes keys the way a real terminal would ("\r" for Enter,
// "\x1b[A" for Up, "\x03" for Ctrl+C). Herdr wants literal text via
// `pane.send_text` and named keys via `pane.send_keys` ("enter", "ctrl+c",
// "esc"). Named keys let Herdr honor the pane's own key encoding modes
// (application cursor keys, bracketed paste, kitty protocol) instead of us.

import type { InputOp } from "./types";

const ESC = "\x1b";

// Escape sequences → key names. Longest match wins. Herdr 0.9.1 has no names
// for Home/End/PageUp/PageDown/Delete/Insert (`invalid_key`), so those fall
// through to the raw-bytes path below, which Herdr forwards verbatim.
const SEQUENCES: Record<string, string> = {
  "\x1b[A": "up", "\x1bOA": "up",
  "\x1b[B": "down", "\x1bOB": "down",
  "\x1b[C": "right", "\x1bOC": "right",
  "\x1b[D": "left", "\x1bOD": "left",
  "\x1b[Z": "shift+tab",
  "\x1bOP": "f1", "\x1bOQ": "f2", "\x1bOR": "f3", "\x1bOS": "f4",
  "\x1b[15~": "f5", "\x1b[17~": "f6", "\x1b[18~": "f7", "\x1b[19~": "f8",
  "\x1b[20~": "f9", "\x1b[21~": "f10", "\x1b[23~": "f11", "\x1b[24~": "f12",
};

// Modified arrows: "\x1b[1;5A" → ctrl+up. Modifier bitmask per xterm: 1 + shift(1) alt(2) ctrl(4).
const MODIFIED = /^\x1b\[1;(\d)([ABCD])$/;
const MOD_TARGET: Record<string, string> = { A: "up", B: "down", C: "right", D: "left" };
function modifiers(n: number): string {
  const m = n - 1;
  const parts: string[] = [];
  if (m & 4) parts.push("ctrl");
  if (m & 2) parts.push("alt");
  if (m & 1) parts.push("shift");
  return parts.join("+");
}

const SINGLE: Record<string, string> = {
  "\r": "enter",
  "\n": "enter",
  "\t": "tab",
  "\x7f": "backspace",
  "\x08": "backspace",
  "\x1b": "esc",
};

/** Encode one xterm `onData` chunk into ordered ops. Consecutive text is merged, consecutive keys are merged. */
export function encodeInput(data: string): InputOp[] {
  const ops: InputOp[] = [];
  const pushText = (t: string) => {
    const last = ops[ops.length - 1];
    if (last && "text" in last) last.text += t; else ops.push({ text: t });
  };
  const pushKey = (k: string) => {
    const last = ops[ops.length - 1];
    if (last && "keys" in last) last.keys.push(k); else ops.push({ keys: [k] });
  };

  let i = 0;
  while (i < data.length) {
    const ch = data.charAt(i);

    if (ch === ESC) {
      // Try the longest known escape sequence first (max 6 chars).
      let matched = false;
      for (let len = Math.min(6, data.length - i); len >= 2; len--) {
        const seq = data.slice(i, i + len);
        const name = SEQUENCES[seq];
        if (name) { pushKey(name); i += len; matched = true; break; }
        const mm = MODIFIED.exec(seq);
        if (mm) { pushKey(`${modifiers(Number(mm[1]))}+${MOD_TARGET[mm[2] ?? ""] ?? "up"}`); i += len; matched = true; break; }
      }
      if (matched) continue;
      const next: string | undefined = i + 1 < data.length ? data.charAt(i + 1) : undefined;
      if (next !== undefined && next !== "[" && next !== "O") {
        // Alt+key arrives as ESC followed by the key's own encoding.
        if (next >= " " && next <= "~") { pushKey(`alt+${next.toLowerCase()}`); i += 2; continue; }
        const code = next.charCodeAt(0);
        if (code >= 1 && code <= 26) { pushKey(`ctrl+alt+${String.fromCharCode(96 + code)}`); i += 2; continue; }
      }
      if (next === "[" || next === "O") {
        // Unknown CSI/SS3 sequence: forward the raw bytes and let the pane decode them.
        const end = findCsiEnd(data, i);
        pushText(data.slice(i, end)); i = end; continue;
      }
      pushKey("esc"); i += 1; continue;
    }

    const single = SINGLE[ch];
    if (single) { pushKey(single); i += 1; continue; }

    const code = ch.charCodeAt(0);
    if (code >= 1 && code <= 26) { pushKey(`ctrl+${String.fromCharCode(96 + code)}`); i += 1; continue; }
    if (code < 32) { pushText(ch); i += 1; continue; } // other control bytes: raw

    // Run of printable text (including unicode) up to the next control byte.
    let j = i + 1;
    while (j < data.length) {
      const c = data.charCodeAt(j);
      if (c < 32 || c === 0x7f) break;
      j++;
    }
    pushText(data.slice(i, j));
    i = j;
  }
  return ops;
}

// CSI sequences end at a byte in 0x40..0x7e; SS3 ends after one byte.
function findCsiEnd(data: string, start: number): number {
  if (data.charAt(start + 1) === "O") return Math.min(data.length, start + 3);
  let k = start + 2;
  while (k < data.length) {
    const c = data.charCodeAt(k);
    k++;
    if (c >= 0x40 && c <= 0x7e) break;
  }
  return k;
}
