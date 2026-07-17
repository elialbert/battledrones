import type { BuildingKind, Domain, TargetDomain, UnitKind } from "./types";

/**
 * Every tunable number in the game lives here.
 * Distances are in tiles, speeds in tiles/second, times in seconds,
 * damage in HP/second — the sim converts to per-tick internally.
 */
export const TICK_RATE = 10;
export const TICKS_PER_SEC = TICK_RATE;

export interface UnitStats {
  cost: number;
  hp: number;
  speed: number;
  sight: number;
  domain: Domain;
  targets: TargetDomain;
  dps: number;
  range: number;
  buildTime: number;
  builtAt: BuildingKind;
}

export interface BuildingStats {
  cost: number;
  hp: number;
  sight: number;
  /** Square footprint edge, in tiles. */
  size: number;
  buildTime: number;
  targets: TargetDomain;
  dps: number;
  range: number;
}

export const UNITS: Record<UnitKind, UnitStats> = {
  harvester: {
    cost: 150, hp: 220, speed: 1.6, sight: 4,
    domain: "ground", targets: "none", dps: 0, range: 0,
    buildTime: 8, builtAt: "hq"
  },
  scout: {
    cost: 100, hp: 60, speed: 4.4, sight: 8,
    domain: "air", targets: "none", dps: 0, range: 0,
    buildTime: 5, builtAt: "airpad"
  },
  stinger: {
    cost: 150, hp: 150, speed: 2.0, sight: 5,
    domain: "ground", targets: "ground", dps: 22, range: 3,
    buildTime: 7, builtAt: "fab-plant"
  },
  "flak-crawler": {
    cost: 200, hp: 170, speed: 1.6, sight: 5,
    domain: "ground", targets: "air", dps: 34, range: 4.5,
    buildTime: 8, builtAt: "fab-plant"
  },
  wasp: {
    cost: 200, hp: 100, speed: 3.4, sight: 5,
    domain: "air", targets: "ground", dps: 28, range: 2.5,
    buildTime: 8, builtAt: "airpad"
  },
  raptor: {
    cost: 250, hp: 130, speed: 3.8, sight: 6,
    domain: "air", targets: "air", dps: 32, range: 3.5,
    buildTime: 9, builtAt: "airpad"
  }
};

export const BUILDINGS: Record<BuildingKind, BuildingStats> = {
  hq: {
    cost: 0, hp: 1600, sight: 6, size: 3, buildTime: 0,
    targets: "none", dps: 0, range: 0
  },
  "fab-plant": {
    cost: 300, hp: 650, sight: 3, size: 2, buildTime: 10,
    targets: "none", dps: 0, range: 0
  },
  airpad: {
    cost: 400, hp: 550, sight: 3, size: 2, buildTime: 12,
    targets: "none", dps: 0, range: 0
  },
  turret: {
    cost: 250, hp: 420, sight: 5, size: 1, buildTime: 8,
    targets: "both", dps: 26, range: 4
  }
};

export const ECONOMY = {
  startingScrap: 500,
  /** Scrap a harvester can carry per trip. */
  harvesterCapacity: 100,
  /** Scrap mined per second while sitting on a field. */
  harvestRate: 34,
  /** Scrap transferred per second while unloading at the HQ. */
  unloadRate: 200,
  /** Scrap in a fresh scrap-field tile. */
  scrapPerTile: 1500,
  /** New buildings must be placed within this range of a friendly building. */
  buildRadius: 6
};

export const COMBAT = {
  /** Seconds between shots (cooldown); damage per shot = dps * this. */
  shotInterval: 0.5,
  /** Auto-acquire radius = weapon range + this bonus. */
  acquireBonus: 1.5
};

export const FOG = {
  /** Visibility recompute cadence, in ticks (10Hz / 4 ≈ 2.5Hz–4Hz zone). */
  intervalTicks: 3
};
