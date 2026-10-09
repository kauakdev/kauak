import { beforeEach, expect, test, vi } from "vitest";
import { AppState, type Change } from "./state";
import type { MachineInfo, Snapshot } from "@kauak/protocol";

// The store saves the floor on screen; a Map stands in for the browser's localStorage.
const stored = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => stored.get(k) ?? null,
  setItem: (k: string, v: string) => stored.set(k, String(v)),
});

const machine = (id: string): MachineInfo => ({
  id,
  label: id,
  ssh: id === "local" ? null : id,
  state: "live",
  message: "",
  runtime: { name: "Herdr", version: null },
});
// Only the ids: the store reads nothing else of a snapshot.
const snapshot = (...panes: string[]) =>
  ({
    workspaces: [{ workspace_id: "w1" }],
    panes: panes.map((pane_id) => ({ pane_id, workspace_id: "w1" })),
  }) as Snapshot;
function make(search = "") {
  const state = new AppState(new URLSearchParams(search));
  const changes: Change[] = [];
  state.subscribe((c) => changes.push(c));
  return { state, changes };
}

beforeEach(() => stored.clear());

test("starts on ?floor=, else the saved floor, else this machine's; a ?pane= deep link names its own", () => {
  expect(make().state.current).toBe("local");
  stored.set("agent-office.floor", "devbox");
  expect(make().state.current).toBe("devbox");
  expect(make("?floor=nas").state.current).toBe("nas");
  expect(make("?floor=nas&pane=w1:p1").state.current).toBe("local");
  expect(make("?pane=nas/w1:p1").state.current).toBe("nas");
});

test("a floor that is gone takes its snapshot along and the page to the first floor, saved", () => {
  const { state, changes } = make("?floor=devbox");
  state.setMachines([machine("local"), machine("devbox")]);
  state.setSnapshot("devbox", snapshot("p1"));
  expect(changes.splice(0)).toStrictEqual([
    { type: "floors", current: true },
    { type: "floors", current: true },
  ]);
  expect(state.floors()[1]?.snapshot?.panes[0]?.pane_id).toBe("devbox/p1");
  state.setMachines([machine("local")]);
  expect(changes).toStrictEqual([{ type: "floor", dir: 0 }]);
  expect(state.current).toBe("local");
  expect(stored.get("agent-office.floor")).toBe("local");
  expect(state.snapshot("devbox")).toBe(undefined);
});

test("going to a floor says which way the elevator went; an unknown floor changes nothing", () => {
  const { state, changes } = make();
  state.setMachines([machine("local"), machine("devbox"), machine("nas")]);
  changes.length = 0;
  state.goToFloor("nas");
  state.goToFloor("devbox");
  state.goToFloor("devbox");
  state.goToFloor("gone");
  expect(changes).toStrictEqual([
    { type: "floor", dir: 1 },
    { type: "floor", dir: -1 },
    { type: "floor", dir: 0 },
  ]);
  expect(stored.get("agent-office.floor")).toBe("devbox");
});

test("selecting a pane on another floor goes there first; selecting again tells again; a missing pane is ignored", () => {
  const { state, changes } = make();
  state.setMachines([machine("local"), machine("devbox")]);
  state.setSnapshot("local", snapshot("p1"));
  state.setSnapshot("devbox", snapshot("p2"));
  changes.length = 0;
  state.select("devbox/p2");
  state.select("devbox/p2");
  state.select("devbox/p9");
  expect(changes).toStrictEqual([{ type: "floor", dir: 1 }, { type: "selection" }, { type: "selection" }]);
  expect(state.selected).toBe("devbox/p2");
  expect(state.pane("devbox/p2")?.pane_id).toBe("devbox/p2");
  changes.length = 0;
  state.deselect();
  state.deselect();
  expect(changes).toStrictEqual([{ type: "selection" }]);
  expect(state.selected).toBe(null);
});

test("a deep link waits for its floor's first snapshot, and gives up if the pane is not in it", () => {
  const { state, changes } = make("?pane=devbox/p2");
  state.setMachines([machine("local"), machine("devbox")]);
  state.setSnapshot("local", snapshot("p1"));
  expect(state.selected).toBe(null);
  state.setSnapshot("devbox", snapshot("p2"));
  expect(state.selected).toBe("devbox/p2");
  expect(changes.slice(-2)).toStrictEqual([{ type: "floors", current: true }, { type: "selection" }]);

  const late = make("?pane=w1:p7").state;
  late.setMachines([machine("local")]);
  late.setSnapshot("local", snapshot("p1"));
  late.setSnapshot("local", snapshot("p1", "w1:p7"));
  expect(late.selected).toBe(null);
});

test("a change made by a subscriber runs before the rest of the round, and unsubscribing stops the calls", () => {
  const state = new AppState(new URLSearchParams());
  state.setMachines([machine("local")]);
  state.setSnapshot("local", snapshot("p1"));
  state.select("local/p1");
  const seen: string[] = [];
  state.subscribe((c) => {
    seen.push(`first ${c.type}`);
    if (c.type === "floors" && state.selected) state.deselect();
  });
  const stop = state.subscribe((c) => seen.push(`second ${c.type}`));
  state.setSnapshot("local", snapshot());
  expect(seen).toStrictEqual(["first floors", "first selection", "second selection", "second floors"]);
  stop();
  seen.length = 0;
  state.goToFloor("local");
  expect(seen).toStrictEqual(["first floor"]);
});
