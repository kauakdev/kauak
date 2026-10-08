// HTML HUD around the canvas: top bar stats, roster, activity feed. Everything
// here is driven by bridge pushes (no per-frame polling); only the relative
// timestamps are refreshed on a slow timer. Stats, roster and feed span every
// floor; the connection chip and the empty state describe the floor on screen.

import { contextLevel, contextPercent, contextText } from "./context";
import { floorOf, floorProblem, runtimeOf, type Floor } from "./floors";
import type { AgentStatus, PaneInfo, Snapshot } from "./types";

const ORDER: AgentStatus[] = ["working", "idle", "blocked", "done", "unknown"];
const MAX_FEED = 40;
const FEED_KEY = "agent-office.feed-hidden";

interface Tracked { status: AgentStatus; agent: string | null; since: number; room: string }
interface FeedItem { at: number; text: string; status: AgentStatus; paneId: string; floor: string }

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
  /** Set by main: true while the terminal panel owns the keyboard. */
  isTyping: () => boolean = () => false;
  private items: FeedItem[] = [];
  private floors: Floor[] = [];
  private current = "";
  private bridgeUp = false;
  /** Floors whose first snapshot arrived; panes already there at start are not news. */
  private seen = new Set<string>();
  private selected: string | null = null;
  private order: string[] = [];

  constructor(private h: HudHandlers) {
    document.getElementById("btn-fit")!.addEventListener("click", () => h.onFit());
    document.getElementById("btn-zoom-in")!.addEventListener("click", () => h.onZoom(1.25));
    document.getElementById("btn-zoom-out")!.addEventListener("click", () => h.onZoom(0.8));
    document.getElementById("btn-roster")!.addEventListener("click", () => document.body.classList.toggle("roster-hidden"));
    document.getElementById("btn-feed")!.addEventListener("click", () => this.toggleFeed());
    document.getElementById("feed-hide")!.addEventListener("click", (e) => { e.stopPropagation(); this.toggleFeed(true); });
    // On phones a hidden feed is a pill; tapping it brings the feed back.
    document.querySelector("#feed header")!.addEventListener("click", () => { if (document.body.classList.contains("feed-hidden")) this.toggleFeed(false); });
    this.toggleFeed(load(FEED_KEY) === "1");
    addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || this.isTyping() || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "f") h.onFit();
      else if (e.key === "r") document.body.classList.toggle("roster-hidden");
      else if (e.key === "a") this.toggleFeed();
      else if (e.key === "j" || e.key === "k" || e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); this.step(e.key === "j" || e.key === "ArrowDown" ? 1 : -1); }
      else if (e.key === "+" || e.key === "=") h.onZoom(1.25);
      else if (e.key === "-") h.onZoom(0.8);
    });
    const tickClock = () => { this.clock.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); };
    tickClock();
    setInterval(tickClock, 15_000);
    setInterval(() => this.refreshTimes(), 10_000);
  }

  /** Whether the WebSocket to the bridge is up. */
  setBridge(up: boolean) {
    this.bridgeUp = up;
    this.renderConn();
  }

  setSelected(paneId: string | null) {
    this.selected = paneId;
    for (const el of this.roster.querySelectorAll<HTMLElement>(".pane")) el.classList.toggle("selected", el.dataset.pane === paneId);
  }

  setFloors(floors: Floor[], current: string) {
    this.floors = floors;
    this.current = current;
    const now = Date.now();
    const live = new Set<string>();
    const present = new Set(floors.map((f) => f.info.id));
    for (const f of floors) {
      const s = f.snapshot;
      if (!s) continue;
      const fresh = !this.seen.has(f.info.id);
      this.seen.add(f.info.id);
      const roomOf = new Map(s.workspaces.map((w) => [w.workspace_id, w.label || w.repo?.name || w.workspace_id]));
      for (const p of s.panes) {
        live.add(p.pane_id);
        const room = roomOf.get(p.workspace_id) ?? "?";
        const t = this.tracked.get(p.pane_id);
        const who = p.agent ?? "shell";
        const item = (text: string, status: AgentStatus) => this.push({ at: now, text, status, paneId: p.pane_id, floor: f.info.id });
        if (!t) {
          this.tracked.set(p.pane_id, { status: p.agent_status, agent: p.agent ?? null, since: now, room });
          if (!fresh && p.agent) item(`${who} joined ${room}`, p.agent_status);
        } else {
          if ((t.agent ?? null) !== (p.agent ?? null) && p.agent) item(`${p.agent} sat down in ${room}`, p.agent_status);
          if (t.status !== p.agent_status) {
            t.since = now;
            item(`${who} in ${room} is now ${p.agent_status}`, p.agent_status);
          }
          t.status = p.agent_status; t.agent = p.agent ?? null; t.room = room;
        }
      }
    }
    for (const [id, t] of [...this.tracked]) {
      if (live.has(id)) continue;
      this.tracked.delete(id);
      // A removed floor takes its panes along quietly.
      const floor = floorOf(id);
      if (t.agent && present.has(floor)) this.push({ at: now, text: `${t.agent} left ${t.room}`, status: "unknown", paneId: id, floor });
    }
    for (const id of [...this.seen]) if (!present.has(id)) this.seen.delete(id);
    const panes = floors.flatMap((f) => f.snapshot?.panes ?? []);
    this.renderStats(panes);
    this.renderRoster();
    this.renderFeed();
    this.renderConn();
  }

  /** Shows or hides the activity feed; remembered across reloads. */
  private toggleFeed(hide = !document.body.classList.contains("feed-hidden")) {
    document.body.classList.toggle("feed-hidden", hide);
    document.getElementById("btn-feed")!.setAttribute("aria-expanded", String(!hide));
    save(FEED_KEY, hide ? "1" : "0");
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

  /** Connection chip and empty state, both about the floor on screen. */
  private renderConn() {
    const conn = document.getElementById("conn")!;
    const f = this.floors.find((x) => x.info.id === this.current);
    let ok = false, text: string;
    if (!this.bridgeUp) {
      text = "bridge offline · retrying";
      this.showEmpty("The bridge is offline", "Start it with npx kauak serve (or pnpm dev in a checkout). This page reconnects on its own.");
    } else if (!f) {
      text = "connecting…";
      this.empty.hidden = true;
    } else if (f.info.state === "down") {
      text = `${f.info.label} unreachable`;
      this.showEmpty(`Floor ${f.number} · ${f.info.label} is unreachable`, `${(f.info.message || "Herdr did not answer").replace(/\.?$/, ".")} Retrying on its own.`);
    } else if (!f.snapshot) {
      text = "connecting…";
      this.showEmpty(`Taking the elevator to ${f.info.label}…`, f.info.message || "Waiting for Herdr.");
    } else {
      ok = f.info.state === "live";
      text = `${f.number}F · ${runtimeOf(f.info)}`;
      if (f.snapshot.panes.length === 0) this.showEmpty(`Floor ${f.number} is empty`, `Open a workspace or pane in Herdr${f.info.ssh ? ` on ${f.info.label}` : ""} and it will appear here.`);
      else this.empty.hidden = true;
    }
    conn.classList.toggle("ok", ok);
    conn.classList.toggle("bad", !ok);
    document.getElementById("conn-text")!.textContent = text;
  }

  private renderStats(panes: PaneInfo[]) {
    const counts: Record<AgentStatus, number> = { working: 0, idle: 0, blocked: 0, done: 0, unknown: 0 };
    let agents = 0;
    for (const p of panes) if (p.agent) { agents++; counts[p.agent_status]++; }
    const chips = [`<span class="chip"><b>${agents}</b> agent${agents === 1 ? "" : "s"} · <b>${panes.length}</b> pane${panes.length === 1 ? "" : "s"}</span>`];
    for (const st of ORDER) {
      if (st === "unknown" && counts[st] === 0) continue;
      chips.push(`<span class="chip st-${st} ${counts[st] === 0 ? "zero" : ""}"><i class="dot"></i>${counts[st]} ${st}</span>`);
    }
    this.stats.innerHTML = chips.join("");
    document.title = counts.blocked > 0 ? `(${counts.blocked} blocked) kauak` : "kauak";
  }

  private renderRoster() {
    this.order = [];
    const many = this.floors.length > 1;
    const html: string[] = [];
    // Top floor first, like the elevator.
    for (const f of [...this.floors].reverse()) {
      const state = floorProblem(f.info);
      if (many) {
        html.push(`<h2 class="floor-h conn-${f.info.state} ${f.info.id === this.current ? "current" : ""}"><span class="fn">${f.number}F</span>` +
          `<span class="name">${esc(f.info.label)}</span>${state ? `<span class="state" title="${esc(f.info.message)}">${esc(state)}</span>` : ""}</h2>`);
      }
      if (f.snapshot) html.push(`<div class="floor-body conn-${f.info.state}">${this.rosterGroups(f.snapshot)}</div>`);
    }
    this.roster.innerHTML = html.join("");
    for (const el of this.roster.querySelectorAll<HTMLElement>(".pane")) el.addEventListener("click", () => this.h.onSelect(el.dataset.pane!));
  }

  private rosterGroups(s: Snapshot): string {
    const byWs = new Map<string, PaneInfo[]>();
    for (const p of s.panes) byWs.set(p.workspace_id, [...(byWs.get(p.workspace_id) ?? []), p]);
    const groups = new Map<string, { name: string; rows: string[] }>();
    for (const ws of [...s.workspaces].sort((a, b) => a.number - b.number)) {
      const panes = byWs.get(ws.workspace_id) ?? [];
      const key = ws.repo?.key ?? `dir:${panes[0]?.cwd ?? ws.label}`;
      const name = ws.repo?.name ?? (panes[0]?.cwd?.split("/").pop() || "loose");
      const g = groups.get(key) ?? { name, rows: [] };
      g.rows.push(`<div class="room"><span>${esc(ws.label || ws.workspace_id)}</span>${ws.focused ? '<em title="focused in Herdr">●</em>' : ""}</div>`);
      for (const p of panes) {
        this.order.push(p.pane_id);
        const t = this.tracked.get(p.pane_id);
        const title = p.title || p.cwd?.split("/").pop() || p.pane_id;
        g.rows.push(
          `<button class="pane st-${p.agent_status} ${p.pane_id === this.selected ? "selected" : ""}" data-pane="${esc(p.pane_id)}">` +
          `<i class="dot"></i><span class="kind">${esc(p.agent ?? "shell")}</span><span class="title">${esc(title)}</span>${contextMeter(p)}` +
          `<span class="age" data-since="${t?.since ?? Date.now()}">${ago(t?.since ?? Date.now())}</span></button>`,
        );
      }
      groups.set(key, g);
    }
    return [...groups.values()].map((g) => `<section><h3>${esc(g.name)}</h3>${g.rows.join("")}</section>`).join("");
  }

  private renderFeed() {
    if (this.items.length === 0) { this.feed.innerHTML = `<div class="quiet">Quiet so far. Status changes show up here.</div>`; return; }
    const many = this.floors.length > 1;
    const numberOf = new Map(this.floors.map((f) => [f.info.id, f.number]));
    this.feed.innerHTML = this.items.slice(0, 12).map((it) => {
      const n = numberOf.get(it.floor);
      const tag = many && n ? `<b class="fl">${n}F</b>` : "";
      return `<button class="ev st-${it.status}" data-pane="${esc(it.paneId)}"><i class="dot"></i><span>${tag}${esc(it.text)}</span><time data-since="${it.at}">${ago(it.at)}</time></button>`;
    }).join("");
    for (const el of this.feed.querySelectorAll<HTMLElement>(".ev")) el.addEventListener("click", () => {
      if (this.tracked.has(el.dataset.pane!)) this.h.onSelect(el.dataset.pane!);
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

/** The pane's context meter, or an empty cell to keep the row's grid. */
function contextMeter(p: PaneInfo): string {
  const c = p.context;
  if (!c) return "<span></span>";
  return `<span class="ctx ${contextLevel(c)}" title="Context: ${esc(contextText(c))}"><i style="width:${contextPercent(c)}"></i></span>`;
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

// localStorage can be missing or throw (private windows, blocked site data).
function load(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function save(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch {}
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
}
