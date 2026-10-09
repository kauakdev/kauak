// The page's one HTML escape, for what the bridge reports (floor and room
// names, titles, folders, diffs) wherever the page writes it into innerHTML:
// the banner, the elevator, the HUD, the tooltip, the build slots and the printout.

/** `s` safe to put in HTML text or a double-quoted attribute; `'` is left alone, so never a single-quoted one. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
}
