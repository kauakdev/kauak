// Floors: one per Herdr machine. Pane, tab and workspace ids are only unique
// within one Herdr server, so the client prefixes every id in a snapshot with
// its machine ("trelew/w1:p1"). Everything past the bridge connection works
// with these keys and never has to know which machine a pane lives on.

import type { MachineInfo, Snapshot } from "./types";

export interface Floor {
  info: MachineInfo;
  /** 1 for the first floor. */
  number: number;
  /** Latest snapshot with namespaced ids; kept (stale) while the machine is down. */
  snapshot: Snapshot | null;
}

/** A few words on why a floor is not live, for the elevator and roster; the full message goes in tooltips. */
export function floorProblem(info: MachineInfo): string {
  if (info.state === "live") return "";
  if (info.state === "connecting") return "connecting…";
  const m = info.message;
  if (/timed out/i.test(m)) return "offline · ssh timed out";
  if (/Permission denied/i.test(m)) return "ssh key refused";
  if (/Host key verification failed/i.test(m)) return `unknown host key · run ssh ${info.ssh ?? ""} once`;
  if (/Could not resolve hostname|Name or service not known/i.test(m)) return "unknown host";
  if (/Connection refused/i.test(m)) return "ssh refused the connection";
  if (/Herdr is not running/i.test(m)) return "Herdr is not running";
  if (/no reply from Herdr/i.test(m)) return "Herdr is not answering";
  return m || "unreachable";
}

export const EMPTY_SNAPSHOT: Snapshot = {
  version: "", protocol: 0, focused_workspace_id: null, focused_tab_id: null, focused_pane_id: null,
  workspaces: [], tabs: [], panes: [], layouts: [],
};

export function keyOf(machine: string, id: string): string {
  return `${machine}/${id}`;
}

/** Machine ids never contain "/", Herdr ids may, so split at the first one. */
export function splitKey(key: string): { machine: string; id: string } {
  const i = key.indexOf("/");
  return { machine: key.slice(0, i), id: key.slice(i + 1) };
}

export function floorOf(key: string): string {
  return splitKey(key).machine;
}

export function namespaceSnapshot(machine: string, s: Snapshot): Snapshot {
  const k = (id: string) => keyOf(machine, id);
  const kn = (id: string | null) => (id === null ? null : k(id));
  return {
    ...s,
    focused_workspace_id: kn(s.focused_workspace_id),
    focused_tab_id: kn(s.focused_tab_id),
    focused_pane_id: kn(s.focused_pane_id),
    workspaces: s.workspaces.map((w) => ({ ...w, workspace_id: k(w.workspace_id), active_tab_id: k(w.active_tab_id) })),
    tabs: s.tabs.map((t) => ({ ...t, tab_id: k(t.tab_id), workspace_id: k(t.workspace_id) })),
    panes: s.panes.map((p) => ({ ...p, pane_id: k(p.pane_id), terminal_id: k(p.terminal_id), workspace_id: k(p.workspace_id), tab_id: k(p.tab_id) })),
    layouts: s.layouts.map((l) => ({
      ...l,
      workspace_id: k(l.workspace_id),
      tab_id: k(l.tab_id),
      focused_pane_id: kn(l.focused_pane_id),
      panes: l.panes.map((lp) => ({ ...lp, pane_id: k(lp.pane_id) })),
    })),
  };
}

/** All floors in one snapshot, for the views that span every floor (terminal panel). */
export function mergeSnapshots(floors: Floor[]): Snapshot {
  const snaps = floors.map((f) => f.snapshot).filter((s): s is Snapshot => s !== null);
  return {
    ...EMPTY_SNAPSHOT,
    workspaces: snaps.flatMap((s) => s.workspaces),
    tabs: snaps.flatMap((s) => s.tabs),
    panes: snaps.flatMap((s) => s.panes),
    layouts: snaps.flatMap((s) => s.layouts),
  };
}
