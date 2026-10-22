/**
 * Marshal (APM-BOTS.md): a bot built to play under an actions-per-minute
 * cap, the way a human does. Two speeds make it better or worse:
 *
 *  - how fast it acts: the APM cap (ai/apm.ts) its seat wears, by default
 *    its difficulty's (MARSHAL);
 *  - how fast it thinks: the commander's plan (commander.ts) every `think`
 *    seconds, and a look at every fight every `react` seconds.
 *
 * The plan is the stock commander's: build order, counters, waves, drawn
 * for each game from MARSHAL_PLANS (a stock personality, or its own Turtle
 * or Greed on top of one). What differs is how it gives orders:
 *
 *  - **Only orders that change something.** An order to a unit already doing
 *    it (the same target, a destination within a tile or two, a Mender within
 *    reach of where it's wanted) is dropped before it costs an action.
 *  - **Ranked wants that wait.** Orders are ranked (dodging calldowns and
 *    pulling out of fights, the economy, the finishing push, production,
 *    focus fire, then the plan's army orders), and the cap spends from the
 *    top. What it can't pay for yet waits (`sent`) until the plan or the next
 *    look at the fights replaces it, so an order planned on a tick with no
 *    action to spare isn't lost.
 *  - **Fights are re-planned while they happen.** Focus fire on what dies
 *    fastest for the harm it does, spread so it doesn't overkill and only
 *    switched for a much better target; hurt expensive units step back; and
 *    a fight that's lost, away from home, is broken off.
 *  - **It finishes a won game.** Once its army is twice the enemy army it
 *    has seen lately, everything attack-moves on the enemy's buildings, one
 *    order every few seconds; a capped commander otherwise sits on a won game
 *    till time runs out.
 *
 * It reads what the commander reads: its own side, and the enemy only
 * through seenEnemies, knownBuildings and visible tiles. No income handicap.
 */
import { BUILDINGS, TICK_RATE, UNITS } from "../balance";
import { isVisible, knownBuildings } from "../fog";
import type { Command, Faction, Unit, World } from "../types";
import { buildingCenter, dist, domainOf, hqOf } from "../world";
import { STRATEGIES, createAiState, tickAi, type Difficulty, type Strategy, type StrategyName } from "./commander";
import { USELESS, effectivenessVs, seenEnemies } from "./intel";
import { dodgingUnits } from "./powers";
import type { Bot } from "./bots";
import { hash32 } from "../rand";
import { pickAiOpener } from "../openers";

export interface MarshalOptions {
  /** Seconds between the commander's planning passes. */
  think: number;
  /** Seconds between looks at the fights (0: no fight micro). */
  react: number;
  /** The plan it follows (MARSHAL_PLANS). */
  strategy: PlanName;
  /**
   * Actions a minute it may spend on fight micro (breaking off, stepping
   * back, focus fire), out of what its cap allows: how sharp it is in a
   * fight, apart from how well it runs its base. Unlimited if left out.
   */
  microApm?: number;
  /** Play the plan's fast-expanding version, if it has one (MARSHAL_PLANS). */
  fast?: boolean;
  /** Seconds of peace: no raids, waves or finishing push before this. */
  holdUntil?: number;
  /** Changes to whichever plan it plays (MARSHAL: Hard's economy). */
  tweak?: Partial<Strategy>;
  /** Changes to how it fights (FIGHT). */
  fight?: Partial<Fight>;
}

export type PlanName = StrategyName | "turtle" | "greed";

/**
 * The game plans Marshal picks from: the stock personalities, and two of its
 * own built on one of them (`base`: its opener and the tables keyed by
 * personality, ai/goliath.ts and ai/airlift.ts).
 */
export const MARSHAL_PLANS: Record<PlanName, { base: StrategyName; label: string; tweak?: Partial<Strategy>; fast?: Partial<Strategy> }> = {
  balanced: { base: "balanced", label: "Balanced", fast: fastDepot(["fab-plant", "depot", "airpad", "turret", "tech-lab", "assembly-bay", "turret", "radar"]) },
  /** (no fast version: Rush is the plan that skips the economy; with a depot it beat the rest of the field more often) */
  rush: { base: "rush", label: "Rush" },
  airswarm: { base: "airswarm", label: "Air Swarm", fast: fastDepot(["airpad", "depot", "fab-plant", "turret", "tech-lab", "airpad"]) },
  boom: { base: "boom", label: "Boom", fast: fastDepot(["fab-plant", "depot", "turret", "tech-lab", "airpad", "turret", "radar", "sam-site"]) },
  skyforce: { base: "skyforce", label: "Skyforce" },
  ironclad: { base: "ironclad", label: "Ironclad", fast: fastDepot(["fab-plant", "depot", "turret", "tech-lab", "assembly-bay", "airpad", "fab-plant", "sam-site"]) },
  /**
   * Turrets and a SAM round home, heavy tech and a depot behind them, no
   * raids, and one army big enough to end it. (Against stock Balanced at
   * 14 APM: 72% of 36 games; 33% with five towers, a radar and only the
   * usual four harvesters: towers cost actions as well as scrap.)
   */
  turtle: {
    base: "ironclad",
    label: "Turtle",
    tweak: {
      buildOrder: ["fab-plant", "turret", "tech-lab", "depot", "sam-site", "turret", "fab-plant", "radar"],
      harvesters: 5,
      assaultValue: 3000,
      harassGroup: Infinity
    },
    fast: fastDepot(["fab-plant", "turret", "depot", "tech-lab", "sam-site", "turret", "fab-plant", "radar"])
  },
  /** Two depots before anything else, a harvester for each, then a late push. (78% at 14 APM; 56% with a turret and the Tech Lab between the depots.) */
  greed: {
    base: "boom",
    label: "Greed",
    tweak: {
      buildOrder: ["fab-plant", "depot", "depot", "turret", "tech-lab", "fab-plant", "airpad", "sam-site"],
      harvesters: 6,
      assaultValue: 2400,
      harassGroup: Infinity
    }
  }
};

/**
 * A plan's fast-expanding version (`fast`): a depot by the first field right
 * after the first factory, and a fifth harvester. Under a budget of actions
 * the economy is what wins: every plan but Rush and Greed gained 10 to 20
 * points with it (APM-BOTS.md, "Retuning the levels").
 */
function fastDepot(buildOrder: Strategy["buildOrder"]): Partial<Strategy> {
  return { buildOrder, harvesters: 5 };
}

/**
 * The plans each difficulty picks from, at random for each game (APM-BOTS.md,
 * "Retuning the levels"). Easy plays the slow plans, no Rush and no Greed (a
 * beginner gets a few minutes' peace, and Greed is the strongest plan);
 * Normal all of them but Skyforce (an all-air plan needs more hands, and it
 * won 27% of a round robin at 50 APM); Hard the four strongest.
 */
export const MARSHAL_POOL: Record<Difficulty, PlanName[]> = {
  easy: ["balanced", "boom", "turtle"],
  casual: ["balanced", "boom", "turtle", "airswarm"],
  normal: ["balanced", "rush", "airswarm", "boom", "ironclad", "turtle", "greed"],
  hard: ["balanced", "airswarm", "ironclad", "greed"],
  brutal: ["balanced", "airswarm", "ironclad", "greed"]
};

/**
 * What every plan adds to its personality: an economy for a budget of
 * actions. A bank is spent down (each order buys more once scrap piles up),
 * and depots follow the mining (APM-BOTS.md: against stock Balanced, Normal
 * went from 67% to 85% of 60 games, mining 2530 scrap a minute, not 1960).
 */
export const MARSHAL_ECONOMY: Partial<Strategy> = { spendDown: true, depotReach: 5 };

/** A plan as the commander's personality it plays (`fast`: its fast-expanding version, if it has one). */
export const planStrategy = (name: PlanName, fast = false): Strategy => {
  const p = MARSHAL_PLANS[name];
  return { ...STRATEGIES[p.base], ...MARSHAL_ECONOMY, ...p.tweak, ...(fast ? p.fast : undefined), label: p.label };
};

/** The plan a Marshal with this seed draws (from `pool`: the plans the match rules allow). */
export function marshalPlan(seed: number, difficulty: Difficulty, pool: readonly PlanName[] = MARSHAL_POOL[difficulty]): PlanName {
  return pool.length ? pool[hash32(seed, 0x6d61) % pool.length]! : "balanced";
}

/**
 * Each difficulty: how fast it thinks and acts, fight micro's share of its
 * actions, whether it plays the fast-expanding plans, and its seconds of
 * peace. `burst` is how many actions its cap banks (ai/apm.ts; APM_BURST if
 * left out): Brutal's `apm` plus `burst` is 120, so no minute of a game sees
 * more than 120 actions. Fight micro never gives more than one order at a
 * time (MICRO_BURST), so even Brutal's is at most 2 a second, a human's pace.
 * Brutal also plays every plan with a bigger economy and army (`tweak`) and
 * fights its own way (`fight`). Each level beats the one below it 87–99% of
 * 60 games. APM-BOTS.md ("Retuning the levels", "Hard, harder", "Five
 * levels") has the numbers.
 */
export const MARSHAL: Record<
  Difficulty,
  {
    think: number; react: number; apm: number; burst?: number; microApm: number; fast: boolean; holdUntil: number;
    tweak?: Partial<Strategy>; fight?: Partial<Fight>;
  }
> = {
  easy: { think: 4, react: 3, apm: 10, microApm: 3, fast: false, holdUntil: 300 },
  // (between Easy and Normal: three minutes' peace, the slow plans and Air Swarm)
  casual: { think: 3, react: 2, apm: 18, microApm: 8, fast: false, holdUntil: 180 },
  normal: { think: 2, react: 1, apm: 30, microApm: 20, fast: true, holdUntil: 0 },
  // (Hard before Brutal took its place, at 80 actions a minute: at 120 it beat Normal 99%, and lost only 39% to Brutal)
  hard: { think: 1.5, react: 0.5, apm: 80, microApm: 60, fast: true, holdUntil: 0 },
  // (a plan every 2 s: under the strict cap, a plan every 1.5 s lost 29% to it)
  brutal: {
    think: 2, react: 0.5, apm: 115, burst: 5, microApm: 120, fast: true, holdUntil: 0,
    // twelve harvesters (and one per depot), waves at 2500, factories as soon as scrap piles up
    tweak: { harvesters: 12, assaultValue: 2500, expandEarly: true },
    // a lost fight broken off sooner, and stayed out of longer; the finishing push at 1.5× the enemy army
    // seen; a shooter switches to a target twice as good (not 3×)
    fight: { breakOff: 0.5, retreatHold: 20, finish: 1.5, switch: 2 }
  }
};

/** Orders by rank: the cap spends from the top. */
const enum Rank {
  Dodge,
  Retreat,
  Economy,
  Push,
  Production,
  Focus,
  Army,
  Other
}

interface Want {
  rank: Rank;
  cmd: Command;
  /** From the commander's plan (kept until sent or replanned); else the fight micro's (kept till the next look). */
  planned: boolean;
  /** The finishing push (kept until sent). */
  push?: boolean;
}

/** Destinations this close count as the same order. */
const SAME_SPOT = 1.5;
/** …and for Menders, which heal anything in reach. */
const MENDER_SLACK = 4;
/** Fight micro looks this far round a fight for both sides' strength. */
const FIGHT_RADIUS = 8;
/** Break off when our strength is under this share of theirs (Lanchester: dps × hp). */
const BREAK_OFF = 0.3;
/** Fights this close to home are never broken off: there's nowhere to go. */
const HOME_STAND = 12;
/** A unit worth at least this steps back when hurt below HURT. */
const PRECIOUS = 250;
const HURT = 0.25;
/** A target with this much damage aimed at it (in seconds to kill) takes no more shooters. */
const OVERKILL_SECS = 1.5;
/** Switch a shooter's target only for one this much better (each switch costs an action, and another when it ends). */
const SWITCH = 3;
/** Finish when our army is this many times the enemy army seen lately, and worth at least FINISH_MIN. */
const FINISH = 2;
const FINISH_MIN = 3000;
/** Seconds between the finishing push's orders. */
const FINISH_EVERY = 10;
/** An enemy unit unseen this long no longer counts toward its army (ticks). */
const SIGHTING_TTL = 90 * TICK_RATE;
/** Seconds a fight it broke off keeps its units out of the plan's waves. */
const RETREAT_HOLD = 8;

/** How it fights, by default (MarshalOptions.fight changes it: Hard's). */
const FIGHT = {
  breakOff: BREAK_OFF,
  homeStand: HOME_STAND,
  retreatHold: RETREAT_HOLD,
  precious: PRECIOUS,
  hurt: HURT,
  overkill: OVERKILL_SECS,
  switch: SWITCH,
  finish: FINISH,
  finishMin: FINISH_MIN,
  finishEvery: FINISH_EVERY
};
export type Fight = typeof FIGHT;

/** The fight micro's budget: how many actions it can bank (one: a fight order at most every 60 / microApm seconds). */
const MICRO_BURST = 1;
const PER_ACTION = 60 * TICK_RATE;

const unitsOf = (c: Command): number[] | null => ("unitIds" in c ? c.unitIds : null);

function rankOf(c: Command, dodging: Set<number>): Rank {
  switch (c.type) {
    case "move":
      return c.unitIds.every((id) => dodging.has(id)) ? Rank.Dodge : Rank.Army;
    case "calldown":
      return Rank.Retreat;
    case "harvest":
    case "placeBuilding":
    case "cancelBuilding":
      return Rank.Economy;
    case "produce":
      return c.unit === "harvester" ? Rank.Economy : Rank.Production;
    case "startBuilding":
    case "cancelProduce":
    case "sell":
      return Rank.Production;
    case "attack":
    case "attackMove":
    case "stop":
    case "board":
    case "unload":
    case "anchor":
    case "packUp":
    case "lift":
      return Rank.Army;
    default:
      return Rank.Other;
  }
}

/** Is `u` already doing what `c` would tell it? */
function alreadyDoing(u: Unit, c: Command): boolean {
  const o = u.order;
  switch (c.type) {
    case "move":
    case "attackMove": {
      // (Menders heal whatever's in reach: they follow the army loosely, not step for step)
      const near = u.kind === "mender" ? MENDER_SLACK : SAME_SPOT;
      if (o.type === c.type && dist(o.x, o.y, c.x, c.y) <= near) return true;
      return c.type === "attackMove" && o.type === "idle" && dist(u.x, u.y, c.x, c.y) <= near; // (already there)
    }
    case "attack":
      return o.type === "attack" && o.targetId === c.targetId;
    case "harvest":
      return o.type === "harvest" && dist(o.fieldX + 0.5, o.fieldY + 0.5, c.x, c.y) <= SAME_SPOT;
    case "stop":
      return o.type === "idle";
    case "board":
      return o.type === "board" && o.carrierId === c.carrierId;
    default:
      return false; // (anything else always changes something)
  }
}

export function marshal(side: Faction, seed: number, difficulty: Difficulty, opts: MarshalOptions): Bot {
  const plan = MARSHAL_PLANS[opts.strategy];
  const K: Fight = { ...FIGHT, ...opts.fight };
  const s = createAiState(plan.base, difficulty, seed, { ...planStrategy(opts.strategy, opts.fast), holdUntil: opts.holdUntil, ...opts.tweak });
  s.fair = true;
  s.interval = opts.think;
  const reactTicks = Math.max(1, Math.round(opts.react * TICK_RATE));

  /** The plan's orders not yet sent. */
  let backlog: Want[] = [];
  /** The fight micro's orders not yet sent: they wait until the next look at the fights. */
  let microLog: Want[] = [];
  /** The finishing push's order, until it's sent. */
  let push: Want | null = null;
  let lastPush = -1e9;
  /** What went out last tick, until sent() says what got through (uncapped, all of it). */
  let out: Want[] = [];
  let pushedAt = -1e9;
  /** Units the fight micro holds, until a tick: the plan's attack orders don't pull them away. */
  const held = new Map<number, number>();
  /** Enemy units seen lately: what each is worth and when it was last seen. */
  const sighted = new Map<number, { value: number; tick: number }>();
  let finishing = false;
  // the fight micro's own budget (opts.microApm), a token bucket like ai/apm.ts's
  let microTokens = MICRO_BURST * PER_ACTION;
  // (the bank also holds what a look's refill leaves over: at 115 a minute and a look every 0.5 s, a bank of
  // exactly one action threw away 57.5 of every 60 and it acted on every other look, 60 a minute)
  const microCap = MICRO_BURST * PER_ACTION + Math.max(0, reactTicks * (opts.microApm ?? 0) - 1);
  let microTick = 0;

  /** `c` cut down to the units it would change (null: none). The plan doesn't pull held units out of a fight. */
  function trim(w: World, c: Command, planned: boolean): Command | null {
    const ids = unitsOf(c);
    if (!ids) return c;
    const keep: number[] = [];
    for (const id of ids) {
      const u = w.units.get(id);
      if (!u || u.faction !== side) continue;
      if (planned && (c.type === "attackMove" || c.type === "attack") && (held.get(id) ?? -1) > w.tick) continue;
      if (!alreadyDoing(u, c)) keep.push(id);
    }
    if (!keep.length) return null;
    return keep.length === ids.length ? c : ({ ...c, unitIds: keep } as Command);
  }

  const cut = (w: World, wants: Want[], planned: boolean) =>
    wants.flatMap((want) => {
      const cmd = trim(w, want.cmd, planned);
      return cmd ? [{ ...want, cmd }] : [];
    });

  return {
    opener: pickAiOpener(plan.base, seed, side),
    plan: plan.label,
    tick(w: World): Command[] {
      for (const [id, until] of held) if (until <= w.tick) held.delete(id);
      const plan = tickAi(w, side, s); // the dodge reflex every tick, the plan every `think`
      const dodging = new Set(dodgingUnits(w, s));
      const reflex: Want[] = [];
      if (s.lastDecisionTick === w.tick) backlog = plan.map((cmd) => ({ rank: rankOf(cmd, dodging), cmd, planned: true }));
      else for (const cmd of plan) reflex.push({ rank: Rank.Dodge, cmd, planned: false });
      if (opts.microApm !== undefined) {
        microTokens = Math.min(microCap, microTokens + (w.tick - microTick) * opts.microApm);
        microTick = w.tick;
      }
      if (opts.react > 0 && w.tick % reactTicks === 0 && !w.winner) {
        push = finish(w) ?? (finishing ? push : null);
        let micro = fights(w, dodging);
        if (opts.microApm !== undefined) {
          // (the most urgent first: breaking off and stepping back, then focus fire)
          micro.sort((a, b) => a.rank - b.rank);
          const n = Math.min(micro.length, MICRO_BURST, Math.floor(microTokens / PER_ACTION));
          for (const x of micro.slice(n)) for (const id of unitsOf(x.cmd) ?? []) held.delete(id);
          micro = micro.slice(0, n);
          microTokens -= n * PER_ACTION;
        }
        microLog = micro;
      }
      const all = merge([...cut(w, [...reflex, ...(push ? [push] : []), ...microLog], false), ...cut(w, backlog, true)]);
      all.sort((a, b) => a.rank - b.rank); // (stable: the plan's own order within a rank)
      // (all of it sent, unless sent() says otherwise)
      out = all;
      backlog = [];
      microLog = [];
      if (push) {
        push = null;
        pushedAt = lastPush;
        lastPush = w.tick;
      }
      return all.map((x) => x.cmd);
    },
    sent(cmds: Command[]) {
      const went = new Set(cmds);
      const left = out.filter((x) => !went.has(x.cmd));
      backlog = left.filter((x) => x.planned);
      microLog = left.filter((x) => !x.planned && !x.push && x.rank !== Rank.Dodge);
      const p = left.find((x) => x.push);
      if (p) {
        push = p;
        lastPush = pushedAt;
      }
      out = [];
    }
  };

  /** One order for many units: orders of a kind to one spot, or one target, are merged. */
  function merge(wants: Want[]): Want[] {
    const res: Want[] = [];
    for (const want of wants) {
      const c = want.cmd;
      if (c.type === "attackMove" || c.type === "move" || c.type === "attack") {
        const twin = res.find((o) => {
          const d = o.cmd;
          if (o.rank !== want.rank || o.planned !== want.planned || o.push !== want.push || d.type !== c.type) return false;
          if (d.type === "attack" && c.type === "attack") return d.targetId === c.targetId;
          return d.type !== "attack" && c.type !== "attack" && dist(d.x, d.y, c.x, c.y) <= 0.5;
        });
        if (twin) {
          const ids = unitsOf(twin.cmd)!;
          twin.cmd = { ...twin.cmd, unitIds: [...ids, ...c.unitIds.filter((id) => !ids.includes(id))] } as Command;
          continue;
        }
      }
      res.push({ ...want });
    }
    return res;
  }

  /** The finishing push, once the game is won: everything at the nearest enemy building it knows of. */
  function finish(w: World): Want | null {
    for (const e of seenEnemies(w, side)) if (e.kind !== "harvester") sighted.set(e.id, { value: UNITS[e.kind].cost, tick: w.tick });
    let enemy = 0;
    for (const [id, x] of sighted) {
      if (w.tick - x.tick > SIGHTING_TTL) sighted.delete(id);
      else enemy += x.value;
    }
    const army = [...w.units.values()].filter(
      (u) =>
        u.faction === side && !u.goliath && UNITS[u.kind].dps > 0 && u.kind !== "harvester" &&
        (u.order.type === "idle" || u.order.type === "attackMove" || u.order.type === "attack")
    );
    const ours = army.reduce((v, u) => v + UNITS[u.kind].cost, 0);
    if (!finishing && ours >= Math.max(K.finishMin, K.finish * enemy)) finishing = true;
    else if (finishing && ours < Math.max(K.finishMin * 0.6, 1.5 * enemy)) finishing = false;
    if (!finishing || w.tick < (s.strategy.holdUntil ?? 0) * TICK_RATE || w.tick - lastPush < K.finishEvery * TICK_RATE || !army.length) return null;
    const cx = army.reduce((a, u) => a + u.x, 0) / army.length;
    const cy = army.reduce((a, u) => a + u.y, 0) / army.length;
    const known = knownBuildings(w, side).filter((b) => b.faction !== side);
    const centre = (b: (typeof known)[number]) => ({ x: b.tx + BUILDINGS[b.kind].size / 2, y: b.ty + BUILDINGS[b.kind].size / 2 });
    known.sort((a, b) => dist(centre(a).x, centre(a).y, cx, cy) - dist(centre(b).x, centre(b).y, cx, cy) || a.id - b.id);
    // (none known: where their HQ must be, the mirror of ours)
    const hq = hqOf(w, side);
    const home = hq ? buildingCenter(hq) : { x: cx, y: cy };
    const at = known[0] ? centre(known[0]) : { x: w.width - home.x, y: w.height - home.y };
    const ids = army.map((u) => u.id);
    for (const id of ids) held.set(id, w.tick + (K.finishEvery + 2) * TICK_RATE);
    return { rank: Rank.Push, cmd: { type: "attackMove", faction: side, unitIds: ids, x: at.x, y: at.y }, planned: false, push: true };
  }

  /** The fight micro: break off lost fights, step hurt units back, focus fire. */
  function fights(w: World, dodging: Set<number>): Want[] {
    const res: Want[] = [];
    const hq = hqOf(w, side);
    const home = hq ? buildingCenter(hq) : null;
    const enemies = seenEnemies(w, side).filter((e) => !e.goliath && (UNITS[e.kind].dps > 0 || UNITS[e.kind].heal));
    const army = [...w.units.values()].filter(
      (u) =>
        u.faction === side && !u.goliath && UNITS[u.kind].dps > 0 && u.kind !== "harvester" &&
        !dodging.has(u.id) && (u.order.type === "idle" || u.order.type === "attackMove" || u.order.type === "attack")
    );
    const defences = [...w.buildings.values()].filter(
      (b) => b.faction !== side && BUILDINGS[b.kind].dps > 0 && isVisible(w, side, b.tx, b.ty)
    );
    const inFight = army.filter((u) => enemies.some((e) => dist(u.x, u.y, e.x, e.y) <= UNITS[u.kind].range + 2.5));
    const fightIds = new Set(inFight.map((u) => u.id));

    // the units in each fight
    const done = new Set<number>();
    const clusters: Unit[][] = [];
    for (const u of inFight) {
      if (done.has(u.id)) continue;
      const c = [u];
      done.add(u.id);
      for (let i = 0; i < c.length; i++)
        for (const v of inFight)
          if (!done.has(v.id) && dist(c[i]!.x, c[i]!.y, v.x, v.y) <= 5) {
            done.add(v.id);
            c.push(v);
          }
      clusters.push(c);
    }

    const leaving = new Set<number>();
    for (const c of clusters) {
      const cx = c.reduce((a, u) => a + u.x, 0) / c.length;
      const cy = c.reduce((a, u) => a + u.y, 0) / c.length;
      const ours = army.filter((u) => dist(u.x, u.y, cx, cy) <= FIGHT_RADIUS);
      const theirs = enemies.filter((e) => dist(e.x, e.y, cx, cy) <= FIGHT_RADIUS + 2);
      const towers = defences.filter((b) => {
        const bc = buildingCenter(b);
        return dist(bc.x, bc.y, cx, cy) <= FIGHT_RADIUS + 2;
      });
      // --- a lost fight away from home: everyone in it falls back toward home
      if (!finishing && home && dist(cx, cy, home.x, home.y) > K.homeStand) {
        const mine = strength(ours, theirs, towers.length > 0);
        const them =
          strength(theirs, ours, false) + towers.reduce((a, b) => a + BUILDINGS[b.kind].dps, 0) * towers.reduce((a, b) => a + b.hp, 0);
        if (mine < K.breakOff * them) {
          const back = toward(cx, cy, home, 10);
          const ids = ours.filter((u) => u.kind !== "mender").map((u) => u.id);
          for (const id of ids) {
            leaving.add(id);
            held.set(id, w.tick + K.retreatHold * TICK_RATE);
          }
          if (ids.length) res.push({ rank: Rank.Retreat, cmd: { type: "move", faction: side, unitIds: ids, x: back.x, y: back.y }, planned: false });
          continue;
        }
      }
      // --- hurt, expensive units step back out of it
      if (home)
        for (const u of c) {
          if (UNITS[u.kind].cost < K.precious || u.hp > K.hurt * UNITS[u.kind].hp || leaving.has(u.id)) continue;
          const back = toward(u.x, u.y, home, 7);
          leaving.add(u.id);
          held.set(u.id, w.tick + 6 * TICK_RATE);
          res.push({ rank: Rank.Retreat, cmd: { type: "move", faction: side, unitIds: [u.id], x: back.x, y: back.y }, planned: false });
        }
      // --- focus fire: each shooter on what dies fastest for the harm it does, no overkill
      const aimed = new Map<number, number>(); // damage a second already on each target
      const shooters = c.filter((u) => !leaving.has(u.id));
      const options = new Map<number, Unit[]>();
      for (const u of shooters) {
        const st = UNITS[u.kind];
        options.set(
          u.id,
          theirs.filter((e) => {
            const d = dist(u.x, u.y, e.x, e.y);
            return d <= st.range + 0.3 && d >= (st.minRange ?? 0) && effectivenessVs(u.kind, UNITS[e.kind].armor, domainOf(e)) >= USELESS;
          })
        );
      }
      // (the shooters with the fewest choices pick first)
      shooters.sort((a, b) => options.get(a.id)!.length - options.get(b.id)!.length || a.id - b.id);
      const orders = new Map<number, number[]>();
      for (const u of shooters) {
        const can = options.get(u.id)!;
        if (!can.length) continue;
        const dps = (e: Unit) => UNITS[u.kind].dps * effectivenessVs(u.kind, UNITS[e.kind].armor, domainOf(e));
        const score = (e: Unit) => (harm(e) * dps(e)) / Math.max(1, e.hp);
        const open = (e: Unit) => (aimed.get(e.id) ?? 0) * K.overkill < e.hp;
        let best: Unit | null = null;
        for (const e of can) if (open(e) && (!best || score(e) > score(best) || (score(e) === score(best) && e.id < best.id))) best = e;
        best ??= can.reduce((a, e) => (score(e) > score(a) ? e : a));
        const curId = u.order.type === "attack" ? u.order.targetId : u.autoTargetId;
        const cur = curId === null ? undefined : can.find((e) => e.id === curId);
        const pick = cur && open(cur) && score(best) < K.switch * score(cur) ? cur : best;
        aimed.set(pick.id, (aimed.get(pick.id) ?? 0) + dps(pick));
        if (pick.id === curId) continue;
        held.set(u.id, w.tick + 3 * TICK_RATE);
        orders.set(pick.id, [...(orders.get(pick.id) ?? []), u.id]);
      }
      for (const [targetId, ids] of orders) res.push({ rank: Rank.Focus, cmd: { type: "attack", faction: side, unitIds: ids, targetId }, planned: false });
    }
    // (units out of the fight aren't held: the plan has them again)
    for (const id of held.keys()) if (!fightIds.has(id) && !leaving.has(id) && w.units.get(id)?.order.type !== "move") held.delete(id);
    return res;
  }
}

/** How much harm an enemy unit does a second (a healer counts for what it heals). */
function harm(e: Unit): number {
  const st = UNITS[e.kind];
  return st.dps + (st.heal ?? 0) * 1.5 + 1;
}

/** Lanchester strength of `a` against `b`: its damage a second (by how well it hurts them) × its hit points. */
function strength(a: Unit[], b: Unit[], vsStructures: boolean): number {
  if (!a.length) return 0;
  const bHp = b.reduce((n, e) => n + e.hp, 0);
  let dps = 0;
  for (const u of a) {
    const st = UNITS[u.kind];
    if (st.dps <= 0) continue;
    // its damage against their mix, weighted by their hit points (structures if that's all there is)
    let eff = 0;
    if (bHp > 0) for (const e of b) eff += (effectivenessVs(u.kind, UNITS[e.kind].armor, domainOf(e)) * e.hp) / bHp;
    else eff = vsStructures ? effectivenessVs(u.kind, "structure", "ground") : 1;
    dps += st.dps * eff;
  }
  return dps * a.reduce((n, u) => n + u.hp, 0);
}

function toward(x: number, y: number, to: { x: number; y: number }, d: number) {
  const len = Math.max(1, dist(x, y, to.x, to.y));
  const k = Math.min(1, d / len);
  return { x: x + (to.x - x) * k, y: y + (to.y - y) * k };
}
