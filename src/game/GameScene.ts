import Phaser from "phaser";
import { createAiState, tickAi, type AiState } from "../sim/ai/commander";
import { BUILDINGS, ECONOMY, TICK_RATE, UNITS } from "../sim/balance";
import { canPlaceBuilding } from "../sim/economy";
import { Vis } from "../sim/fog";
import { createSkirmishWorld } from "../sim/map";
import { step } from "../sim/sim";
import { Terrain, type Building, type Unit, type World } from "../sim/types";
import { buildingCenter, hqOf } from "../sim/world";
import {
  T_GROUND,
  T_ROCK,
  T_SCRAP_EMPTY,
  T_SCRAP_FULL,
  T_SCRAP_HALF,
  TILE,
  buildingTex,
  facingFrame,
  loadAssets,
  unitTex
} from "./assets";
import { Controller, PLAYER, hitTest } from "./controller";
import { GestureRecognizer } from "./gestures";
import { createHud, type Hud } from "../ui/hud";

const TICK_MS = 1000 / TICK_RATE;
const AIR_LIFT_PX = 8;

interface EntityView {
  body: Phaser.GameObjects.Sprite;
  shadow?: Phaser.GameObjects.Image;
  head?: Phaser.GameObjects.Sprite; // turret
}

export class GameScene extends Phaser.Scene {
  world!: World;
  ctrl!: Controller;
  private ai!: AiState;
  private acc = 0;
  private prev = new Map<number, { x: number; y: number }>();
  private views = new Map<number, EntityView>();
  private overlay!: Phaser.GameObjects.Graphics;
  private fogTex!: Phaser.Textures.CanvasTexture;
  private tileLayer!: Phaser.Tilemaps.TilemapLayer;
  private lastScrapFrame!: Uint8Array;
  private gest!: GestureRecognizer;
  private boxRect: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private hud!: Hud;
  private ended = false;
  private startedAt = 0;

  constructor() {
    super("game");
  }

  preload(): void {
    loadAssets(this.load);
  }

  create(): void {
    this.world = createSkirmishWorld();
    this.ctrl = new Controller(this.world);
    this.ai = createAiState();
    this.startedAt = this.time.now;

    this.createTerrain();
    this.createFog();
    this.overlay = this.add.graphics().setDepth(8);

    this.anims.create({
      key: "explode",
      frames: this.anims.generateFrameNumbers("fx-explosion", { start: 0, end: 5 }),
      frameRate: 15,
      hideOnComplete: true
    });

    const cam = this.cameras.main;
    cam.setBounds(0, 0, this.world.width * TILE, this.world.height * TILE);
    const hq = hqOf(this.world, PLAYER)!;
    const c = buildingCenter(hq);
    cam.centerOn(c.x * TILE, c.y * TILE);
    this.clampZoom();
    this.scale.on("resize", () => this.clampZoom());

    this.setupInput();
    this.hud = createHud({
      world: this.world,
      ctrl: this.ctrl,
      camera: cam,
      centerCamera: (wx, wy) => cam.centerOn(wx * TILE, wy * TILE),
      matchSeconds: () => (this.time.now - this.startedAt) / 1000
    });

    this.events.on(Phaser.Scenes.Events.SHUTDOWN, () => this.hud.destroy());

    // debug/testing handle (harmless in production)
    (window as unknown as Record<string, unknown>).__bd = {
      world: this.world,
      ctrl: this.ctrl,
      cam
    };
  }

  override update(_time: number, delta: number): void {
    this.gest.tick(performance.now());

    this.acc += Math.min(delta, 250);
    while (this.acc >= TICK_MS) {
      this.acc -= TICK_MS;
      this.snapshotPrev();
      const cmds = [...this.ctrl.drainCommands(), ...tickAi(this.world, "red", this.ai)];
      step(this.world, cmds);
      this.afterTick();
    }
    this.ctrl.prune();
    const alpha = this.acc / TICK_MS;
    this.syncSprites(alpha);
    this.drawOverlay(alpha);
    this.hud.update();

    if (this.world.winner && !this.ended) {
      this.ended = true;
      this.hud.showEnd(this.world.winner);
    }
  }

  // ------------------------------------------------------------ terrain ---

  private createTerrain(): void {
    const w = this.world;
    const data: number[][] = [];
    for (let ty = 0; ty < w.height; ty++) {
      const row: number[] = [];
      for (let tx = 0; tx < w.width; tx++) {
        const t = w.terrain[ty * w.width + tx];
        if (t === Terrain.Rock) row.push(T_ROCK[(tx + ty) % 2]!);
        else if (t === Terrain.Scrap) row.push(T_SCRAP_FULL);
        else row.push(T_GROUND[(tx * 7 + ty * 13) % 3]!);
      }
      data.push(row);
    }
    const map = this.make.tilemap({ data, tileWidth: TILE, tileHeight: TILE });
    const tiles = map.addTilesetImage("terrain")!;
    this.tileLayer = map.createLayer(0, tiles, 0, 0)!.setDepth(0);
    this.lastScrapFrame = new Uint8Array(w.width * w.height).fill(255);
  }

  private updateScrapTiles(): void {
    const w = this.world;
    for (let i = 0; i < w.terrain.length; i++) {
      if (w.terrain[i] !== Terrain.Scrap) continue;
      const ratio = w.scrap[i]! / ECONOMY.scrapPerTile;
      const frame = ratio > 0.5 ? T_SCRAP_FULL : ratio > 0 ? T_SCRAP_HALF : T_SCRAP_EMPTY;
      if (this.lastScrapFrame[i] !== frame) {
        this.lastScrapFrame[i] = frame;
        this.tileLayer.putTileAt(frame, i % w.width, Math.floor(i / w.width));
      }
    }
  }

  // ---------------------------------------------------------------- fog ---

  private createFog(): void {
    const w = this.world;
    this.fogTex = this.textures.createCanvas("fog", w.width, w.height)!;
    this.add
      .image(0, 0, "fog")
      .setOrigin(0)
      .setScale(TILE)
      .setDepth(10)
      .setAlpha(1);
    this.redrawFog();
  }

  private redrawFog(): void {
    const w = this.world;
    const ctx = this.fogTex.getContext();
    const img = ctx.createImageData(w.width, w.height);
    const vis = w.fog[PLAYER].vis;
    for (let i = 0; i < vis.length; i++) {
      const o = i * 4;
      img.data[o] = 8;
      img.data[o + 1] = 10;
      img.data[o + 2] = 16;
      img.data[o + 3] = vis[i] === Vis.Visible ? 0 : vis[i] === Vis.Explored ? 115 : 255;
    }
    ctx.putImageData(img, 0, 0);
    this.fogTex.refresh();
  }

  // ------------------------------------------------------------- sim glue --

  private snapshotPrev(): void {
    this.prev.clear();
    for (const u of this.world.units.values()) this.prev.set(u.id, { x: u.x, y: u.y });
  }

  private afterTick(): void {
    this.updateScrapTiles();
    if (this.world.tick % 3 === 1) this.redrawFog();
    for (const fx of this.world.fx) {
      if (fx.type === "shot") this.spawnShot(fx.x, fx.y, fx.tx!, fx.ty!);
      else this.spawnExplosion(fx.x, fx.y);
    }
  }

  private spawnShot(x: number, y: number, tx: number, ty: number): void {
    const sx = x * TILE;
    const sy = y * TILE;
    const angle = Math.atan2(tx - x, -(ty - y));
    const bolt = this.add
      .image(sx, sy, "fx-bolt")
      .setRotation(angle)
      .setDepth(7)
      .setAlpha(0.9);
    this.tweens.add({
      targets: bolt,
      x: tx * TILE,
      y: ty * TILE,
      duration: 90,
      onComplete: () => bolt.destroy()
    });
    const muzzle = this.add.image(sx, sy, "fx-muzzle").setDepth(7);
    this.time.delayedCall(60, () => muzzle.destroy());
  }

  private spawnExplosion(x: number, y: number): void {
    this.add.sprite(x * TILE, y * TILE, "fx-explosion").setDepth(7).play("explode");
  }

  // -------------------------------------------------------------- render ---

  private syncSprites(alpha: number): void {
    const w = this.world;
    const seen = new Set<number>();

    for (const u of w.units.values()) {
      seen.add(u.id);
      let v = this.views.get(u.id);
      const air = UNITS[u.kind].domain === "air";
      if (!v) {
        const body = this.add.sprite(0, 0, unitTex(u.faction, u.kind)).setDepth(air ? 6 : 3);
        v = { body };
        if (air) v.shadow = this.add.image(0, 0, "shadow").setDepth(4).setAlpha(0.6);
        this.views.set(u.id, v);
      }
      const p = this.prev.get(u.id) ?? u;
      const x = (p.x + (u.x - p.x) * alpha) * TILE;
      const y = (p.y + (u.y - p.y) * alpha) * TILE;
      let frame = facingFrame(u.facing);
      if (u.kind === "harvester" && u.cargo >= ECONOMY.harvesterCapacity / 2) frame += 8;
      v.body.setPosition(x, y - (air ? AIR_LIFT_PX : 0)).setFrame(frame);
      v.shadow?.setPosition(x, y);
      // hide enemies inside the player's fog
      const visible = u.faction === PLAYER || this.tileVisible(u.x, u.y);
      v.body.setVisible(visible);
      v.shadow?.setVisible(visible);
    }

    for (const b of w.buildings.values()) {
      seen.add(b.id);
      let v = this.views.get(b.id);
      const size = BUILDINGS[b.kind].size;
      const cx = (b.tx + size / 2) * TILE;
      const cy = (b.ty + size / 2) * TILE;
      if (!v) {
        if (b.kind === "turret") {
          const body = this.add.sprite(cx, cy, `b-${b.faction}-turret-base`).setDepth(2);
          const head = this.add.sprite(cx, cy, `b-${b.faction}-turret-head`).setDepth(2.1);
          v = { body, head };
        } else {
          v = { body: this.add.sprite(cx, cy, buildingTex(b.faction, b.kind)).setDepth(2) };
        }
        this.views.set(b.id, v);
      }
      if (b.kind === "turret") v.head!.setFrame(facingFrame(b.facing));
      else v.body.setFrame(b.hp <= BUILDINGS[b.kind].hp / 2 ? 1 : 0);
      const visible =
        b.faction === PLAYER ||
        this.world.fog[PLAYER].known.has(b.id) ||
        this.tileVisible(b.tx + size / 2, b.ty + size / 2);
      v.body.setVisible(visible);
      v.head?.setVisible(visible);
    }

    // removals: rubble for buildings, cleanup for units
    for (const [id, v] of this.views) {
      if (seen.has(id)) continue;
      const wasBuilding = v.head !== undefined || v.body.texture.key.startsWith("b-");
      if (wasBuilding && !v.head) {
        this.add
          .image(v.body.x, v.body.y, v.body.texture.key, 2)
          .setDepth(1)
          .setAlpha(0.9);
      }
      v.body.destroy();
      v.shadow?.destroy();
      v.head?.destroy();
      this.views.delete(id);
    }
  }

  private tileVisible(x: number, y: number): boolean {
    const w = this.world;
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= w.width || ty >= w.height) return false;
    return w.fog[PLAYER].vis[ty * w.width + tx] === Vis.Visible;
  }

  private drawOverlay(alpha: number): void {
    const g = this.overlay;
    g.clear();
    const w = this.world;

    // selection rings
    for (const id of this.ctrl.selectedUnits) {
      const u = w.units.get(id);
      if (!u) continue;
      const p = this.prev.get(id) ?? u;
      const x = (p.x + (u.x - p.x) * alpha) * TILE;
      const y = (p.y + (u.y - p.y) * alpha) * TILE;
      g.lineStyle(2, 0x7ef29b, 0.9).strokeCircle(x, y, 13);
    }
    if (this.ctrl.selectedBuilding !== null) {
      const b = w.buildings.get(this.ctrl.selectedBuilding);
      if (b) {
        const size = BUILDINGS[b.kind].size;
        g.lineStyle(2, 0x7ef29b, 0.9).strokeRect(
          b.tx * TILE + 2, b.ty * TILE + 2, size * TILE - 4, size * TILE - 4
        );
        if (b.rally)
          g.lineStyle(2, 0xffe066, 0.9)
            .strokeCircle(b.rally.x * TILE, b.rally.y * TILE, 6)
            .lineBetween(
              (b.tx + size / 2) * TILE, (b.ty + size / 2) * TILE,
              b.rally.x * TILE, b.rally.y * TILE
            );
      }
    }

    // health bars (damaged or selected)
    for (const u of w.units.values()) {
      const max = UNITS[u.kind].hp;
      if (u.hp >= max && !this.ctrl.selectedUnits.has(u.id)) continue;
      if (u.faction !== PLAYER && !this.tileVisible(u.x, u.y)) continue;
      const p = this.prev.get(u.id) ?? u;
      const x = (p.x + (u.x - p.x) * alpha) * TILE;
      const y = (p.y + (u.y - p.y) * alpha) * TILE;
      this.healthBar(g, x - 12, y - 22, 24, u.hp / max, u.faction === PLAYER);
    }
    for (const b of w.buildings.values()) {
      const max = BUILDINGS[b.kind].hp;
      if (b.hp >= max && this.ctrl.selectedBuilding !== b.id) continue;
      const size = BUILDINGS[b.kind].size;
      const visible =
        b.faction === PLAYER || this.tileVisible(b.tx + size / 2, b.ty + size / 2);
      if (!visible) continue;
      this.healthBar(
        g,
        b.tx * TILE + 2,
        b.ty * TILE - 6,
        size * TILE - 4,
        b.hp / max,
        b.faction === PLAYER
      );
    }

    // placement ghost under the pointer
    if (this.ctrl.placing && this.world.factions[PLAYER].pending?.ready) {
      const kind = this.ctrl.placing;
      const size = BUILDINGS[kind].size;
      const pointer = this.input.activePointer;
      const wp = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
      const tx = Math.round(wp.x / TILE - size / 2);
      const ty = Math.round(wp.y / TILE - size / 2);
      const ok = canPlaceBuilding(w, PLAYER, kind, tx, ty);
      g.fillStyle(ok ? 0x37d67a : 0xe25555, 0.35).fillRect(
        tx * TILE, ty * TILE, size * TILE, size * TILE
      );
      g.lineStyle(2, ok ? 0x37d67a : 0xe25555, 0.9).strokeRect(
        tx * TILE, ty * TILE, size * TILE, size * TILE
      );
    }

    // box-select rectangle
    if (this.boxRect) {
      const cam = this.cameras.main;
      const a = cam.getWorldPoint(this.boxRect.x0, this.boxRect.y0);
      const b = cam.getWorldPoint(this.boxRect.x1, this.boxRect.y1);
      g.lineStyle(1.5, 0x7ef29b, 0.9).strokeRect(
        Math.min(a.x, b.x), Math.min(a.y, b.y),
        Math.abs(b.x - a.x), Math.abs(b.y - a.y)
      );
      g.fillStyle(0x7ef29b, 0.08).fillRect(
        Math.min(a.x, b.x), Math.min(a.y, b.y),
        Math.abs(b.x - a.x), Math.abs(b.y - a.y)
      );
    }
  }

  private healthBar(
    g: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    width: number,
    ratio: number,
    friendly: boolean
  ): void {
    g.fillStyle(0x10141c, 0.8).fillRect(x, y, width, 4);
    g.fillStyle(friendly ? 0x53d769 : 0xe25555, 1).fillRect(
      x + 1, y + 1, Math.max(0, (width - 2) * ratio), 2
    );
  }

  // --------------------------------------------------------------- input ---

  private setupInput(): void {
    const cam = this.cameras.main;
    this.gest = new GestureRecognizer({
      onTap: (sx, sy) => {
        const wp = cam.getWorldPoint(sx, sy);
        const wx = wp.x / TILE;
        const wy = wp.y / TILE;
        const radius = Math.max(0.65, 22 / (TILE * cam.zoom));
        this.ctrl.tapWorld(wx, wy, hitTest(this.world, wx, wy, radius));
      },
      onDoubleTap: (sx, sy) => {
        const wp = cam.getWorldPoint(sx, sy);
        const wx = wp.x / TILE;
        const wy = wp.y / TILE;
        const radius = Math.max(0.65, 22 / (TILE * cam.zoom));
        const hit = hitTest(this.world, wx, wy, radius);
        if (hit.kind !== "ownUnit") return;
        const kind = this.world.units.get(hit.id)?.kind;
        const view = cam.worldView;
        const ids = [...this.world.units.values()]
          .filter(
            (u) =>
              u.faction === PLAYER &&
              u.kind === kind &&
              view.contains(u.x * TILE, u.y * TILE)
          )
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
        this.boxRect.x1 = sx;
        this.boxRect.y1 = sy;
        const a = cam.getWorldPoint(this.boxRect.x0, this.boxRect.y0);
        const b = cam.getWorldPoint(this.boxRect.x1, this.boxRect.y1);
        this.boxRect = null;
        const x0 = Math.min(a.x, b.x) / TILE;
        const y0 = Math.min(a.y, b.y) / TILE;
        const x1 = Math.max(a.x, b.x) / TILE;
        const y1 = Math.max(a.y, b.y) / TILE;
        const ids = [...this.world.units.values()]
          .filter(
            (u) =>
              u.faction === PLAYER && u.x >= x0 && u.x <= x1 && u.y >= y0 && u.y <= y1
          )
          .map((u) => u.id);
        if (ids.length > 0) this.ctrl.selectUnits(ids);
      },
      onPan: (dx, dy) => {
        cam.scrollX -= dx / cam.zoom;
        cam.scrollY -= dy / cam.zoom;
      },
      onPinch: (scale, cx, cy) => this.zoomAround(cam.zoom * scale, cx, cy),
      onRightClick: (sx, sy) => {
        const wp = cam.getWorldPoint(sx, sy);
        const wx = wp.x / TILE;
        const wy = wp.y / TILE;
        const radius = Math.max(0.65, 22 / (TILE * cam.zoom));
        let hit = hitTest(this.world, wx, wy, radius);
        // right-click never re-selects; own entities count as ground
        if (hit.kind === "ownUnit" || hit.kind === "ownBuilding") hit = { kind: "ground" };
        this.ctrl.tapWorld(wx, wy, hit);
      },
      onWheel: (deltaY, sx, sy) =>
        this.zoomAround(cam.zoom * (deltaY > 0 ? 0.87 : 1.15), sx, sy)
    });

    const toPointer = (p: Phaser.Input.Pointer) => ({
      id: p.id,
      x: p.x,
      y: p.y,
      pointerType: ((p.event as PointerEvent)?.pointerType ?? "mouse") as
        | "touch"
        | "mouse"
        | "pen",
      button: (p.event as PointerEvent)?.button ?? 0
    });
    this.input.on("pointerdown", (p: Phaser.Input.Pointer) =>
      this.gest.down(toPointer(p), performance.now())
    );
    this.input.on("pointermove", (p: Phaser.Input.Pointer) =>
      this.gest.move(toPointer(p), performance.now())
    );
    const up = (p: Phaser.Input.Pointer) => this.gest.up(toPointer(p), performance.now());
    this.input.on("pointerup", up);
    this.input.on("pointerupoutside", up);
    this.input.on(
      "wheel",
      (p: Phaser.Input.Pointer, _o: unknown, _dx: number, dy: number) =>
        this.gest.wheel(dy, p.x, p.y)
    );
    this.input.keyboard?.on("keydown-ESC", () => {
      this.ctrl.placing = null;
      this.ctrl.clearSelection();
    });
  }

  private zoomAround(zoom: number, sx: number, sy: number): void {
    const cam = this.cameras.main;
    const before = cam.getWorldPoint(sx, sy);
    cam.setZoom(this.clampedZoom(zoom));
    const after = cam.getWorldPoint(sx, sy);
    cam.scrollX += before.x - after.x;
    cam.scrollY += before.y - after.y;
  }

  private clampedZoom(z: number): number {
    const cam = this.cameras.main;
    const minZoom = Math.max(
      cam.width / (this.world.width * TILE),
      cam.height / (this.world.height * TILE)
    );
    return Phaser.Math.Clamp(z, Math.max(minZoom, 0.5), 3);
  }

  private clampZoom(): void {
    const cam = this.cameras.main;
    cam.setZoom(this.clampedZoom(cam.zoom));
  }
}

export type { Unit, Building };
