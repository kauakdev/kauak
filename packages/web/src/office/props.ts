// Procedural office furniture and décor. Every prop is drawn into a Graphics
// at tile coordinates so it can be swapped for a sprite later.

import type { Graphics } from "pixi.js";
import { mix, shade, toScreen } from "./iso";
import { hex } from "@kauak/appearance/registry";
import { defaultTheme } from "../appearance/catalog";

export interface MaterialPalette {
  wood: number;
  woodDark: number;
  metal: number;
  chair: number;
  pot: number;
  leaf: number;
  leafDark: number;
  paper: number;
  screenOff: number;
  white: number;
}
export const PALETTE = Object.fromEntries(
  Object.entries(defaultTheme.materials).map(([k, c]) => [k, hex(c)]),
) as unknown as MaterialPalette;

/** Axis-aligned iso box; base at tile (x,y), footprint (w,d), from height z0 to z0+h px. */
export function box(g: Graphics, x: number, y: number, w: number, d: number, h: number, color: number, z0 = 0) {
  const z1 = z0 + h;
  const t0 = toScreen(x, y, z1),
    t1 = toScreen(x + w, y, z1),
    t2 = toScreen(x + w, y + d, z1),
    t3 = toScreen(x, y + d, z1);
  const bl = toScreen(x, y + d, z0),
    bf = toScreen(x + w, y + d, z0),
    br = toScreen(x + w, y, z0);
  g.poly([t3.x, t3.y, t2.x, t2.y, bf.x, bf.y, bl.x, bl.y]).fill(shade(color, 0.68)); // front-left face
  g.poly([t2.x, t2.y, t1.x, t1.y, br.x, br.y, bf.x, bf.y]).fill(shade(color, 0.84)); // front-right face
  g.poly([t0.x, t0.y, t1.x, t1.y, t2.x, t2.y, t3.x, t3.y]).fill(color); // top
}

/** Vertical quad on a wall that runs along X (constant y), between heights z0..z1. */
export function quadAlongX(g: Graphics, x0: number, x1: number, y: number, z0: number, z1: number) {
  const a = toScreen(x0, y, z0),
    b = toScreen(x1, y, z0),
    c = toScreen(x1, y, z1),
    d = toScreen(x0, y, z1);
  return g.poly([a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y]);
}

/** Vertical quad on a wall that runs along Y (constant x). */
export function quadAlongY(g: Graphics, x: number, y0: number, y1: number, z0: number, z1: number) {
  const a = toScreen(x, y0, z0),
    b = toScreen(x, y1, z0),
    c = toScreen(x, y1, z1),
    d = toScreen(x, y0, z1);
  return g.poly([a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y]);
}

export function floorPoly(g: Graphics, x: number, y: number, w: number, d: number, z = 0) {
  const a = toScreen(x, y, z),
    b = toScreen(x + w, y, z),
    c = toScreen(x + w, y + d, z),
    e = toScreen(x, y + d, z);
  return g.poly([a.x, a.y, b.x, b.y, c.x, c.y, e.x, e.y]);
}

export function shadow(g: Graphics, x: number, y: number, rx: number, ry: number, alpha = 0.28) {
  const p = toScreen(x, y);
  g.ellipse(p.x, p.y, rx, ry).fill({ color: 0x000000, alpha });
}

// ------------------------------------------------------------------ furniture

export function plant(g: Graphics, x: number, y: number, seed: number, palette: MaterialPalette = PALETTE) {
  shadow(g, x + 0.2, y + 0.2, 11, 5, 0.22);
  box(g, x, y, 0.4, 0.4, 9, palette.pot);
  const c = toScreen(x + 0.2, y + 0.2, 9);
  const leaves = 4 + (seed % 3);
  for (let i = 0; i < leaves; i++) {
    const a = (i / leaves) * Math.PI * 2 + seed;
    const r = 5 + ((seed >> (i + 2)) & 3);
    const col = i % 2 ? palette.leaf : palette.leafDark;
    g.circle(c.x + Math.cos(a) * 6, c.y - 8 + Math.sin(a) * 3.5, r).fill(col);
  }
  g.circle(c.x, c.y - 12, 6).fill(palette.leaf);
}

export function cabinet(g: Graphics, x: number, y: number, palette: MaterialPalette = PALETTE) {
  shadow(g, x + 0.3, y + 0.3, 14, 7, 0.22);
  box(g, x, y, 0.55, 0.45, 24, palette.metal);
  // drawer lines on the front-left face
  for (const z of [7, 15]) {
    const a = toScreen(x + 0.06, y + 0.45, z),
      b = toScreen(x + 0.49, y + 0.45, z);
    g.moveTo(a.x, a.y)
      .lineTo(b.x, b.y)
      .stroke({ color: shade(palette.metal, 0.5), width: 1 });
    const h = toScreen(x + 0.28, y + 0.45, z + 3);
    g.circle(h.x, h.y, 1.2).fill(0xd0d4e2);
  }
}

export function cooler(g: Graphics, x: number, y: number) {
  shadow(g, x + 0.18, y + 0.18, 9, 4.5, 0.22);
  box(g, x, y, 0.36, 0.36, 20, 0x3b4160);
  const c = toScreen(x + 0.18, y + 0.18, 20);
  g.ellipse(c.x, c.y - 7, 7, 11)
    .fill({ color: 0x8fd3ff, alpha: 0.85 })
    .stroke({ color: 0x5aa8d6, width: 1 });
  g.ellipse(c.x, c.y - 12, 5, 4).fill({ color: 0xc9ecff, alpha: 0.5 });
}

export function bookshelf(g: Graphics, x: number, y: number, seed: number, palette: MaterialPalette = PALETTE) {
  shadow(g, x + 0.45, y + 0.25, 22, 8, 0.22);
  box(g, x, y, 0.9, 0.3, 30, palette.woodDark);
  // books on two shelves of the front-left face
  const books = [0xe07a5f, 0x81b29a, 0xf2cc8f, 0x3d5a80, 0xee6c4d, 0x98c1d9, 0xd9a5b3];
  for (const shelf of [3, 16]) {
    let bx = x + 0.06;
    let i = seed;
    while (bx < x + 0.84) {
      const w = 0.06 + ((i >> 3) & 1) * 0.04;
      const h = 8 + ((i >> 5) & 3);
      quadAlongX(g, bx, bx + w, y + 0.3, shelf, shelf + h).fill(books[i % books.length]!);
      bx += w + 0.01;
      i = (i * 1103515245 + 12345) >>> 0;
    }
  }
}

export function sofa(g: Graphics, x: number, y: number, color: number) {
  shadow(g, x + 0.6, y + 0.3, 30, 10, 0.24);
  box(g, x, y, 1.2, 0.55, 10, color);
  box(g, x, y, 1.2, 0.14, 20, shade(color, 0.9)); // backrest
  box(g, x, y, 0.14, 0.55, 15, shade(color, 0.95)); // armrests
  box(g, x + 1.06, y, 0.14, 0.55, 15, shade(color, 0.95));
  const c = toScreen(x + 0.6, y + 0.3, 10);
  g.moveTo(c.x - 4, c.y + 1)
    .lineTo(c.x + 4, c.y - 1)
    .stroke({ color: shade(color, 0.7), width: 1 });
}

export function coffeeTable(g: Graphics, x: number, y: number, palette: MaterialPalette = PALETTE) {
  shadow(g, x + 0.3, y + 0.2, 15, 6, 0.18);
  box(g, x, y, 0.6, 0.4, 8, palette.wood);
  const c = toScreen(x + 0.3, y + 0.2, 8);
  g.circle(c.x - 4, c.y - 1, 2.2).fill(palette.white);
  g.rect(c.x + 1, c.y - 4, 7, 4).fill(0xc7a97a);
}

/** A drinks machine against a side wall (constant x), its front facing +x. Footprint 0.5 × 0.75. */
export function vendingMachine(g: Graphics, x: number, y: number, body: number, glow: number, accent: number) {
  const w = 0.5,
    f = x + w + 0.002;
  shadow(g, x + 0.3, y + 0.4, 17, 9, 0.25);
  box(g, x, y, w, 0.75, 36, body);
  // glass front with three shelves of drinks
  quadAlongY(g, f, y + 0.07, y + 0.5, 12, 31)
    .fill(0x141c2c)
    .stroke({ color: shade(body, 0.55), width: 1 });
  quadAlongY(g, f, y + 0.09, y + 0.48, 13, 30).fill({ color: glow, alpha: 0.16 });
  const drinks = [0xe07a5f, 0xf2cc8f, 0x81b29a, 0x98c1d9, 0xee6c4d, 0xd9a5b3];
  for (let row = 0; row < 3; row++) {
    const z = 15 + row * 5.5;
    const a = toScreen(f, y + 0.09, z - 0.5),
      b = toScreen(f, y + 0.48, z - 0.5);
    g.moveTo(a.x, a.y)
      .lineTo(b.x, b.y)
      .stroke({ color: shade(body, 1.3), width: 1, alpha: 0.5 });
    for (let k = 0; k < 3; k++) {
      const p = toScreen(f, y + 0.16 + k * 0.12, z);
      g.roundRect(p.x - 1.6, p.y - 4, 3.2, 4, 0.8).fill(drinks[(row * 3 + k * 2) % drinks.length]!);
    }
  }
  // keypad, coin slot, the hatch the drink drops into, a lit sign on top
  quadAlongY(g, f, y + 0.55, y + 0.69, 17, 31).fill(shade(body, 0.6));
  for (let k = 0; k < 4; k++) {
    const p = toScreen(f, y + 0.62, 20 + k * 2.6);
    g.circle(p.x, p.y, 0.9).fill(accent);
  }
  const slot = toScreen(f, y + 0.62, 15);
  g.rect(slot.x - 0.6, slot.y - 2, 1.2, 2.5).fill(0x0b0e15);
  quadAlongY(g, f, y + 0.14, y + 0.46, 3, 8)
    .fill(0x0b0e15)
    .stroke({ color: shade(body, 0.5), width: 1 });
  quadAlongY(g, f, y + 0.05, y + 0.7, 32.5, 35).fill({ color: glow, alpha: 0.9 });
}

/** A low bench against the back wall (constant y), `w` tiles long. */
export function bench(g: Graphics, x: number, y: number, w: number, palette: MaterialPalette = PALETTE) {
  shadow(g, x + w / 2, y + 0.2, w * 17, 6, 0.2);
  for (const lx of [x + 0.08, x + w - 0.16]) box(g, lx, y + 0.06, 0.08, 0.22, 5, palette.metal);
  box(g, x, y, w, 0.34, 3, palette.wood, 5);
}

export function rug(g: Graphics, x: number, y: number, w: number, d: number, color: number) {
  floorPoly(g, x, y, w, d, 0.5).fill({ color, alpha: 0.32 });
  floorPoly(g, x + 0.12, y + 0.12, w - 0.24, d - 0.24, 0.5).stroke({ color, alpha: 0.4, width: 1 });
}

export function lightPool(g: Graphics, x: number, y: number, rx: number, ry: number, color = 0xfff2d0, intensity = 0.105) {
  const c = toScreen(x, y, 0.5);
  for (let i = 3; i >= 1; i--) g.ellipse(c.x, c.y, rx * (i / 3), ry * (i / 3)).fill({ color, alpha: intensity / 3 });
}

// ------------------------------------------------------------------ basecamp
//
// The alpine décor: what a mountain hut and its campus have instead of
// plants, shelves, sofas and coffee tables.

const KIT = [0xe8742f, 0xf2c14e, 0xc8452f, 0x3d7ea6];
const ROCK_SNOW = 0xf4f7fa;

/** A small conifer; on the campus it stands in snow, indoors in a stone planter. Footprint 0.45 × 0.45. */
export function pine(g: Graphics, x: number, y: number, seed: number, palette: MaterialPalette = PALETTE, snowy = false) {
  shadow(g, x + 0.22, y + 0.22, 12, 5.5, 0.24);
  const lift = snowy ? 0 : 6;
  if (!snowy) box(g, x + 0.04, y + 0.04, 0.36, 0.36, 6, palette.pot);
  const c = toScreen(x + 0.22, y + 0.22, lift);
  g.rect(c.x - 1.5, c.y - 5, 3, 5).fill(palette.woodDark);
  const s = 0.9 + (seed % 4) * 0.08;
  let bottom = c.y - 4;
  for (let i = 0; i < 3; i++) {
    const w = (11 - i * 2.6) * s,
      h = (13 - i * 1.5) * s,
      top = bottom - h;
    g.poly([c.x, top, c.x - w, bottom, c.x, bottom + 2]).fill(palette.leafDark);
    g.poly([c.x, top, c.x + w, bottom, c.x, bottom + 2]).fill(palette.leaf);
    if (snowy)
      g.poly([
        c.x,
        top,
        c.x - w * 0.45,
        top + h * 0.45,
        c.x - w * 0.15,
        top + h * 0.36,
        c.x,
        top + h * 0.48,
        c.x + w * 0.2,
        top + h * 0.38,
        c.x + w * 0.45,
        top + h * 0.45,
      ]).fill({ color: palette.white, alpha: 0.92 });
    bottom -= h * 0.55;
  }
}

/** A snow-capped boulder. Footprint 0.5 × 0.5. */
export function boulder(g: Graphics, x: number, y: number, seed: number, palette: MaterialPalette = PALETTE) {
  shadow(g, x + 0.25, y + 0.25, 14, 6, 0.24);
  const c = toScreen(x + 0.25, y + 0.25),
    s = 0.75 + (seed % 5) * 0.09;
  const at = (pts: number[]) => pts.map((v, i) => (i % 2 ? c.y + v * s : c.x + v * s));
  g.poly(at([-12, 0, -10, -8, -4, -13, 3, -12, 9, -7, 12, 0, 4, 3, -6, 3])).fill(shade(palette.pot, 0.78));
  g.poly(at([-4, -13, 3, -12, 9, -7, 12, 0, 4, 3, 2, -5, -5, -7])).fill(palette.pot);
  g.poly(at([-10, -8, -4, -13, 3, -12, 9, -7, 4, -8.5, 0, -7, -5, -8.5])).fill(ROCK_SNOW);
}

/** An A-frame tent, its ridge along x and its door at the +x end. Footprint 0.85 × 0.6. */
export function tent(g: Graphics, x: number, y: number, color: number) {
  const w = 0.85,
    d = 0.6,
    h = 17;
  shadow(g, x + w / 2, y + d / 2, 24, 10, 0.24);
  const b0 = toScreen(x, y),
    b1 = toScreen(x + w, y),
    b2 = toScreen(x + w, y + d),
    b3 = toScreen(x, y + d);
  const r0 = toScreen(x + 0.04, y + d / 2, h),
    r1 = toScreen(x + w - 0.04, y + d / 2, h);
  g.poly([b0.x, b0.y, b1.x, b1.y, r1.x, r1.y, r0.x, r0.y]).fill(shade(color, 0.6));
  g.poly([b1.x, b1.y, b2.x, b2.y, r1.x, r1.y]).fill(shade(color, 0.8));
  const m = toScreen(x + w, y + d / 2),
    dl = toScreen(x + w, y + d * 0.3),
    dr = toScreen(x + w, y + d * 0.7),
    dt = toScreen(x + w - 0.02, y + d / 2, h * 0.7);
  g.poly([dl.x, dl.y, dt.x, dt.y, dr.x, dr.y]).fill(shade(color, 0.42));
  g.moveTo(m.x, m.y)
    .lineTo(dt.x, dt.y)
    .stroke({ color: shade(color, 0.6), width: 0.8 });
  g.poly([r0.x, r0.y, r1.x, r1.y, b2.x, b2.y, b3.x, b3.y]).fill(color);
  g.moveTo(r0.x, r0.y)
    .lineTo(r1.x, r1.y)
    .stroke({ color: shade(color, 1.25), width: 1.2 });
  // guy lines to their stakes
  for (const [r, sx] of [
    [r0, x - 0.18],
    [r1, x + w + 0.18],
  ] as const) {
    const s = toScreen(sx, y + d / 2);
    g.moveTo(r.x, r.y).lineTo(s.x, s.y).stroke({ color: 0xd0d4e2, width: 0.6, alpha: 0.8 });
  }
}

/** Expedition duffels stacked in a corner. Footprint 0.55 × 0.45. */
export function duffels(g: Graphics, x: number, y: number, seed: number) {
  shadow(g, x + 0.28, y + 0.24, 15, 7, 0.22);
  const bag = (bx: number, by: number, w: number, d: number, h: number, color: number, z0 = 0) => {
    box(g, bx, by, w, d, h, color, z0);
    for (const k of [0.28, 0.72]) {
      const sx = bx + w * k,
        a = toScreen(sx, by + d, z0),
        b = toScreen(sx, by + d, z0 + h),
        c = toScreen(sx, by, z0 + h);
      g.moveTo(a.x, a.y)
        .lineTo(b.x, b.y)
        .lineTo(c.x, c.y)
        .stroke({ color: shade(color, 0.5), width: 1.2 });
    }
    const za = toScreen(bx + 0.05, by + d / 2, z0 + h),
      zb = toScreen(bx + w - 0.05, by + d / 2, z0 + h);
    g.moveTo(za.x, za.y)
      .lineTo(zb.x, zb.y)
      .stroke({ color: shade(color, 1.3), width: 0.8 });
  };
  bag(x, y + 0.02, 0.55, 0.21, 8, KIT[seed % KIT.length]!);
  bag(x, y + 0.24, 0.55, 0.21, 8, KIT[(seed + 1) % KIT.length]!);
  bag(x + 0.05, y + 0.1, 0.45, 0.24, 7, KIT[(seed + 2) % KIT.length]!, 8);
}

/** A gear rack against the front: coiled ropes on pegs, helmets on the shelf, ice axes below. Footprint 0.9 × 0.3. */
export function gearRack(g: Graphics, x: number, y: number, seed: number, palette: MaterialPalette = PALETTE) {
  shadow(g, x + 0.45, y + 0.25, 22, 8, 0.22);
  box(g, x, y, 0.9, 0.1, 30, palette.woodDark);
  box(g, x + 0.04, y + 0.1, 0.82, 0.2, 2, palette.wood, 13);
  const face = y + 0.12;
  // ice axes leaning on the board
  for (const ax of [x + 0.2, x + 0.55]) {
    const a = toScreen(ax, y + 0.24, 0),
      b = toScreen(ax + 0.08, face, 12);
    g.moveTo(a.x, a.y)
      .lineTo(b.x, b.y)
      .stroke({ color: shade(palette.metal, 0.75), width: 1.6 });
    g.moveTo(b.x - 4, b.y + 1)
      .lineTo(b.x + 4, b.y - 1.5)
      .stroke({ color: palette.metal, width: 1.8 });
  }
  // helmets on the shelf
  for (const [k, hx] of [x + 0.28, x + 0.62].entries()) {
    const p = toScreen(hx, y + 0.2, 15),
      col = KIT[(seed + k * 3) % KIT.length]!;
    g.moveTo(p.x - 4.5, p.y)
      .arc(p.x, p.y, 4.5, Math.PI, Math.PI * 2)
      .closePath()
      .fill(col)
      .stroke({ color: shade(col, 0.6), width: 0.8 });
    g.ellipse(p.x, p.y, 5.2, 1.2).fill(shade(col, 0.75));
  }
  // coiled ropes on pegs
  const ropes = [0xe0533d, 0x3fa7d6, 0x7bd389, 0xf2c14e];
  for (let k = 0; k < 3; k++) {
    const p = toScreen(x + 0.18 + k * 0.27, face, 23),
      col = ropes[(seed + k) % ropes.length]!;
    g.ellipse(p.x, p.y + 1, 4.6, 5.2).stroke({ color: col, width: 2.2 });
    g.ellipse(p.x, p.y + 1, 2.8, 3.4).stroke({ color: shade(col, 0.8), width: 1.2 });
    g.moveTo(p.x + 1, p.y + 5.5)
      .lineTo(p.x + 2, p.y + 10)
      .stroke({ color: col, width: 1.4 });
    g.circle(p.x, p.y - 4.4, 1).fill(palette.metal);
  }
  // the rack's posts
  box(g, x, y, 0.06, 0.3, 30, palette.wood);
  box(g, x + 0.84, y, 0.06, 0.3, 30, palette.wood);
}

/** A log to sit on, with a wool blanket thrown over it. Footprint 1.2 × 0.55, like a sofa. */
export function logBench(g: Graphics, x: number, y: number, blanket: number, palette: MaterialPalette = PALETTE) {
  shadow(g, x + 0.6, y + 0.3, 28, 9, 0.22);
  box(g, x, y + 0.1, 1.2, 0.4, 9, palette.woodDark);
  for (const z of [3, 6]) {
    const a = toScreen(x + 0.05, y + 0.5, z),
      b = toScreen(x + 1.15, y + 0.5, z);
    g.moveTo(a.x, a.y)
      .lineTo(b.x, b.y)
      .stroke({ color: shade(palette.woodDark, 0.7), width: 0.8 });
  }
  const e = toScreen(x + 1.2, y + 0.3, 4.5); // sawn end, with its rings
  g.ellipse(e.x, e.y, 6, 5.5).fill(palette.wood).stroke({ color: palette.woodDark, width: 1 });
  g.ellipse(e.x, e.y, 3, 2.7).stroke({ color: shade(palette.wood, 0.75), width: 0.8 });
  floorPoly(g, x + 0.3, y + 0.1, 0.55, 0.4, 9.05).fill(blanket);
  quadAlongX(g, x + 0.3, x + 0.85, y + 0.5, 2, 9.05).fill(shade(blanket, 0.75));
  const f0 = toScreen(x + 0.3, y + 0.5, 4),
    f1 = toScreen(x + 0.85, y + 0.5, 4);
  g.moveTo(f0.x, f0.y)
    .lineTo(f1.x, f1.y)
    .stroke({ color: shade(blanket, 1.3), width: 1, alpha: 0.7 });
}

/** A ring of stones with a log fire laid in it; the flames are drawn apart (`flames`) so they can flicker. Footprint 0.6 × 0.4. */
export function firePit(g: Graphics, x: number, y: number, glow: number, palette: MaterialPalette = PALETTE) {
  const c = toScreen(x + 0.3, y + 0.2);
  g.ellipse(c.x, c.y, 30, 15).fill({ color: glow, alpha: 0.08 });
  g.ellipse(c.x, c.y, 18, 9).fill({ color: glow, alpha: 0.12 });
  g.ellipse(c.x, c.y, 9, 4.5).fill(0x2a2220);
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    g.ellipse(c.x + Math.cos(a) * 11, c.y + Math.sin(a) * 5.5 - 1.2, 3.2, 2.3).fill(i % 2 ? palette.pot : shade(palette.pot, 0.8));
  }
  g.moveTo(c.x - 7, c.y + 1)
    .lineTo(c.x + 6, c.y - 3)
    .stroke({ color: palette.woodDark, width: 3, cap: "round" });
  g.moveTo(c.x - 6, c.y - 2.5)
    .lineTo(c.x + 7, c.y + 1.5)
    .stroke({ color: shade(palette.woodDark, 1.2), width: 3, cap: "round" });
}

/** Flames around their base at (0, 0), to place over a fire pit. */
export function flames(g: Graphics) {
  g.poly([-6, 0, -5, -7, -2, -4, 0, -15, 2.5, -6, 5, -9, 6, 0]).fill({ color: 0xff8c42, alpha: 0.95 });
  g.poly([-3.5, 0, -1.5, -6, 0.5, -9.5, 2.5, -4, 3.5, 0]).fill(0xffd166);
  g.ellipse(0, -1, 3, 1.5).fill(0xfff2d0);
}

/** A topo map pinned to a side wall: contour rings round a summit, and the route up it camp by camp. */
export function routeMapOnSideWall(
  g: Graphics,
  x: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
  seed: number,
  palette: MaterialPalette = PALETTE,
) {
  quadAlongY(g, x, y0, y1, z0, z1).fill(palette.paper).stroke({ color: palette.woodDark, width: 2 });
  const span = y1 - y0,
    h = z1 - z0;
  const at = (fy: number, fz: number) => toScreen(x, y0 + fy * span, z0 + fz * h);
  const sy = 0.55 + ((seed >> 3) % 15) / 100,
    sz = 0.66;
  for (let k = 1; k <= 4; k++) {
    const pts: number[] = [];
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2,
        wob = 1 + (((seed >> (i + k)) & 3) - 1.5) * 0.06;
      const p = at(sy + Math.cos(a) * k * 0.09 * wob, sz + Math.sin(a) * k * 0.14 * wob);
      pts.push(p.x, p.y);
    }
    g.poly(pts).stroke({ color: 0xa08a6a, width: 0.8, alpha: 0.75 });
  }
  const route = [at(0.1, 0.12), at(0.3, 0.3), at(0.22, 0.48), at(0.42, 0.56), at(sy, sz)];
  route.forEach((p, i) => {
    if (i) {
      const q = route[i - 1]!;
      g.moveTo(q.x, q.y).lineTo(p.x, p.y).stroke({ color: 0xd9480f, width: 1.2 });
    }
    if (i < route.length - 1) g.circle(p.x, p.y, 1.3).fill(0x2a2e3f);
  });
  const top = route[route.length - 1]!;
  g.moveTo(top.x, top.y)
    .lineTo(top.x, top.y - 6)
    .stroke({ color: 0x2a2e3f, width: 0.8 });
  g.poly([top.x, top.y - 6, top.x - 4, top.y - 5, top.x, top.y - 3.5]).fill(0xd9480f);
}

/** A framed poster of a peak at dusk on a side wall. */
export function peakPosterOnSideWall(
  g: Graphics,
  x: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
  color: number,
  palette: MaterialPalette = PALETTE,
) {
  quadAlongY(g, x, y0, y1, z0, z1)
    .fill(mix(color, 0x10121a, 0.55))
    .stroke({ color: palette.woodDark, width: 1.5 });
  const span = y1 - y0,
    h = z1 - z0;
  const at = (fy: number, fz: number) => toScreen(x, y0 + fy * span, z0 + fz * h);
  const sun = at(0.3, 0.72);
  g.circle(sun.x, sun.y, 2.4).fill({ color: 0xffd9a0, alpha: 0.9 });
  const ridge = [at(0.06, 0.1), at(0.3, 0.45), at(0.42, 0.36), at(0.64, 0.82), at(0.82, 0.5), at(0.94, 0.4), at(0.94, 0.1)];
  g.poly(ridge.flatMap((p) => [p.x, p.y])).fill(0x3d4a5c);
  const cap = [at(0.64, 0.82), at(0.56, 0.62), at(0.6, 0.66), at(0.66, 0.6), at(0.73, 0.66)];
  g.poly(cap.flatMap((p) => [p.x, p.y])).fill(palette.white);
}

// ------------------------------------------------------------------ printer
//
// The room's printer (printer-animator.ts): a printer on a low stand, paper
// standing in its feed at the back and printed sheets landing on a tray in
// front of it (+y). The sheets and the light are drawn apart, so they can be
// animated.

/** Its footprint from its back corner, in tiles; where a sheet lies on the tray; heights in px. */
export const PRINTER = {
  w: 0.6,
  d: 0.84,
  sheet: { x: 0.15, y: 0.47, w: 0.3, d: 0.33 },
  slotY: 0.443,
  slotZ: 16.2,
  trayZ: 11.9,
  sheetH: 0.6,
  stackMax: 6,
};
const PRINTER_BODY = 0xe2e5ed;
const PAPER = 0xfbfaf5;
const PAPER_EDGE = 0xb4b0a4;

export function printer(g: Graphics, x: number, y: number, palette: MaterialPalette = PALETTE) {
  shadow(g, x + 0.3, y + 0.42, 18, 9, 0.24);
  // A small cabinet to stand on
  box(g, x, y, 0.6, 0.46, 11, palette.metal);
  const s0 = toScreen(x + 0.3, y + 0.46, 2),
    s1 = toScreen(x + 0.3, y + 0.46, 9.5);
  g.moveTo(s0.x, s0.y)
    .lineTo(s1.x, s1.y)
    .stroke({ color: shade(palette.metal, 0.55), width: 1 });
  for (const hx of [0.25, 0.35]) {
    const h = toScreen(x + hx, y + 0.46, 7);
    g.circle(h.x, h.y, 0.9).fill(0xd0d4e2);
  }
  // Body, with paper standing in the feed at the back and a control panel
  box(g, x + 0.02, y + 0.02, 0.56, 0.42, 9, PRINTER_BODY, 11);
  floorPoly(g, x + 0.1, y + 0.05, 0.36, 0.16, 20.02).fill(shade(PRINTER_BODY, 0.72));
  const a = toScreen(x + 0.13, y + 0.15, 20),
    b = toScreen(x + 0.43, y + 0.15, 20),
    c = toScreen(x + 0.43, y + 0.07, 28),
    d = toScreen(x + 0.13, y + 0.07, 28);
  g.poly([a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y]).fill(PAPER).stroke({ color: PAPER_EDGE, width: 0.8 });
  floorPoly(g, x + 0.4, y + 0.27, 0.15, 0.14, 20.02).fill(0x2a2e3f);
  // The slot sheets come out of, and the tray they land on
  quadAlongX(g, x + 0.1, x + 0.5, y + PRINTER.slotY, PRINTER.slotZ - 0.9, PRINTER.slotZ + 0.9).fill(0x1c1f2b);
  box(g, x + 0.1, y + 0.44, 0.4, 0.4, 0.7, shade(PRINTER_BODY, 0.82), PRINTER.trayZ - 0.7);
}

/** The printer's light, on its control panel. */
export function printerLight(g: Graphics, x: number, y: number, color: number, glow: boolean) {
  const p = toScreen(x + 0.49, y + 0.34, 20.3);
  if (glow) g.ellipse(p.x, p.y, 5, 2.8).fill({ color, alpha: 0.28 });
  g.ellipse(p.x, p.y, 2.2, 1.3).fill(color);
}

/** Height of the top of `n` sheets on the tray (only a few are drawn). */
export function paperTop(n: number): number {
  return PRINTER.trayZ + Math.min(n, PRINTER.stackMax) * PRINTER.sheetH;
}

/** `n` printed sheets on the tray, the top one with rows of print. */
export function paperStack(g: Graphics, x: number, y: number, n: number) {
  const s = PRINTER.sheet,
    shown = Math.min(n, PRINTER.stackMax);
  for (let i = 0; i < shown; i++) {
    const jx = (((i * 7919) % 5) - 2) * 0.01,
      jy = (((i * 104729) % 5) - 2) * 0.008;
    const z = paperTop(i + 1);
    floorPoly(g, x + s.x + jx, y + s.y + jy, s.w, s.d, z)
      .fill(i % 2 ? PAPER : shade(PAPER, 0.95))
      .stroke({ color: PAPER_EDGE, width: 0.6 });
    if (i === shown - 1) printRows(g, x + s.x + jx, y + s.y + jy, z, 1);
  }
}

/**
 * The sheet being printed: `out` (0..1) of it is out of the slot, and it has
 * fallen `fall` (0..1) of the way from the slot onto `landZ`.
 */
export function printingSheet(g: Graphics, x: number, y: number, out: number, fall: number, landZ: number) {
  const s = PRINTER.sheet;
  const sy = y + PRINTER.slotY + (s.y - PRINTER.slotY) * fall;
  const z = PRINTER.slotZ + (landZ - PRINTER.slotZ) * fall;
  floorPoly(g, x + s.x, sy, s.w, s.d * out, z)
    .fill(PAPER)
    .stroke({ color: PAPER_EDGE, width: 0.6 });
  printRows(g, x + s.x, sy, z, out);
}

/** Rows of a diff on a sheet lying at height z, as far as `share` (0..1) of it is out. */
function printRows(g: Graphics, x: number, y: number, z: number, share: number) {
  const lens = [0.17, 0.12, 0.2, 0.2, 0.09, 0.15];
  const ink = [0x3d4256, 0x8a8f9e, 0x2f9e44, 0xd9480f, 0x8a8f9e, 0x8a8f9e];
  lens.forEach((len, k) => {
    const ry = y + 0.05 + k * 0.045;
    if (ry > y + PRINTER.sheet.d * share - 0.02) return;
    const a = toScreen(x + 0.04 + (k === 1 || k === 4 ? 0.03 : 0), ry, z),
      b = toScreen(x + 0.04 + len, ry, z);
    g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ color: ink[k]!, width: 0.8, alpha: 0.9 });
  });
}

// ------------------------------------------------------------------ wall décor

/** A window in a back wall; with `peaks`, snowy mountains show through it. */
export function windowOnBackWall(g: Graphics, x0: number, x1: number, y: number, z0: number, z1: number, peaks = false) {
  quadAlongX(g, x0, x1, y, z0, z1).fill(0x1d2740).stroke({ color: 0x8e96b4, width: 1.5 });
  const mid = (x0 + x1) / 2,
    zm = (z0 + z1) / 2;
  quadAlongX(g, x0 + 0.05, x1 - 0.05, y, z0 + 2, z1 - 2).fill({ color: 0x6fb3ff, alpha: 0.35 });
  quadAlongX(g, x0 + 0.05, x1 - 0.05, y, zm + 2, z1 - 2).fill({ color: 0xa9d5ff, alpha: 0.25 });
  if (peaks) {
    const w = x1 - x0 - 0.1,
      h = z1 - z0 - 4,
      at = (fx: number, fz: number) => toScreen(x0 + 0.05 + fx * w, y, z0 + 2 + fz * h);
    const ridge = [at(0, 0), at(0, 0.3), at(0.22, 0.62), at(0.36, 0.44), at(0.6, 0.86), at(0.82, 0.5), at(1, 0.38), at(1, 0)];
    g.poly(ridge.flatMap((p) => [p.x, p.y])).fill({ color: 0x4a5d78, alpha: 0.9 });
    for (const [px, pz] of [
      [0.22, 0.62],
      [0.6, 0.86],
    ] as const) {
      const cap = [at(px, pz), at(px - 0.09, pz - 0.2), at(px - 0.02, pz - 0.14), at(px + 0.04, pz - 0.2), at(px + 0.1, pz - 0.18)];
      g.poly(cap.flatMap((p) => [p.x, p.y])).fill({ color: 0xf4f7fa, alpha: 0.9 });
    }
  }
  const a = toScreen(mid, y, z0),
    b = toScreen(mid, y, z1);
  g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ color: 0x8e96b4, width: 1 });
  const c = toScreen(x0, y, zm),
    d = toScreen(x1, y, zm);
  g.moveTo(c.x, c.y).lineTo(d.x, d.y).stroke({ color: 0x8e96b4, width: 1 });
  // light spill on the floor in front of the window
  const w = x1 - x0;
  const f0 = toScreen(x0, y, 0),
    f1 = toScreen(x1, y, 0),
    f2 = toScreen(x1 + w * 0.35, y + 1.6, 0.4),
    f3 = toScreen(x0 + w * 0.35, y + 1.6, 0.4);
  g.poly([f0.x, f0.y, f1.x, f1.y, f2.x, f2.y, f3.x, f3.y]).fill({ color: 0xbfe0ff, alpha: 0.05 });
}

export function whiteboardOnSideWall(
  g: Graphics,
  x: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
  seed: number,
  palette: MaterialPalette = PALETTE,
) {
  quadAlongY(g, x, y0, y1, z0, z1).fill(palette.white).stroke({ color: 0x9aa0b4, width: 1.5 });
  const colors = [0x3d5a80, 0xe07a5f, 0x2a9d8f, 0x222222];
  let i = seed;
  for (let k = 0; k < 5; k++) {
    const yy = y0 + 0.12 + (((i >> 2) % 60) / 100) * (y1 - y0 - 0.3);
    const len = 0.12 + (((i >> 8) % 40) / 100) * (y1 - y0 - 0.4);
    const zz = z1 - 3 - k * ((z1 - z0 - 6) / 5);
    const a = toScreen(x, yy, zz),
      b = toScreen(x, yy + len, zz);
    g.moveTo(a.x, a.y)
      .lineTo(b.x, b.y)
      .stroke({ color: colors[i % colors.length]!, width: 1.2, alpha: 0.85 });
    i = (i * 1103515245 + 12345) >>> 0;
  }
  // marker tray
  const t0 = toScreen(x, y0, z0 - 1),
    t1 = toScreen(x, y1, z0 - 1);
  g.moveTo(t0.x, t0.y).lineTo(t1.x, t1.y).stroke({ color: 0x9aa0b4, width: 2 });
}

export function posterOnSideWall(g: Graphics, x: number, y0: number, y1: number, z0: number, z1: number, color: number) {
  quadAlongY(g, x, y0, y1, z0, z1)
    .fill(mix(color, 0x10121a, 0.5))
    .stroke({ color: 0x9aa0b4, width: 1 });
  quadAlongY(g, x, y0 + 0.08, y1 - 0.08, z0 + 3, z1 - 3).fill({ color, alpha: 0.6 });
}

export function clockOnBackWall(g: Graphics, x: number, y: number, z: number, palette: MaterialPalette = PALETTE) {
  const c = toScreen(x, y, z);
  g.circle(c.x, c.y, 5).fill(palette.white).stroke({ color: 0x555a70, width: 1 });
  g.moveTo(c.x, c.y)
    .lineTo(c.x, c.y - 3.5)
    .stroke({ color: 0x222222, width: 1 });
  g.moveTo(c.x, c.y)
    .lineTo(c.x + 2.5, c.y + 1)
    .stroke({ color: 0x222222, width: 1 });
}
