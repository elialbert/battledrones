import Phaser from "phaser";
import { BUILDINGS, UNITS } from "../../sim/balance";
import type { Faction, FxEvent, World } from "../../sim/types";
import { TILE } from "../assets";
import { sfx } from "../audio";
import {
  DepositPops,
  HpTrail,
  SpendWatch,
  barBlink,
  coinPitch,
  combatAge,
  deathCue,
  enemyBarColor,
  friendlyBarColor,
  ringStrength,
  shakeFor
} from "../juice";
import type { EntityRenderer } from "./entities";
import { AIR_LIFT, type Fx } from "./fx";

/** Team colours for ground rings and death pulses. */
const TEAM: Record<Faction, number> = { blue: 0x3d8bff, red: 0xff4a3a };
const TRAIL_COLOR = 0xfff1c0;
const POP_FONT = '"Rajdhani", "Segoe UI", system-ui, -apple-system, sans-serif';
/** Text is rasterised at this size and scaled to ~POP_CSS CSS px on screen. */
const POP_RASTER = 44;
const POP_CSS = 19;

export interface JuiceHost {
  world: World;
  entities: EntityRenderer;
  fx: Fx;
  player: Faction;
  spectator: boolean;
  /** May the local player see this world point (tiles)? */
  sees(x: number, y: number): boolean;
  /** Volume for a sound at world px (x, y): 0 far off-screen. */
  earshot(x: number, y: number): number;
  /** World px spanning `css` CSS px at the current zoom. */
  px(css: number): number;
}

/**
 * Combat and economy feedback layered over the battle: hit flashes, team
 * combat rings, damage-trail health bars, kill/loss cues, on-screen-only
 * camera shake and gold income pops. GameScene feeds it the sim's fx events
 * once per tick and calls update() every frame; the rules live in ../juice.ts.
 */
export class CombatJuice {
  private ground: Phaser.GameObjects.Graphics;
  private air: Phaser.GameObjects.Graphics;
  private trail = new HpTrail();
  private pops = new DepositPops();
  private spend = new SpendWatch();
  private popTexts = new Map<number, Phaser.GameObjects.Text>();
  private time = 0;
  private sweepT = 0;
  private shakeUntil = 0;
  private shakeLevel = 0;
  private lostAlertAt = -1e9;
  private resEl: HTMLElement | null = null;

  constructor(private scene: Phaser.Scene, private host: JuiceHost) {
    // rings sit under the hulls (ground units at depth 3, aircraft at 6)
    this.ground = scene.add.graphics().setDepth(2.85);
    this.air = scene.add.graphics().setDepth(5.9);
  }

  // ------------------------------------------------------------- events ---

  /** Handle this tick's sim events (called after GameScene.handleFx). */
  events(list: readonly FxEvent[]): void {
    for (const ev of list) {
      if (ev.type === "hit") this.host.entities.hitFlash(ev.id);
      else if (ev.type === "death") this.death(ev);
      else if (ev.type === "deposit") this.deposit(ev);
    }
  }

  private onScreen(wx: number, wy: number): boolean {
    return this.scene.cameras.main.worldView.contains(wx, wy);
  }

  private death(ev: Extract<FxEvent, { type: "death" }>): void {
    const h = this.host;
    const wx = ev.x * TILE;
    const wy = ev.y * TILE - (ev.air ? AIR_LIFT : 0);
    const ours = ev.faction === h.player;
    const seen = ours || h.sees(ev.x, ev.y);
    const visible = seen && this.onScreen(wx, wy);
    const cue = deathCue(ev, h.player, h.spectator, seen);
    if (cue.sound === "kill") sfx.play("kill", h.earshot(wx, wy));
    else if (cue.sound === "lost") {
      if (visible) sfx.play("lost", Math.max(0.6, h.earshot(wx, wy)));
      else if (this.time - this.lostAlertAt > 1200) {
        // off-screen losses are quieter and throttled, but never silent
        this.lostAlertAt = this.time;
        sfx.play("lost", 0.4);
      }
    }
    if (cue.vibrate) {
      try {
        if (typeof navigator.vibrate === "function") navigator.vibrate(20);
      } catch {
        /* haptics unavailable */
      }
    }
    if (!visible) return; // never shake (or pulse) for fogged / off-screen deaths
    const s = shakeFor(ev);
    if (this.time >= this.shakeUntil || s.intensity > this.shakeLevel) {
      this.scene.cameras.main.shake(s.ms, s.intensity, true);
      this.shakeUntil = this.time + s.ms;
      this.shakeLevel = s.intensity;
    }
    // a crisp ring in the victim's colour says whose unit just popped
    if (ev.unitKind) this.deathRing(wx, wy, TEAM[ev.faction], UNITS[ev.unitKind].radius * TILE);
  }

  /** Expanding team-coloured ring (normal blend, so it reads over the fireball's glow). */
  private deathRing(wx: number, wy: number, color: number, radius: number): void {
    const tex = 54; // fx-select ring radius in texture px
    const r0 = Math.max(radius * 1.1, this.host.px(12)) / tex;
    const img = this.scene.add.image(wx, wy, "fx-select").setDepth(7.95).setTint(color).setScale(r0).setAlpha(0.95);
    this.scene.tweens.add({
      targets: img, scale: r0 * 2.1, alpha: 0, duration: 480, ease: "Quad.easeOut",
      onComplete: () => img.destroy()
    });
  }

  private deposit(ev: Extract<FxEvent, { type: "deposit" }>): void {
    const h = this.host;
    if (ev.faction !== h.player) return;
    const key = Math.round(ev.x * 2) * 4096 + Math.round(ev.y * 2);
    const r = this.pops.add(key, ev.amount, this.time);
    const wx = ev.x * TILE;
    const wy = ev.y * TILE;
    this.popText(key, wx, wy, r.amount, r.merged);
    if (h.spectator) return;
    sfx.play("coin", this.onScreen(wx, wy) ? 0.9 : 0.3, coinPitch(r.streak));
    this.pill("bump");
  }

  /** A gold "+100" that rises from the drop-off; merged deliveries bump the same label. */
  private popText(key: number, wx: number, wy: number, amount: number, merged: boolean): void {
    const label = `+${Math.round(amount)}`;
    const scale = this.host.px(POP_CSS) / POP_RASTER;
    const cur = this.popTexts.get(key);
    if (merged && cur?.active) {
      cur.setText(label);
      this.scene.tweens.add({ targets: cur, scale: { from: scale * 1.25, to: scale }, duration: 180 });
      return;
    }
    const t = this.scene.add
      .text(wx, wy - TILE * 0.3, label, {
        fontFamily: POP_FONT,
        fontSize: `${POP_RASTER}px`,
        fontStyle: "bold",
        color: "#ffd66e",
        stroke: "#3a2604",
        strokeThickness: 8
      })
      .setOrigin(0.5, 1)
      .setDepth(8.6)
      .setScale(scale * 0.6);
    this.popTexts.set(key, t);
    const rise = this.host.px(38);
    this.scene.tweens.add({ targets: t, scale, duration: 160, ease: "Back.easeOut" });
    this.scene.tweens.add({ targets: t, y: t.y - rise, duration: 1100, ease: "Quad.easeOut" });
    this.scene.tweens.add({
      targets: t, alpha: 0, delay: 650, duration: 450,
      onComplete: () => {
        if (this.popTexts.get(key) === t) this.popTexts.delete(key);
        t.destroy();
      }
    });
  }

  /** Restart a one-shot CSS animation on the scrap pill. */
  private pill(cls: "bump" | "spend"): void {
    this.resEl ??= document.getElementById("res");
    const el = this.resEl;
    if (!el) return;
    el.classList.remove("bump", "spend");
    void el.offsetWidth; // reflow so the animation restarts
    el.classList.add(cls);
  }

  // -------------------------------------------------------------- frame ---

  update(dtMs: number): void {
    this.time += dtMs;
    const h = this.host;
    const w = h.world;
    if (!h.spectator && h.world.winner === null && this.spend.update(w.factions[h.player].scrap) > 0) this.pill("spend");

    // health trails for everything on show (cheap: one map entry per entity)
    for (const u of w.units.values())
      if (h.entities.isShown(u.id)) this.trail.update(u.id, u.hp / UNITS[u.kind].hp, 1, this.time);
    for (const b of w.buildings.values())
      if (h.entities.isShown(b.id)) this.trail.update(b.id, b.hp / BUILDINGS[b.kind].hp, 1, this.time);
    this.sweepT += dtMs;
    if (this.sweepT > 2000) {
      this.sweepT = 0;
      this.trail.retain((id) => w.units.has(id) || w.buildings.has(id));
    }

    // team rings under every unit that fired or was hit in the last ~3 s
    const g = this.ground.clear();
    const a = this.air.clear();
    const lw = h.px(1.6);
    for (const u of w.units.values()) {
      const k = ringStrength(combatAge(u, w.tick));
      if (k <= 0 || !h.entities.isShown(u.id)) continue;
      const p = h.entities.pos(u.id);
      if (!p) continue;
      const st = UNITS[u.kind];
      const flying = st.domain === "air";
      const gfx = flying ? a : g;
      const col = TEAM[u.faction];
      const r = Math.max(st.radius * TILE * 1.32, h.px(11));
      const x = flying ? p.x : p.gx;
      const y = flying ? p.y : p.gy;
      gfx.fillStyle(col, 0.2 * k).fillEllipse(x, y + 2, r * 2, r * 1.8);
      gfx.lineStyle(lw, col, 0.75 * k).strokeEllipse(x, y + 2, r * 2, r * 1.8);
    }
  }

  // --------------------------------------------------------- health bars ---

  /**
   * A health bar with a damage trail (recently lost HP in pale gold that
   * drains away) and, for enemies near death, a 2 Hz blink. Sizes stay in
   * whole device pixels so bars are crisp at every zoom.
   */
  healthBar(
    g: Phaser.GameObjects.Graphics,
    id: number,
    x: number,
    y: number,
    width: number,
    ratio: number,
    friendly: boolean
  ): void {
    const px = this.host.px;
    const minW = px(22);
    if (width < minW) {
      x -= (minW - width) / 2;
      width = minW;
    }
    const cam = this.scene.cameras.main;
    // snap edges to device pixels; Phaser maps world → screen as
    // floor(x + originX + 0.5) + zoom * (world - scroll - originX)
    const z = cam.zoom;
    const ox = cam.width * cam.originX;
    const oy = cam.height * cam.originY;
    const cx = Math.floor(cam.x + ox + 0.5) - z * ox;
    const cy = Math.floor(cam.y + oy + 0.5) - z * oy;
    const snap = (v: number, scroll: number, c: number) => (Math.round((v - scroll) * z + c) - c) / z + scroll;
    const x0 = snap(x, cam.scrollX, cx);
    const y0 = snap(y, cam.scrollY, cy);
    const x1 = snap(x + width, cam.scrollX, cx);
    const one = 1 / z; // one device pixel in world px
    const hgt = Math.max(2, Math.round(px(4) * z)) / z;
    const bw = x1 - x0;
    const r = Math.max(0, Math.min(1, ratio));
    const fill = (k: number) => Math.round(bw * k * z) / z;
    const border = Math.max(one, Math.round(px(1) * z) / z);
    g.fillStyle(0x0a0d14, 0.85).fillRect(x0 - border, y0 - border, bw + border * 2, hgt + border * 2);
    const trail = Math.max(r, Math.min(1, this.trail.value(id) ?? r));
    const filled = fill(r);
    if (trail > r) g.fillStyle(TRAIL_COLOR, 0.95).fillRect(x0 + filled, y0, fill(trail) - filled, hgt);
    const col = friendly ? friendlyBarColor(r) : enemyBarColor(r);
    g.fillStyle(col, barBlink(r, friendly, this.time)).fillRect(x0, y0, filled, hgt);
    // segment ticks make big health pools readable at a glance
    const segs = Math.min(10, Math.floor(bw / px(7)));
    if (segs < 2) return;
    g.fillStyle(0x0a0d14, 0.55);
    for (let i = 1; i < segs; i++) g.fillRect(x0 + fill(i / segs), y0, one, hgt);
  }
}
