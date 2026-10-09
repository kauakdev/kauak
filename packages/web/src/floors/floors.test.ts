import { describe, expect, test } from "vitest";
import { EMPTY_SNAPSHOT, floorOf, floorProblem, keyOf, mergeSnapshots, namespaceSnapshot, runtimeOf, splitKey, type Floor } from "./floors";
import type { MachineInfo, PaneInfo, Snapshot, WorkspaceInfo } from "@kauak/protocol";

const machine = (over: Partial<MachineInfo> = {}): MachineInfo => ({
  id: "devbox",
  label: "devbox",
  ssh: "devbox",
  state: "down",
  message: "",
  runtime: { name: "Herdr", version: null },
  ...over,
});
const workspace = (workspace_id: string): WorkspaceInfo => ({
  workspace_id,
  number: 1,
  label: "api",
  focused: false,
  repo: null,
  git_root: "/src/api",
});
const pane = (pane_id: string, workspace_id: string): PaneInfo => ({
  pane_id,
  workspace_id,
  focused: false,
  cwd: "/src/api",
  title: "claude",
  agent: "claude",
  agent_status: "idle",
  screen: null,
  scrollback: false,
  context: null,
});
const floor = (id: string, number: number, snapshot: Snapshot | null): Floor => ({ info: machine({ id }), number, snapshot });

describe("keys", () => {
  test("a key is the machine, a slash, then the id, and splits back at the first slash", () => {
    expect(keyOf("devbox", "w1:p1")).toBe("devbox/w1:p1");
    expect(splitKey("devbox/w1:p1")).toStrictEqual({ machine: "devbox", id: "w1:p1" });
    expect(floorOf("devbox/w1:p1")).toBe("devbox");
  });

  test("ids with slashes in them round-trip, as machine ids never have one", () => {
    for (const id of ["w1/p1", "/home/me/api", "a/b/c:d", ""]) {
      const key = keyOf("nas", id);
      expect(splitKey(key)).toStrictEqual({ machine: "nas", id });
      expect(floorOf(key)).toBe("nas");
    }
  });

  test("a key without a slash, which keyOf never makes, loses its last character as the machine", () => {
    expect(splitKey("local")).toStrictEqual({ machine: "loca", id: "local" });
  });
});

describe("namespaceSnapshot", () => {
  test("prefixes every pane and workspace id with the machine and keeps the rest", () => {
    const snap: Snapshot = { workspaces: [workspace("w1"), workspace("w/2")], panes: [pane("w1:p1", "w1"), pane("w/2:p1", "w/2")] };
    const out = namespaceSnapshot("devbox", snap);
    expect(out.workspaces.map((w) => w.workspace_id)).toStrictEqual(["devbox/w1", "devbox/w/2"]);
    expect(out.panes.map((p) => [p.pane_id, p.workspace_id])).toStrictEqual([
      ["devbox/w1:p1", "devbox/w1"],
      ["devbox/w/2:p1", "devbox/w/2"],
    ]);
    expect(out.workspaces[0]).toStrictEqual({ ...workspace("w1"), workspace_id: "devbox/w1" });
    expect(out.panes[1]).toStrictEqual({ ...pane("w/2:p1", "w/2"), pane_id: "devbox/w/2:p1", workspace_id: "devbox/w/2" });
  });

  test("leaves the bridge's snapshot as it was", () => {
    const snap: Snapshot = { workspaces: [workspace("w1")], panes: [pane("w1:p1", "w1")] };
    const copy = structuredClone(snap);
    namespaceSnapshot("devbox", snap);
    expect(snap).toStrictEqual(copy);
    expect(namespaceSnapshot("devbox", EMPTY_SNAPSHOT)).toStrictEqual({ workspaces: [], panes: [] });
  });
});

test("mergeSnapshots puts every floor's rooms and desks in one snapshot, in floor order, skipping floors with none yet", () => {
  const one = namespaceSnapshot("local", { workspaces: [workspace("w1")], panes: [pane("w1:p1", "w1"), pane("w1:p2", "w1")] });
  const two = namespaceSnapshot("nas", { workspaces: [workspace("w1"), workspace("w2")], panes: [pane("w2:p1", "w2")] });
  const merged = mergeSnapshots([floor("local", 1, one), floor("devbox", 2, null), floor("nas", 3, two)]);
  expect(merged.workspaces.map((w) => w.workspace_id)).toStrictEqual(["local/w1", "nas/w1", "nas/w2"]);
  expect(merged.panes.map((p) => p.pane_id)).toStrictEqual(["local/w1:p1", "local/w1:p2", "nas/w2:p1"]);
  expect(mergeSnapshots([])).toStrictEqual({ workspaces: [], panes: [] });
  expect(mergeSnapshots([floor("devbox", 1, null)])).toStrictEqual({ workspaces: [], panes: [] });
});

describe("floorProblem", () => {
  test("says nothing for a live floor, and that a connecting one is connecting", () => {
    expect(floorProblem(machine({ state: "live", message: "ssh: connect to host devbox: Connection timed out" }))).toBe("");
    expect(floorProblem(machine({ state: "connecting", message: "Permission denied" }))).toBe("connecting…");
  });

  test("puts ssh's and the runtime's errors in a few words", () => {
    const problem = (message: string, over: Partial<MachineInfo> = {}) => floorProblem(machine({ message, ...over }));
    expect(problem("ssh: connect to host devbox port 22: Connection timed out")).toBe("offline · ssh timed out");
    expect(problem("me@devbox: permission denied (publickey).")).toBe("ssh key refused");
    expect(problem("Host key verification failed.")).toBe("unknown host key · run ssh devbox once");
    expect(problem("Host key verification failed.", { ssh: null })).toBe("unknown host key · run ssh  once");
    expect(problem("ssh: Could not resolve hostname devbox: Name or service not known")).toBe("unknown host");
    expect(problem("ssh: devbox: Name or service not known")).toBe("unknown host");
    expect(problem("ssh: connect to host devbox port 22: Connection refused")).toBe("ssh refused the connection");
    expect(problem("Herdr is not running on devbox")).toBe("Herdr is not running");
    expect(problem("no reply from Herdr after 5s")).toBe("Herdr is not answering");
    expect(problem("no reply from Herdr", { runtime: { name: "Tmux", version: null } })).toBe("no reply from Herdr");
  });

  test("falls back to the whole message, or to unreachable without one", () => {
    expect(floorProblem(machine({ message: "the floor caught fire" }))).toBe("the floor caught fire");
    expect(floorProblem(machine({ message: "" }))).toBe("unreachable");
  });

  test("checks a timeout before a refusal when ssh reports both", () => {
    expect(floorProblem(machine({ message: "Connection refused, then Connection timed out" }))).toBe("offline · ssh timed out");
  });
});

test("runtimeOf names what runs the floor, with its version once known", () => {
  expect(runtimeOf(machine())).toBe("Herdr");
  expect(runtimeOf(machine({ runtime: { name: "Herdr", version: "0.9.3" } }))).toBe("Herdr 0.9.3");
  expect(runtimeOf(machine({ runtime: { name: "Herdr", version: "" } }))).toBe("Herdr");
});
