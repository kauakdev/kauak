// The Kauak protocol: what the bridge and the office page say to each other
// over the WebSocket. These are its types; protocol.js has the rules the
// bridge checks every message from a page against, and docs/protocol.md is
// the reference.
//
// Nothing here belongs to the runtime behind a floor. The bridge's Herdr
// adapter (machine.js, herdr.js) turns Herdr's API into these shapes, and the
// page (web/src) and its simulated bridge (web/src/demo.ts) only know them.

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
  /** The git checkout its folder is in, found by the bridge whether or not the runtime knows: its printer's (bridge/diffs.js). */
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
  /** How full the agent's context window is, when the bridge could read it (bridge/context.js). */
  context: ContextUsage | null;
}

/** Tokens in the agent's context window as of its last model call, and the window's size. */
export interface ContextUsage {
  used: number;
  max: number;
}

// ---------------------------------------------------------------- printers

/** What changed in one file of a room's git checkout (bridge/diffs.js). */
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

/** One unit of terminal input: literal text, or named keys (`KEY` in protocol.js: "enter", "esc", "ctrl+c"...). */
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

// ---------------------------------------------------------------- protocol.js

export declare const AGENT_STATUSES: readonly AgentStatus[];
export declare const SSH_TARGET: RegExp;
export declare const GIT_REF: RegExp;
export declare const AGENT_KIND: RegExp;
export declare const KEY: RegExp;
export declare const MAX_READ_LINES: number;
export declare const MAX_INPUT_OPS: number;
export declare const MAX_INPUT_TEXT: number;
export declare function parseClientMessage(value: unknown): ClientMessage | null;
