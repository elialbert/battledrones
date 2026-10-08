import * as THREE from "three";
import { sfx, type SfxName } from "../audio";
import type { Biome, Faction, FxEvent, Projectile, WeaponFx } from "../../sim/types";
import { ModelBuilder } from "../three/builder";
import { glowMat, modelMat } from "../three/materials";
import { GM_D, modelMesh, rubbleGeometry } from "../three/models";
import { TEX, type EmitCfg } from "../three/particles";
import { AIR_H, type P3, type View } from "../three/view";

type ShotEvent = Extract<FxEvent, { type: "shot" }>;

/** A purely visual projectile (tracer, rocket, missile) flying for `dur` ms. */
interface Flier {
  obj: THREE.Object3D;
  a: P3;
  b: P3;
  /** Bezier control point (missiles curve), else null. */
  c: P3 | null;
  t: number;
  dur: number;
  trail: boolean;
  onHit?: () => void;
}

const LASER_TINT: Record<Faction, number> = { blue: 0x7fd4ff, red: 0xff6a4a };
const DUST_TINT: Record<Biome, number> = {
  temperate: 0x8a7453, desert: 0xd8b77a, arctic: 0xf2f6ff, volcanic: 0x5d5752
};

const SMOKE: EmitCfg = {
  tex: TEX.smoke, life: [900, 1800], speed: [0.06, 0.3], up: [0.3, 0.75], size: [0.45, 0.6], grow: [2.4, 3.2],
  alpha: [0.55, 0], tints: [0x3a3a3a, 0x555555, 0x2a2826], drag: 0.6, spin: 1.2
};
const FIRE: EmitCfg = {
  tex: TEX.glow, additive: true, life: [250, 600], speed: [0.15, 0.9], up: [0.3, 1.1], size: [0.55, 0.8], grow: [0.15, 0.3],
  alpha: [0.9, 0], tints: [0xffc257, 0xff7a1e, 0xffe39a], drag: 0.5
};
const SPARKS: EmitCfg = {
  tex: TEX.spark, additive: true, life: [150, 450], speed: [1, 4], up: [0.5, 2.6], size: [0.18, 0.26], grow: [0.2, 0.3],
  alpha: [1, 0], tints: [0xffffff], gravity: -6
};
const DEBRIS: EmitCfg = {
  tex: TEX.debris, life: [550, 900], speed: [0.8, 2.6], up: [2, 3.6], size: [0.1, 0.18], grow: [0.7, 0.9],
  alpha: [1, 0.3], tints: [0x2b2b2b, 0x3a342e], gravity: -9.5, spin: 14
};
const TRAIL: EmitCfg = {
  tex: TEX.smoke, life: [300, 550], speed: [0, 0.08], up: [0.05, 0.15], size: [0.16, 0.2], grow: [2.2, 2.8],
  alpha: [0.45, 0], tints: [0xcfcfcf]
};
const HEAL: EmitCfg = {
  tex: TEX.spark, additive: true, life: [300, 600], speed: [0.1, 0.4], up: [0.4, 0.9], size: [0.22, 0.3], grow: [0, 0.1],
  alpha: [1, 0], tints: [0x7dff9a]
};

const tracerGeo = new THREE.BoxGeometry(0.035, 0.035, 1);
let tracerMat: THREE.MeshBasicMaterial | null = null;
let missileGeo: THREE.BufferGeometry | null = null;
let shellGeo: THREE.BufferGeometry | null = null;
const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);
const up = new THREE.Vector3(0, 1, 0);

function missile(): THREE.BufferGeometry {
  if (missileGeo) return missileGeo;
  const b = new ModelBuilder();
  // built pointing +Z (Object3D.lookAt aims +Z at the target)
  b.tube(0.022, 0.2, 6, [0, 0, 0], 0xd9dde3);
  b.cone(0.022, 0.06, 6, [0, 0, 0.13], 0xc84a3a, { rot: [Math.PI / 2, 0, 0] });
  b.box(0.07, 0.006, 0.04, [0, 0, -0.08], 0x7c8490);
  b.box(0.006, 0.07, 0.04, [0, 0, -0.08], 0x7c8490);
  b.sphere(0.025, [0, 0, -0.11], 0xffd27a, { glow: 1, w: 5, h: 3 });
  return (missileGeo = b.build());
}

function shell(): THREE.BufferGeometry {
  if (shellGeo) return shellGeo;
  const b = new ModelBuilder();
  b.sphere(0.06, [0, 0, 0], GM_D, { w: 7, h: 5, scale: [1, 1, 1.5] });
  return (shellGeo = b.build());
}

export class Fx {
  private fliers: Flier[] = [];
  private shells = new Map<number, THREE.Mesh>();
  private rubbles: THREE.Object3D[] = [];
  private dustCfg: EmitCfg;

  constructor(
    private v: View,
    biome: Biome,
    /** Volume for a sound at tile point (x, y): 0 when far off-screen. */
    private earshot: (x: number, y: number) => number
  ) {
    this.dustCfg = {
      tex: TEX.smoke, life: [500, 900], speed: [0.03, 0.15], up: [0.05, 0.22], size: [0.22, 0.3], grow: [2.4, 3],
      alpha: [0.4, 0], tints: [DUST_TINT[biome]], drag: 0.7
    };
    tracerMat ??= glowMat(0xffe2a0, 1);
  }

  private sound(name: SfxName, x: number, y: number, vol = 1): void {
    sfx.play(name, vol * this.earshot(x, y));
  }

  emit(cfg: EmitCfg, p: P3, n: number): void {
    this.v.particles.emit(cfg, p.x, p.y, p.h, n);
  }

  // ------------------------------------------------------------- shots ---

  /** A weapon fired from `from` toward `to` (tiles + height). `faction` colours lasers. */
  shot(ev: ShotEvent, from: P3, to: P3, faction: Faction): void {
    const fx: WeaponFx = ev.fx;
    const flash = (scale: number, tint = 0xffd27a) => this.flash(from, scale, tint);
    switch (fx) {
      case "cannon":
        flash(0.5);
        this.tracer(from, to, 1, () => this.impact(to, 0.35, ev.air));
        this.sound("cannon", from.x, from.y, 0.8);
        break;
      case "heavy-cannon":
        flash(1.0);
        this.emit(SMOKE, from, 2);
        this.tracer(from, to, 1.8, () => this.impact(to, 0.7, ev.air));
        this.sound("heavy", from.x, from.y);
        break;
      case "mg":
        flash(0.32);
        this.tracer(from, to, 0.6);
        this.sound("mg", from.x, from.y, 0.6);
        break;
      case "flak": {
        flash(0.42);
        this.tracer(from, to, 0.7, () => {
          const p = { x: to.x + (Math.random() - 0.5) * 0.45, y: to.y + (Math.random() - 0.5) * 0.45, h: to.h + (Math.random() - 0.3) * 0.4 };
          this.flash(p, 0.6, 0xffb35a);
          this.emit(SMOKE, p, 1);
          this.emit(SPARKS, p, 3);
        });
        this.sound("flak", from.x, from.y, 0.7);
        break;
      }
      case "rockets":
        for (const side of [-1, 1]) {
          const nx = -(to.y - from.y);
          const ny = to.x - from.x;
          const len = Math.hypot(nx, ny) || 1;
          const o = { x: from.x + (nx / len) * 0.11 * side, y: from.y + (ny / len) * 0.11 * side, h: from.h };
          this.missile(o, to, 240 + side * 30, false, () => this.impact(to, 0.45, ev.air));
        }
        this.sound("rocket", from.x, from.y, 0.7);
        break;
      case "missile":
        this.missile(from, to, 420, true, () => this.impact(to, 0.5, ev.air));
        this.sound("missile", from.x, from.y, 0.7);
        break;
      case "laser":
        this.beam(from, to, LASER_TINT[faction], 5, 200);
        this.flash(from, 0.42, LASER_TINT[faction]);
        this.flash(to, 0.6, LASER_TINT[faction]);
        this.emit(SPARKS, to, 3);
        this.sound("laser", from.x, from.y, 0.7);
        break;
      case "shell":
        flash(0.85);
        this.emit(SMOKE, from, 3);
        this.sound("shell", from.x, from.y);
        break;
      case "bomb":
        this.sound("bomb", from.x, from.y, 0.6);
        break;
    }
  }

  /** A quick additive bloom. */
  flash(p: P3, scale: number, tint: number, alpha = 1): void {
    const c = new THREE.Color(tint);
    this.v.particles.spawn(
      { x: p.x, y: p.h, z: p.y, life: 110, tex: TEX.glow, size0: scale * 1.1, size1: scale * 1.6, alpha0: alpha, alpha1: 0, r: c.r, g: c.g, b: c.b },
      true
    );
  }

  private tracer(from: P3, to: P3, scale: number, onHit?: () => void): void {
    const d = Math.hypot(to.x - from.x, to.y - from.y, to.h - from.h);
    const m = new THREE.Mesh(tracerGeo, tracerMat!);
    m.scale.set(scale, scale, 0.32 * scale);
    m.renderOrder = 7;
    this.v.scene.add(m);
    this.fliers.push({ obj: m, a: from, b: to, c: null, t: 0, dur: Math.min(180, Math.max(50, d * 22)), trail: false, onHit });
    this.place(m, from, to);
  }

  private missile(from: P3, to: P3, dur: number, curve: boolean, onHit?: () => void): void {
    const m = new THREE.Mesh(missile(), modelMat("normal"));
    m.userData.model = true;
    this.v.scene.add(m);
    let c: P3 | null = null;
    if (curve) {
      const k = (Math.random() - 0.5) * 0.6;
      c = {
        x: (from.x + to.x) / 2 - (to.y - from.y) * k,
        y: (from.y + to.y) / 2 + (to.x - from.x) * k,
        h: Math.max(from.h, to.h) + 0.6
      };
    } else c = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, h: Math.max(from.h, to.h) + 0.25 };
    this.fliers.push({ obj: m, a: from, b: to, c, t: 0, dur, trail: true, onHit });
    this.place(m, from, to);
  }

  private place(o: THREE.Object3D, at: P3, toward: P3): void {
    o.position.set(at.x, at.h, at.y);
    o.lookAt(toward.x, toward.h, toward.y);
  }

  /** A glowing beam between two points that fades over `dur` ms. */
  beam(from: P3, to: P3, tint: number, width: number, dur: number): void {
    const a = new THREE.Vector3(from.x, from.h, from.y);
    const b = new THREE.Vector3(to.x, to.h, to.y);
    const len = a.distanceTo(b);
    if (len < 0.01) return;
    const dir = b.clone().sub(a).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(up, dir);
    const parts: { m: THREE.Mesh; mat: THREE.MeshBasicMaterial; o: number }[] = [];
    for (const [r, o, col] of [[width * 0.008, 1, 0xffffff], [width * 0.022, 0.55, tint]] as const) {
      const mat = glowMat(col, o);
      const m = new THREE.Mesh(beamGeo, mat);
      m.position.copy(a).addScaledVector(dir, len / 2);
      m.quaternion.copy(q);
      m.scale.set(r, len, r);
      m.renderOrder = 7;
      this.v.scene.add(m);
      parts.push({ m, mat, o });
    }
    this.v.tweens.add({
      dur,
      update: (k) => {
        for (const p of parts) {
          p.mat.opacity = p.o * (1 - k * k);
          p.m.scale.x = p.m.scale.z = p.m.scale.x * (1 - k * 0.02);
        }
      },
      done: () => {
        for (const p of parts) {
          this.v.scene.remove(p.m);
          p.mat.dispose();
        }
      }
    });
  }

  heal(from: P3, to: P3): void {
    this.beam(from, to, 0x7dff9a, 3.5, 420);
    this.emit(HEAL, to, 2);
    this.sound("heal", to.x, to.y, 0.35);
  }

  sparks(p: P3, n: number, tints?: number[]): void {
    this.emit(tints ? { ...SPARKS, tints, gravity: -2 } : SPARKS, p, n);
  }

  // --------------------------------------------------------- explosions ---

  private impact(p: P3, size: number, air: boolean): void {
    this.emit(SPARKS, p, Math.round(3 + size * 4));
    if (size > 0.4) this.boom(p, size * 0.6, air, false, 1, 0.7);
    else this.flash(p, size * 1.3, 0xffc26a);
    if (!air && size > 0.3) this.dust(p.x, p.y);
  }

  /**
   * A fireball (layered additive puffs), smoke and a scorch mark. `flashK`/
   * `flashA` size the bloom: small deaths keep it modest so the fight
   * underneath stays readable; building deaths keep the full flare.
   */
  private boom(p: P3, size: number, air: boolean, decal: boolean, flashK = 1.5, flashA = 1): void {
    const pt = this.v.particles;
    // big blasts overlap many additive puffs: dim each so the fireball stays orange, not white
    const k = size > 1 ? 1 / Math.sqrt(size) : 1;
    this.flash(p, size * flashK, 0xffa640, flashA * k);
    const c = new THREE.Color(0xfff0c0);
    pt.spawn({ x: p.x, y: p.h + 0.1, z: p.y, life: 200, tex: TEX.glow, size0: size * 0.7, size1: size * 1.25, alpha0: 0.9 * k, alpha1: 0, r: c.r, g: c.g, b: c.b }, true);
    pt.emit(
      { ...FIRE, size: [0.5 * size + 0.15, 0.75 * size + 0.2], grow: [1.3, 1.8], life: [300, 650], alpha: [0.75 * k, 0], tints: [0xff9a2e, 0xff6a1a, 0xffc257] },
      p.x, p.y, p.h + 0.1, Math.round(size < 1 ? 2 + size * 4 : 4 + size * 4)
    );
    pt.emit(FIRE, p.x, p.y, p.h, Math.round(size < 1 ? 1 + size * 3 : 3 + size * 4));
    pt.emit({ ...SMOKE, size: [0.35 * size + 0.2, 0.5 * size + 0.25] }, p.x, p.y, p.h + 0.15, Math.round(size < 1 ? 1 + size * 2 : 2 + size * 3));
    if (decal && !air) this.decal(p.x, p.y, size);
  }

  explosion(ev: Extract<FxEvent, { type: "explosion" }>, at: P3): void {
    if (ev.kind === "building") {
      const size = ev.size;
      for (let i = 0; i < 3 + size * 2; i++) {
        const o = { x: at.x + (Math.random() - 0.5) * size * 0.8, y: at.y + (Math.random() - 0.5) * size * 0.8, h: at.h + Math.random() * 0.5 };
        this.v.tweens.after(i * 110, () => this.boom(o, 1.2 + Math.random() * 0.8, false, i === 0));
      }
      this.emit({ ...DEBRIS, speed: [1.2, 3.4], size: [0.12, 0.26] }, { ...at, h: at.h + 0.4 }, 16);
      // camera shake is decided by render/juice-view.ts (on-screen deaths only)
      this.sound("bigExplosion", at.x, at.y);
    } else if (ev.kind === "unit") {
      // small hulls pop smaller; Titans and Hornets keep their big fireball
      this.boom(at, ev.size >= 1 ? 0.8 + ev.size : 0.5 + ev.size * 0.85, ev.air, true, 0.9, 0.85);
      this.emit(DEBRIS, at, 7);
      this.sound("explosion", at.x, at.y, 0.9);
      if (ev.air) {
        // the wreck falls to the ground and burns out there
        this.v.tweens.after(300, () => this.boom({ x: at.x, y: at.y, h: this.v.terrain.surfaceAt(at.x, at.y) + 0.1 }, 0.6, false, true));
      }
    } else {
      this.boom(at, 0.5 + ev.size * 0.7, false, true, 1.1, 0.8);
      this.sound("explosion", at.x, at.y, 0.7);
    }
  }

  private decal(x: number, y: number, size: number): void {
    const h = this.v.terrain.surfaceAt(x, y) + 0.03;
    const c = new THREE.Color(0x14100c);
    const s = 0.55 + size * 0.55;
    this.v.particles.spawn({ x, y: h, z: y, life: 38000, tex: TEX.scorch, size0: s, size1: s * 1.05, alpha0: 0.8, alpha1: 0, r: c.r, g: c.g, b: c.b, flat: true, rot: Math.random() * 6.28 });
  }

  /** Rubble left where a building stood (+ scorch). */
  rubble(x: number, y: number, size: number): THREE.Object3D {
    const m = modelMesh(rubbleGeometry(size, Math.floor(Math.random() * 4)));
    m.position.set(x, this.v.terrain.heightAt(x, y), y);
    m.rotation.y = Math.floor(Math.random() * 4) * (Math.PI / 2);
    this.v.scene.add(m);
    this.rubbles.push(m);
    if (this.rubbles.length > 40) {
      const old = this.rubbles.shift();
      if (old) this.v.scene.remove(old);
    }
    this.decal(x, y, size * 1.4);
    return m;
  }

  // ------------------------------------------------------ ambient bits ---

  dust(x: number, y: number, n = 1): void {
    this.v.particles.emit(this.dustCfg, x, y, this.v.terrain.surfaceAt(x, y) + 0.05, n);
  }

  buildingSmoke(p: P3, burning: boolean): void {
    this.emit(SMOKE, p, 1);
    if (burning) this.emit(FIRE, p, 1);
  }

  /** An expanding ring on the ground. */
  pulse(x: number, y: number, tint: number, scale = 1.2, h?: number): void {
    const c = new THREE.Color(tint);
    this.v.particles.spawn(
      {
        x, y: (h ?? this.v.terrain.surfaceAt(x, y)) + 0.06, z: y, life: 500, tex: TEX.ring, flat: h === undefined,
        size0: 0.35 * scale, size1: 1.55 * scale, alpha0: 1, alpha1: 0, r: c.r, g: c.g, b: c.b
      },
      true
    );
  }

  /** A command marker where the player tapped (move / attack). */
  marker(x: number, y: number, tint: number): void {
    const c = new THREE.Color(tint);
    this.v.particles.spawn({
      x, y: this.v.terrain.surfaceAt(x, y) + 0.06, z: y, life: 450, tex: TEX.select, flat: true,
      size0: 1.0, size1: 0.25, alpha0: 0.95, alpha1: 0.1, r: c.r, g: c.g, b: c.b
    });
  }

  // ------------------------------------------------------------ per frame ---

  update(dtMs: number): void {
    const keep: Flier[] = [];
    const pos = new THREE.Vector3();
    for (const f of this.fliers) {
      f.t += dtMs;
      const k = Math.min(1, f.t / f.dur);
      let x: number;
      let y: number;
      let h: number;
      if (f.c) {
        const a = (1 - k) * (1 - k);
        const b = 2 * (1 - k) * k;
        const c = k * k;
        x = a * f.a.x + b * f.c.x + c * f.b.x;
        y = a * f.a.y + b * f.c.y + c * f.b.y;
        h = a * f.a.h + b * f.c.h + c * f.b.h;
      } else {
        x = f.a.x + (f.b.x - f.a.x) * k;
        y = f.a.y + (f.b.y - f.a.y) * k;
        h = f.a.h + (f.b.h - f.a.h) * k;
      }
      pos.set(x, h, y);
      if (pos.distanceToSquared(f.obj.position) > 1e-8) f.obj.lookAt(pos.x + (pos.x - f.obj.position.x), pos.y + (pos.y - f.obj.position.y), pos.z + (pos.z - f.obj.position.z));
      f.obj.position.copy(pos);
      if (f.trail && Math.random() < 0.8) this.v.particles.emit(TRAIL, x, y, h, 1);
      if (k >= 1) {
        this.v.scene.remove(f.obj);
        f.onHit?.();
      } else keep.push(f);
    }
    this.fliers = keep;
  }

  /** Draw the sim's slow projectiles (shells arc, bombs fall). */
  projectiles(list: Projectile[], alpha: number, prev: Map<number, { x: number; y: number }>): void {
    const seen = new Set<number>();
    const t = this.v.terrain;
    for (const p of list) {
      seen.add(p.id);
      let m = this.shells.get(p.id);
      if (!m) {
        m = modelMesh(shell());
        this.v.scene.add(m);
        this.shells.set(p.id, m);
      }
      const pp = prev.get(p.id) ?? { x: p.x, y: p.y };
      const x = pp.x + (p.x - pp.x) * alpha;
      const y = pp.y + (p.y - pp.y) * alpha;
      const total = Math.hypot(p.tx - p.sx, p.ty - p.sy) || 1;
      const k = Math.min(1, Math.hypot(x - p.sx, y - p.sy) / total);
      const g0 = t.surfaceAt(p.sx, p.sy);
      const g1 = t.surfaceAt(p.tx, p.ty);
      let h: number;
      if (p.fromAir) h = g0 + AIR_H * (1 - k) * (1 - k * 0.2) + (g1 - g0) * k;
      else h = g0 + 0.55 * (1 - k) + (g1 - g0) * k + 4 * k * (1 - k) * Math.min(2.2, total * 0.32);
      const prevPos = m.position.clone();
      m.position.set(x, h, y);
      if (prevPos.distanceToSquared(m.position) > 1e-8) m.lookAt(prevPos.multiplyScalar(-1).add(m.position.clone().multiplyScalar(2)));
      if (!p.fromAir && Math.random() < 0.5) this.v.particles.emit(TRAIL, x, y, h, 1);
    }
    for (const [id, m] of this.shells)
      if (!seen.has(id)) {
        this.v.scene.remove(m);
        this.shells.delete(id);
      }
  }

  destroy(): void {
    for (const f of this.fliers) this.v.scene.remove(f.obj);
    for (const m of this.shells.values()) this.v.scene.remove(m);
    for (const r of this.rubbles) this.v.scene.remove(r);
    this.fliers = [];
    this.shells.clear();
  }
}
