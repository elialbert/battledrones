import { describe, expect, it } from "vitest";
import { createAiState, tickAi, type AiState } from "../src/sim/ai/commander";
import { activeSortie, sortiesLaunched } from "../src/sim/ai/harass";
import { planStrategy } from "../src/sim/ai/marshal";
import { TICK_RATE } from "../src/sim/balance";
import { createMapWorld } from "../src/sim/maps";
import { step } from "../src/sim/sim";
import type { World } from "../src/sim/types";
import { buildingCenter, dist, hqOf, spawnUnit } from "../src/sim/world";

/** Red, a Marshal-style commander that only pokes, on Riverlands with two Stingers at home; blue does nothing. */
function pokeWorld(holdUntil = 0) {
  const w = createMapWorld("riverlands");
  const ai = createAiState("balanced", "normal", 1, { ...planStrategy("balanced"), harassGroup: Infinity, holdUntil });
  ai.sorties = ["poke"];
  const home = buildingCenter(hqOf(w, "red")!);
  const ids = [0, 1].map((i) => spawnUnit(w, "stinger", "red", home.x - 2 + i, home.y - 3).id);
  w.tick = 40 * TICK_RATE;
  return { w, ai, home, ids };
}

function run(w: World, s: AiState, secs: number, each?: () => void): void {
  hqOf(w, "blue")!.hp = 1e9;
  for (let i = 0; i < secs * TICK_RATE && !w.winner; i++) {
    step(w, tickAi(w, "red", s));
    each?.();
  }
}

describe("harassment sorties (ai/harass.ts)", () => {
  it("sends the first two Stingers to poke at their mining, and brings them home", () => {
    const { w, ai, home, ids } = pokeWorld();
    let out = false;
    let farthest = 0;
    run(w, ai, 120, () => {
      const a = activeSortie(ai);
      if (a?.phase === "out") out = true;
      for (const id of ids) {
        const u = w.units.get(id);
        if (u) farthest = Math.max(farthest, dist(u.x, u.y, home.x, home.y));
      }
    });
    expect(out).toBe(true);
    expect(sortiesLaunched(ai)).toBe(1);
    expect(farthest).toBeGreaterThan(20);
    // over, and nobody lost: the leash brought them back
    expect(activeSortie(ai)).toBeNull();
    for (const id of ids) expect(w.units.has(id)).toBe(true);
  });

  it("turns for home when it meets a guard it can't beat", () => {
    const { w, ai } = pokeWorld();
    // a guard of four Stingers waiting where it's headed
    let guarded = false;
    let why: string | undefined;
    run(w, ai, 90, () => {
      const a = activeSortie(ai);
      if (a && !guarded) {
        guarded = true;
        for (let i = 0; i < 4; i++) spawnUnit(w, "stinger", "blue", a.to.x - 2 + i, a.to.y);
      }
      why = a?.why ?? why;
    });
    // (Stingers see 5 tiles and the commander looks every 2 s: often hit before it sees it's outgunned)
    expect(["outgunned", "hurt"]).toContain(why);
  });

  it("waits out the peace (Easy's five minutes): no poke before it", () => {
    const { w, ai } = pokeWorld(300);
    run(w, ai, 90);
    expect(sortiesLaunched(ai)).toBe(0);
  });
});
