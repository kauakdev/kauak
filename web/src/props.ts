// Procedural office furniture and décor. Every prop is drawn into a Graphics
// at tile coordinates so it can be swapped for a sprite later.

import { Graphics } from "pixi.js";
import { mix, shade, toScreen } from "./iso";
import { hex } from "../../shared/plugins/registry";
import { defaultTheme } from "./plugins/catalog";

export interface MaterialPalette {
  wood: number; woodDark: number; metal: number; chair: number; pot: number;
  leaf: number; leafDark: number; paper: number; screenOff: number; white: number;
}
export const PALETTE = Object.fromEntries(Object.entries(defaultTheme.materials).map(([k, c]) => [k, hex(c)])) as unknown as MaterialPalette;

/** Axis-aligned iso box; base at tile (x,y), footprint (w,d), from height z0 to z0+h px. */
export function box(g: Graphics, x: number, y: number, w: number, d: number, h: number, color: number, z0 = 0) {
  const z1 = z0 + h;
  const t0 = toScreen(x, y, z1), t1 = toScreen(x + w, y, z1), t2 = toScreen(x + w, y + d, z1), t3 = toScreen(x, y + d, z1);
  const bl = toScreen(x, y + d, z0), bf = toScreen(x + w, y + d, z0), br = toScreen(x + w, y, z0);
  g.poly([t3.x, t3.y, t2.x, t2.y, bf.x, bf.y, bl.x, bl.y]).fill(shade(color, 0.68));   // front-left face
  g.poly([t2.x, t2.y, t1.x, t1.y, br.x, br.y, bf.x, bf.y]).fill(shade(color, 0.84));   // front-right face
  g.poly([t0.x, t0.y, t1.x, t1.y, t2.x, t2.y, t3.x, t3.y]).fill(color);                // top
}

/** Vertical quad on a wall that runs along X (constant y), between heights z0..z1. */
export function quadAlongX(g: Graphics, x0: number, x1: number, y: number, z0: number, z1: number) {
  const a = toScreen(x0, y, z0), b = toScreen(x1, y, z0), c = toScreen(x1, y, z1), d = toScreen(x0, y, z1);
  return g.poly([a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y]);
}

/** Vertical quad on a wall that runs along Y (constant x). */
export function quadAlongY(g: Graphics, x: number, y0: number, y1: number, z0: number, z1: number) {
  const a = toScreen(x, y0, z0), b = toScreen(x, y1, z0), c = toScreen(x, y1, z1), d = toScreen(x, y0, z1);
  return g.poly([a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y]);
}

export function floorPoly(g: Graphics, x: number, y: number, w: number, d: number, z = 0) {
  const a = toScreen(x, y, z), b = toScreen(x + w, y, z), c = toScreen(x + w, y + d, z), e = toScreen(x, y + d, z);
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
    const a = toScreen(x + 0.06, y + 0.45, z), b = toScreen(x + 0.49, y + 0.45, z);
    g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ color: shade(palette.metal, 0.5), width: 1 });
    const h = toScreen(x + 0.28, y + 0.45, z + 3);
    g.circle(h.x, h.y, 1.2).fill(0xd0d4e2);
  }
}

export function cooler(g: Graphics, x: number, y: number) {
  shadow(g, x + 0.18, y + 0.18, 9, 4.5, 0.22);
  box(g, x, y, 0.36, 0.36, 20, 0x3b4160);
  const c = toScreen(x + 0.18, y + 0.18, 20);
  g.ellipse(c.x, c.y - 7, 7, 11).fill({ color: 0x8fd3ff, alpha: 0.85 }).stroke({ color: 0x5aa8d6, width: 1 });
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
  box(g, x, y, 1.2, 0.14, 20, shade(color, 0.9));           // backrest
  box(g, x, y, 0.14, 0.55, 15, shade(color, 0.95));         // armrests
  box(g, x + 1.06, y, 0.14, 0.55, 15, shade(color, 0.95));
  const c = toScreen(x + 0.6, y + 0.3, 10);
  g.moveTo(c.x - 4, c.y + 1).lineTo(c.x + 4, c.y - 1).stroke({ color: shade(color, 0.7), width: 1 });
}

export function coffeeTable(g: Graphics, x: number, y: number, palette: MaterialPalette = PALETTE) {
  shadow(g, x + 0.3, y + 0.2, 15, 6, 0.18);
  box(g, x, y, 0.6, 0.4, 8, palette.wood);
  const c = toScreen(x + 0.3, y + 0.2, 8);
  g.circle(c.x - 4, c.y - 1, 2.2).fill(palette.white);
  g.rect(c.x + 1, c.y - 4, 7, 4).fill(0xc7a97a);
}

export function rug(g: Graphics, x: number, y: number, w: number, d: number, color: number) {
  floorPoly(g, x, y, w, d, 0.5).fill({ color, alpha: 0.32 });
  floorPoly(g, x + 0.12, y + 0.12, w - 0.24, d - 0.24, 0.5).stroke({ color, alpha: 0.4, width: 1 });
}

export function lightPool(g: Graphics, x: number, y: number, rx: number, ry: number, color = 0xfff2d0, intensity = 0.105) {
  const c = toScreen(x, y, 0.5);
  for (let i = 3; i >= 1; i--) g.ellipse(c.x, c.y, rx * (i / 3), ry * (i / 3)).fill({ color, alpha: intensity / 3 });
}

// ------------------------------------------------------------------ wall décor

export function windowOnBackWall(g: Graphics, x0: number, x1: number, y: number, z0: number, z1: number) {
  quadAlongX(g, x0, x1, y, z0, z1).fill(0x1d2740).stroke({ color: 0x8e96b4, width: 1.5 });
  const mid = (x0 + x1) / 2, zm = (z0 + z1) / 2;
  quadAlongX(g, x0 + 0.05, x1 - 0.05, y, z0 + 2, z1 - 2).fill({ color: 0x6fb3ff, alpha: 0.35 });
  quadAlongX(g, x0 + 0.05, x1 - 0.05, y, zm + 2, z1 - 2).fill({ color: 0xa9d5ff, alpha: 0.25 });
  const a = toScreen(mid, y, z0), b = toScreen(mid, y, z1);
  g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ color: 0x8e96b4, width: 1 });
  const c = toScreen(x0, y, zm), d = toScreen(x1, y, zm);
  g.moveTo(c.x, c.y).lineTo(d.x, d.y).stroke({ color: 0x8e96b4, width: 1 });
  // light spill on the floor in front of the window
  const w = x1 - x0;
  const f0 = toScreen(x0, y, 0), f1 = toScreen(x1, y, 0), f2 = toScreen(x1 + w * 0.35, y + 1.6, 0.4), f3 = toScreen(x0 + w * 0.35, y + 1.6, 0.4);
  g.poly([f0.x, f0.y, f1.x, f1.y, f2.x, f2.y, f3.x, f3.y]).fill({ color: 0xbfe0ff, alpha: 0.05 });
}

export function whiteboardOnSideWall(g: Graphics, x: number, y0: number, y1: number, z0: number, z1: number, seed: number, palette: MaterialPalette = PALETTE) {
  quadAlongY(g, x, y0, y1, z0, z1).fill(palette.white).stroke({ color: 0x9aa0b4, width: 1.5 });
  const colors = [0x3d5a80, 0xe07a5f, 0x2a9d8f, 0x222222];
  let i = seed;
  for (let k = 0; k < 5; k++) {
    const yy = y0 + 0.12 + ((i >> 2) % 60) / 100 * (y1 - y0 - 0.3);
    const len = 0.12 + ((i >> 8) % 40) / 100 * (y1 - y0 - 0.4);
    const zz = z1 - 3 - k * ((z1 - z0 - 6) / 5);
    const a = toScreen(x, yy, zz), b = toScreen(x, yy + len, zz);
    g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ color: colors[i % colors.length]!, width: 1.2, alpha: 0.85 });
    i = (i * 1103515245 + 12345) >>> 0;
  }
  // marker tray
  const t0 = toScreen(x, y0, z0 - 1), t1 = toScreen(x, y1, z0 - 1);
  g.moveTo(t0.x, t0.y).lineTo(t1.x, t1.y).stroke({ color: 0x9aa0b4, width: 2 });
}

export function posterOnSideWall(g: Graphics, x: number, y0: number, y1: number, z0: number, z1: number, color: number) {
  quadAlongY(g, x, y0, y1, z0, z1).fill(mix(color, 0x10121a, 0.5)).stroke({ color: 0x9aa0b4, width: 1 });
  quadAlongY(g, x, y0 + 0.08, y1 - 0.08, z0 + 3, z1 - 3).fill({ color, alpha: 0.6 });
}

export function clockOnBackWall(g: Graphics, x: number, y: number, z: number, palette: MaterialPalette = PALETTE) {
  const c = toScreen(x, y, z);
  g.circle(c.x, c.y, 5).fill(palette.white).stroke({ color: 0x555a70, width: 1 });
  g.moveTo(c.x, c.y).lineTo(c.x, c.y - 3.5).stroke({ color: 0x222222, width: 1 });
  g.moveTo(c.x, c.y).lineTo(c.x + 2.5, c.y + 1).stroke({ color: 0x222222, width: 1 });
}
