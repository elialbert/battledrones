/**
 * Scripted seats (AGENT-BATTLES.md "Scripted seats"): a seat that plays a
 * fixed list of orders through the same tools as any agent, so a whole arena
 * match runs in CI with no model and no network. A script names its opener,
 * orders for particular rounds, and orders repeated every n rounds.
 */
import type { OpenerId } from "../sim/openers";
import type { Faction } from "../sim/types";
import type { Arena } from "./match";

export interface Script {
  opener: OpenerId;
  /** Orders for particular rounds (keys are round numbers). */
  rounds?: Record<string, unknown[]>;
  /** Orders repeated every `every` rounds, from round `from` (default 1). */
  repeat?: { every: number; from?: number; orders: unknown[] }[];
}

/**
 * The default script: Blitz, a turret and an Assembly Bay, Stingers and
 * Troopers off the line, and every minute the whole army attack-moves on
 * the enemy HQ. Not clever, but it exercises the order vocabulary and it can
 * win against an idle opponent.
 */
export const DEFAULT_SCRIPT: Script = {
  opener: "blitz",
  rounds: {
    "1": [{ produce: "stinger", count: 2 }, { build: "turret" }],
    "4": [{ build: "assembly-bay" }],
    "9": [{ produce: "harvester" }],
    "12": [{ build: "airpad" }],
    "20": [{ build: "tech-lab" }],
    "30": [{ build: "turret" }]
  },
  repeat: [
    { every: 3, from: 2, orders: [{ produce: "stinger" }, { produce: "trooper" }] },
    { every: 6, from: 18, orders: [{ produce: "flak-crawler" }] },
    { every: 12, from: 12, orders: [{ attack_move: "army", to: "enemy-hq" }] }
  ]
};

/** The orders a script gives in round `r` (round 0: the opener). */
export function scriptOrders(s: Script, r: number): unknown[] {
  if (r === 0) return [{ opener: s.opener }];
  const out = [...(s.rounds?.[String(r)] ?? [])];
  for (const rep of s.repeat ?? []) {
    const from = rep.from ?? 1;
    if (r >= from && (r - from) % rep.every === 0) out.push(...rep.orders);
  }
  return out;
}

/** Play this round's turn for a scripted seat. */
export function playScripted(arena: Arena, side: Faction, s: Script): void {
  if (!arena.turnOpen(side)) return;
  const orders = scriptOrders(s, arena.round);
  if (orders.length) arena.orders(side, orders);
  arena.endRound(side, `scripted round ${arena.round}`);
}
