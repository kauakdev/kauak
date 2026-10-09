// The bridge on its own, from a checkout: `pnpm bridge`, and the bridge half of
// `pnpm dev`. It serves the page built into packages/kauak/dist (`pnpm build`)
// when there is one; `pnpm dev` serves the page from Vite instead. `kauak
// serve` (packages/kauak/cli/commands/serve.js) starts the bridge the same way.

import { fileURLToPath } from "node:url";
import { resolveConfig } from "./config.ts";
import { createBridge } from "./server.ts";

const bridge = createBridge(resolveConfig(process.env, { pageDir: fileURLToPath(new URL("../../kauak/dist/", import.meta.url)) }));

// SSH tunnels and remote context readers are child processes; take them down with the bridge.
function shutdown(code = 0) {
  bridge.close();
  process.exit(code);
}
process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());
process.on("exit", () => bridge.close());

// The bridge has said why it cannot listen.
bridge.listen().catch(() => shutdown(1));
