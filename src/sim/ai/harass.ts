import { BUILDINGS, TICK_RATE, UNITS } from "../balance";
import { knownBuildings } from "../fog";
import type { Command, Faction, Unit, UnitKind, World } from "../types";
import { dist, domainOf } from "../world";
import type { AiState } from "./commander";
import { AA_COVER, USELESS, aaSources, aaStrengthAt, effectivenessVs } from "./intel";

/**
 * Harassment sorties (AiState.sorties: Marshal's plans pick theirs,
 * ai/marshal.ts). A sortie is a few units sent at the enemy's mining with
 * a leash: it goes, kills what harvesters it can, and comes home once it's
 * hurt, outgunned, or out of time. While one is out no other tactic gives
 * its units orders.
 *
 * - POKE (~0:40–2:00): the first two Stingers or Wasps look in on their
 *   home field: their opener, and a harvester if nobody guards it.
 * - PRESSURE (~1:00–2:30): five of a kind, a real bite at the mining line.
 * - AIR (from 6:00, every couple of minutes): a wing of Wasps and Raptors
 *   at the field they'd expand to, away from the HQ's guns, and home before
 *   the flak arrives.
 *
 * What a sortie sees feeds the counters like anything else seen; where it
 * was driven off is remembered (GUARDED_SECS), and the next goes elsewhere.
 */

export type SortieKind = "poke" | "pressure" | "air";

export const SORTIE = {
  poke: { from: 40, until: 120, size: 2, secs: 50, kinds: ["stinger", "wasp", "raptor"] as UnitKind[] },
  pressure: { from: 60, until: 150, size: 5, secs: 60, kinds: ["stinger", "wasp", "raptor", "lancer", "trooper"] as UnitKind[] },
  air: { from: 360, every: 120, size: 4, max: 6, secs: 60, kinds: ["wasp", "raptor"] as UnitKind[], armyValue: 1500 },
  /** Home once the sortie is down to this share of its HP (it is chased home: at 0.65 a pressure sortie lost four of five)… */
  hurt: 0.8,
  /** …or what defends there is this many times its strength. */
  outgunned: 0.8,
  /** Defenders this close to the sortie count against it. */
  reach: 8,
  /** Harvesters this close to the sortie (or its target) are its prey. */
  prey: 9,
  /** A spot a sortie was driven off is left alone this long (s). */
  guardedSecs: 150,
  /** Units guarding within this of home may go on a sortie, not just idle ones. */
  homePool: 14,
  /** Back within this of home: the sortie is over. */
  homeReach: 7
};

type P = { x: number; y: number };

interface Sortie {
  kind: SortieKind;
  ids: number[];
  to: P;
  hp: number;
  started: number;
  phase: "out" | "home";
  /** Why it turned for home (traces). */
  why?: "hurt" | "outgunned" | "flak" | "time" | "seen";
}

interface Memo {
  active: Sortie | null;
  done: Set<SortieKind>;
  lastAir: number;
  launched: number;
  guarded: { x: number; y: number; tick: number }[];
}

const memos = new WeakMap<AiState, Memo>();
function memo(s: AiState): Memo {
  let m = memos.get(s);
  if (!m) {
    m = { active: null, done: new Set(), lastAir: -1e9, launched: 0, guarded: [] };
    memos.set(s, m);
  }
  return m;
}

/** Our units out on a sortie: no other tactic gives them orders. */
export function sortieHolds(s: AiState): Set<number> {
  return new Set(memos.get(s)?.active?.ids ?? []);
}

/** The sortie out now (traces and tests). */
export const activeSortie = (s: AiState): Readonly<Sortie> | null => memos.get(s)?.active ?? null;
/** Sorties launched so far (traces and tests). */
export const sortiesLaunched = (s: AiState): number => memos.get(s)?.launched ?? 0;

export interface SortieContext {
  hqC: P;
  /** The army, minus what other planners hold. */
  army: readonly Unit[];
  used: Set<number>;
  seen: readonly Unit[];
  armyValue: number;
  /** The base under real attack: no sortie leaves. */
  threatened: boolean;
  /** Where to hit: their home field (leg 0) or a field they'd expand to (leg 1). */
  target: (leg: number) => P & { targetId?: number };
}

/** The sorties' orders this pass. */
export function planSorties(w: World, faction: Faction, s: AiState, ctx: SortieContext): Command[] {
  if (!s.sorties?.length) return [];
  const m = memo(s);
  m.guarded = m.guarded.filter((g) => w.tick - g.tick < SORTIE.guardedSecs * TICK_RATE);
  const cmds: Command[] = [];
  const a = m.active;
  if (a) {
    a.ids = a.ids.filter((id) => w.units.get(id)?.faction === faction);
    if (!a.ids.length) m.active = null;
    else {
      for (const id of a.ids) ctx.used.add(id);
      cmds.push(...fly(w, faction, m, a, ctx));
    }
  }
  if (!m.active) {
    const go = launch(w, faction, s, m, ctx);
    if (go) cmds.push(go);
  }
  return cmds;
}

function launch(w: World, faction: Faction, s: AiState, m: Memo, ctx: SortieContext): Command | null {
  const secs = w.tick / TICK_RATE;
  if (ctx.threatened || secs < (s.strategy.holdUntil ?? 0)) return null;
  const idle = (kinds: UnitKind[]) =>
    ctx.army
      .filter(
        (u) =>
          kinds.includes(u.kind) && !ctx.used.has(u.id) && u.hp >= 0.8 * UNITS[u.kind].hp &&
          // (idle, or standing guard at home: not out with a wave)
          (u.order.type === "idle" || (u.order.type === "attackMove" && dist(u.x, u.y, ctx.hqC.x, ctx.hqC.y) <= SORTIE.homePool))
      )
      .sort((a, b) => dist(a.x, a.y, ctx.hqC.x, ctx.hqC.y) - dist(b.x, b.y, ctx.hqC.x, ctx.hqC.y) || a.id - b.id);
  for (const kind of s.sorties!) {
    if (m.done.has(kind)) continue;
    let group: Unit[] = [];
    let leg = 0;
    if (kind === "air") {
      const k = SORTIE.air;
      if (secs < k.from || w.tick - m.lastAir < k.every * TICK_RATE || ctx.armyValue < k.armyValue) continue;
      const wing = idle(k.kinds);
      if (wing.length < k.size) continue;
      group = wing.slice(0, k.max);
      leg = 1;
    } else {
      const k = SORTIE[kind];
      if (secs > k.until) {
        m.done.add(kind);
        continue;
      }
      if (secs < k.from) continue;
      if (kind === "poke") group = idle(k.kinds).slice(0, k.size);
      else {
        // (five of one kind: they move and fight as one)
        const byKind = k.kinds.map((kk) => idle([kk])).sort((a, b) => b.length - a.length);
        group = byKind[0]!.slice(0, k.size);
      }
      if (group.length < k.size) continue;
    }
    const to = pickTarget(w, faction, m, ctx, leg, group);
    if (!to) {
      // (nowhere unguarded to go: an air raid waits for the next window; the early ones give up)
      if (kind === "air") m.lastAir = w.tick;
      else m.done.add(kind);
      continue;
    }
    if (kind === "air") m.lastAir = w.tick;
    else m.done.add(kind);
    m.launched++;
    const ids = group.map((u) => u.id);
    for (const id of ids) ctx.used.add(id);
    m.active = { kind, ids, to, hp: group.reduce((h, u) => h + u.hp, 0), started: w.tick, phase: "out" };
    return { type: "move", faction, unitIds: ids, x: to.x, y: to.y };
  }
  return null;
}

/** Where a sortie goes: the field asked for, else the other, never a spot a sortie was driven off lately, nor (for aircraft) into flak. */
function pickTarget(w: World, faction: Faction, m: Memo, ctx: SortieContext, leg: number, group: Unit[]): P | null {
  const air = group.every((u) => domainOf(u) === "air");
  const aa = air ? aaSources(w, faction, ctx.seen) : [];
  for (const l of [leg, leg ^ 1]) {
    const t = ctx.target(l);
    if (m.guarded.some((g) => dist(g.x, g.y, t.x, t.y) <= 6)) continue;
    if (air && aaStrengthAt(aa, t.x, t.y) >= AA_COVER) continue;
    return { x: t.x, y: t.y };
  }
  return null;
}

function fly(w: World, faction: Faction, m: Memo, a: Sortie, ctx: SortieContext): Command[] {
  const units = a.ids.map((id) => w.units.get(id)!);
  const cx = units.reduce((v, u) => v + u.x, 0) / units.length;
  const cy = units.reduce((v, u) => v + u.y, 0) / units.length;
  const home = (): Command[] => {
    const go = units.filter((u) => !(u.order.type === "move" && dist(u.order.x, u.order.y, ctx.hqC.x, ctx.hqC.y) <= 2));
    return go.length ? [{ type: "move", faction, unitIds: go.map((u) => u.id), x: ctx.hqC.x, y: ctx.hqC.y }] : [];
  };

  if (a.phase === "home") {
    if (dist(cx, cy, ctx.hqC.x, ctx.hqC.y) <= SORTIE.homeReach) {
      m.active = null;
      return [];
    }
    return home();
  }

  // --- the leash: hurt, outgunned, or out of time, it turns for home
  const spec = SORTIE[a.kind];
  const hp = units.reduce((v, u) => v + u.hp, 0);
  const defenders = ctx.seen.filter(
    (e) => !e.goliath && UNITS[e.kind].dps > 0 && dist(e.x, e.y, cx, cy) <= SORTIE.reach && units.some((u) => canHurt(e, u))
  );
  // known guns that can hit the sortie, and how far they reach
  const air = units.every((u) => domainOf(u) === "air");
  const guns = knownBuildings(w, faction).flatMap((b) => {
    const st = BUILDINGS[b.kind];
    const live = w.buildings.get(b.id);
    if (b.faction === faction || !live || st.dps <= 0 || (st.targets !== "both" && st.targets !== (air ? "air" : "ground"))) return [];
    return [{ x: b.tx + st.size / 2, y: b.ty + st.size / 2, reach: st.range + st.size / 2, dps: st.dps, hp: live.hp }];
  });
  const covered = (x: number, y: number, slack: number) => guns.some((g) => dist(g.x, g.y, x, y) <= g.reach + slack);
  const towers = guns.filter((g) => dist(g.x, g.y, cx, cy) <= g.reach + 1);
  const ours = units.reduce((v, u) => v + UNITS[u.kind].dps, 0) * hp;
  const theirs =
    defenders.reduce((v, e) => v + UNITS[e.kind].dps, 0) * defenders.reduce((v, e) => v + e.hp, 0) +
    towers.reduce((v, g) => v + g.dps * g.hp, 0);
  const flak = air && aaStrengthAt(aaSources(w, faction, ctx.seen), cx, cy) >= AA_COVER * 2;
  const why =
    hp < SORTIE.hurt * a.hp ? "hurt" : theirs > SORTIE.outgunned * ours ? "outgunned" : flak ? "flak" : w.tick - a.started > spec.secs * TICK_RATE ? "time" : null;
  if (why) {
    a.why = why;
    // (driven off: the next sortie goes elsewhere)
    if (why !== "time") m.guarded.push({ x: a.to.x, y: a.to.y, tick: w.tick });
    a.phase = "home";
    return home();
  }

  // --- the prey: the nearest harvester by the sortie or its target, out of their guns' reach, all on it
  const prey = ctx.seen
    .filter(
      (e) =>
        e.kind === "harvester" && (dist(e.x, e.y, cx, cy) <= SORTIE.prey || dist(e.x, e.y, a.to.x, a.to.y) <= SORTIE.prey) &&
        !covered(e.x, e.y, 1)
    )
    .sort((p, q) => dist(p.x, p.y, cx, cy) - dist(q.x, q.y, cx, cy) || p.id - q.id)[0];
  if (prey) {
    const go = units.filter((u) => !(u.order.type === "attack" && u.order.targetId === prey.id) && canHurt(u, prey));
    return go.length ? [{ type: "attack", faction, unitIds: go.map((u) => u.id), targetId: prey.id }] : [];
  }
  // nothing to hit there, or nothing out of their guns' reach (and nobody driving it off): it has seen what it came to see
  if (dist(cx, cy, a.to.x, a.to.y) <= 2.5 || covered(cx, cy, 2)) {
    a.why = "seen";
    a.phase = "home";
    return home();
  }
  const go = units.filter((u) => !(u.order.type === "move" && dist(u.order.x, u.order.y, a.to.x, a.to.y) <= 1.5));
  return go.length ? [{ type: "move", faction, unitIds: go.map((u) => u.id), x: a.to.x, y: a.to.y }] : [];
}

function canHurt(u: Unit, e: Unit): boolean {
  const st = UNITS[u.kind];
  const d = domainOf(e);
  return st.dps > 0 && (st.targets === "both" || st.targets === d) && effectivenessVs(u.kind, UNITS[e.kind].armor, d) >= USELESS;
}
