import type Phaser from "phaser";
import type { BuildingKind, Faction, UnitKind } from "../sim/types";

export const TILE = 32;

export const UNIT_KINDS: UnitKind[] = [
  "harvester",
  "scout",
  "stinger",
  "flak-crawler",
  "wasp",
  "raptor"
];

export const unitTex = (f: Faction, k: UnitKind) => `u-${f}-${k}`;
export const buildingTex = (f: Faction, k: BuildingKind) => `b-${f}-${k}`;

/** Terrain sheet indices (see ART.md). */
export const T_GROUND = [0, 1, 2];
export const T_ROCK = [3, 4];
export const T_SCRAP_FULL = 5;
export const T_SCRAP_HALF = 6;
export const T_SCRAP_EMPTY = 7;

export function loadAssets(load: Phaser.Loader.LoaderPlugin): void {
  const base = "assets/sprites";
  for (const f of ["blue", "red"] as const) {
    for (const k of UNIT_KINDS)
      load.spritesheet(unitTex(f, k), `${base}/units/${f}/${k}.png`, {
        frameWidth: TILE,
        frameHeight: TILE
      });
    load.spritesheet(buildingTex(f, "hq"), `${base}/buildings/${f}/hq.png`, {
      frameWidth: 96,
      frameHeight: 96
    });
    load.spritesheet(buildingTex(f, "fab-plant"), `${base}/buildings/${f}/fab-plant.png`, {
      frameWidth: 64,
      frameHeight: 64
    });
    load.spritesheet(buildingTex(f, "airpad"), `${base}/buildings/${f}/airpad.png`, {
      frameWidth: 64,
      frameHeight: 64
    });
    load.image(`b-${f}-turret-base`, `${base}/buildings/${f}/turret-base.png`);
    load.spritesheet(`b-${f}-turret-head`, `${base}/buildings/${f}/turret-head.png`, {
      frameWidth: TILE,
      frameHeight: TILE
    });
  }
  load.image("shadow", `${base}/units/shadow.png`);
  load.spritesheet("terrain", `${base}/terrain/tiles.png`, {
    frameWidth: TILE,
    frameHeight: TILE
  });
  load.image("fx-muzzle", `${base}/fx/muzzle.png`);
  load.image("fx-bolt", `${base}/fx/bolt.png`);
  load.spritesheet("fx-explosion", `${base}/fx/explosion.png`, {
    frameWidth: TILE,
    frameHeight: TILE
  });
}

/** Facing angle (radians, 0 = North, clockwise) to 8-direction frame index. */
export function facingFrame(facing: number): number {
  const step = Math.round(facing / (Math.PI / 4));
  return ((step % 8) + 8) % 8;
}
