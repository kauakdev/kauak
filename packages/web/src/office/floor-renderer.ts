// Draws one floor of the office into the scene's layers, from its plan
// (layout.ts): the campus, each wing's sign, each room (platform, floor, walls,
// props, break area, plaque, desks and people), the brand banner, and the dust
// or snow. Everything is drawn procedurally with Graphics for now, so sprites
// can replace individual draw* functions later.
//
// Build mode adds "+" slots to the objects layer: a new desk in every room, a
// new room at the end of every wing and one below them all (see layout.ts).
//
// A room in a git checkout gets a printer here too, but the printers' animation
// draws it (printer-animator.ts). Every snapshot redraws the whole floor; a
// person's animation and walk carry on, kept by pane id.

import { Container, Graphics, Matrix, Polygon, Sprite, Text, TextStyle, Texture } from "pixi.js";
import type { BrandBanner, Characters, Theme } from "@kauak/appearance/contracts";
import { hex, resolveAnchor } from "@kauak/appearance/registry";
import { STATUS_COLOR, kindColor, makeCharacter, makeEmptyDesk, type CharState, type DeskNode, type Whereabouts } from "./character";
import { TILE_W, depth, hashStr, mix, rng, shade, toScreen, type Pt } from "./iso";
import { CELL, WALL, type Desk, type Office, type Plot, type Room, type Spot, type Wing } from "./layout";
import * as P from "./props";
import { printerOf } from "../printers/prints";
import { makeLounge, type Block, type Seat } from "./roam";
import { escapeHtml } from "./tooltip";
import type { PaneInfo, Snapshot } from "@kauak/protocol";

const labelStyle = new TextStyle({ fill: 0xe8e9f0, fontSize: 13, fontFamily: "ui-sans-serif, system-ui, sans-serif", fontWeight: "600" });
const subStyle = new TextStyle({ fill: 0xaab0c8, fontSize: 11, fontFamily: "ui-sans-serif, system-ui, sans-serif" });
const wingStyle = new TextStyle({
  fill: 0xffd166,
  fontSize: 15,
  fontFamily: "ui-sans-serif, system-ui, sans-serif",
  fontWeight: "700",
  letterSpacing: 1.5,
});
const wingSubStyle = new TextStyle({ fill: 0xaab0c8, fontSize: 11, fontFamily: "ui-sans-serif, system-ui, sans-serif" });
const slotStyle = new TextStyle({
  fill: 0xffd166,
  fontSize: 12,
  fontFamily: "ui-sans-serif, system-ui, sans-serif",
  fontWeight: "700",
  letterSpacing: 0.5,
});
const plusStyle = new TextStyle({ fill: 0x1a1a1a, fontSize: 16, fontFamily: "ui-sans-serif, system-ui, sans-serif", fontWeight: "800" });
const BUILD = 0xffd166;
const VENDING = 0xb8433a;
// Wool blankets on the basecamp's log benches, and its tents along the trail.
const BLANKETS = [0xb5452f, 0x2f6b8a, 0xc9a227];
const TENTS = [0xe8742f, 0xf2c14e, 0xc8452f];

// A desk's floor footprint (chair, person, desk and name tag), in tiles from the desk's corner.
const DESK_FOOT = { dx: -0.35, dy: -1.0, w: 1.7, d: 2.0 };
// How far above the footprint a desk stays clickable (px): up to the status bubble.
const DESK_HIT_H = 60;

function floorTile(g: Graphics, x: number, y: number, color: number) {
  P.floorPoly(g, x, y, 1, 1)
    .fill(color)
    .stroke({ color: shade(color, 0.82), width: 1 });
}

/** A tile of floorboards running along x, four to a tile, their joints staggered row by row. */
function floorBoards(g: Graphics, x: number, y: number, color: number) {
  const seam = shade(color, 0.72);
  for (let k = 0; k < 4; k++) {
    const y0 = y + k / 4,
      row = y * 4 + k,
      n = (((x + row) % 3) + 3) % 3;
    P.floorPoly(g, x, y0, 1, 0.25).fill(shade(color, 0.95 + ((((row * 7) % 5) + 5) % 5) * 0.025));
    const a = toScreen(x, y0),
      b = toScreen(x + 1, y0);
    g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ color: seam, width: 1 });
    if (n === 0) {
      const j = x + 0.2 + ((((row * 5) % 3) + 3) % 3) * 0.3,
        c = toScreen(j, y0),
        d = toScreen(j, y0 + 0.25);
      g.moveTo(c.x, c.y).lineTo(d.x, d.y).stroke({ color: seam, width: 1 });
    }
  }
}

export function deskFootprint(g: Graphics, d: Spot, z = 0) {
  return P.floorPoly(g, d.x + DESK_FOOT.dx, d.y + DESK_FOOT.dy, DESK_FOOT.w, DESK_FOOT.d, z);
}

/**
 * The footprint plus the column above it, so a click anywhere on the desk,
 * the person or the gaps between them counts, not just on drawn pixels.
 */
function deskHitArea(d: Spot): Polygon {
  const x = d.x + DESK_FOOT.dx,
    y = d.y + DESK_FOOT.dy,
    H = DESK_HIT_H;
  const top = toScreen(x, y),
    right = toScreen(x + DESK_FOOT.w, y);
  const bottom = toScreen(x + DESK_FOOT.w, y + DESK_FOOT.d),
    left = toScreen(x, y + DESK_FOOT.d);
  return new Polygon([top.x, top.y - H, right.x, right.y - H, right.x, right.y, bottom.x, bottom.y, left.x, left.y, left.x, left.y - H]);
}

function floorCorners(p: Plot, z = 0): Pt[] {
  return [toScreen(p.x, p.y, z), toScreen(p.x + p.w, p.y, z), toScreen(p.x + p.w, p.y + p.h, z), toScreen(p.x, p.y + p.h, z)];
}

/** Dashed outline of a closed polygon. */
function dashed(g: Graphics, pts: Pt[], dash = 7, gap = 5) {
  pts.forEach((a, i) => {
    const b = pts[(i + 1) % pts.length]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const at = (t: number) => ({ x: a.x + ((b.x - a.x) * t) / len, y: a.y + ((b.y - a.y) * t) / len });
    for (let t = 0; t < len; t += dash + gap) {
      const p = at(t),
        q = at(Math.min(len, t + dash));
      g.moveTo(p.x, p.y).lineTo(q.x, q.y);
    }
  });
  return g.stroke({ color: BUILD, width: 1.5, alpha: 0.85 });
}

/** What the office is drawn with. The scene changes it with the appearance, then redraws. */
export interface Look {
  theme: Theme;
  characters: Characters;
  materials: P.MaterialPalette;
}

/** Whether the viewer asked for reduced motion; the scene keeps it current. */
export interface Motion {
  reduced: boolean;
}

/** The scene's layers, back to front. The renderer draws in all of them but `overlay`. */
export interface Layers {
  ground: Container;
  platforms: Container;
  floor: Container;
  /** Depth-sorted. */
  objects: Container;
  overlay: Container;
  labels: Container;
  motes: Container;
}

/** A build-mode slot: a new desk in a room, or a new room in a wing (null: in any folder). */
export type BuildTarget = { kind: "desk"; room: Room } | { kind: "room"; wing: Wing | null };

/** A "+" slot on screen. `key` stays the same across rebuilds, like a pane id. */
export interface Slot {
  root: Container;
  key: string;
  target: BuildTarget;
  badge: Container;
  badgeY: number;
  /** What the tooltip says about it (HTML). */
  tip: string;
  /** Lights it up while the pointer is on it. */
  hover(on: boolean): void;
}

export class FloorRenderer {
  /** The desks on the floor drawn now, one per pane. */
  nodes: DeskNode[] = [];
  /** The build-mode slots on the floor drawn now. */
  slots: Slot[] = [];
  /** The banner's middle on the floor drawn now (world px), or null when it is not drawn. */
  brandPoint: Pt | null = null;
  private ground: Container;
  private platforms: Container;
  private floor: Container;
  private objects: Container;
  private labels: Container;
  private motes: Container;
  /** pane id → its person's animation and walk; kept across redraws. */
  private states = new Map<string, CharState>();
  private blockedRooms: { g: Graphics; base: number }[] = [];
  /** Fires in the basecamp's lounges, flickering. */
  private fires: { g: Graphics; base: number }[] = [];
  private moteList: { g: Graphics; vx: number; vy: number }[] = [];
  private bounds = { minX: -200, maxX: 200, minY: -200, maxY: 200 };
  private brand: BrandBanner | null = null;
  private brandImage: HTMLImageElement | null = null;
  private brandTexture: Texture | null = null;

  /** `addPrinter` draws a room's printer, between the room's props and its break area. */
  constructor(
    layers: Layers,
    private look: Look,
    private motion: Motion,
    private addPrinter: (room: Room, key: string, blocks: Block[]) => void,
  ) {
    this.ground = layers.ground;
    this.platforms = layers.platforms;
    this.floor = layers.floor;
    this.objects = layers.objects;
    this.labels = layers.labels;
    this.motes = layers.motes;
  }

  /** The banner for the next redraw. Returns the texture it stops using, for the caller to destroy once that redraw is done. */
  setBanner(banner: BrandBanner | null, image: HTMLImageElement | null): Texture | null {
    const previous = this.brandTexture;
    this.brand = banner;
    if (image !== this.brandImage) {
      this.brandImage = image;
      this.brandTexture = image ? Texture.from(image) : null;
    }
    return previous !== this.brandTexture ? previous : null;
  }

  /** Destroys the floor drawn now, the printers in `objects` with it. */
  clear() {
    for (const layer of [this.ground, this.platforms, this.floor, this.objects, this.labels])
      for (const child of layer.removeChildren()) child.destroy({ children: true });
    this.nodes = [];
    this.slots = [];
    this.blockedRooms = [];
    this.fires = [];
  }

  /** Draws `office`, the plan of `snap`, on cleared layers; forgets the people whose panes are gone. */
  draw(office: Office, snap: Snapshot, now: number) {
    this.drawGround(office);
    office.wings.forEach((wing, i) => {
      this.drawWing(wing, i, now);
    });
    this.drawBrand(office);
    if (office.slot)
      this.drawRoomSlot(
        office.slot,
        "+room",
        { kind: "room", wing: null },
        "Room in another folder",
        "<b>New room</b>\nin any folder or repository on this floor",
      );

    const live = new Set(snap.panes.map((p) => p.pane_id));
    for (const id of [...this.states.keys()]) if (!live.has(id)) this.states.delete(id);
  }

  private drawGround(office: Office) {
    const GROUND = hex(this.look.theme.palette.ground),
      GROUND_LINE = hex(this.look.theme.palette.groundLine),
      PATH = hex(this.look.theme.palette.path);
    const g = new Graphics();
    const m = 3;
    // Campus slab + subtle grid
    P.floorPoly(g, -m, -m, office.w + m * 2, office.h + m * 2)
      .fill(GROUND)
      .stroke({ color: GROUND_LINE, width: 2 });
    for (let x = -m; x <= office.w + m; x++) {
      const a = toScreen(x, -m),
        b = toScreen(x, office.h + m);
      g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ color: 0xffffff, width: 1, alpha: 0.025 });
    }
    for (let y = -m; y <= office.h + m; y++) {
      const a = toScreen(-m, y),
        b = toScreen(office.w + m, y);
      g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ color: 0xffffff, width: 1, alpha: 0.025 });
    }
    // Corridors: a spine down the left side and one branch per wing
    P.floorPoly(g, -2, -2, 1.2, office.h + 4)
      .fill(PATH)
      .stroke({ color: shade(PATH, 1.25), width: 1 });
    for (const wing of office.wings) {
      const row = wing.y + Math.floor(wing.h / 2);
      P.floorPoly(g, -2, row, wing.w + 2, 1.2)
        .fill(PATH)
        .stroke({ color: shade(PATH, 1.25), width: 1 });
    }
    // A few plants along the spine
    const r = rng(hashStr("campus"));
    for (let y = -1; y < office.h + 1; y += 4) {
      if (r() < 0.6) {
        const seed = Math.floor(r() * 1000);
        this.addProp((pg) => this.decorPlant(pg, -2.9, y, seed, true), -2.9, y);
      }
    }
    if (this.look.theme.architecture.decor === "alpine") this.drawWilds(office, m);
    this.ground.addChild(g);
    const corners = [toScreen(-m, -m), toScreen(office.w + m, -m), toScreen(office.w + m, office.h + m), toScreen(-m, office.h + m)];
    this.bounds = {
      minX: Math.min(...corners.map((c) => c.x)),
      maxX: Math.max(...corners.map((c) => c.x)),
      minY: Math.min(...corners.map((c) => c.y)) - 120,
      maxY: Math.max(...corners.map((c) => c.y)),
    };
  }

  /** The basecamp's campus: tents pitched by the trail, and pines and boulders out in the snow. */
  private drawWilds(office: Office, m: number) {
    const r = rng(hashStr("wilds"));
    for (let y = 1; y < office.h; y += 4)
      if (r() < 0.55) {
        const color = TENTS[Math.floor(r() * TENTS.length)]!;
        this.addProp((g) => P.tent(g, -3.05, y, color), -3.05, y);
      }
    const scatter = (x: number, y: number) => {
      const seed = Math.floor(r() * 1000);
      this.addProp(
        (g) => (seed % 3 ? P.pine(g, x, y, seed, this.look.materials, true) : P.boulder(g, x, y, seed, this.look.materials)),
        x,
        y,
      );
    };
    for (let y = -m + 0.6; y < office.h + m - 1; y += 1.6 + r() * 1.4) if (r() < 0.6) scatter(office.w + 0.9 + r() * (m - 1.6), y);
    for (let x = -m + 0.6; x < office.w + 0.6; x += 1.6 + r() * 1.4) if (r() < 0.6) scatter(x, office.h + 1.2 + r() * (m - 1.9));
  }

  private drawWing(wing: Wing, index: number, now: number) {
    const tints = this.look.theme.palette.wings;
    const tint = hex(tints[index % tints.length]!);
    // Sign: dark plaque with the repo name and a summary line
    const agents = wing.rooms.flatMap((r) => r.desks).filter((d) => d.pane.agent).length;
    const desks = wing.rooms.reduce((n, r) => n + r.desks.length, 0);
    const sign = new Container();
    const t = new Text({ text: wing.name.toUpperCase(), style: wingStyle });
    const sub = new Text({
      text: `${wing.rooms.length} room${wing.rooms.length === 1 ? "" : "s"} · ${desks} desk${desks === 1 ? "" : "s"} · ${agents} agent${agents === 1 ? "" : "s"}`,
      style: wingSubStyle,
    });
    const w = Math.max(t.width, sub.width) + 24;
    const bg = new Graphics();
    bg.roundRect(0, 0, w, 44, 8).fill({ color: 0x0f1118, alpha: 0.85 }).stroke({ color: 0x3a3f55, width: 1 });
    bg.roundRect(0, 0, 4, 44, 2).fill(hex(this.look.theme.palette.accent));
    t.position.set(12, 6);
    sub.position.set(12, 26);
    sign.addChild(bg, t, sub);
    // Anchor the sign at the wing's leftmost corner, beside the corridor spine,
    // so it never overlaps the wing above.
    const p = toScreen(wing.x - 0.6, wing.y + wing.h * 0.5, 0);
    sign.position.set(p.x - w - 14, p.y - 22 - 40);
    const post = new Graphics();
    post
      .moveTo(p.x - 14, p.y - 18)
      .lineTo(p.x - 14, p.y + 4)
      .stroke({ color: 0x6a7090, width: 2 });
    this.labels.addChild(post, sign);
    for (const room of wing.rooms) this.drawRoom(room, tint, now);
    if (wing.slot)
      this.drawRoomSlot(wing.slot, `+room:${wing.key}`, { kind: "room", wing }, "New room", `<b>New room</b>\nin ${escapeHtml(wing.name)}`);
  }

  private drawRoom(room: Room, tint: number, now: number) {
    const seed = hashStr(room.workspace.workspace_id);
    const r = rng(seed);
    const anyBlocked = room.desks.some((d) => d.pane.agent_status === "blocked");
    const focusedTint = mix(tint, hex(this.look.theme.palette.focus), 0.45);

    // Raised platform: shadow + 6px side faces
    const plat = new Graphics();
    P.floorPoly(plat, room.x + 0.15, room.y + 0.15, room.w, room.h, -8).fill({ color: 0x000000, alpha: 0.35 });
    P.box(plat, room.x, room.y, room.w, room.h, 6, shade(tint, 0.55), -6);
    this.platforms.addChild(plat);

    const g = new Graphics();
    const pattern = this.look.theme.architecture.floorPattern;
    for (let x = room.x; x < room.x + room.w; x++) {
      for (let y = room.y; y < room.y + room.h; y++) {
        const base = room.focused ? focusedTint : tint;
        if (pattern === "planks") {
          floorBoards(g, x, y, base);
          continue;
        }
        floorTile(g, x, y, (x + y) % 2 === 0 ? base : shade(base, 0.93));
        if (pattern === "inset")
          P.floorPoly(g, x + 0.09, y + 0.09, 0.82, 0.82).stroke({ color: hex(this.look.theme.palette.accent), alpha: 0.23, width: 1 });
      }
    }
    const rugs = this.look.theme.palette.rugs;
    P.rug(g, room.x + WALL, room.y + WALL, room.w - WALL * 2, room.h - WALL * 2, hex(rugs[Math.floor(r() * rugs.length)]!));
    P.lightPool(
      g,
      room.x + room.w / 2,
      room.y + room.h / 2,
      room.w * 22,
      room.h * 11,
      hex(this.look.theme.palette.light),
      this.look.theme.architecture.lightIntensity,
    );

    // Back walls with windows, a whiteboard/poster and a clock
    const wall = new Graphics();
    const WALL_H = this.look.theme.architecture.wallHeight,
      WALL_COLOR = hex(this.look.theme.palette.wall);
    P.box(wall, room.x, room.y - 0.18, room.w, 0.18, WALL_H, WALL_COLOR);
    P.box(wall, room.x - 0.18, room.y, 0.18, room.h, WALL_H, WALL_COLOR);
    const wy = room.y + 0.005,
      wx = room.x + 0.005;
    const alpine = this.look.theme.architecture.decor === "alpine";
    for (let x = room.x + 0.6; x + 1.4 <= room.x + room.w; x += 2.2) P.windowOnBackWall(wall, x, x + 1.4, wy, 9, 24, alpine);
    P.clockOnBackWall(wall, room.x + room.w - 0.35, wy, 22, this.look.materials);
    if (room.h >= 3) {
      const y1 = room.y + Math.min(room.h - 0.4, 2.2),
        color = kindColor(room.desks[0]?.pane.agent);
      if (r() < 0.6) {
        if (alpine) P.routeMapOnSideWall(wall, wx, room.y + 0.4, y1, 8, 24, seed, this.look.materials);
        else P.whiteboardOnSideWall(wall, wx, room.y + 0.4, y1, 8, 24, seed, this.look.materials);
      } else if (alpine) P.peakPosterOnSideWall(wall, wx, room.y + 0.5, room.y + 1.3, 10, 24, color, this.look.materials);
      else P.posterOnSideWall(wall, wx, room.y + 0.5, room.y + 1.3, 10, 24, color);
    }

    // Outline; pulses red when someone is blocked
    const outline = new Graphics();
    P.floorPoly(outline, room.x, room.y, room.w, room.h, 0.5).stroke({
      color: anyBlocked ? STATUS_COLOR.blocked : room.focused ? hex(this.look.theme.palette.accent) : 0x7a82a8,
      width: anyBlocked ? 3 : 1.5,
      alpha: anyBlocked ? 0.9 : 0.6,
    });
    if (anyBlocked) this.blockedRooms.push({ g: outline, base: Math.random() * 6 });
    this.floor.addChild(g, wall, outline);

    // What people walk around (room-local), and the desks themselves, where nobody stops to stand.
    const blocks: Block[] = [],
      avoid: Block[] = [],
      seats: Seat[] = [];
    for (const d of [...room.desks, ...(room.slot ? [room.slot] : [])]) {
      const x = d.x - room.x,
        y = d.y - room.y;
      blocks.push({ x, y, w: 1, d: 0.7 }, { x: x + 0.25, y: y - 0.7, w: 0.5, d: 0.45 });
      avoid.push({ x: x + DESK_FOOT.dx, y: y + DESK_FOOT.dy, w: DESK_FOOT.w, d: DESK_FOOT.d + 0.4 });
    }
    this.drawRoomProps(room, r, blocks, seats);
    const printer = printerOf(room.workspace);
    if (printer) this.addPrinter(room, printer, blocks);
    const machine = this.drawBreakArea(room, g, blocks, seats);
    const lounge = makeLounge(room.workspace.workspace_id, room.w, room.h, blocks, machine, seats, avoid);
    this.drawRoomPlaque(room);
    // States first: everyone in the room is a member of its lounge before anyone picks a seat.
    const states = room.desks.map((d) => this.stateFor(d.pane, now));
    lounge.members = states.filter((_, i) => room.desks[i]!.pane.agent);
    const where: Whereabouts = { lounge, origin: { x: room.x, y: room.y } };
    room.desks.forEach((desk, i) => {
      this.drawDesk(desk, states[i]!, where);
    });
    if (room.slot) this.drawDeskSlot(room, room.slot);
  }

  /** A depth-sorted prop; `foot` (world tiles) is added to the room's `blocks` for people to walk around. */
  private addProp(draw: (g: Graphics) => void, x: number, y: number, foot?: { room: Room; blocks: Block[]; w: number; d: number }) {
    const g = new Graphics();
    draw(g);
    g.zIndex = depth(x, y) * 10;
    g.eventMode = "none";
    this.objects.addChild(g);
    if (foot) foot.blocks.push({ x: x - foot.room.x, y: y - foot.room.y, w: foot.w, d: foot.d });
  }

  private drawRoomProps(room: Room, r: () => number, blocks: Block[], seats: Seat[]) {
    const add = (draw: (g: Graphics) => void, x: number, y: number, w: number, d: number) =>
      this.addProp(draw, x, y, { room, blocks, w, d });
    const seed = Math.floor(r() * 1e6);
    const decor = this.look.theme.architecture.decor;
    // Corners in the WALL padding ring
    add((g) => this.decorPlant(g, room.x + 0.3, room.y + 0.3, seed), room.x + 0.3, room.y + 0.3, 0.45, 0.45);
    if (r() < 0.7) {
      const cool = r() < 0.5,
        x = room.x + room.w - 0.8,
        y = room.y + 0.25;
      add(
        (g) =>
          decor === "alpine"
            ? P.duffels(g, x, y, seed)
            : cool
              ? P.cooler(g, room.x + room.w - 0.7, room.y + 0.3)
              : P.cabinet(g, x, y, this.look.materials),
        x,
        y,
        0.55,
        0.45,
      );
    }
    if (room.h > 3 && r() < 0.6)
      add((g) => this.decorPlant(g, room.x + 0.3, room.y + room.h - 0.7, seed >> 3), room.x + 0.3, room.y + room.h - 0.7, 0.45, 0.45);
    if (room.w >= 5 && r() < 0.7) {
      const x = room.x + room.w - 1.2,
        y = room.y + room.h - 0.6;
      add(
        (g) =>
          decor === "technical"
            ? P.cabinet(g, x, y, this.look.materials)
            : decor === "alpine"
              ? P.gearRack(g, x, y, seed, this.look.materials)
              : P.bookshelf(g, x, y, seed, this.look.materials),
        x,
        y,
        0.9,
        0.45,
      );
    }
    // Free desk cells become a lounge (after the new-desk slot in build mode).
    // Separate props, so whoever sits on the sofa sorts between it and the table.
    const cols = Math.round((room.w - WALL * 2) / CELL),
      rows = Math.round((room.h - WALL * 2) / CELL);
    const n = room.desks.length + (room.slot ? 1 : 0);
    for (let i = n; i < cols * rows; i++) {
      const cx = room.x + WALL + (i % cols) * CELL,
        cy = room.y + WALL + Math.floor(i / cols) * CELL;
      if (decor === "alpine") {
        // A log bench by a fire pit
        const blanket = BLANKETS[i % BLANKETS.length]!;
        add((g) => P.logBench(g, cx + 0.9, cy + 0.3, blanket, this.look.materials), cx + 0.9, cy + 0.3, 1.2, 0.55);
        add((g) => P.firePit(g, cx + 1.2, cy + 1.3, hex(this.look.theme.palette.light), this.look.materials), cx + 1.2, cy + 1.3, 0.6, 0.4);
        this.addFire(cx + 1.5, cy + 1.5);
      } else {
        const col = [0x5b6ea6, 0x7a5b8e, 0x4f7f77][i % 3]!;
        add((g) => P.sofa(g, cx + 0.9, cy + 0.3, col), cx + 0.9, cy + 0.3, 1.2, 0.55);
        add((g) => P.coffeeTable(g, cx + 1.2, cy + 1.3, this.look.materials), cx + 1.2, cy + 1.3, 0.6, 0.4);
      }
      add((g) => this.decorPlant(g, cx + 0.2, cy + 1.4, seed + i), cx + 0.2, cy + 1.4, 0.45, 0.45);
      for (const sx of [cx + 1.25, cx + 1.75])
        seats.push({ at: { x: sx - room.x, y: cy + 0.63 - room.y }, stand: { x: sx - room.x, y: cy + 1.1 - room.y } });
    }
  }

  /** Flames over a fire pit centred on (x, y); they flicker in tick(). */
  private addFire(x: number, y: number) {
    const g = new Graphics();
    P.flames(g);
    const p = toScreen(x, y);
    g.position.set(p.x, p.y + 0.5);
    g.zIndex = depth(x, y) * 10 + 1;
    g.eventMode = "none";
    this.objects.addChild(g);
    this.fires.push({ g, base: Math.random() * 10 });
  }

  /**
   * Where idle agents take a break: a vending machine on the side wall, near
   * the front, and a bench under the windows. Returns where to stand to use
   * the machine (room-local).
   */
  private drawBreakArea(room: Room, floor: Graphics, blocks: Block[], seats: Seat[]): Spot {
    const decor = this.look.theme.architecture.decor;
    const mx = room.x + 0.04,
      my = room.y + room.h - 1.65;
    P.lightPool(floor, mx + 0.9, my + 0.38, 30, 15, hex(this.look.theme.palette.light), this.look.theme.architecture.lightIntensity * 1.4);
    this.addProp(
      (g) =>
        P.vendingMachine(
          g,
          mx,
          my,
          decor === "technical" ? this.look.materials.metal : decor === "alpine" ? this.look.materials.woodDark : VENDING,
          hex(this.look.theme.palette.light),
          hex(this.look.theme.palette.accent),
        ),
      mx,
      my,
      { room, blocks, w: 0.5, d: 0.75 },
    );
    const bw = room.w >= 8 ? 2.4 : 1.6,
      bx = room.x + 0.95,
      by = room.y + 0.06;
    this.addProp((g) => P.bench(g, bx, by, bw, this.look.materials), bx, by, { room, blocks, w: bw, d: 0.34 });
    for (let x = bx + 0.4; x < bx + bw; x += 0.8) seats.push({ at: { x: x - room.x, y: 0.27 }, stand: { x: x - room.x, y: 0.85 } });
    return { x: mx + 0.92 - room.x, y: my + 0.38 - room.y };
  }

  /** A potted plant, or the theme's equivalent; `outdoor` on the campus. */
  private decorPlant(g: Graphics, x: number, y: number, seed: number, outdoor = false) {
    if (this.look.theme.architecture.decor === "botanical") {
      P.plant(g, x, y, seed, this.look.materials);
      return;
    }
    if (this.look.theme.architecture.decor === "alpine") {
      P.pine(g, x, y, seed, this.look.materials, outdoor);
      return;
    }
    P.box(g, x, y, 0.45, 0.45, 12, this.look.materials.metal);
    const p = toScreen(x + 0.22, y + 0.22, 12);
    g.moveTo(p.x, p.y)
      .lineTo(p.x, p.y - 15)
      .stroke({ color: this.look.materials.metal, width: 3 });
    g.circle(p.x, p.y - 16, 4).fill(hex(this.look.theme.palette.accent));
    g.ellipse(p.x, p.y - 13, 9, 3).stroke({ color: hex(this.look.theme.palette.accent), width: 1.5 });
  }

  /** Contain image in a neutral panel, then project that panel onto a wall plane. */
  private drawBrand(office: Office) {
    this.brandPoint = null;
    if (!this.brand?.visible || !this.brandTexture || !office.wings.length) return;
    const a = resolveAnchor(this.look.theme, this.brand.anchorId),
      room = office.wings[0]!.rooms[0]!;
    const x = a.x + (a.origin === "first-room" ? room.x : 0),
      y = a.y + (a.origin === "first-room" ? room.y : 0);
    const w = (a.width * TILE_W) / 2,
      h = a.height;
    const left = a.facing === "x" ? toScreen(x, y, a.z + h) : toScreen(x, y + a.width, a.z + h);
    const panel = new Container();
    panel.eventMode = "none";
    const posts = new Graphics();
    for (const offset of [0.15, a.width - 0.15]) {
      const px = a.facing === "x" ? x + offset : x,
        py = a.facing === "x" ? y : y + offset;
      const base = toScreen(px, py, a.origin === "first-room" ? this.look.theme.architecture.wallHeight : 0);
      const top = toScreen(px, py, a.z + h - 4);
      posts.moveTo(base.x, base.y).lineTo(top.x, top.y).stroke({ color: this.look.materials.metal, width: 3 });
      if (a.origin === "campus") P.shadow(posts, px, py, 6, 3, 0.25);
    }
    this.floor.addChild(posts);
    panel.setFromMatrix(new Matrix(1, a.facing === "x" ? 0.5 : -0.5, 0, 1, left.x, left.y));
    const frame = new Graphics();
    frame.roundRect(-3, -3, w + 6, h + 6, 3).fill(this.look.materials.metal);
    frame.rect(0, 0, w, h).fill(this.brand.background === "dark" ? 0x172638 : 0xf4f6f8);
    const sprite = new Sprite(this.brandTexture),
      padding = 6;
    const scale = Math.min((w - padding * 2) / this.brand.width, (h - padding * 2) / this.brand.height);
    sprite.scale.set(scale);
    sprite.position.set((w - sprite.width) / 2, (h - sprite.height) / 2);
    panel.addChild(frame, sprite);
    // Dedicated floor layer stays behind the people and labels; avoids hiding desks.
    this.floor.addChild(panel);
    this.brandPoint = { x: left.x + w / 2, y: left.y + h / 2 + (a.facing === "x" ? 0.25 : -0.25) * w };
  }

  private drawRoomPlaque(room: Room) {
    const repo = room.workspace.repo;
    const sub = repo
      ? repo.linked
        ? `worktree · ${repo.checkout.split("/").pop()}`
        : "main checkout"
      : `workspace ${room.workspace.number}`;
    const label = new Text({ text: room.workspace.label || room.workspace.workspace_id, style: labelStyle });
    const subT = new Text({ text: sub, style: subStyle });
    const dots = new Graphics();
    const w = Math.max(label.width, subT.width) + 24 + room.desks.length * 10;
    const bg = new Graphics();
    bg.roundRect(-w / 2, 0, w, 40, 7)
      .fill({ color: 0x0f1118, alpha: 0.82 })
      .stroke({ color: room.focused ? 0xffd166 : 0x3a3f55, width: 1 });
    label.anchor.set(0, 0);
    label.position.set(-w / 2 + 10, 5);
    subT.anchor.set(0, 0);
    subT.position.set(-w / 2 + 10, 22);
    room.desks.forEach((d, i) => {
      dots.circle(w / 2 - 12 - i * 10, 20, 3.5).fill(STATUS_COLOR[d.pane.agent_status]);
    });
    const c = new Container();
    c.addChild(bg, label, subT, dots);
    const lp = toScreen(room.x + room.w / 2, room.y + room.h + 0.1);
    c.position.set(lp.x, lp.y + 2);
    this.labels.addChild(c);
  }

  private stateFor(pane: PaneInfo, now: number): CharState {
    const prev = this.states.get(pane.pane_id);
    const state: CharState = prev
      ? prev.status === pane.agent_status
        ? prev
        : { ...prev, status: pane.agent_status, lastChange: now }
      : { phase: Math.random() * 10, status: pane.agent_status, lastChange: 0 };
    this.states.set(pane.pane_id, state);
    return state;
  }

  private drawDesk(desk: Desk, state: CharState, where: Whereabouts) {
    const pane = desk.pane;
    const node = pane.agent
      ? makeCharacter(desk, state, this.look.characters, this.look.materials, this.motion.reduced, where)
      : makeEmptyDesk(desk, state, this.look.materials);
    this.nodes.push(node);
    node.root.eventMode = "static";
    node.root.hitArea = deskHitArea(desk);
    // The desk takes clicks, and so does its person while away from it (the person sets its own eventMode).
    for (const target of [node.root, node.person]) {
      if (!target) continue;
      target.interactiveChildren = false;
      target.cursor = "pointer";
    }
    for (const layer of node.layers) this.objects.addChild(layer);
  }

  /** A ghost desk with a "+" badge in the room's next desk cell. */
  private drawDeskSlot(room: Room, at: Spot) {
    const g = new Graphics();
    deskFootprint(g, at, 0.5).fill({ color: BUILD, alpha: 0.07 });
    const f = { x: at.x + DESK_FOOT.dx, y: at.y + DESK_FOOT.dy, w: DESK_FOOT.w, h: DESK_FOOT.d };
    dashed(g, floorCorners(f, 0.5));
    const ghost = new Graphics();
    P.box(ghost, at.x + 0.25, at.y - 0.7, 0.5, 0.1, 22, BUILD, 4); // chair back
    P.box(ghost, at.x, at.y, 1, 0.7, 14, BUILD); // desk
    ghost.alpha = 0.22;
    const top = toScreen(at.x + 0.5, at.y - 0.1, 44);
    const name = room.workspace.label || room.workspace.workspace_id;
    this.addSlot(
      [g, ghost],
      deskHitArea(at),
      depth(at.x, at.y) * 10,
      top,
      `+desk:${room.workspace.workspace_id}`,
      { kind: "desk", room },
      `<b>New desk</b>\nin ${escapeHtml(name)}`,
    );
  }

  /** A dashed room outline with a label and a "+" badge. */
  private drawRoomSlot(plot: Plot, key: string, target: BuildTarget, label: string, tip: string) {
    const g = new Graphics();
    const corners = floorCorners(plot);
    const outline = new Polygon(corners.flatMap((c) => [c.x, c.y]));
    g.poly(outline.points).fill({ color: BUILD, alpha: 0.05 });
    dashed(g, corners);
    const text = new Text({ text: label.toUpperCase(), style: slotStyle });
    text.anchor.set(0.5);
    const mid = toScreen(plot.x + plot.w / 2, plot.y + plot.h / 2);
    text.position.set(mid.x, mid.y + 18);
    this.addSlot([g, text], outline, depth(plot.x, plot.y) * 10, { x: mid.x, y: mid.y - 8 }, key, target, tip);
  }

  private addSlot(parts: Container[], hitArea: Polygon, zIndex: number, badgeAt: Pt, key: string, target: BuildTarget, tip: string) {
    const root = new Container();
    root.addChild(...parts);
    const badge = new Container();
    const disc = new Graphics()
      .circle(0, 0, 12)
      .fill(BUILD)
      .stroke({ color: shade(BUILD, 0.6), width: 1.5 });
    const plus = new Text({ text: "+", style: plusStyle });
    plus.anchor.set(0.5, 0.55);
    badge.addChild(disc, plus);
    badge.position.set(badgeAt.x, badgeAt.y);
    root.addChild(badge);
    root.zIndex = zIndex;
    root.eventMode = "static";
    root.hitArea = hitArea;
    root.interactiveChildren = false;
    root.cursor = "pointer";
    root.alpha = 0.85;
    const hover = (on: boolean) => {
      root.alpha = on ? 1 : 0.85;
      badge.scale.set(on ? 1.15 : 1);
    };
    const slot: Slot = { root, key, target, badge, badgeY: badgeAt.y, tip, hover };
    this.slots.push(slot);
    this.objects.addChild(root);
  }

  // ------------------------------------------------------------ ambient

  buildMotes(office: Office) {
    for (const child of this.motes.removeChildren()) child.destroy();
    this.moteList = [];
    const r = rng(7);
    // Dust rising in the light, or at the basecamp, snow drifting down on the wind.
    const snow = this.look.theme.architecture.decor === "alpine";
    const n = Math.min(snow ? 140 : 80, 20 + (office.w * office.h) / 3);
    for (let i = 0; i < n; i++) {
      const g = new Graphics();
      if (snow) g.circle(0, 0, 0.9 + r() * 1.4).fill({ color: 0xffffff, alpha: 0.35 + r() * 0.4 });
      else g.circle(0, 0, 0.8 + r() * 1.2).fill({ color: hex(this.look.theme.palette.light), alpha: 0.1 + r() * 0.12 });
      g.position.set(
        this.bounds.minX + r() * (this.bounds.maxX - this.bounds.minX),
        this.bounds.minY + r() * (this.bounds.maxY - this.bounds.minY),
      );
      this.motes.addChild(g);
      this.moteList.push(snow ? { g, vx: -4 - r() * 8, vy: 9 + r() * 14 } : { g, vx: (r() - 0.5) * 4, vy: -3 - r() * 5 });
    }
  }

  tickDesks(dt: number, now: number) {
    for (const n of this.nodes) n.tick(dt, now);
  }

  /** The build slots' badges bob, blocked rooms pulse and fires flicker. */
  tickRooms(now: number) {
    for (const sl of this.slots) sl.badge.y = sl.badgeY + Math.sin(now / 300) * 2;
    for (const b of this.blockedRooms) b.g.alpha = 0.6 + Math.sin(now / 180 + b.base) * 0.4;
    for (const f of this.fires)
      f.g.scale.set(
        1 + Math.sin(now / 130 + f.base) * 0.05,
        1 + Math.sin(now / 90 + f.base) * 0.1 + Math.sin(now / 53 + f.base * 2) * 0.06,
      );
  }

  tickMotes(dt: number) {
    for (const m of this.moteList) {
      m.g.x += m.vx * dt;
      m.g.y += m.vy * dt;
      if (m.g.y < this.bounds.minY) {
        m.g.y = this.bounds.maxY;
        m.g.x = this.bounds.minX + Math.random() * (this.bounds.maxX - this.bounds.minX);
      } else if (m.g.y > this.bounds.maxY) {
        m.g.y = this.bounds.minY;
        m.g.x = this.bounds.minX + Math.random() * (this.bounds.maxX - this.bounds.minX);
      }
      if (m.g.x < this.bounds.minX) m.g.x = this.bounds.maxX;
    }
  }
}
