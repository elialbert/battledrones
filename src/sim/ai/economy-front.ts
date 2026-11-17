import { BUILDINGS, ECONOMY, TICK_RATE, UNITS } from "../balance";
import { knownBuildings } from "../fog";
import { findPath } from "../movement";
import { isMulti } from "../sides";
import { Terrain, type Command, type Faction, type Unit, type UnitKind, type World } from "../types";
import { buildingCenter, dist, hqOf, moveClassOf, passable, regionAt, sideFrame } from "../world";
import { DRY_FIELD, expansionSiteForField, expansionSites, perTick, SERVED } from "./expansion";
import { effectivenessVs } from "./intel";
import { miningRoute, type MiningAccess } from "./fields";

const COMMIT = 20 * TICK_RATE;
const REVIEW = 10 * TICK_RATE;
const MEMORY = 15 * TICK_RATE;
const ARRIVE = 4;
type Point = { x: number; y: number };

export interface EconomyField {
  id: number;
  tiles: number[];
  live: number[];
  raw: number;
  scrap: number;
}
export interface EconomySite {
  fieldId: number;
  entry: Point;
  depotId?: number;
  construction?: { tx: number; ty: number };
  raw: number;
  scrap: number;
  miners: number;
  productive: number;
  waiting: number;
  route: Point[];
  safe: boolean;
  threat: number;
  lastSeen: number | null;
  confidence: "observed" | "remembered" | "unknown";
  readySeconds: number;
  deploymentCost: number;
  runwaySeconds: number;
  score: number;
  reason: string;
  viable: boolean;
}
export interface EconomyFrontPlan {
  fieldId: number;
  depotId?: number;
  phase: "assemble" | "secure" | "hold" | "recover";
  assigned: number[];
  since: number;
  phaseSince: number;
  progressTick?: number;
  distanceLeft?: number;
  approach: Point;
  hold: Point;
  retreat: Point;
  advance?: Point;
  required: number;
  assignedValue: number;
  availableValue: number;
  orderedValue: number;
  arrivedValue: number;
  reason: string;
}
interface Observation { kind: UnitKind; x: number; y: number; hp: number; tick: number }
export interface EconomyFrontState {
  status: "idle" | "assigned" | "recover";
  plan?: EconomyFrontPlan;
  sites: EconomySite[];
  samples: Map<number, { tick: number; raw: number }[]>;
  observations: Map<number, Observation>;
  urgent: boolean;
  runwaySeconds: number;
  reason: string;
  nextReview: number;
  scout?: { id: number; issued: number; departed?: number; origin: Point; reason: string };
}
export interface EconomyOwner {
  secureEconomy?: boolean;
  difficulty: string;
  economyFront?: EconomyFrontState;
}

/** Explicit rollout boundary. Reachable ordinary ground fields on mesa maps still work. */
export function economyEligible(w: World, faction: Faction, s: EconomyOwner): boolean {
  return !!s.secureEconomy && (s.difficulty === "hard" || s.difficulty === "brutal") &&
    !!hqOf(w, faction) && !w.survival && !w.ops && !isMulti(w) && !w.rules?.islands &&
    !w.rules?.nomads && !w.rules?.armada && !(w.rules?.mutators.length);
}

/** Stable terrain identity, including depleted tiles, with the commander's two-tile gaps.
 * Live mining entries deliberately retain fields.ts's separate adjacent-live semantics. */
export function economyFields(w: World, faction: Faction): EconomyField[] {
  const groups = perTick(w, `economy terrain ${faction}`, () => {
    let cached = terrainFields.get(w)?.get(faction);
    if (cached) return cached;
    const visited = new Uint8Array(w.terrain.length);
    cached = [];
    const fr = sideFrame(w, faction);
    const resource = (i: number) => w.terrain[i] === Terrain.Scrap || w.terrain[i] === Terrain.Crystal;
    for (let fy = 0; fy < w.height; fy++) for (let fx = 0; fx < w.width; fx++) {
      const [x, y] = fr.tile(fx, fy, 1);
      const start = y * w.width + x;
      if (visited[start] || !resource(start)) continue;
      const tiles = [start];
      visited[start] = 1;
      for (let n = 0; n < tiles.length; n++) {
        const k = tiles[n]!;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const nx = k % w.width + dx, ny = Math.floor(k / w.width) + dy;
          if (nx < 0 || ny < 0 || nx >= w.width || ny >= w.height) continue;
          const i = ny * w.width + nx;
          if (!visited[i] && resource(i)) { visited[i] = 1; tiles.push(i); }
        }
      }
      cached.push({ id: fy * w.width + fx, tiles });
    }
    let map = terrainFields.get(w);
    if (!map) terrainFields.set(w, map = new Map());
    map.set(faction, cached);
    return cached;
  });
  return groups.map(g => ({ ...g, live: g.tiles.filter(t => w.scrap[t]! > 0),
    raw: g.tiles.reduce((n, t) => n + w.scrap[t]!, 0),
    scrap: g.tiles.reduce((n, t) => n + w.scrap[t]! * (w.terrain[t] === Terrain.Crystal ? ECONOMY.crystalValue : 1), 0) }));
}
const terrainFields = new WeakMap<World, Map<Faction, { id: number; tiles: number[] }[]>>();
const hpValue = (u: Unit) => UNITS[u.kind].cost * u.hp / UNITS[u.kind].hp;
const point = (w: World, t: number): Point => ({ x: t % w.width + 0.5, y: Math.floor(t / w.width) + 0.5 });
const near = (a: Point, b: Point, r: number) => dist(a.x, a.y, b.x, b.y) <= r;
const sameOrder = (u: Unit, to: Point) => (u.order.type === "attackMove" || u.order.type === "move") && near(u.order, to, 1);

/** Same DPS × HP model as Marshal micro, using only the remembered composition. */
function strength(a: { kind: UnitKind; hp: number }[], b: { kind: UnitKind; hp: number }[], structures = false): number {
  const hp = b.reduce((n, u) => n + u.hp, 0);
  const dps = a.reduce((n, u) => n + UNITS[u.kind].dps * (hp > 0
    ? b.reduce((v, e) => v + effectivenessVs(u.kind, UNITS[e.kind].armor, UNITS[e.kind].domain) * e.hp / hp, 0)
    : structures ? effectivenessVs(u.kind, "structure", "ground") : 1), 0);
  return dps * a.reduce((n, u) => n + u.hp, 0);
}

export function newEconomyFront(): EconomyFrontState {
  return { status: "idle", sites: [], samples: new Map(), observations: new Map(), urgent: false, runwaySeconds: 0, reason: "observing current mining", nextReview: 0 };
}

/** All enemy inputs are sightings/known buildings, never a lookup by a remembered enemy ID. */
export function planEconomyFront(w: World, faction: Faction, s: EconomyFrontState, ctx: {
  home: Point; enemyHome: Point; seen: Unit[]; miners: Unit[]; army: Unit[];
  unavailable: ReadonlySet<number>; access: MiningAccess; threatened: boolean;
  lost: readonly { x: number; y: number }[]; constrained?: boolean; assault?: boolean;
  withdrawn?: ReadonlySet<number>;
}, cmds: Command[]): Set<number> {
  const { home, enemyHome, access } = ctx;
  for (const e of ctx.seen) if (e.kind !== "harvester" && UNITS[e.kind].dps > 0)
    s.observations.set(e.id, { kind: e.kind, x: e.x, y: e.y, hp: e.hp, tick: w.tick });
  for (const [id, o] of s.observations) if (w.tick - o.tick > MEMORY) s.observations.delete(id);
  if (s.scout && !s.scout.departed) {
    const scout = w.units.get(s.scout.id);
    if (scout && !near(scout, s.scout.origin, 1)) s.scout.departed = w.tick;
  }
  const fr = sideFrame(w, faction);
  const tie = (p: Point) => { const f = fr.toFrame(p); return f.y * w.width + f.x; };
  const fields = economyFields(w, faction);
  const drops = [...w.buildings.values()].filter(b => b.faction === faction && BUILDINGS[b.kind].dropOff);
  const shifts = expansionSites(w, faction, home);
  const region = regionAt(w, Math.floor(home.x), Math.floor(home.y), "ground");
  const origin = (() => {
    for (let r = 2; r <= 5; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const [vx, vy] = fr.vec(dx, dy);
      const p = { x: home.x + vx, y: home.y + vy };
      if (passable(w, Math.floor(p.x), Math.floor(p.y), "ground")) return p;
    }
    return home;
  })();
  const available = ctx.army.filter(u => !ctx.unavailable.has(u.id) && u.kind !== "mender" &&
    UNITS[u.kind].domain === "ground" && UNITS[u.kind].dps > 0 && u.hp >= UNITS[u.kind].hp * 0.45 &&
    !near(u, enemyHome, 12)); // preserve a push already at the enemy base
  const old = s.plan;
  if (old) {
    old.assigned = old.assigned.filter(id => w.units.get(id)?.faction === faction);
    old.assignedValue = old.assigned.reduce((n, id) => n + hpValue(w.units.get(id)!), 0);
    old.availableValue = old.assigned.filter(id => !ctx.unavailable.has(id)).reduce((n, id) => n + hpValue(w.units.get(id)!), 0);
    old.arrivedValue = old.assigned.filter(id => !ctx.unavailable.has(id) && near(w.units.get(id)!, old.hold, ARRIVE)).reduce((n, id) => n + hpValue(w.units.get(id)!), 0);
  }
  const owned = new Set(old?.assigned ?? []);
  // Keep a real home reserve; do not take specialist units to satisfy this number.
  const homeReserve = Math.min(600, available.reduce((n, u) => n + hpValue(u), 0) * 0.2);
  const reserve = new Set<number>();
  let homeValue = 0;
  for (const u of [...available].sort((a, b) => dist(a.x, a.y, home.x, home.y) - dist(b.x, b.y, home.x, home.y) || a.id - b.id)) {
    if (homeValue >= homeReserve) break;
    if (!owned.has(u.id)) { reserve.add(u.id); homeValue += hpValue(u); }
  }
  const pool = available.filter(u => !reserve.has(u.id) && (owned.has(u.id) || !ctx.seen.some(e =>
    near(u, e, Math.max(UNITS[u.kind].range, UNITS[e.kind].range) + 1) && w.tick - u.firedTick < 2 * TICK_RATE)));
  const worked = new Set(ctx.miners.flatMap(h => h.order.type === "harvest" ? [h.order.fieldY * w.width + h.order.fieldX] : []));
  // Bound expensive route and recruitment searches. Productive and retained fields come first.
  const candidates = fields.map(f => {
    const live = f.live.filter(t => regionAt(w, t % w.width, Math.floor(t / w.width), "ground") === region);
    return { ...f, live, raw: live.reduce((n, t) => n + w.scrap[t]!, 0),
      scrap: live.reduce((n, t) => n + w.scrap[t]! * (w.terrain[t] === Terrain.Crystal ? ECONOMY.crystalValue : 1), 0) };
  }).filter(f => f.live.length)
    .map(f => ({ f, working: f.tiles.some(t => worked.has(t)), entry: f.live.map(t => point(w, t))
      .sort((a, b) => dist(a.x, a.y, home.x, home.y) - dist(b.x, b.y, home.x, home.y) || tie(a) - tie(b))[0]! }))
    .sort((a, b) => Number(b.f.id === old?.fieldId) - Number(a.f.id === old?.fieldId) || Number(b.working) - Number(a.working) ||
      dist(a.entry.x, a.entry.y, home.x, home.y) - dist(b.entry.x, b.entry.y, home.x, home.y) || tie(a.entry) - tie(b.entry)).slice(0, 8);
  s.sites = [];
  const forces = new Map<number, Unit[]>();
  for (const { f, entry } of candidates) {
    const route = findPath(w, origin.x, origin.y, entry.x, entry.y, "ground", faction);
    if (!route) continue;
    const depot = drops.map(b => ({ b, c: buildingCenter(b) })).filter(d => near(d.c, entry, SERVED) &&
      (miningRoute(w, faction, d.c, entry)?.length ?? Infinity) <= SERVED * 1.5)
      .sort((a, b) => dist(a.c.x, a.c.y, entry.x, entry.y) - dist(b.c.x, b.c.y, entry.x, entry.y) || a.b.id - b.b.id)[0]?.b;
    const construction = !depot && f.raw >= DRY_FIELD ? expansionSiteForField(w, faction, home, entry) ?? undefined : undefined;
    if (!depot && !construction) continue;
    if (!depot && f.raw < DRY_FIELD) continue;
    const nearby = [...s.observations.values()].filter(e => near(e, entry, 10) || route.some(p => near(e, p, 7)));
    let threat = nearby.reduce((n, e) => n + UNITS[e.kind].cost * e.hp / UNITS[e.kind].hp, 0);
    const towers = knownBuildings(w, faction).filter(b => BUILDINGS[b.kind].dps > 0 &&
      (near({ x: b.tx + BUILDINGS[b.kind].size / 2, y: b.ty + BUILDINGS[b.kind].size / 2 }, entry, 10) || route.some(p => near(p, { x: b.tx + BUILDINGS[b.kind].size / 2, y: b.ty + BUILDINGS[b.kind].size / 2 }, 7))));
    for (const b of towers) threat += BUILDINGS[b.kind].cost || 500;
    const loss = ctx.lost.some(p => near(p, entry, 8));
    if (loss) threat = Math.max(threat, 500);
    const on = ctx.miners.filter(h => h.order.type === "harvest" && f.tiles.includes(h.order.fieldY * w.width + h.order.fieldX) &&
      regionAt(w, h.order.fieldX, h.order.fieldY, "ground") === region);
    const productive = on.filter(h => h.order.type === "harvest" && (h.order.phase === "harvesting" || h.order.phase === "toBase" || h.order.phase === "unloading"));
    const safe = !access.unsafeAt(Math.floor(entry.x), Math.floor(entry.y)) && route.every(p => !access.avoid[Math.floor(p.y) * w.width + Math.floor(p.x)]);
    const history = (s.samples.get(f.id) ?? []).filter(p => w.tick - p.tick <= 30 * TICK_RATE);
    if (history.at(-1)?.tick !== w.tick) history.push({ tick: w.tick, raw: f.raw });
    s.samples.set(f.id, history);
    const first = history[0]!;
    const measured = w.tick - first.tick >= 10 * TICK_RATE ? Math.max(0, first.raw - f.raw) / ((w.tick - first.tick) / TICK_RATE) : 0;
    const haulSteps = depot ? miningRoute(w, faction, buildingCenter(depot), entry)!.length : 10;
    const rawLoad = ECONOMY.harvesterCapacity / Math.max(1, f.scrap / Math.max(1, f.raw));
    const loadSeconds = rawLoad / ECONOMY.harvestRate;
    const unloadSeconds = ECONOMY.harvesterCapacity / ECONOMY.unloadRate;
    const capacity = on.length * rawLoad / (loadSeconds + 2 * haulSteps / UNITS.harvester.speed + unloadSeconds);
    const rate = Math.max(measured, capacity * 0.5);
    const runway = productive.length && safe && depot && depot.founding === undefined ? f.raw / Math.max(1, rate) : 0;
    // Units already fighting here are real support even when another mission
    // owns them. They may help win this fight without being recruited away.
    const support = ctx.army.filter(u => !pool.includes(u) && !ctx.withdrawn?.has(u.id) && !u.goliath &&
      u.kind !== "mender" && UNITS[u.kind].dps > 0 && near(u, entry, 7));
    const deploying = old?.fieldId === f.id && (old.phase === "assemble" || old.phase === "secure");
    const holding = old?.fieldId === f.id && old.phase === "hold" && !s.urgent;
    const share = holding ? ctx.assault && productive.length > 0 && safe ? 0.15 : 0.35 : 0.6;
    // Recruit until the composition-aware fight is viable. Requiring 1.6 times
    // the enemy's price as well rejected winning local fights before that
    // model could matter, even with the entire available army present.
    const required = Math.max(loss ? 600 : 450, deploying ? old.required : pool.reduce((n, u) => n + hpValue(u), 0) * share);
    const force: Unit[] = [];
    let v = 0;
    let armyTravel = 0;
    const viableFight = () => {
      const ourRange = force.reduce((n, u) => Math.max(n, UNITS[u.kind].range), 0);
      const theirRange = nearby.reduce((n, u) => Math.max(n, UNITS[u.kind].range), towers.reduce((n, b) => Math.max(n, BUILDINGS[b.kind].range), 0));
      const margin = theirRange > ourRange ? 1.5 : 1.2;
      const together = [...force, ...support];
      const enemyStrength = strength(nearby, together) + towers.reduce((n, b) => n + BUILDINGS[b.kind].dps, 0) * towers.reduce((n, b) => n + BUILDINGS[b.kind].hp, 0);
      return v >= required && (threat < 500 || strength(together, nearby, towers.length > 0) >= margin * enemyStrength);
    };
    // Existing orders are eligible. Reachability is checked per movement class; only actual
    // recruits contribute to the same force that will be reserved and commanded.
    const roster = (u: Unit) => owned.has(u.id) ? old!.assigned.indexOf(u.id) : Number.MAX_SAFE_INTEGER;
    for (const u of [...pool].sort((a, b) => roster(a) - roster(b) || dist(a.x, a.y, entry.x, entry.y) - dist(b.x, b.y, entry.x, entry.y) || a.id - b.id)) {
      if (viableFight() && (!deploying || !owned.has(u.id))) break;
      // An unobserved ground approach still needs a ground escort. Flak's
      // nominal DPS/price cannot make an otherwise empty guard useful.
      if (UNITS[u.kind].targets === "air" && !nearby.some(e => UNITS[e.kind].domain === "air")) continue;
      if (threat >= 500 && nearby.length && !nearby.some(e => effectivenessVs(u.kind, UNITS[e.kind].armor, UNITS[e.kind].domain) >= 0.45)) continue;
      const path = findPath(w, u.x, u.y, entry.x, entry.y, moveClassOf(u.kind), faction);
      if (!path) continue;
      force.push(u); v += hpValue(u);
      armyTravel = Math.max(armyTravel, path.length / Math.max(0.1, UNITS[u.kind].speed));
    }
    forces.set(f.id, force);
    const crewTravel = route.length / UNITS.harvester.speed;
    const crewTraining = Math.max(0, ECONOMY.expansion.crew + 3 - ctx.miners.length) * UNITS.harvester.buildTime;
    const build = depot ? (depot.founding ?? 0) / TICK_RATE : crewTraining + crewTravel + ECONOMY.expansion.buildTime;
    const transfer = productive.length ? 0 : crewTravel;
    const firstLoad = loadSeconds + haulSteps / UNITS.harvester.speed + unloadSeconds;
    // Safe transfers can overlap army movement; a new Depot's shift is sent only after
    // construction, matching staffExpansions rather than promising imaginary early income.
    const ready = (depot ? Math.max(armyTravel + (threat ? 12 : 0), build, transfer)
      : Math.max(armyTravel + (threat ? 12 : 0), build) + transfer) + firstLoad + 8;
    const deploymentCost = depot ? 0 : ECONOMY.expansion.cost + ECONOMY.expansion.crew * UNITS.harvester.cost + ECONOMY.expansion.crew * crewTravel * ECONOMY.harvestRate * 0.45;
    const useful = Math.min(f.scrap, 60 * Math.min(5, Math.max(1, ctx.miners.length - 3)) * ECONOMY.harvestRate * 0.45);
    // Staffing sends a Depot's shift to its nearest live patch. A different
    // patch within ten tiles cannot promise immediate income from that Depot.
    const shift = depot && shifts.find(site => near({ x: site.cx, y: site.cy }, buildingCenter(depot), 0.1));
    const waitingForShift = shift && !f.tiles.includes(shift.field.y * w.width + shift.field.x) && !on.length;
    const viable = !waitingForShift && viableFight();
    s.sites.push({ fieldId: f.id, entry, depotId: depot?.id, construction, raw: f.raw, scrap: f.scrap, miners: on.length, productive: productive.length,
      waiting: on.length - productive.length, route, safe, threat, lastSeen: nearby.length ? Math.max(...nearby.map(e => e.tick)) : null,
      confidence: nearby.some(e => e.tick === w.tick) ? "observed" : nearby.length || loss ? "remembered" : "unknown",
      readySeconds: ready, deploymentCost, runwaySeconds: runway,
      score: useful - ready * 18 - deploymentCost - threat * 0.4,
      viable, reason: waitingForShift ? "Depot's shift is working another live field" : viable ? "reachable income after deployment and escort cost" : "insufficient available force after specialist and home reserves" });
  }
  const dependable = s.sites.filter(site => site.runwaySeconds > 0);
  s.runwaySeconds = dependable.reduce((n, site) => Math.max(n, site.runwaySeconds), 0);
  const options = s.sites.filter(site => site.scrap >= (site.depotId ? 300 : DRY_FIELD) && site.viable &&
    !near(site.entry, home, 10));
  options.sort((a, b) => b.score - a.score || tie(a.entry) - tie(b.entry));
  const current = s.sites.find(site => site.fieldId === old?.fieldId);
  const next = options.find(site => site.fieldId !== old?.fieldId && !site.runwaySeconds);
  let target = options[0];
  const retained = options.find(site => site.fieldId === old?.fieldId);
  if (retained && target && (w.tick - old!.since < COMMIT || target.score < retained.score + Math.max(400, Math.abs(retained.score) * 0.2))) target = retained;
  const horizon = ((current?.runwaySeconds ? next : target)?.readySeconds ?? 60) + 25;
  const productiveNow = dependable.reduce((n, site) => n + site.productive, 0);
  const productiveThen = dependable.reduce((n, site) => n + (site.runwaySeconds > horizon ? site.productive : 0), 0);
  s.urgent = !dependable.length || productiveThen < productiveNow * 0.65;
  // A newly productive site is the income we set out to secure. Keep covering it
  // while it has runway; an unstaffed field scoring slightly higher is no reason
  // to consume another crew or abandon this one.
  if (!s.urgent && retained && retained.miners) target = retained;
  if (s.urgent && next && current?.runwaySeconds && current.safe && !current.threat && current.runwaySeconds < next.readySeconds + 25)
    target = next; // preparation concerns the next source, rather than re-activating today's income
  if (ctx.threatened) {
    s.status = "recover";
    if (old) {
      old.phase = "recover"; old.reason = "home emergency"; old.phaseSince = w.tick;
      const ids = old.assigned.filter(id => w.units.has(id) && !ctx.unavailable.has(id));
      if (ids.length) cmds.push({ type: "attackMove", faction, unitIds: ids, ...origin });
      old.assigned = [];
    }
    s.reason = "home emergency preempts the economic assignment";
    return new Set();
  }
  if (!old && !s.urgent) { s.status = "idle"; s.reason = "dependable mining has sufficient runway"; return new Set(); }
  if (!old && !target && w.tick < s.nextReview) { s.status = "recover"; s.reason = "recovery: insufficient force or access at the next source"; return new Set(); }
  if (!target) {
    s.status = "recover";
    if (old) {
      if (old.phase !== "recover") { old.phase = "recover"; old.phaseSince = w.tick; }
      old.reason = "no viable source or sufficient force";
      const ids = old.assigned.filter(id => w.units.has(id));
      const moving = ids.filter(id => !ctx.unavailable.has(id) && !near(w.units.get(id)!, origin, ARRIVE) && !sameOrder(w.units.get(id)!, origin));
      if (moving.length) cmds.push({ type: "move", faction, unitIds: moving, ...origin });
      old.assigned = ids;
      if (ids.every(id => near(w.units.get(id)!, origin, ARRIVE))) old.assigned = [];
    }
    s.nextReview = w.tick + REVIEW;
    s.reason = "recovery: no viable reachable source";
    return new Set(old?.assigned);
  }
  // Retreat from a newly losing target first. Retain survivors until the next review instead
  // of feeding them straight into the next fight from their current exposed positions.
  if (old?.phase === "recover" && old.assigned.length && w.tick - old.phaseSince < REVIEW) {
    s.status = "recover";
    const ids = old.assigned.filter(id => w.units.has(id));
    const moving = ids.filter(id => !ctx.unavailable.has(id) && !near(w.units.get(id)!, origin, ARRIVE) && !sameOrder(w.units.get(id)!, origin));
    if (moving.length) cmds.push({ type: "move", faction, unitIds: moving, ...origin });
    old.assigned = ids;
    return new Set(ids);
  }
  const force = forces.get(target.fieldId)!;
  // A pocket's mining tile can be behind rocks, farther from the enemy than
  // its mouth. Cover the reachable approach instead of parking the guard
  // inside that dead end. On an open field this remains the mining entry.
  let holdIndex = target.route.length - 1;
  for (let i = Math.max(0, target.route.length - 10); i < target.route.length; i++) {
    const at = target.route[i]!, best = target.route[holdIndex]!;
    if (near(at, target.entry, 6) && dist(at.x, at.y, enemyHome.x, enemyHome.y) < dist(best.x, best.y, enemyHome.x, enemyHome.y)) holdIndex = i;
  }
  // A legal approach is on the route, on our side of the first known danger.
  let approach = target.route[Math.max(0, holdIndex - 7)] ?? origin;
  const firstDanger = target.route.findIndex(p => access.avoid[Math.floor(p.y) * w.width + Math.floor(p.x)]);
  if (firstDanger >= 0 && firstDanger <= holdIndex) approach = target.route[Math.max(0, firstDanger - 4)] ?? origin;
  const hold = target.route[holdIndex] ?? target.entry;
  let p = old;
  if (!p || p.fieldId !== target.fieldId || p.phase === "recover") {
    p = { fieldId: target.fieldId, depotId: target.depotId, phase: "assemble", assigned: [], since: w.tick, phaseSince: w.tick,
      approach, hold, retreat: origin, required: 0, assignedValue: 0, availableValue: 0, orderedValue: 0, arrivedValue: 0, reason: "prepare next dependable income" };
    s.plan = p;
  }
  p.depotId = target.depotId;
  const reinforced = force.some(u => !p!.assigned.includes(u.id));
  p.assigned = force.map(u => u.id);
  p.assignedValue = force.reduce((n, u) => n + hpValue(u), 0);
  p.required = p.assignedValue; // evaluate, reserve and wait for the same selected force
  p.availableValue = p.assignedValue;
  p.approach = approach; p.hold = hold;
  const assembled = force.filter(u => near(u, approach, ARRIVE)).reduce((n, u) => n + hpValue(u), 0);
  const arrived = force.filter(u => near(u, hold, ARRIVE)).reduce((n, u) => n + hpValue(u), 0);
  const fighting = (u: Unit) => !!ctx.constrained && w.tick - u.firedTick < 2 * TICK_RATE && ctx.seen.some(e =>
    near(u, e, UNITS[u.kind].range + 0.3) && effectivenessVs(u.kind, UNITS[e.kind].armor, UNITS[e.kind].domain) > 0);
  const remaining = Math.max(...force.map(u => dist(u.x, u.y, p!.phase === "assemble" ? approach.x : hold.x, p!.phase === "assemble" ? approach.y : hold.y)));
  if (reinforced || p.distanceLeft === undefined || remaining < p.distanceLeft - 0.5) {
    p.distanceLeft = remaining;
    p.progressTick = w.tick;
  }
  if (p.phase === "secure" && force.some(fighting)) p.progressTick = w.tick;
  const change = (phase: EconomyFrontPlan["phase"], reason: string) => {
    if (p!.phase !== phase) { p!.phaseSince = w.tick; p!.progressTick = w.tick; p!.distanceLeft = undefined; }
    p!.phase = phase; p!.reason = reason;
  };
  if (arrived >= p.required && target.safe) change("hold", "actual cover has reached a usable mining approach");
  else if (p.phase === "assemble" && assembled >= Math.max(p.required, p.assignedValue * 0.85)) change("secure", "selected force has actually assembled");
  else if (p.phase === "hold" && !target.safe) {
    change("secure", "reinforce the viable fight at the mining approach");
    p.advance = { ...hold };
  }
  else if (p.phase !== "hold" && w.tick - (p.progressTick ?? p.phaseSince) > 40 * TICK_RATE) {
    change("recover", "movement stalled or force cannot assemble");
    s.nextReview = w.tick + REVIEW;
  }
  if (p.phase === "secure") {
    // Advance in short shared hops. The fastest leading units cannot start the fight while
    // the selected slow units are still at the assembly point or behind the rocks.
    const progress = force.map(u => {
      let best = 0;
      for (let i = 1; i < target!.route.length; i++) if (dist(u.x, u.y, target!.route[i]!.x, target!.route[i]!.y) < dist(u.x, u.y, target!.route[best]!.x, target!.route[best]!.y)) best = i;
      return best;
    });
    let previous = 0;
    if (p.advance) for (let i = 1; i < target.route.length; i++)
      if (dist(p.advance.x, p.advance.y, target.route[i]!.x, target.route[i]!.y) < dist(p.advance.x, p.advance.y, target.route[previous]!.x, target.route[previous]!.y)) previous = i;
    // Reinforcements join the line already reached. A new unit at home must
    // never move that line backward and recall the veterans guarding miners.
    p.advance = target.route[Math.min(holdIndex, Math.max(previous, Math.min(...progress) + 4))] ?? hold;
  }
  const destination = p.phase === "assemble" ? approach : p.phase === "recover" ? origin : p.phase === "secure" ? p.advance ?? hold : hold;
  p.orderedValue = force.filter(u => sameOrder(u, destination)).reduce((n, u) => n + hpValue(u), 0);
  p.arrivedValue = arrived;
  const moving = force.filter(u => !near(u, destination, p!.phase === "hold" ? ARRIVE : 2) && !sameOrder(u, destination) &&
    (p!.phase === "recover" || !fighting(u)));
  if (moving.length) cmds.push({ type: p.phase === "recover" ? "move" : "attackMove", faction, unitIds: moving.map(u => u.id), ...destination });
  s.reason = p.reason;
  s.status = p.phase === "recover" ? "recover" : "assigned";
  // Optional reconnaissance has no role in readiness or phase exit conditions.
  if (!s.scout || w.tick - s.scout.issued > 20 * TICK_RATE) {
    const scout = [...w.units.values()].find(u => u.faction === faction && u.kind === "scout" && u.order.type === "idle" && !ctx.unavailable.has(u.id));
    if (scout) {
      s.scout = { id: scout.id, issued: w.tick, origin: { x: scout.x, y: scout.y }, reason: "observe the selected mining approach" };
      cmds.push({ type: "move", faction, unitIds: [scout.id], ...hold });
    }
  }
  return new Set(p.assigned);
}

/** Observer gets a detached snapshot. It cannot mutate the plan or consume random numbers. */
export function economyDiagnostic(s: EconomyFrontState | undefined): unknown {
  if (!s) return null;
  return { status: s.status, urgent: s.urgent, runwaySeconds: s.runwaySeconds, reason: s.reason,
    plan: s.plan ? { ...s.plan, assigned: [...s.plan.assigned], approach: { ...s.plan.approach }, hold: { ...s.plan.hold }, retreat: { ...s.plan.retreat }, advance: s.plan.advance ? { ...s.plan.advance } : undefined } : null,
    sites: s.sites.map(site => ({ ...site, entry: { ...site.entry }, construction: site.construction ? { ...site.construction } : undefined, route: site.route.map(p => ({ ...p })) })),
    scout: s.scout ? { ...s.scout, origin: { ...s.scout.origin } } : null };
}
