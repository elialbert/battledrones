/**
 * Posture: how much Marshal invests in its army, its economy and its tech
 * (POSTURE-PLAN.md).
 *
 * Each plan has a timeline of shares (POSTURE_CURVES): its intended emphasis
 * over the game. On Hard and Brutal, what scouting has shown nudges the
 * shares off that curve: an army bigger than ours or a raid at home toward
 * army, an enemy out-expanding us or sitting at home toward whatever lean
 * we're already winning with (the greed rule), and so on. Every nudge is
 * bounded (POSTURE.pull from the curve), the shares move a little per think
 * (POSTURE.step), and a lean, once taken, holds for POSTURE.hold seconds.
 *
 * Stage 0: worked out every think and traced, read by nothing.
 *
 * Fair: the reads come from what Marshal has seen (seenEnemies, its own
 * sightings memory, knownBuildings) and its own faction's numbers, never the
 * enemy's scrap, income or units out of sight.
 */
import { BUILDINGS, TICK_RATE, UNITS } from "../balance";
import { knownBuildings } from "../fog";
import { dist } from "../world";
import type { Faction, Unit, UnitKind, World } from "../types";
import type { AiState } from "./commander";

export type Area = "army" | "economy" | "tech";
export type Shares = Record<Area, number>;
const AREAS: readonly Area[] = ["army", "economy", "tech"];

export interface Posture extends Shares {
  /** The plan's curve right now, before scouting nudged it. */
  base: Shares;
  /** Where the reads would put the shares (the shares move toward it by POSTURE.step a think). */
  target: Shares;
  /** The lean committed to, and since when (tick). */
  lean: Area | null;
  leanSince: number;
  /** When it was worked out (tick). */
  tick: number;
  /** Reads that moved it this think (trace only: never read by decisions). */
  reasons: string[];
  /** What the shares would ask for (stage 0: trace only). */
  wantFactories: number;
  depotCap: number;
  /** This think's reads (trace only), when scouting. */
  reads?: PostureReads;
}

/** What posture remembers between thinks (not traced). */
export interface PostureMemory {
  plan: string;
  /** Scouting nudges the curve (Hard, Brutal); otherwise the curve alone. */
  scouting: boolean;
  /** Our own delivered scrap, sampled each think: [tick, total]. */
  income: [number, number][];
  /** Enemy harvesters seen: id → tick last seen. */
  miners: Map<number, number>;
  /** Last tick an armed enemy was seen on our half of the map. */
  pressure: number;
}

export const POSTURE = {
  /** No share moves further than this from the plan's curve. */
  pull: 0.25,
  /** …nor faster than this a second (a full pull takes ~20 s of a steady read: one sighting moves it a little). */
  step: 0.0125,
  /** A lean holds this long (seconds) before another can replace it. */
  hold: 45,
  /** A share this far above the curve is a lean. */
  leanBy: 0.1,
  /** …and a curve with one share this big leans that way by itself (Rush, Boom). */
  planLean: 0.6,
  /** Enemy army value below this isn't a read (DOCTRINE.minRead). */
  minRead: 800,
  /**
   * Outnumbered: our army under this share of theirs starts it, and at `full` it's the whole nudge.
   * Graded, not a cliff: replay.json sat at 0.75–0.85 for a minute and a cut at 0.8 flipped every few thinks.
   */
  outnumbered: { from: 0.9, full: 0.6 },
  /** Safely ahead: our army this many times theirs, graded the same way. */
  ahead: { from: 1.3, full: 1.8 },
  /** "Could just win": the finishing push's edge (Brutal's fight.finish). */
  finish: 1.5,
  /** …against no more than this many known defences round their HQ. */
  fewDefences: 2,
  /** Defences this close (tiles) to their HQ count. */
  defenceRadius: 10,
  /** Ahead on economy: our income this many times our estimate of theirs. */
  incomeEdge: 1.1,
  /** Seconds of income averaged. */
  incomeWindow: 60,
  /** No armed enemy on our half this long (seconds) while their army reads small: they're sitting at home. */
  quiet: 90,
  /** An enemy harvester counts toward their income this long (seconds) after it was seen. */
  minerMemory: 60,
  /** Scrap a second one busy factory spends (Fab ~22, Airpad ~25, Bay ~18). */
  perFactory: 22,
  maxFactories: 8,
  /** Depot cap = round(economy × this): Boom's .7 → 4, Balanced's .45 → 3. */
  depotK: 5.7
};

/** Nudge sizes, by read. */
const NUDGE = { attacked: 0.25, outnumbered: 0.15, teching: 0.05, ahead: 0.05, fieldsLow: 0.1, outGreed: 0.1, closeOut: 0.1, punish: 0.05 };

type Key = [seconds: number, army: number, economy: number, tech: number];
const k = (t: number, a: number, e: number, x: number): Key => [t, a, e, x];
const BALANCED: Key[] = [k(0, 0.45, 0.45, 0.1), k(120, 0.5, 0.3, 0.2), k(240, 0.55, 0.25, 0.2), k(420, 0.55, 0.2, 0.25)];
const RUSH: Key[] = [k(0, 0.75, 0.25, 0), k(120, 0.75, 0.2, 0.05), k(240, 0.6, 0.25, 0.15), k(420, 0.55, 0.25, 0.2)];
const BOOM: Key[] = [k(0, 0.25, 0.7, 0.05), k(120, 0.35, 0.55, 0.1), k(240, 0.5, 0.3, 0.2), k(420, 0.55, 0.2, 0.25)];
const AIR: Key[] = [k(0, 0.45, 0.35, 0.2), k(120, 0.5, 0.3, 0.2), k(240, 0.55, 0.2, 0.25), k(420, 0.55, 0.2, 0.25)];
const TURTLE: Key[] = [k(0, 0.35, 0.4, 0.25), k(120, 0.4, 0.3, 0.3), k(240, 0.5, 0.2, 0.3), k(420, 0.5, 0.2, 0.3)];

/**
 * Each Marshal plan's shares over time (seconds → shares, linear between keys).
 * The fun plans' curves follow what their own machinery already does, so the
 * posture doesn't fight it: Hornet Strike techs to its bombers, Juggernaut to
 * its Gantry, the Wall's turrets are economy-side spending.
 */
export const POSTURE_CURVES: Record<string, readonly Key[]> = {
  balanced: BALANCED,
  feint: BALANCED,
  rush: RUSH,
  boom: BOOM,
  greed: BOOM,
  landgrab: BOOM,
  airswarm: AIR,
  skyforce: AIR,
  ironclad: TURTLE,
  turtle: TURTLE,
  siege: TURTLE,
  wall: TURTLE,
  strike: [k(0, 0.4, 0.35, 0.25), k(120, 0.4, 0.3, 0.3), k(240, 0.5, 0.2, 0.3), k(420, 0.55, 0.2, 0.25)],
  juggernaut: [k(0, 0.3, 0.35, 0.35), k(120, 0.3, 0.3, 0.4), k(240, 0.4, 0.25, 0.35), k(420, 0.5, 0.2, 0.3)]
};

/** A plan's curve at `seconds`. */
export function curveAt(plan: string, seconds: number): Shares {
  const keys = POSTURE_CURVES[plan] ?? BALANCED;
  let i = 0;
  while (i < keys.length - 1 && keys[i + 1]![0] <= seconds) i++;
  const a = keys[i]!;
  const b = keys[i + 1];
  const f = b ? Math.max(0, Math.min(1, (seconds - a[0]) / (b[0] - a[0]))) : 0;
  const at = (j: 1 | 2 | 3) => a[j] + (b ? (b[j] - a[j]) * f : 0);
  return { army: at(1), economy: at(2), tech: at(3) };
}

/** What scouting says, this think (all fog-limited: postureReads). */
export interface PostureReads {
  ourArmy: number;
  /** Remembered enemy army (AiState.sightings): 0 when nothing is remembered. */
  enemyArmy: number;
  /** A raid at home, or a Depot of ours lost in the last 45 s. */
  attacked: boolean;
  ourDepots: number;
  enemyDepots: number;
  /** Seconds since an armed enemy was last seen on our half. */
  quietFor: number;
  /** Tech-lab units, a Goliath, a Tech Lab or Gantry seen. */
  teching: boolean;
  /** Scrap/s: ours delivered over the last minute; theirs estimated from what we've seen. */
  ourIncome: number;
  enemyIncome: number;
  /** Turrets and SAM sites known round their HQ. */
  enemyDefences: number;
  fieldsLow: boolean;
}

export function newPosture(plan: string, scouting: boolean): { posture: Posture; memo: PostureMemory } {
  const base = curveAt(plan, 0);
  return {
    posture: { ...base, base, target: { ...base }, tick: 0, lean: null, leanSince: 0, reasons: [], wantFactories: 1, depotCap: depotCapOf(base.economy) },
    memo: { plan, scouting, income: [], miners: new Map(), pressure: 0 }
  };
}

const depotCapOf = (economy: number) => Math.max(1, Math.round(economy * POSTURE.depotK));

/**
 * Move `amount` of share into `to`, from `from` in order (each giving what it
 * can), every share kept within POSTURE.pull of `base` and in [0, 1]. Sums stay 1.
 */
function shift(t: Shares, base: Shares, to: Area, amount: number, from: readonly Area[]): void {
  let room = Math.min(amount, Math.min(1, base[to] + POSTURE.pull) - t[to]);
  for (const d of from) {
    if (room <= 1e-9) break;
    const give = Math.min(room, t[d] - Math.max(0, base[d] - POSTURE.pull));
    if (give <= 0) continue;
    t[d] -= give;
    t[to] += give;
    room -= give;
  }
}

/** 0 at `from`, rising to 1 at `full` (either direction). */
function ramp(x: number, from: number, full: number): number {
  return Math.max(0, Math.min(1, (x - from) / (full - from)));
}

/** The lean the shares show, else the one the plan's curve has by itself. */
function leanOf(p: Shares, base: Shares): Area | null {
  let best: Area | null = null;
  let by = POSTURE.leanBy;
  for (const a of AREAS) if (p[a] - base[a] > by) { best = a; by = p[a] - base[a]; }
  if (best) return best;
  for (const a of AREAS) if (base[a] >= POSTURE.planLean) return a;
  return null;
}

/**
 * The next posture from the last one and this think's reads (null: the curve
 * alone); `spend`, our income (scrap/s). Pure: the same inputs give the same posture.
 */
export function reviewPosture(prev: Posture, plan: string, tick: number, reads: PostureReads | null, spend = reads?.ourIncome ?? 0): Posture {
  const base = curveAt(plan, tick / TICK_RATE);
  const target: Shares = { ...base };
  const reasons: string[] = [];
  const lean = prev.lean;
  if (reads) {
    const known = reads.enemyArmy >= POSTURE.minRead;
    if (reads.attacked) {
      reasons.push("attacked");
      shift(target, base, "army", NUDGE.attacked, ["tech", "economy"]);
    } else {
      const ratio = known ? reads.ourArmy / reads.enemyArmy : 1;
      const down = ramp(ratio, POSTURE.outnumbered.from, POSTURE.outnumbered.full);
      if (down > 0) {
        reasons.push("outnumbered");
        shift(target, base, "army", NUDGE.outnumbered * down, ["tech", "economy"]);
      }
      // the greed rule: an enemy out-expanding us or sitting at home amplifies the lean we're winning with
      const greedy = reads.enemyDepots > reads.ourDepots || (reads.quietFor >= POSTURE.quiet && reads.enemyArmy < reads.ourArmy);
      const closeOut = greedy && lean === "army" && reads.ourArmy >= POSTURE.finish * reads.enemyArmy && reads.enemyDefences <= POSTURE.fewDefences;
      // (rushing and able to win: no banking the lead, it goes in)
      const up = closeOut ? 0 : ramp(ratio, POSTURE.ahead.from, POSTURE.ahead.full);
      if (up > 0) {
        reasons.push("ahead");
        shift(target, base, "economy", NUDGE.ahead * up, ["army"]);
        shift(target, base, "tech", NUDGE.ahead * up, ["army"]);
      }
      if (reads.teching) {
        const hit = reads.ourArmy > reads.enemyArmy;
        reasons.push(hit ? "teching:hit" : "teching:match");
        shift(target, base, hit ? "army" : "tech", NUDGE.teching, ["economy"]);
      }
      if (reads.fieldsLow) {
        reasons.push("fieldsLow");
        shift(target, base, "economy", NUDGE.fieldsLow, ["tech", "army"]);
      }
      if (greedy) {
        if (lean === "economy" && reads.ourIncome >= POSTURE.incomeEdge * reads.enemyIncome) {
          reasons.push("greedy:outgreed");
          shift(target, base, "economy", NUDGE.outGreed, ["army", "tech"]);
        } else if (closeOut) {
          reasons.push("greedy:closeOut");
          shift(target, base, "army", NUDGE.closeOut, ["economy", "tech"]);
        } else {
          reasons.push("greedy:punish");
          shift(target, base, "army", NUDGE.punish, ["economy", "tech"]);
        }
      }
    }
  }
  // toward the target, at most POSTURE.step a second per share (the whole move scaled, so the sum holds)
  const move: Shares = { army: target.army - prev.army, economy: target.economy - prev.economy, tech: target.tech - prev.tech };
  const most = Math.max(...AREAS.map((a) => Math.abs(move[a])));
  const step = (POSTURE.step * Math.max(0, tick - prev.tick)) / TICK_RATE;
  const f = most > step ? step / most : 1;
  const next: Shares = { army: prev.army + move.army * f, economy: prev.economy + move.economy * f, tech: prev.tech + move.tech * f };
  // the curve itself moves: keep within its bounds
  for (const a of AREAS) next[a] = Math.max(Math.max(0, base[a] - POSTURE.pull), Math.min(base[a] + POSTURE.pull, next[a]));
  const sum = next.army + next.economy + next.tech;
  for (const a of AREAS) next[a] /= sum;
  // a lean, once taken, holds
  const now = leanOf(next, base);
  const held = now !== prev.lean && prev.lean !== null && tick - prev.leanSince < POSTURE.hold * TICK_RATE;
  const committed = held ? prev.lean : now;
  return {
    ...next,
    base,
    target,
    tick,
    lean: committed,
    leanSince: committed === prev.lean ? prev.leanSince : tick,
    reasons,
    ...(reads ? { reads } : {}),
    wantFactories: Math.max(1, Math.min(POSTURE.maxFactories, Math.ceil((next.army * spend) / POSTURE.perFactory))),
    depotCap: depotCapOf(next.economy)
  };
}

const TECH_KINDS = new Set<UnitKind>((Object.keys(UNITS) as UnitKind[]).filter((u) => UNITS[u].requires === "tech-lab" || u === "goliath"));

/** The commander's view this think, for postureReads. */
export interface PostureView {
  seen: readonly Unit[];
  armyValue: number;
  enemyArmy: number;
  threatened: boolean;
  home: { x: number; y: number };
  enemyHome: { x: number; y: number };
  enemyHq: { x: number; y: number };
  focus: Faction | null;
  fieldsLow: boolean;
}

/** This think's reads, from what `faction` has seen (fair: never the enemy's own numbers). */
export function postureReads(w: World, faction: Faction, s: AiState, memo: PostureMemory, v: PostureView): PostureReads {
  const rival = (f: Faction) => f !== faction && (!v.focus || f === v.focus);
  // our income: our own delivered scrap over the last minute
  const delivered = w.factions[faction].stats.scrapHarvested;
  memo.income.push([w.tick, delivered]);
  while (memo.income.length > 1 && w.tick - memo.income[0]![0] > POSTURE.incomeWindow * TICK_RATE) memo.income.shift();
  const [t0, d0] = memo.income[0]!;
  const ourIncome = w.tick > t0 ? ((delivered - d0) * TICK_RATE) / (w.tick - t0) : 0;
  // theirs: the harvesters we've seen lately (at least the drop-offs we know of times our crew per drop-off),
  // at our own rate per harvester
  for (const e of v.seen) if (e.kind === "harvester" && rival(e.faction)) memo.miners.set(e.id, w.tick);
  for (const [id, t] of memo.miners) if (w.tick - t > POSTURE.minerMemory * TICK_RATE) memo.miners.delete(id);
  let ourMiners = 0;
  for (const u of w.units.values()) if (u.faction === faction && u.kind === "harvester") ourMiners++;
  let ourDepots = 0;
  let ourDrops = 0;
  for (const b of w.buildings.values())
    if (b.faction === faction) {
      if (b.kind === "depot") ourDepots++;
      if (b.kind === "depot" || b.kind === "hq") ourDrops++;
    }
  const known = knownBuildings(w, faction).filter((b) => rival(b.faction));
  const enemyDepots = known.filter((b) => b.kind === "depot").length;
  const enemyDrops = enemyDepots + 1; // (and their HQ)
  const perMiner = ourMiners ? ourIncome / ourMiners : 0;
  const theirMiners = Math.max(memo.miners.size, enemyDrops * (ourDrops ? ourMiners / ourDrops : 0));
  // pressure: an armed enemy on our half
  const armed = (u: Unit) => u.kind !== "harvester" && UNITS[u.kind].dps > 0;
  for (const e of v.seen)
    if (rival(e.faction) && armed(e) && dist(e.x, e.y, v.home.x, v.home.y) < dist(e.x, e.y, v.enemyHome.x, v.enemyHome.y)) memo.pressure = w.tick;
  let teching = known.some((b) => b.kind === "tech-lab" || b.kind === "gantry");
  if (!teching) teching = v.seen.some((e) => rival(e.faction) && TECH_KINDS.has(e.kind));
  if (!teching) for (const e of s.sightings?.values() ?? []) if (rival(e.faction) && TECH_KINDS.has(e.kind)) { teching = true; break; }
  const enemyDefences = known.filter(
    (b) => (b.kind === "turret" || b.kind === "sam-site") && dist(b.tx + BUILDINGS[b.kind].size / 2, b.ty + BUILDINGS[b.kind].size / 2, v.enemyHq.x, v.enemyHq.y) <= POSTURE.defenceRadius
  ).length;
  return {
    ourArmy: v.armyValue,
    enemyArmy: v.enemyArmy,
    attacked: v.threatened || (s.depotsLost?.length ?? 0) > 0,
    ourDepots,
    enemyDepots,
    quietFor: (w.tick - memo.pressure) / TICK_RATE,
    teching,
    ourIncome,
    enemyIncome: theirMiners * perMiner,
    enemyDefences,
    fieldsLow: v.fieldsLow
  };
}

/** Once a think (ai/commander.ts): the posture from the plan's curve and, scouting, the reads. */
export function updatePosture(w: World, faction: Faction, s: AiState, v: PostureView): void {
  const memo = s.postureMemo;
  if (!s.posture || !memo) return;
  // (read either way, for the trace and the income; acted on only when scouting)
  const reads = postureReads(w, faction, s, memo, v);
  s.posture = reviewPosture(s.posture, memo.plan, w.tick, memo.scouting ? reads : null, reads.ourIncome);
}
