import { BUILDINGS, ECONOMY, TICK_RATE, UNITS } from "../balance";
import { foundBlocker } from "../economy";
import { findPath } from "../movement";
import type { Command, Faction, Unit, World } from "../types";
import { dist, isResource, sideFrame, tileIndex } from "../world";

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

/**
 * The nearest field to the HQ that no drop-off within `reach` serves (a
 * Depot still going up counts: it will), or null.
 */
export function unservedField(w: World, faction: Faction, hqC: { x: number; y: number }, reach: number): { x: number; y: number; d: number } | null {
  const drops = [...w.buildings.values()].filter((b) => b.faction === faction && BUILDINGS[b.kind].dropOff);
  const fr = sideFrame(w, faction); // scanned in the side's own frame (mirror-fair ties)
  let best: { x: number; y: number; d: number } | null = null;
  for (let fy = 0; fy < w.height; fy++)
    for (let fx = 0; fx < w.width; fx++) {
      const [tx, ty] = fr.tile(fx, fy, 1);
      if (!isResource(w, tileIndex(w, tx, ty))) continue;
      const x = tx + 0.5;
      const y = ty + 0.5;
      if (drops.some((b) => dist(x, y, b.tx + BUILDINGS[b.kind].size / 2, b.ty + BUILDINGS[b.kind].size / 2) < reach)) continue;
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
      best = { tx, ty };
      bestD = d;
    }
  if (!best) return null;
  const [bx, by] = fr.vec(0, 2.5);
  if (!findPath(w, hqC.x + bx, hqC.y + by, best.tx + size / 2, best.ty + size / 2, "ground", faction)) return null;
  return best;
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
