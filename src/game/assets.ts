import * as THREE from "three";
import type { Biome, BuildingKind, UnitKind } from "../sim/types";
import { isRandomMapId } from "../sim/mapgen";
import { mapById } from "../sim/maps";
import { mapAssetBase, terrainChunkUrl } from "./map-art";
import { paintMapPixels, paintTerrainArt } from "./terrain-paint";
import type { TerrainArt } from "./three/terrain";

export { mapAssetBase } from "./map-art";

/** Painted terrain images: 48 px per tile, split into 1024 px chunks. */
export const TERRAIN_PX = 48;
export const TERRAIN_CHUNK = 1024;

export const UNIT_KINDS: UnitKind[] = [
  "harvester", "scout", "stinger", "flak-crawler", "mortar", "mastodon", "lancer",
  "wasp", "raptor", "hornet", "mender", "trooper", "rocket-squad", "sniper", "condor", "goliath"
];
export const BUILDING_KINDS: BuildingKind[] = [
  "hq", "fab-plant", "airpad", "tech-lab", "depot", "turret", "sam-site", "radar", "assembly-bay", "gantry"
];

/** Terrain chunk grid for a map (chunks per side). */
export function terrainChunks(mapSize: number): number {
  return Math.ceil((mapSize * TERRAIN_PX) / TERRAIN_CHUNK);
}

/** A biome's rock material (art/textures.py): the 3D cliffs and crags are textured with it. */
export function rockTextureUrl(biome: Biome): string {
  return `assets/textures/rock-${biome}.webp`;
}

/** A biome's rock material, or null (the rocks go untextured) if it fails. */
const loadRock = (loader: THREE.TextureLoader, biome: Biome): Promise<THREE.Texture | null> =>
  loader.loadAsync(rockTextureUrl(biome)).catch(() => {
    console.warn("rock texture failed:", biome);
    return null;
  });

/**
 * Load a map's painted terrain chunks (draped over the 3D heightfield) and
 * its biome's rock material. A missing chunk loads as null — the terrain
 * falls back to flat colours there — and a missing rock texture leaves the
 * rocks untextured, so a bad network never stalls the boot. A generated map
 * has no pre-painted chunks: its ground is painted here and now (terrain-paint.ts).
 */
export async function loadTerrainArt(
  mapId: string,
  mapSize: number,
  biome: Biome,
  progress?: (k: number) => void
): Promise<TerrainArt> {
  const loader = new THREE.TextureLoader();
  if (isRandomMapId(mapId)) {
    const [art, rock] = await Promise.all([paintTerrainArt(mapById(mapId), progress), loadRock(loader, biome)]);
    return { ...art, rock };
  }
  const n = terrainChunks(mapSize);
  let done = 0;
  const total = n * n + 1;
  const chunks: (THREE.Texture | null)[][] = [];
  let rock: THREE.Texture | null = null;
  const jobs: Promise<void>[] = [
    loadRock(loader, biome).then((tex) => {
      rock = tex;
      progress?.(++done / total);
    })
  ];
  for (let r = 0; r < n; r++) {
    const row: (THREE.Texture | null)[] = [];
    chunks.push(row);
    for (let c = 0; c < n; c++) {
      row.push(null);
      jobs.push(
        loader
          .loadAsync(terrainChunkUrl(mapId, c, r))
          .then((tex) => {
            row[c] = tex;
          })
          .catch(() => console.warn("terrain chunk failed:", mapId, c, r))
          .finally(() => progress?.(++done / total))
      );
    }
  }
  await Promise.all(jobs);
  return { chunks, rock, pxPerTile: TERRAIN_PX, chunk: TERRAIN_CHUNK };
}

/** Overview image size (px), as art/terrain.py writes the built-in maps' thumbs. */
const THUMB = 256;
/** Painted px per tile for a generated map's overview, before it's scaled to THUMB. */
const THUMB_PX = 3;
const thumbs = new Map<string, string>();

/**
 * A map's overview image (map picker, minimap): the painted thumb, or for a
 * generated map one painted now (a PNG data URL, memoised per id). Without a
 * DOM, or for a malformed id, the asset path.
 */
export function mapThumbUrl(mapId: string): string {
  const path = `${mapAssetBase(mapId)}/thumb.webp`;
  if (!isRandomMapId(mapId) || typeof document === "undefined") return path;
  const hit = thumbs.get(mapId);
  if (hit) return hit;
  try {
    const def = mapById(mapId);
    const data = paintMapPixels(def, THUMB_PX);
    if (!data) return path;
    const n = def.size * THUMB_PX;
    const src = document.createElement("canvas");
    src.width = src.height = n;
    src.getContext("2d")!.putImageData(new ImageData(data as Uint8ClampedArray<ArrayBuffer>, n, n), 0, 0);
    const cv = document.createElement("canvas");
    cv.width = cv.height = THUMB;
    const ctx = cv.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, 0, 0, THUMB, THUMB);
    const url = cv.toDataURL("image/png");
    thumbs.set(mapId, url);
    return url;
  } catch {
    return path;
  }
}
