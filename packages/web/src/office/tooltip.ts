// The office's tooltip: one HTML element (#tip) that follows the pointer over a
// desk, a room's printer or a build-mode slot, coloured by what it describes.

import { contextText } from "../app/context";
import { escapeHtml } from "../app/html";
import type { Prints } from "../printers/prints";
import { whereabouts, type Roam } from "./roam";
import type { PaneInfo } from "@kauak/protocol";

export class Tooltip {
  /** What runs the floor drawn ("Herdr"), for a focused pane. */
  runtime = "";

  constructor(private tip: HTMLElement) {}

  hide() {
    this.tip.style.display = "none";
  }

  /** A desk: its agent and status, where the agent is when away (`roam`), the pane's title, context and folder. */
  pane(pane: PaneInfo, roam: Roam | undefined, x: number, y: number) {
    const away = pane.agent ? whereabouts(roam) : null;
    const who = pane.agent
      ? `<b>${escapeHtml(pane.agent)}</b> · ${pane.agent_status}${away ? ` · ${away}` : ""}`
      : "<b>shell</b> · no agent";
    const context = pane.context ? `\ncontext: ${contextText(pane.context)}` : "";
    this.place(
      `${who}\n${escapeHtml(pane.title)}${context}\n<span class="muted">${escapeHtml(shortPath(pane.cwd ?? ""))}\n${pane.pane_id}${pane.focused ? ` · focused in ${escapeHtml(this.runtime)}` : ""}</span>`,
      pane.agent_status,
      x,
      y,
    );
  }

  /** A room's printer (`key`): how many sheets it holds and the latest one. */
  printer(prints: Prints | null, key: string, x: number, y: number) {
    const count = prints?.printedCount(key) ?? 0,
      unread = prints?.unread(key) ?? 0;
    const latest = prints?.latest(key);
    const head = `<b>Printer</b> · ${count ? `${count} sheet${count === 1 ? "" : "s"}` : "nothing printed yet"}${unread ? ` · ${unread} new` : ""}`;
    const body = latest
      ? `\nlatest: ${escapeHtml(latest.path)} <span class="add">+${latest.added}</span> <span class="del">−${latest.removed}</span>\n<span class="muted">click to read, or to see everything uncommitted</span>`
      : '\nPrints a sheet each time a file here changes.\n<span class="muted">click to see everything uncommitted</span>';
    this.place(head + body, "print", x, y);
  }

  /** A build-mode slot; `html` says what it adds. */
  build(html: string, x: number, y: number) {
    this.place(html, "build", x, y);
  }

  private place(html: string, status: string, x: number, y: number) {
    this.tip.dataset.status = status;
    this.tip.innerHTML = html;
    this.tip.style.display = "block";
    const pad = 14;
    this.tip.style.left = `${Math.min(x + pad, innerWidth - this.tip.offsetWidth - pad)}px`;
    this.tip.style.top = `${Math.min(y + pad, innerHeight - this.tip.offsetHeight - pad)}px`;
  }
}

function shortPath(p: string): string {
  return p.replace(/^\/home\/[^/]+/, "~");
}
