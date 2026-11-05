import { describe, expect, it } from "vitest";
import type { AiState } from "../src/sim/ai/commander";
import { offHome, planSkylift, skyliftWantsCondor, SKYLIFT } from "../src/sim/ai/skylift";
import { BUILDINGS, TICK_RATE } from "../src/sim/balance";
import { createMapWorld } from "../src/sim/maps";
import { step } from "../src/sim/sim";
import type { Faction, Unit, World } from "../src/sim/types";
import { hqOf, regionAt, spawnUnit } from "../src/sim/world";

const MAP = "three-canyons";

function setup(faction: Faction, harvesters = 18, condors = 2) {
  const w = createMapWorld(MAP);
  w.tick = SKYLIFT.from * TICK_RATE;
  w.factions[faction].scrap = 3000;
  const hq = hqOf(w, faction)!;
  const dir = faction === "blue" ? 1 : -1;
  const field = faction === "blue" ? [3, 116] : [116, 3];
  for (let i = 0; i < harvesters; i++) {
    const u = spawnUnit(w, "harvester", faction, hq.tx + 1 + dir * (5 + (i % 6)), hq.ty + 1 - dir * (3 + Math.floor(i / 6)));
    u.order = { type: "harvest", fieldX: field[0]!, fieldY: field[1]!, phase: "toField" };
  }
  for (let i = 0; i < condors; i++) spawnUnit(w, "condor", faction, hq.tx + 1 + dir * 4, hq.ty + 1 - dir * 4);
  const s = { skylift: true } as unknown as AiState;
  return { w, s, hq };
}

/** A think every second for `secs`: the plan's commands go in as they come. */
function fly(w: World, s: AiState, faction: Faction, secs: number) {
  const hq = hqOf(w, faction)!;
  for (let t = 0; t < secs; t++) {
    const harvesters = [...w.units.values()].filter((u) => u.faction === faction && u.kind === "harvester");
    const { cmds } = planSkylift(w, faction, s, { hq, harvesters, seen: [], threatened: false });
    for (let i = 0; i < TICK_RATE; i++) step(w, i === 0 ? cmds : []);
  }
}

const onMesa = (w: World, faction: Faction): Unit[] => {
  const hq = hqOf(w, faction)!;
  return [...w.units.values()].filter((u) => u.faction === faction && u.kind === "harvester" && offHome(w, hq, u) && u.order.type !== "board");
};

describe("the mesa run", () => {
  for (const faction of ["blue", "red"] as const)
    it(`${faction} flies a crew up, founds a Depot and works the field`, () => {
      const { w, s, hq } = setup(faction);
      fly(w, s, faction, 420);
      const home = regionAt(w, hq.tx, hq.ty, "ground");
      const depot = [...w.buildings.values()].find((b) => b.faction === faction && b.kind === "depot" && regionAt(w, b.tx, b.ty, "ground") !== home);
      expect(depot).toBeTruthy();
      expect(depot!.founding).toBeUndefined();
      expect(onMesa(w, faction).length).toBeGreaterThanOrEqual(5);
      expect(onMesa(w, faction).filter((u) => u.order.type === "harvest").length).toBeGreaterThanOrEqual(4);
    });

  it("leaves enough at home, and waits for the opening", () => {
    const { w, s } = setup("blue", 8);
    fly(w, s, "blue", 20); // (the HQ's starter makes nine: one too few to spare a crew's worth quickly)
    const late = setup("blue");
    late.w.tick = 0;
    fly(late.w, late.s, "blue", 20);
    expect(onMesa(late.w, "blue")).toHaveLength(0);
    const home = [...w.units.values()].filter((u) => u.faction === "blue" && u.kind === "harvester" && u.order.type !== "board");
    expect(home.length).toBeGreaterThanOrEqual(SKYLIFT.keepHome);
  });

  it("asks production for its Condors", () => {
    const { w, s } = setup("blue", 18, 0);
    fly(w, s, "blue", 1);
    expect(skyliftWantsCondor(w, s, 0)).toBe(true);
    expect(skyliftWantsCondor(w, s, SKYLIFT.condors)).toBe(false);
  });

  it("does nothing on a map with no field off the home ground", () => {
    const w = createMapWorld("dune-sea");
    w.tick = SKYLIFT.from * TICK_RATE;
    const s = { skylift: true } as unknown as AiState;
    const hq = hqOf(w, "blue")!;
    const r = planSkylift(w, "blue", s, { hq, harvesters: [], seen: [], threatened: false });
    expect(r.cmds).toHaveLength(0);
    expect(skyliftWantsCondor(w, s, 0)).toBe(false);
    expect(BUILDINGS.depot.dropOff).toBe(true);
  });
});
