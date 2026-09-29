#!/usr/bin/env node
// `npx agentoffice`: start the bridge, which also serves the built office
// page, and open it in the browser. Settings are the bridge's environment
// variables (see README); the flags below are shortcuts for the common ones.

import { spawn } from "node:child_process";
import fs from "node:fs";

const HELP = `Usage: agentoffice [options]

Shows your Herdr coding agents as a live isometric office.

Options:
  -p, --port <n>  port for the page and the bridge (default 7788)
      --demo      open the demo with simulated agents (no Herdr needed)
      --no-open   do not open the browser
  -v, --version   print the version
  -h, --help      show this help

Environment: HERDR_SOCKET_PATH, AGENT_OFFICE_PORT, AGENT_OFFICE_HOST,
AGENT_OFFICE_ORIGINS, AGENT_OFFICE_CONFIG (see the README).
`;

const args = process.argv.slice(2);
let open = true, demo = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "-h" || a === "--help") { process.stdout.write(HELP); process.exit(0); }
  else if (a === "-v" || a === "--version") {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    console.log(pkg.version);
    process.exit(0);
  }
  else if (a === "--no-open") open = false;
  else if (a === "--demo") demo = true;
  else if (a === "-p" || a === "--port" || a.startsWith("--port=")) {
    const v = a.startsWith("--port=") ? a.slice(7) : args[++i];
    if (!/^\d+$/.test(v ?? "") || Number(v) < 1 || Number(v) > 65535) fail(`invalid port: ${v ?? "(missing)"}`);
    process.env.AGENT_OFFICE_PORT = v;
  }
  else fail(`unknown option: ${a}`);
}

// Read after the flags have set the environment.
const { ready } = await import("../bridge/server.js");
const { LOCAL_SOCKET } = await import("../bridge/machine.js");
const url = await ready;
if (!url) {
  console.error("agentoffice: the office page is missing from this install (run `pnpm build` in a checkout)");
  process.exit(1);
}

const page = demo ? `${url}?demo` : url;
console.log(`\n  Agent Office is running at ${page}\n`);
if (!demo && !fs.existsSync(LOCAL_SOCKET)) {
  console.log(`  Herdr is not running on this machine (no socket at ${LOCAL_SOCKET}).`);
  console.log(`  Start Herdr and the office picks it up on its own, or try the demo: npx agentoffice --demo\n`);
}
console.log("  Press Ctrl+C to stop.\n");
if (open) openBrowser(page);

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

function fail(message) {
  console.error(`agentoffice: ${message}\n\n${HELP}`);
  process.exit(1);
}
