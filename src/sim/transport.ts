import { INFANTRY, TICK_RATE, UNITS } from "./balance";
import { isInfantry, isTransport } from "./infantry";
import { moveUnitToward } from "./movement";
import { isStunned } from "./powers";
import type { Command, Faction, Unit, World } from "./types";
import { inBounds, passable, sideFrame } from "./world";

/**
 * The Condor dropship (INFANTRY.md). Infantry squads BOARD it — walk up, and
 * after INFANTRY.boardTime within INFANTRY.boardRange they are taken off the
 * map into `condor.passengers` — and it UNLOADS them: flies to a drop point,
 * hovers INFANTRY.unloadHover, and puts them back (same ids) around the point.
 *
 * Passengers are OUT of `World.units` while aboard, so every system that walks
 * the units (combat, vision, capture, targeting, salvage) ignores them for
 * free. Code that must still find a squad aboard uses findUnit / carrierOf.
 *
 * Shot down: over ground a squad could stand on the passengers bail out hurt;
 * over water or rock they are lost with it (combat.ts cleanupDeaths).
 */

// ----------------------------------------------------------- helpers ---

/** A unit by id, on the field or aboard a Condor (null when it is gone). */
export function findUnit(w: World, id: number): Unit | null {
  const u = w.units.get(id);
  if (u) return u;
  for (const c of w.units.values()) {
    if (!c.passengers?.length) continue;
    for (const p of c.passengers) if (p.id === id) return p;
  }
  return null;
}

/** The Condor carrying unit `unitId`, or null when it is not aboard one. */
export function carrierOf(w: World, unitId: number): Unit | null {
  for (const c of w.units.values()) if (c.passengers?.some((p) => p.id === unitId)) return c;
  return null;
}

/** Seats left aboard a transport (0 for anything that carries nothing). */
export function freeSeats(c: Unit): number {
  return Math.max(0, (UNITS[c.kind].capacity ?? 0) - (c.passengers?.length ?? 0));
}

/** Is this a transport with anyone aboard? */
export function isLoaded(c: Unit): boolean {
  return (c.passengers?.length ?? 0) > 0;
}

/** Can a squad stand on this tile? (Foot-passable ground, no building on it.) */
const standable = (w: World, tx: number, ty: number): boolean => passable(w, tx, ty, "foot");

/**
 * Where infantry dropped at (x, y) by `faction` touch down: the point itself
 * when a squad can stand there, else the nearest point (kept off tile edges)
 * of a tile it can stand on within INFANTRY.dropSearch — never Water, Rock or
 * a building. Scanned in the side's own frame, so red's choice is always the
 * mirror image of blue's. Null when there is nowhere within reach.
 */
export function dropPoint(w: World, faction: Faction, x: number, y: number): { x: number; y: number } | null {
  const fr = sideFrame(w, faction);
  const p = fr.pt({ x, y });
  const fx0 = Math.floor(p.x);
  const fy0 = Math.floor(p.y);
  const ok = (fx: number, fy: number) => {
    const [tx, ty] = fr.tile(fx, fy, 1);
    return inBounds(w, tx, ty) && standable(w, tx, ty);
  };
  if (ok(fx0, fy0)) return { x, y };
  const R = INFANTRY.dropSearch;
  const span = Math.ceil(R);
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  // fixed (frame) scan order + strict comparison: deterministic, mirror-fair ties
  for (let dy = -span; dy <= span; dy++)
    for (let dx = -span; dx <= span; dx++) {
      const fx = fx0 + dx;
      const fy = fy0 + dy;
      if (!ok(fx, fy)) continue;
      const cx = Math.max(fx + 0.2, Math.min(fx + 0.8, p.x));
      const cy = Math.max(fy + 0.2, Math.min(fy + 0.8, p.y));
      const d = Math.hypot(cx - p.x, cy - p.y);
      if (d > R || d >= bestD) continue;
      bestD = d;
      best = { x: cx, y: cy };
    }
  return best ? fr.pt(best) : null;
}

/**
 * Where passenger i of n steps off around a drop point: a small ring (in the
 * side's own frame), or the point itself when that spot is no good.
 */
function seatSpot(w: World, faction: Faction, x: number, y: number, i: number, n: number): { x: number; y: number } {
  if (n <= 1) return { x, y };
  const a = (i / n) * Math.PI * 2 + 0.4 + (faction === "red" ? Math.PI : 0);
  const px = x + Math.sin(a) * 0.45;
  const py = y - Math.cos(a) * 0.45;
  return inBounds(w, Math.floor(px), Math.floor(py)) && standable(w, Math.floor(px), Math.floor(py)) ? { x: px, y: py } : { x, y };
}

/** Put a Condor's passengers back on the field around (x, y); returns their ids. */
function disembarkAll(w: World, c: Unit, x: number, y: number, bailout: boolean): number[] {
  const ps = c.passengers ?? [];
  const ids: number[] = [];
  ps.forEach((p, i) => {
    const s = seatSpot(w, c.faction, x, y, i, ps.length);
    p.x = s.x;
    p.y = s.y;
    p.facing = p.aim = c.facing;
    p.order = { type: "idle" };
    p.path = null;
    p.pathGoal = null;
    p.autoTargetId = null;
    if (bailout) p.hp = Math.min(p.hp, UNITS[p.kind].hp * INFANTRY.bailoutHp);
    w.units.set(p.id, p);
    ids.push(p.id);
  });
  c.passengers = [];
  if (ids.length > 0) w.fx.push({ type: "disembark", faction: c.faction, carrierId: c.id, unitIds: ids, x, y, bailout });
  return ids;
}

// ---------------------------------------------------------- shot down ---

/** Is the Condor over ground its passengers could bail out onto? (Not Water, Rock or a building.) */
export function canBailOut(w: World, c: Unit): boolean {
  const tx = Math.floor(c.x);
  const ty = Math.floor(c.y);
  return inBounds(w, tx, ty) && standable(w, tx, ty);
}

/**
 * A Condor was shot down over walkable ground (cleanupDeaths): its passengers
 * bail out where it fell, each with at most INFANTRY.bailoutHp of its max HP.
 * Returns their ids.
 */
export function bailOut(w: World, c: Unit): number[] {
  return disembarkAll(w, c, c.x, c.y, true);
}

// ----------------------------------------------------------- commands ---

/** Apply a `board` or `unload` command (validated: own units of the right kinds only). */
export function applyTransportCommand(w: World, c: Extract<Command, { type: "board" | "unload" }>): void {
  if (c.type === "board") {
    const carrier = w.units.get(c.carrierId);
    if (!carrier || carrier.faction !== c.faction || !isTransport(carrier.kind)) return;
    for (const id of c.unitIds) {
      // (a squad already aboard is not on the field: w.units misses it and it is ignored)
      const u = w.units.get(id);
      if (!u || u.faction !== c.faction || !isInfantry(u.kind)) continue;
      u.order = { type: "board", carrierId: carrier.id, ticks: 0 };
      u.path = null;
      u.autoTargetId = null;
    }
    return;
  }
  for (const id of c.unitIds) {
    const u = w.units.get(id);
    if (!u || u.faction !== c.faction || !isLoaded(u)) continue;
    const hasPoint = Number.isFinite(c.x) && Number.isFinite(c.y);
    const at = dropPoint(w, u.faction, hasPoint ? c.x! : u.x, hasPoint ? c.y! : u.y);
    if (!at) continue; // nowhere within reach a squad could stand
    u.order = { type: "unload", x: at.x, y: at.y, hover: -1 };
    u.path = null;
    u.autoTargetId = null;
  }
}

// --------------------------------------------------------------- tick ---

/**
 * Per tick, after combat and before movement: boarding squads walk to their
 * Condor and climb in; idle Condors drift to meet squads boarding them;
 * unloading Condors fly to the drop point, hover, and put their squads down.
 * EMP-stunned squads and Condors pause. Passengers ride along (their x/y
 * follow the Condor, for the UI).
 */
export function tickTransport(w: World): void {
  const boardTicks = Math.round(INFANTRY.boardTime * TICK_RATE);
  const hoverTicks = Math.round(INFANTRY.unloadHover * TICK_RATE);
  /** Condor id → the squads walking to board it (for idle Condors to meet). */
  const boarders = new Map<number, Unit[]>();
  /** Condors a squad is climbing into right now: they hold still until it is aboard. */
  const climbing = new Set<number>();

  // collected first: embarking takes squads out of w.units, dropping puts them back
  const boarding: Unit[] = [];
  const transports: Unit[] = [];
  for (const u of w.units.values()) {
    if (u.order.type === "board") boarding.push(u);
    else if (u.passengers) transports.push(u);
  }
  for (const u of boarding) {
    if (u.order.type !== "board" || u.hp <= 0) continue;
    const o = u.order;
    const c = w.units.get(o.carrierId);
    if (!c || c.hp <= 0 || c.faction !== u.faction || freeSeats(c) === 0) {
      u.order = { type: "idle" }; // carrier gone or full
      u.path = null;
      continue;
    }
    if (isStunned(w, u.id)) continue; // EMP'd: frozen in place, the clock stops
    const d = Math.hypot(c.x - u.x, c.y - u.y);
    if (d > INFANTRY.boardRange) {
      o.ticks = 0;
      moveUnitToward(w, u, c.x, c.y);
      const list = boarders.get(c.id);
      if (list) list.push(u);
      else boarders.set(c.id, [u]);
      continue;
    }
    u.path = null;
    climbing.add(c.id);
    if (++o.ticks < boardTicks) continue;
    // climb aboard (from where it stands): off the field, into the hold
    w.fx.push({ type: "embark", faction: u.faction, carrierId: c.id, unitId: u.id, x: u.x, y: u.y });
    w.units.delete(u.id);
    u.order = { type: "idle" };
    u.pathGoal = null;
    u.autoTargetId = null;
    u.x = c.x;
    u.y = c.y;
    c.passengers!.push(u);
  }

  for (const c of transports) {
    if (c.hp <= 0) continue;
    const stunned = isStunned(w, c.id);
    if (c.order.type === "unload" && !stunned) {
      const o = c.order;
      if (!isLoaded(c)) {
        c.order = { type: "idle" }; // nothing left to drop
      } else if (o.hover < 0) {
        if (moveUnitToward(w, c, o.x, o.y)) o.hover = 0;
      } else if (++o.hover >= hoverTicks) {
        // re-validated: a building may have gone up on the spot meanwhile
        const at = dropPoint(w, c.faction, o.x, o.y);
        if (at) disembarkAll(w, c, at.x, at.y, false);
        c.order = { type: "idle" };
      }
    } else if (c.order.type === "idle" && !stunned && freeSeats(c) > 0 && !climbing.has(c.id)) {
      // an idle Condor comes to meet the nearest squad boarding it (not drifting off one that is climbing in)
      let near: Unit | null = null;
      let nearD = Infinity;
      for (const s of boarders.get(c.id) ?? []) {
        const d = Math.hypot(s.x - c.x, s.y - c.y);
        if (d < nearD) {
          nearD = d;
          near = s;
        }
      }
      if (near && nearD > INFANTRY.boardRange * 0.6) moveUnitToward(w, c, near.x, near.y);
    }
    for (const p of c.passengers ?? []) {
      p.x = c.x;
      p.y = c.y;
    }
  }
}
