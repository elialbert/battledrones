import { BUILDINGS, TICK_RATE, UNITS } from "../balance";
import type { Command, Faction, Unit, World } from "../types";
import { dist, isResource, sideFrame } from "../world";
import { perTick, walkFromDrops } from "./expansion";

/**
 * Which field the AI's harvesters mine. Left alone, a harvester whose field
 * runs dry walks to the nearest one (economy.ts), and on Riverlands that was
 * the contested middle, not the untouched field behind the base's rocks: a
 * Brutal Marshal lost 22 harvesters there in 35 s to an army camped beside it
 * (replay -marshal-brutal, 3:22). So each think the fields are weighed: the
 * walk from our nearest drop-off — round any ground out past the base where
 * an enemy army was seen lately, more than ours there — plus how far out
 * toward the enemy they lie, and how crowded. A field with no safe way there
 * (the army sits by it, or across the way to it) is unsafe.
 *
 * An idle harvester is sent to the best field (the walk to it counted too),
 * and so is one on an unsafe field, or on one out past the base when the
 * best is better by a margin. With every field unsafe it waits behind the HQ.
 * Crowding only picks where one goes, never moves one: a Depot's shift
 * (ai/expansion.ts staffExpansions) is meant to crowd its field.
 */

/** A connected patch of scrap/crystal tiles. */
interface Field {
  /** Tile indices. */
  tiles: number[];
  cx: number;
  cy: number;
}

/** An enemy seen within this long still counts, where it was last seen. */
const MEMORY = 15 * TICK_RATE;
/** Ground this close to armed enemies is theirs... */
const DANGER_RADIUS = 7;
/** ...once they're worth this much (a pair of Stingers poking by is not an army)... */
const DANGER_VALUE = 500;
/** ...and more than our own armed units (and turrets) as close. */
const DANGER_OVER_OURS = 1;
/**
 * Exposure: a point's distance from our HQ over that plus its distance from the enemy's (0 at home,
 * ½ halfway). Past EXPOSED it's out beyond the base: a field there scores EXPOSURE_COST steps more
 * per unit (halfway out, 37), and only ground there is ever the enemy's (a raid in the base is the
 * defence's to beat: the miners stay, and run from fire as they always do).
 */
const EXPOSURE_COST = 150;
const EXPOSED = 0.25;
/** Score per harvester past one per tile (they get in each other's way). */
const CROWD_COST = 2;
/** A harvester moves only for a field this much better (steps), so they don't flicker between two. */
const MARGIN = 6;
/** Score per tile (as the crow flies) a harvester has to go to a field: of two alike, the nearer. */
const TRAVEL_COST = 0.5;

interface Sighting {
  x: number;
  y: number;
  value: number;
  tick: number;
}
/** Where each enemy was last seen, per AI (keyed by its AiState). */
const memory = new WeakMap<object, Map<number, Sighting>>();
/** When each harvester was last sent to a field, per AI. */
const sentAt = new WeakMap<object, Map<number, number>>();
/**
 * Idle again this soon after being sent: the field's out of its reach from where it stands (the
 * sim gives up on it). It's left to the commander's own search from there, not sent every think
 * (Frostbite: 300 orders, a tenth of a Hard Marshal's actions).
 */
const RETRY = 20 * TICK_RATE;

function remember(w: World, key: object, seen: Unit[]): Map<number, Sighting> {
  let m = memory.get(key);
  if (!m) memory.set(key, (m = new Map()));
  for (const e of seen)
    if (UNITS[e.kind].dps > 0 && e.kind !== "harvester") m.set(e.id, { x: e.x, y: e.y, value: UNITS[e.kind].cost, tick: w.tick });
  for (const [id, s] of m) if (w.tick - s.tick > MEMORY) m.delete(id);
  return m;
}

/** The fields left (scanned in the side's own frame, so ties fall the same way for both sides). */
function fieldsOf(w: World, faction: Faction): Field[] {
  return perTick(w, `fields ${faction}`, () => {
    const W = w.width;
    const seen = new Uint8Array(W * w.height);
    const out: Field[] = [];
    const fr = sideFrame(w, faction);
    for (let fy = 0; fy < w.height; fy++)
      for (let fx = 0; fx < W; fx++) {
        const [sx, sy] = fr.tile(fx, fy, 1);
        const start = sy * W + sx;
        if (seen[start] || !isResource(w, start)) continue;
        const tiles: number[] = [];
        const stack = [start];
        seen[start] = 1;
        let x = 0;
        let y = 0;
        while (stack.length) {
          const cur = stack.pop()!;
          tiles.push(cur);
          const cx = cur % W;
          const cy = Math.floor(cur / W);
          x += cx;
          y += cy;
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const nx = cx + dx;
              const ny = cy + dy;
              if (nx < 0 || ny < 0 || nx >= W || ny >= w.height) continue;
              const ni = ny * W + nx;
              if (!seen[ni] && isResource(w, ni)) {
                seen[ni] = 1;
                stack.push(ni);
              }
            }
        }
        out.push({ tiles, cx: x / tiles.length + 0.5, cy: y / tiles.length + 0.5 });
      }
    return out;
  });
}

/** Adds `value` to every tile within DANGER_RADIUS of (x, y). */
function stamp(w: World, grid: Float64Array, x: number, y: number, value: number): void {
  const r = DANGER_RADIUS;
  for (let ty = Math.max(0, Math.floor(y - r)); ty <= Math.min(w.height - 1, Math.floor(y + r)); ty++)
    for (let tx = Math.max(0, Math.floor(x - r)); tx <= Math.min(w.width - 1, Math.floor(x + r)); tx++)
      if (dist(tx + 0.5, ty + 0.5, x, y) <= r) grid[ty * w.width + tx]! += value;
}

/**
 * Send the harvesters to the fields worth mining (call once per think, after
 * the expansion crews and shifts have taken theirs: `skip`). `accept`: fields
 * we may mine at all (island maps: our side of the bridges). Returns the
 * harvesters it has seen to (`sent`: given an order; `held`: kept waiting
 * by the HQ, every field unsafe), for the commander to leave be.
 */
export function tendFields(
  w: World,
  faction: Faction,
  key: object,
  hqC: { x: number; y: number },
  enemyHome: { x: number; y: number },
  harvesters: Unit[],
  skip: Set<number>,
  seen: Unit[],
  own: Unit[],
  accept: ((tx: number, ty: number) => boolean) | null,
  cmds: Command[]
): { sent: Set<number>; held: Set<number> } {
  const sightings = remember(w, key, seen);
  let last = sentAt.get(key);
  if (!last) sentAt.set(key, (last = new Map()));
  for (const [id, t] of last) if (w.tick - t > RETRY || !w.units.has(id)) last.delete(id);
  const sent = new Set<number>();
  const held = new Set<number>();
  const W = w.width;
  const exposureAt = (x: number, y: number) => {
    const a = dist(x, y, hqC.x, hqC.y);
    const b = dist(x, y, enemyHome.x, enemyHome.y);
    return a + b > 0 ? a / (a + b) : 0;
  };
  // the enemy's ground: out past the base, by more of their army than ours
  let avoid: Uint8Array | undefined;
  let total = 0;
  for (const s of sightings.values()) total += s.value;
  if (total >= DANGER_VALUE) {
    const theirs = new Float64Array(W * w.height);
    const ours = new Float64Array(W * w.height);
    for (const s of sightings.values()) stamp(w, theirs, s.x, s.y, s.value);
    for (const u of own) if (UNITS[u.kind].dps > 0 && u.kind !== "harvester") stamp(w, ours, u.x, u.y, UNITS[u.kind].cost);
    for (const b of w.buildings.values())
      if (b.faction === faction && BUILDINGS[b.kind].dps > 0)
        stamp(w, ours, b.tx + BUILDINGS[b.kind].size / 2, b.ty + BUILDINGS[b.kind].size / 2, BUILDINGS[b.kind].cost);
    for (let i = 0; i < theirs.length; i++)
      if (theirs[i]! >= DANGER_VALUE && theirs[i]! > ours[i]! * DANGER_OVER_OURS && exposureAt((i % W) + 0.5, Math.floor(i / W) + 0.5) >= EXPOSED)
        (avoid ??= new Uint8Array(W * w.height))[i] = 1;
  }
  const walk = walkFromDrops(w, faction, avoid);
  const fields = fieldsOf(w, faction).filter((f) => !accept || accept(f.tiles[0]! % W, Math.floor(f.tiles[0]! / W)));
  // each field's way in: its tile nearest (on a safe walk) one of our drop-offs; none, it's unsafe
  // (a tie goes to the first in the side's own frame, so red picks blue's mirror image)
  const fr = sideFrame(w, faction);
  const frameIndex = (t: number) => {
    const p = fr.toFrame({ x: (t % W) + 0.5, y: Math.floor(t / W) + 0.5 });
    return Math.floor(p.y) * W + Math.floor(p.x);
  };
  const entry = fields.map((f) => {
    let best = -1;
    for (const t of f.tiles)
      if (walk[t]! >= 0 && (best < 0 || walk[t]! < walk[best]! || (walk[t] === walk[best] && frameIndex(t) < frameIndex(best)))) best = t;
    return best;
  });
  // (nowhere we can walk to at all, danger or none — no drop-off, or none by a field: the commander's own search)
  if (entry.every((e) => e < 0) && (!avoid || fields.every((f) => f.tiles.every((t) => walkFromDrops(w, faction)[t]! < 0))))
    return { sent, held };
  const unsafe = entry.map((e) => e < 0);
  const exposure = fields.map((f) => exposureAt(f.cx, f.cy));
  const fieldOfTile = new Map<number, number>();
  fields.forEach((f, i) => f.tiles.forEach((t) => fieldOfTile.set(t, i)));
  /** Which field a harvester mines now (its order's), or -1. */
  const onField = (h: Unit): number => {
    const o = h.order;
    return o.type === "harvest" ? fieldOfTile.get(o.fieldY * W + o.fieldX) ?? -1 : -1;
  };
  const crowd = fields.map(() => 0);
  for (const h of harvesters) {
    const i = onField(h);
    if (i >= 0) crowd[i]!++;
  }
  const score = (i: number) =>
    walk[entry[i]!]! + EXPOSURE_COST * Math.max(0, exposure[i]! - EXPOSED) + CROWD_COST * Math.max(0, crowd[i]! + 1 - fields[i]!.tiles.length);
  const travel = (h: Unit, i: number) => dist(h.x, h.y, fields[i]!.cx, fields[i]!.cy);
  /** The best safe field for `h` to go to (with the way there), or -1. */
  const best = (h: Unit): number => {
    let pick = -1;
    let bestScore = Infinity;
    for (let i = 0; i < fields.length; i++) {
      if (unsafe[i]) continue;
      const s = score(i) + TRAVEL_COST * travel(h, i);
      if (s < bestScore) {
        bestScore = s;
        pick = i;
      }
    }
    return pick;
  };
  const orders = new Map<number, number[]>(); // field → harvesters sent there
  const retreat: number[] = [];
  for (const h of harvesters) {
    if (skip.has(h.id)) continue;
    const o = h.order;
    // (a full hold on its way home, unloading, or running from fire: let it be)
    if (o.type !== "idle" && !(o.type === "harvest" && (o.phase === "toField" || o.phase === "harvesting"))) continue;
    if (o.type === "harvest" && w.tick - h.damagedTick < 4 * TICK_RATE) continue;
    if (o.type === "idle" && last.has(h.id)) continue;
    const cur = onField(h);
    if (cur >= 0) crowd[cur]!--;
    const to = best(h);
    // (cur < 0 on a harvest order: its tile just ran dry, and the sim picks the next; we see where next think)
    const stay =
      o.type === "harvest" &&
      (cur < 0 || (!unsafe[cur] && (to < 0 || to === cur || exposure[cur]! < EXPOSED || score(cur) - score(to) <= MARGIN)));
    if (stay) {
      if (cur >= 0) crowd[cur]!++;
      continue;
    }
    if (to < 0) {
      // every field unsafe: wait behind the HQ (once there, it stays put)
      if (o.type !== "idle" || dist(h.x, h.y, hqC.x, hqC.y) > 5) retreat.push(h.id);
      else held.add(h.id);
      continue;
    }
    crowd[to]!++;
    orders.set(to, [...(orders.get(to) ?? []), h.id]);
  }
  for (const [i, ids] of orders) {
    const e = entry[i]!;
    cmds.push({ type: "harvest", faction, unitIds: ids, x: (e % W) + 0.5, y: Math.floor(e / W) + 0.5 });
    for (const id of ids) {
      sent.add(id);
      last.set(id, w.tick);
    }
  }
  if (retreat.length) {
    const [dx, dy] = sideFrame(w, faction).vec(0, 3); // (just behind the HQ, in the side's frame)
    cmds.push({ type: "move", faction, unitIds: retreat, x: hqC.x + dx, y: hqC.y + dy });
    for (const id of retreat) sent.add(id);
  }
  return { sent, held };
}
