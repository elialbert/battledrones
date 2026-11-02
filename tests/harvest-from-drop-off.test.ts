import { describe, expect, it } from "vitest";
import { BUILDINGS, ECONOMY, TICK_RATE } from "../src/sim/balance";
import { createMapWorld } from "../src/sim/maps";
import { step } from "../src/sim/sim";
import { buildingCenter, hqOf, spawnUnit } from "../src/sim/world";

describe("the harvest command on your own HQ (economy.ts harvestFromDropOff)", () => {
  it("a loaded harvester left idle unloads there, then goes back to mining", () => {
    const w = createMapWorld("proving-grounds");
    const hq = hqOf(w, "blue")!;
    const c = buildingCenter(hq);
    const u = spawnUnit(w, "harvester", "blue", c.x + 6, c.y - 6);
    u.cargo = ECONOMY.harvesterCapacity * 0.6; // (interrupted part-full: no field order to resume)
    const before = w.factions.blue.scrap;
    step(w, [{ type: "harvest", faction: "blue", unitIds: [u.id], x: c.x, y: c.y }]);
    expect(u.order.type === "harvest" && u.order.phase).toBe("toBase");
    let unloaded = false;
    let mining = false;
    for (let i = 0; i < 60 * TICK_RATE && !mining; i++) {
      step(w, []);
      if (u.cargo === 0) unloaded = true;
      if (unloaded && u.order.type === "harvest" && u.order.phase === "harvesting") mining = true;
    }
    expect(unloaded).toBe(true);
    expect(w.factions.blue.scrap).toBeGreaterThan(before);
    expect(mining).toBe(true);
  });

  it("an empty one just goes to the field by that building; the enemy's HQ does nothing", () => {
    const w = createMapWorld("proving-grounds");
    const hq = hqOf(w, "blue")!;
    const c = buildingCenter(hq);
    const u = spawnUnit(w, "harvester", "blue", c.x + 6, c.y - 6);
    step(w, [{ type: "harvest", faction: "blue", unitIds: [u.id], x: c.x, y: c.y }]);
    expect(u.order.type === "harvest" && u.order.phase).toBe("toField");
    const idle = spawnUnit(w, "harvester", "blue", c.x + 6, c.y - 7);
    const red = buildingCenter(hqOf(w, "red")!);
    step(w, [{ type: "harvest", faction: "blue", unitIds: [idle.id], x: red.x, y: red.y }]);
    expect(idle.order.type).toBe("idle");
    expect(BUILDINGS.hq.dropOff).toBe(true);
  });
});
