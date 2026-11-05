import { ECONOMY, TICK_RATE, BUILDINGS, UNITS } from "../balance";
import { foundBlocker, nearestReachableResource } from "../economy";
import { knownBuildings } from "../fog";
import type { Building, Command, Faction, Unit, World } from "../types";
import { dist, isResource, regionAt, sideFrame, tileIndex } from "../world";
import type { AiState } from "./commander";
import { droppingCondor } from "./condor";
import { EXPANSION_MINERS } from "./expansion";

/**
 * The commander's mesa run: fields no harvester can drive to (Three Canyons'
 * corner mesas) are worked by flying a crew up. Two Condors of its own ferry
 * Harvesters from home, two a trip; four found a Depot up there and a shift
 * works it. Ordinary board / unload / found / harvest commands, same fog as
 * everyone. Harvesters up on a mesa, or boarding, aren't the commander's to
 * staff: it trains replacements at home (offHome).
 */

export const SKYLIFT = {
  /** No run starts before this (s): the opening and first expansions come first. */
  from: 300,
  /** Harvesters at home before one is spared for it. */
  keepHome: 8,
  /** Condors flying it. */
  condors: 2,
  /** Condors built for it in a match, at most… */
  maxBuilt: 6,
  /** …and no sooner than this (s) after one went down. */
  rebuild: 60,
  /** A Condor this far (tiles) from the HQ flies home before anyone boards it. */
  boardReach: 14,
  /** Armed enemies this close to the landing (tiles): nobody lands. */
  hot: 9
};

interface AirField {
  region: number;
  /** The field tile nearest the middle of the region's fields. */
  x: number;
  y: number;
}

interface Memo {
  /** The Condors flying it. */
  ids: number[];
  built: number;
  lostTick: number;
  /** Ground region being worked (null: none picked). */
  region: number | null;
  /** Is a run under way (it wants Condors)? */
  active: boolean;
  /** No field is left off the home ground: never look again. */
  none: boolean;
}

const memos = new WeakMap<AiState, Memo>();
const memo = (s: AiState): Memo => {
  let m = memos.get(s);
  if (!m) memos.set(s, (m = { ids: [], built: 0, lostTick: -1e9, region: null, active: false, none: false }));
  return m;
};

const homeRegion = (w: World, hq: Building): number => regionAt(w, hq.tx, hq.ty, "ground");
const regionOf = (w: World, u: { x: number; y: number }): number => regionAt(w, Math.floor(u.x), Math.floor(u.y), "ground");

/** Is this harvester the mesa run's: boarding a Condor, or set down off the home ground? */
export function offHome(w: World, hq: Building | null, u: Unit): boolean {
  return u.order.type === "board" || (!!hq && regionOf(w, u) !== homeRegion(w, hq));
}

/** Fields no harvester can drive to from home, one to a ground region, in the side's own frame order. */
function airFields(w: World, faction: Faction, home: number): AirField[] {
  const fr = sideFrame(w, faction);
  const sums = new Map<number, { x: number; y: number; n: number }>();
  for (let fy = 0; fy < w.height; fy++)
    for (let fx = 0; fx < w.width; fx++) {
      const [tx, ty] = fr.tile(fx, fy, 1);
      if (!isResource(w, tileIndex(w, tx, ty))) continue;
      const r = regionAt(w, tx, ty, "ground");
      if (!r || r === home) continue;
      const a = sums.get(r) ?? { x: 0, y: 0, n: 0 };
      a.x += tx;
      a.y += ty;
      a.n++;
      sums.set(r, a);
    }
  const out: AirField[] = [];
  for (const [region, a] of sums) out.push({ region, x: Math.round(a.x / a.n), y: Math.round(a.y / a.n) });
  return out;
}

/** The open Depot site nearest a field, on its ground, scanned in the side's own frame. */
function depotSite(w: World, faction: Faction, at: AirField): { tx: number; ty: number } | null {
  const size = BUILDINGS.depot.size;
  const fr = sideFrame(w, faction);
  const f = fr.toFrame(at);
  let best: { tx: number; ty: number } | null = null;
  let bestD = Infinity;
  const R = ECONOMY.wastelandRing + 7;
  for (let dy = -R; dy <= R; dy++)
    for (let dx = -R; dx <= R; dx++) {
      const fx = Math.round(f.x + dx - size / 2);
      const fy = Math.round(f.y + dy - size / 2);
      const d = dist(fx + size / 2, fy + size / 2, f.x, f.y);
      if (d >= bestD) continue;
      const [tx, ty] = fr.tile(fx, fy, size);
      if (foundBlocker(w, faction, tx, ty) || regionAt(w, tx, ty, "ground") !== at.region) continue;
      best = { tx, ty };
      bestD = d;
    }
  return best;
}

/** The Condors flying the run (their orders are mining, to the APM cap: marshal.ts rankOf). */
export const ferryCondors = (s: AiState): ReadonlySet<number> => new Set(memos.get(s)?.ids ?? []);

/** Does production owe the run a Condor? `queued`: ones on their way already. */
export function skyliftWantsCondor(w: World, s: AiState, queued: number): boolean {
  const m = memos.get(s);
  if (!m?.active || m.ids.length + queued >= SKYLIFT.condors) return false;
  return m.built < SKYLIFT.maxBuilt && w.tick - m.lostTick >= SKYLIFT.rebuild * TICK_RATE;
}

export interface SkyliftContext {
  hq: Building | null;
  /** Every Harvester of ours on the field. */
  harvesters: Unit[];
  seen: Unit[];
  threatened: boolean;
  /** Condors another plan holds (a Goliath's lift). */
  skip?: ReadonlySet<number>;
}

/** One pass of the mesa run: its commands, and the Condors it flies (the drop plan leaves them be). */
export function planSkylift(w: World, faction: Faction, s: AiState, ctx: SkyliftContext): { cmds: Command[]; condors: Set<number> } {
  const cmds: Command[] = [];
  const condors = new Set<number>();
  const done = { cmds, condors };
  if (!s.skylift || !ctx.hq) return done;
  const m = memo(s);
  if (m.none) return done;
  const hq = ctx.hq;
  const home = homeRegion(w, hq);
  const fields = airFields(w, faction, home);
  if (fields.length === 0) {
    m.none = true;
    m.region = null;
    m.active = false;
    m.ids = [];
    return done;
  }
  const hqC = { x: hq.tx + BUILDINGS.hq.size / 2, y: hq.ty + BUILDINGS.hq.size / 2 };
  const armedBy = (x: number, y: number) => ctx.seen.some((e) => UNITS[e.kind].dps > 0 && dist(e.x, e.y, x, y) <= SKYLIFT.hot);

  // the Condors flying it (one shot down: the rebuild clock starts)
  const alive = m.ids.filter((id) => w.units.has(id));
  if (alive.length < m.ids.length) m.lostTick = w.tick;
  m.ids = alive;

  // the mesa: the one being worked, or the nearest nobody else has
  let at = fields.find((f) => f.region === m.region) ?? null;
  if (!at) {
    m.region = null;
    const theirs = new Set(knownBuildings(w, faction).filter((b) => b.faction !== faction).map((b) => regionAt(w, b.tx, b.ty, "ground")));
    const open = fields.filter((f) => !theirs.has(f.region) && !armedBy(f.x, f.y));
    open.sort((a, b) => dist(a.x, a.y, hqC.x, hqC.y) - dist(b.x, b.y, hqC.x, hqC.y));
    at = open[0] ?? null;
    if (!at) {
      m.active = false;
      return done;
    }
  }
  const landing = at;

  const homeCrew = ctx.harvesters.filter((u) => regionOf(w, u) === home && u.order.type !== "board" && u.order.type !== "found");
  if (m.region === null) {
    if (w.tick < SKYLIFT.from * TICK_RATE || ctx.threatened || homeCrew.length < SKYLIFT.keepHome) {
      m.active = false;
      return done;
    }
    m.region = landing.region;
  }
  m.active = true;

  const up = ctx.harvesters.filter((u) => regionOf(w, u) === landing.region);
  const site = [...w.buildings.values()].find(
    (b) => b.faction === faction && BUILDINGS[b.kind].dropOff && regionAt(w, b.tx, b.ty, "ground") === landing.region
  );

  // on the mesa: found the Depot; once it's up, nobody stands idle
  const founding = up.some((u) => u.order.type === "found");
  if (!site && !founding && up.length >= ECONOMY.expansion.crew && w.factions[faction].scrap >= ECONOMY.expansion.cost) {
    const spot = depotSite(w, faction, landing);
    if (spot) cmds.push({ type: "found", faction, unitIds: up.slice(0, ECONOMY.expansion.crew).map((u) => u.id), tx: spot.tx, ty: spot.ty });
  }
  if (site && site.founding === undefined)
    for (const u of up) {
      if (u.order.type !== "idle") continue;
      const f = nearestReachableResource(w, u.x, u.y, faction);
      if (f) cmds.push({ type: "harvest", faction, unitIds: [u.id], x: f.x + 0.5, y: f.y + 0.5 });
    }

  // how many more are owed: a crew (they become the Depot) and a shift
  const flying = m.ids.reduce((n, id) => n + (w.units.get(id)?.passengers?.length ?? 0), 0);
  const boarding = ctx.harvesters.filter((u) => u.order.type === "board");
  const want = EXPANSION_MINERS + (site ? 0 : ECONOMY.expansion.crew);
  const owing = want - up.length - flying - boarding.length;
  let owed = owing;

  // the Condors: any free one of ours while there's cargo left to fly
  if (owed > 0)
    for (const u of w.units.values()) {
      if (m.ids.length >= SKYLIFT.condors) break;
      if (u.faction !== faction || u.kind !== "condor" || u.order.type === "lift" || ctx.skip?.has(u.id)) continue;
      if (m.ids.includes(u.id) || droppingCondor(s) === u.id || u.passengers?.length) continue;
      m.ids.push(u.id);
      m.built++;
    }

  const spare = homeCrew
    .filter((u) => !ctx.seen.some((e) => UNITS[e.kind].dps > 0 && dist(e.x, e.y, u.x, u.y) <= SKYLIFT.hot))
    .sort((a, b) => Number(b.order.type === "idle") - Number(a.order.type === "idle") || dist(a.x, a.y, hqC.x, hqC.y) - dist(b.x, b.y, hqC.x, hqC.y) || a.id - b.id);
  let free = Math.max(0, homeCrew.length - SKYLIFT.keepHome);
  // (every field at home dry: all of them are spare)
  if (homeCrew.every((u) => u.order.type === "idle")) free = homeCrew.length;

  for (const id of m.ids) {
    const c = w.units.get(id)!;
    condors.add(id);
    const aboard = c.passengers?.length ?? 0;
    const coming = boarding.filter((u) => u.order.type === "board" && u.order.carrierId === id).length;
    const seats = (UNITS.condor.capacity ?? 2) - aboard - coming;
    if (c.order.type === "unload") continue;
    if (aboard > 0 && coming === 0 && (seats === 0 || owed <= 0 || free <= 0)) {
      if (!armedBy(landing.x, landing.y)) cmds.push({ type: "unload", faction, unitIds: [id], x: landing.x + 0.5, y: landing.y + 0.5 });
      continue;
    }
    if (seats <= 0 || owed <= 0 || free <= 0) continue;
    if (dist(c.x, c.y, hqC.x, hqC.y) > SKYLIFT.boardReach) {
      if (c.order.type === "idle") cmds.push({ type: "move", faction, unitIds: [id], x: hqC.x, y: hqC.y });
      continue;
    }
    const riders = spare.splice(0, Math.min(seats, owed, free));
    if (riders.length === 0) continue;
    owed -= riders.length;
    free -= riders.length;
    cmds.push({ type: "board", faction, unitIds: riders.map((u) => u.id), carrierId: id });
  }

  // nothing left to fly: the Condors go back to the drop plan
  if (owing <= 0 && flying === 0 && boarding.length === 0) {
    m.ids = [];
    m.active = false;
    condors.clear();
  }
  return done;
}
