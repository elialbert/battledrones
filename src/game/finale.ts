import type { Fx } from "./render/fx";
import { Ease } from "./three/tween";
import type { View } from "./three/view";

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
  view: View;
  fx: Fx;
  /** Dying HQ centre (tiles) and footprint size (tiles). */
  x: number;
  y: number;
  size: number;
  /** False when no HQ died (an op ended on its objective): no blasts, just the slow-mo, flash and banner. */
  blasts?: boolean;
  /** Screen point (CSS px) the HQ should end up under: the middle of the free area, clear of the HUD dock. */
  screenX?: number;
  screenY?: number;
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

  private pan: { x0: number; y0: number; t: number } | null;

  constructor(private o: FinaleOpts) {
    this.apply(FINALE.slow);
    const rig = o.view.rig;
    this.pan = { x0: rig.x, y0: rig.y, t: 0 };
  }

  /** Glide the camera so the HQ lands mid free area (recomputed as the zoom pushes in). */
  private glide(realMs: number): void {
    const p = this.pan;
    if (!p) return;
    p.t = Math.min(FINALE.panMs, p.t + realMs);
    const rig = this.o.view.rig;
    const to = rig.targetFor(this.o.x, this.o.y, this.o.screenX ?? rig.width / 2, this.o.screenY ?? rig.height / 2);
    const k = Ease.sineInOut(p.t / FINALE.panMs);
    rig.x = p.x0 + (to.x - p.x0) * k;
    rig.y = p.y0 + (to.y - p.y0) * k;
    rig.apply();
    if (p.t >= FINALE.panMs) this.pan = null;
  }

  /** Advance with the real (unscaled) frame delta. */
  update(realMs: number): void {
    if (this.done) return;
    this.t += realMs;
    this.glide(realMs);
    const v = this.o.view;
    // staged chain of blasts across the footprint, outside-in (real time,
    // like everything here, so a slow frame can't reorder the beats)
    const n = this.o.blasts === false ? 0 : Math.min(FINALE.blasts, this.spots.length);
    while (this.blasts < n && this.t >= FINALE.blastAt + this.blasts * FINALE.blastEvery) {
      const [dx, dy] = this.spots[this.blasts]!;
      const last = this.blasts === n - 1;
      const half = this.o.size / 2;
      const bx = this.o.x + dx * half;
      const by = this.o.y + dy * half;
      this.o.fx.explosion(
        { type: "explosion", x: this.o.x, y: this.o.y, size: last ? 2.2 : 1.3, air: false, kind: "building" },
        { x: bx, y: by, h: v.terrain.heightAt(bx, by) + 0.4 }
      );
      this.blasts++;
    }
    if (!this.flashed && this.t >= FINALE.flashAt) {
      this.flashed = true;
      // the core goes up: a blast front rolls out across the base and a pillar of smoke climbs
      if (n > 0) {
        const h = v.terrain.heightAt(this.o.x, this.o.y);
        this.o.fx.shock(this.o.x, this.o.y, this.o.size * 1.5, 0xfff0d8, 0.85, 800);
        this.o.fx.plume(this.o.x, this.o.y, h + 0.6, 1.4 + this.o.size * 0.3, 8);
      }
      v.stage.flash(380, 255, 244, 228);
      v.rig.shake(520, 0.011);
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

  /** Slow (or restore) every render clock: GameScene scales the frame delta for tweens, particles and effects by it. */
  private apply(k: number): void {
    this.timeScale = k;
  }
}

/**
 * How the score resolves at the flash: a fanfare for a win (or a new Last
 * Stand record), a lament for a loss. A spectator hears the winner's fanfare,
 * except in Last Stand, where the watched base is always overrun in the end.
 */
export function finaleOutcome(o: { won: boolean; newRecord: boolean; spectator: boolean; survival: boolean }): "victory" | "defeat" {
  return o.won || o.newRecord || (o.spectator && !o.survival) ? "victory" : "defeat";
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
