// T3 Code → Kauak: how T3 Code's orchestration API becomes the Kauak protocol
// (@kauak/protocol). floor.ts talks to the server and calls these on what
// comes back; nothing past the bridge sees a T3 field, command or error.
// Verified against T3 Code 0.0.45, orchestration protocol 1
// (packages/contracts/src/orchestration.ts in pingdotgg/t3code). Protocol 2,
// on T3 Code's main branch, renames the commands and reshapes threads; it
// would be another file like this one.
//
// A T3 Code server holds projects (a folder, usually a git repository) and
// threads (a conversation with one agent, in the project's folder or in a git
// worktree of it). In the office a room is one checkout, a project's folder or
// a worktree, and a desk is a thread. A thread has no terminal, so its screen
// is drawn here from its messages and activities.

import { randomUUID } from "node:crypto";
import {
  AGENT_KIND,
  type AgentStatus,
  type ContextUsage,
  type PaneRequest,
  type RequestAnswer,
  type RuntimeFeatures,
  type Snapshot,
} from "@kauak/protocol";

export const RUNTIME = "T3 Code";
/** The orchestration protocol this file speaks; the server says which it speaks at /.well-known/t3/environment. */
export const PROTOCOL = 1;
/** Columns the transcript is wrapped at; the terminal panel shrinks its font to fit them. */
export const WIDTH = 80;
/** Rows of a desk's "screen": the last rows of its transcript, with the rest as history above. */
export const SCREEN_ROWS = 40;

// The server's RPC methods and HTTP routes, as floor.ts uses them.
export const RPC = {
  config: "server.getConfig",
  subscribeShell: "orchestration.subscribeShell",
  dispatch: "orchestration.dispatchCommand",
  createWorktree: "vcs.createWorktree",
} as const;
export const ROUTES = {
  environment: "/.well-known/t3/environment",
  shell: "/api/orchestration/shell",
  thread: (id: string, turns: number) => `/api/orchestration/threads/${encodeURIComponent(id)}?turnLimit=${turns}&reasoningMessages=true`,
};

// ---------------------------------------------------------------- T3 Code's shapes
//
// What the bridge reads of the server's answers. They describe, they do not
// check: the functions below tolerate fields that are missing.

export interface T3Environment {
  serverVersion?: string;
  orchestrationProtocolVersion?: number;
}

export interface T3ModelSelection {
  instanceId: string;
  model: string;
  options?: unknown;
}

export interface T3Project {
  id: string;
  title: string;
  workspaceRoot: string;
  repositoryIdentity?: { canonicalKey?: string; name?: string } | null;
  defaultModelSelection?: T3ModelSelection | null;
}

export interface T3Session {
  status: string;
  providerName?: string | null;
  providerInstanceId?: string;
  lastError?: string | null;
}

export interface T3LatestTurn {
  turnId: string;
  state: string;
}

/** A thread as the shell stream has it: no messages, but whether it waits on you. */
export interface T3ThreadShell {
  id: string;
  projectId: string;
  title: string;
  modelSelection: T3ModelSelection;
  runtimeMode: string;
  interactionMode?: string;
  branch: string | null;
  worktreePath: string | null;
  latestTurn: T3LatestTurn | null;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
  deletedAt?: string | null;
  settledOverride?: string | null;
  session: T3Session | null;
  hasPendingApprovals?: boolean;
  hasPendingUserInput?: boolean;
  backgroundLiveness?: string | null;
}

export interface T3Message {
  id: string;
  role: string;
  text: string;
  streaming?: boolean;
  createdAt: string;
}

export interface T3Activity {
  id: string;
  tone: string;
  kind: string;
  summary: string;
  payload: unknown;
  createdAt: string;
  sequence?: number;
}

/** A thread with its latest turns: what `threads/:id` answers, as far as the bridge reads it. */
export interface T3Thread extends T3ThreadShell {
  messages: T3Message[];
  activities: T3Activity[];
}

export interface T3ThreadDetail {
  thread: T3Thread;
  page?: { hasMore?: boolean };
}

export interface T3Shell {
  snapshotSequence: number;
  projects: T3Project[];
  threads: T3ThreadShell[];
}

/** What `orchestration.subscribeShell` streams: the shell, then a marker, then changes, each numbered. */
export type T3ShellItem =
  | { kind: "snapshot"; snapshot: T3Shell }
  | { kind: "synchronized" }
  | { kind: "project-upserted"; sequence: number; project: T3Project }
  | { kind: "project-removed"; sequence: number; projectId: string }
  | { kind: "thread-upserted"; sequence: number; thread: T3ThreadShell }
  | { kind: "thread-removed"; sequence: number; threadId: string };

export interface T3Provider {
  instanceId: string;
  driver?: string;
  enabled?: boolean;
  models?: { slug: string; isDefault?: boolean }[];
}

/** What `server.getConfig` answers, as far as the bridge reads it. */
export interface T3Config {
  providers?: T3Provider[];
  settings?: { defaultModelSelection?: T3ModelSelection | null; defaultRuntimeMode?: string };
}

// ---------------------------------------------------------------- the shell

/**
 * The shell after one streamed item, and whether it changed. Items numbered
 * at or below what the shell already has are replays of what it holds.
 */
export function applyShell(shell: T3Shell | null, item: T3ShellItem): { shell: T3Shell | null; changed: boolean } {
  if (item.kind === "snapshot") return { shell: item.snapshot, changed: true };
  if (item.kind === "synchronized" || !shell || item.sequence <= shell.snapshotSequence) return { shell, changed: false };
  const next: T3Shell = { ...shell, snapshotSequence: item.sequence };
  if (item.kind === "project-upserted") next.projects = upsert(shell.projects, item.project);
  else if (item.kind === "project-removed") next.projects = shell.projects.filter((p) => p.id !== item.projectId);
  else if (item.kind === "thread-upserted") next.threads = upsert(shell.threads, item.thread);
  else if (item.kind === "thread-removed") next.threads = shell.threads.filter((t) => t.id !== item.threadId);
  return { shell: next, changed: true };
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  return i === -1 ? [...list, item] : list.map((x, j) => (j === i ? item : x));
}

/** Threads still in play: not archived, deleted or settled (T3 Code's "done with it"). Settled ones are history. */
export function shown(t: T3ThreadShell): boolean {
  return !t.archivedAt && !t.deletedAt && t.settledOverride !== "settled";
}

/** One room: a project's folder, or a worktree of it, with the threads in it. */
export interface Room {
  id: string;
  project: T3Project;
  worktreePath: string | null;
  branch: string | null;
  threads: T3ThreadShell[];
}

/**
 * Every project's folder is a room, with or without threads, so build mode
 * can add one to it; a worktree is a room while a thread is in it. Rooms
 * follow the server's order of projects, a project's folder before its
 * worktrees; desks keep the order their threads were made in.
 */
export function roomsOf(shell: T3Shell | null): Room[] {
  if (!shell) return [];
  const rooms: Room[] = [];
  for (const project of shell.projects) {
    const threads = shell.threads
      .filter((t) => t.projectId === project.id && shown(t))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    rooms.push({ id: project.id, project, worktreePath: null, branch: null, threads: threads.filter((t) => !t.worktreePath) });
    const trees = new Map<string, T3ThreadShell[]>();
    for (const t of threads) if (t.worktreePath) trees.set(t.worktreePath, [...(trees.get(t.worktreePath) ?? []), t]);
    for (const [worktreePath, list] of [...trees].sort(([a], [b]) => a.localeCompare(b)))
      rooms.push({ id: `${project.id}:${worktreePath}`, project, worktreePath, branch: list[0]!.branch, threads: list });
  }
  return rooms;
}

// ---------------------------------------------------------------- T3 Code → Kauak

/**
 * The shell, and each thread's latest turns where the bridge has fetched
 * them, as a Kauak Snapshot. `kindOf` names a thread's agent from its
 * provider instance (agentKind with the server's config). `git_root` starts
 * out null; the bridge's enrichers fill it in.
 */
export function toSnapshot(
  shell: T3Shell | null,
  details: ReadonlyMap<string, T3Thread>,
  kindOf: (instanceId: string) => string | null,
): Snapshot {
  const snapshot: Snapshot = { workspaces: [], panes: [] };
  roomsOf(shell).forEach((room, i) => {
    const { project, worktreePath } = room;
    const id = project.repositoryIdentity?.canonicalKey;
    snapshot.workspaces.push({
      workspace_id: room.id,
      number: i + 1,
      label: worktreePath ? (room.branch ?? basename(worktreePath)) : project.title,
      // T3 Code's window shows whichever thread its user opened; the server does not know.
      focused: false,
      repo: id
        ? {
            key: id,
            name: project.repositoryIdentity?.name ?? project.title,
            root: project.workspaceRoot,
            checkout: worktreePath ?? project.workspaceRoot,
            linked: worktreePath !== null,
          }
        : null,
      git_root: null,
    });
    for (const t of room.threads) {
      const detail = details.get(t.id);
      const status = statusOf(t);
      snapshot.panes.push({
        pane_id: t.id,
        workspace_id: room.id,
        focused: false,
        cwd: worktreePath ?? project.workspaceRoot,
        title: t.title,
        agent: kindOf(t.session?.providerInstanceId ?? t.modelSelection.instanceId),
        agent_status: status,
        screen: { rows: SCREEN_ROWS, cols: WIDTH, exact: true },
        scrollback: (detail?.messages.length ?? 0) > 0,
        context: detail ? contextOf(detail.activities) : null,
        // Only while the shell says the thread waits on you: its turns may be a fetch behind.
        request: status === "blocked" && detail ? requestOf(detail.activities) : null,
      });
    }
  });
  return snapshot;
}

/**
 * What the agent is up to. T3 Code has no "blocked": a thread waits on you
 * while it has an approval or a question open, or after its turn failed.
 * "done" is a finished turn in a thread you have not settled yet.
 */
export function statusOf(t: T3ThreadShell): AgentStatus {
  if (t.hasPendingApprovals || t.hasPendingUserInput) return "blocked";
  const session = t.session?.status;
  const turn = t.latestTurn?.state;
  if (session === "starting" || session === "running" || turn === "running" || t.backgroundLiveness === "working") return "working";
  if (session === "error" || turn === "error") return "blocked";
  if (turn === "completed") return "done";
  return "idle";
}

// Agent kinds are commands' names (AGENT_KIND); T3 Code's provider drivers mostly are too.
const KIND_OF_DRIVER: Record<string, string> = { claudeAgent: "claude" };
const DRIVER_OF_KIND: Record<string, string> = { claude: "claudeAgent" };

/** The agent kind of a provider instance: its driver's, through the server's config when it has the instance. */
export function agentKind(instanceId: string, config: T3Config | null): string | null {
  const driver = config?.providers?.find((p) => p.instanceId === instanceId)?.driver ?? instanceId;
  const kind = KIND_OF_DRIVER[driver] ?? driver.toLowerCase();
  return AGENT_KIND.test(kind) ? kind : null;
}

/** No focus or plain shells; build mode offers the agents T3 Code has enabled, Claude and Codex first. */
export function featuresOf(config: T3Config | null): RuntimeFeatures {
  const kinds = (config?.providers ?? []).filter((p) => p.enabled !== false).map((p) => agentKind(p.instanceId, config));
  const agents = [...new Set(kinds.filter((k): k is string => k !== null))];
  const rank = (k: string) => (k === "claude" ? 0 : k === "codex" ? 1 : 2);
  return { focus: false, shells: false, agent_kinds: config ? agents.sort((a, b) => rank(a) - rank(b)) : ["claude", "codex"] };
}

/** The context window as of the agent's last model call, from the latest `context-window.updated` activity. */
export function contextOf(activities: T3Activity[]): ContextUsage | null {
  for (let i = activities.length - 1; i >= 0; i--) {
    if (activities[i]!.kind !== "context-window.updated") continue;
    const p = activities[i]!.payload as { usedTokens?: unknown; maxTokens?: unknown } | null;
    return typeof p?.usedTokens === "number" && typeof p.maxTokens === "number" && p.maxTokens > 0
      ? { used: p.usedTokens, max: p.maxTokens }
      : null;
  }
  return null;
}

// ---------------------------------------------------------------- requests

interface Approval {
  requestId: string;
  requestKind: string;
  detail: string;
  options: { decision: string; label: string; warning?: string }[];
  createdAt: string;
}

interface Question {
  id: string;
  header: string;
  question: string;
  options: { label: string; description?: string; value?: string }[];
  multiSelect?: boolean;
  allowCustomAnswer?: boolean;
}

interface UserInput {
  requestId: string;
  questions: Question[];
  createdAt: string;
}

// What T3 Code's own clients offer when an approval names no options.
const APPROVAL_OPTIONS = [
  { decision: "accept", label: "Approve" },
  { decision: "acceptForSession", label: "Always allow this session" },
  { decision: "decline", label: "Decline" },
  { decision: "cancel", label: "Cancel" },
];
const APPROVAL_TITLES: Record<string, string> = {
  command: "Run a command",
  "file-read": "Read a file",
  "file-change": "Change files",
  "mcp-elicitation": "Answer a tool",
  permission: "Grant a permission",
};
// A reply the server could not deliver because the request is gone closes it too.
const STALE = /(stale|unknown) pending/i;

/**
 * The approvals and questions still open in these activities, oldest first,
 * as T3 Code's clients work them out (client-runtime/src/pendingRequests.ts):
 * a request is open from its `*.requested` until its `*.resolved`, or a
 * failed reply that says it no longer exists.
 */
export function pendingOf(activities: T3Activity[]): { approvals: Approval[]; questions: UserInput[] } {
  const approvals = new Map<string, Approval>();
  const questions = new Map<string, UserInput>();
  const closed = new Set<string>();
  for (const a of activities) {
    const p = (a.payload ?? {}) as Record<string, unknown>;
    const id = typeof p.requestId === "string" && p.requestId ? p.requestId : null;
    if (!id) continue;
    const detail = typeof p.detail === "string" ? p.detail : "";
    if (a.kind === "approval.requested") {
      if (closed.has(id) || p.requestType === "tool_user_input" || p.requestType === "auth_tokens_refresh") continue;
      const options = Array.isArray(p.options)
        ? p.options.filter((o) => typeof o?.decision === "string" && typeof o?.label === "string")
        : [];
      approvals.set(id, {
        requestId: id,
        requestKind: typeof p.requestKind === "string" ? p.requestKind : "command",
        detail: detail || (typeof p.appName === "string" ? p.appName : ""),
        options: options.length ? options : APPROVAL_OPTIONS,
        createdAt: a.createdAt,
      });
    } else if (a.kind === "user-input.requested") {
      if (closed.has(id) || !Array.isArray(p.questions)) continue;
      const list = p.questions.filter((q) => typeof q?.id === "string" && typeof q?.question === "string" && Array.isArray(q?.options));
      if (list.length) questions.set(id, { requestId: id, questions: list, createdAt: a.createdAt });
    } else if (
      a.kind === "approval.resolved" ||
      a.kind === "user-input.resolved" ||
      (a.kind.startsWith("provider.") && a.kind.endsWith(".respond.failed") && STALE.test(detail))
    ) {
      closed.add(id);
      approvals.delete(id);
      questions.delete(id);
    }
  }
  const byTime = (x: { createdAt: string }, y: { createdAt: string }) => x.createdAt.localeCompare(y.createdAt);
  return { approvals: [...approvals.values()].sort(byTime), questions: [...questions.values()].sort(byTime) };
}

/** The request the page shows: the oldest open approval, else the oldest open question. */
export function requestOf(activities: T3Activity[]): PaneRequest | null {
  const { approvals, questions } = pendingOf(activities);
  const a = approvals[0];
  if (a)
    return {
      id: a.requestId,
      kind: "approval",
      questions: [
        {
          id: a.requestId,
          title: APPROVAL_TITLES[a.requestKind] ?? "Allow this?",
          text: clean(a.detail),
          options: a.options.map((o) => ({ id: o.decision, label: clean(o.label), description: clean(o.warning ?? "") })),
          multiple: false,
          typed: false,
        },
      ],
    };
  const q = questions[0];
  if (!q) return null;
  return {
    id: q.requestId,
    kind: "question",
    questions: q.questions.map((x) => ({
      id: x.id,
      title: clean(typeof x.header === "string" ? x.header : ""),
      text: clean(x.question),
      // T3 Code answers with an option's value, else its label.
      options: x.options.map((o) => ({ id: o.value ?? o.label, label: clean(o.label), description: clean(o.description ?? "") })),
      multiple: x.multiSelect === true,
      typed: x.allowCustomAnswer !== false,
    })),
  };
}

/** An approval's answer: the decision picked, checked against the options. */
export function decisionOf(request: PaneRequest, answers: RequestAnswer[]): string {
  const question = request.questions[0]!;
  const picked = answers.find((a) => a.question_id === question.id)?.options[0];
  if (!picked || !question.options.some((o) => o.id === picked)) throw new Error("Pick one of the answers offered.");
  return picked;
}

/** A question's answers as T3 Code takes them: by question id, an option's id, several for a multiple choice, or the typed text. */
export function answersOf(request: PaneRequest, answers: RequestAnswer[]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const q of request.questions) {
    const a = answers.find((x) => x.question_id === q.id);
    const text = a?.text?.trim();
    const picked = (a?.options ?? []).filter((id) => q.options.some((o) => o.id === id));
    if (text && q.typed) out[q.id] = text;
    else if (picked.length) out[q.id] = q.multiple ? picked : picked[0]!;
    else throw new Error(`Answer "${q.title || q.text}" first.`);
  }
  return out;
}

// ---------------------------------------------------------------- the screen

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

/**
 * A thread's latest turns drawn as a terminal would show them: your
 * messages after a prompt sign, the agent's replies, its tools one line
 * each, what it asked and was answered, and at the bottom what it is doing
 * now. Rows of ANSI text, `width` columns at most, oldest first. Text from
 * the thread has its control characters taken out, so it cannot move the
 * mirror's cursor or change its modes.
 */
export function transcript(thread: T3Thread, more: boolean, width = WIDTH): string[] {
  const rows: string[] = [];
  if (more) rows.push(`${DIM}… earlier turns are in T3 Code${RESET}`, "");
  const tools = toolLines(thread.activities);
  const entries: { at: string; order: number; draw(): string[] }[] = [];
  for (const [i, m] of thread.messages.entries()) entries.push({ at: m.createdAt, order: i, draw: () => message(m, width) });
  for (const [i, a] of thread.activities.entries()) {
    const draw = activity(a, tools, width);
    if (draw) entries.push({ at: a.createdAt, order: thread.messages.length + i, draw });
  }
  entries.sort((x, y) => x.at.localeCompare(y.at) || x.order - y.order);
  for (const e of entries) rows.push(...e.draw());
  rows.push(...footer(thread, width));
  // No blank rows at the top or two in a row: the mirror shows every one.
  return rows.filter((r, i) => r !== "" || (i > 0 && rows[i - 1] !== ""));
}

function message(m: T3Message, width: number): string[] {
  const text = clean(m.text).trim();
  if (m.role === "reasoning" || (!text && !m.streaming)) return [];
  if (m.role === "user") {
    const lines = wrap(text, width - 2);
    return ["", ...lines.map((l, i) => (i === 0 ? `${BOLD}${CYAN}❯${RESET} ${BOLD}${l}${RESET}` : `  ${BOLD}${l}${RESET}`)), ""];
  }
  const lines = wrap(text, width);
  if (m.role === "system") return lines.map((l) => `${DIM}${l}${RESET}`);
  if (m.streaming) lines.push(`${(lines.pop() ?? "").trimEnd()}${DIM}▍${RESET}`);
  // A blank row on either side sets a reply apart from the tool rows around it.
  return ["", ...lines, ""];
}

/**
 * Each tool call once: at its completion, else at its latest update (still
 * running). An update can come in after the completion, and does not undo it.
 */
function toolLines(activities: T3Activity[]): Map<string, T3Activity> {
  const last = new Map<string, T3Activity>();
  for (const a of activities) {
    const id = (a.payload as { toolCallId?: unknown } | null)?.toolCallId;
    if (a.tone !== "tool" || typeof id !== "string" || !a.kind.startsWith("tool.")) continue;
    if (last.get(id)?.kind !== "tool.completed") last.set(id, a);
  }
  return last;
}

// Tools other than a shell show their input as JSON ("Write: {"file_path":…"); the field that says what it is about reads better.
const TOOL_INPUT = /^([\w.-]+): \{.*?"(file_path|path|notebook_path|command|pattern|url|query|description|prompt)":"((?:[^"\\]|\\.)*)/;

/** A tool's one line: its name and what it was run on. */
function toolText(detail: string): string {
  const line = firstLine(detail);
  const m = TOOL_INPUT.exec(line);
  if (!m) return line;
  let value = m[3]!;
  try {
    value = JSON.parse(`"${value}"`);
  } catch {}
  return `${m[1]}: ${firstLine(value)}`;
}

function activity(a: T3Activity, tools: Map<string, T3Activity>, width: number): (() => string[]) | null {
  const p = (a.payload ?? {}) as Record<string, unknown>;
  const detail = typeof p.detail === "string" ? clean(p.detail) : "";
  if (a.tone === "tool" && a.kind.startsWith("tool.")) {
    if (tools.get(String(p.toolCallId)) !== a) return null;
    const running = a.kind !== "tool.completed";
    const text = toolText(detail || clean(a.summary));
    return () => [clip(`  ${running ? YELLOW : DIM}⏺${RESET} ${DIM}${text}${running ? " …" : ""}${RESET}`, width)];
  }
  if (a.kind === "approval.requested") return () => [clip(`  ${YELLOW}? ${firstLine(detail || clean(a.summary))}${RESET}`, width)];
  if (a.kind === "approval.resolved")
    return () => [clip(`  ${DIM}↳ ${typeof p.decision === "string" ? p.decision : "answered"}${RESET}`, width)];
  const questions: { question?: unknown }[] = Array.isArray(p.questions) ? p.questions : [];
  if (a.kind === "user-input.requested")
    return () =>
      questions.flatMap((q) => wrap(clean(String(q?.question ?? "")), width - 4).map((l, i) => `  ${YELLOW}${i ? " " : "?"} ${l}${RESET}`));
  if (a.kind === "user-input.resolved" && p.answers && typeof p.answers === "object")
    return () =>
      Object.values(p.answers as Record<string, unknown>).map((v) =>
        clip(`  ${DIM}↳ ${clean(Array.isArray(v) ? v.join(", ") : String(v))}${RESET}`, width),
      );
  if (a.tone === "error")
    return () => wrap(`✗ ${clean(a.summary)}${detail ? `: ${detail}` : ""}`, width - 2).map((l) => `  ${RED}${l}${RESET}`);
  return null;
}

function footer(thread: T3Thread, width: number): string[] {
  const status = statusOf(thread);
  const request = status === "blocked" ? requestOf(thread.activities) : null;
  if (request)
    return [
      "",
      `${BOLD}${YELLOW}⚠ ${request.kind === "approval" ? "Waiting for your approval" : "Waiting for your answer"}: the buttons below answer it.${RESET}`,
    ];
  const error = thread.session?.lastError;
  if (status === "blocked" && error) return ["", ...wrap(`✗ ${clean(error)}`, width).map((l) => `${RED}${l}${RESET}`)];
  if (status === "working") return [`${DIM}… working${RESET}`];
  return [];
}

// C0 and C1 controls but newline and tab, and DEL: an agent's text must not drive the terminal it is shown in.
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/** Text from the server, safe to put on a terminal screen. */
function clean(s: string): string {
  return String(s).replace(/\r\n?/g, "\n").replace(/\t/g, "  ").replace(CONTROLS, "");
}

function firstLine(s: string): string {
  return (
    s
      .split("\n")
      .find((l) => l.trim())
      ?.trim() ?? ""
  );
}

/** One row cut to `width` columns, ending in "…" when it was longer; its color escapes take none. */
function clip(row: string, width: number): string {
  const parts = row.split(/(\x1b\[[0-9;]*m)/);
  const cols = parts.reduce((n, part, i) => n + (i % 2 ? 0 : [...part].length), 0);
  if (cols <= width) return row;
  let left = width - 1;
  let out = "";
  parts.forEach((part, i) => {
    if (i % 2) out += part;
    else {
      const chars = [...part].slice(0, Math.max(0, left));
      left -= chars.length;
      out += chars.join("");
    }
  });
  return `${out.replace(/(\x1b\[[0-9;]*m)+$/, "")}…${RESET}`;
}

/** Paragraphs wrapped at word boundaries to `width` columns; a word longer than that is cut. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (!para.trim()) {
      out.push("");
      continue;
    }
    const indent = /^\s*/.exec(para)![0].slice(0, width / 2);
    let line = "";
    for (const word of para.trim().split(/ +/)) {
      for (let w = word; w; ) {
        const room = width - (line ? line.length + 1 : indent.length);
        if (w.length <= room) {
          line = line ? `${line} ${w}` : indent + w;
          w = "";
        } else if (line) {
          out.push(line);
          line = "";
        } else {
          out.push(indent + w.slice(0, room));
          w = w.slice(room);
        }
      }
    }
    if (line) out.push(line);
  }
  return out;
}

function basename(p: string): string {
  return p.replace(/\/+$/, "").split("/").pop() || p;
}

// ---------------------------------------------------------------- Kauak → T3 Code

/** Fields every command carries: its id and when it was made. */
function stamp() {
  return { commandId: randomUUID(), createdAt: new Date().toISOString() };
}

/** Send a message in the thread: a new turn, in the thread's own modes and model. */
export function turnStart(thread: T3ThreadShell, text: string) {
  return {
    type: "thread.turn.start",
    ...stamp(),
    threadId: thread.id,
    message: { messageId: randomUUID(), role: "user", text, attachments: [] },
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode ?? "default",
  };
}

/** Stop the turn the agent is on. */
export function interrupt(thread: T3ThreadShell) {
  return {
    type: "thread.turn.interrupt",
    ...stamp(),
    threadId: thread.id,
    ...(thread.latestTurn?.state === "running" ? { turnId: thread.latestTurn.turnId } : {}),
  };
}

export function approvalRespond(threadId: string, requestId: string, decision: string) {
  return { type: "thread.approval.respond", ...stamp(), threadId, requestId, decision };
}

export function userInputRespond(threadId: string, requestId: string, answers: Record<string, string | string[]>) {
  return { type: "thread.user-input.respond", ...stamp(), threadId, requestId, answers };
}

/** A thread in a room, with no messages yet: a desk waiting for its first one. */
export function threadCreate(
  room: { project: T3Project; branch: string | null; worktreePath: string | null },
  model: T3ModelSelection,
  runtimeMode: string,
) {
  const threadId = randomUUID();
  return {
    threadId,
    command: {
      type: "thread.create",
      ...stamp(),
      threadId,
      projectId: room.project.id,
      title: "New thread",
      modelSelection: model,
      runtimeMode,
      interactionMode: "default",
      branch: room.branch,
      worktreePath: room.worktreePath,
    },
  };
}

/** Change the thread's agent, before its first message. */
export function threadModel(threadId: string, model: T3ModelSelection) {
  return { type: "thread.meta.update", ...stamp(), threadId, modelSelection: model };
}

export function projectCreate(workspaceRoot: string, title: string) {
  const projectId = randomUUID();
  return { projectId, command: { type: "project.create", ...stamp(), projectId, title, workspaceRoot } };
}

/** `vcs.createWorktree`: a new branch `branch` off `base` (HEAD without one), in T3 Code's worktrees folder. */
export function worktreeOf(cwd: string, branch: string, base: string | undefined) {
  return { cwd, refName: base ?? "HEAD", newRefName: branch, ...(base ? { baseRefName: base } : {}), path: null };
}

/**
 * The model a new thread of `kind` gets: the one its provider's latest
 * thread used, else the user's default, else the project's, else the
 * provider's own default. Rejects when T3 Code has no such agent enabled.
 */
export function modelFor(kind: string, project: T3Project | null, shell: T3Shell | null, config: T3Config | null): T3ModelSelection {
  const providers = (config?.providers ?? []).filter((p) => p.enabled !== false && agentKind(p.instanceId, config) === kind);
  const provider = providers.find((p) => p.instanceId === (DRIVER_OF_KIND[kind] ?? kind)) ?? providers[0];
  if (!provider) throw new Error(`${kind} is not enabled in ${RUNTIME}.`);
  const latest = [...(shell?.threads ?? [])]
    .filter((t) => t.modelSelection.instanceId === provider.instanceId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  for (const m of [latest?.modelSelection, config?.settings?.defaultModelSelection, project?.defaultModelSelection])
    if (m?.instanceId === provider.instanceId && m.model) return m;
  const model = provider.models?.find((m) => m.isDefault)?.slug ?? provider.models?.[0]?.slug;
  if (!model) throw new Error(`${RUNTIME} lists no model for ${kind}.`);
  return { instanceId: provider.instanceId, model };
}

/** The approval mode new threads start in: the user's default in T3 Code, else asking before anything. */
export function runtimeModeOf(config: T3Config | null): string {
  return config?.settings?.defaultRuntimeMode ?? "approval-required";
}
