import type { World } from "./types";

/**
 * Deterministic randomness for the simulation. The sim must never call
 * Math.random(): everything random is a pure hash of the match seed plus
 * whatever identifies the decision (tick, entity id, a salt string…), so
 * a match replays identically from the same seed and commands.
 */

/** 32-bit integer hash of any number of integers (murmur-style finaliser). */
export function hash32(...xs: number[]): number {
  let h = 0x9e3779b9 | 0;
  for (const x of xs) {
    h = Math.imul(h ^ (x | 0), 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
  }
  return h >>> 0;
}

/** Stable integer for a short string salt (e.g. "drop", "wave"). */
export function saltOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Uniform float in [0, 1) derived from the match seed and the given keys. */
export function worldRandom(w: World, salt: string, ...keys: number[]): number {
  return hash32(w.seed, saltOf(salt), ...keys) / 4294967296;
}

/** Integer in [0, n) derived from the match seed and the given keys. */
export function worldPick(w: World, n: number, salt: string, ...keys: number[]): number {
  return Math.floor(worldRandom(w, salt, ...keys) * n) % Math.max(1, n);
}
