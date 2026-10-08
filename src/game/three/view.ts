import type * as THREE from "three";
import type { CameraRig } from "./camera";
import type { GroundGfx } from "./ground-gfx";
import type { Particles } from "./particles";
import type { ScreenLayer } from "./screen";
import type { Stage } from "./stage";
import type { Terrain3D } from "./terrain";
import type { Tweens } from "./tween";

/**
 * Everything a renderer needs from the 3D view, handed to each presenter
 * in place of the old Phaser scene. Positions are in tiles (x, y on the
 * map) plus a height h above sea level, in the same units.
 */
export interface View {
  stage: Stage;
  scene: THREE.Scene;
  rig: CameraRig;
  tweens: Tweens;
  particles: Particles;
  terrain: Terrain3D;
  screen: ScreenLayer;
  /** Ground marks darkened by the fog of war (selection rings, order lines). */
  ground: GroundGfx;
  /** Ground marks that read through the fog (objective rings, wave markers). */
  over: GroundGfx;
  /** Marks drawn over everything (calldown reticles, placement footprint). */
  top: GroundGfx;
  dpr: number;
}

/** A point in the world: tiles plus height. */
export interface P3 {
  x: number;
  y: number;
  h: number;
}

/** How high aircraft fly above the ground (world units). */
export const AIR_H = 1.35;
/** Hover tanks ride this far above the ground (or water). */
export const HOVER_H = 0.12;
