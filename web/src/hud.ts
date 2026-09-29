// HTML HUD around the canvas: top bar stats, roster, activity feed. Everything
// here is driven by snapshot pushes (no per-frame polling); only the relative
// timestamps are refreshed on a slow timer.

import type { AgentStatus, PaneInfo, Snapshot } from "./types";

const ORDER: AgentStatus[] = ["working", "idle", "blocked", "done", "unknown"];
const MAX_FEED = 40;

interface Tracked { status: AgentStatus; agent: string | null; since: number; room: string }
interface FeedItem { at: number; text: string; status: AgentStatus; paneId: string }

export interface HudHandlers {
  onSelect(paneId: string): void;
  onFit(): void;
  onZoom(factor: number): void;
}

export class Hud {
  private roster = document.getElementById("roster-body")!;
  private feed = document.getElementById("feed-body")!;
  private stats = document.getElementById("stats")!;
  private clock = document.getElementById("clock")!;
  private empty = document.getElementById("empty")!;
  private tracked = new Map<string, Tracked>();
  private items: FeedItem[] = [];
  private snapshot: Snapshot | null = null;
  private selected: string | null = null;
  private order: string[] = [];

  constructor(private h: HudHandlers) {
    document.getElementById("btn-fit")!.addEventListener("click", () => h.onFit());
    document.getElementById("btn-zoom-in")!.addEventListener("click", () => h.onZoom(1.25));
    document.getElementById("btn-zoom-out")!.addEventListener("click", () => h.onZoom(0.8));
    document.getElementById("btn-roster")!.addEventListener("click", () => document.body.classList.toggle("roster-hidden"));
    addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "f") h.onFit();
      else if (e.key === "r") document.body.classList.toggle("roster-hidden");
      else if (e.key === "j" || e.key === "k" || e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); this.step(e.key === "j" || e.key === "ArrowDown" ? 1 : -1); }
      else if (e.key === "+" || e.key === "=") h.onZoom(1.25);
      else if (e.key === "-") h.onZoom(0.8);
    });
    const tickClock = () => { this.clock.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); };
    tickClock();
    setInterval(tickClock, 15_000);
    setInterval(() => this.refreshTimes(), 10_000);
  }

  setStatus(ok: boolean, text: string) {
    const conn = document.getElementById("conn")!;
    conn.classList.toggle("ok", ok);
    conn.classList.toggle("bad", !ok);
    document.getElementById("conn-text")!.textContent = text;
    if (!ok) this.showEmpty("Herdr is unreachable", text);
  }

  setSelected(paneId: string | null) {
    this.selected = paneId;
    for (const el of this.roster.querySelectorAll<HTMLElement>(".pane")) el.classList.toggle("selected", el.dataset.pane === paneId);
  }

  setSnapshot(s: Snapshot) {
    const now = Date.now();
    const prevSnap = this.snapshot;
    this.snapshot = s;
    const roomOf = new Map(s.workspaces.map((w) => [w.workspace_id, w.label || w.worktree?.repo_name || w.workspace_id]));
    const live = new Set<string>();
    for (const p of s.panes) {
      live.add(p.pane_id);
      const room = roomOf.get(p.workspace_id) ?? "?";
      const t = this.tracked.get(p.pane_id);
      const who = p.agent ?? "shell";
      if (!t) {
        this.tracked.set(p.pane_id, { status: p.agent_status, agent: p.agent ?? null, since: now, room });
        if (prevSnap && p.agent) this.push({ at: now, text: `${who} joined ${room}`, status: p.agent_status, paneId: p.pane_id });
      } else {
        if ((t.agent ?? null) !== (p.agent ?? null) && p.agent) this.push({ at: now, text: `${p.agent} sat down in ${room}`, status: p.agent_status, paneId: p.pane_id });
        if (t.status !== p.agent_status) {
          t.since = now;
          this.push({ at: now, text: `${who} in ${room} is now ${p.agent_status}`, status: p.agent_status, paneId: p.pane_id });
        }
        t.status = p.agent_status; t.agent = p.agent ?? null; t.room = room;
      }
    }
    for (const [id, t] of [...this.tracked]) {
      if (!live.has(id)) { this.tracked.delete(id); if (t.agent) this.push({ at: now, text: `${t.agent} left ${t.room}`, status: "unknown", paneId: id }); }
    }
    this.renderStats(s);
    this.renderRoster(s);
    this.renderFeed();
    if (s.panes.length === 0) this.showEmpty("The office is empty", "Open a workspace or pane in Herdr and it will appear here.");
    else this.empty.hidden = true;
  }

  // ------------------------------------------------------------ pieces

  private showEmpty(title: string, body: string) {
    this.empty.hidden = false;
    this.empty.querySelector("h2")!.textContent = title;
    this.empty.querySelector("p")!.textContent = body;
  }

  private push(item: FeedItem) {
    this.items.unshift(item);
    if (this.items.length > MAX_FEED) this.items.length = MAX_FEED;
  }

  private renderStats(s: Snapshot) {
    const counts: Record<AgentStatus, number> = { working: 0, idle: 0, blocked: 0, done: 0, unknown: 0 };
    let agents = 0;
    for (const p of s.panes) if (p.agent) { agents++; counts[p.agent_status]++; }
    const chips = [`<span class="chip"><b>${agents}</b> agent${agents === 1 ? "" : "s"} · <b>${s.panes.length}</b> pane${s.panes.length === 1 ? "" : "s"}</span>`];
    for (const st of ORDER) {
      if (st === "unknown" && counts[st] === 0) continue;
      chips.push(`<span class="chip st-${st} ${counts[st] === 0 ? "zero" : ""}"><i class="dot"></i>${counts[st]} ${st}</span>`);
    }
    this.stats.innerHTML = chips.join("");
    document.title = counts.blocked > 0 ? `(${counts.blocked} blocked) Agent Office` : "Agent Office";
  }

  private renderRoster(s: Snapshot) {
    const byWs = new Map<string, PaneInfo[]>();
    for (const p of s.panes) byWs.set(p.workspace_id, [...(byWs.get(p.workspace_id) ?? []), p]);
    const groups = new Map<string, { name: string; rows: string[] }>();
    this.order = [];
    for (const ws of [...s.workspaces].sort((a, b) => a.number - b.number)) {
      const panes = byWs.get(ws.workspace_id) ?? [];
      const key = ws.worktree?.repo_key ?? `dir:${panes[0]?.cwd ?? ws.label}`;
      const name = ws.worktree?.repo_name ?? (panes[0]?.cwd.split("/").pop() || "loose");
      const g = groups.get(key) ?? { name, rows: [] };
      g.rows.push(`<div class="room"><span>${esc(ws.label || ws.workspace_id)}</span>${ws.focused ? '<em title="focused in Herdr">●</em>' : ""}</div>`);
      for (const p of panes) {
        this.order.push(p.pane_id);
        const t = this.tracked.get(p.pane_id);
        const title = p.terminal_title_stripped || p.terminal_title || (p.foreground_cwd || p.cwd).split("/").pop() || p.pane_id;
        g.rows.push(
          `<button class="pane st-${p.agent_status} ${p.pane_id === this.selected ? "selected" : ""}" data-pane="${esc(p.pane_id)}">` +
          `<i class="dot"></i><span class="kind">${esc(p.agent ?? "shell")}</span><span class="title">${esc(title)}</span>` +
          `<span class="age" data-since="${t?.since ?? Date.now()}">${ago(t?.since ?? Date.now())}</span></button>`,
        );
      }
      groups.set(key, g);
    }
    this.roster.innerHTML = [...groups.values()].map((g) => `<section><h3>${esc(g.name)}</h3>${g.rows.join("")}</section>`).join("");
    for (const el of this.roster.querySelectorAll<HTMLElement>(".pane")) el.addEventListener("click", () => this.h.onSelect(el.dataset.pane!));
  }

  private renderFeed() {
    if (this.items.length === 0) { this.feed.innerHTML = `<div class="quiet">Quiet so far. Status changes show up here.</div>`; return; }
    this.feed.innerHTML = this.items.slice(0, 12).map((it) =>
      `<button class="ev st-${it.status}" data-pane="${esc(it.paneId)}"><i class="dot"></i><span>${esc(it.text)}</span><time data-since="${it.at}">${ago(it.at)}</time></button>`).join("");
    for (const el of this.feed.querySelectorAll<HTMLElement>(".ev")) el.addEventListener("click", () => {
      if (this.snapshot?.panes.some((p) => p.pane_id === el.dataset.pane)) this.h.onSelect(el.dataset.pane!);
    });
  }

  private refreshTimes() {
    for (const el of document.querySelectorAll<HTMLElement>("[data-since]")) el.textContent = ago(Number(el.dataset.since));
  }

  private step(dir: number) {
    if (this.order.length === 0) return;
    const i = this.order.indexOf(this.selected ?? "");
    const next = i === -1 ? (dir > 0 ? 0 : this.order.length - 1) : (i + dir + this.order.length) % this.order.length;
    this.h.onSelect(this.order[next]!);
  }
}

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
}
