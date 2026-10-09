// The bridge, put together: the core (core/bridge.ts) with Herdr as every
// floor's runtime (runtimes/herdr/), context meters and printers as each
// floor's enrichers (enrichers/), and the agents' slash commands. This is the
// one module that names them; the core knows them only through the ports
// (ports/).
//
// Loading this file starts nothing. An entry point (`kauak serve`, or main.ts)
// resolves the config (config.ts), calls createBridge, then `listen()`, and
// owns the process: its signals and its exit code.

import type { BridgeConfig } from "./config.ts";
import { Bridge, type BridgeDeps } from "./core/bridge.ts";
import { slashCommands } from "./enrichers/commands/commands.ts";
import { ContextTracker } from "./enrichers/context/context.ts";
import { DiffTracker } from "./enrichers/diffs/diffs.ts";
import type { Runtime } from "./ports/runtime.ts";
import { Machine } from "./runtimes/herdr/machine.ts";

/**
 * The bridge for `config`, its floors made but not started: `listen()` starts
 * them and opens the port, and resolves with the office's URL (null when
 * there is no built page to serve); it rejects when the port cannot be
 * opened, after saying why. `close()` stops the floors at once (their SSH
 * tunnels and remote helpers are child processes) and then closes the port.
 * `floors` is id → Runtime, in floor order. `deps` replaces any of the
 * runtime, the enrichers or the slash commands, as a test may.
 */
export function createBridge(config: BridgeConfig, deps: Partial<BridgeDeps> = {}) {
  const bridge = new Bridge(config, { ...herdrBridge(config), ...deps });
  const floors: ReadonlyMap<string, Runtime> = bridge.machines;
  return { listen: () => bridge.listen(), close: () => bridge.close(), floors };
}

/** Herdr on every floor; its context meters, then each room's git checkout, and the printers; the agents' slash commands. */
function herdrBridge(config: BridgeConfig): BridgeDeps {
  return {
    runtime: (floor) => new Machine(floor, config),
    enrichers: (floor) => {
      const context = new ContextTracker(floor, config);
      const diffs = new DiffTracker(floor, config);
      return { enrichers: [context, diffs], printers: diffs };
    },
    commands: (agent, cwd, local) => slashCommands(agent, cwd, local, config),
  };
}
