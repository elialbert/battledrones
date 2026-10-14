import { describe, expect, it } from "vitest";
import { createAiState, tickAi } from "../src/sim/ai/commander";
import { TERRAIN, TICK_RATE } from "../src/sim/balance";
import { findPath } from "../src/sim/movement";
import { createMapWorld, isKnownMapId, mapById } from "../src/sim/maps";
import {
  BIOMES,
  LAYOUTS,
  RANDOM_MAP_SIZE,
  clearRandomMapCache,
  parseRandomMapId,
  randomMapDef,
  randomMapId,
  rollRandomMapId,
  seedCode,
  seedFromText
} from "../src/sim/mapgen";
import { step } from "../src/sim/sim";
import { Terrain, type World } from "../src/sim/types";
import { groundPassable } from "../src/sim/world";

/**
 * Random maps (mapgen.ts): every well-formed id grows the same fair map,
 * tile for tile — point-symmetric, connected for ground armies, with every
 * terrain feature in play — on any biome.
 */

const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

const SEEDS = [1, 42, 777, 9001, 123456, 0xdeadbeef, 0x7fffffff, 31337, 2024, 65535];
const ids = BIOMES.flatMap((b) => SEEDS.map((s) => randomMapId(b, s)));

/** Ground BFS (4-neighbour) over a world's terrain. */
function reach(w: World, x: number, y: number): Uint8Array {
  const S = w.width;
  const seen = new Uint8Array(S * S);
  const q = [Math.floor(y) * S + Math.floor(x)];
  seen[q[0]!] = 1;
  while (q.length) {
    const i = q.pop()!;
    const tx = i % S;
    const ty = (i / S) | 0;
    for (const [nx, ny] of [[tx + 1, ty], [tx - 1, ty], [tx, ty + 1], [tx, ty - 1]] as const) {
      if (nx < 0 || ny < 0 || nx >= S || ny >= S) continue;
      const j = ny * S + nx;
      if (!seen[j] && TERRAIN[w.terrain[j] as Terrain].ground) {
        seen[j] = 1;
        q.push(j);
      }
    }
  }
  return seen;
}

describe("random map ids", () => {
  it("round-trip through parse, and only canonical codes parse", () => {
    for (const b of BIOMES)
      for (const s of SEEDS) {
        const id = randomMapId(b, s);
        expect(parseRandomMapId(id)).toEqual({ biome: b, seed: s >>> 0 });
      }
    for (const bad of ["random-", "random-swamp-abc", "random-desert-", "random-desert-ABC", "random-desert-0abc", "random-desert-zzzzzzz", "random-desert-1-2", "riverlands", "random-desert-abc "])
      expect(parseRandomMapId(bad), bad).toBeNull();
    expect(parseRandomMapId("random-desert-0")).toEqual({ biome: "desert", seed: 0 });
    expect(parseRandomMapId(`random-arctic-${seedCode(0xffffffff)}`)!.seed).toBe(0xffffffff);
  });

  it("reads typed seeds: base-36 codes as is, words hashed", () => {
    expect(seedFromText("k3x9a")).toBe(parseInt("k3x9a", 36));
    expect(seedFromText("  K3X9A ")).toBe(parseInt("k3x9a", 36));
    expect(seedFromText("dragons")).toBe(seedFromText("Dragons"));
    expect(seedFromText("dragons")).not.toBe(seedFromText("wyverns"));
    // 7-char codes (half of all seeds) round-trip too; 7-char words still hash
    expect(seedFromText(seedCode(0xffffffff))).toBe(0xffffffff);
    expect(seedFromText(seedCode(3e9))).toBe(3e9);
    expect(seedFromText("dragons")).not.toBe(parseInt("dragons", 36) >>> 0);
    const s = seedFromText("the long road");
    expect(Number.isInteger(s) && s >= 0 && s <= 0xffffffff).toBe(true);
  });

  it("rolls well-formed ids, on the asked biome or any", () => {
    let x = 7;
    const rnd = () => ((x = (x * 16807) % 2147483647) / 2147483647);
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const id = rollRandomMapId(undefined, rnd);
      const p = parseRandomMapId(id)!;
      expect(p).not.toBeNull();
      seen.add(p.biome);
    }
    expect(seen.size).toBe(5);
    expect(parseRandomMapId(rollRandomMapId("volcanic", rnd))!.biome).toBe("volcanic");
  });

  it("resolve through mapById and isKnownMapId; malformed ids don't", () => {
    const id = randomMapId("tropical", 42);
    expect(isKnownMapId(id)).toBe(true);
    expect(mapById(id).id).toBe(id);
    expect(isKnownMapId("random-tropical-0042")).toBe(false);
    expect(isKnownMapId("random-jungle-42")).toBe(false);
    expect(mapById("random-jungle-42").id).toBe("proving-grounds");
  });
});

describe("generated maps", () => {
  it("are deterministic: regrowing an id gives the same map, tile for tile", () => {
    const first = ids.slice(0, 15).map((id) => randomMapDef(id)!);
    clearRandomMapCache();
    for (const a of first) {
      const b = randomMapDef(a.id)!;
      expect(b).not.toBe(a);
      expect(same(b.random!.terrain, a.random!.terrain)).toBe(true);
      expect([b.name, b.blurb, b.hq, b.uplinks, b.dropSites, b.random!.layout]).toEqual([a.name, a.blurb, a.hq, a.uplinks, a.dropSites, a.random!.layout]);
    }
    // and different seeds grow different maps
    const t = (id: string) => randomMapDef(id)!.random!.terrain;
    expect(same(t(randomMapId("desert", 1)), t(randomMapId("desert", 2)))).toBe(false);
  });

  it("roll every layout across the seeds", () => {
    const layouts = new Set<string>();
    for (let s = 0; s < 80; s++) layouts.add(randomMapDef(randomMapId("temperate", s * 104729))!.random!.layout);
    expect([...layouts].sort()).toEqual([...LAYOUTS].sort());
  });

  for (const id of ids)
    it(`${id}: symmetric, connected, every feature in play`, () => {
      const def = randomMapDef(id)!;
      const S = RANDOM_MAP_SIZE;
      expect(def.size).toBe(S);
      expect(def.name.length).toBeGreaterThan(3);
      expect(def.blurb.length).toBeGreaterThan(20);
      const g = def.random!.terrain;
      expect(g.length).toBe(S * S);
      for (let i = 0; i < g.length; i++) if (g[i] !== g[g.length - 1 - i]) throw new Error(`asymmetric at tile ${i % S},${(i / S) | 0}`);
      const has = new Set(g);
      for (const t of [Terrain.Water, Terrain.Bridge, Terrain.Rock, Terrain.Forest, Terrain.Scrap, Terrain.Crystal, Terrain.Road])
        expect(has.has(t), `terrain ${t}`).toBe(true);
      if (def.biome === "volcanic") expect(has.has(Terrain.Shallows)).toBe(false); // no wading through lava
      if (def.biome !== "tropical") expect(has.has(Terrain.Deep)).toBe(false);

      const w = createMapWorld(id, { objectives: true });
      const hqs = [...w.buildings.values()].filter((b) => b.kind === "hq");
      expect(hqs.map((b) => b.faction).sort()).toEqual(["blue", "red"]);
      const [blue, red] = [hqs.find((b) => b.faction === "blue")!, hqs.find((b) => b.faction === "red")!];
      expect([red.tx, red.ty]).toEqual([S - blue.tx - 3, S - blue.ty - 3]);
      const fromBlue = reach(w, blue.tx + 1, blue.ty + 1);
      const fromRed = reach(w, red.tx + 1, red.ty + 1);
      expect(fromBlue[(red.ty + 1) * S + red.tx + 1]).toBe(1);
      // a home field within easy reach of each HQ
      let home = 0;
      for (let i = 0; i < g.length; i++)
        if (g[i] === Terrain.Scrap && fromBlue[i] && Math.hypot((i % S) + 0.5 - blue.tx - 1.5, ((i / S) | 0) + 0.5 - blue.ty - 1.5) < 11) home++;
      expect(home).toBeGreaterThanOrEqual(8);
      expect(def.uplinks.length).toBeGreaterThanOrEqual(1);
      expect(def.dropSites).toHaveLength(3);
      for (const p of [...w.objectives.uplinks.map((u) => [u.x, u.y] as const), ...def.dropSites]) {
        const [x, y] = p;
        expect(groundPassable(w, Math.floor(x), Math.floor(y)), `${x},${y}`).toBe(true);
        const i = Math.floor(y) * S + Math.floor(x);
        expect(fromBlue[i] && fromRed[i], `${x},${y} reachable`).toBe(1);
      }
    });

  it("A* paths are mirror images on random maps", () => {
    for (const id of [randomMapId("arctic", 42), randomMapId("volcanic", 9001)]) {
      const w = createMapWorld(id);
      const pm = (p: { x: number; y: number }) => ({ x: w.width - p.x, y: w.height - p.y });
      const pts: { x: number; y: number }[] = [];
      for (let ty = 1; ty < w.height - 1; ty += 9) for (let tx = 1 + (ty % 3); tx < w.width - 1; tx += 9) if (groundPassable(w, tx, ty)) pts.push({ x: tx, y: ty });
      let n = 0;
      for (let i = 0; i < pts.length; i += 4) {
        const a = { x: pts[i]!.x + 0.5, y: pts[i]!.y + 0.5 };
        const g = pts[(i * 7 + 3) % pts.length]!;
        const b = i % 8 === 0 ? { x: g.x, y: g.y } : { x: g.x + 0.5, y: g.y + 0.5 };
        const pb = findPath(w, a.x, a.y, b.x, b.y, "ground", "blue");
        const ma = pm(a);
        const mb = pm(b);
        const pr = findPath(w, ma.x, ma.y, mb.x, mb.y, "ground", "red");
        expect(pr === null ? null : pr.map(pm)).toEqual(pb);
        n++;
      }
      expect(n).toBeGreaterThan(5);
    }
  });

  it("host an AI-vs-AI skirmish without a hitch", () => {
    for (const id of [randomMapId("tropical", 777), randomMapId("desert", 31337)]) {
      const w = createMapWorld(id, { objectives: true });
      const blue = createAiState("balanced", "normal", 1);
      const red = createAiState("rush", "normal", 2);
      for (let i = 0; i < 90 * TICK_RATE && !w.winner; i++) step(w, [...tickAi(w, "blue", blue), ...tickAi(w, "red", red)]);
      const harvesters = [...w.units.values()].filter((u) => u.kind === "harvester");
      expect(harvesters.length).toBeGreaterThanOrEqual(2);
      expect([...w.buildings.values()].filter((b) => b.kind !== "hq").length).toBeGreaterThan(0);
    }
  }, 30000);
});
