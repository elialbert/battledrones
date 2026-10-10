import { BUILDINGS, UNITS } from "../balance";
import type { Building, Command, Faction, Unit } from "../types";
import { buildingCenter, dist } from "../world";

/**
 * The commander's Menders. A Mender has no gun, so it is never a wave, a raid
 * or a guard post of its own: every decision pass it picks the friendly unit
 * that needs it most — a wounded one close by, else the nearest group that is
 * on the move — and follows it. A unit alone deep in enemy ground (a raider,
 * the last of a wave) is not worth following there, and a Mender with nobody
 * worth following flies home to patch up the base instead of hovering where
 * the fight used to be.
 */
export const MENDER_AI = {
  /** Units under this share of max HP count as wounded. */
  wounded: 0.85,
  /** Wounded units farther than this (tiles) from the Mender are left to others. */
  reach: 20,
  /** Friendly army within this many tiles of a unit is its company. */
  company: 5,
  /** Within this many tiles of the enemy HQ counts as deep in enemy ground… */
  deep: 16,
  /** …where a unit with less company than this (scrap value, itself included) is not followed. */
  deepCompany: 400,
  /** A Mender already headed within this many tiles of its pick keeps its order. */
  slack: 2.5,
  /** Home: a Mender this close to its rest point stays put. */
  rest: 3
};

/**
 * Orders for the Menders in `army` that aren't already spoken for (`used`:
 * dodging a reticle, or sent to a resting veteran). Every Mender it handles
 * is added to `used`, so no wave, guard or salvage tactic recruits it.
 */
export function planMenders(
  faction: Faction,
  army: Unit[],
  buildings: Building[],
  used: Set<number>,
  home: { x: number; y: number },
  enemyHq: { x: number; y: number }
): Command[] {
  const cmds: Command[] = [];
  const menders = army.filter((u) => u.kind === "mender" && !used.has(u.id));
  if (menders.length === 0) return cmds;
  const others = army.filter((u) => u.kind !== "mender");
  const company = (u: Unit) =>
    others.reduce((v, o) => (dist(o.x, o.y, u.x, u.y) <= MENDER_AI.company ? v + UNITS[o.kind].cost : v), 0);
  // a lone unit deep in enemy ground (a raider, the last of a wave): not worth following in there
  const safe = (u: Unit) =>
    dist(u.x, u.y, enemyHq.x, enemyHq.y) > MENDER_AI.deep || company(u) >= MENDER_AI.deepCompany;
  const hp = (u: Unit) => u.hp / UNITS[u.kind].hp;
  const wounded = others.filter((u) => hp(u) < MENDER_AI.wounded && safe(u));
  const moving = others.filter((u) => u.order.type !== "idle" && safe(u));
  // nothing to follow: the base's most battered building, else just behind the HQ
  let rest = { x: home.x, y: home.y };
  let worst = 1;
  for (const b of buildings) {
    const share = b.hp / BUILDINGS[b.kind].hp;
    if (share < worst) {
      worst = share;
      rest = buildingCenter(b);
    }
  }

  for (const m of menders) {
    used.add(m.id);
    let pick: { x: number; y: number } | null = null;
    // the wounded first: the worse hurt and the closer, the better
    let best = Infinity;
    for (const u of wounded) {
      const d = dist(u.x, u.y, m.x, m.y);
      if (d > MENDER_AI.reach) continue;
      const score = d + hp(u) * 10;
      if (score < best) {
        best = score;
        pick = u;
      }
    }
    // else tag along with the nearest unit that's going somewhere
    if (!pick) {
      best = Infinity;
      for (const u of moving) {
        const d = dist(u.x, u.y, m.x, m.y);
        if (d < best) {
          best = d;
          pick = u;
        }
      }
    }
    const goal = pick ?? rest;
    const near = pick ? MENDER_AI.slack : MENDER_AI.rest;
    if (dist(m.x, m.y, goal.x, goal.y) <= near) continue; // there: heal whatever's in reach
    const o = m.order;
    if ((o.type === "move" || o.type === "attackMove") && dist(o.x, o.y, goal.x, goal.y) <= near) continue; // on its way
    cmds.push({ type: pick ? "attackMove" : "move", faction, unitIds: [m.id], x: goal.x, y: goal.y });
  }
  return cmds;
}
