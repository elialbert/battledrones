import * as THREE from "three";
import { BUILDINGS, ECONOMY, UNITS } from "../../sim/balance";
import type { Building, Unit, World } from "../../sim/types";
import { eliteUniform, setVariant, type Variant } from "../three/materials";
import { buildingDef, instance, unitDef, unitScale, type ModelInstance } from "../three/models";
import { AIR_H, HOVER_H, type P3, type View } from "../three/view";
import { Ease } from "../three/tween";
import type { Fx } from "./fx";
import { FlashClock, JUICE } from "../juice";

interface UnitView {
  kind: "unit";
  m: ModelInstance;
  air: boolean;
  hover: boolean;
  face: number;
  aim: number;
  recoil: number;
  lastFired: number;
  phase: number;
  dustT: number;
  /** Rendered ground position (tiles) and body position/height. */
  gx: number;
  gy: number;
  bh: number;
  /** Smoothed terrain pitch/roll and aircraft bank. */
  pitch: number;
  roll: number;
  bank: number;
  visible: boolean;
  variant: Variant;
  rank: number;
  /** Chevron pop-in (1 = settled). */
  chevronPop: number;
  /** Model height (bars and labels sit above it). */
  top: number;
  scale: number;
}

interface BuildingView {
  kind: "building";
  m: ModelInstance;
  face: number;
  recoil: number;
  lastFired: number;
  smokeT: number;
  size: number;
  cx: number;
  cy: number;
  base: number;
  visible: boolean;
  variant: Variant;
  warmUntil: number;
  top: number;
}

type View3 = UnitView | BuildingView;

/** Shortest signed angle from a to b. */
function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

const tmp = new THREE.Vector3();

/**
 * Units and buildings as 3D models: hulls that turn and tilt over the
 * terrain, turrets that track their targets and kick on recoil, rotors that
 * spin, aircraft that bank into turns and bob at altitude, buildings that
 * rise out of the ground when placed and smoke when hurt. Hits flash the
 * model white (warm for buildings), elites shimmer gold.
 */
export class EntityRenderer {
  private views = new Map<number, View3>();
  private sold = new Set<number>();
  private time = 0;
  private flashes = new FlashClock();
  readonly group = new THREE.Group();

  constructor(
    private v: View,
    private world: World,
    private fx: Fx,
    /** Is world tile position visible to the local player? */
    private visibleAt: (x: number, y: number) => boolean,
    /** Should this enemy building be drawn (seen now or remembered)? */
    private buildingShown: (b: Building) => boolean,
    private isFriendly: (f: string) => boolean
  ) {
    v.scene.add(this.group);
  }

  markSold(id: number): void {
    this.sold.add(id);
  }

  // ------------------------------------------------------------- queries ---

  /** Rendered position of an entity: body (x, y, h) and ground (gx, gy). */
  pos(id: number): { x: number; y: number; h: number; gx: number; gy: number; top: number } | null {
    const v = this.views.get(id);
    if (!v) return null;
    if (v.kind === "unit") return { x: v.gx, y: v.gy, h: v.bh, gx: v.gx, gy: v.gy, top: v.bh + v.top };
    return { x: v.cx, y: v.cy, h: v.base + 0.4, gx: v.cx, gy: v.cy, top: v.base + v.top };
  }

  /** Last rendered pose of a unit (wrecks start from it). */
  pose(id: number): { gx: number; gy: number; bh: number; face: number; aim: number; visible: boolean } | null {
    const v = this.views.get(id);
    if (!v || v.kind !== "unit") return null;
    return { gx: v.gx, gy: v.gy, bh: v.bh, face: v.face, aim: v.aim, visible: v.visible };
  }

  isShown(id: number): boolean {
    return this.views.get(id)?.visible ?? false;
  }

  /** Where a shot leaves the shooter's barrel. */
  muzzle(id: number): P3 | null {
    const v = this.views.get(id);
    if (!v) return null;
    const m = v.m;
    m.root.updateMatrixWorld(true);
    tmp.set(...m.def.muzzle);
    if (m.turret) m.turret.localToWorld(tmp);
    else m.body.localToWorld(tmp);
    return { x: tmp.x, y: tmp.z, h: tmp.y };
  }

  /** Called when a shot fires: kick the recoil and snap aim toward it. */
  fired(id: number, angle: number): void {
    const v = this.views.get(id);
    if (!v) return;
    v.recoil = 1;
    if (v.kind === "unit" && v.m.turret) v.aim = angle;
    else if (v.kind === "unit") v.face = v.aim = angle;
    else v.face = angle;
  }

  /**
   * A hit landed on a visible entity: units flash white, buildings a brief
   * warm glow. Throttled per entity so sustained fire flickers, not strobes.
   */
  hitFlash(id: number): void {
    const v = this.views.get(id);
    if (!v || !v.visible) return;
    // wall-clock timing: a flash still ends if the game is paused mid-blink
    const now = performance.now();
    if (v.kind === "unit") {
      this.flashes.hit(id, now);
      return;
    }
    if (!this.flashes.hit(id, now, JUICE.buildingFlashMs, JUICE.buildingFlashGapMs)) return;
    v.warmUntil = now + JUICE.buildingFlashMs;
  }

  /** Units with ranks, for the chevrons the overlay draws. */
  *ranked(): Generator<{ x: number; y: number; h: number; rank: number; pop: number }> {
    for (const v of this.views.values())
      if (v.kind === "unit" && v.visible && v.rank > 0) yield { x: v.gx, y: v.gy, h: v.bh + v.top, rank: v.rank, pop: v.chevronPop };
  }

  // ------------------------------------------------------------- sync ---

  sync(alpha: number, prev: Map<number, { x: number; y: number }>, dtMs: number): void {
    const w = this.world;
    this.time += dtMs;
    eliteUniform.value = 0.1 + 0.06 * Math.sin(this.time / 260);
    const seen = new Set<number>();
    const turnK = 1 - Math.pow(0.0005, dtMs / 1000); // fast but smooth turning

    for (const u of w.units.values()) {
      seen.add(u.id);
      let v = this.views.get(u.id) as UnitView | undefined;
      if (!v) v = this.createUnit(u);
      const p = prev.get(u.id) ?? u;
      const gx = p.x + (u.x - p.x) * alpha;
      const gy = p.y + (u.y - p.y) * alpha;
      this.updateUnit(u, v, gx, gy, dtMs, turnK);
    }

    for (const b of w.buildings.values()) {
      seen.add(b.id);
      let v = this.views.get(b.id) as BuildingView | undefined;
      if (!v) v = this.createBuilding(b);
      this.updateBuilding(b, v, dtMs, turnK);
    }

    for (const [id, v] of this.views) {
      if (seen.has(id)) continue;
      const root = v.m.root;
      if (v.kind === "building") {
        if (!this.sold.has(id) && v.visible) this.fx.rubble(v.cx, v.cy, v.size);
        if (this.sold.has(id)) {
          // packed up: it sinks back into the ground
          const y0 = root.position.y;
          this.v.tweens.add({
            dur: 380, ease: Ease.quadIn,
            update: (k) => {
              root.position.y = y0 - k * v.top * 0.9;
              root.scale.setScalar(1 - k * 0.15);
            },
            done: () => this.group.remove(root)
          });
          for (let i = 0; i < 5; i++) this.fx.dust(v.cx + (Math.random() - 0.5) * v.size, v.cy + (Math.random() - 0.5) * v.size);
        } else this.group.remove(root);
      } else this.group.remove(root);
      this.views.delete(id);
    }
  }

  private createUnit(u: Unit): UnitView {
    const stats = UNITS[u.kind];
    const m = instance(unitDef(u.kind, u.faction));
    m.body.rotation.order = "YXZ";
    this.group.add(m.root);
    const scale = unitScale(u.kind);
    m.root.scale.setScalar(scale);
    const v: UnitView = {
      kind: "unit", m, air: stats.domain === "air", hover: !!stats.hover,
      face: u.facing, aim: u.aim, recoil: 0, lastFired: u.firedTick, phase: (u.id * 1.37) % (Math.PI * 2), dustT: 0,
      gx: u.x, gy: u.y, bh: 0, pitch: 0, roll: 0, bank: 0, visible: true, variant: "normal",
      // units that arrive ranked (Last Stand waves) don't pop their chevrons
      rank: u.rank, chevronPop: 1, top: m.def.height * scale, scale
    };
    // units roll out of the factory with a quick pop-in
    if (this.world.tick > 1) {
      m.root.scale.setScalar(scale * 0.5);
      this.v.tweens.add({ dur: 320, ease: Ease.backOut, update: (k) => m.root.scale.setScalar(scale * (0.5 + 0.5 * k)) });
    }
    this.views.set(u.id, v);
    return v;
  }

  private setVariant(v: UnitView | BuildingView, variant: Variant): void {
    if (v.variant === variant) return;
    v.variant = variant;
    setVariant(v.m.root, variant);
  }

  private updateUnit(u: Unit, v: UnitView, gx: number, gy: number, dtMs: number, turnK: number): void {
    const stats = UNITS[u.kind];
    const visible = this.isFriendly(u.faction) || this.visibleAt(u.x, u.y);
    v.visible = visible;
    v.m.root.visible = visible;
    const moved = Math.hypot(gx - v.gx, gy - v.gy);
    v.gx = gx;
    v.gy = gy;
    if (!visible) return;
    const t = this.v.terrain;
    const flashing = this.flashes.active(u.id, performance.now());
    this.setVariant(v, flashing ? "flash" : u.rank >= 3 ? "elite" : "normal");

    const prevFace = v.face;
    v.face += angleDelta(v.face, u.facing) * turnK;
    if (stats.turret) {
      // turrets track their target, then settle back over the hull
      const aimTarget = this.world.tick - u.firedTick > 25 ? u.facing : u.aim;
      v.aim += angleDelta(v.aim, aimTarget) * turnK * 0.7;
    } else {
      v.aim = v.face; // the sim turns the whole body to shoot
    }
    if (u.firedTick !== v.lastFired) {
      v.lastFired = u.firedTick;
      v.recoil = 1;
    }
    v.recoil = Math.max(0, v.recoil - dtMs / 160);

    const sk = 1 - Math.pow(0.002, dtMs / 1000);
    const root = v.m.root;
    const body = v.m.body;
    if (v.air) {
      const bob = Math.sin(this.time / 380 + v.phase) * 0.06;
      v.bh = t.surfaceAt(gx, gy) * 0.3 + AIR_H + bob;
      // bank into turns, nose down when moving fast
      const turnRate = dtMs > 0 ? angleDelta(prevFace, v.face) / (dtMs / 1000) : 0;
      v.bank += (Math.max(-0.6, Math.min(0.6, -turnRate * 0.35)) - v.bank) * sk;
      const speed = dtMs > 0 ? moved / (dtMs / 1000) : 0;
      v.pitch += (Math.max(-0.25, -speed * 0.05) - v.pitch) * sk;
      body.rotation.set(v.pitch, -v.face, v.bank);
    } else {
      const f = v.face;
      const fx = Math.sin(f);
      const fz = -Math.cos(f);
      const hover = v.hover;
      const at = (x: number, y: number) => t.groundAt(x, y, hover);
      const L = 0.3;
      const hF = at(gx + fx * L, gy + fz * L);
      const hB = at(gx - fx * L, gy - fz * L);
      const hR = at(gx - fz * 0.22, gy + fx * 0.22);
      const hL = at(gx + fz * 0.22, gy - fx * 0.22);
      v.pitch += (Math.atan2(hF - hB, L * 2) - v.pitch) * sk;
      v.roll += (Math.atan2(hR - hL, 0.44) - v.roll) * sk;
      const base = (hF + hB + hR + hL) / 4;
      v.bh = hover ? base + HOVER_H + Math.sin(this.time / 300 + v.phase) * 0.02 : base;
      body.rotation.set(v.pitch, -v.face, v.roll);
    }
    root.position.set(gx, v.bh, gy);

    if (v.m.turret) {
      const rel = v.aim - v.face;
      v.m.turret.rotation.y = -rel;
      const kick = v.recoil * (u.kind === "titan" ? 0.08 : 0.05);
      const mount = v.m.def.mount;
      v.m.turret.position.set(mount[0] + Math.sin(-rel) * kick, mount[1], mount[2] + Math.cos(-rel) * kick);
    }
    for (const r of v.m.rotors) r.obj.rotation[r.axis] += (r.speed * dtMs) / 1000;
    if (v.m.cargo) v.m.cargo.visible = u.kind === "harvester" && u.cargo >= ECONOMY.harvesterCapacity / 2;

    // veterancy: a promotion pops the new chevron in
    if (u.rank > v.rank) {
      v.rank = u.rank;
      v.chevronPop = 0;
      this.v.tweens.add({ dur: 450, ease: Ease.backOut, update: (k) => (v.chevronPop = k) });
    }
    v.rank = u.rank;

    // ground vehicles kick up dust when moving
    if (!v.air && !v.hover && moved > 0.006) {
      v.dustT -= dtMs;
      if (v.dustT <= 0) {
        v.dustT = 90 + Math.random() * 80;
        this.fx.dust(gx - Math.sin(v.face) * 0.25, gy + Math.cos(v.face) * 0.25);
      }
    }
    // hover tanks stir a faint spray over water
    if (v.hover && moved > 0.006 && t.heightAt(gx, gy) < -0.1 && Math.random() < 0.3) this.fx.dust(gx, gy);
  }

  private createBuilding(b: Building): BuildingView {
    const size = BUILDINGS[b.kind].size;
    const cx = b.tx + size / 2;
    const cy = b.ty + size / 2;
    const t = this.v.terrain;
    let base = 0;
    for (const [dx, dy] of [[0, 0], [-0.4, -0.4], [0.4, -0.4], [-0.4, 0.4], [0.4, 0.4]] as [number, number][])
      base = Math.max(base, t.heightAt(cx + dx * size, cy + dy * size));
    const m = instance(buildingDef(b.kind, b.faction));
    m.root.position.set(cx, base - 0.02, cy);
    this.group.add(m.root);
    const v: BuildingView = {
      kind: "building", m, face: b.facing, recoil: 0, lastFired: b.firedTick,
      smokeT: 0, size, cx, cy, base, visible: true, variant: "normal", warmUntil: 0, top: m.def.height
    };
    if (this.world.tick > 1) {
      // freshly placed: it rises from the ground in a puff of dust
      m.root.scale.set(1, 0.05, 1);
      this.v.tweens.add({ dur: 480, ease: Ease.backOut, update: (k) => m.root.scale.set(0.9 + 0.1 * k, Math.max(0.05, k), 0.9 + 0.1 * k) });
      for (let i = 0; i < 8; i++) this.fx.dust(cx + (Math.random() - 0.5) * size, cy + (Math.random() - 0.5) * size);
    }
    this.views.set(b.id, v);
    return v;
  }

  private updateBuilding(b: Building, v: BuildingView, dtMs: number, turnK: number): void {
    const stats = BUILDINGS[b.kind];
    const visible = this.isFriendly(b.faction) || this.buildingShown(b);
    v.visible = visible;
    v.m.root.visible = visible;
    if (!visible) return;
    const ratio = b.hp / stats.hp;
    this.setVariant(v, performance.now() < v.warmUntil ? "warm" : ratio < 0.5 ? "damaged" : "normal");
    if (v.m.turret) {
      if (b.kind === "radar") v.face += dtMs / 900; // radar sweeps continuously
      else v.face += angleDelta(v.face, b.facing) * turnK;
      if (b.firedTick !== v.lastFired) {
        v.lastFired = b.firedTick;
        v.recoil = 1;
      }
      v.recoil = Math.max(0, v.recoil - dtMs / 160);
      const kick = v.recoil * 0.05;
      const mount = v.m.def.mount;
      v.m.turret.rotation.y = -v.face;
      v.m.turret.position.set(mount[0] - Math.sin(v.face) * kick, mount[1], mount[2] + Math.cos(v.face) * kick);
    }
    // damage smoke and fire
    if (ratio < 0.5) {
      v.smokeT -= dtMs;
      if (v.smokeT <= 0) {
        v.smokeT = ratio < 0.25 ? 110 : 260;
        const half = v.size / 2;
        this.fx.buildingSmoke(
          { x: v.cx + (Math.random() - 0.5) * half, y: v.cy + (Math.random() - 0.5) * half, h: v.base + v.top * (0.45 + Math.random() * 0.3) },
          ratio < 0.25
        );
      }
    }
  }

  destroy(): void {
    this.v.scene.remove(this.group);
    this.views.clear();
  }
}
