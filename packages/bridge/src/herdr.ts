// Herdr → Kauak: how Herdr's API shapes become the Kauak protocol
// (@kauak/protocol). machine.ts speaks Herdr's socket protocol and calls these
// on what comes back; nothing past the bridge sees a Herdr field, method or
// error. Verified against Herdr 0.9.x, protocol 22 (`herdr api schema`).

import { AGENT_STATUSES, type AgentStatus, type PaneInfo, type RepoInfo, type Snapshot } from "@kauak/protocol";

export const RUNTIME = "Herdr";

const STATUSES: ReadonlySet<string> = new Set(AGENT_STATUSES);

// ---------------------------------------------------------------- Herdr's shapes
//
// What the bridge reads of Herdr's answers, as Herdr 0.9.x sends them. They
// describe, they do not check: the functions below still tolerate a newer or
// older Herdr that leaves something out.

/** Herdr's `session.snapshot`. */
export interface HerdrSnapshot {
  version?: string;
  workspaces: HerdrWorkspace[];
  panes: HerdrPane[];
  layouts?: { panes?: { pane_id: string; rect?: HerdrRect }[] }[];
}

export interface HerdrWorkspace {
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  active_tab_id?: string;
  /** Set on the workspaces Herdr recognizes as a git checkout. */
  worktree?: HerdrWorktree | null;
}

export interface HerdrWorktree {
  repo_key: string;
  repo_name: string;
  repo_root: string;
  checkout_path: string;
  is_linked_worktree: boolean;
}

export interface HerdrPane {
  pane_id: string;
  workspace_id: string;
  tab_id?: string;
  focused: boolean;
  cwd?: string | null;
  foreground_cwd?: string | null;
  terminal_title?: string;
  terminal_title_stripped?: string;
  agent?: string | null;
  agent_status: string;
  /** What Herdr's agent integration reported on start: a transcript path or a session id. */
  agent_session?: { agent?: string | null; kind: string; value: unknown } | null;
  scroll?: { viewport_rows?: number; max_offset_from_bottom?: number };
}

export interface HerdrRect {
  width: number;
  height: number;
}

/** What each request the bridge makes answers with (`result`), as far as it reads it. */
export interface HerdrResults {
  "session.snapshot": { snapshot: HerdrSnapshot };
  "pane.focus": unknown;
  "pane.read": { read: { text: string } };
  "pane.send_text": unknown;
  "pane.send_keys": unknown;
  "pane.process_info": { process_info?: { foreground_processes?: { pid: number }[] } };
  "tab.create": { root_pane: { pane_id: string } };
  "worktree.create": { root_pane: { pane_id: string } };
  "workspace.create": { root_pane: { pane_id: string } };
  "agent.start": unknown;
}

export type HerdrMethod = keyof HerdrResults;

/** A failed request: Herdr's error message with its `code` and the `method` asked, or the socket's error. */
export type HerdrError = Error & { code?: string; method?: string };

/** The agent session of a pane, as the trackers get it. */
export interface AgentSession {
  kind: "id" | "path";
  value: string;
}

// ---------------------------------------------------------------- Herdr → Kauak

/**
 * Herdr's `session.snapshot` as a Kauak Snapshot. Only what the office shows
 * is kept: tabs, layouts, terminal ids and revisions stay here. `context`
 * and `git_root` start out null; the bridge's trackers fill them in.
 */
export function toSnapshot(raw: HerdrSnapshot | null): Snapshot {
  const rects = new Map<string, HerdrRect | undefined>();
  for (const layout of list(raw?.layouts)) for (const p of list(layout?.panes)) rects.set(p?.pane_id, p?.rect);
  return {
    workspaces: list(raw?.workspaces).map((w) => ({
      workspace_id: String(w.workspace_id),
      number: Number.isInteger(w.number) ? w.number : 0,
      label: typeof w.label === "string" ? w.label : "",
      focused: w.focused === true,
      repo: repoOf(w.worktree),
      git_root: null,
    })),
    panes: list(raw?.panes).map((p) => ({
      pane_id: String(p.pane_id),
      workspace_id: String(p.workspace_id),
      focused: p.focused === true,
      cwd: p.foreground_cwd || p.cwd || null,
      // Herdr strips the spinner or status glyph an agent puts in front of its title.
      title: p.terminal_title_stripped || p.terminal_title || "",
      agent: typeof p.agent === "string" && p.agent ? p.agent : null,
      agent_status: STATUSES.has(p.agent_status) ? (p.agent_status as AgentStatus) : "unknown",
      screen: screenOf(p.scroll, rects.get(p.pane_id)),
      scrollback: (p.scroll?.max_offset_from_bottom ?? 0) > 0,
      context: null,
    })),
  };
}

/** Herdr's worktree metadata, which it attaches to the workspaces it recognizes as a git checkout. */
function repoOf(wt: HerdrWorktree | null | undefined): RepoInfo | null {
  if (!wt || typeof wt.repo_key !== "string") return null;
  return { key: wt.repo_key, name: wt.repo_name, root: wt.repo_root, checkout: wt.checkout_path, linked: wt.is_linked_worktree === true };
}

/**
 * `scroll.viewport_rows` is the pane's real height. Its layout rect is its
 * real size only when the heights agree: on Herdr 0.9.1 the rect stayed at
 * 120×40 whatever size the attached client gave the pane.
 */
function screenOf(scroll: HerdrPane["scroll"], rect: HerdrRect | undefined): PaneInfo["screen"] {
  const rows = scroll?.viewport_rows || rect?.height;
  if (!rows) return null;
  return { rows, cols: rect?.width ?? null, exact: rect !== undefined && rect.height === scroll?.viewport_rows };
}

/**
 * The agent session Herdr's integration (`herdr integration install claude`)
 * reported for a pane: a transcript path or a session id. Only while it is
 * for the agent in the pane now.
 */
export function paneSession(raw: HerdrSnapshot | null, paneId: string): AgentSession | null {
  const pane = list(raw?.panes).find((p) => p.pane_id === paneId);
  const s = pane?.agent_session;
  return s && s.agent === pane.agent && (s.kind === "id" || s.kind === "path") && typeof s.value === "string"
    ? { kind: s.kind, value: s.value }
    : null;
}

/** A Herdr request's error (or the socket's) as a message fit to show; git's end with the line that says what went wrong. */
export function errorMessage(err: HerdrError | null | undefined): string {
  if (err?.code === "ENOENT" || err?.code === "ECONNREFUSED") return `${RUNTIME} is not running`;
  const text = String(err?.message ?? err);
  return (
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() ?? text
  );
}

function list<T>(v: T[] | undefined): T[] {
  return Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : [];
}
