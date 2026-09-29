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
  | { type: "pane_output"; machine: string; pane_id: string; text: string; revision: number; truncated: boolean; seq?: number }
  | { type: "input_ack"; machine: string; pane_id: string; id?: number }
  | { type: "error"; machine?: string; pane_id?: string; id?: number; message: string };

/** One unit of terminal input: literal text or named keys (Herdr `pane.send_keys` names). */
export type InputOp = { text: string } | { keys: string[] };
