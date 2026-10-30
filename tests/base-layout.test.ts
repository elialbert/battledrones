import { describe, expect, it } from "vitest";
import { BUILDINGS } from "../src/sim/balance";
import { MAPS, createMapWorld } from "../src/sim/maps";
import { BIOMES, randomMapId } from "../src/sim/mapgen";
import { sealsOff } from "../src/sim/placement";
import { Terrain, type World } from "../src/sim/types";
import { createWorld, hqOf, setTerrain, spawnBuilding } from "../src/sim/world";

/** How far blue's nearest scrap tile lies toward the map centre (the enemy) from its HQ; negative is behind it. */
function homeFieldAhead(w: World): number {
  const hq = hqOf(w, "blue")!;
  const c = { x: hq.tx + BUILDINGS.hq.size / 2, y: hq.ty + BUILDINGS.hq.size / 2 };
  const to = { x: w.width / 2 - c.x, y: w.height / 2 - c.y };
  const len = Math.hypot(to.x, to.y);
  let best = Infinity;
  let ahead = 0;
  for (let i = 0; i < w.terrain.length; i++) {
    if (w.terrain[i] !== Terrain.Scrap) continue;
    const x = (i % w.width) + 0.5 - c.x;
    const y = Math.floor(i / w.width) + 0.5 - c.y;
    const d = Math.hypot(x, y);
    if (d < best) {
      best = d;
      ahead = (x * to.x + y * to.y) / len;
    }
  }
  return ahead;
}

describe("the home field lies behind the HQ, away from the enemy", () => {
  for (const def of MAPS)
    it(def.name, () => {
      expect(homeFieldAhead(createMapWorld(def.id))).toBeLessThan(-2);
    });

  it("on generated maps too", () => {
    for (const b of BIOMES)
      for (const seed of [11, 4242, 90001]) expect(homeFieldAhead(createMapWorld(randomMapId(b, seed))), `${b} ${seed}`).toBeLessThan(-2);
  });
});

describe("sealsOff: a building that would box ground in", () => {
  /** A 5x4 room of rock, open to the east through a 2-tile doorway at x 15, y 11–12. */
  const room = () => {
    const w = createWorld(32, 32);
    for (let y = 8; y <= 15; y++)
      for (let x = 8; x <= 15; x++) {
        const wall = x === 8 || x === 15 || y === 8 || y === 15;
        if (wall && !(x === 15 && (y === 11 || y === 12))) setTerrain(w, x, y, Terrain.Rock);
      }
    return w;
  };

  it("is true for a building across the room's only doorway", () => {
    expect(sealsOff(room(), 15, 11, 2)).toBe(true);
  });

  it("is true for one finishing off a pocket another building started", () => {
    // a dead-end corridor 3 wide (x 11–13) running in from the top edge, open at the bottom
    const w = createWorld(32, 32);
    for (let y = 0; y <= 9; y++) {
      setTerrain(w, 10, y, Terrain.Rock);
      setTerrain(w, 14, y, Terrain.Rock);
    }
    spawnBuilding(w, "fab-plant", "blue", 11, 8); // (x 11–12, y 8–9: a one-tile gap left at x 13)
    expect(sealsOff(w, 13, 8, 1)).toBe(true);
    expect(sealsOff(w, 12, 3, 1)).toBe(false); // (in the corridor, round it either side)
  });

  it("is false out in the open, and against a wall or the map edge with a way round", () => {
    const w = room();
    expect(sealsOff(w, 20, 20, 2)).toBe(false);
    expect(sealsOff(w, 16, 4, 2)).toBe(false);
    expect(sealsOff(w, 0, 0, 2)).toBe(false);
    expect(sealsOff(w, 10, 10, 2)).toBe(false); // (inside the room: still round it on every side)
  });

  it("is true for a building cutting the map's edge off in a corner", () => {
    const w = createWorld(16, 16);
    setTerrain(w, 0, 2, Terrain.Rock);
    // a 2x2 at (1, 0) leaves tiles (0, 0)–(0, 1) between it, the rock and the edge
    expect(sealsOff(w, 1, 0, 2)).toBe(true);
  });
});
