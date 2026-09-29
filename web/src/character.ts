// Desks and the people who sit at them. A desk node is created per pane; it
// owns its own tick() so the scene just loops over them each frame.

import { Container, Graphics, Text, TextStyle, type PointData } from "pixi.js";
import { hashStr, mix, shade, toScreen } from "./iso";
import type { Desk } from "./layout";
import { PALETTE, box, quadAlongX, shadow } from "./props";
import type { AgentStatus } from "./types";

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

const HAIR = [0x2b1d14, 0x5a3a22, 0xc7813a, 0x1b1b1f, 0x8c2f2f, 0xe0c080, 0x4a4e69];
const SKIN = [0xf1d3b3, 0xe0b48f, 0xc68642, 0x8d5524, 0xffdbac];

const tagStyle = new TextStyle({ fill: 0x111111, fontSize: 9, fontWeight: "700", fontFamily: "ui-sans-serif, system-ui, sans-serif", letterSpacing: 0.5 });
const bubbleStyle = new TextStyle({ fill: 0x111111, fontSize: 13, fontWeight: "800", fontFamily: "ui-sans-serif, system-ui, sans-serif" });
const glyphStyle = new TextStyle({ fill: 0x5ad87a, fontSize: 10, fontFamily: "ui-monospace, monospace" });
const GLYPH_CHARS = ["{", "}", ";", "=>", "()", "fn", "if", "λ", "0x", "//", "<>", "&&"];

export interface CharState {
  phase: number;                 // animation clock (s)
  status: AgentStatus;
  lastChange: number;            // ms since epoch when status last changed
}

export interface DeskNode {
  root: Container;
  desk: Desk;
  state: CharState;
  /** Screen-space point above the occupant's head (or monitor) for the selection marker. */
  anchor: PointData;
  tick(dt: number, now: number): void;
}

// ------------------------------------------------------------------ desk

interface DeskParts { screen: Graphics; screenRect: { x0: number; x1: number; y: number; z0: number; z1: number } }

function drawDeskFurniture(root: Container, desk: Desk, seed: number, occupied: boolean): DeskParts {
  const g = new Graphics();
  shadow(g, desk.x + 0.5, desk.y + 0.45, 30, 12, 0.22);
  box(g, desk.x, desk.y, 1, 0.7, 14, occupied ? PALETTE.wood : shade(PALETTE.wood, 0.85));
  // legs hint: darker strip at the base of the front faces
  // monitor stand + bezel (screen faces the viewer, parallel to the back wall)
  box(g, desk.x + 0.44, desk.y + 0.22, 0.12, 0.1, 5, 0x2a2d3a, 14);
  const x0 = desk.x + 0.16, x1 = desk.x + 0.84, y = desk.y + 0.24, z0 = 19, z1 = 39;
  quadAlongX(g, x0, x1, y, z0, z1).fill(0x11131b).stroke({ color: 0x444a66, width: 1 });
  // keyboard, mug, papers
  box(g, desk.x + 0.28, desk.y + 0.48, 0.44, 0.14, 2, 0x3a3f55, 14);
  if (seed & 1) box(g, desk.x + 0.86, desk.y + 0.5, 0.11, 0.11, 6, seed & 2 ? PALETTE.white : 0xd97757, 14);
  if (seed & 4) box(g, desk.x + 0.04, desk.y + 0.42, 0.22, 0.2, 1, PALETTE.paper, 14);
  root.addChild(g);
  const screen = new Graphics();
  root.addChild(screen);
  return { screen, screenRect: { x0: x0 + 0.03, x1: x1 - 0.03, y: y - 0.01, z0: z0 + 1.5, z1: z1 - 1.5 } };
}

/** Redraws the monitor contents for the given status. Called every frame; cheap. */
function drawScreen(parts: DeskParts, status: AgentStatus | "off", t: number) {
  const g = parts.screen;
  const r = parts.screenRect;
  g.clear();
  const c = status === "off" ? 0x7a7f93 : STATUS_COLOR[status];
  quadAlongX(g, r.x0, r.x1, r.y, r.z0, r.z1).fill(mix(PALETTE.screenOff, c, status === "off" ? 0.06 : 0.28));
  const h = r.z1 - r.z0, w = r.x1 - r.x0;
  const line = (frac: number, len: number, alpha: number) => {
    const z = r.z0 + 2 + frac * (h - 4);
    const a = toScreen(r.x0 + 0.04, r.y, z), b = toScreen(r.x0 + 0.04 + len * (w - 0.08), r.y, z);
    g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ color: c, width: 1.4, alpha });
  };
  if (status === "working") {
    for (let i = 0; i < 5; i++) {
      const k = (i / 5 + t * 0.35) % 1;
      line(1 - k, 0.35 + ((i * 37) % 60) / 100, 0.9 - k * 0.5);
    }
    g.alpha = 0.92 + Math.sin(t * 40) * 0.04;           // CRT-ish flicker
  } else if (status === "idle" || status === "done") {
    line(0.85, 0.6, 0.6); line(0.65, 0.4, 0.5); line(0.45, 0.7, 0.4);
    if (Math.floor(t * 2) % 2 === 0) line(0.2, 0.08, 0.9);   // blinking prompt
    g.alpha = 1;
  } else if (status === "blocked") {
    line(0.8, 0.5, 0.5); line(0.6, 0.65, 0.5);
    if (Math.floor(t * 3) % 2 === 0) {
      const z = r.z0 + h * 0.3;
      const a = toScreen(r.x0 + 0.04, r.y, z), b = toScreen(r.x1 - 0.04, r.y, z);
      g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ color: c, width: 3, alpha: 0.9 });
    }
    g.alpha = 1;
  } else {
    if (Math.floor(t * 1.5) % 2 === 0) line(0.15, 0.08, 0.7);  // lone cursor
    g.alpha = 1;
  }
}

// ------------------------------------------------------------------ empty desk

export function makeEmptyDesk(desk: Desk, state: CharState): DeskNode {
  const root = new Container();
  const seed = hashStr(desk.pane.pane_id);
  const parts = drawDeskFurniture(root, desk, seed, false);
  const chair = new Graphics();
  box(chair, desk.x + 0.25, desk.y - 0.7, 0.5, 0.45, 8, PALETTE.chair, 4);
  box(chair, desk.x + 0.25, desk.y - 0.7, 0.5, 0.1, 22, shade(PALETTE.chair, 1.15), 4);
  root.addChildAt(chair, 0);
  const tag = makeTag("shell", 0x9aa0b4, desk);
  root.addChild(tag);
  const top = toScreen(desk.x + 0.5, desk.y + 0.24, 39);
  return {
    root, desk, state, anchor: { x: top.x, y: top.y - 14 },
    tick(dt) { state.phase += dt; drawScreen(parts, "off", state.phase); },
  };
}

function makeTag(text: string, color: number, desk: Desk): Container {
  const c = new Container();
  const t = new Text({ text: text.toUpperCase(), style: tagStyle });
  t.anchor.set(0.5);
  const bg = new Graphics();
  const w = t.width + 10;
  bg.roundRect(-w / 2, -8, w, 16, 4).fill({ color, alpha: 0.95 }).stroke({ color: shade(color, 0.6), width: 1 });
  c.addChild(bg, t);
  const p = toScreen(desk.x + 0.5, desk.y + 0.95);
  c.position.set(p.x, p.y);
  return c;
}

// ------------------------------------------------------------------ character

export function makeCharacter(desk: Desk, state: CharState): DeskNode {
  const pane = desk.pane;
  const root = new Container();
  const seed = hashStr(pane.pane_id);
  const color = kindColor(pane.agent);
  const skin = SKIN[seed % SKIN.length]!;
  const hair = HAIR[(seed >> 4) % HAIR.length]!;

  // Chair behind the desk, then the person, then the desk in front.
  const chair = new Graphics();
  shadow(chair, desk.x + 0.5, desk.y - 0.45, 16, 7, 0.25);
  box(chair, desk.x + 0.25, desk.y - 0.7, 0.5, 0.45, 8, PALETTE.chair, 4);
  box(chair, desk.x + 0.25, desk.y - 0.7, 0.5, 0.1, 22, shade(PALETTE.chair, 1.15), 4);
  root.addChild(chair);

  const p = toScreen(desk.x + 0.5, desk.y - 0.48);
  const body = new Graphics();
  body.ellipse(p.x, p.y - 15, 9.5, 12).fill(color).stroke({ color: shade(color, 0.6), width: 1 });   // torso
  body.circle(p.x, p.y - 33, 7.5).fill(skin).stroke({ color: shade(skin, 0.7), width: 1 });         // head
  body.moveTo(p.x - 8, p.y - 34).arc(p.x, p.y - 34, 8, Math.PI, Math.PI * 2).closePath().fill(hair); // hair (explicit moveTo: arc() would otherwise start from a stale point)
  body.circle(p.x - 2.6, p.y - 33, 1).fill(0x222222);
  body.circle(p.x + 2.6, p.y - 33, 1).fill(0x222222);
  root.addChild(body);
  const hands = new Graphics();
  root.addChild(hands);

  const parts = drawDeskFurniture(root, desk, seed, true);
  root.addChild(makeTag(pane.agent ?? "agent", color, desk));

  // Status bubble above the head
  const bubble = new Container();
  const bubbleBg = new Graphics();
  const bubbleText = new Text({ text: "", style: bubbleStyle });
  bubbleText.anchor.set(0.5);
  bubble.addChild(bubbleBg, bubbleText);
  bubble.position.set(p.x + 16, p.y - 54);
  root.addChild(bubble);

  const glyphs = new Container();
  root.addChild(glyphs);
  const glyphPool = Array.from({ length: 3 }, () => { const t = new Text({ text: "", style: glyphStyle }); t.anchor.set(0.5); glyphs.addChild(t); return t; });

  let shown: AgentStatus | null = null;
  const applyStatus = () => {
    const st = state.status;
    const c = STATUS_COLOR[st];
    bubbleBg.clear();
    bubbleBg.roundRect(-11, -11, 22, 22, 6).fill(c).stroke({ color: shade(c, 0.6), width: 1.5 });
    bubbleBg.poly([-4, 10, 4, 10, -2, 16]).fill(c);
    bubbleText.text = st === "blocked" ? "?" : st === "done" ? "✓" : st === "idle" ? "☕" : st === "unknown" ? "~" : "…";
    root.alpha = st === "unknown" ? 0.6 : 1;
    shown = st;
  };
  applyStatus();

  const tick = (dt: number, now: number) => {
    state.phase += dt;
    const t = state.phase;
    if (shown !== state.status) applyStatus();
    hands.clear();
    for (const g of glyphPool) g.visible = false;
    drawScreen(parts, state.status, t);

    switch (state.status) {
      case "working": {
        const l = Math.sin(t * 14) * 1.5, r = Math.sin(t * 14 + Math.PI) * 1.5;
        hands.circle(p.x - 6, p.y - 5 + l, 2.5).fill(skin);
        hands.circle(p.x + 6, p.y - 5 + r, 2.5).fill(skin);
        body.y = Math.sin(t * 3) * 0.6;
        const cycle = (t * 0.9) % 1;
        glyphPool.forEach((g, i) => {
          const k = (cycle + i / glyphPool.length) % 1;
          g.visible = true;
          g.text = GLYPH_CHARS[(Math.floor(t * 0.9) + i * 5) % GLYPH_CHARS.length]!;
          g.position.set(p.x + 20 + Math.sin(k * 6) * 4 + i * 5, p.y - 14 - k * 36);
          g.alpha = 1 - k;
        });
        bubble.visible = false;
        break;
      }
      case "idle": {
        body.y = Math.sin(t * 1.4) * 1.2;
        hands.circle(p.x + 7, p.y - 13 + Math.sin(t * 1.4) * 1.2, 2.5).fill(skin);
        bubble.visible = true; bubble.alpha = 0.9; bubble.scale.set(1);
        bubble.y = p.y - 54;
        break;
      }
      case "blocked": {
        bubble.visible = true; bubble.alpha = 1;
        bubble.scale.set(1 + Math.sin(t * 5) * 0.12);
        bubble.y = p.y - 54;
        hands.circle(p.x + 11, p.y - 31 + Math.sin(t * 5) * 1.5, 2.5).fill(skin);
        body.y = 0;
        break;
      }
      case "done": {
        bubble.visible = true; bubble.alpha = 1; bubble.scale.set(1);
        bubble.y = p.y - 54 - Math.abs(Math.sin(t * 3)) * 5;
        body.y = -Math.abs(Math.sin(t * 3)) * 2;
        break;
      }
      default: {
        bubble.visible = true; bubble.alpha = 0.8; bubble.scale.set(1);
        bubble.y = p.y - 54; body.y = 0;
      }
    }
    // Pop on status change
    const since = now - state.lastChange;
    if (since < 600) bubble.scale.set(1 + (1 - since / 600) * 0.6);
  };

  return { root, desk, state, anchor: { x: p.x, y: p.y - 46 }, tick };
}
