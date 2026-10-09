// The bridge's settings, resolved once from the environment and what the entry
// point knows itself. This is the one place a setting is read from the
// environment: the entry points (`kauak serve` in packages/kauak, main.ts for
// `pnpm bridge` and `pnpm dev`) hand resolveConfig their process.env, and the
// bridge gets the frozen result (server.ts), each part of it the fields it uses.
//
// Every KAUAK_* variable still falls back to its AGENT_OFFICE_* name from
// before the rename, and the saved floors to ~/.config/agent-office
// (docs/configuration.md).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface BridgeConfig {
  /** Port of the WebSocket and the page (--port, KAUAK_PORT). */
  readonly port: number;
  /** Interface the bridge listens on (KAUAK_HOST). */
  readonly host: string;
  /** Hostnames of the pages that may open the WebSocket: this computer's, and KAUAK_ORIGINS. */
  readonly origins: readonly string[];
  /** The saved floors (KAUAK_CONFIG). */
  readonly machinesFile: string;
  /** This machine's Herdr socket (HERDR_SOCKET_PATH). */
  readonly herdrSocket: string;
  /** The ssh executable that reaches remote floors (KAUAK_SSH). */
  readonly sshCommand: string;
  /** Where the local ends of the SSH tunnels go. */
  readonly tunnelDir: string;
  /** Claude Code's folder on this machine (CLAUDE_CONFIG_DIR): its transcripts and slash commands. */
  readonly claudeDir: string;
  /** Codex's folder on this machine (CODEX_HOME): its rollouts and prompts. */
  readonly codexDir: string;
  /** The built page the bridge serves beside the WebSocket, or null to serve none. */
  readonly pageDir: string | null;
}

/** What the entry point knows itself: the port from its command line, and where the built page is. */
export interface ConfigFlags {
  port?: number;
  pageDir?: string | null;
}

export function resolveConfig(env: Readonly<Record<string, string | undefined>>, flags: ConfigFlags = {}): BridgeConfig {
  const home = os.homedir();
  return Object.freeze({
    port: Number(flags.port ?? env.KAUAK_PORT ?? env.AGENT_OFFICE_PORT ?? 7788),
    // The bridge can type into terminals, create panes and worktrees, and open SSH
    // connections, so by default only this computer may connect, and only pages
    // served from it.
    host: env.KAUAK_HOST ?? env.AGENT_OFFICE_HOST ?? "127.0.0.1",
    origins: Object.freeze([
      "localhost",
      "127.0.0.1",
      "[::1]",
      ...(env.KAUAK_ORIGINS ?? env.AGENT_OFFICE_ORIGINS ?? "")
        .split(",")
        .map((h) => h.trim())
        .filter(Boolean),
    ]),
    machinesFile: env.KAUAK_CONFIG ?? env.AGENT_OFFICE_CONFIG ?? defaultMachinesFile(home),
    herdrSocket: env.HERDR_SOCKET_PATH ?? env.HERDR_SOCKET ?? path.join(home, ".config", "herdr", "herdr.sock"),
    sshCommand: env.KAUAK_SSH ?? env.AGENT_OFFICE_SSH ?? "ssh",
    tunnelDir: path.join(os.tmpdir(), `kauak-${process.getuid?.() ?? "user"}`),
    claudeDir: env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"),
    codexDir: env.CODEX_HOME ?? path.join(home, ".codex"),
    pageDir: flags.pageDir ?? null,
  });
}

/** Reuse existing floors after the rename; fresh installs use the kauak directory. */
function defaultMachinesFile(home: string) {
  const file = path.join(home, ".config", "kauak", "machines.json");
  const legacy = path.join(home, ".config", "agent-office", "machines.json");
  return !fs.existsSync(file) && fs.existsSync(legacy) ? legacy : file;
}
