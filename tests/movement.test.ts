import { describe, expect, it } from "vitest";
import { ECONOMY, TICK_RATE, UNITS } from "../src/sim/balance";
import { findPath } from "../src/sim/movement";
import { step } from "../src/sim/sim";
import { Terrain } from "../src/sim/types";
import { canGetWithin, createWorld, regionAt, setTerrain, spawnBuilding, spawnUnit } from "../src/sim/world";

function runTicks(w: ReturnType<typeof createWorld>, n: number) {
  for (let i = 0; i < n; i++) step(w, []);
}

describe("pathfinding", () => {
  it("finds a straight path on open ground", () => {
    const w = createWorld(16, 16);
    const path = findPath(w, 1.5, 1.5, 10.5, 1.5)!;
    expect(path).not.toBeNull();
    expect(path.at(-1)).toEqual({ x: 10.5, y: 1.5 });
    expect(path.length).toBe(9);
  });

  it("routes around a rock wall through a gap", () => {
    const w = createWorld(16, 16);
    for (let ty = 0; ty < 16; ty++) if (ty !== 8) setTerrain(w, 8, ty, Terrain.Rock);
    const path = findPath(w, 2.5, 2.5, 13.5, 2.5)!;
    expect(path).not.toBeNull();
    // must pass through the single gap at (8, 8)
    expect(path.some((p) => p.x === 8.5 && p.y === 8.5)).toBe(true);
  });

  it("returns null when the goal is sealed off far from anything reachable", () => {
    const w = createWorld(24, 16);
    for (let i = 0; i < 16; i++) {
      setTerrain(w, 8, i, Terrain.Rock);
    }
    expect(findPath(w, 2.5, 2.5, 20.5, 2.5)).toBeNull();
  });

  it("walks to the nearest reachable tile when the goal is cut off nearby", () => {
    // a wall between us and the goal: stop on our side of it, not flood the map
    const w = createWorld(16, 16);
    for (let i = 0; i < 16; i++) setTerrain(w, 8, i, Terrain.Rock);
    const end = findPath(w, 2.5, 2.5, 11.5, 2.5)!.at(-1)!;
    expect(end).toEqual({ x: 7.5, y: 2.5 });
  });

  it("knows an island is cut off without searching the mainland", () => {
    const w = createWorld(40, 40);
    for (let y = 0; y < 40; y++) for (let x = 20; x < 40; x++) setTerrain(w, x, y, Terrain.Water);
    for (let y = 18; y < 22; y++) for (let x = 30; x < 34; x++) setTerrain(w, x, y, Terrain.Ground);
    expect(regionAt(w, 31, 19, "ground")).not.toBe(regionAt(w, 5, 5, "ground"));
    expect(regionAt(w, 31, 19, "hover")).toBe(regionAt(w, 25, 5, "hover"));
    expect(regionAt(w, 25, 5, "foot")).toBe(0);
    expect(findPath(w, 5.5, 5.5, 31.5, 19.5)).toBeNull();
    expect(findPath(w, 5.5, 5.5, 31.5, 19.5, "hover")).not.toBeNull();
    expect(canGetWithin(w, "ground", 5.5, 19.5, 30.5, 19.5, 4)).toBe(false);
    expect(canGetWithin(w, "ground", 5.5, 19.5, 22.5, 19.5, 4)).toBe(true);
    expect(canGetWithin(w, "air", 5.5, 19.5, 31.5, 19.5, 1)).toBe(true);
    // painting changes the regions: a causeway joins the island to the shore
    for (let x = 20; x < 30; x++) setTerrain(w, x, 19, Terrain.Bridge);
    expect(regionAt(w, 31, 19, "ground")).toBe(regionAt(w, 5, 5, "ground"));
  });

  it("redirects to a nearby tile when the goal tile is blocked", () => {
    const w = createWorld(16, 16);
    setTerrain(w, 10, 10, Terrain.Rock);
    const path = findPath(w, 2.5, 2.5, 10.5, 10.5)!;
    expect(path).not.toBeNull();
    const end = path.at(-1)!;
    expect(Math.hypot(end.x - 10.5, end.y - 10.5)).toBeLessThan(2);
  });

  it("never cuts a diagonal corner past blocking rock", () => {
    const w = createWorld(8, 8);
    setTerrain(w, 3, 2, Terrain.Rock);
    setTerrain(w, 2, 3, Terrain.Rock);
    // moving from (2,2) to (3,3) diagonally would cut between the two rocks
    const path = findPath(w, 2.5, 2.5, 3.5, 3.5)!;
    expect(path).not.toBeNull();
    expect(path.length).toBeGreaterThan(1); // forced around, not straight through
  });
});

describe("unit movement", () => {
  it("moves a ground unit to its ordered destination at its speed", () => {
    const w = createWorld(24, 24);
    const u = spawnUnit(w, "stinger", "blue", 2.5, 2.5);
    step(w, [{ type: "move", faction: "blue", unitIds: [u.id], x: 12.5, y: 2.5 }]);
    const seconds = 10 / UNITS.stinger.speed;
    runTicks(w, Math.ceil(seconds * TICK_RATE) + 5);
    expect(Math.hypot(u.x - 12.5, u.y - 2.5)).toBeLessThan(0.6);
    expect(u.order.type).toBe("idle");
  });

  it("does not let a ground unit take a path through buildings", () => {
    const w = createWorld(24, 24);
    // wall of buildings with no gap across the middle
    for (let tx = 0; tx < 24; tx += 3) spawnBuilding(w, "hq", "red", tx, 10);
    const u = spawnUnit(w, "stinger", "blue", 5.5, 2.5);
    step(w, [{ type: "move", faction: "blue", unitIds: [u.id], x: 5.5, y: 20.5 }]);
    runTicks(w, 200);
    expect(u.y).toBeLessThan(10); // gave up on the near side, never clipped through
  });

  it("flies an air unit straight over rock", () => {
    const w = createWorld(24, 24);
    for (let ty = 0; ty < 24; ty++) setTerrain(w, 10, ty, Terrain.Rock);
    const u = spawnUnit(w, "wasp", "blue", 2.5, 12.5);
    step(w, [{ type: "move", faction: "blue", unitIds: [u.id], x: 20.5, y: 12.5 }]);
    const seconds = 18 / UNITS.wasp.speed;
    runTicks(w, Math.ceil(seconds * TICK_RATE) + 5);
    expect(Math.hypot(u.x - 20.5, u.y - 12.5)).toBeLessThan(0.5);
  });

  it("separates PERFECTLY stacked units (identical coordinates)", () => {
    const w = createWorld(24, 24);
    const units = [1, 2, 3].map(() => spawnUnit(w, "stinger", "blue", 5.5, 5.5));
    runTicks(w, 20);
    for (let i = 0; i < units.length; i++)
      for (let j = i + 1; j < units.length; j++)
        expect(
          Math.hypot(units[i]!.x - units[j]!.x, units[i]!.y - units[j]!.y)
        ).toBeGreaterThan(0.3);
  });

  it("a group moving on one shared path never fuses into a single point", () => {
    const w = createWorld(32, 32);
    const units = [0, 1, 2, 3].map((i) =>
      spawnUnit(w, "stinger", "blue", 3.5 + i * 0.05, 3.5)
    );
    step(w, [
      { type: "move", faction: "blue", unitIds: units.map((u) => u.id), x: 28.5, y: 3.5 }
    ]);
    let minSeen = Infinity;
    for (let t = 0; t < 12 * TICK_RATE; t++) {
      step(w, []);
      for (let i = 0; i < units.length; i++)
        for (let j = i + 1; j < units.length; j++)
          minSeen = Math.min(
            minSeen,
            Math.hypot(units[i]!.x - units[j]!.x, units[i]!.y - units[j]!.y)
          );
    }
    expect(minSeen).toBeGreaterThan(0.15);
  });

  it("separates stacked units of the same domain", () => {
    const w = createWorld(24, 24);
    const a = spawnUnit(w, "stinger", "blue", 5.5, 5.5);
    const b = spawnUnit(w, "stinger", "blue", 5.55, 5.5);
    runTicks(w, 20);
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(0.5);
  });

  it("never shoves a ground unit onto the map's edge (its model would hang off it)", () => {
    // a factory in a corner rolls its units out onto one spot: they part, inside the map
    for (const kind of ["stinger", "trooper"] as const) {
      const w = createWorld(24, 24);
      const units = [1, 2, 3, 4].map(() => spawnUnit(w, kind, "blue", 0.5, 23.5));
      runTicks(w, 3 * TICK_RATE);
      for (const u of units) {
        expect(Math.min(u.x, u.y, w.width - u.x, w.height - u.y), kind).toBeGreaterThanOrEqual(0.4 - 1e-9);
        for (const o of units) if (o !== u) expect(Math.hypot(u.x - o.x, u.y - o.y)).toBeGreaterThan(0.3);
      }
    }
  });

  it("lets air and ground units share a spot (different altitude)", () => {
    const w = createWorld(24, 24);
    const a = spawnUnit(w, "stinger", "blue", 5.5, 5.5);
    const b = spawnUnit(w, "wasp", "blue", 5.5, 5.5);
    runTicks(w, 10);
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(0.3);
  });

  it("faces the direction of travel", () => {
    const w = createWorld(24, 24);
    const u = spawnUnit(w, "stinger", "blue", 5.5, 5.5);
    step(w, [{ type: "move", faction: "blue", unitIds: [u.id], x: 10.5, y: 5.5 }]);
    runTicks(w, 3);
    // travelling east: facing = atan2(dx, -dy) = atan2(1, 0) = PI/2
    expect(u.facing).toBeCloseTo(Math.PI / 2, 1);
  });
});

describe("harvesting cycle", () => {
  it("mines a field, hauls to HQ, unloads scrap, and repeats", () => {
    const w = createWorld(24, 24);
    spawnBuilding(w, "hq", "blue", 2, 2);
    setTerrain(w, 8, 3, Terrain.Scrap);
    const u = spawnUnit(w, "harvester", "blue", 6.5, 3.5);
    w.factions.blue.scrap = 0;
    step(w, [{ type: "harvest", faction: "blue", unitIds: [u.id], x: 8.5, y: 3.5 }]);
    runTicks(w, 60 * TICK_RATE);
    expect(w.factions.blue.scrap).toBeGreaterThan(150); // several round trips
    expect(w.scrap[3 * 24 + 8]).toBeLessThan(1500);
  });

  it("retargets to another field when the first is mined out", () => {
    const w = createWorld(24, 24);
    spawnBuilding(w, "hq", "blue", 2, 2);
    setTerrain(w, 8, 3, Terrain.Scrap);
    setTerrain(w, 10, 3, Terrain.Scrap);
    w.scrap[3 * 24 + 8] = 30; // nearly empty
    const u = spawnUnit(w, "harvester", "blue", 7.5, 3.5);
    step(w, [{ type: "harvest", faction: "blue", unitIds: [u.id], x: 8.5, y: 3.5 }]);
    runTicks(w, 40 * TICK_RATE);
    expect(w.scrap[3 * 24 + 10]).toBeLessThan(1500); // moved on to the second tile
  });

  it("three harvesters on one field all keep income flowing (no jam)", () => {
    const w = createWorld(24, 24);
    spawnBuilding(w, "hq", "blue", 2, 2);
    for (let tx = 8; tx <= 10; tx++)
      for (let ty = 3; ty <= 5; ty++) setTerrain(w, tx, ty, Terrain.Scrap);
    const ids = [1, 2, 3].map(
      (i) => spawnUnit(w, "harvester", "blue", 6.5 + i * 0.3, 3.5).id
    );
    w.factions.blue.scrap = 0;
    step(w, [{ type: "harvest", faction: "blue", unitIds: ids, x: 9.5, y: 4.5 }]);
    runTicks(w, 90 * TICK_RATE);
    // three harvesters over 90s must clearly out-earn a single stuck one
    expect(w.factions.blue.scrap).toBeGreaterThan(500);
  });

  it("a harvester under fire flees toward the HQ instead of mining on", () => {
    const w = createWorld(32, 32);
    spawnBuilding(w, "hq", "blue", 2, 2);
    setTerrain(w, 20, 20, Terrain.Scrap);
    const h = spawnUnit(w, "harvester", "blue", 20.5, 20.5);
    step(w, [{ type: "harvest", faction: "blue", unitIds: [h.id], x: 20.5, y: 20.5 }]);
    runTicks(w, 5);
    const distBefore = Math.hypot(h.x - 3.5, h.y - 3.5);
    h.hp -= 20;
    h.damagedTick = w.tick; // shot!
    runTicks(w, 3 * TICK_RATE);
    const distAfter = Math.hypot(h.x - 3.5, h.y - 3.5);
    expect(distAfter).toBeLessThan(distBefore - 2); // clearly running home
    // once safe it goes back to mining
    runTicks(w, 30 * TICK_RATE);
    expect(w.factions.blue.scrap).toBeGreaterThan(ECONOMY.startingScrap);
  });

  it("goes idle when all scrap in the world is gone", () => {
    const w = createWorld(24, 24);
    spawnBuilding(w, "hq", "blue", 2, 2);
    setTerrain(w, 8, 3, Terrain.Scrap);
    w.scrap[3 * 24 + 8] = 0;
    const u = spawnUnit(w, "harvester", "blue", 7.5, 3.5);
    step(w, [{ type: "harvest", faction: "blue", unitIds: [u.id], x: 8.5, y: 3.5 }]);
    runTicks(w, 5);
    expect(u.order.type).toBe("idle");
  });
});

describe("fighting across water", () => {
  /** A 40×24 map: blue's shore on the left, sea from x=14, a 6×6 island at x=26..31. */
  function islandWorld() {
    const w = createWorld(40, 24);
    for (let y = 0; y < 24; y++) for (let x = 14; x < 40; x++) setTerrain(w, x, y, Terrain.Water);
    for (let y = 9; y < 15; y++) for (let x = 26; x < 32; x++) setTerrain(w, x, y, Terrain.Rough);
    return w;
  }

  it("an island garrison shelled from out of reach isn't locked onto the shooter", () => {
    const w = islandWorld();
    const garrison = spawnUnit(w, "trooper", "blue", 27.5, 12);
    const mortar = spawnUnit(w, "mortar", "red", 20, 12); // 7.5 tiles off, across the water
    setTerrain(w, 20, 12, Terrain.Ground);
    for (let x = 15; x < 22; x++) for (let y = 10; y < 15; y++) setTerrain(w, x, y, Terrain.Ground);
    runTicks(w, 6 * TICK_RATE);
    expect(w.units.get(garrison.id)!.hp).toBeLessThan(UNITS.trooper.hp); // the shells landed
    expect(w.units.get(garrison.id)!.order).toEqual({ type: "idle" }); // …and it didn't take an order it can't carry out
    // enemy squads dropped beside it get shot
    const raider = spawnUnit(w, "trooper", "red", 29.5, 12);
    const hp0 = raider.hp;
    w.units.delete(mortar.id);
    runTicks(w, 3 * TICK_RATE);
    expect(w.units.get(raider.id)?.hp ?? 0).toBeLessThan(hp0);
  });

  it("an attack order on an island target from the mainland is dropped, not chased forever", () => {
    const w = islandWorld();
    const tank = spawnUnit(w, "stinger", "blue", 8, 12);
    const squad = spawnUnit(w, "trooper", "red", 28.5, 12);
    step(w, [{ type: "attack", faction: "blue", unitIds: [tank.id], targetId: squad.id }]);
    runTicks(w, 2);
    expect(w.units.get(tank.id)!.order.type).toBe("idle");
  });
});
