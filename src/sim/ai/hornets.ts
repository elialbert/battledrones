import { TICK_RATE, UNITS } from "../balance";
import { knownBuildings } from "../fog";
import type { Command, Faction, Unit, World } from "../types";
import { dist } from "../world";
import type { AiState } from "./commander";
import { aaSources, aaStrengthAt, type Sighting } from "./intel";

/**
 * The Hornet strike (AiState.hornetStyle "strike": Marshal's Hornet Strike
 * plan, for fun). Every Hornet we build is the strike's, never the army's:
 *
 * - GATHER: they wait behind our HQ until STRIKE.wing of them stand there
 *   (the Airpads build Hornets first until then, commander.ts runPads). A
 *   real attack on the base has them out bombing it meanwhile.
 * - FLY: the wing flies up our side of the map to a free corner, then along
 *   the enemy's edge of it to a hiding spot at most STRIKE.hideReach tiles
 *   from their HQ, out of the way of the armies in the middle.
 * - PARK: it waits there for the enemy's army to come at us: once we see
 *   STRIKE.trigger worth of it on our half of the map, the wing strikes. It
 *   strikes at once if it's found (enemy anti-air by it), and after
 *   STRIKE.patience seconds in any case.
 * - STRIKE: every Hornet bombs their HQ; nothing turns them back. Once the
 *   wing is gone (or the HQ) the next one gathers.
 */

export const STRIKE = {
  /** Hornets in a wing. */
  wing: 7,
  /** The hiding spot: in from the map's edge by this many tiles… */
  inset: 2.5,
  /** …and at most this far from their HQ along the edge (a corner farther than that is pulled in toward it). */
  hideReach: 30,
  /** Enemy army (scrap) seen on our half of the map that launches the strike. */
  trigger: 800,
  /** Enemy anti-air (in Flak) by the parked wing that launches it at once. */
  found: 0.5,
  /** Seconds parked before it strikes anyway. */
  patience: 240,
  /** Gathering Hornets wait this far behind our HQ. */
  gatherBack: 4
};

type P = { x: number; y: number };
type Phase = "gather" | "fly" | "park" | "strike";

interface Memo {
  phase: Phase;
  /** The wing in flight (fly, park, strike). */
  ids: number[];
  /** Waypoints still to fly (fly). */
  route: P[];
  /** Tick it parked. */
  parked: number;
}

const memos = new WeakMap<AiState, Memo>();
function memo(s: AiState): Memo {
  let m = memos.get(s);
  if (!m) {
    m = { phase: "gather", ids: [], route: [], parked: -1 };
    memos.set(s, m);
  }
  return m;
}

/** Does this commander fly the Hornet strike? */
export const strikes = (s: AiState) => s.hornetStyle === "strike";

/** Our Hornets the strike holds (all of them, when it's on): no other tactic gives them orders. */
export function strikeHolds(w: World, faction: Faction, s: AiState): Set<number> {
  const out = new Set<number>();
  if (!strikes(s)) return out;
  for (const u of w.units.values()) if (u.faction === faction && u.kind === "hornet") out.add(u.id);
  return out;
}

/** Hornets the strike still wants built: a wing's worth while one gathers (none while one waits in its corner). */
export function strikeWants(w: World, faction: Faction, s: AiState, queued: number): number {
  if (!strikes(s)) return 0;
  const m = memo(s);
  if (m.phase === "fly" || m.phase === "park") return 0;
  const inFlight = new Set(m.ids);
  let home = 0;
  for (const u of w.units.values()) if (u.faction === faction && u.kind === "hornet" && !inFlight.has(u.id)) home++;
  return Math.max(0, STRIKE.wing - home - queued);
}

/** The strike's phase (traces and tests). */
export const strikePhase = (s: AiState): Phase => memo(s).phase;

export interface StrikeContext {
  /** Our base, and where theirs is (known, or the mirror of ours). */
  hqC: P;
  enemyHqPos: P;
  seen: readonly Unit[];
  /** Where the base is under real attack (the nearest intruder), if it is. */
  defend: P | null;
}

/** The strike's orders this pass. */
export function planStrike(w: World, faction: Faction, s: AiState, ctx: StrikeContext): Command[] {
  if (!strikes(s)) return [];
  const m = memo(s);
  const cmds: Command[] = [];
  const hornets = [...w.units.values()].filter((u) => u.faction === faction && u.kind === "hornet").sort((a, b) => a.id - b.id);
  m.ids = m.ids.filter((id) => w.units.has(id));
  const enemyHq = knownBuildings(w, faction).find((b) => b.kind === "hq" && b.faction !== faction);
  // the wing is spent, or its target is (gone where we bombed it): the next one gathers
  const done =
    m.phase === "strike" && !enemyHq && hornets.some((u) => m.ids.includes(u.id) && dist(u.x, u.y, ctx.enemyHqPos.x, ctx.enemyHqPos.y) <= 3);
  if (m.phase !== "gather" && (m.ids.length === 0 || done)) {
    m.phase = "gather";
    m.ids = [];
  }

  // --- gather behind the HQ, and set out once there's a wing
  if (m.phase === "gather") {
    const ready = hornets.filter((u) => u.hp >= 0.8 * UNITS.hornet.hp);
    if (ready.length >= STRIKE.wing) {
      m.ids = ready.slice(0, STRIKE.wing).map((u) => u.id);
      m.route = route(w, faction, ctx);
      m.phase = "fly";
    }
  }
  const gather = away(ctx.hqC, ctx.enemyHqPos, STRIKE.gatherBack);
  const flight = hornets.filter((u) => m.ids.includes(u.id));
  const waiting = hornets.filter((u) => !m.ids.includes(u.id));
  const def = ctx.defend;
  if (def) {
    // (the base under attack: the Hornets still gathering bomb what's at it)
    const go = waiting.filter((u) => !(u.order.type === "attackMove" && dist(u.order.x, u.order.y, def.x, def.y) <= 2));
    if (go.length) cmds.push({ type: "attackMove", faction, unitIds: go.map((u) => u.id), x: def.x, y: def.y });
  } else {
    const stray = waiting.filter((u) => u.order.type === "idle" && dist(u.x, u.y, gather.x, gather.y) > 2.5);
    if (stray.length) cmds.push({ type: "move", faction, unitIds: stray.map((u) => u.id), x: gather.x, y: gather.y });
  }
  const ids = flight.map((u) => u.id);
  if (!ids.length) return cmds;

  // --- fly the route, waypoint by waypoint, together
  if (m.phase === "fly") {
    const cx = flight.reduce((a, u) => a + u.x, 0) / flight.length;
    const cy = flight.reduce((a, u) => a + u.y, 0) / flight.length;
    while (m.route.length > 1 && dist(cx, cy, m.route[0]!.x, m.route[0]!.y) <= 2.5) m.route.shift();
    const to = m.route[0]!;
    if (m.route.length === 1 && dist(cx, cy, to.x, to.y) <= 2.5) {
      m.phase = "park";
      m.parked = w.tick;
    } else cmds.push({ type: "move", faction, unitIds: ids, x: to.x, y: to.y });
  }

  // --- parked: wait for their army to come at us
  if (m.phase === "park") {
    const cx = flight.reduce((a, u) => a + u.x, 0) / flight.length;
    const cy = flight.reduce((a, u) => a + u.y, 0) / flight.length;
    const ourHalf = (u: Sighting) => dist(u.x, u.y, ctx.hqC.x, ctx.hqC.y) < dist(u.x, u.y, ctx.enemyHqPos.x, ctx.enemyHqPos.y);
    const coming = ctx.seen
      .filter((e) => e.kind !== "harvester" && UNITS[e.kind].dps > 0 && ourHalf(e))
      .reduce((v, e) => v + (e.goliath ? UNITS.goliath.cost : UNITS[e.kind].cost), 0);
    const found = aaStrengthAt(aaSources(w, faction, ctx.seen), cx, cy) >= STRIKE.found;
    if (coming >= STRIKE.trigger || found || w.tick - m.parked >= STRIKE.patience * TICK_RATE) m.phase = "strike";
    else {
      // (back on the spot if something shoved them off it)
      const spot = m.route[m.route.length - 1]!;
      const off = flight.filter((u) => u.order.type === "idle" && dist(u.x, u.y, spot.x, spot.y) > 2.5);
      if (off.length) cmds.push({ type: "move", faction, unitIds: off.map((u) => u.id), x: spot.x, y: spot.y });
    }
  }

  // --- strike: everything on their HQ
  if (m.phase === "strike") {
    if (enemyHq && w.buildings.has(enemyHq.id)) {
      const go = flight.filter((u) => !(u.order.type === "attack" && u.order.targetId === enemyHq.id));
      if (go.length) cmds.push({ type: "attack", faction, unitIds: go.map((u) => u.id), targetId: enemyHq.id });
    } else {
      // (not seen yet: fly where it must be, and bomb it once it is)
      const go = flight.filter((u) => !(u.order.type === "move" && dist(u.order.x, u.order.y, ctx.enemyHqPos.x, ctx.enemyHqPos.y) < 1));
      if (go.length) cmds.push({ type: "move", faction, unitIds: go.map((u) => u.id), x: ctx.enemyHqPos.x, y: ctx.enemyHqPos.y });
    }
  }
  return cmds;
}

/** `d` tiles from `from`, away from `to`. */
function away(from: P, to: P, d: number): P {
  const len = Math.max(1, dist(from.x, from.y, to.x, to.y));
  return { x: from.x - ((to.x - from.x) / len) * d, y: from.y - ((to.y - from.y) / len) * d };
}

/**
 * The way to the hiding spot: up our side of the map to the free corner
 * with the least anti-air we know of on the way (by id, a tie), then along
 * the enemy's edge to a spot within STRIKE.hideReach of their HQ.
 */
function route(w: World, faction: Faction, ctx: StrikeContext): P[] {
  const i = STRIKE.inset;
  const corners: P[] = [
    { x: i, y: i },
    { x: w.width - i, y: i },
    { x: i, y: w.height - i },
    { x: w.width - i, y: w.height - i }
  ];
  // (the two corners nearest neither HQ: on these maps the HQs hold the other two)
  const free = corners
    .map((c) => ({ c, near: Math.min(dist(c.x, c.y, ctx.hqC.x, ctx.hqC.y), dist(c.x, c.y, ctx.enemyHqPos.x, ctx.enemyHqPos.y)) }))
    .sort((a, b) => b.near - a.near)
    .slice(0, 2)
    .map((x) => x.c);
  const aa = aaSources(w, faction, ctx.seen);
  const risk = (c: P) => {
    let r = 0;
    for (let k = 1; k <= 8; k++) {
      const t = k / 8;
      r += aaStrengthAt(aa, ctx.hqC.x + (c.x - ctx.hqC.x) * t, ctx.hqC.y + (c.y - ctx.hqC.y) * t);
      r += aaStrengthAt(aa, c.x + (ctx.enemyHqPos.x - c.x) * t, c.y + (ctx.enemyHqPos.y - c.y) * t);
    }
    return r;
  };
  const corner = free.sort((a, b) => risk(a) - risk(b) || a.x - b.x || a.y - b.y)[0]!;
  const d = dist(corner.x, corner.y, ctx.enemyHqPos.x, ctx.enemyHqPos.y);
  if (d <= STRIKE.hideReach) return [corner];
  const k = 1 - STRIKE.hideReach / d;
  return [corner, { x: corner.x + (ctx.enemyHqPos.x - corner.x) * k, y: corner.y + (ctx.enemyHqPos.y - corner.y) * k }];
}
