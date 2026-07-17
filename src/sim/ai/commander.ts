import { BUILDINGS, ECONOMY, TICK_RATE, UNITS } from "../balance";
import { canPlaceBuilding, nearestScrapTile } from "../economy";
import { isVisible, knownBuildings } from "../fog";
import {
  Terrain,
  type Building,
  type BuildingKind,
  type Command,
  type Faction,
  type Unit,
  type UnitKind,
  type World
} from "../types";
import { buildingCenter, hqOf, terrainAt } from "../world";

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
}

export type StrategyName = "balanced" | "rush" | "airswarm" | "boom";

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
const COMBAT_KINDS: UnitKind[] = ["stinger", "flak-crawler", "wasp", "raptor"];

const mirror = (w: World, x: number, y: number) => ({ x: w.width - x, y: w.height - y });

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

  // --- construction: place a ready building, or start the next one -------
  if (f.pending?.ready) {
    const spot = findPlacementSpot(w, faction, f.pending.kind, hq);
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

  // --- production ---------------------------------------------------------
  const fab = get("fab-plant");
  const pad = get("airpad");
  // reserve scrap while a production building (fab/airpad) is still needed —
  // turrets are cheap and shouldn't starve unit production
  const nextWanted = nextBuilding(myBuildings, s.strategy);
  const reserve =
    f.pending || nextWanted === null || nextWanted === "turret" ? 0 : 300;
  const spendable = f.scrap - reserve;
  if (fab && fab.queue.length === 0) {
    const wantFlak = count("flak-crawler") < Math.ceil(s.seenAir / 1.5);
    const kind: UnitKind = wantFlak ? "flak-crawler" : "stinger";
    if (spendable >= UNITS[kind].cost)
      cmds.push({ type: "produce", faction, buildingId: fab.id, unit: kind });
  }
  if (pad && pad.queue.length === 0) {
    let kind: UnitKind | null = null;
    if (count("scout") < 1) kind = "scout";
    else if (s.seenAir > count("raptor") * 2 && count("raptor") < 3) kind = "raptor";
    else kind = "wasp";
    if (kind && spendable >= UNITS[kind].cost)
      cmds.push({ type: "produce", faction, buildingId: pad.id, unit: kind });
  }

  // --- scouting -----------------------------------------------------------
  for (const scout of mine.filter((u) => u.kind === "scout"))
    if (scout.order.type === "idle") {
      const leg = scoutSweep(w, faction, hq, s.scoutLeg++);
      cmds.push({ type: "move", faction, unitIds: [scout.id], x: leg.x, y: leg.y });
    }

  // --- mode transitions ----------------------------------------------------
  if (s.mode === "buildup" && has("airpad") && count("wasp") >= s.strategy.harassGroup)
    s.mode = "harass";
  if (armyValue >= s.strategy.assaultValue) s.mode = "assault";
  if (s.mode === "assault" && armyValue < RETREAT_ARMY_VALUE) s.mode = "buildup";

  // --- combat behaviour by mode -------------------------------------------
  const enemyHq = knownBuildings(w, faction).find((b) => b.kind === "hq");
  const enemyHqPos = enemyHq
    ? { x: enemyHq.tx + 1.5, y: enemyHq.ty + 1.5 }
    : mirror(w, ...(({ x, y }) => [x, y] as const)(buildingCenter(hq)));

  if (s.mode === "harass") {
    const wasps = mine.filter((u) => u.kind === "wasp" && u.order.type === "idle");
    if (wasps.length >= s.strategy.harassGroup) {
      const raidTarget = enemyHarvestArea(w, faction, hq);
      cmds.push({
        type: "attackMove", faction,
        unitIds: wasps.map((u) => u.id),
        x: raidTarget.x, y: raidTarget.y
      });
    }
  } else if (s.mode === "assault") {
    const idleArmy = army.filter((u) => u.order.type === "idle");
    if (idleArmy.length > 0)
      cmds.push({
        type: "attackMove", faction,
        unitIds: idleArmy.map((u) => u.id),
        x: enemyHqPos.x, y: enemyHqPos.y
      });
  }

  return cmds;
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
  // ratchet up quickly, decay slowly — a glimpse of a wasp pack should stick
  s.seenAir = Math.max(air, s.seenAir * 0.9);
  s.seenGround = Math.max(ground, s.seenGround * 0.9);
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

function findPlacementSpot(
  w: World,
  faction: Faction,
  kind: BuildingKind,
  hq: Building
): { tx: number; ty: number } | null {
  const c = buildingCenter(hq);
  const size = BUILDINGS[kind].size;
  for (let r = 2; r <= ECONOMY.buildRadius + 2; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const tx = Math.round(c.x + dx - size / 2);
        const ty = Math.round(c.y + dy - size / 2);
        if (canPlaceBuilding(w, faction, kind, tx, ty)) return { tx, ty };
      }
  return null;
}

/** Corner-sweep waypoints for scouts, biased toward the far half. */
function scoutSweep(w: World, _faction: Faction, hq: Building, leg: number): { x: number; y: number } {
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
function enemyHarvestArea(w: World, faction: Faction, hq: Building): { x: number; y: number } {
  // a visible enemy harvester is the best target
  for (const u of w.units.values())
    if (
      u.faction !== faction &&
      u.kind === "harvester" &&
      isVisible(w, faction, Math.floor(u.x), Math.floor(u.y))
    )
      return { x: u.x, y: u.y };
  const c = buildingCenter(hq);
  const own = nearestScrapTile(w, c.x, c.y);
  if (own) {
    const m = mirror(w, own.x + 0.5, own.y + 0.5);
    if (terrainAt(w, Math.floor(m.x), Math.floor(m.y)) !== Terrain.Rock) return m;
  }
  return mirror(w, c.x, c.y);
}

export type { Unit };
