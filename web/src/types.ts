// Shapes taken from `herdr api schema` (protocol 22). Only the fields we use.

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface WorktreeInfo {
  repo_key: string;
  repo_name: string;
  repo_root: string;
  checkout_path: string;
  is_linked_worktree: boolean;
}

export interface WorkspaceInfo {
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  tab_count: number;
  active_tab_id: string;
  agent_status: AgentStatus;
  worktree?: WorktreeInfo | null;
  /** Added by the bridge, not Herdr: the git checkout the room is in, whose edits its printer prints (bridge/diffs.js). */
  git_root?: string | null;
}

export interface TabInfo {
  tab_id: string;
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  agent_status: AgentStatus;
}

export interface PaneInfo {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  focused: boolean;
  cwd: string;
  foreground_cwd: string;
  agent?: string | null;
  terminal_title: string;
  terminal_title_stripped: string;
  agent_status: AgentStatus;
  /** `viewport_rows` is the pane's real height; layout rects are not (see `TerminalPanel.resizeToPane`). */
  scroll?: { offset_from_bottom: number; max_offset_from_bottom: number; viewport_rows: number };
  revision: number;
  /** Added by the bridge, not Herdr: Claude Code and Codex panes whose transcript it found (bridge/context.js). */
  context?: ContextUsage | null;
}

/** Tokens in the agent's context window as of its last model call, and the window's size. */
export interface ContextUsage {
  used: number;
  max: number;
}

export interface LayoutPane {
  pane_id: string;
  focused: boolean;
  rect: { x: number; y: number; width: number; height: number };
}

export interface LayoutInfo {
  workspace_id: string;
  tab_id: string;
  focused_pane_id: string | null;
  panes: LayoutPane[];
}

export interface Snapshot {
  version: string;
  protocol: number;
  focused_workspace_id: string | null;
  focused_tab_id: string | null;
  focused_pane_id: string | null;
  workspaces: WorkspaceInfo[];
  tabs: TabInfo[];
  panes: PaneInfo[];
  layouts: LayoutInfo[];
}

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

/** One Herdr server; the office shows each as a floor. */
export interface MachineInfo {
  id: string;
  label: string;
  /** SSH destination for a remote machine, null for this one. */
  ssh: string | null;
  state: "connecting" | "live" | "down";
  message: string;
  version: string | null;
}

export type BridgeMessage =
  | { type: "machines"; machines: MachineInfo[] }
  | { type: "machine_added"; machine: string }
  | { type: "machine_error"; message: string }
  | { type: "snapshot"; machine: string; snapshot: Snapshot }
  | { type: "event"; machine: string; event: string; data: unknown }
  /** Every sheet a floor's printers hold, on connecting. */
  | { type: "prints"; machine: string; sheets: DiffSheet[] }
  | { type: "print"; machine: string; sheet: DiffSheet }
  | ({ type: "uncommitted"; machine: string; root: string; id?: number } & Uncommitted)
  | { type: "pane_output"; machine: string; pane_id: string; text: string; revision: number; truncated: boolean; seq?: number }
  | { type: "input_ack"; machine: string; pane_id: string; id?: number }
  | { type: "commands"; machine: string; pane_id: string; agent: string | null; commands: SlashCommand[] }
  | { type: "created"; machine: string; id?: number; pane_id: string }
  /** A create request failed; `pane_id` is set when the desk exists but its agent did not start. */
  | { type: "create_error"; machine: string; id?: number; pane_id?: string; message: string }
  | { type: "error"; machine?: string; pane_id?: string; id?: number; message: string };

/** An entry of the message box's "/" menu. `source`: "built-in", "project", "user", or a plugin's name. */
export interface SlashCommand {
  name: string;
  description: string;
  hint?: string;
  aliases?: string[];
  source: string;
}

/** One unit of terminal input: literal text or named keys (Herdr `pane.send_keys` names). */
export type InputOp = { text: string } | { keys: string[] };

/** A new room from build mode: a git worktree on a new branch, or a workspace in a folder. */
export type RoomSpec =
  | { kind: "worktree"; cwd: string; branch: string; base?: string; label?: string }
  | { kind: "folder"; cwd: string; label?: string };
