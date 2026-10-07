import type Phaser from "phaser";
import type { BuildingKind, Faction, UnitKind } from "../sim/types";

/** World pixels per sim tile. */
export const TILE = 64;
/** Atlas art is authored at 128 texture px per tile: sprites draw at 0.5×. */
export const ART_SCALE = TILE / 128;
/** Painted terrain images: 48 px per tile, split into 1024 px chunks. */
export const TERRAIN_PX = 48;
export const TERRAIN_CHUNK = 1024;

export const ATLAS = "game";

export const UNIT_KINDS: UnitKind[] = [
  "harvester", "scout", "stinger", "flak-crawler", "mortar", "titan", "lancer",
  "wasp", "raptor", "hornet", "mender"
];
export const BUILDING_KINDS: BuildingKind[] = [
  "hq", "fab-plant", "airpad", "tech-lab", "depot", "turret", "sam-site", "radar"
];
/** Buildings drawn with a separately rotating head. */
export const HEADED: Partial<Record<BuildingKind, true>> = { turret: true, "sam-site": true, radar: true };

export const unitFrame = (f: Faction, k: UnitKind) => `u/${f}/${k}`;
export const turretFrame = (f: Faction, k: UnitKind) => `u/${f}/${k}-turret`;
export const buildingFrame = (f: Faction, k: BuildingKind) => `b/${f}/${k}`;
export const headFrame = (f: Faction, k: BuildingKind) => `b/${f}/${k}-head`;

export interface SpriteMeta {
  pxPerTile: number;
  frames: Record<string, { origin?: [number, number] }>;
  /** Turret/head mount offset from the hull/base origin, in tiles (hull facing north). */
  mounts: Record<string, [number, number]>;
  sizes: Record<string, number>;
}

let meta: SpriteMeta = { pxPerTile: 128, frames: {}, mounts: {}, sizes: {} };

export function setSpriteMeta(m: SpriteMeta | undefined): void {
  if (m) meta = { ...meta, ...m };
}

export function frameOrigin(frame: string): [number, number] {
  return meta.frames[frame]?.origin ?? [0.5, 0.5];
}

export function mountOffset(kind: string): [number, number] {
  return meta.mounts[kind] ?? [0, 0];
}

export function mapAssetBase(mapId: string): string {
  return `assets/maps/${mapId}`;
}

export function loadAssets(load: Phaser.Loader.LoaderPlugin, mapId: string, mapSize: number): void {
  load.multiatlas(ATLAS, "assets/sprites/game.json", "assets/sprites/");
  load.json("sprite-meta", "assets/sprites/meta.json");
  const px = mapSize * TERRAIN_PX;
  const n = Math.ceil(px / TERRAIN_CHUNK);
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) load.image(`terrain-${c}-${r}`, `${mapAssetBase(mapId)}/t_${c}_${r}.webp`);
}

/** Terrain chunk grid for a map (chunks per side). */
export function terrainChunks(mapSize: number): number {
  return Math.ceil((mapSize * TERRAIN_PX) / TERRAIN_CHUNK);
}
