// The appearance packages installed on the machine that serves the page: the
// bridge reads ~/.config/kauak/appearances (and the files `kauak serve
// --appearance` names) and answers `GET /appearances.json` with each file's
// JSON as it is, or why it could not be read (packages/bridge/src/transport/
// appearances.ts). They are loaded with the included packages and the ones
// imported in this browser, every time the page loads: edit a file, reload.
//
// The page validates each one as it validates an import (the appearance
// registry), so what the bridge sends is read here as data from outside: a
// response that is not the expected shape is as good as none.

/** What the bridge found: where packages go, and each file's JSON or its error. */
export interface Installed {
  dir: string;
  packages: InstalledPackage[];
}
export type InstalledPackage = { file: string; package: unknown } | { file: string; error: string };

/** Where the bridge serves them; the Vite dev server proxies it to the bridge, and a static site has none. */
export const INSTALLED_URL = "appearances.json";
/** How long the office waits for them before it opens without them: it shows nothing until then. */
export const INSTALLED_TIMEOUT_MS = 3000;

/** The bridge's answer as Installed, or null for anything else: no bridge (the demo site), or not its shape. */
export function readInstalled(value: unknown): Installed | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { dir, packages } = value as Record<string, unknown>;
  if (typeof dir !== "string" || !Array.isArray(packages)) return null;
  const out: InstalledPackage[] = [];
  for (const p of packages) {
    if (!p || typeof p !== "object" || typeof (p as { file: unknown }).file !== "string") return null;
    const { file, error } = p as { file: string; error?: unknown };
    out.push(typeof error === "string" ? { file, error } : { file, package: (p as { package: unknown }).package });
  }
  return { dir, packages: out };
}

/**
 * Asks the server for the installed packages; null when there are none to ask
 * for (no bridge, or an answer that is not its), or no answer in time.
 */
export async function fetchInstalled(fetcher: typeof fetch = fetch, timeout = INSTALLED_TIMEOUT_MS): Promise<Installed | null> {
  try {
    // The signal also stops a body that never ends.
    const res = await fetcher(INSTALLED_URL, { cache: "no-store", signal: AbortSignal.timeout(timeout) });
    if (!res.ok || !(res.headers.get("content-type") ?? "").startsWith("application/json")) return null;
    return readInstalled(await res.json());
  } catch {
    return null;
  }
}

/** The file's name, as the settings list it: its last path segment. */
export function fileName(file: string) {
  return file.split(/[\\/]/).pop() || file;
}
