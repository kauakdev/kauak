import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { T3_FIELDS, TOKEN, fakeT3, t3State } from "./fixtures/fake-t3.mjs";
import { T3Floor } from "./floor.ts";
import {
  WIDTH,
  agentKind,
  answersOf,
  applyShell,
  decisionOf,
  featuresOf,
  modelFor,
  pendingOf,
  requestOf,
  toSnapshot,
  transcript,
  wrap,
} from "./t3.ts";

function assertNoT3Fields(value) {
  const keys = new Set();
  JSON.stringify(value, (k, v) => {
    keys.add(k);
    return v;
  });
  for (const f of T3_FIELDS) assert.ok(!keys.has(f), `"${f}" leaked`);
}

const CONFIG = {
  providers: [
    {
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      enabled: true,
      models: [{ slug: "claude-old" }, { slug: "claude-default", isDefault: true }],
    },
    { instanceId: "codex", driver: "codex", enabled: true, models: [{ slug: "gpt-default", isDefault: true }] },
    { instanceId: "cursor", driver: "cursor", enabled: false, models: [] },
  ],
  settings: { defaultRuntimeMode: "approval-required" },
};
const kindOf = (id) => agentKind(id, CONFIG);
const details = (state) =>
  new Map(Object.entries(state.turns).map(([id, turns]) => [id, { ...state.shell.threads.find((t) => t.id === id), ...turns }]));

test("a T3 Code shell becomes a Kauak snapshot: a room per checkout, a desk per thread in play", () => {
  const state = t3State();
  const snap = toSnapshot(state.shell, details(state), kindOf);
  assert.deepEqual(
    snap.workspaces.map((w) => [w.workspace_id, w.number, w.label, w.repo?.checkout ?? null, w.repo?.linked ?? null]),
    [
      ["p-billing", 1, "billing-api", "/home/dev/code/billing-api", false],
      [
        "p-billing:/home/dev/.t3/worktrees/billing-api/feat-refunds",
        2,
        "feat/refunds",
        "/home/dev/.t3/worktrees/billing-api/feat-refunds",
        true,
      ],
      ["p-notes", 3, "notes", null, null],
    ],
  );
  // Rooms of one repository share its key, so they share a wing.
  assert.equal(snap.workspaces[0].repo.key, snap.workspaces[1].repo.key);
  assert.deepEqual(
    snap.panes.map((p) => [p.pane_id, p.workspace_id.split(":")[0], p.agent, p.agent_status]),
    [
      ["t-work", "p-billing", "claude", "working"],
      ["t-approve", "p-billing", "codex", "blocked"],
      ["t-ask", "p-notes", "claude", "blocked"],
      ["t-done", "p-notes", "claude", "done"],
    ],
  );
  const [work, approve, ask, done] = snap.panes;
  assert.equal(work.cwd, "/home/dev/code/billing-api");
  assert.equal(approve.cwd, "/home/dev/.t3/worktrees/billing-api/feat-refunds");
  assert.deepEqual(work.context, { used: 84213, max: 258400 });
  assert.equal(work.request, null);
  assert.equal(approve.request.id, "r-push");
  assert.equal(ask.request.id, "q-db");
  assert.equal(done.request, null);
  assert.deepEqual(work.screen, { rows: 40, cols: WIDTH, exact: true });
  assertNoT3Fields(snap);

  // Without its turns a desk still has its status, but no request or meter yet.
  const bare = toSnapshot(state.shell, new Map(), kindOf);
  assert.equal(bare.panes[1].agent_status, "blocked");
  assert.equal(bare.panes[1].request, null);
  assert.equal(bare.panes[0].context, null);
});

test("the shell stream: a snapshot, then numbered changes, replays left out", () => {
  const { shell } = t3State();
  let s = applyShell(null, { kind: "snapshot", snapshot: shell }).shell;
  assert.equal(applyShell(s, { kind: "synchronized" }).changed, false);
  const renamed = { ...shell.threads[0], title: "Renamed" };
  assert.equal(applyShell(s, { kind: "thread-upserted", sequence: 10, thread: renamed }).changed, false);
  s = applyShell(s, { kind: "thread-upserted", sequence: 11, thread: renamed }).shell;
  assert.equal(s.threads[0].title, "Renamed");
  s = applyShell(s, { kind: "thread-removed", sequence: 12, threadId: "t-work" }).shell;
  assert.equal(
    s.threads.some((t) => t.id === "t-work"),
    false,
  );
  s = applyShell(s, { kind: "project-removed", sequence: 13, projectId: "p-notes" }).shell;
  assert.deepEqual(
    toSnapshot(s, new Map(), kindOf).workspaces.map((w) => w.label),
    ["billing-api", "feat/refunds"],
  );
});

test("open requests are worked out as T3 Code's clients do", () => {
  const { turns } = t3State();
  // r-old was answered, r-gone failed as stale; r-push is still open.
  assert.deepEqual(
    pendingOf(turns["t-approve"].activities).approvals.map((a) => a.requestId),
    ["r-push"],
  );
  assert.deepEqual(requestOf(turns["t-approve"].activities), {
    id: "r-push",
    kind: "approval",
    questions: [
      {
        id: "r-push",
        title: "Run a command",
        text: "git push origin HEAD",
        options: [
          { id: "accept", label: "Approve", description: "" },
          { id: "acceptForSession", label: "Always allow this session", description: "" },
          { id: "decline", label: "Decline", description: "" },
          { id: "cancel", label: "Cancel", description: "" },
        ],
        multiple: false,
        typed: false,
      },
    ],
  });
  const ask = requestOf(turns["t-ask"].activities);
  assert.equal(ask.kind, "question");
  assert.deepEqual(
    ask.questions.map((q) => [q.id, q.title, q.options.map((o) => o.id), q.multiple, q.typed]),
    [
      ["db", "Database", ["Postgres", "sqlite"], false, true],
      ["extras", "Extras", ["Backups", "Replicas"], true, false],
    ],
  );
  // Options an approval names itself are kept, with their warnings.
  const own = requestOf([
    {
      kind: "approval.requested",
      createdAt: "x",
      payload: {
        requestId: "r",
        requestKind: "file-change",
        detail: "a.ts",
        options: [{ decision: "accept", label: "Yes", warning: "careful" }, { nope: 1 }],
      },
    },
  ]);
  assert.deepEqual(own.questions[0].options, [{ id: "accept", label: "Yes", description: "careful" }]);
  assert.equal(own.questions[0].title, "Change files");
  assert.equal(requestOf([]), null);
});

test("answers become T3 Code's: a decision, or answers by question id", () => {
  const { turns } = t3State();
  const approval = requestOf(turns["t-approve"].activities);
  assert.equal(decisionOf(approval, [{ question_id: "r-push", options: ["acceptForSession"] }]), "acceptForSession");
  assert.throws(() => decisionOf(approval, [{ question_id: "r-push", options: ["yolo"] }]), /Pick one of the answers offered/);
  assert.throws(() => decisionOf(approval, []), /Pick one/);

  const ask = requestOf(turns["t-ask"].activities);
  assert.deepEqual(
    answersOf(ask, [
      { question_id: "db", options: ["sqlite"] },
      { question_id: "extras", options: ["Backups", "nope", "Replicas"] },
    ]),
    { db: "sqlite", extras: ["Backups", "Replicas"] },
  );
  // A typed answer wins where it is allowed, and is not where it is not.
  assert.deepEqual(
    answersOf(ask, [
      { question_id: "db", options: ["sqlite"], text: " MySQL " },
      { question_id: "extras", options: ["Backups"], text: "ignored" },
    ]),
    { db: "MySQL", extras: ["Backups"] },
  );
  assert.throws(() => answersOf(ask, [{ question_id: "db", options: ["sqlite"] }]), /Answer "Extras" first/);
});

test("a transcript draws a thread as a terminal would, with nothing that could drive the terminal", () => {
  const state = t3State();
  const rows = transcript(details(state).get("t-work"), true);
  const text = rows.join("\n");
  const plain = (r) => r.replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(plain(rows[0]), /earlier turns are in T3 Code/);
  assert.ok(rows.some((r) => plain(r) === "❯ Add refunds to the ledger, with tests."));
  // The agent's reasoning is not shown; its replies are, the one still streaming with a cursor.
  assert.doesNotMatch(text, /Thinking about where/);
  assert.ok(rows.some((r) => plain(r).startsWith("Refunds go in **ledger.ts**.")));
  assert.ok(rows.some((r) => plain(r) === "Running the tests▍"));
  // A tool once, done even though an update came after its completion; one still running says so.
  assert.deepEqual(
    rows.map(plain).filter((r) => r.includes("⏺")),
    ["  ⏺ Bash: pnpm test", "  ⏺ Write: /home/dev/code/billing-api/src/ledger.ts …"],
  );
  assert.ok(rows.some((r) => plain(r).includes("✗ Provider hiccup: rate limited, retrying")));
  assert.equal(plain(rows.at(-1)), "… working");
  // Only color escapes are left: the agent's own title and clear-screen sequences are gone.
  for (const r of rows) {
    assert.doesNotMatch(r.replace(/\x1b\[[0-9;]*m/g, ""), /[\x00-\x1f\x7f]/, JSON.stringify(r));
    assert.ok([...plain(r)].length <= WIDTH, `too wide: ${r}`);
  }

  const asking = transcript(details(state).get("t-approve"), false).map(plain);
  assert.match(asking.at(-1), /Waiting for your approval: the buttons below answer it/);
  assert.ok(asking.includes("  ? git push origin HEAD"));
  assert.ok(asking.includes("  ↳ accept"));
});

test("wrap breaks at words, cuts what has none, and keeps blank lines and indents", () => {
  assert.deepEqual(wrap("one two three four", 9), ["one two", "three", "four"]);
  assert.deepEqual(wrap("abcdefghij", 4), ["abcd", "efgh", "ij"]);
  assert.deepEqual(wrap("a\n\n  b c", 10), ["a", "", "  b c"]);
});

test("a new thread gets the model its provider's latest thread used, else the provider's default", () => {
  const { shell } = t3State();
  const project = shell.projects[0];
  assert.deepEqual(modelFor("claude", project, shell, CONFIG), { instanceId: "claudeAgent", model: "claude-test" });
  assert.deepEqual(modelFor("codex", project, { ...shell, threads: [] }, CONFIG), { instanceId: "codex", model: "gpt-default" });
  assert.throws(() => modelFor("cursor", project, shell, CONFIG), /cursor is not enabled in T3 Code/);
  assert.throws(() => modelFor("gemini", project, shell, CONFIG), /gemini is not enabled/);
  assert.deepEqual(featuresOf(CONFIG), { focus: false, shells: false, agent_kinds: ["claude", "codex"] });
  assert.equal(agentKind("claudeAgent", null), "claude");
  assert.equal(agentKind("Not A Kind!", null), null);
});

// ---------------------------------------------------------------- a floor

async function liveFloor(t, opts = {}) {
  const t3 = await fakeT3(opts);
  t.after(() => t3.close());
  const tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "kauak-t3-test-"));
  t.after(() => fs.rmSync(tokenDir, { recursive: true, force: true }));
  const floor = new T3Floor({ id: "t3", label: "T3", runtime: "t3", url: t3.url, token: opts.token ?? TOKEN }, { tokenDir });
  t.after(() => floor.stop());
  return { t3, floor, tokenDir };
}

async function started(floor) {
  const live = once(floor, "snapshot");
  floor.start();
  await live;
  return floor;
}

/** A port nothing listens on. */
function closedPort() {
  return new Promise((resolve) => {
    const srv = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function until(check, what, ms = 3000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) if (check()) return;
  throw new Error(`timed out: ${what}`);
}

test("a T3 Code floor connects with its token and emits Kauak snapshots as the shell changes", async (t) => {
  const { t3, floor } = await liveFloor(t);
  await started(floor);
  assert.deepEqual(floor.info, {
    id: "t3",
    label: "T3",
    ssh: null,
    state: "live",
    message: "",
    runtime: { name: "T3 Code", version: "0.0.45", features: { focus: false, shells: false, agent_kinds: ["claude", "codex"] } },
  });
  assert.deepEqual(
    floor.snapshot.panes.map((p) => p.pane_id),
    ["t-work", "t-approve", "t-ask", "t-done"],
  );
  // Each desk's latest turn is fetched, for its request and context meter.
  await until(() => floor.snapshot.panes[1].request?.id === "r-push", "the approval");
  assert.deepEqual(floor.snapshot.panes[0].context, { used: 84213, max: 258400 });
  assert.ok(t3.reads.every((r) => r.turnLimit === 1 && r.reasoningMessages === "true"));
  assert.ok(t3.acks >= 1, "the stream's chunks are acknowledged");

  const next = once(floor, "snapshot");
  t3.upsertThread({ ...t3.state.shell.threads[3], settledOverride: "settled" });
  const [snap] = await next;
  assert.equal(
    snap.panes.some((p) => p.pane_id === "t-done"),
    false,
  );
  assertNoT3Fields(snap);
  assertNoT3Fields(floor.info);
});

test("typing waits in a draft; Enter sends it as a message, Esc stops the turn, other keys do nothing", async (t) => {
  const { t3, floor } = await liveFloor(t);
  await started(floor);
  await floor.sendText("t-work", "fix the \x1b[200~flaky\rtest\x1b[201~x");
  await floor.sendKeys("t-work", ["backspace", "up", "tab"]);
  assert.equal(t3.commands().length, 0);
  await floor.sendKeys("t-work", ["enter"]);
  const [start] = t3.commands("thread.turn.start");
  assert.equal(start.threadId, "t-work");
  assert.deepEqual(start.message.text, "fix the flaky\ntest");
  assert.equal(start.message.role, "user");
  assert.deepEqual(start.message.attachments, []);
  assert.equal(start.runtimeMode, "approval-required");
  // An empty Enter sends nothing.
  await floor.sendKeys("t-work", ["enter"]);
  assert.equal(t3.commands("thread.turn.start").length, 1);
  await until(() => floor.shell.threads.find((x) => x.id === "t-work").latestTurn.state === "running", "the turn");
  await floor.sendKeys("t-work", ["esc"]);
  assert.equal(t3.commands("thread.turn.interrupt")[0].threadId, "t-work");
  await assert.rejects(floor.sendText("t-settled", "x"), /pane t-settled not found/);
});

test("reading a desk draws its transcript from its latest turns", async (t) => {
  const { t3, floor } = await liveFloor(t);
  await started(floor);
  const text = await floor.readPane("t-work", 1000);
  assert.ok(text.includes("\r\n"));
  assert.match(text, /Add refunds to the ledger, with tests\./);
  assert.ok(t3.reads.some((r) => r.id === "t-work" && r.turnLimit === 4));
  const screen = await floor.readPane("t-done", null);
  assert.match(screen, /Done\./);
  await assert.rejects(floor.readPane("t-nope"), /pane t-nope not found/);
});

test("an answer is checked against the desk's open request, then sent as T3 Code's", async (t) => {
  const { t3, floor } = await liveFloor(t);
  await started(floor);
  await assert.rejects(floor.answer("t-approve", "r-old", [{ question_id: "r-old", options: ["accept"] }]), /already answered/);
  await assert.rejects(floor.answer("t-approve", "r-push", [{ question_id: "r-push", options: ["nope"] }]), /Pick one/);
  await floor.answer("t-approve", "r-push", [{ question_id: "r-push", options: ["accept"] }]);
  const [approval] = t3.commands("thread.approval.respond");
  assert.deepEqual([approval.threadId, approval.requestId, approval.decision], ["t-approve", "r-push", "accept"]);
  await until(() => floor.snapshot.panes.find((p) => p.pane_id === "t-approve").agent_status !== "blocked", "the approval to go");

  await floor.answer("t-ask", "q-db", [
    { question_id: "db", options: ["Postgres"] },
    { question_id: "extras", options: ["Replicas"] },
  ]);
  assert.deepEqual(t3.commands("thread.user-input.respond")[0].answers, { db: "Postgres", extras: ["Replicas"] });
});

test("build mode: a desk is a new thread with the agent's model, a room a project or a worktree", async (t) => {
  const { t3, floor } = await liveFloor(t);
  await started(floor);
  const desk = await floor.createDesk("p-billing:/home/dev/.t3/worktrees/billing-api/feat-refunds", "codex");
  const [create] = t3.commands("thread.create");
  assert.equal(create.threadId, desk);
  assert.deepEqual(create.modelSelection, { instanceId: "codex", model: "gpt-test" });
  assert.deepEqual(
    [create.projectId, create.branch, create.worktreePath],
    ["p-billing", "feat/refunds", "/home/dev/.t3/worktrees/billing-api/feat-refunds"],
  );
  assert.equal(create.runtimeMode, "approval-required");
  assert.ok(floor.snapshot.panes.some((p) => p.pane_id === desk && p.agent === "codex"));
  // The thread has its agent from the start.
  await floor.startAgent("codex", desk);
  assert.equal(t3.commands("thread.meta.update").length, 0);
  await floor.startAgent("claude", desk);
  assert.equal(t3.commands("thread.meta.update")[0].modelSelection.instanceId, "claudeAgent");

  await assert.rejects(floor.createDesk("p-billing", null), /Pick an agent/);
  await assert.rejects(floor.createDesk("p-gone", "claude"), /That room is gone/);

  const inFolder = await floor.createRoom({ kind: "folder", cwd: "/home/dev/scratch/", label: "Scratch" }, "claude");
  const project = t3.commands("project.create")[0];
  assert.deepEqual([project.workspaceRoot, project.title], ["/home/dev/scratch", "Scratch"]);
  assert.equal(t3.commands("thread.create").find((c) => c.threadId === inFolder).projectId, project.projectId);

  const inTree = await floor.createRoom({ kind: "worktree", cwd: "/home/dev/code/billing-api", branch: "feat/x", base: "main" }, "claude");
  assert.equal(t3.commands("project.create").length, 1, "the folder was a project already");
  const tree = t3.commands("thread.create").find((c) => c.threadId === inTree);
  assert.deepEqual([tree.branch, tree.worktreePath], ["feat/x", "/home/dev/.t3/worktrees/billing-api/feat-x"]);
  assert.ok(floor.snapshot.workspaces.some((w) => w.label === "feat/x" && w.repo?.linked));
});

test("a refused command rejects with T3 Code's sentence", async (t) => {
  const { floor } = await liveFloor(t, {
    handlers: {
      "thread.turn.start": () => {
        throw new Error("Thread is busy.\nWait for the current turn.");
      },
    },
  });
  await started(floor);
  await floor.sendText("t-done", "again");
  await assert.rejects(floor.sendKeys("t-done", ["enter"]), { message: "Wait for the current turn." });
  await assert.rejects(floor.focusPane("t-done"), /no way to show a thread/);
});

test("a wrong token, a server that is not there, or another protocol: the floor is down and says why", async (t) => {
  const why = async (opts, url) => {
    const { floor, t3 } = await liveFloor(t, opts);
    if (url) floor.url = url;
    const down = once(floor, "status");
    floor.start();
    const [info] = await down;
    floor.stop();
    await t3.close();
    return [info.state, info.message];
  };
  assert.deepEqual(await why({ token: "wrong" }), ["down", "T3 Code refused the token (401)"]);
  assert.deepEqual(await why({}, `http://127.0.0.1:${await closedPort()}`), ["down", "T3 Code is not running (ECONNREFUSED)"]);
  const [state, message] = await why({ protocol: 2 });
  assert.equal(state, "down");
  assert.match(message, /T3 Code 0\.0\.45 speaks protocol 2; this Kauak speaks 1/);
});

test("a dropped connection is retried, and the floor comes back live", async (t) => {
  const { t3, floor } = await liveFloor(t);
  await started(floor);
  const down = once(floor, "status");
  t3.drop();
  assert.equal((await down)[0].state, "down");
  await until(() => floor.state === "live", "the floor to come back", 5000);
});

test("the token is kept in a file only you can read, never in the floor's config, and goes with the floor", async (t) => {
  const { floor, tokenDir } = await liveFloor(t);
  const file = path.join(tokenDir, "t3.token");
  assert.equal(fs.readFileSync(file, "utf8"), `${TOKEN}\n`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(tokenDir).mode & 0o777, 0o700);
  assert.deepEqual(floor.config, { id: "t3", label: "T3", runtime: "t3", url: floor.url });
  assert.doesNotMatch(JSON.stringify(floor.config), new RegExp(TOKEN));
  // Made again from machines.json, with no token: it reads its file.
  const again = new T3Floor(floor.config, { tokenDir });
  await started(again);
  again.forget();
  assert.equal(fs.existsSync(file), false);
});
