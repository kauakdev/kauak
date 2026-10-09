// Desks and the people who sit at them. A desk node is created per pane; it
// owns its own tick() so the scene just loops over them each frame.
//
// The person is drawn apart from the desk so an idle agent can leave it (see
// roam.ts): chair, person and desk are three depth-sorted layers, and the
// person takes clicks for its desk while away from it.

import { Container, Graphics, Rectangle, Text, TextStyle, type PointData } from "pixi.js";
import { CONTEXT_COLOR, contextLevel, contextShare } from "../app/context";
import { depth, hashStr, mix, shade, toScreen } from "./iso";
import type { Characters } from "@kauak/appearance/contracts";
import { hex } from "@kauak/appearance/registry";
import { defaultCharacters } from "../appearance/catalog";
import type { Desk, Spot } from "./layout";
import { PALETTE, box, quadAlongX, shadow, type MaterialPalette } from "./props";
import {
  facing,
  newRoam,
  poseOf,
  resumeRoam,
  settleRoam,
  spawnAway,
  stepRoam,
  vendProgress,
  type Home,
  type Lounge,
  type Pose,
  type Roam,
} from "./roam";
import type { AgentStatus, ContextUsage } from "@kauak/protocol";

export const STATUS_COLOR: Record<AgentStatus, number> = {
  working: 0x5ad87a,
  idle: 0x8fb4ff,
  blocked: 0xff6b6b,
  done: 0xffd166,
  unknown: 0x7a7f93,
};

// Shirt color per agent kind; unknown kinds get a hashed color.
const KIND_COLOR: Record<string, number> = {
  claude: 0xd97757,
  codex: 0x2ec4b6,
  gemini: 0x6f7bf7,
  cursor: 0xe0e0e0,
  copilot: 0x9b7bff,
  opencode: 0xf4a261,
  aider: 0x7bd389,
};

export function kindColor(kind: string | null | undefined): number {
  if (!kind) return 0x9aa0b4;
  if (KIND_COLOR[kind]) return KIND_COLOR[kind]!;
  return 0x404040 + (hashStr(kind) & 0xbfbfbf);
}

const tagStyle = new TextStyle({
  fill: 0x111111,
  fontSize: 9,
  fontWeight: "700",
  fontFamily: "ui-sans-serif, system-ui, sans-serif",
  letterSpacing: 0.5,
});
const bubbleStyle = new TextStyle({ fill: 0x111111, fontSize: 13, fontWeight: "800", fontFamily: "ui-sans-serif, system-ui, sans-serif" });
const glyphStyle = new TextStyle({ fill: 0x5ad87a, fontSize: 10, fontFamily: "ui-monospace, monospace" });

export interface CharState {
  phase: number; // animation clock (s)
  status: AgentStatus;
  lastChange: number; // ms since epoch when status last changed
  /** Where the agent is when it can leave its desk; kept across rebuilds like the rest. */
  roam?: Roam;
}

export interface DeskNode {
  /** The desk, its monitor and name tag; takes clicks for the desk. */
  root: Container;
  /** Every container for the depth-sorted layer, root included. Each has its zIndex set. */
  layers: Container[];
  /** The person, when it can walk away from the desk; it takes clicks for the desk while away. */
  person: Container | null;
  desk: Desk;
  state: CharState;
  /** Screen-space point above the occupant's head (or monitor) for the selection marker. Follows a walking person. */
  anchor: PointData;
  tick(dt: number, now: number): void;
}

/** The room a person can roam: what it offers, and its corner in world tiles. */
export interface Whereabouts {
  lounge: Lounge;
  origin: Spot;
}

// ------------------------------------------------------------------ desk

interface DeskParts {
  screen: Graphics;
  palette: MaterialPalette;
  screenRect: { x0: number; x1: number; y: number; z0: number; z1: number };
}

function drawDeskFurniture(root: Container, desk: Desk, seed: number, occupied: boolean, palette: MaterialPalette): DeskParts {
  const g = new Graphics();
  shadow(g, desk.x + 0.5, desk.y + 0.45, 30, 12, 0.22);
  box(g, desk.x, desk.y, 1, 0.7, 14, occupied ? palette.wood : shade(palette.wood, 0.85));
  // legs hint: darker strip at the base of the front faces
  // monitor stand + bezel (screen faces the viewer, parallel to the back wall)
  box(g, desk.x + 0.44, desk.y + 0.22, 0.12, 0.1, 5, 0x2a2d3a, 14);
  const x0 = desk.x + 0.16,
    x1 = desk.x + 0.84,
    y = desk.y + 0.24,
    z0 = 19,
    z1 = 39;
  quadAlongX(g, x0, x1, y, z0, z1).fill(0x11131b).stroke({ color: 0x444a66, width: 1 });
  // keyboard, mug, papers
  box(g, desk.x + 0.28, desk.y + 0.48, 0.44, 0.14, 2, 0x3a3f55, 14);
  if (seed & 1) box(g, desk.x + 0.86, desk.y + 0.5, 0.11, 0.11, 6, seed & 2 ? palette.white : 0xd97757, 14);
  if (seed & 4) box(g, desk.x + 0.04, desk.y + 0.42, 0.22, 0.2, 1, palette.paper, 14);
  root.addChild(g);
  const screen = new Graphics();
  root.addChild(screen);
  return { screen, palette, screenRect: { x0: x0 + 0.03, x1: x1 - 0.03, y: y - 0.01, z0: z0 + 1.5, z1: z1 - 1.5 } };
}

/** Redraws the monitor contents for the given status. Called every frame; cheap. */
function drawScreen(parts: DeskParts, status: AgentStatus | "off", t: number) {
  const g = parts.screen;
  const r = parts.screenRect;
  g.clear();
  const c = status === "off" ? 0x7a7f93 : STATUS_COLOR[status];
  quadAlongX(g, r.x0, r.x1, r.y, r.z0, r.z1).fill(mix(parts.palette.screenOff, c, status === "off" ? 0.06 : 0.28));
  const h = r.z1 - r.z0,
    w = r.x1 - r.x0;
  const line = (frac: number, len: number, alpha: number) => {
    const z = r.z0 + 2 + frac * (h - 4);
    const a = toScreen(r.x0 + 0.04, r.y, z),
      b = toScreen(r.x0 + 0.04 + len * (w - 0.08), r.y, z);
    g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ color: c, width: 1.4, alpha });
  };
  if (status === "working") {
    for (let i = 0; i < 5; i++) {
      const k = (i / 5 + t * 0.35) % 1;
      line(1 - k, 0.35 + ((i * 37) % 60) / 100, 0.9 - k * 0.5);
    }
    g.alpha = 0.92 + Math.sin(t * 40) * 0.04; // CRT-ish flicker
  } else if (status === "idle" || status === "done") {
    line(0.85, 0.6, 0.6);
    line(0.65, 0.4, 0.5);
    line(0.45, 0.7, 0.4);
    if (Math.floor(t * 2) % 2 === 0) line(0.2, 0.08, 0.9); // blinking prompt
    g.alpha = 1;
  } else if (status === "blocked") {
    line(0.8, 0.5, 0.5);
    line(0.6, 0.65, 0.5);
    if (Math.floor(t * 3) % 2 === 0) {
      const z = r.z0 + h * 0.3;
      const a = toScreen(r.x0 + 0.04, r.y, z),
        b = toScreen(r.x1 - 0.04, r.y, z);
      g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ color: c, width: 3, alpha: 0.9 });
    }
    g.alpha = 1;
  } else {
    if (Math.floor(t * 1.5) % 2 === 0) line(0.15, 0.08, 0.7); // lone cursor
    g.alpha = 1;
  }
}

// ------------------------------------------------------------------ empty desk

export function makeEmptyDesk(desk: Desk, state: CharState, palette = PALETTE): DeskNode {
  const root = new Container();
  const seed = hashStr(desk.pane.pane_id);
  const parts = drawDeskFurniture(root, desk, seed, false, palette);
  const chair = new Graphics();
  box(chair, desk.x + 0.25, desk.y - 0.7, 0.5, 0.45, 8, palette.chair, 4);
  box(chair, desk.x + 0.25, desk.y - 0.7, 0.5, 0.1, 22, shade(palette.chair, 1.15), 4);
  root.addChildAt(chair, 0);
  const tag = makeTag("shell", 0x9aa0b4, desk);
  root.addChild(tag);
  root.zIndex = depth(desk.x, desk.y) * 10;
  // Whoever sat here is gone; an agent started here later sits down fresh.
  state.roam = undefined;
  const top = toScreen(desk.x + 0.5, desk.y + 0.24, 39);
  return {
    root,
    layers: [root],
    person: null,
    desk,
    state,
    anchor: { x: top.x, y: top.y - 14 },
    tick(dt) {
      state.phase += dt;
      drawScreen(parts, "off", state.phase);
    },
  };
}

/** Name tag in front of the desk, with the agent's context meter under it when the bridge knows it. */
function makeTag(text: string, color: number, desk: Desk, context: ContextUsage | null = null): Container {
  const c = new Container();
  const t = new Text({ text: text.toUpperCase(), style: tagStyle });
  t.anchor.set(0.5);
  const bg = new Graphics();
  const w = t.width + 10;
  bg.roundRect(-w / 2, -8, w, 16, 4)
    .fill({ color, alpha: 0.95 })
    .stroke({ color: shade(color, 0.6), width: 1 });
  c.addChild(bg, t);
  if (context) c.addChild(contextMeter(context, Math.max(w, 36)));
  const p = toScreen(desk.x + 0.5, desk.y + 0.95);
  c.position.set(p.x, p.y);
  return c;
}

/** A bar as wide as the name tag, just under it: how full the context window is. */
function contextMeter(context: ContextUsage, w: number): Graphics {
  const g = new Graphics();
  const y = 11,
    h = 5;
  g.roundRect(-w / 2, y, w, h, 2.5)
    .fill({ color: 0x0f1118, alpha: 0.9 })
    .stroke({ color: 0x3a3f55, width: 1 });
  const fill = (w - 2) * contextShare(context);
  if (fill > 0) g.roundRect(-w / 2 + 1, y + 1, Math.max(2, fill), h - 2, 1.5).fill(CONTEXT_COLOR[contextLevel(context)]);
  return g;
}

// ------------------------------------------------------------------ character

// How much higher the body is drawn off the desk chair: on a bench, or standing on its legs (px).
const LIFT = 6;
const SHOE = 0x1d1f29;
const CANS = [0xe07a5f, 0x81b29a, 0x98c1d9, 0xf2cc8f, 0xee6c4d];
// A climber's kit: pack and rope vary per person; boots, gloves, harness and mug do not.
const PACKS = [0x3d5a80, 0x2f4f4f, 0x6b4f3a, 0x4a4e69, 0x7f2f2f];
const ROPES = [0xe0533d, 0x3fa7d6, 0xf2c14e, 0x7bd389];
const BOOT = 0xd98c2b;
const GLOVE = 0x30343f;
const HARNESS = 0x2b2e3b;
const CARABINER = 0xf2c14e;
const MUG = 0xe8eef2;
const MUG_RIM = 0x2f6b8a;
const AXE = 0x8b95a1;

/** What a climber carries; unused by the other models. */
interface Kit {
  pack: number;
  rope: number;
}

/** Torso and head, `lift` px up from the seat or feet. `back`: seen from behind; `eye` -1/1: looking left/right. */
function drawBody(
  g: Graphics,
  look: Characters,
  color: number,
  skin: number,
  hair: number,
  kit: Kit,
  lift: number,
  back: boolean,
  eye: number,
) {
  g.clear();
  const y = -lift,
    e = eye * 1.2;
  if (look.model === "climber") drawClimber(g, look, color, skin, hair, kit, y, back, e);
  else if (look.model === "robot") {
    g.roundRect(-9, y - 26, 18, 22, 4)
      .fill(skin)
      .stroke({ color: shade(skin, 0.6), width: 1 });
    g.roundRect(-11, y - 43, 22, 18, 5)
      .fill(skin)
      .stroke({ color: shade(skin, 0.6), width: 1 });
    if (back) g.roundRect(-6, y - 38, 12, 7, 2).fill(shade(skin, 0.85));
    else {
      g.roundRect(-8 + e, y - 39, 16, 9, 3).fill(hex(look.visor));
      g.circle(-4 + e, y - 35, 1.5).fill(color);
      g.circle(4 + e, y - 35, 1.5).fill(color);
      g.roundRect(-5, y - 20, 10, 7, 2).fill(color);
    }
    g.moveTo(0, y - 43)
      .lineTo(0, y - 48)
      .stroke({ color: skin, width: 2 });
    g.circle(0, y - 49, 2).fill(color);
  } else {
    g.ellipse(0, y - 15, 9.5, 12)
      .fill(color)
      .stroke({ color: shade(color, 0.6), width: 1 }); // torso
    g.circle(0, y - 33, 7.5)
      .fill(skin)
      .stroke({ color: shade(skin, 0.7), width: 1 }); // head
    if (back) g.circle(0, y - 33.5, 7.7).fill(hair);
    else {
      g.moveTo(-8, y - 34)
        .arc(0, y - 34, 8, Math.PI, Math.PI * 2)
        .closePath()
        .fill(hair); // hair (explicit moveTo: arc() would otherwise start from a stale point)
      g.circle(-2.6 + e, y - 33, 1).fill(0x222222);
      g.circle(2.6 + e, y - 33, 1).fill(0x222222);
    }
  }
}

/**
 * A mountaineer: helmet with goggles pushed up on it, a down jacket in the
 * agent's color, a rope over the shoulder, harness and a pack; from behind,
 * the pack with a coiled rope and an ice axe.
 */
function drawClimber(
  g: Graphics,
  look: Characters,
  color: number,
  skin: number,
  hair: number,
  kit: Kit,
  y: number,
  back: boolean,
  e: number,
) {
  const helmet = hex(look.shell),
    lens = hex(look.visor);
  const jacket = () => {
    g.ellipse(0, y - 15, 10.5, 12.5)
      .fill(color)
      .stroke({ color: shade(color, 0.6), width: 1 });
    for (const q of [-19, -11])
      g.moveTo(-9.6, y + q)
        .quadraticCurveTo(0, y + q + 2.5, 9.6, y + q)
        .stroke({ color: shade(color, 0.78), width: 1 }); // quilting
  };
  const dome = () => {
    g.moveTo(-8.8, y - 34.5)
      .arc(0, y - 34.5, 8.8, Math.PI, Math.PI * 2)
      .closePath()
      .fill(helmet)
      .stroke({ color: shade(helmet, 0.6), width: 1 });
    g.roundRect(-9.6, y - 35.6, 19.2, 2.3, 1).fill(shade(helmet, 0.8));
  };
  if (back) {
    jacket();
    g.circle(0, y - 33, 7.5).fill(hair);
    dome();
    g.moveTo(5, y - 7)
      .lineTo(8.5, y - 37)
      .stroke({ color: AXE, width: 1.6 }); // ice axe
    g.moveTo(4.5, y - 37.5)
      .lineTo(12, y - 35.5)
      .stroke({ color: shade(AXE, 1.2), width: 2 });
    g.roundRect(-9, y - 28, 18, 23, 4)
      .fill(kit.pack)
      .stroke({ color: shade(kit.pack, 0.6), width: 1 }); // pack
    g.roundRect(-8, y - 29.5, 16, 6.5, 3).fill(shade(kit.pack, 1.18)); // its lid
    g.ellipse(0, y - 15, 6.5, 3.2).stroke({ color: kit.rope, width: 2.2 }); // a coiled rope
    g.ellipse(0, y - 15, 4, 1.8).stroke({ color: shade(kit.rope, 0.8), width: 1 });
    g.moveTo(-5, y - 8)
      .lineTo(5, y - 8)
      .stroke({ color: shade(kit.pack, 0.6), width: 1.4 });
    return;
  }
  g.roundRect(-10.5, y - 30.5, 21, 16, 4)
    .fill(kit.pack)
    .stroke({ color: shade(kit.pack, 0.6), width: 1 }); // pack, behind the shoulders
  jacket();
  g.moveTo(0, y - 26)
    .lineTo(0, y - 6)
    .stroke({ color: shade(color, 0.6), width: 0.8 }); // zip
  g.moveTo(-7.5, y - 24)
    .lineTo(6.5, y - 8)
    .stroke({ color: kit.rope, width: 2.6, cap: "round" }); // rope over the shoulder
  g.moveTo(-6.5, y - 25)
    .lineTo(7.5, y - 9)
    .stroke({ color: shade(kit.rope, 0.75), width: 0.8 });
  g.roundRect(-7.5, y - 7.5, 15, 2.6, 1).fill(HARNESS); // harness
  g.ellipse(-4, y - 3.4, 1.5, 2.2).stroke({ color: CARABINER, width: 1 });
  g.circle(0, y - 33, 7.5)
    .fill(skin)
    .stroke({ color: shade(skin, 0.7), width: 1 }); // head
  g.ellipse(-7, y - 31.5, 1.6, 2.6).fill(hair);
  g.ellipse(7, y - 31.5, 1.6, 2.6).fill(hair);
  dome();
  g.moveTo(-8.6, y - 38.4)
    .lineTo(8.6, y - 38.4)
    .stroke({ color: 0x1b1d26, width: 1.2 }); // goggles up on the helmet
  g.roundRect(-6.4 + e, y - 40.2, 5.6, 3.6, 1.5)
    .fill(lens)
    .stroke({ color: 0x1b1d26, width: 0.8 });
  g.roundRect(0.8 + e, y - 40.2, 5.6, 3.6, 1.5)
    .fill(lens)
    .stroke({ color: 0x1b1d26, width: 0.8 });
  g.circle(-2.6 + e, y - 31.6, 1).fill(0x222222);
  g.circle(2.6 + e, y - 31.6, 1).fill(0x222222);
}

/** A shoe, or a climber's boot, at (x, y). */
function foot(g: Graphics, x: number, y: number, boots: boolean) {
  if (!boots) {
    g.ellipse(x, y, 2.6, 1.5).fill(SHOE);
    return;
  }
  g.ellipse(x - 0.3, y + 0.5, 3.6, 1.7).fill(SHOE);
  g.ellipse(x, y - 0.4, 3.1, 2).fill(BOOT);
}

/** Legs off the desk chair: hanging from a bench or sofa, standing (with a shadow), or mid-stride. */
function drawLegs(g: Graphics, pose: Pose, stride: number, pants: number, boots = false) {
  if (pose === "sit") {
    // Seats face the room: knees forward, toward the viewer's left.
    for (const s of [-1, 1]) {
      g.moveTo(s * 3, -9)
        .lineTo(s * 3 - 7, -6)
        .lineTo(s * 3 - 7, 2.5)
        .stroke({ color: pants, width: 4, cap: "round", join: "round" });
      foot(g, s * 3 - 8, 3, boots);
    }
    return;
  }
  g.ellipse(0, 0, 9, 4).fill({ color: 0x000000, alpha: 0.22 });
  for (const s of [-1, 1]) {
    const ph = stride + (s > 0 ? Math.PI : 0);
    const up = pose === "walk" ? Math.max(0, Math.sin(ph)) * 2.5 : 0;
    const x = s * 3 + (pose === "walk" ? Math.cos(ph) * 1.8 : 0);
    g.moveTo(s * 3, -11)
      .lineTo(x, -1.5 - up)
      .stroke({ color: pants, width: 4, cap: "round" });
    foot(g, x, -1 - up, boots);
  }
}

/**
 * An agent at its desk. Given its room (`where`), an idle agent gets up and
 * roams it (roam.ts) and comes back when there is work.
 */
export function makeCharacter(
  desk: Desk,
  state: CharState,
  look: Characters = defaultCharacters,
  palette = PALETTE,
  reducedMotion = false,
  where: Whereabouts | null = null,
): DeskNode {
  const pane = desk.pane;
  const root = new Container();
  const seed = hashStr(pane.pane_id);
  const color = kindColor(pane.agent);
  const climber = look.model === "climber";
  const skin = look.model === "robot" ? hex(look.shell) : hex(look.skin[seed % look.skin.length]!);
  const hair = hex(look.hair[(seed >>> 4) % look.hair.length]!);
  const pants = look.model === "robot" ? shade(skin, 0.72) : climber ? mix(0x2b3140, color, 0.15) : shade(color, 0.42);
  const can = CANS[(seed >>> 8) % CANS.length]!;
  const kit: Kit = { pack: PACKS[(seed >>> 12) % PACKS.length]!, rope: ROPES[(seed >>> 16) % ROPES.length]! };
  const palm = climber ? GLOVE : skin;

  // Chair behind the desk, then the person, then the desk in front.
  const z = depth(desk.x, desk.y) * 10;
  const back = new Container();
  back.zIndex = z - 2;
  back.eventMode = "none";
  const chair = new Graphics();
  shadow(chair, desk.x + 0.5, desk.y - 0.45, 16, 7, 0.25);
  box(chair, desk.x + 0.25, desk.y - 0.7, 0.5, 0.45, 8, palette.chair, 4);
  box(chair, desk.x + 0.25, desk.y - 0.7, 0.5, 0.1, 22, shade(palette.chair, 1.15), 4);
  back.addChild(chair);
  root.zIndex = z;

  // In the chair, and the spot beside it to get up to; room-local, as roaming is.
  const origin = where?.origin ?? { x: 0, y: 0 };
  const home: Home = {
    seat: { x: desk.x + 0.5 - origin.x, y: desk.y - 0.48 - origin.y },
    stand: { x: desk.x - 0.25 - origin.x, y: desk.y - 0.45 - origin.y },
  };
  if (where) {
    if (!state.roam || state.roam.room !== where.lounge.key) {
      state.roam = newRoam(where.lounge.key, home);
      if (state.status === "idle" && state.lastChange === 0) spawnAway(state.roam, where.lounge, home);
    } else resumeRoam(state.roam, where.lounge, home);
  }

  // The person, drawn around its seat or feet (0, 0).
  const person = new Container();
  person.hitArea = new Rectangle(-13, -60, 26, 62);
  person.eventMode = "none";
  const legs = new Graphics(),
    body = new Graphics(),
    hands = new Graphics();
  person.addChild(legs, body, hands);

  const p = toScreen(desk.x + 0.5, desk.y - 0.48);
  const parts = drawDeskFurniture(root, desk, seed, true, palette);
  root.addChild(makeTag(pane.agent ?? "agent", color, desk, pane.context));

  // Status bubble above the head
  const bubble = new Container();
  const bubbleBg = new Graphics();
  const bubbleText = new Text({ text: "", style: bubbleStyle });
  bubbleText.anchor.set(0.5);
  bubble.addChild(bubbleBg, bubbleText);
  bubble.position.set(16, -54);
  person.addChild(bubble);

  const glyphs = new Container();
  root.addChild(glyphs);
  const glyphPool = Array.from({ length: 3 }, () => {
    const t = new Text({ text: "", style: glyphStyle });
    t.anchor.set(0.5);
    glyphs.addChild(t);
    return t;
  });

  let shown: AgentStatus | null = null;
  const applyStatus = () => {
    const st = state.status;
    const c = STATUS_COLOR[st];
    bubbleBg.clear();
    bubbleBg
      .roundRect(-11, -11, 22, 22, 6)
      .fill(c)
      .stroke({ color: shade(c, 0.6), width: 1.5 });
    bubbleBg.poly([-4, 10, 4, 10, -2, 16]).fill(c);
    bubbleText.text = st === "blocked" ? "?" : st === "done" ? "✓" : st === "idle" ? "☕" : st === "unknown" ? "~" : "…";
    root.alpha = person.alpha = back.alpha = st === "unknown" ? 0.6 : 1;
    shown = st;
  };
  applyStatus();

  const hand = (x: number, y: number) => hands.circle(x, y, 2.5).fill(palm);
  const drink = (x: number, y: number) => {
    if (climber) {
      // An enamel mug of something hot
      hands
        .moveTo(x - 1, y - 8)
        .quadraticCurveTo(x - 2.6, y - 10, x - 1, y - 12)
        .stroke({ color: 0xffffff, width: 0.8, alpha: 0.55 });
      hands
        .moveTo(x + 1.2, y - 8.5)
        .quadraticCurveTo(x - 0.2, y - 10.5, x + 1.2, y - 12.5)
        .stroke({ color: 0xffffff, width: 0.8, alpha: 0.4 });
      hands.circle(x + 3.1, y - 3.6, 1.5).stroke({ color: MUG, width: 1 });
      hands
        .roundRect(x - 2.6, y - 6.6, 5.2, 6, 1)
        .fill(MUG)
        .stroke({ color: shade(MUG, 0.6), width: 0.8 });
      hands
        .ellipse(x, y - 6.6, 2.6, 0.9)
        .fill(0x5a3a22)
        .stroke({ color: MUG_RIM, width: 0.8 });
    } else {
      hands
        .roundRect(x - 2, y - 7, 4, 6.5, 1)
        .fill(can)
        .stroke({ color: shade(can, 0.6), width: 0.8 });
      hands.rect(x - 2, y - 7, 4, 1.2).fill(0xd0d4e2);
    }
    hand(x, y - 1.5);
  };

  /** In the chair: typing, leaning back, hand up, or bouncing with the news. */
  const seated = (t: number, motion: number) => {
    switch (state.status) {
      case "working": {
        const l = Math.sin(t * 14) * 1.5 * motion,
          r = Math.sin(t * 14 + Math.PI) * 1.5 * motion;
        hand(-6, -5 + l);
        hand(6, -5 + r);
        body.y = Math.sin(t * 3) * 0.6 * motion;
        const cycle = (t * 0.9) % 1;
        glyphPool.forEach((g, i) => {
          const k = (cycle + i / glyphPool.length) % 1;
          g.visible = !reducedMotion;
          g.text = look.animation.glyphs[(Math.floor(t * 0.9) + i * 5) % look.animation.glyphs.length]!;
          g.position.set(p.x + 20 + Math.sin(k * 6) * 4 + i * 5, p.y - 14 - k * 36);
          g.alpha = 1 - k;
        });
        bubble.visible = false;
        break;
      }
      case "idle": {
        body.y = Math.sin(t * 1.4) * 1.2 * motion;
        hand(7, -13 + Math.sin(t * 1.4) * 1.2);
        bubble.visible = true;
        bubble.alpha = 0.9;
        bubble.scale.set(1);
        break;
      }
      case "blocked": {
        bubble.visible = true;
        bubble.alpha = 1;
        bubble.scale.set(1 + Math.sin(t * 5) * 0.12 * motion);
        hand(11, -31 + Math.sin(t * 5) * 1.5);
        body.y = 0;
        break;
      }
      case "done": {
        bubble.visible = true;
        bubble.alpha = 1;
        bubble.scale.set(1);
        bubble.y = -54 - Math.abs(Math.sin(t * 3)) * 5 * motion;
        body.y = -Math.abs(Math.sin(t * 3)) * 2 * motion;
        if (climber) {
          // Summit: a little flag in the agent's color, held up high
          const up = body.y,
            wave = Math.sin(t * 6) * 1.5 * motion;
          hands
            .moveTo(-11, -24 + up)
            .lineTo(-11, -46 + up)
            .stroke({ color: AXE, width: 1.2 });
          hands
            .poly([-11, -46 + up, -20, -43 + up + wave * 0.5, -11, -39 + up])
            .fill(color)
            .stroke({ color: shade(color, 0.6), width: 0.8 });
          hand(-11, -25 + up);
        }
        break;
      }
      default: {
        bubble.visible = true;
        bubble.alpha = 0.8;
        bubble.scale.set(1);
        body.y = 0;
      }
    }
  };

  /** Away from the desk: walking, at the vending machine, sitting down, or standing about with a drink. */
  const roaming = (r: Roam, pose: Pose, t: number, motion: number) => {
    const walking = pose === "walk";
    const stride = r.clock * (r.hurry ? 17 : 10);
    const sw = walking ? Math.sin(stride) * 2 : 0;
    const bob = walking ? -Math.abs(Math.sin(stride)) * 1.4 : pose === "sit" ? Math.sin(t * 1.4) * 0.6 * motion : 0;
    drawLegs(legs, pose, stride, pants, climber);
    body.y = bob;
    const y = -13 - LIFT + bob; // hands at the sides
    if (state.status === "blocked") {
      hand(-9.5, y - sw);
      hand(11, -31 - LIFT + bob + Math.sin(t * 5) * 1.5); // hand up, all the way back
    } else if (!walking && r.goal.kind === "machine") {
      const k = vendProgress(r);
      if (k < 0.45) {
        hand(-7, -27 - LIFT);
        hand(9.5, y);
      } // choosing
      else if (k < 0.7) {
        body.y = 3;
        hand(-6, -5 - LIFT);
        hand(9.5, y + 3);
      } // stooping to the hatch
      else {
        hand(-9.5, y);
        drink(9.5, y);
      }
    } else if (r.carrying) {
      hand(-9.5, y - sw);
      if (!walking && r.clock % 6 > 5)
        drink(4, -28 - LIFT + bob); // a sip
      else drink(9.5, y + sw);
    } else {
      hand(-9.5, y - sw);
      hand(9.5, y + sw);
    }
    bubble.visible = state.status !== "working";
    bubble.alpha = state.status === "idle" ? 0.9 : state.status === "unknown" ? 0.8 : 1;
    bubble.scale.set(state.status === "blocked" ? 1 + Math.sin(t * 5) * 0.12 * motion : 1);
    bubble.y = -54 - LIFT + bob - (state.status === "done" ? Math.abs(Math.sin(t * 3)) * 5 * motion : 0);
  };

  const anchor = { x: p.x, y: p.y - 46 };
  let drawn = "";
  let away = false;
  const tick = (dt: number, now: number) => {
    state.phase += reducedMotion ? 0 : dt * look.animation.tempo[state.status];
    const t = state.phase;
    const motion = reducedMotion ? 0 : look.animation.amplitude;
    if (shown !== state.status) applyStatus();
    const r = state.roam;
    if (r && where) {
      const idle = state.status === "idle";
      if (reducedMotion) settleRoam(r, where.lounge, home, idle);
      else stepRoam(r, where.lounge, home, idle, dt);
    }
    const pose: Pose = r && where ? poseOf(r) : "desk";
    const lift = pose === "desk" ? 0 : LIFT;
    const face = r && pose !== "desk" ? facing(r) : { back: false, left: false };
    const key = `${pose}:${face.back}:${face.left}`;
    if (key !== drawn) {
      drawBody(body, look, color, skin, hair, kit, lift, face.back, pose === "stand" || pose === "walk" ? (face.left ? -1 : 1) : 0);
      drawn = key;
    }

    // In the chair, or wherever the walk has got to.
    const at = r && where ? r.pos : home.seat;
    const wx = origin.x + at.x,
      wy = origin.y + at.y;
    const s = toScreen(wx, wy);
    person.position.set(s.x, s.y);
    // Between the chair and the desk while sitting there or getting up; elsewhere by depth, like the furniture.
    const atDesk = pose === "desk" || (wx > desk.x - 0.45 && wx < desk.x + 1.1 && wy > desk.y - 0.75 && wy < desk.y);
    person.zIndex = atDesk ? z - 1 : depth(wx, wy) * 10 + 1;
    if (away !== (pose !== "desk")) {
      away = pose !== "desk";
      person.eventMode = away ? "static" : "none";
    }
    anchor.x = s.x;
    anchor.y = s.y - 46 - lift;

    hands.clear();
    legs.clear();
    for (const g of glyphPool) g.visible = false;
    drawScreen(parts, state.status, t);
    bubble.y = -54;
    if (pose === "desk") seated(t, motion);
    else roaming(r!, pose, t, motion);
    // Pop on status change
    const since = now - state.lastChange;
    if (!reducedMotion && since < 600) bubble.scale.set(1 + (1 - since / 600) * 0.6);
  };

  return { root, layers: [back, person, root], person, desk, state, anchor, tick };
}
