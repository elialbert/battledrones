import Phaser from "phaser";
import { POWERS } from "../../sim/balance";
import { POWER_NAMES } from "../../sim/powers";
import type { Calldown, Faction, FxEvent, PowerKind, World } from "../../sim/types";
import { hqOf } from "../../sim/world";
import { announce } from "../announce";
import { calldownThreatens } from "../awareness";
import { sfx, type SfxName } from "../audio";
import { TILE } from "../assets";
import type { Fx } from "./fx";

/**
 * Everything the commander calldowns look and sound like: public reticles
 * (red for the enemy's, gold/cyan/blue for yours) that shrink to the moment
 * of impact, Barrage shells streaking in, the EMP shockwave and the
 * crackle on whatever it froze, Drop Pods falling with a flare and dust,
 * and the Sky Hammer's beam from orbit. Also the targeting preview, the
 * warnings, and the announcer lines for the big moments.
 */

export interface PowerRendererOpts {
  player: Faction;
  spectator: boolean;
  dpr: number;
  /** Is the tile position visible to the local player (or fog off)? */
  visibleAt(x: number, y: number): boolean;
  /** Volume for a sound at world px (x, y). */
  earshot(x: number, y: number): number;
  /** Rendered position of an entity (world px), and whether it is drawn. */
  pos(id: number): { x: number; y: number } | null;
  isShown(id: number): boolean;
  /** Tap-to-jump warning toast and a minimap ping. */
  alert(msg: string, x: number, y: number): void;
  ping(x: number, y: number): void;
}

/** What the player is aiming while a calldown button is armed. */
export interface TargetPreview {
  power: PowerKind;
  /** Aim point in tiles. */
  x: number;
  y: number;
  ok: boolean;
}

const ENEMY = 0xff3b30;
const OWN: Record<PowerKind, number> = { barrage: 0xffc93c, emp: 0x7fe3ff, droppod: 0x6eb0ff, hammer: 0xffd86e };
const EMP_BLUE = 0xbfeaff;
/** Barrage shells appear this many sim ticks before they land, falling from this offset (world px). */
const SHELL_LEAD = 3.2;
const STREAK_DX = -140;
const STREAK_DY = -520;
/** Above the fog (10): reticles are public and show through it. */
const RETICLE_DEPTH = 10.4;

interface Falling {
  img: Phaser.GameObjects.Image;
  glow: Phaser.GameObjects.Image;
}

export class PowerRenderer {
  private g: Phaser.GameObjects.Graphics;
  private arcs: Phaser.GameObjects.Graphics;
  private sparks: Phaser.GameObjects.Particles.ParticleEmitter;
  private trail: Phaser.GameObjects.Particles.ParticleEmitter;
  private pods = new Map<number, Falling>();
  private landed: Phaser.GameObjects.Image[] = [];
  private incoming = new Set<string>();
  /** Barrage shells in the air, positioned from sim time (pauses and speeds with the game). */
  private streaks: { img: Phaser.GameObjects.Image; x: number; y: number; tick: number; lead: number }[] = [];
  private time = 0;
  /** Kills by each of our calldowns, for the "direct hit" callout. */
  private tally = new Map<number, { power: PowerKind; faction: Faction; kills: number; value: number; x: number; y: number }>();
  private hammerAnnounced = false;

  constructor(
    private scene: Phaser.Scene,
    private world: World,
    private fx: Fx,
    private opts: PowerRendererOpts
  ) {
    makePowerTextures(scene);
    this.arcs = scene.add.graphics().setDepth(7.66);
    this.g = scene.add.graphics().setDepth(RETICLE_DEPTH);
    this.sparks = scene.add
      .particles(0, 0, "fx-spark", {
        emitting: false,
        lifespan: { min: 120, max: 380 },
        speed: { min: 30, max: 150 },
        scale: { start: 0.9, end: 0.1 },
        alpha: { start: 1, end: 0 },
        tint: [0xbfeaff, 0x7fd4ff, 0xffffff],
        blendMode: Phaser.BlendModes.ADD
      })
      .setDepth(7.7);
    this.trail = scene.add
      .particles(0, 0, "fx-glow", {
        emitting: false,
        lifespan: { min: 180, max: 420 },
        speed: { min: 0, max: 18 },
        scale: { start: 0.55, end: 0.05 },
        alpha: { start: 0.85, end: 0 },
        tint: [0xffc257, 0xff7a1e, 0xffe39a],
        blendMode: Phaser.BlendModes.ADD
      })
      .setDepth(RETICLE_DEPTH - 0.05);
  }

  private friendly(f: Faction): boolean {
    return f === this.opts.player;
  }

  private px(css: number): number {
    return (css * this.opts.dpr) / this.scene.cameras.main.zoom;
  }

  private onScreen(x: number, y: number, pad = 2 * TILE): boolean {
    const v = this.scene.cameras.main.worldView;
    return x > v.x - pad && x < v.right + pad && y > v.y - pad && y < v.bottom + pad;
  }

  private sound(name: SfxName, x: number, y: number, vol = 1, floor = 0): void {
    sfx.play(name, Math.max(floor, vol * this.opts.earshot(x, y)));
  }

  private shake(x: number, y: number, ms: number, k: number): void {
    if (this.onScreen(x, y, TILE)) this.scene.cameras.main.shake(ms, k);
  }

  // ------------------------------------------------------------- events ---

  onFx(ev: FxEvent): void {
    switch (ev.type) {
      case "calldown":
        this.started(ev);
        break;
      case "calldownImpact":
        this.landed_(ev);
        break;
      case "stun":
        for (const id of ev.ids) {
          const p = this.opts.isShown(id) ? this.opts.pos(id) : null;
          if (p) this.sparks.emitParticleAt(p.x, p.y, 6);
        }
        break;
      case "powerOnline":
        if (ev.power !== "hammer") break;
        if (!this.hammerAnnounced && (this.friendly(ev.faction) || this.opts.spectator)) {
          this.hammerAnnounced = true;
          announce({
            key: "sky-hammer-online",
            text: "Sky Hammer online",
            sub: this.opts.spectator ? "Both commanders can call orbital strikes" : "Orbital strike ready. Tap its button, then the map",
            tone: "epic",
            priority: 1
          });
          sfx.play("ready");
        }
        break;
      case "death": {
        if (ev.killerId === null) break;
        // a calldown's victims die in the same tick it lands, killed by its side's HQ
        for (const t of this.tally.values()) {
          const hq = hqOf(this.world, t.faction);
          if (hq && hq.id === ev.killerId && Math.hypot(ev.x - t.x, ev.y - t.y) <= POWERS.hammer.radius + 3) {
            t.kills++;
            t.value += ev.value;
            break;
          }
        }
        break;
      }
    }
  }

  private started(ev: Extract<FxEvent, { type: "calldown" }>): void {
    const x = ev.x * TILE;
    const y = ev.y * TILE;
    const name = POWER_NAMES[ev.power];
    const ours = this.friendly(ev.faction) && !this.opts.spectator;
    // does it threaten anything of the player's? (then the siren carries off-screen too;
    // the same rule drops a fast game back to 1×, src/game/awareness.ts)
    const threatened = !ours && !this.opts.spectator && calldownThreatens(this.world, this.opts.player, ev.x, ev.y, ev.radius);
    if (ours) sfx.play("uplink", 0.8);
    else this.sound("siren", x, y, 0.9, threatened || ev.power === "hammer" ? 0.5 : 0);
    if (ev.power === "hammer") this.sound("charge", x, y, 0.8, this.opts.spectator ? 0 : 0.3);
    if (ev.power === "droppod") {
      const tint = ev.faction === "blue" ? 0xa9d0ff : 0xffb3a3;
      const img = this.scene.add.image(x, y, "pw-pod").setDepth(RETICLE_DEPTH - 0.02).setTint(tint).setVisible(false);
      const glow = this.scene.add
        .image(x, y, "fx-glow")
        .setDepth(RETICLE_DEPTH - 0.03)
        .setTint(0xff9a3a)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setVisible(false);
      this.pods.set(ev.id, { img, glow });
    }
    if (this.friendly(ev.faction)) {
      this.tally.set(ev.id, { power: ev.power, faction: ev.faction, kills: 0, value: 0, x: ev.x, y: ev.y });
      return;
    }
    if (this.opts.spectator) {
      if (ev.power === "hammer")
        announce({ key: "sky-hammer-inbound", text: "Sky Hammer inbound!", sub: `${ev.faction === "blue" ? "Blue" : "Red"} calls an orbital strike`, tone: "info", priority: 1, x: ev.x, y: ev.y });
      return;
    }
    // the enemy's: warn, loudly if it threatens anything of ours
    if (ev.power === "hammer") {
      announce({
        key: "enemy-sky-hammer",
        text: "Enemy Sky Hammer inbound!",
        sub: "Get clear of the red circle",
        tone: "bad",
        priority: 0,
        x: ev.x,
        y: ev.y
      });
      this.opts.ping(ev.x, ev.y);
      return;
    }
    if (!threatened) return;
    this.opts.ping(ev.x, ev.y);
    if (!this.onScreen(x, y, 0)) this.opts.alert(`Enemy ${name} inbound!`, ev.x, ev.y);
  }

  private landed_(ev: Extract<FxEvent, { type: "calldownImpact" }>): void {
    const x = ev.x * TILE;
    const y = ev.y * TILE;
    const s = this.scene;
    switch (ev.power) {
      case "barrage": {
        this.fx.explosion({ type: "explosion", x: ev.x, y: ev.y, size: 1.5, air: false, kind: "impact" }, { x, y });
        this.fx.pulse(x, y, 0xffb35a, 2.2);
        for (let i = 0; i < 3; i++) this.fx.dust(x + (Math.random() - 0.5) * 50, y + (Math.random() - 0.5) * 50);
        this.sound("shell", x, y, 0.9);
        this.shake(x, y, 150, 0.004);
        break;
      }
      case "emp": {
        const R = POWERS.emp.radius * TILE;
        for (const [delay, k] of [[0, 1], [90, 0.75]] as const) {
          const ring = s.add
            .image(x, y, "fx-ring")
            .setDepth(7.9)
            .setScale(0.2)
            .setTint(EMP_BLUE)
            .setBlendMode(Phaser.BlendModes.ADD);
          s.tweens.add({ targets: ring, scale: (R * 2 * k) / 56, alpha: 0, delay, duration: 420, ease: "Cubic.easeOut", onComplete: () => ring.destroy() });
        }
        const glow = s.add.image(x, y, "fx-glow").setDepth(7.9).setScale(3).setTint(EMP_BLUE).setBlendMode(Phaser.BlendModes.ADD);
        s.tweens.add({ targets: glow, alpha: 0, scale: 5, duration: 380, onComplete: () => glow.destroy() });
        this.sparks.emitParticleAt(x, y, 24);
        this.sound("emp", x, y, 1, 0.15);
        this.shake(x, y, 120, 0.003);
        break;
      }
      case "droppod": {
        const pod = this.pods.get(ev.id);
        pod?.img.destroy();
        pod?.glow.destroy();
        this.pods.delete(ev.id);
        const tint = ev.faction === "blue" ? 0xa9d0ff : 0xffb3a3;
        const shell = s.add.image(x, y, "pw-pod-open").setDepth(2.4).setTint(tint).setScale(0.9).setRotation(Math.random() * Math.PI * 2);
        this.landed.push(shell);
        s.tweens.add({ targets: shell, alpha: 0, delay: 9000, duration: 3000, onComplete: () => shell.destroy() });
        if (this.landed.length > 12) this.landed.shift()?.destroy();
        const flare = s.add.image(x, y, "fx-glow").setDepth(7.9).setScale(4).setTint(0xffb35a).setBlendMode(Phaser.BlendModes.ADD);
        s.tweens.add({ targets: flare, alpha: 0, scale: 6, duration: 450, onComplete: () => flare.destroy() });
        this.fx.pulse(x, y, 0xe8d8b0, 2);
        for (let i = 0; i < 10; i++) {
          const a = (i / 10) * Math.PI * 2;
          this.fx.dust(x + Math.cos(a) * 34, y + Math.sin(a) * 26);
        }
        for (const id of ev.unitIds) {
          const u = this.world.units.get(id);
          if (u && this.friendly(u.faction)) this.fx.pulse(u.x * TILE, u.y * TILE, 0x7ec1ff, 0.8);
        }
        this.sound("pod", x, y, 1);
        this.shake(x, y, 140, 0.003);
        break;
      }
      case "hammer": {
        const R = POWERS.hammer.radius * TILE;
        const beam = s.add
          .image(x, y - 700, "fx-beam")
          .setDepth(RETICLE_DEPTH + 0.05)
          .setDisplaySize(1400, 150)
          .setRotation(Math.PI / 2)
          .setTint(0xdff6ff)
          .setBlendMode(Phaser.BlendModes.ADD);
        s.tweens.add({ targets: beam, alpha: 0, displayHeight: 30, duration: 650, ease: "Quad.easeIn", onComplete: () => beam.destroy() });
        const flash = s.add.image(x, y, "fx-glow").setDepth(RETICLE_DEPTH + 0.04).setScale(7).setTint(0xffffff).setBlendMode(Phaser.BlendModes.ADD);
        s.tweens.add({ targets: flash, alpha: 0, scale: 11, duration: 520, onComplete: () => flash.destroy() });
        for (const [delay, k, tint] of [[0, 1.15, 0xffffff], [120, 0.85, 0xffd27a], [260, 1.4, 0xffa040]] as const) {
          const ring = s.add.image(x, y, "fx-ring").setDepth(7.95).setScale(0.3).setTint(tint).setBlendMode(Phaser.BlendModes.ADD);
          s.tweens.add({ targets: ring, scale: (R * 2 * k) / 56, alpha: 0, delay, duration: 600, ease: "Cubic.easeOut", onComplete: () => ring.destroy() });
        }
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2 + Math.random();
          const d = i === 0 ? 0 : R * (0.35 + Math.random() * 0.4);
          s.time.delayedCall(i * 70, () =>
            this.fx.explosion(
              { type: "explosion", x: ev.x, y: ev.y, size: i === 0 ? 2.2 : 1, air: false, kind: "unit" },
              { x: x + Math.cos(a) * d, y: y + Math.sin(a) * d }
            )
          );
        }
        this.sound("hammer", x, y, 1, 0.45);
        if (this.onScreen(x, y, 4 * TILE)) this.scene.cameras.main.shake(520, 0.012);
        break;
      }
    }
  }

  // ---------------------------------------------------------- per frame ---

  /** Draw reticles, falling pods and shells, stun crackle and the aim preview. */
  sync(dtMs: number, alpha: number, preview: TargetPreview | null): void {
    this.time += dtMs;
    const g = this.g;
    g.clear();
    this.arcs.clear();
    const w = this.world;
    const now = w.tick - 1 + alpha; // fractional sim tick on screen
    for (const c of w.powers.active) this.drawCalldown(c, now);
    this.flyStreaks(now);
    this.drawStuns(dtMs);
    if (preview) this.drawPreview(preview);
    this.settleTallies();
  }

  private drawCalldown(c: Calldown, now: number): void {
    const g = this.g;
    const friendly = this.friendly(c.faction);
    const col = friendly ? OWN[c.power] : ENEMY;
    const x = c.x * TILE;
    const y = c.y * TILE;
    const R = c.radius * TILE;
    const span = Math.max(1, c.landTick - c.startTick);
    const k = Phaser.Math.Clamp((now - c.startTick) / span, 0, 1);
    const blink = 0.5 + 0.5 * Math.sin(this.time * (0.01 + k * 0.02));
    // danger disc, brightening as it closes in
    g.fillStyle(col, 0.07 + 0.1 * k + 0.05 * blink).fillCircle(x, y, R);
    g.lineStyle(this.px(2.5), col, 0.95).strokeCircle(x, y, R);
    if (k < 1 && R * (1 - k) > this.px(3)) g.lineStyle(this.px(2), col, 0.75 + 0.25 * blink).strokeCircle(x, y, R * (1 - k));
    // four outward brackets
    const spin = c.power === "hammer" ? this.time * 0.0016 : 0;
    for (let i = 0; i < 4; i++) {
      const a = spin + (i * Math.PI) / 2;
      const r0 = R + this.px(4);
      const r1 = R + this.px(14);
      g.lineStyle(this.px(3), col, 0.95).lineBetween(x + Math.sin(a) * r0, y - Math.cos(a) * r0, x + Math.sin(a) * r1, y - Math.cos(a) * r1);
    }
    // centre cross
    const cc = Math.min(R * 0.22, this.px(10));
    g.lineStyle(this.px(1.5), col, 0.9).lineBetween(x - cc, y, x + cc, y).lineBetween(x, y - cc, x, y + cc);

    if (c.power === "hammer") {
      // a targeting lance from orbit, thickening as the strike charges
      const top = y - 1100;
      g.lineStyle(this.px(1 + 5 * k * k), friendly ? 0xfff2c0 : 0xffb0a0, 0.25 + 0.55 * k).lineBetween(x, top, x, y);
      g.fillStyle(0xffffff, 0.15 + 0.5 * k * blink).fillCircle(x, y, this.px(4 + 10 * k));
    } else if (c.power === "droppod") {
      this.drawPod(c, now, x, y);
    } else if (c.power === "barrage") {
      c.shells.forEach((s, i) => {
        const key = `${c.id}:${i}`;
        const lead = s.tick - now;
        if (lead > 0 && lead <= SHELL_LEAD && !this.incoming.has(key)) {
          this.incoming.add(key);
          this.shellStreak(s.x * TILE, s.y * TILE, s.tick);
        }
      });
    }
  }

  private drawPod(c: Calldown, now: number, x: number, y: number): void {
    const pod = this.pods.get(c.id);
    if (!pod) return;
    const fall = 7; // ticks of visible descent
    const t = c.landTick - now;
    // the shadow tightens as the pod comes down
    const k = Phaser.Math.Clamp(1 - t / (c.landTick - c.startTick), 0, 1);
    this.g.fillStyle(0x000000, 0.12 + 0.3 * k).fillEllipse(x, y + 4, 26 + 40 * (1 - k), 14 + 22 * (1 - k));
    if (t > fall || t < 0) {
      pod.img.setVisible(false);
      pod.glow.setVisible(false);
      return;
    }
    const e = 1 - t / fall; // 0 → 1 as it lands
    const ease = e * e;
    const px = x + 260 * (1 - ease);
    const py = y - 720 * (1 - ease);
    pod.img.setVisible(true).setPosition(px, py).setScale(1.5 - 0.5 * ease).setRotation(0.35);
    pod.glow.setVisible(true).setPosition(px + 14, py - 30).setScale(1.6 - 0.4 * ease).setAlpha(0.9);
    this.trail.emitParticleAt(px + 10, py - 26, 2);
  }

  /** An incoming barrage shell: a bright streak that drops onto (x, y) at sim tick `tick`. */
  private shellStreak(x: number, y: number, tick: number): void {
    const img = this.scene.add
      .image(x + STREAK_DX, y + STREAK_DY, "fx-tracer")
      .setDepth(RETICLE_DEPTH - 0.02)
      .setScale(1.1, 2.2)
      .setRotation(Math.atan2(-STREAK_DX, STREAK_DY))
      .setBlendMode(Phaser.BlendModes.ADD)
      .setTint(0xffe0a0);
    this.streaks.push({ img, x, y, tick, lead: SHELL_LEAD });
  }

  private flyStreaks(now: number): void {
    if (this.streaks.length === 0) return;
    this.streaks = this.streaks.filter((s) => {
      const left = s.tick - now;
      if (left <= 0) {
        s.img.destroy();
        return false;
      }
      const k = Math.min(1, left / s.lead); // 1 → 0 as it comes down
      const e = k * k;
      s.img.setPosition(s.x + STREAK_DX * e, s.y + STREAK_DY * e);
      if (Math.random() < 0.6) this.trail.emitParticleAt(s.img.x, s.img.y, 1);
      return true;
    });
    if (this.incoming.size > 200) this.incoming.clear();
  }

  /** Blue crackle on everything an EMP froze (only what the player can see). */
  private drawStuns(dtMs: number): void {
    const st = this.world.powers.stunned;
    if (st.size === 0) return;
    const a = this.arcs;
    for (const [id, until] of st) {
      if (until <= this.world.tick || !this.opts.isShown(id)) continue;
      const p = this.opts.pos(id);
      if (!p) continue;
      const b = this.world.buildings.get(id);
      const r = b ? 26 : 16;
      // a flickering blue haze says "frozen" at a glance
      a.fillStyle(0x7fd4ff, 0.12 + 0.12 * Math.random()).fillCircle(p.x, p.y, r * 1.35);
      if (Math.random() < dtMs / 90) this.sparks.emitParticleAt(p.x + (Math.random() - 0.5) * r, p.y + (Math.random() - 0.5) * r, 1);
      // a jagged arc or two, redrawn every frame
      for (let n = 0; n < 2; n++) {
        if (Math.random() < 0.35) continue;
        let ang = Math.random() * Math.PI * 2;
        let px = p.x + Math.cos(ang) * r;
        let py = p.y + Math.sin(ang) * r;
        a.lineStyle(this.px(1.6), Math.random() < 0.5 ? 0xbfeaff : 0x7fd4ff, 0.9);
        a.beginPath();
        a.moveTo(px, py);
        for (let i = 0; i < 4; i++) {
          ang += 0.45 + Math.random() * 0.4;
          const rr = r * (0.55 + Math.random() * 0.6);
          px = p.x + Math.cos(ang) * rr;
          py = p.y + Math.sin(ang) * rr;
          a.lineTo(px, py);
        }
        a.strokePath();
      }
    }
  }

  private drawPreview(p: TargetPreview): void {
    const g = this.g;
    const x = p.x * TILE;
    const y = p.y * TILE;
    const R = POWERS[p.power].radius * TILE;
    const col = p.ok ? OWN[p.power] : 0x9aa3b0;
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 0.008);
    g.fillStyle(col, p.ok ? 0.12 + 0.06 * pulse : 0.08).fillCircle(x, y, R);
    // dashed rim
    const dashes = 28;
    g.lineStyle(this.px(2.5), col, 0.95);
    for (let i = 0; i < dashes; i += 1) {
      if (i % 2) continue;
      const a0 = (i / dashes) * Math.PI * 2 + this.time * 0.0006;
      const a1 = ((i + 1) / dashes) * Math.PI * 2 + this.time * 0.0006;
      g.beginPath();
      g.arc(x, y, R, a0, a1);
      g.strokePath();
    }
    const cc = this.px(12);
    g.lineStyle(this.px(2), col, 1).lineBetween(x - cc, y, x + cc, y).lineBetween(x, y - cc, x, y + cc);
    if (!p.ok) {
      const d = this.px(9);
      g.lineStyle(this.px(3), 0xff5a4a, 1).lineBetween(x - d, y - d, x + d, y + d).lineBetween(x - d, y + d, x + d, y - d);
    }
  }

  /** Once one of our calldowns has fully landed, cheer if it hit hard. */
  private settleTallies(): void {
    if (this.tally.size === 0) return;
    const live = new Set(this.world.powers.active.map((c) => c.id));
    for (const [id, t] of this.tally) {
      if (live.has(id)) continue;
      this.tally.delete(id);
      if (this.opts.spectator || t.power === "emp" || t.power === "droppod") continue;
      if (t.kills >= 3 || t.value >= 700)
        announce({
          key: "calldown-hit",
          text: t.kills >= 5 ? "Devastating strike!" : "Direct hit!",
          sub: `${POWER_NAMES[t.power]}: ${t.kills} destroyed (${Math.round(t.value)} scrap)`,
          tone: "good",
          priority: 3,
          x: t.x,
          y: t.y
        });
    }
  }

  /** Reticles for the minimap: tiles, radius, and whose. */
  rings(): { x: number; y: number; r: number; enemy: boolean }[] {
    return this.world.powers.active.map((c) => ({ x: c.x, y: c.y, r: c.radius, enemy: !this.friendly(c.faction) }));
  }

  destroy(): void {
    for (const p of this.pods.values()) {
      p.img.destroy();
      p.glow.destroy();
    }
    this.pods.clear();
  }
}

/** Procedural pod textures: the falling capsule and the landed, opened shell. */
function makePowerTextures(scene: Phaser.Scene): void {
  const make = (key: string, w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void) => {
    if (scene.textures.exists(key)) return;
    const tex = scene.textures.createCanvas(key, w, h)!;
    draw(tex.getContext());
    tex.refresh();
  };
  // falling capsule, nose down-left (it streaks in from the upper right)
  make("pw-pod", 44, 64, (ctx) => {
    ctx.translate(22, 32);
    const body = ctx.createLinearGradient(-14, 0, 14, 0);
    body.addColorStop(0, "#8a929e");
    body.addColorStop(0.45, "#f2f5f8");
    body.addColorStop(1, "#5d6470");
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(0, 28);
    ctx.quadraticCurveTo(14, 18, 13, -4);
    ctx.lineTo(10, -22);
    ctx.lineTo(-10, -22);
    ctx.lineTo(-13, -4);
    ctx.quadraticCurveTo(-14, 18, 0, 28);
    ctx.fill();
    ctx.fillStyle = "#3a404a";
    ctx.fillRect(-11, -26, 22, 5); // heat shield rim
    ctx.fillStyle = "#4c84d8";
    ctx.fillRect(-13, 2, 26, 4); // team stripe (tinted)
    ctx.fillStyle = "#1c2028";
    ctx.beginPath();
    ctx.ellipse(0, 12, 4, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    // fins
    ctx.fillStyle = "#6c7480";
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(s * 12, -14);
      ctx.lineTo(s * 19, -24);
      ctx.lineTo(s * 12, -22);
      ctx.fill();
    }
  });
  // landed pod seen from above: hatch open, four petals splayed
  make("pw-pod-open", 72, 72, (ctx) => {
    ctx.translate(36, 36);
    const scorch = ctx.createRadialGradient(0, 0, 4, 0, 0, 34);
    scorch.addColorStop(0, "rgba(20,16,12,0.65)");
    scorch.addColorStop(1, "rgba(20,16,12,0)");
    ctx.fillStyle = scorch;
    ctx.fillRect(-36, -36, 72, 72);
    for (let i = 0; i < 4; i++) {
      ctx.save();
      ctx.rotate((i * Math.PI) / 2 + Math.PI / 4);
      const pg = ctx.createLinearGradient(0, -10, 0, -30);
      pg.addColorStop(0, "#c9d0d8");
      pg.addColorStop(1, "#6a727e");
      ctx.fillStyle = pg;
      ctx.beginPath();
      ctx.moveTo(-8, -9);
      ctx.lineTo(-11, -28);
      ctx.quadraticCurveTo(0, -33, 11, -28);
      ctx.lineTo(8, -9);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#4c84d8";
      ctx.fillRect(-9, -22, 18, 3);
      ctx.restore();
    }
    const core = ctx.createRadialGradient(-2, -2, 1, 0, 0, 11);
    core.addColorStop(0, "#f4f6f8");
    core.addColorStop(1, "#59606b");
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(0, 0, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#20252d";
    ctx.beginPath();
    ctx.arc(0, 0, 5, 0, Math.PI * 2);
    ctx.fill();
  });
}
