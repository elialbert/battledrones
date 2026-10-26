/**
 * The one way a skirmish match is set up from its description (battle
 * records, AGENT-BATTLES.md; sound duels, SOUND-DUEL.md; a Last Stand or an
 * op played here, game/recorder.ts, with `survival` or `op`): the map with
 * objectives, blue's opener then red's (they take ids from the shared counter,
 * so the order matters; a four-player map's in canonical side order, sides.ts),
 * each side's income, then the fog drawn once. Two
 * phones that call this with the same setup hold the same world.
 */
import { tickFog } from "./fog";
import { createMapWorld } from "./maps";
import type { SurvivalOptions } from "./modes/survival";
import { applyOpener, type OpenerId } from "./openers";
import type { MutatorId } from "./rules";
import type { Faction, World } from "./types";
import { sidesOf } from "./sides";

export interface MatchSetup {
  map: string;
  seed: number;
  mutators: MutatorId[];
  openers: Partial<Record<Faction, OpenerId>>;
  /** Per-side income multipliers (AI difficulty in arena seats); absent = 1. */
  income?: Partial<Record<Faction, number>>;
  /** Last Stand (a match played here, game/recorder.ts): the wave director instead of red's base. No openers, no objectives. */
  survival?: SurvivalOptions;
  /** Ops: the scenario (ops.ts), with its own setup. No openers, no objectives. */
  op?: string;
}

export function setupWorld(r: MatchSetup): World {
  const w = createMapWorld(r.map, {
    seed: r.seed,
    objectives: true,
    ...(r.mutators.length ? { mutators: r.mutators } : {}),
    ...(r.survival ? { survival: r.survival } : {}),
    ...(r.op ? { op: r.op } : {})
  });
  for (const f of sidesOf(w)) {
    const o = r.openers[f];
    if (o) applyOpener(w, f, o);
    const m = r.income?.[f];
    if (m !== undefined) w.factions[f].incomeMult = m;
  }
  tickFog(w);
  return w;
}
