import Phaser from "phaser";
import { DIFFICULTY, createAiState, tickAi, type AiState } from "../sim/ai/commander";
import { BUILDINGS, ECONOMY, TICK_RATE, UNITS } from "../sim/balance";
import { canPlaceBuilding, nearestReachableResource } from "../sim/economy";
import { isVisible, tickFog } from "../sim/fog";
import { createMapWorld, mapById } from "../sim/maps";
import { OPENERS, OPENER_IDS, allowedOpener, applyOpener, openerBlocked, pickAiOpener, type OpenerId } from "../sim/openers";
import { step } from "../sim/sim";
import type { Building, FxEvent, World } from "../sim/types";
import { buildingCenter, hqOf } from "../sim/world";
import { sfx } from "./audio";
import {
  ATLAS,
  TILE,
  loadAssets,
  setSpriteMeta,
  type SpriteMeta
} from "./assets";
import { Controller, PLAYER, hitTest } from "./controller";
import { GestureRecognizer } from "./gestures";
import { announce } from "./announce";
import { gameMode, matchOptions } from "./mode";
import { music } from "./music";
import { BattleMood } from "./score";
import { voices, type VoiceHooks } from "./voices";
import { Announcer } from "./announcer";
import { Awareness } from "./awareness-view";
import { planTicks } from "./awareness";
import { SurvivalPresenter, finishRun } from "./survival";
import { chronicleOf, type Chronicle } from "./chronicle";
import { Finale, finaleZoom, freeAreaOffset } from "./finale";
import { HeroPresenter } from "./hero-fx";
import { aiSeed, aiStrategy, announceRules, opEnemyAi, settleCareer } from "./meta";
import { OpsPresenter } from "./ops";
import { EntityRenderer } from "./render/entities";
import { AIR_LIFT, Fx } from "./render/fx";
import { CombatJuice } from "./render/juice-view";
import { WorldView } from "./render/world-view";
import { WreckRenderer } from "./render/wrecks";
import { PowerRenderer } from "./render/powers";
import { createFxTextures } from "./textures";
import { createHud, type Hud } from "../ui/hud";
import { PlacementView } from "./placement-view";
import { CommandUi } from "../ui/command";
import { showOpenerPicker } from "../ui/openers";
import { createPowerPanel, type PowerPanel } from "../ui/powers";
import { fitZoom, frameCentre, hudInsets, startBox } from "./framing";

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
  /** Veteran promotions/deaths, the match record, and the HQ-kill cinematic. */
  private heroes!: HeroPresenter;
  private chronicle!: Chronicle;
  private finale: Finale | null = null;
  private finaleAt: { x: number; y: number; size: number } | null = null;
  /** Ops: briefing banner, countdowns and star notices (null outside ops). */
  private ops: OpsPresenter | null = null;
  private acc = 0;
  private prev = new Map<number, { x: number; y: number }>();
  private dpr = 1;
  private overlay!: Phaser.GameObjects.Graphics;
  /** Building placement: ghost, suggested spot, touch move/drag/confirm. */
  private place!: PlacementView;
  /** Squad chips, counter/idle advisor badges. */
  private command!: CommandUi;
  private worldView!: WorldView;
  private entities!: EntityRenderer;
  private fx!: Fx;
  private juice!: CombatJuice;
  /** Battle intensity for the adaptive score. */
  private mood!: BattleMood;
  /** The radio announcer (and the kill-streak callouts it owns). */
  private radio!: Announcer;
  private voiceHooks!: VoiceHooks;
  /** Game speed, inbound warnings, edge arrows, jump button, battle meter. */
  private aware!: Awareness;
  private wrecks!: WreckRenderer;
  /** Commander calldowns: reticles/effects, and the HUD buttons + targeting. */
  private powerFx!: PowerRenderer;
  private powerUi?: PowerPanel;
  private gest!: GestureRecognizer;
  private boxRect: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private hud!: Hud;
  private ended = false;
  /** The clock waits for the player's opener pick. */
  private holdStart = false;
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
        spectator: gameMode.spectator || !!this.world.ops, // (no Last Stand records in an op)
        ping: (x, y) => this.hud?.ping(x, y),
        gfx: this.add.graphics().setDepth(10.5)
      });
    // spectating pits two Normal commanders against each other
    // mutators / the Daily Op decide which personalities can play (meta.ts)
    const aiDiff = gameMode.spectator ? "normal" : gameMode.difficulty;
    this.ai = opEnemyAi() ?? createAiState(aiStrategy(aiDiff), aiDiff, aiSeed(1));
    if (gameMode.spectator) {
      this.blueAi = createAiState(aiStrategy("normal"), "normal", aiSeed(2));
      this.ctrl.spectator = true;
      this.ctrl.showFog = false; // watch the whole battle by default
    }
    // quick-start openers: spectated AIs take theirs at once; the player picks first
    // (skirmish and the Daily Op only: Last Stand and Ops set up their own starts)
    const openers: Partial<Record<"blue" | "red", OpenerId>> = {};
    if (this.world.survival || this.world.ops) {
      /* no opener cards */
    } else if (this.blueAi) {
      // (match rules may ban a pick, e.g. no Fab Plants under Air War: take an allowed one)
      openers.blue = allowedOpener(this.world, "blue", pickAiOpener(this.blueAi.strategy.name, this.world.seed, "blue")) ?? undefined;
      openers.red = allowedOpener(this.world, "red", pickAiOpener(this.ai.strategy.name, this.world.seed, "red")) ?? undefined;
      if (openers.blue) applyOpener(this.world, "blue", openers.blue);
      if (openers.red) applyOpener(this.world, "red", openers.red);
    } else this.holdStart = OPENER_IDS.some((id) => !openerBlocked(this.world, PLAYER, id));
    tickFog(this.world); // the base shows through the opener cards

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
    this.juice = new CombatJuice(this, {
      world: this.world, entities: this.entities, fx: this.fx, player: PLAYER, spectator: gameMode.spectator,
      sees: (x, y) => this.seesPoint(x, y),
      earshot: (x, y) => this.earshot(x, y),
      px: (css) => this.px(css)
    });
    this.mood = new BattleMood({
      player: PLAYER, spectator: gameMode.spectator,
      earshot: (x, y) => this.earshot(x * TILE, y * TILE),
      sees: (x, y) => this.seesPoint(x, y),
      factionOf: (id) => (this.world.units.get(id) ?? this.world.buildings.get(id))?.faction ?? null
    });
    music.play("battle", this.world.biome);
    const inView = (x: number, y: number) => this.cameras.main.worldView.contains(x * TILE, y * TILE);
    this.radio = new Announcer({
      world: this.world, player: PLAYER, spectator: gameMode.spectator, onScreen: inView,
      caption: (l) => this.hud.radio(l.text, l.tone, l.x, l.y)
    });
    this.voiceHooks = {
      world: this.world, player: PLAYER, spectator: gameMode.spectator,
      inView: (x, y) => this.seesPoint(x, y) && inView(x, y)
    };
    this.wrecks = new WreckRenderer(this, this.world, this.fx, {
      visibleAt: (x, y) => this.tileVisible(x, y),
      pose: (id) => this.entities.pose(id),
      player: PLAYER,
      spectator: gameMode.spectator,
      dpr: this.dpr,
      hint: (msg, x, y) => this.hud.hint(msg, undefined, x, y)
    });
    this.powerFx = new PowerRenderer(this, this.world, this.fx, {
      player: PLAYER,
      spectator: gameMode.spectator,
      dpr: this.dpr,
      visibleAt: (x, y) => this.tileVisible(x, y),
      earshot: (x, y) => this.earshot(x, y),
      pos: (id) => this.entities.pos(id),
      isShown: (id) => this.entities.isShown(id),
      alert: (msg, x, y) => this.hud.alert(msg, x, y),
      ping: (x, y) => this.hud.ping(x, y)
    });
    this.overlay = this.add.graphics().setDepth(8);
    this.place = new PlacementView({
      scene: this, world: this.world, ctrl: this.ctrl, dpr: this.dpr,
      viewCentre: () => this.aware.viewCentre(),
      inView: (x, y) => this.aware.inPlay(x, y, 40),
      glideTo: (x, y) => this.aware.glideTo(x, y),
      hint: (id, msg) => this.command.hint(id, msg),
      handoff: (p) => this.gest.down(p, performance.now())
    });
    this.chronicle = chronicleOf(this.world);
    this.heroes = new HeroPresenter(this, this.world, {
      dpr: this.dpr,
      player: PLAYER,
      spectator: gameMode.spectator,
      seesPoint: (x, y) => this.seesPoint(x, y),
      unitPos: (id) => this.entities.pos(id),
      notify: (msg, tone, x, y) => this.hud?.notice(msg, tone, x, y)
    });

    const focus = gameMode.spectator ? null : hqOf(this.world, PLAYER);
    const c = gameMode.op?.focus ?? (focus ? buildingCenter(focus) : { x: this.world.width / 2, y: this.world.height / 2 });
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
      wrecks: () => this.wrecks.dots(),
      targetChip: () => this.powerUi?.chip() ?? null,
      calldowns: () => this.powerFx.rings(),
      strategies: this.blueAi
        ? {
            blue: `${this.blueAi.strategy.label}${openers.blue ? ` · ${OPENERS[openers.blue].name}` : ""}`,
            red: this.survival ? "the waves" : `${this.ai.strategy.label}${openers.red ? ` · ${OPENERS[openers.red].name}` : ""}`
          }
        : null,
      enemy: { strategy: this.survival ? "Last Stand" : this.ai.strategy.label, difficulty: gameMode.difficulty },
      cardNote: (k) => this.command?.cardNote(k) ?? null
    });

    this.aware = new Awareness({
      scene: this, world: this.world, player: PLAYER, spectator: gameMode.spectator, dpr: this.dpr,
      hud: this.hud, radio: this.radio,
      sees: (x, y) => this.seesPoint(x, y),
      pulse: (x, y, c) => this.fx.pulse(x * TILE, y * TILE, c, 1.4)
    });
    this.command = new CommandUi({
      root: document.getElementById("hud")!, world: this.world, ctrl: this.ctrl, spectator: gameMode.spectator,
      glideTo: (x, y) => this.aware.glideTo(x, y),
      tip: (msg, ms) => this.hud.hint(msg, ms)
    });
    const powerUi = createPowerPanel({
      world: this.world,
      ctrl: this.ctrl,
      notify: (msg, tone) => this.hud.notify(msg, tone),
      hint: (msg) => this.hud.hint(msg),
      viewCentre: () => ({ x: cam.midPoint.x / TILE, y: cam.midPoint.y / TILE })
    });
    this.powerUi = powerUi;

    this.events.on(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.command.destroy();
      this.place.destroy();
      this.aware.destroy();
      powerUi.destroy();
      this.powerFx.destroy();
      this.hud.destroy();
      this.radio.destroy();
    });
    window.setTimeout(() => announceRules(this.world), 1200); // Daily Op / mutators banner
    if (this.world.ops) this.ops = new OpsPresenter(this.world, { notify: (m, t, x, y) => this.hud.notice(m, t, x, y) });
    if (focus && !gameMode.op) this.frameStart(); // an op opens on its own focus point
    if (this.holdStart) {
      const picker = showOpenerPicker({
        context: `${mapById(gameMode.mapId).name} · vs ${this.ai.strategy.label} AI (${DIFFICULTY[gameMode.difficulty].label})`,
        onPick: (id) => this.startWithOpener(id),
        blocked: (id) => openerBlocked(this.world, PLAYER, id)
      });
      this.events.on(Phaser.Scenes.Events.SHUTDOWN, () => picker.destroy());
    }

    // debug/testing handle (harmless in production)
    (window as unknown as Record<string, unknown>).__bd = {
      world: this.world,
      ctrl: this.ctrl,
      cam,
      scene: this,
      announce,
      music,
      radio: this.radio,
      voices,
      aware: this.aware,
      place: this.place,
      command: this.command,
      canPlace: (tx: number, ty: number) =>
        canPlaceBuilding(this.world, PLAYER, this.ctrl.placing ?? "fab-plant", tx, ty)
    };
  }

  /** Open on the player's HQ, home field and factory site, framed clear of the HUD. */
  private frameStart(): void {
    const box = startBox(this.world, PLAYER);
    if (!box) return;
    const cam = this.cameras.main;
    const ins = hudInsets();
    const vw = cam.width / this.dpr;
    const vh = cam.height / this.dpr;
    const fit = Phaser.Math.Clamp(fitZoom(box, vw, vh, ins, TILE), 0.4, 0.75);
    cam.setZoom(this.clampedZoom(fit * this.dpr));
    this.targetZoom = cam.zoom;
    const at = frameCentre(box, cam.zoom / this.dpr, vw, vh, ins, TILE);
    cam.centerOn(at.x, at.y);
  }

  /** The player picked an opener: both sides get theirs and the clock starts. */
  private startWithOpener(id: OpenerId): void {
    if (!this.holdStart) return;
    const mine = applyOpener(this.world, PLAYER, id);
    const red = allowedOpener(this.world, "red", pickAiOpener(this.ai.strategy.name, this.world.seed, "red"));
    if (red) applyOpener(this.world, "red", red);
    tickFog(this.world);
    this.holdStart = false;
    // roll-out flourish on everything that just arrived
    const b = mine.buildingId !== null ? this.world.buildings.get(mine.buildingId) : null;
    if (b) {
      const c = buildingCenter(b);
      this.fx.pulse(c.x * TILE, c.y * TILE, 0x7ef29b, BUILDINGS[b.kind].size);
    }
    for (const uid of mine.unitIds) {
      const u = this.world.units.get(uid);
      if (u) this.fx.pulse(u.x * TILE, u.y * TILE, 0x7ec1ff, 0.8);
    }
    sfx.play("build");
    const o = OPENERS[id];
    announce({ key: `opener-${id}`, text: `${o.name}!`, sub: o.rollout, tone: "good", priority: 1 });
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

    if (!this.ctrl.paused && !this.ended && !this.holdStart) {
      // game speed (1–4×), at most AWARE.maxTicksPerFrame ticks per frame
      const plan = planTicks(this.acc, delta, this.aware.value);
      this.acc = plan.acc;
      for (let i = 0; i < plan.ticks; i++) {
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
    this.finale?.update(delta);
    const slow = this.finale?.timeScale ?? 1;
    this.worldView.update(delta * slow, this.ctrl.showFog);
    this.entities.sync(alpha, this.prev, this.ctrl.paused ? 0 : delta * slow);
    this.wrecks.sync(this.ctrl.paused ? 0 : delta * slow);
    this.powerFx.sync(this.ctrl.paused ? 0 : delta * slow, alpha, this.powerUi?.preview() ?? null);
    this.fx.projectiles(this.world.projectiles, alpha, this.prev);
    this.fx.update(this.ctrl.paused ? 0 : delta * slow);
    this.juice.update(this.ctrl.paused ? 0 : delta * slow);
    this.place.update(delta);
    this.drawOverlay(alpha);
    this.hud.update();
    this.command.update();
    this.aware.update(delta, this.ctrl.paused);
    voices.watchSelection(this.ctrl.selectedUnits, this.world);
    this.radio.update(delta, this.ctrl.paused);
    music.update({
      intensity: this.mood.update(delta / 1000, this.simSeconds),
      alarm: this.mood.alarm(this.simSeconds),
      paused: this.ctrl.paused
    });
    this.powerUi?.update();

    if (this.world.winner && !this.ended) {
      this.ended = true;
      const won = this.world.winner === PLAYER;
      // Last Stand always ends in defeat; a new record still gets the fanfare
      const run = this.survival && !gameMode.spectator && !this.world.ops ? finishRun(this.world, this.world.mapId, this.survival.difficulty) : null;
      this.chronicle.finish();
      settleCareer(this.world, PLAYER); // XP, medals, stars (spectators: no-op)
      this.playFinale(() => {
        // at the flash the score resolves into a fanfare / lament; the SFX jingle covers music-off
        const outcome = won || run?.isNew || gameMode.spectator ? "victory" : "defeat";
        if (!music.finale(outcome) && !gameMode.spectator) sfx.play(outcome);
      });
    }
  }

  /**
   * The HQ kill: slow motion, a camera glide onto the wreck, rolling blasts,
   * a white flash with the result line, then the after-action report.
   */
  private playFinale(stinger: () => void): void {
    const winner = this.world.winner!;
    // an op that ended on its objective has no HQ wreck: look where it was decided, skip the blasts
    const opEnd = this.world.ops?.result;
    const at = (opEnd?.byGoal ? { x: opEnd.x, y: opEnd.y, size: 3 } : null) ??
      this.finaleAt ?? { x: this.world.width / 2, y: this.world.height / 2, size: 3 };
    const spec = gameMode.spectator;
    const won = winner === PLAYER;
    this.glide = null;
    this.boxRect = null;
    this.ctrl.clearSelection();
    this.ctrl.placing = null;
    const zoom = finaleZoom(this.cameras.main.zoom, DEFAULT_ZOOM * this.dpr);
    const free = freeAreaOffset();
    this.finale = new Finale({
      scene: this,
      fx: this.fx,
      ...at,
      blasts: !opEnd?.byGoal,
      shiftX: (free.x * this.dpr) / this.clampedZoom(zoom),
      shiftY: (free.y * this.dpr) / this.clampedZoom(zoom),
      onFlash: () => {
        stinger();
        const loser = winner === "blue" ? "Red" : "Blue";
        announce(
          this.ops
            ? this.ops.endAnnouncement()
            : this.survival
            ? { key: "base-overrun", text: "Base overrun", sub: "The HQ has fallen", tone: "bad", priority: 0, x: at.x, y: at.y }
            : spec
              ? { key: "hq-destroyed", text: `${loser} HQ destroyed`, sub: `${loser === "Red" ? "Blue" : "Red"} wins`, tone: "epic", priority: 0, x: at.x, y: at.y }
              : won
                ? { key: "victory", text: "Enemy HQ destroyed", sub: "Victory", tone: "epic", priority: 0, x: at.x, y: at.y }
                : { key: "defeat", text: "Our HQ has fallen", sub: "Defeat", tone: "bad", priority: 0, x: at.x, y: at.y }
        );
      },
      onDone: () => {
        this.finale = null;
        this.hud.showEnd(winner);
      }
    });
    this.zoomBy(zoom / this.targetZoom);
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
    this.juice.events(this.world.fx);
    this.mood.events(this.world.fx, this.simSeconds);
    this.aware.events(this.world.fx, this.simSeconds);
    this.radio.events(this.world.fx, this.simSeconds);
    voices.events(this.world.fx, this.voiceHooks);
    this.command.events(this.world.fx, this.simSeconds);
    this.ops?.tick();
    this.chronicle.tick();
    this.heroes.flush();
    for (const ev of this.world.fx) {
      this.handleFx(ev);
      this.wrecks.onFx(ev);
      this.powerFx.onFx(ev);
    }
    const fb = this.ctrl.lastFeedback;
    if (fb) {
      this.ctrl.lastFeedback = null;
      const tint = fb.kind === "attack" ? 0xff5a4a : fb.kind === "rally" ? 0xffe066 : 0x7ef29b;
      this.fx.marker(fb.x * TILE, fb.y * TILE, tint);
      sfx.play("click", 0.6);
      voices.order(fb.kind, this.ctrl.selectedUnits, this.world);
    }
  }

  private handleFx(ev: FxEvent): void {
    this.chronicle.onFx(ev);
    this.heroes.handleFx(ev);
    if (ev.type === "death" && ev.buildingKind === "hq")
      this.finaleAt = { x: ev.x, y: ev.y, size: BUILDINGS.hq.size };
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
          if (!voices.active) sfx.play("ready", 0.5); // else the unit reports in (voices.ts)
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
            const hq = ev.building && w.buildings.get(ev.id)?.kind === "hq";
            this.hud.alert(hq ? "HQ under attack!" : ev.building ? "Base under attack!" : "Units under attack!", ev.x, ev.y);
          }
        }
        this.hud.ping(ev.x, ev.y);
        break;
      case "rankUp": {
        const u = w.units.get(ev.id);
        if (!u || !this.seesPoint(u.x, u.y)) return;
        this.fx.pulse(u.x * TILE, u.y * TILE, 0xffd66e, 1);
        if (u.faction === PLAYER && !voices.active) sfx.play("rank", 0.7); // else a voiced sparkle
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
      this.healthBar(g, u.id, p.x - bw / 2, p.y - UNITS[u.kind].radius * TILE - 14, bw, u.hp / max, u.faction === PLAYER);
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
        this.healthBar(g, b.id, b.tx * TILE + 6, b.ty * TILE - 4, size * TILE - 12, b.hp / max, b.faction === PLAYER);
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
    this.place.draw(g, (css) => this.px(css));
  }

  /** Damage-trail health bar (see render/juice-view.ts). */
  private healthBar(
    g: Phaser.GameObjects.Graphics,
    id: number,
    x: number,
    y: number,
    width: number,
    ratio: number,
    friendly: boolean
  ): void {
    this.juice.healthBar(g, id, x, y, width, ratio, friendly);
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
      onTap: (sx, sy, type) => {
        if (this.place.tap(sx, sy, type)) return; // placing: move the ghost / build
        const p = this.worldAt(sx, sy);
        if (this.powerUi?.tapWorld(p.x, p.y)) return; // an armed calldown fires here
        this.ctrl.tapWorld(p.x, p.y, hitTest(this.world, p.x, p.y, this.hitRadius(), this.canSee));
      },
      onDoubleTap: (sx, sy) => {
        if (this.place.tap(sx, sy)) return; // 2nd tap lands on the ghost it just moved: build
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
    for (const ev of this.world.fx) {
      this.handleFx(ev);
      this.wrecks.onFx(ev);
      this.powerFx.onFx(ev);
    }
    this.juice.events(this.world.fx);
    this.mood.events(this.world.fx, this.simSeconds);
    this.aware.events(this.world.fx, this.simSeconds);
    this.radio.events(this.world.fx, this.simSeconds);
    voices.events(this.world.fx, this.voiceHooks);
    this.command.events(this.world.fx, this.simSeconds);
    this.ops?.tick();
    this.chronicle.tick();
    this.heroes.flush();
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
      if (this.finale) return; // the camera belongs to the cinematic now
      this.glide = null; // touching the map stops any glide
      if (this.place.down(toPointer(p))) return; // a finger on the ghost drags it
      this.gest.down(toPointer(p), performance.now());
    });
    this.input.on("pointermove", (p: Phaser.Input.Pointer) => {
      if (!this.place.move(toPointer(p))) this.gest.move(toPointer(p), performance.now());
    });
    // an armed calldown's preview follows the mouse, or the finger on the map
    const aim = (p: Phaser.Input.Pointer) => {
      if (!this.powerUi?.targeting) return;
      const q = this.worldAt(p.x / this.dpr, p.y / this.dpr);
      this.powerUi.aim(q.x, q.y);
    };
    this.input.on("pointermove", aim);
    this.input.on("pointerdown", aim);
    const up = (p: Phaser.Input.Pointer) => {
      if (!this.place.up(toPointer(p))) this.gest.up(toPointer(p), performance.now());
    };
    this.input.on("pointerup", up);
    this.input.on("pointerupoutside", up);
    this.input.on("wheel", (p: Phaser.Input.Pointer, _o: unknown, _dx: number, dy: number) =>
      this.gest.wheel(dy, p.x / this.dpr, p.y / this.dpr)
    );
    this.input.keyboard?.on("keydown-ESC", () => {
      this.powerUi?.cancel();
      this.ctrl.placing = null;
      this.ctrl.clearSelection();
    });
    this.cursors = this.input.keyboard?.createCursorKeys();
    this.wasd = this.input.keyboard?.addKeys("W,A,S,D") as typeof this.wasd;
    // Phaser re-dispatches its whole key queue when several key events land in one frame
    // (a modifier combo like Ctrl+1): act on each DOM event once
    const handled = new WeakSet<KeyboardEvent>();
    this.input.keyboard?.on("keydown", (e: KeyboardEvent) => {
      if (handled.has(e)) return;
      handled.add(e);
      if (e.key === "+" || e.key === "=") this.zoomBy(1.3);
      else if (e.key === "-" || e.key === "_") this.zoomBy(1 / 1.3);
      else if ((e.key === "p" || e.key === " ") && !this.holdStart) this.hud.togglePause();
      else if (e.key === "q") this.ctrl.selectArmy();
      else if (e.key === "Delete") this.ctrl.sellSelected();
      else if (e.key === ".") this.aware.cycleSpeed();
      else if (e.key === "j") this.aware.jump();
      else if (/^Digit[1-3]$/.test(e.code)) {
        // squads: 1–3 select (twice: fly there); Ctrl/Cmd/Shift + 1–3 save
        const save = e.ctrlKey || e.metaKey || e.shiftKey;
        if (save) e.preventDefault();
        this.command.key(Number(e.code.slice(5)) - 1, save);
      }
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


