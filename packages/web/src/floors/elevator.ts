// Elevator panel: one button per floor (machine), top floor first, with
// the floor's connection state and how many of its agents need attention.
// Also owns the "add floor" form. Reads the floors and the floor on screen
// from the page's state (app/state.ts), re-rendering when they change.

import type { AppState } from "../app/state";
import { floorProblem, runtimeOf } from "./floors";
import type { AgentStatus } from "@kauak/protocol";
import "./elevator.css";

export interface ElevatorHandlers {
  onAdd(ssh: string, label: string): boolean;
  onRemove(floor: string): void;
}

export class Elevator {
  private el = document.getElementById("floors")!;
  private list = document.getElementById("floor-list")!;
  private form = document.getElementById("floor-add") as HTMLFormElement;
  private err = this.form.querySelector<HTMLElement>(".err")!;
  private submit = this.form.querySelector<HTMLButtonElement>("button[type=submit]")!;
  private input = this.form.querySelector<HTMLInputElement>("input[name=ssh]")!;
  /** Set by main: true while the terminal panel owns the keyboard. */
  isTyping: () => boolean = () => false;

  constructor(
    private state: AppState,
    private h: ElevatorHandlers,
  ) {
    document.getElementById("floor-add-btn")!.addEventListener("click", () => this.toggleForm(this.form.hidden));
    this.form.querySelector("[data-cancel]")!.addEventListener("click", () => this.toggleForm(false));
    // Capture phase, so Esc closes the form before it can close the terminal panel.
    addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Escape" && !this.form.hidden && !this.isTyping()) {
          e.stopPropagation();
          this.toggleForm(false);
        }
      },
      true,
    );
    this.form.addEventListener("submit", (e) => {
      e.preventDefault();
      const data = new FormData(this.form);
      const ssh = String(data.get("ssh") ?? "").trim();
      if (!ssh) return;
      this.input.focus(); // the submit button is about to be disabled and would drop focus
      if (!this.h.onAdd(ssh, String(data.get("label") ?? "").trim())) {
        this.showError("The bridge is offline. Try again once it reconnects.");
        return;
      }
      this.submit.disabled = true;
      this.showError("");
    });
    this.list.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const rm = target.closest<HTMLElement>("[data-rm]");
      if (rm) {
        const f = this.state.floors().find((x) => x.info.id === rm.dataset.rm);
        if (f && confirm(`Remove floor ${f.number} (${f.info.label})? The machine and its agents are not touched.`))
          this.h.onRemove(f.info.id);
        return;
      }
      const go = target.closest<HTMLElement>("[data-floor]");
      if (go) this.state.goToFloor(go.dataset.floor!);
    });
    addEventListener("keydown", (e) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        this.isTyping() ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey
      )
        return;
      const floors = this.state.floors();
      if (/^[1-9]$/.test(e.key)) {
        const f = floors[Number(e.key) - 1];
        if (f) this.state.goToFloor(f.info.id);
      } else if (e.key === "PageUp" || e.key === "PageDown") {
        e.preventDefault();
        const i = floors.findIndex((f) => f.info.id === this.state.current);
        const next = floors[i + (e.key === "PageUp" ? 1 : -1)];
        if (next) this.state.goToFloor(next.info.id);
      }
    });
    state.subscribe((change) => {
      if (change.type !== "selection") this.render();
    });
  }

  private render() {
    const floors = this.state.floors(),
      current = this.state.current;
    this.list.innerHTML = [...floors]
      .reverse()
      .map((f) => {
        const { info } = f;
        const counts: Partial<Record<AgentStatus, number>> = {};
        let agents = 0;
        for (const p of f.snapshot?.panes ?? [])
          if (p.agent) {
            agents++;
            counts[p.agent_status] = (counts[p.agent_status] ?? 0) + 1;
          }
        const sub =
          info.state === "live"
            ? `${agents} agent${agents === 1 ? "" : "s"}${info.ssh ? ` · ssh ${info.ssh}` : " · this machine"}`
            : floorProblem(info);
        const badges = (["blocked", "done"] as const)
          .filter((s) => counts[s])
          .map((s) => `<b class="badge st-${s}" title="${counts[s]} ${s}">${counts[s]}</b>`)
          .join("");
        const tip = `${f.number}F · ${info.label}${info.runtime.version ? ` · ${runtimeOf(info)}` : ""}\n${info.state}${info.message ? `: ${info.message}` : ""}\nkey ${f.number <= 9 ? f.number : "—"}`;
        return (
          `<div class="floor conn-${info.state} ${info.id === current ? "current" : ""}" role="listitem">` +
          `<button class="go" data-floor="${esc(info.id)}" title="${esc(tip)}" ${info.id === current ? 'aria-current="true"' : ""}>` +
          `<span class="fn">${f.number}F</span><span class="txt"><span class="name">${esc(info.label)}</span><span class="sub">${esc(sub)}</span></span>` +
          `<span class="badges">${badges}<i class="conn-dot"></i></span></button>` +
          (info.id === "local"
            ? ""
            : `<button class="rm" data-rm="${esc(info.id)}" title="Remove this floor" aria-label="Remove floor ${esc(info.label)}">×</button>`) +
          `</div>`
        );
      })
      .join("");
  }

  /** The bridge accepted the new machine. */
  added() {
    this.form.reset();
    this.toggleForm(false);
  }

  showError(message: string) {
    this.submit.disabled = false;
    this.err.textContent = message;
    this.err.hidden = !message;
    if (message) this.input.select();
  }

  private toggleForm(open: boolean) {
    this.form.hidden = !open;
    this.el.classList.toggle("adding", open);
    this.showError("");
    if (open) this.input.focus();
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
}
