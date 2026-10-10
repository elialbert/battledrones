import { describe, expect, it } from "vitest";
import { STRATEGIES, createAiState, tickAi, type StrategyName } from "../src/sim/ai/commander";
import { BUILDINGS, ECONOMY, TICK_RATE, UNITS } from "../src/sim/balance";
import { buildingBlocker, unitBlocker } from "../src/sim/economy";
import { Vis, tickFog } from "../src/sim/fog";
import { createMapWorld } from "../src/sim/maps";
import {
  DEFAULT_RULES,
  MUTATORS,
  MUTATOR_IDS,
  applyMutators,
  bannedBy,
  incomeOf,
  isMutated,
  makeRules,
  rulesOf,
  strategyFits,
  type MutatorId
} from "../src/sim/rules";
import { step } from "../src/sim/sim";
import type { World } from "../src/sim/types";
import { createWorld, hqOf, spawnBuilding, spawnUnit } from "../src/sim/world";

const run = (w: World, ticks: number) => {
  for (let i = 0; i < ticks; i++) step(w, []);
};

describe("rules plumbing", () => {
  it("a classic match has no rules and plays by the defaults", () => {
    const w = createMapWorld("riverlands");
    expect(w.rules).toBeUndefined();
    expect(rulesOf(w)).toBe(DEFAULT_RULES);
    expect(isMutated(w)).toBe(false);
    expect(w.factions.blue.scrap).toBe(ECONOMY.startingScrap);
    expect(createMapWorld("riverlands", { mutators: [] }).rules).toBeUndefined();
  });

  it("MatchOptions.mutators installs the rules for both sides", () => {
    const w = createMapWorld("dune-sea", { seed: 3, mutators: ["glass", "blitz"] });
    expect(rulesOf(w).mutators).toEqual(["blitz", "glass"]); // canonical order
    expect(rulesOf(w).dmgMult).toBe(2);
    expect(w.factions.blue.scrap).toBe(3000);
    expect(w.factions.red.scrap).toBe(3000);
    expect(isMutated(w)).toBe(true);
  });

  it("makeRules dedupes, ignores unknown ids and never mutates the defaults", () => {
    const r = makeRules(["airwar", "airwar", "veterans"]);
    expect(r.mutators).toEqual(["airwar", "veterans"]);
    expect(r.bannedUnits.filter((k) => k === "stinger")).toHaveLength(1);
    expect(DEFAULT_RULES.bannedUnits).toEqual([]);
    const w = createWorld(8, 8);
    applyMutators(w, ["nonsense" as MutatorId]);
    expect(w.rules).toBeUndefined();
  });

  it("every mutator has a name, icon and description", () => {
    for (const id of MUTATOR_IDS) {
      expect(MUTATORS[id].id).toBe(id);
      expect(MUTATORS[id].name.length).toBeGreaterThan(2);
      expect(MUTATORS[id].desc.length).toBeGreaterThan(10);
    }
  });
});

describe("mutator effects", () => {
  it("Gold Rush multiplies harvest income on top of the AI's own handicap", () => {
    const harvest = (muts: MutatorId[]) => {
      const w = createMapWorld("riverlands", { seed: 5, mutators: muts });
      const blueH = [...w.units.values()].find((u) => u.faction === "blue" && u.kind === "harvester")!;
      step(w, [{ type: "harvest", faction: "blue", unitIds: [blueH.id], x: 13.5, y: 46.5 }]);
      // harvest from the nearest field until a couple of loads are in
      let field: { x: number; y: number } | null = null;
      for (let ty = 0; ty < w.height && !field; ty++)
        for (let tx = 0; tx < w.width && !field; tx++)
          if (w.scrap[ty * w.width + tx]! > 0 && Math.hypot(tx - blueH.x, ty - blueH.y) < 14) field = { x: tx, y: ty };
      step(w, [{ type: "harvest", faction: "blue", unitIds: [blueH.id], x: field!.x + 0.5, y: field!.y + 0.5 }]);
      run(w, 120 * TICK_RATE);
      return w;
    };
    const classic = harvest([]);
    const rush = harvest(["goldrush"]);
    expect(classic.factions.blue.stats.scrapHarvested).toBeGreaterThan(0);
    expect(rush.factions.blue.stats.scrapHarvested / classic.factions.blue.stats.scrapHarvested).toBeCloseTo(1.5, 5);
    // the AI rewrites FactionState.incomeMult every tick; the mutator multiplies on top
    rush.factions.red.incomeMult = 1.3;
    expect(incomeOf(rush, "red")).toBeCloseTo(1.95, 10);
  });

  it("Glass Cannons doubles weapon damage", () => {
    const hit = (muts: MutatorId[]) => {
      const w = createWorld(16, 16);
      applyMutators(w, muts);
      spawnUnit(w, "stinger", "blue", 4, 8);
      const target = spawnUnit(w, "titan", "red", 6, 8);
      for (let i = 0; i < 40 && target.hp === UNITS.titan.hp; i++) step(w, []);
      return UNITS.titan.hp - target.hp;
    };
    const base = hit([]);
    expect(base).toBeGreaterThan(0);
    expect(hit(["glass"])).toBeCloseTo(base * 2, 6);
  });

  it("Rapid Fab halves construction and production times", () => {
    const ticksToBuild = (muts: MutatorId[]) => {
      const w = createMapWorld("riverlands", { mutators: muts });
      w.factions.blue.scrap = 5000;
      step(w, [{ type: "startBuilding", faction: "blue", building: "turret" }]);
      let n = 1;
      while (!w.factions.blue.pending?.ready && n < 1000) {
        step(w, []);
        n++;
      }
      return n;
    };
    const ticksToProduce = (muts: MutatorId[]) => {
      const w = createMapWorld("riverlands", { mutators: muts });
      w.factions.blue.scrap = 5000;
      const hq = hqOf(w, "blue")!;
      const before = w.units.size;
      step(w, [{ type: "produce", faction: "blue", buildingId: hq.id, unit: "harvester" }]);
      let n = 1;
      while (w.units.size === before && n < 1000) {
        step(w, []);
        n++;
      }
      return n;
    };
    expect(ticksToBuild([])).toBe(BUILDINGS.turret.buildTime * TICK_RATE);
    expect(ticksToBuild(["rapidfab"])).toBe((BUILDINGS.turret.buildTime * TICK_RATE) / 2);
    expect(ticksToProduce([])).toBe(UNITS.harvester.buildTime * TICK_RATE);
    expect(ticksToProduce(["rapidfab"])).toBe((UNITS.harvester.buildTime * TICK_RATE) / 2);
  });

  it("Air War bans the Fab Plant, SAM sites and ground combat units for both sides", () => {
    const w = createMapWorld("riverlands", { mutators: ["airwar"] });
    for (const f of ["blue", "red"] as const) {
      expect(buildingBlocker(w, f, "fab-plant")).toBe("Disabled: Air War");
      expect(buildingBlocker(w, f, "sam-site")).toBe("Disabled: Air War");
      expect(buildingBlocker(w, f, "airpad")).toBeNull();
      expect(buildingBlocker(w, f, "turret")).toBeNull();
      for (const k of ["stinger", "flak-crawler", "mortar", "titan", "lancer"] as const)
        expect(unitBlocker(w, f, k)).toBe("Disabled: Air War");
      // the starting Trooper Squad stays home: no Condor to fly it into the fight
      expect(unitBlocker(w, f, "condor")).toBe("Disabled: Air War");
      expect([...w.units.values()].filter((u) => u.faction === f && u.kind === "trooper")).toHaveLength(1);
      expect(bannedBy(w, "harvester")).toBeNull();
    }
    // a direct command is refused too
    w.factions.blue.scrap = 5000;
    step(w, [{ type: "startBuilding", faction: "blue", building: "fab-plant" }]);
    expect(w.factions.blue.pending).toBeNull();
    const fab = spawnBuilding(w, "fab-plant", "blue", 20, 44); // even a stray one can't produce
    step(w, [{ type: "produce", faction: "blue", buildingId: fab.id, unit: "stinger" }]);
    expect(fab.queue).toHaveLength(0);
  });

  it("Veterans: freshly built combat units roll out at rank 1, harvesters don't", () => {
    const w = createMapWorld("riverlands", { mutators: ["veterans"] });
    w.factions.blue.scrap = 5000;
    const hq = hqOf(w, "blue")!;
    const pad = spawnBuilding(w, "airpad", "blue", hq.tx + 5, hq.ty - 3);
    step(w, [
      { type: "produce", faction: "blue", buildingId: pad.id, unit: "wasp" },
      { type: "produce", faction: "blue", buildingId: hq.id, unit: "harvester" }
    ]);
    run(w, 30 * TICK_RATE);
    const wasp = [...w.units.values()].find((u) => u.kind === "wasp")!;
    const harvesters = [...w.units.values()].filter((u) => u.kind === "harvester" && u.faction === "blue");
    expect(wasp.rank).toBe(1);
    expect(wasp.xp).toBe(UNITS.wasp.cost); // rank-1 XP, so promotion continues normally
    expect(harvesters.length).toBe(2);
    for (const h of harvesters) expect(h.rank).toBe(0);
    // …and so does each side's starting Trooper Squad
    const squads = [...w.units.values()].filter((u) => u.kind === "trooper");
    expect(squads.map((u) => [u.faction, u.rank])).toEqual([["blue", 1], ["red", 1]]);
    expect(squads[0]!.xp).toBe(UNITS.trooper.cost);
  });

  it("Clear Skies: both sides see the whole map (and the enemy base)", () => {
    const w = createMapWorld("ashlands", { mutators: ["clearskies"] });
    tickFog(w);
    for (const f of ["blue", "red"] as const) {
      expect(w.fog[f].vis.every((v) => v === Vis.Visible)).toBe(true);
      const enemyHq = hqOf(w, f === "blue" ? "red" : "blue")!;
      expect(w.fog[f].known.has(enemyHq.id)).toBe(true);
    }
    const classic = createMapWorld("ashlands");
    tickFog(classic);
    expect(classic.fog.blue.vis.every((v) => v === Vis.Visible)).toBe(false);
  });
});

describe("the AI under mutators", () => {
  it("strategyFits keeps tank and ground-raid plans out of Air War", () => {
    const airwar = makeRules(["airwar"]);
    const fits = (Object.keys(STRATEGIES) as StrategyName[]).filter((n) => strategyFits(STRATEGIES[n], airwar));
    expect(fits).toEqual(expect.arrayContaining(["balanced", "airswarm", "boom", "skyforce"]));
    expect(fits).not.toContain("ironclad");
    expect(fits).not.toContain("rush");
    for (const n of Object.keys(STRATEGIES) as StrategyName[]) expect(strategyFits(STRATEGIES[n], DEFAULT_RULES)).toBe(true);
  });

  it("plays an Air War to a finish without ever building a banned kind", () => {
    const w = createMapWorld("frostbite", { seed: 11, mutators: ["airwar"] });
    const a = createAiState("airswarm", "normal", 1);
    const b = createAiState("balanced", "normal", 2);
    const banned = new Set<string>(["fab-plant", "sam-site", "stinger", "flak-crawler", "mortar", "titan", "lancer"]);
    let air = 0;
    for (let i = 0; i < 25 * 60 * TICK_RATE && !w.winner; i++) {
      step(w, [...tickAi(w, "blue", a), ...tickAi(w, "red", b)]);
      if (i % 50 === 0) {
        for (const u of w.units.values()) {
          expect(banned.has(u.kind)).toBe(false);
          if (UNITS[u.kind].domain === "air") air++;
        }
        for (const bd of w.buildings.values()) expect(banned.has(bd.kind)).toBe(false);
      }
    }
    expect(air).toBeGreaterThan(0);
    expect(w.winner).not.toBeNull();
  }, 60_000);
});
