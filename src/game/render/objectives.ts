import Phaser from "phaser";
import { OBJECTIVES, TICK_RATE } from "../../sim/balance";
import { CRATE_NAMES } from "../../sim/objectives";
import type { Crate, CrateReward, Faction, FxEvent, Uplink, World } from "../../sim/types";
import { buildingCenter, hqOf } from "../../sim/world";
import { announce } from "../announce";
import { sfx, type SfxName } from "../audio";
import { ART_SCALE, ATLAS, TILE, frameOrigin, mountOffset } from "../assets";
import type { Fx } from "./fx";

/**
 * How the map objectives look and sound: the Uplink relays (a neutral
 * platform whose dish turns for whoever holds it, a team-coloured capture
 * ring and bar that read through the fog), supply crates (a gold beacon the
 * moment one is announced, a striped parachute bringing it down, a glinting
 * crate with a burn-out timer) and the claim pop. Also the announcer lines,
 * warnings and the minimap marks for both.
 */

export interface ObjectiveRendererOpts {
  player: Faction;
  spectator: boolean;
  dpr: number;
  /** Is the tile position visible to the local player (or fog off)? */
  visibleAt(x: number, y: number): boolean;
  /** Volume for a sound at world px (x, y). */
  earshot(x: number, y: number): number;
  /** Tap-to-jump warning toast, a plain toast, a minimap ping, a one-time tip. */
  alert(msg: string, x: number, y: number): void;
  notify(msg: string, tone?: "good" | "bad"): void;
  ping(x: number, y: number): void;
  hint(msg: string, x?: number, y?: number): void;
}

const TEAM: Record<Faction, number> = { blue: 0x4fa3ff, red: 0xff5a4a };
const TEAM_CSS: Record<Faction, string> = { blue: "#7ec1ff", red: "#ff8a7a" };
const NEUTRAL = 0xe8c66a;
const GOLD = 0xffd66e;
/** Ground layer (under wrecks and units) and the through-the-fog layer (fog is 10). */
const GROUND_DEPTH = 1.51;
const OVER_FOG = 10.25;
const CRATE_DEPTH = 2.45;
/** Sim ticks of visible parachute descent before a crate lands. */
const FALL = 26;
/** Drawn height of a crate high above its landing spot (screen-up = altitude, as for aircraft). */
const FALL_LIFT = 230;
const HINT_KEY = "battledrones.hint.uplinks";

interface UplinkView {
  l: Uplink;
  base: Phaser.GameObjects.Image;
  shadow: Phaser.GameObjects.Image;
  head: Phaser.GameObjects.Image;
  headShadow: Phaser.GameObjects.Image;
  glow: Phaser.GameObjects.Image;
  hx: number;
  hy: number;
  spin: number;
  /** Seconds left of the capture flash. */
  flash: number;
  lastAlert: number;
}

interface CrateView {
  c: Crate;
  crate: Phaser.GameObjects.Image;
  chute: Phaser.GameObjects.Image;
  glow: Phaser.GameObjects.Image;
  pillar: Phaser.GameObjects.Image;
  landed: boolean;
}

export class ObjectiveRenderer {
  private ground: Phaser.GameObjects.Graphics;
  private over: Phaser.GameObjects.Graphics;
  private lines: Phaser.GameObjects.Graphics;
  private uplinks: UplinkView[] = [];
  private crates = new Map<number, CrateView>();
  private announced = new Set<number>();
  private time = 0;
  private hinted = false;

  constructor(
    private scene: Phaser.Scene,
    private world: World,
    private fx: Fx,
    private opts: ObjectiveRendererOpts
  ) {
    makeObjectiveTextures(scene);
    this.ground = scene.add.graphics().setDepth(GROUND_DEPTH + 0.01);
    this.over = scene.add.graphics().setDepth(OVER_FOG);
    this.lines = scene.add.graphics().setDepth(OVER_FOG + 0.02);
    for (const l of world.objectives.uplinks) this.uplinks.push(this.makeUplink(l));
  }

  private makeUplink(l: Uplink): UplinkView {
    const s = this.scene;
    const x = l.x * TILE;
    const y = l.y * TILE;
    const shadow = s.add.image(x + 7, y + 9, ATLAS, "obj/uplink").setScale(ART_SCALE).setTint(0x000000).setAlpha(0.32).setDepth(GROUND_DEPTH - 0.004);
    const base = s.add.image(x, y, ATLAS, "obj/uplink").setScale(ART_SCALE).setDepth(GROUND_DEPTH - 0.003);
    const glow = s.add.image(x, y, "fx-glow").setScale(2.2).setAlpha(0).setBlendMode(Phaser.BlendModes.ADD).setDepth(GROUND_DEPTH - 0.002);
    const [mx, my] = mountOffset("uplink");
    const [ox, oy] = frameOrigin("obj/uplink-head");
    const hx = x + mx * TILE;
    const hy = y + my * TILE;
    const headShadow = s.add.image(hx + 6, hy + 8, ATLAS, "obj/uplink-head").setOrigin(ox, oy).setScale(ART_SCALE).setTint(0x000000).setAlpha(0.3).setDepth(GROUND_DEPTH - 0.001);
    const head = s.add.image(hx, hy, ATLAS, "obj/uplink-head").setOrigin(ox, oy).setScale(ART_SCALE).setDepth(GROUND_DEPTH);
    const spin = (l.id * 1.7) % (Math.PI * 2);
    return { l, base, shadow, head, headShadow, glow, hx, hy, spin, flash: 0, lastAlert: -1e9 };
  }

  private friendly(f: Faction): boolean {
    return f === this.opts.player;
  }

  private px(css: number): number {
    return (css * this.opts.dpr) / this.scene.cameras.main.zoom;
  }

  private onScreen(x: number, y: number, pad = 0): boolean {
    const v = this.scene.cameras.main.worldView;
    return x > v.x - pad && x < v.right + pad && y > v.y - pad && y < v.bottom + pad;
  }

  private sound(name: SfxName, x: number, y: number, vol = 1, floor = 0): void {
    sfx.play(name, Math.max(floor, vol * this.opts.earshot(x, y)));
  }

  /** The player's HQ (or the map centre): which of a drop's two crates is "ours". */
  private home(): { x: number; y: number } {
    const hq = hqOf(this.world, this.opts.player);
    return hq ? buildingCenter(hq) : { x: this.world.width / 2, y: this.world.height / 2 };
  }

  // ------------------------------------------------------------- events ---

  onFx(ev: FxEvent): void {
    switch (ev.type) {
      case "uplinkFlip":
        this.flipped(ev);
        break;
      case "uplinkContest": {
        // the enemy started pushing one of ours back: warn (once per push, throttled)
        if (this.opts.spectator || ev.owner !== this.opts.player || ev.faction === this.opts.player) break;
        const v = this.uplinks.find((u) => u.l.id === ev.id);
        if (!v || this.time - v.lastAlert < 20000) break;
        v.lastAlert = this.time;
        this.opts.ping(ev.x, ev.y);
        if (!this.onScreen(ev.x * TILE, ev.y * TILE)) {
          sfx.play("alert", 0.7);
          this.opts.alert("Uplink under attack!", ev.x, ev.y);
        }
        break;
      }
      case "crateIncoming":
        this.incoming(ev);
        break;
      case "crateLanded": {
        const v = this.crates.get(ev.id);
        if (v) this.land(v);
        break;
      }
      case "crateClaimed":
        this.claimed(ev);
        break;
      case "crateExpired": {
        const v = this.crates.get(ev.id);
        if (!v) break;
        this.crates.delete(ev.id);
        this.fx.dust(ev.x * TILE, ev.y * TILE);
        this.scene.tweens.add({
          targets: [v.crate, v.glow], alpha: 0, duration: 700,
          onComplete: () => this.destroyCrate(v)
        });
        v.pillar.destroy();
        v.chute.destroy();
        break;
      }
    }
  }

  private flipped(ev: Extract<FxEvent, { type: "uplinkFlip" }>): void {
    const v = this.uplinks.find((u) => u.l.id === ev.id);
    const x = ev.x * TILE;
    const y = ev.y * TILE;
    if (v) v.flash = 1;
    const col = ev.owner ? TEAM[ev.owner] : NEUTRAL;
    this.fx.pulse(x, y, col, 2.6);
    this.fx.pulse(x, y, 0xffffff, 1.4);
    const me = this.opts.player;
    if (this.opts.spectator) {
      if (ev.owner) {
        this.sound("capture", x, y, 0.8);
        announce({
          key: "uplink-spectate", text: `${ev.owner === "blue" ? "Blue" : "Red"} takes an Uplink`,
          sub: "Scrap, vision and command charge while they hold it", tone: "info", priority: 3, x: ev.x, y: ev.y
        });
      }
      return;
    }
    if (ev.owner === me) {
      this.sound("capture", x, y, 1, 0.55);
      announce({
        key: "uplink-captured", text: "Uplink captured",
        sub: `+${OBJECTIVES.uplink.income} scrap/s · vision · ⚡ charge`, tone: "good", priority: 2, x: ev.x, y: ev.y
      });
    } else if (ev.prev === me) {
      this.sound("uplinkLost", x, y, 1, 0.55);
      this.opts.ping(ev.x, ev.y);
      announce({
        key: "uplink-lost", text: "Uplink lost", sub: "Get units back on it before they take it", tone: "bad", priority: 1, x: ev.x, y: ev.y
      });
    } else if (ev.owner) {
      this.sound("uplinkLost", x, y, 0.6, 0.2);
      this.opts.ping(ev.x, ev.y);
      this.opts.notify("📡 The enemy took an Uplink", "bad");
    }
  }

  private incoming(ev: Extract<FxEvent, { type: "crateIncoming" }>): void {
    const s = this.scene;
    const x = ev.x * TILE;
    const y = ev.y * TILE;
    const crate = s.add.image(x, y, ATLAS, "obj/crate").setScale(ART_SCALE).setDepth(CRATE_DEPTH).setVisible(false);
    const chute = s.add.image(x, y, "obj-chute").setDepth(OVER_FOG + 0.03).setVisible(false);
    const glow = s.add.image(x, y, "fx-glow").setTint(GOLD).setBlendMode(Phaser.BlendModes.ADD).setDepth(CRATE_DEPTH - 0.01).setAlpha(0);
    const pillar = s.add
      .image(x, y - 380, "fx-beam")
      .setDisplaySize(760, 46)
      .setRotation(Math.PI / 2)
      .setTint(GOLD)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setAlpha(0.35)
      .setDepth(OVER_FOG - 0.01);
    const c = this.world.objectives.crates.find((k) => k.id === ev.id);
    if (!c) return;
    this.crates.set(ev.id, { c, crate, chute, glow, pillar, landed: false });
    if (this.announced.has(ev.drop)) return;
    this.announced.add(ev.drop);
    // one banner per drop, pointing at the crate on our side
    const home = this.home();
    const pair = this.world.objectives.crates.filter((k) => k.drop === ev.drop);
    pair.sort((a, b) => Math.hypot(a.x - home.x, a.y - home.y) - Math.hypot(b.x - home.x, b.y - home.y));
    const at = pair[0] ?? c;
    sfx.play("drop", 0.75);
    announce({
      key: "supply-drop",
      text: ev.reward === "unit" ? "Rare supply drop!" : "Supply drop inbound",
      // the first drop spells out the rule; later ones just say what's in it
      sub: ev.drop === 0 ? `${CRATE_NAMES[ev.reward]} · first unit to a crate takes it` : `${CRATE_NAMES[ev.reward]} · lands in ${Math.round(OBJECTIVES.drops.warning)} s`,
      tone: "epic",
      priority: 1,
      x: at.x,
      y: at.y
    });
    this.opts.ping(at.x, at.y);
  }

  private land(v: CrateView): void {
    if (v.landed) return;
    v.landed = true;
    const x = v.c.x * TILE;
    const y = v.c.y * TILE;
    v.crate.setVisible(true).setPosition(x, y).setScale(ART_SCALE).setRotation(0);
    v.pillar.destroy();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      this.fx.dust(x + Math.cos(a) * 30, y + Math.sin(a) * 22);
    }
    this.fx.pulse(x, y, GOLD, 1.3);
    this.sound("pod", x, y, 0.45);
    // the canopy sags and slides off on the breeze
    const chute = v.chute;
    chute.setVisible(true).setPosition(x + 6, y - 26).setScale(0.75).setAlpha(0.95);
    this.scene.tweens.add({
      targets: chute, x: x + 54, y: y - 6, scaleY: 0.22, scaleX: 0.6, alpha: 0, rotation: 0.7,
      duration: 900, ease: "Quad.easeIn", onComplete: () => chute.setVisible(false)
    });
  }

  private claimed(ev: Extract<FxEvent, { type: "crateClaimed" }>): void {
    const v = this.crates.get(ev.id);
    const x = ev.x * TILE;
    const y = ev.y * TILE;
    if (v) {
      this.crates.delete(ev.id);
      v.pillar.destroy();
      v.chute.destroy();
      v.crate.setVisible(true);
      this.scene.tweens.add({
        targets: v.crate, scale: ART_SCALE * 1.6, alpha: 0, duration: 320, ease: "Quad.easeOut",
        onComplete: () => this.destroyCrate(v)
      });
      this.scene.tweens.add({ targets: v.glow, scale: 4, alpha: 0, duration: 420 });
    }
    const mine = this.friendly(ev.faction) && !this.opts.spectator;
    this.fx.pulse(x, y, mine || this.opts.spectator ? GOLD : 0xff8a7a, 1.8);
    this.sound("crate", x, y, mine ? 1 : 0.6, mine ? 0.35 : 0);
    const label = rewardLabel(ev.reward, ev.amount, ev.scrap);
    const color = this.opts.spectator ? TEAM_CSS[ev.faction] : mine ? "#ffd66e" : "#ff9a8a";
    if (this.opts.visibleAt(ev.x, ev.y)) this.floatLabel(x, y, label, color, mine || this.opts.spectator ? 20 : 15);
    for (const id of ev.unitIds) {
      const u = this.world.units.get(id);
      if (u && this.opts.visibleAt(u.x, u.y)) this.fx.pulse(u.x * TILE, u.y * TILE, ev.reward === "repair" ? 0x7ef29b : GOLD, 0.9);
    }
    if (this.opts.spectator) return;
    const what = ev.scrap > 0 && ev.reward !== "scrap" ? `${CRATE_NAMES[ev.reward]} (+${Math.round(ev.scrap)} scrap)` : CRATE_NAMES[ev.reward];
    if (mine) {
      if (!this.onScreen(x, y)) this.opts.notify(`📦 Crate secured: ${what}`, "good");
    } else this.opts.notify(`📦 Enemy grabbed a crate: ${CRATE_NAMES[ev.reward]}`, "bad");
  }

  private destroyCrate(v: CrateView): void {
    v.crate.destroy();
    v.glow.destroy();
    v.chute.destroy();
    v.pillar.destroy();
  }

  /** Reward pop: a bold label that bounces up from the crate and drifts away. */
  private floatLabel(x: number, y: number, label: string, color: string, cssPx: number): void {
    const cam = this.scene.cameras.main;
    const z = cam.zoom / this.opts.dpr;
    const size = Math.round(Phaser.Math.Clamp(cssPx / z, 16, 76));
    const t = this.scene.add
      .text(x, y - 18, label, {
        fontFamily: '"Rajdhani", "Segoe UI", system-ui, sans-serif',
        fontStyle: "bold",
        fontSize: `${size}px`,
        color,
        stroke: "#1b1306",
        strokeThickness: Math.max(3, Math.round(size / 5))
      })
      .setOrigin(0.5, 1)
      .setDepth(8.8)
      .setScale(0.6)
      .setResolution(Math.max(1, Math.min(2, cam.zoom)));
    this.scene.tweens.add({ targets: t, scale: 1, duration: 200, ease: "Back.easeOut" });
    this.scene.tweens.add({
      targets: t, y: y - 18 - size * 1.8, alpha: 0, delay: 1100, duration: 1000, ease: "Quad.easeIn",
      onComplete: () => t.destroy()
    });
  }

  // ---------------------------------------------------------- per frame ---

  sync(dtMs: number, alpha: number): void {
    this.time += dtMs;
    this.ground.clear();
    this.over.clear();
    this.lines.clear();
    const dt = dtMs / 1000;
    for (const v of this.uplinks) this.drawUplink(v, dt);
    const now = this.world.tick - 1 + alpha;
    for (const v of this.crates.values()) this.drawCrate(v, now);
    this.firstHint();
  }

  private drawUplink(v: UplinkView, dt: number): void {
    const l = v.l;
    const x = l.x * TILE;
    const y = l.y * TILE;
    const owner = l.owner;
    const col = owner ? TEAM[owner] : NEUTRAL;
    // the dish: idles on a slow scan, turns for its owner, spins up while being captured
    const rate = l.pushing ? 2.6 : owner ? 0.7 : 0;
    v.spin = rate > 0 ? v.spin + rate * dt : Math.sin(this.time * 0.0004 + l.id) * 0.9;
    v.head.setRotation(v.spin);
    v.headShadow.setRotation(v.spin);
    v.flash = Math.max(0, v.flash - dt * 1.2);
    const breathe = 0.5 + 0.5 * Math.sin(this.time * 0.003 + l.id);
    v.glow.setTint(col).setAlpha(owner ? 0.28 + 0.14 * breathe + 0.5 * v.flash : 0.08 + 0.4 * v.flash);
    v.glow.setScale(2.2 + v.flash * 1.5);

    const seen = this.opts.visibleAt(l.x, l.y);
    const g = seen ? this.ground : this.over;
    const k = seen ? 1 : 0.7;
    const R = OBJECTIVES.uplink.radius * TILE;
    // the capture zone: a dashed ring in the owner's colour, turning while contested
    const dashes = 28;
    const turn = l.pushing || l.contested ? this.time * 0.0009 : 0;
    g.lineStyle(this.px(owner ? 2.2 : 1.6), col, (owner ? 0.75 : 0.55) * k);
    for (let i = 0; i < dashes; i += 2) {
      const a0 = (i / dashes) * Math.PI * 2 + turn;
      g.beginPath();
      g.arc(x, y, R, a0, a0 + (Math.PI * 2) / dashes);
      g.strokePath();
    }
    if (owner && seen) g.fillStyle(col, 0.05 + 0.03 * breathe).fillCircle(x, y, R);
    // the capture bar: a ring around the platform, filled toward whoever is winning it
    const ar = 1.38 * TILE;
    const p = l.progress / 100;
    g.lineStyle(this.px(7), 0x0b0f16, 0.6 * k).strokeCircle(x, y, ar);
    if (Math.abs(p) > 0.001) {
      const pc = p > 0 ? TEAM.blue : TEAM.red;
      const a0 = -Math.PI / 2;
      const a1 = a0 + Math.PI * 2 * Math.abs(p);
      g.lineStyle(this.px(4.5), pc, 0.95 * k);
      g.beginPath();
      g.arc(x, y, ar, a0, a1);
      g.strokePath();
      if (l.pushing) {
        // a bright tip on the moving edge
        const tip = 4 + 2 * Math.sin(this.time * 0.02);
        g.fillStyle(0xffffff, 0.9 * k).fillCircle(x + Math.cos(a1) * ar, y + Math.sin(a1) * ar, this.px(tip));
      }
    }
    if (l.contested) {
      const pulse = 0.5 + 0.5 * Math.sin(this.time * 0.012);
      g.lineStyle(this.px(3), 0xffa040, (0.4 + 0.5 * pulse) * k).strokeCircle(x, y, ar + this.px(7));
    }
    if (v.flash > 0) g.lineStyle(this.px(5), 0xffffff, v.flash * 0.8).strokeCircle(x, y, R * (1.15 - 0.15 * v.flash));
  }

  private drawCrate(v: CrateView, now: number): void {
    const c = v.c;
    const x = c.x * TILE;
    const y = c.y * TILE;
    const g = this.over;
    const left = c.landTick - now;
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 0.008);
    if (!v.landed && left <= 0) this.land(v);
    if (!v.landed) {
      // announced: a gold landing marker and a light pillar, both through the fog
      const k = Phaser.Math.Clamp(1 - left / (c.landTick - c.announcedTick), 0, 1);
      const r = (0.95 - 0.25 * k) * TILE;
      g.lineStyle(this.px(2.5), GOLD, 0.65 + 0.3 * pulse).strokeCircle(x, y, r);
      g.lineStyle(this.px(1.5), GOLD, 0.5).strokeCircle(x, y, r * (1.55 - 0.3 * pulse));
      for (let i = 0; i < 4; i++) {
        const a = (i * Math.PI) / 2 + Math.PI / 4;
        g.lineStyle(this.px(3), GOLD, 0.9).lineBetween(
          x + Math.cos(a) * (r + this.px(5)), y + Math.sin(a) * (r + this.px(5)),
          x + Math.cos(a) * (r + this.px(13)), y + Math.sin(a) * (r + this.px(13))
        );
      }
      g.fillStyle(GOLD, 0.08 + 0.08 * pulse).fillCircle(x, y, r);
      v.pillar.setAlpha(0.22 + 0.2 * pulse);
      // the last couple of seconds: it comes down under a striped canopy
      if (left <= FALL) {
        const e = Phaser.Math.Clamp(1 - left / FALL, 0, 1);
        const h = (1 - e) * (1 - e * 0.35);
        const sc = 1 + 1.3 * h;
        const sway = Math.sin(this.time * 0.004 + c.id) * 0.14 * h;
        const cy = y - FALL_LIFT * h;
        // ground shadow tightens as it nears
        this.ground.fillStyle(0x000000, 0.12 + 0.3 * e).fillEllipse(x + 6, y + 6, 34 + 50 * h, 22 + 32 * h);
        v.crate.setVisible(true).setDepth(OVER_FOG + 0.01).setPosition(x, cy).setScale(ART_SCALE * sc).setRotation(sway * 0.5);
        const chuteY = cy - (52 + 26 * h) * sc * 0.6;
        v.chute.setVisible(true).setPosition(x + sway * 30, chuteY).setScale(0.7 * sc).setRotation(sway);
        // suspension lines from the canopy rim to the crate
        const rim = 46 * 0.7 * sc;
        this.lines.lineStyle(this.px(1), 0xe8e2cc, 0.8);
        for (const dx of [-1, -0.4, 0.4, 1])
          this.lines.lineBetween(x + sway * 30 + dx * rim, chuteY + 10 * sc, x + dx * 14 * sc, cy - 10 * sc);
      }
      return;
    }
    v.crate.setDepth(CRATE_DEPTH);
    // landed: a warm glow, a blinking beacon and a burn-out ring
    const ttl = Phaser.Math.Clamp((c.expireTick - now) / (c.expireTick - c.landTick), 0, 1);
    const hurry = ttl < 10 / OBJECTIVES.drops.ttl;
    const blink = hurry ? 0.5 + 0.5 * Math.sin(this.time * 0.02) : pulse;
    v.glow.setPosition(x, y).setAlpha(0.32 + 0.25 * blink).setScale(1.5 + 0.25 * blink);
    const seen = this.opts.visibleAt(c.x, c.y);
    const rg = seen ? this.ground : g;
    const rr = 0.78 * TILE;
    rg.lineStyle(this.px(4), 0x0b0f16, 0.55).strokeCircle(x, y, rr);
    rg.lineStyle(this.px(3), hurry ? 0xff7a4a : GOLD, 0.95);
    rg.beginPath();
    rg.arc(x, y, rr, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ttl);
    rg.strokePath();
    if (!seen) {
      // out of sight: a gold diamond marks it through the fog
      const d = this.px(8 + 2 * blink);
      g.fillStyle(GOLD, 0.85).fillPoints([
        new Phaser.Math.Vector2(x, y - d), new Phaser.Math.Vector2(x + d, y),
        new Phaser.Math.Vector2(x, y + d), new Phaser.Math.Vector2(x - d, y)
      ], true);
      g.lineStyle(this.px(1.5), 0x1b1306, 0.9).strokePoints([
        new Phaser.Math.Vector2(x, y - d), new Phaser.Math.Vector2(x + d, y),
        new Phaser.Math.Vector2(x, y + d), new Phaser.Math.Vector2(x - d, y)
      ], true);
    }
  }

  /** One-time tip the first time a match has Uplinks. */
  private firstHint(): void {
    // at 0:45: after the opening's own tips, before the first relay usually falls and the first drop
    if (this.hinted || this.opts.spectator || this.uplinks.length === 0 || this.world.tick < 45 * TICK_RATE) return;
    this.hinted = true;
    try {
      if (localStorage.getItem(HINT_KEY)) return;
      localStorage.setItem(HINT_KEY, "1");
    } catch {
      return;
    }
    const home = this.home();
    const near = [...this.uplinks].sort(
      (a, b) => Math.hypot(a.l.x - home.x, a.l.y - home.y) - Math.hypot(b.l.x - home.x, b.l.y - home.y)
    )[0]!;
    this.opts.hint("Park units on a 📡 Uplink to take it: scrap, vision, ⚡ charge. Tap to look.", near.l.x, near.l.y);
  }

  // ------------------------------------------------------------ minimap ---

  /** Uplink diamonds and blinking crate marks, drawn on the HUD minimap (k = px per tile). */
  minimap(ctx: CanvasRenderingContext2D, k: number): void {
    const t = this.time;
    for (const l of this.world.objectives.uplinks) {
      const x = l.x * k;
      const y = l.y * k;
      const d = 7;
      ctx.beginPath();
      ctx.moveTo(x, y - d);
      ctx.lineTo(x + d, y);
      ctx.lineTo(x, y + d);
      ctx.lineTo(x - d, y);
      ctx.closePath();
      ctx.fillStyle = l.owner === "blue" ? "#4fa3ff" : l.owner === "red" ? "#ff5a4a" : "#6b6450";
      ctx.fill();
      const busy = l.pushing || l.contested;
      ctx.lineWidth = busy ? 2.5 : 1.6;
      ctx.strokeStyle = busy && Math.sin(t * 0.012) > 0 ? "#ffa040" : "#f4ecd8";
      ctx.stroke();
    }
    const blink = Math.sin(t * 0.01) > -0.2;
    for (const c of this.world.objectives.crates) {
      const x = c.x * k;
      const y = c.y * k;
      if (this.world.tick < c.landTick) {
        ctx.strokeStyle = blink ? "#ffd66e" : "rgba(255,214,110,0.4)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.stroke();
      } else if (blink) {
        ctx.fillStyle = "#ffd66e";
        ctx.strokeStyle = "#1b1306";
        ctx.lineWidth = 1.5;
        ctx.fillRect(x - 4, y - 4, 8, 8);
        ctx.strokeRect(x - 4, y - 4, 8, 8);
      }
    }
  }

  destroy(): void {
    for (const v of this.crates.values()) this.destroyCrate(v);
    this.crates.clear();
  }
}

/** The pop text for a claimed crate. */
export function rewardLabel(reward: CrateReward, amount: number, scrap: number): string {
  const extra = scrap > 0 && reward !== "scrap" ? `  +${Math.round(scrap)}` : "";
  switch (reward) {
    case "scrap":
      return `+${Math.round(scrap)}`;
    case "veterans":
      return amount > 0 ? `VETERANS ×${amount}` : `+${Math.round(scrap)}`;
    case "repair":
      return amount > 0 ? "REPAIRED" : `+${Math.round(scrap)}`;
    case "charge":
      return amount > 0 ? `+${amount} ⚡${extra}` : `+${Math.round(scrap)}`;
    case "unit":
      return "FREE LANCER!";
  }
}

/** A top-down parachute canopy: eight gores in hazard gold and cream around a vent. */
function makeObjectiveTextures(scene: Phaser.Scene): void {
  if (scene.textures.exists("obj-chute")) return;
  const S = 132;
  const tex = scene.textures.createCanvas("obj-chute", S, S)!;
  const ctx = tex.getContext();
  const c = S / 2;
  const R = 60;
  for (let i = 0; i < 8; i++) {
    const a0 = (i / 8) * Math.PI * 2 - Math.PI / 2;
    const a1 = ((i + 1) / 8) * Math.PI * 2 - Math.PI / 2;
    const g = ctx.createRadialGradient(c - 10, c - 12, 4, c, c, R);
    if (i % 2) {
      g.addColorStop(0, "#fff3c4");
      g.addColorStop(0.7, "#f2b632");
      g.addColorStop(1, "#a8701a");
    } else {
      g.addColorStop(0, "#ffffff");
      g.addColorStop(0.7, "#ece4cf");
      g.addColorStop(1, "#9c937e");
    }
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(c, c);
    // scalloped rim: each gore bulges a little past the chord
    ctx.arc(c, c, R, a0, a1);
    ctx.closePath();
    ctx.fill();
  }
  ctx.strokeStyle = "rgba(60,44,20,0.55)";
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
    ctx.beginPath();
    ctx.moveTo(c, c);
    ctx.lineTo(c + Math.cos(a) * R, c + Math.sin(a) * R);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(c, c, R - 1, 0, Math.PI * 2);
  ctx.stroke();
  // the vent at the apex
  ctx.fillStyle = "#3a2f1e";
  ctx.beginPath();
  ctx.arc(c, c, 7, 0, Math.PI * 2);
  ctx.fill();
  tex.refresh();
}
