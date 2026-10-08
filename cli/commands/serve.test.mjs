import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// The server runs from a directory outside the checkout, with a Herdr socket
// that does not exist and an empty floor list, so it never touches a real
// Herdr or saved floors. It never opens a browser either: PATH holds only this
// node and stand-ins for the browser openers (xdg-open, open) that write the
// URL they get to the run's OPENER_LOG file and exit.
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BIN = path.join(ROOT, "bin", "kauak.js");
const BUILT = fs.existsSync(path.join(ROOT, "dist", "index.html"));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kauak-serve-tests-"));
test.after(() => fs.rmSync(temp, { recursive: true }));
const PATH_DIR = path.join(temp, "path");
fs.mkdirSync(PATH_DIR);
if (process.platform !== "win32") fs.symlinkSync(process.execPath, path.join(PATH_DIR, "node"));
for (const opener of ["xdg-open", "open"]) {
  fs.writeFileSync(path.join(PATH_DIR, opener), '#!/bin/sh\necho "$@" >> "$OPENER_LOG"\n', { mode: 0o755 });
}
const env = { ...process.env, PATH: PATH_DIR, HERDR_SOCKET_PATH: path.join(temp, "herdr.sock"), KAUAK_CONFIG: path.join(temp, "machines.json"), KAUAK_HOST: "127.0.0.1" };
let runs = 0;

/** Runs `kauak <args>`; it is killed when the test ends, if still running. */
function start(t, args, { bin = BIN, extraEnv = {} } = {}) {
  const log = path.join(temp, `opener-${++runs}.log`);
  const child = spawn(process.execPath, [bin, ...args], { cwd: temp, env: { ...env, ...extraEnv, OPENER_LOG: log } });
  t.after(() => child.kill("SIGKILL"));
  const s = { stdout: "", stderr: "", exit: once(child, "close").then(([code]) => code) };
  child.stdout.setEncoding("utf8").on("data", (d) => { s.stdout += d; });
  child.stderr.setEncoding("utf8").on("data", (d) => { s.stderr += d; });
  /** Resolves true once stdout has `text`, false if the process exits first. */
  s.until = (text) => new Promise((resolve) => {
    const check = () => { if (s.stdout.includes(text)) resolve(true); };
    child.stdout.on("data", check);
    s.exit.then(() => resolve(s.stdout.includes(text)));
    check();
  });
  s.stop = () => { child.kill("SIGINT"); return s.exit; };
  /** What the browser opener was given, or null if it was not called within `ms`. */
  s.opened = async (ms = 5000) => {
    for (const end = Date.now() + ms; !fs.existsSync(log) && Date.now() < end;) await sleep(25);
    return fs.existsSync(log) ? fs.readFileSync(log, "utf8") : null;
  };
  return s;
}

async function freePort() {
  const server = net.createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

const notBuilt = !BUILT && "dist/ is not built (pnpm build)";
const noStubOpener = process.platform === "win32" && "the stand-in browser opener is a shell script";

test("serves the office page on --port and stops with exit 0 on Ctrl+C", { skip: notBuilt, timeout: 20_000 }, async (t) => {
  const port = await freePort();
  const s = start(t, ["serve", "--no-open", "--port", String(port)]);
  assert.ok(await s.until("Press Ctrl+C to stop."), s.stdout + s.stderr);
  assert.match(s.stdout, new RegExp(`kauak is running at http://127\\.0\\.0\\.1:${port}/\\n`));
  assert.match(s.stdout, /Herdr is not running on this machine .*\n.*npx kauak serve --demo/);
  const res = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/html/);
  assert.match(await res.text(), /<title>kauak<\/title>/);
  assert.equal(await s.stop(), 0);
  assert.equal(await s.opened(300), null);
});
test("`kauak` alone runs serve: KAUAK_PORT, the page and the browser", { skip: notBuilt || noStubOpener, timeout: 20_000 }, async (t) => {
  const port = await freePort();
  const s = start(t, [], { extraEnv: { KAUAK_PORT: String(port) } });
  assert.ok(await s.until("Press Ctrl+C to stop."), s.stdout + s.stderr);
  assert.match(s.stdout, new RegExp(`kauak is running at http://127\\.0\\.0\\.1:${port}/\\n`));
  assert.equal(await s.opened(), `http://127.0.0.1:${port}/\n`);
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
  assert.equal(await s.stop(), 0);
});
test("options without the word serve go to serve: `kauak --no-open --port <n>`", { skip: notBuilt, timeout: 20_000 }, async (t) => {
  const port = await freePort();
  const s = start(t, ["--no-open", "--port", String(port)]);
  assert.ok(await s.until("Press Ctrl+C to stop."), s.stdout + s.stderr);
  assert.match(s.stdout, new RegExp(`kauak is running at http://127\\.0\\.0\\.1:${port}/\\n`));
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
  assert.equal(await s.stop(), 0);
  assert.equal(await s.opened(300), null);
});
test("`kauak --demo` points at the demo and skips the Herdr hint", { skip: notBuilt, timeout: 20_000 }, async (t) => {
  const port = await freePort();
  const s = start(t, ["--demo", "--no-open", "-p", String(port)]);
  assert.ok(await s.until("Press Ctrl+C to stop."), s.stdout + s.stderr);
  assert.match(s.stdout, new RegExp(`kauak is running at http://127\\.0\\.0\\.1:${port}/\\?demo\\n`));
  assert.doesNotMatch(s.stdout, /Herdr is not running/);
  assert.equal(await s.stop(), 0);
});
test("exits 1 with a clear message when the office page is not built", { timeout: 20_000 }, async (t) => {
  // An install without dist/: the package's files except the page, plus its dependencies.
  const pkg = path.join(temp, "no-page");
  const { files } = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  for (const entry of files.filter((f) => !/^(dist\b|!)/.test(f))) fs.cpSync(path.join(ROOT, entry), path.join(pkg, entry), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "package.json"), path.join(pkg, "package.json"));
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(pkg, "node_modules"), "junction");
  const bin = path.join(pkg, "bin", "kauak.js");
  // `kauak` alone stops here too: it is serve, and the browser never opens.
  for (const s of [
    start(t, ["serve", "--no-open", "--port", String(await freePort())], { bin }),
    start(t, [], { bin, extraEnv: { KAUAK_PORT: String(await freePort()) } }),
  ]) {
    assert.equal(await s.exit, 1);
    assert.match(s.stderr, /kauak: the office page is missing from this install/);
    assert.equal(await s.opened(0), null);
  }
});
test("exits 1 when the port is taken", { timeout: 20_000 }, async (t) => {
  const taken = net.createServer().listen(0, "127.0.0.1");
  await once(taken, "listening");
  t.after(() => taken.close());
  const { port } = taken.address();
  const s = start(t, ["serve", "--no-open", "--port", String(port)]);
  assert.equal(await s.exit, 1);
  assert.match(s.stderr, new RegExp(`port ${port} is already in use`));
});
test("bad options exit 2 with the usage, before the bridge starts", () => {
  for (const [args, message] of [
    [["--port", "abc"], "invalid port 'abc'"],
    [["--port", "0"], "invalid port '0'"],
    [["--port=65536"], "invalid port '65536'"],
    [["-p"], "argument missing"],
    [["--bogus"], "unknown option '--bogus'"],
    [["--demo=yes"], "does not take an argument"],
    [["extra"], "unexpected argument 'extra'"],
  ]) {
    const r = spawnSync(process.execPath, [BIN, "serve", "--no-open", ...args], { cwd: temp, env, encoding: "utf8", timeout: 10_000 });
    assert.equal(r.status, 2, args.join(" "));
    assert.equal(r.stdout, "");
    assert.ok(r.stderr.startsWith("kauak serve: ") && r.stderr.includes(message), r.stderr);
    assert.match(r.stderr, /\n\nUsage: kauak serve \[options\]\n/);
  }
});
