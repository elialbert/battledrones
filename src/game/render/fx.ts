import Phaser from "phaser";
import { sfx, type SfxName } from "../audio";
import { ART_SCALE, ATLAS, TILE } from "../assets";
import type { Biome, Faction, FxEvent, Projectile, WeaponFx } from "../../sim/types";

type ShotEvent = Extract<FxEvent, { type: "shot" }>;

/** A purely visual projectile (tracer, rocket, missile) flying for `dur` ms. */
interface Flier {
  img: Phaser.GameObjects.Image;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Bezier control point (missiles curve), else null. */
  cx: number | null;
  cy: number | null;
  t: number;
  dur: number;
  trail: number;
  onHit?: () => void;
}

/** Height (world px) an aircraft flies above its ground shadow. */
export const AIR_LIFT = 22;

const LASER_TINT: Record<Faction, number> = { blue: 0x7fd4ff, red: 0xff6a4a };
const DUST_TINT: Record<Biome, number> = {
  temperate: 0x8a7453, desert: 0xd8b77a, arctic: 0xf2f6ff, volcanic: 0x5d5752
};

export class Fx {
  private fliers: Flier[] = [];
  private shells = new Map<number, { img: Phaser.GameObjects.Image; shadow: Phaser.GameObjects.Image }>();
  private decals: Phaser.GameObjects.Image[] = [];
  private smoke: Phaser.GameObjects.Particles.ParticleEmitter;
  private fire: Phaser.GameObjects.Particles.ParticleEmitter;
  private sparks: Phaser.GameObjects.Particles.ParticleEmitter;
  private debris: Phaser.GameObjects.Particles.ParticleEmitter;
  private dustE: Phaser.GameObjects.Particles.ParticleEmitter;
  private trailE: Phaser.GameObjects.Particles.ParticleEmitter;
  private healE: Phaser.GameObjects.Particles.ParticleEmitter;

  constructor(
    private scene: Phaser.Scene,
    biome: Biome,
    /** Volume for a sound at world px (x, y): 0 when far off-screen. */
    private earshot: (x: number, y: number) => number
  ) {
    const add = (tex: string, cfg: Phaser.Types.GameObjects.Particles.ParticleEmitterConfig, depth: number) =>
      scene.add.particles(0, 0, tex, { emitting: false, ...cfg }).setDepth(depth);
    this.smoke = add("fx-smoke", {
      lifespan: { min: 900, max: 1800 }, speed: { min: 4, max: 22 }, angle: { min: 200, max: 340 },
      scale: { start: 0.5, end: 1.6 }, alpha: { start: 0.55, end: 0 }, rotate: { min: 0, max: 360 },
      tint: [0x3a3a3a, 0x555555, 0x2a2826]
    }, 7.2);
    this.fire = add("fx-glow", {
      lifespan: { min: 250, max: 600 }, speed: { min: 10, max: 60 },
      scale: { start: 0.7, end: 0.1 }, alpha: { start: 0.9, end: 0 },
      tint: [0xffc257, 0xff7a1e, 0xffe39a], blendMode: Phaser.BlendModes.ADD
    }, 7.3);
    this.sparks = add("fx-spark", {
      lifespan: { min: 150, max: 450 }, speed: { min: 60, max: 260 },
      scale: { start: 1, end: 0.2 }, alpha: { start: 1, end: 0 }, blendMode: Phaser.BlendModes.ADD
    }, 7.4);
    this.debris = add("fx-shell", {
      lifespan: { min: 400, max: 800 }, speed: { min: 50, max: 180 }, gravityY: 260,
      scale: { start: 0.6, end: 0.3 }, alpha: { start: 1, end: 0.2 }, rotate: { min: 0, max: 360 },
      tint: 0x2b2b2b
    }, 7.1);
    this.dustE = add("fx-smoke", {
      lifespan: { min: 500, max: 900 }, speed: { min: 2, max: 10 },
      scale: { start: 0.25, end: 0.7 }, alpha: { start: 0.35, end: 0 }, tint: DUST_TINT[biome]
    }, 2.9);
    this.trailE = add("fx-smoke", {
      lifespan: { min: 300, max: 550 }, speed: { min: 0, max: 6 },
      scale: { start: 0.18, end: 0.45 }, alpha: { start: 0.45, end: 0 }, tint: 0xcfcfcf
    }, 7.5);
    this.healE = add("fx-spark", {
      lifespan: { min: 300, max: 600 }, speed: { min: 10, max: 40 }, angle: { min: 240, max: 300 },
      scale: { start: 0.9, end: 0 }, alpha: { start: 1, end: 0 }, tint: 0x7dff9a, blendMode: Phaser.BlendModes.ADD
    }, 7.6);
  }

  private sound(name: SfxName, x: number, y: number, vol = 1): void {
    sfx.play(name, vol * this.earshot(x, y));
  }

  // ------------------------------------------------------------- shots ---

  /**
   * A weapon fired from `from` toward `to` (world px, already lifted for
   * aircraft). `faction` colours lasers.
   */
  shot(ev: ShotEvent, from: { x: number; y: number }, to: { x: number; y: number }, faction: Faction): void {
    const fx: WeaponFx = ev.fx;
    const flash = (scale: number, tint = 0xffd27a) =>
      this.flash(from.x, from.y, scale, tint);
    switch (fx) {
      case "cannon":
        flash(0.55);
        this.tracer(from, to, 1, () => this.impact(to.x, to.y, 0.35, ev.air));
        this.sound("cannon", from.x, from.y, 0.8);
        break;
      case "heavy-cannon":
        flash(1.1);
        this.smoke.emitParticleAt(from.x, from.y, 2);
        this.tracer(from, to, 1.8, () => this.impact(to.x, to.y, 0.7, ev.air));
        this.sound("heavy", from.x, from.y);
        break;
      case "mg":
        flash(0.35);
        this.tracer(from, to, 0.6);
        this.sound("mg", from.x, from.y, 0.6);
        break;
      case "flak": {
        flash(0.45);
        this.tracer(from, to, 0.7, () => {
          const bx = to.x + (Math.random() - 0.5) * 30;
          const by = to.y + (Math.random() - 0.5) * 30;
          this.flash(bx, by, 0.5, 0xffb35a);
          this.smoke.emitParticleAt(bx, by, 1);
          this.sparks.emitParticleAt(bx, by, 3);
        });
        this.sound("flak", from.x, from.y, 0.7);
        break;
      }
      case "rockets":
        for (const side of [-1, 1]) {
          const nx = -(to.y - from.y);
          const ny = to.x - from.x;
          const len = Math.hypot(nx, ny) || 1;
          const o = { x: from.x + (nx / len) * 7 * side, y: from.y + (ny / len) * 7 * side };
          this.missile(o, to, 240 + side * 30, 0.7, false, () => this.impact(to.x, to.y, 0.45, ev.air));
        }
        this.sound("rocket", from.x, from.y, 0.7);
        break;
      case "missile":
        this.missile(from, to, 420, 0.85, true, () => this.impact(to.x, to.y, 0.5, ev.air));
        this.sound("missile", from.x, from.y, 0.7);
        break;
      case "laser":
        this.beam(from, to, LASER_TINT[faction], 5, 200);
        this.flash(from.x, from.y, 0.45, LASER_TINT[faction]);
        this.flash(to.x, to.y, 0.6, LASER_TINT[faction]);
        this.sparks.emitParticleAt(to.x, to.y, 3);
        this.sound("laser", from.x, from.y, 0.7);
        break;
      case "shell":
        flash(0.9);
        this.smoke.emitParticleAt(from.x, from.y, 3);
        this.sound("shell", from.x, from.y);
        break;
      case "bomb":
        this.sound("bomb", from.x, from.y, 0.6);
        break;
    }
  }

  private flash(x: number, y: number, scale: number, tint: number, alpha = 1): void {
    const img = this.scene.add
      .image(x, y, "fx-glow")
      .setDepth(7.7)
      .setScale(scale)
      .setTint(tint)
      .setAlpha(alpha)
      .setBlendMode(Phaser.BlendModes.ADD);
    this.scene.tweens.add({ targets: img, alpha: 0, scale: scale * 1.4, duration: 90, onComplete: () => img.destroy() });
  }

  private tracer(from: { x: number; y: number }, to: { x: number; y: number }, scale: number, onHit?: () => void): void {
    const d = Math.hypot(to.x - from.x, to.y - from.y);
    const img = this.scene.add
      .image(from.x, from.y, "fx-tracer")
      .setDepth(7.6)
      .setScale(0.6 * scale, 0.9 * scale)
      .setRotation(Math.atan2(to.x - from.x, -(to.y - from.y)))
      .setBlendMode(Phaser.BlendModes.ADD);
    this.fliers.push({
      img, x0: from.x, y0: from.y, x1: to.x, y1: to.y, cx: null, cy: null,
      t: 0, dur: Phaser.Math.Clamp(d * 0.35, 50, 180), trail: 0, onHit
    });
  }

  private missile(
    from: { x: number; y: number }, to: { x: number; y: number }, dur: number, scale: number, curve: boolean, onHit?: () => void
  ): void {
    const img = this.scene.add.image(from.x, from.y, "fx-missile").setDepth(7.6).setScale(scale);
    let cx: number | null = null;
    let cy: number | null = null;
    if (curve) {
      const mx = (from.x + to.x) / 2;
      const my = (from.y + to.y) / 2;
      const nx = -(to.y - from.y);
      const ny = to.x - from.x;
      const k = (Math.random() - 0.5) * 0.6;
      cx = mx + nx * k;
      cy = my + ny * k;
    }
    this.fliers.push({ img, x0: from.x, y0: from.y, x1: to.x, y1: to.y, cx, cy, t: 0, dur, trail: 1, onHit });
  }

  /** Stretched additive beam between two points. */
  beam(from: { x: number; y: number }, to: { x: number; y: number }, tint: number, width: number, dur: number): void {
    const d = Math.hypot(to.x - from.x, to.y - from.y);
    const img = this.scene.add
      .image((from.x + to.x) / 2, (from.y + to.y) / 2, "fx-beam")
      .setDepth(7.65)
      .setDisplaySize(d, width * 2.4)
      .setRotation(Math.atan2(to.y - from.y, to.x - from.x))
      .setTint(tint)
      .setBlendMode(Phaser.BlendModes.ADD);
    this.scene.tweens.add({ targets: img, alpha: 0, duration: dur, ease: "Quad.easeIn", onComplete: () => img.destroy() });
  }

  heal(from: { x: number; y: number }, to: { x: number; y: number }): void {
    this.beam(from, to, 0x7dff9a, 3.5, 420);
    this.healE.emitParticleAt(to.x, to.y, 2);
    this.sound("heal", to.x, to.y, 0.35);
  }

  // --------------------------------------------------------- explosions ---

  private impact(x: number, y: number, size: number, air: boolean): void {
    this.sparks.emitParticleAt(x, y, Math.round(3 + size * 4));
    if (size > 0.4) this.boom(x, y, size * 0.6, air, false, 1, 0.7);
    else this.flash(x, y, size * 1.2, 0xffc26a);
    if (!air && size > 0.3) this.dustE.emitParticleAt(x, y, 1);
  }

  /**
   * Animated fireball + fire/smoke/debris particles. `flashK`/`flashA` size
   * the additive glow: small deaths and impacts keep it modest so the
   * fight underneath stays readable; building deaths keep the full bloom.
   */
  private boom(x: number, y: number, size: number, air: boolean, decal: boolean, flashK = 1.5, flashA = 1): void {
    const s = this.scene.add
      .sprite(x, y, ATLAS, "explosion/0")
      .setDepth(air ? 7.8 : 7)
      .setScale(ART_SCALE * size * 0.62)
      .setRotation(Math.random() * Math.PI * 2);
    s.play("boom");
    s.once(Phaser.Animations.Events.ANIMATION_COMPLETE, () => s.destroy());
    this.flash(x, y, size * flashK, 0xffa640, flashA);
    // fewer additive fire puffs for small booms: they pile up into a white blob over the fight
    this.fire.emitParticleAt(x, y, Math.round(size < 1 ? 1 + size * 4 : 3 + size * 5));
    this.smoke.emitParticleAt(x, y, Math.round(size < 1 ? size * 2 : 1 + size * 3));
    if (decal && !air) this.decal(x, y, size);
  }

  explosion(ev: Extract<FxEvent, { type: "explosion" }>, lifted: { x: number; y: number }): void {
    const x = lifted.x;
    const y = lifted.y;
    if (ev.kind === "building") {
      const size = ev.size;
      for (let i = 0; i < 3 + size * 2; i++) {
        const ox = (Math.random() - 0.5) * size * TILE * 0.8;
        const oy = (Math.random() - 0.5) * size * TILE * 0.8;
        this.scene.time.delayedCall(i * 110, () => this.boom(x + ox, y + oy, 1.2 + Math.random() * 0.8, false, i === 0));
      }
      this.debris.emitParticleAt(x, y, 14);
      // camera shake is decided by render/juice-view.ts (on-screen deaths only)
      this.sound("bigExplosion", x, y);
    } else if (ev.kind === "unit") {
      // small hulls pop smaller; Titans and Hornets keep their big fireball
      this.boom(x, y, ev.size >= 1 ? 0.8 + ev.size : 0.5 + ev.size * 0.85, ev.air, true, 0.9, 0.85);
      this.debris.emitParticleAt(x, y, 6);
      this.sound("explosion", x, y, 0.9);
      if (ev.air) {
        // wreck falls to the ground and burns out there
        this.scene.time.delayedCall(260, () => {
          this.boom(x + 6, y + AIR_LIFT, 0.6, false, true);
        });
      }
    } else {
      this.boom(x, y, 0.5 + ev.size * 0.7, false, true, 1.1, 0.8);
      this.sound("explosion", x, y, 0.7);
    }
  }

  private decal(x: number, y: number, size: number): void {
    const frame = `decal/${[0, 1, 2, 5][Math.floor(Math.random() * 4)]}`;
    const d = this.scene.add
      .image(x, y, ATLAS, frame)
      .setDepth(1.05)
      .setScale(ART_SCALE * (0.35 + size * 0.35))
      .setRotation(Math.random() * Math.PI * 2)
      .setAlpha(0.85);
    this.decals.push(d);
    this.scene.tweens.add({ targets: d, alpha: 0, delay: 25000, duration: 15000, onComplete: () => d.destroy() });
    if (this.decals.length > 70) this.decals.shift()?.destroy();
  }

  /** Rubble left where a building stood (+ scorch). */
  rubble(x: number, y: number, size: number): Phaser.GameObjects.Image {
    return this.scene.add
      .image(x, y, ATLAS, `rubble/${Math.floor(Math.random() * 4)}`)
      .setDepth(1.1)
      .setDisplaySize(size * TILE * 1.05, size * TILE * 1.05)
      .setAlpha(0.95);
  }

  // ------------------------------------------------------ ambient bits ---

  dust(x: number, y: number): void {
    this.dustE.emitParticleAt(x, y, 1);
  }

  buildingSmoke(x: number, y: number, burning: boolean): void {
    this.smoke.emitParticleAt(x, y, 1);
    if (burning) this.fire.emitParticleAt(x, y, 1);
  }

  pulse(x: number, y: number, tint: number, scale = 1.2): void {
    const r = this.scene.add
      .image(x, y, "fx-ring")
      .setDepth(7.9)
      .setScale(0.3 * scale)
      .setTint(tint)
      .setBlendMode(Phaser.BlendModes.ADD);
    this.scene.tweens.add({ targets: r, scale: 1.3 * scale, alpha: 0, duration: 500, onComplete: () => r.destroy() });
  }

  /** A command marker where the player tapped (move / attack). */
  marker(x: number, y: number, tint: number): void {
    const r = this.scene.add.image(x, y, "fx-select").setDepth(8.5).setScale(0.45).setTint(tint).setAlpha(0.9);
    this.scene.tweens.add({ targets: r, scale: 0.12, alpha: 0, duration: 450, ease: "Quad.easeIn", onComplete: () => r.destroy() });
  }

  // ------------------------------------------------------------ per frame ---

  update(dtMs: number): void {
    const keep: Flier[] = [];
    for (const f of this.fliers) {
      f.t += dtMs;
      const k = Math.min(1, f.t / f.dur);
      let x: number;
      let y: number;
      if (f.cx !== null && f.cy !== null) {
        const a = (1 - k) * (1 - k);
        const b = 2 * (1 - k) * k;
        const c = k * k;
        x = a * f.x0 + b * f.cx + c * f.x1;
        y = a * f.y0 + b * f.cy + c * f.y1;
      } else {
        x = f.x0 + (f.x1 - f.x0) * k;
        y = f.y0 + (f.y1 - f.y0) * k;
      }
      f.img.setRotation(Math.atan2(x - f.img.x, -(y - f.img.y)) || f.img.rotation);
      f.img.setPosition(x, y);
      if (f.trail && Math.random() < 0.8) this.trailE.emitParticleAt(x, y, 1);
      if (k >= 1) {
        f.img.destroy();
        f.onHit?.();
      } else keep.push(f);
    }
    this.fliers = keep;
  }

  /** Draw the sim's slow projectiles (shells arc, bombs fall). */
  projectiles(list: Projectile[], alpha: number, prev: Map<number, { x: number; y: number }>): void {
    const seen = new Set<number>();
    for (const p of list) {
      seen.add(p.id);
      let v = this.shells.get(p.id);
      if (!v) {
        v = {
          img: this.scene.add.image(0, 0, "fx-shell").setDepth(7.7),
          shadow: this.scene.add.image(0, 0, "fx-shell").setDepth(2.95).setTint(0x000000).setAlpha(0.35)
        };
        this.shells.set(p.id, v);
      }
      const pp = prev.get(p.id) ?? { x: p.x, y: p.y };
      const x = (pp.x + (p.x - pp.x) * alpha) * TILE;
      const y = (pp.y + (p.y - pp.y) * alpha) * TILE;
      const total = Math.hypot(p.tx - p.sx, p.ty - p.sy) || 1;
      const k = Math.min(1, Math.hypot(p.x - p.sx, p.y - p.sy) / total);
      let lift: number;
      let scale: number;
      if (p.fromAir) {
        lift = AIR_LIFT * (1 - k);
        scale = 0.9 - k * 0.3;
      } else {
        lift = 4 * k * (1 - k) * Math.min(90, total * TILE * 0.35);
        scale = 0.7 + lift / 110;
      }
      v.img.setPosition(x, y - lift).setScale(scale);
      v.shadow.setPosition(x + lift * 0.15, y + lift * 0.1).setScale(0.6);
      if (!p.fromAir && Math.random() < 0.5) this.trailE.emitParticleAt(x, y - lift, 1);
    }
    for (const [id, v] of this.shells)
      if (!seen.has(id)) {
        v.img.destroy();
        v.shadow.destroy();
        this.shells.delete(id);
      }
  }
}
