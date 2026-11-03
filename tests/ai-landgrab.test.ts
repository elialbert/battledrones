import { describe, expect, it } from "vitest";
import { expansionSite, tendExpansion, type ExpansionPlan } from "../src/sim/ai/expansion";
import { MARSHAL_PLANS, MARSHAL_POOL, planStrategy, seatMarshal } from "../src/sim/ai/marshal";
import { BUILDINGS, TICK_RATE } from "../src/sim/balance";
import { createMapWorld } from "../src/sim/maps";
import { step } from "../src/sim/sim";
import type { Command, Unit, World } from "../src/sim/types";
import { buildingCenter, hqOf, spawnUnit } from "../src/sim/world";

/** A blue side about to expand, with a Stinger of red's stood on the site it would take. */
function hotSite(): { w: World; hq: { x: number; y: number }; crew: Unit[]; foes: Unit[]; site: { tx: number; ty: number } } {
  const w = createMapWorld("dune-sea", { seed: 1 });
  w.factions.blue.scrap = 2000;
  const hq = buildingCenter(hqOf(w, "blue")!);
  for (let i = 0; i < 6; i++) spawnUnit(w, "harvester", "blue", hq.x + 3, hq.y + 3);
  const site = expansionSite(w, "blue", hq, 5)!;
  const foe = spawnUnit(w, "stinger", "red", site.tx + 1, site.ty + 1);
  return { w, hq, crew: [...w.units.values()].filter((u) => u.faction === "blue" && u.kind === "harvester"), foes: [foe], site };
}

describe("Land Grab (Marshal)", () => {
  it("is one of the plans every level draws, Brutal too, and only it grabs land", () => {
    for (const pool of Object.values(MARSHAL_POOL)) expect(pool).toContain("landgrab");
    for (const name of Object.keys(MARSHAL_PLANS) as (keyof typeof MARSHAL_PLANS)[])
      expect(!!planStrategy(name).landGrab).toBe(name === "landgrab");
  });

  it("fights for a hot site it can win: no crew goes, and the army is pointed at the site", () => {
    const { w, hq, crew, foes, site } = hotSite();
    const s: { expansion?: ExpansionPlan | null; contest?: { x: number; y: number } | null } = {};
    const cmds: Command[] = [];
    expect(tendExpansion(w, "blue", s, true, hq, crew, new Set(), 0, 5, cmds, foes, () => true).size).toBe(0);
    expect(cmds).toEqual([]);
    expect(s.expansion ?? null).toBeNull();
    const half = BUILDINGS.depot.size / 2;
    expect(s.contest).toEqual({ x: site.tx + half, y: site.ty + half });
  });

  it("leaves a hot site it would lose for a quiet field, as every other plan does", () => {
    const lost = hotSite();
    const s: { expansion?: ExpansionPlan | null; contest?: { x: number; y: number } | null } = {};
    tendExpansion(lost.w, "blue", s, true, lost.hq, lost.crew, new Set(), 0, 5, [], lost.foes, () => false);
    expect(s.contest ?? null).toBeNull();

    const other = hotSite();
    const t: { expansion?: ExpansionPlan | null } = {};
    tendExpansion(other.w, "blue", t, true, other.hq, other.crew, new Set(), 0, 5, [], other.foes);
    expect(s.expansion?.tx).toBe(t.expansion?.tx);
    expect(s.expansion?.ty).toBe(t.expansion?.ty);
    expect(s.expansion).toBeTruthy();
    expect([s.expansion!.tx, s.expansion!.ty]).not.toEqual([lost.site.tx, lost.site.ty]);
  });

  it("gets past three Depots on Frostbite from either side, the factories scrap piles up for not in front of them", () => {
    for (const side of ["blue", "red"] as const) {
      const w = createMapWorld("frostbite", { seed: 2 });
      const bot = seatMarshal(side, 2, "brutal", "landgrab");
      // (the other side sits still, and its HQ can't fall: left to die, the game was over by 2:52)
      const foeHq = hqOf(w, side === "blue" ? "red" : "blue")!;
      for (let i = 0; i < 5 * 60 * TICK_RATE && !w.winner; i++) {
        step(w, bot.tick(w));
        foeHq.hp = BUILDINGS.hq.hp;
      }
      const depots = [...w.buildings.values()].filter((b) => b.faction === side && b.kind === "depot").length;
      expect(depots).toBeGreaterThan(3);
    }
  });
});
