// PixiJS isometric rendering of the office. Everything is drawn procedurally
// with Graphics for now, so sprites can replace individual draw* functions later.
//
// Layers (back → front): ground (campus slab, corridors) → platforms (room
// slabs + shadows) → floor (tiles, rugs, walls, décor) → objects (depth-sorted
// desks, people, props) → overlay (selection marker, hover ring) → labels → motes.

import { Application, Container, Graphics, Text, TextStyle } from "pixi.js";
import { STATUS_COLOR, kindColor, makeCharacter, makeEmptyDesk, type CharState, type DeskNode } from "./character";
import { TILE_W, depth, hashStr, mix, rng, shade, toScreen } from "./iso";
import { CELL, WALL, buildOffice, type Desk, type Office, type Room, type Wing } from "./layout";
import * as P from "./props";
import type { PaneInfo, Snapshot } from "./types";

const BG = 0x171a26;
const GROUND = 0x1f2230;
const GROUND_LINE = 0x272b3b;
const PATH = 0x2a2e40;
const WALL_COLOR = 0x5a6080;
const WALL_H = 30;
// Floor tint per wing so repositories read as different departments.
const WING_TINTS = [0x3a3f55, 0x3d4452, 0x44405a, 0x3a4a4e, 0x4a4040];

const labelStyle = new TextStyle({ fill: 0xe8e9f0, fontSize: 13, fontFamily: "ui-sans-serif, system-ui, sans-serif", fontWeight: "600" });
const subStyle = new TextStyle({ fill: 0xaab0c8, fontSize: 11, fontFamily: "ui-sans-serif, system-ui, sans-serif" });
const wingStyle = new TextStyle({ fill: 0xffd166, fontSize: 15, fontFamily: "ui-sans-serif, system-ui, sans-serif", fontWeight: "700", letterSpacing: 1.5 });
const wingSubStyle = new TextStyle({ fill: 0xaab0c8, fontSize: 11, fontFamily: "ui-sans-serif, system-ui, sans-serif" });

function floorTile(g: Graphics, x: number, y: number, color: number) {
  P.floorPoly(g, x, y, 1, 1).fill(color).stroke({ color: shade(color, 0.82), width: 1 });
}

interface CameraTarget { x: number; y: number; scale: number }

export class OfficeScene {
  readonly app = new Application();
  readonly world = new Container();
  private ground = new Container();
  private platforms = new Container();
  private floor = new Container();
  private objects = new Container();       // depth-sorted
  private overlay = new Container();
  private labels = new Container();
  private motes = new Container();
  private nodes: DeskNode[] = [];
  private states = new Map<string, CharState>();
  private blockedRooms: { g: Graphics; base: number }[] = [];
  private office: Office | null = null;
  private fitted = false;
  private tip = document.getElementById("tip")!;
  private plumbob = new Container();
  private hoverRing = new Graphics();
  private selectedId: string | null = null;
  private hoveredId: string | null = null;
  private camTarget: CameraTarget | null = null;
  private moteList: { g: Graphics; vx: number; vy: number }[] = [];
  private bounds = { minX: -200, maxX: 200, minY: -200, maxY: 200 };
  onSelectPane: (pane: PaneInfo) => void = () => {};
  onHoverPane: (paneId: string | null) => void = () => {};

  async init(host: HTMLElement) {
    await this.app.init({ resizeTo: host, antialias: true, background: BG, resolution: devicePixelRatio, autoDensity: true });
    host.appendChild(this.app.canvas);
    this.objects.sortableChildren = true;
    this.world.addChild(this.ground, this.platforms, this.floor, this.objects, this.overlay, this.labels, this.motes);
    this.overlay.addChild(this.hoverRing, this.plumbob);
    this.drawPlumbob();
    this.app.stage.addChild(this.world);
    this.setupCamera();
    this.app.ticker.add((tk) => this.tick(tk.deltaMS / 1000));
  }

  // ------------------------------------------------------------ camera

  private setupCamera() {
    const stage = this.app.stage;
    stage.eventMode = "static";
    stage.hitArea = { contains: () => true } as never;
    let drag: { x: number; y: number; wx: number; wy: number; moved: boolean } | null = null;
    stage.on("pointerdown", (e) => { drag = { x: e.global.x, y: e.global.y, wx: this.world.x, wy: this.world.y, moved: false }; this.camTarget = null; });
    stage.on("pointerup", () => (drag = null));
    stage.on("pointerupoutside", () => (drag = null));
    stage.on("pointermove", (e) => {
      if (!drag) return;
      this.world.x = drag.wx + (e.global.x - drag.x);
      this.world.y = drag.wy + (e.global.y - drag.y);
    });
    this.app.canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.camTarget = null;
      this.zoomAt(Math.exp(-e.deltaY * 0.001), e.offsetX, e.offsetY);
    }, { passive: false });
  }

  zoomAt(factor: number, mx = this.app.screen.width / 2, my = this.app.screen.height / 2) {
    const next = Math.min(3, Math.max(0.3, this.world.scale.x * factor));
    const wx = (mx - this.world.x) / this.world.scale.x, wy = (my - this.world.y) / this.world.scale.y;
    this.world.scale.set(next);
    this.world.x = mx - wx * next;
    this.world.y = my - wy * next;
  }

  /** Animate the camera so the whole office fits. */
  fit() {
    const office = this.office;
    if (!office || office.w === 0) return;
    const corners = [toScreen(-1, -1), toScreen(office.w + 1, -1), toScreen(office.w + 1, office.h + 1), toScreen(-1, office.h + 1)];
    const minX = Math.min(...corners.map((c) => c.x)), maxX = Math.max(...corners.map((c) => c.x));
    const minY = Math.min(...corners.map((c) => c.y)) - 90, maxY = Math.max(...corners.map((c) => c.y)) + 40;
    const v = this.viewport();
    const scale = Math.min(2, Math.max(0.3, Math.min(v.w / (maxX - minX + 60), v.h / (maxY - minY + 60))));
    this.camTarget = { scale, x: v.cx - ((minX + maxX) / 2) * scale, y: v.cy - ((minY + maxY) / 2) * scale };
  }

  /** Visible canvas area once the HUD (roster, terminal panel, bars) is subtracted. */
  private viewport() {
    const sw = this.app.screen.width, sh = this.app.screen.height;
    const visible = (id: string) => { const el = document.getElementById(id); return el && getComputedStyle(el).opacity !== "0" && getComputedStyle(el).display !== "none" ? el.getBoundingClientRect() : null; };
    const roster = visible("roster");
    const left = roster && roster.right < sw * 0.5 ? roster.right + 8 : 0;
    const right = document.body.classList.contains("panel-open") ? Math.min(920, sw * 0.62) : 0;
    const top = 52, bottom = 40;
    const w = Math.max(200, sw - left - right), h = Math.max(200, sh - top - bottom);
    return { w, h, cx: left + w / 2, cy: top + h / 2 };
  }

  /** Animate the camera onto one desk. */
  focusPane(paneId: string) {
    const node = this.nodes.find((n) => n.desk.pane.pane_id === paneId);
    if (!node) return;
    const scale = Math.max(this.world.scale.x, 1.3);
    const v = this.viewport();
    this.camTarget = { scale, x: v.cx - node.anchor.x * scale, y: v.cy - (node.anchor.y + 20) * scale };
  }

  // ------------------------------------------------------------ selection

  setSelected(paneId: string | null) {
    this.selectedId = paneId;
    this.updatePlumbob();
  }

  private drawPlumbob() {
    const g = new Graphics();
    // Sims-style diamond: two halves so it reads as 3D when we squash scale.x
    g.poly([0, -22, 8, -8, 0, 8]).fill(0x7bff7b);
    g.poly([0, -22, -8, -8, 0, 8]).fill(0x38c95a);
    g.poly([0, -22, 8, -8, 0, -8]).stroke({ color: 0xd7ffd7, width: 1, alpha: 0.7 });
    this.plumbob.addChild(g);
    this.plumbob.visible = false;
  }

  private updatePlumbob() {
    const node = this.nodes.find((n) => n.desk.pane.pane_id === this.selectedId);
    this.plumbob.visible = !!node;
    if (node) this.plumbob.position.set(node.anchor.x, node.anchor.y - 22);
  }

  private setHover(id: string | null) {
    if (id === this.hoveredId) return;
    this.hoveredId = id;
    this.hoverRing.clear();
    const node = this.nodes.find((n) => n.desk.pane.pane_id === id);
    if (node) {
      const d = node.desk;
      const c = STATUS_COLOR[d.pane.agent_status];
      P.floorPoly(this.hoverRing, d.x - 0.35, d.y - 1.0, 1.7, 2.0, 0.5).stroke({ color: c, width: 2, alpha: 0.9 });
      P.floorPoly(this.hoverRing, d.x - 0.35, d.y - 1.0, 1.7, 2.0, 0.5).fill({ color: c, alpha: 0.08 });
    }
    this.onHoverPane(id);
  }

  // ------------------------------------------------------------ building

  setSnapshot(snap: Snapshot) {
    const office = buildOffice(snap);
    this.office = office;
    const now = performance.now();
    for (const layer of [this.ground, this.platforms, this.floor, this.objects, this.labels]) layer.removeChildren();
    this.nodes = [];
    this.blockedRooms = [];

    this.drawGround(office);
    office.wings.forEach((wing, i) => this.drawWing(wing, i, now));

    const live = new Set(snap.panes.map((p) => p.pane_id));
    for (const id of [...this.states.keys()]) if (!live.has(id)) this.states.delete(id);

    if (!this.fitted && office.w > 0) {
      this.fit();
      if (this.camTarget) { this.world.scale.set(this.camTarget.scale); this.world.position.set(this.camTarget.x, this.camTarget.y); this.camTarget = null; }
      this.fitted = true;
    }
    this.buildMotes(office);
    this.updatePlumbob();
    this.setHover(null);
  }

  private drawGround(office: Office) {
    const g = new Graphics();
    const m = 3;
    // Campus slab + subtle grid
    P.floorPoly(g, -m, -m, office.w + m * 2, office.h + m * 2).fill(GROUND).stroke({ color: GROUND_LINE, width: 2 });
    for (let x = -m; x <= office.w + m; x++) {
      const a = toScreen(x, -m), b = toScreen(x, office.h + m);
      g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ color: 0xffffff, width: 1, alpha: 0.025 });
    }
    for (let y = -m; y <= office.h + m; y++) {
      const a = toScreen(-m, y), b = toScreen(office.w + m, y);
      g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ color: 0xffffff, width: 1, alpha: 0.025 });
    }
    // Corridors: a spine down the left side and one branch per wing
    P.floorPoly(g, -2, -2, 1.2, office.h + 4).fill(PATH).stroke({ color: shade(PATH, 1.25), width: 1 });
    for (const wing of office.wings) {
      const row = wing.y + Math.floor(wing.h / 2);
      P.floorPoly(g, -2, row, wing.w + 2, 1.2).fill(PATH).stroke({ color: shade(PATH, 1.25), width: 1 });
    }
    // A few plants along the spine
    const r = rng(hashStr("campus"));
    for (let y = -1; y < office.h + 1; y += 4) {
      if (r() < 0.6) { const pg = new Graphics(); P.plant(pg, -2.9, y, Math.floor(r() * 1000)); pg.zIndex = depth(-2.9, y) * 10; this.objects.addChild(pg); }
    }
    this.ground.addChild(g);
    const corners = [toScreen(-m, -m), toScreen(office.w + m, -m), toScreen(office.w + m, office.h + m), toScreen(-m, office.h + m)];
    this.bounds = {
      minX: Math.min(...corners.map((c) => c.x)), maxX: Math.max(...corners.map((c) => c.x)),
      minY: Math.min(...corners.map((c) => c.y)) - 120, maxY: Math.max(...corners.map((c) => c.y)),
    };
  }

  private drawWing(wing: Wing, index: number, now: number) {
    const tint = WING_TINTS[index % WING_TINTS.length]!;
    // Sign: dark plaque with the repo name and a summary line
    const agents = wing.rooms.flatMap((r) => r.desks).filter((d) => d.pane.agent).length;
    const desks = wing.rooms.reduce((n, r) => n + r.desks.length, 0);
    const sign = new Container();
    const t = new Text({ text: wing.name.toUpperCase(), style: wingStyle });
    const sub = new Text({ text: `${wing.rooms.length} room${wing.rooms.length === 1 ? "" : "s"} · ${desks} desk${desks === 1 ? "" : "s"} · ${agents} agent${agents === 1 ? "" : "s"}`, style: wingSubStyle });
    const w = Math.max(t.width, sub.width) + 24;
    const bg = new Graphics();
    bg.roundRect(0, 0, w, 44, 8).fill({ color: 0x0f1118, alpha: 0.85 }).stroke({ color: 0x3a3f55, width: 1 });
    bg.roundRect(0, 0, 4, 44, 2).fill(0xffd166);
    t.position.set(12, 6); sub.position.set(12, 26);
    sign.addChild(bg, t, sub);
    // Anchor the sign at the wing's leftmost corner, beside the corridor spine,
    // so it never overlaps the wing above.
    const p = toScreen(wing.x - 0.6, wing.y + wing.h * 0.5, 0);
    sign.position.set(p.x - w - 14, p.y - 22 - 40);
    const post = new Graphics();
    post.moveTo(p.x - 14, p.y - 18).lineTo(p.x - 14, p.y + 4).stroke({ color: 0x6a7090, width: 2 });
    this.labels.addChild(post, sign);
    for (const room of wing.rooms) this.drawRoom(room, tint, now);
  }

  private drawRoom(room: Room, tint: number, now: number) {
    const seed = hashStr(room.workspace.workspace_id);
    const r = rng(seed);
    const anyBlocked = room.desks.some((d) => d.pane.agent_status === "blocked");
    const focusedTint = mix(tint, 0x5a6aa8, 0.45);

    // Raised platform: shadow + 6px side faces
    const plat = new Graphics();
    P.floorPoly(plat, room.x + 0.15, room.y + 0.15, room.w, room.h, -8).fill({ color: 0x000000, alpha: 0.35 });
    P.box(plat, room.x, room.y, room.w, room.h, 6, shade(tint, 0.55), -6);
    this.platforms.addChild(plat);

    const g = new Graphics();
    for (let x = room.x; x < room.x + room.w; x++) {
      for (let y = room.y; y < room.y + room.h; y++) {
        const base = room.focused ? focusedTint : tint;
        floorTile(g, x, y, (x + y) % 2 === 0 ? base : shade(base, 0.93));
      }
    }
    P.rug(g, room.x + WALL, room.y + WALL, room.w - WALL * 2, room.h - WALL * 2, r() < 0.5 ? 0xd97757 : 0x6f7bf7);
    P.lightPool(g, room.x + room.w / 2, room.y + room.h / 2, room.w * 22, room.h * 11);

    // Back walls with windows, a whiteboard/poster and a clock
    const wall = new Graphics();
    P.box(wall, room.x, room.y - 0.18, room.w, 0.18, WALL_H, WALL_COLOR);
    P.box(wall, room.x - 0.18, room.y, 0.18, room.h, WALL_H, WALL_COLOR);
    const wy = room.y + 0.005, wx = room.x + 0.005;
    for (let x = room.x + 0.6; x + 1.4 <= room.x + room.w; x += 2.2) P.windowOnBackWall(wall, x, x + 1.4, wy, 9, 24);
    P.clockOnBackWall(wall, room.x + room.w - 0.35, wy, 22);
    if (room.h >= 3) {
      if (r() < 0.6) P.whiteboardOnSideWall(wall, wx, room.y + 0.4, room.y + Math.min(room.h - 0.4, 2.2), 8, 24, seed);
      else P.posterOnSideWall(wall, wx, room.y + 0.5, room.y + 1.3, 10, 24, kindColor(room.desks[0]?.pane.agent));
    }

    // Outline; pulses red when someone is blocked
    const outline = new Graphics();
    P.floorPoly(outline, room.x, room.y, room.w, room.h, 0.5).stroke({ color: anyBlocked ? STATUS_COLOR.blocked : room.focused ? 0xffd166 : 0x7a82a8, width: anyBlocked ? 3 : 1.5, alpha: anyBlocked ? 0.9 : 0.6 });
    if (anyBlocked) this.blockedRooms.push({ g: outline, base: Math.random() * 6 });
    this.floor.addChild(g, wall, outline);

    this.drawRoomProps(room, r);
    this.drawRoomPlaque(room);
    for (const desk of room.desks) this.drawDesk(desk, now);
  }

  private drawRoomProps(room: Room, r: () => number) {
    const add = (draw: (g: Graphics) => void, x: number, y: number) => {
      const g = new Graphics(); draw(g); g.zIndex = depth(x, y) * 10; this.objects.addChild(g);
    };
    const seed = Math.floor(r() * 1e6);
    // Corners in the WALL padding ring
    add((g) => P.plant(g, room.x + 0.3, room.y + 0.3, seed), room.x + 0.3, room.y + 0.3);
    if (r() < 0.7) add((g) => (r() < 0.5 ? P.cooler(g, room.x + room.w - 0.7, room.y + 0.3) : P.cabinet(g, room.x + room.w - 0.8, room.y + 0.25)), room.x + room.w - 0.7, room.y + 0.3);
    if (room.h > 3 && r() < 0.6) add((g) => P.plant(g, room.x + 0.3, room.y + room.h - 0.7, seed >> 3), room.x + 0.3, room.y + room.h - 0.7);
    if (room.w >= 5 && r() < 0.7) add((g) => P.bookshelf(g, room.x + room.w - 1.2, room.y + room.h - 0.6, seed), room.x + room.w - 1.2, room.y + room.h - 0.6);
    // Free desk cells become a lounge
    const cols = Math.round((room.w - WALL * 2) / CELL), rows = Math.round((room.h - WALL * 2) / CELL);
    const n = room.desks.length;
    for (let i = n; i < cols * rows; i++) {
      const cx = room.x + WALL + (i % cols) * CELL, cy = room.y + WALL + Math.floor(i / cols) * CELL;
      const col = [0x5b6ea6, 0x7a5b8e, 0x4f7f77][i % 3]!;
      add((g) => { P.sofa(g, cx + 0.9, cy + 0.3, col); P.coffeeTable(g, cx + 1.2, cy + 1.3); P.plant(g, cx + 0.2, cy + 1.4, seed + i); }, cx + 1.2, cy + 1.3);
    }
  }

  private drawRoomPlaque(room: Room) {
    const wt = room.workspace.worktree;
    const sub = wt ? (wt.is_linked_worktree ? `worktree · ${wt.checkout_path.split("/").pop()}` : "main checkout") : `workspace ${room.workspace.number}`;
    const label = new Text({ text: room.workspace.label || room.workspace.workspace_id, style: labelStyle });
    const subT = new Text({ text: sub, style: subStyle });
    const dots = new Graphics();
    const w = Math.max(label.width, subT.width) + 24 + room.desks.length * 10;
    const bg = new Graphics();
    bg.roundRect(-w / 2, 0, w, 40, 7).fill({ color: 0x0f1118, alpha: 0.82 }).stroke({ color: room.focused ? 0xffd166 : 0x3a3f55, width: 1 });
    label.anchor.set(0, 0); label.position.set(-w / 2 + 10, 5);
    subT.anchor.set(0, 0); subT.position.set(-w / 2 + 10, 22);
    room.desks.forEach((d, i) => dots.circle(w / 2 - 12 - i * 10, 20, 3.5).fill(STATUS_COLOR[d.pane.agent_status]));
    const c = new Container();
    c.addChild(bg, label, subT, dots);
    const lp = toScreen(room.x + room.w / 2, room.y + room.h + 0.1);
    c.position.set(lp.x, lp.y + 2);
    this.labels.addChild(c);
  }

  private drawDesk(desk: Desk, now: number) {
    const pane = desk.pane;
    const prev = this.states.get(pane.pane_id);
    const state: CharState = prev
      ? (prev.status === pane.agent_status ? prev : { ...prev, status: pane.agent_status, lastChange: now })
      : { phase: Math.random() * 10, status: pane.agent_status, lastChange: 0 };
    this.states.set(pane.pane_id, state);

    const node = pane.agent ? makeCharacter(desk, state) : makeEmptyDesk(desk, state);
    this.nodes.push(node);
    const root = node.root;
    root.zIndex = depth(desk.x, desk.y) * 10;
    root.eventMode = "static";
    root.cursor = "pointer";
    root.on("pointerover", (e) => { this.setHover(pane.pane_id); this.showTip(pane, e.global.x, e.global.y); });
    root.on("pointermove", (e) => this.showTip(pane, e.global.x, e.global.y));
    root.on("pointerout", () => { this.setHover(null); this.tip.style.display = "none"; });
    root.on("pointertap", () => this.onSelectPane(pane));
    this.objects.addChild(root);
  }

  private showTip(pane: PaneInfo, x: number, y: number) {
    const who = pane.agent ? `<b>${escapeHtml(pane.agent)}</b> · ${pane.agent_status}` : "<b>shell</b> · no agent";
    const title = pane.terminal_title_stripped || pane.terminal_title || "";
    this.tip.dataset.status = pane.agent_status;
    this.tip.innerHTML = `${who}\n${escapeHtml(title)}\n<span class="muted">${escapeHtml(shortPath(pane.foreground_cwd || pane.cwd))}\n${pane.pane_id}${pane.focused ? " · focused in Herdr" : ""}</span>`;
    this.tip.style.display = "block";
    const pad = 14;
    this.tip.style.left = `${Math.min(x + pad, innerWidth - this.tip.offsetWidth - pad)}px`;
    this.tip.style.top = `${Math.min(y + pad, innerHeight - this.tip.offsetHeight - pad)}px`;
  }

  // ------------------------------------------------------------ ambient

  private buildMotes(office: Office) {
    this.motes.removeChildren();
    this.moteList = [];
    const r = rng(7);
    const n = Math.min(80, 20 + office.w * office.h / 3);
    for (let i = 0; i < n; i++) {
      const g = new Graphics();
      g.circle(0, 0, 0.8 + r() * 1.2).fill({ color: 0xfff2d0, alpha: 0.10 + r() * 0.12 });
      g.position.set(this.bounds.minX + r() * (this.bounds.maxX - this.bounds.minX), this.bounds.minY + r() * (this.bounds.maxY - this.bounds.minY));
      this.motes.addChild(g);
      this.moteList.push({ g, vx: (r() - 0.5) * 4, vy: -3 - r() * 5 });
    }
  }

  private tick(dt: number) {
    const now = performance.now();
    for (const n of this.nodes) n.tick(dt, now);
    for (const b of this.blockedRooms) b.g.alpha = 0.6 + Math.sin(now / 180 + b.base) * 0.4;
    if (this.plumbob.visible) {
      const t = now / 1000;
      this.plumbob.scale.x = 0.55 + Math.abs(Math.cos(t * 2.2)) * 0.45;
      this.plumbob.y += 0;
      const node = this.nodes.find((n) => n.desk.pane.pane_id === this.selectedId);
      if (node) this.plumbob.position.set(node.anchor.x, node.anchor.y - 22 + Math.sin(t * 3) * 3);
    }
    for (const m of this.moteList) {
      m.g.x += m.vx * dt; m.g.y += m.vy * dt;
      if (m.g.y < this.bounds.minY) { m.g.y = this.bounds.maxY; m.g.x = this.bounds.minX + Math.random() * (this.bounds.maxX - this.bounds.minX); }
    }
    if (this.camTarget) {
      const k = 1 - Math.exp(-dt * 6);
      const c = this.camTarget;
      const s = this.world.scale.x + (c.scale - this.world.scale.x) * k;
      this.world.scale.set(s);
      this.world.x += (c.x - this.world.x) * k;
      this.world.y += (c.y - this.world.y) * k;
      if (Math.abs(c.x - this.world.x) < 0.5 && Math.abs(c.y - this.world.y) < 0.5 && Math.abs(c.scale - s) < 0.001) this.camTarget = null;
    }
  }
}

function shortPath(p: string): string {
  return p.replace(/^\/home\/[^/]+/, "~");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
}
