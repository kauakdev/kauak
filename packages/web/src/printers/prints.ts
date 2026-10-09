// What every room's printer has printed: one sheet per file edit in the
// room's git checkout (the bridge's enrichers/diffs/). Rooms in one checkout
// share a printer's sheets, so they are kept per floor and checkout
// ("machine/<root>").
//
// A sheet that arrives live is queued until the scene has printed it, one at
// a time; the ones a page gets on connecting are already on the tray, and
// only live ones count as new until they are read.

import { floorOf, keyOf } from "../floors/floors";
import type { DiffSheet, WorkspaceInfo } from "@kauak/protocol";

// Same as the bridge keeps per checkout.
const MAX_SHEETS = 50;

/** A room's printer: its floor and checkout. Null for a room outside git. */
export function printerOf(ws: WorkspaceInfo): string | null {
  return ws.git_root ? keyOf(floorOf(ws.workspace_id), ws.git_root) : null;
}

export class Prints {
  /** printer → sheets, oldest first */
  private sheets = new Map<string, DiffSheet[]>();
  /** printer → how many of its newest sheets are still to be printed */
  private queued = new Map<string, number>();
  /** ids of sheets that are read, or were already printed when the page connected */
  private seen = new Set<string>();

  /** Everything a floor's printers hold, on (re)connecting. */
  reset(machine: string, sheets: DiffSheet[]) {
    for (const key of [...this.sheets.keys()]) {
      if (floorOf(key) === machine) {
        this.sheets.delete(key);
        this.queued.delete(key);
      }
    }
    for (const s of sheets) {
      this.list(keyOf(machine, s.root)).push(s);
      this.seen.add(s.id);
    }
  }

  add(machine: string, sheet: DiffSheet) {
    const key = keyOf(machine, sheet.root);
    const list = this.list(key);
    list.push(sheet);
    if (list.length > MAX_SHEETS) list.splice(0, list.length - MAX_SHEETS);
    this.queued.set(key, Math.min(list.length, (this.queued.get(key) ?? 0) + 1));
  }

  /** The sheets on the printer's tray, oldest first. */
  printed(key: string): DiffSheet[] {
    const list = this.sheets.get(key) ?? [];
    return list.slice(0, list.length - (this.queued.get(key) ?? 0));
  }

  printedCount(key: string): number {
    return (this.sheets.get(key)?.length ?? 0) - (this.queued.get(key) ?? 0);
  }

  /** The newest sheet on the tray, or null. */
  latest(key: string): DiffSheet | null {
    return this.sheets.get(key)?.[this.printedCount(key) - 1] ?? null;
  }

  /** The next sheet is out on the tray; `all` puts every queued one there. */
  done(key: string, all = false) {
    const q = this.queued.get(key) ?? 0;
    if (q > 0) this.queued.set(key, all ? 0 : q - 1);
  }

  queuedCount(key: string): number {
    return this.queued.get(key) ?? 0;
  }

  /** Printed sheets nobody has read yet. */
  unread(key: string): number {
    const list = this.sheets.get(key) ?? [];
    let n = 0;
    for (let i = 0, end = this.printedCount(key); i < end; i++) if (!this.seen.has(list[i]!.id)) n++;
    return n;
  }

  markRead(id: string) {
    this.seen.add(id);
  }

  private list(key: string): DiffSheet[] {
    let list = this.sheets.get(key);
    if (!list) this.sheets.set(key, (list = []));
    return list;
  }
}
