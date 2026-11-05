/**
 * Doctrine: the army Marshal commits to, once it knows what it's facing.
 *
 * The commander's production answers what it sees one unit at a time, so its
 * army is a bit of everything. A doctrine is a decision above that: from
 * Strategy.doctrine.from on, what the enemy has shown (AiState.sightings) picks
 * one of the armies below, each order for anything else becomes one for it, and
 * the base gets the factories it needs. A later read can change it, no sooner
 * than `hold` seconds after the last change: the old factories stand idle, and
 * the new ones have to be paid for, which is what makes a switch a decision.
 *
 * The three are the focused armies that held up against a mix with ground-only
 * Lancers, and they answer each other (Hard, 24 games a pairing): Air beat
 * Lancer + Rocket 77%, Lancer + Flak beat Air 63%, and Air beat tanks with no
 * anti-air 96%.
 */
import { UNITS } from "../balance";
import type { BuildingKind, UnitKind } from "../types";
import { AA_COVER, aaWeight } from "./intel";

export type DoctrineName = "air" | "armour" | "rockets";

/** What each army builds, by factory, in turn; and the factories it wants. */
export const DOCTRINES: Record<DoctrineName, { lines: Partial<Record<BuildingKind, UnitKind[]>>; factories: BuildingKind[] }> = {
  air: { lines: { airpad: ["wasp", "hornet", "raptor"] }, factories: ["airpad", "airpad", "airpad"] },
  armour: { lines: { "fab-plant": ["lancer", "flak-crawler"] }, factories: ["fab-plant", "fab-plant", "fab-plant"] },
  rockets: { lines: { "fab-plant": ["lancer"], "assembly-bay": ["rocket-squad"] }, factories: ["fab-plant", "fab-plant", "assembly-bay", "assembly-bay"] }
};

export const DOCTRINE = {
  /** Seconds in: the openings are the plans' own. (Balanced against itself, 24 games: 3:00 54%, 6:00 58%, 9:00 50%.) */
  from: 360,
  /** Seconds a doctrine stands before another read can change it. */
  hold: 120,
  /** Enemy army value below this isn't a read. */
  minRead: 800,
  /** This share of their army in the air: guns that shoot up. */
  airShare: 0.35,
  /** Anti-air at or below this share: the sky is open. */
  openSky: 0.15,
  /** This share of heavy armour: Rocket Squads. */
  heavyShare: 0.3,
  /** Scrap kept past a unit's price before an idle factory is put to work. */
  busyAbove: 400
};

/** Strategy.doctrine: when it starts, and a hook for traces. */
export interface DoctrinePlan {
  from: number;
  onSwitch?: (name: DoctrineName, tick: number) => void;
}

/** AiState.doctrine: the army in force, since when, and whose turn in each factory's rotation. */
export interface DoctrineState {
  name: DoctrineName;
  since: number;
  turn: Partial<Record<BuildingKind, number>>;
}

/** One remembered enemy unit, as far as a doctrine cares. */
export interface Seen {
  kind: UnitKind;
  value: number;
}

/** The doctrine for this enemy army, or null if it says nothing either way. */
export function readEnemy(army: Iterable<Seen>): DoctrineName | null {
  let total = 0;
  let air = 0;
  let aa = 0;
  let heavy = 0;
  for (const { kind, value } of army) {
    const st = UNITS[kind];
    total += value;
    if (st.domain === "air" && st.dps > 0) air += value;
    if (aaWeight(st) >= AA_COVER) aa += value;
    if (st.armor === "heavy") heavy += value;
  }
  if (total < DOCTRINE.minRead) return null;
  if (air >= DOCTRINE.airShare * total) return "armour";
  if (aa <= DOCTRINE.openSky * total) return "air";
  if (heavy >= DOCTRINE.heavyShare * total) return "rockets";
  return null;
}

/** Take a new read: starts a doctrine, or changes it once it has stood long enough. */
export function reviewDoctrine(cur: DoctrineState | undefined, plan: DoctrinePlan, tick: number, tickRate: number, army: Iterable<Seen>): DoctrineState | undefined {
  if (tick < plan.from * tickRate) return cur;
  if (cur && tick - cur.since < DOCTRINE.hold * tickRate) return cur;
  const read = readEnemy(army);
  if (!read || read === cur?.name) return cur;
  plan.onSwitch?.(read, tick);
  return { name: read, since: tick, turn: {} };
}

/** The next unit of this doctrine from this factory, or null if it has no part in it. */
export function doctrineUnit(d: DoctrineState, site: BuildingKind): UnitKind | null {
  const line = DOCTRINES[d.name].lines[site];
  if (!line) return null;
  const n = d.turn[site] ?? 0;
  d.turn[site] = n + 1;
  return line[n % line.length]!;
}

/**
 * What an order for `kind` at `site` becomes under a doctrine. Support and
 * transport (Harvesters, Scouts, Condors, Menders, Goliaths) are left alone.
 */
export function underDoctrine(d: DoctrineState | undefined, site: BuildingKind | undefined, kind: UnitKind): UnitKind | null {
  if (!d || !site || kind === "harvester" || kind === "scout" || kind === "condor" || kind === "mender" || kind === "goliath") return kind;
  if (DOCTRINES[d.name].lines[site]?.includes(kind)) return kind;
  return doctrineUnit(d, site);
}
