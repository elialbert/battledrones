import { BUILDINGS, ECONOMY, TICK_RATE, UNITS } from "../balance";
import { canPlaceBuilding, nearestScrapTile } from "../economy";
import { isVisible, knownBuildings } from "../fog";
import {
  Terrain,
  type Building,
  type BuildingKind,
  type Command,
  type Domain,
  type Faction,
  type TargetDomain,
  type Unit,
  type UnitKind,
  type World
} from "../types";
import { buildingCenter, dist, hqOf, terrainAt } from "../world";

export type AiMode = "buildup" | "harass" | "assault";

/** A commander personality: opening, economy size, and aggression timing. */
export interface Strategy {
  name: StrategyName;
  /** Buildings wanted, in order (duplicates = build that many). */
  buildOrder: BuildingKind[];
  harvesters: number;
  /** Army value (scrap cost) that triggers the all-in assault. */
  assaultValue: number;
  /** Idle wasps required before a harass raid launches. */
  harassGroup: number;
  /** Never build ground combat units; answer enemy air with raptors. */
  airOnly?: boolean;
}

export type StrategyName = "balanced" | "rush" | "airswarm" | "boom" | "skyforce";

export const STRATEGIES: Record<StrategyName, Strategy> = {
  /** Steady macro: factory then airpad, standard timing. */
  balanced: {
    name: "balanced",
    buildOrder: ["fab-plant", "airpad", "turret", "turret"],
    harvesters: 2,
    assaultValue: 1100,
    harassGroup: 2
  },
  /** Early ground pressure: attacks at half the usual army size. */
  rush: {
    name: "rush",
    buildOrder: ["fab-plant", "turret", "airpad"],
    harvesters: 2,
    assaultValue: 650,
    harassGroup: 3
  },
  /** Airpad first: relentless wasp raids, weak if flak shows up early. */
  airswarm: {
    name: "airswarm",
    buildOrder: ["airpad", "fab-plant", "turret"],
    harvesters: 2,
    assaultValue: 1000,
    harassGroup: 2
  },
  /** Greedy economy: extra harvester and turtling, then a huge late push. */
  boom: {
    name: "boom",
    buildOrder: ["fab-plant", "turret", "airpad", "turret"],
    harvesters: 3,
    assaultValue: 1600,
    harassGroup: 3
  },
  /** Pure air force: no Fab Plant, no ground combat units at all — wasps
   * and raptors backed by turrets for base defence. */
  skyforce: {
    name: "skyforce",
    buildOrder: ["airpad", "turret", "turret", "turret"],
    harvesters: 2,
    assaultValue: 1200,
    harassGroup: 2,
    airOnly: true
  }
};

export interface AiState {
  mode: AiMode;
  strategy: Strategy;
  lastDecisionTick: number;
  /** Rolling estimate of enemy force composition, from what we've seen. */
  seenAir: number;
  seenGround: number;
  scoutLeg: number;
}

/** Pass a strategy for deterministic behaviour (tests); omit for random. */
export function createAiState(strategy?: StrategyName): AiState {
  const names = Object.keys(STRATEGIES) as StrategyName[];
  const picked = strategy ?? names[Math.floor(Math.random() * names.length)]!;
  return {
    mode: "buildup",
    strategy: STRATEGIES[picked],
    lastDecisionTick: -1000,
    seenAir: 0,
    seenGround: 0,
    scoutLeg: 0
  };
}

const DECISION_INTERVAL = 2 * TICK_RATE;
const RETREAT_ARMY_VALUE = 300;
/** Visible armed enemies this close to our buildings/harvesters are threats. */
const DEFENSE_RADIUS = 11;
const GUARD_RADIUS = 5;
const STAGE_RADIUS = 6;
const COMBAT_KINDS: UnitKind[] = ["stinger", "flak-crawler", "wasp", "raptor"];

const mirror = (w: World, x: number, y: number) => ({ x: w.width - x, y: w.height - y });

const canHitDomain = (targets: TargetDomain, domain: Domain): boolean =>
  targets === "both" || targets === domain;

/**
 * The enemy commander. Runs a decision pass every 2 seconds and returns
 * ordinary commands — it plays by the same rules (and fog) as the player.
 */
export function tickAi(w: World, faction: Faction, s: AiState): Command[] {
  if (w.tick - s.lastDecisionTick < DECISION_INTERVAL || w.winner) return [];
  s.lastDecisionTick = w.tick;

  const cmds: Command[] = [];
  const hq = hqOf(w, faction);
  if (!hq) return cmds;
  const f = w.factions[faction];
  const mine = [...w.units.values()].filter((u) => u.faction === faction);
  const myBuildings = [...w.buildings.values()].filter((b) => b.faction === faction);
  const harvesters = mine.filter((u) => u.kind === "harvester");
  const army = mine.filter((u) => COMBAT_KINDS.includes(u.kind));
  const armyValue = army.reduce((v, u) => v + UNITS[u.kind].cost, 0);
  const count = (k: UnitKind) => mine.filter((u) => u.kind === k).length;
  const has = (k: BuildingKind) => myBuildings.some((b) => b.kind === k);
  const get = (k: BuildingKind) => myBuildings.find((b) => b.kind === k);

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
  if (f.pending?.ready) {
    const anchor = f.pending.kind === "turret" ? guardPoint : hqC;
    const spot = findPlacementSpot(w, faction, f.pending.kind, anchor);
    if (spot) cmds.push({ type: "placeBuilding", faction, tx: spot.tx, ty: spot.ty });
  } else if (!f.pending) {
    const next = nextBuilding(myBuildings, s.strategy);
    if (next && f.scrap >= BUILDINGS[next].cost)
      cmds.push({ type: "startBuilding", faction, building: next });
  }

  // --- economy: keep the strategy's harvester count mining ----------------
  if (
    harvesters.length < s.strategy.harvesters &&
    hq.queue.length === 0 &&
    f.scrap >= UNITS.harvester.cost
  )
    cmds.push({ type: "produce", faction, buildingId: hq.id, unit: "harvester" });
  for (const h of harvesters)
    if (h.order.type === "idle") {
      const field = nearestScrapTile(w, h.x, h.y);
      if (field)
        cmds.push({ type: "harvest", faction, unitIds: [h.id], x: field.x + 0.5, y: field.y + 0.5 });
    }

  // --- production: adaptive counters to the enemy composition -------------
  const fab = get("fab-plant");
  const pad = get("airpad");
  // reserve scrap while a production building (fab/airpad) is still needed —
  // turrets are cheap and shouldn't starve unit production
  const nextWanted = nextBuilding(myBuildings, s.strategy);
  const reserve =
    f.pending || nextWanted === null || nextWanted === "turret" ? 0 : 300;
  const spendable = f.scrap - reserve;
  if (fab && !s.strategy.airOnly && fab.queue.length === 0) {
    const wantFlak = count("flak-crawler") < Math.ceil(s.seenAir * 0.8);
    const kind: UnitKind = wantFlak ? "flak-crawler" : "stinger";
    if (spendable >= UNITS[kind].cost)
      cmds.push({ type: "produce", faction, buildingId: fab.id, unit: kind });
  }
  if (pad && pad.queue.length === 0) {
    // air-only strategies can't lean on flak, so they field more raptors
    const raptorCap = s.strategy.airOnly ? 6 : 4;
    const wantRaptors = Math.min(raptorCap, Math.ceil(s.seenAir * 0.6));
    let kind: UnitKind | null = null;
    if (count("scout") < 1) kind = "scout";
    else if (count("raptor") < wantRaptors) kind = "raptor";
    else kind = "wasp";
    if (kind && spendable >= UNITS[kind].cost)
      cmds.push({ type: "produce", faction, buildingId: pad.id, unit: kind });
  }

  // --- scouting -----------------------------------------------------------
  for (const scout of mine.filter((u) => u.kind === "scout"))
    if (scout.order.type === "idle") {
      const leg = scoutSweep(w, hq, s.scoutLeg++);
      cmds.push({ type: "move", faction, unitIds: [scout.id], x: leg.x, y: leg.y });
    }

  // --- mode transitions ----------------------------------------------------
  if (s.mode === "buildup" && has("airpad") && count("wasp") >= s.strategy.harassGroup)
    s.mode = "harass";
  if (armyValue >= s.strategy.assaultValue) s.mode = "assault";
  if (s.mode === "assault" && armyValue < RETREAT_ARMY_VALUE) s.mode = "buildup";

  // ======================= tactics =========================================
  const used = new Set<number>();
  const idleArmy = () =>
    army.filter((u) => u.order.type === "idle" && !used.has(u.id));

  // --- 1. threat response: answer unengaged intruders with counters -------
  const threats = findThreats(w, faction, myBuildings, harvesters);
  threats.sort(
    (a, b) => dist(a.x, a.y, hqC.x, hqC.y) - dist(b.x, b.y, hqC.x, hqC.y)
  );
  for (const t of threats.slice(0, 2)) {
    const wanted = UNITS[t.kind].cost * 1.5;
    const capable = idleArmy()
      .filter((u) => canHitDomain(UNITS[u.kind].targets, t.domain))
      .sort((a, b) => dist(a.x, a.y, t.x, t.y) - dist(b.x, b.y, t.x, t.y));
    const squad: number[] = [];
    let v = 0;
    for (const u of capable) {
      if (v >= wanted) break;
      squad.push(u.id);
      used.add(u.id);
      v += UNITS[u.kind].cost;
    }
    if (squad.length > 0)
      cmds.push({ type: "attack", faction, unitIds: squad, targetId: t.id });
  }

  // --- 2. economy guard: a share of the army holds the mining line --------
  const guardShare = s.mode === "assault" ? 0.15 : 0.35;
  const guardValue = army
    .filter((u) => dist(u.x, u.y, guardPoint.x, guardPoint.y) <= GUARD_RADIUS)
    .reduce((v, u) => v + UNITS[u.kind].cost, 0);
  if (guardValue < guardShare * armyValue) {
    let need = guardShare * armyValue - guardValue;
    const recruits = idleArmy()
      .filter((u) => dist(u.x, u.y, guardPoint.x, guardPoint.y) > GUARD_RADIUS)
      .sort(
        (a, b) =>
          dist(a.x, a.y, guardPoint.x, guardPoint.y) -
          dist(b.x, b.y, guardPoint.x, guardPoint.y)
      );
    const squad: number[] = [];
    for (const u of recruits) {
      if (need <= 0) break;
      squad.push(u.id);
      used.add(u.id);
      need -= UNITS[u.kind].cost;
    }
    if (squad.length > 0)
      cmds.push({
        type: "attackMove", faction, unitIds: squad,
        x: guardPoint.x, y: guardPoint.y
      });
  }

  // --- 3/4. offence by mode -----------------------------------------------
  const enemyHq = knownBuildings(w, faction).find((b) => b.kind === "hq");
  const enemyHqPos = enemyHq
    ? { x: enemyHq.tx + 1.5, y: enemyHq.ty + 1.5 }
    : mirror(w, hqC.x, hqC.y);

  if (s.mode === "harass") {
    const wasps = mine.filter(
      (u) => u.kind === "wasp" && u.order.type === "idle" && !used.has(u.id)
    );
    if (wasps.length >= s.strategy.harassGroup) {
      const raid = enemyHarvestArea(w, faction, hqC);
      const ids = wasps.map((u) => u.id);
      ids.forEach((id) => used.add(id));
      if (raid.targetId !== undefined)
        cmds.push({ type: "attack", faction, unitIds: ids, targetId: raid.targetId });
      else
        cmds.push({ type: "attackMove", faction, unitIds: ids, x: raid.x, y: raid.y });
    }
  } else if (s.mode === "assault") {
    // staged waves: gather at a forward point, launch together
    const d = dist(hqC.x, hqC.y, enemyHqPos.x, enemyHqPos.y);
    const staging = {
      x: hqC.x + ((enemyHqPos.x - hqC.x) / d) * 9,
      y: hqC.y + ((enemyHqPos.y - hqC.y) / d) * 9
    };
    const staged = army.filter(
      (u) => !used.has(u.id) && dist(u.x, u.y, staging.x, staging.y) <= STAGE_RADIUS
    );
    const stagedValue = staged.reduce((v, u) => v + UNITS[u.kind].cost, 0);
    const launchAt = Math.max(400, s.strategy.assaultValue * 0.6);

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
          cmds.push({
            type: "attackMove", faction, unitIds: [u.id],
            x: staging.x, y: staging.y
          });
        }
      }
    }
  }

  return cmds;
}

interface PriorityTarget {
  id?: number;
  x: number;
  y: number;
  domain: Domain;
}

/** Harvesters first, then production buildings, then the HQ. */
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
  for (const kinds of [["fab-plant", "airpad"], ["turret"], ["hq"]] as const) {
    const b = known.find((kb) => (kinds as readonly string[]).includes(kb.kind));
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
    if (nearBuilding || nearHarvester)
      out.push({ id: u.id, x: u.x, y: u.y, kind: u.kind, domain: UNITS[u.kind].domain });
  }
  return out;
}

/** Count enemy units currently visible to us, split by domain. */
function observeEnemy(w: World, faction: Faction, s: AiState): void {
  let air = 0;
  let ground = 0;
  for (const u of w.units.values()) {
    if (u.faction === faction) continue;
    if (!isVisible(w, faction, Math.floor(u.x), Math.floor(u.y))) continue;
    if (UNITS[u.kind].domain === "air") air++;
    else ground++;
  }
  // ratchet up quickly, decay slowly (~1 min half-life at 2s decisions) —
  // a glimpse of a wasp pack should keep informing production for a while
  s.seenAir = Math.max(air, s.seenAir * 0.97);
  s.seenGround = Math.max(ground, s.seenGround * 0.97);
}

/** First entry of the strategy's build order not yet satisfied. */
function nextBuilding(myBuildings: Building[], strategy: Strategy): BuildingKind | null {
  const have = new Map<BuildingKind, number>();
  for (const b of myBuildings) have.set(b.kind, (have.get(b.kind) ?? 0) + 1);
  const wanted = new Map<BuildingKind, number>();
  for (const kind of strategy.buildOrder) {
    wanted.set(kind, (wanted.get(kind) ?? 0) + 1);
    if ((have.get(kind) ?? 0) < wanted.get(kind)!) return kind;
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
        if (canPlaceBuilding(w, faction, kind, tx, ty)) {
          best = { tx, ty };
          bestD = d;
        }
      }
  }
  return best;
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
  if (own) {
    const m = mirror(w, own.x + 0.5, own.y + 0.5);
    if (terrainAt(w, Math.floor(m.x), Math.floor(m.y)) !== Terrain.Rock) return m;
  }
  return mirror(w, hqC.x, hqC.y);
}

export type { Unit };
