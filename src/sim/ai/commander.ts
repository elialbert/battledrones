import { BUILDINGS, ECONOMY, OBJECTIVES, UNITS } from "../balance";
import { TICK_RATE } from "../balance";
import { buildingBlocker, canPlaceBuilding, nearestReachableResource, nearestScrapTile, unitBlocker } from "../economy";
import { isVisible, knownBuildings } from "../fog";
import { findPath } from "../movement";
import { planSalvage } from "./salvage";
import { objectiveHolds, planObjectives } from "./objectives";
import { dodgeCalldowns, dodgingUnits, planCalldowns } from "./powers";
import type {
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
import {
  buildingCenter,
  dist,
  hqOf,
  isResource,
  nearestDropOff,
  tileIndex
} from "../world";

export type AiMode = "buildup" | "harass" | "assault";
export type Difficulty = "easy" | "normal" | "hard";

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
  /** Idle raiders required before a harass raid launches. */
  harassGroup: number;
  /** Air force first: the Fab Plant only makes anti-air and a small home guard. */
  airOnly?: boolean;
  /** Lean on heavy tech ground units (titans, lancers, mortars). */
  heavy?: boolean;
  /** Early raids use stingers as well as wasps. */
  groundRaids?: boolean;
}

export type StrategyName = "balanced" | "rush" | "airswarm" | "boom" | "skyforce" | "ironclad";

export const STRATEGIES: Record<StrategyName, Strategy> = {
  /** Steady macro: factory, airpad, tech, standard timing. */
  balanced: {
    name: "balanced",
    label: "Balanced",
    buildOrder: ["fab-plant", "airpad", "turret", "tech-lab", "depot", "turret", "radar"],
    harvesters: 4,
    assaultValue: 1700,
    harassGroup: 2
  },
  /** Early ground pressure: Stinger raids in packs of five, two factories, the earliest and smallest waves. */
  rush: {
    name: "rush",
    label: "Rush",
    buildOrder: ["fab-plant", "turret", "airpad", "fab-plant", "tech-lab"],
    harvesters: 4,
    assaultValue: 1400,
    harassGroup: 5,
    groundRaids: true
  },
  /** Airpad first: relentless wasp raids, bombers later. */
  airswarm: {
    name: "airswarm",
    label: "Air Swarm",
    buildOrder: ["airpad", "fab-plant", "turret", "tech-lab", "depot", "airpad"],
    harvesters: 4,
    assaultValue: 1700,
    harassGroup: 2
  },
  /** Greedy economy: extra harvesters, a forward depot, a huge late push. */
  boom: {
    name: "boom",
    label: "Boom",
    buildOrder: ["fab-plant", "depot", "turret", "tech-lab", "airpad", "turret", "radar", "sam-site"],
    harvesters: 4,
    assaultValue: 2000,
    harassGroup: 3
  },
  /** Air force: wasps, raptors and hornets; the late Fab Plant only guards home. */
  skyforce: {
    name: "skyforce",
    label: "Skyforce",
    buildOrder: ["airpad", "turret", "tech-lab", "airpad", "fab-plant", "depot", "sam-site"],
    harvesters: 4,
    assaultValue: 2000,
    harassGroup: 2,
    airOnly: true
  },
  /** Armoured column: rushes the Tech Lab (right after a turret) for Titans, Lancers and Mortars. */
  ironclad: {
    name: "ironclad",
    label: "Ironclad",
    buildOrder: ["fab-plant", "turret", "tech-lab", "airpad", "depot", "fab-plant", "sam-site"],
    harvesters: 4,
    assaultValue: 1500,
    harassGroup: 3,
    heavy: true
  }
};

export const DIFFICULTY: Record<
  Difficulty,
  {
    label: string; interval: number; incomeMult: number; extraHarvesters: number; assaultMult: number; harass: boolean;
    /** Personalities this difficulty picks from at random. */
    pool: StrategyName[];
  }
> = {
  easy: {
    label: "Easy", interval: 3.5, incomeMult: 0.75, extraHarvesters: -1, assaultMult: 1.35, harass: false,
    pool: ["balanced", "rush", "airswarm", "skyforce"]
  },
  normal: {
    label: "Normal", interval: 2, incomeMult: 1, extraHarvesters: 0, assaultMult: 1, harass: true,
    pool: ["balanced", "rush", "airswarm", "boom", "skyforce", "ironclad"]
  },
  hard: {
    label: "Hard", interval: 1.2, incomeMult: 1.3, extraHarvesters: 1, assaultMult: 0.9, harass: true,
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
  /** Heavily armoured enemy ground units seen (titans, harvesters don't count). */
  seenHeavy: number;
  /** Enemy anti-air (flak, lancers, raptors) seen recently. */
  seenAA: number;
  /** Tick the last scout was ordered (scouts are cheap but not free). */
  lastScoutTick: number;
  scoutLeg: number;
  /** Deterministic RNG state for tie-breaks. */
  rng: number;
  /** Extra SAM sites wanted in response to enemy air. */
  extraSams: number;
  /** Extra production buildings wanted because scrap is piling up. */
  extraProduction: number;
  /** Depot build order entries we gave up on (no useful spot). */
  skippedDepots: number;
  /** Army value when the current wave launched (for retreat decisions). */
  waveValue: number;
}

/** Pass a strategy for deterministic behaviour (tests); omit for random. */
export function createAiState(strategy?: StrategyName, difficulty: Difficulty = "normal", seed?: number): AiState {
  const names = DIFFICULTY[difficulty].pool;
  const picked = strategy ?? names[Math.floor(Math.random() * names.length)]!;
  return {
    mode: "buildup",
    strategy: STRATEGIES[picked],
    difficulty,
    lastDecisionTick: -1000,
    seenAir: 0,
    seenGround: 0,
    seenHeavy: 0,
    seenAA: 0,
    lastScoutTick: -1e9,
    scoutLeg: 0,
    rng: seed ?? 12345,
    extraSams: 0,
    extraProduction: 0,
    skippedDepots: 0,
    waveValue: 0
  };
}

const RETREAT_ARMY_VALUE = 350;
/**
 * Share of the assault threshold that must gather at the staging point
 * before a wave launches: big waves, and a lull while the next one gathers
 * (at 0.6 waves trickled out every 500–1,200 scrap, fighting never paused,
 * and the side ahead at 4:00 won 87–90%).
 */
const WAVE_LAUNCH = 0.75;
/** No raids before this: an opener's starting units guard home while both sides settle in. */
const OPENING_GRACE = 45 * TICK_RATE;
/** Enemy army value at the HQ that, if it outguns the home guard, recalls everyone. */
const HOME_ALARM_VALUE = 400;
/** Visible armed enemies this close to our buildings/harvesters are threats. */
const DEFENSE_RADIUS = 11;
const GUARD_RADIUS = 5;
const STAGE_RADIUS = 6;
const COMBAT_KINDS: UnitKind[] = [
  "stinger", "flak-crawler", "mortar", "titan", "lancer", "wasp", "raptor", "hornet", "mender"
];

const mirror = (w: World, x: number, y: number) => ({ x: w.width - x, y: w.height - y });

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
 * player. Difficulty only changes its reaction speed and income.
 */
export function tickAi(w: World, faction: Faction, s: AiState): Command[] {
  const diff = DIFFICULTY[s.difficulty];
  w.factions[faction].incomeMult = diff.incomeMult;
  // calldown reflex: scatter from enemy reticles every tick, not just on decision passes
  const reflex = w.winner ? [] : dodgeCalldowns(w, faction, s);
  if (w.tick - s.lastDecisionTick < diff.interval * TICK_RATE || w.winner) return reflex;
  s.lastDecisionTick = w.tick;

  const cmds: Command[] = reflex;
  const hq = hqOf(w, faction);
  if (!hq) return cmds;
  const f = w.factions[faction];
  const mine = [...w.units.values()].filter((u) => u.faction === faction);
  const myBuildings = [...w.buildings.values()].filter((b) => b.faction === faction);
  const harvesters = mine.filter((u) => u.kind === "harvester");
  const army = mine.filter((u) => COMBAT_KINDS.includes(u.kind));
  const armyValue = value(army);
  const count = (k: UnitKind) => mine.filter((u) => u.kind === k).length;
  const queued = (k: UnitKind) =>
    myBuildings.reduce((n, b) => n + b.queue.filter((q) => q.kind === k).length, 0);
  const have = (k: UnitKind) => count(k) + queued(k);
  const has = (k: BuildingKind) => myBuildings.some((b) => b.kind === k);

  observeEnemy(w, faction, s);

  const hqC = buildingCenter(hq);
  const activeField = nearestScrapTile(w, hqC.x, hqC.y);
  /** Where the economy needs defending: the mined field, shaded toward home. */
  const guardPoint = activeField
    ? {
        x: activeField.x + 0.5 + Math.sign(hqC.x - activeField.x) * 1.5,
        y: activeField.y + 0.5 + Math.sign(hqC.y - activeField.y) * 1.5
      }
    : hqC;

  // --- construction: place a ready building, or start the next one -------
  const wanted = nextBuilding(w, faction, myBuildings, s);
  if (f.pending?.ready) {
    const kind = f.pending.kind;
    let spot: { tx: number; ty: number } | null = null;
    if (kind === "depot") {
      const site = depotSite(w, faction, hqC);
      spot = site ? site.spot : findPlacementSpot(w, faction, kind, guardPoint);
    } else {
      const anchor =
        kind === "turret" || kind === "sam-site" ? guardPoint : kind === "radar" ? towardEnemy(w, hqC, 4) : hqC;
      spot = findPlacementSpot(w, faction, kind, anchor);
    }
    if (spot) cmds.push({ type: "placeBuilding", faction, tx: spot.tx, ty: spot.ty });
    else cmds.push({ type: "cancelBuilding", faction }); // nowhere to put it
  } else if (!f.pending && wanted && f.scrap >= BUILDINGS[wanted].cost) {
    cmds.push({ type: "startBuilding", faction, building: wanted });
  }

  // --- economy: keep the harvester count mining ---------------------------
  const depots = myBuildings.filter((b) => b.kind === "depot").length;
  const wantHarvesters = Math.max(1, s.strategy.harvesters + diff.extraHarvesters + depots);
  if (harvesters.length < wantHarvesters && hq.queue.length === 0 && f.scrap >= UNITS.harvester.cost)
    cmds.push({ type: "produce", faction, buildingId: hq.id, unit: "harvester" });
  for (const h of harvesters)
    if (h.order.type === "idle") {
      const field = nearestReachableResource(w, h.x, h.y);
      if (field)
        cmds.push({ type: "harvest", faction, unitIds: [h.id], x: field.x + 0.5, y: field.y + 0.5 });
    }

  // --- production: adaptive counters to the enemy composition -------------
  // reserve scrap while an important building is still wanted
  const reserve =
    f.pending || wanted === null ? 0 : wanted === "turret" || wanted === "radar" ? 0 : Math.min(400, BUILDINGS[wanted].cost);
  let spendable = f.scrap - reserve;
  const produce = (b: Building, kind: UnitKind | null) => {
    if (!kind || unitBlocker(w, faction, kind) || spendable < UNITS[kind].cost) return;
    spendable -= UNITS[kind].cost;
    cmds.push({ type: "produce", faction, buildingId: b.id, unit: kind });
  };
  const tech = has("tech-lab");
  const enemyDefenses = knownBuildings(w, faction).filter(
    (kb) => kb.kind === "turret" || kb.kind === "sam-site"
  ).length;
  const ownAA = have("flak-crawler") + have("lancer") * 0.6 + have("raptor");

  // floating scrap? keep queues two deep
  const depth = f.scrap > 700 ? 2 : 1;
  for (const fab of myBuildings.filter((b) => b.kind === "fab-plant")) {
    if (fab.queue.length >= depth) continue;
    let kind: UnitKind = "stinger";
    const r = rand(s);
    if (s.strategy.airOnly) {
      // home guard only: a few stingers vs raiders, flak when the skies fill
      if (ownAA < Math.ceil(s.seenAir * 0.5)) kind = "flak-crawler";
      else if (have("stinger") >= 3) continue;
    } else if (ownAA < Math.ceil(s.seenAir * 0.6)) kind = tech && r < 0.35 ? "lancer" : "flak-crawler";
    else if (tech && have("mortar") < Math.min(3, 1 + enemyDefenses) && (enemyDefenses > 0 || r < 0.2))
      kind = "mortar";
    else if (tech && s.seenHeavy >= 2 && r < 0.6) kind = "lancer"; // lasers burn through armour
    else if (tech && (s.strategy.heavy ? r < 0.45 : r < 0.25)) kind = "titan";
    else if (tech && r < (s.strategy.heavy ? 0.8 : 0.5)) kind = "lancer";
    produce(fab, kind);
  }
  for (const pad of myBuildings.filter((b) => b.kind === "airpad")) {
    if (pad.queue.length >= depth) continue;
    const wantRaptors = Math.min(s.strategy.airOnly ? 7 : 4, Math.ceil(s.seenAir * 0.6));
    const armySize = army.length;
    let kind: UnitKind;
    if (have("scout") < 1 && w.tick - s.lastScoutTick > 60 * TICK_RATE) {
      kind = "scout";
      s.lastScoutTick = w.tick;
    }
    else if (have("raptor") < wantRaptors) kind = "raptor";
    else if (have("mender") < Math.min(3, Math.floor(armySize / 6))) kind = "mender";
    else if (tech && (s.strategy.airOnly ? rand(s) < 0.4 : rand(s) < 0.25 + s.seenHeavy * 0.08)) kind = "hornet";
    else if (s.strategy.heavy && s.seenHeavy < 2 && fabCount(myBuildings) > 0 && rand(s) < 0.5) continue; // save for tanks
    else kind = "wasp";
    produce(pad, kind);
  }

  // --- scouting -----------------------------------------------------------
  for (const scout of mine.filter((u) => u.kind === "scout"))
    if (scout.order.type === "idle") {
      const leg = scoutSweep(w, hq, s.scoutLeg++);
      cmds.push({ type: "move", faction, unitIds: [scout.id], x: leg.x, y: leg.y });
    }

  // --- expand production when scrap piles up despite full queues ---------
  const producers = myBuildings.filter((b) => b.kind === "fab-plant" || b.kind === "airpad");
  if (
    f.scrap > 1000 &&
    !f.pending &&
    wanted === null &&
    s.extraProduction < 3 &&
    producers.length > 0 &&
    producers.every((b) => b.queue.length > 0)
  )
    s.extraProduction++;

  // --- anti-air response: SAM sites when the skies fill up ---------------
  if (s.seenAir >= 4 && s.extraSams < 1) s.extraSams = 1;
  if (s.seenAir >= 8 && s.extraSams < 2) s.extraSams = 2;

  // --- mode transitions ----------------------------------------------------
  // the longer the match drags on (from 7:00, 6% a minute, down to half), the lower the bar for an all-in push
  const minutes = w.tick / TICK_RATE / 60;
  const lateGame = Math.max(0.5, 1 - Math.max(0, minutes - 7) * 0.06);
  const assaultAt = s.strategy.assaultValue * diff.assaultMult * lateGame;
  const raiders = mine.filter(
    (u) => (u.kind === "wasp" || (s.strategy.groundRaids && u.kind === "stinger")) && u.order.type === "idle"
  );
  if (
    s.mode === "buildup" && diff.harass && raiders.length >= s.strategy.harassGroup &&
    s.seenAA <= raiders.length / 2 && w.tick >= OPENING_GRACE
  )
    s.mode = "harass";
  if (armyValue >= assaultAt && s.mode !== "assault") {
    s.mode = "assault";
    s.waveValue = armyValue;
  }
  if (s.mode === "assault" && armyValue < Math.max(RETREAT_ARMY_VALUE, s.waveValue * 0.25)) s.mode = "buildup";

  // ======================= tactics =========================================
  const used = new Set<number>(dodgingUnits(w, s)); // units running from a reticle stay put
  const idleArmy = () => army.filter((u) => u.order.type === "idle" && !used.has(u.id));

  // --- 1. threat response: answer unengaged intruders with counters -------
  const threats = findThreats(w, faction, myBuildings, harvesters);
  threats.sort((a, b) => dist(a.x, a.y, hqC.x, hqC.y) - dist(b.x, b.y, hqC.x, hqC.y));
  for (const t of threats.slice(0, 3)) {
    const wantedValue = UNITS[t.kind].cost * 1.5;
    const capable = idleArmy()
      .filter((u) => canHitDomain(UNITS[u.kind].targets, t.domain))
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
  const atHome = threats.filter((t) => dist(t.x, t.y, hqC.x, hqC.y) <= DEFENSE_RADIUS);
  const raidValue = atHome.reduce((v, t) => v + UNITS[t.kind].cost, 0);
  const homeGuard = value(army.filter((u) => dist(u.x, u.y, hqC.x, hqC.y) <= DEFENSE_RADIUS));
  if (raidValue >= HOME_ALARM_VALUE && raidValue > homeGuard) {
    s.mode = "buildup";
    const enemyHome = mirror(w, hqC.x, hqC.y);
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
  // Uplink garrisons, capture squads and crate runners stay on task (ai/objectives.ts)
  for (const id of objectiveHolds(w, faction, s)) used.add(id);

  // --- 2. economy guard: a share of the army holds the mining line --------
  const guardShare = s.mode === "assault" ? 0.15 : 0.35;
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
  const enemyHomeGuess = knownBuildings(w, faction).find((b) => b.kind === "hq");
  cmds.push(
    ...planObjectives(w, faction, s, {
      mode: s.mode, hqC, guardPoint, guardNeed: guardShare * armyValue, army, used,
      threatened: raidValue >= HOME_ALARM_VALUE,
      enemyHqPos: enemyHomeGuess ? { x: enemyHomeGuess.tx + 1.5, y: enemyHomeGuess.ty + 1.5 } : mirror(w, hqC.x, hqC.y)
    })
  );

  // --- 3/4. offence by mode -----------------------------------------------
  const enemyHq = knownBuildings(w, faction).find((b) => b.kind === "hq");
  const enemyHqPos = enemyHq ? { x: enemyHq.tx + 1.5, y: enemyHq.ty + 1.5 } : mirror(w, hqC.x, hqC.y);

  if (s.mode === "harass") {
    const group = raiders.filter((u) => !used.has(u.id));
    const raid = enemyHarvestArea(w, faction, hqC);
    const flying = group.filter((u) => UNITS[u.kind].domain === "air").length;
    // raiders don't fly into flak (seen now, or remembered): they wait for
    // the main assault instead
    if (flying > group.length / 2 && (coveredByAA(w, faction, raid.x, raid.y) || s.seenAA > group.length / 2))
      s.mode = "buildup";
    else if (group.length >= s.strategy.harassGroup) {
      const ids = group.map((u) => u.id);
      ids.forEach((id) => used.add(id));
      if (raid.targetId !== undefined)
        cmds.push({ type: "attack", faction, unitIds: ids, targetId: raid.targetId });
      else cmds.push({ type: "attackMove", faction, unitIds: ids, x: raid.x, y: raid.y });
    }
  } else if (s.mode === "assault") {
    // staged waves: gather at a forward point, launch together
    const staging = towardEnemy(w, hqC, 9, enemyHqPos);
    const staged = army.filter(
      (u) => !used.has(u.id) && dist(u.x, u.y, staging.x, staging.y) <= STAGE_RADIUS
    );
    const stagedValue = value(staged);
    const launchAt = Math.max(450, assaultAt * WAVE_LAUNCH);

    if (stagedValue >= launchAt) {
      const target = pickPriorityTarget(w, faction, enemyHqPos);
      launchWave(cmds, faction, staged, target, used);
    } else {
      for (const u of idleArmy()) {
        if (dist(u.x, u.y, enemyHqPos.x, enemyHqPos.y) < 14) {
          // already deep in enemy territory: keep fighting, don't yo-yo home
          const target = pickPriorityTarget(w, faction, enemyHqPos);
          launchWave(cmds, faction, [u], target, used);
        } else if (dist(u.x, u.y, staging.x, staging.y) > STAGE_RADIUS) {
          used.add(u.id);
          cmds.push({ type: "attackMove", faction, unitIds: [u.id], x: staging.x, y: staging.y });
        }
      }
    }
  }

  // --- 4b. salvage: once a fight near home is over, sweep up the wrecks ----
  cmds.push(
    ...planSalvage(w, faction, {
      army, harvesters, buildings: myBuildings, used, threatened: raidValue >= HOME_ALARM_VALUE, assault: s.mode === "assault"
    })
  );

  // --- 4c. commander calldowns (ai/powers.ts) ------------------------------
  cmds.push(...planCalldowns(w, faction, s, { mode: s.mode, hqC, guardPoint, enemyHqPos, army, threats }));

  // --- 5. menders tag along with whoever needs them -------------------------
  for (const m of mine.filter((u) => u.kind === "mender" && u.order.type === "idle" && !used.has(u.id))) {
    const busy = army.filter((u) => u.kind !== "mender" && u.order.type !== "idle");
    if (busy.length === 0) continue;
    busy.sort((a, b) => dist(a.x, a.y, m.x, m.y) - dist(b.x, b.y, m.x, m.y));
    const buddy = busy[0]!;
    cmds.push({ type: "attackMove", faction, unitIds: [m.id], x: buddy.x, y: buddy.y });
  }

  return cmds;
}

const fabCount = (bs: Building[]) => bs.filter((b) => b.kind === "fab-plant").length;

/** Can we see enemy anti-air (flak, lancers, turrets, SAMs) covering this spot? */
function coveredByAA(w: World, faction: Faction, x: number, y: number): boolean {
  for (const u of w.units.values()) {
    if (u.faction === faction || !canHitDomain(UNITS[u.kind].targets, "air")) continue;
    if (!isVisible(w, faction, Math.floor(u.x), Math.floor(u.y))) continue;
    if (dist(u.x, u.y, x, y) < UNITS[u.kind].range + 3) return true;
  }
  for (const kb of knownBuildings(w, faction)) {
    const st = BUILDINGS[kb.kind];
    if (!canHitDomain(st.targets, "air") || kb.kind === "hq") continue;
    if (dist(kb.tx + st.size / 2, kb.ty + st.size / 2, x, y) < st.range + 2) return true;
  }
  return false;
}

/** A point `d` tiles from `from` toward the enemy HQ (or the map mirror). */
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
}

/** Harvesters first, then production buildings, then defences, then the HQ. */
function pickPriorityTarget(w: World, faction: Faction, fallback: { x: number; y: number }): PriorityTarget {
  let best: PriorityTarget | null = null;
  let bestD = Infinity;
  for (const u of w.units.values()) {
    if (u.faction === faction || u.kind !== "harvester") continue;
    if (!isVisible(w, faction, Math.floor(u.x), Math.floor(u.y))) continue;
    const d = dist(u.x, u.y, fallback.x, fallback.y);
    if (d < bestD) {
      bestD = d;
      best = { id: u.id, x: u.x, y: u.y, domain: "ground" };
    }
  }
  if (best) return best;
  const known = knownBuildings(w, faction);
  for (const kinds of [["fab-plant", "airpad", "tech-lab", "depot"], ["turret", "sam-site", "radar"], ["hq"]] as const) {
    const cands = known.filter((kb) => (kinds as readonly string[]).includes(kb.kind));
    cands.sort((a, b) => dist(a.tx, a.ty, fallback.x, fallback.y) - dist(b.tx, b.ty, fallback.x, fallback.y));
    const b = cands[0];
    if (b) {
      const size = BUILDINGS[b.kind].size;
      return { id: b.id, x: b.tx + size / 2, y: b.ty + size / 2, domain: "ground" };
    }
  }
  return { x: fallback.x, y: fallback.y, domain: "ground" };
}

/** Send a wave at a target: attackers attack it, the rest escort. */
function launchWave(
  cmds: Command[],
  faction: Faction,
  units: Unit[],
  target: PriorityTarget,
  used: Set<number>
): void {
  const attackers: number[] = [];
  const escorts: number[] = [];
  for (const u of units) {
    used.add(u.id);
    if (target.id !== undefined && canHitDomain(UNITS[u.kind].targets, target.domain))
      attackers.push(u.id);
    else escorts.push(u.id);
  }
  if (attackers.length > 0 && target.id !== undefined)
    cmds.push({ type: "attack", faction, unitIds: attackers, targetId: target.id });
  if (escorts.length > 0)
    cmds.push({ type: "attackMove", faction, unitIds: escorts, x: target.x, y: target.y });
}

interface Threat {
  id: number;
  x: number;
  y: number;
  kind: UnitKind;
  domain: Domain;
}

/** Visible armed enemy units close to our buildings or harvesters. */
function findThreats(
  w: World,
  faction: Faction,
  myBuildings: Building[],
  harvesters: Unit[]
): Threat[] {
  const out: Threat[] = [];
  for (const u of w.units.values()) {
    if (u.faction === faction || UNITS[u.kind].dps <= 0) continue;
    if (!isVisible(w, faction, Math.floor(u.x), Math.floor(u.y))) continue;
    const nearBuilding = myBuildings.some((b) => {
      const c = buildingCenter(b);
      return dist(u.x, u.y, c.x, c.y) <= DEFENSE_RADIUS;
    });
    const nearHarvester = harvesters.some((h) => dist(u.x, u.y, h.x, h.y) <= 6);
    const nearUplink = w.objectives.uplinks.some(
      (l) => l.owner === faction && dist(u.x, u.y, l.x, l.y) <= OBJECTIVES.uplink.radius + 2
    );
    if (nearBuilding || nearHarvester || nearUplink)
      out.push({ id: u.id, x: u.x, y: u.y, kind: u.kind, domain: UNITS[u.kind].domain });
  }
  return out;
}

/** Count enemy units currently visible to us, split by domain. */
function observeEnemy(w: World, faction: Faction, s: AiState): void {
  let air = 0;
  let ground = 0;
  let heavy = 0;
  let aa = 0;
  for (const u of w.units.values()) {
    if (u.faction === faction || u.kind === "harvester") continue;
    if (!isVisible(w, faction, Math.floor(u.x), Math.floor(u.y))) continue;
    if (UNITS[u.kind].domain === "air") air += u.kind === "hornet" ? 2 : u.kind === "scout" ? 0.3 : 1;
    else ground++;
    if (UNITS[u.kind].armor === "heavy") heavy++;
    if (canHitDomain(UNITS[u.kind].targets, "air")) aa++;
  }
  // ratchet up quickly, decay slowly (~1 min half-life at 2s decisions) —
  // a glimpse of a wasp pack should keep informing production for a while
  s.seenAir = Math.max(air, s.seenAir * 0.97);
  s.seenGround = Math.max(ground, s.seenGround * 0.97);
  s.seenHeavy = Math.max(heavy, s.seenHeavy * 0.97);
  s.seenAA = Math.max(aa, s.seenAA * 0.97);
}

/** First entry of the build order (plus reactive SAMs) not yet satisfied. */
function nextBuilding(w: World, faction: Faction, myBuildings: Building[], s: AiState): BuildingKind | null {
  const have = new Map<BuildingKind, number>();
  for (const b of myBuildings) have.set(b.kind, (have.get(b.kind) ?? 0) + 1);
  const order = [...s.strategy.buildOrder];
  for (let i = 0; i < s.extraSams; i++) order.splice(Math.min(order.length, 2 + i), 0, "sam-site");
  const fabs = order.filter((k) => k === "fab-plant").length;
  const pads = order.filter((k) => k === "airpad").length;
  for (let i = 0; i < s.extraProduction; i++) {
    const air = s.strategy.airOnly || (!s.strategy.heavy && pads + (i % 2) <= fabs);
    order.push(air ? "airpad" : "fab-plant");
  }
  const wanted = new Map<BuildingKind, number>();
  let depotsSkipped = 0;
  for (const kind of order) {
    wanted.set(kind, (wanted.get(kind) ?? 0) + 1);
    if ((have.get(kind) ?? 0) >= wanted.get(kind)!) continue;
    if (kind === "depot" && depotsSkipped < 3) {
      // only worth it if there's a distant field we can actually reach
      const hq = hqOf(w, faction);
      if (!hq || !depotSite(w, faction, buildingCenter(hq))) {
        depotsSkipped++;
        continue;
      }
    }
    if (buildingBlocker(w, faction, kind)) continue;
    return kind;
  }
  return null;
}

/** A spot for a forward depot next to a field far from existing drop-offs. */
function depotSite(
  w: World,
  faction: Faction,
  hqC: { x: number; y: number }
): { spot: { tx: number; ty: number } } | null {
  let best: { x: number; y: number; d: number } | null = null;
  for (let ty = 0; ty < w.height; ty++)
    for (let tx = 0; tx < w.width; tx++) {
      if (!isResource(w, tileIndex(w, tx, ty))) continue;
      const drop = nearestDropOff(w, faction, tx + 0.5, ty + 0.5);
      if (!drop) continue;
      const dc = buildingCenter(drop);
      if (dist(tx + 0.5, ty + 0.5, dc.x, dc.y) < 9) continue; // already served
      const d = dist(tx + 0.5, ty + 0.5, hqC.x, hqC.y);
      if (!best || d < best.d) best = { x: tx + 0.5, y: ty + 0.5, d };
    }
  if (!best || best.d > 24) return null;
  const spot = findPlacementSpot(w, faction, "depot", best);
  if (!spot || dist(spot.tx + 1, spot.ty + 1, best.x, best.y) > 5) return null;
  if (!findPath(w, hqC.x, hqC.y + 2.5, best.x, best.y)) return null;
  return { spot };
}

/** Closest placeable spot to `anchor` within build range of our base. */
function findPlacementSpot(
  w: World,
  faction: Faction,
  kind: BuildingKind,
  anchor: { x: number; y: number }
): { tx: number; ty: number } | null {
  const size = BUILDINGS[kind].size;
  let best: { tx: number; ty: number } | null = null;
  let bestD = Infinity;
  for (const b of w.buildings.values()) {
    if (b.faction !== faction) continue;
    const c = buildingCenter(b);
    const r = ECONOMY.buildRadius + 2;
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const tx = Math.round(c.x + dx - size / 2);
        const ty = Math.round(c.y + dy - size / 2);
        const d = dist(tx + size / 2, ty + size / 2, anchor.x, anchor.y);
        if (d >= bestD) continue;
        if (!canPlaceBuilding(w, faction, kind, tx, ty)) continue;
        // keep a lane open: don't wall the HQ in with production buildings
        if (size > 1 && tooCramped(w, tx, ty, size)) continue;
        best = { tx, ty };
        bestD = d;
      }
  }
  return best;
}

/** Would a building here leave no free tile along any side (walling in)? */
function tooCramped(w: World, tx: number, ty: number, size: number): boolean {
  let free = 0;
  for (let i = -1; i <= size; i++)
    for (const [x, y] of [
      [tx + i, ty - 1],
      [tx + i, ty + size],
      [tx - 1, ty + i],
      [tx + size, ty + i]
    ] as [number, number][]) {
      if (x < 0 || y < 0 || x >= w.width || y >= w.height) continue;
      if (w.occupancy[y * w.width + x] === 0) free++;
    }
  return free < (size + 2) * 2;
}

/** Corner-sweep waypoints for scouts, biased toward the far half. */
function scoutSweep(w: World, hq: Building, leg: number): { x: number; y: number } {
  const c = buildingCenter(hq);
  const far = mirror(w, c.x, c.y);
  const stops = [
    far,
    { x: far.x, y: c.y },
    { x: c.x, y: far.y },
    { x: w.width / 2, y: w.height / 2 }
  ];
  return stops[leg % stops.length]!;
}

/** Where the enemy probably mines: their side's scrap, or mirror of ours. */
function enemyHarvestArea(
  w: World,
  faction: Faction,
  hqC: { x: number; y: number }
): { x: number; y: number; targetId?: number } {
  // a visible enemy harvester is the best target
  for (const u of w.units.values())
    if (
      u.faction !== faction &&
      u.kind === "harvester" &&
      isVisible(w, faction, Math.floor(u.x), Math.floor(u.y))
    )
      return { x: u.x, y: u.y, targetId: u.id };
  const own = nearestScrapTile(w, hqC.x, hqC.y);
  if (own) return mirror(w, own.x + 0.5, own.y + 0.5);
  return mirror(w, hqC.x, hqC.y);
}

export type { Unit };
