import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { rng } from "./iso";
import type { Spot } from "./layout";
import {
  VEND_S,
  facing,
  findPath,
  makeLounge,
  newRoam,
  poseOf,
  resumeRoam,
  settleRoam,
  stepRoam,
  vendProgress,
  whereabouts,
  type Block,
  type Home,
  type Lounge,
  type Roam,
  type Seat,
} from "./roam";

// The nav grid is a quarter of a tile.
const blockedAt = (l: Lounge, x: number, y: number) => l.blocked[Math.floor(y / 0.25) * l.cols + Math.floor(x / 0.25)] === 1;
const inBlock = (p: Spot, b: Block) => p.x > b.x && p.x < b.x + b.w && p.y > b.y && p.y < b.y + b.d;
/** Tiles left to walk from `from` along `path`. */
const length = (from: Spot, path: Spot[]) =>
  path.reduce((n, p, i) => {
    const q = i ? path[i - 1]! : from;
    return n + Math.hypot(p.x - q.x, p.y - q.y);
  }, 0);
/** Points every few hundredths of a tile along the walk. */
function along(from: Spot, path: Spot[]): Spot[] {
  const out: Spot[] = [];
  let a = from;
  for (const b of path) {
    const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.02);
    for (let k = 0; k <= n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
    a = b;
  }
  return out;
}

// A 6 × 5 room: a desk at the back with its chair, a vending machine and a two-seat sofa.
const DESK: Block = { x: 1, y: 0.5, w: 1.5, d: 0.8 };
const MACHINE: Block = { x: 5, y: 0.5, w: 0.6, d: 0.6 };
const SOFA: Block = { x: 4.5, y: 3.8, w: 1.2, d: 0.6 };
const SEATS: Seat[] = [
  { at: { x: 4.8, y: 4.1 }, stand: { x: 4.8, y: 3.2 } },
  { at: { x: 5.4, y: 4.1 }, stand: { x: 5.4, y: 3.2 } },
];
const HOME: Home = { seat: { x: 1.75, y: 1.6 }, stand: { x: 1.75, y: 2.2 } };
const room = (members: Roam[] = []) => {
  const l = makeLounge("w1", 6, 5, [DESK, MACHINE, SOFA], { x: 5.3, y: 1.5 }, SEATS, [DESK]);
  l.members = members.map((roam) => ({ roam }));
  return l;
};

/** Steps until the walk is over, or fails after a minute of walking. */
function walk(r: Roam, l: Lounge, idle: boolean, dt = 0.1) {
  for (let t = 0; r.walking; t += dt) {
    if (t > 60) throw new Error("still walking after a minute");
    stepRoam(r, l, HOME, idle, dt);
  }
}

beforeEach(() => {
  vi.spyOn(Math, "random").mockImplementation(rng(7));
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("makeLounge", () => {
  test("the walls are blocked all round and the floor between them is open", () => {
    const l = makeLounge("w1", 4, 4, [], null, [], []);
    expect([l.cols, l.rows]).toStrictEqual([16, 16]);
    expect(l.blocked.reduce((n, b) => n + b, 0)).toBe(16 * 16 - 14 * 14);
    for (const [x, y] of [
      [0.1, 2],
      [2, 0.1],
      [3.9, 2],
      [2, 3.9],
    ])
      expect(blockedAt(l, x!, y!)).toBe(true);
    expect(blockedAt(l, 0.3, 0.3)).toBe(false);
    expect(blockedAt(l, 3.7, 3.7)).toBe(false);
    expect(makeLounge("w1", 4.1, 3.3, [], null, [], [])).toMatchObject({ cols: 17, rows: 14 });
    expect(l).toMatchObject({ key: "w1", machine: null, seats: [], members: [] });
  });

  test("furniture blocks its floor and a margin round it, so people walk past, not through", () => {
    const l = makeLounge("w1", 4, 4, [{ x: 1, y: 1, w: 1, d: 1 }], null, [], []);
    expect(blockedAt(l, 1.5, 1.5)).toBe(true);
    expect(blockedAt(l, 0.9, 1.5)).toBe(true);
    expect(blockedAt(l, 2.1, 2.1)).toBe(true);
    expect(blockedAt(l, 0.7, 1.5)).toBe(false);
    expect(blockedAt(l, 2.3, 1.5)).toBe(false);
    expect(l.blocked.reduce((n, b) => n + b, 0)).toBe(16 * 16 - 14 * 14 + 6 * 6);
  });

  test("spots to stand on are on a half-tile grid, in the open, off the desks and clear of the machine and the seats", () => {
    const l = room();
    expect(l.spots.length).toBeGreaterThan(10);
    for (const s of l.spots) {
      expect((s.x * 2) % 1).toBe(0);
      expect(((s.y - 0.25) * 2) % 1).toBe(0);
      for (const [dx, dy] of [
        [-0.3, -0.3],
        [0.3, 0.3],
        [-0.3, 0.3],
        [0.3, -0.3],
      ])
        expect(blockedAt(l, s.x + dx!, s.y + dy!)).toBe(false);
      expect(inBlock(s, DESK)).toBe(false);
      for (const busy of [l.machine!, ...SEATS.map((seat) => seat.stand)])
        expect(Math.hypot(busy.x - s.x, busy.y - s.y)).toBeGreaterThanOrEqual(0.6);
    }
    // x from 1 to 3 and y from 0.75 to 3.25: at x 0.5 and 3.5 the walls' margins are under 0.3 tiles away.
    expect(makeLounge("w1", 4, 4, [], null, [], []).spots).toHaveLength(30);
    expect(makeLounge("w1", 4, 4, [], null, [], []).spots[0]).toStrictEqual({ x: 1, y: 0.75 });
  });

  test("a spot keeps the same floor clear on every side: furniture under 0.3 tiles away in front or to the right rules it out, as behind or to the left", () => {
    const at: Spot = { x: 2, y: 1.75 };
    const has = (l: Lounge) => l.spots.some((s) => s.x === at.x && s.y === at.y);
    expect(has(makeLounge("w1", 4, 4, [], null, [], []))).toBe(true);
    // Each bar's margin stops 0.3 tiles from the spot, on one side: the floor 0.25 to 0.5 tiles out is blocked, the floor nearer is open.
    const bars: { bar: Block; dx: number; dy: number }[] = [
      { bar: { x: 2.45, y: 0, w: 0.5, d: 4 }, dx: 1, dy: 0 }, // to the right
      { bar: { x: 0, y: 2.2, w: 4, d: 0.5 }, dx: 0, dy: 1 }, // in front
      { bar: { x: 1.05, y: 0, w: 0.5, d: 4 }, dx: -1, dy: 0 }, // to the left
      { bar: { x: 0, y: 0.8, w: 4, d: 0.5 }, dx: 0, dy: -1 }, // behind
    ];
    for (const { bar, dx, dy } of bars) {
      const l = makeLounge("w1", 4, 4, [bar], null, [], []);
      expect(blockedAt(l, at.x + dx * 0.2, at.y + dy * 0.2)).toBe(false);
      expect(blockedAt(l, at.x + dx * 0.3, at.y + dy * 0.3)).toBe(true);
      expect(has(l)).toBe(false);
    }
  });
});

describe("findPath", () => {
  const open = () => makeLounge("w1", 6, 4, [], null, [], []);

  test("in the open, the path is one straight step to the goal", () => {
    expect(findPath(open(), { x: 1, y: 2 }, { x: 5, y: 2 })).toStrictEqual([{ x: 5, y: 2 }]);
    expect(findPath(open(), { x: 1, y: 1 }, { x: 4.6, y: 3.3 })).toStrictEqual([{ x: 4.6, y: 3.3 }]);
  });

  test("a start that is the goal is a path of the goal alone", () => {
    expect(findPath(open(), { x: 2, y: 2 }, { x: 2, y: 2 })).toStrictEqual([{ x: 2, y: 2 }]);
  });

  test("goes round furniture in the way, through the gap, with corners pulled straight", () => {
    const wall: Block = { x: 2.5, y: 0, w: 1, d: 3 };
    const l = makeLounge("w1", 6, 4, [wall], null, [], []);
    const from = { x: 1, y: 1 },
      to = { x: 5, y: 1 };
    const path = findPath(l, from, to);
    expect(path).toStrictEqual([
      { x: 2.125, y: 3.375 },
      { x: 3.875, y: 3.375 },
      { x: 5, y: 1 },
    ]);
    for (const p of along(from, path)) expect(inBlock(p, wall)).toBe(false);
    expect(length(from, path)).toBeLessThan(8);
  });

  test("takes the shortest way round: the nearer of two gaps, between staggered walls, out of a U", () => {
    const wallWithGaps = makeLounge(
      "w1",
      8,
      6,
      [
        { x: 3.5, y: 0, w: 1, d: 1.2 },
        { x: 3.5, y: 2, w: 1, d: 2.6 },
      ],
      null,
      [],
      [],
    );
    expect(findPath(wallWithGaps, { x: 1, y: 3 }, { x: 7, y: 3 })).toStrictEqual([
      { x: 3.375, y: 1.625 },
      { x: 4.875, y: 1.625 },
      { x: 7, y: 3 },
    ]);
    const staggered = makeLounge(
      "w1",
      8,
      6,
      [
        { x: 2, y: 1, w: 1, d: 4 },
        { x: 5, y: 0, w: 1, d: 4 },
      ],
      null,
      [],
      [],
    );
    expect(findPath(staggered, { x: 1, y: 1 }, { x: 7, y: 5 })).toStrictEqual([
      { x: 2.125, y: 0.625 },
      { x: 3.375, y: 0.625 },
      { x: 4.875, y: 4.625 },
      { x: 7, y: 5 },
    ]);
    const u = makeLounge(
      "w1",
      8,
      8,
      [
        { x: 1, y: 2, w: 6, d: 0.6 },
        { x: 1, y: 2, w: 0.6, d: 4 },
        { x: 1, y: 5.4, w: 6, d: 0.6 },
      ],
      null,
      [],
      [],
    );
    expect(findPath(u, { x: 3, y: 4 }, { x: 7.5, y: 1 })).toStrictEqual([
      { x: 7.375, y: 2.875 },
      { x: 7.5, y: 1 },
    ]);
  });

  test("an unreachable goal gets a straight line to it, so an agent with work still gets back to its desk", () => {
    const l = makeLounge("w1", 6, 4, [{ x: 2.5, y: 0, w: 1, d: 4 }], null, [], []);
    expect(findPath(l, { x: 1, y: 1 }, { x: 5, y: 1 })).toStrictEqual([{ x: 5, y: 1 }]);
  });

  test("a start or goal in the furniture, a seat say, sets off from the nearest open floor", () => {
    const l = room();
    const path = findPath(l, SEATS[0]!.at, HOME.stand);
    expect(path.at(-1)).toStrictEqual(HOME.stand);
    for (const p of along(path[0]!, path.slice(1))) expect(blockedAt(l, p.x, p.y)).toBe(false);
  });
});

describe("stepRoam", () => {
  test("a working agent stays in its chair, and follows its desk when the room moves it", () => {
    const r = newRoam("w1", HOME);
    const l = room([r]);
    for (let i = 0; i < 50; i++) stepRoam(r, l, HOME, false, 0.1);
    expect(r.pos).toStrictEqual(HOME.seat);
    expect([poseOf(r), whereabouts(r), r.walking]).toStrictEqual(["desk", null, false]);
    const moved: Home = { seat: { x: 2.25, y: 1.6 }, stand: { x: 2.25, y: 2.2 } };
    stepRoam(r, l, moved, false, 0.1);
    expect(r.pos).toStrictEqual(moved.seat);
  });

  test("an agent that goes idle waits a beat, gets up and walks to the vending machine for a drink", () => {
    const r = newRoam("w1", HOME);
    const l = room([r]);
    stepRoam(r, l, HOME, true, 0.1);
    expect(r.until).toBeGreaterThanOrEqual(0.1 + 0.7);
    expect(r.until).toBeLessThan(0.1 + 1.7);
    while (r.clock + 0.1 < r.until) stepRoam(r, l, HOME, true, 0.1);
    expect(r.walking).toBe(false);
    stepRoam(r, l, HOME, true, 0.1);
    expect(r.walking).toBe(true);
    expect(r.goal).toStrictEqual({ kind: "machine" });
    // Out of the chair first, then round the desk.
    expect(r.path[0]).toStrictEqual(HOME.stand);
    expect(r.path.at(-1)).toStrictEqual(l.machine);
    expect([poseOf(r), whereabouts(r), r.hurry]).toStrictEqual(["walk", "on a break", false]);

    // At 1.15 tiles a second.
    const before = length(r.pos, r.path);
    stepRoam(r, l, HOME, true, 0.2);
    expect(before - length(r.pos, r.path)).toBeCloseTo(0.23, 6);

    walk(r, l, true);
    expect(r.pos).toStrictEqual(l.machine);
    expect(r.until).toBeCloseTo(r.clock + VEND_S, 6);
    expect([poseOf(r), facing(r)]).toStrictEqual(["stand", { back: true, left: true }]);
    expect(r.carrying).toBe(false);
    while (vendProgress(r) <= 0.64) stepRoam(r, l, HOME, true, 0.1);
    stepRoam(r, l, HOME, true, 0.1);
    expect(r.carrying).toBe(true);
  });

  test("work for the agent sends it hurrying back to its chair, where it puts the drink away", () => {
    const r = newRoam("w1", HOME);
    const l = room([r]);
    Object.assign(r, { goal: { kind: "spot", at: { x: 3.5, y: 3 } }, pos: { x: 3.5, y: 3 }, carrying: true, idle: true });
    const route = [...findPath(l, r.pos, HOME.stand), HOME.seat];
    stepRoam(r, l, HOME, false, 0.2);
    expect([r.goal, r.walking, r.hurry]).toStrictEqual([{ kind: "desk" }, true, true]);
    expect(whereabouts(r)).toBe("heading back to the desk");
    // At 2.6 tiles a second.
    expect(length({ x: 3.5, y: 3 }, route) - length(r.pos, r.path)).toBeCloseTo(0.52, 6);
    expect(r.path.at(-1)).toStrictEqual(HOME.seat);
    walk(r, l, false);
    expect(r.pos).toStrictEqual(HOME.seat);
    expect([poseOf(r), r.carrying, whereabouts(r)]).toStrictEqual(["desk", false, null]);
  });

  test("two agents never take one seat, nor queue at the machine together", () => {
    for (let seed = 1; seed <= 40; seed++) {
      vi.spyOn(Math, "random").mockImplementation(rng(seed));
      const sitting = newRoam("w1", HOME);
      Object.assign(sitting, { goal: { kind: "seat", seat: 0 }, pos: { ...SEATS[0]!.at } });
      const vending = newRoam("w1", HOME);
      Object.assign(vending, { goal: { kind: "machine" }, pos: { x: 5.3, y: 1.5 } });
      const r = newRoam("w1", HOME);
      const l = room([sitting, vending, r]);
      stepRoam(r, l, HOME, true, 0.1);
      stepRoam(r, l, HOME, true, 2);
      expect(r.walking).toBe(true);
      expect(r.goal).not.toStrictEqual({ kind: "machine" });
      expect(r.goal).not.toStrictEqual({ kind: "seat", seat: 0 });
    }
  });

  test("an agent on a break in another room's lounge does not count as company", () => {
    const elsewhere = newRoam("w2", HOME);
    Object.assign(elsewhere, { goal: { kind: "machine" } });
    const r = newRoam("w1", HOME);
    const l = room([elsewhere, r]);
    stepRoam(r, l, HOME, true, 0.1);
    stepRoam(r, l, HOME, true, 2);
    expect(r.goal).toStrictEqual({ kind: "machine" });
  });
});

describe("with reduced motion, and when the room is rebuilt", () => {
  test("settleRoam puts an idle agent straight into a free seat with a drink, and a working one back at the desk", () => {
    const r = newRoam("w1", HOME);
    const l = room([r]);
    settleRoam(r, l, HOME, true);
    expect([r.goal, r.pos, r.walking, r.carrying]).toStrictEqual([{ kind: "seat", seat: 0 }, SEATS[0]!.at, false, true]);
    settleRoam(r, l, HOME, false);
    expect([r.goal, r.pos, r.walking, r.carrying]).toStrictEqual([{ kind: "desk" }, HOME.seat, false, false]);
  });

  test("resumeRoam keeps a walk's goal, and leaves someone whose seat is gone standing where they are", () => {
    const r = newRoam("w1", HOME);
    settleRoam(r, room([r]), HOME, true);
    const l = makeLounge("w1", 6, 5, [DESK, MACHINE], { x: 5.3, y: 1.5 }, [], [DESK]);
    l.members = [{ roam: r }];
    resumeRoam(r, l, HOME);
    expect([r.goal, r.pos, r.walking, r.path]).toStrictEqual([{ kind: "spot", at: SEATS[0]!.at }, SEATS[0]!.at, false, []]);

    const walker = newRoam("w1", HOME);
    const full = room([walker]);
    stepRoam(walker, full, HOME, true, 0.1);
    stepRoam(walker, full, HOME, true, 2);
    expect(walker.goal).toStrictEqual({ kind: "machine" });
    resumeRoam(walker, full, HOME);
    expect([walker.goal, walker.walking, walker.path.at(-1)]).toStrictEqual([{ kind: "machine" }, true, full.machine]);
  });
});
