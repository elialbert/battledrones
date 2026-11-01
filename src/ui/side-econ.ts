/**
 * Each side's economy at a glance, for watching a match (AI vs AI, a
 * replay): scrap in the bank, income a minute, the army's worth in scrap
 * and the ⚡ meter. The spectator's versus pill shows it (src/ui/hud.ts).
 */
import { TICK_RATE, UNITS } from "../sim/balance";
import type { Faction, World } from "../sim/types";

/** Income a minute is measured over the last minute of game time. */
const RATE_TICKS = 60 * TICK_RATE;

/** Scrap a side has earned so far: mined, salvaged, from Uplinks and crates (not the HQ's trickle, nor refunds). */
export function earned(w: World, side: Faction): number {
  const st = w.factions[side].stats;
  const ob = w.objectives.stats[side];
  return st.scrapHarvested + st.scrapSalvaged + ob.uplinkScrap + ob.crateScrap;
}

/** What a side's army cost: every unit but harvesters, squads riding in Condors too. */
export function armyValue(w: World, side: Faction): number {
  let v = 0;
  for (const u of w.units.values()) {
    if (u.faction !== side) continue;
    if (u.kind !== "harvester") v += UNITS[u.kind].cost;
    for (const p of u.passengers ?? []) v += UNITS[p.kind].cost;
  }
  return v;
}

/** Income a minute per side, from samples of scrap earned each second of game time (a seek back starts afresh). */
export function incomeTracker(sides: readonly Faction[]) {
  let samples: { tick: number; earned: Partial<Record<Faction, number>> }[] = [];
  return (w: World): Partial<Record<Faction, number>> => {
    const last = samples[samples.length - 1];
    if (last && w.tick < last.tick) samples = [];
    if (!samples.length || w.tick - samples[samples.length - 1]!.tick >= TICK_RATE)
      samples.push({ tick: w.tick, earned: Object.fromEntries(sides.map((f) => [f, earned(w, f)])) });
    while (samples.length > 1 && w.tick - samples[1]!.tick >= RATE_TICKS) samples.shift();
    // over the last minute; just after a seek, over what's been seen since (or the whole game, until 10 s of it)
    const from = samples[0]!;
    const span = w.tick - from.tick;
    const out: Partial<Record<Faction, number>> = {};
    for (const f of sides) {
      const now = earned(w, f);
      out[f] = span >= 10 * TICK_RATE ? ((now - (from.earned[f] ?? 0)) / span) * RATE_TICKS : w.tick ? (now / w.tick) * RATE_TICKS : 0;
    }
    return out;
  };
}

const short = (n: number) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));

/** One side's line, as markup of numbers only: "💰 1.2k · +840/m · ⚔ 3.4k · ⚡ 40" (the ⚡ part in its own span, phones drop it). */
export function econHtml(w: World, side: Faction, perMin: number): string {
  return `💰 ${short(w.factions[side].scrap)} · +${short(perMin)}/m · ⚔ ${short(armyValue(w, side))}<span class="e-pow"> · ⚡ ${Math.floor(w.powers.meter[side])}</span>`;
}
