import Phaser from "phaser";
import { SALVAGE, TICK_RATE, UNITS } from "../../sim/balance";
import { incomeOf } from "../../sim/rules";
import type { Faction, FxEvent, UnitKind, World, Wreck } from "../../sim/types";
import { announce } from "../announce";
import { ART_SCALE, ATLAS, TILE, frameOrigin, mountOffset, turretFrame, unitFrame } from "../assets";
import { sfx } from "../audio";
import type { Fx } from "./fx";

/**
 * Battlefield wrecks (sim: salvage.ts). A destroyed combat unit's own
 * sprite stays on the field as a charred hull with its turret blown off,
 * smoulders while it is too hot to touch, then glints gold: loot. Aircraft
 * tumble out of the sky first. Picking one up pops a gold "+52" (and a coin
 * blip for your own). Wrecks show only where you have vision; a wreck you
 * saw is remembered (like a building) until you see that it's gone or it
 * would have burnt out anyway.
 */

/** Last rendered pose of a unit (EntityRenderer.pose): body (lifted) and ground px, hull and turret angles. */
export interface UnitPose {
  bx: number;
  by: number;
  gx: number;
  gy: number;
  face: number;
  aim: number;
  visible: boolean;
}

export interface WreckRendererOpts {
  /** Is tile position (x, y) visible to the local player (always true with fog off)? */
  visibleAt(x: number, y: number): boolean;
  /** Last rendered pose of a (just-killed) unit, if it still has a view. */
  pose(id: number): UnitPose | null;
  player: Faction;
  spectator: boolean;
  dpr: number;
  /**
   * One-time "what are these?" hint (paced by the HUD's hint queue; tapping it
   * jumps to x, y). `shown` runs once it is actually on screen.
   */
  hint(msg: string, x: number, y: number, shown: () => void): void;
}

interface WreckView {
  id: number;
  kind: UnitKind;
  /** Resting spot (world px). */
  x: number;
  y: number;
  body: Phaser.GameObjects.Image;
  shadow: Phaser.GameObjects.Image;
  turret?: Phaser.GameObjects.Image;
  aura: Phaser.GameObjects.Image;
  glint: Phaser.GameObjects.Image;
  /** Every image, for visibility/alpha/teardown. */
  parts: Phaser.GameObjects.Image[];
  /** The player has seen it (remembered after that). */
  seen: boolean;
  /** Removed from the sim (kept as a remembered ghost until seen gone). */
  gone: boolean;
  /** Sim tick it burns out (known to everyone: wrecks last SALVAGE.ttl). */
  expireTick: number;
  /** Sim tick it cools enough to salvage. */
  coolTick: number;
  /** Still tumbling out of the sky / sliding to rest. */
  landing: boolean;
  smokeT: number;
  glintT: number;
  phase: number;
}

/** Charred hull: the painted art multiplied down to a warm soot grey (team colours still read faintly). */
const BURNT = 0x5f5850;
const BURNT_TURRET = 0x6c645b;
const GOLD = 0xffd66e;
/** Remembered wrecks beyond the sim cap (ghosts) — keep the scene light. */
const MAX_VIEWS = SALVAGE.maxWrecks + 15;
/** Own salvage within this window (ms) adds up to a "haul". */
const HAUL_WINDOW = 9000;
const HAUL_AT = 400;
const HINT_KEY = "battledrones.hint.salvage";

/** Small deterministic hash → [0, 1) so a wreck looks the same every time it's drawn. */
const rnd = (id: number, k: number) => {
  const x = Math.sin(id * 12.9898 + k * 78.233) * 43758.5453;
  return x - Math.floor(x);
};

export class WreckRenderer {
  private views = new Map<number, WreckView>();
  /** Poses of units that died this frame, consumed when their wreck appears. */
  private deaths = new Map<number, { pose: UnitPose | null; ev: Extract<FxEvent, { type: "death" }> }>();
  private collected = new Set<number>();
  private haul: { t: number; v: number }[] = [];
  private lastHaul = -1e9;
  private hinted = false;
  private time = 0;
  /** Thin smoke wisps and embers over burning hulls (lighter than a building fire). */
  private smoke: Phaser.GameObjects.Particles.ParticleEmitter;
  private embers: Phaser.GameObjects.Particles.ParticleEmitter;
  /** Live "+52" pops: pickups landing together merge into one running total. */
  private floats: { text: Phaser.GameObjects.Text; x: number; y: number; amount: number; color: string; born: number }[] = [];

  constructor(
    private scene: Phaser.Scene,
    private world: World,
    private fx: Fx,
    private opts: WreckRendererOpts
  ) {
    makeGlintTexture(scene);
    this.smoke = scene.add
      .particles(0, 0, "fx-smoke", {
        emitting: false,
        lifespan: { min: 1100, max: 1900 },
        speed: { min: 8, max: 24 },
        angle: { min: 250, max: 290 },
        scale: { start: 0.2, end: 0.75 },
        alpha: { start: 0.38, end: 0 },
        rotate: { min: 0, max: 360 },
        tint: [0x4d4944, 0x5f5a54, 0x3d3a37]
      })
      .setDepth(7.15);
    this.embers = scene.add
      .particles(0, 0, "fx-glow", {
        emitting: false,
        lifespan: { min: 200, max: 460 },
        speed: { min: 4, max: 20 },
        angle: { min: 235, max: 305 },
        scale: { start: 0.3, end: 0.04 },
        alpha: { start: 0.9, end: 0 },
        tint: [0xffc257, 0xff7a1e, 0xffe39a],
        blendMode: Phaser.BlendModes.ADD
      })
      .setDepth(1.66);
    try {
      // (no tip on a frozen economy — an op's: wrecks pay its side nothing)
      this.hinted = opts.spectator || incomeOf(world, opts.player) <= 0 || localStorage.getItem(HINT_KEY) === "1";
    } catch {
      this.hinted = true;
    }
  }

  // ------------------------------------------------------------ events ---

  /** Feed every sim fx event through here (before the entity views sync). */
  onFx(ev: FxEvent): void {
    if (ev.type === "death" && ev.unitKind && ev.unitKind !== "harvester") {
      this.deaths.set(ev.id, { pose: this.opts.pose(ev.id), ev });
    } else if (ev.type === "salvage") {
      this.collected.add(ev.wreckId);
      this.pickedUp(ev);
    }
  }

  private pickedUp(ev: Extract<FxEvent, { type: "salvage" }>): void {
    const mine = ev.faction === this.opts.player && !this.opts.spectator;
    const x = ev.x * TILE;
    const y = ev.y * TILE;
    if (!mine && !this.opts.visibleAt(ev.x, ev.y)) return;
    const amount = Math.round(ev.value);
    if (mine) {
      sfx.play("coin", 0.8);
      this.floatText(x, y, amount, "#ffd66e", 19);
      this.trackHaul(amount, ev.x, ev.y);
    } else {
      // spectating: each side's haul in its team colour; playing: the enemy's in muted red
      this.floatText(x, y, amount, this.opts.spectator && ev.faction === "blue" ? "#9fd0ff" : "#ff9a8a", 13);
    }
  }

  /** A burst of own salvage (sweeping a wreck field) is a moment worth calling out. */
  private trackHaul(amount: number, x: number, y: number): void {
    const now = this.scene.time.now;
    this.haul.push({ t: now, v: amount });
    while (this.haul.length && now - this.haul[0]!.t > HAUL_WINDOW) this.haul.shift();
    const sum = this.haul.reduce((s, h) => s + h.v, 0);
    if (sum >= HAUL_AT && now - this.lastHaul > 30000) {
      this.lastHaul = now;
      this.haul = [];
      announce({ key: "salvage-haul", text: "SALVAGE HAUL", sub: `+${sum} scrap from the wreckage`, tone: "good", priority: 3, x, y });
    }
  }

  // -------------------------------------------------------------- sync ---

  /** Per frame, after the sim ticks and the unit views sync. */
  sync(dtMs: number): void {
    const w = this.world;
    this.time += dtMs;
    const live = new Set<number>();
    for (const r of w.wrecks) {
      live.add(r.id);
      let v = this.views.get(r.id);
      if (!v) v = this.create(r);
      this.update(v, dtMs);
    }
    // aircraft lost where no tank could ever reach (water, lava, rock): fall and sink
    for (const [id, d] of this.deaths)
      if (!live.has(id) && d.ev.air && d.pose?.visible) this.sink(d.ev.unitKind!, d.ev.faction, d.pose);
    this.deaths.clear();

    for (const [id, v] of this.views) {
      if (live.has(id)) continue;
      const visibleNow = this.opts.visibleAt(v.x / TILE, v.y / TILE);
      if (!v.gone) {
        v.gone = true;
        if (!v.seen) {
          this.destroy(v);
          continue;
        }
        if (this.collected.has(id) && visibleNow) {
          this.popAway(v);
          continue;
        }
        if (visibleNow) {
          this.fadeAway(v, 350);
          continue;
        }
        // seen once, out of sight now: remembered as a ghost until re-seen
      } else if (visibleNow || w.tick >= v.expireTick) {
        this.fadeAway(v, 350);
        continue;
      }
      this.update(v, dtMs);
    }
    this.collected.clear();
    // ghosts first, then the oldest, if the field gets too busy
    if (this.views.size > MAX_VIEWS)
      for (const [, v] of this.views) {
        if (this.views.size <= MAX_VIEWS) break;
        if (v.gone) this.destroy(v);
      }
  }

  /** Wrecks the player currently knows about (tile coords), for minimap dots. */
  dots(): { x: number; y: number }[] {
    const out: { x: number; y: number }[] = [];
    for (const v of this.views.values()) if (v.seen && !v.landing) out.push({ x: v.x / TILE, y: v.y / TILE });
    return out;
  }

  // ------------------------------------------------------------ views ---

  private create(r: Wreck): WreckView {
    const s = this.scene;
    const air = UNITS[r.kind].domain === "air";
    const frame = unitFrame(r.faction, r.kind);
    const [ox, oy] = air ? [0.5, 0.5] : frameOrigin(frame);
    const x = r.x * TILE;
    const y = r.y * TILE;
    // a slight twist: it slewed as it died
    const face = r.facing + (rnd(r.id, 1) - 0.5) * 0.5;
    const scale = ART_SCALE * (air ? 0.9 : 0.97);
    const shadow = s.add
      .image(x + 3, y + 4, ATLAS, frame).setOrigin(ox, oy).setScale(scale).setRotation(face)
      .setTint(0x000000).setAlpha(0.28).setDepth(1.58);
    const body = s.add.image(x, y, ATLAS, frame).setOrigin(ox, oy).setScale(scale).setRotation(face).setTint(BURNT).setDepth(1.6);
    const aura = s.add
      .image(x, y, "fx-glow").setDepth(1.56).setScale(1.25).setTint(0xffb53d).setAlpha(0)
      .setBlendMode(Phaser.BlendModes.ADD);
    const glint = s.add.image(x, y, "fx-glint").setDepth(1.7).setScale(0).setTint(0xffe9a8).setBlendMode(Phaser.BlendModes.ADD);
    const v: WreckView = {
      id: r.id, kind: r.kind, x, y, body, shadow, aura, glint, parts: [shadow, body, aura, glint],
      seen: false, gone: false,
      expireTick: this.world.tick + r.ttl, coolTick: this.world.tick + r.hot,
      landing: false, smokeT: 0, glintT: 600 + rnd(r.id, 2) * 1800, phase: rnd(r.id, 3) * Math.PI * 2
    };
    if (UNITS[r.kind].turret) {
      // turret blown off its ring: tossed a little way, knocked askew
      const [mx, my] = mountOffset(r.kind);
      const c = Math.cos(face);
      const sn = Math.sin(face);
      const tf = turretFrame(r.faction, r.kind);
      const [tox, toy] = frameOrigin(tf);
      const a = rnd(r.id, 4) * Math.PI * 2;
      const d = 6 + rnd(r.id, 5) * 5;
      const tx = x + (mx * c - my * sn) * TILE + Math.sin(a) * d;
      const ty = y + (mx * sn + my * c) * TILE - Math.cos(a) * d;
      const rot = face + (rnd(r.id, 6) - 0.5) * 2.4;
      v.turret = s.add.image(tx, ty, ATLAS, tf).setOrigin(tox, toy).setScale(scale).setRotation(rot).setTint(BURNT_TURRET).setDepth(1.62);
      v.parts.push(v.turret);
    }
    this.views.set(r.id, v);

    // fresh off a death this frame: start from where the unit was drawn
    const death = this.deaths.get(r.id);
    if (death?.pose?.visible) {
      const p = death.pose;
      v.seen = true;
      if (air) this.fall(v, p, face);
      else if (Math.hypot(p.gx - x, p.gy - y) > 2) this.slide(v, p.gx, p.gy);
    }
    return v;
  }

  /** An aircraft drops from flying height, tumbling, onto its resting spot. */
  private fall(v: WreckView, p: UnitPose, face: number): void {
    v.landing = true;
    const spin = (rnd(v.id, 7) < 0.5 ? -1 : 1) * (0.7 + rnd(v.id, 8) * 0.5);
    v.body.setPosition(p.bx, p.by).setRotation(face - spin).setScale(ART_SCALE).setTint(0xb0a090);
    v.shadow.setPosition(p.gx + 12, p.gy + 16).setScale(ART_SCALE * 0.8).setAlpha(0.18);
    const dur = 280;
    this.scene.tweens.add({
      targets: v.body, x: v.x, y: v.y, rotation: face, scale: ART_SCALE * 0.9, duration: dur, ease: "Quad.easeIn",
      onComplete: () => {
        v.landing = false;
        v.body.setTint(BURNT);
        for (let i = 0; i < 4; i++) this.fx.dust(v.x + (rnd(v.id, 20 + i) - 0.5) * 30, v.y + (rnd(v.id, 30 + i) - 0.5) * 20);
      }
    });
    this.scene.tweens.add({ targets: v.shadow, x: v.x + 3, y: v.y + 4, scale: ART_SCALE * 0.9, alpha: 0.28, duration: dur, ease: "Quad.easeIn" });
  }

  /** Slid off a building / out of the water onto the nearest ground. */
  private slide(v: WreckView, fromX: number, fromY: number): void {
    v.landing = true;
    const dx = fromX - v.x;
    const dy = fromY - v.y;
    for (const o of v.parts) o.setPosition(o.x + dx, o.y + dy);
    this.scene.tweens.add({
      targets: v.parts, x: `-=${dx}`, y: `-=${dy}`, duration: 260, ease: "Quad.easeOut",
      onComplete: () => (v.landing = false)
    });
  }

  /** An aircraft lost over water or lava: it drops and is swallowed. */
  private sink(kind: UnitKind, faction: Faction, p: UnitPose): void {
    const img = this.scene.add
      .image(p.bx, p.by, ATLAS, unitFrame(faction, kind)).setScale(ART_SCALE).setRotation(p.face)
      .setTint(0x9a8a7a).setDepth(1.6);
    this.scene.tweens.add({
      targets: img, x: p.gx, y: p.gy, scale: ART_SCALE * 0.55, alpha: 0, rotation: p.face + 1.1,
      duration: 420, ease: "Quad.easeIn", onComplete: () => img.destroy()
    });
  }

  private update(v: WreckView, dtMs: number): void {
    const w = this.world;
    const visibleNow = this.opts.visibleAt(v.x / TILE, v.y / TILE);
    if (visibleNow) v.seen = true;
    const shown = v.seen;
    for (const o of v.parts) o.setVisible(shown);
    if (!shown) return;
    if (!this.hinted && visibleNow && !v.gone && w.tick >= v.coolTick)
      this.opts.hint("Glinting wrecks hold scrap: roll any ground unit over them.", v.x / TILE, v.y / TILE, () => {
        this.hinted = true;
        try {
          localStorage.setItem(HINT_KEY, "1");
        } catch {
          /* ignore */
        }
      });

    // burns out over its last 10 s
    const left = (v.expireTick - w.tick) / TICK_RATE;
    const fade = Phaser.Math.Clamp(left / 10, 0, 1);
    if (!v.landing) {
      v.body.setAlpha(fade);
      v.shadow.setAlpha(0.28 * fade);
      v.turret?.setAlpha(fade);
    }
    const hot = w.tick < v.coolTick;
    // loot glow: a slow warm breath once it's cool enough to salvage
    const auraA = hot || v.landing ? 0 : (0.13 + 0.07 * Math.sin(this.time / 520 + v.phase)) * fade;
    v.aura.setAlpha(auraA);
    if (!visibleNow || dtMs <= 0) return;

    // smoulder: fire and thick smoke while hot, a thin wisp for a few seconds after
    const age = (w.tick - (v.coolTick - Math.round(SALVAGE.hot * TICK_RATE))) / TICK_RATE;
    if (age < 7) {
      v.smokeT -= dtMs;
      if (v.smokeT <= 0) {
        v.smokeT = hot ? 200 + rnd(v.id, w.tick) * 120 : 600 + age * 110;
        const sx = v.x + (rnd(v.id, w.tick + 1) - 0.5) * 18;
        const sy = v.y + (rnd(v.id, w.tick + 2) - 0.5) * 14;
        this.smoke.emitParticleAt(sx, sy, 1);
        if (hot) this.embers.emitParticleAt(sx, sy, 1 + Math.round(rnd(v.id, w.tick + 3) * 2));
      }
    }
    // the glint that says "loot"
    if (!hot && !v.landing && !v.gone) {
      v.glintT -= dtMs;
      if (v.glintT <= 0) {
        v.glintT = 1700 + rnd(v.id, Math.floor(this.time / 1000)) * 1200;
        const gx = v.x + (rnd(v.id, Math.floor(this.time)) - 0.5) * 26;
        const gy = v.y + (rnd(v.id, Math.floor(this.time) + 9) - 0.5) * 22;
        v.glint.setPosition(gx, gy).setScale(0).setAlpha(fade).setRotation(0);
        this.scene.tweens.add({ targets: v.glint, scale: 0.9, rotation: 0.5, duration: 200, yoyo: true, ease: "Sine.easeOut" });
      }
    }
  }

  /** Scooped up: the hull shrinks into a gold sparkle. */
  private popAway(v: WreckView): void {
    this.views.delete(v.id);
    const ring = this.scene.add.image(v.x, v.y, "fx-ring").setDepth(7.9).setScale(0.25).setTint(GOLD).setBlendMode(Phaser.BlendModes.ADD);
    this.scene.tweens.add({ targets: ring, scale: 0.9, alpha: 0, duration: 380, onComplete: () => ring.destroy() });
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + rnd(v.id, 40);
      const g = this.scene.add.image(v.x, v.y, "fx-glint").setDepth(7.95).setScale(0.45).setTint(GOLD).setBlendMode(Phaser.BlendModes.ADD);
      this.scene.tweens.add({
        targets: g, x: v.x + Math.sin(a) * 34, y: v.y - Math.cos(a) * 26 - 16, scale: 0, rotation: 1.2,
        duration: 420, ease: "Quad.easeOut", onComplete: () => g.destroy()
      });
    }
    for (const o of v.parts) this.scene.tweens.killTweensOf(o);
    v.aura.destroy();
    v.glint.destroy();
    const hull = v.parts.filter((o) => o !== v.glint && o !== v.aura);
    this.scene.tweens.add({
      targets: hull, alpha: 0, scale: ART_SCALE * 0.55, duration: 220, ease: "Quad.easeIn",
      onComplete: () => hull.forEach((o) => o.destroy())
    });
  }

  private fadeAway(v: WreckView, ms: number): void {
    this.views.delete(v.id);
    const parts = v.parts;
    for (const o of parts) this.scene.tweens.killTweensOf(o);
    this.scene.tweens.add({ targets: parts, alpha: 0, duration: ms, onComplete: () => parts.forEach((o) => o.destroy()) });
  }

  private destroy(v: WreckView): void {
    this.views.delete(v.id);
    for (const o of v.parts) {
      this.scene.tweens.killTweensOf(o);
      o.destroy();
    }
  }

  /**
   * A gold "+52" that pops up from the wreck and drifts away. Pickups that
   * land together (a tank rolling through a wreck field) add up in one pop.
   */
  private floatText(x: number, y: number, amount: number, color: string, cssPx: number): void {
    const now = this.scene.time.now;
    this.floats = this.floats.filter((f) => f.text.active);
    const near = this.floats.find(
      (f) => f.color === color && now - f.born < 600 && Math.abs(f.x - x) < 110 && Math.abs(f.y - y) < 90
    );
    if (near) {
      near.amount += amount;
      near.born = now;
      this.launchFloat(near.text, near.x, near.y, `+${near.amount}`);
      return;
    }
    const cam = this.scene.cameras.main;
    const z = cam.zoom / this.opts.dpr; // CSS px per world px
    const size = Math.round(Phaser.Math.Clamp(cssPx / z, 16, 70));
    const text = this.scene.add
      .text(x, y, "", {
        fontFamily: '"Rajdhani", "Segoe UI", system-ui, sans-serif',
        fontStyle: "bold",
        fontSize: `${size}px`,
        color,
        stroke: "#1b1306",
        strokeThickness: Math.max(3, Math.round(size / 5))
      })
      .setOrigin(0.5, 1)
      .setDepth(8.8)
      .setResolution(Math.max(1, Math.min(2, cam.zoom)));
    this.floats.push({ text, x, y, amount, color, born: now });
    this.launchFloat(text, x, y, `+${amount}`);
  }

  private launchFloat(t: Phaser.GameObjects.Text, x: number, y: number, label: string): void {
    this.scene.tweens.killTweensOf(t);
    const size = parseFloat(String(t.style.fontSize)) || 24;
    t.setText(label).setPosition(x, y - 14).setAlpha(1).setScale(0.7);
    this.scene.tweens.add({ targets: t, scale: 1, duration: 170, ease: "Back.easeOut" });
    this.scene.tweens.add({
      targets: t, y: y - 14 - size * 1.6, alpha: 0, delay: 520, duration: 900, ease: "Quad.easeIn",
      onComplete: () => t.destroy()
    });
  }
}

/** Four-point star: the "there's loot here" sparkle. */
function makeGlintTexture(scene: Phaser.Scene): void {
  if (scene.textures.exists("fx-glint")) return;
  const tex = scene.textures.createCanvas("fx-glint", 48, 48)!;
  const ctx = tex.getContext();
  const g = ctx.createRadialGradient(24, 24, 0, 24, 24, 10);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 48, 48);
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  for (const [w, h] of [[2.2, 23], [23, 2.2]] as const) {
    ctx.beginPath();
    ctx.moveTo(24 - w, 24);
    ctx.lineTo(24, 24 - h);
    ctx.lineTo(24 + w, 24);
    ctx.lineTo(24, 24 + h);
    ctx.closePath();
    ctx.fill();
  }
  tex.refresh();
}

