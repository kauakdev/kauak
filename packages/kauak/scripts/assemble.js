// Copies into the npm package what it ships from outside this folder: the
// bridge, whose source is packages/bridge/src, and the repository's README
// and LICENSE, which npm only takes from the package's own folder (the README
// is the package's page on npmjs.com).
//
// `prepack` runs it, and `postpack` runs it with --clean to remove the copies,
// so a checkout runs the bridge from its source, never from a copy. Each run
// first removes what an earlier one left (a pack that failed before postpack),
// so a stale copy of the bridge is never shipped.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = fileURLToPath(new URL("../", import.meta.url));
const REPO = path.join(PACKAGE, "..", "..");
const BRIDGE = path.join(PACKAGE, "..", "bridge", "src");
const COPIES = ["bridge", "README.md", "LICENSE"];
// Tests, their fixtures and type declarations stay out, as `files` in package.json says too.
const LEFT_OUT = /(\.test\.[^/\\]+|[/\\]fixtures|\.d\.ts)$/;

/** Copies the bridge, README.md and LICENSE into `dir`: the package, or a stand-in for an install in tests. */
export function assemble(dir = PACKAGE) {
  clean(dir);
  fs.cpSync(BRIDGE, path.join(dir, "bridge"), { recursive: true, filter: (src) => !LEFT_OUT.test(src) });
  for (const file of ["README.md", "LICENSE"]) fs.copyFileSync(path.join(REPO, file), path.join(dir, file));
}

/** Removes the copies from `dir`. */
export function clean(dir = PACKAGE) {
  for (const entry of COPIES) fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--clean") clean();
  else assemble();
}
