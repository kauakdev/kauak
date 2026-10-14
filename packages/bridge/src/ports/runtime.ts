// The Runtime port: what the core (core/) and the enrichers ask of one
// floor, in Kauak terms. A runtime adapter implements it for the program
// that runs the floor's terminals and agents (runtimes/herdr/ for Herdr), and
// server.ts makes one per floor. Nothing here names a runtime's methods,
// fields or errors, so a second runtime is another adapter and the core does
// not change (docs/protocol.md, "Another runtime").

import type { MachineInfo, RequestAnswer, RoomSpec, Snapshot } from "@kauak/protocol";

/** The runtimes a floor can have: Herdr (the default), or a T3 Code server. */
export type RuntimeKind = "herdr" | "t3";

/** A floor as machines.json saves it: its id and label, its runtime, and the SSH target, local socket or URL that reaches it. */
export interface MachineConfig {
  id: string;
  label: string;
  /** Left out for Herdr, as in the files saved before there was a choice. */
  runtime?: RuntimeKind;
  /** The address of a runtime served over HTTP (T3 Code: http://127.0.0.1:3773). */
  url?: string | null;
  /**
   * The bearer token of a floor that is being added. Never saved in
   * machines.json: the runtime keeps it in a file of its own, and its
   * `config` leaves it out.
   */
  token?: string;
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
  /** The runtime puts each agent's context use on its panes itself, so the context meters (enrichers/context/) leave its floor alone. */
  readonly reportsContext: boolean;
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
  /** The floor is being removed for good: drop what the runtime keeps for it, such as a token. Stops it too. */
  forget(): void;
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
  /**
   * A new desk in the room; resolves with its pane's id. `agent` is the kind
   * that will be started in it (startAgent), for a runtime whose desks are
   * an agent's from the start.
   */
  createDesk(workspaceId: string, agent: string | null): Promise<string>;
  /** A new room, its folder already checked; resolves with its first pane's id. `agent` as for createDesk. */
  createRoom(room: RoomSpec, agent: string | null): Promise<string>;
  /** Start an agent of `kind` in the pane, once its shell is ready for it. */
  startAgent(kind: string, paneId: string): Promise<void>;
  /** Answer the pane's request (PaneInfo.request); rejects when the runtime reports none. */
  answer(paneId: string, requestId: string, answers: RequestAnswer[]): Promise<void>;
  /** The agent session reported for the pane's current agent, or null. */
  paneSession(paneId: string): AgentSession | null;
  /** The pids of the pane's foreground processes. */
  paneProcesses(paneId: string): Promise<number[]>;
}
