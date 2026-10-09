import { BUILDINGS, TERRAIN, TICK_RATE, UNITS } from "./balance";
import { crushes, isInfantry, tickCrush } from "./infantry";
import { Terrain, type Faction, type Unit, type World } from "./types";
import { inBounds, moveClassOf, passable, terrainMult, terrainSpeed, type MoveClass } from "./world";

const ARRIVE_DIST = 0.25;
/** Consume en-route waypoints loosely — tight radii livelock grouped units. */
const WAYPOINT_DIST = 0.7;
/** Fastest terrain speed multiplier (roads) — keeps the A* heuristic admissible. */
const MAX_TERRAIN_SPEED = Math.max(...Object.values(TERRAIN).map((t) => Math.max(t.speed, t.hoverSpeed, t.footSpeed)));

/**
 * Arrival radius at a final destination, growing with the crowd already
 * parked there: N units can't all touch the same point (separation keeps
 * them ~0.7 apart), so each neighbour near the goal widens "arrived".
 */
function arrivalRadius(w: World, u: Unit, gx: number, gy: number): number {
  let crowd = 0;
  for (const o of w.units.values()) {
    if (o.id === u.id || UNITS[o.kind].domain !== UNITS[u.kind].domain) continue;
    if (Math.hypot(o.x - gx, o.y - gy) < 0.9) crowd++;
  }
  return Math.min(2, ARRIVE_DIST + 0.4 * crowd);
}

/** Per-step cost multiplier of entering a tile (slow terrain costs more). */
function stepCost(w: World, idx: number, mc: MoveClass): number {
  return 1 / (terrainMult(TERRAIN[w.terrain[idx] as Terrain], mc) || 1);
}

/**
 * 8-directional A* over the tile grid, weighted by terrain speed (roads are
 * preferred, mud and woods avoided). Returns tile-centre waypoints.
 */
export function findPath(
  w: World,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  mc: MoveClass = "ground",
  faction?: Faction
): { x: number; y: number }[] | null {
  const pass = (x: number, y: number) => passable(w, x, y, mc);
  // scan orders run in the side's own frame (red's is blue's turned 180°), so
  // equal-cost ties resolve as mirror images for the two sides (see sideFrame)
  const s = faction === "red" ? -1 : 1;
  // the tile under a point, floored in that frame too: a point on a tile edge
  // (e.g. an Uplink at (28, 28)) belongs to the tile on the side's own far side
  const tileX = (x: number) => (s > 0 ? Math.floor(x) : w.width - 1 - Math.floor(w.width - x));
  const tileY = (y: number) => (s > 0 ? Math.floor(y) : w.height - 1 - Math.floor(w.height - y));
  const sx = tileX(fromX);
  const sy = tileY(fromY);
  let gx = tileX(toX);
  let gy = tileY(toY);
  if (!inBounds(w, gx, gy)) {
    gx = Math.max(0, Math.min(w.width - 1, gx));
    gy = Math.max(0, Math.min(w.height - 1, gy));
  }
  // If the goal tile itself is blocked, walk to the nearest passable tile
  // around it (spiral search, small radius), preferring ones nearer to us.
  if (!pass(gx, gy)) {
    let found: { x: number; y: number } | null = null;
    for (let r = 1; r <= 6 && !found; r++) {
      let bestD = Infinity;
      for (let i = -r; i <= r; i++)
        for (let j = -r; j <= r; j++) {
          const dy = i * s;
          const dx = j * s;
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (!pass(gx + dx, gy + dy)) continue;
          const d = Math.hypot(gx + dx - sx, gy + dy - sy);
          if (d < bestD) {
            bestD = d;
            found = { x: gx + dx, y: gy + dy };
          }
        }
    }
    if (!found) return null;
    gx = found.x;
    gy = found.y;
  }
  if (sx === gx && sy === gy) return [{ x: gx + 0.5, y: gy + 0.5 }];

  const W = w.width;
  const H = w.height;
  const n = W * H;
  const gScore = new Float32Array(n).fill(Infinity);
  const cameFrom = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const startIdx = sy * W + sx;
  const goalIdx = gy * W + gx;
  gScore[startIdx] = 0;
  // simple binary heap of [f, idx]
  const heap: number[] = [];
  const push = (f: number, idx: number) => {
    heap.push(f, idx);
    let i = heap.length / 2 - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p * 2]! <= heap[i * 2]!) break;
      for (let k = 0; k < 2; k++) {
        const t = heap[p * 2 + k]!;
        heap[p * 2 + k] = heap[i * 2 + k]!;
        heap[i * 2 + k] = t;
      }
      i = p;
    }
  };
  const pop = (): number => {
    const idx = heap[1]!;
    const last = heap.length - 2;
    heap[0] = heap[last]!;
    heap[1] = heap[last + 1]!;
    heap.length = last;
    let i = 0;
    const size = heap.length / 2;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let m = i;
      if (l < size && heap[l * 2]! < heap[m * 2]!) m = l;
      if (r < size && heap[r * 2]! < heap[m * 2]!) m = r;
      if (m === i) break;
      for (let k = 0; k < 2; k++) {
        const t = heap[m * 2 + k]!;
        heap[m * 2 + k] = heap[i * 2 + k]!;
        heap[i * 2 + k] = t;
      }
      i = m;
    }
    return idx;
  };
  const h = (idx: number) => {
    const dx = Math.abs((idx % W) - gx);
    const dy = Math.abs(Math.floor(idx / W) - gy);
    return (Math.max(dx, dy) + 0.4142 * Math.min(dx, dy)) / MAX_TERRAIN_SPEED;
  };
  push(h(startIdx), startIdx);

  while (heap.length > 0) {
    const cur = pop();
    if (cur === goalIdx) {
      const path: { x: number; y: number }[] = [];
      for (let idx = goalIdx; idx !== startIdx; idx = cameFrom[idx]!)
        path.push({ x: (idx % W) + 0.5, y: Math.floor(idx / W) + 0.5 });
      path.reverse();
      return path;
    }
    if (closed[cur]) continue;
    closed[cur] = 1;
    const cx = cur % W;
    const cy = Math.floor(cur / W);
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++) {
        const dy = i * s;
        const dx = j * s;
        if (dx === 0 && dy === 0) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (!pass(nx, ny)) continue;
        // no diagonal corner-cutting past blocked orthogonals
        if (dx !== 0 && dy !== 0 && (!pass(cx + dx, cy) || !pass(cx, cy + dy))) continue;
        const nIdx = ny * W + nx;
        if (closed[nIdx]) continue;
        const cost = (dx !== 0 && dy !== 0 ? 1.4142 : 1) * stepCost(w, nIdx, mc);
        const g = gScore[cur]! + cost;
        if (g < gScore[nIdx]!) {
          gScore[nIdx] = g;
          cameFrom[nIdx] = cur;
          push(g + h(nIdx), nIdx);
        }
      }
  }
  return null; // unreachable
}

/** Tiles per tick this unit moves at its current position. */
export function unitStepSpeed(w: World, u: Unit): number {
  return (UNITS[u.kind].speed / TICK_RATE) * terrainSpeed(w, u.x, u.y, moveClassOf(u.kind));
}

/**
 * Advance a unit one tick toward (x, y). Ground units follow an A* path
 * (computed/cached here); air units fly straight. Returns true on arrival.
 */
export function moveUnitToward(w: World, u: Unit, x: number, y: number): boolean {
  const mc = moveClassOf(u.kind);
  const speed = unitStepSpeed(w, u);
  if (mc === "air") {
    const d = Math.hypot(x - u.x, y - u.y);
    if (d <= Math.max(arrivalRadius(w, u, x, y), speed)) {
      return true;
    }
    u.facing = Math.atan2(x - u.x, -(y - u.y));
    u.x += ((x - u.x) / d) * speed;
    u.y += ((y - u.y) / d) * speed;
    return false;
  }

  // ground: (re)plan when the goal changed or the path is exhausted/blocked
  if (
    !u.path ||
    !u.pathGoal ||
    Math.hypot(u.pathGoal.x - x, u.pathGoal.y - y) > 0.6
  ) {
    u.path = findPath(w, u.x, u.y, x, y, mc, u.faction);
    u.pathGoal = { x, y };
    if (!u.path) return true; // unreachable: give up (caller goes idle)
  }
  let wp = u.path[0];
  while (wp) {
    const consume = u.path.length > 1 ? WAYPOINT_DIST : arrivalRadius(w, u, wp.x, wp.y);
    if (Math.hypot(wp.x - u.x, wp.y - u.y) > consume) break;
    u.path.shift();
    wp = u.path[0];
  }
  if (!wp) {
    u.path = null;
    u.pathGoal = null;
    return true;
  }
  if (!passable(w, Math.floor(wp.x), Math.floor(wp.y), mc)) {
    // world changed under the path (new building etc.) — replan next tick
    u.path = null;
    return false;
  }
  const d = Math.hypot(wp.x - u.x, wp.y - u.y);
  const step = Math.min(speed, d);
  u.facing = Math.atan2(wp.x - u.x, -(wp.y - u.y));
  u.x += ((wp.x - u.x) / d) * step;
  u.y += ((wp.y - u.y) / d) * step;
  return false;
}

/** Where to drive to reach a building: the nearest point of its footprint. */
export function approachPoint(
  w: World,
  u: Unit,
  targetId: number
): { x: number; y: number } | null {
  const t = w.units.get(targetId);
  if (t) return { x: t.x, y: t.y };
  const b = w.buildings.get(targetId);
  if (!b) return null;
  const size = BUILDINGS[b.kind].size;
  return {
    x: Math.max(b.tx + 0.5, Math.min(b.tx + size - 0.5, u.x)),
    y: Math.max(b.ty + 0.5, Math.min(b.ty + size - 0.5, u.y))
  };
}

/**
 * Per-tick movement for move / attack-move orders (combat may pause it),
 * then separation, then crushing: a Titan that drove this tick rolls over
 * the enemy squads under it (infantry.ts).
 */
export function tickMovement(w: World, pausedIds: Set<number>): void {
  /** Where each crusher stood before it moved (to tell who actually drove). */
  const crushers: { u: Unit; x: number; y: number }[] = [];
  for (const u of w.units.values()) if (crushes(u.kind)) crushers.push({ u, x: u.x, y: u.y });
  for (const u of w.units.values()) {
    const o = u.order;
    if (pausedIds.has(u.id)) continue;
    if (o.type === "move" || o.type === "attackMove") {
      if (moveUnitToward(w, u, o.x, o.y)) u.order = { type: "idle" };
    } else if (o.type === "attack") {
      const p = approachPoint(w, u, o.targetId);
      if (!p) {
        u.order = { type: "idle" };
        continue;
      }
      const minRange = UNITS[u.kind].minRange ?? 0;
      const d = Math.hypot(p.x - u.x, p.y - u.y);
      if (minRange > 0 && d < minRange) {
        // artillery: back off out of minimum range instead of closing in
        const k = (minRange + 0.8) / Math.max(d, 0.01);
        moveUnitToward(w, u, p.x + (u.x - p.x) * k, p.y + (u.y - p.y) * k);
      } else {
        moveUnitToward(w, u, p.x, p.y); // combat pauses it once in range
      }
    }
  }
  const moved = crushers.filter((c) => c.u.x !== c.x || c.u.y !== c.y).map((c) => c.u);
  separate(w);
  if (moved.length > 0) tickCrush(w, moved);
}

const KIND_INDEX: Record<string, number> = Object.fromEntries(Object.keys(UNITS).map((k, i) => [k, i]));

/**
 * Gentle separation so same-domain units don't stack. Robot infantry give
 * way: a squad and a FRIENDLY vehicle part by moving only the squad (it
 * steps aside), and a squad and an ENEMY vehicle don't part at all (tanks
 * roll through squads — and Titans crush them). Squads among themselves,
 * and vehicles among themselves, share the push as usual.
 */
function separate(w: World): void {
  const units = [...w.units.values()];
  for (let i = 0; i < units.length; i++) {
    const a = units[i]!;
    const da = UNITS[a.kind].domain;
    const ia = isInfantry(a.kind);
    for (let j = i + 1; j < units.length; j++) {
      const b = units[j]!;
      if (UNITS[b.kind].domain !== da) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      if (Math.abs(dx) > 1.2 || Math.abs(dy) > 1.2) continue;
      const ib = isInfantry(b.kind);
      if (ia !== ib && a.faction !== b.faction) continue; // enemy vehicle and squad: drive through
      const d = Math.hypot(dx, dy);
      const minD = Math.max(0.7, UNITS[a.kind].radius + UNITS[b.kind].radius);
      if (d >= minD) continue;
      const push = (minD - d) / 2;
      let ux: number;
      let uy: number;
      if (d < 1e-3) {
        // perfectly coincident (e.g. spawned at the same tile centre): no
        // direction to push along, so derive one deterministically — for a
        // side's own pair from kinds and the clock, turned 180° for red, so
        // both sides' mirror-image pairs split as mirror images
        const angle =
          a.faction === b.faction
            ? ((KIND_INDEX[a.kind]! * 7 + KIND_INDEX[b.kind]! * 13 + w.tick) % 16) * (Math.PI / 8) +
              (a.faction === "red" ? Math.PI : 0)
            : ((a.id * 7 + b.id * 13) % 16) * (Math.PI / 8);
        ux = Math.sin(angle);
        uy = -Math.cos(angle);
      } else {
        ux = dx / d;
        uy = dy / d;
      }
      if (ia !== ib) {
        // a squad steps aside for a friendly vehicle: it takes the whole push
        const [veh, squad, sx, sy] = ia ? [b, a, -ux, -uy] : [a, b, ux, uy];
        const s = stepAside(veh, sx, sy);
        nudge(w, squad, s.x * push * 2, s.y * push * 2);
        continue;
      }
      nudge(w, a, -ux * push, -uy * push);
      nudge(w, b, ux * push, uy * push);
    }
  }
}

/**
 * Which way a squad in a vehicle's way gives ground: straight away from it,
 * or — when it stands in front — sideways off the vehicle's line of travel,
 * to whichever side it is already on (dead ahead: the vehicle's right, which
 * turns with the vehicle, so mirror-image pairs part as mirror images).
 * (dx, dy) is the unit vector from the vehicle to the squad.
 */
function stepAside(v: Unit, dx: number, dy: number): { x: number; y: number } {
  const fx = Math.sin(v.facing);
  const fy = -Math.cos(v.facing);
  if (dx * fx + dy * fy <= 0) return { x: dx, y: dy }; // beside or behind it: just back off
  const rx = -fy; // the vehicle's right hand
  const ry = fx;
  const side = dx * rx + dy * ry;
  const s = side < -1e-6 ? -1 : 1;
  return { x: rx * s, y: ry * s };
}

function nudge(w: World, u: Unit, dx: number, dy: number): void {
  const nx = Math.min(w.width - 0.05, Math.max(0.05, u.x + dx));
  const ny = Math.min(w.height - 0.05, Math.max(0.05, u.y + dy));
  if (passable(w, Math.floor(nx), Math.floor(ny), moveClassOf(u.kind))) {
    u.x = nx;
    u.y = ny;
  }
}
