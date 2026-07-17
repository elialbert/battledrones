import { BUILDINGS, ECONOMY, TICK_RATE, UNITS } from "./balance";
import { moveUnitToward } from "./movement";
import {
  Terrain,
  type Building,
  type Command,
  type Faction,
  type Unit,
  type UnitKind,
  type World
} from "./types";
import {
  buildingAtTile,
  distToBuilding,
  groundPassable,
  hqOf,
  inBounds,
  spawnBuilding,
  spawnUnit,
  terrainAt,
  tileIndex
} from "./world";

// ------------------------------------------------------------- commands ----

export function startBuilding(w: World, faction: Faction, kind: Exclude<typeof BUILDINGS extends Record<infer K, unknown> ? K : never, never>): void {
  const f = w.factions[faction];
  const stats = BUILDINGS[kind];
  if (f.pending || kind === "hq") return;
  if (f.scrap < stats.cost) return;
  f.scrap -= stats.cost;
  f.pending = { kind, remaining: stats.buildTime * TICK_RATE, ready: false };
}

export function cancelBuilding(w: World, faction: Faction): void {
  const f = w.factions[faction];
  if (!f.pending) return;
  f.scrap += BUILDINGS[f.pending.kind].cost;
  f.pending = null;
}

export function canPlaceBuilding(
  w: World,
  faction: Faction,
  kind: keyof typeof BUILDINGS,
  tx: number,
  ty: number
): boolean {
  const size = BUILDINGS[kind].size;
  for (let dy = 0; dy < size; dy++)
    for (let dx = 0; dx < size; dx++) {
      const x = tx + dx;
      const y = ty + dy;
      if (!inBounds(w, x, y)) return false;
      if (terrainAt(w, x, y) !== Terrain.Ground) return false;
      if (buildingAtTile(w, x, y)) return false;
    }
  // no ground unit parked inside the footprint
  for (const u of w.units.values())
    if (
      UNITS[u.kind].domain === "ground" &&
      u.x >= tx && u.x < tx + size &&
      u.y >= ty && u.y < ty + size
    )
      return false;
  // within build radius of a friendly building
  const cx = tx + size / 2;
  const cy = ty + size / 2;
  for (const b of w.buildings.values())
    if (b.faction === faction && distToBuilding(b, cx, cy) <= ECONOMY.buildRadius)
      return true;
  return false;
}

export function placeBuilding(w: World, faction: Faction, tx: number, ty: number): void {
  const f = w.factions[faction];
  if (!f.pending || !f.pending.ready) return;
  if (!canPlaceBuilding(w, faction, f.pending.kind, tx, ty)) return;
  spawnBuilding(w, f.pending.kind, faction, tx, ty);
  f.pending = null;
  // parked ground paths may now be stale; force replans
  for (const u of w.units.values()) u.path = null;
}

export function produceUnit(w: World, faction: Faction, buildingId: number, kind: UnitKind): void {
  const b = w.buildings.get(buildingId);
  const f = w.factions[faction];
  const stats = UNITS[kind];
  if (!b || b.faction !== faction || stats.builtAt !== b.kind) return;
  if (f.scrap < stats.cost) return;
  f.scrap -= stats.cost;
  b.queue.push({ kind, remaining: stats.buildTime * TICK_RATE });
}

export function setRally(w: World, faction: Faction, buildingId: number, x: number, y: number): void {
  const b = w.buildings.get(buildingId);
  if (!b || b.faction !== faction) return;
  b.rally = { x, y };
}

// ---------------------------------------------------------------- ticks ----

export function tickConstruction(w: World): void {
  for (const f of Object.values(w.factions)) {
    if (!f.pending || f.pending.ready) continue;
    if (--f.pending.remaining <= 0) f.pending.ready = true;
  }
}

export function tickProduction(w: World): void {
  for (const b of w.buildings.values()) {
    const head = b.queue[0];
    if (!head) continue;
    if (--head.remaining > 0) continue;
    b.queue.shift();
    const spot = findSpawnSpot(w, b, UNITS[head.kind].domain === "air");
    const u = spawnUnit(w, head.kind, b.faction, spot.x, spot.y);
    applyRally(w, u, b);
  }
}

function findSpawnSpot(w: World, b: Building, air: boolean): { x: number; y: number } {
  const size = BUILDINGS[b.kind].size;
  for (let r = 1; r <= 4; r++)
    for (let dy = -r; dy <= size + r - 1; dy++)
      for (let dx = -r; dx <= size + r - 1; dx++) {
        if (Math.max(dx < 0 ? -dx : dx - size + 1, dy < 0 ? -dy : dy - size + 1) !== r) continue;
        const tx = b.tx + dx;
        const ty = b.ty + dy;
        if (!inBounds(w, tx, ty)) continue;
        if (air || groundPassable(w, tx, ty)) return { x: tx + 0.5, y: ty + 0.5 };
      }
  return { x: b.tx + size / 2, y: b.ty - 1 };
}

function applyRally(w: World, u: Unit, b: Building): void {
  if (!b.rally) return;
  const { x, y } = b.rally;
  if (u.kind === "harvester" && terrainAt(w, Math.floor(x), Math.floor(y)) === Terrain.Scrap) {
    u.order = { type: "harvest", fieldX: Math.floor(x), fieldY: Math.floor(y), phase: "toField" };
  } else {
    u.order = { type: "attackMove", x, y };
  }
}

// -------------------------------------------------------------- harvest ----

/** Find the closest scrap tile with scrap remaining, or null if mined out. */
export function nearestScrapTile(w: World, x: number, y: number): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (let ty = 0; ty < w.height; ty++)
    for (let tx = 0; tx < w.width; tx++) {
      const i = tileIndex(w, tx, ty);
      if (w.terrain[i] !== Terrain.Scrap || w.scrap[i]! <= 0) continue;
      const d = Math.hypot(tx + 0.5 - x, ty + 0.5 - y);
      if (d < bestD) {
        bestD = d;
        best = { x: tx, y: ty };
      }
    }
  return best;
}

export function tickHarvest(w: World): void {
  for (const u of w.units.values()) {
    if (u.order.type !== "harvest") continue;
    const o = u.order;
    const perTick = (rate: number) => rate / TICK_RATE;

    if (o.phase === "toField") {
      const i = tileIndex(w, o.fieldX, o.fieldY);
      if (w.terrain[i] !== Terrain.Scrap || w.scrap[i]! <= 0) {
        const next = nearestScrapTile(w, u.x, u.y);
        if (!next) {
          u.order = { type: "idle" };
          continue;
        }
        o.fieldX = next.x;
        o.fieldY = next.y;
      }
      if (moveUnitToward(w, u, o.fieldX + 0.5, o.fieldY + 0.5)) o.phase = "harvesting";
    } else if (o.phase === "harvesting") {
      const i = tileIndex(w, o.fieldX, o.fieldY);
      const available = w.scrap[i]!;
      if (available <= 0) {
        o.phase = "toField";
        continue;
      }
      const mined = Math.min(perTick(ECONOMY.harvestRate), available, ECONOMY.harvesterCapacity - u.cargo);
      u.cargo += mined;
      w.scrap[i] = Math.max(0, available - mined);
      if (u.cargo >= ECONOMY.harvesterCapacity - 1e-6) {
        u.cargo = ECONOMY.harvesterCapacity;
        o.phase = "toBase";
      }
    } else if (o.phase === "toBase") {
      const hq = hqOf(w, u.faction);
      if (!hq) {
        u.order = { type: "idle" };
        continue;
      }
      const size = BUILDINGS.hq.size;
      const doorX = hq.tx + size / 2;
      const doorY = hq.ty + size + 0.5; // south side
      if (moveUnitToward(w, u, doorX, doorY) || distToBuilding(hq, u.x, u.y) < 1.2)
        o.phase = "unloading";
    } else {
      // unloading
      const transfer = Math.min(perTick(ECONOMY.unloadRate), u.cargo);
      u.cargo -= transfer;
      w.factions[u.faction].scrap += transfer;
      if (u.cargo <= 1e-6) {
        u.cargo = 0;
        o.phase = "toField";
      }
    }
  }
}

export function applyEconomyCommand(w: World, c: Command): void {
  switch (c.type) {
    case "startBuilding":
      startBuilding(w, c.faction, c.building);
      break;
    case "cancelBuilding":
      cancelBuilding(w, c.faction);
      break;
    case "placeBuilding":
      placeBuilding(w, c.faction, c.tx, c.ty);
      break;
    case "produce":
      produceUnit(w, c.faction, c.buildingId, c.unit);
      break;
    case "rally":
      setRally(w, c.faction, c.buildingId, c.x, c.y);
      break;
  }
}
