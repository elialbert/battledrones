export type Faction = "blue" | "red";
export type Domain = "ground" | "air";
export type TargetDomain = "ground" | "air" | "both" | "none";

export type UnitKind =
  | "harvester"
  | "scout"
  | "stinger"
  | "flak-crawler"
  | "mortar"
  | "titan"
  | "lancer"
  | "wasp"
  | "raptor"
  | "hornet"
  | "mender";

export type BuildingKind =
  | "hq"
  | "fab-plant"
  | "airpad"
  | "tech-lab"
  | "depot"
  | "turret"
  | "sam-site"
  | "radar";

/** Armor classes: weapons deal a damage-type-specific multiple vs each. */
export type ArmorClass = "light" | "medium" | "heavy" | "structure";

/** Damage types, each with a multiplier row in `DAMAGE_VS` (balance.ts). */
export type DamageType = "kinetic" | "cannon" | "flak" | "missile" | "explosive" | "laser";

/** How a weapon looks when it fires (render-only hint carried on fx). */
export type WeaponFx =
  | "cannon"
  | "heavy-cannon"
  | "flak"
  | "rockets"
  | "missile"
  | "laser"
  | "shell"
  | "bomb"
  | "mg";

export const enum Terrain {
  Ground = 0,
  Rock = 1,
  Scrap = 2,
  /** Deep water (or lava): blocks tracked/wheeled units; hover and air cross. */
  Water = 3,
  /** Paved road: faster ground movement. */
  Road = 4,
  /** Mud, scree, slush: slow for wheels/tracks, hover glides over. */
  Rough = 5,
  /** Woods: slow for everyone on the ground, and cover (less damage taken). */
  Forest = 6,
  /** Rich crystal field: harvests into more scrap per load. */
  Crystal = 7,
  /** Bridge deck over water: a road that can't be built on. */
  Bridge = 8,
  /** Shallow ford: slow for ground units, open to hover. */
  Shallows = 9
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
  /** Hull facing angle in radians, 0 = North (up), clockwise. */
  facing: number;
  /** Weapon aim angle (turrets track this independently of the hull). */
  aim: number;
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
  /** Tick this unit last took damage (drives harvester flee behaviour). */
  damagedTick: number;
  /** Who last hurt us (unit or building id) — idle units retaliate. */
  lastAttackerId: number | null;
  /** Tick this unit last fired (renderer: recoil, turret settle). */
  firedTick: number;
  /** Combat experience: scrap value of enemies destroyed. */
  xp: number;
  /** Veterancy rank 0–3 (derived from xp); boosts damage. */
  rank: number;
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
  damagedTick: number;
  lastAttackerId: number | null;
  firedTick: number;
}

/** A building being constructed C&C-style (timer in the "sidebar"). */
export interface PendingBuilding {
  kind: BuildingKind;
  remaining: number;
  ready: boolean;
}

export interface FactionStats {
  unitsBuilt: number;
  unitsLost: number;
  unitsKilled: number;
  buildingsLost: number;
  scrapHarvested: number;
}

export interface FactionState {
  scrap: number;
  /** At most one building under construction at a time (C&C rule). */
  pending: PendingBuilding | null;
  stats: FactionStats;
  /** Multiplier on harvested scrap (AI difficulty handicap/bonus). */
  incomeMult: number;
}

/** A simulated slow projectile (artillery shell, bomb): dodgeable. */
export interface Projectile {
  id: number;
  faction: Faction;
  fx: WeaponFx;
  /** Launch point, current point, and ground impact point (tiles). */
  sx: number;
  sy: number;
  x: number;
  y: number;
  tx: number;
  ty: number;
  /** Tiles per tick. */
  speed: number;
  damage: number;
  splash: number;
  dmgType: DamageType;
  targets: TargetDomain;
  sourceId: number;
  /** Launched from the air (bombs fall rather than arc). */
  fromAir: boolean;
}

export type FxEvent =
  | {
      type: "shot";
      fx: WeaponFx;
      x: number;
      y: number;
      tx: number;
      ty: number;
      /** Shooter / target are airborne (for render altitude). */
      fromAir: boolean;
      air: boolean;
      sourceId: number;
    }
  | { type: "explosion"; x: number; y: number; size: number; air: boolean; kind: "unit" | "building" | "impact" }
  | { type: "heal"; x: number; y: number; tx: number; ty: number; sourceId: number; targetId: number }
  | { type: "built"; faction: Faction; id: number }
  | { type: "sold"; id: number }
  | { type: "hit"; faction: Faction; x: number; y: number; building: boolean }
  | { type: "rankUp"; id: number };

import type { FactionFog } from "./fog";

export type Biome = "temperate" | "desert" | "arctic" | "volcanic";

export interface World {
  tick: number;
  width: number;
  height: number;
  terrain: Uint8Array;
  /** Scrap remaining per tile (only meaningful on scrap/crystal tiles). */
  scrap: Uint16Array;
  /** Building id occupying each tile (0 = none) — O(1) footprint lookups. */
  occupancy: Int32Array;
  nextId: number;
  units: Map<number, Unit>;
  buildings: Map<number, Building>;
  projectiles: Projectile[];
  factions: Record<Faction, FactionState>;
  /** null while the match runs; the winning faction once an HQ dies. */
  winner: Faction | null;
  /** Transient render events emitted this tick (cleared each step). */
  fx: FxEvent[];
  fog: Record<Faction, FactionFog>;
  /** Map metadata for the renderer. */
  mapId: string;
  biome: Biome;
}

export type Command =
  | { type: "move"; faction: Faction; unitIds: number[]; x: number; y: number }
  | { type: "attackMove"; faction: Faction; unitIds: number[]; x: number; y: number }
  | { type: "attack"; faction: Faction; unitIds: number[]; targetId: number }
  | { type: "harvest"; faction: Faction; unitIds: number[]; x: number; y: number }
  | { type: "stop"; faction: Faction; unitIds: number[] }
  | { type: "produce"; faction: Faction; buildingId: number; unit: UnitKind }
  | { type: "cancelProduce"; faction: Faction; buildingId: number; unit: UnitKind }
  | { type: "startBuilding"; faction: Faction; building: BuildingKind }
  | { type: "cancelBuilding"; faction: Faction }
  | { type: "placeBuilding"; faction: Faction; tx: number; ty: number }
  | { type: "sell"; faction: Faction; buildingId: number }
  | { type: "rally"; faction: Faction; buildingId: number; x: number; y: number };
