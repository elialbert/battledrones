import {
  Terrain,
  type ArmorClass,
  type BuildingKind,
  type DamageType,
  type Domain,
  type TargetDomain,
  type UnitKind,
  type WeaponFx
} from "./types";

/**
 * Every tunable number in the game lives here.
 * Distances are in tiles, speeds in tiles/second, times in seconds,
 * damage in HP/second — the sim converts to per-tick internally.
 */
export const TICK_RATE = 10;
export const TICKS_PER_SEC = TICK_RATE;

/** Weapon/armor fields shared by units and armed buildings. */
export interface ArmedStats {
  targets: TargetDomain;
  /** Sustained damage per second against a 1.0× armor match. */
  dps: number;
  range: number;
  /** Seconds between shots (damage per shot = dps × shotInterval). */
  shotInterval?: number;
  /** Can't fire at targets closer than this (artillery). */
  minRange?: number;
  /** Splash radius in tiles (full damage at centre, half at the edge). */
  splash?: number;
  /** If set, shots are simulated projectiles at this speed (tiles/s). */
  projectileSpeed?: number;
  dmgType?: DamageType;
  fx?: WeaponFx;
  /** Damage multiplier against aircraft (generalist weapons are weaker vs air). */
  airMult?: number;
}

export interface UnitStats extends ArmedStats {
  name: string;
  /** One-line role summary for the build-bar tooltip. */
  role: string;
  cost: number;
  hp: number;
  speed: number;
  sight: number;
  domain: Domain;
  armor: ArmorClass;
  /** Hovers: crosses water, ignores rough ground (still a ground target). */
  hover?: boolean;
  /** Repair beam: HP/second restored to one damaged friendly in range. */
  heal?: number;
  buildTime: number;
  builtAt: BuildingKind;
  /** Extra building that must exist before this unit can be produced. */
  requires?: BuildingKind;
  /** Rendered with a separately rotating turret. */
  turret?: boolean;
  /** Collision/visual radius in tiles. */
  radius: number;
}

export interface BuildingStats extends ArmedStats {
  name: string;
  role: string;
  cost: number;
  hp: number;
  sight: number;
  /** Square footprint edge, in tiles. */
  size: number;
  buildTime: number;
  /** Any one of these must already stand before construction can start. */
  requires?: BuildingKind[];
  /** Harvesters may unload scrap here. */
  dropOff?: boolean;
}

/**
 * Combat units carry 1.5× their original HP (Hornets 1.3×, so Flak still
 * answers them; Harvesters and Scouts unchanged): half an army now takes
 * ~7–9 s to die instead of 5–7, long enough to react on a phone.
 */
export const UNITS: Record<UnitKind, UnitStats> = {
  harvester: {
    name: "Harvester", role: "Mines scrap and crystal. Keep it safe.",
    cost: 150, hp: 250, speed: 1.6, sight: 4, domain: "ground", armor: "medium",
    targets: "none", dps: 0, range: 0,
    buildTime: 10, builtAt: "hq", radius: 0.45
  },
  scout: {
    name: "Scout", role: "Fast flying eyes. Unarmed.",
    cost: 75, hp: 60, speed: 4.8, sight: 9, domain: "air", armor: "light",
    targets: "none", dps: 0, range: 0,
    buildTime: 4, builtAt: "airpad", radius: 0.3
  },
  stinger: {
    name: "Stinger", role: "Fast light tank. Beats Flak and Mortars. Can't hit air.",
    cost: 150, hp: 255, speed: 2.3, sight: 5, domain: "ground", armor: "medium",
    targets: "ground", dps: 22, range: 3.2, shotInterval: 0.6, dmgType: "kinetic", fx: "cannon",
    buildTime: 7, builtAt: "fab-plant", turret: true, radius: 0.38
  },
  "flak-crawler": {
    name: "Flak Crawler", role: "Anti-air. Shreds drones. Helpless vs ground.",
    cost: 190, hp: 285, speed: 1.9, sight: 6, domain: "ground", armor: "medium",
    targets: "air", dps: 31, range: 5, shotInterval: 0.3, dmgType: "flak", fx: "flak",
    buildTime: 8, builtAt: "fab-plant", turret: true, radius: 0.4
  },
  mortar: {
    name: "Mortar", role: "Long-range splash artillery. Razes bases. Fragile up close.",
    cost: 275, hp: 195, speed: 1.5, sight: 6, domain: "ground", armor: "light",
    targets: "ground", dps: 18, range: 8, minRange: 2.5, shotInterval: 3,
    splash: 1.1, projectileSpeed: 5.5, dmgType: "explosive", fx: "shell",
    buildTime: 10, builtAt: "fab-plant", requires: "tech-lab", turret: true, radius: 0.42
  },
  titan: {
    name: "Titan", role: "Super-heavy tank. Crushes light armies. Can't hit air.",
    cost: 475, hp: 1050, speed: 1.2, sight: 6, domain: "ground", armor: "heavy",
    targets: "ground", dps: 46, range: 4, shotInterval: 1.2, dmgType: "cannon", fx: "heavy-cannon",
    buildTime: 15, builtAt: "fab-plant", requires: "tech-lab", turret: true, radius: 0.55
  },
  lancer: {
    name: "Lancer", role: "Hover laser tank. Burns through armour, hits air too. Crosses water.",
    cost: 275, hp: 405, speed: 2.5, sight: 6, domain: "ground", armor: "medium",
    hover: true,
    targets: "both", dps: 28, range: 4.5, shotInterval: 0.8, dmgType: "laser", fx: "laser", airMult: 0.65,
    buildTime: 11, builtAt: "fab-plant", requires: "tech-lab", turret: true, radius: 0.42
  },
  wasp: {
    name: "Wasp", role: "Strike drone. Rockets ground targets. Dies to Flak.",
    cost: 200, hp: 205, speed: 3.6, sight: 6, domain: "air", armor: "light",
    targets: "ground", dps: 28, range: 3, shotInterval: 1, dmgType: "missile", fx: "rockets",
    buildTime: 8, builtAt: "airpad", radius: 0.35
  },
  raptor: {
    name: "Raptor", role: "Interceptor. Hunts air units. Can't hit ground.",
    cost: 250, hp: 265, speed: 4.1, sight: 7, domain: "air", armor: "medium",
    targets: "air", dps: 32, range: 4, shotInterval: 0.8, dmgType: "missile", fx: "missile",
    buildTime: 9, builtAt: "airpad", radius: 0.38
  },
  hornet: {
    name: "Hornet", role: "Heavy bomber. Carpet-bombs ground and bases. Needs escort.",
    cost: 375, hp: 505, speed: 2.1, sight: 6, domain: "air", armor: "heavy",
    targets: "ground", dps: 36, range: 1.6, shotInterval: 2, splash: 1.1,
    projectileSpeed: 5, dmgType: "explosive", fx: "bomb",
    buildTime: 14, builtAt: "airpad", requires: "tech-lab", radius: 0.5
  },
  mender: {
    name: "Mender", role: "Repair drone. Heals nearby units and buildings.",
    cost: 150, hp: 180, speed: 3.2, sight: 6, domain: "air", armor: "light",
    targets: "none", dps: 0, range: 3, heal: 10,
    buildTime: 7, builtAt: "airpad", radius: 0.32
  }
};

export const BUILDINGS: Record<BuildingKind, BuildingStats> = {
  hq: {
    name: "HQ", role: "Command centre. Builds Harvesters, takes scrap. Lose it, lose the game.",
    cost: 0, hp: 3200, sight: 7, size: 3, buildTime: 0, dropOff: true,
    // point defence: swats early drone raids, leaves ground assaults to real defences
    targets: "air", dps: 9, range: 4.5, shotInterval: 0.5, dmgType: "kinetic", fx: "mg"
  },
  "fab-plant": {
    name: "Fab Plant", role: "Builds ground vehicles.",
    cost: 300, hp: 1000, sight: 4, size: 2, buildTime: 10,
    targets: "none", dps: 0, range: 0
  },
  airpad: {
    name: "Airpad", role: "Builds flying drones.",
    cost: 350, hp: 850, sight: 4, size: 2, buildTime: 12,
    targets: "none", dps: 0, range: 0
  },
  "tech-lab": {
    name: "Tech Lab", role: "Unlocks Mortar, Titan, Lancer and Hornet.",
    cost: 450, hp: 800, sight: 4, size: 2, buildTime: 20, requires: ["fab-plant", "airpad"],
    targets: "none", dps: 0, range: 0
  },
  depot: {
    name: "Depot", role: "Forward scrap drop-off. Build it near distant fields.",
    cost: 250, hp: 800, sight: 4, size: 2, buildTime: 10, dropOff: true,
    targets: "none", dps: 0, range: 0
  },
  turret: {
    name: "Turret", role: "Autocannon defence. Hits ground and air.",
    cost: 225, hp: 650, sight: 6, size: 1, buildTime: 8,
    targets: "both", dps: 26, range: 4.5, shotInterval: 0.5, dmgType: "kinetic", fx: "cannon"
  },
  "sam-site": {
    name: "SAM Site", role: "Long-range anti-air missiles.",
    cost: 275, hp: 560, sight: 7, size: 1, buildTime: 9,
    targets: "air", dps: 32, range: 6.5, shotInterval: 1.2, dmgType: "missile", fx: "missile"
  },
  radar: {
    name: "Radar", role: "Reveals a wide area through the fog.",
    cost: 200, hp: 450, sight: 13, size: 1, buildTime: 8,
    targets: "none", dps: 0, range: 0
  }
};

/** Damage multiplier by damage type (row) vs armor class (column). */
export const DAMAGE_VS: Record<DamageType, Record<ArmorClass, number>> = {
  kinetic: { light: 1.0, medium: 1.0, heavy: 0.6, structure: 0.65 },
  cannon: { light: 0.8, medium: 1.0, heavy: 1.3, structure: 1.0 },
  flak: { light: 1.25, medium: 1.0, heavy: 1.15, structure: 0.5 },
  missile: { light: 1.15, medium: 1.0, heavy: 0.9, structure: 0.6 },
  explosive: { light: 1.2, medium: 0.9, heavy: 0.85, structure: 1.35 },
  laser: { light: 1.0, medium: 1.0, heavy: 1.55, structure: 0.8 }
};

export interface TerrainInfo {
  name: string;
  /** Tracked/wheeled units can enter. */
  ground: boolean;
  /** Hover units can enter. */
  hover: boolean;
  /** Speed multiplier for tracked/wheeled and hover units. */
  speed: number;
  hoverSpeed: number;
  /** Buildings may be placed here. */
  buildable: boolean;
  /** Damage multiplier for ground units standing here (cover). */
  cover: number;
}

export const TERRAIN: Record<Terrain, TerrainInfo> = {
  [Terrain.Ground]: { name: "Ground", ground: true, hover: true, speed: 1, hoverSpeed: 1, buildable: true, cover: 1 },
  [Terrain.Rock]: { name: "Rock", ground: false, hover: false, speed: 0, hoverSpeed: 0, buildable: false, cover: 1 },
  [Terrain.Scrap]: { name: "Scrap field", ground: true, hover: true, speed: 0.85, hoverSpeed: 1, buildable: false, cover: 1 },
  [Terrain.Water]: { name: "Water", ground: false, hover: true, speed: 0, hoverSpeed: 1, buildable: false, cover: 1 },
  [Terrain.Road]: { name: "Road", ground: true, hover: true, speed: 1.35, hoverSpeed: 1.15, buildable: true, cover: 1 },
  [Terrain.Rough]: { name: "Rough ground", ground: true, hover: true, speed: 0.6, hoverSpeed: 1, buildable: false, cover: 1 },
  [Terrain.Forest]: { name: "Woods", ground: true, hover: true, speed: 0.55, hoverSpeed: 0.6, buildable: false, cover: 0.7 },
  [Terrain.Crystal]: { name: "Crystal field", ground: true, hover: true, speed: 0.85, hoverSpeed: 1, buildable: false, cover: 1 },
  [Terrain.Bridge]: { name: "Bridge", ground: true, hover: true, speed: 1.35, hoverSpeed: 1.15, buildable: false, cover: 1 },
  [Terrain.Shallows]: { name: "Shallows", ground: true, hover: true, speed: 0.5, hoverSpeed: 1, buildable: false, cover: 1 }
};

export const ECONOMY = {
  startingScrap: 600,
  /** Scrap a harvester can carry per trip. */
  harvesterCapacity: 100,
  /** Scrap mined per second while sitting on a field. */
  harvestRate: 21,
  /** Scrap transferred per second while unloading at a drop-off. */
  unloadRate: 140,
  /** Scrap in a fresh scrap-field tile. */
  scrapPerTile: 1500,
  /** Raw crystal in a fresh crystal tile… */
  crystalPerTile: 1200,
  /** …and each unit of it mined is worth this much scrap in the hold. */
  crystalValue: 1.6,
  /** New buildings must be placed within this range of a friendly building. */
  buildRadius: 6,
  /** Fraction of cost refunded when selling a building. */
  sellRefund: 0.5,
  /** Scrap per second every HQ salvages on its own (keeps broke sides alive). */
  hqTrickle: 2,
  /** Max units queued per production building. */
  maxQueue: 6
};

export const COMBAT = {
  /** Default seconds between shots; damage per shot = dps * this. */
  shotInterval: 0.5,
  /** Auto-acquire radius = weapon range + this bonus. */
  acquireBonus: 1.5,
  /** Idle units retaliate against attackers up to this far away. */
  retaliateRange: 9,
  /** Idle allies this close to a victim join in its defence. */
  assistRadius: 5,
  /** XP (fraction of own cost in kills) needed for ranks 1, 2, 3. */
  rankXp: [1, 2.5, 5],
  /** Damage bonus per veterancy rank. */
  rankDamage: 0.15,
  /** HP/sec regenerated at rank 3 (fraction of max HP). */
  eliteRegen: 0.01
};

export const FOG = {
  /** Visibility recompute cadence, in ticks (10Hz / 4 ≈ 2.5Hz–4Hz zone). */
  intervalTicks: 3
};

/** Damage per shot for a weapon, before armor/veterancy. */
export const shotDamage = (s: ArmedStats): number =>
  s.dps * (s.shotInterval ?? COMBAT.shotInterval);

/**
 * Battlefield salvage (salvage.ts): a destroyed combat unit leaves a
 * burning wreck worth a share of its cost, scooped up by the first ground
 * unit of either side to drive over it. Fights leave loot worth holding.
 */
export const SALVAGE = {
  /** Wreck value as a share of the dead unit's cost (harvesters leave none). */
  share: 0.3,
  /** Seconds a wreck lies on the field before it burns out. */
  ttl: 60,
  /** Seconds a fresh wreck burns before it can be salvaged (not mid-brawl). */
  hot: 2.5,
  /** A ground unit whose centre comes this close (tiles) collects the wreck. */
  pickupRadius: 0.9,
  /** A death spot no tank could reach (water, rock, a building) shifts to a passable tile this close, else no wreck. */
  shiftRadius: 2,
  /** Most wrecks on the field at once; past that the oldest burns out. */
  maxWrecks: 60
};

/**
 * Commander calldowns (powers.ts). A Command meter per side (0–100) fills
 * slowly on its own and mostly from losses, and pays for three telegraphed,
 * map-targeted powers; the Sky Hammer is a separate late-game strike that
 * comes online for both sides at 6:00. Every telegraph is public (both
 * sides see it through the fog), so landing one and dodging one are both
 * skill moments. Damage stays modest and cooldowns long: burst powers fed
 * the snowball in the design panel's prototypes.
 */
export const POWERS = {
  meterMax: 100,
  /** Meter per second, always. */
  passive: 0.1,
  /** Meter per scrap of your own units and buildings destroyed (comeback-weighted). */
  perScrapLost: 0.02,
  /** Meter per scrap of enemy units and buildings you destroy. */
  perScrapKilled: 0.007,
  barrage: {
    cost: 60, cooldown: 45, telegraph: 2.5,
    /** Shells, the seconds between them, and their scatter (tiles) around the aim point. */
    shells: 3, shellGap: 0.3, scatter: 0.9,
    damage: 170, splash: 2,
    /** Reticle size: the area any shell can reach. */
    radius: 2.9
  },
  emp: {
    cost: 40, cooldown: 40, telegraph: 0.8,
    radius: 3,
    /** Seconds stunned units can't move or fire and buildings can't fire or produce. */
    stun: 4
  },
  droppod: {
    cost: 70, cooldown: 60, telegraph: 2,
    radius: 1.2,
    /** Light impact on enemy ground units right under the pod. */
    damage: 60,
    units: ["stinger", "stinger", "flak-crawler"] as UnitKind[],
    /** With a Tech Lab standing. */
    techUnits: ["lancer", "lancer", "flak-crawler"] as UnitKind[]
  },
  hammer: {
    /** Comes online for both sides at this match time (seconds), then recharges. */
    unlock: 6 * 60, cooldown: 120, telegraph: 3,
    radius: 2.5,
    /** Units: this × (1 − 0.5·d/r), any armour, ground or air. */
    unitDamage: 260,
    /** Buildings whose footprint is in the radius: flat (an HQ loses ~22%). */
    buildingDamage: 700
  }
};
