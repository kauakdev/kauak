// The Kauak protocol: what the bridge and the office page say to each other
// over the WebSocket. These are its types, and the rules the bridge checks
// every message from a page against; docs/protocol.md is the reference.
//
// Every message from a page goes through parseClientMessage before the bridge
// acts on it; a message that is not one of these shapes is dropped. Rules that
// deserve an answer (an SSH target or a branch name typed in a form) are only
// exported here: the bridge checks them itself and replies with what is wrong.
//
// Nothing here belongs to the runtime behind a floor. The bridge's Herdr
// adapter (machine.ts, herdr.ts) turns Herdr's API into these shapes, and the
// page (web/src) and its simulated bridge (web/src/demo.ts) only know them.
// Both sides load this file, so it imports nothing: no Node, no DOM.

// ---------------------------------------------------------------- floors

/** What an agent is up to. A pane without an agent is "unknown". */
export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/** One machine, shown as one floor of the office. */
export interface MachineInfo {
  id: string;
  label: string;
  /** SSH destination for a remote machine, null for this one. */
  ssh: string | null;
  state: "connecting" | "live" | "down";
  /** Why it is connecting or down, in a few words fit to show. */
  message: string;
  /** What runs the machine's terminals and agents; `version` is known once connected. */
  runtime: { name: string; version: string | null };
}

/** Everything on one floor right now. A new one replaces the last. */
export interface Snapshot {
  /** In the runtime's own order. */
  workspaces: WorkspaceInfo[];
  panes: PaneInfo[];
}

/** A workspace: one room of the office. Ids are only unique on their floor. */
export interface WorkspaceInfo {
  workspace_id: string;
  /** 1 for the runtime's first workspace. */
  number: number;
  label: string;
  /** The workspace the runtime is showing. */
  focused: boolean;
  /** The git repository the runtime opened it in, when it knows. */
  repo: RepoInfo | null;
  /** The git checkout its folder is in, found by the bridge whether or not the runtime knows: its printer's (bridge/diffs.ts). */
  git_root: string | null;
}

export interface RepoInfo {
  /** The same for every checkout of one repository; rooms are grouped into wings by it. */
  key: string;
  name: string;
  /** The repository's main checkout. */
  root: string;
  /** The workspace's checkout: `root`, or a linked worktree's folder. */
  checkout: string;
  /** The checkout is a linked worktree (`git worktree add`). */
  linked: boolean;
}

/** A terminal pane: one desk. An agent may sit there. */
export interface PaneInfo {
  pane_id: string;
  workspace_id: string;
  /** The pane the runtime has focused; at most one per floor. */
  focused: boolean;
  /** The folder its program works in (the foreground process's, else the shell's). */
  cwd: string | null;
  /** The terminal's title, without the status glyph agents put in front. */
  title: string;
  /** The agent running in it, by its command's name ("claude", "codex"...), or null for a plain shell. */
  agent: string | null;
  agent_status: AgentStatus;
  /** Its screen in cells, when known. `rows` is its real height. `cols` is its real width when `exact`; otherwise a width the mirror should not go below (or null). */
  screen: { rows: number; cols: number | null; exact: boolean } | null;
  /** There is history above the screen to read. */
  scrollback: boolean;
  /** How full the agent's context window is, when the bridge could read it (bridge/context.ts). */
  context: ContextUsage | null;
}

/** Tokens in the agent's context window as of its last model call, and the window's size. */
export interface ContextUsage {
  used: number;
  max: number;
}

// ---------------------------------------------------------------- printers

/** What changed in one file of a room's git checkout (bridge/diffs.ts). */
export interface FileDiff {
  /** Relative to the checkout. */
  path: string;
  change: "added" | "modified" | "deleted" | "renamed";
  /** Where a renamed file was. */
  from?: string;
  /** Not known to git yet (the uncommitted view only). */
  untracked?: boolean;
  added: number;
  removed: number;
  /** Unified hunks: "@@ -12,6 +12,7 @@" headers, then " ", "-" and "+" rows. Empty with a `note`. */
  diff: string;
  /** Rows were left off the end. */
  truncated: boolean;
  /** Why there is no diff (a binary or very large file). */
  note?: string;
}

/** One edit to a file: a sheet out of the room's printer. */
export interface DiffSheet extends FileDiff {
  id: string;
  /** The checkout it happened in; rooms find it by their `git_root`. */
  root: string;
  /** ms since epoch. */
  at: number;
}

/** Everything not committed in a checkout: its diff against HEAD and the untracked files, by path. */
export interface Uncommitted {
  files: FileDiff[];
  /** There was more than fits in one printout. */
  incomplete: boolean;
  error?: string;
}

// ---------------------------------------------------------------- input

/** An entry of the message box's "/" menu. `source`: "built-in", "project", "user", or a plugin's name. */
export interface SlashCommand {
  name: string;
  description: string;
  hint?: string;
  aliases?: string[];
  source: string;
}

/** One unit of terminal input: literal text, or named keys (`KEY` below: "enter", "esc", "ctrl+c"...). */
export type InputOp = { text: string } | { keys: string[] };

/** A new room from build mode: a git worktree on a new branch, or a workspace in a folder. */
export type RoomSpec =
  | { kind: "worktree"; cwd: string; branch: string; base?: string; label?: string }
  | { kind: "folder"; cwd: string; label?: string };

// ---------------------------------------------------------------- messages

/** Bridge → page. Every message about a floor names it in `machine`; pane, workspace and root ids are that floor's. */
export type BridgeMessage =
  | { type: "machines"; machines: MachineInfo[] }
  | { type: "machine_added"; machine: string }
  | { type: "machine_error"; message: string }
  | { type: "snapshot"; machine: string; snapshot: Snapshot }
  /** Every sheet a floor's printers hold, on connecting. */
  | { type: "prints"; machine: string; sheets: DiffSheet[] }
  | { type: "print"; machine: string; sheet: DiffSheet }
  | ({ type: "uncommitted"; machine: string; root: string; id?: number } & Uncommitted)
  | { type: "pane_output"; machine: string; pane_id: string; text: string; seq?: number }
  | { type: "input_ack"; machine: string; pane_id: string; id?: number }
  | { type: "commands"; machine: string; pane_id: string; agent: string | null; commands: SlashCommand[] }
  | { type: "created"; machine: string; id?: number; pane_id: string }
  /** A create request failed; `pane_id` is set when the desk exists but its agent did not start. */
  | { type: "create_error"; machine: string; id?: number; pane_id?: string; message: string }
  | { type: "error"; machine?: string; pane_id?: string; id?: number; message: string };

/** Page → bridge, as parseClientMessage returns them. */
export type ClientMessage =
  | { type: "add_machine"; ssh: string; label: string }
  | { type: "remove_machine"; machine: string }
  | { type: "refresh"; machine: string }
  | { type: "focus"; machine: string; pane_id: string }
  /** The pane's screen; with `lines`, the last `lines` rows of its history and screen. `seq` comes back on the reply. */
  | { type: "read"; machine: string; pane_id: string; lines: number | null; seq?: number }
  | { type: "input"; machine: string; pane_id: string; ops: InputOp[]; id?: number }
  | { type: "commands"; machine: string; pane_id: string }
  | { type: "uncommitted"; machine: string; root: string; id?: number }
  | { type: "create_desk"; machine: string; workspace_id: string; agent: string | null; id?: number }
  | { type: "create_room"; machine: string; room: RoomSpec; agent: string | null; id?: number };

// ---------------------------------------------------------------- rules

export const AGENT_STATUSES: readonly AgentStatus[] = ["idle", "working", "blocked", "done", "unknown"];

// An SSH destination as typed in the UI: `host`, `user@host` or an alias from
// ~/.ssh/config. Never starting with "-", so it cannot be read as an ssh option.
export const SSH_TARGET = /^[A-Za-z0-9_][A-Za-z0-9._@-]{0,127}$/;
// A branch or base as typed in the build form, never starting with "-".
export const GIT_REF = /^[A-Za-z0-9_.][A-Za-z0-9_./-]{0,199}$/;
// An agent kind: its command's name ("claude", "codex"...).
export const AGENT_KIND = /^[a-z][a-z0-9_-]{0,31}$/;
// A named key: "enter", "esc", "tab", "backspace", an arrow, or a letter or
// digit, after any of the ctrl+, alt+ and shift+ modifiers ("ctrl+c", "shift+tab").
export const KEY = /^(?:(?:ctrl|alt|shift)\+){0,3}(?:enter|esc|tab|backspace|up|down|left|right|[a-z0-9])$/;

// The most rows one read may ask for, ops in one input message, and characters in one text op.
export const MAX_READ_LINES = 5000;
export const MAX_INPUT_OPS = 256;
export const MAX_INPUT_TEXT = 64 * 1024;

// Ids, and text fields (paths, labels, branches) the bridge checks further itself.
const MAX_ID = 512;
const MAX_FIELD = 4096;

/** A message as a page sent it: any fields, of any type, until a parser has checked them. */
type Fields = Record<string, unknown>;

/**
 * One parser per ClientMessage type, each returning that type or null. The
 * map's type has a key for every type, so a new message does not compile
 * until it has a parser.
 */
const PARSERS: { [T in ClientMessage["type"]]: (m: Fields) => Extract<ClientMessage, { type: T }> | null } = {
  add_machine: (m) =>
    str(m.ssh, MAX_FIELD, true) ? { type: "add_machine", ssh: m.ssh.trim(), label: str(m.label, MAX_FIELD) ? m.label.trim() : "" } : null,
  remove_machine: (m) => (str(m.machine) ? { type: "remove_machine", machine: m.machine } : null),
  refresh: (m) => (str(m.machine) ? { type: "refresh", machine: m.machine } : null),
  // Everything else is about something on one floor, named in `machine`.
  focus: (m) => (str(m.machine) && str(m.pane_id) ? { type: "focus", machine: m.machine, pane_id: m.pane_id } : null),
  commands: (m) => (str(m.machine) && str(m.pane_id) ? { type: "commands", machine: m.machine, pane_id: m.pane_id } : null),
  read: (m) => {
    if (!str(m.machine) || !str(m.pane_id)) return null;
    const lines = int(m.lines) && m.lines > 0 ? Math.min(m.lines, MAX_READ_LINES) : null;
    return { type: "read", machine: m.machine, pane_id: m.pane_id, lines, ...(typeof m.seq === "number" ? { seq: m.seq } : {}) };
  },
  input: (m) => {
    if (!str(m.machine) || !str(m.pane_id) || !Array.isArray(m.ops)) return null;
    return { type: "input", machine: m.machine, pane_id: m.pane_id, ops: inputOps(m.ops), ...idOf(m) };
  },
  uncommitted: (m) =>
    str(m.machine) && str(m.root, MAX_FIELD) ? { type: "uncommitted", machine: m.machine, root: m.root, ...idOf(m) } : null,
  create_desk: (m) => {
    if (!str(m.machine) || !str(m.workspace_id)) return null;
    return { type: "create_desk", machine: m.machine, workspace_id: m.workspace_id, agent: agentOf(m.agent), ...idOf(m) };
  },
  create_room: (m) => {
    if (!str(m.machine)) return null;
    const room = roomSpec(m.room);
    return room ? { type: "create_room", machine: m.machine, room, agent: agentOf(m.agent), ...idOf(m) } : null;
  },
};

/** A page's message as the bridge acts on it, or null when it is not one. */
export function parseClientMessage(value: unknown): ClientMessage | null {
  if (!isObject(value) || typeof value.type !== "string" || !isClientType(value.type)) return null;
  return PARSERS[value.type](value);
}

function isClientType(type: string): type is ClientMessage["type"] {
  // Own keys only, so "constructor" or "toString" is not a message.
  return Object.hasOwn(PARSERS, type);
}

/** The page's `id` for the reply, when it sent an integer one. */
function idOf(m: Fields): { id?: number } {
  return int(m.id) ? { id: m.id } : {};
}

/** Text ops cut to MAX_INPUT_TEXT, keys that are not KEY names dropped, empty ops left out. */
function inputOps(list: unknown[]): InputOp[] {
  const ops: InputOp[] = [];
  // An op that is not an object has no `text` or `keys`, and is left out like an empty one.
  for (const op of list.slice(0, MAX_INPUT_OPS) as (Fields | null | undefined)[]) {
    if (typeof op?.text === "string") {
      if (op.text) ops.push({ text: op.text.slice(0, MAX_INPUT_TEXT) });
    } else if (Array.isArray(op?.keys)) {
      const keys = op.keys.filter((k): k is string => typeof k === "string" && KEY.test(k));
      if (keys.length) ops.push({ keys });
    }
  }
  return ops;
}

/** The agent to start: any non-empty string, which the bridge checks against AGENT_KIND (and says so); null for none. */
function agentOf(v: unknown): string | null {
  return typeof v === "string" && v ? v.slice(0, 64) : null;
}

/** A build-mode room as sent; the bridge checks the folder and branch itself. */
function roomSpec(r: unknown): RoomSpec | null {
  if (!isObject(r) || !str(r.cwd, MAX_FIELD, true) || (r.label !== undefined && !str(r.label, MAX_FIELD, true))) return null;
  const label = typeof r.label === "string" ? { label: r.label } : {};
  if (r.kind === "folder") return { kind: r.kind, cwd: r.cwd, ...label };
  if (r.kind !== "worktree" || !str(r.branch, MAX_FIELD, true) || (r.base !== undefined && !str(r.base, MAX_FIELD, true))) return null;
  return { kind: r.kind, cwd: r.cwd, branch: r.branch, ...(typeof r.base === "string" ? { base: r.base } : {}), ...label };
}

function isObject(v: unknown): v is Fields {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function int(v: unknown): v is number {
  return Number.isInteger(v);
}

/** A string of at most `max` characters, empty only when `empty`. */
function str(v: unknown, max = MAX_ID, empty = false): v is string {
  return typeof v === "string" && v.length <= max && (empty || v.length > 0);
}
