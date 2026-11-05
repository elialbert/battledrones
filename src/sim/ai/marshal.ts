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
 *    switched for a much better target; hurt expensive units step back;
 *    what outranges the enemy closing on it kites (ai/kite.ts, Normal and
 *    up); and a fight that's lost, away from home, is broken off.
 *  - **It harasses on a leash.** Each plan flies its own sorties (ai/harass.ts):
 *    a poke at their mining at 0:40, maybe a bigger bite after it, raids on
 *    their far fields late on, every one home when it's hurt or outgunned.
 *    They replace the stock commander's raids, which never came back.
 *  - **It finishes a won game.** Once its army is twice the enemy army it
 *    has seen lately, everything attack-moves on the enemy's buildings, one
 *    order every few seconds; a capped commander otherwise sits on a won game
 *    till time runs out.
 *
 * It reads what the commander reads: its own side, and the enemy only
 * through seenEnemies, knownBuildings and visible tiles. No income handicap.
 */
import { ferryCondors } from "./skylift";
import { BUILDINGS, TICK_RATE, UNITS } from "../balance";
import { isVisible, knownBuildings } from "../fog";
import type { Command, Faction, Unit, World } from "../types";
import { buildingCenter, dist, domainOf, hqOf } from "../world";
import { STRATEGIES, createAiState, tickAi, type Difficulty, type Strategy, type StrategyName } from "./commander";
import { DOCTRINE, type DoctrinePlan } from "./doctrine";
import { USELESS, effectivenessVs, seenEnemies } from "./intel";
import { dodgingUnits } from "./powers";
import type { Bot } from "./bots";
import { goliathsOf, isLifted } from "../goliath";
import { strikeHolds } from "./hornets";
import { sortieHolds, type SortieKind } from "./harass";
import { feintHolds } from "./feint";
import { siegeHolds } from "./siege";
import type { MapDef } from "../maps";
import { hash32 } from "../rand";
import { AI_OPENER } from "../openers";
import { capApm } from "./apm";
import { kiteStep } from "./kite";

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
  /** Weighs its waves, aircraft and Gantry against the enemy it remembers (AiState.weighs). */
  weighs?: boolean;
  /** Flies crews up to fields no harvester can drive to (ai/skylift.ts). */
  skylift?: boolean;
  /** Play the plan's fast-expanding version, if it has one (MARSHAL_PLANS). */
  fast?: boolean;
  /** Seconds of peace: no raids, waves or finishing push before this. */
  holdUntil?: number;
  /** Changes to whichever plan it plays (MARSHAL: Hard's economy). */
  tweak?: Partial<Strategy>;
  /**
   * Army value it waves at, unless its plan sets its own (Rush's early wave,
   * Turtle's one push, Juggernaut's Goliath escort keep theirs).
   */
  assaultValue?: number;
  /** Changes to how it fights (FIGHT). */
  fight?: Partial<Fight>;
  /** Commit to an army late on (ai/doctrine.ts). Needs `weighs`: it reads the army that remembers. */
  doctrine?: Partial<DoctrinePlan>;
  /** The harassment sorties it flies instead of its plan's (ai/harass.ts): experiments. */
  sorties?: SortieKind[];
}

export type PlanName = StrategyName | "turtle" | "greed" | "juggernaut" | "strike" | "wall" | "landgrab" | "feint" | "siege";

/**
 * The game plans Marshal picks from: the stock personalities, and eight of
 * its own built on one of them (`base`: the tables keyed by
 * personality, ai/goliath.ts and ai/airlift.ts). `goliath`: how its Goliaths
 * play (AiState.goliathStyle), "expand" unless it says; `hornets`: how its
 * Hornets do (AiState.hornetStyle).
 */
export const MARSHAL_PLANS: Record<
  PlanName,
  {
    base: StrategyName; label: string; tweak?: Partial<Strategy>; fast?: Partial<Strategy>; goliath?: "rush"; hornets?: "strike";
    sorties: SortieKind[];
    /** Its army is the plan: no doctrine (ai/doctrine.ts). */
    ownArmy?: boolean;
  }
> = {
  balanced: { base: "balanced", label: "Balanced", sorties: ["poke", "pressure", "air"], fast: fastDepot(["fab-plant", "depot", "airpad", "turret", "tech-lab", "assembly-bay", "turret", "radar"]) },
  /**
   * A flood of Stingers (RUSH-RPS.md): a Depot, three Fab Plants by 0:50,
   * seven harvesters, one big wave instead of raids, then the rest of the
   * order and an expansion. (Hard, 24 games: beat Greed 11–9 and Turtle
   * 14–9 at Stinger buildTime 10–11; raids instead of one wave were no better.)
   */
  rush: {
    base: "rush",
    label: "Rush",
    sorties: ["poke", "pressure"],
    tweak: {
      buildOrder: ["fab-plant", "depot", "fab-plant", "fab-plant", "assembly-bay", "turret", "airpad", "tech-lab", "depot"],
      harvesters: 7,
      assaultValue: 1500,
      harassGroup: Infinity,
      infantry: 0.15,
      spend: { maxDepots: 2 }
    }
  },
  airswarm: { base: "airswarm", label: "Air Swarm", sorties: ["poke", "pressure", "air"], fast: fastDepot(["airpad", "depot", "fab-plant", "turret", "tech-lab", "airpad"]) },
  boom: { base: "boom", label: "Boom", sorties: ["poke", "air"], fast: fastDepot(["fab-plant", "depot", "turret", "tech-lab", "airpad", "turret", "radar", "sam-site"]) },
  skyforce: { base: "skyforce", label: "Skyforce", sorties: ["poke", "air"] },
  ironclad: { base: "ironclad", label: "Ironclad", sorties: ["poke", "air"], fast: fastDepot(["fab-plant", "depot", "turret", "tech-lab", "assembly-bay", "airpad", "fab-plant", "sam-site"]) },
  /**
   * Holds the way into its base (ai/choke.ts) with turrets and the whole
   * army, a turret more for every two tanks it sees, techs up behind them
   * (Mortars for a Stinger flood, then heavy armour), no raids, and a
   * mid-game push once 1800 of the army is tier 2 (~3:30–4:00; TECH-TIER.md:
   * the 3000 bar it had was passed at ~3:00 by Stingers alone, and Rush won
   * 69%; with the push 52%). Greed still beats it.
   */
  turtle: {
    base: "ironclad",
    label: "Turtle",
    sorties: ["poke"],
    tweak: {
      buildOrder: ["fab-plant", "turret", "turret", "tech-lab", "depot", "fab-plant", "turret", "sam-site", "radar"],
      harvesters: 6,
      // (6000: out of the way, the tier-2 push times it)
      assaultValue: 6000,
      techAssault: 1800,
      harassGroup: Infinity,
      holdChoke: true,
      turretsVsGround: 2,
      mortarShare: 0.35,
      expandEarly: true
    },
    fast: { buildOrder: ["fab-plant", "depot", "turret", "turret", "tech-lab", "fab-plant", "turret", "sam-site", "radar"], harvesters: 7 }
  },
  /** Two depots before anything else, a harvester for each, then a late push. (78% at 14 APM; 56% with a turret and the Tech Lab between the depots.) */
  greed: {
    base: "boom",
    label: "Greed",
    sorties: ["poke"],
    tweak: {
      buildOrder: ["fab-plant", "depot", "depot", "turret", "tech-lab", "fab-plant", "airpad", "sam-site"],
      harvesters: 6,
      assaultValue: 2400,
      harassGroup: Infinity
    }
  },
  /**
   * For fun, and weaker than the rest (APM-BOTS.md): straight to the
   * Gantry's four prerequisites, the Gantry from 1:00, most of the income
   * saved for the Goliath, and the Goliath pushes for their HQ with the army
   * round it (ai/goliath.ts "RUSHERS"). No raids, and waves only once the
   * army is big: the army is the Goliath's escort.
   */
  juggernaut: {
    base: "ironclad",
    label: "Juggernaut",
    sorties: ["poke"],
    goliath: "rush",
    tweak: {
      buildOrder: ["fab-plant", "tech-lab", "airpad", "assembly-bay", "depot", "turret"],
      harvesters: 6,
      assaultValue: 5000,
      harassGroup: Infinity
    }
  },
  /**
   * For fun (APM-BOTS.md): the Tech Lab straight after the Airpad, the
   * Airpads build Hornets before anything else till there are seven, and
   * the wing hides by a far corner of the map until the enemy's army comes
   * at ours, then bombs their HQ (ai/hornets.ts). Once only: then it turns
   * to a strong air attack (hornets.ts PIVOT). No raids: the Wasps stay
   * home and guard.
   */
  strike: {
    base: "airswarm",
    label: "Hornet Strike",
    sorties: ["poke", "air"],
    hornets: "strike",
    tweak: {
      buildOrder: ["airpad", "tech-lab", "fab-plant", "airpad", "turret", "depot"],
      harassGroup: Infinity
    }
  },
  /**
   * For fun, and never Brutal's (MARSHAL_POOL): turrets, a SAM Site after
   * every fourth, and a tier-1 army from all three factories. It expands by
   * building turrets out to each new field until a Depot fits by it (no
   * crews), guards each new Depot with two before moving on, then creeps
   * the turrets on to the enemy's expansions and HQ, few kept at home; it
   * leaves the Tech Lab till the fifteenth turret (commander.ts Strategy.wall).
   */
  wall: {
    base: "boom",
    label: "The Wall",
    sorties: ["poke"],
    tweak: {
      buildOrder: ["fab-plant", "turret", "depot", "turret", "airpad", "turret", "assembly-bay", "turret", "fab-plant"],
      harvesters: 6,
      // (the army holds at the wall: Stingers waved at 4500 walked into tier 2 and the base fell behind
      // them; it goes once 2400 of it is tier 2)
      assaultValue: 9000,
      techAssault: 2400,
      harassGroup: Infinity,
      // (a share of Troopers and Rocket Squads from the Assembly Bay, as from the others)
      infantry: 0.25,
      // (factories for scrap piling up go up next, the turrets going up one at a time)
      expandEarly: true,
      spend: { maxDepots: 8, maxExtra: 4 },
      wall: { max: 32, samEvery: 4, guard: 2, tech: 15, army: 1200, armyPerTurret: 90 }
    }
  },
  /**
   * For fun: a Depot on every field it can reach, either side of the halfway
   * line, and most of the army out to fight for a site with enemies by it
   * when that fight looks winnable (commander.ts Strategy.landGrab). Its
   * income grows while its army stays thin: kill the Depots. (Brutal, 24
   * games on four maps: 14–9–1 against Balanced, so it's in Brutal's pool;
   * 6.3 Depots at 5:00 to Greed's 4.7, mining level with it.)
   */
  landgrab: {
    base: "boom",
    label: "Land Grab",
    sorties: ["poke"],
    tweak: {
      buildOrder: ["fab-plant", "depot", "depot", "fab-plant", "turret", "depot", "tech-lab", "airpad", "depot", "sam-site"],
      harvesters: 6,
      assaultValue: 2400,
      harassGroup: Infinity,
      landGrab: true,
      spend: { maxDepots: 8 }
    }
  },
  /**
   * For fun, and never Brutal's (MARSHAL_POOL): a loud few at one drop-off
   * and, once the army's gone to them, the real thing at another (ai/feint.ts).
   * It plays on a player's habits, not their build: watch the other side of
   * the base. Only on maps with room for it (planFitsMap). (Brutal, against
   * Balanced: 29–28–3 on Ashlands, 4–14–12 on random maps, and the bots rarely
   * take the bait: the wave reached its target in a third of tricks at best.)
   */
  feint: {
    base: "balanced",
    label: "The Feint",
    sorties: ["poke"],
    fast: fastDepot(["fab-plant", "depot", "airpad", "turret", "tech-lab", "assembly-bay", "turret", "radar"]),
    tweak: {
      assaultValue: Infinity,
      harassGroup: Infinity,
      feint: { from: 240, army: 3000, after: 1700, tricks: 2 }
    }
  },
  /**
   * For fun: a slow column of Mortars and Menders behind an escort, coming on
   * in hops and shelling from past a Turret's reach (ai/siege.ts). It's the
   * army, all but a home guard: go round it, or come by air. (Brutal, against
   * Balanced: 18–19–11 on four maps, so it's in Brutal's pool; three hops or
   * more in 43 of the 48, and 10 Mortars lost a game.)
   */
  siege: {
    base: "ironclad",
    // (Hard, 24 games with a doctrine against without: 48% with its Mortars replaced, 35% with them kept)
    ownArmy: true,
    label: "Siege Train",
    sorties: ["poke"],
    tweak: {
      buildOrder: ["fab-plant", "depot", "tech-lab", "airpad", "fab-plant", "turret", "depot", "sam-site"],
      harvesters: 6,
      // (the column is the attack: stock waves would take its army off it)
      assaultValue: 12000,
      harassGroup: Infinity,
      mortarShare: 0.3,
      mortarCap: 6,
      siege: { from: 210, mortars: 4, army: 4000 }
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
 * The plans each difficulty picks from, at random for each game: every plan,
 * at every level (a player at any level can meet any of them), but for The
 * Wall and The Feint on Brutal (they're there to be weird, not hard; they
 * can still be picked by name). The level is in how Marshal plays the plan (MARSHAL). Easy's five minutes' peace holds
 * Rush's wave till 5:00; Hornet Strike's bombers and Juggernaut's Goliath
 * don't wait for it (they never did on Casual).
 */
const ALL_PLANS = Object.keys(MARSHAL_PLANS) as PlanName[];
export const MARSHAL_POOL: Record<Difficulty, PlanName[]> = {
  easy: ALL_PLANS,
  casual: ALL_PLANS,
  normal: ALL_PLANS,
  hard: ALL_PLANS,
  brutal: ALL_PLANS.filter((p) => p !== "wall" && p !== "feint")
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

/** The smallest map The Feint is played on (planFitsMap). */
const FEINT_MAP = 64;

/**
 * May this plan be played on this map? The Feint needs a duel on open ground
 * with room to hide an army (Brutal, against Balanced: 8–25–3 on the 48 and
 * 56 tile maps, 29–28–3 on Ashlands); on islands it never plays its trick, and
 * nobody has tried it four ways.
 */
export function planFitsMap(plan: PlanName, map: Pick<MapDef, "size" | "islands" | "players">): boolean {
  return plan !== "feint" || (map.size >= FEINT_MAP && !map.islands && (map.players ?? 2) === 2);
}

/** The plan a Marshal with this seed draws (from `pool`: the plans the match rules allow). */
export function marshalPlan(seed: number, difficulty: Difficulty, pool: readonly PlanName[] = MARSHAL_POOL[difficulty]): PlanName {
  return pool.length ? pool[hash32(seed, 0x6d61) % pool.length]! : "balanced";
}

/**
 * Each difficulty: how fast it thinks and acts, fight micro's share of its
 * actions, whether it plays the fast-expanding plans, and its seconds of
 * peace. `burst` is how many actions its cap banks (ai/apm.ts; APM_BURST if
 * left out): Brutal's `apm` plus `burst` is 180, so no minute of a game sees
 * more than 180 actions (it was 120: at 175, with 180 for fight micro, it beat
 * that Brutal 40–5 of 60, 15 drawn; more bought little, APM-BOTS.md "Five
 * levels"). Fight micro never gives more than one order at a time
 * (MICRO_BURST), so even Brutal's is at most 3 a second, a quick human's pace.
 * Brutal also plays every plan with a bigger economy (`tweak`), waves at a
 * bigger army unless the plan times its own (`assaultValue`), and
 * fights its own way (`fight`). Each level beats the one below it 87–99% of
 * 60 games. APM-BOTS.md ("Retuning the levels", "Hard, harder", "Five
 * levels") has the numbers.
 */
export const MARSHAL: Record<
  Difficulty,
  {
    think: number; react: number; apm: number; burst?: number; microApm: number; fast: boolean; holdUntil: number;
    tweak?: Partial<Strategy>; assaultValue?: number; fight?: Partial<Fight>; weighs?: boolean; skylift?: boolean; doctrine?: Partial<DoctrinePlan>;
  }
> = {
  // (Easy and Casual don't kite, ai/kite.ts: a step back every 20 s is no kiting, and lost Easy fights it would win)
  easy: { think: 4, react: 3, apm: 10, microApm: 3, fast: false, holdUntil: 300, fight: { kite: false } },
  // (between Easy and Normal: three minutes' peace, the slow plans and Air Swarm)
  casual: { think: 3, react: 2, apm: 18, microApm: 8, fast: false, holdUntil: 180, fight: { kite: false } },
  normal: { think: 2, react: 1, apm: 30, microApm: 20, fast: true, holdUntil: 0, skylift: true },
  // (Hard before Brutal took its place, at 80 actions a minute, 100 since 2026-10-30: at 120 it beat Normal 99%, and lost only 39% to Brutal)
  // (`weighs`, Hard and Brutal: waves weighed against the enemy army it remembers, no aircraft into
  // massed flak, no Gantry while behind — AiState.weighs)
  hard: { think: 1.5, react: 0.5, apm: 100, microApm: 60, fast: true, holdUntil: 0, weighs: true, skylift: true, doctrine: {} },
  // (a plan every 2 s: under the strict cap, a plan every 1.5 s lost 29% to it)
  brutal: {
    think: 2, react: 0.5, apm: 175, burst: 5, microApm: 180, fast: true, holdUntil: 0, weighs: true, skylift: true, doctrine: {},
    // twelve harvesters (and one per depot), factories as soon as scrap piles up; waves at 2500 unless
    // the plan times its own
    tweak: { harvesters: 12, expandEarly: true, factoryBeforeLab: true, bayOverflow: true },
    assaultValue: 2500,
    // a lost fight broken off sooner, and stayed out of longer; the finishing push at 1.5× the enemy army
    // seen; a shooter switches to a target twice as good (not 3×)
    fight: { breakOff: 0.5, retreatHold: 20, finish: 1.5, switch: 2 }
  }
};

/**
 * Marshal at `difficulty` playing `plan` (with an op's `tweak` on top), under
 * its difficulty's APM cap: the bot every seat in the game gets (game/meta.ts,
 * ffa/match.ts). Deterministic from `seed`.
 */
export function seatMarshal(side: Faction, seed: number, difficulty: Difficulty, plan: PlanName, tweak?: Partial<Strategy>): Bot {
  const m = MARSHAL[difficulty];
  return capApm(marshal(side, seed, difficulty, { ...m, strategy: plan, tweak: { ...m.tweak, ...tweak } }), m.apm, m.burst);
}

/** Orders by rank: the cap spends from the top. */
/** An attack order for this many units or more is a wave, not a unit's errand (merge). */
const WAVE_ORDER = 6;

const enum Rank {
  Dodge,
  Retreat,
  Kite,
  Economy,
  Push,
  Production,
  Focus,
  Army,
  Other,
  /** Keeping a marching wave together (low: only APM the rest leaves). */
  March
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
/** A marching wave's unit this much closer (tiles) to where it's going than the wave's middle waits for it. */
const MARCH_LEAD = 5;
/** …at a spot this far (tiles) ahead of the middle, till the middle is this close behind it (MARCH_CATCH). */
const MARCH_AHEAD = 2;
const MARCH_CATCH = 1.5;
/** Within this (tiles) of where it's going, or in contact, the wave stops waiting and goes in. */
const MARCH_ARRIVE = 10;
const MARCH_CONTACT = 8;
/** A unit waits at most this long (s); a wave is kept together at most this long after it's sent (s). */
const MARCH_WAIT = 20;
const MARCH_MAX = 120;
/** How long (s) a wave's orders have to go out, before it counts as broken up. */
const MARCH_SEND = 4;
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
/**
 * The finishing push starts only on a fresh look at the enemy's base (in sight within this many s): an
 * army kept home out of sight isn't in what's been seen lately, and "won" at 2:10 on what the scouts saw
 * a minute before sent the whole army into one half again its size (replay, Brutal Turtle on Dune Sea).
 */
const LOOK_FRESH = 30;
/** Seconds between sending a unit to look (a Scout, else one fast unit), while the push waits on one. */
const LOOK_EVERY = 20;
/** An enemy unit unseen this long no longer counts toward its army (ticks). */
const SIGHTING_TTL = 90 * TICK_RATE;
/** A lost fight falls back to a Goliath of ours this close (tiles) to it and nearer home, one above this share of its HP. */
const GOLIATH_COVER_REACH = 16;
const GOLIATH_COVER_HP = 0.35;
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
  finishEvery: FINISH_EVERY,
  /** Units that outrange what's coming at them step back and keep shooting (ai/kite.ts). */
  kite: true
};
export type Fight = typeof FIGHT;

/** The fight micro's budget: how many actions it can bank (one: a fight order at most every 60 / microApm seconds). */
const MICRO_BURST = 1;
const PER_ACTION = 60 * TICK_RATE;

const unitsOf = (c: Command): number[] | null => ("unitIds" in c ? c.unitIds : null);

function rankOf(c: Command, dodging: Set<number>, goliaths: Set<number>, ferry: ReadonlySet<number>): Rank {
  // (a Goliath's own orders, to walk out to a field, dig in, pack up, go with the economy: it expands
  // the economy, and an order to it lost to the cap leaves it idle, chasing whatever it sees)
  if ("unitIds" in c && c.unitIds.length > 0 && c.unitIds.every((id) => goliaths.has(id)) && !c.unitIds.every((id) => dodging.has(id)))
    return Rank.Economy;
  // (the mesa run is mining: ai/skylift.ts)
  if (c.type === "board" ? ferry.has(c.carrierId) : (c.type === "unload" || c.type === "move") && c.unitIds.every((id) => ferry.has(id))) return Rank.Economy;
  switch (c.type) {
    case "move":
      return c.unitIds.every((id) => dodging.has(id)) ? Rank.Dodge : Rank.Army;
    case "calldown":
      return Rank.Retreat;
    case "harvest":
    case "found":
    case "placeBuilding":
    case "cancelBuilding":
    // (a building is started at most once a think, with the scrap for it: about an action each. Ranked
    // with production it lost to the harvesters' orders at 30 APM, and the build order waited up to 74 s)
    case "startBuilding":
      return Rank.Economy;
    case "produce":
      return c.unit === "harvester" ? Rank.Economy : Rank.Production;
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

/** The personality Marshal plays with these options: its plan, then its level's wave size and changes. */
export function marshalStrategy(opts: MarshalOptions): Partial<Strategy> {
  const own = MARSHAL_PLANS[opts.strategy].tweak?.assaultValue !== undefined;
  const assault = opts.assaultValue !== undefined && !own ? { assaultValue: opts.assaultValue } : {};
  // (no stock harass raids: its sorties harass, on a leash, ai/harass.ts)
  const doctrine = opts.doctrine && !MARSHAL_PLANS[opts.strategy].ownArmy && { from: DOCTRINE.from, ...opts.doctrine };
  return { ...planStrategy(opts.strategy, opts.fast), ...assault, holdUntil: opts.holdUntil, harassGroup: Infinity, ...(doctrine ? { doctrine } : {}), ...opts.tweak };
}

export function marshal(side: Faction, seed: number, difficulty: Difficulty, opts: MarshalOptions): Bot {
  const plan = MARSHAL_PLANS[opts.strategy];
  const K: Fight = { ...FIGHT, ...opts.fight };
  const s = createAiState(plan.base, difficulty, seed, marshalStrategy(opts));
  s.fair = true;
  s.weighs = opts.weighs;
  s.skylift = opts.skylift;
  s.interval = opts.think;
  // (a Goliath alone is a target: it expands the economy and backs the army up, unless the plan rushes one)
  s.goliathStyle = plan.goliath ?? "expand";
  s.hornetStyle = plan.hornets;
  // its plan's sorties, each but the first poke left out of one game in four (ai/harass.ts)
  s.sorties = opts.sorties ?? plan.sorties.filter((k, i) => k === "poke" || hash32(seed, 0x6861 + i) % 4 !== 0);
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
  /** When the enemy's base was last in sight, and a unit last sent to look at it (LOOK_FRESH). */
  let lookedAt = -1e9;
  let lookSent = -1e9;
  /** The look's order, until it's sent. */
  let look: Want | null = null;
  // the fight micro's own budget (opts.microApm), a token bucket like ai/apm.ts's
  let microTokens = MICRO_BURST * PER_ACTION;
  // (the bank also holds what a look's refill leaves over: at 115 a minute and a look every 0.5 s, a bank of
  // exactly one action threw away 57.5 of every 60 and it acted on every other look, 60 a minute)
  const microCap = MICRO_BURST * PER_ACTION + Math.max(0, reactTicks * (opts.microApm ?? 0) - 1);
  let microTick = 0;
  /** Units of the marching wave waiting for the rest (ai/commander.ts AiState.wave): since when. */
  const waiting = new Map<number, number>();
  /** The wave `waiting` is for (its launch tick). */
  let waveTick = -1;

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
    opener: AI_OPENER,
    plan: plan.label,
    tick(w: World): Command[] {
      for (const [id, until] of held) if (until <= w.tick) held.delete(id);
      const plan = tickAi(w, side, s); // the dodge reflex every tick, the plan every `think`
      const dodging = new Set(dodgingUnits(w, s));
      const reflex: Want[] = [];
      if (s.lastDecisionTick === w.tick) {
        const goliaths = new Set(goliathsOf(w, side).map((g) => g.id));
        const ferry = ferryCondors(s);
        backlog = plan.map((cmd) => ({ rank: rankOf(cmd, dodging, goliaths, ferry), cmd, planned: true }));
      } else for (const cmd of plan) reflex.push({ rank: Rank.Dodge, cmd, planned: false });
      if (opts.microApm !== undefined) {
        microTokens = Math.min(microCap, microTokens + (w.tick - microTick) * opts.microApm);
        microTick = w.tick;
      }
      if (opts.react > 0 && w.tick % reactTicks === 0 && !w.winner) {
        push = finish(w) ?? (finishing ? push : null);
        let micro = [...fights(w, dodging), ...march(w, dodging)];
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
      const all = merge([...cut(w, [...reflex, ...(push ? [push] : []), ...(look ? [look] : []), ...microLog], false), ...cut(w, backlog, true)]);
      look = null;
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
    // (an order for a whole wave, merged or sent as one, is one action for an army: ranked with single
    // orders it lost every time to a Fab Plant's next unit once scrap piled up. Three Canyons, Normal:
    // 0 of 4,700 army orders sent in two minutes, 160 units idle at home all game)
    for (const r of res)
      if (r.rank === Rank.Army && (r.cmd.type === "attackMove" || r.cmd.type === "attack") && r.cmd.unitIds.length >= WAVE_ORDER) r.rank = Rank.Push;
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
    // (a Hornet strike's wing, and a sortie out harassing, fly their own plans: ai/hornets.ts, ai/harass.ts)
    const wing = new Set([...strikeHolds(w, side, s), ...sortieHolds(s), ...feintHolds(s), ...siegeHolds(s)]);
    const army = [...w.units.values()].filter(
      (u) =>
        u.faction === side && !u.goliath && UNITS[u.kind].dps > 0 && u.kind !== "harvester" && !wing.has(u.id) &&
        (u.order.type === "idle" || u.order.type === "attackMove" || u.order.type === "attack")
    );
    const ours = army.reduce((v, u) => v + UNITS[u.kind].cost, 0);
    // (where their army would be: their HQs we know of, else the mirror of ours)
    const homes = knownBuildings(w, side).filter((b) => b.faction !== side && b.kind === "hq").map((b) => ({ x: b.tx + BUILDINGS.hq.size / 2, y: b.ty + BUILDINGS.hq.size / 2 }));
    if (!homes.length) {
      const hq = hqOf(w, side);
      if (hq) {
        const c = buildingCenter(hq);
        homes.push({ x: w.width - c.x, y: w.height - c.y });
      }
    }
    if (homes.some((h) => isVisible(w, side, Math.floor(h.x), Math.floor(h.y)))) lookedAt = w.tick;
    if (!finishing && ours >= Math.max(K.finishMin, K.finish * enemy)) {
      if (w.tick - lookedAt <= LOOK_FRESH * TICK_RATE || !homes.length) finishing = true;
      else if (w.tick - lookSent >= LOOK_EVERY * TICK_RATE) {
        // not seen lately: look before calling it won (what the look sees counts on the next pass)
        const mine = [...w.units.values()].filter((u) => u.faction === side && !wing.has(u.id) && !u.goliath);
        const scout =
          mine.find((u) => u.kind === "scout") ??
          army.filter((u) => u.kind === "wasp" || u.kind === "stinger").sort((a, b) => UNITS[b.kind].speed - UNITS[a.kind].speed || a.id - b.id)[0];
        if (scout) {
          const h = [...homes].sort((a, b) => dist(a.x, a.y, scout.x, scout.y) - dist(b.x, b.y, scout.x, scout.y))[0]!;
          lookSent = w.tick;
          held.set(scout.id, w.tick + LOOK_EVERY * TICK_RATE);
          look = { rank: Rank.Push, cmd: { type: "move", faction: side, unitIds: [scout.id], x: h.x, y: h.y }, planned: false };
        }
      }
    }
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

  /**
   * Keep the last wave sent (AiState.wave) together on its way: the fast
   * units that get well ahead of its middle wait just ahead of it till the
   * rest catch up, so it arrives as one, not a trickle into the enemy. Off
   * once it's close, in contact, or the wave has moved on to other orders.
   */
  function march(w: World, dodging: Set<number>): Want[] {
    const wave = s.wave;
    if (!wave) return [];
    if (wave.tick !== waveTick) {
      // a new wave: the last one's waiting are the plan's again
      for (const id of waiting.keys()) held.delete(id);
      waiting.clear();
      waveTick = wave.tick;
    }
    const dest = { x: wave.x, y: wave.y };
    const res: Want[] = [];
    const wing = new Set([...strikeHolds(w, side, s), ...sortieHolds(s), ...feintHolds(s), ...siegeHolds(s)]);
    const going = (u: Unit) => u.order.type === "attackMove" && dist(u.order.x, u.order.y, dest.x, dest.y) <= 0.5;
    const units = wave.ids
      .map((id) => w.units.get(id))
      .filter((u): u is Unit => !!u && u.faction === side && UNITS[u.kind].dps > 0 && !wing.has(u.id) && !dodging.has(u.id));
    const marching = units.filter((u) => waiting.has(u.id) || going(u));
    // (its orders may not be out yet: the APM cap sends the plan's in turn)
    if (2 * marching.length < units.length && w.tick - wave.tick < MARCH_SEND * TICK_RATE) return [];
    // (contact: an armed enemy at hand, not a long gun's reach off: artillery would end every march at the gate)
    const enemies = seenEnemies(w, side).filter((e) => e.kind !== "harvester" && (UNITS[e.kind].dps > 0 || !!e.goliath));
    const contact = marching.some((u) => enemies.some((e) => dist(u.x, u.y, e.x, e.y) <= MARCH_CONTACT));
    const r = (u: Unit) => dist(u.x, u.y, dest.x, dest.y);
    const sorted = [...marching].sort((a, b) => r(a) - r(b) || a.id - b.id);
    const pace = sorted[Math.floor(sorted.length / 2)];
    const over =
      !pace || marching.length < 3 || 2 * marching.length < units.length || contact || r(pace) <= MARCH_ARRIVE ||
      w.tick - wave.tick > MARCH_MAX * TICK_RATE;
    const go = (ids: number[]) => {
      for (const id of ids) {
        waiting.delete(id);
        held.delete(id);
      }
      if (ids.length) res.push({ rank: Rank.March, cmd: { type: "attackMove", faction: side, unitIds: ids, x: dest.x, y: dest.y }, planned: false });
    };
    if (over) {
      // still on its way (close, or in contact): the waiting go in with it; else (recalled, broken up) the plan has them
      const still = !pace || 2 * marching.length < units.length ? [] : [...waiting.keys()].filter((id) => w.units.has(id));
      go(still);
      for (const id of waiting.keys()) held.delete(id);
      waiting.clear();
      s.wave = undefined;
      return res;
    }
    const m = r(pace);
    // caught up (or waited long enough): on with the wave
    go(marching.filter((u) => waiting.has(u.id) && (r(u) >= m - MARCH_CATCH || w.tick - waiting.get(u.id)! > MARCH_WAIT * TICK_RATE)).map((u) => u.id));
    // well ahead of the middle: wait just ahead of it
    const ahead = marching.filter((u) => !waiting.has(u.id) && r(u) < m - MARCH_LEAD).map((u) => u.id);
    if (ahead.length) {
      const spot = toward(pace.x, pace.y, dest, MARCH_AHEAD);
      for (const id of ahead) waiting.set(id, w.tick);
      res.push({ rank: Rank.March, cmd: { type: "attackMove", faction: side, unitIds: ahead, x: spot.x, y: spot.y }, planned: false });
    }
    // the plan doesn't send the waiting back to the staging point meanwhile
    for (const id of waiting.keys()) held.set(id, w.tick + 2 * reactTicks + TICK_RATE);
    return res;
  }

  /** The fight micro: break off lost fights, step hurt units back, focus fire. */
  function fights(w: World, dodging: Set<number>): Want[] {
    const res: Want[] = [];
    const hq = hqOf(w, side);
    const home = hq ? buildingCenter(hq) : null;
    const enemies = seenEnemies(w, side).filter((e) => !e.goliath && (UNITS[e.kind].dps > 0 || UNITS[e.kind].heal));
    const wing = new Set([...strikeHolds(w, side, s), ...sortieHolds(s), ...feintHolds(s), ...siegeHolds(s)]);
    const army = [...w.units.values()].filter(
      (u) =>
        u.faction === side && !u.goliath && UNITS[u.kind].dps > 0 && u.kind !== "harvester" && !wing.has(u.id) &&
        !dodging.has(u.id) && (u.order.type === "idle" || u.order.type === "attackMove" || u.order.type === "attack")
    );
    const defences = [...w.buildings.values()].filter(
      (b) => b.faction !== side && BUILDINGS[b.kind].dps > 0 && isVisible(w, side, b.tx, b.ty)
    );
    // our Goliaths that can fight: they count in a fight by them, and a lost fight falls back to one
    const goliaths = goliathsOf(w, side).filter((g) => !isLifted(g) && g.hp > GOLIATH_COVER_HP * UNITS.goliath.hp);
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
        const by = goliaths.filter((g) => dist(g.x, g.y, cx, cy) <= FIGHT_RADIUS);
        const mine = strength([...ours, ...by], theirs, towers.length > 0);
        const them =
          strength(theirs, ours, false) + towers.reduce((a, b) => a + BUILDINGS[b.kind].dps, 0) * towers.reduce((a, b) => a + b.hp, 0);
        if (mine < K.breakOff * them) {
          // back under a Goliath of ours between the fight and home (its guns cover the retreat), else toward home
          const cover = goliaths
            .filter((g) => dist(g.x, g.y, cx, cy) <= GOLIATH_COVER_REACH && dist(g.x, g.y, home.x, home.y) < dist(cx, cy, home.x, home.y))
            .sort((a, b) => dist(a.x, a.y, cx, cy) - dist(b.x, b.y, cx, cy) || a.id - b.id)[0];
          const back = cover ? toward(cover.x, cover.y, home, 2) : toward(cx, cy, home, 10);
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
          // (back as far as the HQ's side, never into it: a spot it can't reach had it ordered there every pass)
          const d = dist(u.x, u.y, home.x, home.y);
          if (d <= HOME_SIDE + 1) continue;
          const back = toward(u.x, u.y, home, Math.min(7, d - HOME_SIDE));
          leaving.add(u.id);
          held.set(u.id, w.tick + 6 * TICK_RATE);
          res.push({ rank: Rank.Retreat, cmd: { type: "move", faction: side, unitIds: [u.id], x: back.x, y: back.y }, planned: false });
        }
      // --- kiting: what outranges the enemy closing on it steps back out of its reach (ai/kite.ts)
      if (K.kite) {
        const step = kiteStep(w, c.filter((u) => !leaving.has(u.id)), theirs, home);
        if (step) {
          for (const id of step.ids) {
            leaving.add(id);
            held.set(id, w.tick + 2 * reactTicks + TICK_RATE);
          }
          res.push({ rank: Rank.Kite, cmd: { type: "move", faction: side, unitIds: step.ids, x: step.x, y: step.y }, planned: false });
        }
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

/** How far from the HQ's centre a unit stepping back home stops (it's a 3×3 footprint). */
const HOME_SIDE = 3;

function toward(x: number, y: number, to: { x: number; y: number }, d: number) {
  const len = Math.max(1, dist(x, y, to.x, to.y));
  const k = Math.min(1, d / len);
  return { x: x + (to.x - x) * k, y: y + (to.y - y) * k };
}
