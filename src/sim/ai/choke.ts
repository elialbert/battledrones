import { TERRAIN } from "../balance";
import { hypot } from "../fmath";
import type { Faction, World } from "../types";
import { buildingCenter, hqOf, sideFrame } from "../world";

/**
 * A base's chokepoints for the AI: where the ground ways in narrow down.
 * The fewest tiles that, blocked, would cut the ground round the HQ (within
 * CHOKE.inner tiles) off from the map past CHOKE.outer: a minimum vertex
 * cut (max flow, each tile carrying one unit, 4-way steps, buildings
 * ignored). If that's CHOKE.maxTiles or fewer, its tiles, grouped, are the
 * entrances, one per gap in the ridge. Terrain only, so it's worked out once
 * per side.
 */
export interface Entrance {
  /** Middle of the gap. */
  x: number;
  y: number;
  /** CHOKE.back steps inside the gap, toward the HQ: where a defence stands. */
  hold: { x: number; y: number };
  /** Tiles across. */
  width: number;
}

export const CHOKE = {
  /** The base's core, and the map past it (tiles from the HQ's middle): the cut lies between. */
  inner: 7,
  outer: 30,
  /** A cut this many tiles or fewer is a choke (an open corner's quarter ring 7 tiles out is ~13). */
  maxTiles: 12,
  /** The defence stands this many steps inside the gap. */
  back: 3
};

const cache = new WeakMap<Uint8Array, Map<Faction, Entrance[]>>();

/** The entrances to `faction`'s base, the one facing the enemy first; [] on open ground (or with no HQ). */
export function baseEntrances(w: World, faction: Faction): Entrance[] {
  let byFaction = cache.get(w.terrain);
  if (!byFaction) cache.set(w.terrain, (byFaction = new Map()));
  let out = byFaction.get(faction);
  if (!out) byFaction.set(faction, (out = findEntrances(w, faction)));
  return out;
}

function findEntrances(w: World, faction: Faction): Entrance[] {
  const hq = hqOf(w, faction);
  if (!hq) return [];
  const W = w.width;
  const H = w.height;
  const N = W * H;
  const c = buildingCenter(hq);
  const ground = (i: number) => TERRAIN[w.terrain[i] as 0].ground;
  const from = (i: number) => hypot((i % W) + 0.5 - c.x, ((i / W) | 0) + 0.5 - c.y);
  const near4 = (i: number): number[] => {
    const x = i % W;
    const y = (i / W) | 0;
    const out: number[] = [];
    if (x > 0) out.push(i - 1);
    if (x < W - 1) out.push(i + 1);
    if (y > 0) out.push(i - W);
    if (y < H - 1) out.push(i + W);
    return out.filter(ground);
  };

  // the graph: tile i is node i (in) and i + N (out), joined by an edge of capacity 1;
  // S = 2N feeds the core, T = 2N + 1 drains the map past `outer`
  const S = 2 * N;
  const T = S + 1;
  const BIG = 1 << 20;
  const head = new Int32Array(T + 1).fill(-1);
  const to: number[] = [];
  const cap: number[] = [];
  const nxt: number[] = [];
  const edge = (a: number, b: number, c: number) => {
    to.push(b), cap.push(c), nxt.push(head[a]!), (head[a] = to.length - 1);
    to.push(a), cap.push(0), nxt.push(head[b]!), (head[b] = to.length - 1);
  };
  for (let i = 0; i < N; i++) {
    if (!ground(i)) continue;
    const d = from(i);
    const inner = d <= CHOKE.inner;
    const outer = d >= CHOKE.outer;
    edge(i, i + N, inner || outer ? BIG : 1);
    if (inner) edge(S, i, BIG);
    if (outer) edge(i + N, T, BIG);
    for (const j of near4(i)) edge(i + N, j, BIG);
  }
  // Edmonds-Karp, given up past maxTiles (no choke: too many ways in)
  const via = new Int32Array(T + 1);
  const reach = (): boolean => {
    via.fill(-1);
    via[S] = -2;
    const q = [S];
    for (let h = 0; h < q.length; h++) {
      const v = q[h]!;
      for (let e = head[v]!; e >= 0; e = nxt[e]!)
        if (cap[e]! > 0 && via[to[e]!] === -1) {
          via[to[e]!] = e;
          if (to[e] === T) return true;
          q.push(to[e]!);
        }
    }
    return false;
  };
  let flow = 0;
  while (reach()) {
    if (++flow > CHOKE.maxTiles) return [];
    for (let v = T; v !== S; v = to[via[v]! ^ 1]!) {
      cap[via[v]!]!--;
      cap[via[v]! ^ 1]!++;
    }
  }
  if (flow === 0) return []; // (nothing out there by ground: an island)
  // the cut: tiles whose in node the source still reaches and whose out node it doesn't
  const cut: number[] = [];
  for (let i = 0; i < N; i++) if (ground(i) && via[i] !== -1 && via[i + N] === -1) cut.push(i);

  // grouped into gaps (8-way), each with a hold point walked back toward the HQ
  const steps = new Int32Array(N).fill(-1);
  const q: number[] = [];
  for (let i = 0; i < N; i++)
    if (ground(i) && from(i) <= 2.2) {
      steps[i] = 0;
      q.push(i);
    }
  for (let h = 0; h < q.length; h++) for (const j of near4(q[h]!)) if (steps[j] === -1) (steps[j] = steps[q[h]!]! + 1), q.push(j);
  const fr = sideFrame(w, faction);
  const inCut = new Set(cut);
  const done = new Set<number>();
  const out: Entrance[] = [];
  for (const i0 of cut) {
    if (done.has(i0)) continue;
    const g = [i0];
    done.add(i0);
    for (let h = 0; h < g.length; h++) {
      const x = g[h]! % W;
      const y = (g[h]! / W) | 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const j = (y + dy) * W + x + dx;
          if (x + dx >= 0 && x + dx < W && inCut.has(j) && !done.has(j)) done.add(j), g.push(j);
        }
    }
    const x = g.reduce((s, i) => s + (i % W) + 0.5, 0) / g.length;
    const y = g.reduce((s, i) => s + ((i / W) | 0) + 0.5, 0) / g.length;
    const mid = (i: number) => hypot((i % W) + 0.5 - x, ((i / W) | 0) + 0.5 - y);
    // (ties in our own frame's order: both sides pick the same tile, mirrored)
    const order = (j: number) => {
      const f = fr.toFrame({ x: (j % W) + 0.5, y: ((j / W) | 0) + 0.5 });
      return f.y * W + f.x;
    };
    let at = g.reduce((b, i) => (mid(i) < mid(b) - 1e-9 || (Math.abs(mid(i) - mid(b)) < 1e-9 && order(i) < order(b)) ? i : b), g[0]!);
    for (let k = 0; k < CHOKE.back; k++) {
      const down = near4(at)
        .filter((j) => steps[j]! >= 0 && steps[j]! < steps[at]!)
        .sort((a, b) => order(a) - order(b))[0];
      if (down === undefined) break;
      at = down;
    }
    out.push({ x, y, hold: { x: (at % W) + 0.5, y: ((at / W) | 0) + 0.5 }, width: g.length });
  }
  // the gap facing the enemy first (the far corner of our own frame), ties in our own frame's order
  const enemy = fr.toWorld({ x: W - fr.toFrame(c).x, y: H - fr.toFrame(c).y });
  const key = (e: Entrance) => {
    const f = fr.toFrame(e);
    return Math.round(hypot(e.x - enemy.x, e.y - enemy.y) * 100) * 1e4 + f.y * 100 + f.x;
  };
  return out.sort((a, b) => key(a) - key(b));
}
