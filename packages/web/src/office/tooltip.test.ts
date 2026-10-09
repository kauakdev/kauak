import { expect, test, vi } from "vitest";
import { Tooltip, escapeHtml } from "./tooltip";
import type { PaneInfo } from "@kauak/protocol";

// The tooltip keeps itself inside the window.
vi.stubGlobal("innerWidth", 1280);
vi.stubGlobal("innerHeight", 800);

/** A stand-in for #tip with what the tooltip writes and reads. */
const tipElement = () => ({ style: {}, dataset: {}, innerHTML: "", offsetWidth: 200, offsetHeight: 60 }) as unknown as HTMLElement;
const pane = (focused: boolean): PaneInfo => ({
  pane_id: "local/w1:p1",
  workspace_id: "local/w1",
  focused,
  cwd: "/home/dev/code/kauak",
  title: "fix the tests",
  agent: null,
  agent_status: "unknown",
  screen: null,
  scrollback: false,
  context: null,
});

test("escapeHtml makes names and titles safe to put in a tooltip's HTML or a double-quoted attribute", () => {
  expect(escapeHtml(`<img src=x onerror="alert(1)"> & co`)).toBe("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; co");
  expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  expect(escapeHtml("it's fine · ✓")).toBe("it's fine · ✓");
  expect(escapeHtml("")).toBe("");
});

test("a focused desk's tooltip names what runs its floor, escaped", () => {
  const el = tipElement();
  const tip = new Tooltip(el);
  tip.runtime = "Herdr";
  tip.pane(pane(true), undefined, 10, 10);
  expect(el.innerHTML).toBe(
    '<b>shell</b> · no agent\nfix the tests\n<span class="muted">~/code/kauak\nlocal/w1:p1 · focused in Herdr</span>',
  );
  tip.runtime = "Zellij";
  tip.pane(pane(true), undefined, 10, 10);
  expect(el.innerHTML).toContain("local/w1:p1 · focused in Zellij</span>");
  expect(el.innerHTML).not.toContain("Herdr");
  tip.runtime = "<b>tmux</b>";
  tip.pane(pane(true), undefined, 10, 10);
  expect(el.innerHTML).toContain("· focused in &lt;b&gt;tmux&lt;/b&gt;</span>");
  tip.pane(pane(false), undefined, 10, 10);
  expect(el.innerHTML).toContain("\nlocal/w1:p1</span>");
});
