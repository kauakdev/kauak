import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { FIXTURE, fakeHerdr, herdrError } from "./fixtures/fake-herdr.mjs";
import { errorMessage, paneSession, toSnapshot } from "./herdr.ts";
import { Machine } from "./machine.ts";

// Herdr's names, which must never reach a page.
const HERDR_FIELDS = [
  "terminal_id",
  "terminal_title",
  "foreground_cwd",
  "tab_id",
  "tabs",
  "layouts",
  "scroll",
  "viewport_rows",
  "worktree",
  "repo_key",
  "checkout_path",
  "is_linked_worktree",
  "agent_session",
  "revision",
  "protocol",
  "version",
  "agents",
  "active_tab_id",
  "pane_count",
  "focused_pane_id",
];

function assertNoHerdrFields(value) {
  const keys = new Set();
  JSON.stringify(value, (k, v) => {
    keys.add(k);
    return v;
  });
  for (const f of HERDR_FIELDS) assert.ok(!keys.has(f), `"${f}" leaked`);
}

test("a Herdr session.snapshot becomes a Kauak snapshot", () => {
  const snap = toSnapshot(FIXTURE);
  assert.deepEqual(snap, {
    workspaces: [
      {
        workspace_id: "w1",
        number: 1,
        label: "billing-api",
        focused: true,
        git_root: null,
        repo: {
          key: "/home/dev/code/billing-api/.git",
          name: "billing-api",
          root: "/home/dev/code/billing-api",
          checkout: "/home/dev/code/billing-api",
          linked: false,
        },
      },
      {
        workspace_id: "w2",
        number: 2,
        label: "feat/refunds",
        focused: false,
        git_root: null,
        repo: {
          key: "/home/dev/code/billing-api/.git",
          name: "billing-api",
          root: "/home/dev/code/billing-api",
          checkout: "/home/dev/.herdr/worktrees/billing-api/feat-refunds",
          linked: true,
        },
      },
      { workspace_id: "w3", number: 3, label: "notes", focused: false, git_root: null, repo: null },
    ],
    panes: [
      {
        pane_id: "w1:p1",
        workspace_id: "w1",
        focused: true,
        cwd: "/home/dev/code/billing-api",
        title: "Add refunds to the ledger",
        agent: "claude",
        agent_status: "idle",
        screen: { rows: 40, cols: 120, exact: true },
        scrollback: false,
        context: null,
      },
      // The foreground program's folder wins over the shell's; history above the screen is scrollback.
      {
        pane_id: "w1:p2",
        workspace_id: "w1",
        focused: false,
        cwd: "/home/dev/code/billing-api/db",
        title: "dev@laptop: ~/code/billing-api/db",
        agent: null,
        agent_status: "unknown",
        screen: { rows: 40, cols: 120, exact: true },
        scrollback: true,
        context: null,
      },
      // The layout rect is not the pane's real size when its height disagrees with the viewport's.
      {
        pane_id: "w2:p1",
        workspace_id: "w2",
        focused: false,
        cwd: "/home/dev/.herdr/worktrees/billing-api/feat-refunds",
        title: "codex",
        agent: "codex",
        agent_status: "working",
        screen: { rows: 52, cols: 120, exact: false },
        scrollback: false,
        context: null,
      },
      // Herdr may leave the folder, title, scroll state and layout out.
      {
        pane_id: "w3:p1",
        workspace_id: "w3",
        focused: false,
        cwd: null,
        title: "",
        agent: "claude",
        agent_status: "blocked",
        screen: null,
        scrollback: false,
        context: null,
      },
    ],
  });
  assertNoHerdrFields(snap);
});

test("the translation tolerates what a newer or older Herdr might send", () => {
  const raw = structuredClone(FIXTURE);
  raw.panes[0].agent_status = "thinking";
  raw.panes[1].agent = "";
  raw.panes[1].terminal_title_stripped = "";
  raw.workspaces[0].worktree = { unexpected: true };
  delete raw.layouts;
  const snap = toSnapshot(raw);
  assert.equal(snap.panes[0].agent_status, "unknown");
  assert.equal(snap.panes[1].agent, null);
  assert.equal(snap.panes[1].title, "dev@laptop: ~/code/billing-api/db");
  assert.equal(snap.workspaces[0].repo, null);
  assert.deepEqual(snap.panes[0].screen, { rows: 40, cols: null, exact: false });
  assert.deepEqual(toSnapshot({}), { workspaces: [], panes: [] });
  assert.deepEqual(toSnapshot(null), { workspaces: [], panes: [] });
});

test("an agent session counts only while it is the pane's current agent's", () => {
  assert.deepEqual(paneSession(FIXTURE, "w1:p1"), { kind: "path", value: FIXTURE.panes[0].agent_session.value });
  assert.deepEqual(paneSession(FIXTURE, "w2:p1"), { kind: "id", value: "0199a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b" });
  assert.equal(paneSession(FIXTURE, "w3:p1"), null); // a codex session in a claude pane
  assert.equal(paneSession(FIXTURE, "w1:p2"), null);
  assert.equal(paneSession(FIXTURE, "nope"), null);
  assert.equal(paneSession(null, "w1:p1"), null);
});

test("Herdr's errors become messages fit to show", () => {
  assert.equal(errorMessage(herdrError("pane_not_found", "pane w9:p1 not found")), "pane w9:p1 not found");
  assert.equal(
    errorMessage(herdrError("worktree_failed", "git worktree add failed:\nPreparing worktree\nfatal: a branch named 'x' already exists\n")),
    "fatal: a branch named 'x' already exists",
  );
  assert.equal(
    errorMessage(Object.assign(new Error("connect ENOENT /home/dev/.config/herdr/herdr.sock"), { code: "ENOENT" })),
    "Herdr is not running",
  );
  assert.equal(errorMessage(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })), "Herdr is not running");
});

// ---------------------------------------------------------------- the adapter, against a fake Herdr

async function liveMachine(t, options) {
  const herdr = await fakeHerdr(options);
  const m = new Machine({ id: "local", label: "local", socket: herdr.socketPath });
  t.after(async () => {
    m.stop();
    await herdr.close();
  });
  const first = once(m, "snapshot");
  m.start();
  await first;
  return { herdr, m };
}

test("a floor subscribes to Herdr and emits Kauak snapshots, another one after each event", async (t) => {
  const { herdr, m } = await liveMachine(t);
  assert.deepEqual(m.snapshot, toSnapshot(FIXTURE));
  assert.deepEqual(m.info, {
    id: "local",
    label: "local",
    ssh: null,
    state: "live",
    message: "",
    runtime: { name: "Herdr", version: "0.9.3" },
  });

  herdr.snapshot = structuredClone(FIXTURE);
  herdr.snapshot.panes[0].agent_status = "working";
  const next = once(m, "snapshot");
  herdr.emit("pane.updated", { pane_id: "w1:p1" });
  const [snap] = await next;
  assert.equal(snap.panes[0].agent_status, "working");
});

test("Kauak operations become Herdr requests", async (t) => {
  const { herdr, m } = await liveMachine(t, {
    handlers: {
      "pane.read": (p) => ({ read: { pane_id: p.pane_id, text: "$ ls\r\nREADME.md", revision: 0, truncated: false } }),
      "tab.create": () => ({ tab: { tab_id: "w1:t3" }, root_pane: { pane_id: "w1:p7" } }),
      "worktree.create": () => ({ root_pane: { pane_id: "w4:p1" } }),
      "workspace.create": () => ({ root_pane: { pane_id: "w5:p1" } }),
      "pane.process_info": () => ({ process_info: { foreground_processes: [{ pid: 4242, name: "claude" }, { pid: "x" }] } }),
    },
  });
  assert.equal(await m.readPane("w1:p1", 1040), "$ ls\r\nREADME.md");
  await m.readPane("w1:p1");
  assert.deepEqual(herdr.calls("pane.read"), [
    { pane_id: "w1:p1", source: "recent", format: "ansi", strip_ansi: false, lines: 1040 },
    { pane_id: "w1:p1", source: "visible", format: "ansi", strip_ansi: false, lines: null },
  ]);

  await m.focusPane("w2:p1");
  await m.sendText("w1:p1", "hello");
  const keys = Array.from({ length: 70 }, () => "down");
  await m.sendKeys("w1:p1", keys);
  assert.deepEqual(herdr.calls("pane.focus"), [{ pane_id: "w2:p1" }]);
  assert.deepEqual(herdr.calls("pane.send_text"), [{ pane_id: "w1:p1", text: "hello" }]);
  assert.deepEqual(
    herdr.calls("pane.send_keys").map((p) => p.keys.length),
    [64, 6],
  );

  // A desk opens in its room's checkout; rooms are worktrees or plain workspaces.
  assert.equal(await m.createDesk("w2"), "w1:p7");
  assert.deepEqual(herdr.calls("tab.create"), [
    { workspace_id: "w2", cwd: "/home/dev/.herdr/worktrees/billing-api/feat-refunds", focus: false },
  ]);
  await assert.rejects(m.createDesk("w9"), { message: "That room is gone." });
  assert.equal(await m.createRoom({ kind: "worktree", cwd: "/home/dev/code/billing-api", branch: "feat/export" }), "w4:p1");
  assert.equal(await m.createRoom({ kind: "folder", cwd: "/home/dev/notes", label: "Notes" }), "w5:p1");
  assert.deepEqual(herdr.calls("worktree.create"), [
    { cwd: "/home/dev/code/billing-api", branch: "feat/export", base: null, label: null, focus: false },
  ]);
  assert.deepEqual(herdr.calls("workspace.create"), [{ cwd: "/home/dev/notes", label: "Notes", focus: false }]);

  assert.deepEqual(await m.paneProcesses("w1:p1"), [4242]);
  assert.deepEqual(m.paneSession("w2:p1"), { kind: "id", value: "0199a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b" });
});

test("a failed operation rejects with Herdr's message, not its method or code", async (t) => {
  const { m } = await liveMachine(t, {
    handlers: {
      "pane.focus": () => {
        throw herdrError("pane_not_found", "pane w9:p1 not found");
      },
    },
  });
  await assert.rejects(m.focusPane("w9:p1"), (err) => err.message === "pane w9:p1 not found");
});

test("an agent starts once the new pane's shell is ready for it", async (t) => {
  let busy = 2;
  const { herdr, m } = await liveMachine(t, {
    handlers: {
      "agent.start": () => {
        if (busy-- > 0) throw herdrError("agent_pane_busy", "pane is busy");
        return { agent: { name: "claude-x" } };
      },
    },
  });
  await m.startAgent("claude", "w1:p7");
  const calls = herdr.calls("agent.start");
  assert.equal(calls.length, 3);
  assert.equal(calls[0].kind, "claude");
  assert.equal(calls[0].pane_id, "w1:p7");
  assert.match(calls[0].name, /^claude-[a-z0-9]+$/);
});

test("a floor whose Herdr is not running is down, and says so", async (t) => {
  const m = new Machine({ id: "local", label: "local", socket: "/nonexistent/kauak-test/herdr.sock" });
  t.after(() => m.stop());
  const status = once(m, "status");
  m.start();
  const [info] = await status;
  assert.equal(info.state, "down");
  assert.match(info.message, /^Herdr is not running/);
  assert.deepEqual(info.runtime, { name: "Herdr", version: null });
});
