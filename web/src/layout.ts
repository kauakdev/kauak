// Turns a Herdr snapshot into an office floor plan in tile coordinates.
//
//   repository  → wing  (a row of rooms sharing a repo_key)
//   workspace   → room  (one per checkout / worktree)
//   pane        → desk  (a pane is a desk whether or not an agent sits there)
//   agent       → person at the desk

import type { PaneInfo, Snapshot, WorkspaceInfo } from "./types";

export const CELL = 3;          // tiles per desk cell
export const WALL = 1;          // tiles of padding inside a room
export const ROOM_GAP = 2;      // tiles between rooms
export const WING_GAP = 3;      // tiles between wings

export interface Desk {
  pane: PaneInfo;
  x: number; y: number;         // tile position (room-relative → absolute after layout)
}

export interface Room {
  workspace: WorkspaceInfo;
  x: number; y: number; w: number; h: number;
  desks: Desk[];
  focused: boolean;
}

export interface Wing {
  key: string;
  name: string;
  x: number; y: number; w: number; h: number;
  rooms: Room[];
}

export interface Office {
  wings: Wing[];
  w: number; h: number;
}

function roomFor(ws: WorkspaceInfo, panes: PaneInfo[], focusedPane: string | null): Room {
  const n = Math.max(1, panes.length);
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const desks: Desk[] = panes.map((pane, i) => ({
    pane,
    x: WALL + (i % cols) * CELL + 1,
    y: WALL + Math.floor(i / cols) * CELL + 1,
  }));
  return {
    workspace: ws,
    x: 0, y: 0,
    w: cols * CELL + WALL * 2,
    h: rows * CELL + WALL * 2,
    desks,
    focused: ws.focused || panes.some((p) => p.pane_id === focusedPane),
  };
}

export function buildOffice(snap: Snapshot): Office {
  const panesByWs = new Map<string, PaneInfo[]>();
  for (const p of snap.panes) {
    const list = panesByWs.get(p.workspace_id) ?? [];
    list.push(p);
    panesByWs.set(p.workspace_id, list);
  }

  // Group by repository. Workspaces without a repo share a "loose" wing.
  const groups = new Map<string, { name: string; ws: WorkspaceInfo[] }>();
  for (const ws of [...snap.workspaces].sort((a, b) => a.number - b.number)) {
    // Herdr only attaches worktree metadata for workspaces it recognizes as a
    // git checkout. Fall back to the first pane's cwd so the room still lands
    // in a sensibly named wing.
    const fallbackDir = panesByWs.get(ws.workspace_id)?.[0]?.cwd ?? ws.label ?? "loose";
    const key = ws.worktree?.repo_key ?? `dir:${fallbackDir}`;
    const name = ws.worktree?.repo_name ?? (fallbackDir.split("/").pop() || "loose");
    const g = groups.get(key) ?? { name, ws: [] };
    g.ws.push(ws);
    groups.set(key, g);
  }

  const wings: Wing[] = [];
  let cursorY = 0;
  let maxW = 0;
  for (const [key, g] of groups) {
    const rooms = g.ws.map((ws) => roomFor(ws, panesByWs.get(ws.workspace_id) ?? [], snap.focused_pane_id));
    let cursorX = 0;
    let wingH = 0;
    for (const r of rooms) {
      r.x = cursorX; r.y = cursorY;
      for (const d of r.desks) { d.x += r.x; d.y += r.y; }
      cursorX += r.w + ROOM_GAP;
      wingH = Math.max(wingH, r.h);
    }
    const w = Math.max(0, cursorX - ROOM_GAP);
    wings.push({ key, name: g.name, x: 0, y: cursorY, w, h: wingH, rooms });
    maxW = Math.max(maxW, w);
    cursorY += wingH + WING_GAP;
  }
  return { wings, w: maxW, h: Math.max(0, cursorY - WING_GAP) };
}
