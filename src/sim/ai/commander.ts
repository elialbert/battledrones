import { BUILDINGS, ECONOMY, GOLIATH, OBJECTIVES, UNITS } from "../balance";
import { TICK_RATE } from "../balance";
import { buildRadiusOf, buildingBlocker, canPlaceBuilding, nearestReachableResource, nearestScrapTile, unitBlocker } from "../economy";
import { SERVED, UNSAFE, UNWALKED, expansionSite, expansionSites, perTick, staffExpansions, tendExpansion, unservedField, walkFromDrops, type ExpansionPlan } from "./expansion";
import { tendFields } from "./fields";
import { baseEntrances } from "./choke";
import { isVisible, knownBuildings, type KnownBuilding } from "../fog";
import { isOut } from "../combat";
import { QUARTER, isMulti, rivalsOf, turnPoint } from "../sides";
import { isInfantry } from "../infantry";
import { earlyCallBonus, survivalHoldPoint, waveBudget } from "../modes/survival";
import { findPath } from "../movement";
import { isCramped, sealsOff } from "../placement";
import { isWoundedVeteran, veteranRetreats } from "./veterans";
import { planMenders } from "./menders";
import { bannedBy, infantryArmy } from "../rules";
import { planSalvage } from "./salvage";
import { planStrike, strikeHolds, strikeWants } from "./hornets";
import { planSorties, sortieHolds, type SortieKind } from "./harass";
import { feintHolds, planFeint, type Trick } from "./feint";
import { planSiege, siegeHolds, type Hop } from "./siege";
import { objectiveHolds, planObjectives } from "./objectives";
import { dodgeCalldowns, dodgingUnits, planCalldowns } from "./powers";
import { offHome, planSkylift, skyliftWantsCondor } from "./skylift";
import { AIRBORNE_INFANTRY, condorHolds, flysGivenCondor, planCondor, wantCondor } from "./condor";
import { AIRLIFT, airliftActive, airliftHolds, airliftSquadsWanted, airliftWantsCondor, offHomeLand, planAirlift } from "./airlift";
import { DOCTRINES, DOCTRINE, doctrineUnit, reviewDoctrine, underDoctrine, type DoctrinePlan, type DoctrineState } from "./doctrine";
import { AA_COVER, USELESS, aaSources, aaStrengthAt, aaWeight, effectivenessVs, seenEnemies, unitAntiAir } from "./intel";
import {
  GOLIATH_AI,
  enemyGantryBuilds,
  enemyHqGone,
  goliathBarracks,
  goliathFund,
  goliathHarvest,
  goliathHolds,
  huntGoliaths,
  liftCondors,
  liftWantsCondors,
  lostHome,
  noteGantryFailed,
  noteNoRoom,
  noteGoliathOrdered,
  noteHome,
  outpostSpot,
  outpostWanted,
  planGoliaths,
  threatValue,
  wantGantry,
  wantGoliath
} from "./goliath";
import { canWalk, distToFootprint, goliathsOf, hasGoliath, isAnchored, repairUrgency, trainableAt, unitCost } from "../goliath";
import type {
  ArmorClass,
  Building,
  BuildingKind,
  Command,
  Domain,
  Faction,
  TargetDomain,
  Unit,
  UnitKind,
  World
} from "../types";
import { Terrain } from "../types";
import {
  buildingCenter,
  canGetWithin,
  dist,
  domainOf,
  hqOf,
  isResource,
  moveClassOf,
  nearestDropOff,
  passable,
  regionAt,
  regionLabels,
  sideFrame,
  tileIndex
} from "../world";

export type AiMode = "buildup" | "harass" | "assault";
export type Difficulty = "easy" | "casual" | "normal" | "hard" | "brutal";

/** A commander personality: opening, economy size, army mix, aggression. */
export interface Strategy {
  name: StrategyName;
  /** One-line description for the spectator HUD. */
  label: string;
  /** Buildings wanted, in order (duplicates = build that many). */
  buildOrder: BuildingKind[];
  harvesters: number;
  /** Army value (scrap cost) that triggers the all-in assault. */
  assaultValue: number;
  /**
   * The all-in also goes once this much of the army's value is tier 2 (units
   * the Tech Lab unlocks), whatever the rest: Turtle's mid-game push.
   */
  techAssault?: number;
  /** Idle raiders required before a harass raid launches. */
  harassGroup: number;
  /** Air force first: the Fab Plant only makes anti-air and a small home guard. */
  airOnly?: boolean;
  /** Lean on heavy tech ground units (mastodons, lancers, mortars). */
  heavy?: boolean;
  /** Early raids use stingers as well as wasps. */
  groundRaids?: boolean;
  /**
   * Share of the army's value it keeps in robot infantry once it has an
   * Assembly Bay (Troopers, with Rocket Squads against armour and air).
   * Without it, the Bay only answers what it sees: Rockets for Mastodons,
   * Snipers for enemy infantry.
   */
  infantry?: number;
  /** Rocket Squads it keeps per Mastodon of its own, as escorts (Ironclad). */
  escorts?: number;
  /** No Assembly Bay in its plans, but it builds one for Rocket Squads once it has seen heavy armour (Mastodons, Hornets). */
  bayVsArmour?: boolean;
  /**
   * Scrap piling up is spent, not banked: deeper queues, the dearer unit of
   * each choice, more factories sooner. For a commander on an action budget
   * (ai/marshal.ts), where each order is worth more when it buys more.
   */
  spendDown?: boolean;
  /** A field this far from the nearest drop-off gets a depot by it (9 if unset): nearer means shorter hauls. */
  depotReach?: number;
  /** Seconds of peace: no raids or assaults before this (it still defends). */
  holdUntil?: number;
  /** Hold the way into the base (ai/choke.ts), not the mining line: the guard, and the whole army while it builds up, stand there, and the turrets go up toward it. */
  holdChoke?: boolean;
  /** Share of its Fab Plants' orders that are Mortars once the Tech Lab stands (up to mortarCap at a time): splash for a tank flood at the gate. */
  mortarShare?: number;
  /** The most Mortars mortarShare keeps at a time (4 if unset). */
  mortarCap?: number;
  /** A turret more for every this many enemy ground units seen (up to 4): Turtle digs in against a tank rush. */
  turretsVsGround?: number;
  /** Seconds before its first raid may leave, instead of OPENING_GRACE (Rush: the Blitz opener's Stingers go at once). */
  raidFrom?: number;
  /**
   * A third tier-1 factory ahead of the Tech Lab: its 35 s hold the only build slot, and with a Fab
   * Plant and an Airpad to spend on, Brutal banked 1,800 scrap behind it (replay 2026-11-05).
   */
  factoryBeforeLab?: boolean;
  /** Scrap piling up (`rich`) buys squads from the Assembly Bays, past the plan's infantry share. */
  bayOverflow?: boolean;
  /** Changes to SPEND for this personality. */
  spend?: Partial<typeof SPEND>;
  /** Scrap piling up adds factories even before the build order is through, and they come next, not last. */
  expandEarly?: boolean;
  /**
   * The Wall (ai/marshal.ts): turrets are the plan. After the build order it
   * keeps putting turrets up (a SAM Site after every `samEvery`th) to `max`.
   * No crew founds a Depot past the build zone: turrets are built out toward
   * the field one after another, each carrying the zone on (economy.ts
   * buildRadiusOf), until a Depot fits by it, a turret out there coming
   * ahead of the rest of the order; each Depot out past home gets `guard`
   * turrets on the enemy's side, and with no field left to reach the
   * turrets creep on toward the enemy's drop-offs (wallAnchor). The Tech Lab
   * waits for the `tech`th turret; the factories stop at an army worth
   * `army`, plus `armyPerTurret` a turret standing, unless scrap piles up.
   */
  wall?: { max: number; samEvery: number; guard: number; tech: number; army: number; armyPerTurret: number };
  /**
   * Land Grab (ai/marshal.ts): every field is worth having, past the halfway
   * line too. The base builds out to fields on either side and the guard
   * stands by the expansion nearest the enemy wherever it is; a site with
   * enemies by it is fought for by most of the army (CONTEST_SHARE) if that
   * fight looks winnable (contestable), else the crew goes to the next quiet field.
   */
  landGrab?: boolean;
  /**
   * The Feint (ai/feint.ts): a trick from `from` s, once the army is worth `army` (scaled as
   * a wave is), up to `tricks` of them, with the stock waves off between
   * (assaultValue Infinity) and at `after` once one is sprung. `onTrick`: each
   * trick as it starts, kept up to date as it plays (traces).
   */
  feint?: { from: number; army: number; after: number; tricks: number; onTrick?: (t: Trick) => void };
  /**
   * Siege Train (ai/siege.ts): a column leaves from `from` s, once there are
   * `mortars` Mortars and an army worth `army` (scaled as a wave is).
   * `onHop`: each hop as it starts, kept up to date as it plays (traces).
   */
  siege?: { from: number; mortars: number; army: number; onHop?: (h: Hop) => void };
  /** Commit to one army from `from` seconds on, and change it on what's seen (ai/doctrine.ts). */
  doctrine?: DoctrinePlan;
}

export type StrategyName = "balanced" | "rush" | "airswarm" | "boom" | "skyforce" | "ironclad";

export const STRATEGIES: Record<StrategyName, Strategy> = {
  /** Steady macro: factory, airpad, tech, then an Assembly Bay; standard timing, the odd Condor drop. */
  balanced: {
    name: "balanced",
    label: "Balanced",
    buildOrder: ["fab-plant", "airpad", "turret", "tech-lab", "assembly-bay", "depot", "turret", "radar"],
    harvesters: 4,
    assaultValue: 1700,
    harassGroup: 2,
    infantry: 0.25
  },
  /**
   * Early ground pressure: Troopers from an early Assembly Bay alongside
   * Stinger raids in packs of five, two factories, the earliest and smallest
   * waves, Condor drops on the harvesters. A fifth harvester pays for it:
   * every side's starting Trooper Squad blunts the opening raids (at 4 it
   * won 18–26% of tools/pacing.ts games with infantry in; 40% at 5).
   */
  rush: {
    name: "rush",
    label: "Rush",
    buildOrder: ["fab-plant", "assembly-bay", "turret", "airpad", "fab-plant", "tech-lab"],
    harvesters: 5,
    assaultValue: 1400,
    harassGroup: 5,
    groundRaids: true,
    infantry: 0.4
  },
  /** Airpad first: relentless wasp raids, bombers later; Rocket Squads when Mastodons show up. */
  airswarm: {
    name: "airswarm",
    label: "Air Swarm",
    buildOrder: ["airpad", "fab-plant", "turret", "tech-lab", "depot", "airpad"],
    harvesters: 4,
    assaultValue: 1700,
    harassGroup: 2,
    bayVsArmour: true
  },
  /**
   * Greedy economy: extra harvesters, a forward depot, a huge late push;
   * Rocket Squads from an Assembly Bay once Mastodons show up.
   * (The depot comes after a turret and the Tech Lab: with every side's
   * starting Trooper Squad on guard, a depot second won it 74–76% of
   * tools/pacing.ts games; 61% this way.)
   */
  boom: {
    name: "boom",
    label: "Boom",
    buildOrder: ["fab-plant", "turret", "tech-lab", "depot", "airpad", "turret", "radar", "sam-site"],
    harvesters: 4,
    assaultValue: 2000,
    harassGroup: 3,
    bayVsArmour: true
  },
  /**
   * Air force: wasps, raptors and hornets; the late Fab Plant only guards
   * home, and Rocket Squads from an Assembly Bay join it once Mastodons show up.
   */
  skyforce: {
    name: "skyforce",
    label: "Skyforce",
    buildOrder: ["airpad", "turret", "tech-lab", "airpad", "fab-plant", "depot", "sam-site"],
    harvesters: 4,
    assaultValue: 2000,
    harassGroup: 2,
    airOnly: true,
    bayVsArmour: true
  },
  /**
   * Armoured column: rushes the Tech Lab (right after a turret) for Mastodons,
   * Lancers and Mortars, and an Assembly Bay for the Rocket Squads that
   * escort the Mastodons. (Waves at 1400: at 1500 it won 72–76% of
   * tools/pacing.ts games once infantry was in, at 1800 82%, at 1300 58%.)
   */
  ironclad: {
    name: "ironclad",
    label: "Ironclad",
    buildOrder: ["fab-plant", "turret", "tech-lab", "assembly-bay", "airpad", "depot", "fab-plant", "sam-site"],
    harvesters: 4,
    assaultValue: 1400,
    harassGroup: 3,
    heavy: true,
    escorts: 1
  }
};

/** Strategy.spendDown: scrap counts as piling up past `rich`; a queue slot per `perSlot` banked; more factories past `expandAt`, up to `maxExtra`. Strategy.depotReach: up to `maxDepots` depots (till the fields run low: RUNNING_LOW). */
export const SPEND = { rich: 600, perSlot: 400, expandAt: 600, maxExtra: 5, maxDepots: 4 };
/**
 * Scrap left per harvester in the fields our drop-offs serve, below which the depot cap
 * (Strategy.spend.maxDepots) is off: Depots follow the mining, however few the plan wanted, while
 * there's an unserved field to reach. (About 80 s of mining at Brutal's rate: a crew's walk and build.)
 * Replay 2026-11-02 (ashlands, 64 tiles): Brutal Rush, capped at two, ran its fields dry at 4:20 and
 * mined 3k to the player's 14k after 4:30. Lifting every cap at 3:00 instead cost the other plans
 * ~4k mined by 5:00 (crews of 4 used up on Depots while the old fields had plenty left), 26–46.
 */
const RUNNING_LOW = 300;
/** How many Depots a plan may have now (RUNNING_LOW). */
const depotCap = (w: World, faction: Faction, strategy: Strategy): number =>
  fieldsRunningLow(w, faction) ? Infinity : strategy.spend?.maxDepots ?? SPEND.maxDepots;
function fieldsRunningLow(w: World, faction: Faction): boolean {
  return perTick(w, `low ${faction}`, () => {
    const drops: { x: number; y: number }[] = [];
    for (const b of w.buildings.values()) if (b.faction === faction && BUILDINGS[b.kind].dropOff) drops.push(buildingCenter(b));
    let harvesters = 0;
    for (const u of w.units.values()) if (u.faction === faction && u.kind === "harvester") harvesters++;
    let left = 0;
    for (let i = 0; i < w.scrap.length; i++) {
      if (!w.scrap[i] || !isResource(w, i)) continue;
      const x = (i % w.width) + 0.5;
      const y = Math.floor(i / w.width) + 0.5;
      if (drops.some((d) => dist(x, y, d.x, d.y) <= SERVED)) left += w.scrap[i]!;
    }
    return left < RUNNING_LOW * Math.max(1, harvesters);
  });
}

export const DIFFICULTY: Record<
  Difficulty,
  {
    label: string; interval: number; incomeMult: number; extraHarvesters: number; assaultMult: number; harass: boolean;
    /** The army comes to an expansion under attack, when it can win there (not just to the HQ). */
    defendExpansions?: boolean;
    /**
     * Expands boldly: the crew goes once half the miners are working, not after a full shift on top
     * of them, and a raid at home doesn't put it off. A Depot by a field pays back so fast it's worth
     * losing one in a fight (a player beat Brutal on that alone).
     */
    boldExpand?: boolean;
    /** Personalities this difficulty picks from at random. */
    pool: StrategyName[];
  }
> = {
  easy: {
    label: "Easy", interval: 3.5, incomeMult: 0.75, extraHarvesters: -1, assaultMult: 1.35, harass: false,
    // no Skyforce: its all-air wave at ~3:00 beat a scripted first-week player
    // 11 games in 15 on Easy (tools/beginner.ts); the other three lost 6 in 45
    pool: ["balanced", "rush", "airswarm"]
  },
  // (between Easy and Normal: a little slower, no handicap below Normal's harvesters)
  casual: {
    label: "Casual", interval: 2.75, incomeMult: 0.875, extraHarvesters: 0, assaultMult: 1.15, harass: false,
    pool: ["balanced", "rush", "airswarm", "boom"]
  },
  normal: {
    label: "Normal", interval: 2, incomeMult: 1, extraHarvesters: 0, assaultMult: 1, harass: true, defendExpansions: true,
    pool: ["balanced", "rush", "airswarm", "boom", "skyforce", "ironclad"]
  },
  hard: {
    label: "Hard", interval: 1.2, incomeMult: 1.3, extraHarvesters: 1, assaultMult: 0.9, harass: true, defendExpansions: true, boldExpand: true,
    pool: ["balanced", "airswarm", "boom", "ironclad"]
  },
  // (plays as Hard; only a stock commander's handicap grows. Marshal's Brutal smaller waves lost: APM-BOTS.md)
  brutal: {
    label: "Brutal", interval: 1.2, incomeMult: 1.5, extraHarvesters: 2, assaultMult: 0.9, harass: true, defendExpansions: true, boldExpand: true,
    pool: ["balanced", "airswarm", "boom", "ironclad"]
  }
};

export interface AiState {
  mode: AiMode;
  strategy: Strategy;
  difficulty: Difficulty;
  lastDecisionTick: number;
  /** Rolling estimate of enemy force composition, from what we've seen. */
  seenAir: number;
  seenGround: number;
  /** Heavily armoured enemy ground units seen (mastodons, harvesters don't count). */
  seenHeavy: number;
  /** Enemy anti-air seen recently, in Flak Crawlers (intel.ts aaWeight: a Trooper Squad is 0.2). */
  seenAA: number;
  /** Enemy robot infantry squads seen recently. */
  seenInfantry: number;
  /** Tick the last scout was ordered (scouts are cheap but not free). */
  lastScoutTick: number;
  scoutLeg: number;
  /** Deterministic RNG state for tie-breaks. */
  rng: number;
  /** Extra SAM sites wanted in response to enemy air. */
  extraSams: number;
  /** Extra turrets wanted in response to enemy infantry. */
  extraTurrets: number;
  /** Extra production buildings wanted because scrap is piling up. */
  extraProduction: number;
  /** Depot build order entries we gave up on (no useful spot). */
  skippedDepots: number;
  /** An expansion Depot's crew on its way to found it (ai/expansion.ts). */
  expansion?: ExpansionPlan | null;
  /** Our Depots last think, to tell which fell (hotSpots). */
  depotsStanding?: Map<number, { x: number; y: number }>;
  /** Where a Depot of ours fell, and when (DEPOT_LOST_HOLD). */
  depotsLost?: { x: number; y: number; tick: number }[];
  /** This think's ground no Depot goes up on and no crew walks to: see noteHotSpots. */
  hotSpots?: { x: number; y: number }[];
  /** The expansion site the army is fighting for (Strategy.landGrab; ai/expansion.ts tendExpansion). */
  contest?: { x: number; y: number } | null;
  /** Harass raids launched: every other one looks in on where the enemy would expand. */
  raids?: number;
  /** Army value when the current wave launched (for retreat decisions). */
  waveValue: number;
  /**
   * Weighs its moves against the enemy army it remembers (ai/marshal.ts):
   * a wave launches only when it outweighs that army (WAVE_EDGE), and the
   * whole army gathers for it; no Wasps or Hornets into massed flak, nor
   * more Airpads; no Gantry while behind. `sightings`: each armed enemy
   * unit seen lately, its worth and where (SIGHTING_TTL); `waveReady`: the
   * tick a wave was first ready to go.
   */
  weighs?: boolean;
  /** Flies crews up to fields no harvester can drive to (ai/skylift.ts). */
  skylift?: boolean;
  sightings?: Map<number, { kind: UnitKind; value: number; tick: number; x: number; y: number; faction: Faction }>;
  /** The army it has committed to (ai/doctrine.ts), once Strategy.doctrine has one. */
  doctrine?: DoctrineState;
  waveReady?: number | null;
  /** When WAVE_EDGE first held a wave back that was otherwise ready (null: it isn't). */
  waveStall?: number | null;
  /** The last wave sent: its units and where it marches (ai/marshal.ts keeps it together on the way). */
  wave?: { ids: number[]; x: number; y: number; tick: number };
  /** No income handicap: the difficulty changes only how it plays (ai/bots.ts seats are all fair). */
  fair?: boolean;
  /** Seconds between decision passes, instead of the difficulty's (ai/marshal.ts thinks at its own pace). */
  interval?: number;
  /**
   * How its Goliaths play (ai/goliath.ts): "expand" (ai/marshal.ts) never
   * walks one with a wave or to a forward post, only to fields on our half
   * of the map, falls back when it's outgunned on the way, has the Depot
   * built as it arrives and moves on to the next field once the Depot stands,
   * and covers our army's fights near it, dug in behind the line. "rush" (Marshal's Juggernaut plan) has the Gantry early and pushes for
   * the enemy's HQ with its Goliath and a big escort.
   */
  goliathStyle?: "expand" | "rush";
  /**
   * How its Hornets play (ai/hornets.ts): "strike" (Marshal's Hornet Strike
   * plan) builds a wing of them first, hides it by a far corner of the map
   * and bombs the enemy's HQ when their army comes at ours. They are never
   * the army's.
   */
  hornetStyle?: "strike";
  /** Harassment sorties it flies (ai/harass.ts: Marshal's plans pick them). */
  sorties?: readonly SortieKind[];
  /**
   * A free-for-all: the rival this commander is out to beat (pickFocus), and
   * the tick it looks again. Absent in a duel: there is only one.
   */
  focus?: Faction | null;
  focusUntil?: number;
}

/**
 * Pass a strategy for deterministic behaviour (tests); omit for random.
 * `tweak` overrides parts of the personality (Ops: a commander that never
 * attacks gets `assaultValue: Infinity, harassGroup: Infinity`).
 */
export function createAiState(strategy?: StrategyName, difficulty: Difficulty = "normal", seed?: number, tweak?: Partial<Strategy>): AiState {
  const names = DIFFICULTY[difficulty].pool;
  const picked = strategy ?? names[Math.floor(Math.random() * names.length)]!;
  return {
    mode: "buildup",
    strategy: tweak ? { ...STRATEGIES[picked], ...tweak } : STRATEGIES[picked],
    difficulty,
    lastDecisionTick: -1000,
    seenAir: 0,
    seenGround: 0,
    seenHeavy: 0,
    seenAA: 0,
    seenInfantry: 0,
    lastScoutTick: -1e9,
    scoutLeg: 0,
    rng: seed ?? 12345,
    extraSams: 0,
    extraTurrets: 0,
    extraProduction: 0,
    skippedDepots: 0,
    waveValue: 0
  };
}

const RETREAT_ARMY_VALUE = 350;
/** Defences go up at least this far (tiles) out in front of the HQ. */
const DEFENCE_FRONT = 4;
/** No Depot goes back up where one fell for this long, whatever's in sight: what killed it has only stepped out of view. */
const DEPOT_LOST_HOLD = 45 * TICK_RATE;
/** An enemy remembered (AiState.sightings) counts for a site this long after it was seen. */
const HOT_MEMORY = 15 * TICK_RATE;

/**
 * This think's AiState.hotSpots: armed enemies seen, those remembered lately, and where a Depot of
 * ours fell lately. A Depot's site is judged from these, not from what's in sight: the army that
 * kills a forward Depot takes its sight with it.
 */
function noteHotSpots(w: World, faction: Faction, s: AiState, seen: readonly Unit[]): void {
  const now = new Map<number, { x: number; y: number }>();
  for (const b of w.buildings.values()) if (b.faction === faction && b.kind === "depot") now.set(b.id, buildingCenter(b));
  const lost = (s.depotsLost ?? []).filter((d) => w.tick - d.tick <= DEPOT_LOST_HOLD);
  for (const [id, at] of s.depotsStanding ?? []) if (!now.has(id)) lost.push({ ...at, tick: w.tick });
  s.depotsStanding = now;
  s.depotsLost = lost;
  const spots: { x: number; y: number }[] = [...lost];
  const armed = (k: UnitKind) => UNITS[k].dps > 0 && k !== "harvester";
  for (const e of seen) if (armed(e.kind)) spots.push({ x: e.x, y: e.y });
  for (const e of s.sightings?.values() ?? []) if (armed(e.kind) && w.tick - e.tick <= HOT_MEMORY) spots.push({ x: e.x, y: e.y });
  s.hotSpots = spots;
}

/**
 * Share of the assault threshold that must gather at the staging point
 * before a wave launches: big waves, and a lull while the next one gathers
 * (at 0.6 waves trickled out every 500–1,200 scrap, fighting never paused,
 * and the side ahead at 4:00 won 87–90%).
 */
const WAVE_LAUNCH = 0.75;
/** A weighing commander's wave must be worth this many times the enemy army it remembers. */
const WAVE_EDGE = 1.2;
/** …and waits this long for the rest of the army to reach the staging point, once it's enough. */
const WAVE_GATHER = 15 * TICK_RATE;
/**
 * A wave held back by WAVE_EDGE this long goes anyway, with what has gathered, if that's at least
 * WAVE_STALL_EDGE of the army remembered. Two even armies each waiting for 1.2× the other never
 * moved (Three Canyons: mirror games sat out 40 minutes, mined dry, with 70k armies).
 */
const WAVE_STALL = 120 * TICK_RATE;
const WAVE_STALL_EDGE = 0.75;
/** How long an enemy unit seen stays in the remembered army (unless its spot is seen empty). */
const SIGHTING_TTL = 90 * TICK_RATE;
/** Enemy anti-air (in Flak, AiState.seenAA) past which a weighing commander's Airpads build no Wasps or Hornets… */
const FLAK_WALL = 3;
/** …unless its strike aircraft outnumber that flak this many times over. */
const FLAK_OUTNUMBER = 2;
/** No raids before this: an opener's starting units guard home while both sides settle in. */
const OPENING_GRACE = 45 * TICK_RATE;
/** Enemy army value at the HQ that, if it outguns the home guard, recalls everyone. */
const HOME_ALARM_VALUE = 400;
/** Visible armed enemies this close to our buildings/harvesters are threats. */
const DEFENSE_RADIUS = 11;
/** Bold expansion (Difficulty.boldExpand): harvesters left mining while a crew goes, at least. */
const BOLD_KEEP = 5;
/**
 * An expansion's raiders (scrap value) the army goes out to, if what it can send is at least this
 * share of them (Difficulty.defendExpansions). Replay 2026-10-31 (dune-sea): Brutal's army, as big as
 * the raid, sat by its HQ while the raid killed 22 harvesters and both Depots 17 tiles away.
 */
const EXPANSION_DEFEND_ODDS = 0.9;

const GUARD_RADIUS = 5;
const STAGE_RADIUS = 6;
/** The army (the Condor is transport, not a combat unit: ai/condor.ts flies it). */
const COMBAT_KINDS: UnitKind[] = [
  "stinger", "flak-crawler", "mortar", "mastodon", "lancer", "wasp", "raptor", "hornet", "mender",
  "trooper", "rocket-squad", "sniper"
];

const INFANTRY_KINDS: UnitKind[] = ["trooper", "rocket-squad", "sniper"];

const mirror = (w: World, x: number, y: number) => ({ x: w.width - x, y: w.height - y });

/** A free-for-all's focus holds this long before it is looked at again (s), unless that side is knocked out. */
const FOCUS_SECS = 100;
/** A raid at home this big (scrap value) turns the focus on whoever sent it, for at least this long (s). */
const GRUDGE_VALUE = 400;
const GRUDGE_SECS = 70;

/**
 * Where `rival`'s base is, from ours (`origin`, where our HQ stands or stood):
 * the map is symmetric, so it is our spot turned onto their corner (a duel's:
 * the mirror image).
 */
function homeOf(w: World, faction: Faction, rival: Faction, origin: { x: number; y: number }): { x: number; y: number } {
  return turnPoint((QUARTER[rival] - QUARTER[faction] + 4) & 3, w.width, w.height, origin.x, origin.y);
}

/**
 * A free-for-all's focus: the rival this commander builds its waves, raids
 * and strikes against. A side that raids our base earns a grudge (focus on
 * it at once); otherwise the focus holds for FOCUS_SECS, then goes to the
 * rival that looks easiest: near (its base's distance from ours), and hurt
 * (its HQ's health, when we have seen it), with a seeded shuffle so four
 * commanders don't all pile onto the same one. Knocked-out sides are skipped.
 */
function pickFocus(w: World, faction: Faction, s: AiState, origin: { x: number; y: number }, raiders: Map<Faction, number>): Faction | null {
  const rivals = rivalsOf(w, faction).filter((f) => !isOut(w, f));
  if (rivals.length === 0) return null;
  let grudge: Faction | null = null;
  let worst = GRUDGE_VALUE;
  for (const f of rivals) {
    const v = raiders.get(f) ?? 0;
    if (v >= worst) {
      worst = v;
      grudge = f;
    }
  }
  if (grudge) {
    if (s.focus !== grudge) s.focusUntil = w.tick + GRUDGE_SECS * TICK_RATE;
    s.focus = grudge;
    return grudge;
  }
  if (s.focus && rivals.includes(s.focus) && w.tick < (s.focusUntil ?? 0)) return s.focus;
  let best: Faction | null = null;
  let bestScore = Infinity;
  for (const f of rivals) {
    const home = homeOf(w, faction, f, origin);
    const hq = knownBuildings(w, faction).find((kb) => kb.kind === "hq" && kb.faction === f);
    const live = hq ? w.buildings.get(hq.id) : undefined;
    const health = live && isVisible(w, faction, hq!.tx + 1, hq!.ty + 1) ? live.hp / BUILDINGS.hq.hp : 1;
    const score = dist(origin.x, origin.y, home.x, home.y) * (0.6 + 0.4 * health) + rand(s) * 18;
    if (score < bestScore) {
      bestScore = score;
      best = f;
    }
  }
  s.focus = best;
  s.focusUntil = w.tick + FOCUS_SECS * TICK_RATE;
  return best;
}

const canHitDomain = (targets: TargetDomain, domain: Domain): boolean =>
  targets === "both" || targets === domain;

const value = (units: Unit[]) => units.reduce((v, u) => v + UNITS[u.kind].cost, 0);

function rand(s: AiState): number {
  s.rng = (s.rng * 1103515245 + 12345) & 0x7fffffff;
  return s.rng / 0x7fffffff;
}

/**
 * The enemy commander. Runs a decision pass every couple of seconds and
 * returns ordinary commands — it plays by the same rules (and fog) as the
 * player. Difficulty changes its reaction speed, harvester count and
 * assault timing, and (unless the commander is `fair`) its income.
 */
export function tickAi(w: World, faction: Faction, s: AiState): Command[] {
  const diff = DIFFICULTY[s.difficulty];
  w.factions[faction].incomeMult = s.fair ? 1 : diff.incomeMult;
  // no HQ, no commander — unless a Goliath fights on (a side is beaten only once its HQ and all
  // its Goliaths are gone: GOLIATH.md); Last Stand's waves are the director's alone (not even the dodge reflex)
  const hq = hqOf(w, faction);
  if (!hq && !hasGoliath(w, faction)) return [];
  // calldown reflex: scatter from enemy reticles every tick, not just on decision passes
  const reflex = w.winner ? [] : dodgeCalldowns(w, faction, s);
  if (w.tick - s.lastDecisionTick < (s.interval ?? diff.interval) * TICK_RATE || w.winner) return reflex;
  s.lastDecisionTick = w.tick;

  const cmds: Command[] = reflex;
  const f = w.factions[faction];
  const mine = [...w.units.values()].filter((u) => u.faction === faction);
  const myBuildings = [...w.buildings.values()].filter((b) => b.faction === faction);
  const allHarvesters = mine.filter((u) => u.kind === "harvester");
  // (those on a mesa, or boarding for one, are the mesa run's: ai/skylift.ts)
  const harvesters = s.skylift ? allHarvesters.filter((u) => !offHome(w, hq, u)) : allHarvesters;
  // (island maps: squads holding an island relay, or stranded on one, are the airlift's — ai/airlift.ts —
  // never counted toward a wave they can't walk to)
  // (nor are the Hornets of a strike wing, ai/hornets.ts, nor a sortie out harassing, ai/harass.ts)
  const wing = new Set([...strikeHolds(w, faction, s), ...sortieHolds(s)]);
  const army = mine.filter((u) => COMBAT_KINDS.includes(u.kind) && !offHomeLand(w, faction, u) && !wing.has(u.id));
  const airlifts = airliftActive(w, faction, s);
  const armyValue = value(army);
  const count = (k: UnitKind) => mine.filter((u) => u.kind === k).length;
  // (Goliaths are their own planner's, never the army's: ai/goliath.ts)
  const goliaths = goliathsOf(w, faction).sort((a, b) => a.id - b.id);
  // (squads training at an anchored Goliath count as queued too)
  const queued = (k: UnitKind) =>
    myBuildings.reduce((n, b) => n + b.queue.filter((q) => q.kind === k).length, 0) +
    goliaths.reduce((n, g) => n + g.goliath!.queue.filter((q) => q.kind === k).length, 0);
  const have = (k: UnitKind) => count(k) + queued(k);
  const has = (k: BuildingKind) => myBuildings.some((b) => b.kind === k);

  const seen = seenEnemies(w, faction); // through fog and Sniper concealment alike
  observeEnemy(s, seen, enemyGantryBuilds(w, faction).length);

  // where our HQ stands, or stood (Nomads: where our Goliath started): the enemy's home is its
  // mirror image, and that stays put (a free-for-all's: the focus rival's corner, homeOf)
  const origin = hq ? buildingCenter(hq) : lostHome(w, faction, s);
  if (hq) noteHome(s, origin);
  const multi = isMulti(w);
  // the base: the HQ, else (lost, or Nomads) our first dug-in Goliath, else where the HQ stood
  const baseGoliath = hq ? undefined : goliaths.find(isAnchored);
  const hqC = baseGoliath ? { x: baseGoliath.x, y: baseGoliath.y } : origin;
  // island maps: the two landmasses meet only at the bridges, and a field on
  // the enemy's side of them is theirs to defend, not ours to mine
  const islandMap = !!w.rules?.islands;
  // --- threats: armed intruders near our buildings, harvesters or Uplinks ---
  const threats = findThreats(w, faction, seen, myBuildings, harvesters);
  // (where our base is, for the raid tally below: the HQ, else a dug-in Goliath, else where the HQ stood)
  const home0 = hq ? origin : goliaths.find(isAnchored) ?? origin;
  // a free-for-all: who we're out to beat this pass (a raid on our base turns us on the raider)
  const focus = multi ? pickFocus(w, faction, s, origin, raidersAt(w, threats, home0)) : null;
  const enemyHome = focus ? homeOf(w, faction, focus, origin) : mirror(w, origin.x, origin.y);
  const enemyArmy = s.weighs ? rememberEnemyArmy(w, faction, s, seen, focus) : 0;
  noteHotSpots(w, faction, s, seen);
  const ourSide = (tx: number, ty: number) =>
    dist(tx + 0.5, ty + 0.5, hqC.x, hqC.y) <= dist(tx + 0.5, ty + 0.5, enemyHome.x, enemyHome.y);
  const nearestField = nearestScrapTile(w, hqC.x, hqC.y, faction);
  const activeField = nearestField && (!islandMap || ourSide(nearestField.x, nearestField.y)) ? nearestField : null;
  /** Where the economy needs defending: the way into the base (Strategy.holdChoke), else the mined field, shaded toward home. */
  const [entrance] = s.strategy.holdChoke && hq && !baseGoliath ? baseEntrances(w, faction) : [];
  // (an expansion out past the home field is where the economy is exposed: the guard stands by it)
  // (Land Grab: either side of the halfway line is ours to hold)
  const claimable = s.strategy.landGrab ? () => true : ourSide;
  const outGuard = entrance || !hq ? null : expansionGuard(w, faction, hqC, enemyHome, claimable);
  const contest = !entrance && hq ? s.contest ?? null : null;
  const guardPoint = entrance
    ? entrance.hold
    : contest
    ? contest
    : outGuard
    ? outGuard
    : activeField
    ? {
        x: activeField.x + 0.5 + Math.sign(hqC.x - activeField.x - 0.5) * 1.5,
        y: activeField.y + 0.5 + Math.sign(hqC.y - activeField.y - 0.5) * 1.5
      }
    : hqC;

  threats.sort((a, b) => dist(a.x, a.y, hqC.x, hqC.y) - dist(b.x, b.y, hqC.x, hqC.y));
  // (a Goliath counts for what it can still fire: ai/goliath.ts threatValue)
  const atHome = threats.filter((t) => dist(t.x, t.y, hqC.x, hqC.y) <= DEFENSE_RADIUS);
  const raidValue = atHome.reduce((v, t) => v + t.value, 0);
  const threatened = raidValue >= HOME_ALARM_VALUE;
  const enemyHqKnown = knownBuildings(w, faction).find((b) => b.kind === "hq" && (!focus || b.faction === focus));
  const enemyHqPos = enemyHqKnown ? { x: enemyHqKnown.tx + 1.5, y: enemyHqKnown.ty + 1.5 } : enemyHome;

  // --- construction: place a ready building, or start the next one -------
  // (late in a match, rich and with an army: a Gantry and whatever it needs first, ai/goliath.ts)
  // (with no HQ, lost or Nomads, there's a Gantry only while a Goliath is dug in to build round)
  const gantryWanted = (!!hq || !!baseGoliath) && wantGantry(w, faction, s, { armyValue, threatened, home: origin, enemyHome, behind: armyValue < enemyArmy });
  // (the base builds out to the next field instead of sending a crew: set below, once the order is read)
  let creepAt: { x: number; y: number } | null = null;
  // (the home field lies behind the HQ, so "by the mining line" was the back of the base: two Turrets
  // there never fired while the HQ died a few tiles off, replay 2026-11-05. They go up in front of it.)
  const defencePoint = hq && !entrance && inFrontBy(hqC, guardPoint, enemyHome) < DEFENCE_FRONT ? towardEnemy(w, hqC, DEFENCE_FRONT, enemyHome) : guardPoint;
  /**
   * Where a building of `kind` goes: defences in front of the base, by the mining line, radar forward, the Gantry behind the
   * HQ (it is big, and always seen), production out toward the field the base is building out to
   * (creepTarget), the rest by the HQ.
   */
  const anchorFor = (kind: BuildingKind) =>
    s.strategy.wall && hq && (kind === "turret" || kind === "sam-site")
      ? wallAnchor(w, faction, s.strategy, kind, myBuildings, hqC, enemyHome)
      : creepAt && CREEP_KINDS.has(kind)
      ? creepAt
      : kind === "turret" || kind === "sam-site"
      ? defencePoint
      : kind === "depot" && !hq
      ? guardPoint
      : kind === "radar" ? towardEnemy(w, hqC, 4) : kind === "gantry" ? towardEnemy(w, hqC, -5) : hqC;
  // (no HQ: every building goes up in a Goliath's ring, and a full ring is skipped, not started and refunded)
  let roomless = false;
  const fits = (kind: BuildingKind) => {
    const ok = !!findPlacementSpot(w, faction, kind, anchorFor(kind));
    if (!ok) roomless = true;
    return ok;
  };
  const creepField = hq ? creepTarget(w, faction, s.strategy, hqC, claimable) : null;
  const creepOut = { deferred: false };
  const next = nextBuilding(w, faction, myBuildings, s, gantryWanted, hq ? undefined : fits, false, !!creepField, creepOut);
  creepAt = creepOut.deferred ? creepField : null;
  // a Depot past the build zone is deployed by a crew: it goes up alongside the rest of the order, once
  // the crew is trained (ai/expansion.ts)
  const expansionNext = next === "depot" && !!hq && !s.strategy.wall && depotByCrew(w, faction, s, buildingCenter(hq));
  const wanted = expansionNext ? nextBuilding(w, faction, myBuildings, s, gantryWanted, hq ? undefined : fits, true, !!creepField) : next;
  if (roomless) noteNoRoom(w, s); // (the base Goliath may move on to build more: ai/goliath.ts)
  if (f.pending?.ready) {
    const kind = f.pending.kind;
    // an outpost goes up in its Goliath's ring (ai/goliath.ts)
    const outpost = outpostSpot(w, faction, s, kind, enemyHqPos);
    let spot = outpost === "wait" ? null : outpost;
    if (!spot && outpost !== "wait" && kind === "depot" && hq) {
      const site = safeDepotSite(w, faction, s, hqC);
      // (nowhere safe any more: it's refunded, below, and not put up by the guard for nothing)
      const hotSite = !site && !!depotSite(w, faction, hqC, s.strategy.depotReach, depotFar(s.strategy), depotTries(s.strategy));
      spot = site ? site.spot : hotSite ? null : findPlacementSpot(w, faction, kind, guardPoint);
    } else if (!spot && outpost !== "wait") spot = findPlacementSpot(w, faction, kind, anchorFor(kind));
    if (outpost === "wait") {
      // (an outpost Depot built ahead of its Goliath waits, ready, until it digs in)
    } else if (spot) cmds.push({ type: "placeBuilding", faction, tx: spot.tx, ty: spot.ty });
    else {
      cmds.push({ type: "cancelBuilding", faction }); // nowhere to put it
      if (kind === "gantry") noteGantryFailed(w, s);
      if (!hq) noteNoRoom(w, s);
    }
  } else if (!f.pending) {
    // an outpost for a dug-in Goliath first (cheap, and few), else the base's next building
    const outpost = outpostWanted(w, faction, s, f.scrap);
    if (outpost) cmds.push({ type: "startBuilding", faction, building: outpost });
    else if (wanted && f.scrap >= BUILDINGS[wanted].cost) {
      // (a Gantry only with room for it: else it would go up only to be refunded)
      if (wanted === "gantry" && hq && !fits("gantry")) noteGantryFailed(w, s);
      else cmds.push({ type: "startBuilding", faction, building: wanted });
    }
  }

  // --- economy: keep the harvester count mining ---------------------------
  const depots = myBuildings.filter((b) => b.kind === "depot").length;
  // (island maps: only fields on our side of the bridges; none left, no more harvesters —
  // and no search: a search for a field that isn't there floods the whole landmass)
  const fieldsLeft = !islandMap || ownFieldLeft(w, hqC, ourSide);
  // (the ground searched in vain this think isn't searched again: late in a match, with the near
  // fields mined out, a dozen idle harvesters took 30 ms of one tick)
  const misses: Uint8Array[] = [];
  const fieldFrom = (x: number, y: number) =>
    !islandMap
      ? nearestReachableResource(w, x, y, faction, undefined, misses)
      : fieldsLeft
      ? nearestReachableResource(w, x, y, faction, ourSide, misses)
      : null;
  // the fields our dug-in Goliaths work (ai/goliath.ts): harvesters sent out, and more built for them
  const goliathFields = goliathHarvest(w, faction, s, harvesters, () => {
    const at = fieldFrom(hqC.x, hqC.y);
    return at ? { x: at.x + 0.5, y: at.y + 0.5 } : null;
  });
  cmds.push(...goliathFields.cmds);
  // an expansion Depot: its crew of harvesters walks to the site, and it's started there (ai/expansion.ts)
  const mining = Math.max(1, s.strategy.harvesters + diff.extraHarvesters + depots + goliathFields.extra);
  // (an expansion is next: its crew is trained on top of the miners, and it's never started under attack)
  // (bold: a raid at home doesn't put it off, and half the miners stay on while the crew goes: the rest are trained after)
  const expanding = !!s.expansion || (expansionNext && (!threatened || !!diff.boldExpand));
  const boldKeep = diff.boldExpand ? Math.min(mining, Math.max(BOLD_KEEP, Math.ceil(mining / 2))) : mining;
  // (Land Grab: each crew is four harvesters gone, and a Depot with nobody to work it earns nothing)
  const crewKeep = s.strategy.landGrab ? Math.max(boldKeep, GRAB_MINERS * depots) : boldKeep;
  // (the fields running low: the next one is worth a fight, when it's one the army can win)
  const contestable = s.strategy.landGrab || (s.weighs && hq && fieldsRunningLow(w, faction))
    ? (x: number, y: number) => contestWinnable(seen, x, y, armyValue, s.weighs ? enemyArmy : 0)
    : undefined;
  const crew = tendExpansion(w, faction, s, expanding, hq ? hqC : null, harvesters, goliathFields.keep, crewKeep, s.strategy.depotReach ?? 9, cmds, seen, contestable, s.hotSpots);
  // a finished Depot by a field of its own is worked by a full shift, sent from the home field (ai/expansion.ts)
  const staffed = staffExpansions(w, faction, hqC, harvesters, new Set([...goliathFields.keep, ...crew]), seen, cmds);
  const wantHarvesters = mining + staffed.extra + (expanding && !s.expansion ? ECONOMY.expansion.crew : 0);
  // (Nomads: no HQ ever — the dug-in Goliath builds them, goliath.ts trainableAt)
  const yard = hq ? { id: hq.id, queue: hq.queue } : baseGoliath && trainableAt(w, "harvester") ? { id: baseGoliath.id, queue: baseGoliath.goliath!.queue } : null;
  // (Land Grab: the next one queued behind the last, the HQ never idle: crews use them up as fast as it trains them)
  const yardRoom = s.strategy.landGrab ? 2 : 1;
  if (yard && fieldsLeft && harvesters.length < wantHarvesters && yard.queue.length < yardRoom && f.scrap >= UNITS.harvester.cost)
    cmds.push({ type: "produce", faction, buildingId: yard.id, unit: "harvester" });
  // the rest mine the best field going: near a drop-off, on our side, none with an enemy army by it (ai/fields.ts)
  const busy = new Set([...goliathFields.keep, ...crew, ...staffed.sent]);
  const tended = fieldsLeft
    ? tendFields(w, faction, s, hqC, enemyHome, harvesters, busy, seen, mine, islandMap ? ourSide : null, cmds, staffed.staffed)
    : { sent: new Set<number>(), held: new Set<number>() };
  for (const h of harvesters) {
    if (busy.has(h.id) || tended.sent.has(h.id) || tended.held.has(h.id)) continue; // (working a Goliath's field, founding a Depot, or off to one; sent to a field)
    const o = h.order;
    // (a dry field sends a harvester to the nearest one it can reach: never across the bridges)
    const astray = islandMap && o.type === "harvest" && !ourSide(o.fieldX, o.fieldY);
    if (h.order.type !== "idle" && !astray) continue;
    const field = fieldFrom(h.x, h.y);
    if (field) cmds.push({ type: "harvest", faction, unitIds: [h.id], x: field.x + 0.5, y: field.y + 0.5 });
    else if (astray) {
      const [dx, dy] = sideFrame(w, faction).vec(0, 3); // (just behind the HQ, in the side's frame)
      cmds.push({ type: "move", faction, unitIds: [h.id], x: hqC.x + dx, y: hqC.y + dy });
    }
  }

  // --- production: adaptive counters to the enemy composition -------------
  // reserve scrap while an important building is still wanted
  // (an expansion's crew trained or on its way: its price)
  const crewReady = expansionNext && (!threatened || !!diff.boldExpand) && harvesters.length >= crewKeep + ECONOMY.expansion.crew;
  const reserve = ((s.expansion && s.expansion.depotId === undefined) || crewReady) && !f.pending
    ? ECONOMY.expansion.cost
    : f.pending || wanted === null ? 0 : (wanted === "turret" && !s.strategy.wall) || wanted === "radar" ? 0 : Math.min(400, BUILDINGS[wanted].cost);
  // the Goliath savings: a share of income set aside while the Gantry waits for one (ai/goliath.ts)
  const gantry = myBuildings.find((b) => b.kind === "gantry") ?? null;
  const fundCtx = { gantry: !!gantry || f.pending?.kind === "gantry", armyValue, threatened };
  const fund = goliathFund(w, faction, s, fundCtx);
  let spendable = f.scrap - reserve - fund;
  const liftHeld = liftCondors(w, faction, s);
  // the army it's committed to (ai/doctrine.ts): not where rules or the islands decide what it can field
  if (s.strategy.doctrine && s.sightings && has("tech-lab") && !airlifts && !infantryArmy(w, faction) && !s.strategy.airOnly && !bannedBy(w, "fab-plant", faction)) {
    const known = [...s.sightings.values()].filter((e) => !focus || e.faction === focus);
    s.doctrine = reviewDoctrine(s.doctrine, s.strategy.doctrine, w.tick, TICK_RATE, known);
  }
  /** Queue `kind` at a producer (a building, or an anchored Goliath for squads) if we can pay its price now. */
  const produce = (b: { id: number }, wants: UnitKind | null) => {
    const kind = wants && underDoctrine(s.doctrine, w.buildings.get(b.id)?.kind, wants);
    if (!kind || unitBlocker(w, faction, kind) || spendable < unitCost(w, faction, kind)) return;
    spendable -= unitCost(w, faction, kind);
    cmds.push({ type: "produce", faction, buildingId: b.id, unit: kind });
  };
  // --- the Gantry: a Goliath once the fund (and the bank) covers its escalating price
  if (gantry && gantry.queue.length === 0 && wantGoliath(w, faction, s, { ...fundCtx, spendable: f.scrap - reserve })) {
    cmds.push({ type: "produce", faction, buildingId: gantry.id, unit: "goliath" });
    spendable = f.scrap - reserve - unitCost(w, faction, "goliath");
    noteGoliathOrdered(w, s);
  }
  const tech = has("tech-lab");
  const enemyDefenses = knownBuildings(w, faction).filter(
    (kb) => kb.kind === "turret" || kb.kind === "sam-site"
  ).length;
  // anti-air on hand, in Flak Crawlers (intel.ts aaWeight: a Rocket Squad 1); rifle
  // squads (0.2 each) don't count — a few of them out with the army leave the harvesters bare
  const ownAA = COMBAT_KINDS.reduce((a, k) => a + (aaWeight(UNITS[k]) >= AA_COVER ? have(k) * aaWeight(UNITS[k]) : 0), 0);
  // a ground army that is mostly robot infantry: splash and rapid fire answer it, not big guns
  const infantryHeavy = s.seenInfantry >= 3 && s.seenInfantry >= 0.4 * s.seenGround;

  // floating scrap? keep queues two deep (spending down: deeper, and dearer units)
  const sp = { ...SPEND, ...s.strategy.spend };
  const rich = !!s.strategy.spendDown && f.scrap > sp.rich;
  const depth = s.strategy.spendDown ? 1 + Math.min(3, Math.floor(f.scrap / sp.perSlot)) : f.scrap > 700 ? 2 : 1;
  // --- Assembly Bay: robot infantry, mixed to what we've seen -------------
  // Rockets for armour (and Ironclad's Mastodon escorts), Snipers for enemy squads
  // (never on Easy), and the personality's share of Troopers. Under Infantry
  // War the Bays field the whole army: Rockets for the defences, more Snipers.
  // Island relays (ai/airlift.ts): squads are what holds them, so the Bays
  // come first, keep a bigger share, and make what the airlift is waiting for.
  const infantryWar = infantryArmy(w, faction);
  // (Airborne: the free Condor needs squads to fly, whatever the personality)
  const infantryShare = infantryWar
    ? 1
    : Math.max(
        s.strategy.infantry ?? 0,
        flysGivenCondor(w, faction, s) ? AIRBORNE_INFANTRY : 0,
        airlifts ? AIRLIFT.infantry : 0
      );
  const infantryValue = INFANTRY_KINDS.reduce((v, k) => v + have(k) * UNITS[k].cost, 0);
  // (the whole force, island garrisons included: the share is of everything we field)
  const forceValue = airlifts ? value(mine.filter((u) => COMBAT_KINDS.includes(u.kind))) : armyValue;
  /** Robot infantry for the Bays' queues: everything (`liftOnly` false), or only the squads the airlift is waiting for. */
  // (the Wall: an army that grows with the turrets — the scrap is the turrets'; but they go up one
  // at a time, slower than it mines, so what piles up past `rich` buys tier 1 from every factory)
  const wall = s.strategy.wall;
  const armyFull = !!wall && !rich && armyValue >= wall.army + wall.armyPerTurret * myBuildings.filter((b) => b.kind === "turret").length;
  const wallSpends = !!wall && rich;
  const overflow = !!s.strategy.bayOverflow && rich;
  const runBays = (liftOnly = false) => {
    if (armyFull && !liftOnly) return;
    let liftWants = airlifts ? airliftSquadsWanted(s) - INFANTRY_KINDS.reduce((n, k) => n + queued(k), 0) : 0;
    for (const bay of myBuildings.filter((b) => b.kind === "assembly-bay")) {
      if (bay.queue.length >= depth || (liftOnly && liftWants <= 0)) continue;
      const r = rand(s);
      const wantRockets = Math.max(
        Math.round(have("mastodon") * (s.strategy.escorts ?? 0)),
        Math.round(s.seenHeavy * 0.8),
        infantryWar ? Math.min(6, enemyDefenses) : 0
      );
      const wantSnipers =
        s.difficulty === "easy" || !tech ? 0 : Math.min(infantryWar ? 5 : 3, Math.floor(s.seenInfantry / 3));
      let kind: UnitKind;
      if (have("rocket-squad") < wantRockets) kind = "rocket-squad";
      else if (have("sniper") < wantSnipers) kind = "sniper";
      else if (liftWants > 0 || (!liftOnly && (wallSpends || overflow || infantryValue < infantryShare * Math.max(500, forceValue))))
        // (island garrisons face the enemy's drones alone: Rocket Squads once they fly)
        kind = ownAA < Math.ceil(s.seenAir * 0.6) || r < 0.2 || (airlifts && s.seenAir >= 2 && r < 0.5) ? "rocket-squad" : "trooper";
      else continue;
      liftWants--;
      produce(bay, kind);
    }
    // anchored Goliaths train the squads that stand by them (ai/goliath.ts)
    if (!liftOnly) for (const t of goliathBarracks(w, faction, s, () => rand(s), !!hq)) produce(t, t.kind);
  };
  // (island relays: tanks only reach the islands' war over the bridges, at the enemy's base —
  // a capped share of the force, the rest goes to squads, Condors and the air that holds islands)
  const vehicleCap = airlifts ? AIRLIFT.vehicles * Math.max(1000, forceValue) : Infinity;
  const vehicleValue = airlifts
    ? (["stinger", "flak-crawler", "mortar", "mastodon", "lancer"] as const).reduce((v, k) => v + have(k) * UNITS[k].cost, 0)
    : 0;
  const runFabs = () => {
    if (armyFull) return;
    for (const fab of myBuildings.filter((b) => b.kind === "fab-plant")) {
      if (fab.queue.length >= depth) continue;
      let kind: UnitKind = "stinger";
      const r = rand(s);
      if (vehicleValue >= vehicleCap && ownAA >= Math.ceil(s.seenAir * 0.6)) continue;
      if (s.strategy.airOnly) {
        // home guard only: a few stingers vs raiders, flak when the skies fill
        if (ownAA < Math.ceil(s.seenAir * 0.5)) kind = "flak-crawler";
        else if (have("stinger") >= 3) continue;
      } else if (ownAA < Math.ceil(s.seenAir * 0.6)) kind = "flak-crawler";
      else if (tech && have("mortar") < Math.min(3, 1 + enemyDefenses) && (enemyDefenses > 0 || r < 0.2))
        kind = "mortar";
      else if (tech && s.strategy.mortarShare && have("mortar") < (s.strategy.mortarCap ?? 4) && r < s.strategy.mortarShare) kind = "mortar";
      else if (infantryHeavy && r < 0.65)
        // (a couple of Mortars for the splash; Stingers do the rest — Mortars die fast in a brawl)
        kind = tech && have("mortar") < Math.min(3, 1 + Math.floor(s.seenInfantry / 4)) ? "mortar" : "stinger";
      else if (tech && s.seenHeavy >= 2 && r < 0.6) kind = "lancer"; // lasers burn through armour
      else if (tech && (s.strategy.heavy || rich ? r < 0.45 : r < 0.25)) kind = "mastodon"; // (rich: the most scrap an order buys)
      else if (tech && (rich || r < (s.strategy.heavy ? 0.8 : 0.5))) kind = "lancer";
      produce(fab, kind);
    }
  };
  // a strike wing still to build (ai/hornets.ts): the Airpads build Hornets first, and the rest waits for them
  let wingShort = unitBlocker(w, faction, "hornet") ? 0 : strikeWants(w, faction, s, queued("hornet"));
  const runPads = () => {
    if (armyFull && wingShort <= 0) return;
    for (const pad of myBuildings.filter((b) => b.kind === "airpad")) {
      if (wingShort > 0 && pad.queue.length < depth) {
        if (spendable < unitCost(w, faction, "hornet")) break;
        produce(pad, "hornet");
        wingShort--;
        continue;
      }
      if (pad.queue.length >= depth) continue;
      // Air War mutator (no Fab Plants): play the air-only plan, and bring bombers for the defences
      const airWar = bannedBy(w, "fab-plant", faction) !== null; // (or an op's "air only")
      const airOnly = s.strategy.airOnly || airWar;
      // (island relays: the air war over the islands decides who holds them)
      const wantRaptors = Math.min(airWar ? 5 : airOnly ? 7 : airlifts ? AIRLIFT.raptors : 4, Math.ceil(s.seenAir * 0.6));
      const armySize = army.length;
      // (Condors on, or held for, a Goliath's lift aren't the drop plan's or the airlift's)
      const condors = have("condor") - liftHeld.size;
      // Menders for our Goliaths (only Menders repair them): one with any, three for each hurt one
      const goliathMenders = Math.min(
        GOLIATH_AI.menders,
        Math.max(goliaths.length > 0 ? 1 : 0, goliaths.filter((g) => repairUrgency(g) > 0 || g.hp < UNITS.goliath.hp * 0.85).length * 3)
      );
      let kind: UnitKind;
      if (have("scout") < 1 && w.tick - s.lastScoutTick > 60 * TICK_RATE) {
        kind = "scout";
        s.lastScoutTick = w.tick;
      }
      else if (have("raptor") < wantRaptors && !unitBlocker(w, faction, "raptor")) kind = "raptor"; // (Infantry War: no fighters)
      else if (
        liftWantsCondors(w, faction, s) > queued("condor") ||
        skyliftWantsCondor(w, s, queued("condor")) ||
        (airlifts
          ? airliftWantsCondor(w, faction, s, condors)
          : wantCondor(w, faction, s, condors, count("trooper") + count("rocket-squad")))
      )
        kind = "condor";
      else if (
        have("mender") < Math.min(3, Math.floor(armySize / 6)) + goliathMenders ||
        (have("mender") < 1 && army.some(isWoundedVeteran))
      )
        kind = "mender";
      // (weighing: no Wasps or Hornets fed into massed flak, unless there are plenty of them; the scrap goes to the Fab Plants)
      else if (s.weighs && !airOnly && s.seenAA >= FLAK_WALL && FLAK_OUTNUMBER * s.seenAA > have("wasp") + have("hornet")) continue;
      else if (tech && (airOnly ? rand(s) < (airWar && enemyDefenses > 0 ? 0.55 : 0.4) : rand(s) < (rich ? 0.6 : 0.25) + s.seenHeavy * 0.08))
        kind = "hornet";
      else if (s.strategy.heavy && !airlifts && s.seenHeavy < 2 && fabCount(myBuildings) > 0 && rand(s) < 0.5) continue; // save for tanks (not with islands to clear)
      else kind = "wasp";
      produce(pad, kind);
    }
  };

  // (island relays: the squads the airlift is waiting for are bought first)
  if (airlifts) runBays(true);
  if (wingShort > 0) {
    runPads();
    // (the next Hornet's price set aside, if any Airpad is free to build it)
    if (wingShort > 0 && myBuildings.some((b) => b.kind === "airpad" && b.queue.length < depth)) spendable -= unitCost(w, faction, "hornet");
    runFabs();
  } else {
    runFabs();
    runPads();
  }
  runBays();
  // (a doctrine's factories are kept busy: what the commander asks for is sized for a mixed army, and
  // the scrap the idle ones would have spent just banks)
  if (s.doctrine && !armyFull)
    for (const b of myBuildings) {
      if (!DOCTRINES[s.doctrine.name].lines[b.kind] || b.queue.length >= depth) continue;
      const kind = doctrineUnit(s.doctrine, b.kind);
      if (kind && spendable >= unitCost(w, faction, kind) + DOCTRINE.busyAbove) produce(b, kind);
    }

  // --- scouting -----------------------------------------------------------
  for (const scout of mine.filter((u) => u.kind === "scout"))
    if (scout.order.type === "idle") {
      const leg = scoutSweep(w, hqC, s.scoutLeg++);
      cmds.push({ type: "move", faction, unitIds: [scout.id], x: leg.x, y: leg.y });
    }

  // --- expand production when scrap piles up despite full queues ---------
  // (Infantry War: the Bays are the factories; the Airpad only makes Condors, Scouts and Menders)
  const producers = myBuildings.filter((b) =>
    infantryWar ? b.kind === "assembly-bay" : b.kind === "fab-plant" || b.kind === "airpad"
  );
  if (
    f.scrap > (s.strategy.spendDown ? sp.expandAt : 1000) &&
    !f.pending &&
    (wanted === null || s.strategy.expandEarly) &&
    s.extraProduction < (s.strategy.spendDown ? sp.maxExtra : 3) &&
    producers.length > 0 &&
    producers.every((b) => b.queue.length > 0)
  )
    s.extraProduction++;

  // --- anti-air response: SAM sites when the skies fill up ---------------
  if (s.seenAir >= 4 && s.extraSams < 1) s.extraSams = 1;
  if (s.seenAir >= 8 && s.extraSams < 2) s.extraSams = 2;
  // --- …and turrets when robot infantry pours in --------------------------
  if (s.seenInfantry >= 5 && s.extraTurrets < 1) s.extraTurrets = 1;
  if (s.seenInfantry >= 9 && s.extraTurrets < 2) s.extraTurrets = 2;
  // …and, for a plan that digs in, when tanks pour in
  if (s.strategy.turretsVsGround) s.extraTurrets = Math.max(s.extraTurrets, Math.min(4, Math.floor(s.seenGround / s.strategy.turretsVsGround)));

  // --- mode transitions ----------------------------------------------------
  // the longer the match drags on (from 7:00, 6% a minute, down to half), the lower the bar for an all-in push
  const minutes = w.tick / TICK_RATE / 60;
  const lateGame = Math.max(0.5, 1 - Math.max(0, minutes - 7) * 0.06);
  // (island relays: a wave walks the long way round by the bridges, and an early one bleeds the
  // squads and air the islands need — no all-in below AIRLIFT.assaultFloor there)
  const assaultValue = airlifts ? Math.max(s.strategy.assaultValue, AIRLIFT.assaultFloor) : s.strategy.assaultValue;
  const assaultAt = assaultValue * diff.assaultMult * lateGame;
  const raiders = mine.filter(
    (u) => (u.kind === "wasp" || (s.strategy.groundRaids && u.kind === "stinger")) && u.order.type === "idle"
  );
  if (
    s.mode === "buildup" && diff.harass && raiders.length >= s.strategy.harassGroup &&
    s.seenAA <= raiders.length / 2 && w.tick >= Math.max(s.strategy.raidFrom !== undefined ? s.strategy.raidFrom * TICK_RATE : OPENING_GRACE, (s.strategy.holdUntil ?? 0) * TICK_RATE)
  )
    s.mode = "harass";
  const techAt = (s.strategy.techAssault ?? Infinity) * diff.assaultMult * lateGame;
  const techReady = techAt < Infinity && value(army.filter((u) => UNITS[u.kind].requires === "tech-lab")) >= techAt;
  if ((armyValue >= assaultAt || techReady) && s.mode !== "assault" && w.tick >= (s.strategy.holdUntil ?? 0) * TICK_RATE) {
    s.mode = "assault";
    s.waveValue = armyValue;
  }
  if (s.mode === "assault" && armyValue < Math.max(RETREAT_ARMY_VALUE, s.waveValue * 0.25)) s.mode = "buildup";
  // Last Stand: there is no enemy base to raid or assault — defend
  if (w.survival) s.mode = "buildup";

  // ======================= tactics =========================================
  const used = new Set<number>(dodgingUnits(w, s)); // units running from a reticle stay put
  // squads walking up a Condor's ramp, or dropped on a raid, follow the drop plan (ai/condor.ts)
  for (const id of condorHolds(w, s)) used.add(id);
  for (const id of airliftHolds(w, s)) used.add(id);
  // (a trick under way, ai/feint.ts: they still count as the army, for what it's worth)
  for (const id of feintHolds(s)) used.add(id);
  // (a column on its way, ai/siege.ts: the same)
  for (const id of siegeHolds(s)) used.add(id);
  const idleArmy = () => army.filter((u) => u.order.type === "idle" && !used.has(u.id));

  // --- 0. wounded veterans fall back to a Mender or the HQ ----------------
  cmds.push(...veteranRetreats(faction, army, hqC, used, w));
  // --- 0b. Menders follow whoever needs them, and come home when nobody does
  // (ai/menders.ts; no wave, guard post or sweep takes them after this; our Goliaths first)
  cmds.push(...planMenders(faction, army, myBuildings, used, hqC, enemyHqPos, goliaths, w));

  // --- 1. threat response: answer unengaged intruders with counters -------
  for (const t of threats.slice(0, 3)) {
    const wantedValue = t.value * 1.5;
    // (and can hurt it: no Sniper Team sent at a tank)
    // (and can get at it: no tank sent at a squad on an island)
    const capable = idleArmy()
      .filter(
        (u) =>
          canHitDomain(UNITS[u.kind].targets, t.domain) && effectivenessVs(u.kind, UNITS[t.kind].armor, t.domain) >= USELESS &&
          canGetWithin(w, moveClassOf(u.kind), u.x, u.y, t.x, t.y, UNITS[u.kind].range)
      )
      .sort((a, b) => dist(a.x, a.y, t.x, t.y) - dist(b.x, b.y, t.x, t.y));
    const squad: number[] = [];
    let v = 0;
    for (const u of capable) {
      if (v >= wantedValue) break;
      squad.push(u.id);
      used.add(u.id);
      v += UNITS[u.kind].cost;
    }
    if (squad.length > 0) cmds.push({ type: "attack", faction, unitIds: squad, targetId: t.id });
  }

  // --- 1b. home defence: a real attack on the base recalls the army -------
  // (with quick-start openers an 8-unit push can land at 1:00; an army out
  // raiding must not leave the HQ to die)
  const homeGuard = value(army.filter((u) => dist(u.x, u.y, hqC.x, hqC.y) <= DEFENSE_RADIUS));
  if (raidValue >= HOME_ALARM_VALUE && raidValue > homeGuard) {
    s.mode = "buildup";
    const away = army.filter(
      (u) =>
        !used.has(u.id) &&
        dist(u.x, u.y, hqC.x, hqC.y) > DEFENSE_RADIUS &&
        dist(u.x, u.y, enemyHome.x, enemyHome.y) > 8 && // about to finish the job there
        atHome.some((t) => canHitDomain(UNITS[u.kind].targets, t.domain))
    );
    if (away.length > 0) {
      away.forEach((u) => used.add(u.id));
      cmds.push({ type: "attackMove", faction, unitIds: away.map((u) => u.id), x: hqC.x, y: hqC.y });
    }
  }
  // --- 1b'. an expansion under attack: the army goes to it, if it can win there ---------
  // (the Depot pays for itself many times over; its miners die first, and with them the income)
  if (diff.defendExpansions && !threatened) {
    let raided: { x: number; y: number; value: number; domains: Set<Domain> } | null = null;
    for (const d of myBuildings) {
      if (d.kind !== "depot") continue;
      const c = buildingCenter(d);
      if (dist(c.x, c.y, hqC.x, hqC.y) <= DEFENSE_RADIUS) continue; // (home: 1b's)
      const raid = threats.filter((t) => dist(t.x, t.y, c.x, c.y) <= DEFENSE_RADIUS);
      const v = raid.reduce((a, t) => a + t.value, 0);
      if (v < HOME_ALARM_VALUE || (raided && v <= raided.value)) continue;
      const n = raid.length;
      raided = {
        x: raid.reduce((a, t) => a + t.x, 0) / n,
        y: raid.reduce((a, t) => a + t.y, 0) / n,
        value: v,
        domains: new Set(raid.map((t) => t.domain))
      };
    }
    if (raided) {
      const r = raided;
      const there = army.filter((u) => dist(u.x, u.y, r.x, r.y) <= DEFENSE_RADIUS);
      const go = army.filter(
        (u) =>
          !used.has(u.id) && u.kind !== "mender" &&
          dist(u.x, u.y, r.x, r.y) > DEFENSE_RADIUS &&
          dist(u.x, u.y, enemyHome.x, enemyHome.y) > 8 && // about to finish the job there
          // (nearer their base than the raid: a wave on its way over keeps going. Replay 2026-11-02, ashlands:
          // eight Stingers called back from beside the enemy's harvesters walked 45 tiles home, too late, and died)
          dist(u.x, u.y, enemyHome.x, enemyHome.y) >= dist(u.x, u.y, r.x, r.y) &&
          [...r.domains].some((dom) => canHitDomain(UNITS[u.kind].targets, dom))
      );
      if (go.length && value(go) + value(there) >= EXPANSION_DEFEND_ODDS * r.value) {
        go.forEach((u) => used.add(u.id));
        cmds.push({ type: "attackMove", faction, unitIds: go.map((u) => u.id), x: r.x, y: r.y });
      }
    }
  }
  // --- 1c. Goliaths: ours dig in, hold, move on, lift, walk with a wave; theirs are hunted (ai/goliath.ts)
  // (escorts and strikes already under way stay on task)
  for (const id of goliathHolds(w, s)) used.add(id);
  const staging = towardEnemy(w, hqC, 9, enemyHqPos);
  cmds.push(
    ...planGoliaths(w, faction, s, {
      army, used, hqC, enemyHqPos, seen, mode: s.mode, threatened, staging, guardPoint, hasHq: !!hq,
      defend: threatened && atHome[0] ? { x: atHome[0].x, y: atHome[0].y } : null
    })
  );
  cmds.push(...huntGoliaths(w, faction, s, { army, used, seen, enemyHqPos, mode: s.mode, threatened }));
  // --- 1c'. the Hornet strike: gather, hide, bomb their HQ when their army is out (ai/hornets.ts)
  const intruder = threatened ? atHome[0] : undefined;
  cmds.push(...planStrike(w, faction, s, { hqC, enemyHqPos, seen, defend: intruder ? { x: intruder.x, y: intruder.y } : null }));
  // --- 1c'. The Feint: a loud few at one target, the army out of sight for the other (ai/feint.ts)
  if (s.strategy.feint)
    cmds.push(
      ...planFeint(w, faction, s, {
        hqC, army, used, seen, threatened, focus, enemyHqPos,
        readyAt: s.strategy.feint.army * diff.assaultMult * lateGame,
        enemyArmy, outweigh: s.weighs ? WAVE_EDGE * enemyArmy : 0,
        barred: airlifts || !!w.survival,
        field: (leg) => enemyHarvestArea(w, faction, hqC, focus ? seen.filter((u) => u.faction === focus) : seen, focus, leg)
      })
    );
  // --- 1c'. Siege Train: Mortars and an escort in hops, shelling from out of reach (ai/siege.ts)
  if (s.strategy.siege)
    cmds.push(
      ...planSiege(w, faction, s, {
        hqC, army, used, seen, threatened, focus, enemyHqPos,
        readyAt: s.strategy.siege.army * diff.assaultMult,
        enemyArmy,
        barred: airlifts || !!w.survival
      })
    );
  // --- 1c''. harassment sorties: a few units at their mining, and home before they're lost (ai/harass.ts)
  cmds.push(
    ...planSorties(w, faction, s, {
      hqC, army, used, seen, armyValue, threatened,
      target: (leg) => enemyHarvestArea(w, faction, hqC, focus ? seen.filter((u) => u.faction === focus) : seen, focus, leg)
    })
  );

  // Uplink garrisons, capture squads and crate runners stay on task (ai/objectives.ts)
  for (const id of objectiveHolds(w, faction, s)) used.add(id);

  // --- 1d. Condor drops on the enemy's harvesters (ai/condor.ts) ----------
  // (two cheap squads picked before the guard takes its share: the drop is a deliberate commitment)
  // (island relays: every Condor flies the airlift instead, ai/airlift.ts)
  // (never a Condor on, or held for, a Goliath's lift: ai/goliath.ts)
  const skip = new Set(liftCondors(w, faction, s));
  // (nor one flying a crew up to a mesa: ai/skylift.ts)
  const skylift = planSkylift(w, faction, s, { hq, harvesters: allHarvesters, seen, threatened, skip });
  cmds.push(...skylift.cmds);
  for (const id of skylift.condors) skip.add(id);
  if (airlifts) cmds.push(...planAirlift(w, faction, s, { mine, army, used, hqC, seen, threatened, skip }));
  else cmds.push(...planCondor(w, faction, s, { army, used, hqC, threatened, skip }));

  // --- 2. economy guard: a share of the army holds the mining line --------
  const guardShare = s.mode === "assault" ? 0.15 : entrance ? 1 : contest ? CONTEST_SHARE : 0.35;
  const guardValue = value(army.filter((u) => dist(u.x, u.y, guardPoint.x, guardPoint.y) <= GUARD_RADIUS));
  if (guardValue < guardShare * armyValue) {
    let need = guardShare * armyValue - guardValue;
    const recruits = idleArmy()
      .filter((u) => u.kind !== "mortar" && dist(u.x, u.y, guardPoint.x, guardPoint.y) > GUARD_RADIUS)
      .sort(
        (a, b) =>
          dist(a.x, a.y, guardPoint.x, guardPoint.y) - dist(b.x, b.y, guardPoint.x, guardPoint.y)
      );
    const squad: number[] = [];
    for (const u of recruits) {
      if (need <= 0) break;
      squad.push(u.id);
      used.add(u.id);
      need -= UNITS[u.kind].cost;
    }
    if (squad.length > 0)
      cmds.push({ type: "attackMove", faction, unitIds: squad, x: guardPoint.x, y: guardPoint.y });
  }

  // --- 2b. map objectives: take Uplinks, hold them, race for supply crates --
  cmds.push(
    ...planObjectives(w, faction, s, {
      mode: s.mode, hqC, guardPoint, guardNeed: guardShare * armyValue, army, used,
      threatened: raidValue >= HOME_ALARM_VALUE, enemyHqPos
    })
  );

  // --- 3/4. offence by mode -----------------------------------------------

  if (s.mode === "harass") {
    const group = raiders.filter((u) => !used.has(u.id));
    const raid = enemyHarvestArea(w, faction, hqC, focus ? seen.filter((u) => u.faction === focus) : seen, focus, s.raids ?? 0);
    const flying = group.filter((u) => UNITS[u.kind].domain === "air").length;
    // raiders don't fly into flak (seen now, or remembered): they wait for
    // the main assault instead
    if (flying > group.length / 2 && (aaStrengthAt(aaSources(w, faction, seen), raid.x, raid.y) >= AA_COVER || s.seenAA > group.length / 2))
      s.mode = "buildup";
    else if (group.length >= s.strategy.harassGroup) {
      const ids = group.map((u) => u.id);
      ids.forEach((id) => used.add(id));
      s.raids = (s.raids ?? 0) + 1;
      if (raid.targetId !== undefined)
        cmds.push({ type: "attack", faction, unitIds: ids, targetId: raid.targetId });
      else cmds.push({ type: "attackMove", faction, unitIds: ids, x: raid.x, y: raid.y });
    }
  } else if (s.mode === "assault") {
    // staged waves: gather at a forward point, launch together
    // (a big army takes a big ring: 140 units never fit in STAGE_RADIUS round the base's buildings,
    // so a third of it read as gathered and it could never outweigh the army it was weighed against)
    const stageRadius = Math.max(STAGE_RADIUS, Math.sqrt(army.length) * 1.1);
    const staged = army.filter(
      (u) => !used.has(u.id) && dist(u.x, u.y, staging.x, staging.y) <= stageRadius
    );
    // (a Goliath waiting there to walk with the wave counts for what it can fire, ai/goliath.ts, but
    // never for more than the army staged beside it: alone it would launch empty waves every pass,
    // and the rest of the army would never be called up to the staging point)
    const goliathStaged = goliaths.reduce(
      (v, g) => (canWalk(g) && dist(g.x, g.y, staging.x, staging.y) <= stageRadius ? v + threatValue(g) : v),
      0
    );
    const stagedValue = value(staged) + Math.min(goliathStaged, value(staged));
    // Air War: fragile aircraft trickling in just feed the defences, so launch one big wave
    const airWar = bannedBy(w, "fab-plant", faction) !== null && !infantryWar;
    const launchAt = airWar ? assaultAt : Math.max(450, assaultAt * WAVE_LAUNCH);
    // (weighing: a wave that outweighs the army we remember, with the rest of ours gathered for it —
    // or after WAVE_GATHER, what has gathered; half an army sent at a bigger one only feeds it)
    let go = stagedValue >= launchAt;
    if (go && s.weighs) {
      const coming = value(army.filter((u) => !used.has(u.id) && u.kind !== "mender"));
      if (stagedValue < WAVE_EDGE * enemyArmy) {
        s.waveStall ??= w.tick;
        go = w.tick - s.waveStall >= WAVE_STALL && stagedValue >= WAVE_STALL_EDGE * enemyArmy;
        s.waveReady = null;
      } else if (stagedValue < 0.8 * coming) {
        s.waveReady ??= w.tick;
        go = w.tick - s.waveReady >= WAVE_GATHER;
      }
    }
    if (go) s.waveReady = s.waveStall = null;

    if (go) {
      const target = pickPriorityTarget(w, faction, seen, enemyHqPos, focus);
      // robot infantry still marching up (1.6–1.8 tiles/s) goes with the wave, not left for the next one
      const marching = army.filter(
        (u) =>
          isInfantry(u.kind) && !used.has(u.id) && u.order.type === "attackMove" &&
          dist(u.order.x, u.order.y, staging.x, staging.y) < 1 && dist(u.x, u.y, staging.x, staging.y) <= 2 * stageRadius &&
          !staged.includes(u)
      );
      const wave = [...staged, ...marching];
      launchWave(w, cmds, faction, wave, target, used);
      s.wave = { ids: wave.map((u) => u.id), x: target.x, y: target.y, tick: w.tick };
    } else {
      for (const u of idleArmy()) {
        if (dist(u.x, u.y, enemyHqPos.x, enemyHqPos.y) < 14) {
          // already deep in enemy territory: keep fighting, don't yo-yo home
          const target = pickPriorityTarget(w, faction, seen, enemyHqPos, focus);
          launchWave(w, cmds, faction, [u], target, used);
        } else if (dist(u.x, u.y, staging.x, staging.y) > stageRadius) {
          used.add(u.id);
          cmds.push({ type: "attackMove", faction, unitIds: [u.id], x: staging.x, y: staging.y });
        }
      }
    }
  }

  // --- Last Stand: hold a line toward the incoming wave, engage the siege ---
  if (w.survival) {
    const hold = survivalHoldPoint(w, faction);
    if (hold) {
      const squad = idleArmy()
        .filter((u) => (hold.engage ? u.kind !== "mortar" || dist(u.x, u.y, hold.x, hold.y) > 7 : true))
        .filter((u) => dist(u.x, u.y, hold.x, hold.y) > (hold.engage ? 2 : STAGE_RADIUS))
        .map((u) => u.id);
      squad.forEach((id) => used.add(id));
      if (squad.length > 0) cmds.push({ type: "attackMove", faction, unitIds: squad, x: hold.x, y: hold.y });
    }
    // strong enough for what's next and nothing on the field: bring it on
    if (earlyCallBonus(w) > 0 && armyValue >= 1.8 * waveBudget(w.survival.difficulty, w.survival.wave + 1))
      cmds.push({ type: "callWave", faction });
  }

  // --- 4b. salvage: once a fight near home is over, sweep up the wrecks ----
  cmds.push(
    ...planSalvage(w, faction, {
      army, harvesters, buildings: myBuildings, used, threatened: raidValue >= HOME_ALARM_VALUE, assault: s.mode === "assault"
    })
  );

  // --- 4c. commander calldowns (ai/powers.ts) ------------------------------
  cmds.push(...planCalldowns(w, faction, s, { mode: s.mode, hqC, guardPoint, enemyHqPos, army, threats }));

  return cmds;
}

const fabCount = (bs: Building[]) => bs.filter((b) => b.kind === "fab-plant").length;

/** Is any field left on our side (`ourSide`) of an island map, on the land our HQ stands (or stood) on? */
function ownFieldLeft(w: World, hqC: { x: number; y: number }, ourSide: (tx: number, ty: number) => boolean): boolean {
  const home = regionAt(w, Math.floor(hqC.x), Math.floor(hqC.y), "ground");
  const labels = regionLabels(w, "ground");
  for (let i = 0; i < labels.length; i++)
    if (isResource(w, i) && labels[i] === home && ourSide(i % w.width, Math.floor(i / w.width))) return true;
  return false;
}

/** A point `d` tiles from `from` toward the enemy HQ (or the map mirror). */
/** How far `p` lies in front of `from`, on the line to `to` (behind it: less than 0). */
function inFrontBy(from: { x: number; y: number }, p: { x: number; y: number }, to: { x: number; y: number }): number {
  const len = Math.max(1, dist(from.x, from.y, to.x, to.y));
  return ((p.x - from.x) * (to.x - from.x) + (p.y - from.y) * (to.y - from.y)) / len;
}

function towardEnemy(w: World, from: { x: number; y: number }, d: number, to?: { x: number; y: number }) {
  const target = to ?? mirror(w, from.x, from.y);
  const len = Math.max(1, dist(from.x, from.y, target.x, target.y));
  return { x: from.x + ((target.x - from.x) / len) * d, y: from.y + ((target.y - from.y) / len) * d };
}

interface PriorityTarget {
  id?: number;
  x: number;
  y: number;
  domain: Domain;
  armor: ArmorClass;
}

/**
 * Harvesters first, then production buildings, then defences, then the HQ.
 * A Gantry with a Goliath on its cradle (public: GOLIATH.md) comes before
 * all of them (killed mid-build, the progress is lost); once the enemy HQ is
 * seen gone, its Goliaths are what's left to beat, so they come first; and
 * with nothing else known, the nearest Goliath beats an empty plot.
 * A free-for-all's `focus`: that rival's first; anyone's when none of its is known.
 */
function pickPriorityTarget(w: World, faction: Faction, seen: Unit[], fallback: { x: number; y: number }, focus: Faction | null = null): PriorityTarget {
  if (focus) {
    const theirs = pickPriorityTarget(w, faction, seen.filter((u) => u.faction === focus), fallback, null);
    const ownerOf = (id?: number) => (id === undefined ? null : (w.units.get(id) ?? w.buildings.get(id))?.faction ?? knownBuildings(w, faction).find((kb) => kb.id === id)?.faction ?? null);
    if (theirs.id !== undefined && ownerOf(theirs.id) === focus) return theirs;
    const any = pickPriorityTarget(w, faction, seen, fallback, null);
    return any.id !== undefined ? any : theirs;
  }
  const building = enemyGantryBuilds(w, faction).sort(
    (a, b) => dist(a.x, a.y, fallback.x, fallback.y) - dist(b.x, b.y, fallback.x, fallback.y) || a.id - b.id
  )[0];
  if (building) return { id: building.id, x: building.x, y: building.y, domain: "ground", armor: "structure" };
  // an expansion Depot going up (frail: catch it before it's done)
  const [rising] = enemyExpansions(w, faction, fallback, null, true);
  if (rising) return { id: rising.id, x: rising.x, y: rising.y, domain: "ground", armor: "structure" };
  const enemyGoliaths = seen
    .filter((u) => !!u.goliath)
    .sort((a, b) => dist(a.x, a.y, fallback.x, fallback.y) - dist(b.x, b.y, fallback.x, fallback.y) || a.id - b.id);
  const goliath = enemyGoliaths[0];
  const goliathTarget = (g: Unit): PriorityTarget => ({ id: g.id, x: g.x, y: g.y, domain: domainOf(g), armor: UNITS.goliath.armor });
  if (goliath && enemyHqGone(w, faction, fallback)) return goliathTarget(goliath);
  let best: PriorityTarget | null = null;
  let bestD = Infinity;
  for (const u of seen) {
    if (u.kind !== "harvester") continue;
    const d = dist(u.x, u.y, fallback.x, fallback.y);
    if (d < bestD) {
      bestD = d;
      best = { id: u.id, x: u.x, y: u.y, domain: "ground", armor: UNITS.harvester.armor };
    }
  }
  if (best) return best;
  const known = knownBuildings(w, faction);
  for (const kinds of [["gantry", "fab-plant", "airpad", "assembly-bay", "tech-lab", "depot"], ["turret", "sam-site", "radar"], ["hq"]] as const) {
    const cands = known.filter((kb) => (kinds as readonly string[]).includes(kb.kind));
    // by footprint centre (a top-left corner is not mirror-symmetric)
    const centre = (kb: (typeof cands)[number]) => BUILDINGS[kb.kind].size / 2;
    cands.sort(
      (a, b) =>
        dist(a.tx + centre(a), a.ty + centre(a), fallback.x, fallback.y) -
        dist(b.tx + centre(b), b.ty + centre(b), fallback.x, fallback.y)
    );
    const b = cands[0];
    if (b) {
      const size = BUILDINGS[b.kind].size;
      return { id: b.id, x: b.tx + size / 2, y: b.ty + size / 2, domain: "ground", armor: "structure" };
    }
  }
  if (goliath) return goliathTarget(goliath);
  return { x: fallback.x, y: fallback.y, domain: "ground", armor: "structure" };
}

/** Closer than this (tiles) to a wave's target, a unit that can hurt it is ordered onto it; farther, it attack-moves there. */
const WAVE_STRIKE = 10;

/** Send a wave at a target: attackers attack it, the rest (and anything that can't hurt it, a Sniper Team at a building) escort. */
function launchWave(
  w: World,
  cmds: Command[],
  faction: Faction,
  units: Unit[],
  target: PriorityTarget,
  used: Set<number>
): void {
  // a remembered building may have died out of sight: an attack on its id
  // idles the wave on the spot, so march on its last known position instead
  // (the same place either way; arriving re-sees the footprint, forgets the ghost)
  const id = target.id !== undefined && (w.units.has(target.id) || w.buildings.has(target.id)) ? target.id : undefined;
  const attackers: number[] = [];
  const escorts: number[] = [];
  for (const u of units) {
    used.add(u.id);
    // (an attack order holds fire on everything else: from afar, the wave attack-moves there, and fights its way through)
    if (id !== undefined && dist(u.x, u.y, target.x, target.y) <= WAVE_STRIKE && effectivenessVs(u.kind, target.armor, target.domain) >= USELESS)
      attackers.push(u.id);
    else escorts.push(u.id);
  }
  if (attackers.length > 0 && id !== undefined)
    cmds.push({ type: "attack", faction, unitIds: attackers, targetId: id });
  if (escorts.length > 0)
    cmds.push({ type: "attackMove", faction, unitIds: escorts, x: target.x, y: target.y });
}

interface Threat {
  id: number;
  x: number;
  y: number;
  kind: UnitKind;
  /** Where it is now (a Goliath on a lift is in the air). */
  domain: Domain;
  /** What it's worth as a threat (ai/goliath.ts threatValue: a Goliath by what it can still fire). */
  value: number;
}

/** Visible armed enemy units (and the Menders keeping them going) close to our buildings or harvesters. */
function findThreats(
  w: World,
  faction: Faction,
  seen: Unit[],
  myBuildings: Building[],
  harvesters: Unit[]
): Threat[] {
  const out: Threat[] = [];
  for (const u of seen) {
    if (UNITS[u.kind].dps <= 0 && !UNITS[u.kind].heal) continue;
    const nearBuilding = myBuildings.some((b) => {
      const c = buildingCenter(b);
      return dist(u.x, u.y, c.x, c.y) <= DEFENSE_RADIUS;
    });
    const nearHarvester = harvesters.some((h) => dist(u.x, u.y, h.x, h.y) <= 6);
    const nearUplink = w.objectives.uplinks.some(
      (l) => l.owner === faction && dist(u.x, u.y, l.x, l.y) <= OBJECTIVES.uplink.radius + 2
    );
    if (nearBuilding || nearHarvester || nearUplink)
      out.push({ id: u.id, x: u.x, y: u.y, kind: u.kind, domain: domainOf(u), value: threatValue(u) });
  }
  return out;
}

/**
 * Tally the enemy units we can see (`seen`: fog and Sniper concealment
 * applied) by domain, heavy armour, anti-air (in Flak, aaWeight) and robot
 * infantry. An enemy Goliath counts as GOLIATH_AI.heavyWeight heavy units
 * (the Rocket Squads, Lancers and Hornets that answer it come with that),
 * with the anti-air of the weapons it can fire now; one taking shape on a
 * Gantry (`gantryBuilds`, public) pre-arms the counters.
 */
function observeEnemy(s: AiState, seen: Unit[], gantryBuilds = 0): void {
  let air = 0;
  let ground = 0;
  let heavy = gantryBuilds * GOLIATH_AI.gantryWeight;
  let aa = 0;
  let infantry = 0;
  for (const u of seen) {
    if (u.kind === "harvester") continue;
    if (domainOf(u) === "air")
      air += u.kind === "hornet" ? 2 : u.kind === "scout" ? 0.3 : u.kind === "condor" ? 0.5 : 1;
    else ground++;
    if (u.goliath) heavy += GOLIATH_AI.heavyWeight;
    else if (UNITS[u.kind].armor === "heavy") heavy++;
    aa += unitAntiAir(u).weight;
    if (isInfantry(u.kind)) infantry++;
  }
  // ratchet up quickly, decay slowly (~1 min half-life at 2s decisions) —
  // a glimpse of a wasp pack should keep informing production for a while
  s.seenAir = Math.max(air, s.seenAir * 0.97);
  s.seenGround = Math.max(ground, s.seenGround * 0.97);
  s.seenHeavy = Math.max(heavy, s.seenHeavy * 0.97);
  s.seenAA = Math.max(aa, s.seenAA * 0.97);
  s.seenInfantry = Math.max(infantry, s.seenInfantry * 0.97);
}

/**
 * The enemy army a weighing commander remembers (AiState.sightings): every
 * armed unit (or Mender) seen in the last SIGHTING_TTL, at its price, but
 * not one that died where we last saw it (its spot in sight, and it gone
 * from there for good). One that only moved off out of sight is still
 * counted: forgotten, a besieging army that stepped back a few tiles read
 * as gone, and the base sent its army out into it. In a free-for-all, the
 * focus rival's only. Goliaths count for what they can still fire.
 */
function rememberEnemyArmy(w: World, faction: Faction, s: AiState, seen: Unit[], focus: Faction | null): number {
  const memo = (s.sightings ??= new Map());
  const now = new Set<number>();
  for (const u of seen) {
    if (u.kind === "harvester" || (UNITS[u.kind].dps <= 0 && !UNITS[u.kind].heal)) continue;
    now.add(u.id);
    memo.set(u.id, { kind: u.kind, value: u.goliath ? threatValue(u) : UNITS[u.kind].cost, tick: w.tick, x: u.x, y: u.y, faction: u.faction });
  }
  let v = 0;
  for (const [id, e] of memo) {
    // (an army that steps back out of sight is still out there: only one seen gone and dead is forgotten early)
    if (w.tick - e.tick > SIGHTING_TTL || (!now.has(id) && !w.units.has(id) && isVisible(w, faction, Math.floor(e.x), Math.floor(e.y)))) memo.delete(id);
    else if (!focus || e.faction === focus) v += e.value;
  }
  return v;
}

/**
 * First entry of the build order (plus reactive SAMs) not yet satisfied.
 * `gantry` (ai/goliath.ts wantGantry): a Gantry after the build order, with
 * whatever it still needs of its four prerequisites first. Outposts (built
 * in a Goliath's ring, far from base) don't count toward the base's order.
 */
function nextBuilding(
  w: World,
  faction: Faction,
  myBuildings: Building[],
  s: AiState,
  gantry = false,
  fits?: (kind: BuildingKind) => boolean,
  /** Pass over an expansion Depot (it goes up alongside the order: ai/expansion.ts). */
  skipExpansion = false,
  /** The base can build out to the field (creepTarget): a Depot a crew would found waits, and the rest of the order goes up toward it. */
  creep = false,
  /** Set when that happened: a crew's Depot passed over for the creep. */
  out?: { deferred: boolean }
): BuildingKind | null {
  const have = new Map<BuildingKind, number>();
  // (with no HQ every building is an outpost: then they're the base)
  const hasHq = !!hqOf(w, faction);
  for (const b of myBuildings) if (!b.outpost || !hasHq) have.set(b.kind, (have.get(b.kind) ?? 0) + 1);
  // Infantry War: an Assembly Bay wherever the plan says Fab Plant
  const infantryWar = infantryArmy(w, faction);
  const order = s.strategy.buildOrder.map((k): BuildingKind => (infantryWar && k === "fab-plant" ? "assembly-bay" : k));
  const wall = s.strategy.wall;
  if (wall) order.push(...wallOrder(wall, order));
  // Last Stand: static defences earn their keep against endless waves
  if (w.survival) order.push("turret", "sam-site", "turret", "turret", "sam-site", "turret");
  // (not for the Wall: its order is turrets and SAM Sites already, and these ahead of it slowed the
  // turrets it techs at)
  for (let i = 0; i < (wall ? 0 : s.extraSams); i++) order.splice(Math.min(order.length, 2 + i), 0, "sam-site");
  for (let i = 0; i < (wall ? 0 : s.extraTurrets); i++) order.splice(Math.min(order.length, 2 + i), 0, "turret");
  // Mastodons (or Hornets) seen, or a Condor to fill (Airborne): an Assembly Bay, early in the queue
  if (((s.strategy.bayVsArmour && s.seenHeavy >= 2) || flysGivenCondor(w, faction, s)) && !order.includes("assembly-bay"))
    order.splice(Math.min(order.length, 3), 0, "assembly-bay");
  // island relays (ai/airlift.ts): squads hold them, so the Assembly Bay comes
  // second; and an Airpad by third, for more Condors and the air that clears
  // islands — and a second one by sixth (the islands' war is fought in the air)
  if (airliftActive(w, faction, s)) {
    (["assembly-bay", "airpad"] as const).forEach((k, slot) => {
      const i = order.indexOf(k);
      if (i >= 0 && i <= slot + 1) return;
      if (i > 0) order.splice(i, 1);
      order.splice(Math.min(order.length, slot + 1), 0, k);
    });
    if (order.filter((k) => k === "airpad").length < 2) order.splice(Math.min(order.length, 5), 0, "airpad");
  }
  // the Gantry once the order is through (the prerequisites it lacks go in just ahead of it, below)
  if (gantry && (!wall || have.has("tech-lab"))) order.push("gantry"); // (the Wall: no Tech Lab, no Gantry)
  // a building that needs one of each (BuildingStats.requiresAll: the Tech Lab, the Gantry) comes after
  // them all: one the order has later moves up to just before it, one it lacks goes in there (not
  // for one that's up already)
  for (let i = 0; i < order.length; i++)
    for (const k of BUILDINGS[order[i]!].requiresAll ?? []) {
      if (have.has(order[i]!) || order.slice(0, i).includes(k) || bannedBy(w, k, faction)) continue;
      const later = order.indexOf(k, i + 1);
      if (later > i) order.splice(later, 1);
      order.splice(i++, 0, k);
    }
  // (a third factory, ahead of the lab, while the lab's still to come: Strategy.factoryBeforeLab)
  if (s.strategy.factoryBeforeLab && !have.has("tech-lab")) {
    const lab = order.indexOf("tech-lab");
    const factories = order.slice(0, Math.max(0, lab)).filter((k) => k === "fab-plant" || k === "airpad").length;
    if (lab >= 0 && factories < 3)
      order.splice(lab, 0, infantryWar ? "assembly-bay" : s.strategy.airOnly || bannedBy(w, "fab-plant", faction) ? "airpad" : "fab-plant");
  }
  // depots follow the mining (Strategy.depotReach): one more, early, while there's a field for it
  if (s.strategy.depotReach !== undefined) {
    const depots = Math.min(depotCap(w, faction, s.strategy), Math.max(order.filter((k) => k === "depot").length, (have.get("depot") ?? 0) + 1));
    for (let i = order.filter((k) => k === "depot").length; i < depots; i++) order.splice(Math.min(order.length, 3), 0, "depot");
  }
  const fabs = order.filter((k) => k === "fab-plant").length;
  const pads = order.filter((k) => k === "airpad").length;
  const noFab = bannedBy(w, "fab-plant", faction) !== null; // Air War mutator (or an op)
  // (early, but not ahead of a Tech Lab still to come: scrap banked while its prerequisites go up
  // would otherwise buy factory after factory in front of it)
  // (the Wall's Tech Lab waits for its turrets, so the factories don't wait for it)
  const lab = wall || (have.get("tech-lab") ?? 0) > 0 ? -1 : order.indexOf("tech-lab");
  // the factories its doctrine wants, on top of what the order has (ai/doctrine.ts)
  if (s.doctrine) {
    const counted = new Map<BuildingKind, number>();
    for (const k of DOCTRINES[s.doctrine.name].factories) {
      counted.set(k, (counted.get(k) ?? 0) + 1);
      if (order.filter((o) => o === k).length < counted.get(k)!) order.push(k);
    }
  }
  for (let i = 0; i < s.extraProduction; i++) {
    // (weighing: no more Airpads into massed flak)
    const flak = !!s.weighs && s.seenAA >= FLAK_WALL;
    const air = s.strategy.airOnly || noFab || (!s.strategy.heavy && !flak && pads + (i % 2) <= fabs);
    // (the Wall: the three factories in turn, its tier 1 from each)
    const k = infantryWar ? "assembly-bay" : wall ? WALL_FACTORIES[i % 3]! : air ? "airpad" : "fab-plant";
    if (s.strategy.expandEarly) order.splice(Math.min(order.length, Math.max(2 + i, lab + 1 + i)), 0, k);
    else order.push(k);
  }
  // (depots follow the mining: the next Depot goes up before anything put in ahead of it since —
  // expandEarly's factories, the turrets and SAMs answering what it saw. Each factory built was
  // replaced by another in front of it, -dune-sea-…-brutal: Juggernaut's Depot, fifth in its plan,
  // slid to eleventh and went up at 4:23, the home field long dry. Brutal, 24 games each against
  // the order as it was: Juggernaut 15–1, Skyforce 13–4, Strike 12–8; the plans with an early Depot unchanged)
  if (s.strategy.depotReach !== undefined) {
    const counted = new Map<BuildingKind, number>();
    const left = order.findIndex((k) => {
      counted.set(k, (counted.get(k) ?? 0) + 1);
      return (have.get(k) ?? 0) < counted.get(k)!;
    });
    if (s.strategy.landGrab) {
      // (every Depot up to the first it hasn't got: they're counted in order, so the next one alone
      // may be one that stands, the one it wants left behind a run of factories. Frostbite: red
      // stopped at three from 2:00 on)
      const ahead = order.slice(0, Math.max(0, left)).filter((k) => k === "depot").length;
      for (let at = left, n = ahead; left >= 0 && n <= (have.get("depot") ?? 0); at++, n++) {
        const d = order.indexOf("depot", at);
        if (d < 0) break;
        order.splice(d, 1);
        order.splice(at, 0, "depot");
      }
    } else {
      const depot = order.indexOf("depot", left);
      if (left >= 0 && depot > left) {
        order.splice(depot, 1);
        order.splice(left, 0, "depot");
      }
    }
  }
  const wanted = new Map<BuildingKind, number>();
  let depotsSkipped = 0;
  let deferred = false;
  for (const kind of order) {
    wanted.set(kind, (wanted.get(kind) ?? 0) + 1);
    if ((have.get(kind) ?? 0) >= wanted.get(kind)!) continue;
    let expansion = false;
    if (kind === "depot" && depotsSkipped < 3) {
      // only worth it if there's a distant field we can actually reach: a spot in range, or one past it
      // that a crew deploys to (ai/expansion.ts)
      const hq = hqOf(w, faction);
      const c = hq ? buildingCenter(hq) : null;
      // (the Wall founds none: with no spot in range, the turrets build out toward the field instead)
      expansion = !!c && !wall && depotByCrew(w, faction, s, c);
      if (!c || (!expansion && !safeDepotSite(w, faction, s, c))) {
        // (the Wall expands hard: with a field out there to reach, the next turret builds out to it, ahead of the rest)
        if (wall && c && wallFrontier(w, faction, s.strategy, c, mirror(w, c.x, c.y)) && !buildingBlocker(w, faction, "turret")) return "turret";
        depotsSkipped++;
        continue;
      }
    }
    if (skipExpansion && expansion) continue;
    if (expansion && creep) {
      deferred = true;
      if (out) out.deferred = true;
      continue;
    }
    if (expansion) return kind; // (deployed by a crew: ai/expansion.ts)
    if (buildingBlocker(w, faction, kind)) continue;
    if (fits && !fits(kind)) continue; // (no room for it in any ring: the next thing that fits)
    // (the creep goes on only while production is what comes next: else the crew goes after all)
    if (deferred && !CREEP_KINDS.has(kind)) return crewAfterAll();
    return kind;
  }
  return deferred ? crewAfterAll() : null;

  function crewAfterAll(): BuildingKind | null {
    if (out) out.deferred = false;
    return skipExpansion ? null : "depot";
  }
}

/**
 * Production that carries the build zone out to the next field (creepTarget): what the player does on
 * Dune Sea, an Assembly Bay, an Airpad and a Fab Plant one in front of the other out to the field in
 * front of the base, then an ordinary Depot by it — no crew of four used up, a Depot at full health,
 * and the factories' new units standing by it (replay 2026-11-03).
 */
const CREEP_KINDS: ReadonlySet<BuildingKind> = new Set(["fab-plant", "airpad", "assembly-bay", "tech-lab"]);
/** The creep's buildings stop this far (tiles) short of the field: the Depot goes up in front of them, by it. */
const CREEP_SHORT = 5;
/** A field this close (tiles) to one of the base's buildings is built out to, not crewed: two or three buildings' reach. */
const CREEP_REACH = 16;

/**
 * Where the base builds its production out to, or null: the next field the expansion wants (ai/expansion.ts
 * unservedField, nearest on foot) while no Depot fits by it yet, on our side of the map, within depotFar of
 * the HQ and CREEP_REACH of a building of ours. Not the Wall (its turrets build out) nor a plan that holds
 * its choke (it keeps a tight base behind it), nor Last Stand.
 */
function creepTarget(
  w: World,
  faction: Faction,
  strategy: Strategy,
  hqC: { x: number; y: number },
  ourSide: (tx: number, ty: number) => boolean
): { x: number; y: number } | null {
  if (strategy.wall || strategy.holdChoke || w.survival) return null;
  let depots = 0;
  for (const b of w.buildings.values()) if (b.faction === faction && b.kind === "depot") depots++;
  if (depots >= depotCap(w, faction, strategy)) return null;
  if (depotSite(w, faction, hqC, strategy.depotReach, depotFar(strategy), depotTries(strategy))) return null; // (one fits already: hot or not, it's no creep's business)
  const field = unservedField(w, faction, hqC, Math.max(strategy.depotReach ?? 9, SERVED));
  if (!field || field.d > depotFar(strategy) || !ourSide(Math.floor(field.x), Math.floor(field.y))) return null;
  let near = Infinity;
  for (const b of w.buildings.values())
    if (b.faction === faction && !b.outpost) {
      const c = buildingCenter(b);
      near = Math.min(near, dist(c.x, c.y, field.x, field.y));
    }
  if (near > CREEP_REACH) return null;
  const d = Math.max(1, dist(field.x, field.y, hqC.x, hqC.y));
  const by = Math.min(CREEP_SHORT, d);
  const at = { x: field.x + ((hqC.x - field.x) / d) * by, y: field.y + ((hqC.y - field.y) / d) * by };
  // (only while the next building gets nearer: Frostbite's field past a band of rock and woods drew
  // the factories up to the ridge, where the zone can't cross, and held the crew back till 4:28)
  const spot = findPlacementSpot(w, faction, "fab-plant", at);
  const size = BUILDINGS["fab-plant"].size / 2;
  if (!spot || dist(spot.tx + size, spot.ty + size, field.x, field.y) > near - CREEP_STEP) return null;
  return at;
}
/** The creep's next building must stand at least this much (tiles) nearer the field than the nearest one does. */
const CREEP_STEP = 2;

/** Harvesters Land Grab keeps mining for each Depot before another crew goes. */
const GRAB_MINERS = 3;
/** Land Grab's share of the army that goes to a site it's fighting for (Strategy.landGrab). */
const CONTEST_SHARE = 0.6;
/** …which must outweigh what's seen by the site by this much (as WAVE_EDGE). */
const CONTEST_EDGE = 1.2;
/** Enemies this close to a site (tiles) are in the fight for it. */
const CONTEST_RADIUS = 10;

/**
 * Is a site worth fighting for: does CONTEST_SHARE of our army outweigh the armed enemies seen by it,
 * and, for a commander that weighs, our whole army at least match the one it remembers (`remembered`:
 * what's by the site may be the edge of it)? The share sent whatever was there lost the army to the
 * enemy's main force.
 */
function contestWinnable(seen: readonly Unit[], x: number, y: number, armyValue: number, remembered: number): boolean {
  let there = 0;
  for (const e of seen) if (UNITS[e.kind].dps > 0 && dist(e.x, e.y, x, y) <= CONTEST_RADIUS) there += UNITS[e.kind].cost;
  return CONTEST_SHARE * armyValue >= CONTEST_EDGE * there && armyValue >= remembered;
}

/**
 * Where the guard stands when the base has an expansion out past its home field on our side of the map:
 * between its Depot and field, a step toward the enemy (the one nearest the enemy, if several), or null.
 */
function expansionGuard(
  w: World,
  faction: Faction,
  hqC: { x: number; y: number },
  enemyHome: { x: number; y: number },
  ourSide: (tx: number, ty: number) => boolean
): { x: number; y: number } | null {
  let best: { x: number; y: number; d: number } | null = null;
  for (const site of expansionSites(w, faction, hqC)) {
    const mx = (site.cx + site.field.x + 0.5) / 2;
    const my = (site.cy + site.field.y + 0.5) / 2;
    if (!ourSide(Math.floor(mx), Math.floor(my))) continue;
    const d = dist(mx, my, enemyHome.x, enemyHome.y);
    if (best && d >= best.d) continue;
    const by = Math.min(EXPANSION_GUARD_OUT, d);
    best = { x: mx + ((enemyHome.x - mx) / Math.max(1, d)) * by, y: my + ((enemyHome.y - my) / Math.max(1, d)) * by, d };
  }
  return best && { x: best.x, y: best.y };
}
/** The expansion guard stands this far (tiles) out from its Depot and field, toward the enemy. */
const EXPANSION_GUARD_OUT = 2;

/**
 * The Wall's buildings after its build order (Strategy.wall): turrets to `max`,
 * a SAM Site after every `samEvery`th, and the Tech Lab after the `tech`th.
 */
function wallOrder(wall: NonNullable<Strategy["wall"]>, order: readonly BuildingKind[]): BuildingKind[] {
  const out: BuildingKind[] = [];
  for (let n = order.filter((k) => k === "turret").length + 1; n <= wall.max; n++) {
    out.push("turret");
    if (n % wall.samEvery === 0) out.push("sam-site");
    if (n === wall.tech) out.push("tech-lab"); // (what it needs is in the build order, nextBuilding puts it in if not)
  }
  return out;
}

/** The factories the Wall adds when scrap piles up, in turn. */
const WALL_FACTORIES = ["fab-plant", "airpad", "assembly-bay"] as const;
/** The Wall's guard round a Depot counts its turrets (or SAM Sites) this close (tiles). */
const WALL_GUARD = 6;
/** …and stands this far out from it, toward the enemy. */
const WALL_OUT = 3;
/** A Depot this close to the HQ (tiles) is home, and gets no guard of its own. */
const WALL_HOME = 10;
/** The creep's front is this wide (tiles each side of the line to its target): turrets go up across it in turn. */
const WALL_SPREAD = 5;
/** A field with this many of our turrets by it (WALL_GUARD) and still no Depot is given up on: the wall moves on. */
const WALL_STUCK = 4;

/**
 * Where the Wall's next turret or SAM Site goes (Strategy.wall). Always
 * forward, the HQ guarded only by the creep going out from it:
 *
 * - a Depot out past WALL_HOME with fewer than `guard` turrets (one SAM
 *   Site) by it: on the enemy's side of it (each expansion enveloped before
 *   the wall moves on);
 * - a turret: out toward the nearest field on our side nothing serves,
 *   carrying the build zone till a Depot fits by it;
 * - else the creep: a turret at the edge of the zone toward the nearest
 *   enemy drop-off we know of (their expansions first, then their HQ),
 *   across a front WALL_SPREAD wide; a SAM Site by the turret nearest it,
 *   to cover the creep from the air.
 */
function wallAnchor(
  w: World,
  faction: Faction,
  strategy: Strategy,
  kind: "turret" | "sam-site",
  myBuildings: readonly Building[],
  hqC: { x: number; y: number },
  enemyHome: { x: number; y: number }
): { x: number; y: number } {
  const wall = strategy.wall!;
  const guards = myBuildings.filter((b) => b.kind === kind).map(buildingCenter);
  // the creep's target: the enemy drop-off we know of nearest our HQ, or their home
  let target = enemyHome;
  let best = Infinity;
  for (const kb of knownBuildings(w, faction)) {
    if (kb.faction === faction || !BUILDINGS[kb.kind].dropOff) continue;
    const s = BUILDINGS[kb.kind].size / 2;
    const d = dist(kb.tx + s, kb.ty + s, hqC.x, hqC.y);
    if (d < best) (best = d), (target = { x: kb.tx + s, y: kb.ty + s });
  }
  let weakest: { c: { x: number; y: number }; n: number; d: number } | null = null;
  for (const b of myBuildings) {
    if (b.kind !== "depot" || b.outpost || b.founding !== undefined) continue;
    const c = buildingCenter(b);
    if (dist(c.x, c.y, hqC.x, hqC.y) <= WALL_HOME) continue; // (one by the HQ is home: the creep out from it guards it)
    const n = guards.filter((g) => dist(g.x, g.y, c.x, c.y) <= WALL_GUARD).length;
    const d = dist(c.x, c.y, target.x, target.y);
    // (ties: the one nearer the enemy)
    if (!weakest || n < weakest.n || (n === weakest.n && d < weakest.d)) weakest = { c, n, d };
  }
  const toward = (c: { x: number; y: number }, to: { x: number; y: number }, by: number) => {
    const d = dist(c.x, c.y, to.x, to.y);
    return d < 1 ? c : { x: c.x + ((to.x - c.x) / d) * by, y: c.y + ((to.y - c.y) / d) * by };
  };
  if (weakest && weakest.n < (kind === "turret" ? wall.guard : 1)) return toward(weakest.c, target, WALL_OUT);
  if (kind === "sam-site") {
    // (by the turret nearest the target, a step back toward home)
    let front: { x: number; y: number } | null = null;
    for (const b of myBuildings)
      if (b.kind === "turret") {
        const c = buildingCenter(b);
        if (!front || dist(c.x, c.y, target.x, target.y) < dist(front.x, front.y, target.x, target.y)) front = c;
      }
    return front ? toward(front, hqC, 1.5) : toward(hqC, target, WALL_OUT);
  }
  const field = wallFrontier(w, faction, strategy, hqC, enemyHome);
  if (field) return field;
  // (across the front in turn: left of the line, on it, right of it; the nearest spot in the zone to
  // that point is the zone's edge toward it)
  const d = Math.max(1, dist(hqC.x, hqC.y, target.x, target.y));
  const side = (guards.length % 3) - 1;
  return { x: target.x - ((target.y - hqC.y) / d) * WALL_SPREAD * side, y: target.y + ((target.x - hqC.x) / d) * WALL_SPREAD * side };
}

/**
 * The field the Wall builds out to next (Strategy.wall): the nearest to the HQ that nothing
 * serves, on our side of the map (nearer us than `enemyHome`), while it has Depots to go.
 */
function wallFrontier(w: World, faction: Faction, strategy: Strategy, hqC: { x: number; y: number }, enemyHome: { x: number; y: number }): { x: number; y: number } | null {
  let depots = 0;
  for (const b of w.buildings.values()) if (b.faction === faction && b.kind === "depot") depots++;
  if (depots >= depotCap(w, faction, strategy)) return null;
  // (turrets round a field can take the spot its Depot needed: with WALL_STUCK by it and still none, on to the next)
  const turrets: { x: number; y: number }[] = [];
  for (const b of w.buildings.values()) if (b.faction === faction && b.kind === "turret") turrets.push(buildingCenter(b));
  const stuck = (x: number, y: number) => {
    let n = 0;
    for (const t of turrets) if (dist(t.x, t.y, x, y) <= WALL_GUARD && ++n >= WALL_STUCK) return true;
    return false;
  };
  const field = unservedField(w, faction, hqC, Math.max(strategy.depotReach ?? 9, SERVED), stuck, true);
  return field && dist(field.x, field.y, hqC.x, hqC.y) <= dist(field.x, field.y, enemyHome.x, enemyHome.y) ? field : null;
}

/** How far from the HQ a field may be for a Depot in the build zone: the Wall builds its zone out to far ones. */
const depotFar = (s: Strategy): number => (s.wall ? 36 : 24);
/** How many fields, nearest first, a Depot site is looked for by: the Wall's turrets may have taken one field's spot, and go on to the next. */
const depotTries = (s: Strategy): number => (s.wall ? 4 : 1);

/** Is the Depot it wants one a crew deploys past the build zone (no spot in range, but one out there)? */
function depotByCrew(w: World, faction: Faction, s: AiState, hqC: { x: number; y: number }): boolean {
  const reach = s.strategy.depotReach;
  return !safeDepotSite(w, faction, s, hqC, 24, 1) && !!expansionSite(w, faction, hqC, reach ?? 9);
}

/** Tiles of one field are at most this far apart (a gap in a field's piles doesn't split it). */
const FIELD_GAP = 2;
/**
 * Which field each scrap or crystal tile belongs to (-1: none), from the map
 * as it is now. (Not memoised: every page of a lockstep match must agree, and
 * a world rebuilt from a checkpoint would remember a different map.)
 */
function fieldIds(w: World): Int32Array {
  const ids = new Int32Array(w.width * w.height).fill(-1);
  const isField = (i: number) => w.terrain[i] === Terrain.Scrap || w.terrain[i] === Terrain.Crystal;
  let next = 0;
  for (let i = 0; i < ids.length; i++) {
    if (ids[i] !== -1 || !isField(i)) continue;
    const stack = [i];
    ids[i] = next;
    while (stack.length) {
      const k = stack.pop()!;
      const x = k % w.width;
      const y = Math.floor(k / w.width);
      for (let dy = -FIELD_GAP; dy <= FIELD_GAP; dy++)
        for (let dx = -FIELD_GAP; dx <= FIELD_GAP; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w.width || ny >= w.height) continue;
          const j = ny * w.width + nx;
          if (ids[j] === -1 && isField(j)) {
            ids[j] = next;
            stack.push(j);
          }
        }
    }
    next++;
  }
  return ids;
}

/**
 * depotSite, on ground that's safe (AiState.hotSpots): with a spot gone hot, the next field's. Replay
 * 2026-11-05: a Depot killed at 2:08 went up again on the same tiles at 2:54 and 3:34, in the sidebar
 * where nothing asked what stood there, 20 s of the build slot and 500 scrap for 13 s of Depot.
 */
function safeDepotSite(
  w: World,
  faction: Faction,
  s: AiState,
  hqC: { x: number; y: number },
  far = depotFar(s.strategy),
  tries = depotTries(s.strategy)
): { spot: { tx: number; ty: number } } | null {
  const reach = s.strategy.depotReach ?? 9;
  const hot = s.hotSpots;
  if (!hot?.length) return depotSite(w, faction, hqC, reach, far, tries);
  const clear = (x: number, y: number) => !hot.some((h) => dist(h.x, h.y, x, y) <= UNSAFE);
  return perTick(w, `safe depot ${faction} ${hqC.x} ${hqC.y} ${reach} ${far} ${tries}`, () => scanDepotSite(w, faction, hqC, reach, far, tries, clear));
}

/** A spot for a forward depot next to a field no drop-off serves yet. */
function depotSite(
  w: World,
  faction: Faction,
  hqC: { x: number; y: number },
  reach = 9,
  /** Fields farther than this from the HQ are left out. */
  far = 24,
  /** Fields tried, nearest first. */
  tries = 1
): { spot: { tx: number; ty: number } } | null {
  return perTick(w, `depot ${faction} ${hqC.x} ${hqC.y} ${reach} ${far} ${tries}`, () => scanDepotSite(w, faction, hqC, reach, far, tries));
}
function scanDepotSite(
  w: World,
  faction: Faction,
  hqC: { x: number; y: number },
  reach: number,
  far: number,
  tries: number,
  /** Is this spot fit to build on? Left out: all are. Unfit fields don't count toward `tries`. */
  clear?: (x: number, y: number) => boolean
): { spot: { tx: number; ty: number } } | null {
  const fr = sideFrame(w, faction); // scanned in the side's own frame (mirror-fair ties)
  // (a field with a drop-off in reach of any of its tiles is served: one depot to a field, not a ring of them)
  const ids = fieldIds(w);
  const served = new Set<number>();
  for (let i = 0; i < ids.length; i++) {
    if (ids[i]! < 0 || served.has(ids[i]!) || !isResource(w, i)) continue;
    const drop = nearestDropOff(w, faction, (i % w.width) + 0.5, Math.floor(i / w.width) + 0.5);
    if (drop) {
      const dc = buildingCenter(drop);
      if (dist((i % w.width) + 0.5, Math.floor(i / w.width) + 0.5, dc.x, dc.y) < reach) served.add(ids[i]!);
    }
  }
  // (the nearest tile of each field, on foot from our drop-offs, as ai/expansion.ts unservedField)
  const walk = walkFromDrops(w, faction);
  const near = new Map<number, { x: number; y: number; d: number; k: number }>();
  for (let fy = 0; fy < w.height; fy++)
    for (let fx = 0; fx < w.width; fx++) {
      const [tx, ty] = fr.tile(fx, fy, 1);
      const i = tileIndex(w, tx, ty);
      if (!isResource(w, i) || served.has(ids[i]!)) continue;
      if (!nearestDropOff(w, faction, tx + 0.5, ty + 0.5)) continue;
      const d = dist(tx + 0.5, ty + 0.5, hqC.x, hqC.y);
      if (d > far) continue;
      const k = walk[i]! >= 0 ? walk[i]! : UNWALKED + d;
      const had = near.get(ids[i]!);
      if (!had || k < had.k || (k === had.k && d < had.d)) near.set(ids[i]!, { x: tx + 0.5, y: ty + 0.5, d, k });
    }
  // (ties keep scan order: a stable sort, in the side's own frame)
  const fields = [...near.values()].sort((a, b) => a.k - b.k || a.d - b.d).filter((f) => !clear || clear(f.x, f.y)).slice(0, tries);
  for (const best of fields) {
    const spot = findPlacementSpot(w, faction, "depot", best);
    if (!spot || dist(spot.tx + 1, spot.ty + 1, best.x, best.y) > 5) continue;
    if (clear && !clear(spot.tx + 1, spot.ty + 1)) continue;
    // reachable by ground from just behind the HQ (in the side's own frame)
    const [bx, by] = fr.vec(0, 2.5);
    if (!findPath(w, hqC.x + bx, hqC.y + by, best.x, best.y, "ground", faction)) continue;
    return { spot };
  }
  return null;
}

/** Closest placeable spot to `anchor` within build range of our base. */
function findPlacementSpot(
  w: World,
  faction: Faction,
  kind: BuildingKind,
  anchor: { x: number; y: number }
): { tx: number; ty: number } | null {
  const size = BUILDINGS[kind].size;
  // candidates are generated and compared in the side's own frame, so ties
  // (common: spots equidistant from the HQ) resolve as mirror images
  const fr = sideFrame(w, faction);
  const a = fr.toFrame(anchor);
  let best: { tx: number; ty: number } | null = null;
  let bestD = Infinity;
  // round every building of the base (outposts never give build range) and every dug-in Goliath's ring
  const centres: { c: { x: number; y: number }; r: number }[] = [];
  for (const b of w.buildings.values())
    if (b.faction === faction && !b.outpost) centres.push({ c: buildingCenter(b), r: buildRadiusOf(b, kind) + 2 });
  const dugIn = goliathsOf(w, faction).filter(isAnchored);
  if (kind !== "hq") for (const g of dugIn) centres.push({ c: g, r: Math.ceil(GOLIATH.buildRing + size) });
  /** A tile's lane round a dug-in Goliath's feet stays open (it walks out again once packed up). */
  const atFeet = (tx: number, ty: number) => dugIn.some((g) => distToFootprint(tx, ty, size, g.x, g.y) < GOLIATH.footprint / 2 + 1);
  // a Gantry's Goliath rolls out GOLIATH.footprint wide: the Gantry keeps that lane all round it, clear of
  // the map edge, rock and other buildings (replay 2026-11-03: one by the map edge, boxed in by a Depot
  // and a Fab Plant, held its Goliath for 30 s while the base was attacked)
  const lane = GOLIATH.footprint;
  const gantries = kind === "gantry" ? [] : [...w.buildings.values()].filter((b) => b.faction === faction && b.kind === "gantry");
  const gs = BUILDINGS.gantry.size;
  const inLane = (tx: number, ty: number) =>
    gantries.some((b) => tx < b.tx + gs + lane && tx + size > b.tx - lane && ty < b.ty + gs + lane && ty + size > b.ty - lane);
  const laneClear = (tx: number, ty: number) => {
    for (let y = ty - lane; y < ty + size + lane; y++)
      for (let x = tx - lane; x < tx + size + lane; x++) {
        if (x >= tx && x < tx + size && y >= ty && y < ty + size) continue;
        if (!passable(w, x, y, "ground")) return false;
      }
    return true;
  };
  for (const { c: at, r } of centres) {
    const c = fr.toFrame(at);
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const fx = Math.round(c.x + dx - size / 2);
        const fy = Math.round(c.y + dy - size / 2);
        const d = dist(fx + size / 2, fy + size / 2, a.x, a.y);
        if (d >= bestD) continue;
        const [tx, ty] = fr.tile(fx, fy, size);
        if (!canPlaceBuilding(w, faction, kind, tx, ty)) continue;
        // keep a lane open: don't wall the HQ in with production buildings
        if (size > 1 && isCramped(w, tx, ty, size)) continue;
        if (dugIn.length > 0 && atFeet(tx, ty)) continue;
        if (kind === "gantry" ? !laneClear(tx, ty) : gantries.length > 0 && inLane(tx, ty)) continue;
        // and never box ground in: a pocket our own units roll out into and can't leave, or the base's way out shut
        if (sealsOff(w, tx, ty, size)) continue;
        best = { tx, ty };
        bestD = d;
      }
  }
  return best;
}

/** Corner-sweep waypoints for scouts, biased toward the far half. */
function scoutSweep(w: World, c: { x: number; y: number }, leg: number): { x: number; y: number } {
  const far = mirror(w, c.x, c.y);
  const stops = [
    far,
    { x: far.x, y: c.y },
    { x: c.x, y: far.y },
    { x: w.width / 2, y: w.height / 2 }
  ];
  return stops[leg % stops.length]!;
}

/** Fields this far from an HQ (tiles) count as its home field, not an expansion. */
const HOME_FIELD = 10;

/**
 * Our side's fields an expansion would go to, nearest the HQ first (one
 * point per field, past the home field and within reach): mirrored, where
 * the enemy would expand.
 */
function expansionFields(w: World, faction: Faction, hqC: { x: number; y: number }): { x: number; y: number }[] {
  const tiles: { x: number; y: number; d: number }[] = [];
  const fr = sideFrame(w, faction); // scanned in the side's own frame (mirror-fair ties)
  for (let fy = 0; fy < w.height; fy++)
    for (let fx = 0; fx < w.width; fx++) {
      const [tx, ty] = fr.tile(fx, fy, 1);
      if (!isResource(w, tileIndex(w, tx, ty))) continue;
      const d = dist(tx + 0.5, ty + 0.5, hqC.x, hqC.y);
      if (d > HOME_FIELD && d <= 36) tiles.push({ x: tx + 0.5, y: ty + 0.5, d });
    }
  tiles.sort((a, b) => a.d - b.d); // (stable: ties keep the frame's scan order)
  const out: { x: number; y: number }[] = [];
  for (const t of tiles) if (out.length < 3 && !out.some((o) => dist(o.x, o.y, t.x, t.y) < 8)) out.push({ x: t.x, y: t.y });
  return out;
}

/** Tiles from their HQ past which a known Depot of theirs counts as an expansion. */
const EXPANSION_OFF_HQ = 12;

/**
 * Known enemy expansion Depots, nearest `from` first: with `rising`, only
 * those still going up (economy.ts tickFounding), else the finished ones.
 */
function enemyExpansions(
  w: World, faction: Faction, from: { x: number; y: number }, focus: Faction | null, rising: boolean
): { id: number; x: number; y: number }[] {
  const known = knownBuildings(w, faction).filter((kb) => !focus || kb.faction === focus);
  const centre = (kb: KnownBuilding) => ({ x: kb.tx + BUILDINGS[kb.kind].size / 2, y: kb.ty + BUILDINGS[kb.kind].size / 2 });
  const hqs = known.filter((kb) => kb.kind === "hq").map(centre);
  const out: { id: number; x: number; y: number }[] = [];
  for (const kb of known) {
    if (kb.kind !== "depot") continue;
    const c = centre(kb);
    const up = w.buildings.get(kb.id)?.founding !== undefined;
    if (rising ? !up : up || hqs.some((h) => dist(h.x, h.y, c.x, c.y) < EXPANSION_OFF_HQ) || !hqs.length) continue;
    out.push({ id: kb.id, ...c });
  }
  return out.sort((a, b) => dist(a.x, a.y, from.x, from.y) - dist(b.x, b.y, from.x, from.y) || a.id - b.id);
}

/** Where the enemy probably mines: their side's scrap, or mirror of ours. */
function enemyHarvestArea(
  w: World,
  faction: Faction,
  hqC: { x: number; y: number },
  seen: Unit[],
  focus: Faction | null = null,
  /** Raids launched so far: an odd one looks in on a field they'd expand to, not their home field. */
  leg = 0
): { x: number; y: number; targetId?: number } {
  // a Gantry with a Goliath on the cradle beats anything (killed mid-build, the build is lost)
  const gantry = enemyGantryBuilds(w, faction).sort((a, b) => dist(a.x, a.y, hqC.x, hqC.y) - dist(b.x, b.y, hqC.x, hqC.y) || a.id - b.id)[0];
  if (gantry) return { x: gantry.x, y: gantry.y, targetId: gantry.id };
  // an expansion Depot going up: frail, undefended, and its crew already spent on it
  const [rising] = enemyExpansions(w, faction, hqC, focus, true);
  if (rising) return { x: rising.x, y: rising.y, targetId: rising.id };
  // a visible enemy harvester is the best target
  for (const u of seen) if (u.kind === "harvester") return { x: u.x, y: u.y, targetId: u.id };
  // the harvesters at an expansion: further from their HQ's guns than the home field's
  const [outpost] = enemyExpansions(w, faction, hqC, focus, false);
  if (outpost) return { x: outpost.x, y: outpost.y };
  const own = nearestScrapTile(w, hqC.x, hqC.y, faction);
  // (a free-for-all: the focus rival's field, ours turned onto its corner)
  if (focus) return homeOf(w, faction, focus, own ? { x: own.x + 0.5, y: own.y + 0.5 } : hqC);
  if (leg % 2 === 1) {
    const out = expansionFields(w, faction, hqC);
    const f = out[(leg >> 1) % Math.max(1, out.length)];
    if (f) return mirror(w, f.x, f.y);
  }
  if (own) return mirror(w, own.x + 0.5, own.y + 0.5);
  return mirror(w, hqC.x, hqC.y);
}

/** A free-for-all: each rival's threat value raiding our base (within DEFENSE_RADIUS of it), for pickFocus. */
function raidersAt(w: World, threats: readonly Threat[], home: { x: number; y: number }): Map<Faction, number> {
  const out = new Map<Faction, number>();
  for (const t of threats) {
    const f = w.units.get(t.id)?.faction;
    if (!f || dist(t.x, t.y, home.x, home.y) > DEFENSE_RADIUS) continue;
    out.set(f, (out.get(f) ?? 0) + t.value);
  }
  return out;
}

export type { Unit };
