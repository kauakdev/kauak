// Bundles the bridge for the npm package: the two modules `kauak serve`
// loads (src/config.ts and src/server.ts, packages/kauak/cli/commands/serve.js)
// become plain JavaScript in packages/kauak/bridge/, with what they import
// from the workspace inlined. The package cannot carry the source as it is:
// @kauak/protocol is TypeScript and is not on npm. `ws` and Node's own modules
// stay imports, which the install provides.
//
// The two Python helpers are copied beside the bundle, because each enricher
// reads its own from its folder (`new URL("./context_remote.py",
// import.meta.url)`), so every chunk is written to that one folder, and the
// script fails if one is not.
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
        input: { server: path.join(SRC, "server.ts"), config: path.join(SRC, "config.ts") },
        output: { format: "es", entryFileNames: "[name].js", chunkFileNames: "[name]-[hash].js" },
      },
    },
  });
  // Which chunks hold the enrichers is Rollup's choice, so every chunk has to be beside the helpers.
  for (const { output } of [result].flat()) {
    for (const file of output) {
      if (file.type === "chunk" && path.dirname(file.fileName) !== ".")
        throw new Error(`bundle: ${file.fileName} is not beside the Python helpers, which the enrichers read from their own folder`);
    }
  }
  // Each helper sits beside its enricher in src/, and they all land in outDir: no two may share a name.
  const helpers = fs.readdirSync(SRC, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".py"));
  for (const file of helpers) {
    const name = path.basename(file);
    if (fs.existsSync(path.join(outDir, name))) throw new Error(`bundle: two Python helpers are named ${name}`);
    fs.copyFileSync(path.join(SRC, file), path.join(outDir, name));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await bundle();
