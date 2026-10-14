import { describe, expect, it } from "vitest";
import { createMapWorld } from "../src/sim/maps";
import { Terrain } from "../src/sim/types";
import { bridgeRuns } from "../src/game/three/terrain-bridges";

/** Every bridge run on a map, with how much of it its straight deck (if slanted) covers. */
function runsOf(id: string) {
  const w = createMapWorld(id);
  const { runs } = bridgeRuns(w.terrain, w.width, w.height);
  return runs.map((r) => {
    let inside = 0;
    for (const i of r.tiles) {
      const dx = (i % w.width) + 0.5 - r.mx;
      const dz = Math.floor(i / w.width) + 0.5 - r.mz;
      if (Math.abs(dx * r.ux + dz * r.uz - r.mid) <= r.hl && Math.abs(dz * r.ux - dx * r.uz) <= r.hw) inside++;
    }
    // the tiles' own principal axis, and how elongated they are along it
    let xx = 0;
    let zz = 0;
    let xz = 0;
    for (const i of r.tiles) {
      const dx = (i % w.width) + 0.5 - r.mx;
      const dz = Math.floor(i / w.width) + 0.5 - r.mz;
      xx += dx * dx;
      zz += dz * dz;
      xz += dx * dz;
    }
    const tileAng = 0.5 * Math.atan2(2 * xz, xx - zz);
    const spread = Math.hypot((xx - zz) / 2, xz);
    const elong = ((xx + zz) / 2 + spread) / Math.max(1e-9, (xx + zz) / 2 - spread);
    return { ...r, covered: inside / r.tiles.length, deg: Math.round((r.ang * 180) / Math.PI), tileAng, elong };
  });
}

describe("bridges", () => {
  it("lay the built-ins' diagonal crossings as straight decks across their stair-stepped tiles", () => {
    for (const id of ["riverlands", "ashlands", "archipelago"]) {
      const runs = runsOf(id);
      expect(runs.length).toBeGreaterThan(0);
      for (const r of runs) {
        expect(r.slant).toBe(true);
        expect(Math.abs(r.deg)).toBe(45);
        expect(r.covered).toBeGreaterThan(0.9);
        // about the band its tiles make: wider than the strip they cover outright, narrower than their outline
        expect(r.hw).toBeGreaterThan(0.9);
        expect(r.hw).toBeLessThan(2);
      }
    }
  });

  it("lays generated maps' bridges square to the grid or on its diagonal, every slanted deck over its tiles", () => {
    for (const id of ["random-tropical-1key5u8", "random-arctic-ctu04c", "random-volcanic-1ue4523", "random-temperate-9ccule", "random-desert-10w7f6z"]) {
      const runs = runsOf(id);
      expect(runs.length).toBeGreaterThan(0);
      for (const r of runs) {
        // a long run's tiles lie along its axis (a clean band, not a ragged slant the deck can't fit)
        if (r.elong > 2.5 && r.tiles.length >= 10) expect(Math.abs(Math.sin(r.tileAng - r.ang))).toBeLessThan(0.2);
        if (!r.slant) continue;
        expect(r.covered).toBeGreaterThan(0.85);
        expect(r.hl).toBeGreaterThan(1);
      }
    }
  });

  it("leaves a square bridge tile by tile", () => {
    const w = createMapWorld("riverlands");
    w.terrain.fill(Terrain.Water);
    for (let y = 10; y < 13; y++) for (let x = 5; x < 20; x++) w.terrain[y * w.width + x] = x < 8 || x > 16 ? Terrain.Ground : Terrain.Bridge;
    const { runs } = bridgeRuns(w.terrain, w.width, w.height);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.slant).toBe(false);
    expect(Math.abs(runs[0]!.ux)).toBeCloseTo(1);
  });
});
