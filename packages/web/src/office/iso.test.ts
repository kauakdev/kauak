import { describe, expect, test } from "vitest";
import { TILE_H, TILE_W, depth, hashStr, mix, rng, shade, toScreen } from "./iso";

describe("toScreen", () => {
  test("a tile step right-down is half a tile across and half a tile down; left-down mirrors it", () => {
    expect(toScreen(0, 0)).toStrictEqual({ x: 0, y: 0 });
    expect(toScreen(1, 0)).toStrictEqual({ x: TILE_W / 2, y: TILE_H / 2 });
    expect(toScreen(0, 1)).toStrictEqual({ x: -TILE_W / 2, y: TILE_H / 2 });
    expect(toScreen(3, 1)).toStrictEqual({ x: 64, y: 64 });
    expect(toScreen(0.5, 0.25)).toStrictEqual({ x: 8, y: 12 });
  });

  test("height lifts a point straight up the screen", () => {
    expect(toScreen(2, 3, 10)).toStrictEqual({ x: -32, y: 70 });
    expect(toScreen(2, 3, 10).y).toBe(toScreen(2, 3).y - 10);
    expect(toScreen(2, 3, 10).x).toBe(toScreen(2, 3).x);
  });
});

test("depth draws what is nearer the viewer (further right-down or left-down) later", () => {
  const tiles = [
    { x: 4, y: 4 },
    { x: 0, y: 0 },
    { x: 3, y: 1 },
    { x: 0, y: 2.5 },
  ];
  const order = [...tiles].sort((a, b) => depth(a.x, a.y) - depth(b.x, b.y));
  expect(order).toStrictEqual([tiles[1], tiles[3], tiles[2], tiles[0]]);
  expect(depth(1, 2)).toBe(3);
  // Along a screen row (x + y fixed) nothing is in front of anything else.
  expect(depth(3, 0)).toBe(depth(0, 3));
});

describe("colours", () => {
  test("shade scales each channel, clamped to 0..255 and cut to whole values", () => {
    expect(shade(0x808080, 0.5)).toBe(0x404040);
    expect(shade(0x336699, 1)).toBe(0x336699);
    expect(shade(0x808080, 2)).toBe(0xffffff);
    expect(shade(0x123456, -1)).toBe(0x000000);
    expect(shade(0xff8000, 0.5)).toBe(0x7f4000);
    expect(shade(0x0f0f0f, 0.5)).toBe(0x070707);
  });

  test("mix blends channel by channel from a (k = 0) to b (k = 1), rounding", () => {
    expect(mix(0x102030, 0xf0e0d0, 0)).toBe(0x102030);
    expect(mix(0x102030, 0xf0e0d0, 1)).toBe(0xf0e0d0);
    expect(mix(0x000000, 0xffffff, 0.5)).toBe(0x808080);
    expect(mix(0xff0000, 0x0000ff, 0.25)).toBe(0xbf0040);
  });
});

describe("hashStr", () => {
  test("is 32-bit FNV-1a, so a prop seeded from a name is the same on every load", () => {
    expect(hashStr("")).toBe(2166136261);
    expect(hashStr("a")).toBe(0xe40c292c);
    expect(hashStr("foobar")).toBe(0xbf9cf968);
    expect(hashStr("w1:p1")).toBe(hashStr("w1:p1"));
    expect(hashStr("w1:p1")).not.toBe(hashStr("w1:p2"));
  });

  test("stays an unsigned 32-bit integer for long strings", () => {
    const h = hashStr("devbox/".repeat(500));
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(2 ** 32);
  });
});

describe("rng", () => {
  test("is mulberry32: one seed gives one sequence, in [0, 1)", () => {
    const a = rng(1);
    expect([a(), a(), a()]).toStrictEqual([0.6270739405881613, 0.002735721180215478, 0.5274470399599522]);
    const b = rng(hashStr("room")),
      c = rng(hashStr("room"));
    const seq = Array.from({ length: 200 }, () => b());
    expect(Array.from({ length: 200 }, () => c())).toStrictEqual(seq);
    for (const v of seq) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  test("different seeds give different sequences", () => {
    const a = rng(1),
      b = rng(2);
    const first = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).not.toStrictEqual(first);
  });
});
