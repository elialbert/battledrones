import { BUILDINGS, ECONOMY, TERRAIN, UNITS } from "./balance";
import { createFog } from "./fog";
import { createObjectiveState } from "./objectives";
import { createPowerState } from "./powers";
import {
  Terrain,
  type Building,
  type BuildingKind,
  type Faction,
  type FactionState,
  type Unit,
  type UnitKind,
  type World
} from "./types";

const newFaction = (): FactionState => ({
  scrap: ECONOMY.startingScrap,
  pending: null,
  stats: { unitsBuilt: 0, unitsLost: 0, unitsKilled: 0, buildingsLost: 0, buildingsKilled: 0, scrapHarvested: 0, scrapSalvaged: 0 },
  incomeMult: 1
});

export function createWorld(width: number, height: number): World {
  return {
    tick: 0,
    width,
    height,
    terrain: new Uint8Array(width * height),
    scrap: new Uint16Array(width * height),
    occupancy: new Int32Array(width * height),
    nextId: 1,
    units: new Map(),
    buildings: new Map(),
    projectiles: [],
    wrecks: [],
    powers: createPowerState(),
    objectives: createObjectiveState(),
    factions: { blue: newFaction(), red: newFaction() },
    winner: null,
    fx: [],
    fog: createFog(width, height),
    mapId: "custom",
    biome: "temperate",
    seed: 1
  };
}

export const tileIndex = (w: World, tx: number, ty: number): number =>
  ty * w.width + tx;

export const inBounds = (w: World, tx: number, ty: number): boolean =>
  tx >= 0 && ty >= 0 && tx < w.width && ty < w.height;

export function terrainAt(w: World, tx: number, ty: number): Terrain {
  if (!inBounds(w, tx, ty)) return Terrain.Rock;
  return w.terrain[tileIndex(w, tx, ty)] as Terrain;
}

export function setTerrain(w: World, tx: number, ty: number, t: Terrain): void {
  const i = tileIndex(w, tx, ty);
  w.terrain[i] = t;
  w.scrap[i] =
    t === Terrain.Scrap ? ECONOMY.scrapPerTile : t === Terrain.Crystal ? ECONOMY.crystalPerTile : 0;
}

/** Is this a harvestable tile (scrap or crystal) with anything left? */
export function isResource(w: World, i: number): boolean {
  const t = w.terrain[i];
  return (t === Terrain.Scrap || t === Terrain.Crystal) && w.scrap[i]! > 0;
}

/** Tiles occupied by any building footprint, for pathing/placement. */
export function buildingAtTile(w: World, tx: number, ty: number): Building | null {
  if (!inBounds(w, tx, ty)) return null;
  const id = w.occupancy[tileIndex(w, tx, ty)]!;
  return id ? w.buildings.get(id) ?? null : null;
}

/** Movement class of a unit: decides which terrain it may cross. */
export type MoveClass = "ground" | "hover" | "air";

export const moveClassOf = (kind: UnitKind): MoveClass =>
  UNITS[kind].domain === "air" ? "air" : UNITS[kind].hover ? "hover" : "ground";

/** Can a unit of this movement class stand on the tile? */
export function passable(w: World, tx: number, ty: number, mc: MoveClass): boolean {
  if (!inBounds(w, tx, ty)) return false;
  if (mc === "air") return true;
  const i = tileIndex(w, tx, ty);
  const info = TERRAIN[w.terrain[i] as Terrain];
  if (!(mc === "hover" ? info.hover : info.ground)) return false;
  return w.occupancy[i] === 0;
}

/** Ground-passability of a tile for tracked/wheeled units (air ignores this). */
export function groundPassable(w: World, tx: number, ty: number): boolean {
  return passable(w, tx, ty, "ground");
}

/** Speed multiplier for a movement class on the tile under (x, y). */
export function terrainSpeed(w: World, x: number, y: number, mc: MoveClass): number {
  if (mc === "air") return 1;
  const info = TERRAIN[terrainAt(w, Math.floor(x), Math.floor(y))];
  return (mc === "hover" ? info.hoverSpeed : info.speed) || 1;
}

export function spawnUnit(
  w: World,
  kind: UnitKind,
  faction: Faction,
  x: number,
  y: number
): Unit {
  const unit: Unit = {
    id: w.nextId++,
    kind,
    faction,
    x,
    y,
    hp: UNITS[kind].hp,
    facing: faction === "blue" ? 0 : Math.PI,
    aim: faction === "blue" ? 0 : Math.PI,
    order: { type: "idle" },
    path: null,
    pathGoal: null,
    cargo: 0,
    cooldown: 0,
    autoTargetId: null,
    damagedTick: -1000,
    lastAttackerId: null,
    firedTick: -1000,
    xp: 0,
    rank: 0,
    kills: 0
  };
  w.units.set(unit.id, unit);
  return unit;
}

export function spawnBuilding(
  w: World,
  kind: BuildingKind,
  faction: Faction,
  tx: number,
  ty: number
): Building {
  const building: Building = {
    id: w.nextId++,
    kind,
    faction,
    tx,
    ty,
    hp: BUILDINGS[kind].hp,
    queue: [],
    rally: null,
    facing: faction === "blue" ? 0 : Math.PI,
    cooldown: 0,
    damagedTick: -1000,
    lastAttackerId: null,
    firedTick: -1000
  };
  w.buildings.set(building.id, building);
  stampOccupancy(w, building, building.id);
  return building;
}

/** Remove a building and free its footprint. */
export function removeBuilding(w: World, b: Building): void {
  w.buildings.delete(b.id);
  stampOccupancy(w, b, 0);
  // footprint freed: ground paths through here may open up
  for (const u of w.units.values()) u.path = null;
}

function stampOccupancy(w: World, b: Building, id: number): void {
  const size = BUILDINGS[b.kind].size;
  for (let dy = 0; dy < size; dy++)
    for (let dx = 0; dx < size; dx++)
      if (inBounds(w, b.tx + dx, b.ty + dy)) w.occupancy[tileIndex(w, b.tx + dx, b.ty + dy)] = id;
}

export function buildingCenter(b: Building): { x: number; y: number } {
  const size = BUILDINGS[b.kind].size;
  return { x: b.tx + size / 2, y: b.ty + size / 2 };
}

export const dist = (ax: number, ay: number, bx: number, by: number): number =>
  Math.hypot(bx - ax, by - ay);

/** Distance from a point to a building's footprint (0 if inside). */
export function distToBuilding(b: Building, x: number, y: number): number {
  const size = BUILDINGS[b.kind].size;
  const dx = Math.max(b.tx - x, 0, x - (b.tx + size));
  const dy = Math.max(b.ty - y, 0, y - (b.ty + size));
  return Math.hypot(dx, dy);
}

export function hqOf(w: World, faction: Faction): Building | null {
  for (const b of w.buildings.values())
    if (b.kind === "hq" && b.faction === faction) return b;
  return null;
}

/** Nearest friendly scrap drop-off (HQ or depot) to a point. */
export function nearestDropOff(w: World, faction: Faction, x: number, y: number): Building | null {
  let best: Building | null = null;
  let bestD = Infinity;
  for (const b of w.buildings.values()) {
    if (b.faction !== faction || !BUILDINGS[b.kind].dropOff) continue;
    const d = distToBuilding(b, x, y);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

/** Does the faction own at least one building of this kind? */
export function hasBuilding(w: World, faction: Faction, kind: BuildingKind): boolean {
  for (const b of w.buildings.values()) if (b.faction === faction && b.kind === kind) return true;
  return false;
}
