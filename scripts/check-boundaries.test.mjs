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
  "packages/bridge/src/machine.js":
    'import { toSnapshot } from "./herdr.js";\nexport const snapshot = (request) => request("session.snapshot");\n',
  "packages/bridge/src/herdr.js": 'import { AGENT_STATUSES } from "./protocol.js";\n// Herdr\'s `pane.read` answers in rows.\n',
  "packages/bridge/src/remote.js": 'import { SSH } from "./machine.js";\n',
  "packages/bridge/src/protocol.js": "export const AGENT_STATUSES = [];\n",
  "packages/bridge/src/protocol.d.ts": 'export type AgentStatus = "idle" | "working";\n',
  "packages/bridge/src/context.js":
    '// Herdr reports no token counts, so read them from the transcript.\nimport { RemoteScript } from "./remote.js";\n',
  "packages/bridge/src/diffs.js": 'import { RemoteScript } from "./remote.js";\n',
  "packages/bridge/src/commands.js": 'import fs from "node:fs";\n',
  "packages/bridge/src/server.js": 'import { Machine } from "./machine.js";\nimport { parseClientMessage } from "./protocol.js";\n',
  "packages/bridge/src/server.test.mjs": 'import { toSnapshot } from "./herdr.js";\nconst calls = ["pane.read", "tab.create"];\n',
  "packages/bridge/src/fixtures/fake-herdr.mjs": 'export const METHOD = "session.snapshot";\n',
  "packages/kauak/cli/main.js": 'export async function serve() {\n  await import("../../bridge/src/server.js");\n}\n',
  "packages/kauak/bin/kauak.js": 'import { main } from "../cli/main.js";\n',
  "packages/appearance/src/contracts.ts": "export interface Theme {\n  name: string;\n}\n",
  "packages/appearance/src/registry.ts":
    'import type { Theme } from "./contracts";\nexport const load = (storage: { getItem(k: string): string | null }) => storage.getItem("theme");\nexport const title = (t: Theme) => ({ document: t.name });\n',
  "packages/web/src/types.ts": 'export type * from "../../bridge/src/protocol";\n',
  "packages/web/src/main.ts": 'import type { AgentStatus } from "./types";\nimport { Theme } from "@kauak/appearance/contracts";\n',
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

test("only the Herdr adapter imports herdr.js, however it is imported", () => {
  const rule = /only the Herdr adapter/;
  assertViolation(
    { "packages/bridge/src/server.js": 'import { Machine } from "./machine.js";\nimport { toSnapshot } from "./herdr.js";\n' },
    /^packages\/bridge\/src\/server\.js:2: imports "\.\/herdr\.js" \(packages\/bridge\/src\/herdr\.js\): only the Herdr adapter/,
  );
  assertViolation({ "packages/bridge/src/server.js": 'export * from "./herdr.js";\n' }, rule);
  assertViolation({ "packages/bridge/src/server.js": 'export { toSnapshot as snap } from "./herdr.js";\n' }, rule);
  assertViolation({ "packages/bridge/src/server.js": 'const herdr = await import("./herdr.js");\n' }, rule);
  assertViolation({ "packages/kauak/cli/main.js": "const { toSnapshot } = await import(`../../bridge/src/herdr.js`);\n" }, rule);
  assertViolation({ "packages/kauak/cli/main.js": 'const { toSnapshot } = await import("@kauak/bridge/herdr.js");\n' }, rule);
  assertViolation({ "packages/kauak/cli/main.js": 'const { toSnapshot } = await import("../bridge/herdr.js");\n' }, rule);
  assertViolation({ "packages/bridge/src/server.js": 'const { toSnapshot } = require("./herdr");\n' }, rule);
});

test("imports in comments, strings and template literals are not imports", () => {
  const { status, lines } = check({
    "packages/bridge/src/server.js": [
      '// import { toSnapshot } from "./herdr.js";',
      '/* export * from "./herdr.js"; */',
      "const example = 'import { toSnapshot } from \"./herdr.js\"';",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: this line of the file is a template literal
      'const later = `${"x"} import("./herdr.js")`;',
      'const re = /import\\("\\.\\/herdr\\.js"\\)/;',
      "",
    ].join("\n"),
  });
  assert.equal(status, 0, lines.join("\n"));
});

test("the trackers and the protocol do not import the Herdr adapter", () => {
  assertViolation(
    { "packages/bridge/src/context.js": 'import { RemoteScript } from "./remote.js";\nimport { LOCAL_SOCKET } from "./machine.js";\n' },
    /^packages\/bridge\/src\/context\.js:2: imports "\.\/machine\.js" \(packages\/bridge\/src\/machine\.js\): the trackers and the protocol/,
  );
  assertViolation(
    { "packages/bridge/src/protocol.js": 'import { RUNTIME } from "./herdr.js";\n' },
    /^packages\/bridge\/src\/protocol\.js:1: .*the trackers/,
  );
});

test("Herdr's method names are flagged outside the adapter, but not in comments, tests or the demo", () => {
  assertViolation(
    {
      "packages/bridge/src/diffs.js":
        'import { RemoteScript } from "./remote.js";\nexport const read = (m) => m.request("pane.read", {});\n',
    },
    /^packages\/bridge\/src\/diffs\.js:2: names "pane\.read": Herdr's method and event names/,
  );
  assertViolation(
    { "packages/web/src/ws.ts": 'export const EVENT = "workspace.created";\n' },
    /^packages\/web\/src\/ws\.ts:1: names "workspace\.created"/,
  );
  const { status, lines } = check({
    "packages/bridge/src/diffs.js":
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
  assertViolation({ "packages/appearance/src/registry.ts": 'import { parseClientMessage } from "../../bridge/src/protocol.js";\n' }, rule);
  assertViolation({ "packages/appearance/src/registry.ts": 'import { parseClientMessage } from "@kauak/bridge/protocol.js";\n' }, rule);
  assertViolation({ "packages/appearance/src/registry.ts": 'import { keyOf } from "../../web/src/floors";\n' }, rule);
  assertViolation(
    { "packages/appearance/src/registry.ts": 'export const load = () => localStorage.getItem("theme");\n' },
    /^packages\/appearance\/src\/registry\.ts:1: uses localStorage: the appearance registry/,
  );
  assertViolation({ "packages/appearance/src/registry.ts": "export const el = (e: HTMLElement) => e;\n" }, /uses HTMLElement/);
});

test("packages/appearance imports nothing from the bridge, the CLI or the page", () => {
  assertViolation(
    { "packages/appearance/src/contracts.ts": 'import type { Snapshot } from "../../bridge/src/protocol";\n' },
    /^packages\/appearance\/src\/contracts\.ts:1: .*appearance contracts/,
  );
  assertViolation(
    { "packages/appearance/src/contracts.ts": 'import type { Snapshot } from "@kauak/bridge/protocol.js";\n' },
    /^packages\/appearance\/src\/contracts\.ts:1: .*appearance contracts/,
  );
});

test("the page imports only the protocol's types from the bridge, and nothing of the CLI", () => {
  const rule = /the page knows the bridge only through the protocol's types/;
  assertViolation(
    { "packages/web/src/main.ts": 'import { ready } from "../../bridge/src/server.js";\n' },
    /^packages\/web\/src\/main\.ts:1: imports "\.\.\/\.\.\/bridge\/src\/server\.js" \(packages\/bridge\/src\/server\.js\): the page knows the bridge/,
  );
  // The protocol's rules are bridge code; only its types may cross.
  assertViolation({ "packages/web/src/main.ts": 'import { ready } from "@kauak/bridge/server.js";\n' }, rule);
  assertViolation({ "packages/web/src/main.ts": 'import { parseClientMessage } from "../../bridge/src/protocol";\n' }, rule);
  assertViolation({ "packages/web/src/main.ts": 'import { AGENT_STATUSES } from "../../bridge/src/protocol.js";\n' }, rule);
  assertViolation({ "packages/web/src/main.ts": 'import { main } from "../../kauak/cli/main.js";\n' }, rule);
  const { status, lines } = check({ "packages/web/src/main.ts": 'import type { AgentStatus } from "../../bridge/src/protocol";\n' });
  assert.equal(status, 0, lines.join("\n"));
});

test("the bridge and the CLI import nothing from the page, and the bridge nothing from the CLI", () => {
  assertViolation(
    { "packages/bridge/src/server.js": 'import { keyOf } from "../../web/src/floors.ts";\n' },
    /^packages\/bridge\/src\/server\.js:1: .*the bridge and the CLI import nothing from the page/,
  );
  assertViolation(
    { "packages/kauak/cli/main.js": 'await import("../../web/src/demo.ts");\n' },
    /^packages\/kauak\/cli\/main\.js:1: .*nothing from the page/,
  );
  assertViolation({ "packages/bridge/src/server.js": 'import { keyOf } from "@kauak/web/src/floors.ts";\n' }, /nothing from the page/);
  assertViolation(
    { "packages/bridge/src/server.js": 'import { UsageError } from "../../kauak/cli/errors.js";\n' },
    /^packages\/bridge\/src\/server\.js:1: .*nothing from the CLI/,
  );
  assertViolation({ "packages/bridge/src/server.js": 'import pkg from "kauak/package.json";\n' }, /nothing from the CLI/);
});

test("a rule whose files are gone fails instead of passing on nothing", () => {
  assertViolation({ "packages/appearance/src/registry.ts": null }, /rule matches no files, update RULES: the appearance registry/);
});

test("dot folders such as .claude/worktrees are not read", () => {
  const { status, lines } = check({
    ".claude/worktrees/feature/packages/bridge/src/server.js": 'import { toSnapshot } from "./herdr.js";\n',
  });
  assert.equal(status, 0, lines.join("\n"));
});
