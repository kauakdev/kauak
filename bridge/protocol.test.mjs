import test from "node:test";
import assert from "node:assert/strict";
import { KEY, MAX_INPUT_OPS, MAX_INPUT_TEXT, MAX_READ_LINES, parseClientMessage as parse } from "./protocol.js";

test("every message the page sends is accepted as it is", () => {
  const sent = [
    { type: "focus", machine: "local", pane_id: "w1:p1" },
    { type: "read", machine: "local", pane_id: "w1:p1", lines: 1040, seq: 7 },
    { type: "input", machine: "local", pane_id: "w1:p1", ops: [{ text: "ls" }, { keys: ["enter"] }], id: 3 },
    { type: "commands", machine: "local", pane_id: "w1:p1" },
    { type: "uncommitted", machine: "gpu-box", root: "/home/dev/code/llm-evals", id: 2 },
    { type: "create_desk", machine: "local", workspace_id: "w1", agent: "claude", id: 1 },
    { type: "create_desk", machine: "local", workspace_id: "w1", agent: null, id: 1 },
    { type: "create_room", machine: "local", room: { kind: "worktree", cwd: "~/code/kauak", branch: "feat/x", base: "main", label: "x" }, agent: "codex", id: 4 },
    { type: "create_room", machine: "local", room: { kind: "folder", cwd: "/tmp" }, agent: null, id: 5 },
    { type: "remove_machine", machine: "gpu-box" },
    { type: "refresh", machine: "local" },
  ];
  for (const msg of sent) assert.deepEqual(parse(msg), msg);
  assert.deepEqual(parse({ type: "add_machine", ssh: " dev@gpu-box ", label: " GPU " }), { type: "add_machine", ssh: "dev@gpu-box", label: "GPU" });
  assert.deepEqual(parse({ type: "add_machine", ssh: "gpu-box" }), { type: "add_machine", ssh: "gpu-box", label: "" });
});

test("what is not a Kauak message is dropped", () => {
  for (const msg of [
    null, "focus", [], 42, {}, { type: 1 }, { type: "nope", machine: "local" },
    // Herdr's own requests are not Kauak's.
    { type: "pane.send_keys", machine: "local", pane_id: "w1:p1", keys: ["enter"] },
    { method: "pane.focus", params: { pane_id: "w1:p1" } },
    { type: "focus", pane_id: "w1:p1" },
    { type: "focus", machine: "local" },
    { type: "focus", machine: "local", pane_id: 7 },
    { type: "focus", machine: "", pane_id: "w1:p1" },
    { type: "input", machine: "local", pane_id: "w1:p1", ops: "ls" },
    { type: "uncommitted", machine: "local" },
    { type: "create_desk", machine: "local" },
    { type: "create_room", machine: "local", room: { kind: "tab", cwd: "/tmp" } },
    { type: "create_room", machine: "local", room: { kind: "worktree", cwd: "/tmp" } },
    { type: "create_room", machine: "local", room: "/tmp" },
    { type: "add_machine", ssh: 5 },
    { type: "remove_machine" },
  ]) assert.equal(parse(msg), null, JSON.stringify(msg));
});

test("reads ask for at most MAX_READ_LINES rows, and none means the screen", () => {
  const read = (lines) => parse({ type: "read", machine: "local", pane_id: "w1:p1", lines });
  assert.equal(read(10 ** 9).lines, MAX_READ_LINES);
  assert.equal(read(undefined).lines, null);
  assert.equal(read(0).lines, null);
  assert.equal(read(-5).lines, null);
  assert.equal(read(12.5).lines, null);
  // A Herdr read source is not part of the protocol.
  assert.equal("source" in parse({ type: "read", machine: "local", pane_id: "w1:p1", source: "recent" }), false);
});

test("input keeps text and Kauak key names, within limits", () => {
  const ops = (list) => parse({ type: "input", machine: "local", pane_id: "w1:p1", ops: list }).ops;
  for (const key of ["enter", "esc", "tab", "shift+tab", "up", "down", "ctrl+c", "backspace", "ctrl+u", "left", "alt+f"]) assert.match(key, KEY);
  assert.deepEqual(ops([{ keys: ["enter", "ESC", "\x1b", "ctrl+", "f13", "ctrl+alt+shift+meta+x", 5, "x".repeat(40), "ctrl+c"] }]), [{ keys: ["enter", "ctrl+c"] }]);
  assert.deepEqual(ops([{ text: "" }, { keys: ["bogus"] }, { text: "hi" }, null, { other: 1 }]), [{ text: "hi" }]);
  assert.equal(ops([{ text: "x".repeat(MAX_INPUT_TEXT + 10) }])[0].text.length, MAX_INPUT_TEXT);
  assert.equal(ops(Array.from({ length: MAX_INPUT_OPS + 50 }, () => ({ text: "a" }))).length, MAX_INPUT_OPS);
});

test("ids and seqs come back only when the page sent them", () => {
  assert.equal("seq" in parse({ type: "read", machine: "local", pane_id: "w1:p1" }), false);
  assert.equal("id" in parse({ type: "input", machine: "local", pane_id: "w1:p1", ops: [], id: "7" }), false);
  assert.equal(parse({ type: "uncommitted", machine: "local", root: "/r", id: 9 }).id, 9);
});

test("build requests keep what the bridge checks and answers itself", () => {
  // A bad agent kind, empty folder or branch is the bridge's to explain, so it gets through.
  const desk = parse({ type: "create_desk", machine: "local", workspace_id: "w1", agent: "Not An Agent" });
  assert.equal(desk.agent, "Not An Agent");
  assert.equal(parse({ type: "create_desk", machine: "local", workspace_id: "w1", agent: "" }).agent, null);
  assert.deepEqual(parse({ type: "create_room", machine: "local", room: { kind: "worktree", cwd: "", branch: "" } }).room, { kind: "worktree", cwd: "", branch: "" });
  // Fields that are not the room's are left behind.
  assert.deepEqual(parse({ type: "create_room", machine: "local", room: { kind: "folder", cwd: "/tmp", branch: "x", extra: 1 } }).room, { kind: "folder", cwd: "/tmp" });
});
