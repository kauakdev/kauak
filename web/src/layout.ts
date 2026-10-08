// Turns a floor's snapshot into an office floor plan in tile coordinates.
//
//   repository  → wing  (a row of rooms sharing a repo key)
//   workspace   → room  (one per checkout / worktree)
//   pane        → desk  (a pane is a desk whether or not an agent sits there)
//   agent       → person at the desk
//
// In build mode every room grows by one desk cell for a "new desk" slot, every
// wing ends in a slot for a new room, and a last slot below the wings takes a
// room in any other folder.

import type { PaneInfo, Snapshot, WorkspaceInfo } from "./types";

export const CELL = 3;          // tiles per desk cell
export const WALL = 1;          // tiles of padding inside a room
export const ROOM_GAP = 2;      // tiles between rooms
export const WING_GAP = 3;      // tiles between wings

/** A tile position: a desk's corner. */
export interface Spot { x: number; y: number }

/** A tile rectangle. */
export interface Plot extends Spot { w: number; h: number }

/** A pane's desk. Its position is room-relative until the layout places the room. */
export interface Desk extends Spot {
  pane: PaneInfo;
}

export interface Room extends Plot {
  workspace: WorkspaceInfo;
  desks: Desk[];
  focused: boolean;
  /** Build mode: where a new desk goes. */
  slot: Spot | null;
}

export interface Wing extends Plot {
  key: string;
  name: string;
  rooms: Room[];
  /** Build mode: where a new room goes, at the end of the wing. */
  slot: Plot | null;
}

export interface Office {
  wings: Wing[];
  w: number; h: number;
  /** Build mode: a new room in any other folder, below every wing. */
  slot: Plot | null;
}

/** The smallest room: one desk cell. Also the size of a new-room slot. */
const ROOM_MIN = CELL + WALL * 2;

function roomFor(ws: WorkspaceInfo, panes: PaneInfo[], build: boolean): Room {
  const n = Math.max(1, panes.length + (build ? 1 : 0));
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const cell = (i: number): Spot => ({ x: WALL + (i % cols) * CELL + 1, y: WALL + Math.floor(i / cols) * CELL + 1 });
  return {
    workspace: ws,
    x: 0, y: 0,
    w: cols * CELL + WALL * 2,
    h: rows * CELL + WALL * 2,
    desks: panes.map((pane, i) => ({ pane, ...cell(i) })),
    focused: ws.focused || panes.some((p) => p.focused),
    slot: build ? cell(panes.length) : null,
  };
}

export function buildOffice(snap: Snapshot, build = false): Office {
  const panesByWs = new Map<string, PaneInfo[]>();
  for (const p of snap.panes) {
    const list = panesByWs.get(p.workspace_id) ?? [];
    list.push(p);
    panesByWs.set(p.workspace_id, list);
  }

  // Group by repository. Workspaces without a repo share a "loose" wing.
  const groups = new Map<string, { name: string; ws: WorkspaceInfo[] }>();
  for (const ws of [...snap.workspaces].sort((a, b) => a.number - b.number)) {
    // The runtime may not know a workspace's repository (Herdr only does for
    // the ones it recognizes as a git checkout). Fall back to the first
    // pane's folder so the room still lands in a sensibly named wing.
    const fallbackDir = panesByWs.get(ws.workspace_id)?.[0]?.cwd ?? ws.label ?? "loose";
    const key = ws.repo?.key ?? `dir:${fallbackDir}`;
    const name = ws.repo?.name ?? (fallbackDir.split("/").pop() || "loose");
    const g = groups.get(key) ?? { name, ws: [] };
    g.ws.push(ws);
    groups.set(key, g);
  }

  const wings: Wing[] = [];
  let cursorY = 0;
  let maxW = 0;
  for (const [key, g] of groups) {
    const rooms = g.ws.map((ws) => roomFor(ws, panesByWs.get(ws.workspace_id) ?? [], build));
    let cursorX = 0;
    let wingH = 0;
    for (const r of rooms) {
      r.x = cursorX; r.y = cursorY;
      for (const d of r.desks) { d.x += r.x; d.y += r.y; }
      if (r.slot) { r.slot.x += r.x; r.slot.y += r.y; }
      cursorX += r.w + ROOM_GAP;
      wingH = Math.max(wingH, r.h);
    }
    const slot = build ? { x: cursorX, y: cursorY, w: ROOM_MIN, h: ROOM_MIN } : null;
    if (slot) cursorX += slot.w + ROOM_GAP;
    const w = Math.max(0, cursorX - ROOM_GAP);
    wings.push({ key, name: g.name, x: 0, y: cursorY, w, h: wingH, rooms, slot });
    maxW = Math.max(maxW, w);
    cursorY += wingH + WING_GAP;
  }
  const slot = build ? { x: 0, y: cursorY, w: ROOM_MIN, h: ROOM_MIN } : null;
  if (slot) { maxW = Math.max(maxW, slot.w); cursorY += slot.h + WING_GAP; }
  return { wings, w: maxW, h: Math.max(0, cursorY - WING_GAP), slot };
}
