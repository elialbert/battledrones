/**
 * Battle awareness and tempo, wired into the scene: game speed (chip, hold
 * the clock, '.' key), "enemy inbound" warnings, off-screen hotspot arrows
 * with a camera glide, the ⚡ jump button and the battle meter. The rules are
 * in ./awareness (engine-free, tested); the widgets in ../ui/awareness.
 */
import type Phaser from "phaser";
import type { Faction, FxEvent, World } from "../sim/types";
import { TILE } from "./assets";
import { sfx } from "./audio";
import { announce } from "./announce";
import type { Announcer } from "./announcer";
import {
  AWARE,
  BattleMeter,
  GameSpeed,
  HeatMap,
  InboundWatch,
  SPEED_KEY,
  edgePoint,
  mergeHotspots,
  placeOnEdge,
  tallyView,
  type Hotspot,
  type InboundWarning,
  type Rect
} from "./awareness";
import type { Hud } from "../ui/hud";
import { MARKER, mountAwareness, type ArrowSpec, type AwarenessUi } from "../ui/awareness";

export interface AwarenessHooks {
  scene: Phaser.Scene;
  world: World;
  player: Faction;
  spectator: boolean;
  dpr: number;
  hud: Hud;
  radio: Announcer;
  /** Can the local player see this tile point (fog, or fog switched off)? */
  sees(x: number, y: number): boolean;
  /** A marker flash where the camera lands (tiles). */
  pulse?(x: number, y: number, color: number): void;
}

/** Camera glide time for arrow / jump taps, ms. */
const GLIDE_MS = 350;
/** Hotspots are recomputed this often (ms of real time). */
const SPOT_MS = 100;

const inside = (r: Rect, x: number, y: number) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;

export class Awareness {
  readonly speed: GameSpeed;
  readonly heat: HeatMap;
  readonly inbound: InboundWatch;
  private meter = new BattleMeter();
  private ui: AwarenessUi;
  private spots: Hotspot[] = [];
  private spotClock = SPOT_MS;
  private meterClock = SPOT_MS;
  private tally: ReturnType<typeof tallyView> | null = null;
  private lastShotInView = -Infinity;
  private simT = 0;
  private glide: { x0: number; y0: number; x1: number; y1: number; t: number } | null = null;
  private jumpIdx = -1;
  private lastJumpAt = -Infinity;
  private lastView = { x: 0, y: 0 };
  private viewJumped = false;
  private offPointer: () => void;

  constructor(private h: AwarenessHooks) {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(SPEED_KEY);
    } catch {
      /* storage blocked: 1× */
    }
    this.speed = new GameSpeed(h.spectator, raw);
    this.heat = new HeatMap({ world: h.world, player: h.player, spectator: h.spectator });
    this.inbound = new InboundWatch({ world: h.world, player: h.player });
    this.ui = mountAwareness(document.getElementById("hud")!, {
      spectator: h.spectator,
      onCycleSpeed: () => this.cycleSpeed(),
      onHold: (held) => {
        this.speed.held = held;
        this.syncSpeed();
      },
      onArrow: (key) => {
        const s = this.spots.find((p) => p.key === key);
        if (s) this.goTo(s);
      },
      onJump: () => this.jump()
    });
    // touching the battlefield cancels a glide (the player takes the camera)
    const stop = () => (this.glide = null);
    h.scene.input.on("pointerdown", stop);
    this.offPointer = () => h.scene.input.off("pointerdown", stop);
    this.syncSpeed();
  }

  /** The sim speed multiplier right now. */
  get value(): number {
    return this.speed.value;
  }

  cycleSpeed(): void {
    this.speed.cycle();
    try {
      localStorage.setItem(SPEED_KEY, this.speed.serialize());
    } catch {
      /* ignore */
    }
    sfx.play("click", 0.5);
    this.syncSpeed();
  }

  private syncSpeed(): void {
    this.ui.setSpeed(this.speed.value, this.speed.base, this.speed.held);
    // battle sounds space out at speed so 2× isn't twice the din
    sfx.setTempo(this.speed.value);
  }

  // ------------------------------------------------------------ sim side --

  /** This tick's events at sim time `t` (call before the radio sees them). */
  events(fx: readonly FxEvent[], t: number): void {
    this.simT = t;
    this.heat.events(fx, t);
    const play = this.ui.layout().play;
    for (const ev of fx)
      if (ev.type === "shot") {
        if (t - this.lastShotInView < 0.2) break;
        const a = this.toScreen(ev.x, ev.y);
        const b = this.toScreen(ev.tx, ev.ty);
        if ((inside(play, a.x, a.y) && this.h.sees(ev.x, ev.y)) || (inside(play, b.x, b.y) && this.h.sees(ev.tx, ev.ty)))
          this.lastShotInView = t;
      }
    if (this.h.spectator) return;
    for (const wn of this.inbound.events(fx, t)) this.warn(wn);
  }

  /** Present an inbound warning: banner (first of its kind) or ticker + radio, alarm, minimap pulse. */
  private warn(wn: InboundWarning): void {
    if (!wn.loud) return; // inside the global gap: the arrow alone
    const h = this.h;
    h.radio.callouts.inbound(wn.domain, wn.t);
    if (wn.first)
      announce({
        key: `inbound-${wn.domain}`, text: wn.short, sub: `Counter: ${wn.advice}`, tone: "bad", priority: 1,
        x: wn.x, y: wn.y, say: wn.text
      });
    else {
      h.hud.alert(`${wn.text} — ${wn.advice}`, wn.x, wn.y);
      h.radio.push({ key: "inbound", text: wn.text, priority: 1, tone: "bad", x: wn.x, y: wn.y, caption: false });
    }
    sfx.play("inbound", 0.85);
    h.hud.ping(wn.x, wn.y, "inbound");
  }

  // --------------------------------------------------------- render side --

  /** World tiles → CSS px on screen (current camera, no one-frame lag). */
  private toScreen(x: number, y: number): { x: number; y: number } {
    const cam = this.h.scene.cameras.main;
    const z = cam.zoom;
    const vx = cam.scrollX + cam.width / 2 - cam.width / (2 * z);
    const vy = cam.scrollY + cam.height / 2 - cam.height / (2 * z);
    return { x: ((x * TILE - vx) * z) / this.h.dpr, y: ((y * TILE - vy) * z) / this.h.dpr };
  }

  /** Camera scroll that puts world tile (x, y) at CSS point (sx, sy). */
  private scrollFor(x: number, y: number, sx: number, sy: number): { x: number; y: number } {
    const cam = this.h.scene.cameras.main;
    const z = cam.zoom;
    return {
      x: x * TILE - cam.width / 2 + cam.width / (2 * z) - (sx * this.h.dpr) / z,
      y: y * TILE - cam.height / 2 + cam.height / (2 * z) - (sy * this.h.dpr) / z
    };
  }

  /** Glide the camera so (x, y) sits in the middle of the visible battlefield. */
  glideTo(x: number, y: number): void {
    const p = this.ui.layout().play;
    const to = this.scrollFor(x, y, (p.x0 + p.x1) / 2, (p.y0 + p.y1) / 2);
    const cam = this.h.scene.cameras.main;
    this.glide = { x0: cam.scrollX, y0: cam.scrollY, x1: to.x, y1: to.y, t: 0 };
  }

  private goTo(s: Hotspot): void {
    this.glideTo(s.x, s.y);
    sfx.play("click", 0.5);
    const col = s.kind === "attack" || s.kind === "fight" ? 0xffc04a : 0xff5a4a;
    this.h.pulse?.(s.x, s.y, col);
  }

  /** ⚡: cycle through the hotspots, most urgent first. */
  jump(): void {
    const list = this.spots;
    if (list.length === 0) {
      this.ui.jumpNothing();
      return;
    }
    const now = performance.now();
    this.jumpIdx = now - this.lastJumpAt < 4000 ? (this.jumpIdx + 1) % list.length : 0;
    this.lastJumpAt = now;
    // skip one we're already looking at
    const p = this.ui.layout().play;
    const c = { x: (p.x0 + p.x1) / 2, y: (p.y0 + p.y1) / 2 };
    for (let i = 0; i < list.length; i++) {
      const s = list[(this.jumpIdx + i) % list.length]!;
      const q = this.toScreen(s.x, s.y);
      if (list.length === 1 || Math.hypot(q.x - c.x, q.y - c.y) > 60) {
        this.jumpIdx = (this.jumpIdx + i) % list.length;
        this.goTo(s);
        return;
      }
    }
    this.goTo(list[this.jumpIdx]!);
  }

  /** Every frame, after the HUD update. */
  update(deltaMs: number, paused: boolean): void {
    const cam = this.h.scene.cameras.main;
    if (this.glide) {
      const g = this.glide;
      g.t = Math.min(GLIDE_MS, g.t + deltaMs);
      const k = 1 - Math.pow(1 - g.t / GLIDE_MS, 3);
      cam.scrollX = g.x0 + (g.x1 - g.x0) * k;
      cam.scrollY = g.y0 + (g.y1 - g.y0) * k;
      if (g.t >= GLIDE_MS) this.glide = null;
    }
    const L = this.ui.layout();
    this.spotClock += deltaMs;
    if (this.spotClock >= SPOT_MS) {
      this.spotClock = 0;
      this.spots = mergeHotspots(this.heat.hotspots(), this.h.spectator ? [] : this.inbound.hotspots(this.simT));
      this.ui.setJump(this.spots.length, this.spots.some((s) => s.kind === "defend" || s.kind === "inbound"));
    }
    this.ui.setArrows(this.arrows(L));

    // battle meter: tally the view every 100 ms, ease every frame
    this.meterClock += deltaMs;
    if (this.meterClock >= SPOT_MS || !this.tally) {
      this.meterClock = 0;
      const vc = this.toWorld((L.play.x0 + L.play.x1) / 2, (L.play.y0 + L.play.y1) / 2);
      this.viewJumped = this.viewJumped || Math.hypot(vc.x - this.lastView.x, vc.y - this.lastView.y) > 3;
      this.lastView = vc;
      const inView = (x: number, y: number) => {
        const s = this.toScreen(x, y);
        return inside(L.play, s.x, s.y) && s.y > L.markers.y0 - MARKER.size / 2;
      };
      this.tally = tallyView(this.h.world, this.h.spectator ? "blue" : this.h.player, inView, (x, y) => this.h.sees(x, y));
    }
    if (!paused) {
      const m = this.meter.update(this.tally, this.lastShotInView, this.simT, deltaMs, this.viewJumped);
      this.viewJumped = false;
      this.ui.setMeter(m.shown, m.share);
      if (m.turning) this.ui.turning(m.turning);
    }
  }

  private toWorld(sx: number, sy: number): { x: number; y: number } {
    const cam = this.h.scene.cameras.main;
    const z = cam.zoom;
    const vx = cam.scrollX + cam.width / 2 - cam.width / (2 * z);
    const vy = cam.scrollY + cam.height / 2 - cam.height / (2 * z);
    return { x: (vx + (sx * this.h.dpr) / z) / TILE, y: (vy + (sy * this.h.dpr) / z) / TILE };
  }

  /** Edge arrows for the off-screen hotspots: capped, merged by direction, clear of the HUD. */
  private arrows(L: ReturnType<AwarenessUi["layout"]>): ArrowSpec[] {
    const out: ArrowSpec[] = [];
    const dirs: number[] = [];
    const avoid = [...L.avoid];
    // a hotspot counts as on screen inside the battlefield, clear of the top HUD band
    const vis: Rect = { x0: L.play.x0, y0: L.markers.y0 - MARKER.size / 2, x1: L.play.x1, y1: L.play.y1 };
    const c = { x: (L.markers.x0 + L.markers.x1) / 2, y: (L.markers.y0 + L.markers.y1) / 2 };
    for (const s of this.spots) {
      if (out.length >= AWARE.maxArrows) break;
      const q = this.toScreen(s.x, s.y);
      if (inside(vis, q.x, q.y)) continue;
      const dir = Math.atan2(q.y - c.y, q.x - c.x);
      // merge: one arrow per direction
      if (dirs.some((d) => Math.abs(Math.atan2(Math.sin(d - dir), Math.cos(d - dir))) < 0.32)) continue;
      const e = edgePoint(L.markers, q.x, q.y);
      const p = placeOnEdge(L.markers, e, MARKER.size + 4, avoid, 200);
      if (!p) continue;
      dirs.push(dir);
      avoid.push({ x0: p.x - MARKER.size / 2 - 4, y0: p.y - MARKER.size / 2 - 4, x1: p.x + MARKER.size / 2 + 4, y1: p.y + MARKER.size / 2 + 4 });
      out.push({
        key: s.key, kind: s.kind, label: s.label, x: p.x, y: p.y,
        angle: Math.atan2(q.y - p.y, q.x - p.x),
        scale: 1 + Math.min(0.25, s.heat / 24)
      });
    }
    return out;
  }

  /** Hotspots right now (debug/tests). */
  get hotspots(): readonly Hotspot[] {
    return this.spots;
  }

  destroy(): void {
    this.offPointer();
    sfx.setTempo(1);
    this.ui.destroy();
  }
}
