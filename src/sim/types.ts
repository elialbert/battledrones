export type Faction = "blue" | "red";
export type Domain = "ground" | "air";
export type TargetDomain = "ground" | "air" | "both" | "none";

export type UnitKind =
  | "harvester"
  | "scout"
  | "stinger"
  | "flak-crawler"
  | "wasp"
  | "raptor";

export type BuildingKind = "hq" | "fab-plant" | "airpad" | "turret";

export const enum Terrain {
  Ground = 0,
  Rock = 1,
  Scrap = 2
}

/** Harvester internal cycle state. */
export type HarvestPhase = "toField" | "harvesting" | "toBase" | "unloading";

export type UnitOrder =
  | { type: "idle" }
  | { type: "move"; x: number; y: number }
  | { type: "attackMove"; x: number; y: number }
  | { type: "attack"; targetId: number }
  | { type: "harvest"; fieldX: number; fieldY: number; phase: HarvestPhase };

export interface Unit {
  id: number;
  kind: UnitKind;
  faction: Faction;
  /** Position in tile units (floats); the unit's centre. */
  x: number;
  y: number;
  hp: number;
  /** Facing angle in radians, 0 = North (up), clockwise. */
  facing: number;
  order: UnitOrder;
  /** Remaining path waypoints in tile coords (ground units). */
  path: { x: number; y: number }[] | null;
  /** Destination the current path was computed for (invalidation check). */
  pathGoal: { x: number; y: number } | null;
  /** Scrap carried (harvesters). */
  cargo: number;
  /** Ticks until this unit may fire again. */
  cooldown: number;
  /** Current auto-acquired target while attack-moving/idling. */
  autoTargetId: number | null;
}

export interface QueueItem {
  kind: UnitKind;
  /** Ticks of build time remaining. */
  remaining: number;
}

export interface Building {
  id: number;
  kind: BuildingKind;
  faction: Faction;
  /** Top-left tile of the footprint. */
  tx: number;
  ty: number;
  hp: number;
  queue: QueueItem[];
  rally: { x: number; y: number } | null;
  /** Turret head facing, radians clockwise from North. */
  facing: number;
  cooldown: number;
}

/** A building being constructed C&C-style (timer in the "sidebar"). */
export interface PendingBuilding {
  kind: BuildingKind;
  remaining: number;
  ready: boolean;
}

export interface FactionState {
  scrap: number;
  /** At most one building under construction at a time (C&C rule). */
  pending: PendingBuilding | null;
}

export interface FxEvent {
  type: "shot" | "explosion";
  x: number;
  y: number;
  /** For shots: where the bolt lands. */
  tx?: number;
  ty?: number;
  air?: boolean;
}

import type { FactionFog } from "./fog";

export interface World {
  tick: number;
  width: number;
  height: number;
  terrain: Uint8Array;
  /** Scrap remaining per tile (only meaningful on Terrain.Scrap tiles). */
  scrap: Uint16Array;
  nextId: number;
  units: Map<number, Unit>;
  buildings: Map<number, Building>;
  factions: Record<Faction, FactionState>;
  /** null while the match runs; the winning faction once an HQ dies. */
  winner: Faction | null;
  /** Transient render events emitted this tick (cleared each step). */
  fx: FxEvent[];
  fog: Record<Faction, FactionFog>;
}

export type Command =
  | { type: "move"; faction: Faction; unitIds: number[]; x: number; y: number }
  | { type: "attackMove"; faction: Faction; unitIds: number[]; x: number; y: number }
  | { type: "attack"; faction: Faction; unitIds: number[]; targetId: number }
  | { type: "harvest"; faction: Faction; unitIds: number[]; x: number; y: number }
  | { type: "stop"; faction: Faction; unitIds: number[] }
  | { type: "produce"; faction: Faction; buildingId: number; unit: UnitKind }
  | { type: "startBuilding"; faction: Faction; building: BuildingKind }
  | { type: "cancelBuilding"; faction: Faction }
  | { type: "placeBuilding"; faction: Faction; tx: number; ty: number }
  | { type: "rally"; faction: Faction; buildingId: number; x: number; y: number };
