import * as THREE from "three";
import { Terrain, type Biome } from "../sim/types";
import type { MapDef } from "../sim/maps";
import type { TerrainArt } from "./three/terrain";
import { bridgeRuns, type BridgeRun } from "./three/terrain-bridges";

/**
 * Ground art for generated maps, painted at runtime: they have no pre-painted
 * chunks (art/terrain.py paints only the built-in maps offline), so this paints
 * an approximation of that look straight from the tile grid. Pure and
 * deterministic: a pixel's colour depends only on the grid, biome, seed, scale
 * and its own global position, so chunks of any size tile seamlessly.
 *
 * The look: per-biome palettes sampled from the built-in maps' art, tiles
 * blended into their neighbours with a narrow smooth kernel over
 * domain-warped coordinates (organic edges, no grid squares), distance
 * fields for water depth, banks and rock relief, then layered value noise
 * and per-pixel grain so it reads as painted rather than flat-filled.
 */

/** Painted px per tile and chunk size for generated maps (half the built-ins' 48 px: painted on the player's CPU). */
export const PAINT_PX = 24;
export const PAINT_CHUNK = 1024;

type RGB = readonly [number, number, number];
const hex = (h: number): RGB => [(h >> 16) & 255, (h >> 8) & 255, h & 255];

interface Palette {
  ground: RGB; ground2: RGB; cover: number;
  rough: RGB; rough2: RGB;
  rockLit: RGB; rock: RGB; rockDark: RGB;
  scrap: RGB; rust: RGB; metal: RGB;
  bank: RGB; water: RGB; abyss: RGB; foam: RGB;
  road: RGB; curb: RGB;
  forest: RGB; moss: RGB; needles: RGB;
  crystalBed: RGB; crystal: RGB; glint: RGB;
  deck: RGB; rail: RGB;
  shallows: RGB; stones: RGB;
  /** How much the banks darken the ground (wet soil). */
  wet: number;
  /** Per-pixel grain and low-frequency brightness amplitudes. */
  grain: number; low: number;
}

// colours from the built-in maps' painted art (per-terrain medians, see art/terrain.py for the looks)
const PAL: Record<Biome, Palette> = {
  temperate: {
    ground: hex(0x5e7826), ground2: hex(0x6e7430), cover: 0.35,
    rough: hex(0x6a5236), rough2: hex(0x4e3f2a),
    rockLit: hex(0x86827a), rock: hex(0x605d57), rockDark: hex(0x34322f),
    scrap: hex(0x4d4528), rust: hex(0x8c4a22), metal: hex(0x8a8c88),
    bank: hex(0x2f7476), water: hex(0x0f4a5e), abyss: hex(0x0b3550), foam: hex(0xc8dcd4),
    road: hex(0x77705f), curb: hex(0x4f4a3e),
    forest: hex(0x34431b), moss: hex(0x4e5f22), needles: hex(0x6c6a2c),
    crystalBed: hex(0x4a4a2a), crystal: hex(0x5fd8c8), glint: hex(0xe8fff8),
    deck: hex(0x8a7a64), rail: hex(0x4a3c2e),
    shallows: hex(0x5f8a7c), stones: hex(0x8a8a78),
    wet: 0.28, grain: 0.07, low: 0.08
  },
  desert: {
    ground: hex(0xc48f54), ground2: hex(0xdcae6e), cover: 0.4,
    rough: hex(0x8c6d4f), rough2: hex(0x6e5238),
    rockLit: hex(0xc8774a), rock: hex(0x9c5734), rockDark: hex(0x5a2c1a),
    scrap: hex(0x73573e), rust: hex(0x9a4a22), metal: hex(0x9a948a),
    bank: hex(0x3a9a90), water: hex(0x146c7a), abyss: hex(0x0e5468), foam: hex(0xeee8d0),
    road: hex(0x957552), curb: hex(0x6a5038),
    forest: hex(0x4e5018), moss: hex(0x6a6a24), needles: hex(0x8a7a3a),
    crystalBed: hex(0x7a6240), crystal: hex(0x6ee0d0), glint: hex(0xfff8e8),
    deck: hex(0x9e7852), rail: hex(0x5a4028),
    shallows: hex(0x6fb0a0), stones: hex(0xb08a60),
    wet: 0.3, grain: 0.06, low: 0.07
  },
  arctic: {
    ground: hex(0xc8d6ee), ground2: hex(0xe6eef9), cover: 0.3,
    rough: hex(0x7c7c86), rough2: hex(0xa8b0c0),
    rockLit: hex(0x8a92a0), rock: hex(0x4a505c), rockDark: hex(0x262a34),
    scrap: hex(0x6e707a), rust: hex(0x7a4a34), metal: hex(0x9aa0aa),
    bank: hex(0x46688a), water: hex(0x1e3a5a), abyss: hex(0x132a46), foam: hex(0xe8f2ff),
    road: hex(0x8a8e98), curb: hex(0x5e626c),
    forest: hex(0x46525e), moss: hex(0x5e6c78), needles: hex(0x2e3a3a),
    crystalBed: hex(0x66727a), crystal: hex(0x7ae8e0), glint: hex(0xffffff),
    deck: hex(0x735f50), rail: hex(0x3a3430),
    shallows: hex(0x86a8cc), stones: hex(0xb8c4d4),
    wet: 0.12, grain: 0.045, low: 0.05
  },
  volcanic: {
    ground: hex(0x504b47), ground2: hex(0x413c39), cover: 0.45,
    rough: hex(0x6c4232), rough2: hex(0x523228),
    rockLit: hex(0x4a4240), rock: hex(0x2a2423), rockDark: hex(0x141010),
    scrap: hex(0x3f2d24), rust: hex(0x8a3e1c), metal: hex(0x6e6a66),
    // lava: crust at the banks, molten toward the middle (glow below)
    bank: hex(0x3a2a22), water: hex(0x6a2c14), abyss: hex(0x7a3014), foam: hex(0xffc050),
    road: hex(0x3c3735), curb: hex(0x221e1c),
    forest: hex(0x3e3532), moss: hex(0x524842), needles: hex(0x1e1816),
    crystalBed: hex(0x3e3328), crystal: hex(0xe070ff), glint: hex(0xfff0ff),
    deck: hex(0x6c6660), rail: hex(0x34302c),
    shallows: hex(0x4a3226), stones: hex(0x2a2220),
    wet: 0, grain: 0.07, low: 0.06
  },
  tropical: {
    ground: hex(0x86a056), ground2: hex(0xe2d8b2), cover: 0.12,
    rough: hex(0x6a6650), rough2: hex(0x52503e),
    rockLit: hex(0xc2bcaa), rock: hex(0x8c8778), rockDark: hex(0x4e5048),
    scrap: hex(0x62644d), rust: hex(0x8a5230), metal: hex(0x9a9c94),
    bank: hex(0x4fcabb), water: hex(0x017a96), abyss: hex(0x02385a), foam: hex(0xf2faf8),
    road: hex(0x8a7a5c), curb: hex(0x625640),
    forest: hex(0x2e5420), moss: hex(0x3e6e28), needles: hex(0x5a7a30),
    crystalBed: hex(0x5a613e), crystal: hex(0x60f0d8), glint: hex(0xffffff),
    deck: hex(0x8a735a), rail: hex(0x4a3c2e),
    shallows: hex(0x5cd6c4), stones: hex(0xd8d0b0),
    wet: 0.22, grain: 0.06, low: 0.06
  }
};

// the terrain codes as plain constants (the hot loop compares against them per pixel)
const GROUND = Terrain.Ground;
const ROCK = Terrain.Rock;
const SCRAP = Terrain.Scrap;
const WATER = Terrain.Water;
const ROAD = Terrain.Road;
const ROUGH = Terrain.Rough;
const FOREST = Terrain.Forest;
const CRYSTAL = Terrain.Crystal;
const BRIDGE = Terrain.Bridge;
const SHALLOWS = Terrain.Shallows;
const DEEP = Terrain.Deep;

/** Lava's glowing veins, its hot core, and the scorched ground round it. */
const MOLTEN = hex(0xff5a12);
const MAGMA = hex(0xb04010);
const SCORCH = hex(0x7a3a22);

// ------------------------------------------------------------------ noise --

const NT = 256;
const NM = NT - 1;

/** A seeded lattice of random values (value noise reads it, wrapping every 256 cells). */
function noiseTable(seed: number): Float32Array {
  const t = new Float32Array(NT * NT);
  let h = (seed ^ 0x5bd1e995) | 0;
  for (let i = 0; i < t.length; i++) {
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
    h ^= h >>> 15;
    t[i] = (h >>> 0) / 4294967296;
  }
  return t;
}

/** Smooth value noise in 0..1 off a table (its lattice turned 37°, so no grid-aligned squares show). */
function vn(T: Float32Array, px: number, py: number): number {
  const x = px * 0.8 - py * 0.6;
  const y = px * 0.6 + py * 0.8;
  const xf = Math.floor(x);
  const yf = Math.floor(y);
  let fx = x - xf;
  let fy = y - yf;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const x0 = xf & NM;
  const x1 = (xf + 1) & NM;
  const y0 = (yf & NM) * NT;
  const y1 = ((yf + 1) & NM) * NT;
  const a = T[y0 + x0]!;
  const b = T[y0 + x1]!;
  const c = T[y1 + x0]!;
  const d = T[y1 + x1]!;
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);
const smooth = (a: number, b: number, t: number) => {
  const k = clamp01((t - a) / (b - a));
  return k * k * (3 - 2 * k);
};

// ----------------------------------------------------------------- fields --

const isLiquid = (t: number) => t === WATER || t === DEEP || t === SHALLOWS || t === BRIDGE;

interface Fields {
  T: Float32Array;
  /** Signed distance to the nearest shore, tile centres: + into liquid (depth), − onto land. */
  sd: Float32Array;
  /** Height inside rock (tiles from its edge, 0 off rock). */
  rh: Float32Array;
  /** Domain-warp strength: none on bridges (straight decks), a little beside them. */
  amp: Float32Array;
  /** Bridge deck runs along x (1) or y (0). */
  horiz: Uint8Array;
  /** The slanted bridge whose straight deck may reach over this tile (an index into `runs`), or −1. */
  deck: Int32Array;
  runs: BridgeRun[];
  /** The tile and its 8 neighbours are one terrain (nothing to blend). */
  same: Uint8Array;
  /** Bit 1: near a shore (the shore field varies); bit 2: rock up-left (it may cast a shadow). */
  near: Uint8Array;
}

const fieldCache = new WeakMap<Uint8Array, Map<string, Fields>>();

/** Multi-source BFS (8-connected) from every tile where `src` is false into the tiles where `inside` holds. */
function distInside(grid: Uint8Array, S: number, inside: (t: number) => boolean, cap: number): Float32Array {
  const d = new Float32Array(S * S);
  const q: number[] = [];
  for (let i = 0; i < S * S; i++) {
    if (!inside(grid[i]!)) continue;
    const x = i % S;
    const y = (i - x) / S;
    let edge = false;
    for (let dy = -1; dy <= 1 && !edge; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= S || ny >= S) continue;
        if (!inside(grid[ny * S + nx]!)) {
          edge = true;
          break;
        }
      }
    if (edge) {
      d[i] = 1;
      q.push(i);
    }
  }
  for (let h = 0; h < q.length; h++) {
    const i = q[h]!;
    const x = i % S;
    const y = (i - x) / S;
    if (d[i]! >= cap) continue;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= S || ny >= S) continue;
        const k = ny * S + nx;
        if (d[k] === 0 && inside(grid[k]!)) {
          d[k] = d[i]! + 1;
          q.push(k);
        }
      }
  }
  // tiles with no edge in reach (a map of one terrain) sit at the cap
  for (let i = 0; i < S * S; i++) if (inside(grid[i]!) && d[i] === 0) d[i] = cap;
  return d;
}

function fields(grid: Uint8Array, S: number, seed: number): Fields {
  let m = fieldCache.get(grid);
  if (!m) fieldCache.set(grid, (m = new Map()));
  const key = `${S}:${seed}`;
  const hit = m.get(key);
  if (hit) return hit;
  const wet = distInside(grid, S, isLiquid, 10);
  const dry = distInside(grid, S, (t) => !isLiquid(t), 10);
  const sd = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) sd[i] = isLiquid(grid[i]!) ? wet[i]! - 0.5 : 0.5 - dry[i]!;
  const rh = distInside(grid, S, (t) => t === ROCK, 6);
  for (let i = 0; i < S * S; i++) if (grid[i] !== ROCK) rh[i] = 0;
  const amp = new Float32Array(S * S).fill(1);
  const horiz = new Uint8Array(S * S);
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= S || y >= S ? -1 : grid[y * S + x]!);
  const holds = (t: number) => t === BRIDGE || (t >= 0 && !isLiquid(t));
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      if (grid[y * S + x] !== BRIDGE) continue;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < S && ny < S) amp[ny * S + nx] = Math.min(amp[ny * S + nx]!, 0.15);
        }
      const ax = +holds(at(x - 1, y)) + +holds(at(x + 1, y));
      const ay = +holds(at(x, y - 1)) + +holds(at(x, y + 1));
      horiz[y * S + x] = ax >= ay ? 1 : 0;
    }
  for (let i = 0; i < S * S; i++) if (grid[i] === BRIDGE) amp[i] = 0;
  // a diagonal bridge is one straight deck, as the 3D one is, over its stair-stepped tiles and their
  // corners (the river runs on round it)
  const { runs } = bridgeRuns(grid, S, S);
  const deck = new Int32Array(S * S).fill(-1);
  runs.forEach((r, k) => {
    if (!r.slant) return;
    for (const i of r.tiles)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = (i % S) + dx;
          const ny = Math.floor(i / S) + dy;
          if (nx >= 0 && ny >= 0 && nx < S && ny < S && (deck[ny * S + nx]! < 0 || grid[ny * S + nx] === BRIDGE)) deck[ny * S + nx] = k;
        }
  });
  const same = new Uint8Array(S * S);
  const near = new Uint8Array(S * S);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const k = y * S + x;
      let eq = 1;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const t = at(Math.min(S - 1, Math.max(0, x + dx)), Math.min(S - 1, Math.max(0, y + dy)));
          if (t !== grid[k] || t === BRIDGE) eq = 0;
        }
      same[k] = eq;
      // liquids always read their depth; land only within reach of a shore
      let nb = isLiquid(grid[k]!) || sd[k]! > -2.6 ? 1 : 0;
      for (let dy = -2; dy <= 1; dy++)
        for (let dx = -2; dx <= 1; dx++) if (at(x + dx, y + dy) === ROCK) nb |= 2;
      near[k] = nb;
    }
  const f: Fields = { T: noiseTable(seed), sd, rh, amp, horiz, deck, runs, same, near };
  m.set(key, f);
  return f;
}

/** A tile-centred field, bilinear at tile point (u, v). */
function sample(f: Float32Array, S: number, u: number, v: number): number {
  const gx = Math.min(S - 1, Math.max(0, u - 0.5));
  const gy = Math.min(S - 1, Math.max(0, v - 0.5));
  const i = Math.min(S - 2, Math.floor(gx));
  const j = Math.min(S - 2, Math.floor(gy));
  const fx = gx - i;
  const fy = gy - j;
  const k = j * S + i;
  const a = f[k]!;
  const b = f[k + 1]!;
  const c = f[k + S]!;
  const d = f[k + S + 1]!;
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

// ---------------------------------------------------------------- painter --

/** Domain-warp amplitude (tiles): how far edges wander from the grid lines. */
const WARP = 0.42;

/**
 * Paint the w×h pixel rect at (x0, y0) of a map's ground at `px` pixels per
 * tile: RGBA, row-major. `grid` is the row-major size×size Terrain codes.
 */
export function paintTerrainPixels(
  grid: Uint8Array, size: number, biome: Biome, seed: number,
  px: number, x0: number, y0: number, w: number, h: number
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  const S = size;
  const F = fields(grid, S, seed >>> 0);
  const { T, sd: SD, rh: RH, amp: AMP, horiz: HZ, deck: DECK, runs: RUNS, same: SAME, near: NEAR } = F;
  const P = PAL[biome] ?? PAL.temperate;
  const lava = biome === "volcanic";
  const beach = biome === "tropical";
  const arctic = biome === "arctic";
  const steel = biome === "volcanic";
  const pxSalt = Math.imul(seed | 0, 0x27d4eb2d) ^ px;
  // the colour of the terrain being shaded (a typed array: doubles in closure slots would be boxed per write)
  const C = new Float64Array(3);
  const mix3 = (a: RGB, b: RGB, k: number) => {
    C[0] = a[0] + (b[0] - a[0]) * k;
    C[1] = a[1] + (b[1] - a[1]) * k;
    C[2] = a[2] + (b[2] - a[2]) * k;
  };
  const toward = (c: RGB, k: number) => {
    C[0] = C[0]! + (c[0] - C[0]!) * k;
    C[1] = C[1]! + (c[1] - C[1]!) * k;
    C[2] = C[2]! + (c[2] - C[2]!) * k;
  };
  const mul = (k: number) => {
    C[0] = C[0]! * k;
    C[1] = C[1]! * k;
    C[2] = C[2]! * k;
  };
  let du = 0;
  let dv = 0;
  let dhw = 0;
  const tt = new Int32Array(9);
  const ww = new Float64Array(9);
  const mm = new Float64Array(9);
  const bx = new Float64Array(3);
  const by = new Float64Array(3);
  let n = 0;
  /** Gather a tile's B-spline weight by terrain. */
  const add = (t: number, wt: number) => {
    for (let q = 0; q < n; q++)
      if (tt[q] === t) {
        mm[q] = mm[q]! + wt;
        return;
      }
    tt[n] = t;
    mm[n] = wt;
    n++;
  };
  // the low-frequency terms (domain warp, brightness drift) on a coarse lattice every K px,
  // aligned to the whole map so any rect reads the same values, bilinear in between
  const K = Math.max(1, Math.round(px / 6));
  const lx0 = Math.floor(x0 / K);
  const ly0 = Math.floor(y0 / K);
  const lw = Math.floor((x0 + w - 1) / K) - lx0 + 2;
  const lh = Math.floor((y0 + h - 1) / K) - ly0 + 2;
  const lat = new Float32Array(lw * lh * 4);
  for (let j = 0; j < lh; j++)
    for (let i = 0; i < lw; i++) {
      const u = ((lx0 + i) * K + 0.5) / px;
      const v = ((ly0 + j) * K + 0.5) / px;
      const a = WARP * sample(AMP, S, u, v);
      const o = (j * lw + i) * 4;
      lat[o] = a * ((vn(T, u * 0.55 + 17.3, v * 0.55 + 3.1) - 0.5) * 1.6 + (vn(T, u * 1.9 + 41.7, v * 1.9 + 8.9) - 0.5) * 0.6);
      lat[o + 1] = a * ((vn(T, u * 0.55 + 91.1, v * 0.55 + 57.7) - 0.5) * 1.6 + (vn(T, u * 1.9 + 23.3, v * 1.9 + 77.1) - 0.5) * 0.6);
      lat[o + 2] = 1 + (vn(T, u * 0.09 + 31.1, v * 0.09 + 11.3) - 0.5) * 2 * P.low;
      lat[o + 3] = (vn(T, u * 0.07 + 71.7, v * 0.07 + 41.9) - 0.5) * P.low * 60;
    }
  for (let y = 0; y < h; y++) {
    const Y = y0 + y;
    const v = (Y + 0.5) / px;
    const lj = Math.floor(Y / K) - ly0;
    const fy = (Y - (ly0 + lj) * K) / K;
    for (let x = 0; x < w; x++) {
      const X = x0 + x;
      const u = (X + 0.5) / px;
      // per-pixel hashes: grain and speckles
      let hh = Math.imul(X ^ Math.imul(Y, 0x9e3779b1) ^ pxSalt, 0x85ebca6b);
      hh ^= hh >>> 13;
      hh = Math.imul(hh, 0xc2b2ae35);
      hh ^= hh >>> 16;
      const g1 = (hh >>> 0) / 4294967296;
      const g2 = ((Math.imul(hh, 0x2545f491) >>> 8) & 0xffff) / 65536;

      const li = Math.floor(X / K) - lx0;
      const fx = (X - (lx0 + li) * K) / K;
      const o00 = (lj * lw + li) * 4;
      const o10 = o00 + 4;
      const o01 = o00 + lw * 4;
      const o11 = o01 + 4;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;
      const wu = u + lat[o00]! * w00 + lat[o10]! * w10 + lat[o01]! * w01 + lat[o11]! * w11;
      const wv = v + lat[o00 + 1]! * w00 + lat[o10 + 1]! * w10 + lat[o01 + 1]! * w01 + lat[o11 + 1]! * w11;
      const lf = lat[o00 + 2]! * w00 + lat[o10 + 2]! * w10 + lat[o01 + 2]! * w01 + lat[o11 + 2]! * w11;
      const warm = lat[o00 + 3]! * w00 + lat[o10 + 3]! * w10 + lat[o01 + 3]! * w01 + lat[o11 + 3]! * w11;

      // the 3×3 tiles round the warped point, weighted by a quadratic B-spline (rounds off the
      // grid's stair-steps), then sharpened so borders stay crisp (membership⁸, normalised)
      const ci = Math.min(S - 1, Math.max(0, Math.floor(wu)));
      const cj = Math.min(S - 1, Math.max(0, Math.floor(wv)));
      const dx = Math.min(0.5, Math.max(-0.5, wu - ci - 0.5));
      const dy = Math.min(0.5, Math.max(-0.5, wv - cj - 0.5));
      bx[0] = 0.5 * (0.5 - dx) * (0.5 - dx);
      bx[1] = 0.75 - dx * dx;
      bx[2] = 0.5 * (0.5 + dx) * (0.5 + dx);
      by[0] = 0.5 * (0.5 - dy) * (0.5 - dy);
      by[1] = 0.75 - dy * dy;
      by[2] = 0.5 * (0.5 + dy) * (0.5 + dy);
      const ut = Math.min(S - 1, Math.max(0, Math.floor(u)));
      const vt = Math.min(S - 1, Math.max(0, Math.floor(v)));
      const ck = cj * S + ci;
      n = 0;
      // on a slanted bridge's straight deck: where, in its frame (along, across from its centre)
      const dk = DECK[vt * S + ut]!;
      let onDeck = false;
      if (dk >= 0) {
        const r = RUNS[dk]!;
        const ox = u - r.mx;
        const oy = v - r.mz;
        du = ox * r.ux + oy * r.uz - r.mid;
        dv = oy * r.ux - ox * r.uz;
        onDeck = Math.abs(du) <= r.hl && Math.abs(dv) <= r.hw;
        dhw = r.hw;
      }
      if (onDeck || (dk < 0 && grid[vt * S + ut] === BRIDGE)) {
        // decks are crisp rectangles: no blending
        tt[0] = BRIDGE;
        mm[0] = ww[0] = 1;
        n = 1;
      } else if (SAME[ck]) {
        tt[0] = grid[ck]!;
        mm[0] = ww[0] = 1;
        n = 1;
      } else {
        for (let oy = 0; oy < 3; oy++) {
          const ty = Math.min(S - 1, Math.max(0, cj + oy - 1)) * S;
          for (let ox = 0; ox < 3; ox++) {
            const t = grid[ty + Math.min(S - 1, Math.max(0, ci + ox - 1))]!;
            // (round a deck, the river runs on)
            add(t === BRIDGE ? WATER : t, bx[ox]! * by[oy]!);
          }
        }
        let tot = 0;
        for (let q = 0; q < n; q++) {
          const m2 = mm[q]! * mm[q]!;
          const m4 = m2 * m2;
          ww[q] = m4 * m4;
          tot += ww[q]!;
        }
        for (let q = 0; q < n; q++) ww[q] = ww[q]! / tot;
      }

      const nr = NEAR[ck]!;
      const sd = nr & 1 ? sample(SD, S, wu, wv) : SD[ck]!;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let q = 0; q < n; q++) {
        const wt = ww[q]!;
        if (wt < 0.002) continue;
        const t = tt[q]!;
        const memb = mm[q]!;
        switch (t) {
          case GROUND:
          case CRYSTAL: {
            const lo = vn(T, u * 0.22 + 5.5, v * 0.22 + 9.2) * 0.7 + vn(T, u * 0.9 + 1.3, v * 0.9 + 2.7) * 0.3;
            const mid = 0.5 + (0.5 - P.cover) * 0.6;
            mix3(P.ground, P.ground2, smooth(mid - 0.09, mid + 0.09, lo));
            mul(0.9 + vn(T, u * 2.3 + 7.7, v * 2.3 + 1.1) * 0.2);
            if (beach) toward(P.ground2, smooth(-1.45, -0.85, sd - (vn(T, u * 1.4, v * 1.4) - 0.5) * 0.5));
            if (t === CRYSTAL) {
              // a crystal bed: darker ground studded with glinting shards
              toward(P.crystalBed, 0.7);
              const c = vn(T, u * 4.2 + 3.3, v * 4.2 + 6.6) * 0.65 + vn(T, u * 9 + 1.1, v * 9 + 4.4) * 0.35;
              const shard = smooth(0.58, 0.66, c);
              if (shard > 0) {
                toward(P.crystal, shard * (0.55 + 0.35 * vn(T, u * 2 + 9, v * 2 + 9)));
                if (g2 > 0.93) toward(P.glint, shard * 0.8);
              }
            } else if (g2 > 0.985) toward(P.stones, 0.5);
            break;
          }
          case ROUGH: {
            const p = vn(T, u * 1.1 + 13.1, v * 1.1 + 2.2) * 0.6 + vn(T, u * 3.7 + 4.4, v * 3.7 + 6.1) * 0.4;
            mix3(P.rough, P.rough2, smooth(0.35, 0.7, p));
            // pebbles and clods
            const pb = vn(T, u * 7.5 + 2.2, v * 7.5 + 8.8);
            if (pb > 0.72) toward(P.stones, smooth(0.72, 0.8, pb) * 0.45);
            if (g1 > 0.9) mul(0.82);
            break;
          }
          case ROCK: {
            // hill-shaded from the upper left: the height inside the rock plus crags
            const e = 0.28;
            const h0 = sample(RH, S, wu, wv) * 0.6 + vn(T, u * 2.2 + 3.7, v * 2.2 + 5.3) * 0.9 + vn(T, u * 5.3, v * 5.3) * 0.35;
            const h1 = sample(RH, S, wu - e, wv - e) * 0.6 + vn(T, (u - e) * 2.2 + 3.7, (v - e) * 2.2 + 5.3) * 0.9 + vn(T, (u - e) * 5.3, (v - e) * 5.3) * 0.35;
            const lit = clamp01(0.5 + (h0 - h1) * 1.4);
            if (lit < 0.5) mix3(P.rockDark, P.rock, lit * 2);
            else mix3(P.rock, P.rockLit, (lit - 0.5) * 2);
            mul(0.92 + g1 * 0.16);
            // lichen / snow / ash in the hollows
            if (arctic) toward(P.ground2, smooth(0.6, 0.75, vn(T, u * 1.7 + 8.1, v * 1.7 + 2.9)) * 0.7);
            break;
          }
          case SCRAP: {
            mix3(P.scrap, P.rough2, vn(T, u * 1.3 + 6.1, v * 1.3 + 3.3) * 0.35);
            // wreckage plates: metal with rust blooms, rust specks round them
            const pl = vn(T, u * 3.1 + 2.9, v * 3.1 + 7.4) * 0.7 + vn(T, u * 8 + 4.1, v * 8 + 1.7) * 0.3;
            if (pl > 0.56) {
              toward(P.metal, smooth(0.56, 0.6, pl) * 0.7);
              toward(P.rust, smooth(0.55, 0.75, vn(T, u * 6.1 + 5.5, v * 6.1 + 5.5)) * 0.75);
              if (g2 > 0.95) toward(P.glint, 0.4);
            }
            if (g1 > 0.86) toward(g2 > 0.5 ? P.rust : P.metal, 0.6);
            break;
          }
          case WATER:
          case DEEP:
          case SHALLOWS: {
            const depth = Math.max(0, sd);
            if (lava) {
              // crust plates over a molten core: glowing veins, hottest toward the middle
              const c = vn(T, u * 1.5 + 2.2, v * 1.5 + 4.4) * 0.65 + vn(T, u * 3.6 + 7.1, v * 3.6 + 1.9) * 0.35;
              const vein = 1 - Math.abs(c - 0.5) * 2;
              const heat = smooth(0.15, 1.6, depth) * (t === SHALLOWS ? 0.35 : 1);
              mix3(P.bank, P.water, heat);
              mul(0.85 + vn(T, u * 6 + 1, v * 6 + 1) * 0.3);
              const glow = smooth(0.74 - heat * 0.2, 0.94, vein) * (0.35 + 0.65 * heat);
              toward(MOLTEN, glow);
              toward(P.foam, smooth(0.9, 1, vein) * heat * 0.8);
              if (heat > 0.6) toward(MAGMA, (heat - 0.6) * 0.5 * vn(T, u * 0.7, v * 0.7));
              break;
            }
            const deepK = smooth(0.05, t === DEEP ? 1.6 : 2.2, depth);
            mix3(P.bank, P.water, deepK);
            if (t === DEEP) toward(P.abyss, smooth(0.8, 4, depth));
            if (t === SHALLOWS) {
              // a ford: the bed showing through, stones
              mix3(P.shallows, P.bank, 0.25 + vn(T, u * 2.1, v * 2.1) * 0.3);
              const st = vn(T, u * 6.5 + 3.3, v * 6.5 + 1.1);
              if (st > 0.68) toward(P.stones, smooth(0.68, 0.76, st) * 0.5);
            }
            // ripples: stretched noise, brighter crests
            const rip = vn(T, u * 3.2 + v * 1.1 + 5.1, v * 1.4 + 2.3) * 0.6 + vn(T, u * 7.1 + 9.9, v * 3.3 + 4.4) * 0.4;
            mul(0.9 + rip * 0.2);
            if (arctic && t !== SHALLOWS) {
              // skim ice and floes near the banks
              const fl = vn(T, u * 1.8 + 4.4, v * 1.8 + 9.9) * 0.7 + vn(T, u * 5 + 1.3, v * 5 + 2.1) * 0.3 - smooth(0, 1.2, depth) * 0.3;
              if (fl > 0.56) toward(P.foam, smooth(0.56, 0.6, fl) * 0.45);
            }
            // foam at the waterline
            toward(P.foam, (1 - smooth(0.0, 0.16, depth)) * 0.45 * (0.6 + 0.4 * vn(T, u * 5, v * 5)));
            break;
          }
          case ROAD: {
            mix3(P.road, P.rough, vn(T, u * 1.2 + 8.8, v * 1.2 + 4.4) * 0.3);
            // worn edges: darker kerb lines just inside the track's sides
            const edge = smooth(0.48, 0.55, memb) * (1 - smooth(0.6, 0.72, memb));
            toward(P.curb, edge * 0.55);
            mul(0.94 + vn(T, u * 4.4 + 2.2, v * 4.4 + 2.2) * 0.12);
            if (g2 > 0.94) toward(P.stones, 0.35);
            break;
          }
          case FOREST: {
            mix3(P.forest, P.moss, smooth(0.4, 0.75, vn(T, u * 1.4 + 6.6, v * 1.4 + 3.3) * 0.7 + vn(T, u * 4 + 1, v * 4 + 2) * 0.3));
            // needles, leaf litter and deep shade between the trunks
            if (g1 > 0.9) toward(P.needles, 0.55);
            else if (g1 < 0.12) mul(0.7);
            mul(0.82 + vn(T, u * 2.6 + 2.2, v * 2.6 + 9.1) * 0.25);
            break;
          }
          case BRIDGE: {
            const k = Math.min(S - 1, Math.max(0, Math.floor(v))) * S + Math.min(S - 1, Math.max(0, Math.floor(u)));
            const hz = HZ[k] === 1;
            // a slanted deck is one board wide, railed down its two sides; a square one, tile by tile
            const along = onDeck ? du : hz ? u : v;
            const across = onDeck ? dv + dhw : hz ? v : u;
            const fa = across - Math.floor(across);
            const ti = onDeck ? 0 : Math.floor(across);
            const ti2 = hz ? Math.floor(u) : ti;
            const tj2 = hz ? ti : Math.floor(v);
            const side = (dx: number, dy: number) => {
              const nx = ti2 + dx;
              const ny = tj2 + dy;
              return nx < 0 || ny < 0 || nx >= S || ny >= S || grid[ny * S + nx] !== BRIDGE;
            };
            const railLo = onDeck ? dv < 0.13 - dhw : (hz ? side(0, -1) : side(-1, 0)) && fa < 0.13;
            const railHi = onDeck ? dv > dhw - 0.13 : (hz ? side(0, 1) : side(1, 0)) && fa > 0.87;
            if (steel) {
              // riveted steel plates, one per tile, tread pattern
              const fl = along - Math.floor(along);
              mix3(P.deck, P.rail, 0.15 + vn(T, u * 3, v * 3) * 0.2);
              if (fl < 0.04 || fl > 0.96) mul(0.6);
              else if ((onDeck ? Math.floor(along * 8) + Math.floor(across * 8) : Math.floor(u * 8) + Math.floor(v * 8)) % 2 === 0) mul(1.08);
              if (Math.abs(fl - 0.12) < 0.03 && Math.abs(fa - 0.25) < 0.03) toward(P.foam, 0.5);
            } else {
              // planks across the deck: dark seams, each plank its own tone and grain
              const pa = along * 3.6;
              const pi = Math.floor(pa);
              const pf = pa - pi;
              const ph = ((Math.imul(pi, 0x9e3779b1) ^ Math.imul(ti, 0x85ebca6b)) >>> 0) / 4294967296;
              mix3(P.deck, P.rail, ph * 0.35);
              mul(0.92 + vn(T, (onDeck ? across : hz ? v : u) * 9 + pi * 3.1, pa * 0.4) * 0.16);
              if (pf < 0.1) mul(0.55);
              if (arctic) toward(P.ground2, smooth(0.55, 0.7, vn(T, u * 2.4 + 1.1, v * 2.4 + 6.2)) * 0.8);
            }
            if (railLo || railHi) mix3(P.rail, P.deck, 0.15 + (railLo ? 0.25 : 0));
            break;
          }
          default:
            mix3(P.ground, P.ground, 0);
        }
        // land beside the water: wet, darker banks (lava scorches instead)
        if (sd > -1.2 && t !== WATER && t !== DEEP && t !== SHALLOWS && t !== BRIDGE) {
          const near = smooth(-1.1, 0, sd);
          if (lava) toward(SCORCH, near * 0.55);
          else mul(1 - P.wet * near * near);
        }
        // shadows cast down-right by rock
        if (t !== ROCK && nr & 2) {
          const sh = sample(RH, S, wu - 0.45, wv - 0.45);
          if (sh > 0) mul(1 - Math.min(1, sh) * 0.3);
        }
        r += C[0]! * wt;
        g += C[1]! * wt;
        b += C[2]! * wt;
      }
      // low-frequency brightness and warm/cool drift, then grain
      const gr = 1 + (g1 + g2 - 1) * P.grain;
      const o = (y * w + x) * 4;
      out[o] = (r * lf + warm) * gr;
      out[o + 1] = g * lf * gr;
      out[o + 2] = (b * lf - warm) * gr;
      out[o + 3] = 255;
    }
  }
  return out;
}

/** A generated map's grid, as the painter wants it. */
const gridOf = (def: MapDef): Uint8Array | null => def.random?.terrain ?? null;

/** Paint a whole generated map at `px` per tile into one RGBA buffer (thumbnails, previews). */
export function paintMapPixels(def: MapDef, px: number): Uint8ClampedArray | null {
  const grid = gridOf(def);
  if (!grid) return null;
  const n = def.size * px;
  return paintTerrainPixels(grid, def.size, def.biome, def.random!.seed, px, 0, 0, n, n);
}

/**
 * Paint a generated map's ground art as chunked canvas textures (the shape
 * loadTerrainArt hands the 3D terrain), a chunk at a time with a yield in
 * between so the loading screen keeps drawing. The edge chunks are narrower
 * (a 108-tile map at 24 px is 2592 px: 1024 + 1024 + 544). `rock` is left
 * null: the caller loads the biome's rock material.
 */
export async function paintTerrainArt(def: MapDef, progress?: (k: number) => void): Promise<TerrainArt> {
  const grid = gridOf(def);
  const px = PAINT_PX;
  const full = def.size * px;
  const n = Math.ceil(full / PAINT_CHUNK);
  const chunks: (THREE.Texture | null)[][] = [];
  for (let r = 0; r < n; r++) {
    const row: (THREE.Texture | null)[] = [];
    chunks.push(row);
    for (let c = 0; c < n; c++) {
      await new Promise((res) => setTimeout(res, 0));
      const x0 = c * PAINT_CHUNK;
      const y0 = r * PAINT_CHUNK;
      const w = Math.min(PAINT_CHUNK, full - x0);
      const h = Math.min(PAINT_CHUNK, full - y0);
      let tex: THREE.Texture | null = null;
      try {
        if (grid) {
          const data = paintTerrainPixels(grid, def.size, def.biome, def.random!.seed, px, x0, y0, w, h);
          const cv = document.createElement("canvas");
          cv.width = w;
          cv.height = h;
          const ctx = cv.getContext("2d");
          if (ctx) {
            ctx.putImageData(new ImageData(data as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0);
            tex = new THREE.CanvasTexture(cv);
          }
        }
      } catch (e) {
        console.warn("terrain paint failed:", def.id, c, r, e);
      }
      row.push(tex);
      progress?.((r * n + c + 1) / (n * n));
    }
  }
  return { chunks, rock: null, pxPerTile: px, chunk: PAINT_CHUNK };
}
