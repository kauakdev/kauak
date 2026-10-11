// One T3 Code server, shown in the office as one floor: the bridge's T3 Code
// adapter, which implements the Runtime port (ports/runtime.ts) as the Herdr
// adapter does. The core and the enrichers ask a T3Floor for what they need
// in Kauak terms; this file turns that into requests to the server, and t3.ts
// turns the server's answers into the Kauak protocol (@kauak/protocol).
//
// The server (T3 Code 0.0.45, orchestration protocol 1) is reached on this
// machine at its URL, with a bearer token it issued (`t3 auth session issue`):
//   - /.well-known/t3/environment, unauthenticated, says its version and protocol;
//   - one WebSocket (rpc.ts) carries `orchestration.subscribeShell`, which
//     streams the projects and threads and every change to them, and the
//     commands (`orchestration.dispatchCommand`);
//   - a thread's messages and activities come over HTTP, its latest turns
//     only: when the shell says the thread changed (for its status, its
//     request and its context meter), and when a page reads it.
//
// A thread has no terminal: the page's mirror shows a transcript drawn from
// those turns (t3.ts), and what is typed in the message box is kept here
// until Enter sends it as a message.

import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { MachineInfo, PaneRequest, RequestAnswer, RoomSpec, Snapshot } from "@kauak/protocol";
import type { BridgeConfig } from "../../config.ts";
import type { AgentSession, MachineConfig, Runtime } from "../../ports/runtime.ts";
import { RpcSocket, type RpcStream } from "./rpc.ts";
import {
  PROTOCOL,
  ROUTES,
  RPC,
  RUNTIME,
  SCREEN_ROWS,
  type T3Config,
  type T3Environment,
  type T3Shell,
  type T3ShellItem,
  type T3Thread,
  type T3ThreadDetail,
  type T3ThreadShell,
  agentKind,
  answersOf,
  applyShell,
  approvalRespond,
  decisionOf,
  featuresOf,
  interrupt,
  modelFor,
  projectCreate,
  requestOf,
  roomsOf,
  runtimeModeOf,
  shown,
  statusOf,
  threadCreate,
  threadModel,
  toSnapshot,
  transcript,
  turnStart,
  userInputRespond,
  worktreeOf,
} from "./t3.ts";

const RETRY_MS = [2000, 4000, 8000, 15_000, 30_000];
const HTTP_TIMEOUT_MS = 10_000;
const SNAPSHOT_DEBOUNCE_MS = 60;
// A thread's turns are fetched again this long after the shell says it changed, so a burst is one fetch.
const DETAIL_DEBOUNCE_MS = 150;
// Turns fetched for a desk's status, request and context meter, and for its transcript.
const SUMMARY_TURNS = 1;
const READ_TURNS = 4;
// The panel reads a desk every 400 ms; its transcript is fetched at most this often.
const READ_FRESH_MS = 1000;
// A desk read this recently keeps its transcript's turns when it is fetched for its status.
const READING_MS = 5000;
// Threads whose turns are fetched at once, when the floor connects.
const FETCH_CONCURRENCY = 4;
// How long a new thread or project may take to show up in the shell.
const CREATED_WAIT_MS = 5000;

interface Detail {
  thread: T3Thread;
  more: boolean;
  turns: number;
  at: number;
}

/** The bridge-wide settings a T3Floor uses (config.ts): where floors' tokens are kept. */
export type T3Settings = Pick<BridgeConfig, "tokenDir">;

/**
 * Emits "status" when `state`/`message` change, and "snapshot" with a fresh
 * Kauak snapshot whenever what the office shows changes.
 * `state`: "connecting" → "live" ⇄ "down" (retries with backoff while down).
 */
export class T3Floor extends EventEmitter implements Runtime {
  id: string;
  label: string;
  readonly ssh = null;
  url: string;
  tokenFile: string;
  state: MachineInfo["state"] = "connecting";
  message = "";
  env: T3Environment | null = null;
  server: T3Config | null = null;
  shell: T3Shell | null = null;
  details = new Map<string, Detail>();
  snapshot: Snapshot | null = null;
  /** What was last emitted, to leave out snapshots that change nothing. */
  sent = "";
  socket: RpcSocket | null = null;
  sub: RpcStream | null = null;
  /** Text typed into each desk's message box, until Enter sends it. */
  drafts = new Map<string, string>();
  fetching = new Map<string, Promise<Detail>>();
  detailTimers = new Map<string, NodeJS.Timeout>();
  readAt = new Map<string, number>();
  retryTimer: NodeJS.Timeout | null = null;
  emitTimer: NodeJS.Timeout | null = null;
  refreshTimer: NodeJS.Timeout | null = null;
  attempt = 0;
  stopped = false;

  constructor({ id, label, url, token }: MachineConfig, settings: T3Settings) {
    super();
    this.id = id;
    this.label = label;
    this.url = new URL(url ?? "http://127.0.0.1:3773").origin;
    this.tokenFile = path.join(settings.tokenDir, `${id}.token`);
    if (token) saveToken(this.tokenFile, settings.tokenDir, token);
  }

  get info(): MachineInfo {
    return {
      id: this.id,
      label: this.label,
      ssh: null,
      state: this.state,
      message: this.message,
      runtime: { name: RUNTIME, version: this.env?.serverVersion ?? null, features: featuresOf(this.server) },
    };
  }

  /** What machines.json saves: never the token, which has its own file. */
  get config(): MachineConfig {
    return { id: this.id, label: this.label, runtime: "t3", url: this.url };
  }

  start() {
    this.connect();
  }

  stop() {
    this.stopped = true;
    for (const t of [this.retryTimer, this.emitTimer, this.refreshTimer, ...this.detailTimers.values()]) clearTimeout(t as NodeJS.Timeout);
    this.sub?.close();
    this.socket?.close();
  }

  /** The token is the floor's alone: removing the floor deletes it. */
  forget() {
    this.stop();
    try {
      fs.unlinkSync(this.tokenFile);
    } catch {}
  }

  // ------------------------------------------------------------ lifecycle

  async connect() {
    this.retryTimer = null;
    if (this.stopped) return;
    try {
      const token = readToken(this.tokenFile);
      this.env = await this.get<T3Environment>(ROUTES.environment, null);
      const protocol = this.env.orchestrationProtocolVersion;
      if (protocol !== PROTOCOL)
        throw new Error(`${RUNTIME} ${this.env.serverVersion ?? ""} speaks protocol ${protocol ?? "?"}; this Kauak speaks ${PROTOCOL}`);
      const socket = await RpcSocket.open(this.url, token);
      if (this.stopped) return socket.close();
      this.socket = socket;
      socket.on("close", (why: string) => {
        if (this.socket === socket) this.fail(why);
      });
      this.server = await socket.request<T3Config>(RPC.config, {});
      this.subscribe(socket);
    } catch (err) {
      this.fail((err as Error).message);
    }
  }

  subscribe(socket: RpcSocket) {
    const sub = socket.stream(RPC.subscribeShell, {}, (items) => {
      for (const item of items as T3ShellItem[]) this.apply(item);
    });
    this.sub = sub;
    sub.done.then(
      () => this.sub === sub && this.fail(`${RUNTIME} ended the subscription`),
      (err: Error) => this.sub === sub && this.fail(err.message),
    );
  }

  /** One item of the shell stream: the first is the whole shell, then each change. */
  apply(item: T3ShellItem) {
    const first = item.kind === "snapshot";
    const { shell, changed } = applyShell(this.shell, item);
    if (!changed) return;
    this.shell = shell;
    if (first) {
      this.attempt = 0;
      this.setState("live");
      this.fetchAll();
    } else if (item.kind === "thread-upserted") {
      // A thread put away (settled, archived) is no desk any more: its turns go.
      if (shown(item.thread)) this.scheduleDetail(item.thread.id);
      else this.details.delete(item.thread.id);
    } else if (item.kind === "thread-removed") this.details.delete(item.threadId);
    this.scheduleEmit();
  }

  /** Mark the floor down and retry. */
  fail(message: string) {
    if (this.stopped) return;
    const socket = this.socket;
    this.socket = null;
    this.sub = null;
    socket?.close();
    this.setState("down", message);
    if (this.retryTimer) return;
    const wait = RETRY_MS[Math.min(this.attempt++, RETRY_MS.length - 1)]!;
    console.warn(`[bridge] ${this.label}: ${message}; retrying in ${wait / 1000}s`);
    this.retryTimer = setTimeout(() => this.connect(), wait);
  }

  setState(state: MachineInfo["state"], message = "") {
    if (state === this.state && message === this.message) return;
    this.state = state;
    this.message = message;
    this.emit("status", this.info);
  }

  scheduleEmit() {
    this.emitTimer ??= setTimeout(() => {
      this.emitTimer = null;
      this.emitSnapshot();
    }, SNAPSHOT_DEBOUNCE_MS);
  }

  /** The shell and the turns fetched so far as a Kauak snapshot, emitted when it differs from the last. */
  emitSnapshot() {
    clearTimeout(this.emitTimer as NodeJS.Timeout);
    this.emitTimer = null;
    const threads = new Map([...this.details].map(([id, d]) => [id, d.thread]));
    const snapshot = toSnapshot(this.shell, threads, (instanceId) => agentKind(instanceId, this.server));
    const json = JSON.stringify(snapshot);
    if (json === this.sent && this.snapshot) return;
    this.sent = json;
    this.snapshot = snapshot;
    this.emit("snapshot", snapshot);
  }

  /** Fetch the shell now (it is the stream's too) and emit it: build mode waits on this for a new desk. */
  async refresh() {
    clearTimeout(this.refreshTimer as NodeJS.Timeout);
    const shell = await this.get<T3Shell>(ROUTES.shell);
    if (!this.shell || shell.snapshotSequence >= this.shell.snapshotSequence) this.shell = shell;
    this.emitSnapshot();
  }

  scheduleRefresh() {
    clearTimeout(this.refreshTimer as NodeJS.Timeout);
    this.refreshTimer = setTimeout(() => {
      this.refresh().catch((err) => console.error(`[bridge] ${this.label}: snapshot failed:`, err.message));
    }, SNAPSHOT_DEBOUNCE_MS);
  }

  // ------------------------------------------------------------ threads' turns

  /** On connecting: every desk's latest turn, a few at a time, for its request and context meter. */
  async fetchAll() {
    const ids = (this.shell?.threads ?? []).filter(shown).map((t) => t.id);
    const next = async (): Promise<void> => {
      const id = ids.shift();
      if (!id || this.stopped) return;
      await this.fetchDetail(id).catch(() => {});
      return next();
    };
    await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, next));
  }

  scheduleDetail(threadId: string) {
    clearTimeout(this.detailTimers.get(threadId));
    this.detailTimers.set(
      threadId,
      setTimeout(() => {
        this.detailTimers.delete(threadId);
        this.fetchDetail(threadId).catch((err) => console.error(`[bridge] ${this.label}: thread ${threadId}:`, err.message));
      }, DETAIL_DEBOUNCE_MS),
    );
  }

  /** The thread's latest turns: as many as its transcript shows while a page reads it, else one. One fetch at a time per thread. */
  fetchDetail(threadId: string, turns?: number): Promise<Detail> {
    const reading = Date.now() - (this.readAt.get(threadId) ?? 0) < READING_MS;
    const want = turns ?? (reading ? READ_TURNS : SUMMARY_TURNS);
    const running = this.fetching.get(threadId);
    if (running) return running.then((d) => (d.turns >= want ? d : this.fetchDetail(threadId, want)));
    const fetch = this.get<T3ThreadDetail>(ROUTES.thread(threadId, want))
      .then((res) => {
        const detail = { thread: res.thread, more: res.page?.hasMore === true, turns: want, at: Date.now() };
        if (this.shell?.threads.some((t) => t.id === threadId)) this.details.set(threadId, detail);
        this.scheduleEmit();
        return detail;
      })
      .finally(() => this.fetching.delete(threadId));
    this.fetching.set(threadId, fetch);
    return fetch;
  }

  // ------------------------------------------------------------ Kauak operations

  /** T3 Code's window shows whichever thread its user picks; nothing outside it can. */
  async focusPane(_paneId: string) {
    throw new Error(`${RUNTIME} has no way to show a thread from outside it.`);
  }

  /** The thread's transcript (t3.ts); with `lines`, its last `lines` rows, else the last screenful. */
  async readPane(paneId: string, lines: number | null = null): Promise<string> {
    this.thread(paneId);
    this.readAt.set(paneId, Date.now());
    const cached = this.details.get(paneId);
    const detail =
      cached && cached.turns >= READ_TURNS && Date.now() - cached.at < READ_FRESH_MS
        ? cached
        : await this.call(this.fetchDetail(paneId, READ_TURNS));
    const rows = transcript(detail.thread, detail.more);
    return rows.slice(-(lines ?? SCREEN_ROWS)).join("\r\n");
  }

  /**
   * Typed text waits in the desk's draft for Enter. What the message box
   * adds for a terminal goes: bracketed paste's markers, and the page keys
   * the mirror sends on a wheel turn.
   */
  async sendText(paneId: string, text: string) {
    this.thread(paneId);
    const typed = text
      .replace(/\x1b\[(?:200|201|5|6)~/g, "")
      .replace(/\r\n?/g, "\n")
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
    if (typed) this.drafts.set(paneId, (this.drafts.get(paneId) ?? "") + typed);
  }

  /**
   * Enter sends the draft as a message; Esc and Ctrl+C drop it and stop the
   * agent's turn, as they do in its own prompt; Backspace takes a character
   * off. The other keys mean nothing to a conversation.
   */
  async sendKeys(paneId: string, keys: string[]) {
    for (const key of keys) {
      const thread = this.thread(paneId);
      const draft = this.drafts.get(paneId) ?? "";
      if (key === "enter") {
        this.drafts.delete(paneId);
        if (draft.trim()) await this.dispatch(turnStart(thread, draft.trim()));
      } else if (key === "esc" || key === "ctrl+c") {
        this.drafts.delete(paneId);
        if (statusOf(thread) === "working") await this.dispatch(interrupt(thread));
      } else if (key === "backspace") this.drafts.set(paneId, [...draft].slice(0, -1).join(""));
    }
    this.scheduleDetail(paneId);
  }

  /** A new thread in the room, with no messages yet; `agent` picks its provider. */
  async createDesk(workspaceId: string, agent: string | null): Promise<string> {
    const room = roomsOf(this.shell).find((r) => r.id === workspaceId);
    if (!room) throw new Error("That room is gone.");
    return this.newThread(room, agent);
  }

  /**
   * A new room: the folder becomes a project unless one is already there,
   * and a worktree room is a new git worktree of it, on a new branch, in T3
   * Code's worktrees folder. Either way its first desk is a new thread.
   */
  async createRoom(spec: RoomSpec, agent: string | null): Promise<string> {
    if (!agent) throw new Error(noAgent());
    const folder = spec.cwd.replace(/(.)\/+$/, "$1");
    let project = this.shell?.projects.find((p) => p.workspaceRoot === folder);
    if (!project) {
      const { projectId, command } = projectCreate(folder, spec.label ?? (path.basename(folder) || folder));
      await this.dispatch(command);
      project = await this.waitFor(() => this.shell?.projects.find((p) => p.id === projectId));
    }
    if (spec.kind === "folder") return this.newThread({ project, branch: null, worktreePath: null }, agent);
    const res = await this.call(
      this.rpc().request<{ worktree: { path: string; refName: string } }>(
        RPC.createWorktree,
        worktreeOf(project.workspaceRoot, spec.branch, spec.base),
      ),
    );
    return this.newThread({ project, branch: res.worktree.refName, worktreePath: res.worktree.path }, agent);
  }

  async newThread(room: Parameters<typeof threadCreate>[0], agent: string | null): Promise<string> {
    if (!agent) throw new Error(noAgent());
    const model = modelFor(agent, room.project, this.shell, this.server);
    const { threadId, command } = threadCreate(room, model, runtimeModeOf(this.server));
    await this.dispatch(command);
    await this.waitFor(() => this.shell?.threads.find((t) => t.id === threadId));
    this.emitSnapshot();
    return threadId;
  }

  /** The thread already has an agent from createDesk; a different kind changes it while it has no messages. */
  async startAgent(kind: string, paneId: string) {
    const thread = this.thread(paneId);
    if (agentKind(thread.modelSelection.instanceId, this.server) === kind) return;
    const project = this.shell?.projects.find((p) => p.id === thread.projectId) ?? null;
    await this.dispatch(threadModel(paneId, modelFor(kind, project, this.shell, this.server)));
  }

  /** Answer the thread's open approval or question, checked against its latest turn. */
  async answer(paneId: string, requestId: string, answers: RequestAnswer[]) {
    this.thread(paneId);
    const detail = await this.call(this.fetchDetail(paneId, SUMMARY_TURNS));
    const request: PaneRequest | null = requestOf(detail.thread.activities);
    if (!request || request.id !== requestId) throw new Error("That was already answered.");
    await this.dispatch(
      request.kind === "approval"
        ? approvalRespond(paneId, requestId, decisionOf(request, answers))
        : userInputRespond(paneId, requestId, answersOf(request, answers)),
    );
    this.scheduleDetail(paneId);
  }

  /** T3 Code runs its agents itself; nothing reports their transcripts or processes to the bridge, which gets context meters from the server. */
  paneSession(_paneId: string): AgentSession | null {
    return null;
  }

  async paneProcesses(_paneId: string): Promise<number[]> {
    return [];
  }

  // ------------------------------------------------------------ the server

  /** The desk's thread as the shell has it; rejects for one that is not shown. */
  thread(paneId: string): T3ThreadShell {
    const t = this.shell?.threads.find((x) => x.id === paneId);
    if (!t || !shown(t)) throw new Error(`pane ${paneId} not found`);
    return t;
  }

  rpc(): RpcSocket {
    if (!this.socket || this.state !== "live") throw new Error(`not connected to ${RUNTIME}${this.message ? `: ${this.message}` : ""}`);
    return this.socket;
  }

  async dispatch(command: object) {
    await this.call(this.rpc().request(RPC.dispatch, command));
  }

  /** A request whose failure is a message fit to show. */
  async call<T>(p: Promise<T>): Promise<T> {
    try {
      return await p;
    } catch (err) {
      throw new Error(errorMessage(err as Error));
    }
  }

  /** Resolves once `find` finds what a command made in the shell (the stream brings it, or a fetch). */
  async waitFor<T>(find: () => T | undefined): Promise<T> {
    for (const started = Date.now(); Date.now() - started < CREATED_WAIT_MS; ) {
      const found = find();
      if (found) return found;
      await new Promise((r) => setTimeout(r, 150));
      if (!find()) await this.refresh().catch(() => {});
    }
    throw new Error(`${RUNTIME} did not show it in time; check its window.`);
  }

  /** GET a path of the server, with the token unless `token` is null. */
  async get<T>(route: string, token: string | null = readToken(this.tokenFile)): Promise<T> {
    let res: Response;
    try {
      res = await fetch(new URL(route, this.url), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch (err) {
      const code = ((err as Error & { cause?: { code?: string } }).cause?.code ?? "") as string;
      throw new Error(code === "ECONNREFUSED" ? `${RUNTIME} is not running (ECONNREFUSED)` : `no reply from ${RUNTIME}`);
    }
    if (res.status === 401) throw new Error(`${RUNTIME} refused the token (401)`);
    if (!res.ok) throw new Error(`${RUNTIME} answered ${res.status}`);
    return (await res.json()) as T;
  }
}

function noAgent() {
  return `Pick an agent: each desk in ${RUNTIME} is an agent's thread.`;
}

/** T3 Code's errors carry a sentence already; the last line says what went wrong. */
function errorMessage(err: Error | null | undefined): string {
  const text = String(err?.message ?? err);
  return (
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() ?? text
  );
}

/** The token goes in a file only you can read, in a folder only you can open. */
function saveToken(file: string, dir: string, token: string) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  fs.writeFileSync(file, `${token.trim()}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function readToken(file: string): string {
  let token = "";
  try {
    token = fs.readFileSync(file, "utf8").trim();
  } catch {}
  if (!token) throw new Error(`no token for this floor (${file}); remove the floor and add it again`);
  return token;
}
