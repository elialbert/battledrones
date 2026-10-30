import { BUILDINGS, ECONOMY, GOLIATH, TICK_RATE, UNITS } from "../balance";
import { foundBlocker } from "../economy";
import { findPath } from "../movement";
import type { Command, Faction, Unit, World } from "../types";
import { dist, isResource, passable, sideFrame, tileIndex } from "../world";
import { sealsOff } from "../placement";
import { anchorFootprint } from "../goliath";

/**
 * Expansion Depots for the AI: a Depot it wants by a field out of build
 * range is deployed by a crew of harvesters on site, who are used up
 * (economy.ts orderFound). The commander picks a site by a field nothing
 * serves and sends a crew there (they stop mining); the sim founds it once
 * they're all there. A crew
 * that's cut down, or a site that's lost, calls it off.
 */
export interface ExpansionPlan {
  /** The Depot's top-left tile. */
  tx: number;
  ty: number;
  crew: number[];
  since: number;
  /** Placed: the Depot going up (a crew that isn't used up waits by it till it's done). */
  depotId?: number;
}

/** Give up on a crew that hasn't got there (and founded it) in this long. */
const STALE = 60 * TICK_RATE;
/** Fields this close to the HQ (tiles) are worth an expansion; past it, too far to hold. */
const MAX_FIELD = 36;
/** A field tile this close to a drop-off is served already: an expansion goes to a field of its own. */
const SERVED = 10;
/** Fields this close to the HQ (tiles) are its home field (as ai/commander.ts HOME_FIELD). */
const HOME_FIELD = 10;

/** A field in a drop-off's reach is served if a harvester walks there in at most this many times `reach` steps. */
const WALK_SLACK = 1.5;

/**
 * The nearest field to the HQ that no drop-off within `reach` serves (a
 * Depot still going up counts: it will), or null.
 */
export function unservedField(w: World, faction: Faction, hqC: { x: number; y: number }, reach: number): { x: number; y: number; d: number } | null {
  const drops = [...w.buildings.values()].filter((b) => b.faction === faction && BUILDINGS[b.kind].dropOff);
  const walk = walkFromDrops(w, faction);
  const fr = sideFrame(w, faction); // scanned in the side's own frame (mirror-fair ties)
  let best: { x: number; y: number; d: number } | null = null;
  for (let fy = 0; fy < w.height; fy++)
    for (let fx = 0; fx < w.width; fx++) {
      const [tx, ty] = fr.tile(fx, fy, 1);
      if (!isResource(w, tileIndex(w, tx, ty))) continue;
      const x = tx + 0.5;
      const y = ty + 0.5;
      if (drops.some((b) => dist(x, y, b.tx + BUILDINGS[b.kind].size / 2, b.ty + BUILDINGS[b.kind].size / 2) < reach)) {
        // (in reach as the crow flies, but not on foot — a field behind rocks, every load walked round
        // them, past whatever waits out there — isn't served: Riverlands' south field, -marshal-brutal)
        const steps = walk[tileIndex(w, tx, ty)]!;
        if (steps >= 0 && steps <= reach * WALK_SLACK) continue;
      }
      const d = dist(x, y, hqC.x, hqC.y);
      if (!best || d < best.d) best = { x, y, d };
    }
  return best && best.d <= MAX_FIELD ? best : null;
}

/**
 * `fn()` once per tick for the same `key` (a site scan: the AI asks several
 * times a think, both sides, and the world can't change between thinks of one
 * tick). Per world object, so a world rebuilt from a checkpoint starts fresh.
 */
export function perTick<T>(w: World, key: string, fn: () => T): T {
  let m = tickMemo.get(w);
  if (!m || m.tick !== w.tick) tickMemo.set(w, (m = { tick: w.tick, v: new Map() }));
  if (!m.v.has(key)) m.v.set(key, fn());
  return m.v.get(key) as T;
}
const tickMemo = new WeakMap<World, { tick: number; v: Map<string, unknown> }>();

/**
 * Steps from our nearest drop-off to every tile (8-way, no corner cutting, as
 * nearestReachableResource walks), -1 where none reach. `avoid`: tiles not to
 * walk through (ai/fields.ts: where an enemy army waits).
 */
export function walkFromDrops(w: World, faction: Faction, avoid?: Uint8Array): Int32Array {
  if (!avoid) return perTick(w, `drop walk ${faction}`, () => walkFrom(w, faction));
  return walkFrom(w, faction, avoid);
}
function walkFrom(w: World, faction: Faction, avoid?: Uint8Array): Int32Array {
  const W = w.width;
  const d = new Int32Array(W * w.height).fill(-1);
  const queue = new Int32Array(W * w.height);
  let head = 0;
  let tail = 0;
  const source = (tx: number, ty: number, size: number) => {
    for (let y = ty; y < ty + size; y++)
      for (let x = tx; x < tx + size; x++) {
        const i = y * W + x;
        if (x < 0 || y < 0 || x >= W || y >= w.height || d[i]! >= 0) continue;
        d[i] = 0;
        queue[tail++] = i;
      }
  };
  for (const b of w.buildings.values())
    if (b.faction === faction && BUILDINGS[b.kind].dropOff) source(b.tx, b.ty, BUILDINGS[b.kind].size); // (one going up counts: it will be)
  // (and a dug-in Goliath: harvesters unload at it, world.ts nearestDropSite)
  for (const u of w.units.values())
    if (u.faction === faction && u.goliath?.mode === "anchored" && !u.goliath.lift) {
      const foot = u.goliath.foot ?? anchorFootprint(w, faction, u.x, u.y);
      source(foot.tx, foot.ty, GOLIATH.footprint);
    }
  const open = (x: number, y: number) => passable(w, x, y, "ground") && !avoid?.[y * W + x];
  while (head < tail) {
    const cur = queue[head++]!;
    const cx = cur % W;
    const cy = Math.floor(cur / W);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (!open(nx, ny)) continue;
        if (dx !== 0 && dy !== 0 && (!open(cx + dx, cy) || !open(cx, cy + dy))) continue;
        const ni = ny * W + nx;
        if (d[ni]! >= 0) continue;
        d[ni] = d[cur]! + 1;
        queue[tail++] = ni;
      }
  }
  return d;
}

/** Where an expansion Depot would go: the open spot nearest the nearest unserved field, reachable from home. */
export function expansionSite(w: World, faction: Faction, hqC: { x: number; y: number }, reach: number): { tx: number; ty: number } | null {
  return perTick(w, `exp ${faction} ${hqC.x} ${hqC.y} ${reach}`, () => scanExpansionSite(w, faction, hqC, reach));
}
function scanExpansionSite(w: World, faction: Faction, hqC: { x: number; y: number }, reach: number): { tx: number; ty: number } | null {
  const field = unservedField(w, faction, hqC, Math.max(reach, SERVED));
  if (!field) return null;
  const size = BUILDINGS.depot.size;
  const fr = sideFrame(w, faction);
  const f = fr.toFrame(field);
  const R = ECONOMY.wastelandRing + 4;
  let best: { tx: number; ty: number } | null = null;
  let bestD = Infinity;
  for (let dy = -R; dy <= R; dy++)
    for (let dx = -R; dx <= R; dx++) {
      const fx = Math.round(f.x + dx - size / 2);
      const fy = Math.round(f.y + dy - size / 2);
      const d = dist(fx + size / 2, fy + size / 2, f.x, f.y);
      if (d >= bestD) continue;
      const [tx, ty] = fr.tile(fx, fy, size);
      if (foundBlocker(w, faction, tx, ty)) continue;
      if (sealsOff(w, tx, ty, size)) continue; // (no pocket boxed in, placement.ts)
      best = { tx, ty };
      bestD = d;
    }
  if (!best) return null;
  const [bx, by] = fr.vec(0, 2.5);
  if (!findPath(w, hqC.x + bx, hqC.y + by, best.tx + size / 2, best.ty + size / 2, "ground", faction)) return null;
  return best;
}

/**
 * Harvesters a Depot by a field of its own is kept staffed with: about where one field's
 * miners start getting in each other's way (a 4–12 tile field by a Depot, measured).
 */
export const EXPANSION_MINERS = 5;
/** Harvesters left on the home field however many Depots want staffing. */
const HOME_MINERS = 3;
/** Armed enemies this close to a Depot (tiles): no more harvesters fed in till they're gone. */
const UNSAFE = 8;

/** The field tile nearest a Depot's middle, within SERVED (scanned in the side's own frame: mirror-fair ties), or null. */
function fieldBy(w: World, faction: Faction, cx: number, cy: number): { x: number; y: number } | null {
  const fr = sideFrame(w, faction);
  const c = fr.toFrame({ x: cx, y: cy });
  let best: { x: number; y: number } | null = null;
  let bestD = SERVED;
  for (let fy = Math.floor(c.y - SERVED); fy <= c.y + SERVED; fy++)
    for (let fx = Math.floor(c.x - SERVED); fx <= c.x + SERVED; fx++) {
      const d = dist(fx + 0.5, fy + 0.5, c.x, c.y);
      if (d > bestD || (best && d === bestD)) continue;
      const [tx, ty] = fr.tile(fx, fy, 1);
      if (tx < 0 || ty < 0 || tx >= w.width || ty >= w.height || !isResource(w, tileIndex(w, tx, ty))) continue;
      best = { x: tx, y: ty };
      bestD = d;
    }
  return best;
}

/**
 * Keep each finished Depot that serves a field of its own (past the home
 * field: an expansion, or a sidebar Depot out by one) worked by
 * EXPANSION_MINERS harvesters. Left alone, harvesters only ever mine the
 * field nearest where they stand, so an expansion's field sat untouched while
 * they walked out to the contested middle. Short ones are made up from the
 * home field's miners, nearest first, as soon as the Depot is up. Returns the
 * harvesters sent this think (the commander leaves them be) and how many the
 * Depots want on top of the one each already counts for.
 */
export function staffExpansions(
  w: World,
  faction: Faction,
  hqC: { x: number; y: number },
  harvesters: Unit[],
  skip: Set<number>,
  enemies: Unit[],
  cmds: Command[]
): { sent: Set<number>; extra: number } {
  const sent = new Set<number>();
  let extra = 0;
  const sites: { cx: number; cy: number; field: { x: number; y: number } }[] = [];
  for (const b of w.buildings.values()) {
    if (b.faction !== faction || b.kind !== "depot" || b.founding !== undefined) continue;
    const size = BUILDINGS.depot.size;
    const cx = b.tx + size / 2;
    const cy = b.ty + size / 2;
    const field = perTick(w, `depot field ${b.id}`, () => fieldBy(w, faction, cx, cy));
    if (!field || dist(field.x + 0.5, field.y + 0.5, hqC.x, hqC.y) <= HOME_FIELD) continue;
    sites.push({ cx, cy, field });
  }
  if (!sites.length) return { sent, extra };
  const servedBy = (h: Unit) => {
    const o = h.order;
    if (o.type !== "harvest") return -1;
    return sites.findIndex((s) => dist(o.fieldX + 0.5, o.fieldY + 0.5, s.cx, s.cy) <= SERVED);
  };
  const free = harvesters.filter((h) => !skip.has(h.id) && (h.order.type === "idle" || h.order.type === "harvest"));
  let home = free.filter((h) => servedBy(h) < 0);
  for (const [i, s] of sites.entries()) {
    extra += EXPANSION_MINERS - 1;
    const have = harvesters.filter((h) => servedBy(h) === i).length;
    if (have >= EXPANSION_MINERS) continue;
    if (enemies.some((e) => UNITS[e.kind].dps > 0 && dist(e.x, e.y, s.cx, s.cy) <= UNSAFE)) continue;
    const take = Math.min(EXPANSION_MINERS - have, home.length - HOME_MINERS);
    if (take <= 0) continue;
    const picks = home
      .map((h) => ({ h, d: dist(h.x, h.y, s.cx, s.cy) }))
      .sort((a, b) => a.d - b.d || a.h.id - b.h.id)
      .slice(0, take)
      .map((p) => p.h);
    for (const h of picks) sent.add(h.id);
    home = home.filter((h) => !sent.has(h.id));
    cmds.push({ type: "harvest", faction, unitIds: picks.map((h) => h.id), x: s.field.x + 0.5, y: s.field.y + 0.5 });
  }
  return { sent, extra };
}

/**
 * Run the side's expansion (call once per think). With `want` (the build
 * order's next Depot is an expansion), the scrap nearly there and `keep`
 * harvesters besides the crew to go on mining: pick a site, and send a crew
 * to found it (economy.ts `found`: they pay and turn into the Depot once
 * they're all there). Returns the crew's ids: the commander leaves them be.
 */
export function tendExpansion(
  w: World,
  faction: Faction,
  s: { expansion?: ExpansionPlan | null },
  want: boolean,
  hqC: { x: number; y: number } | null,
  harvesters: Unit[],
  skip: Set<number>,
  /** Harvesters to leave mining: the crew is on top of them. */
  keep: number,
  reach: number,
  cmds: Command[]
): Set<number> {
  const E = ECONOMY.expansion;
  const f = w.factions[faction];
  const plan = s.expansion;
  const size = BUILDINGS.depot.size;
  if (plan && plan.depotId === undefined) {
    // founded since the last think? (the Depot now stands on the site)
    const b = [...w.buildings.values()].find((d) => d.faction === faction && d.kind === "depot" && d.tx === plan.tx && d.ty === plan.ty);
    if (b) plan.depotId = b.id;
  }
  if (plan?.depotId !== undefined) {
    const b = w.buildings.get(plan.depotId);
    if (!b || b.founding === undefined || E.consume) {
      s.expansion = null;
      return new Set();
    }
    return new Set(plan.crew); // (not used up: they wait by it till it's up)
  }
  if (plan) {
    const onIt = (u: Unit | undefined): u is Unit =>
      !!u && u.faction === faction && u.order.type === "found" && u.order.tx === plan.tx && u.order.ty === plan.ty;
    const crew = plan.crew.map((id) => w.units.get(id)).filter(onIt);
    // (a beat for the order to land: an APM cap may hold it back)
    const lost = (w.tick - plan.since > TICK_RATE * 2 && crew.length < E.crew) || w.tick - plan.since > STALE;
    if (lost) {
      s.expansion = null;
      if (crew.length) cmds.push({ type: "stop", faction, unitIds: crew.map((u) => u.id) });
      return new Set();
    }
    if (crew.length < E.crew && w.tick - plan.since <= TICK_RATE * 2) return new Set(plan.crew);
    // our own units standing on the site step off it (the crew may stay: they're used up)
    const cx = plan.tx + size / 2;
    const cy = plan.ty + size / 2;
    const off = [...w.units.values()].filter(
      (u) => u.faction === faction && u.kind !== "harvester" && UNITS[u.kind].domain === "ground" &&
        u.x >= plan.tx && u.x < plan.tx + size && u.y >= plan.ty && u.y < plan.ty + size && u.order.type !== "move"
    );
    if (off.length) cmds.push({ type: "move", faction, unitIds: off.map((u) => u.id), x: cx + (cx < w.width / 2 ? 2.5 : -2.5), y: cy });
    return new Set(plan.crew);
  }
  if (!want || !hqC) return new Set();
  // nearly enough scrap: it comes in while the crew walks (and it's paid when they get there)
  if (f.scrap < E.cost * 0.7) return new Set();
  const free = harvesters.filter((h) => !skip.has(h.id));
  if (free.length < E.crew + keep) return new Set();
  const site = expansionSite(w, faction, hqC, reach);
  if (!site) return new Set();
  const cx = site.tx + size / 2;
  const cy = site.ty + size / 2;
  const crew = free
    .map((u) => ({ u, d: dist(u.x, u.y, cx, cy) }))
    .sort((a, b) => a.d - b.d || a.u.id - b.u.id)
    .slice(0, E.crew)
    .map((c) => c.u);
  s.expansion = { tx: site.tx, ty: site.ty, crew: crew.map((u) => u.id), since: w.tick };
  cmds.push({ type: "found", faction, unitIds: crew.map((u) => u.id), tx: site.tx, ty: site.ty });
  return new Set(s.expansion.crew);
}
