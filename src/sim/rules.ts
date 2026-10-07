import { COMBAT, ECONOMY, UNITS } from "./balance";
import type { Strategy } from "./ai/commander";
import type { BuildingKind, Faction, Unit, UnitKind, World } from "./types";

/**
 * Match rules and the mutators that change them. `World.rules` is absent
 * (or identity) in a classic match; every hook below reads through
 * `rulesOf(w)`, so a world without rules plays exactly as before.
 *
 * Mutators are picked on the menu (or by the Daily Op) and apply to BOTH
 * sides: the AI obeys them through the same blockers and multipliers.
 */

export type MutatorId = "blitz" | "goldrush" | "glass" | "rapidfab" | "airwar" | "veterans" | "clearskies";

export interface Rules {
  /** Scrap each side starts with. */
  startScrap: number;
  /**
   * Multiplier on harvested scrap and HQ trickle, on top of
   * `FactionState.incomeMult` (which the AI rewrites every tick).
   */
  incomeMult: number;
  /** Build progress per tick: 2 = units and buildings take half the time. */
  buildSpeed: number;
  /** Multiplier on every weapon's damage. */
  dmgMult: number;
  bannedUnits: UnitKind[];
  bannedBuildings: BuildingKind[];
  /** No fog of war for either side. */
  fogOff: boolean;
  /** Veterancy rank that produced combat units start at. */
  startRank: number;
  /** The mutators these rules came from, in canonical order (display, career). */
  mutators: MutatorId[];
  /** Ops: bans for one side only (e.g. "air only" for the player), on top of the shared ones. */
  sideBans?: Partial<Record<Faction, { units?: UnitKind[]; buildings?: BuildingKind[] }>>;
  /** Ops: per-side income multiplier on top of `incomeMult` (0 = a frozen economy). */
  sideIncome?: Partial<Record<Faction, number>>;
  /** What a ban no mutator explains says ("Disabled in this op"); default "Disabled: match rules". */
  banLabel?: string;
  /**
   * Ops: no commander calldowns for either side — for an op whose puzzle is
   * a fixed strike group or a fixed budget (a free Drop Pod would break it).
   */
  noCalldowns?: boolean;
}

export const DEFAULT_RULES: Readonly<Rules> = Object.freeze({
  startScrap: ECONOMY.startingScrap,
  incomeMult: 1,
  buildSpeed: 1,
  dmgMult: 1,
  bannedUnits: [],
  bannedBuildings: [],
  fogOff: false,
  startRank: 0,
  mutators: []
});

export interface MutatorDef {
  id: MutatorId;
  name: string;
  icon: string;
  /** One line for the menu sheet. */
  desc: string;
  apply(r: Rules): void;
  bansUnits?: UnitKind[];
  bansBuildings?: BuildingKind[];
  /** Mutators that make no sense together with this one. */
  conflicts?: MutatorId[];
}

export const GROUND_COMBAT: UnitKind[] = ["stinger", "flak-crawler", "mortar", "titan", "lancer"];

export const MUTATORS: Record<MutatorId, MutatorDef> = {
  blitz: {
    id: "blitz",
    name: "Blitz",
    icon: "⚡",
    desc: "Both sides start with 3,000 scrap",
    apply: (r) => (r.startScrap = 3000)
  },
  goldrush: {
    id: "goldrush",
    name: "Gold Rush",
    icon: "💰",
    desc: "Harvesting and HQ income ×1.5",
    apply: (r) => (r.incomeMult *= 1.5)
  },
  glass: {
    id: "glass",
    name: "Glass Cannons",
    icon: "💥",
    desc: "Every weapon deals double damage",
    apply: (r) => (r.dmgMult *= 2)
  },
  rapidfab: {
    id: "rapidfab",
    name: "Rapid Fab",
    icon: "🔧",
    desc: "Units and buildings build in half the time",
    apply: (r) => (r.buildSpeed *= 2)
  },
  airwar: {
    id: "airwar",
    name: "Air War",
    icon: "✈️",
    // SAM sites go too: measured, aircraft-only armies never crack a SAM line (every
    // AI-vs-AI Air War drew at 25:00); turrets and the HQ gun still shoot back
    desc: "No ground combat units, Fab Plants or SAM sites: dogfights decide it",
    bansUnits: GROUND_COMBAT,
    bansBuildings: ["fab-plant", "sam-site"],
    apply: (r) => {
      r.bannedUnits.push(...GROUND_COMBAT);
      r.bannedBuildings.push("fab-plant", "sam-site");
    }
  },
  veterans: {
    id: "veterans",
    name: "Veterans",
    icon: "🎖️",
    desc: "Combat units roll out at rank 1 (+15% damage)",
    apply: (r) => (r.startRank = Math.max(r.startRank, 1))
  },
  clearskies: {
    id: "clearskies",
    name: "Clear Skies",
    icon: "☀️",
    desc: "No fog of war: both sides see everything",
    apply: (r) => (r.fogOff = true)
  }
};

/** Canonical display order. */
export const MUTATOR_IDS = Object.keys(MUTATORS) as MutatorId[];

export const isMutatorId = (s: unknown): s is MutatorId => typeof s === "string" && s in MUTATORS;

/** Do these mutators all work together? */
export function mutatorsCompatible(ids: readonly MutatorId[]): boolean {
  for (const a of ids) for (const b of ids) if (a !== b && MUTATORS[a].conflicts?.includes(b)) return false;
  return true;
}

/** Rules for a set of mutators (deduplicated, unknown ids ignored). */
export function makeRules(ids: readonly MutatorId[]): Rules {
  const r: Rules = { ...DEFAULT_RULES, bannedUnits: [], bannedBuildings: [], mutators: [] };
  for (const id of MUTATOR_IDS)
    if (ids.includes(id)) {
      MUTATORS[id].apply(r);
      r.mutators.push(id);
    }
  return r;
}

/** Install a match's mutators (createMapWorld calls this before the first tick). */
export function applyMutators(w: World, ids: readonly MutatorId[]): void {
  const r = makeRules(ids.filter(isMutatorId));
  if (r.mutators.length === 0) return;
  w.rules = r;
  for (const f of Object.values(w.factions)) f.scrap = r.startScrap;
}

export const rulesOf = (w: World): Readonly<Rules> => w.rules ?? DEFAULT_RULES;

/** True when any mutator is active (career: no map stars). */
export const isMutated = (w: World): boolean => rulesOf(w).mutators.length > 0;

/** Total income multiplier for a faction: AI handicap × mutators (× an op's per-side factor). */
export const incomeOf = (w: World, f: Faction): number => {
  const r = rulesOf(w);
  return w.factions[f].incomeMult * r.incomeMult * (r.sideIncome?.[f] ?? 1);
};

/**
 * Why a kind is disabled by this match's rules (null = allowed): a mutator
 * for both sides, or (with `faction`) an op's ban on that side alone.
 */
export function bannedBy(w: World, kind: UnitKind | BuildingKind, faction?: Faction): string | null {
  const r = rulesOf(w);
  const isUnit = kind in UNITS;
  const inList = (units?: readonly UnitKind[], buildings?: readonly BuildingKind[]) =>
    isUnit ? !!units?.includes(kind as UnitKind) : !!buildings?.includes(kind as BuildingKind);
  const side = faction ? r.sideBans?.[faction] : undefined;
  if (!inList(r.bannedUnits, r.bannedBuildings) && !inList(side?.units, side?.buildings)) return null;
  const by = r.mutators.find((id) => inList(MUTATORS[id].bansUnits, MUTATORS[id].bansBuildings));
  return by ? `Disabled: ${MUTATORS[by].name}` : r.banLabel ?? "Disabled: match rules";
}

/** Veterans mutator: a freshly built combat unit starts ranked (with the XP to match). */
export function applySpawnRank(w: World, u: Unit): void {
  const rank = Math.min(COMBAT.rankXp.length, rulesOf(w).startRank);
  if (rank <= 0 || UNITS[u.kind].dps <= 0 || u.rank >= rank) return;
  u.rank = rank;
  u.xp = Math.max(u.xp, COMBAT.rankXp[rank - 1]! * UNITS[u.kind].cost);
}

/**
 * Can an AI personality play its plan under these rules? (An air-only
 * commander needs an Airpad; tank and ground-raid plans need the Fab Plant.)
 */
export function strategyFits(s: Strategy, r: Readonly<Rules>): boolean {
  if (s.airOnly && r.bannedBuildings.includes("airpad")) return false;
  if ((s.heavy || s.groundRaids) && r.bannedBuildings.includes("fab-plant")) return false;
  return true;
}
