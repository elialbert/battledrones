import { describe, expect, it } from "vitest";
import { BUILDINGS, ECONOMY, TICK_RATE } from "../src/sim/balance";
import { createMapWorld } from "../src/sim/maps";
import { step } from "../src/sim/sim";
import { buildingCenter, dist, hqOf } from "../src/sim/world";
import { MARSHAL_POOL, seatMarshal } from "../src/sim/ai/marshal";

describe("The Wall (Marshal)", () => {
  it("builds turrets out past the HQ's zone to a field and puts a Depot there, founds none, and techs only at 15 turrets", () => {
    const w = createMapWorld("riverlands", { seed: 3 });
    const wall = seatMarshal("blue", 3, "normal", "wall");
    // (red sits still, and its HQ can't fall: any bot playing red, even an Easy one, lost before the wall was out)
    const redHq = hqOf(w, "red")!;

    const hq = buildingCenter(hqOf(w, "blue")!);
    const mine = () => [...w.buildings.values()].filter((b) => b.faction === "blue");
    let founds = 0;
    let techEarly = false;
    for (let i = 0; i < 6 * 60 * TICK_RATE && !w.winner; i++) {
      const cmds = wall.tick(w);
      founds += cmds.filter((c) => c.type === "found").length;
      step(w, cmds);
      redHq.hp = BUILDINGS.hq.hp;
      const bs = mine();
      if (bs.some((b) => b.kind === "tech-lab") && bs.filter((b) => b.kind === "turret").length < 15) techEarly = true;
    }
    expect(founds).toBe(0);
    expect(techEarly).toBe(false);
    const bs = mine();
    expect(bs.filter((b) => b.kind === "turret").length).toBeGreaterThanOrEqual(8);
    // a turret, and a Depot by it, out past what the HQ's zone reaches
    const far = (k: string) => bs.filter((b) => b.kind === k && dist(buildingCenter(b).x, buildingCenter(b).y, hq.x, hq.y) > ECONOMY.buildRadius + BUILDINGS.hq.size);
    expect(far("turret").length).toBeGreaterThan(0);
    expect(far("depot").length).toBeGreaterThan(0);
    // a few Stingers, no tanks
    const units = [...w.units.values()].filter((u) => u.faction === "blue");
    expect(units.some((u) => u.kind === "stinger")).toBe(true);
    expect(units.some((u) => u.kind === "mastodon" || u.kind === "lancer")).toBe(false);
  });

  it("is never drawn on Brutal", () => {
    expect(MARSHAL_POOL.brutal).not.toContain("wall");
    expect(MARSHAL_POOL.hard).toContain("wall");
  });
});
