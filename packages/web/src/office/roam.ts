// Idle agents leave their desks. They get up, walk to the room's vending
// machine for a drink, then sit on the bench or a lounge sofa, or stand around
// the room with it, until their agent gets work (or a question) and they hurry
// back. An empty chair reads as "free" at a glance; someone leaning back in it
// does not.
//
// Positions are room-local tiles (from the room's back corner), so a walk
// survives the room moving when another room or wing changes. Paths go round
// the furniture on a quarter-tile grid: A*, then pulled straight.

import type { Spot } from "./layout";

const RES = 0.25; // nav grid cell, in tiles
const RADIUS = 0.15; // how close a person gets to furniture
const WALK = 1.15; // tiles per second
const HURRY = 2.6; // back to the desk, the agent has work
export const VEND_S = 2.8; // at the machine: reach, stoop, take the drink

/** A floor rectangle (room-local tiles) people walk around. */
export interface Block {
  x: number;
  y: number;
  w: number;
  d: number;
}

/** A place to sit, and the spot in front of it to sit down from. */
export interface Seat {
  at: Spot;
  stand: Spot;
}

/** Where an agent sits at its desk, and where it steps out to. */
export interface Home {
  seat: Spot;
  stand: Spot;
}

/** What a room offers people on a break. Rebuilt with the room. */
export interface Lounge {
  /** The room's workspace id. */
  key: string;
  cols: number;
  rows: number;
  blocked: Uint8Array;
  /** Where to stand to use the vending machine. */
  machine: Spot | null;
  seats: Seat[];
  /** Open floor to stand around on, away from desks. */
  spots: Spot[];
  /** Everyone in the room who can roam, so two don't take one seat or crowd the machine. */
  members: { roam?: Roam }[];
}

export type Goal = { kind: "desk" } | { kind: "machine" } | { kind: "seat"; seat: number } | { kind: "spot"; at: Spot };

export interface Roam {
  room: string;
  /** Feet position (room-local tiles). */
  pos: Spot;
  /** Waypoints left to walk. */
  path: Spot[];
  goal: Goal;
  walking: boolean;
  hurry: boolean;
  /** Seconds; `until` is when the current stay ends. */
  clock: number;
  until: number;
  /** Holding a drink from the machine. */
  carrying: boolean;
  /** Last direction walked (tiles), for which way the person faces. */
  heading: Spot;
  /** Whether the agent was idle last tick, to notice it becoming idle. */
  idle: boolean;
}

export type Pose = "desk" | "sit" | "stand" | "walk";

export function makeLounge(
  key: string,
  w: number,
  h: number,
  blocks: Block[],
  machine: Spot | null,
  seats: Seat[],
  avoid: Block[],
): Lounge {
  const cols = Math.ceil(w / RES),
    rows = Math.ceil(h / RES);
  const blocked = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = (i + 0.5) * RES,
        y = (j + 0.5) * RES;
      // The back and side walls are at 0; the far edges are the platform's.
      const out = x < 0.25 || y < 0.25 || x > w - 0.2 || y > h - 0.2;
      if (out || blocks.some((b) => x > b.x - RADIUS && x < b.x + b.w + RADIUS && y > b.y - RADIUS && y < b.y + b.d + RADIUS))
        blocked[j * cols + i] = 1;
    }
  }
  const l: Lounge = { key, cols, rows, blocked, machine, seats, spots: [], members: [] };
  // Not on a desk (its outline is what lights up on hover) or in front of a seat or the machine.
  const busy = [...(machine ? [machine] : []), ...seats.map((s) => s.stand)];
  for (let y = 0.75; y < h - 0.3; y += 0.5) {
    for (let x = 0.5; x < w - 0.3; x += 0.5) {
      if (!roomy(l, { x, y }, 0.3)) continue;
      if (avoid.some((b) => x > b.x && x < b.x + b.w && y > b.y && y < b.y + b.d)) continue;
      if (busy.some((b) => Math.hypot(b.x - x, b.y - y) < 0.6)) continue;
      l.spots.push({ x, y });
    }
  }
  return l;
}

export function newRoam(room: string, home: Home): Roam {
  return {
    room,
    pos: { ...home.seat },
    path: [],
    goal: { kind: "desk" },
    walking: false,
    hurry: false,
    clock: 0,
    until: 0,
    carrying: false,
    heading: { x: 1, y: 0 },
    idle: false,
  };
}

/** An agent first seen idle is already on a break somewhere, partway through it. */
export function spawnAway(r: Roam, l: Lounge, home: Home) {
  const goal = choose(r, l, false);
  place(r, l, home, goal);
  r.carrying = goal.kind !== "machine" && Math.random() < 0.8;
  r.until = r.clock + Math.random() * stay(goal);
  r.idle = true;
}

/** After the room is rebuilt: walk on toward the same goal, from where the person is. */
export function resumeRoam(r: Roam, l: Lounge, home: Home) {
  const g = r.goal;
  const valid =
    g.kind === "desk" ||
    (g.kind === "machine" && l.machine) ||
    (g.kind === "seat" && g.seat < l.seats.length) ||
    (g.kind === "spot" && free(l, g.at));
  if (!valid) {
    // Stand where they are; the next step picks something else to do.
    r.goal = { kind: "spot", at: { ...r.pos } };
    r.walking = false;
    r.path = [];
    r.until = r.clock;
  } else if (r.walking) go(r, l, home, g, r.hurry);
  else r.pos = end(g, l, home);
}

/** One frame of an agent's life away from (or on the way back to) its desk. */
export function stepRoam(r: Roam, l: Lounge, home: Home, idle: boolean, dt: number) {
  r.clock += dt;
  if (idle && !r.idle) r.until = r.clock + 0.7 + Math.random(); // a beat before getting up
  r.idle = idle;
  if (!idle && r.goal.kind !== "desk") go(r, l, home, { kind: "desk" }, true);
  else if (idle && r.walking && r.goal.kind === "desk") go(r, l, home, choose(r, l, true), false);

  if (r.walking) {
    let left = (r.hurry ? HURRY : WALK) * dt;
    while (left > 0 && r.path.length) {
      const n = r.path[0]!;
      const dx = n.x - r.pos.x,
        dy = n.y - r.pos.y,
        d = Math.hypot(dx, dy);
      if (d > 1e-4) r.heading = { x: dx / d, y: dy / d };
      if (d <= left) {
        r.pos = { ...n };
        r.path.shift();
        left -= d;
      } else {
        r.pos = { x: r.pos.x + (dx / d) * left, y: r.pos.y + (dy / d) * left };
        left = 0;
      }
    }
    if (!r.path.length) arrive(r);
    return;
  }
  if (r.goal.kind === "desk") r.pos = { ...home.seat }; // the desk may have moved
  if (r.goal.kind === "machine" && vendProgress(r) > 0.64) r.carrying = true;
  if (idle && r.clock >= r.until) go(r, l, home, choose(r, l, r.goal.kind === "desk"), false);
}

/** Reduced motion: no walking. Idle agents are simply somewhere on their break; the rest at their desks. */
export function settleRoam(r: Roam, l: Lounge, home: Home, idle: boolean) {
  if (!idle) {
    if (r.goal.kind !== "desk" || r.walking) {
      place(r, l, home, { kind: "desk" });
      r.carrying = false;
    }
  } else if (r.goal.kind === "desk" || r.walking) {
    place(r, l, home, rest(r, l));
    r.carrying = true;
  }
}

export function poseOf(r: Roam): Pose {
  if (r.walking) return "walk";
  return r.goal.kind === "desk" ? "desk" : r.goal.kind === "seat" ? "sit" : "stand";
}

/** Which way the person faces: away from the viewer (`back`), and to the left or right of the screen. */
export function facing(r: Roam): { back: boolean; left: boolean } {
  if (!r.walking) {
    if (r.goal.kind === "machine") return { back: true, left: true };
    if (r.goal.kind === "spot") return { back: false, left: Math.floor(r.clock / 2.4) % 2 === 0 }; // looking around
    return { back: false, left: false };
  }
  // The last step into a seat is backwards, still facing the room.
  if (r.path.length === 1 && r.goal.kind !== "spot" && r.goal.kind !== "machine")
    return { back: false, left: r.heading.x - r.heading.y < 0 };
  const sx = r.heading.x - r.heading.y,
    sy = r.heading.x + r.heading.y;
  return { back: sy < -0.05, left: sx < 0 };
}

/** 0 → 1 over a stay at the machine. */
export function vendProgress(r: Roam): number {
  return Math.min(1, Math.max(0, 1 - (r.until - r.clock) / VEND_S));
}

/** A few words for the tooltip, or null when at the desk. */
export function whereabouts(r: Roam | undefined): string | null {
  if (!r || r.goal.kind === "desk") return r?.walking ? "heading back to the desk" : null;
  return "on a break";
}

// ------------------------------------------------------------------ choices

function others(r: Roam, l: Lounge): Roam[] {
  return l.members.map((m) => m.roam).filter((o): o is Roam => !!o && o !== r && o.room === l.key);
}

/** What to do next. Leaving the desk, that is the vending machine whenever it is free. */
function choose(r: Roam, l: Lounge, fromDesk: boolean): Goal {
  const rest = others(r, l);
  const machineFree = !!l.machine && !rest.some((o) => o.goal.kind === "machine");
  if (fromDesk && machineFree) return { kind: "machine" };
  const options: [Goal, number][] = [];
  if (machineFree && r.goal.kind !== "machine") options.push([{ kind: "machine" }, r.carrying ? 0.6 : 4]);
  // Up from a seat means a stretch of the legs, not another seat.
  const seats = r.goal.kind === "seat" ? [] : freeSeats(r, l, rest);
  if (seats.length) options.push([{ kind: "seat", seat: seats[Math.floor(Math.random() * seats.length)]! }, r.carrying ? 3 : 1.5]);
  const spot = pickSpot(r, l, rest);
  if (spot) options.push([{ kind: "spot", at: spot }, 2]);
  let k = Math.random() * options.reduce((n, [, w]) => n + w, 0);
  for (const [goal, w] of options) if ((k -= w) <= 0) return goal;
  return { kind: "spot", at: { ...r.pos } };
}

/** Somewhere to be without walking there (reduced motion): a seat, else the machine, else a spot. */
function rest(r: Roam, l: Lounge): Goal {
  const all = others(r, l);
  const seat = freeSeats(r, l, all)[0];
  if (seat !== undefined) return { kind: "seat", seat };
  if (l.machine && !all.some((o) => o.goal.kind === "machine")) return { kind: "machine" };
  const spot = pickSpot(r, l, all);
  return spot ? { kind: "spot", at: spot } : { kind: "desk" };
}

function freeSeats(_r: Roam, l: Lounge, rest: Roam[]): number[] {
  return l.seats.map((_, i) => i).filter((i) => !rest.some((o) => o.goal.kind === "seat" && o.goal.seat === i));
}

function pickSpot(r: Roam, l: Lounge, rest: Roam[]): Spot | null {
  const far = (a: Spot, b: Spot, d: number) => Math.hypot(a.x - b.x, a.y - b.y) > d;
  const ok = l.spots.filter(
    (s) => far(s, r.pos, 1.2) && rest.every((o) => far(o.pos, s, 0.9) && (o.goal.kind !== "spot" || far(o.goal.at, s, 0.9))),
  );
  return ok.length ? ok[Math.floor(Math.random() * ok.length)]! : null;
}

function stay(goal: Goal): number {
  return goal.kind === "machine" ? VEND_S : goal.kind === "seat" ? 8 + Math.random() * 9 : goal.kind === "spot" ? 3 + Math.random() * 4 : 1;
}

// ------------------------------------------------------------------ moving

/** Where a goal's walk ends: in the seat, at the machine, on the spot. */
function end(goal: Goal, l: Lounge, home: Home): Spot {
  switch (goal.kind) {
    case "desk":
      return { ...home.seat };
    case "machine":
      return { ...l.machine! };
    case "seat":
      return { ...l.seats[goal.seat]!.at };
    case "spot":
      return { ...goal.at };
  }
}

function place(r: Roam, l: Lounge, home: Home, goal: Goal) {
  r.goal = goal;
  r.walking = false;
  r.path = [];
  r.pos = end(goal, l, home);
  r.until = r.clock;
}

function go(r: Roam, l: Lounge, home: Home, goal: Goal, hurry: boolean) {
  // Someone sitting gets up first, out of the chair or off the seat.
  const out = r.walking
    ? null
    : r.goal.kind === "desk"
      ? home.stand
      : r.goal.kind === "seat"
        ? (l.seats[r.goal.seat]?.stand ?? null)
        : null;
  const from = out ?? r.pos;
  const target = goal.kind === "desk" ? home.stand : goal.kind === "seat" ? l.seats[goal.seat]!.stand : end(goal, l, home);
  r.path = [...(out ? [out] : []), ...findPath(l, from, target)];
  if (goal.kind === "desk" || goal.kind === "seat") r.path.push(end(goal, l, home));
  r.goal = goal;
  r.walking = true;
  r.hurry = hurry;
}

function arrive(r: Roam) {
  r.walking = false;
  r.until = r.clock + stay(r.goal);
  if (r.goal.kind === "desk") r.carrying = false;
}

// ------------------------------------------------------------------ nav grid

function cellAt(l: Lounge, p: Spot): number {
  const i = Math.min(l.cols - 1, Math.max(0, Math.floor(p.x / RES)));
  const j = Math.min(l.rows - 1, Math.max(0, Math.floor(p.y / RES)));
  return j * l.cols + i;
}

function center(l: Lounge, c: number): Spot {
  return { x: ((c % l.cols) + 0.5) * RES, y: (Math.floor(c / l.cols) + 0.5) * RES };
}

function free(l: Lounge, p: Spot): boolean {
  return !l.blocked[cellAt(l, p)];
}

/** Free floor all round `p`, `r` tiles out. */
function roomy(l: Lounge, p: Spot, r: number): boolean {
  for (let y = p.y - r; y <= p.y + r + 1e-6; y += RES)
    for (let x = p.x - r; x <= p.x + r + 1e-6; x += RES) if (!free(l, { x, y })) return false;
  return true;
}

function nearestFree(l: Lounge, p: Spot): number {
  const ci = Math.floor(p.x / RES),
    cj = Math.floor(p.y / RES);
  let best = -1,
    bestD = Infinity;
  for (let ring = 0; ring <= 8 && best < 0; ring++) {
    for (let j = cj - ring; j <= cj + ring; j++) {
      for (let i = ci - ring; i <= ci + ring; i++) {
        if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== ring) continue;
        if (i < 0 || j < 0 || i >= l.cols || j >= l.rows || l.blocked[j * l.cols + i]) continue;
        const c = j * l.cols + i,
          q = center(l, c),
          d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
    }
  }
  return best;
}

/** Nothing in the way on the straight line from a to b. */
function sight(l: Lounge, a: Spot, b: Spot): boolean {
  const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (RES / 2));
  for (let k = 1; k < n; k++) if (!free(l, { x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n })) return false;
  return true;
}

/** Waypoints from `from` to `to` round the furniture (`from` itself not included). */
export function findPath(l: Lounge, from: Spot, to: Spot): Spot[] {
  const s = nearestFree(l, from),
    e = nearestFree(l, to);
  const cells = s >= 0 && e >= 0 ? astar(l, s, e) : null;
  // Walled off by furniture: walk straight there through it, since an agent with work must get back to its desk.
  if (!cells) return [to];
  const pts = [from, ...cells.map((c) => center(l, c)), to];
  const out: Spot[] = [];
  for (let i = 0; i < pts.length - 1; ) {
    let j = pts.length - 1;
    while (j > i + 1 && !sight(l, pts[i]!, pts[j]!)) j--;
    out.push(pts[j]!);
    i = j;
  }
  return out;
}

const DIRS: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

function astar(l: Lounge, s: number, e: number): number[] | null {
  const { cols, rows, blocked } = l;
  const g = new Float32Array(cols * rows).fill(Infinity);
  const from = new Int32Array(cols * rows).fill(-1);
  const done = new Uint8Array(cols * rows);
  const ex = e % cols,
    ey = Math.floor(e / cols);
  const h = (c: number) => {
    const dx = Math.abs((c % cols) - ex),
      dy = Math.abs(Math.floor(c / cols) - ey);
    return dx + dy + (Math.SQRT2 - 2) * Math.min(dx, dy);
  };
  const heap = new Heap();
  g[s] = 0;
  heap.push(h(s), s);
  while (heap.size) {
    const c = heap.pop();
    if (c === e) break;
    if (done[c]) continue;
    done[c] = 1;
    const ci = c % cols,
      cj = (c - ci) / cols;
    for (const [di, dj] of DIRS) {
      const ni = ci + di,
        nj = cj + dj;
      if (ni < 0 || nj < 0 || ni >= cols || nj >= rows || blocked[nj * cols + ni]) continue;
      if (di && dj && (blocked[cj * cols + ni] || blocked[nj * cols + ci])) continue; // no cutting corners
      const n = nj * cols + ni,
        ng = g[c]! + (di && dj ? Math.SQRT2 : 1);
      if (ng < g[n]!) {
        g[n] = ng;
        from[n] = c;
        heap.push(ng + h(n), n);
      }
    }
  }
  if (s !== e && from[e] === -1) return null;
  const cells = [e];
  for (let c = e; c !== s; c = from[c]!) cells.push(from[c]!);
  return cells.reverse();
}

/** Binary min-heap of cells by priority. */
class Heap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size() {
    return this.vals.length;
  }
  push(k: number, v: number) {
    const { keys, vals } = this;
    let i = vals.length;
    keys.push(k);
    vals.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p]! <= k) break;
      keys[i] = keys[p]!;
      vals[i] = vals[p]!;
      i = p;
    }
    keys[i] = k;
    vals[i] = v;
  }
  pop(): number {
    const { keys, vals } = this;
    const top = vals[0]!,
      k = keys.pop()!,
      v = vals.pop()!;
    if (vals.length) {
      let i = 0;
      for (;;) {
        const a = i * 2 + 1,
          b = a + 1;
        let m = i,
          mk = k;
        if (a < vals.length && keys[a]! < mk) {
          m = a;
          mk = keys[a]!;
        }
        if (b < vals.length && keys[b]! < mk) {
          m = b;
        }
        if (m === i) break;
        keys[i] = keys[m]!;
        vals[i] = vals[m]!;
        i = m;
      }
      keys[i] = k;
      vals[i] = v;
    }
    return top;
  }
}
