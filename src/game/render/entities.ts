import Phaser from "phaser";
import { BUILDINGS, ECONOMY, UNITS } from "../../sim/balance";
import type { Building, Unit, World } from "../../sim/types";
import {
  ART_SCALE,
  ATLAS,
  HEADED,
  TILE,
  buildingFrame,
  frameOrigin,
  headFrame,
  mountOffset,
  turretFrame,
  unitFrame
} from "../assets";
import { AIR_LIFT, type Fx } from "./fx";

interface UnitView {
  kind: "unit";
  body: Phaser.GameObjects.Image;
  shadow: Phaser.GameObjects.Image;
  turret?: Phaser.GameObjects.Image;
  turretShadow?: Phaser.GameObjects.Image;
  glow?: Phaser.GameObjects.Image;
  /** Rank 3 (elite): a pulsing gold copy of the body behind it. */
  shimmer?: Phaser.GameObjects.Image;
  chevrons: Phaser.GameObjects.Image[];
  face: number;
  aim: number;
  recoil: number;
  lastFired: number;
  phase: number;
  dustT: number;
  /** Rendered ground position (world px) and body position (lifted for air). */
  gx: number;
  gy: number;
  bx: number;
  by: number;
  visible: boolean;
}

interface BuildingView {
  kind: "building";
  body: Phaser.GameObjects.Image;
  shadow: Phaser.GameObjects.Image;
  head?: Phaser.GameObjects.Image;
  headShadow?: Phaser.GameObjects.Image;
  face: number;
  recoil: number;
  lastFired: number;
  smokeT: number;
  size: number;
  cx: number;
  cy: number;
  visible: boolean;
}

type View = UnitView | BuildingView;

const SHADOW_ALPHA = 0.32;

/** Shortest signed angle from a to b. */
function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export class EntityRenderer {
  private views = new Map<number, View>();
  private sold = new Set<number>();
  private time = 0;

  constructor(
    private scene: Phaser.Scene,
    private world: World,
    private fx: Fx,
    /** Is world tile position (tiles) visible to the local player? */
    private visibleAt: (x: number, y: number) => boolean,
    /** Should this enemy building be drawn (seen now or remembered)? */
    private buildingShown: (b: Building) => boolean,
    private isFriendly: (f: string) => boolean
  ) {}

  markSold(id: number): void {
    this.sold.add(id);
  }

  // ------------------------------------------------------------- queries ---

  /** Rendered position of an entity (world px): body (lifted) and ground. */
  pos(id: number): { x: number; y: number; gx: number; gy: number } | null {
    const v = this.views.get(id);
    if (!v) return null;
    if (v.kind === "unit") return { x: v.bx, y: v.by, gx: v.gx, gy: v.gy };
    return { x: v.cx, y: v.cy, gx: v.cx, gy: v.cy };
  }

  isShown(id: number): boolean {
    return this.views.get(id)?.visible ?? false;
  }

  /** Where a shot leaves the shooter's barrel (world px). */
  muzzle(id: number): { x: number; y: number } | null {
    const v = this.views.get(id);
    if (!v) return null;
    if (v.kind === "unit") {
      if (v.turret) {
        const len = v.turret.displayHeight * v.turret.originY * 0.92;
        return { x: v.turret.x + Math.sin(v.aim) * len, y: v.turret.y - Math.cos(v.aim) * len };
      }
      const len = v.body.displayHeight * 0.4;
      return { x: v.bx + Math.sin(v.aim) * len, y: v.by - Math.cos(v.aim) * len };
    }
    if (v.head) {
      const len = v.head.displayHeight * v.head.originY * 0.9;
      return { x: v.head.x + Math.sin(v.face) * len, y: v.head.y - Math.cos(v.face) * len };
    }
    return { x: v.cx, y: v.cy - 10 };
  }

  /** Called when a shot fires: kick the recoil and snap aim toward it. */
  fired(id: number, angle: number): void {
    const v = this.views.get(id);
    if (!v) return;
    v.recoil = 1;
    if (v.kind === "unit" && v.turret) v.aim = angle;
    else if (v.kind === "unit") v.face = v.aim = angle;
    else v.face = angle;
  }

  // ------------------------------------------------------------- sync ---

  sync(alpha: number, prev: Map<number, { x: number; y: number }>, dtMs: number): void {
    const w = this.world;
    this.time += dtMs;
    const seen = new Set<number>();
    const turnK = 1 - Math.pow(0.0005, dtMs / 1000); // fast but smooth turning

    for (const u of w.units.values()) {
      seen.add(u.id);
      let v = this.views.get(u.id) as UnitView | undefined;
      if (!v) v = this.createUnit(u);
      const p = prev.get(u.id) ?? u;
      const gx = (p.x + (u.x - p.x) * alpha) * TILE;
      const gy = (p.y + (u.y - p.y) * alpha) * TILE;
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
      if (v.kind === "building") {
        if (!this.sold.has(id) && v.visible) this.fx.rubble(v.cx, v.cy, v.size);
        const parts = [v.body, v.shadow, v.head, v.headShadow].filter(Boolean) as Phaser.GameObjects.Image[];
        if (this.sold.has(id))
          this.scene.tweens.add({ targets: parts, alpha: 0, scale: "*=0.9", duration: 350, onComplete: () => parts.forEach((o) => o.destroy()) });
        else parts.forEach((o) => o.destroy());
      } else {
        for (const o of [v.body, v.shadow, v.turret, v.turretShadow, v.glow, v.shimmer, ...v.chevrons]) o?.destroy();
      }
      this.views.delete(id);
    }
  }

  private createUnit(u: Unit): UnitView {
    const s = this.scene;
    const stats = UNITS[u.kind];
    const air = stats.domain === "air";
    const frame = unitFrame(u.faction, u.kind);
    // aircraft pivot on their frame centre so the sim position sits mid-body
    const [ox, oy] = air ? [0.5, 0.5] : frameOrigin(frame);
    const shadow = s.add
      .image(0, 0, ATLAS, frame)
      .setOrigin(ox, oy)
      .setScale(ART_SCALE * (air ? 0.8 : 1))
      .setTint(0x000000)
      .setAlpha(air ? 0.22 : SHADOW_ALPHA)
      .setDepth(air ? 2.95 : 2.9);
    const body = s.add.image(0, 0, ATLAS, frame).setOrigin(ox, oy).setScale(ART_SCALE).setDepth(air ? 6 : 3);
    const v: UnitView = {
      kind: "unit", body, shadow, chevrons: [], face: u.facing, aim: u.aim, recoil: 0,
      lastFired: u.firedTick, phase: (u.id * 1.37) % (Math.PI * 2), dustT: 0,
      gx: u.x * TILE, gy: u.y * TILE, bx: u.x * TILE, by: u.y * TILE, visible: true
    };
    // units that arrive ranked (Last Stand waves) don't pop their chevrons
    for (let i = 0; i < u.rank; i++) v.chevrons.push(s.add.image(0, 0, "fx-chevron").setDepth(8.2).setScale(0.8));
    if (stats.turret) {
      const tf = turretFrame(u.faction, u.kind);
      const [tx, ty] = frameOrigin(tf);
      v.turretShadow = s.add
        .image(0, 0, ATLAS, tf).setOrigin(tx, ty).setScale(ART_SCALE)
        .setTint(0x000000).setAlpha(SHADOW_ALPHA * 0.8).setDepth(2.92);
      v.turret = s.add.image(0, 0, ATLAS, tf).setOrigin(tx, ty).setScale(ART_SCALE).setDepth(3.1);
    }
    if (stats.hover) {
      v.glow = s.add
        .image(0, 0, "fx-glow")
        .setDepth(2.93)
        .setScale(1.1)
        .setTint(0xffb347)
        .setAlpha(0.35)
        .setBlendMode(Phaser.BlendModes.ADD);
    }
    // units roll out of the factory with a quick pop-in
    if (this.world.tick > 1) {
      for (const o of [body, v.turret]) if (o) o.setAlpha(0);
      s.tweens.add({ targets: [body, v.turret].filter(Boolean), alpha: 1, duration: 300 });
    }
    this.views.set(u.id, v);
    return v;
  }

  private updateUnit(u: Unit, v: UnitView, gx: number, gy: number, dtMs: number, turnK: number): void {
    const stats = UNITS[u.kind];
    const air = stats.domain === "air";
    const visible = this.isFriendly(u.faction) || this.visibleAt(u.x, u.y);
    v.visible = visible;
    for (const o of [v.body, v.shadow, v.turret, v.turretShadow, v.glow]) o?.setVisible(visible);
    for (const c of v.chevrons) c.setVisible(visible);
    v.shimmer?.setVisible(visible);
    const moved = Math.hypot(gx - v.gx, gy - v.gy);
    v.gx = gx;
    v.gy = gy;
    if (!visible) return;

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

    let bx = gx;
    let by = gy;
    if (air) {
      const bob = Math.sin(this.time / 380 + v.phase) * 2.2;
      by = gy - AIR_LIFT + bob;
      v.shadow.setPosition(gx + 12, gy + 16);
    } else {
      const k = stats.hover ? Math.sin(this.time / 300 + v.phase) * 1.2 : 0;
      by = gy + k;
      v.shadow.setPosition(gx + 3, gy + 4 + (stats.hover ? 5 : 0));
    }
    v.bx = bx;
    v.by = by;
    v.body.setPosition(bx, by).setRotation(v.face);
    v.shadow.setRotation(v.face);

    if (u.kind === "harvester") {
      const full = u.cargo >= ECONOMY.harvesterCapacity / 2;
      const frame = full ? `u/${u.faction}/harvester-full` : unitFrame(u.faction, u.kind);
      if (v.body.frame.name !== frame) {
        const [ox, oy] = frameOrigin(frame);
        v.body.setFrame(frame).setOrigin(ox, oy);
        v.shadow.setFrame(frame).setOrigin(ox, oy);
      }
    }

    if (v.turret && v.turretShadow) {
      const [mx, my] = mountOffset(u.kind);
      const c = Math.cos(v.face);
      const s = Math.sin(v.face);
      const ox = (mx * c - my * s) * TILE;
      const oy = (mx * s + my * c) * TILE;
      const kick = v.recoil * (u.kind === "titan" ? 5 : 3);
      const tx = bx + ox - Math.sin(v.aim) * kick;
      const ty = by + oy + Math.cos(v.aim) * kick;
      v.turret.setPosition(tx, ty).setRotation(v.aim);
      v.turretShadow.setPosition(tx + 4, ty + 5).setRotation(v.aim);
    }
    if (v.glow) v.glow.setPosition(gx, gy + 2).setAlpha(0.25 + Math.sin(this.time / 200 + v.phase) * 0.08);

    // veterancy chevrons float above the unit
    while (v.chevrons.length < u.rank) {
      // a promotion: the new chevron pops in
      const c = this.scene.add.image(0, 0, "fx-chevron").setDepth(8.2).setScale(1.6);
      this.scene.tweens.add({ targets: c, scale: 0.8, duration: 450, ease: "Back.easeOut" });
      v.chevrons.push(c);
    }
    v.chevrons.forEach((c, i) => c.setPosition(bx - (u.rank - 1) * 7 + i * 14, by - 30));
    if (u.rank >= 3 && !v.shimmer)
      v.shimmer = this.scene.add
        .image(0, 0, ATLAS, v.body.frame.name)
        .setOrigin(v.body.originX, v.body.originY)
        .setTint(0xffd66e)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDepth(v.body.depth - 0.01);
    v.shimmer
      ?.setPosition(bx, by)
      .setRotation(v.face)
      .setScale(ART_SCALE * 1.1)
      .setAlpha(0.3 + 0.1 * Math.sin(this.time / 260 + v.phase));

    // ground vehicles kick up dust when moving
    if (!air && !stats.hover && moved > 0.4) {
      v.dustT -= dtMs;
      if (v.dustT <= 0) {
        v.dustT = 90 + Math.random() * 80;
        this.fx.dust(gx - Math.sin(v.face) * 14, gy + Math.cos(v.face) * 14);
      }
    }
  }

  private createBuilding(b: Building): BuildingView {
    const s = this.scene;
    const size = BUILDINGS[b.kind].size;
    const cx = (b.tx + size / 2) * TILE;
    const cy = (b.ty + size / 2) * TILE;
    const frame = buildingFrame(b.faction, b.kind);
    const shadow = s.add
      .image(cx + 6, cy + 8, ATLAS, frame)
      .setScale(ART_SCALE)
      .setTint(0x000000)
      .setAlpha(0.3)
      .setDepth(1.9);
    const body = s.add.image(cx, cy, ATLAS, frame).setScale(ART_SCALE).setDepth(2);
    const v: BuildingView = {
      kind: "building", body, shadow, face: b.facing, recoil: 0, lastFired: b.firedTick,
      smokeT: 0, size, cx, cy, visible: true
    };
    if (HEADED[b.kind]) {
      const hf = headFrame(b.faction, b.kind);
      const [hx, hy] = frameOrigin(hf);
      const [mx, my] = mountOffset(b.kind);
      v.headShadow = s.add
        .image(cx + mx * TILE + 5, cy + my * TILE + 7, ATLAS, hf)
        .setOrigin(hx, hy).setScale(ART_SCALE).setTint(0x000000).setAlpha(0.3).setDepth(2.05);
      v.head = s.add.image(cx + mx * TILE, cy + my * TILE, ATLAS, hf).setOrigin(hx, hy).setScale(ART_SCALE).setDepth(2.1);
    }
    if (this.world.tick > 1) {
      // freshly placed: rise from the ground in a puff of dust
      const parts = [body, v.head].filter(Boolean) as Phaser.GameObjects.Image[];
      for (const p of parts) p.setScale(ART_SCALE * 0.75).setAlpha(0);
      s.tweens.add({ targets: parts, scale: ART_SCALE, alpha: 1, duration: 450, ease: "Back.easeOut" });
      for (let i = 0; i < 6; i++)
        this.fx.dust(cx + (Math.random() - 0.5) * size * TILE, cy + (Math.random() - 0.5) * size * TILE);
    }
    this.views.set(b.id, v);
    return v;
  }

  private updateBuilding(b: Building, v: BuildingView, dtMs: number, turnK: number): void {
    const stats = BUILDINGS[b.kind];
    const visible = this.isFriendly(b.faction) || this.buildingShown(b);
    v.visible = visible;
    for (const o of [v.body, v.shadow, v.head, v.headShadow]) o?.setVisible(visible);
    if (!visible) return;
    const ratio = b.hp / stats.hp;
    v.body.setTint(ratio < 0.5 ? 0xb8b0a8 : 0xffffff);
    if (v.head) {
      if (b.kind === "radar") v.face += dtMs / 900; // radar sweeps continuously
      else v.face += angleDelta(v.face, b.facing) * turnK;
      if (b.firedTick !== v.lastFired) {
        v.lastFired = b.firedTick;
        v.recoil = 1;
      }
      v.recoil = Math.max(0, v.recoil - dtMs / 160);
      const [mx, my] = mountOffset(b.kind);
      const kick = v.recoil * 3;
      const hx = v.cx + mx * TILE - Math.sin(v.face) * kick;
      const hy = v.cy + my * TILE + Math.cos(v.face) * kick;
      v.head.setPosition(hx, hy).setRotation(v.face);
      v.headShadow?.setPosition(hx + 5, hy + 7).setRotation(v.face);
    }
    // damage smoke and fire
    if (ratio < 0.5) {
      v.smokeT -= dtMs;
      if (v.smokeT <= 0) {
        v.smokeT = ratio < 0.25 ? 110 : 260;
        const half = (v.size * TILE) / 2;
        this.fx.buildingSmoke(
          v.cx + (Math.random() - 0.5) * half,
          v.cy + (Math.random() - 0.5) * half,
          ratio < 0.25
        );
      }
    }
  }
}
