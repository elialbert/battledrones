import { describe, expect, it } from "vitest";
import { createAiState, tickAi } from "../src/sim/ai/commander";
import { TICK_RATE, UNITS } from "../src/sim/balance";
import { MAPS, createMapWorld } from "../src/sim/maps";
import {
  SURVIVAL,
  earlyCallBonus,
  planWave,
  survivalStatus,
  waveBudget,
  waveRank,
  waveTheme,
  waveUnitsLeft,
  wavesSurvived,
  type SurvivalDifficulty
} from "../src/sim/modes/survival";
import { findPath } from "../src/sim/movement";
import { step } from "../src/sim/sim";
import type { FxEvent, World } from "../src/sim/types";
import { wreckValue } from "../src/sim/salvage";
import { buildingCenter, hqOf, passable, spawnUnit } from "../src/sim/world";

const lastStand = (map = "riverlands", seed = 42, difficulty: SurvivalDifficulty = "normal") =>
  createMapWorld(map, { seed, survival: { difficulty } });

/** Step with no player input until `until` matches an fx event (or the limit). */
function runUntil(w: World, until: (e: FxEvent) => boolean, maxTicks = 3000): FxEvent | null {
  for (let i = 0; i < maxTicks && !w.winner; i++) {
    step(w, []);
    const hit = w.fx.find(until);
    if (hit) return hit;
  }
  return null;
}

const red = (w: World) => [...w.units.values()].filter((u) => u.faction === "red");
/** Keep the defender's HQ standing so a test can watch many waves. */
const shieldHq = (w: World) => {
  const hq = hqOf(w, "blue")!;
  hq.hp = 1e9;
};

describe("Last Stand setup", () => {
  it("leaves skirmish worlds untouched without the option", () => {
    const w = createMapWorld("riverlands");
    expect(w.survival).toBeFalsy();
    expect(hqOf(w, "red")).not.toBeNull();
    expect(red(w)).toHaveLength(1);
  });

  it("removes the red base and economy and schedules wave 1", () => {
    const w = lastStand();
    expect([...w.buildings.values()].every((b) => b.faction === "blue")).toBe(true);
    expect(red(w)).toHaveLength(0);
    expect(w.factions.red.scrap).toBe(0);
    expect(hqOf(w, "blue")).not.toBeNull();
    expect([...w.units.values()].filter((u) => u.kind === "harvester")).toHaveLength(1);
    expect(w.survival!.wave).toBe(0);
    expect(w.survival!.nextWaveTick).toBe(SURVIVAL.firstWave.normal * TICK_RATE);
    expect(lastStand("riverlands", 42, "easy").survival!.nextWaveTick).toBeGreaterThan(w.survival!.nextWaveTick);
  });
});

describe("wave schedule", () => {
  it("is a pure function of the match seed", () => {
    const a = lastStand("dune-sea", 7);
    const b = lastStand("dune-sea", 7);
    const c = lastStand("dune-sea", 8);
    const plans = (w: World) => Array.from({ length: 15 }, (_, i) => planWave(w, i + 1));
    expect(plans(a)).toEqual(plans(b));
    expect(plans(a)).not.toEqual(plans(c));
  });

  it("opens with a small ground wave and escalates", () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const w = lastStand("riverlands", seed);
      const first = planWave(w, 1);
      expect(["armour", "mixed"]).toContain(first.theme);
      expect(first.units.every((k) => UNITS[k].domain === "ground" && UNITS[k].cost <= 200)).toBe(true);
      expect(first.units.length).toBeLessThanOrEqual(4);
      // each block of five: the four themes once, then a boss
      for (let block = 0; block < 3; block++) {
        const themes = [1, 2, 3, 4].map((i) => waveTheme(w, block * 5 + i)).sort();
        expect(themes).toEqual(["air", "armour", "artillery", "mixed"]);
        expect(waveTheme(w, block * 5 + 5)).toBe("boss");
      }
    }
    for (let n = 1; n < 25; n++) expect(waveBudget("normal", n + 1)).toBeGreaterThan(waveBudget("normal", n) * (n % 5 === 0 ? 0.85 : 1));
    expect(waveBudget("easy", 8)).toBeLessThan(waveBudget("normal", 8));
    expect(waveBudget("hard", 8)).toBeGreaterThan(waveBudget("normal", 8));
    expect([waveRank(1), waveRank(5), waveRank(6), waveRank(10), waveRank(12)]).toEqual([0, 1, 1, 2, 2]);
  });

  it("spends close to the wave budget and respects the size limit", () => {
    const w = lastStand("ashlands", 3);
    for (let n = 1; n <= 30; n++) {
      const p = planWave(w, n);
      const spent = p.units.reduce((s, k) => s + UNITS[k].cost, 0);
      expect(spent).toBeLessThanOrEqual(p.budget + 1);
      expect(p.units.length).toBeLessThanOrEqual(SURVIVAL.maxWaveUnits);
      if (p.units.length < SURVIVAL.maxWaveUnits) expect(p.budget - spent).toBeLessThan(300);
      if (p.theme === "artillery") expect(p.units).toContain("mortar");
    }
  });

  it("announces each wave 15 s ahead, then spawns it on time at that edge", () => {
    const w = lastStand("frostbite", 11);
    const warn = runUntil(w, (e) => e.type === "waveIncoming");
    expect(warn).toMatchObject({ type: "waveIncoming", wave: 1, eta: SURVIVAL.warn * TICK_RATE, early: 0 });
    expect(w.tick).toBe(SURVIVAL.firstWave.normal * TICK_RATE - SURVIVAL.warn * TICK_RATE + 1);
    const spawned = runUntil(w, (e) => e.type === "waveSpawned");
    expect(spawned).toMatchObject({ type: "waveSpawned", wave: 1 });
    if (warn?.type !== "waveIncoming" || spawned?.type !== "waveSpawned") throw new Error("unreachable");
    expect([spawned.x, spawned.y]).toEqual([warn.x, warn.y]);
    expect(w.tick).toBe(SURVIVAL.firstWave.normal * TICK_RATE + 1);
    for (let i = 0; i < 40; i++) step(w, []);
    expect(red(w).length).toBe(planWave(w, 1).units.length);
    // they come for the base
    for (const u of red(w)) expect(u.order.type).not.toBe("idle");
  });
});

describe("spawn sites", () => {
  for (const def of MAPS)
    it(`are valid on ${def.name}`, () => {
      const w = lastStand(def.id, 5);
      const sites = w.survival!.sites;
      expect(sites.length).toBeGreaterThanOrEqual(3);
      const c = buildingCenter(hqOf(w, "blue")!);
      for (const s of sites) {
        expect(passable(w, Math.floor(s.x), Math.floor(s.y), "ground")).toBe(true);
        expect(Math.hypot(s.x - c.x, s.y - c.y)).toBeGreaterThan(def.size * 0.45);
        expect(s.ax).toBeGreaterThan(0);
        expect(s.ay).toBeGreaterThan(0);
        expect(s.ax).toBeLessThan(w.width);
        expect(s.ay).toBeLessThan(w.height);
        // tanks can drive from every site to the base
        expect(findPath(w, s.x, s.y, c.x, c.y + 2.5)).not.toBeNull();
      }
    });
});

describe("live cap", () => {
  it("never has more than the cap on the map; the rest wait and stream in", () => {
    const w = lastStand("riverlands", 9);
    const s = w.survival!;
    // jump to a huge late wave
    s.wave = 24;
    s.nextWaveTick = w.tick + 1;
    let maxLive = 0;
    let sawQueue = false;
    for (let i = 0; i < 400; i++) {
      shieldHq(w);
      step(w, []);
      maxLive = Math.max(maxLive, red(w).length);
      if (s.pending.length > 0 && red(w).length >= SURVIVAL.maxLive) sawQueue = true;
    }
    expect(maxLive).toBe(SURVIVAL.maxLive);
    expect(sawQueue).toBe(true);
    // as the defenders thin them out, the queue drains
    for (let i = 0; i < 600 && waveUnitsLeft(w) > 0; i++) {
      for (const u of red(w)) u.hp = 0;
      shieldHq(w);
      step(w, []);
      expect(red(w).length).toBeLessThanOrEqual(SURVIVAL.maxLive);
    }
    expect(s.pending).toHaveLength(0);
    expect(waveUnitsLeft(w)).toBe(0);
  });

  it("marches a wave together instead of strung out by speed", () => {
    const w = lastStand("dune-sea", 4);
    const s = w.survival!;
    s.wave = 8; // a mixed bag of fast and slow units
    s.nextWaveTick = w.tick + 1;
    for (let i = 0; i < 300; i++) step(w, []);
    const units = red(w);
    expect(units.length).toBeGreaterThan(5);
    // still marching: the spread along the way stays small
    const c = buildingCenter(hqOf(w, "blue")!);
    const d = units.map((u) => Math.hypot(u.x - c.x, u.y - c.y));
    expect(Math.max(...d) - Math.min(...d)).toBeLessThan(12);
  });
});

describe("clearing waves and game over", () => {
  /** Run to wave n spawned with every unit on the map. */
  const toWave = (w: World, n: number) => {
    runUntil(w, (e) => e.type === "waveSpawned" && e.wave === n, 20000);
    for (let i = 0; i < 100 && w.survival!.pending.length > 0; i++) step(w, []);
  };

  it("pays a clear bonus and brings the next wave forward", () => {
    const w = lastStand("riverlands", 21);
    toWave(w, 1);
    const scrap = w.factions.blue.scrap;
    for (const u of red(w)) u.hp = 0;
    const cleared = runUntil(w, (e) => e.type === "waveCleared", 5);
    expect(cleared).toMatchObject({ type: "waveCleared", wave: 1, bonus: SURVIVAL.clearBonus });
    expect(w.factions.blue.scrap).toBeGreaterThanOrEqual(scrap + SURVIVAL.clearBonus);
    expect(w.survival!.nextWaveTick).toBeLessThanOrEqual(w.tick + SURVIVAL.afterClear * TICK_RATE);
    expect(wavesSurvived(w)).toBe(1);
    expect(survivalStatus(w)).toMatchObject({ wave: 1, next: 2, left: 0, survived: 1 });
  });

  it("lets the defender call the next wave early for scrap, but only on a clear field", () => {
    const w = lastStand("riverlands", 22);
    expect(earlyCallBonus(w)).toBe(0); // never before wave 1
    toWave(w, 1);
    expect(earlyCallBonus(w)).toBe(0); // enemies on the field
    for (const u of red(w)) u.hp = 0;
    step(w, []);
    const bonus = earlyCallBonus(w);
    expect(bonus).toBeGreaterThan(0);
    const scrap = w.factions.blue.scrap;
    step(w, [{ type: "callWave", faction: "red" }]); // not theirs to call
    expect(w.survival!.warned).toBe(false);
    step(w, [{ type: "callWave", faction: "blue" }]);
    const warn = w.fx.find((e) => e.type === "waveIncoming");
    expect(warn).toMatchObject({ type: "waveIncoming", wave: 2 });
    expect(warn?.type === "waveIncoming" && warn.early).toBeGreaterThan(0);
    expect(w.factions.blue.scrap).toBeGreaterThan(scrap + bonus * 0.9);
    expect(w.survival!.nextWaveTick - w.tick).toBeLessThanOrEqual(SURVIVAL.warn * TICK_RATE);
    expect(earlyCallBonus(w)).toBe(0);
  });

  it("ends when the HQ falls and scores the waves survived", () => {
    const w = lastStand("proving-grounds", 23);
    toWave(w, 1);
    for (const u of red(w)) u.hp = 0;
    toWave(w, 2);
    expect(wavesSurvived(w)).toBe(1); // wave 2 is still alive
    hqOf(w, "blue")!.hp = 0;
    step(w, []);
    expect(w.winner).toBe("red");
    const tick = w.tick;
    step(w, []);
    expect(w.tick).toBe(tick); // the sim stops
    expect(wavesSurvived(w)).toBe(1);
  });

  it("finishes an undefended base", () => {
    const w = lastStand("frostbite", 24);
    for (let i = 0; i < 12 * 60 * TICK_RATE && !w.winner; i++) step(w, []);
    expect(w.winner).toBe("red");
    expect(wavesSurvived(w)).toBeLessThanOrEqual(2);
  });
});

describe("Last Stand salvage", () => {
  it("wave units leave only scrap-light wrecks; the defender's own losses salvage as usual", () => {
    const w = lastStand("riverlands", 42);
    const mine = spawnUnit(w, "titan", "blue", 20.5, 40.5);
    const theirs = spawnUnit(w, "titan", "red", 30.5, 30.5);
    mine.hp = 0;
    theirs.hp = 0;
    step(w, []);
    const wreck = (f: string) => w.wrecks.find((r) => r.faction === f)!;
    expect(wreck("red").value).toBe(Math.round(UNITS.titan.cost * SURVIVAL.waveWreckShare));
    // at the skirmish's 30% a defender salvaged 17–67k a run and outlasted 25+ waves
    expect(wreck("red").value).toBeLessThanOrEqual(UNITS.titan.cost * 0.1);
    expect(wreck("blue").value).toBe(wreckValue("titan"));
    // the share lives on this world's survival state, not in a global
    expect(createMapWorld("riverlands").survival).toBeFalsy();
    expect(wreckValue("titan")).toBe(Math.round(UNITS.titan.cost * 0.3));
  });
});

describe("AI defender", () => {
  it("a Normal Balanced commander holds the opening waves, then the run concludes", () => {
    const w = lastStand("frostbite", 31);
    const ai = createAiState("balanced", "normal", 31);
    let firstLoss = -1;
    for (let i = 0; i < 30 * 60 * TICK_RATE && !w.winner; i++) {
      step(w, tickAi(w, "blue", ai));
      if (firstLoss < 0 && w.fx.some((e) => e.type === "death" && e.faction === "blue" && e.buildingKind)) firstLoss = w.survival!.wave;
    }
    expect(w.winner).toBe("red");
    expect(wavesSurvived(w)).toBeGreaterThanOrEqual(5);
    expect(firstLoss).toBeGreaterThan(3); // no building lost in the first three waves
    expect(ai.mode).toBe("buildup"); // nothing to assault in Last Stand
  });

  it("replays identically from the same seed and commands", () => {
    const sig = () => {
      const w = lastStand("riverlands", 77);
      const ai = createAiState("balanced", "normal", 77);
      for (let i = 0; i < 5 * 60 * TICK_RATE && !w.winner; i++) step(w, tickAi(w, "blue", ai));
      return JSON.stringify([w.tick, w.survival!.wave, [...w.units.values()].map((u) => [u.id, u.kind, u.x.toFixed(3), u.y.toFixed(3), u.hp])]);
    };
    expect(sig()).toBe(sig());
  });
});
