import { describe, expect, it } from "vitest";
import { paintTerrainPixels } from "../src/game/terrain-paint";
import { BIOMES } from "../src/sim/mapgen";
import { Terrain } from "../src/sim/types";

/** A small point-symmetric test grid with every terrain: a river with a bridge and a ford, rock, forest, scrap, crystal, road. */
function testGrid(S = 24): Uint8Array {
  const g = new Uint8Array(S * S);
  const set = (x: number, y: number, t: Terrain) => {
    g[y * S + x] = t;
    g[(S - 1 - y) * S + (S - 1 - x)] = t;
  };
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const d = x - y;
      if (Math.abs(d) <= 2) set(x, y, Math.abs(d) <= 1 ? Terrain.Water : Terrain.Rough);
    }
  for (let x = 0; x < 3; x++) set(x, 0, Terrain.Deep);
  set(11, 11, Terrain.Bridge);
  set(12, 11, Terrain.Bridge);
  set(5, 5, Terrain.Shallows);
  for (let x = 2; x < 5; x++) for (let y = 14; y < 17; y++) set(x, y, Terrain.Rock);
  for (let x = 14; x < 18; x++) for (let y = 2; y < 6; y++) set(x, y, Terrain.Forest);
  set(8, 18, Terrain.Scrap);
  set(9, 18, Terrain.Crystal);
  for (let x = 6; x < 20; x++) set(x, 22, Terrain.Road);
  return g;
}

const S = 24;
const PX = 8;
const at = (px: Uint8ClampedArray, w: number, x: number, y: number) => [...px.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)];
/** The mean colour over a tile's middle half. */
function tileMean(px: Uint8ClampedArray, w: number, tx: number, ty: number): number[] {
  const m = [0, 0, 0];
  let n = 0;
  for (let y = ty * PX + PX / 4; y < (ty + 1) * PX - PX / 4; y++)
    for (let x = tx * PX + PX / 4; x < (tx + 1) * PX - PX / 4; x++) {
      const c = at(px, w, x, y);
      for (let k = 0; k < 3; k++) m[k]! += c[k]!;
      n++;
    }
  return m.map((v) => v / n);
}
const same = (a: Uint8ClampedArray, b: Uint8ClampedArray) => a.length === b.length && a.every((v, i) => v === b[i]);
const dist = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

describe("runtime terrain painter", () => {
  const grid = testGrid(S);
  const W = S * PX;

  it("returns w×h RGBA, opaque", () => {
    const px = paintTerrainPixels(grid, S, "temperate", 7, PX, 3, 5, 17, 11);
    expect(px.length).toBe(17 * 11 * 4);
    for (let i = 3; i < px.length; i += 4) expect(px[i]).toBe(255);
  });

  it("is deterministic, and the seed changes the detail", () => {
    const a = paintTerrainPixels(grid, S, "desert", 42, PX, 0, 0, W, W);
    const b = paintTerrainPixels(grid, S, "desert", 42, PX, 0, 0, W, W);
    expect(same(a, b)).toBe(true);
    const c = paintTerrainPixels(grid, S, "desert", 43, PX, 0, 0, W, W);
    expect(same(a, c)).toBe(false);
  });

  it("paints chunk rects consistently with the whole", () => {
    const whole = paintTerrainPixels(grid, S, "volcanic", 9, PX, 0, 0, W, W);
    for (const [x0, y0, w, h] of [[0, 0, 64, 64], [37, 91, 50, 33], [W - 21, W - 13, 21, 13], [100, 3, 1, 1]] as const) {
      const part = paintTerrainPixels(grid, S, "volcanic", 9, PX, x0, y0, w, h);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) expect(at(part, w, x, y)).toEqual(at(whole, W, x0 + x, y0 + y));
    }
  });

  it("tells terrains apart, and biomes apart", () => {
    const means: Record<string, number[]> = {};
    for (const biome of BIOMES) {
      const px = paintTerrainPixels(grid, S, biome, 1, PX, 0, 0, W, W);
      const ground = tileMean(px, W, 20, 13);
      const water = tileMean(px, W, 8, 8);
      const rock = tileMean(px, W, 3, 15);
      const forest = tileMean(px, W, 15, 3);
      expect(dist(ground, water), `${biome} ground vs water`).toBeGreaterThan(20);
      expect(dist(ground, rock), `${biome} ground vs rock`).toBeGreaterThan(25);
      expect(dist(ground, forest), `${biome} ground vs forest`).toBeGreaterThan(20);
      means[biome] = ground;
    }
    for (const a of BIOMES) for (const b of BIOMES) if (a < b) expect(dist(means[a]!, means[b]!), `${a} vs ${b}`).toBeGreaterThan(30);
  });

  it("lights lava from within: volcanic water glows warmer than its banks' ash", () => {
    const px = paintTerrainPixels(grid, S, "volcanic", 3, PX, 0, 0, W, W);
    const lava = tileMean(px, W, 8, 8);
    expect(lava[0]!).toBeGreaterThan(lava[2]! + 20);
  });
});
