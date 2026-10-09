import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { COMMANDS } from "./main.js";

// The executable runs as its own process from a directory outside the
// checkout, as it does when installed globally or run through npx. None of
// these runs starts the server; in case a regression does, PATH holds only
// this node (for the shebang), so no browser opener can be found.
const BIN = fileURLToPath(new URL("../bin/kauak.js", import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const SERVE = COMMANDS.find((c) => c.name === "serve");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kauak-cli-tests-"));
test.after(() => fs.rmSync(temp, { recursive: true }));
const PATH_DIR = path.join(temp, "path");
fs.mkdirSync(PATH_DIR);
if (process.platform !== "win32") fs.symlinkSync(process.execPath, path.join(PATH_DIR, "node"));
const run = (file, args) =>
  spawnSync(file, args, {
    cwd: temp,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      PATH: PATH_DIR,
      HERDR_SOCKET_PATH: path.join(temp, "herdr.sock"),
      KAUAK_CONFIG: path.join(temp, "machines.json"),
    },
  });
const kauak = (...args) => run(process.execPath, [BIN, ...args]);

test("--help, -h and `help` list every command and exit 0", () => {
  for (const args of [["--help"], ["-h"], ["help"]]) {
    const r = kauak(...args);
    assert.equal(r.status, 0, args.join(" "));
    assert.equal(r.stderr, "");
    assert.match(r.stdout, /^Usage: kauak \[command\] \[options\]\n/);
    for (const c of COMMANDS) assert.match(r.stdout, new RegExp(`\\n  ${c.name} +${c.summary}\\n`));
    assert.match(r.stdout, /\nTo start the office: kauak serve /);
    assert.match(r.stdout, /\n`kauak` alone runs `kauak serve`/);
  }
});
test("--version and -v print the package version and exit 0", () => {
  for (const args of [["--version"], ["-v"], ["-v", "--demo"]]) {
    const r = kauak(...args);
    assert.equal(r.status, 0, args.join(" "));
    assert.equal(r.stdout, `${VERSION}\n`);
  }
});
test("a command's help comes from `<command> --help`, `-h` or `help <command>`", () => {
  for (const c of COMMANDS) {
    for (const args of [
      [c.name, "--help"],
      [c.name, "-h"],
      ["help", c.name],
      ["--help", c.name],
    ]) {
      const r = kauak(...args);
      assert.equal(r.status, 0, args.join(" "));
      assert.equal(r.stdout, c.usage);
    }
  }
});
test("unknown command words exit 2 with the help and never reach serve", () => {
  for (const [args, message] of [
    [["nope"], "kauak: unknown command 'nope'"],
    [["serv", "--no-open"], "kauak: unknown command 'serv'"],
    [["nope", "--demo"], "kauak: unknown command 'nope'"],
    [["help", "nope"], "kauak: unknown command 'nope'"],
    [["--help", "nope"], "kauak: unknown command 'nope'"],
  ]) {
    const r = kauak(...args);
    assert.equal(r.status, 2, args.join(" "));
    assert.equal(r.stdout, "");
    assert.ok(r.stderr.startsWith(`${message}\n\nUsage: kauak [command]`), r.stderr);
  }
});
test("options before any command go to serve, --help included", () => {
  for (const args of [
    ["--demo", "--help"],
    ["--no-open", "-h"],
    ["-p", "9000", "--help"],
  ]) {
    const r = kauak(...args);
    assert.equal(r.status, 0, args.join(" "));
    assert.equal(r.stdout, SERVE.usage);
  }
});
test("bad serve options without the word serve exit 2 with serve's usage", () => {
  for (const [args, message] of [
    [["--port"], "argument missing"],
    [["-p", "abc"], "invalid port 'abc'"],
    [["--bogus"], "unknown option '--bogus'"],
    [["--demo", "-v"], "unknown option '-v'"],
    [["--no-open", "extra"], "unexpected argument 'extra'"],
  ]) {
    const r = kauak(...args);
    assert.equal(r.status, 2, args.join(" "));
    assert.equal(r.stdout, "");
    assert.ok(r.stderr.startsWith("kauak serve: ") && r.stderr.includes(message), r.stderr);
    assert.ok(r.stderr.endsWith(`\n\n${SERVE.usage}`), r.stderr);
  }
});
test("serve's options leave -h/--help and -v/--version to the global ones", () => {
  // Leading options go to serve, so a global option it also had would shadow it (see main.js).
  for (const [name, { short }] of Object.entries(SERVE.options)) {
    assert.ok(!["help", "version"].includes(name) && !["h", "v"].includes(short), name);
  }
});
test("runs through a symlink to the executable, as a global install links it", {
  skip: process.platform === "win32" && "symlinks need extra rights on Windows",
}, () => {
  const link = path.join(temp, "kauak");
  fs.symlinkSync(BIN, link);
  const r = run(link, ["--version"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${VERSION}\n`);
});
test("every command exports what the dispatcher and the help need", () => {
  assert.equal(new Set(COMMANDS.map((c) => c.name)).size, COMMANDS.length);
  for (const c of COMMANDS) {
    assert.match(c.name, /^[a-z][a-z-]*$/);
    assert.notEqual(c.name, "help");
    assert.match(c.summary, /^[^\n]+$/);
    assert.ok(c.usage.startsWith(`Usage: kauak ${c.name}`) && c.usage.endsWith("\n"), c.name);
    assert.equal(typeof c.options, "object");
    assert.equal(typeof c.run, "function");
  }
});
