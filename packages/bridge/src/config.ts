// The bridge's settings, resolved once from the environment and what the entry
// point knows itself. This is the one place a setting is read from the
// environment: the entry points (`kauak serve` in packages/kauak, main.ts for
// `pnpm bridge` and `pnpm dev`) hand resolveConfig their process.env, and the
// bridge gets the frozen result (server.ts), each part of it the fields it uses.
//
// The floors saved before the rename, in ~/.config/agent-office, are copied to
// the kauak folder once, by copyLegacyFloors, which the entry points call before
// they start the bridge (docs/configuration.md).

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
    port: Number(flags.port ?? env.KAUAK_PORT ?? 7788),
    // The bridge can type into terminals, create panes and worktrees, and open SSH
    // connections, so by default only this computer may connect, and only pages
    // served from it.
    host: env.KAUAK_HOST ?? "127.0.0.1",
    origins: Object.freeze([
      "localhost",
      "127.0.0.1",
      "[::1]",
      ...(env.KAUAK_ORIGINS ?? "")
        .split(",")
        .map((h) => h.trim())
        .filter(Boolean),
    ]),
    machinesFile: env.KAUAK_CONFIG ?? defaultMachinesFile(home),
    herdrSocket: env.HERDR_SOCKET_PATH ?? env.HERDR_SOCKET ?? path.join(home, ".config", "herdr", "herdr.sock"),
    sshCommand: env.KAUAK_SSH ?? "ssh",
    tunnelDir: path.join(os.tmpdir(), `kauak-${process.getuid?.() ?? "user"}`),
    claudeDir: env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"),
    codexDir: env.CODEX_HOME ?? path.join(home, ".codex"),
    pageDir: flags.pageDir ?? null,
  });
}

/**
 * Copies the floors saved before the rename to the kauak folder, once: when
 * KAUAK_CONFIG is not set, ~/.config/kauak/machines.json does not exist and
 * ~/.config/agent-office/machines.json does. The old file is left as it was, so
 * an older version still finds it, and nothing reads it after the copy. The
 * entry points call this before createBridge, so resolveConfig stays a
 * description of where the file is. A copy that fails is logged and skipped:
 * the bridge starts with no saved floors, as a fresh install does.
 */
export function copyLegacyFloors(env: Readonly<Record<string, string | undefined>>) {
  if (env.KAUAK_CONFIG !== undefined) return;
  const home = os.homedir();
  const file = defaultMachinesFile(home);
  const legacy = path.join(home, ".config", "agent-office", "machines.json");
  if (fs.existsSync(file) || !fs.existsSync(legacy)) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Exclusive: a kauak file that appeared since the check above is never overwritten.
    fs.copyFileSync(legacy, file, fs.constants.COPYFILE_EXCL);
    console.log(`[bridge] copied the saved floors from ${legacy} to ${file}; the old file is left as it was`);
  } catch (err) {
    console.error(`[bridge] could not copy the saved floors from ${legacy} to ${file}: ${(err as Error).message}`);
  }
}

function defaultMachinesFile(home: string) {
  return path.join(home, ".config", "kauak", "machines.json");
}
