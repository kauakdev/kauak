import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// The page's imports leave out ".ts" (Vite resolves them); Node needs it to load the store's.
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (e) {
      if (specifier.startsWith(".")) return next(`${specifier}.ts`, context);
      throw e;
    }
  },
});

// The store saves the floor on screen; a Map stands in for the browser's localStorage.
const stored = new Map();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => stored.set(k, String(v)) },
});
const { AppState } = await import("./state.ts");

const machine = (id) => ({
  id,
  label: id,
  ssh: id === "local" ? null : id,
  state: "live",
  message: "",
  runtime: { name: "Herdr", version: null },
});
const snapshot = (...panes) => ({
  workspaces: [{ workspace_id: "w1" }],
  panes: panes.map((pane_id) => ({ pane_id, workspace_id: "w1" })),
});
function make(search = "") {
  const state = new AppState(new URLSearchParams(search));
  const changes = [];
  state.subscribe((c) => changes.push(c));
  return { state, changes };
}

test.beforeEach(() => stored.clear());

test("starts on ?floor=, else the saved floor, else this machine's; a ?pane= deep link names its own", () => {
  assert.equal(make().state.current, "local");
  stored.set("agent-office.floor", "devbox");
  assert.equal(make().state.current, "devbox");
  assert.equal(make("?floor=nas").state.current, "nas");
  assert.equal(make("?floor=nas&pane=w1:p1").state.current, "local");
  assert.equal(make("?pane=nas/w1:p1").state.current, "nas");
});

test("a floor that is gone takes its snapshot along and the page to the first floor, saved", () => {
  const { state, changes } = make("?floor=devbox");
  state.setMachines([machine("local"), machine("devbox")]);
  state.setSnapshot("devbox", snapshot("p1"));
  assert.deepEqual(changes.splice(0), [
    { type: "floors", current: true },
    { type: "floors", current: true },
  ]);
  assert.equal(state.floors()[1].snapshot.panes[0].pane_id, "devbox/p1");
  state.setMachines([machine("local")]);
  assert.deepEqual(changes, [{ type: "floor", dir: 0 }]);
  assert.equal(state.current, "local");
  assert.equal(stored.get("agent-office.floor"), "local");
  assert.equal(state.snapshot("devbox"), undefined);
});

test("going to a floor says which way the elevator went; an unknown floor changes nothing", () => {
  const { state, changes } = make();
  state.setMachines([machine("local"), machine("devbox"), machine("nas")]);
  changes.length = 0;
  state.goToFloor("nas");
  state.goToFloor("devbox");
  state.goToFloor("devbox");
  state.goToFloor("gone");
  assert.deepEqual(changes, [
    { type: "floor", dir: 1 },
    { type: "floor", dir: -1 },
    { type: "floor", dir: 0 },
  ]);
  assert.equal(stored.get("agent-office.floor"), "devbox");
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
  assert.deepEqual(changes, [{ type: "floor", dir: 1 }, { type: "selection" }, { type: "selection" }]);
  assert.equal(state.selected, "devbox/p2");
  assert.equal(state.pane("devbox/p2").pane_id, "devbox/p2");
  changes.length = 0;
  state.deselect();
  state.deselect();
  assert.deepEqual(changes, [{ type: "selection" }]);
  assert.equal(state.selected, null);
});

test("a deep link waits for its floor's first snapshot, and gives up if the pane is not in it", () => {
  const { state, changes } = make("?pane=devbox/p2");
  state.setMachines([machine("local"), machine("devbox")]);
  state.setSnapshot("local", snapshot("p1"));
  assert.equal(state.selected, null);
  state.setSnapshot("devbox", snapshot("p2"));
  assert.equal(state.selected, "devbox/p2");
  assert.deepEqual(changes.slice(-2), [{ type: "floors", current: true }, { type: "selection" }]);

  const late = make("?pane=w1:p7").state;
  late.setMachines([machine("local")]);
  late.setSnapshot("local", snapshot("p1"));
  late.setSnapshot("local", snapshot("p1", "w1:p7"));
  assert.equal(late.selected, null);
});

test("a change made by a subscriber runs before the rest of the round, and unsubscribing stops the calls", () => {
  const state = new AppState(new URLSearchParams());
  state.setMachines([machine("local")]);
  state.setSnapshot("local", snapshot("p1"));
  state.select("local/p1");
  const seen = [];
  state.subscribe((c) => {
    seen.push(`first ${c.type}`);
    if (c.type === "floors" && state.selected) state.deselect();
  });
  const stop = state.subscribe((c) => seen.push(`second ${c.type}`));
  state.setSnapshot("local", snapshot());
  assert.deepEqual(seen, ["first floors", "first selection", "second selection", "second floors"]);
  stop();
  seen.length = 0;
  state.goToFloor("local");
  assert.deepEqual(seen, ["first floor"]);
});
