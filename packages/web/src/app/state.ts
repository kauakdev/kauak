// The page's state: the floors (machines and their snapshots), the floor on
// screen and the selected pane. The elevator, the HUD and the terminal panel
// subscribe and read it; main.ts passes it on to the office scene. It changes
// only through the methods below, and each tells the subscribers once what
// changed, so a view redraws once per bridge push or click, as before.
//
// It imports no module with a stylesheet: main.ts's imports set the order of
// the page's CSS.

import { floorOf, keyOf, namespaceSnapshot, type Floor } from "../floors/floors";
import type { MachineInfo, PaneInfo, Snapshot } from "@kauak/protocol";

const FLOOR_KEY = "agent-office.floor";

export type Change =
  /** Machines or a snapshot changed; `current` when the floor on screen may have too. */
  | { type: "floors"; current: boolean }
  /** The page went to a floor (maybe the one it was on): `dir` 1 up, -1 down, 0 neither. */
  | { type: "floor"; dir: number }
  /** A pane was selected (or selected again), or the selection was cleared. */
  | { type: "selection" };

export class AppState {
  /** Floors in bridge order (1F first). */
  private machines: MachineInfo[] = [];
  /** Latest snapshot per machine, namespaced (see floors.ts). */
  private snapshots = new Map<string, Snapshot>();
  private floorId: string;
  private paneId: string | null = null;
  /** A `?pane=` deep link, waiting for its floor's first snapshot. */
  private wantPane: string | null;
  private listeners = new Set<(change: Change) => void>();

  /** `?floor=` or the floor saved last, unless a `?pane=` deep link names one. */
  constructor(params: URLSearchParams) {
    this.floorId = params.get("floor") ?? load(FLOOR_KEY) ?? "local";
    // ?pane=w1:p1 (this machine) or ?pane=<machine>/w1:p1 opens that pane's terminal on load.
    let want = params.get("pane");
    if (want && !want.includes("/")) want = keyOf("local", want);
    if (want) this.floorId = floorOf(want);
    this.wantPane = want;
  }

  /** The floor on screen. */
  get current(): string {
    return this.floorId;
  }

  /** The selected pane, whose terminal is open in the panel. */
  get selected(): string | null {
    return this.paneId;
  }

  floors(): Floor[] {
    return this.machines.map((info, i) => ({ info, number: i + 1, snapshot: this.snapshots.get(info.id) ?? null }));
  }

  snapshot(machine: string): Snapshot | undefined {
    return this.snapshots.get(machine);
  }

  pane(key: string): PaneInfo | undefined {
    return this.snapshots.get(floorOf(key))?.panes.find((p) => p.pane_id === key);
  }

  /** Calls `listener` after every change; returns the call that stops it. */
  subscribe(listener: (change: Change) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The bridge's floors. A floor that is gone takes its snapshot along, and the page to the first floor. */
  setMachines(list: MachineInfo[]) {
    this.machines = list;
    const ids = new Set(list.map((m) => m.id));
    for (const id of [...this.snapshots.keys()]) if (!ids.has(id)) this.snapshots.delete(id);
    if (!ids.has(this.floorId) && list.length > 0) this.goToFloor(list[0]!.id);
    else this.emit({ type: "floors", current: true });
  }

  setSnapshot(machine: string, s: Snapshot) {
    this.snapshots.set(machine, namespaceSnapshot(machine, s));
    this.emit({ type: "floors", current: machine === this.floorId });
    if (this.wantPane && floorOf(this.wantPane) === machine) {
      if (this.pane(this.wantPane)) this.select(this.wantPane);
      this.wantPane = null;
    }
  }

  /** Remembered across reloads. */
  goToFloor(id: string) {
    const all = this.floors();
    const from = all.find((f) => f.info.id === this.floorId),
      to = all.find((f) => f.info.id === id);
    if (!to) return;
    const dir = from && from !== to ? Math.sign(to.number - from.number) : 0;
    this.floorId = id;
    save(FLOOR_KEY, id);
    this.emit({ type: "floor", dir });
  }

  /** Selects a pane in the latest snapshots, taking the page to its floor first. */
  select(key: string) {
    if (!this.pane(key)) return;
    const floor = floorOf(key);
    if (floor !== this.floorId) this.goToFloor(floor);
    this.paneId = key;
    this.emit({ type: "selection" });
  }

  deselect() {
    if (this.paneId === null) return;
    this.paneId = null;
    this.emit({ type: "selection" });
  }

  private emit(change: Change) {
    // Over a copy, so subscribing or unsubscribing mid-round skips no one. A subscriber's own change
    // (the panel deselecting a pane that is gone) runs nested, then the rest of this round.
    for (const listener of [...this.listeners]) listener(change);
  }
}

// localStorage can be missing or throw (private windows, blocked site data).
function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}
