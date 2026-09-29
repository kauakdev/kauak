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
  revision: number;
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

export type BridgeMessage =
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "event"; event: string; data: unknown }
  | { type: "herdr_down"; message: string }
  | { type: "pane_output"; pane_id: string; text: string; revision: number; truncated: boolean }
  | { type: "input_ack"; pane_id: string }
  | { type: "error"; pane_id?: string; message: string };

/** One unit of terminal input: literal text or named keys (Herdr `pane.send_keys` names). */
export type InputOp = { text: string } | { keys: string[] };
