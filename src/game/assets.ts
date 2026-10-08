import * as THREE from "three";
import type { BuildingKind, UnitKind } from "../sim/types";
import type { TerrainArt } from "./three/terrain";

/** Painted terrain images: 48 px per tile, split into 1024 px chunks. */
export const TERRAIN_PX = 48;
export const TERRAIN_CHUNK = 1024;

export const UNIT_KINDS: UnitKind[] = [
  "harvester", "scout", "stinger", "flak-crawler", "mortar", "titan", "lancer",
  "wasp", "raptor", "hornet", "mender"
];
export const BUILDING_KINDS: BuildingKind[] = [
  "hq", "fab-plant", "airpad", "tech-lab", "depot", "turret", "sam-site", "radar"
];

export function mapAssetBase(mapId: string): string {
  return `assets/maps/${mapId}`;
}

/** Terrain chunk grid for a map (chunks per side). */
export function terrainChunks(mapSize: number): number {
  return Math.ceil((mapSize * TERRAIN_PX) / TERRAIN_CHUNK);
}

/**
 * Load a map's painted terrain chunks (draped over the 3D heightfield).
 * A missing chunk loads as null — the terrain falls back to flat colours
 * there — so a bad network never stalls the boot.
 */
export async function loadTerrainArt(mapId: string, mapSize: number, progress?: (k: number) => void): Promise<TerrainArt> {
  const n = terrainChunks(mapSize);
  const loader = new THREE.TextureLoader();
  let done = 0;
  const total = n * n;
  const chunks: (THREE.Texture | null)[][] = [];
  const jobs: Promise<void>[] = [];
  for (let r = 0; r < n; r++) {
    const row: (THREE.Texture | null)[] = [];
    chunks.push(row);
    for (let c = 0; c < n; c++) {
      row.push(null);
      jobs.push(
        loader
          .loadAsync(`${mapAssetBase(mapId)}/t_${c}_${r}.webp`)
          .then((tex) => {
            row[c] = tex;
          })
          .catch(() => console.warn("terrain chunk failed:", mapId, c, r))
          .finally(() => progress?.(++done / total))
      );
    }
  }
  await Promise.all(jobs);
  return { chunks, pxPerTile: TERRAIN_PX, chunk: TERRAIN_CHUNK };
}
