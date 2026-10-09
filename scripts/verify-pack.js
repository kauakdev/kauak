// Checks the package that `npm publish` would upload, the way people get it.
//
// `npm pack` builds the page (the prepack script) and writes the tarball,
// whose file list must have what `kauak serve` needs and nothing from
// development. The tarball is then installed into empty folders the three
// ways kauak is run (npm install, npm install -g, npx), and each install's
// `kauak` must print its version and help. `kauak serve --no-open`, and bare
// `kauak`, which runs serve and opens the browser, must serve the page and
// everything it links to, accept the page's WebSocket and stop on Ctrl+C with
// nothing left running.
//
// It all happens in a temporary folder with its own npm cache, a Herdr socket
// that does not exist, no saved floors and stand-in browser openers, so the
// real Herdr, floors, global packages and browser are never touched; the
// folder is removed at the end.
// Installing needs the npm registry (for the package's dependencies). POSIX
// only. Run it with `pnpm verify:pack`.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

// Files `kauak serve` needs, among them some that no failing import would
// reveal missing: the page, and the helpers a remote floor runs over SSH.
const REQUIRED = [
  "package.json",
  "README.md",
  "LICENSE",
  "bin/kauak.js",
  "cli/main.js",
  "cli/commands/serve.js",
  "bridge/server.js",
  "bridge/machine.js",
  "bridge/context_remote.py",
  "bridge/diffs_remote.py",
  "dist/index.html",
  "dist/kauak.png",
  "dist/THIRD_PARTY_LICENSES.txt",
];
const FORBIDDEN = [
  [/(^|\/)[^/]+\.test\.[^/]+$/, "a test"],
  [/(^|\/)fixtures\//, "a test fixture"],
  [/\.d\.ts$/, "type declarations (the package has no importable API)"],
  [/\.map$/, "a source map"],
  [/\.tgz$/, "a tarball"],
  [/^(web|shared|plugins|docs|scripts|node_modules|dist-demo|\.github|\.agents|\.claude)\//, "development files"],
  [
    /^(package-lock\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|skills-lock\.json|tsconfig\.json|vite\.config\.ts|\.gitignore|\.npmrc)$|(^|\/)\.env/,
    "repository configuration",
  ],
  [/^dist\/kauak-banner\.png$/, "only the demo site's social preview uses it"],
];

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kauak-verify-pack-"));
const children = new Set();
process.on("exit", () => {
  for (const child of children)
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  fs.rmSync(temp, { recursive: true, force: true });
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(130));

// Stand-ins for the browser openers serve runs (xdg-open, open), first on
// PATH: they write the URL they get to $OPENER_LOG instead of opening it.
const openers = path.join(temp, "openers");
fs.mkdirSync(openers);
for (const opener of ["xdg-open", "open"]) {
  fs.writeFileSync(path.join(openers, opener), '#!/bin/sh\necho "$@" >> "$OPENER_LOG"\n', { mode: 0o755 });
}

// The npm_* settings a script runner (npm run, pnpm) passes down would point
// the npm commands below at this checkout; kauak's settings come only from here.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(npm_|KAUAK_|AGENT_OFFICE_)/.test(k)));
Object.assign(env, {
  PATH: `${openers}${path.delimiter}${process.env.PATH}`,
  npm_config_cache: path.join(temp, "npm-cache"),
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_update_notifier: "false",
  HERDR_SOCKET_PATH: path.join(temp, "no-herdr.sock"),
  KAUAK_CONFIG: path.join(temp, "machines.json"),
  KAUAK_HOST: "127.0.0.1",
});

try {
  const tarball = pack();
  const local = path.join(temp, "local"),
    global = path.join(temp, "global");
  npm(["install", "--prefix", local, tarball]);
  checkInstall(path.join(local, "node_modules"));
  ok(`npm install: ${path.relative(temp, local)}/node_modules/kauak, with only its dependencies`);
  npm(["install", "--global", "--prefix", global, tarball]);
  checkInstall(path.join(global, "lib", "node_modules"));
  ok(`npm install -g: ${path.relative(temp, global)}/lib/node_modules/kauak`);

  for (const [way, kauak] of [
    ["npm install", [path.join(local, "node_modules", ".bin", "kauak")]],
    ["npm install -g", [path.join(global, "bin", "kauak")]],
    ["npx", ["npm", "exec", "--yes", `--package=${tarball}`, "--", "kauak"]],
  ]) {
    checkCommands(kauak);
    ok(`${way}: kauak --version, --help`);
    await checkServe(kauak);
    ok(`${way}: kauak serve --no-open served the page, its files and the WebSocket, opened no browser, and stopped on Ctrl+C`);
    await checkServe(kauak, { bare: true });
    ok(`${way}: bare kauak ran serve, served the same, opened the page in the stand-in browser, and stopped on Ctrl+C`);
  }
  console.log(`\nThe package is ready: ${PKG.name}@${PKG.version}`);
} catch (err) {
  console.error(`\nverify-pack failed: ${err.message}`);
  process.exitCode = 1;
}

/** Runs `npm pack`, checks its file list and returns the tarball's path. */
function pack() {
  const started = Date.now();
  const out = npm(["pack", "--json", "--pack-destination", temp], { cwd: ROOT });
  // The prepack build prints to stdout too; npm's JSON comes last, from a line
  // that is just "[" (npm 10 and 11: a list) or "{" (npm 12: by package name).
  const start = out.search(/^[[{]$/m);
  assert.ok(start >= 0, `no JSON from npm pack:\n${out}`);
  process.stdout.write(out.slice(0, start));
  const [info] = Object.values(JSON.parse(out.slice(start)));
  assert.ok(
    fs.statSync(path.join(ROOT, "dist", "index.html")).mtimeMs > started - 2000,
    "npm pack did not rebuild dist/ (the prepack script)",
  );

  console.log(`\n${info.id} → ${info.filename}`);
  for (const f of info.files) console.log(`  ${size(f.size).padStart(9)}  ${f.path}`);
  console.log(`  ${info.entryCount} files, ${size(info.size)} packed, ${size(info.unpackedSize)} unpacked\n  ${info.integrity}\n`);

  const files = new Map(info.files.map((f) => [f.path, f]));
  for (const f of REQUIRED) assert.ok(files.has(f), `${f} is missing from the package`);
  assert.ok(
    [...files.keys()].some((f) => /^dist\/assets\/[^/]+\.js$/.test(f)),
    "the page's scripts are missing from the package",
  );
  assert.ok(files.get("bin/kauak.js").mode & 0o111, "bin/kauak.js is not executable in the package");
  for (const f of files.keys()) {
    for (const [pattern, why] of FORBIDDEN) assert.ok(!pattern.test(f), `${f} should not be in the package: ${why}`);
  }
  ok(`npm pack: rebuilt the page, ${info.entryCount} files, all required ones and nothing from development`);
  return path.join(temp, info.filename);
}

/** An install has the package with a runnable bin and its dependencies, and none of the devDependencies. */
function checkInstall(nodeModules) {
  const dir = path.join(nodeModules, PKG.name);
  const bin = fs.readFileSync(path.join(dir, "bin", "kauak.js"), "utf8");
  assert.ok(bin.startsWith("#!/usr/bin/env node\n"), "bin/kauak.js does not start with a node shebang");
  // A dependency is next to the package (npm install) or inside it (npm install -g).
  const installed = (dep) => [nodeModules, path.join(dir, "node_modules")].some((d) => fs.existsSync(path.join(d, dep)));
  for (const dep of Object.keys(PKG.dependencies ?? {})) assert.ok(installed(dep), `dependency ${dep} was not installed`);
  for (const dep of Object.keys(PKG.devDependencies ?? {})) assert.ok(!installed(dep), `devDependency ${dep} was installed`);
}

function checkCommands(kauak) {
  const version = run(kauak, ["--version"]);
  assert.equal(version.stdout, `${PKG.version}\n`, "kauak --version");
  const help = run(kauak, ["--help"]);
  assert.match(help.stdout, /^Usage: kauak \[command\] \[options\]\n[\s\S]*\n {2}serve +/, "kauak --help");
}

/** `kauak serve --no-open --port <n>`, or bare `kauak`, which gets its port from KAUAK_PORT. */
async function checkServe(kauak, { bare = false } = {}) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}/`;
  const args = bare ? [] : ["serve", "--no-open", "--port", String(port)];
  const openerLog = path.join(temp, `opener-${port}.log`);
  const opened = () => {
    try {
      return fs.readFileSync(openerLog, "utf8");
    } catch {
      return "";
    }
  };
  // Its own process group, so Ctrl+C reaches npx's child too, as in a terminal.
  const child = spawn(kauak[0], [...kauak.slice(1), ...args], {
    cwd: temp,
    env: { ...env, OPENER_LOG: openerLog, ...(bare && { KAUAK_PORT: String(port) }) },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let output = "";
  for (const stream of [child.stdout, child.stderr])
    stream.setEncoding("utf8").on("data", (d) => {
      output += d;
    });
  let exited = false;
  const exit = once(child, "close").then(([code, signal]) => {
    exited = true;
    return code ?? signal;
  });

  for (const end = Date.now() + 60_000; !output.includes("Press Ctrl+C to stop."); await sleep(100)) {
    assert.ok(!exited && Date.now() < end, `kauak serve did not start:\n${output}`);
  }
  assert.ok(output.includes(`kauak is running at ${base}\n`), output);

  const page = await get(base, "text/html");
  assert.match(page, /<title>kauak<\/title>/);
  // Everything the page links to on this server: its script, styles and icon.
  const links = new Set([...page.matchAll(/\b(?:src|href)="([^"#:]+)"/g)].map((m) => m[1]));
  assert.ok(
    [...links].some((l) => /^\/assets\/.+\.js$/.test(l)),
    "the page links no script",
  );
  for (const link of links) await get(new URL(link, base), link.endsWith(".js") ? "text/javascript" : "");

  // The bridge's first message to a page lists the floors; this machine is always one.
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: base.slice(0, -1) });
  try {
    const [data] = await once(ws, "message", { signal: AbortSignal.timeout(10_000) });
    const msg = JSON.parse(data.toString());
    assert.equal(msg.type, "machines");
    assert.ok(
      msg.machines.some((m) => m.id === "local"),
      data.toString(),
    );
  } finally {
    ws.terminate();
  }

  // Bare `kauak` opens the page in the browser, once; --no-open opens nothing.
  for (const end = Date.now() + 10_000; bare && !opened(); await sleep(100)) {
    assert.ok(Date.now() < end, `bare kauak did not open the browser:\n${output}`);
  }
  assert.equal(opened(), bare ? `${base}\n` : "", "the browser opener got the wrong URL, or was called with --no-open");

  process.kill(-child.pid, "SIGINT");
  const code = await Promise.race([exit, sleep(10_000).then(() => "still running 10 s after Ctrl+C")]);
  // npx runs kauak under a shell that, like npx then, ends on the Ctrl+C itself.
  assert.ok(code === 0 || (kauak[0] === "npm" && code === "SIGINT"), `kauak serve did not stop cleanly on Ctrl+C (${code}):\n${output}`);
  await sleep(200);
  assert.throws(() => process.kill(-child.pid, 0), { code: "ESRCH" }, "kauak serve left processes running");
  children.delete(child);
}

async function get(url, type) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  assert.equal(res.status, 200, `GET ${url}`);
  assert.ok(res.headers.get("content-type")?.startsWith(type), `GET ${url}: ${res.headers.get("content-type")}`);
  return res.text();
}

function npm(args, { cwd = temp } = {}) {
  const r = spawnSync("npm", args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 600_000,
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (r.error) throw r.error;
  assert.equal(r.status, 0, `npm ${args.join(" ")} exited with ${r.status ?? r.signal}`);
  return r.stdout;
}

/** Runs a short kauak command, which must exit 0 and print nothing to stderr but npm's own lines. */
function run([cmd, ...pre], args) {
  const r = spawnSync(cmd, [...pre, ...args], { cwd: temp, env, encoding: "utf8", timeout: 120_000 });
  if (r.error) throw r.error;
  assert.equal(r.status, 0, `kauak ${args.join(" ")} exited with ${r.status ?? r.signal}:\n${r.stdout}${r.stderr}`);
  assert.equal(
    r.stderr
      .split("\n")
      .filter((l) => l && !l.startsWith("npm "))
      .join("\n"),
    "",
    `kauak ${args.join(" ")} wrote to stderr`,
  );
  return r;
}

async function freePort() {
  const server = net.createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

function size(bytes) {
  return bytes < 1000 ? `${bytes} B` : bytes < 1e6 ? `${(bytes / 1e3).toFixed(1)} kB` : `${(bytes / 1e6).toFixed(2)} MB`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ok(message) {
  console.log(`✓ ${message}`);
}
