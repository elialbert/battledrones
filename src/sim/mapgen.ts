import type { Biome } from "./types";
import type { MapDef } from "./maps";

/**
 * Random maps: a seeded generator for 108×108 (the largest map's size),
 * point-symmetric skirmish maps on any biome. CONTRACT STUB — the generator
 * agent replaces the bodies below; the exported names and signatures are fixed.
 *
 * Ids look like "random-<biome>-<code>": <code> is the 32-bit seed in lowercase
 * base 36 (seedCode), e.g. "random-volcanic-k3x9a". The same id always grows
 * the same map, tile for tile.
 */

export const RANDOM_MAP_SIZE = 108;
export const RANDOM_PREFIX = "random-";
export const BIOMES: readonly Biome[] = ["temperate", "desert", "arctic", "volcanic", "tropical"];

/** The seed as players share it: lowercase base 36. */
export const seedCode = (seed: number): string => (seed >>> 0).toString(36);

/** A seed from whatever a player typed: a base-36 code (1–6 chars) as is, any other text hashed. */
export function seedFromText(text: string): number {
  throw new Error("stub");
}

export const randomMapId = (biome: Biome, seed: number): string => `${RANDOM_PREFIX}${biome}-${seedCode(seed)}`;

export function parseRandomMapId(id: string): { biome: Biome; seed: number } | null {
  throw new Error("stub");
}

export const isRandomMapId = (id: string): boolean => id.startsWith(RANDOM_PREFIX);

/** The generated map for an id (cached), or null if the id is malformed. */
export function randomMapDef(id: string): MapDef | null {
  throw new Error("stub");
}

/** A fresh random map id (menu side: Math.random is fine there); biome omitted → any biome. */
export function rollRandomMapId(biome?: Biome, rnd: () => number = Math.random): string {
  throw new Error("stub");
}
