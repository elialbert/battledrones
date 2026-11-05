import { describe, expect, it } from "vitest";
import { expansionSite, tendExpansion, type ExpansionPlan } from "../src/sim/ai/expansion";
import { seatMarshal } from "../src/sim/ai/marshal";
import { createMapWorld } from "../src/sim/maps";
import { step } from "../src/sim/sim";
import type { Command, Unit, World } from "../src/sim/types";
import { buildingCenter, hqOf, spawnUnit } from "../src/sim/world";

/** A blue side about to expand, nothing in sight. */
function quiet(): { w: World; hq: { x: number; y: number }; crew: Unit[]; site: { tx: number; ty: number } } {
  const w = createMapWorld("dune-sea", { seed: 1 });
  w.factions.blue.scrap = 2000;
  const hq = buildingCenter(hqOf(w, "blue")!);
  for (let i = 0; i < 6; i++) spawnUnit(w, "harvester", "blue", hq.x + 3, hq.y + 3);
  return { w, hq, crew: [...w.units.values()].filter((u) => u.faction === "blue" && u.kind === "harvester"), site: expansionSite(w, "blue", hq, 5)! };
}

describe("where Marshal's Depots go (replay 2026-11-05)", () => {
  it("sends no crew to a site gone hot out of sight: a Depot fell there, or an army was seen there", () => {
    const { w, hq, crew, site } = quiet();
    const s: { expansion?: ExpansionPlan | null } = {};
    tendExpansion(w, "blue", s, true, hq, crew, new Set(), 0, 5, [], [], undefined, [{ x: site.tx + 1, y: site.ty + 1 }]);
    expect([s.expansion?.tx, s.expansion?.ty]).not.toEqual([site.tx, site.ty]);
  });

  it("calls a crew back from an army across its way, though the site is quiet", () => {
    const { w, hq, crew } = quiet();
    const s: { expansion?: ExpansionPlan | null } = {};
    const cmds: Command[] = [];
    tendExpansion(w, "blue", s, true, hq, crew, new Set(), 0, 5, cmds, []);
    expect(s.expansion).toBeTruthy();
    step(w, cmds);
    const lead = w.units.get(s.expansion!.crew[0]!)!;
    const army = [0, 1, 2].map(() => spawnUnit(w, "stinger", "red", lead.x + 1, lead.y));
    const hot = army.map((u) => ({ x: u.x, y: u.y }));
    const back: Command[] = [];
    tendExpansion(w, "blue", s, true, hq, crew, new Set(), 0, 5, back, army, undefined, hot);
    expect(s.expansion ?? null).toBeNull();
    expect(back.some((c) => c.type === "stop")).toBe(true);
  });

  it("Brutal has three tier-1 factories up before its Tech Lab starts", () => {
    const w = createMapWorld("dune-sea", { seed: 3 });
    const bot = seatMarshal("red", 5, "brutal", "balanced");
    while (w.tick < 3000 && w.factions.red.pending?.kind !== "tech-lab") step(w, bot.tick(w));
    expect(w.factions.red.pending?.kind).toBe("tech-lab");
    const factories = [...w.buildings.values()].filter((b) => b.faction === "red" && (b.kind === "fab-plant" || b.kind === "airpad"));
    expect(factories.length).toBeGreaterThanOrEqual(3);
  }, 30000);
});
