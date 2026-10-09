// `kauak serve`: start the bridge, which also serves the built office page,
// and open it in the browser. Settings are the bridge's environment variables
// (see README); the options below are shortcuts for the common ones.

import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { UsageError } from "../errors.js";

// The npm package carries a bundle of the bridge beside the CLI (packages/bridge/scripts/bundle.js
// makes it when packing); a checkout has none and runs the bridge's own source in packages/bridge.
const PACKED = fs.existsSync(new URL("../../bridge/server.js", import.meta.url));
// The page is built into this package's dist/: in the npm package as in a checkout (packages/kauak/dist).
const PAGE_DIR = fileURLToPath(new URL("../../dist/", import.meta.url));

export const name = "serve";
export const summary = "start the office and open it in the browser";
export const usage = `Usage: kauak serve [options]

Starts the bridge, which serves the office page and connects it to Herdr,
and opens the page in the browser. Runs until Ctrl+C.

Options:
  -p, --port <n>  port for the page and the bridge (default 7788)
      --demo      open the demo with simulated agents (no Herdr needed)
      --no-open   do not open the browser
  -h, --help      show this help

Environment: HERDR_SOCKET_PATH, KAUAK_PORT, KAUAK_HOST,
KAUAK_ORIGINS, KAUAK_CONFIG (see the README).
`;
export const options = {
  port: { type: "string", short: "p" },
  demo: { type: "boolean" },
  "no-open": { type: "boolean" },
};

export async function run(values) {
  const port = values.port;
  if (port !== undefined && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535))
    throw new UsageError(`invalid port '${port}' (use 1-65535)`);

  const { resolveConfig } = await import(PACKED ? "../../bridge/config.js" : "../../../bridge/src/config.ts");
  const { createBridge } = await import(PACKED ? "../../bridge/server.js" : "../../../bridge/src/server.ts");
  const config = resolveConfig(process.env, { port: port === undefined ? undefined : Number(port), pageDir: PAGE_DIR });
  const bridge = createBridge(config);
  // SSH tunnels and remote context readers are child processes; take them down with the bridge.
  const shutdown = (code = 0) => {
    bridge.close();
    process.exit(code);
  };
  process.on("SIGINT", () => shutdown());
  process.on("SIGTERM", () => shutdown());
  process.on("exit", () => bridge.close());

  let url;
  try {
    url = await bridge.listen();
  } catch {
    return 1; // the bridge has said why (the port is in use…)
  }
  if (!url) {
    console.error("kauak: the office page is missing from this install (run `pnpm build` in a checkout)");
    return 1;
  }

  const page = values.demo ? `${url}?demo` : url;
  console.log(`\n  kauak is running at ${page}\n`);
  if (!values.demo && !fs.existsSync(config.herdrSocket)) {
    console.log(`  Herdr is not running on this machine (no socket at ${config.herdrSocket}).`);
    console.log(`  Start Herdr and the office picks it up on its own, or try the demo: npx kauak serve --demo\n`);
  }
  console.log("  Press Ctrl+C to stop.\n");
  if (!values["no-open"]) openBrowser(page);
  // Nothing returned: the bridge keeps the process running until Ctrl+C.
}

function openBrowser(target) {
  const [cmd, ...rest] =
    process.platform === "darwin" ? ["open"] : process.platform === "win32" ? ["cmd", "/c", "start", ""] : ["xdg-open"];
  try {
    const child = spawn(cmd, [...rest, target], { stdio: "ignore", detached: true });
    child.on("error", () => {}); // no opener (headless box, SSH session): the URL above is enough
    child.unref();
  } catch {}
}
