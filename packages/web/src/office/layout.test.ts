import { describe, expect, test } from "vitest";
import { CELL, ROOM_GAP, WALL, WING_GAP, buildOffice, type Office, type Plot } from "./layout";
import type { PaneInfo, RepoInfo, Snapshot, WorkspaceInfo } from "@kauak/protocol";

const repo = (name: string): RepoInfo => ({
  key: `github.com/me/${name}`,
  name,
  root: `/src/${name}`,
  checkout: `/src/${name}`,
  linked: false,
});
const workspace = (workspace_id: string, number: number, over: Partial<WorkspaceInfo> = {}): WorkspaceInfo => ({
  workspace_id,
  number,
  label: workspace_id,
  focused: false,
  repo: repo("api"),
  git_root: null,
  ...over,
});
const pane = (pane_id: string, workspace_id: string, over: Partial<PaneInfo> = {}): PaneInfo => ({
  pane_id,
  workspace_id,
  focused: false,
  cwd: null,
  title: "",
  agent: null,
  agent_status: "unknown",
  screen: null,
  scrollback: false,
  context: null,
  ...over,
});
/** `n` panes in workspace `ws`. */
const panes = (ws: string, n: number) => Array.from({ length: n }, (_, i) => pane(`${ws}:p${i + 1}`, ws));

const inside = (inner: Plot, outer: Plot) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

/** Everything the layout promises about any office, whatever the snapshot. */
function expectSound(office: Office, snap: Snapshot) {
  const rooms = office.wings.flatMap((w) => w.rooms);
  // One room per workspace, and every pane of a listed workspace has one desk, in its room, in snapshot order.
  expect(rooms.map((r) => r.workspace).sort((a, b) => a.number - b.number)).toStrictEqual(
    [...snap.workspaces].sort((a, b) => a.number - b.number),
  );
  for (const room of rooms)
    expect(room.desks.map((d) => d.pane)).toStrictEqual(snap.panes.filter((p) => p.workspace_id === room.workspace.workspace_id));
  // No two desks (or a desk and a new-desk slot) on one spot.
  const spots = office.wings.flatMap((w) => w.rooms.flatMap((r) => [...r.desks, ...(r.slot ? [r.slot] : [])]));
  expect(new Set(spots.map((s) => `${s.x},${s.y}`)).size).toBe(spots.length);

  let y = 0;
  for (const wing of office.wings) {
    expect(wing.y).toBe(y);
    expect(wing.x).toBe(0);
    expect(inside(wing, { x: 0, y: 0, w: office.w, h: office.h })).toBe(true);
    let x = 0;
    const numbers = wing.rooms.map((r) => r.workspace.number);
    expect(numbers).toStrictEqual([...numbers].sort((a, b) => a - b));
    for (const room of wing.rooms) {
      // Rooms stand in a row, ROOM_GAP apart, inside their wing.
      expect(room.x).toBe(x);
      expect(room.y).toBe(wing.y);
      expect(inside(room, wing)).toBe(true);
      // A desk's cell sits within the room's walls.
      for (const s of [...room.desks, ...(room.slot ? [room.slot] : [])])
        expect(
          inside(
            { x: s.x - 1, y: s.y - 1, w: CELL, h: CELL },
            { x: room.x + WALL, y: room.y + WALL, w: room.w - 2 * WALL, h: room.h - 2 * WALL },
          ),
        ).toBe(true);
      x += room.w + ROOM_GAP;
    }
    if (wing.slot) {
      expect(wing.slot.x).toBe(x);
      expect(inside(wing.slot, wing)).toBe(true);
    }
    expect(wing.h).toBe(Math.max(...wing.rooms.map((r) => r.h)));
    y += wing.h + WING_GAP;
  }
  if (office.slot) expect(office.slot).toStrictEqual({ x: 0, y, w: CELL + 2 * WALL, h: CELL + 2 * WALL });
}

test("the grid: a desk cell is 3 tiles, a room's wall 1, and rooms and wings 2 and 3 tiles apart", () => {
  expect([CELL, WALL, ROOM_GAP, WING_GAP]).toStrictEqual([3, 1, 2, 3]);
});

describe("buildOffice", () => {
  test("an empty floor is an empty office, or just the new-room slot in build mode", () => {
    const empty: Snapshot = { workspaces: [], panes: [] };
    expect(buildOffice(empty)).toStrictEqual({ wings: [], w: 0, h: 0, slot: null });
    expect(buildOffice(empty, true)).toStrictEqual({ wings: [], w: 5, h: 5, slot: { x: 0, y: 0, w: 5, h: 5 } });
  });

  test("one workspace with one pane is one wing with one room and one desk", () => {
    const ws = workspace("w1", 1);
    const p = pane("w1:p1", "w1");
    expect(buildOffice({ workspaces: [ws], panes: [p] })).toStrictEqual({
      wings: [
        {
          key: "github.com/me/api",
          name: "api",
          x: 0,
          y: 0,
          w: 5,
          h: 5,
          rooms: [{ workspace: ws, x: 0, y: 0, w: 5, h: 5, desks: [{ pane: p, x: 2, y: 2 }], focused: false, slot: null }],
          slot: null,
        },
      ],
      w: 5,
      h: 5,
      slot: null,
    });
  });

  test("a repository's workspaces are rooms in a row, by workspace number; a room grows into a square of desks", () => {
    const snap: Snapshot = {
      workspaces: [workspace("w3", 3), workspace("w1", 1), workspace("w2", 2)],
      panes: [...panes("w2", 4), ...panes("w1", 1)],
    };
    const office = buildOffice(snap);
    expect(office.wings).toHaveLength(1);
    const rooms = office.wings[0]!.rooms;
    expect(rooms.map((r) => r.workspace.workspace_id)).toStrictEqual(["w1", "w2", "w3"]);
    expect(rooms.map(({ x, y, w, h }) => ({ x, y, w, h }))).toStrictEqual([
      { x: 0, y: 0, w: 5, h: 5 },
      { x: 7, y: 0, w: 8, h: 8 },
      // No panes: still a room, one desk cell big.
      { x: 17, y: 0, w: 5, h: 5 },
    ]);
    expect(rooms[1]!.desks.map(({ pane, x, y }) => [pane.pane_id, x, y])).toStrictEqual([
      ["w2:p1", 9, 2],
      ["w2:p2", 12, 2],
      ["w2:p3", 9, 5],
      ["w2:p4", 12, 5],
    ]);
    expect(office.wings[0]).toMatchObject({ x: 0, y: 0, w: 22, h: 8 });
    expect([office.w, office.h]).toStrictEqual([22, 8]);
    expectSound(office, snap);
  });

  test("repositories are wings, one under the other; a workspace with no repository goes by its first pane's folder, else its label", () => {
    const snap: Snapshot = {
      workspaces: [
        workspace("w1", 1),
        workspace("w2", 2, { repo: null }),
        workspace("w3", 3, { repo: null, label: "scratch" }),
        workspace("w4", 4),
        workspace("w5", 5, { repo: repo("web") }),
        workspace("w6", 6, { repo: null }),
      ],
      panes: [
        pane("w2:p1", "w2", { cwd: "/home/me/notes" }),
        pane("w2:p2", "w2", { cwd: "/tmp" }),
        pane("w6:p1", "w6", { cwd: "/home/me/notes" }),
      ],
    };
    const office = buildOffice(snap);
    expect(office.wings.map((w) => [w.key, w.name, w.rooms.map((r) => r.workspace.workspace_id)])).toStrictEqual([
      ["github.com/me/api", "api", ["w1", "w4"]],
      ["dir:/home/me/notes", "notes", ["w2", "w6"]],
      ["dir:scratch", "scratch", ["w3"]],
      ["github.com/me/web", "web", ["w5"]],
    ]);
    expect(office.wings.map((w) => [w.y, w.w, w.h])).toStrictEqual([
      [0, 12, 5],
      [8, 15, 5],
      [16, 5, 5],
      [24, 5, 5],
    ]);
    expect([office.w, office.h]).toStrictEqual([15, 29]);
    expectSound(office, snap);
  });

  test("a workspace with no folder or label and one in / get two wings, both called loose, as their folders differ", () => {
    const snap: Snapshot = {
      workspaces: [workspace("w1", 1, { repo: null, label: "" }), workspace("w2", 2, { repo: null })],
      panes: [pane("w2:p1", "w2", { cwd: "/" })],
    };
    expect(buildOffice(snap).wings.map((w) => [w.key, w.name])).toStrictEqual([
      ["dir:", "loose"],
      ["dir:/", "loose"],
    ]);
  });

  test("a pane whose workspace is not in the snapshot gets no desk", () => {
    const snap: Snapshot = { workspaces: [workspace("w1", 1)], panes: [pane("w1:p1", "w1"), pane("w9:p1", "w9")] };
    const desks = buildOffice(snap).wings.flatMap((w) => w.rooms.flatMap((r) => r.desks));
    expect(desks.map((d) => d.pane.pane_id)).toStrictEqual(["w1:p1"]);
  });

  test("a room is focused when its workspace or one of its panes is", () => {
    const snap: Snapshot = {
      workspaces: [workspace("w1", 1, { focused: true }), workspace("w2", 2), workspace("w3", 3)],
      panes: [pane("w2:p1", "w2"), pane("w2:p2", "w2", { focused: true }), pane("w3:p1", "w3")],
    };
    expect(buildOffice(snap).wings[0]!.rooms.map((r) => r.focused)).toStrictEqual([true, true, false]);
  });

  test("build mode adds a desk slot to every room, a room slot to every wing and one below them all", () => {
    const snap: Snapshot = {
      workspaces: [workspace("w1", 1), workspace("w2", 2), workspace("w3", 3, { repo: repo("web") })],
      panes: [...panes("w1", 1), ...panes("w3", 4)],
    };
    const office = buildOffice(snap, true);
    const [api, web] = office.wings;
    expect(api!.rooms.map((r) => [r.x, r.w, r.h, r.slot])).toStrictEqual([
      [0, 8, 5, { x: 5, y: 2 }],
      [10, 5, 5, { x: 12, y: 2 }],
    ]);
    expect(api!.slot).toStrictEqual({ x: 17, y: 0, w: 5, h: 5 });
    expect(api!.w).toBe(22);
    expect(web!.rooms[0]).toMatchObject({ x: 0, y: 8, w: 11, h: 8, slot: { x: 5, y: 13 } });
    expect(web!.slot).toStrictEqual({ x: 13, y: 8, w: 5, h: 5 });
    expect(office.slot).toStrictEqual({ x: 0, y: 19, w: 5, h: 5 });
    expect([office.w, office.h]).toStrictEqual([22, 24]);
    expectSound(office, snap);
  });

  test("many rooms and desks keep every promise, in and out of build mode", () => {
    const counts = [0, 1, 2, 3, 5, 9, 10, 16, 17, 30];
    const workspaces = counts.map((_, i) =>
      workspace(`w${i}`, counts.length - i, { repo: i % 3 === 0 ? null : repo(i % 2 ? "api" : "web"), label: `ws ${i % 2}` }),
    );
    const snap: Snapshot = { workspaces, panes: counts.flatMap((n, i) => panes(`w${i}`, n)) };
    for (const build of [false, true]) {
      const office = buildOffice(snap, build);
      expectSound(office, snap);
      for (const room of office.wings.flatMap((w) => w.rooms)) {
        const n = Math.max(1, room.desks.length + (build ? 1 : 0));
        const cols = Math.ceil(Math.sqrt(n));
        expect([room.w, room.h]).toStrictEqual([cols * CELL + 2 * WALL, Math.ceil(n / cols) * CELL + 2 * WALL]);
      }
    }
    const thirty = buildOffice(snap)
      .wings.flatMap((w) => w.rooms)
      .find((r) => r.workspace.workspace_id === "w9")!;
    expect([thirty.w, thirty.h]).toStrictEqual([20, 17]);
  });

  test("the same snapshot always gives the same office, and is left as it was", () => {
    const snap: Snapshot = {
      workspaces: [workspace("w2", 2, { repo: null }), workspace("w1", 1)],
      panes: [...panes("w1", 3), pane("w2:p1", "w2", { cwd: "/home/me/notes" })],
    };
    const copy = structuredClone(snap);
    expect(buildOffice(snap, true)).toStrictEqual(buildOffice(snap, true));
    expect(buildOffice(snap)).toStrictEqual(buildOffice(copy));
    expect(snap).toStrictEqual(copy);
  });
});
