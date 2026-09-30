// Build mode: the top-bar Build button (B) shows "+" slots in the office
// (scene.ts), and clicking one opens this form. It asks Herdr, through the
// bridge, for a new desk (a new tab in the room) or a new room (a git
// worktree on a new branch, or a workspace in a folder), with an optional
// agent. Once the pane exists the office opens it like any other desk.

import type { BuildTarget } from "./scene";
import type { RoomSpec } from "./types";

// Herdr's agent kinds (`herdr agent`, 0.9.1), the usual ones first.
const COMMON_AGENTS = ["claude", "codex", "gemini", "cursor", "copilot", "opencode"];
const MORE_AGENTS = ["amp", "agy", "cline", "devin", "droid", "grok", "hermes", "kilo", "kimi", "kiro", "letta", "maki",
  "mastracode", "muse", "omp", "pi", "qodercli", "qwen"];
const AGENT_KEY = "agent-office.build.agent";
// Creating a worktree runs git checkout, which can take a while on a big repo.
const REPLY_TIMEOUT_MS = 60_000;
const TOAST_MS = 8000;

type Mode = "desk" | "worktree" | "folder";

export interface BuildHandlers {
  onToggle(on: boolean): void;
  createDesk(workspace: string, agent: string | null, id: number): boolean;
  createRoom(machine: string, room: RoomSpec, agent: string | null, id: number): boolean;
  /** The new desk exists (and is in the latest snapshot): open it. */
  onCreated(pane: string): void;
}

export class BuildMode {
  private btn = document.getElementById("btn-build") as HTMLButtonElement;
  private form = document.getElementById("build-form") as HTMLFormElement;
  private title = document.getElementById("build-title")!;
  private note = this.form.querySelector<HTMLElement>(".note")!;
  private err = this.form.querySelector<HTMLElement>(".err")!;
  private submit = this.form.querySelector<HTMLButtonElement>("button[type=submit]")!;
  private field = (name: string) => this.form.elements.namedItem(name) as HTMLInputElement;
  private agent = this.form.elements.namedItem("agent") as HTMLSelectElement;
  private toast = document.getElementById("toast")!;
  private on = false;
  private target: BuildTarget | null = null;
  private floor = { id: "", label: "", remote: false };
  private mode: Mode = "desk";
  private reqId = 0;
  private pending: number | null = null;
  private timer: number | null = null;
  private toastTimer: number | null = null;
  /** Set by main: true while the terminal panel owns the keyboard. */
  isTyping: () => boolean = () => false;

  constructor(private h: BuildHandlers) {
    this.agent.innerHTML = `<option value="">None (just a shell)</option>` +
      COMMON_AGENTS.map((k) => `<option>${k}</option>`).join("") +
      `<optgroup label="More agents">${MORE_AGENTS.map((k) => `<option>${k}</option>`).join("")}</optgroup>`;
    this.agent.value = load(AGENT_KEY) ?? "";
    if (this.agent.selectedIndex < 0) this.agent.value = "";
    this.btn.addEventListener("click", () => this.toggle(!this.on));
    for (const b of this.form.querySelectorAll("[data-cancel]")) b.addEventListener("click", () => this.close());
    for (const r of this.form.querySelectorAll<HTMLInputElement>("input[name=kind]")) r.addEventListener("change", () => this.setMode(r.value as Mode));
    this.form.addEventListener("submit", (e) => { e.preventDefault(); this.send(); });
    this.toast.addEventListener("click", () => { this.toast.hidden = true; });
    addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (this.isTyping() || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "b") this.toggle(!this.on);
    });
    // Capture phase, so Esc closes the form (or leaves build mode) before the
    // terminal panel sees it. With the panel open, Esc closes the panel first.
    addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || this.isTyping()) return;
      if (!this.form.hidden) { e.stopPropagation(); this.close(); }
      else if (this.on && !document.body.classList.contains("panel-open")) { e.stopPropagation(); this.toggle(false); }
    }, true);
  }

  isOn(): boolean { return this.on; }

  /** True while keyboard focus is in the form, so global shortcuts stay out of the way. */
  hasFocus(): boolean { return this.form.contains(document.activeElement); }

  toggle(on: boolean) {
    if (on === this.on) return;
    this.on = on;
    this.btn.setAttribute("aria-pressed", String(on));
    document.body.classList.toggle("building", on);
    if (!on) this.close();
    this.h.onToggle(on);
  }

  /** Open the form for a slot clicked at screen point (x, y) on `floor`. */
  open(target: BuildTarget, floor: { id: string; label: string; remote: boolean }, x: number, y: number) {
    if (this.pending !== null) return; // one request at a time
    this.target = target;
    this.floor = floor;
    this.form.reset();
    this.agent.value = load(AGENT_KEY) ?? "";
    if (this.agent.selectedIndex < 0) this.agent.value = "";
    if (target.kind === "desk") {
      this.title.textContent = `New desk · ${target.room.workspace.label || target.room.workspace.workspace_id}`;
      this.setMode("desk");
    } else {
      const wing = target.wing;
      const repo = wing?.rooms.find((r) => r.workspace.worktree)?.workspace.worktree?.repo_root;
      const folder = repo ?? wing?.rooms.flatMap((r) => r.desks)[0]?.pane.cwd ?? "";
      this.title.textContent = wing ? `New room · ${wing.name}` : "New room";
      this.field("cwd").value = folder;
      this.setMode(repo ? "worktree" : "folder");
    }
    this.showError("");
    this.form.hidden = false;
    this.place(x, y);
    const first = this.mode === "desk" ? this.agent : this.mode === "worktree" ? this.field("branch") : this.field("cwd");
    first.focus();
  }

  close() {
    this.form.hidden = true;
    this.target = null;
    // A reply still on its way is ignored; the desk shows up in the office anyway.
    this.settle();
  }

  /** The bridge created a desk or room for request `id`. */
  created(pane: string, id: number | undefined) {
    if (id !== this.pending) return;
    this.settle();
    this.form.hidden = true;
    this.h.onCreated(pane);
  }

  /** Request `id` failed; with `pane`, the desk exists but its agent did not start. */
  failed(message: string, id: number | undefined, pane?: string) {
    if (pane) { this.showToast(message); return; }
    if (id !== this.pending) return;
    this.settle();
    this.showError(message);
  }

  // ------------------------------------------------------------ form

  private setMode(mode: Mode) {
    this.mode = mode;
    const tokens = mode === "desk" ? ["desk"] : ["room", mode];
    for (const el of this.form.querySelectorAll<HTMLElement>("[data-for]")) {
      const shown = el.dataset.for!.split(" ").some((t) => tokens.includes(t));
      el.hidden = !shown;
      for (const input of el.querySelectorAll<HTMLInputElement>("input[data-required]")) input.required = shown;
    }
    for (const r of this.form.querySelectorAll<HTMLInputElement>("input[name=kind]")) r.checked = r.value === mode;
    this.field("cwd").previousElementSibling!.textContent = mode === "worktree" ? "Repository" : "Folder";
    this.field("cwd").placeholder = this.floor.remote ? "/home/you/code/project" : "~/code/project";
    this.note.textContent = mode === "desk"
      ? `Opens a new tab in this room in Herdr. An agent must be installed on ${this.floor.label} to start.`
      : mode === "worktree"
        ? "Creates a git worktree on a new branch (in ~/.herdr/worktrees) and opens it as a room."
        : `Opens a Herdr workspace in that folder${this.floor.remote ? ` on ${this.floor.label} (absolute path)` : ""}.`;
  }

  private send() {
    const target = this.target;
    if (!target || this.pending !== null) return;
    const agent = this.agent.value || null;
    save(AGENT_KEY, this.agent.value);
    const id = ++this.reqId;
    const value = (name: string) => this.field(name).value.trim();
    let ok: boolean;
    if (target.kind === "desk") {
      ok = this.h.createDesk(target.room.workspace.workspace_id, agent, id);
    } else {
      const label = value("label") || undefined;
      const room: RoomSpec = this.mode === "worktree"
        ? { kind: "worktree", cwd: value("cwd"), branch: value("branch"), base: value("base") || undefined, label }
        : { kind: "folder", cwd: value("cwd"), label };
      ok = this.h.createRoom(this.floor.id, room, agent, id);
    }
    if (!ok) { this.showError("The bridge is offline. Try again once it reconnects."); return; }
    this.pending = id;
    this.submit.disabled = true;
    this.submit.textContent = "Creating…";
    this.showError("");
    this.timer = window.setTimeout(() => this.failed("No answer from the bridge. Check Herdr, then try again.", id), REPLY_TIMEOUT_MS);
  }

  /** No request in flight any more. */
  private settle() {
    this.pending = null;
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    this.submit.disabled = false;
    this.submit.textContent = "Create";
  }

  private showError(message: string) {
    this.err.textContent = message;
    this.err.hidden = !message;
  }

  /** Next to the click, kept on screen; centered under the top bar on narrow screens. */
  private place(x: number, y: number) {
    const w = this.form.offsetWidth, h = this.form.offsetHeight, pad = 12;
    const narrow = innerWidth < 600;
    this.form.style.left = `${narrow ? (innerWidth - w) / 2 : Math.max(pad, Math.min(x + 16, innerWidth - w - pad))}px`;
    this.form.style.top = `${narrow ? 64 : Math.max(64, Math.min(y - 24, innerHeight - h - pad))}px`;
  }

  private showToast(message: string) {
    this.toast.textContent = message;
    this.toast.hidden = false;
    if (this.toastTimer !== null) clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => { this.toast.hidden = true; }, TOAST_MS);
  }
}

// localStorage can be missing or throw (private windows, blocked site data).
function load(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function save(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch {}
}
