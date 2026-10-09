import { describe, expect, test } from "vitest";
import { Prints, printerOf } from "./prints";
import type { DiffSheet, WorkspaceInfo } from "@kauak/protocol";

// Prints keeps sheets in the order they come and never reads the clock, so `at` is only data here.
let made = 0;
const sheet = (root: string, id = `s${++made}`): DiffSheet => ({
  id,
  root,
  at: 1_700_000_000_000 + made,
  path: "src/index.ts",
  change: "modified",
  added: 1,
  removed: 0,
  diff: "@@ -1 +1 @@\n-a\n+b",
  truncated: false,
});
const ids = (sheets: DiffSheet[]) => sheets.map((s) => s.id);
const workspace = (workspace_id: string, git_root: string | null): WorkspaceInfo => ({
  workspace_id,
  number: 1,
  label: "api",
  focused: false,
  repo: null,
  git_root,
});

test("a room's printer is its floor and checkout; a room outside git has none", () => {
  expect(printerOf(workspace("devbox/w1", "/src/api"))).toBe("devbox//src/api");
  expect(printerOf(workspace("local/w/2", "/src/api"))).toBe("local//src/api");
  expect(printerOf(workspace("devbox/w1", null))).toBe(null);
  expect(printerOf(workspace("devbox/w1", ""))).toBe(null);
});

describe("Prints", () => {
  test("sheets a floor already had on connecting are on the tray, read, with nothing queued", () => {
    const prints = new Prints();
    prints.reset("devbox", [sheet("/src/api", "a"), sheet("/src/web", "b"), sheet("/src/api", "c")]);
    expect(ids(prints.printed("devbox//src/api"))).toStrictEqual(["a", "c"]);
    expect(ids(prints.printed("devbox//src/web"))).toStrictEqual(["b"]);
    expect(prints.printedCount("devbox//src/api")).toBe(2);
    expect(prints.queuedCount("devbox//src/api")).toBe(0);
    expect(prints.latest("devbox//src/api")?.id).toBe("c");
    expect(prints.unread("devbox//src/api")).toBe(0);
  });

  test("an unknown printer is empty", () => {
    const prints = new Prints();
    expect(prints.printed("nas//src/api")).toStrictEqual([]);
    expect(prints.printedCount("nas//src/api")).toBe(0);
    expect(prints.queuedCount("nas//src/api")).toBe(0);
    expect(prints.latest("nas//src/api")).toBe(null);
    expect(prints.unread("nas//src/api")).toBe(0);
  });

  test("live sheets queue, and come out on the tray one at a time, oldest first", () => {
    const prints = new Prints();
    const key = "devbox//src/api";
    prints.reset("devbox", [sheet("/src/api", "old")]);
    prints.add("devbox", sheet("/src/api", "n1"));
    prints.add("devbox", sheet("/src/api", "n2"));
    prints.add("devbox", sheet("/src/api", "n3"));
    expect(prints.queuedCount(key)).toBe(3);
    expect(ids(prints.printed(key))).toStrictEqual(["old"]);
    expect(prints.latest(key)?.id).toBe("old");

    prints.done(key);
    expect(prints.queuedCount(key)).toBe(2);
    expect(ids(prints.printed(key))).toStrictEqual(["old", "n1"]);
    expect(prints.latest(key)?.id).toBe("n1");

    prints.done(key, true);
    expect(prints.queuedCount(key)).toBe(0);
    expect(ids(prints.printed(key))).toStrictEqual(["old", "n1", "n2", "n3"]);
    expect(prints.latest(key)?.id).toBe("n3");

    // Nothing left to print: done changes nothing.
    prints.done(key);
    prints.done("nas//src/api");
    expect(prints.printedCount(key)).toBe(4);
    expect(prints.queuedCount("nas//src/api")).toBe(0);
  });

  test("only printed live sheets count as unread, until they are read", () => {
    const prints = new Prints();
    const key = "devbox//src/api";
    prints.reset("devbox", [sheet("/src/api", "old")]);
    prints.add("devbox", sheet("/src/api", "n1"));
    prints.add("devbox", sheet("/src/api", "n2"));
    expect(prints.unread(key)).toBe(0);
    prints.done(key);
    expect(prints.unread(key)).toBe(1);
    prints.done(key);
    expect(prints.unread(key)).toBe(2);
    prints.markRead("n1");
    expect(prints.unread(key)).toBe(1);
    prints.markRead("n2");
    prints.markRead("n2");
    expect(prints.unread(key)).toBe(0);
  });

  test("a printer keeps its newest 50 sheets, and never queues more than it holds", () => {
    const prints = new Prints();
    const key = "devbox//src/api";
    prints.reset(
      "devbox",
      Array.from({ length: 45 }, (_, i) => sheet("/src/api", `old${i}`)),
    );
    for (let i = 0; i < 60; i++) prints.add("devbox", sheet("/src/api", `new${i}`));
    expect(prints.printedCount(key) + prints.queuedCount(key)).toBe(50);
    expect(prints.queuedCount(key)).toBe(50);
    expect(prints.printed(key)).toStrictEqual([]);
    expect(prints.latest(key)).toBe(null);
    prints.done(key, true);
    expect(ids(prints.printed(key))).toStrictEqual(Array.from({ length: 50 }, (_, i) => `new${i + 10}`));
  });

  test("dropping the oldest sheets keeps the queue on the newest", () => {
    const prints = new Prints();
    const key = "devbox//src/api";
    prints.reset(
      "devbox",
      Array.from({ length: 49 }, (_, i) => sheet("/src/api", `old${i}`)),
    );
    prints.add("devbox", sheet("/src/api", "n1"));
    prints.add("devbox", sheet("/src/api", "n2"));
    expect(prints.queuedCount(key)).toBe(2);
    expect(prints.printedCount(key)).toBe(48);
    expect(prints.printed(key)[0]?.id).toBe("old1");
    expect(prints.latest(key)?.id).toBe("old48");
  });

  test("reconnecting a floor replaces its printers, queue and all, and leaves other floors alone", () => {
    const prints = new Prints();
    prints.reset("devbox", [sheet("/src/api", "a")]);
    prints.reset("nas", [sheet("/src/api", "b")]);
    prints.add("devbox", sheet("/src/web", "live"));
    prints.add("nas", sheet("/src/api", "nas-live"));
    prints.reset("devbox", [sheet("/src/api", "a2")]);
    expect(ids(prints.printed("devbox//src/api"))).toStrictEqual(["a2"]);
    expect(prints.printed("devbox//src/web")).toStrictEqual([]);
    expect(prints.queuedCount("devbox//src/web")).toBe(0);
    expect(ids(prints.printed("nas//src/api"))).toStrictEqual(["b"]);
    expect(prints.queuedCount("nas//src/api")).toBe(1);
  });

  test("a sheet that was read stays read after the floor reconnects", () => {
    const prints = new Prints();
    const key = "devbox//src/api";
    prints.add("devbox", sheet("/src/api", "n1"));
    prints.done(key);
    expect(prints.unread(key)).toBe(1);
    prints.reset("devbox", []);
    prints.add("devbox", sheet("/src/api", "n1"));
    prints.done(key);
    expect(prints.unread(key)).toBe(1);
    prints.markRead("n1");
    prints.reset("devbox", []);
    prints.add("devbox", sheet("/src/api", "n1"));
    prints.done(key);
    expect(prints.unread(key)).toBe(0);
  });
});
