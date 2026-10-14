import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ContextTracker } from "./context.ts";

/** A live floor with one Claude desk and no session reported for it; `asked` lists the panes whose processes were asked for. */
function floor(reportsContext) {
  const m = Object.assign(new EventEmitter(), {
    id: "f",
    label: "f",
    ssh: null,
    reportsContext,
    state: "live",
    snapshot: { panes: [{ pane_id: "p1", agent: "claude", cwd: "/home/dev/code/x", context: null }] },
    asked: [],
    paneSession: () => null,
    paneProcesses: async (paneId) => {
      m.asked.push(paneId);
      return [];
    },
  });
  return m;
}

test("a runtime that reports its agents' context gets no meters from this machine's transcripts", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kauak-context-test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const settings = { claudeDir: path.join(home, ".claude"), codexDir: path.join(home, ".codex"), sshCommand: "ssh" };
  for (const [reports, asked] of [
    [false, ["p1"]],
    [true, []],
  ]) {
    const m = floor(reports);
    await new ContextTracker(m, settings).update();
    assert.deepEqual(m.asked, asked);
  }
});
