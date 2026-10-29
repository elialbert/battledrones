import { describe, expect, it } from "vitest";
import { BUILDINGS, ECONOMY, TICK_RATE } from "../src/sim/balance";
import { buildingBlocker, canPlaceBuilding, foundBlocker, inBaseRange } from "../src/sim/economy";
import { MAPS, createMapWorld } from "../src/sim/maps";
import { placementBlocker } from "../src/sim/placement";
import { step } from "../src/sim/sim";
import { Terrain, type World } from "../src/sim/types";
import { hqOf, isResource, nearestDropOff, spawnBuilding, spawnUnit, terrainAt } from "../src/sim/world";

const isField = (t: Terrain) => t === Terrain.Scrap || t === Terrain.Crystal;

/** Tiles from (tx, ty) to the nearest scrap or crystal tile, centre to centre (Infinity: none within 4). */
function fieldDist(w: World, tx: number, ty: number): number {
  let best = Infinity;
  for (let dy = -4; dy <= 4; dy++)
    for (let dx = -4; dx <= 4; dx++) if (isField(terrainAt(w, tx + dx, ty + dy))) best = Math.min(best, Math.hypot(dx, dy));
  return best;
}

describe("Wasteland round every field", () => {
  for (const def of MAPS)
    it(`rings ${def.name}'s fields, and only them`, () => {
      const w = createMapWorld(def.id);
      let waste = 0;
      for (let ty = 0; ty < w.height; ty++)
        for (let tx = 0; tx < w.width; tx++) {
          const t = terrainAt(w, tx, ty);
          if (t === Terrain.Wasteland) {
            waste++;
            expect(fieldDist(w, tx, ty)).toBeLessThanOrEqual(ECONOMY.wastelandRing);
          } else if (t === Terrain.Ground) expect(fieldDist(w, tx, ty)).toBeGreaterThan(ECONOMY.wastelandRing);
        }
      expect(waste).toBeGreaterThan(0);
    });

  it("can't be built on, and says so", () => {
    const w = createMapWorld("riverlands");
    let spot: [number, number] | null = null;
    const hq = hqOf(w, "blue")!;
    for (let ty = hq.ty - 8; ty < hq.ty + 8 && !spot; ty++)
      for (let tx = hq.tx - 8; tx < hq.tx + 8 && !spot; tx++)
        if (terrainAt(w, tx, ty) === Terrain.Wasteland && inBaseRange(w, "blue", tx + 0.5, ty + 0.5)) spot = [tx, ty];
    expect(spot).not.toBeNull();
    expect(canPlaceBuilding(w, "blue", "turret", ...spot!)).toBe(false);
    expect(placementBlocker(w, "blue", "turret", ...spot!)).toBe("Can't build on wasteland");
  });
});

/** A riverlands world with a blue depot by the HQ, and a spot for a deployed one out of build range by a field. */
function withHomeDepot() {
  const w = createMapWorld("riverlands");
  w.factions.blue.scrap = 5000;
  const hq = hqOf(w, "blue")!;
  // a depot in the base: anywhere in range will do for these rules
  let home: [number, number] | null = null;
  for (let ty = hq.ty - 4; ty < hq.ty + 6 && !home; ty++)
    for (let tx = hq.tx + 3; tx < hq.tx + 10 && !home; tx++) if (canPlaceBuilding(w, "blue", "depot", tx, ty)) home = [tx, ty];
  spawnBuilding(w, "depot", "blue", ...home!);
  // an expansion site: by a field, well out of build range, on our half
  let site: [number, number] | null = null;
  for (let ty = 0; ty < w.height && !site; ty++)
    for (let tx = 0; tx < w.width / 2 && !site; tx++)
      if (
        !foundBlocker(w, "blue", tx, ty) &&
        !inBaseRange(w, "blue", tx + 1, ty + 1) &&
        fieldDist(w, tx, ty) <= ECONOMY.wastelandRing + 2
      )
        site = [tx, ty];
  return { w, site: site! };
}

const run = (w: World, s: number) => {
  for (let i = 0; i < s * TICK_RATE; i++) step(w, []);
};

describe("expansion Depots", () => {
  it("Depots come from the sidebar as often as you like; past the base, harvesters deploy one", () => {
    const { w, site } = withHomeDepot();
    expect(buildingBlocker(w, "blue", "depot")).toBeNull();
    step(w, [{ type: "startBuilding", faction: "blue", building: "depot" }]);
    expect(w.factions.blue.pending?.kind).toBe("depot");
    // out of range, the ghost says how to get one there
    expect(placementBlocker(w, "blue", "depot", ...site)).toBe(`Too far: ${ECONOMY.expansion.crew} Harvesters can deploy it`);
    expect(placementBlocker(w, "blue", "turret", ...site)).toBe("Too far from base");
    expect(foundBlocker(w, "blue", ...site)).toBeNull();
  });

  it("is founded by a crew of harvesters: they walk there, pay, are used up, and it goes up out of build range", () => {
    const { w, site } = withHomeDepot();
    expect(site).toBeTruthy();
    const [tx, ty] = site;
    const hq = hqOf(w, "blue")!;
    const harvesters = () => [...w.units.values()].filter((u) => u.faction === "blue" && u.kind === "harvester");
    // three aren't a crew
    const crew = [0, 1, 2, 3].map((i) => spawnUnit(w, "harvester", "blue", hq.tx + 4.5 + (i % 2), hq.ty + 4.5 + (i >> 1)));
    step(w, [{ type: "found", faction: "blue", unitIds: crew.slice(0, 3).map((u) => u.id), tx, ty }]);
    expect(crew[0]!.order.type).not.toBe("found");
    const before = harvesters().length;
    const scrap = w.factions.blue.scrap;
    step(w, [{ type: "found", faction: "blue", unitIds: crew.map((u) => u.id), tx, ty }]);
    for (const u of crew) expect(u.order).toEqual({ type: "found", tx, ty });
    let depot = undefined;
    for (let i = 0; i < 90 * TICK_RATE && !depot; i++) {
      step(w, []);
      depot = [...w.buildings.values()].find((b) => b.faction === "blue" && b.kind === "depot" && b.tx === tx && b.ty === ty);
    }
    expect(depot).toBeTruthy();
    expect(w.factions.blue.scrap).toBeLessThan(scrap - ECONOMY.expansion.cost + 150); // (paid, give or take the HQ's trickle on the walk)
    expect(harvesters().length).toBe(before - ECONOMY.expansion.crew);
    for (const u of crew) expect(w.units.has(u.id)).toBe(false);
    // going up: frail, no drop-off and no build range yet
    expect(depot!.founding).toBeGreaterThan(0);
    expect(depot!.hp).toBeLessThan(BUILDINGS.depot.hp * 0.3);
    expect(nearestDropOff(w, "blue", tx + 1, ty + 1)?.id).not.toBe(depot!.id);
    expect(inBaseRange(w, "blue", tx + 1, ty + 1)).toBe(false);
    run(w, ECONOMY.expansion.buildTime / 2);
    expect(depot!.hp).toBeGreaterThan(BUILDINGS.depot.hp * 0.5);
    expect(depot!.hp).toBeLessThan(BUILDINGS.depot.hp * 0.75);
    run(w, ECONOMY.expansion.buildTime / 2 + 1);
    expect(depot!.founding).toBeUndefined();
    expect(depot!.hp).toBe(BUILDINGS.depot.hp);
    expect(nearestDropOff(w, "blue", tx + 1, ty + 1)?.id).toBe(depot!.id);
    expect(inBaseRange(w, "blue", tx + 1, ty + 1)).toBe(true);
  });

  it("waits for the scrap, and a crew cut below strength calls it off", () => {
    const { w, site } = withHomeDepot();
    const [tx, ty] = site;
    w.factions.blue.scrap = 0;
    const crew = [0, 1, 2, 3].map((i) => spawnUnit(w, "harvester", "blue", tx + 1 + (i % 2 ? 1.6 : -0.6), ty + 1 + (i >> 1 ? 1.6 : -0.6)));
    step(w, [{ type: "found", faction: "blue", unitIds: crew.map((u) => u.id), tx, ty }]);
    run(w, 5);
    expect(w.buildings.size).toBeGreaterThan(0);
    expect([...w.buildings.values()].some((b) => b.tx === tx && b.ty === ty)).toBe(false);
    expect(crew[0]!.order.type).toBe("found");
    w.units.delete(crew[3]!.id);
    step(w, []);
    for (const u of crew.slice(0, 3)) expect(u.order.type).toBe("idle");
  });

  it("sends the crew it didn't need back to work", () => {
    const { w, site } = withHomeDepot();
    const [tx, ty] = site;
    const crew = [0, 1, 2, 3, 4, 5].map((i) => spawnUnit(w, "harvester", "blue", tx + 1 + (i % 2 ? 1.6 : -0.6), ty + 1 + (i % 3) * 0.8 - 0.6));
    step(w, [{ type: "found", faction: "blue", unitIds: crew.map((u) => u.id), tx, ty }]);
    run(w, 5);
    const left = crew.filter((u) => w.units.has(u.id));
    expect(left.length).toBe(crew.length - ECONOMY.expansion.crew);
    for (const u of left) expect(u.order.type).toBe("harvest");
  });

  it("can't be founded on wasteland, and says so", () => {
    const { w } = withHomeDepot();
    let spot: [number, number] | null = null;
    for (let ty = 0; ty < w.height && !spot; ty++)
      for (let tx = 0; tx < w.width / 2 && !spot; tx++) if (terrainAt(w, tx, ty) === Terrain.Wasteland) spot = [tx, ty];
    expect(foundBlocker(w, "blue", ...spot!)).toBe("Can't build on wasteland");
  });

  it("Marshal founds one: a crew walks out, and the Depot goes up by a field it hadn't served", async () => {
    const { MARSHAL, marshal } = await import("../src/sim/ai/marshal");
    const w = createMapWorld("riverlands", { seed: 3 });
    const bot = marshal("blue", 3, "hard", { ...MARSHAL.hard, strategy: "greed" });
    let founded = false;
    for (let i = 0; i < 4 * 60 * TICK_RATE && !founded; i++) {
      step(w, bot.tick(w));
      founded = [...w.buildings.values()].some((b) => b.faction === "blue" && b.kind === "depot" && b.founding !== undefined);
    }
    expect(founded).toBe(true);
    const site = [...w.buildings.values()].find((b) => b.faction === "blue" && b.founding !== undefined)!;
    // by a field (past the Wasteland), out where its first depot didn't reach
    expect(fieldDist(w, site.tx, site.ty)).toBeLessThanOrEqual(ECONOMY.wastelandRing + 3);
    let resources = 0;
    for (let dy = -4; dy <= 5; dy++)
      for (let dx = -4; dx <= 5; dx++) if (isResource(w, (site.ty + dy) * w.width + site.tx + dx)) resources++;
    expect(resources).toBeGreaterThan(0);
  });

  it("Marshal's raids go for an expansion they've seen going up", async () => {
    const { createAiState, tickAi } = await import("../src/sim/ai/commander");
    const { w, site } = withHomeDepot();
    const [tx, ty] = site;
    const d = spawnBuilding(w, "depot", "blue", tx, ty);
    d.founding = ECONOMY.expansion.buildTime * TICK_RATE;
    d.hp = BUILDINGS.depot.hp * ECONOMY.expansion.siteHp;
    // red has seen it (a scout parked by it)
    spawnUnit(w, "scout", "red", tx + 1, ty - 2.5);
    step(w, []);
    const state = createAiState("rush", "normal", 1, { harassGroup: 3 });
    const hq = hqOf(w, "red")!;
    for (let i = 0; i < 3; i++) spawnUnit(w, "stinger", "red", hq.tx - 2, hq.ty + i);
    let hit = false;
    for (let i = 0; i < 10 * TICK_RATE && !hit; i++) {
      state.mode = "harass";
      const cmds = tickAi(w, "red", state);
      hit = cmds.some((c) => c.type === "attack" && c.targetId === d.id);
      step(w, cmds);
    }
    expect(hit).toBe(true);
  });
});
