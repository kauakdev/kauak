// Copies into the npm package what it ships from the repository's root: the
// README and LICENSE, which npm only takes from the package's own folder (the
// README is the package's page on npmjs.com). The bridge comes in as a bundle
// (packages/bridge/scripts/bundle.js), which `prepack` writes before this runs.
//
// `prepack` runs it, and `postpack` runs it with --clean to remove the copies
// and the bundle, so a checkout runs the bridge from its source, never from a
// bundle. A pack that failed before postpack leaves them behind, but the next
// one overwrites the copies, and the bundle empties its folder before writing,
// so nothing stale is ever shipped.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = fileURLToPath(new URL("../", import.meta.url));
const REPO = path.join(PACKAGE, "..", "..");
const COPIES = ["README.md", "LICENSE"];

/** Copies README.md and LICENSE into `dir`: the package, or a stand-in for an install in tests. */
export function assemble(dir = PACKAGE) {
  for (const file of COPIES) fs.copyFileSync(path.join(REPO, file), path.join(dir, file));
}

/** Removes the copies and the bridge's bundle from `dir`. */
export function clean(dir = PACKAGE) {
  for (const entry of ["bridge", ...COPIES]) fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--clean") clean();
  else assemble();
}
