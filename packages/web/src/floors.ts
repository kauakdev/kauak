// Floors: one per machine. Pane and workspace ids are only unique within one
// machine, so the client prefixes every id in a snapshot with its machine
// ("devbox/w1:p1"). Everything past the bridge connection works with these
// keys and never has to know which machine a pane lives on.

import type { MachineInfo, Snapshot } from "@kauak/protocol";

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
  const runtime = info.runtime.name;
  if (m.includes(`${runtime} is not running`)) return `${runtime} is not running`;
  if (m.includes(`no reply from ${runtime}`)) return `${runtime} is not answering`;
  return m || "unreachable";
}

/** "Herdr 0.9.3": what runs the floor, and its version once known. */
export function runtimeOf(info: MachineInfo): string {
  return info.runtime.version ? `${info.runtime.name} ${info.runtime.version}` : info.runtime.name;
}

export const EMPTY_SNAPSHOT: Snapshot = { workspaces: [], panes: [] };

export function keyOf(machine: string, id: string): string {
  return `${machine}/${id}`;
}

/** Machine ids never contain "/", pane and workspace ids may, so split at the first one. */
export function splitKey(key: string): { machine: string; id: string } {
  const i = key.indexOf("/");
  return { machine: key.slice(0, i), id: key.slice(i + 1) };
}

export function floorOf(key: string): string {
  return splitKey(key).machine;
}

export function namespaceSnapshot(machine: string, s: Snapshot): Snapshot {
  const k = (id: string) => keyOf(machine, id);
  return {
    workspaces: s.workspaces.map((w) => ({ ...w, workspace_id: k(w.workspace_id) })),
    panes: s.panes.map((p) => ({ ...p, pane_id: k(p.pane_id), workspace_id: k(p.workspace_id) })),
  };
}

/** All floors in one snapshot, for the views that span every floor (terminal panel). */
export function mergeSnapshots(floors: Floor[]): Snapshot {
  const snaps = floors.map((f) => f.snapshot).filter((s): s is Snapshot => s !== null);
  return {
    workspaces: snaps.flatMap((s) => s.workspaces),
    panes: snaps.flatMap((s) => s.panes),
  };
}
