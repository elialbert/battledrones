import { BUILDINGS, ECONOMY, UNITS } from "./balance";
import { createFog } from "./fog";
import {
  Terrain,
  type Building,
  type BuildingKind,
  type Faction,
  type Unit,
  type UnitKind,
  type World
} from "./types";

export function createWorld(width: number, height: number): World {
  return {
    tick: 0,
    width,
    height,
    terrain: new Uint8Array(width * height),
    scrap: new Uint16Array(width * height),
    nextId: 1,
    units: new Map(),
    buildings: new Map(),
    factions: {
      blue: { scrap: ECONOMY.startingScrap, pending: null },
      red: { scrap: ECONOMY.startingScrap, pending: null }
    },
    winner: null,
    fx: [],
    fog: createFog(width, height)
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
  w.terrain[tileIndex(w, tx, ty)] = t;
  if (t === Terrain.Scrap) w.scrap[tileIndex(w, tx, ty)] = ECONOMY.scrapPerTile;
}

/** Tiles occupied by any building footprint, for pathing/placement. */
export function buildingAtTile(w: World, tx: number, ty: number): Building | null {
  for (const b of w.buildings.values()) {
    const size = BUILDINGS[b.kind].size;
    if (tx >= b.tx && tx < b.tx + size && ty >= b.ty && ty < b.ty + size) return b;
  }
  return null;
}

/** Ground-passability of a tile (air ignores this). */
export function groundPassable(w: World, tx: number, ty: number): boolean {
  if (!inBounds(w, tx, ty)) return false;
  if (terrainAt(w, tx, ty) === Terrain.Rock) return false;
  return buildingAtTile(w, tx, ty) === null;
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
    facing: 0,
    order: { type: "idle" },
    path: null,
    pathGoal: null,
    cargo: 0,
    cooldown: 0,
    autoTargetId: null
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
    facing: 0,
    cooldown: 0
  };
  w.buildings.set(building.id, building);
  return building;
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
