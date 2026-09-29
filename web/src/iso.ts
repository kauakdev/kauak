// Isometric projection helpers. World units are floor tiles.
export const TILE_W = 64;
export const TILE_H = 32;

export interface Pt { x: number; y: number }

/** World tile coords (x right-down, y left-down) + height z → screen px. */
export function toScreen(x: number, y: number, z = 0): Pt {
  return {
    x: (x - y) * (TILE_W / 2),
    y: (x + y) * (TILE_H / 2) - z,
  };
}

/** Depth key for painter's algorithm: bigger = drawn later (in front). */
export function depth(x: number, y: number): number {
  return x + y;
}

export function shade(color: number, factor: number): number {
  const r = Math.min(255, Math.max(0, ((color >> 16) & 0xff) * factor));
  const g = Math.min(255, Math.max(0, ((color >> 8) & 0xff) * factor));
  const b = Math.min(255, Math.max(0, (color & 0xff) * factor));
  return (r << 16) | (g << 8) | b;
}
