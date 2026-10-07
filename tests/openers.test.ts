import { describe, expect, it } from "vitest";
import { STRATEGIES, createAiState, tickAi, type StrategyName } from "../src/sim/ai/commander";
import { BUILDINGS, ECONOMY, TICK_RATE, UNITS } from "../src/sim/balance";
import { nearestReachableResource, nearestScrapTile } from "../src/sim/economy";
import { MAPS, createMapWorld } from "../src/sim/maps";
import {
  OPENERS,
  OPENER_IDS,
  applyOpener,
  openerValue,
  pickAiOpener,
  predictOpenerSite,
  type OpenerId
} from "../src/sim/openers";
import { step } from "../src/sim/sim";
import { Terrain, type Faction, type UnitKind, type World } from "../src/sim/types";
import { buildingCenter, createWorld, distToBuilding, hqOf, isResource, spawnUnit, terrainAt } from "../src/sim/world";
import { fitZoom, frameCentre, startBox } from "../src/game/framing";

const units = (w: World, f: Faction, kind?: UnitKind) =>
  [...w.units.values()].filter((u) => u.faction === f && (!kind || u.kind === kind));
const buildings = (w: World, f: Faction) => [...w.buildings.values()].filter((b) => b.faction === f);

describe("quick-start openers", () => {
  it("leaves the classic start untouched without the option", () => {
    const w = createMapWorld("riverlands", { seed: 5 });
    for (const f of ["blue", "red"] as const) {
      expect(units(w, f)).toHaveLength(1);
      expect(units(w, f, "harvester")).toHaveLength(1);
      expect(buildings(w, f).map((b) => b.kind)).toEqual(["hq"]);
      expect(w.factions[f].scrap).toBe(ECONOMY.startingScrap);
    }
  });

  for (const def of MAPS)
    for (const id of OPENER_IDS)
      it(`${def.name}: ${OPENERS[id].name} hands out exactly its package`, () => {
        const o = OPENERS[id];
        const w = createMapWorld(def.id, { openers: { blue: id, red: id } });
        for (const f of ["blue", "red"] as const) {
          const hq = hqOf(w, f)!;
          const extra = buildings(w, f).filter((b) => b.kind !== "hq");
          expect(extra.map((b) => b.kind)).toEqual([o.building]);
          // a sensible spot: in build range of the HQ, not hugging it
          const b = extra[0]!;
          const c = buildingCenter(b);
          expect(distToBuilding(hq, c.x, c.y)).toBeLessThanOrEqual(ECONOMY.buildRadius);
          expect(distToBuilding(hq, c.x, c.y)).toBeGreaterThan(BUILDINGS[b.kind].size / 2);
          expect(units(w, f, "harvester")).toHaveLength(o.harvesters);
          for (const k of new Set(o.units))
            expect(units(w, f, k)).toHaveLength(o.units.filter((x) => x === k).length);
          expect(units(w, f)).toHaveLength(o.harvesters + o.units.length);
          expect(w.factions[f].scrap).toBe(ECONOMY.startingScrap + o.scrap);
          // every harvester is already on its way to work
          for (const h of units(w, f, "harvester")) expect(h.order.type).toBe("harvest");
          // nobody spawned on a rooftop or in the river
          for (const u of units(w, f)) {
            expect(w.occupancy[Math.floor(u.y) * w.width + Math.floor(u.x)]).toBe(0);
            if (UNITS[u.kind].domain === "ground") {
              const t = terrainAt(w, Math.floor(u.x), Math.floor(u.y));
              expect([Terrain.Water, Terrain.Rock]).not.toContain(t);
            }
          }
        }
      });

  for (const def of MAPS)
    it(`${def.name}: both sides get mirror-image setups`, () => {
      for (const id of OPENER_IDS) {
        const w = createMapWorld(def.id, { openers: { blue: id, red: id } });
        const S = w.width;
        for (const b of buildings(w, "blue")) {
          const size = BUILDINGS[b.kind].size;
          const twin = buildings(w, "red").find((r) => r.kind === b.kind && r.tx === S - b.tx - size && r.ty === S - b.ty - size);
          expect(twin, `${id} ${b.kind}`).toBeDefined();
        }
        for (const u of units(w, "blue")) {
          const twin = units(w, "red", u.kind).find((r) => Math.abs(r.x - (S - u.x)) < 1e-9 && Math.abs(r.y - (S - u.y)) < 1e-9);
          expect(twin, `${id} ${u.kind} @${u.x},${u.y}`).toBeDefined();
        }
      }
    });

  it("predicts the factory site the opener will use", () => {
    for (const def of MAPS) {
      const w = createMapWorld(def.id);
      const site = predictOpenerSite(w, "blue", "fab-plant")!;
      applyOpener(w, "blue", "blitz");
      const fab = buildings(w, "blue").find((b) => b.kind === "fab-plant")!;
      expect({ tx: fab.tx, ty: fab.ty }).toEqual(site);
    }
  });

  it("packages are worth about the same", () => {
    // sticker value; the Airpad is a side-grade so Air Wing carries more
    // (the AI-vs-AI opener matrix puts all three within 45–55% wins)
    expect(openerValue("blitz")).toBe(openerValue("industry"));
    for (const id of OPENER_IDS) {
      expect(openerValue(id)).toBeGreaterThanOrEqual(600);
      expect(openerValue(id)).toBeLessThanOrEqual(1000);
    }
  });

  it("the AI picks by personality, deterministically from the seed", () => {
    expect(pickAiOpener("rush", 1, "red")).toBe("blitz");
    expect(pickAiOpener("boom", 1, "red")).toBe("industry");
    expect(pickAiOpener("airswarm", 1, "red")).toBe("airwing");
    expect(pickAiOpener("skyforce", 1, "blue")).toBe("airwing");
    const balanced = new Set<OpenerId>();
    const ironclad = new Set<OpenerId>();
    for (let seed = 0; seed < 40; seed++) {
      expect(pickAiOpener("balanced", seed, "red")).toBe(pickAiOpener("balanced", seed, "red"));
      balanced.add(pickAiOpener("balanced", seed, "red"));
      ironclad.add(pickAiOpener("ironclad", seed, "blue"));
    }
    expect(balanced.size).toBe(3);
    expect([...ironclad].sort()).toEqual(["blitz", "industry"]);
  });

  it("replays identically from the same seed and openers", () => {
    const run = () => {
      const w = createMapWorld("dune-sea", { seed: 99, openers: { blue: "airwing", red: "blitz" } });
      const a = createAiState("airswarm", "normal", 3);
      const b = createAiState("rush", "normal", 4);
      for (let i = 0; i < 90 * TICK_RATE; i++) step(w, [...tickAi(w, "blue", a), ...tickAi(w, "red", b)]);
      return [...w.units.values()].map((u) => `${u.id}:${u.kind}:${u.x.toFixed(3)}:${u.y.toFixed(3)}:${u.hp}`).join("|");
    };
    expect(run()).toBe(run());
  });
});

describe("the AI with an opener", () => {
  for (const name of Object.keys(STRATEGIES) as StrategyName[])
    it(`${STRATEGIES[name].label} builds on its opener without duplicating it`, () => {
      const id = pickAiOpener(name, 7, "red");
      const w = createMapWorld("riverlands", { seed: 7, openers: { blue: "industry", red: id } });
      const ai = createAiState(name, "normal", 11);
      for (let i = 0; i < 100 * TICK_RATE && !w.winner; i++) step(w, tickAi(w, "red", ai));
      const kinds = buildings(w, "red").map((b) => b.kind);
      expect(kinds.length).toBeGreaterThanOrEqual(3);
      // its first construction is the next build-order entry the opener
      // didn't already cover, not a copy of the free factory
      const have = new Map([[OPENERS[id].building, 1]]);
      const want = new Map<string, number>();
      const next = STRATEGIES[name].buildOrder.find((k) => {
        want.set(k, (want.get(k) ?? 0) + 1);
        return want.get(k)! > (have.get(k) ?? 0);
      });
      expect(kinds[2]).toBe(next);
      expect(units(w, "red", "harvester").length).toBeGreaterThanOrEqual(3);
      expect(units(w, "red", "harvester").every((h) => h.order.type === "harvest")).toBe(true);
    });

  it("holds its opener units at home for the opening seconds", () => {
    const w = createMapWorld("frostbite", { seed: 3, openers: { blue: "industry", red: "airwing" } });
    const ai = createAiState("airswarm", "normal", 5);
    const hq = buildingCenter(hqOf(w, "red")!);
    let farthest = 0;
    for (let i = 0; i < 40 * TICK_RATE; i++) {
      step(w, tickAi(w, "red", ai));
      for (const u of units(w, "red", "wasp")) farthest = Math.max(farthest, Math.hypot(u.x - hq.x, u.y - hq.y));
    }
    expect(farthest).toBeLessThan(14);
    // …and then goes raiding with them
    for (let i = 0; i < 40 * TICK_RATE; i++) step(w, tickAi(w, "red", ai));
    expect(ai.mode).not.toBe("buildup");
  });
});

describe("AI home defence", () => {
  it("recalls an army that is out raiding when a real force hits its base", () => {
    const w = createMapWorld("proving-grounds", { seed: 1 });
    const ai = createAiState("rush", "normal", 1);
    const hq = buildingCenter(hqOf(w, "red")!);
    const away = [0, 1, 2, 3].map((i) => spawnUnit(w, "stinger", "red", 10 + i * 0.8, 20));
    for (const u of away) u.order = { type: "attackMove", x: 5, y: 42 };
    ai.mode = "assault";
    for (let i = 0; i < 4; i++) spawnUnit(w, "stinger", "blue", hq.x - 3 + i * 0.8, hq.y + 4);
    step(w, []); // red's fog sees the intruders
    const cmds = tickAi(w, "red", ai);
    const recall = cmds.find((c) => c.type === "attackMove" && away.every((u) => c.unitIds.includes(u.id)));
    expect(recall).toMatchObject({ x: hq.x, y: hq.y });
    expect(ai.mode).toBe("buildup");
  });

  it("does not panic over a lone scout-sized poke", () => {
    const w = createMapWorld("proving-grounds", { seed: 1 });
    const ai = createAiState("rush", "normal", 1);
    const hq = buildingCenter(hqOf(w, "red")!);
    const away = [0, 1, 2, 3].map((i) => spawnUnit(w, "stinger", "red", 10 + i * 0.8, 20));
    for (const u of away) u.order = { type: "attackMove", x: 5, y: 42 };
    spawnUnit(w, "stinger", "blue", hq.x - 3, hq.y + 4);
    step(w, []);
    const cmds = tickAi(w, "red", ai);
    expect(cmds.some((c) => "unitIds" in c && away.some((u) => c.unitIds.includes(u.id)))).toBe(false);
  });
});

describe("Proving Grounds side fields", () => {
  it("holds enough scrap for a full match and the new fields are mirrored", () => {
    const w = createMapWorld("proving-grounds");
    let total = 0;
    for (let i = 0; i < w.width * w.height; i++) if (isResource(w, i)) total += w.scrap[i]!;
    expect(total).toBeGreaterThanOrEqual(55000);
    for (let ty = 27; ty <= 29; ty++)
      for (let tx = 3; tx <= 5; tx++) {
        expect(terrainAt(w, tx, ty)).toBe(Terrain.Scrap);
        expect(terrainAt(w, w.width - 1 - tx, w.height - 1 - ty)).toBe(Terrain.Scrap);
      }
  });

  it("is where harvesters go once the home field runs dry", () => {
    const w = createMapWorld("proving-grounds");
    for (let ty = 36; ty <= 38; ty++) for (let tx = 12; tx <= 14; tx++) w.scrap[ty * w.width + tx] = 0;
    const next = nearestReachableResource(w, 13, 37)!;
    expect(next.x).toBeLessThanOrEqual(5);
    expect(next.y).toBeGreaterThanOrEqual(27);
    expect(next.y).toBeLessThanOrEqual(29);
  });
});

describe("longer fights", () => {
  it("half of an 8-v-8 Stinger fight takes over 6 seconds to die", () => {
    const w = createWorld(40, 40);
    const A = Array.from({ length: 8 }, (_, i) => spawnUnit(w, "stinger", "blue", 8 + (i % 3) * 0.8, 16 + Math.floor(i / 3) * 0.8).id);
    const B = Array.from({ length: 8 }, (_, i) => spawnUnit(w, "stinger", "red", 30 + (i % 3) * 0.8, 16 + Math.floor(i / 3) * 0.8).id);
    step(w, [
      { type: "attackMove", faction: "blue", unitIds: A, x: 32, y: 17 },
      { type: "attackMove", faction: "red", unitIds: B, x: 8, y: 17 }
    ]);
    let first = -1;
    let half = -1;
    for (let t = 0; t < 60 * TICK_RATE && half < 0; t++) {
      step(w, []);
      if (first < 0 && w.fx.some((f) => f.type === "shot")) first = w.tick;
      if (first >= 0 && (units(w, "blue").length <= 4 || units(w, "red").length <= 4)) half = w.tick;
    }
    expect(half).toBeGreaterThan(0);
    expect((half - first) / TICK_RATE).toBeGreaterThan(6);
  });

  it("leaves harvesters, scouts and buildings as they were", () => {
    expect(UNITS.harvester.hp).toBe(250);
    expect(UNITS.scout.hp).toBe(60);
    expect(BUILDINGS.hq.hp).toBe(3200);
  });
});

describe("start camera framing", () => {
  it("frames the HQ, its home field and the factory site on every map", () => {
    for (const def of MAPS) {
      const w = createMapWorld(def.id);
      const box = startBox(w, "blue")!;
      const hq = hqOf(w, "blue")!;
      expect(box.x0).toBeLessThanOrEqual(hq.tx);
      expect(box.x1).toBeGreaterThanOrEqual(hq.tx + 3);
      const field = nearestScrapTile(w, hq.tx + 1.5, hq.ty + 1.5)!;
      expect(field.x).toBeGreaterThanOrEqual(box.x0);
      expect(field.x + 1).toBeLessThanOrEqual(box.x1);
      expect(field.y).toBeGreaterThanOrEqual(box.y0);
      expect(field.y + 1).toBeLessThanOrEqual(box.y1);
      // compact enough to read on a phone
      expect(box.x1 - box.x0).toBeLessThan(20);
      expect(box.y1 - box.y0).toBeLessThan(20);
    }
  });

  it("centres the box in the part of the screen the HUD leaves free", () => {
    const box = { x0: 2, y0: 4, x1: 12, y1: 10 };
    const ins = { top: 50, right: 10, bottom: 250, left: 10 };
    const zoom = fitZoom(box, 390, 844, ins, 64);
    expect(zoom).toBeCloseTo((390 - 20) / (10 * 64));
    const c = frameCentre(box, zoom, 390, 844, ins, 64);
    // the box centre lands mid-way between the top bar and the dock
    const screenY = 844 / 2 + (7 * 64 - c.y) * zoom;
    expect(screenY).toBeCloseTo(50 + (844 - 300) / 2);
    const screenX = 390 / 2 + (7 * 64 - c.x) * zoom;
    expect(screenX).toBeCloseTo(195);
  });
});

describe("openers under match rules", () => {
  it("blocks openers whose factory or crew a mutator bans, and falls back to an allowed one", async () => {
    const { createMapWorld } = await import("../src/sim/maps");
    const { openerBlocked, allowedOpener } = await import("../src/sim/openers");
    const w = createMapWorld("riverlands", { mutators: ["airwar"] });
    expect(openerBlocked(w, "blue", "blitz")).not.toBeNull();
    expect(openerBlocked(w, "blue", "airwing")).toBeNull();
    expect(allowedOpener(w, "red", "industry")).toBe("airwing");
    const classic = createMapWorld("riverlands");
    expect(openerBlocked(classic, "blue", "blitz")).toBeNull();
  });
});
