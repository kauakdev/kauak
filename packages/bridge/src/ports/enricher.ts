// The Enricher port: what the bridge adds to a floor that its runtime does
// not report, such as context meters (enrichers/context/) and each room's git
// checkout (enrichers/diffs/). server.ts makes them for each floor, and the
// core runs them without knowing which there are. Two of the things the bridge
// adds also answer a page: the printers (enrichers/diffs/) and the slash
// commands (enrichers/commands/). Their faces are here too, so the core asks
// for what they do, never for the module that does it.

import type { DiffSheet, SlashCommand, Snapshot, Uncommitted } from "@kauak/protocol";

/** Adds to one floor's snapshots what its runtime does not report. Made for one floor; making it starts nothing. */
export interface Enricher {
  /** Follow the floor: its snapshots, its timers, a helper on a remote floor. */
  start(): void;
  /** Stop all of that; also safe on one that never started. */
  stop(): void;
  /** The snapshot with this enricher's fields filled in where known; the same object when it has nothing to add. */
  decorate(snapshot: Snapshot): Snapshot;
  /** "change": what `decorate` adds has changed, so the floor's snapshot goes out again. */
  on(event: "change", listener: () => void): unknown;
}

/** A floor's printers: a sheet for each file edit, the sheets kept for pages that connect later, and the uncommitted view. */
export interface Printers {
  on(event: "print", listener: (sheet: DiffSheet) => void): unknown;
  /** Every sheet still kept, oldest first. */
  history(): DiffSheet[];
  /** Everything not committed in a checkout one of the floor's rooms is in. */
  uncommitted(root: string): Promise<Uncommitted>;
}

/** What the bridge adds to one floor: its enrichers, in the order they decorate a snapshot, and its printers. */
export interface FloorEnrichers {
  enrichers: readonly Enricher[];
  printers: Printers;
}

/** The slash commands `agent` offers in `cwd`; `local` says whether the pane is on this machine, whose files can be read. */
export type SlashCommands = (agent: string | null, cwd: string | null, local: boolean) => Promise<SlashCommand[]>;
