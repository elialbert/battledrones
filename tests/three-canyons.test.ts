import { describe, expect, it } from "vitest";
import { TICK_RATE } from "../src/sim/balance";
import { createMapWorld, mapById } from "../src/sim/maps";
import { step } from "../src/sim/sim";
import { findUnit } from "../src/sim/transport";
import { Terrain, type Command, type Unit, type World } from "../src/sim/types";
import { hqOf, isResource, nearestDropSite, passable, regionAt, spawnUnit, tileIndex } from "../src/sim/world";

const MAP = "three-canyons";
const MESA = { x: 12, y: 12 }; // the top-left one; its twin is the mirror image

const run = (w: World, secs: number, cmds: Command[] = []) => {
  for (let i = 0; i < secs * TICK_RATE; i++) step(w, i === 0 ? cmds : []);
};

/** Can a tank drive between the bases with these discs of the map walled off? */
function basesJoined(w: World, cuts: [number, number][]): boolean {
  const W = w.width;
  const blocked = (x: number, y: number) => cuts.some(([cx, cy]) => Math.hypot(x - cx, y - cy) < 8);
  const seen = new Uint8Array(W * W);
  const stack: [number, number][] = [[12, 100]];
  seen[100 * W + 12] = 1;
  while (stack.length) {
    const [x, y] = stack.pop()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const X = x + dx;
      const Y = y + dy;
      if (X < 0 || Y < 0 || X >= W || Y >= W || seen[Y * W + X] || !passable(w, X, Y, "ground") || blocked(X, Y)) continue;
      seen[Y * W + X] = 1;
      stack.push([X, Y]);
    }
  }
  return seen[19 * W + 100] === 1;
}

describe("Three Canyons", () => {
  it("is a big desert duel, point-symmetric", () => {
    const def = mapById(MAP);
    expect(def.biome).toBe("desert");
    expect(def.size).toBe(120);
    const w = createMapWorld(MAP);
    const n = w.terrain.length;
    for (let i = 0; i < n; i++) expect(w.terrain[i]).toBe(w.terrain[n - 1 - i]);
  });

  it("joins the bases by exactly three canyons", () => {
    const w = createMapWorld(MAP);
    const north: [number, number] = [15, 61];
    const centre: [number, number] = [45, 75];
    const south: [number, number] = [104, 58];
    expect(basesJoined(w, [])).toBe(true);
    for (const pair of [[north, centre], [north, south], [centre, south]]) expect(basesJoined(w, pair)).toBe(true);
    expect(basesJoined(w, [north, centre, south])).toBe(false);
  });

  it("keeps both corner mesas, and their fields, off the ground network", () => {
    const w = createMapWorld(MAP);
    const blue = hqOf(w, "blue")!;
    const red = hqOf(w, "red")!;
    for (const mc of ["ground", "foot", "hover"] as const) {
      const home = regionAt(w, blue.tx, blue.ty, mc);
      expect(regionAt(w, red.tx, red.ty, mc)).toBe(home);
      for (const [x, y] of [[MESA.x, MESA.y], [w.width - 1 - MESA.x, w.height - 1 - MESA.y]] as const) {
        expect(regionAt(w, x, y, mc)).toBeGreaterThan(0);
        expect(regionAt(w, x, y, mc)).not.toBe(home);
      }
    }
    expect(isResource(w, tileIndex(w, 7, 8))).toBe(true);
  });
});

describe("Condors carry Harvesters", () => {
  const setup = () => {
    const w = createMapWorld(MAP);
    const hq = hqOf(w, "blue")!;
    const condor = spawnUnit(w, "condor", "blue", hq.tx + 6, hq.ty - 3);
    return { w, hq, condor };
  };
  const loadAndDrop = (w: World, c: Unit, riders: Unit[], x = MESA.x, y = MESA.y) => {
    run(w, 12, [{ type: "board", faction: "blue", unitIds: riders.map((u) => u.id), carrierId: c.id }]);
    expect(c.passengers!.map((p) => p.id).sort()).toEqual(riders.map((u) => u.id).sort());
    run(w, 60, [{ type: "unload", faction: "blue", unitIds: [c.id], x, y }]);
  };

  it("boards two, a seat each, and sets them to work on the mesa's field", () => {
    const { w, hq, condor } = setup();
    const a = spawnUnit(w, "harvester", "blue", hq.tx + 5, hq.ty - 2);
    const b = spawnUnit(w, "harvester", "blue", hq.tx + 6, hq.ty - 2);
    const c = spawnUnit(w, "harvester", "blue", hq.tx + 7, hq.ty - 2);
    run(w, 12, [{ type: "board", faction: "blue", unitIds: [a.id, b.id, c.id], carrierId: condor.id }]);
    expect(condor.passengers!.length).toBe(2);
    expect(w.units.has(c.id)).toBe(true); // no seat left for the third
    run(w, 60, [{ type: "unload", faction: "blue", unitIds: [condor.id], x: MESA.x, y: MESA.y }]);
    expect(condor.passengers!.length).toBe(0);
    for (const u of [a, b]) {
      expect(regionAt(w, Math.floor(u.x), Math.floor(u.y), "ground")).toBe(regionAt(w, MESA.x, MESA.y, "ground"));
      expect(u.cargo).toBeGreaterThan(0); // (full by now: with no drop site up here it waits, loaded)
    }
  });

  it("banks nothing from the mesa until a drop site stands on it: no scrap across the rock", () => {
    const { w, hq, condor } = setup();
    const u = spawnUnit(w, "harvester", "blue", hq.tx + 5, hq.ty - 2);
    expect(nearestDropSite(w, "blue", MESA.x, MESA.y, "ground")).toBeNull();
    loadAndDrop(w, condor, [u]);
    const before = w.factions.blue.stats.scrapHarvested;
    const own = [...w.units.values()].filter((v) => v.kind === "harvester" && v.faction === "blue" && v.id !== u.id);
    for (const v of own) w.units.delete(v.id); // (only the mesa crew's income is under test)
    run(w, 60);
    expect(w.factions.blue.stats.scrapHarvested).toBe(before);
    expect(u.cargo).toBeGreaterThan(0);
  });

  it("founds a Depot on the mesa and hauls to it; harvesters at home ignore it", () => {
    const { w, hq, condor } = setup();
    const crew = [0, 1, 2, 3, 4, 5].map((i) => spawnUnit(w, "harvester", "blue", MESA.x - 3 + i, MESA.y + 2));
    const [tx, ty] = [12, 13];
    w.factions.blue.scrap = 2000;
    run(w, 30, [{ type: "found", faction: "blue", unitIds: crew.slice(0, 4).map((u) => u.id), tx, ty }]);
    const depot = [...w.buildings.values()].find((b) => b.kind === "depot" && b.faction === "blue");
    expect(depot).toBeTruthy();
    run(w, 40);
    expect(depot!.founding).toBeUndefined();
    expect(nearestDropSite(w, "blue", MESA.x, MESA.y, "ground")?.id).toBe(depot!.id);
    // (nearer the mesa's Depot than the HQ, as the crow flies, but over the rock)
    expect(nearestDropSite(w, "blue", 16, 40, "ground")?.id).toBe(hq.id);
    const cargo = crew[4]!;
    cargo.order = { type: "harvest", fieldX: 7, fieldY: 8, phase: "toField" };
    const before = w.factions.blue.stats.scrapHarvested;
    run(w, 90);
    expect(w.factions.blue.stats.scrapHarvested).toBeGreaterThan(before);
    expect(condor.hp).toBeGreaterThan(0);
  });

  it("loses the Harvesters with a Condor shot down over rock", () => {
    const { w, hq, condor } = setup();
    const u = spawnUnit(w, "harvester", "blue", hq.tx + 5, hq.ty - 2);
    run(w, 12, [{ type: "board", faction: "blue", unitIds: [u.id], carrierId: condor.id }]);
    expect(condor.passengers!.length).toBe(1);
    condor.x = 40;
    condor.y = 40;
    expect(w.terrain[40 * w.width + 40]).toBe(Terrain.Rock);
    condor.hp = 0;
    run(w, 1);
    expect(findUnit(w, u.id)).toBeNull();
  });
});
