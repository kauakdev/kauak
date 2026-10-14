// A stand-in T3 Code server for the bridge's tests, speaking what the bridge
// uses of T3 Code 0.0.45 (orchestration protocol 1): the environment route,
// the shell and a thread's turns over HTTP, and on /ws the Effect RPC methods
// with their JSON frames, chunk acknowledgements included. Its state is made
// up, small and in T3 Code's shapes: two projects, a worktree, threads that
// work, wait for an approval or an answer, or are done, and two that are put
// away (settled, archived). Commands are recorded, and those the tests need
// change the state and stream the change, as T3 Code does.

import http from "node:http";
import { WebSocketServer } from "ws";

export const TOKEN = "kauak-test-token";

// T3 Code's names, which must never reach a page.
export const T3_FIELDS = [
  "projectId",
  "modelSelection",
  "instanceId",
  "worktreePath",
  "workspaceRoot",
  "latestTurn",
  "session",
  "hasPendingApprovals",
  "hasPendingUserInput",
  "settledOverride",
  "runtimeMode",
  "messages",
  "activities",
  "snapshotSequence",
  "requestId",
  "decision",
];
const T0 = "2026-10-11T10:00:00.000Z";
const at = (s) => new Date(Date.parse(T0) + s * 1000).toISOString();

const thread = (over) => ({
  title: "Thread",
  modelSelection: { instanceId: "claudeAgent", model: "claude-test" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: at(0),
  updatedAt: at(0),
  archivedAt: null,
  settledOverride: null,
  session: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  latestUserMessageAt: null,
  ...over,
});

/** A fresh copy of the made-up state: the shell, and each thread's messages and activities. */
export function t3State() {
  const shell = {
    snapshotSequence: 10,
    updatedAt: at(0),
    projects: [
      {
        id: "p-billing",
        title: "billing-api",
        workspaceRoot: "/home/dev/code/billing-api",
        repositoryIdentity: { canonicalKey: "github.com/dev/billing-api", name: "billing-api" },
        defaultModelSelection: null,
        scripts: [],
      },
      {
        id: "p-notes",
        title: "notes",
        workspaceRoot: "/home/dev/notes",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
      },
    ],
    threads: [
      thread({
        id: "t-work",
        projectId: "p-billing",
        title: "Add refunds to the ledger",
        session: { threadId: "t-work", status: "running", providerName: "claudeAgent", providerInstanceId: "claudeAgent", lastError: null },
        latestTurn: { turnId: "u1", state: "running" },
        createdAt: at(1),
        updatedAt: at(50),
      }),
      thread({
        id: "t-approve",
        projectId: "p-billing",
        title: "Refund webhooks",
        modelSelection: { instanceId: "codex", model: "gpt-test" },
        branch: "feat/refunds",
        worktreePath: "/home/dev/.t3/worktrees/billing-api/feat-refunds",
        session: { threadId: "t-approve", status: "running", providerName: "codex", providerInstanceId: "codex", lastError: null },
        latestTurn: { turnId: "u2", state: "running" },
        hasPendingApprovals: true,
        createdAt: at(2),
        updatedAt: at(40),
      }),
      thread({
        id: "t-ask",
        projectId: "p-notes",
        title: "Pick a database",
        session: { threadId: "t-ask", status: "running", providerName: "claudeAgent", lastError: null },
        latestTurn: { turnId: "u3", state: "running" },
        hasPendingUserInput: true,
        createdAt: at(3),
      }),
      thread({
        id: "t-done",
        projectId: "p-notes",
        title: "Tidy the notes",
        latestTurn: { turnId: "u4", state: "completed" },
        createdAt: at(4),
      }),
      thread({ id: "t-settled", projectId: "p-notes", title: "Old work", settledOverride: "settled", createdAt: at(5) }),
      thread({ id: "t-archived", projectId: "p-billing", title: "Archived", archivedAt: at(6), createdAt: at(6) }),
    ],
  };
  const activity = (id, kind, tone, summary, payload, s) => ({ id, kind, tone, summary, payload, turnId: null, createdAt: at(s) });
  const message = (id, role, text, s, streaming = false) => ({
    id,
    role,
    text,
    turnId: null,
    streaming,
    createdAt: at(s),
    updatedAt: at(s),
  });
  const turns = {
    "t-work": {
      messages: [
        message("m1", "user", "Add refunds to the ledger, with tests.", 10),
        message("m2", "reasoning", "Thinking about where refunds go.", 11),
        message("m3", "assistant", "Refunds go in **ledger.ts**.\x1b]0;pwned\x07\x1b[2J Writing them now.", 12),
        message("m4", "assistant", "Running the tests", 30, true),
      ],
      activities: [
        activity("a1", "tool.started", "tool", "Command run started", { toolCallId: "c1", detail: "Bash: {}" }, 13),
        activity("a2", "tool.completed", "tool", "Command run", { toolCallId: "c1", detail: "Bash: pnpm test" }, 14),
        activity("a3", "tool.updated", "tool", "Command run", { toolCallId: "c1", detail: "Bash: pnpm test" }, 15),
        activity(
          "a4",
          "tool.started",
          "tool",
          "File change",
          { toolCallId: "c2", detail: 'Write: {"file_path":"/home/dev/code/billing-api/src/ledger.ts","content":"x"}' },
          20,
        ),
        activity("a5", "context-window.updated", "info", "Context window updated", { usedTokens: 84213, maxTokens: 258400 }, 21),
        activity("a6", "runtime.error", "error", "Provider hiccup", { detail: "rate limited, retrying" }, 22),
      ],
    },
    "t-approve": {
      messages: [message("m5", "user", "Add the refund webhook.", 10)],
      activities: [
        activity(
          "b1",
          "approval.requested",
          "approval",
          "Command approval requested",
          { requestId: "r-old", requestKind: "command", detail: "ls" },
          11,
        ),
        activity("b2", "approval.resolved", "approval", "Approval resolved", { requestId: "r-old", decision: "accept" }, 12),
        activity(
          "b3",
          "approval.requested",
          "approval",
          "Command approval requested",
          { requestId: "r-gone", requestKind: "command", detail: "git status" },
          13,
        ),
        activity(
          "b4",
          "provider.approval.respond.failed",
          "error",
          "Approval failed",
          { requestId: "r-gone", detail: "Stale pending approval request: r-gone" },
          14,
        ),
        activity(
          "b5",
          "approval.requested",
          "approval",
          "Command approval requested",
          { requestId: "r-push", requestKind: "command", detail: "git push origin HEAD" },
          15,
        ),
      ],
    },
    "t-ask": {
      messages: [message("m6", "user", "Set up storage.", 10)],
      activities: [
        activity(
          "c1",
          "user-input.requested",
          "info",
          "User input requested",
          {
            requestId: "q-db",
            questions: [
              {
                id: "db",
                header: "Database",
                question: "Which database?",
                options: [
                  { label: "Postgres", description: "The usual" },
                  { label: "SQLite", description: "One file", value: "sqlite" },
                ],
                multiSelect: false,
              },
              {
                id: "extras",
                header: "Extras",
                question: "Anything else?",
                options: [
                  { label: "Backups", description: "" },
                  { label: "Replicas", description: "" },
                ],
                multiSelect: true,
                allowCustomAnswer: false,
              },
            ],
          },
          11,
        ),
      ],
    },
    "t-done": { messages: [message("m7", "user", "Tidy up.", 10), message("m8", "assistant", "Done.", 11)], activities: [] },
  };
  return { shell, turns };
}

/**
 * Starts the stand-in on a free port. `protocol` is the orchestration
 * protocol it says it speaks; `handlers` replaces what a command or method
 * answers, by its type or tag (throw for a failure). `commands(type)` is
 * what was dispatched, `reads` the thread fetches, `acks` the chunks the
 * client acknowledged.
 */
export async function fakeT3({ protocol = 1, handlers = {} } = {}) {
  const state = t3State();
  const dispatched = [];
  const reads = [];
  const subscribers = new Set();
  let acks = 0;
  const authorized = (req) => req.headers.authorization === `Bearer ${TOKEN}`;
  const detail = (id) => ({ ...state.shell.threads.find((t) => t.id === id), ...(state.turns[id] ?? { messages: [], activities: [] }) });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/.well-known/t3/environment")
      return json(200, { serverVersion: "0.0.45", orchestrationProtocolVersion: protocol });
    if (!authorized(req)) return json(401, { _tag: "EnvironmentAuthInvalidError" });
    if (url.pathname === "/api/orchestration/shell") return json(200, state.shell);
    const m = /^\/api\/orchestration\/threads\/([^/]+)$/.exec(url.pathname);
    if (m && state.shell.threads.some((t) => t.id === decodeURIComponent(m[1]))) {
      const id = decodeURIComponent(m[1]);
      reads.push({
        id,
        turnLimit: Number(url.searchParams.get("turnLimit")),
        reasoningMessages: url.searchParams.get("reasoningMessages"),
      });
      return json(200, {
        snapshotSequence: state.shell.snapshotSequence,
        thread: detail(id),
        page: { beforeCursor: null, hasMore: false },
      });
    }
    json(404, {});
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url, "http://x").pathname !== "/ws" || !authorized(req)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => serve(ws));
  });

  /**
   * Upsert a thread into the shell and stream it, as T3 Code does after a
   * command. `held`: the shell has it, but the stream item is returned
   * instead, to `stream` later, as when a fetch is ahead of the stream.
   */
  function upsertThread(t, { held = false } = {}) {
    state.shell.snapshotSequence++;
    const i = state.shell.threads.findIndex((x) => x.id === t.id);
    if (i === -1) state.shell.threads.push(t);
    else state.shell.threads[i] = t;
    const item = { kind: "thread-upserted", sequence: state.shell.snapshotSequence, thread: t };
    if (held) return item;
    stream(item);
  }
  function upsertProject(p) {
    state.shell.snapshotSequence++;
    state.shell.projects.push(p);
    stream({ kind: "project-upserted", sequence: state.shell.snapshotSequence, project: p });
  }
  function stream(item) {
    for (const s of subscribers) s.push(item);
  }
  const shellThread = (id) => state.shell.threads.find((t) => t.id === id);

  /** What a command does to the state, as far as the tests look. */
  function apply(cmd) {
    const t = shellThread(cmd.threadId);
    const turns = state.turns[cmd.threadId];
    if (cmd.type === "project.create")
      upsertProject({
        id: cmd.projectId,
        title: cmd.title,
        workspaceRoot: cmd.workspaceRoot,
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
      });
    else if (cmd.type === "thread.create") {
      const { type: _type, commandId: _id, threadId, ...fields } = cmd;
      state.turns[threadId] = { messages: [], activities: [] };
      upsertThread(thread({ id: threadId, ...fields, updatedAt: cmd.createdAt }));
    } else if (cmd.type === "thread.turn.start") {
      turns.messages.push({
        id: cmd.message.messageId,
        role: "user",
        text: cmd.message.text,
        turnId: null,
        streaming: false,
        createdAt: cmd.createdAt,
      });
      upsertThread({ ...t, latestTurn: { turnId: cmd.commandId, state: "running" }, session: { ...(t.session ?? {}), status: "running" } });
    } else if (cmd.type === "thread.turn.interrupt")
      upsertThread({ ...t, latestTurn: { ...t.latestTurn, state: "interrupted" }, session: { ...t.session, status: "interrupted" } });
    else if (cmd.type === "thread.approval.respond") {
      turns.activities.push({
        id: cmd.commandId,
        kind: "approval.resolved",
        tone: "approval",
        summary: "Approval resolved",
        payload: { requestId: cmd.requestId, decision: cmd.decision },
        createdAt: cmd.createdAt,
      });
      upsertThread({ ...t, hasPendingApprovals: false });
    } else if (cmd.type === "thread.user-input.respond") {
      turns.activities.push({
        id: cmd.commandId,
        kind: "user-input.resolved",
        tone: "info",
        summary: "User input submitted",
        payload: { requestId: cmd.requestId, answers: cmd.answers },
        createdAt: cmd.createdAt,
      });
      upsertThread({ ...t, hasPendingUserInput: false });
    } else if (cmd.type === "thread.meta.update") upsertThread({ ...t, modelSelection: cmd.modelSelection ?? t.modelSelection });
  }

  const METHODS = {
    "server.getConfig": () => ({
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
      settings: { defaultModelSelection: null, defaultRuntimeMode: "approval-required" },
    }),
    "orchestration.dispatchCommand": (cmd) => {
      dispatched.push(cmd);
      handlers[cmd.type]?.(cmd);
      apply(cmd);
      return { sequence: state.shell.snapshotSequence };
    },
    "vcs.createWorktree": (p) => ({
      worktree: { path: `/home/dev/.t3/worktrees/${p.cwd.split("/").pop()}/${p.newRefName.replace(/\//g, "-")}`, refName: p.newRefName },
    }),
  };

  function serve(ws) {
    const send = (msg) => ws.send(JSON.stringify(msg));
    const fail = (requestId, message) =>
      send({
        _tag: "Exit",
        requestId,
        exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: { _tag: "OrchestrationDispatchCommandError", message } }] },
      });
    let sub = null;
    ws.on("message", (data) => {
      const msg = JSON.parse(String(data));
      if (msg._tag === "Ping") return send({ _tag: "Pong" });
      if (msg._tag === "Ack") {
        acks++;
        sub?.acked();
        return;
      }
      if (msg._tag === "Interrupt") {
        if (sub && sub.id === msg.requestId) subscribers.delete(sub);
        return send({ _tag: "Exit", requestId: msg.requestId, exit: { _tag: "Failure", cause: [{ _tag: "Interrupt" }] } });
      }
      if (msg._tag !== "Request") return;
      if (msg.tag === "orchestration.subscribeShell") {
        // Chunks wait for the last one's Ack, as Effect RPC's do.
        const queue = [{ kind: "snapshot", snapshot: state.shell }, { kind: "synchronized" }];
        let waiting = false;
        const flush = () => {
          if (waiting || !queue.length) return;
          waiting = true;
          send({ _tag: "Chunk", requestId: msg.id, values: [queue.shift()] });
        };
        sub = {
          id: msg.id,
          push: (item) => {
            queue.push(structuredClone(item));
            flush();
          },
          acked: () => {
            waiting = false;
            flush();
          },
        };
        subscribers.add(sub);
        flush();
        return;
      }
      try {
        const handler = handlers[msg.tag] ?? METHODS[msg.tag];
        if (!handler)
          return send({
            _tag: "Exit",
            requestId: msg.id,
            exit: { _tag: "Failure", cause: [{ _tag: "Die", defect: `Unknown request tag: ${msg.tag}` }] },
          });
        send({ _tag: "Exit", requestId: msg.id, exit: { _tag: "Success", value: handler(msg.payload) } });
      } catch (err) {
        fail(msg.id, err.message);
      }
    });
    ws.on("close", () => sub && subscribers.delete(sub));
  }

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    state,
    reads,
    get acks() {
      return acks;
    },
    commands: (type) => dispatched.filter((c) => !type || c.type === type),
    upsertThread,
    stream,
    /** Drop every client, as a restarting server would. */
    drop: () => {
      for (const ws of wss.clients) ws.terminate();
    },
    close: () =>
      new Promise((resolve) => {
        for (const ws of wss.clients) ws.terminate();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
