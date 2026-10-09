// The Runtime port: what the core (core/) and the enrichers ask of one
// floor, in Kauak terms. A runtime adapter implements it for the program
// that runs the floor's terminals and agents (runtimes/herdr/ for Herdr), and
// server.ts makes one per floor. Nothing here names a runtime's methods,
// fields or errors, so a second runtime is another adapter and the core does
// not change (docs/protocol.md, "Another runtime").

import type { MachineInfo, RoomSpec, Snapshot } from "@kauak/protocol";

/** A floor as machines.json saves it: its id and label, and the SSH target or local socket of its runtime. */
export interface MachineConfig {
  id: string;
  label: string;
  /** The SSH target of a remote floor. */
  ssh?: string | null;
  /** The runtime's socket on this machine, when it is not the default one. */
  socket?: string | null;
  /** The runtime's socket on the remote machine, so that it is not looked up there. */
  remoteSocket?: string | null;
}

/** The agent session a runtime reported for a pane: a transcript path or a session id. */
export interface AgentSession {
  kind: "id" | "path";
  value: string;
}

/**
 * One floor. Making one starts nothing: `start()` connects, and keeps
 * reconnecting until `stop()`. Emits "status" with its MachineInfo when its
 * state or message change, and "snapshot" with each fresh Snapshot. The
 * operations reject with a message fit to show.
 */
export interface Runtime {
  readonly id: string;
  readonly label: string;
  /** The SSH target of a remote floor; null on this machine. */
  readonly ssh: string | null;
  /** What machines.json saves for it. */
  readonly config: MachineConfig;
  readonly info: MachineInfo;
  readonly state: MachineInfo["state"];
  /** The latest snapshot; null until the first. */
  readonly snapshot: Snapshot | null;
  on(event: "status", listener: (info: MachineInfo) => void): unknown;
  on(event: "snapshot", listener: (snapshot: Snapshot) => void): unknown;
  start(): void;
  stop(): void;
  /** Fetch a snapshot now and emit it. */
  refresh(): Promise<void>;
  /** Fetch one shortly; requests that come close together become one. */
  scheduleRefresh(): void;

  focusPane(paneId: string): Promise<void>;
  /** The pane's screen as ANSI text; with `lines`, the last `lines` rows of its history and screen. */
  readPane(paneId: string, lines?: number | null): Promise<string>;
  sendText(paneId: string, text: string): Promise<void>;
  /** Key names as KEY in @kauak/protocol has them. */
  sendKeys(paneId: string, keys: string[]): Promise<void>;
  /** A new desk in the room; resolves with its pane's id. */
  createDesk(workspaceId: string): Promise<string>;
  /** A new room, its folder already checked; resolves with its first pane's id. */
  createRoom(room: RoomSpec): Promise<string>;
  /** Start an agent of `kind` in the pane, once its shell is ready for it. */
  startAgent(kind: string, paneId: string): Promise<void>;
  /** The agent session reported for the pane's current agent, or null. */
  paneSession(paneId: string): AgentSession | null;
  /** The pids of the pane's foreground processes. */
  paneProcesses(paneId: string): Promise<number[]>;
}
