import { Terrain, type World } from "./types";
import { createWorld, setTerrain, spawnBuilding, spawnUnit, inBounds } from "./world";

export const MAP_SIZE = 48;

/**
 * The MVP skirmish map: 48×48, point-symmetric (rotated 180°).
 * Blue HQ bottom-left, red HQ top-right, a scrap field near each base,
 * one contested field mid-map, rock ridges forming ground chokepoints
 * that air units overfly.
 */
export function createSkirmishWorld(): World {
  const w = createWorld(MAP_SIZE, MAP_SIZE);
  const mirror = (tx: number, ty: number): [number, number] => [
    MAP_SIZE - 1 - tx,
    MAP_SIZE - 1 - ty
  ];

  const rockBoth = (tx: number, ty: number) => {
    if (inBounds(w, tx, ty)) setTerrain(w, tx, ty, Terrain.Rock);
    const [mx, my] = mirror(tx, ty);
    if (inBounds(w, mx, my)) setTerrain(w, mx, my, Terrain.Rock);
  };
  const scrapBoth = (tx: number, ty: number) => {
    if (inBounds(w, tx, ty)) setTerrain(w, tx, ty, Terrain.Scrap);
    const [mx, my] = mirror(tx, ty);
    if (inBounds(w, mx, my)) setTerrain(w, mx, my, Terrain.Scrap);
  };

  // Central ridge with two gaps (chokepoints), running NW–SE across the middle.
  for (let i = -14; i <= 14; i++) {
    const tx = 24 + i;
    const ty = 24 - Math.round(i * 0.35);
    if (Math.abs(i) === 5 || Math.abs(i) === 6) continue; // the gaps
    rockBoth(tx, ty);
    rockBoth(tx, ty + 1);
  }

  // Rock clusters shielding each base's flank.
  for (const [cx, cy] of [
    [14, 30],
    [30, 42]
  ] as const)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        if (Math.abs(dx) + Math.abs(dy) < 2) rockBoth(cx + dx, cy + dy);

  // Home scrap field near the blue base (mirrored for red).
  for (let ty = 36; ty <= 38; ty++)
    for (let tx = 12; tx <= 14; tx++) scrapBoth(tx, ty);

  // Contested central field (self-mirroring around the centre).
  for (let ty = 22; ty <= 25; ty++)
    for (let tx = 22; tx <= 25; tx++)
      if (w.terrain[ty * MAP_SIZE + tx] === Terrain.Ground)
        setTerrain(w, tx, ty, Terrain.Scrap);

  // HQs: blue bottom-left, red top-right (3×3 footprints).
  spawnBuilding(w, "hq", "blue", 4, 40);
  spawnBuilding(w, "hq", "red", 41, 5);

  // Starting harvester next to each HQ.
  spawnUnit(w, "harvester", "blue", 8.5, 41.5);
  spawnUnit(w, "harvester", "red", 39.5, 6.5);

  return w;
}
