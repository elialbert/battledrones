import type { World } from "./types";
import { createMapWorld } from "./maps";

export const MAP_SIZE = 48;

/**
 * The classic MVP skirmish map ("Proving Grounds"): 48×48, point-symmetric.
 * Blue HQ bottom-left, red HQ top-right, a scrap field near each base, one
 * contested field mid-map, rock ridges forming ground chokepoints.
 * The other maps live in maps.ts.
 */
export function createSkirmishWorld(): World {
  return createMapWorld("proving-grounds");
}
