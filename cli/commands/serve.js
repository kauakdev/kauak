// `kauak serve`: start the bridge, which also serves the built office page,
// and open it in the browser. Settings are the bridge's environment variables
// (see README); the options below are shortcuts for the common ones.

import { spawn } from "node:child_process";
import fs from "node:fs";
import { UsageError } from "../errors.js";

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
  if (port !== undefined) {
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new UsageError(`invalid port '${port}' (use 1-65535)`);
    process.env.KAUAK_PORT = port;
  }

  // The bridge starts listening when it is loaded, and reads the environment then.
  const { ready } = await import("../../bridge/server.js");
  const { LOCAL_SOCKET } = await import("../../bridge/machine.js");
  const url = await ready;
  if (!url) {
    console.error("kauak: the office page is missing from this install (run `pnpm build` in a checkout)");
    return 1;
  }

  const page = values.demo ? `${url}?demo` : url;
  console.log(`\n  kauak is running at ${page}\n`);
  if (!values.demo && !fs.existsSync(LOCAL_SOCKET)) {
    console.log(`  Herdr is not running on this machine (no socket at ${LOCAL_SOCKET}).`);
    console.log(`  Start Herdr and the office picks it up on its own, or try the demo: npx kauak serve --demo\n`);
  }
  console.log("  Press Ctrl+C to stop.\n");
  if (!values["no-open"]) openBrowser(page);
  // Nothing returned: the bridge keeps the process running until Ctrl+C.
}

function openBrowser(target) {
  const [cmd, ...rest] = process.platform === "darwin" ? ["open"]
    : process.platform === "win32" ? ["cmd", "/c", "start", ""]
    : ["xdg-open"];
  try {
    const child = spawn(cmd, [...rest, target], { stdio: "ignore", detached: true });
    child.on("error", () => {}); // no opener (headless box, SSH session): the URL above is enough
    child.unref();
  } catch {}
}
