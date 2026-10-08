import * as THREE from "three";
import { BUILDINGS, UNITS } from "../../sim/balance";
import type { Faction, FxEvent, World } from "../../sim/types";
import { sfx } from "../audio";
import { coinPitchIn } from "../score";
import {
  DepositPops,
  HpTrail,
  SpendWatch,
  barBlink,
  combatAge,
  deathCue,
  enemyBarColor,
  friendlyBarColor,
  ringStrength,
  shakeFor
} from "../juice";
import { TEX } from "../three/particles";
import { Ease } from "../three/tween";
import type { Label } from "../three/screen";
import type { View } from "../three/view";
import type { EntityRenderer } from "./entities";
import { AIR_H } from "../three/view";

/** Team colours for ground rings and death pulses. */
const TEAM: Record<Faction, number> = { blue: 0x3d8bff, red: 0xff4a3a };
const TRAIL_COLOR = "#fff1c0";
const POP_CSS = 19;

export interface JuiceHost {
  world: World;
  entities: EntityRenderer;
  player: Faction;
  spectator: boolean;
  /** May the local player see this world point (tiles)? */
  sees(x: number, y: number): boolean;
  /** Volume for a sound at tile point (x, y): 0 far off-screen. */
  earshot(x: number, y: number): number;
}

const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;

/**
 * Combat and economy feedback layered over the battle: hit flashes, team
 * combat rings, damage-trail health bars, kill/loss cues, on-screen-only
 * camera shake and gold income pops. GameScene feeds it the sim's fx events
 * once per tick and calls update() every frame; the rules live in ../juice.ts.
 */
export class CombatJuice {
  private trail = new HpTrail();
  private pops = new DepositPops();
  private spend = new SpendWatch();
  private popLabels = new Map<number, Label>();
  private time = 0;
  private sweepT = 0;
  private shakeUntil = 0;
  private shakeLevel = 0;
  private lostAlertAt = -1e9;
  private resEl: HTMLElement | null = null;

  constructor(private v: View, private host: JuiceHost) {}

  // ------------------------------------------------------------- events ---

  /** Handle this tick's sim events (called after GameScene.handleFx). */
  events(list: readonly FxEvent[]): void {
    for (const ev of list) {
      if (ev.type === "hit") this.host.entities.hitFlash(ev.id);
      else if (ev.type === "death") this.death(ev);
      else if (ev.type === "deposit") this.deposit(ev);
    }
  }

  private death(ev: Extract<FxEvent, { type: "death" }>): void {
    const h = this.host;
    const ours = ev.faction === h.player;
    const seen = ours || h.sees(ev.x, ev.y);
    const visible = seen && this.v.rig.onScreen(ev.x, ev.y);
    const cue = deathCue(ev, h.player, h.spectator, seen);
    if (cue.sound === "kill") sfx.play("kill", h.earshot(ev.x, ev.y));
    else if (cue.sound === "lost") {
      if (visible) sfx.play("lost", Math.max(0.6, h.earshot(ev.x, ev.y)));
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
      this.v.rig.shake(s.ms, s.intensity);
      this.shakeUntil = this.time + s.ms;
      this.shakeLevel = s.intensity;
    }
    // a crisp ring in the victim's colour says whose unit just popped
    if (ev.unitKind) {
      const r = UNITS[ev.unitKind].radius;
      const c = new THREE.Color(TEAM[ev.faction]);
      const ground = this.v.terrain.surfaceAt(ev.x, ev.y);
      this.v.particles.spawn({
        x: ev.x, y: (ev.air ? ground + AIR_H : ground) + 0.07, z: ev.y, life: 480, tex: TEX.select, flat: true,
        size0: Math.max(r * 2.6, 0.7), size1: Math.max(r * 2.6, 0.7) * 2.1, alpha0: 0.95, alpha1: 0, r: c.r, g: c.g, b: c.b
      });
    }
  }

  private deposit(ev: Extract<FxEvent, { type: "deposit" }>): void {
    const h = this.host;
    if (ev.faction !== h.player) return;
    const key = Math.round(ev.x * 2) * 4096 + Math.round(ev.y * 2);
    const r = this.pops.add(key, ev.amount, this.time);
    this.popText(key, ev.x, ev.y, r.amount, r.merged);
    if (h.spectator) return;
    sfx.play("coin", this.v.rig.onScreen(ev.x, ev.y) ? 0.9 : 0.3, coinPitchIn(h.world.biome, r.streak));
    this.pill("bump");
  }

  /** A gold "+100" that rises from the drop-off; merged deliveries bump the same label. */
  private popText(key: number, x: number, y: number, amount: number, merged: boolean): void {
    const text = `+${Math.round(amount)}`;
    const cur = this.popLabels.get(key);
    if (merged && cur && this.v.screen.has(cur)) {
      cur.text = text;
      this.v.tweens.add({ dur: 180, update: (k) => (cur.scale = 1.25 - 0.25 * k) });
      return;
    }
    const l = this.v.screen.label({
      x, y, h: this.v.terrain.surfaceAt(x, y) + 0.9, text, size: POP_CSS, color: "#ffd66e", stroke: "#3a2604", scale: 0.6
    });
    this.popLabels.set(key, l);
    this.v.tweens.add({ dur: 160, ease: Ease.backOut, update: (k) => (l.scale = 0.6 + 0.4 * k) });
    this.v.tweens.add({ dur: 1100, ease: Ease.quadOut, update: (k) => (l.dy = -38 * k) });
    this.v.tweens.add({
      dur: 450, delay: 650,
      update: (k) => (l.alpha = 1 - k),
      done: () => {
        if (this.popLabels.get(key) === l) this.popLabels.delete(key);
        this.v.screen.remove(l);
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
    const g = this.v.ground;
    for (const u of w.units.values()) {
      const k = ringStrength(combatAge(u, w.tick));
      if (k <= 0 || !h.entities.isShown(u.id)) continue;
      const p = h.entities.pos(u.id);
      if (!p) continue;
      const st = UNITS[u.kind];
      const flying = st.domain === "air";
      const col = TEAM[u.faction];
      const r = Math.max(st.radius * 1.4, 11 * g.px(p.x, p.y));
      const at = flying ? p.h - 0.08 : undefined;
      g.fillStyle(col, 0.2 * k).fillEllipse(p.x, p.y, r * 2, r * 2, at);
      g.lineStyle(1.6, col, 0.75 * k).strokeEllipse(p.x, p.y, r * 2, r * 2, at);
    }
  }

  // --------------------------------------------------------- health bars ---

  /**
   * A health bar with a damage trail (recently lost HP in pale gold that
   * drains away) and, for enemies near death, a 2 Hz blink — drawn in screen
   * space, crisp at every zoom. (x, y) is the bar's top-left in CSS px.
   */
  healthBar(ctx: CanvasRenderingContext2D, id: number, x: number, y: number, width: number, ratio: number, friendly: boolean): void {
    const minW = 22;
    if (width < minW) {
      x -= (minW - width) / 2;
      width = minW;
    }
    x = Math.round(x);
    y = Math.round(y);
    width = Math.round(width);
    const hgt = 4;
    const r = Math.max(0, Math.min(1, ratio));
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = "#0a0d14";
    ctx.fillRect(x - 1, y - 1, width + 2, hgt + 2);
    const trail = Math.max(r, Math.min(1, this.trail.value(id) ?? r));
    const filled = Math.round(width * r);
    if (trail > r) {
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = TRAIL_COLOR;
      ctx.fillRect(x + filled, y, Math.round(width * trail) - filled, hgt);
    }
    ctx.globalAlpha = barBlink(r, friendly, this.time);
    ctx.fillStyle = hex(friendly ? friendlyBarColor(r) : enemyBarColor(r));
    ctx.fillRect(x, y, filled, hgt);
    // segment ticks make big health pools readable at a glance
    const segs = Math.min(10, Math.floor(width / 7));
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = "#0a0d14";
    if (segs >= 2) for (let i = 1; i < segs; i++) ctx.fillRect(x + Math.round((width * i) / segs), y, 1, hgt);
    ctx.globalAlpha = 1;
  }
}
