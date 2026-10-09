import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./check-boundaries.mjs", import.meta.url));

// A small tree that keeps every boundary, with a file for each rule to check.
const CLEAN = {
  "packages/bridge/src/machine.ts":
    'import { toSnapshot } from "./herdr.ts";\nexport const snapshot = (request) => request("session.snapshot");\n',
  "packages/bridge/src/herdr.ts": 'import { AGENT_STATUSES } from "@kauak/protocol";\n// Herdr\'s `pane.read` answers in rows.\n',
  "packages/bridge/src/remote.ts": 'import { SSH } from "./machine.ts";\n',
  "packages/bridge/src/context.ts":
    '// Herdr reports no token counts, so read them from the transcript.\nimport { RemoteScript } from "./remote.ts";\n',
  "packages/bridge/src/diffs.ts": 'import { RemoteScript } from "./remote.ts";\n',
  "packages/bridge/src/commands.ts": 'import fs from "node:fs";\n',
  "packages/bridge/src/server.ts": 'import { Machine } from "./machine.ts";\nimport { parseClientMessage } from "@kauak/protocol";\n',
  "packages/bridge/src/server.test.mjs": 'import { toSnapshot } from "./herdr.ts";\nconst calls = ["pane.read", "tab.create"];\n',
  "packages/bridge/src/fixtures/fake-herdr.mjs": 'export const METHOD = "session.snapshot";\n',
  "packages/protocol/src/index.ts":
    'export type AgentStatus = "idle" | "working";\nexport const AGENT_STATUSES: readonly AgentStatus[] = ["idle", "working"];\n',
  "packages/protocol/src/protocol.test.mjs": 'import test from "node:test";\nimport { parseClientMessage } from "./index.ts";\n',
  "packages/kauak/cli/main.js": 'export async function serve() {\n  await import("../../bridge/src/server.ts");\n}\n',
  "packages/kauak/bin/kauak.js": 'import { main } from "../cli/main.js";\n',
  "packages/appearance/src/contracts.ts": "export interface Theme {\n  name: string;\n}\n",
  "packages/appearance/src/registry.ts":
    'import type { Theme } from "./contracts";\nexport const load = (storage: { getItem(k: string): string | null }) => storage.getItem("theme");\nexport const title = (t: Theme) => ({ document: t.name });\n',
  "packages/web/src/main.ts": 'import type { AgentStatus } from "@kauak/protocol";\nimport { Theme } from "@kauak/appearance/contracts";\n',
  "packages/web/src/demo.ts": 'const SEARCHES = ["retries", "session.snapshot"];\n',
};

/** Runs the check on CLEAN with `changes` applied (null removes a file); returns its exit code and output lines. */
function check(changes = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kauak-boundaries-"));
  try {
    for (const [file, text] of Object.entries({ ...CLEAN, ...changes })) {
      if (text === null) continue;
      fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    }
    const run = spawnSync(process.execPath, [SCRIPT, root], { encoding: "utf8" });
    return { status: run.status, lines: (run.stdout + run.stderr).trim().split("\n") };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function assertViolation(changes, pattern) {
  const { status, lines } = check(changes);
  assert.equal(status, 1, lines.join("\n"));
  assert.ok(
    lines.some((l) => pattern.test(l)),
    `expected a line matching ${pattern}, got:\n${lines.join("\n")}`,
  );
}

test("a tree that keeps the boundaries passes", () => {
  const { status, lines } = check();
  assert.equal(status, 0, lines.join("\n"));
  assert.match(lines.at(-1), /no violations/);
});

test("the repository passes", () => {
  const run = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});

test("only the Herdr adapter imports herdr.ts, however it is imported", () => {
  const rule = /only the Herdr adapter/;
  assertViolation(
    { "packages/bridge/src/server.ts": 'import { Machine } from "./machine.ts";\nimport { toSnapshot } from "./herdr.ts";\n' },
    /^packages\/bridge\/src\/server\.ts:2: imports "\.\/herdr\.ts" \(packages\/bridge\/src\/herdr\.ts\): only the Herdr adapter/,
  );
  assertViolation({ "packages/bridge/src/server.ts": 'export * from "./herdr.ts";\n' }, rule);
  assertViolation({ "packages/bridge/src/server.ts": 'export { toSnapshot as snap } from "./herdr.ts";\n' }, rule);
  assertViolation({ "packages/bridge/src/server.ts": 'const herdr = await import("./herdr.ts");\n' }, rule);
  assertViolation({ "packages/kauak/cli/main.js": "const { toSnapshot } = await import(`../../bridge/src/herdr.ts`);\n" }, rule);
  assertViolation({ "packages/kauak/cli/main.js": 'const { toSnapshot } = await import("@kauak/bridge/herdr.ts");\n' }, rule);
  assertViolation({ "packages/kauak/cli/main.js": 'const { toSnapshot } = await import("../bridge/herdr.js");\n' }, rule);
  assertViolation({ "packages/bridge/src/server.ts": 'const { toSnapshot } = require("./herdr");\n' }, rule);
});

test("imports in comments, strings and template literals are not imports", () => {
  const { status, lines } = check({
    "packages/bridge/src/server.ts": [
      '// import { toSnapshot } from "./herdr.ts";',
      '/* export * from "./herdr.ts"; */',
      "const example = 'import { toSnapshot } from \"./herdr.ts\"';",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: this line of the file is a template literal
      'const later = `${"x"} import("./herdr.ts")`;',
      'const re = /import\\("\\.\\/herdr\\.js"\\)/;',
      "",
    ].join("\n"),
  });
  assert.equal(status, 0, lines.join("\n"));
});

test("the trackers do not import the Herdr adapter", () => {
  assertViolation(
    { "packages/bridge/src/context.ts": 'import { RemoteScript } from "./remote.ts";\nimport { LOCAL_SOCKET } from "./machine.ts";\n' },
    /^packages\/bridge\/src\/context\.ts:2: imports "\.\/machine\.ts" \(packages\/bridge\/src\/machine\.ts\): the trackers reach a floor/,
  );
  assertViolation(
    { "packages/bridge/src/commands.ts": 'import { Machine } from "@kauak/bridge/machine.ts";\n' },
    /^packages\/bridge\/src\/commands\.ts:1: .*the trackers/,
  );
});

test("the protocol imports nothing, and uses neither Node nor the DOM", () => {
  const rule = /the protocol imports nothing/;
  assertViolation(
    { "packages/protocol/src/index.ts": 'import fs from "node:fs";\n' },
    /^packages\/protocol\/src\/index\.ts:1: imports "node:fs": the protocol imports nothing/,
  );
  assertViolation({ "packages/protocol/src/index.ts": 'import { RUNTIME } from "../../bridge/src/herdr.ts";\n' }, rule);
  assertViolation({ "packages/protocol/src/index.ts": 'import type { Theme } from "@kauak/appearance/contracts";\n' }, rule);
  assertViolation({ "packages/protocol/src/index.ts": 'import { WebSocket } from "ws";\n' }, rule);
  assertViolation(
    { "packages/protocol/src/index.ts": "export const home = () => process.env.HOME;\n" },
    /^packages\/protocol\/src\/index\.ts:1: uses process: the protocol imports nothing/,
  );
  assertViolation({ "packages/protocol/src/index.ts": "export const title = () => document.title;\n" }, /uses document: the protocol/);
});

test("the bridge and the page import the protocol by its name, not by its path", () => {
  const rule = /import the protocol by its name/;
  assertViolation(
    { "packages/bridge/src/server.ts": 'import { parseClientMessage } from "../../protocol/src/index.ts";\n' },
    /^packages\/bridge\/src\/server\.ts:1: imports "\.\.\/\.\.\/protocol\/src\/index\.ts" \(packages\/protocol\/src\/index\.ts\): other packages import the protocol by its name/,
  );
  assertViolation({ "packages/web/src/main.ts": 'import type { AgentStatus } from "../../protocol/src";\n' }, rule);
});

test("Herdr's method names are flagged outside the adapter, but not in comments, tests or the demo", () => {
  assertViolation(
    {
      "packages/bridge/src/diffs.ts":
        'import { RemoteScript } from "./remote.ts";\nexport const read = (m) => m.request("pane.read", {});\n',
    },
    /^packages\/bridge\/src\/diffs\.ts:2: names "pane\.read": Herdr's method and event names/,
  );
  assertViolation(
    { "packages/web/src/ws.ts": 'export const EVENT = "workspace.created";\n' },
    /^packages\/web\/src\/ws\.ts:1: names "workspace\.created"/,
  );
  const { status, lines } = check({
    "packages/bridge/src/diffs.ts":
      '// Herdr\'s pane.read and "tab.create" are the adapter\'s business.\nexport const label = "pane read";\n',
  });
  assert.equal(status, 0, lines.join("\n"));
});

test("the appearance registry imports nothing but its contracts and uses no DOM", () => {
  const rule = /the appearance registry imports nothing but its contracts/;
  assertViolation(
    { "packages/appearance/src/registry.ts": 'import type { Theme } from "./contracts";\nimport { Graphics } from "pixi.js";\n' },
    /^packages\/appearance\/src\/registry\.ts:2: imports "pixi\.js": the appearance registry/,
  );
  assertViolation({ "packages/appearance/src/registry.ts": 'import { Terminal } from "@xterm/xterm";\n' }, rule);
  assertViolation({ "packages/appearance/src/registry.ts": 'import { Machine } from "../../bridge/src/machine.ts";\n' }, rule);
  assertViolation({ "packages/appearance/src/registry.ts": 'import { parseClientMessage } from "@kauak/protocol";\n' }, rule);
  assertViolation({ "packages/appearance/src/registry.ts": 'import { keyOf } from "../../web/src/floors";\n' }, rule);
  assertViolation(
    { "packages/appearance/src/registry.ts": 'export const load = () => localStorage.getItem("theme");\n' },
    /^packages\/appearance\/src\/registry\.ts:1: uses localStorage: the appearance registry/,
  );
  assertViolation({ "packages/appearance/src/registry.ts": "export const el = (e: HTMLElement) => e;\n" }, /uses HTMLElement/);
});

test("packages/appearance imports nothing from the bridge, the CLI or the page", () => {
  assertViolation(
    { "packages/appearance/src/contracts.ts": 'import type { Machine } from "../../bridge/src/machine.ts";\n' },
    /^packages\/appearance\/src\/contracts\.ts:1: .*appearance contracts/,
  );
  assertViolation(
    { "packages/appearance/src/contracts.ts": 'import type { Machine } from "@kauak/bridge/machine.ts";\n' },
    /^packages\/appearance\/src\/contracts\.ts:1: .*appearance contracts/,
  );
});

test("the page imports the protocol and the appearance packages, and nothing of the bridge or the CLI", () => {
  const rule = /the page imports the protocol and the appearance packages/;
  assertViolation(
    { "packages/web/src/main.ts": 'import { ready } from "../../bridge/src/server.ts";\n' },
    /^packages\/web\/src\/main\.ts:1: imports "\.\.\/\.\.\/bridge\/src\/server\.ts" \(packages\/bridge\/src\/server\.ts\): the page imports the protocol/,
  );
  assertViolation({ "packages/web/src/main.ts": 'import { ready } from "@kauak/bridge/server.ts";\n' }, rule);
  // Types are no exception: what the page knows of the bridge is the protocol.
  assertViolation({ "packages/web/src/main.ts": 'import type { Machine } from "../../bridge/src/machine.ts";\n' }, rule);
  assertViolation({ "packages/web/src/main.ts": 'export type * from "@kauak/bridge/machine.ts";\n' }, rule);
  assertViolation({ "packages/web/src/main.ts": 'import { main } from "../../kauak/cli/main.js";\n' }, rule);
  // The protocol's rules may cross as well as its types.
  const { status, lines } = check({
    "packages/web/src/main.ts":
      'import { AGENT_STATUSES, type AgentStatus } from "@kauak/protocol";\nimport { Theme } from "@kauak/appearance/contracts";\n',
  });
  assert.equal(status, 0, lines.join("\n"));
});

test("the bridge and the CLI import nothing from the page, and the bridge nothing from the CLI", () => {
  assertViolation(
    { "packages/bridge/src/server.ts": 'import { keyOf } from "../../web/src/floors.ts";\n' },
    /^packages\/bridge\/src\/server\.ts:1: .*the bridge and the CLI import nothing from the page/,
  );
  assertViolation(
    { "packages/kauak/cli/main.js": 'await import("../../web/src/demo.ts");\n' },
    /^packages\/kauak\/cli\/main\.js:1: .*nothing from the page/,
  );
  assertViolation({ "packages/bridge/src/server.ts": 'import { keyOf } from "@kauak/web/src/floors.ts";\n' }, /nothing from the page/);
  assertViolation(
    { "packages/bridge/src/server.ts": 'import { UsageError } from "../../kauak/cli/errors.js";\n' },
    /^packages\/bridge\/src\/server\.ts:1: .*nothing from the CLI/,
  );
  assertViolation({ "packages/bridge/src/server.ts": 'import pkg from "kauak/package.json";\n' }, /nothing from the CLI/);
});

test("a rule whose files are gone fails instead of passing on nothing", () => {
  assertViolation({ "packages/appearance/src/registry.ts": null }, /rule matches no files, update RULES: the appearance registry/);
});

test("dot folders such as .claude/worktrees are not read", () => {
  const { status, lines } = check({
    ".claude/worktrees/feature/packages/bridge/src/server.ts": 'import { toSnapshot } from "./herdr.ts";\n',
  });
  assert.equal(status, 0, lines.join("\n"));
});
