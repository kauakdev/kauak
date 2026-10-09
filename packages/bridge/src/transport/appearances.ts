// The appearance packages installed on this machine, served to the page as
// `GET /appearances.json`: every `.json` file in the appearance folder
// (config.appearanceDir, ~/.config/kauak/appearances by default) and the files
// named with `--appearance`. They are read on each request, without blocking
// the bridge while they are, so a file edited or added shows up when the page
// is reloaded, with no restart.
//
// The bridge does not read what is in them: each file is parsed as JSON and
// passed on as it is, and the page's appearance registry validates it as it
// validates a package imported in the browser (@kauak/appearance). A file that
// is not JSON, or too big, is passed on as an error the page can show, beside
// the file's name, so a typo in a package is found in the settings, not in the
// bridge's log.

import fs from "node:fs/promises";
import path from "node:path";
import type { BridgeConfig } from "../config.ts";

/** What this uses of the bridge's config: the appearance folder and the --appearance files. */
export type AppearanceSettings = Pick<BridgeConfig, "appearanceDir" | "appearanceFiles">;

/** A package file: its JSON as it is, or why it could not be read. The page validates the JSON. */
export type InstalledPackage = { file: string; package: unknown } | { file: string; error: string };

/** What the page gets: where to put packages, and the ones found. */
export interface InstalledAppearances {
  dir: string;
  packages: InstalledPackage[];
}

// A package imported in the browser may be 64 KB at most (MAX_PACKAGE_BYTES in the
// appearance registry); the bridge does not pass on more than the page would accept.
const MAX_BYTES = 64 * 1024;

/** The package files, the folder's in name order and then the named ones, each once. */
export async function readAppearances(settings: AppearanceSettings): Promise<InstalledAppearances> {
  const dir = path.resolve(settings.appearanceDir);
  const files = new Set<string>();
  let names: string[] = [];
  try {
    // .json in any case: HARBOR.JSON is as much a package as harbor.json.
    names = (await fs.readdir(dir)).filter((name) => name.toLowerCase().endsWith(".json") && !name.startsWith("."));
  } catch {
    // No folder yet, or not readable: nothing installed there.
  }
  for (const name of names.sort()) files.add(path.join(dir, name));
  for (const file of settings.appearanceFiles) files.add(path.resolve(file));
  return { dir, packages: await Promise.all([...files].map(readPackage)) };
}

async function readPackage(file: string): Promise<InstalledPackage> {
  try {
    const st = await fs.stat(file);
    if (!st.isFile()) return { file, error: "not a file" };
    if (st.size > MAX_BYTES) return { file, error: `${Math.ceil(st.size / 1024)} KB; a package is 64 KB at most` };
    return { file, package: JSON.parse(await fs.readFile(file, "utf8")) };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return { file, error: e.code === "ENOENT" ? "no such file" : e instanceof SyntaxError ? `not valid JSON (${e.message})` : e.message };
  }
}
