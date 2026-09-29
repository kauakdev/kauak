// PixiJS isometric rendering of the office. Everything is drawn procedurally
// with Graphics for now, so sprites can replace individual draw* functions later.

import { Application, Container, Graphics, Text, TextStyle } from "pixi.js";
import { TILE_H, TILE_W, depth, shade, toScreen } from "./iso";
import { buildOffice, type Desk, type Office, type Room, type Wing } from "./layout";
import type { AgentStatus, PaneInfo, Snapshot } from "./types";

// ------------------------------------------------------------------ palette

const STATUS_COLOR: Record<AgentStatus, number> = {
  working: 0x5ad87a,
  idle: 0x8fb4ff,
  blocked: 0xff6b6b,
  done: 0xffd166,
  unknown: 0x7a7f93,
};

// Character body color per agent kind; unknown kinds get a hashed color.
const KIND_COLOR: Record<string, number> = {
  claude: 0xd97757,
  codex: 0x2ec4b6,
  gemini: 0x6f7bf7,
  cursor: 0xe0e0e0,
  copilot: 0x9b7bff,
  opencode: 0xf4a261,
};

function kindColor(kind: string | null | undefined): number {
  if (!kind) return 0x9aa0b4;
  if (KIND_COLOR[kind]) return KIND_COLOR[kind]!;
  let h = 0;
  for (const ch of kind) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return 0x404040 + (h & 0xbfbfbf);
}

const FLOOR = 0x3a3f55;
const FLOOR_ALT = 0x353a4e;
const FLOOR_FOCUSED = 0x46507a;
const WALL_COLOR = 0x5a6080;
const DESK_COLOR = 0x8b6b4a;
const CHAIR_COLOR = 0x2b2e3b;

const labelStyle = new TextStyle({ fill: 0xe8e9f0, fontSize: 13, fontFamily: "ui-sans-serif, system-ui, sans-serif", fontWeight: "600" });
const subStyle = new TextStyle({ fill: 0xaab0c8, fontSize: 11, fontFamily: "ui-sans-serif, system-ui, sans-serif" });
const wingStyle = new TextStyle({ fill: 0xffd166, fontSize: 15, fontFamily: "ui-sans-serif, system-ui, sans-serif", fontWeight: "700", letterSpacing: 1 });
const bubbleStyle = new TextStyle({ fill: 0x111111, fontSize: 13, fontWeight: "800", fontFamily: "ui-sans-serif, system-ui, sans-serif" });

// ------------------------------------------------------------------ primitives

function floorTile(g: Graphics, x: number, y: number, color: number) {
  const a = toScreen(x, y), b = toScreen(x + 1, y), c = toScreen(x + 1, y + 1), d = toScreen(x, y + 1);
  g.poly([a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y]).fill(color).stroke({ color: shade(color, 0.8), width: 1 });
}

/** Axis-aligned iso box with its base at tile (x,y) of size (w,d) and height h px. */
function box(g: Graphics, x: number, y: number, w: number, d: number, h: number, color: number) {
  const top = [toScreen(x, y, h), toScreen(x + w, y, h), toScreen(x + w, y + d, h), toScreen(x, y + d, h)];
  const bl = toScreen(x, y + d), br = toScreen(x + w, y + d), bb = toScreen(x + w, y + d);
  // left face
  g.poly([top[3]!.x, top[3]!.y, top[2]!.x, top[2]!.y, br.x, br.y, bl.x, bl.y]).fill(shade(color, 0.7));
  // right face
  const r0 = toScreen(x + w, y);
  g.poly([top[2]!.x, top[2]!.y, top[1]!.x, top[1]!.y, r0.x, r0.y, bb.x, bb.y]).fill(shade(color, 0.85));
  // top
  g.poly(top.flatMap((p) => [p.x, p.y])).fill(color);
}

// ------------------------------------------------------------------ characters

interface CharState {
  phase: number;                 // animation clock (s)
  status: AgentStatus;
  lastChange: number;            // ms since epoch when status last changed
}

interface CharNode {
  root: Container;
  body: Graphics;
  hands: Graphics;
  bubble: Container;
  bubbleBg: Graphics;
  glyphs: Container;
  desk: Desk;
  state: CharState;
  baseY: number;
}

const GLYPH_CHARS = ["{", "}", ";", "=>", "()", "fn", "if", "λ", "0x", "//"];

function makeCharacter(desk: Desk, state: CharState): CharNode {
  const pane = desk.pane;
  const root = new Container();
  const color = kindColor(pane.agent);

  // Chair behind the desk
  const chair = new Graphics();
  box(chair, desk.x + 0.25, desk.y - 0.85, 0.5, 0.5, 10, CHAIR_COLOR);
  root.addChild(chair);

  // Body + head as a single graphic (re-tinted per status via alpha only)
  const body = new Graphics();
  const p = toScreen(desk.x + 0.5, desk.y - 0.55);
  body.ellipse(p.x, p.y - 14, 9, 12).fill(color).stroke({ color: shade(color, 0.6), width: 1 });
  body.circle(p.x, p.y - 32, 7.5).fill(0xf1d3b3).stroke({ color: 0xb08968, width: 1 });
  // eyes
  body.circle(p.x - 2.5, p.y - 33, 1).fill(0x222222);
  body.circle(p.x + 2.5, p.y - 33, 1).fill(0x222222);
  root.addChild(body);

  const hands = new Graphics();
  root.addChild(hands);

  // Desk in front of the person, with a laptop
  const deskG = new Graphics();
  box(deskG, desk.x, desk.y, 1, 0.7, 14, DESK_COLOR);
  // laptop base + screen
  box(deskG, desk.x + 0.3, desk.y + 0.15, 0.4, 0.3, 16, 0x2a2d3a);
  const s0 = toScreen(desk.x + 0.3, desk.y + 0.15, 16), s1 = toScreen(desk.x + 0.7, desk.y + 0.15, 16);
  deskG.poly([s0.x, s0.y, s1.x, s1.y, s1.x, s1.y - 14, s0.x, s0.y - 14]).fill(0x1c1f2b).stroke({ color: 0x444a66, width: 1 });
  const scr = STATUS_COLOR[pane.agent_status];
  deskG.poly([s0.x + 2, s0.y - 2, s1.x - 2, s1.y - 2, s1.x - 2, s1.y - 12, s0.x + 2, s0.y - 12]).fill({ color: scr, alpha: 0.55 });
  root.addChild(deskG);

  // Status bubble above the head
  const bubble = new Container();
  const bubbleBg = new Graphics();
  bubble.addChild(bubbleBg);
  const bubbleText = new Text({ text: "", style: bubbleStyle });
  bubbleText.anchor.set(0.5);
  bubble.addChild(bubbleText);
  bubble.position.set(p.x + 12, p.y - 52);
  root.addChild(bubble);

  const glyphs = new Container();
  root.addChild(glyphs);

  const node: CharNode = { root, body, hands, bubble, bubbleBg, glyphs, desk, state, baseY: p.y };
  applyStatusVisuals(node, bubbleText);
  return node;
}

function applyStatusVisuals(node: CharNode, text: Text) {
  const st = node.state.status;
  const c = STATUS_COLOR[st];
  node.bubbleBg.clear();
  const label = st === "blocked" ? "?" : st === "done" ? "✓" : st === "idle" ? "☕" : st === "unknown" ? "~" : "…";
  node.bubbleBg.roundRect(-11, -11, 22, 22, 6).fill(c).stroke({ color: shade(c, 0.6), width: 1.5 });
  node.bubbleBg.poly([-4, 10, 4, 10, -2, 16]).fill(c);
  text.text = label;
  node.root.alpha = st === "unknown" ? 0.6 : 1;
  node.bubble.visible = st !== "working" || true;
}

function animateCharacter(node: CharNode, dt: number, now: number) {
  const s = node.state;
  s.phase += dt;
  const t = s.phase;
  const p = toScreen(node.desk.x + 0.5, node.desk.y - 0.55);

  node.hands.clear();
  node.glyphs.removeChildren();

  switch (s.status) {
    case "working": {
      // typing: hands bob alternately, glyphs drift up from the laptop
      const l = Math.sin(t * 14) * 1.5, r = Math.sin(t * 14 + Math.PI) * 1.5;
      node.hands.circle(p.x - 6, p.y - 4 + l, 2.5).fill(0xf1d3b3);
      node.hands.circle(p.x + 6, p.y - 4 + r, 2.5).fill(0xf1d3b3);
      node.body.y = Math.sin(t * 3) * 0.6;
      const cycle = (t * 0.9) % 1;
      for (let i = 0; i < 2; i++) {
        const k = (cycle + i * 0.5) % 1;
        const g = new Text({ text: GLYPH_CHARS[(Math.floor(t * 0.9) + i * 3) % GLYPH_CHARS.length]!, style: new TextStyle({ fill: 0x5ad87a, fontSize: 10, fontFamily: "ui-monospace, monospace" }) });
        g.anchor.set(0.5);
        g.position.set(p.x + 18 + Math.sin(k * 6) * 4 + i * 6, p.y - 10 - k * 34);
        g.alpha = 1 - k;
        node.glyphs.addChild(g);
      }
      node.bubble.visible = false;
      break;
    }
    case "idle": {
      node.body.y = Math.sin(t * 1.4) * 1.2;           // breathing
      node.hands.circle(p.x + 7, p.y - 12 + Math.sin(t * 1.4) * 1.2, 2.5).fill(0xf1d3b3);
      node.bubble.visible = true;
      node.bubble.y = p.y - 52;
      node.bubble.alpha = 0.9;
      break;
    }
    case "blocked": {
      const pulse = 1 + Math.sin(t * 5) * 0.12;
      node.bubble.visible = true;
      node.bubble.scale.set(pulse);
      node.bubble.y = p.y - 52;
      // raised hand
      node.hands.circle(p.x + 10, p.y - 30 + Math.sin(t * 5) * 1.5, 2.5).fill(0xf1d3b3);
      node.body.y = 0;
      break;
    }
    case "done": {
      node.bubble.visible = true;
      node.bubble.y = p.y - 52 - Math.abs(Math.sin(t * 3)) * 5;   // little hop
      node.bubble.scale.set(1);
      node.body.y = -Math.abs(Math.sin(t * 3)) * 2;
      break;
    }
    default: {
      node.bubble.visible = true;
      node.bubble.y = p.y - 52;
      node.body.y = 0;
    }
  }

  // Brief flash on status change
  const since = now - s.lastChange;
  if (since < 600) {
    const k = 1 - since / 600;
    node.bubble.scale.set(1 + k * 0.6);
  }
}

// ------------------------------------------------------------------ scene

export class OfficeScene {
  readonly app = new Application();
  readonly world = new Container();
  private floor = new Container();
  private objects = new Container();       // depth-sorted
  private labels = new Container();
  private chars: CharNode[] = [];
  private states = new Map<string, CharState>();
  private blockedRooms: { g: Graphics; base: number }[] = [];
  private fitted = false;
  private tip = document.getElementById("tip")!;
  onSelectPane: (pane: PaneInfo) => void = () => {};

  async init(host: HTMLElement) {
    await this.app.init({ resizeTo: host, antialias: true, background: 0x1b1e2a, resolution: devicePixelRatio, autoDensity: true });
    host.appendChild(this.app.canvas);
    this.objects.sortableChildren = true;
    this.world.addChild(this.floor, this.objects, this.labels);
    this.app.stage.addChild(this.world);
    this.setupCamera();
    this.app.ticker.add((tk) => this.tick(tk.deltaMS / 1000));
  }

  private setupCamera() {
    const stage = this.app.stage;
    stage.eventMode = "static";
    stage.hitArea = { contains: () => true } as never;
    let drag: { x: number; y: number; wx: number; wy: number } | null = null;
    stage.on("pointerdown", (e) => { drag = { x: e.global.x, y: e.global.y, wx: this.world.x, wy: this.world.y }; });
    stage.on("pointerup", () => (drag = null));
    stage.on("pointerupoutside", () => (drag = null));
    stage.on("pointermove", (e) => {
      if (!drag) return;
      this.world.x = drag.wx + (e.global.x - drag.x);
      this.world.y = drag.wy + (e.global.y - drag.y);
    });
    this.app.canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.001);
      const next = Math.min(3, Math.max(0.3, this.world.scale.x * factor));
      const mx = e.offsetX, my = e.offsetY;
      const wx = (mx - this.world.x) / this.world.scale.x, wy = (my - this.world.y) / this.world.scale.y;
      this.world.scale.set(next);
      this.world.x = mx - wx * next;
      this.world.y = my - wy * next;
    }, { passive: false });
  }

  setSnapshot(snap: Snapshot) {
    const office = buildOffice(snap);
    const now = performance.now();
    this.floor.removeChildren();
    this.objects.removeChildren();
    this.labels.removeChildren();
    this.chars = [];
    this.blockedRooms = [];

    for (const wing of office.wings) this.drawWing(wing, snap, now);

    // Drop states for panes that vanished
    const live = new Set(snap.panes.map((p) => p.pane_id));
    for (const id of [...this.states.keys()]) if (!live.has(id)) this.states.delete(id);

    if (!this.fitted && office.w > 0) { this.fit(office); this.fitted = true; }
  }

  private fit(office: Office) {
    const corners = [toScreen(0, 0), toScreen(office.w, 0), toScreen(office.w, office.h), toScreen(0, office.h)];
    const minX = Math.min(...corners.map((c) => c.x)), maxX = Math.max(...corners.map((c) => c.x));
    const minY = Math.min(...corners.map((c) => c.y)) - 80, maxY = Math.max(...corners.map((c) => c.y)) + 20;
    const sw = this.app.screen.width, sh = this.app.screen.height;
    const scale = Math.min(2, Math.max(0.3, Math.min(sw / (maxX - minX + 80), sh / (maxY - minY + 80))));
    this.world.scale.set(scale);
    this.world.x = sw / 2 - ((minX + maxX) / 2) * scale;
    this.world.y = sh / 2 - ((minY + maxY) / 2) * scale;
  }

  private drawWing(wing: Wing, snap: Snapshot, now: number) {
    const t = new Text({ text: wing.name.toUpperCase(), style: wingStyle });
    const p = toScreen(wing.x, wing.y, 0);
    t.anchor.set(0, 1);
    t.position.set(p.x - TILE_W / 2, p.y - 12);
    this.labels.addChild(t);
    for (const room of wing.rooms) this.drawRoom(room, snap, now);
  }

  private drawRoom(room: Room, snap: Snapshot, now: number) {
    const g = new Graphics();
    const anyBlocked = room.desks.some((d) => d.pane.agent_status === "blocked");
    for (let x = room.x; x < room.x + room.w; x++) {
      for (let y = room.y; y < room.y + room.h; y++) {
        const base = (x + y) % 2 === 0 ? FLOOR : FLOOR_ALT;
        floorTile(g, x, y, room.focused ? shade(FLOOR_FOCUSED, ((x + y) % 2 === 0 ? 1 : 0.94)) : base);
      }
    }
    // Low walls along the back two edges (top-left and top-right in screen space)
    const wall = new Graphics();
    box(wall, room.x, room.y - 0.15, room.w, 0.15, 18, WALL_COLOR);
    box(wall, room.x - 0.15, room.y, 0.15, room.h, 18, WALL_COLOR);
    // Room outline; pulses red when someone is blocked
    const outline = new Graphics();
    const c0 = toScreen(room.x, room.y), c1 = toScreen(room.x + room.w, room.y), c2 = toScreen(room.x + room.w, room.y + room.h), c3 = toScreen(room.x, room.y + room.h);
    outline.poly([c0.x, c0.y, c1.x, c1.y, c2.x, c2.y, c3.x, c3.y]).stroke({ color: anyBlocked ? STATUS_COLOR.blocked : (room.focused ? 0xffd166 : 0x6a7090), width: anyBlocked ? 3 : 1.5, alpha: 0.9 });
    if (anyBlocked) this.blockedRooms.push({ g: outline, base: Math.random() * 6 });
    this.floor.addChild(g, wall, outline);

    // Room plaque: workspace label + checkout basename / branch hint
    const wt = room.workspace.worktree;
    const sub = wt ? (wt.is_linked_worktree ? `worktree · ${wt.checkout_path.split("/").pop()}` : "main checkout") : "";
    const label = new Text({ text: room.workspace.label || room.workspace.workspace_id, style: labelStyle });
    const subT = new Text({ text: sub, style: subStyle });
    const lp = toScreen(room.x + room.w / 2, room.y + room.h + 0.1);
    label.anchor.set(0.5, 0); label.position.set(lp.x, lp.y + 2);
    subT.anchor.set(0.5, 0); subT.position.set(lp.x, lp.y + 19);
    this.labels.addChild(label, subT);

    for (const desk of room.desks) this.drawDesk(desk, snap, now);
  }

  private drawDesk(desk: Desk, _snap: Snapshot, now: number) {
    const pane = desk.pane;
    const prev = this.states.get(pane.pane_id);
    const state: CharState = prev
      ? (prev.status === pane.agent_status ? prev : { ...prev, status: pane.agent_status, lastChange: now })
      : { phase: Math.random() * 10, status: pane.agent_status, lastChange: 0 };
    this.states.set(pane.pane_id, state);

    let root: Container;
    if (pane.agent) {
      const node = makeCharacter(desk, state);
      this.chars.push(node);
      root = node.root;
    } else {
      // Empty desk: a plain terminal with a monitor
      const g = new Graphics();
      box(g, desk.x, desk.y, 1, 0.7, 14, shade(DESK_COLOR, 0.8));
      const s0 = toScreen(desk.x + 0.3, desk.y + 0.2, 14), s1 = toScreen(desk.x + 0.7, desk.y + 0.2, 14);
      g.poly([s0.x, s0.y, s1.x, s1.y, s1.x, s1.y - 16, s0.x, s0.y - 16]).fill(0x1c1f2b).stroke({ color: 0x444a66, width: 1 });
      root = g;
    }
    root.zIndex = depth(desk.x, desk.y) * 10;
    root.eventMode = "static";
    root.cursor = "pointer";
    root.on("pointerover", (e) => this.showTip(pane, e.global.x, e.global.y));
    root.on("pointermove", (e) => this.showTip(pane, e.global.x, e.global.y));
    root.on("pointerout", () => (this.tip.style.display = "none"));
    root.on("pointertap", () => this.onSelectPane(pane));
    this.objects.addChild(root);
  }

  private showTip(pane: PaneInfo, x: number, y: number) {
    const who = pane.agent ? `<b>${pane.agent}</b> · ${pane.agent_status}` : "<b>shell</b> · no agent";
    const title = pane.terminal_title_stripped || pane.terminal_title || "";
    this.tip.innerHTML = `${who}\n${escapeHtml(title)}\n<span style="opacity:.7">${escapeHtml(shortPath(pane.foreground_cwd || pane.cwd))}\n${pane.pane_id}${pane.focused ? " · focused" : ""}</span>`;
    this.tip.style.display = "block";
    const pad = 14;
    this.tip.style.left = `${Math.min(x + pad, innerWidth - this.tip.offsetWidth - pad)}px`;
    this.tip.style.top = `${Math.min(y + pad, innerHeight - this.tip.offsetHeight - pad)}px`;
  }

  private tick(dt: number) {
    const now = performance.now();
    for (const c of this.chars) animateCharacter(c, dt, now);
    for (const b of this.blockedRooms) b.g.alpha = 0.6 + Math.sin(now / 180 + b.base) * 0.4;
  }
}

function shortPath(p: string): string {
  return p.replace(/^\/home\/[^/]+/, "~");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
}

export { TILE_H };
