import { expect, test } from "vitest";
import { buildOffice } from "../office/layout";
import { Hud } from "./hud";
import type { PaneInfo, Snapshot, WorkspaceInfo } from "@kauak/protocol";

const workspace = (workspace_id: string, number: number, over: Partial<WorkspaceInfo> = {}): WorkspaceInfo => ({
  workspace_id,
  number,
  label: workspace_id,
  focused: false,
  repo: null,
  git_root: null,
  ...over,
});
const pane = (pane_id: string, workspace_id: string, over: Partial<PaneInfo> = {}): PaneInfo => ({
  pane_id,
  workspace_id,
  focused: false,
  cwd: null,
  title: "",
  agent: null,
  agent_status: "unknown",
  screen: null,
  scrollback: false,
  context: null,
  ...over,
});

/** The roster's sections for a snapshot. The constructor wires the page's elements, which a test has none of, so it is skipped. */
function roster(snap: Snapshot): string {
  const hud = Object.assign(Object.create(Hud.prototype), { order: [], tracked: new Map(), state: { selected: null } });
  return hud.rosterGroups(snap, "Herdr");
}

test("the roster names its sections as the office names its wings, a workspace with only a label too", () => {
  const snap: Snapshot = {
    workspaces: [
      workspace("w1", 1, { repo: { key: "github.com/me/api", name: "api", root: "/src/api", checkout: "/src/api", linked: false } }),
      workspace("w2", 2),
      workspace("w3", 3, { label: "scratch" }),
      workspace("w4", 4, { label: "notes" }),
    ],
    panes: [pane("w1:p1", "w1"), pane("w2:p1", "w2", { cwd: "/home/me/tools" }), pane("w4:p1", "w4")],
  };
  const html = roster(snap);
  const sections = [...html.matchAll(/<h3>(.*?)<\/h3>/g)].map((m) => m[1]);
  expect(sections).toStrictEqual(buildOffice(snap).wings.map((w) => w.name));
  expect(sections).toStrictEqual(["api", "tools", "scratch", "notes"]);
  expect(html).toContain('<section><h3>scratch</h3><div class="room"><span>scratch</span></div></section>');
});
