// Claude Code's "shadow" text: the dim words in its empty prompt. After a turn
// that is a suggested next message (Tab takes it); otherwise a hint such as
// `Try "…"`. Herdr reads come with their styling, so it can be picked out of
// the mirrored screen: a "❯ " row between two rules, all of it dim.
//
//   ────────────────────────────────
//   ❯ yes, install it and build the pull version     ← "\x1b[2m…" after "❯ "
//   ────────────────────────────────

export interface Shadow {
  text: string;
  /** A suggestion to take with Tab, not a hint about the prompt itself. */
  suggestion: boolean;
}

// Every other placeholder Claude Code draws there (2.1.x): first-run examples,
// queued-message help, and the name of the agent being viewed.
const HINT = /^(Try "|Press |Message @)/;
// A wrapped suggestion takes a few rows; any more and this is not the prompt.
const MAX_ROWS = 6;

/** The shadow text in a Claude Code screen, or null when its prompt is not empty (or not on screen). */
export function promptShadow(screen: string): Shadow | null {
  const rows = screen.split("\r\n");
  for (let i = rows.length - 1; i > 0; i--) {
    const cells = styledCells(rows[i]!);
    // Claude Code puts a no-break space after the "❯".
    if (!/^❯[ \u00a0]/.test(plain(cells)) || !isRule(plain(styledCells(rows[i - 1]!)))) continue;
    const parts = [cells.slice(2)];
    let j = i + 1;
    for (; j < rows.length && j <= i + MAX_ROWS; j++) {
      const next = styledCells(rows[j]!);
      if (isRule(plain(next))) break;
      parts.push(next);
    }
    if (j >= rows.length || j > i + MAX_ROWS) return null;
    const all = parts.flat();
    const visible = all.filter((c) => c.ch.trim() !== "");
    // Typed text is not dim. Claude's own cursor may sit on the first letter, drawn inverted.
    if (!visible.some((c) => c.dim) || visible.some((c) => !c.dim && !c.inverse)) return null;
    const text = parts.map((p) => plain(p).replace(/\u00a0/g, " ").trim()).filter(Boolean).join(" ");
    return { text, suggestion: !HINT.test(text) };
  }
  return null;
}

interface Cell { ch: string; dim: boolean; inverse: boolean }

const TOKEN_RE = /\x1b\[([0-9;:]*)m|\x1b(?:\[[0-9;:?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][A-Za-z0-9]|.)|([^\x1b]+)/g;

/** A row's characters with the two attributes that matter here. */
function styledCells(row: string): Cell[] {
  const cells: Cell[] = [];
  let dim = false, inverse = false;
  for (const m of row.matchAll(TOKEN_RE)) {
    if (m[1] !== undefined) {
      const params = m[1].split(";");
      for (let k = 0; k < params.length; k++) {
        const p = params[k] === "" ? 0 : Number(params[k]);
        if (p === 0) dim = inverse = false;
        else if (p === 2) dim = true;
        else if (p === 22) dim = false;
        else if (p === 7) inverse = true;
        else if (p === 27) inverse = false;
        // 38/48/58;5;n and 38/48/58;2;r;g;b carry arguments that are not attributes.
        else if (p === 38 || p === 48 || p === 58) k += params[k + 1] === "5" ? 2 : params[k + 1] === "2" ? 4 : 0;
      }
    } else if (m[2] !== undefined) {
      for (const ch of m[2]) cells.push({ ch, dim, inverse });
    }
  }
  return cells;
}

function plain(cells: Cell[]): string {
  return cells.map((c) => c.ch).join("");
}

/** Claude Code's input box rules; the top one can carry a label ("──── name ──"). */
function isRule(text: string): boolean {
  return /^─{3,}/.test(text.trim());
}
