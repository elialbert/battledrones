import { BUILDINGS, TICK_RATE, UNITS } from "../balance";
import { cos, sin } from "../fmath";
import { knownBuildings } from "../fog";
import type { Command, Faction, Unit, World } from "../types";
import { canGetWithin, dist, domainOf, moveClassOf, passable } from "../world";
import type { AiState } from "./commander";

/**
 * Siege Train (Strategy.siege: Marshal's plan of that name, for fun). A slow
 * column of Mortars, Menders and an escort comes on in hops, digs in just out
 * of reach and shells the base until someone comes out to stop it.
 *
 * - MUSTER: from `from` s, once there are `mortars` Mortars and an army worth
 *   `army` (scaled as a wave is) that stands up to what we remember of theirs
 *   (SIEGE.edge). The column is the army, all but SIEGE.home of it: a small
 *   one is cut at every hop (2-19-3 against Balanced, 191 of 219 hops cut),
 *   and one that waits for a clear edge leaves at 10:00 or never.
 * - LEAD: the next stop picked (pickStop), the escort goes first, to a screen
 *   just ahead of it.
 * - HAUL: once the escort is there (or SIEGE.leadSecs is up), the Mortars and
 *   Menders follow.
 * - SHELL: Mortars left idle fire by themselves, and they aim at nothing a
 *   Turret reaches: range 8 against 4.5. When none has anything left to shoot
 *   at, on to the next stop.
 *
 * Anything armed coming at the column ends a hop where it stands: the Mortars
 * stop to fire (they can't on the move, combat.ts) and the escort goes at it.
 * What's built meanwhile joins the column. Down to SIEGE.spent of its worth
 * it's over: what's left goes home and the next column musters.
 *
 * The column's units are held from the fight micro (marshal.ts wing), so
 * ai/kite.ts doesn't back the Mortars off a target, and from planMenders,
 * which would send a Mender home every time the column stopped moving.
 * Same fog as everyone: only knownBuildings and what's seen.
 */

export const SIEGE = {
  /** Mortars stand this far from the edge of what they shell (range 8, and the last tile for the ground to give). */
  stand: 7,
  /** Nothing armed of theirs we know of reaches a stop: this far from it (a Turret's 4.5, and a margin). */
  clear: 6,
  /** The escort's screen: this far ahead of the stop… */
  screen: 1.5,
  /** …and it wanders no farther than this from there with nothing to fight. */
  leash: 5,
  /** The longest hop (tiles). */
  hop: 14,
  /** Escort within this of the screen: there. */
  led: 4,
  /** Seconds the Mortars wait for the escort (a Mastodon does 1.0 to their 1.5). */
  leadSecs: 25,
  /** Mortars within this of the stop: there. */
  there: 2.5,
  /** Seconds a hop may take the Mortars. */
  haulSecs: 30,
  /** Seconds at a stop before "nothing to shoot at" counts (they're still coming in). */
  settle: 4,
  /** Anything armed this close to the column is on it… */
  alarm: 8,
  /** …and only this share of the column's worth in it stops a hop: a poke is the escort's business. */
  halt: 0.25,
  /** More than this many times the column's worth on it, and it runs for home: a column dying in the open is 300 a Mortar thrown away. */
  rout: 1.3,
  /** Share of the army, by worth, left at home. */
  home: 0.3,
  /** The column leaves at this many times what we remember of their army. */
  edge: 1,
  /** Reinforcements leave together, once they're worth this (one at a time, they fed Balanced's army: 19.5 Mortars lost a game). */
  group: 900,
  /** Seconds between the escort's orders at the same fight. */
  engageEvery: 3,
  /** A Mortar with something armed this close steps back (it can't hit inside 2.5, and stood there it only dies)… */
  crowd: 4,
  /** …this far, away from it and toward the column's rear. */
  stepBack: 3.5,
  /** Share of the column's worth below which it's over. */
  spent: 0.3,
  /** Seconds before the next column may leave. */
  retry: 30,
  /** Menders the column keeps. */
  menders: 2,
  /** Known buildings tried for a stop, nearest first. */
  tries: 8
};

type P = { x: number; y: number };
type Phase = "muster" | "lead" | "haul" | "shell";

/** One hop, for traces and tests. */
export interface Hop {
  at: number;
  /** When the Mortars got there (or were stopped short): -1 till then. */
  stopped: number;
  stop: P;
  /** What it's for: a building's kind, or "" for a leg of the way. */
  target: string;
  /** Cut short by a fight on the way. */
  cut: boolean;
}

interface Memo {
  phase: Phase;
  guns: number[];
  escort: number[];
  menders: number[];
  stop: P;
  screen: P;
  /** The phase began at this tick. */
  since: number;
  /** The column's worth when it left. */
  worth: number;
  /** No column before this tick. */
  nextAt: number;
  /** The escort's last order at a fight. */
  engaged: number;
  hops: Hop[];
  columns: number;
}

const memos = new WeakMap<AiState, Memo>();
function memo(s: AiState): Memo {
  let m = memos.get(s);
  if (!m) {
    m = { phase: "muster", guns: [], escort: [], menders: [], stop: { x: 0, y: 0 }, screen: { x: 0, y: 0 }, since: 0, worth: 0, nextAt: 0, engaged: -Infinity, hops: [], columns: 0 };
    memos.set(s, m);
  }
  return m;
}

/** The units in the column now: no other tactic gives them orders. */
export function siegeHolds(s: AiState): Set<number> {
  const m = memos.get(s);
  return new Set(m ? [...m.guns, ...m.escort, ...m.menders] : []);
}

/** The column's phase, its hops so far, and the columns sent (traces and tests). */
export const siegePhase = (s: AiState): Phase => memo(s).phase;
export const siegeHops = (s: AiState): readonly Hop[] => memo(s).hops;
export const siegeColumns = (s: AiState): number => memo(s).columns;

export interface SiegeContext {
  hqC: P;
  army: readonly Unit[];
  used: Set<number>;
  seen: readonly Unit[];
  threatened: boolean;
  /** The army's worth that lets a column leave. */
  readyAt: number;
  /** What we remember of their army (0 when it doesn't weigh). */
  enemyArmy: number;
  /** No column here at all (Last Stand, island relays): the plan's stock waves instead. */
  barred: boolean;
  /** The buildings' owner in a free-for-all. */
  focus: Faction | null;
  /** Their base, known or guessed. */
  enemyHqPos: P;
}

const valueOf = (units: readonly Unit[]) => units.reduce((v, u) => v + UNITS[u.kind].cost, 0);
const armed = (e: Unit) => e.kind !== "harvester" && UNITS[e.kind].dps > 0;
const middle = (units: readonly Unit[]): P => ({
  x: units.reduce((v, u) => v + u.x, 0) / units.length,
  y: units.reduce((v, u) => v + u.y, 0) / units.length
});

/** The column's orders this pass. */
export function planSiege(w: World, faction: Faction, s: AiState, ctx: SiegeContext): Command[] {
  const spec = s.strategy.siege;
  if (!spec) return [];
  const m = memo(s);
  const alive = (ids: number[]) => ids.filter((id) => w.units.get(id)?.faction === faction);
  m.guns = alive(m.guns);
  m.escort = alive(m.escort);
  m.menders = alive(m.menders);
  const units = (ids: number[]) => ids.map((id) => w.units.get(id)!);
  const disband = (): Command[] => {
    const ids = [...siegeHolds(s)];
    m.guns = [];
    m.escort = [];
    m.menders = [];
    m.phase = "muster";
    m.nextAt = w.tick + SIEGE.retry * TICK_RATE;
    return ids.length ? [{ type: "move", faction, unitIds: ids, x: ctx.hqC.x, y: ctx.hqC.y }] : [];
  };
  if (ctx.barred) return m.phase === "muster" ? [] : disband();

  // --- muster: enough guns and an escort worth the trip
  if (m.phase === "muster") {
    if (ctx.threatened || w.tick < Math.max(m.nextAt, spec.from * TICK_RATE, (s.strategy.holdUntil ?? 0) * TICK_RATE)) return [];
    const free = ctx.army.filter((u) => !ctx.used.has(u.id) && (u.order.type === "idle" || u.order.type === "attackMove")).sort((a, b) => a.id - b.id);
    const guns = free.filter((u) => u.kind === "mortar");
    if (guns.length < spec.mortars) return [];
    // (the heaviest go, the quickest and lightest stay: they're the ones who can get to a raid)
    const ground = free
      .filter((u) => u.kind !== "mortar" && armed(u) && domainOf(u) === "ground")
      .sort((a, b) => UNITS[b.kind].cost - UNITS[a.kind].cost || a.id - b.id);
    const total = valueOf(guns) + valueOf(ground);
    if (total < ctx.readyAt || total < SIEGE.edge * ctx.enemyArmy) return [];
    const escort: Unit[] = [];
    let v = 0;
    for (const u of ground) {
      if (v + valueOf(guns) >= (1 - SIEGE.home) * total) break;
      escort.push(u);
      v += UNITS[u.kind].cost;
    }
    const from = middle(guns);
    const next = pickStop(w, faction, ctx, from, guns[0]!);
    if (!next) return [];
    m.guns = guns.map((u) => u.id);
    m.escort = escort.map((u) => u.id);
    // (planMenders has had them by now, so `used` says nothing about them: taken from it from here on)
    m.menders = ctx.army.filter((u) => u.kind === "mender").sort((a, b) => a.id - b.id).slice(0, SIEGE.menders).map((u) => u.id);
    m.worth = valueOf(guns) + v;
    m.columns++;
    for (const id of siegeHolds(s)) ctx.used.add(id);
    return setOut(w, faction, s, m, next);
  }

  const guns = units(m.guns);
  const escort = units(m.escort);
  if (!guns.length || valueOf(guns) + valueOf(escort) < SIEGE.spent * m.worth) return disband();

  const cmds: Command[] = [];
  // (what's built meanwhile comes on in groups; home keeps its share)
  if (!ctx.threatened) {
    const idle = ctx.army.filter((u) => !ctx.used.has(u.id) && u.order.type === "idle" && armed(u) && domainOf(u) === "ground");
    const keep = SIEGE.home * (valueOf(guns) + valueOf(escort));
    const late: Unit[] = [];
    let spare = valueOf(idle) - keep;
    for (const u of idle) {
      if (spare < UNITS[u.kind].cost) continue;
      late.push(u);
      spare -= UNITS[u.kind].cost;
    }
    if (valueOf(late) >= SIEGE.group) {
      for (const u of late) {
        (u.kind === "mortar" ? m.guns : m.escort).push(u.id);
        ctx.used.add(u.id);
      }
      const to = middle(guns);
      cmds.push({ type: "attackMove", faction, unitIds: late.map((u) => u.id), x: to.x, y: to.y });
    }
  }

  // --- on the column: the Mortars stop to fire and the escort goes at it
  const near = (u: Unit) => guns.concat(escort).some((v) => dist(u.x, u.y, v.x, v.y) <= SIEGE.alarm);
  const foes = ctx.seen.filter((e) => armed(e) && near(e)).sort((a, b) => a.id - b.id);
  const here = middle(guns);
  const worth = valueOf(guns) + valueOf(escort);
  const on = valueOf(foes);
  if (on > SIEGE.rout * worth) return [...cmds, ...disband()];
  if (foes.length) {
    if (m.phase !== "shell" && on >= SIEGE.halt * worth) {
      const hop = m.hops[m.hops.length - 1]!;
      hop.cut = true;
      hop.stopped = w.tick;
      m.phase = "shell";
      m.since = w.tick;
      m.stop = here;
      m.screen = here;
      cmds.push({ type: "stop", faction, unitIds: m.guns });
    }
    if (escort.length && w.tick - m.engaged >= SIEGE.engageEvery * TICK_RATE) {
      const foe = foes.reduce((a, b) => (dist(b.x, b.y, here.x, here.y) < dist(a.x, a.y, here.x, here.y) ? b : a));
      m.engaged = w.tick;
      cmds.push({ type: "attackMove", faction, unitIds: m.escort, x: foe.x, y: foe.y });
    }
    // (the crowded Mortars back out together, one order: from there they can fire again)
    const crowded = guns.filter((u) => u.order.type !== "move" && foes.some((e) => domainOf(e) === "ground" && dist(e.x, e.y, u.x, u.y) <= SIEGE.crowd));
    if (crowded.length) {
      const c = middle(crowded);
      const f = middle(foes.filter((e) => dist(e.x, e.y, c.x, c.y) <= SIEGE.crowd + 3));
      const d = Math.max(0.1, dist(c.x, c.y, f.x, f.y));
      const to = { x: c.x + ((c.x - f.x) / d) * SIEGE.stepBack, y: c.y + ((c.y - f.y) / d) * SIEGE.stepBack };
      if (passable(w, Math.floor(to.x), Math.floor(to.y), moveClassOf("mortar")))
        cmds.push({ type: "move", faction, unitIds: crowded.map((u) => u.id), x: to.x, y: to.y });
    }
    if (m.phase === "shell") return cmds;
  }

  // --- lead: the escort gets to the screen, then the guns follow
  if (m.phase === "lead") {
    const led = !escort.length || valueOf(escort.filter((u) => dist(u.x, u.y, m.screen.x, m.screen.y) <= SIEGE.led)) * 2 >= valueOf(escort);
    if (led || w.tick - m.since >= SIEGE.leadSecs * TICK_RATE) {
      m.phase = "haul";
      m.since = w.tick;
      cmds.push({ type: "move", faction, unitIds: [...m.guns, ...m.menders], x: m.stop.x, y: m.stop.y });
    }
    return cmds;
  }

  // --- haul: the guns get there
  if (m.phase === "haul") {
    const there = guns.filter((u) => dist(u.x, u.y, m.stop.x, m.stop.y) <= SIEGE.there).length * 2 >= guns.length;
    if (there || w.tick - m.since >= SIEGE.haulSecs * TICK_RATE) {
      m.hops[m.hops.length - 1]!.stopped = w.tick;
      m.phase = "shell";
      m.since = w.tick;
    }
    return cmds;
  }

  // --- shell: they fire by themselves; the escort comes back to its screen after a chase
  const strays = escort.filter((u) => u.order.type !== "move" && dist(u.x, u.y, m.screen.x, m.screen.y) > SIEGE.leash).map((u) => u.id);
  if (strays.length) cmds.push({ type: "move", faction, unitIds: strays, x: m.screen.x, y: m.screen.y });
  const firing = guns.some((u) => u.autoTargetId !== null || u.order.type === "attack");
  if (firing || w.tick - m.since < SIEGE.settle * TICK_RATE) return cmds;
  const next = pickStop(w, faction, ctx, here, guns[0]!);
  if (!next) return [...cmds, ...disband()];
  cmds.push(...setOut(w, faction, s, m, next));
  return cmds;
}

/** Off to the next stop, the escort first. */
function setOut(w: World, faction: Faction, s: AiState, m: Memo, next: Stop): Command[] {
  m.stop = next.stop;
  m.screen = next.screen;
  m.phase = "lead";
  m.since = w.tick;
  const hop: Hop = { at: w.tick, stopped: -1, stop: next.stop, target: next.target, cut: false };
  m.hops.push(hop);
  s.strategy.siege?.onHop?.(hop);
  return m.escort.length ? [{ type: "attackMove", faction, unitIds: m.escort, x: next.screen.x, y: next.screen.y }] : [];
}

interface Stop {
  stop: P;
  screen: P;
  target: string;
}

/**
 * The next stop for a column at `from`: for the nearest building of theirs we
 * know of (their base, guessed, if none), a leg of at most SIEGE.hop toward
 * it, or else a spot SIEGE.stand off its edge, on our side and out of reach of
 * everything armed we know of. Spots are taken turning away from the straight
 * line either way, so red's choice is the mirror image of blue's. Null: there's
 * nowhere left to shell from.
 */
function pickStop(w: World, faction: Faction, ctx: SiegeContext, from: P, gun: Unit): Stop | null {
  const mc = moveClassOf(gun.kind);
  // (a building still "known" that's gone: the shells land there, and a player sees the rubble)
  const theirs = knownBuildings(w, faction)
    .filter((b) => b.faction !== faction && (!ctx.focus || b.faction === ctx.focus) && w.buildings.has(b.id))
    .map((b) => {
      const size = BUILDINGS[b.kind].size;
      return { x: b.tx + size / 2, y: b.ty + size / 2, size, kind: b.kind as string, id: b.id };
    });
  const guns = theirs.filter((b) => BUILDINGS[b.kind as "turret"].dps > 0 && BUILDINGS[b.kind as "turret"].targets !== "air");
  const clear = (p: P) => guns.every((b) => dist(b.x, b.y, p.x, p.y) >= SIEGE.clear);
  const ok = (p: P) =>
    p.x >= 1 && p.y >= 1 && p.x <= w.width - 1 && p.y <= w.height - 1 &&
    passable(w, Math.floor(p.x), Math.floor(p.y), mc) && clear(p) && canGetWithin(w, mc, gun.x, gun.y, p.x, p.y, 2);
  const targets = theirs.length
    ? [...theirs].sort((a, b) => dist(a.x, a.y, from.x, from.y) - dist(b.x, b.y, from.x, from.y) || a.id - b.id).slice(0, SIEGE.tries)
    : [{ ...ctx.enemyHqPos, size: 3, kind: "", id: 0 }];
  for (const t of targets) {
    const len = dist(t.x, t.y, from.x, from.y);
    if (len < 0.1) continue;
    const ux = (from.x - t.x) / len;
    const uy = (from.y - t.y) / len;
    const reach = SIEGE.stand + t.size / 2;
    // (nothing known and we're at the guess: it isn't there)
    if (!t.kind && len <= reach + 1) return null;
    const stopAt = (p: P, kind: string): Stop => {
      const screen = { x: p.x - ux * SIEGE.screen, y: p.y - uy * SIEGE.screen };
      return { stop: p, screen: clear(screen) ? screen : p, target: kind };
    };
    // a leg of the way
    if (len > reach + SIEGE.hop)
      for (const leg of [SIEGE.hop, SIEGE.hop * 0.7, SIEGE.hop * 0.4]) {
        const p = { x: from.x - ux * leg, y: from.y - uy * leg };
        if (ok(p)) return stopAt(p, "");
      }
    for (const turn of [0, 0.35, -0.35, 0.7, -0.7, 1.05, -1.05, 1.4, -1.4]) {
      const c = cos(turn);
      const n = sin(turn);
      const p = { x: t.x + (ux * c - uy * n) * reach, y: t.y + (ux * n + uy * c) * reach };
      if (ok(p)) return stopAt(p, t.kind);
    }
  }
  return null;
}
