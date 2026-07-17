import { TICK_RATE, UNITS } from "./balance";
import type { Unit, World } from "./types";
import { groundPassable, inBounds } from "./world";

const ARRIVE_DIST = 0.25;
/** Consume en-route waypoints loosely — tight radii livelock grouped units. */
const WAYPOINT_DIST = 0.7;

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

/** 8-directional A* over the tile grid. Returns tile-centre waypoints. */
export function findPath(
  w: World,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number
): { x: number; y: number }[] | null {
  const sx = Math.floor(fromX);
  const sy = Math.floor(fromY);
  let gx = Math.floor(toX);
  let gy = Math.floor(toY);
  if (!inBounds(w, gx, gy)) {
    gx = Math.max(0, Math.min(w.width - 1, gx));
    gy = Math.max(0, Math.min(w.height - 1, gy));
  }
  // If the goal tile itself is blocked, walk to the nearest passable tile
  // around it (spiral search, small radius).
  if (!groundPassable(w, gx, gy)) {
    let found = false;
    outer: for (let r = 1; r <= 6 && !found; r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (groundPassable(w, gx + dx, gy + dy)) {
            gx += dx;
            gy += dy;
            found = true;
            break outer;
          }
        }
    if (!found) return null;
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
    return Math.max(dx, dy) + 0.4142 * Math.min(dx, dy);
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
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (!groundPassable(w, nx, ny)) continue;
        // no diagonal corner-cutting past blocked orthogonals
        if (dx !== 0 && dy !== 0 && (!groundPassable(w, cx + dx, cy) || !groundPassable(w, cx, cy + dy)))
          continue;
        const nIdx = ny * W + nx;
        if (closed[nIdx]) continue;
        const cost = dx !== 0 && dy !== 0 ? 1.4142 : 1;
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

/**
 * Advance a unit one tick toward (x, y). Ground units follow an A* path
 * (computed/cached here); air units fly straight. Returns true on arrival.
 */
export function moveUnitToward(w: World, u: Unit, x: number, y: number): boolean {
  const stats = UNITS[u.kind];
  const speed = stats.speed / TICK_RATE;
  if (stats.domain === "air") {
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
    u.path = findPath(w, u.x, u.y, x, y);
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
  if (!groundPassable(w, Math.floor(wp.x), Math.floor(wp.y))) {
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

/** Per-tick movement for move / attack-move orders (combat may pause it). */
export function tickMovement(w: World, pausedIds: Set<number>): void {
  for (const u of w.units.values()) {
    const o = u.order;
    if (pausedIds.has(u.id)) continue;
    if (o.type === "move" || o.type === "attackMove") {
      if (moveUnitToward(w, u, o.x, o.y)) u.order = { type: "idle" };
    } else if (o.type === "attack") {
      const target = w.units.get(o.targetId) ?? null;
      const b = target ? null : w.buildings.get(o.targetId) ?? null;
      if (!target && !b) {
        u.order = { type: "idle" };
        continue;
      }
      const tx = target ? target.x : b!.tx + 0.5;
      const ty = target ? target.y : b!.ty + 0.5;
      moveUnitToward(w, u, tx, ty); // combat pauses it once in range
    }
  }
  separate(w);
}

/** Gentle separation so same-domain units don't stack. */
function separate(w: World): void {
  const units = [...w.units.values()];
  for (let i = 0; i < units.length; i++)
    for (let j = i + 1; j < units.length; j++) {
      const a = units[i]!;
      const b = units[j]!;
      if (UNITS[a.kind].domain !== UNITS[b.kind].domain) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      const minD = 0.7;
      if (d >= minD) continue;
      const push = (minD - d) / 2;
      let ux: number;
      let uy: number;
      if (d < 1e-3) {
        // perfectly coincident (e.g. spawned at the same tile centre): no
        // direction to push along, so derive one deterministically from ids
        const angle = ((a.id * 7 + b.id * 13) % 16) * (Math.PI / 8);
        ux = Math.sin(angle);
        uy = -Math.cos(angle);
      } else {
        ux = dx / d;
        uy = dy / d;
      }
      nudge(w, a, -ux * push, -uy * push);
      nudge(w, b, ux * push, uy * push);
    }
}

function nudge(w: World, u: Unit, dx: number, dy: number): void {
  const nx = Math.min(w.width - 0.05, Math.max(0.05, u.x + dx));
  const ny = Math.min(w.height - 0.05, Math.max(0.05, u.y + dy));
  if (UNITS[u.kind].domain === "air" || groundPassable(w, Math.floor(nx), Math.floor(ny))) {
    u.x = nx;
    u.y = ny;
  }
}
