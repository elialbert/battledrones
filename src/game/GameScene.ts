import Phaser from "phaser";
import { createAiState, tickAi, type AiState } from "../sim/ai/commander";
import { BUILDINGS, ECONOMY, TICK_RATE, UNITS } from "../sim/balance";
import { canPlaceBuilding, nearestReachableResource } from "../sim/economy";
import { isVisible } from "../sim/fog";
import { createMapWorld, mapById } from "../sim/maps";
import { step } from "../sim/sim";
import type { Building, FxEvent, World } from "../sim/types";
import { buildingCenter, hqOf } from "../sim/world";
import { sfx } from "./audio";
import {
  ART_SCALE,
  ATLAS,
  TILE,
  buildingFrame,
  loadAssets,
  setSpriteMeta,
  type SpriteMeta
} from "./assets";
import { Controller, PLAYER, hitTest } from "./controller";
import { GestureRecognizer } from "./gestures";
import { announce } from "./announce";
import { gameMode, matchOptions } from "./mode";
import { SurvivalPresenter, finishRun } from "./survival";
import { EntityRenderer } from "./render/entities";
import { AIR_LIFT, Fx } from "./render/fx";
import { WorldView } from "./render/world-view";
import { createFxTextures } from "./textures";
import { createHud, type Hud } from "../ui/hud";

const TICK_MS = 1000 / TICK_RATE;
/** Logical (CSS-pixel) zoom range; the camera zoom also includes the DPR. */
const MIN_ZOOM = 0.28;
const MAX_ZOOM = 1.6;
const DEFAULT_ZOOM = 0.6;
/** Camera may scroll this far past the map edge so HUD never hides units. */
const EDGE_PAD = 4 * TILE;

export class GameScene extends Phaser.Scene {
  world!: World;
  ctrl!: Controller;
  private ai!: AiState;
  private blueAi: AiState | null = null;
  /** Last Stand banners and spawn marker (null in skirmish). */
  private survival: SurvivalPresenter | null = null;
  private acc = 0;
  private prev = new Map<number, { x: number; y: number }>();
  private dpr = 1;
  private overlay!: Phaser.GameObjects.Graphics;
  private ghost!: Phaser.GameObjects.Image;
  private worldView!: WorldView;
  private entities!: EntityRenderer;
  private fx!: Fx;
  private gest!: GestureRecognizer;
  private boxRect: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private hud!: Hud;
  private ended = false;
  private simSeconds = 0;
  private lastAlert = -1e9;
  /** Smooth-zoom target and its screen anchor point (game px). */
  private targetZoom = 1;
  private zoomAnchor: { x: number; y: number } | null = null;
  /** Pan momentum: CSS-px/frame velocity that decays after release. */
  private glide: { x: number; y: number } | null = null;
  private lastPan = { x: 0, y: 0 };
  private cursors?: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd?: Record<"W" | "A" | "S" | "D", Phaser.Input.Keyboard.Key>;

  constructor() {
    super("game");
  }

  preload(): void {
    const def = mapById(gameMode.mapId);
    loadAssets(this.load, def.id, def.size);
    const bar = document.getElementById("loadbar");
    this.load.on("progress", (p: number) => {
      if (bar) bar.style.width = `${Math.round(p * 100)}%`;
    });
    // a missing terrain chunk must not stall the boot — fall back gracefully
    this.load.on("loaderror", (file: Phaser.Loader.File) => console.warn("asset failed:", file.key));
  }

  create(): void {
    document.getElementById("loading")?.remove();
    this.dpr = (this.game.registry.get("dpr") as number) ?? 1;
    setSpriteMeta(this.cache.json.get("sprite-meta") as SpriteMeta | undefined);
    createFxTextures(this);
    this.anims.create({
      key: "boom",
      frames: this.anims.generateFrameNames(ATLAS, { prefix: "explosion/", start: 0, end: 7 }),
      frameRate: 22,
      hideOnComplete: true
    });

    this.world = createMapWorld(gameMode.mapId, matchOptions());
    this.ctrl = new Controller(this.world);
    if (this.world.survival)
      this.survival = new SurvivalPresenter(this.world, {
        mapId: gameMode.mapId,
        difficulty: this.world.survival.difficulty,
        spectator: gameMode.spectator,
        ping: (x, y) => this.hud?.ping(x, y),
        gfx: this.add.graphics().setDepth(10.5)
      });
    // spectating pits two Normal commanders against each other
    this.ai = createAiState(undefined, gameMode.spectator ? "normal" : gameMode.difficulty, (Math.random() * 1e9) | 0);
    if (gameMode.spectator) {
      this.blueAi = createAiState(undefined, "normal", (Math.random() * 1e9) | 0);
      this.ctrl.spectator = true;
      this.ctrl.showFog = false; // watch the whole battle by default
    }

    const cam = this.cameras.main;
    cam.roundPixels = false;
    cam.setBackgroundColor("#070a10");
    cam.setBounds(
      -EDGE_PAD, -EDGE_PAD,
      this.world.width * TILE + EDGE_PAD * 2, this.world.height * TILE + EDGE_PAD * 2
    );

    this.worldView = new WorldView(this, this.world, PLAYER);
    this.worldView.createClouds();
    this.fx = new Fx(this, this.world.biome, (x, y) => this.earshot(x, y));
    this.entities = new EntityRenderer(
      this,
      this.world,
      this.fx,
      (x, y) => this.tileVisible(x, y),
      (b) => this.buildingShown(b),
      (f) => f === PLAYER || !this.ctrl.showFog
    );
    this.overlay = this.add.graphics().setDepth(8);
    this.ghost = this.add.image(0, 0, ATLAS, buildingFrame(PLAYER, "turret")).setDepth(9).setAlpha(0.55).setVisible(false);

    const focus = gameMode.spectator ? null : hqOf(this.world, PLAYER);
    const c = focus ? buildingCenter(focus) : { x: this.world.width / 2, y: this.world.height / 2 };
    cam.setZoom(DEFAULT_ZOOM * this.dpr);
    this.clampZoom();
    cam.centerOn(c.x * TILE, c.y * TILE);
    this.targetZoom = cam.zoom;
    this.scale.on("resize", () => this.clampZoom());

    this.setupInput();
    // the starting harvester gets to work immediately
    for (const u of this.world.units.values())
      if (u.faction === PLAYER && u.kind === "harvester" && !gameMode.spectator) {
        const f = nearestReachableResource(this.world, u.x, u.y);
        if (f) this.ctrl.enqueue({ type: "harvest", faction: PLAYER, unitIds: [u.id], x: f.x + 0.5, y: f.y + 0.5 });
      }
    this.hud = createHud({
      world: this.world,
      ctrl: this.ctrl,
      camera: cam,
      dpr: this.dpr,
      centerCamera: (wx, wy) => cam.centerOn(wx * TILE, wy * TILE),
      zoomBy: (f) => this.zoomBy(f),
      matchSeconds: () => this.simSeconds,
      strategies: this.blueAi
        ? { blue: this.blueAi.strategy.label, red: this.survival ? "the waves" : this.ai.strategy.label }
        : null,
      enemy: { strategy: this.survival ? "Last Stand" : this.ai.strategy.label, difficulty: gameMode.difficulty }
    });

    this.events.on(Phaser.Scenes.Events.SHUTDOWN, () => this.hud.destroy());

    // debug/testing handle (harmless in production)
    (window as unknown as Record<string, unknown>).__bd = {
      world: this.world,
      ctrl: this.ctrl,
      cam,
      scene: this,
      announce,
      canPlace: (tx: number, ty: number) =>
        canPlaceBuilding(this.world, PLAYER, this.ctrl.placing ?? "fab-plant", tx, ty)
    };
  }

  /** Nudge the smooth-zoom target (zoom buttons, +/- keys, wheel). */
  zoomBy(factor: number, anchorX?: number, anchorY?: number): void {
    this.targetZoom = this.clampedZoom(this.targetZoom * factor);
    this.zoomAnchor =
      anchorX !== undefined && anchorY !== undefined ? { x: anchorX, y: anchorY } : null;
  }

  /** Volume for a sound at world px (x, y): full on screen, fading off it. */
  private earshot(x: number, y: number): number {
    const v = this.cameras.main.worldView;
    const dx = Math.max(v.x - x, 0, x - (v.x + v.width));
    const dy = Math.max(v.y - y, 0, y - (v.y + v.height));
    const d = Math.hypot(dx, dy) / TILE;
    const zoomOut = Phaser.Math.Clamp(this.cameras.main.zoom / this.dpr / DEFAULT_ZOOM, 0.5, 1.2);
    return Math.max(0, 1 - d / 8) * zoomOut;
  }

  private updateCamera(delta: number): void {
    const cam = this.cameras.main;
    if (Math.abs(cam.zoom - this.targetZoom) > 0.001) {
      const t = 1 - Math.pow(0.0025, delta / 1000);
      const next = cam.zoom + (this.targetZoom - cam.zoom) * t;
      const a = this.zoomAnchor ?? { x: cam.width / 2, y: cam.height / 2 };
      this.zoomAround(next, a.x, a.y);
    }
    // keyboard panning (arrows / WASD), speed in CSS px/s
    const panSpeed = (700 * this.dpr * delta) / 1000 / cam.zoom;
    let kx = 0;
    let ky = 0;
    if (this.cursors?.left.isDown || this.wasd?.A.isDown) kx -= 1;
    if (this.cursors?.right.isDown || this.wasd?.D.isDown) kx += 1;
    if (this.cursors?.up.isDown || this.wasd?.W.isDown) ky -= 1;
    if (this.cursors?.down.isDown || this.wasd?.S.isDown) ky += 1;
    if (kx !== 0 || ky !== 0) {
      cam.scrollX += kx * panSpeed;
      cam.scrollY += ky * panSpeed;
      this.glide = null;
    }
    if (this.glide) {
      cam.scrollX -= (this.glide.x * this.dpr) / cam.zoom;
      cam.scrollY -= (this.glide.y * this.dpr) / cam.zoom;
      const friction = Math.pow(0.9, delta / (1000 / 60));
      this.glide.x *= friction;
      this.glide.y *= friction;
      if (Math.hypot(this.glide.x, this.glide.y) < 0.4) this.glide = null;
    }
  }

  override update(_time: number, smoothed: number): void {
    // Phaser clamps its smoothed delta to 60 fps whenever the window lacks
    // focus; the sim must run in real time regardless, so use the raw one
    const raw = this.game.loop.rawDelta;
    const delta = Math.min(250, raw > 0 && raw < 1000 ? raw : smoothed);
    this.gest.tick(performance.now());
    this.updateCamera(delta);

    if (!this.ctrl.paused && !this.ended) {
      this.acc += Math.min(delta, 250);
      while (this.acc >= TICK_MS) {
        this.acc -= TICK_MS;
        this.snapshotPrev();
        const cmds = this.blueAi
          ? [...tickAi(this.world, "blue", this.blueAi), ...tickAi(this.world, "red", this.ai)]
          : [...this.ctrl.drainCommands(), ...tickAi(this.world, "red", this.ai)];
        step(this.world, cmds);
        this.simSeconds += 1 / TICK_RATE;
        this.afterTick();
      }
    }
    this.ctrl.prune();
    const alpha = this.ctrl.paused ? 1 : this.acc / TICK_MS;
    this.worldView.update(delta, this.ctrl.showFog);
    this.entities.sync(alpha, this.prev, this.ctrl.paused ? 0 : delta);
    this.fx.projectiles(this.world.projectiles, alpha, this.prev);
    this.fx.update(this.ctrl.paused ? 0 : delta);
    this.drawOverlay(alpha);
    this.hud.update();

    if (this.world.winner && !this.ended) {
      this.ended = true;
      const won = this.world.winner === PLAYER;
      // Last Stand always ends in defeat; a new record still gets the fanfare
      const run = this.survival && !gameMode.spectator ? finishRun(this.world, this.world.mapId, this.survival.difficulty) : null;
      if (!gameMode.spectator) sfx.play(won || run?.isNew ? "victory" : "defeat");
      this.time.delayedCall(1400, () => this.hud.showEnd(this.world.winner!));
    }
  }

  // ------------------------------------------------------------- sim glue --

  private snapshotPrev(): void {
    this.prev.clear();
    for (const u of this.world.units.values()) this.prev.set(u.id, { x: u.x, y: u.y });
    for (const p of this.world.projectiles) this.prev.set(p.id, { x: p.x, y: p.y });
  }

  /** Is the entity (or point) something the local player may see? */
  private seesPoint(x: number, y: number): boolean {
    return !this.ctrl.showFog || this.tileVisible(x, y);
  }

  private afterTick(): void {
    for (const ev of this.world.fx) this.handleFx(ev);
    const fb = this.ctrl.lastFeedback;
    if (fb) {
      this.ctrl.lastFeedback = null;
      const tint = fb.kind === "attack" ? 0xff5a4a : fb.kind === "rally" ? 0xffe066 : 0x7ef29b;
      this.fx.marker(fb.x * TILE, fb.y * TILE, tint);
      sfx.play("click", 0.6);
    }
  }

  private handleFx(ev: FxEvent): void {
    if (this.survival?.handleFx(ev)) return;
    const w = this.world;
    switch (ev.type) {
      case "shot": {
        if (!this.seesPoint(ev.x, ev.y) && !this.seesPoint(ev.tx, ev.ty)) return;
        const src = w.units.get(ev.sourceId) ?? w.buildings.get(ev.sourceId);
        const faction = src?.faction ?? PLAYER;
        this.entities.fired(ev.sourceId, Math.atan2(ev.tx - ev.x, -(ev.ty - ev.y)));
        const from = this.entities.muzzle(ev.sourceId) ?? { x: ev.x * TILE, y: ev.y * TILE };
        const jitter = () => (Math.random() - 0.5) * 14;
        const to = { x: ev.tx * TILE + jitter(), y: ev.ty * TILE - (ev.air ? AIR_LIFT : 0) + jitter() };
        this.fx.shot(ev, from, to, faction);
        break;
      }
      case "explosion":
        if (!this.seesPoint(ev.x, ev.y) && ev.kind !== "building") return;
        this.fx.explosion(ev, { x: ev.x * TILE, y: ev.y * TILE - (ev.air ? AIR_LIFT : 0) });
        break;
      case "heal": {
        if (!this.seesPoint(ev.x, ev.y)) return;
        const from = this.entities.pos(ev.sourceId);
        const to = this.entities.pos(ev.targetId);
        if (from && to) this.fx.heal({ x: from.x, y: from.y }, { x: to.x, y: to.y });
        break;
      }
      case "built": {
        if (ev.faction !== PLAYER || gameMode.spectator) return;
        const b = w.buildings.get(ev.id);
        const u = w.units.get(ev.id);
        if (b) {
          sfx.play("build");
          const c = buildingCenter(b);
          this.fx.pulse(c.x * TILE, c.y * TILE, 0x7ef29b, BUILDINGS[b.kind].size);
        } else if (u) {
          sfx.play("ready", 0.5);
          this.fx.pulse(u.x * TILE, u.y * TILE, 0x7ec1ff, 0.8);
        }
        break;
      }
      case "sold":
        this.entities.markSold(ev.id);
        sfx.play("sell");
        break;
      case "hit":
        if (ev.faction !== PLAYER || gameMode.spectator) return;
        if (this.simSeconds - this.lastAlert > 12) {
          const cam = this.cameras.main.worldView;
          const onScreen = cam.contains(ev.x * TILE, ev.y * TILE);
          if (!onScreen) {
            this.lastAlert = this.simSeconds;
            sfx.play("alert", 0.8);
            this.hud.alert(ev.building ? "Base under attack!" : "Units under attack!", ev.x, ev.y);
          }
        }
        this.hud.ping(ev.x, ev.y);
        break;
      case "rankUp": {
        const u = w.units.get(ev.id);
        if (!u || !this.seesPoint(u.x, u.y)) return;
        this.fx.pulse(u.x * TILE, u.y * TILE, 0xffd66e, 1);
        if (u.faction === PLAYER) sfx.play("rank", 0.7);
        break;
      }
    }
  }

  // -------------------------------------------------------------- render ---

  private tileVisible(x: number, y: number): boolean {
    if (!this.ctrl.showFog) return true; // debug: reveal everything
    return isVisible(this.world, PLAYER, Math.floor(x), Math.floor(y));
  }

  private buildingShown(b: Building): boolean {
    if (!this.ctrl.showFog) return true;
    if (this.world.fog[PLAYER].known.has(b.id)) return true;
    const c = buildingCenter(b);
    return this.tileVisible(c.x, c.y);
  }

  /** Overlay line width that stays ~`css` CSS px wide at any zoom. */
  private px(css: number): number {
    return (css * this.dpr) / this.cameras.main.zoom;
  }

  private drawOverlay(alpha: number): void {
    const g = this.overlay;
    g.clear();
    const w = this.world;
    const lw = this.px(2);

    // selected units: rings + order lines
    for (const id of this.ctrl.selectedUnits) {
      const u = w.units.get(id);
      const p = this.entities.pos(id);
      if (!u || !p) continue;
      const r = UNITS[u.kind].radius * TILE + 8;
      const col = u.faction === PLAYER ? 0x7ef29b : 0xff7a6a;
      // aircraft: ring the craft itself, not its shadow
      g.lineStyle(lw, col, 0.95).strokeEllipse(p.x, p.y + 2, r * 2.1, r * 1.8);
      if (u.faction !== PLAYER) continue;
      const o = u.order;
      let tx: number | null = null;
      let ty: number | null = null;
      let lineCol = 0x7ef29b;
      if (o.type === "move" || o.type === "attackMove") {
        tx = o.x * TILE;
        ty = o.y * TILE;
        lineCol = o.type === "move" ? 0x7ec1ff : 0x7ef29b;
      } else if (o.type === "attack") {
        const t = this.entities.pos(o.targetId);
        if (t && this.entities.isShown(o.targetId)) {
          tx = t.x;
          ty = t.y;
          lineCol = 0xff5a4a;
        }
      }
      if (tx !== null && ty !== null) {
        g.lineStyle(this.px(1.2), lineCol, 0.35).lineBetween(p.gx, p.gy, tx, ty);
        g.fillStyle(lineCol, 0.5).fillCircle(tx, ty, this.px(3));
      }
    }

    const sb = this.ctrl.selectedBuilding !== null ? w.buildings.get(this.ctrl.selectedBuilding) : null;
    if (sb) {
      const size = BUILDINGS[sb.kind].size;
      g.lineStyle(lw, 0x7ef29b, 0.95).strokeRoundedRect(
        sb.tx * TILE + 2, sb.ty * TILE + 2, size * TILE - 4, size * TILE - 4, 8
      );
      const st = BUILDINGS[sb.kind];
      if (st.range > 0) {
        const c = buildingCenter(sb);
        g.lineStyle(this.px(1.2), 0xffffff, 0.25).strokeCircle(c.x * TILE, c.y * TILE, (st.range + size / 2) * TILE);
      }
      if (sb.rally) {
        const c = buildingCenter(sb);
        g.lineStyle(this.px(1.5), 0xffe066, 0.8)
          .lineBetween(c.x * TILE, c.y * TILE, sb.rally.x * TILE, sb.rally.y * TILE)
          .strokeCircle(sb.rally.x * TILE, sb.rally.y * TILE, 10);
      }
    }

    // health bars (damaged or selected) and veterancy
    for (const u of w.units.values()) {
      const max = UNITS[u.kind].hp;
      const selected = this.ctrl.selectedUnits.has(u.id);
      if (u.hp >= max && !selected) continue;
      if (!this.entities.isShown(u.id)) continue;
      const p = this.entities.pos(u.id);
      if (!p) continue;
      const bw = Math.max(34, UNITS[u.kind].radius * TILE * 2);
      this.healthBar(g, p.x - bw / 2, p.y - UNITS[u.kind].radius * TILE - 14, bw, u.hp / max, u.faction === PLAYER);
      if (u.kind === "harvester" && u.faction === PLAYER && selected) {
        const k = u.cargo / ECONOMY.harvesterCapacity;
        g.fillStyle(0x10141c, 0.8).fillRect(p.x - bw / 2, p.y - UNITS[u.kind].radius * TILE - 7, bw, 4);
        g.fillStyle(0xffd66e, 1).fillRect(p.x - bw / 2 + 1, p.y - UNITS[u.kind].radius * TILE - 6, (bw - 2) * k, 2);
      }
    }
    for (const b of w.buildings.values()) {
      const max = BUILDINGS[b.kind].hp;
      const size = BUILDINGS[b.kind].size;
      if (!this.entities.isShown(b.id)) continue;
      if (b.hp < max || this.ctrl.selectedBuilding === b.id)
        this.healthBar(g, b.tx * TILE + 6, b.ty * TILE - 4, size * TILE - 12, b.hp / max, b.faction === PLAYER);
      // production progress along the bottom edge of our factories
      const head = b.queue[0];
      if (head && b.faction === PLAYER) {
        const total = UNITS[head.kind].buildTime * TICK_RATE;
        const k = 1 - head.remaining / total;
        const y = (b.ty + size) * TILE - 7;
        g.fillStyle(0x10141c, 0.75).fillRect(b.tx * TILE + 8, y, size * TILE - 16, 5);
        g.fillStyle(0x6eb0ff, 1).fillRect(b.tx * TILE + 9, y + 1, (size * TILE - 18) * k, 3);
      }
    }

    this.survival?.drawOverlay((css) => this.px(css), this.time.now);
    this.drawPlacement(g);

    if (this.boxRect) {
      const cam = this.cameras.main;
      const a = cam.getWorldPoint(this.boxRect.x0 * this.dpr, this.boxRect.y0 * this.dpr);
      const b = cam.getWorldPoint(this.boxRect.x1 * this.dpr, this.boxRect.y1 * this.dpr);
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      g.lineStyle(this.px(1.5), 0x7ef29b, 0.9).strokeRect(x, y, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      g.fillStyle(0x7ef29b, 0.08).fillRect(x, y, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    }
    void alpha;
  }

  private drawPlacement(g: Phaser.GameObjects.Graphics): void {
    const kind = this.ctrl.placing;
    if (!kind || !this.world.factions[PLAYER].pending?.ready) {
      this.ghost.setVisible(false);
      return;
    }
    const w = this.world;
    // build-radius hint around our buildings
    for (const b of w.buildings.values()) {
      if (b.faction !== PLAYER) continue;
      const c = buildingCenter(b);
      const size = BUILDINGS[b.kind].size;
      g.fillStyle(0x7ef29b, 0.05).fillCircle(c.x * TILE, c.y * TILE, (ECONOMY.buildRadius + size / 2) * TILE);
    }
    const size = BUILDINGS[kind].size;
    const pointer = this.input.activePointer;
    const wp = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    const tx = Math.round(wp.x / TILE - size / 2);
    const ty = Math.round(wp.y / TILE - size / 2);
    const ok = canPlaceBuilding(w, PLAYER, kind, tx, ty);
    this.ghost
      .setVisible(true)
      .setFrame(buildingFrame(PLAYER, kind))
      .setScale(ART_SCALE)
      .setPosition((tx + size / 2) * TILE, (ty + size / 2) * TILE)
      .setTint(ok ? 0xb8ffc8 : 0xff8080);
    g.fillStyle(ok ? 0x37d67a : 0xe25555, 0.25).fillRect(tx * TILE, ty * TILE, size * TILE, size * TILE);
    g.lineStyle(this.px(2), ok ? 0x37d67a : 0xe25555, 0.9).strokeRect(tx * TILE, ty * TILE, size * TILE, size * TILE);
  }

  private healthBar(
    g: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    width: number,
    ratio: number,
    friendly: boolean
  ): void {
    const h = Math.max(5, this.px(4));
    g.fillStyle(0x0a0d14, 0.85).fillRect(x - 1, y - 1, width + 2, h + 2);
    const col = friendly
      ? ratio > 0.6 ? 0x53d769 : ratio > 0.3 ? 0xf2c14e : 0xf06a4a
      : 0xe25555;
    g.fillStyle(col, 1).fillRect(x, y, Math.max(0, width * ratio), h);
    // segment ticks make big health pools readable at a glance
    const segs = Math.min(10, Math.round(width / 10));
    g.fillStyle(0x0a0d14, 0.5);
    for (let i = 1; i < segs; i++) g.fillRect(x + (width * i) / segs, y, 1, h);
  }

  // --------------------------------------------------------------- input ---

  private worldAt(sx: number, sy: number): { x: number; y: number } {
    const wp = this.cameras.main.getWorldPoint(sx * this.dpr, sy * this.dpr);
    return { x: wp.x / TILE, y: wp.y / TILE };
  }

  private hitRadius(): number {
    return Math.max(0.6, (24 * this.dpr) / (TILE * this.cameras.main.zoom));
  }

  private canSee = (id: number): boolean => this.entities.isShown(id);

  private setupInput(): void {
    const cam = this.cameras.main;
    this.gest = new GestureRecognizer({
      onTap: (sx, sy) => {
        const p = this.worldAt(sx, sy);
        this.ctrl.tapWorld(p.x, p.y, hitTest(this.world, p.x, p.y, this.hitRadius(), this.canSee));
      },
      onDoubleTap: (sx, sy) => {
        const p = this.worldAt(sx, sy);
        const hit = hitTest(this.world, p.x, p.y, this.hitRadius(), this.canSee);
        if (hit.kind !== "ownUnit") return;
        const kind = this.world.units.get(hit.id)?.kind;
        const view = cam.worldView;
        const ids = [...this.world.units.values()]
          .filter((u) => u.faction === PLAYER && u.kind === kind && view.contains(u.x * TILE, u.y * TILE))
          .map((u) => u.id);
        this.ctrl.selectUnits(ids);
      },
      onBoxStart: (sx, sy) => {
        this.boxRect = { x0: sx, y0: sy, x1: sx, y1: sy };
      },
      onBoxMove: (sx, sy) => {
        if (this.boxRect) {
          this.boxRect.x1 = sx;
          this.boxRect.y1 = sy;
        }
      },
      onBoxEnd: (sx, sy) => {
        if (!this.boxRect) return;
        const a = this.worldAt(this.boxRect.x0, this.boxRect.y0);
        const b = this.worldAt(sx, sy);
        this.boxRect = null;
        const x0 = Math.min(a.x, b.x);
        const y0 = Math.min(a.y, b.y);
        const x1 = Math.max(a.x, b.x);
        const y1 = Math.max(a.y, b.y);
        const inBox = [...this.world.units.values()].filter(
          (u) => u.faction === PLAYER && u.x >= x0 && u.x <= x1 && u.y >= y0 && u.y <= y1
        );
        // prefer combat units: a box over the mining line shouldn't grab harvesters
        const army = inBox.filter((u) => u.kind !== "harvester");
        const ids = (army.length > 0 ? army : inBox).map((u) => u.id);
        if (ids.length > 0) this.ctrl.selectUnits(ids);
      },
      onPan: (dx, dy) => {
        cam.scrollX -= (dx * this.dpr) / cam.zoom;
        cam.scrollY -= (dy * this.dpr) / cam.zoom;
        this.lastPan = { x: dx, y: dy };
        this.glide = null;
      },
      onPanEnd: () => {
        if (Math.hypot(this.lastPan.x, this.lastPan.y) > 3) this.glide = { ...this.lastPan };
        this.lastPan = { x: 0, y: 0 };
      },
      onPinch: (scale, cx, cy) => {
        this.zoomAround(cam.zoom * scale, cx * this.dpr, cy * this.dpr);
        this.targetZoom = cam.zoom; // pinch is immediate; keep target in sync
      },
      onRightClick: (sx, sy) => {
        const p = this.worldAt(sx, sy);
        let hit = hitTest(this.world, p.x, p.y, this.hitRadius(), this.canSee);
        // right-click never re-selects; own entities count as ground
        if (hit.kind === "ownUnit" || hit.kind === "ownBuilding") hit = { kind: "ground" };
        this.ctrl.tapWorld(p.x, p.y, hit);
      },
      onWheel: (deltaY, sx, sy) => this.zoomBy(deltaY > 0 ? 0.85 : 1.18, sx * this.dpr, sy * this.dpr)
    });

    const toPointer = (p: Phaser.Input.Pointer) => ({
      id: p.id,
      x: p.x / this.dpr,
      y: p.y / this.dpr,
      // Phaser attaches TouchEvents (no pointerType field) for touch input,
      // so fall back to wasTouch — defaulting to "mouse" misclassified all
      // touches and made one-finger drags box-select instead of pan
      pointerType: (((p.event as PointerEvent)?.pointerType ??
        (p.wasTouch ? "touch" : "mouse")) as "touch" | "mouse" | "pen"),
      button: (p.event as PointerEvent)?.button ?? 0
    });
    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
      this.glide = null; // touching the map stops any glide
      this.gest.down(toPointer(p), performance.now());
    });
    this.input.on("pointermove", (p: Phaser.Input.Pointer) => this.gest.move(toPointer(p), performance.now()));
    const up = (p: Phaser.Input.Pointer) => this.gest.up(toPointer(p), performance.now());
    this.input.on("pointerup", up);
    this.input.on("pointerupoutside", up);
    this.input.on("wheel", (p: Phaser.Input.Pointer, _o: unknown, _dx: number, dy: number) =>
      this.gest.wheel(dy, p.x / this.dpr, p.y / this.dpr)
    );
    this.input.keyboard?.on("keydown-ESC", () => {
      this.ctrl.placing = null;
      this.ctrl.clearSelection();
    });
    this.cursors = this.input.keyboard?.createCursorKeys();
    this.wasd = this.input.keyboard?.addKeys("W,A,S,D") as typeof this.wasd;
    this.input.keyboard?.on("keydown", (e: KeyboardEvent) => {
      if (e.key === "+" || e.key === "=") this.zoomBy(1.3);
      else if (e.key === "-" || e.key === "_") this.zoomBy(1 / 1.3);
      else if (e.key === "p" || e.key === " ") this.hud.togglePause();
      else if (e.key === "q") this.ctrl.selectArmy();
      else if (e.key === "Delete") this.ctrl.sellSelected();
    });
  }

  /**
   * Zoom keeping the world point under screen (sx, sy) — in game px — fixed.
   * Computed analytically: Phaser zooms about the viewport centre, so
   *   scroll' = scroll + (s - centre) * (1/z1 - 1/z2)
   */
  private zoomAround(zoom: number, sx: number, sy: number): void {
    const cam = this.cameras.main;
    const z1 = cam.zoom;
    const z2 = this.clampedZoom(zoom);
    if (z2 === z1) return;
    const k = 1 / z1 - 1 / z2;
    cam.setZoom(z2);
    cam.scrollX += (sx - cam.width / 2) * k;
    cam.scrollY += (sy - cam.height / 2) * k;
  }

  private clampedZoom(z: number): number {
    const cam = this.cameras.main;
    const fit = Math.max(
      cam.width / (this.world.width * TILE + EDGE_PAD * 2),
      cam.height / (this.world.height * TILE + EDGE_PAD * 2)
    );
    return Phaser.Math.Clamp(z, Math.max(fit, MIN_ZOOM * this.dpr), MAX_ZOOM * this.dpr);
  }

  private clampZoom(): void {
    const cam = this.cameras.main;
    cam.setZoom(this.clampedZoom(cam.zoom));
    this.targetZoom = cam.zoom;
  }
}


