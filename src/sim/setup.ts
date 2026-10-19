/**
 * The one way a skirmish match is set up from its description (battle
 * records, AGENT-BATTLES.md; sound duels, SOUND-DUEL.md): the map with
 * objectives, blue's opener then red's (they take ids from the shared counter,
 * so the order matters), each side's income, then the fog drawn once. Two
 * phones that call this with the same setup hold the same world.
 */
import { tickFog } from "./fog";
import { createMapWorld } from "./maps";
import { applyOpener, type OpenerId } from "./openers";
import type { MutatorId } from "./rules";
import type { Faction, World } from "./types";

export interface MatchSetup {
  map: string;
  seed: number;
  mutators: MutatorId[];
  openers: Partial<Record<Faction, OpenerId>>;
  /** Per-side income multipliers (AI difficulty in arena seats); absent = 1. */
  income?: Partial<Record<Faction, number>>;
}

export function setupWorld(r: MatchSetup): World {
  const w = createMapWorld(r.map, { seed: r.seed, objectives: true, ...(r.mutators.length ? { mutators: r.mutators } : {}) });
  for (const f of ["blue", "red"] as const) {
    const o = r.openers[f];
    if (o) applyOpener(w, f, o);
    const m = r.income?.[f];
    if (m !== undefined) w.factions[f].incomeMult = m;
  }
  tickFog(w);
  return w;
}
