import { UNITS } from "./balance";
import { isVisible } from "./fog";
import type { Faction, Unit, UnitKind, World } from "./types";

/**
 * Robot infantry (INFANTRY.md). A squad is ONE sim unit with one HP pool,
 * drawn as `UNITS[kind].squad` robots: a robot falls each time HP crosses a
 * 1/N step, and the squad's firepower scales with the robots still standing.
 */

/** Is this kind a robot infantry squad (Trooper, Rocket, Sniper)? */
export const isInfantry = (kind: UnitKind): boolean => (UNITS[kind].squad ?? 0) > 0;

/** Robots a squad of this kind is drawn as (1 for anything that isn't infantry). */
export const squadSize = (kind: UnitKind): number => UNITS[kind].squad ?? 1;

/**
 * Robots still standing: ceil(N × hp / maxHp), clamped to 0…N. A full squad
 * has N; it drops to N − 1 the moment HP falls below (N − 1)/N of max.
 */
export function squadAlive(u: Pick<Unit, "kind" | "hp">): number {
  const n = squadSize(u.kind);
  if (u.hp <= 0) return 0;
  return Math.max(1, Math.min(n, Math.ceil((n * u.hp) / UNITS[u.kind].hp - 1e-9)));
}

/** Firepower multiplier from losses: alive / N (1 for non-infantry). */
export function squadFirepower(u: Pick<Unit, "kind" | "hp">): number {
  const n = squadSize(u.kind);
  return n <= 1 ? 1 : squadAlive(u) / n;
}

/** Is this a transport (the Condor)? */
export const isTransport = (kind: UnitKind): boolean => (UNITS[kind].capacity ?? 0) > 0;

/**
 * Can `faction` see enemy unit `u` right now? Its tile must be in sight, and
 * a Sniper Team concealed in Woods (only seen by enemies within
 * INFANTRY.concealRadius, until INFANTRY.concealAfterShot s after it fires)
 * stays hidden. Use this — not a bare tile check — wherever a side decides
 * whether it sees an enemy UNIT: targeting, the AI's eyes, the renderer.
 */
export function unitSeenBy(w: World, faction: Faction, u: Unit): boolean {
  if (u.faction === faction) return true;
  if (!isVisible(w, faction, Math.floor(u.x), Math.floor(u.y))) return false;
  return !concealedFrom(w, faction, u);
}

/** Is `u` a Sniper Team hidden from `faction` by Woods concealment? (TODO: sim agent) */
export function concealedFrom(_w: World, _faction: Faction, _u: Unit): boolean {
  return false;
}
