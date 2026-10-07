import { UNITS } from "./balance";
import type { BuildingKind, Faction, FactionStats, UnitKind } from "./types";

/**
 * Medals: pure functions of an end-of-match recap (stats, the army-strength
 * timeline, the death log). No engine, no storage — the career layer
 * (src/game/career.ts) builds the recap from the match chronicle and banks
 * what these return. Thresholds are calibrated on AI-vs-AI matches so a
 * typical win earns one or two medals and the rest are goals to chase.
 */

export type MedalId =
  | "lightning"
  | "untouchable"
  | "comeback"
  | "flawless"
  | "tycoon"
  | "ace"
  | "giant-slayer"
  | "air-superiority"
  | "iron-wall"
  | "exterminator"
  | "wrecking-crew"
  | "holdout"
  | "unbreakable";

export interface MedalDef {
  id: MedalId;
  name: string;
  icon: string;
  /** How to earn it (menu sheet and end screen). */
  desc: string;
  /** Which mode can award it. */
  mode: "skirmish" | "survival";
}

/** Tunables (seconds, counts, ratios). */
export const AWARDS = {
  lightningSecs: 5 * 60,
  comebackRatio: 0.5,
  /** ...and at least this far behind in army value (scrap), after the opening. */
  comebackMinGap: 800,
  comebackAfterSecs: 90,
  flawlessMaxLost: 5,
  tycoonRatio: 2,
  tycoonMin: 3000,
  aceKills: 9,
  giantTitans: 3,
  airKills: 30,
  wallKills: 30,
  exterminatorKills: 60,
  wreckingBuildings: 12,
  holdoutWaves: 10,
  unbreakableWaves: 20
} as const;

export const MEDALS: Record<MedalId, MedalDef> = {
  lightning: { id: "lightning", name: "Lightning War", icon: "⚡", desc: "Win in under 5:00", mode: "skirmish" },
  untouchable: { id: "untouchable", name: "Untouchable", icon: "🛡️", desc: "Win without losing a building", mode: "skirmish" },
  comeback: { id: "comeback", name: "Comeback", icon: "🔄", desc: "Win after your army fell to half of theirs", mode: "skirmish" },
  flawless: { id: "flawless", name: "Flawless", icon: "💎", desc: "Win losing 5 units or fewer", mode: "skirmish" },
  tycoon: { id: "tycoon", name: "Tycoon", icon: "💰", desc: "Win having harvested twice the enemy's scrap", mode: "skirmish" },
  ace: { id: "ace", name: "Ace", icon: "🎖️", desc: "One unit scores 9 kills", mode: "skirmish" },
  "giant-slayer": { id: "giant-slayer", name: "Giant Slayer", icon: "🗿", desc: "Destroy 3 enemy Titans", mode: "skirmish" },
  "air-superiority": { id: "air-superiority", name: "Air Superiority", icon: "✈️", desc: "Shoot down 30 enemy aircraft", mode: "skirmish" },
  "iron-wall": { id: "iron-wall", name: "Iron Wall", icon: "🧱", desc: "Your defences destroy 30 enemy units", mode: "skirmish" },
  exterminator: { id: "exterminator", name: "Exterminator", icon: "☠️", desc: "Destroy 60 enemy units", mode: "skirmish" },
  "wrecking-crew": { id: "wrecking-crew", name: "Wrecking Crew", icon: "🏚", desc: "Destroy 12 enemy buildings", mode: "skirmish" },
  holdout: { id: "holdout", name: "Holdout", icon: "🏰", desc: "Last Stand: survive 10 waves", mode: "survival" },
  unbreakable: { id: "unbreakable", name: "Unbreakable", icon: "🗼", desc: "Last Stand: survive 20 waves", mode: "survival" }
};

export const MEDAL_IDS = Object.keys(MEDALS) as MedalId[];

export interface RecapDeath {
  /** Game seconds. */
  t: number;
  /** The victim's side. */
  faction: Faction;
  unitKind: UnitKind | null;
  buildingKind: BuildingKind | null;
  /** Killed by a building (turret, SAM, HQ gun). */
  byBuilding: boolean;
}

/** Everything the medals need, from one side's point of view. */
export interface MatchRecap {
  pov: Faction;
  won: boolean;
  /** Match length in seconds. */
  secs: number;
  stats: Record<Faction, FactionStats>;
  /** Army strength over time (both sides). */
  samples: { t: number; army: Record<Faction, number> }[];
  deaths: RecapDeath[];
  /** Most kills scored by one of the pov side's units (alive or fallen). */
  bestUnitKills: number;
  /** Last Stand: waves survived (null in a skirmish). */
  waves?: number | null;
}

const enemyOf = (f: Faction): Faction => (f === "blue" ? "red" : "blue");

/** Was the pov side ever down to half the enemy's army (after the opening)? */
export function wasBehind(r: MatchRecap): boolean {
  const them = enemyOf(r.pov);
  return r.samples.some(
    (s) =>
      s.t >= AWARDS.comebackAfterSecs &&
      s.army[them] - s.army[r.pov] >= AWARDS.comebackMinGap &&
      s.army[r.pov] <= s.army[them] * AWARDS.comebackRatio
  );
}

/** Enemy units the pov side destroyed matching a filter. */
function killsWhere(r: MatchRecap, pred: (d: RecapDeath) => boolean): number {
  const them = enemyOf(r.pov);
  let n = 0;
  for (const d of r.deaths) if (d.faction === them && d.unitKind && pred(d)) n++;
  return n;
}

/** The medals this recap earns, in display order. */
export function computeMedals(r: MatchRecap): MedalId[] {
  if (r.waves !== undefined && r.waves !== null) {
    const out: MedalId[] = [];
    if (r.waves >= AWARDS.holdoutWaves) out.push("holdout");
    if (r.waves >= AWARDS.unbreakableWaves) out.push("unbreakable");
    return out;
  }
  const me = r.stats[r.pov];
  const them = r.stats[enemyOf(r.pov)];
  const out: MedalId[] = [];
  if (r.won && r.secs < AWARDS.lightningSecs) out.push("lightning");
  if (r.won && me.buildingsLost === 0) out.push("untouchable");
  if (r.won && wasBehind(r)) out.push("comeback");
  if (r.won && me.unitsLost <= AWARDS.flawlessMaxLost) out.push("flawless");
  if (r.won && me.scrapHarvested >= AWARDS.tycoonMin && me.scrapHarvested >= them.scrapHarvested * AWARDS.tycoonRatio)
    out.push("tycoon");
  // feats of arms count in defeat too: a consolation worth chasing
  if (r.bestUnitKills >= AWARDS.aceKills) out.push("ace");
  if (killsWhere(r, (d) => d.unitKind === "titan") >= AWARDS.giantTitans) out.push("giant-slayer");
  if (killsWhere(r, (d) => UNITS[d.unitKind!].domain === "air") >= AWARDS.airKills) out.push("air-superiority");
  if (killsWhere(r, (d) => d.byBuilding) >= AWARDS.wallKills) out.push("iron-wall");
  if (me.unitsKilled >= AWARDS.exterminatorKills) out.push("exterminator");
  if ((me.buildingsKilled ?? 0) >= AWARDS.wreckingBuildings) out.push("wrecking-crew");
  return out;
}
