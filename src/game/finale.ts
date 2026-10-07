import Phaser from "phaser";
import { TILE } from "./assets";
import type { Fx } from "./render/fx";

/**
 * The cinematic HQ kill (render only — the sim has already stopped at the
 * winner): everything drops to slow motion, the camera glides and zooms onto
 * the dying HQ, a staged chain of explosions rolls across its footprint, a
 * white flash and a heavy shake, then real time resumes and the end screen
 * arrives at ~2.8 s.
 */

export const FINALE = {
  /** Render time scale during the slow-motion stretch. */
  slow: 0.3,
  /** Camera glide onto the HQ (real ms). */
  panMs: 900,
  /** First blast, interval between blasts, and how many (real ms). */
  blastAt: 250,
  blastEvery: 250,
  blasts: 5,
  /** White flash; slow motion eases back to real time after it. */
  flashAt: 1500,
  easeOutMs: 700,
  /** End screen. */
  doneAt: 2800
};

export interface FinaleOpts {
  scene: Phaser.Scene;
  fx: Fx;
  /** Dying HQ centre (tiles) and footprint size (tiles). */
  x: number;
  y: number;
  size: number;
  /** False when no HQ died (an op ended on its objective): no blasts, just the slow-mo, flash and banner. */
  blasts?: boolean;
  /** World-px shift of the camera target so the HQ sits mid free area (clear of the HUD dock). */
  shiftX?: number;
  shiftY?: number;
  /** At the flash: announce the result, play the stinger. */
  onFlash(): void;
  /** At the end: show the end screen. */
  onDone(): void;
}

export class Finale {
  /** Current render time scale (GameScene scales frame deltas by it). */
  timeScale = FINALE.slow;
  private t = 0;
  private flashed = false;
  private done = false;
  private blasts = 0;
  private spots: [number, number][] = [
    [-0.55, -0.45], [0.5, -0.5], [-0.45, 0.5], [0.55, 0.45], [0, 0]
  ];

  constructor(private o: FinaleOpts) {
    const s = o.scene;
    const cam = s.cameras.main;
    this.apply(FINALE.slow);
    cam.pan(o.x * TILE - (o.shiftX ?? 0), o.y * TILE - (o.shiftY ?? 0), FINALE.panMs, "Sine.easeInOut", true);
  }

  /** Advance with the real (unscaled) frame delta. */
  update(realMs: number): void {
    if (this.done) return;
    this.t += realMs;
    const s = this.o.scene;
    // staged chain of blasts across the footprint, outside-in (real time,
    // like everything here, so a slow frame can't reorder the beats)
    const n = this.o.blasts === false ? 0 : Math.min(FINALE.blasts, this.spots.length);
    while (this.blasts < n && this.t >= FINALE.blastAt + this.blasts * FINALE.blastEvery) {
      const [dx, dy] = this.spots[this.blasts]!;
      const last = this.blasts === n - 1;
      const half = (this.o.size * TILE) / 2;
      this.o.fx.explosion(
        { type: "explosion", x: this.o.x, y: this.o.y, size: last ? 2.2 : 1.3, air: false, kind: "building" },
        { x: this.o.x * TILE + dx * half, y: this.o.y * TILE + dy * half }
      );
      this.blasts++;
    }
    if (!this.flashed && this.t >= FINALE.flashAt) {
      this.flashed = true;
      s.cameras.main.flash(380, 255, 244, 228, true);
      s.cameras.main.shake(520, 0.011, true);
      this.o.onFlash();
    }
    if (this.flashed) {
      const k = Math.min(1, (this.t - FINALE.flashAt) / FINALE.easeOutMs);
      this.apply(FINALE.slow + (1 - FINALE.slow) * k * k);
    }
    if (this.t >= FINALE.doneAt) {
      this.done = true;
      this.apply(1);
      this.o.onDone();
    }
  }

  /** Slow (or restore) every render clock: tweens, sprite anims, particles. */
  private apply(k: number): void {
    this.timeScale = k;
    const s = this.o.scene;
    s.tweens.timeScale = k;
    s.anims.globalTimeScale = k;
    for (const obj of s.children.list)
      if (obj instanceof Phaser.GameObjects.Particles.ParticleEmitter) obj.timeScale = k;
  }
}

/** Zoom the finale settles at: a push-in, but never further out than `atLeast`. */
export function finaleZoom(current: number, atLeast: number): number {
  return Math.max(current * 1.3, atLeast);
}

/**
 * Where the middle of the unobstructed battlefield sits relative to the
 * canvas centre, in CSS px: the build dock covers the bottom (portrait) or
 * the right edge (landscape).
 */
export function freeAreaOffset(): { x: number; y: number } {
  const bar = document.querySelector(".buildbar")?.getBoundingClientRect();
  const W = window.innerWidth;
  const H = window.innerHeight;
  if (!bar || bar.width === 0 || bar.height === 0) return { x: 0, y: 0 };
  if (bar.top > H * 0.4) return { x: 0, y: (bar.top - H) / 2 };
  if (bar.left > W * 0.4) return { x: (bar.left - W) / 2, y: 0 };
  return { x: 0, y: 0 };
}
