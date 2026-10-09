// Bundles the bridge for the npm package: the two modules `kauak serve`
// loads (src/server.ts and src/machine.ts, packages/kauak/cli/commands/serve.js)
// become plain JavaScript in packages/kauak/bridge/, with what they import
// from the workspace inlined. The package cannot carry the source as it is:
// @kauak/protocol is TypeScript and is not on npm. `ws` and Node's own modules
// stay imports, which the install provides.
//
// The two Python helpers are copied beside the bundle, because remote.ts reads
// them from its own folder (`new URL(file, import.meta.url)`), so every chunk
// is written to that one folder, and the script fails if one is not.
//
// The kauak package's `prepack` runs it (`pnpm --filter @kauak/bridge bundle`)
// and `postpack` removes the bundle, so a checkout runs the bridge from its
// source, never from a stale bundle.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const BRIDGE = fileURLToPath(new URL("../", import.meta.url));
const SRC = path.join(BRIDGE, "src");
const OUT = path.join(BRIDGE, "..", "kauak", "bridge");

/** Writes the bundle and the Python helpers to `outDir`: the npm package's bridge/, or a stand-in for an install in tests. */
export async function bundle(outDir = OUT, { logLevel = "info" } = {}) {
  const result = await build({
    configFile: false,
    root: BRIDGE,
    publicDir: false,
    logLevel,
    // A build for Node: `ws` stays an import of the installed package; the protocol is not on npm, so it is inlined.
    ssr: { target: "node", external: ["ws"], noExternal: ["@kauak/protocol"] },
    build: {
      ssr: true,
      // The package supports every Node 22.
      target: "node22",
      outDir,
      // outDir is outside the bridge, so Vite would not empty it by itself; an earlier bundle must not linger.
      emptyOutDir: true,
      minify: false,
      sourcemap: false,
      rollupOptions: {
        input: { server: path.join(SRC, "server.ts"), machine: path.join(SRC, "machine.ts") },
        output: { format: "es", entryFileNames: "[name].js", chunkFileNames: "[name]-[hash].js" },
      },
    },
  });
  // Which chunk holds remote.ts is Rollup's choice, so every chunk has to be beside the helpers.
  for (const { output } of [result].flat()) {
    for (const file of output) {
      if (file.type === "chunk" && path.dirname(file.fileName) !== ".")
        throw new Error(`bundle: ${file.fileName} is not beside the Python helpers, which remote.ts reads from its own folder`);
    }
  }
  for (const file of fs.readdirSync(SRC)) if (file.endsWith(".py")) fs.copyFileSync(path.join(SRC, file), path.join(outDir, file));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await bundle();
