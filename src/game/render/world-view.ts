import Phaser from "phaser";
import { ECONOMY } from "../../sim/balance";
import { Vis } from "../../sim/fog";
import { Terrain, type Faction, type World } from "../../sim/types";
import { ART_SCALE, ATLAS, TERRAIN_CHUNK, TERRAIN_PX, TILE, terrainChunks } from "../assets";

/** Fallback flat colours per terrain (used only if painted terrain is missing). */
const FALLBACK: Record<number, number> = {
  [Terrain.Ground]: 0x5b6b3a, [Terrain.Rock]: 0x55565c, [Terrain.Scrap]: 0x4b4234,
  [Terrain.Water]: 0x1f4f6b, [Terrain.Road]: 0x6b6962, [Terrain.Rough]: 0x5a4a35,
  [Terrain.Forest]: 0x2f4a24, [Terrain.Crystal]: 0x3f5a44, [Terrain.Bridge]: 0x7a6a55,
  [Terrain.Shallows]: 0x3f7a8a
};

interface Pile {
  img: Phaser.GameObjects.Image;
  glow?: Phaser.GameObjects.Image;
  base: number;
  crystal: boolean;
  lastRatio: number;
}

/**
 * Phaser gives power-of-two textures REPEAT wrapping, so bilinear sampling
 * at a terrain chunk's edge bleeds in the opposite edge — a visible seam.
 * Re-apply the texture with CLAMP_TO_EDGE through Phaser's wrapper (which
 * also remembers it for WebGL context restores).
 */
function clampEdges(scene: Phaser.Scene, key: string): void {
  const renderer = scene.game.renderer;
  if (!(renderer instanceof Phaser.Renderer.WebGL.WebGLRenderer)) return;
  const tex = scene.textures.get(key).source[0]?.glTexture;
  if (!tex) return;
  const gl = renderer.gl;
  tex.update(
    tex.pixels ?? undefined, tex.width, tex.height, tex.flipY,
    gl.CLAMP_TO_EDGE, gl.CLAMP_TO_EDGE, tex.minFilter, tex.magFilter, tex.format
  );
}

/** Deterministic per-tile pseudo-random in [0, 1). */
const rnd = (i: number, k: number) => {
  const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453;
  return x - Math.floor(x);
};

export class WorldView {
  private piles = new Map<number, Pile>();
  private fogTex: Phaser.Textures.CanvasTexture;
  private fogImg: Phaser.GameObjects.Image;
  private fogCur: Float32Array;
  private fogData: ImageData;
  private time = 0;

  constructor(private scene: Phaser.Scene, private world: World, private player: Faction) {
    this.createTerrain();
    this.createPiles();
    const w = world;
    // fog: one texel per tile, bilinear-filtered up to soft edges
    this.fogTex = scene.textures.createCanvas(`fog-${Date.now()}`, w.width + 2, w.height + 2)!;
    this.fogData = this.fogTex.getContext().createImageData(w.width + 2, w.height + 2);
    this.fogCur = new Float32Array((w.width + 2) * (w.height + 2)).fill(1);
    this.fogImg = scene.add
      .image(-TILE, -TILE, this.fogTex.key)
      .setOrigin(0)
      .setScale(TILE)
      .setDepth(10);
  }

  private createTerrain(): void {
    const s = this.scene;
    const n = terrainChunks(this.world.width);
    const scale = TILE / TERRAIN_PX;
    let missing = 0;
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++) {
        const key = `terrain-${c}-${r}`;
        if (!s.textures.exists(key)) {
          missing++;
          continue;
        }
        const src = s.textures.get(key).getSourceImage();
        clampEdges(s, key);
        // overlap neighbours by a world pixel: fractional chunk positions
        // can otherwise leave hairline seams where the background shows
        s.add
          .image(c * TERRAIN_CHUNK * scale, r * TERRAIN_CHUNK * scale, key)
          .setOrigin(0)
          .setDisplaySize(src.width * scale + 1.5, src.height * scale + 1.5)
          .setDepth(0);
      }
    if (missing > 0) this.fallbackTerrain();
    this.edgeShadow();
  }

  /** Soft inner shadow along the map border so the edge reads as deliberate. */
  private edgeShadow(): void {
    const W = this.world.width * TILE;
    const H = this.world.height * TILE;
    const d = TILE * 1.6;
    const g = this.scene.add.graphics().setDepth(0.5);
    const c = 0x05070c;
    g.fillGradientStyle(c, c, c, c, 0.75, 0.75, 0, 0).fillRect(0, 0, W, d);
    g.fillGradientStyle(c, c, c, c, 0, 0, 0.75, 0.75).fillRect(0, H - d, W, d);
    g.fillGradientStyle(c, c, c, c, 0.75, 0, 0.75, 0).fillRect(0, 0, d, H);
    g.fillGradientStyle(c, c, c, c, 0, 0.75, 0, 0.75).fillRect(W - d, 0, d, H);
    g.lineStyle(3, 0x8fb3ff, 0.18).strokeRect(0, 0, W, H);
  }

  /** Flat-colour terrain so the game stays playable without painted art. */
  private fallbackTerrain(): void {
    const w = this.world;
    const g = this.scene.add.graphics().setDepth(0.01);
    for (let ty = 0; ty < w.height; ty++)
      for (let tx = 0; tx < w.width; tx++) {
        const t = w.terrain[ty * w.width + tx]!;
        const shade = 0.92 + rnd(ty * w.width + tx, 3) * 0.16;
        const col = Phaser.Display.Color.IntegerToColor(FALLBACK[t] ?? 0x555555);
        g.fillStyle(
          Phaser.Display.Color.GetColor(
            Math.min(255, col.red * shade), Math.min(255, col.green * shade), Math.min(255, col.blue * shade)
          ),
          1
        );
        g.fillRect(tx * TILE, ty * TILE, TILE, TILE);
      }
  }

  private createPiles(): void {
    const w = this.world;
    for (let i = 0; i < w.terrain.length; i++) {
      const t = w.terrain[i];
      if (t !== Terrain.Scrap && t !== Terrain.Crystal) continue;
      const crystal = t === Terrain.Crystal;
      const tx = i % w.width;
      const ty = Math.floor(i / w.width);
      const x = (tx + 0.5 + (rnd(i, 1) - 0.5) * 0.25) * TILE;
      const y = (ty + 0.5 + (rnd(i, 2) - 0.5) * 0.25) * TILE;
      const base = ART_SCALE * (0.95 + rnd(i, 4) * 0.25);
      const img = this.scene.add
        .image(x, y, ATLAS, `${crystal ? "crystal" : "scrap"}/${Math.floor(rnd(i, 5) * 6)}`)
        .setDepth(1.5)
        .setScale(base)
        .setRotation(rnd(i, 6) * Math.PI * 2);
      const pile: Pile = { img, base, crystal, lastRatio: 1 };
      if (crystal)
        pile.glow = this.scene.add
          .image(x, y, "fx-glow")
          .setDepth(1.55)
          .setScale(1.3)
          .setTint(0x4dff9a)
          .setAlpha(0.25)
          .setBlendMode(Phaser.BlendModes.ADD);
      this.piles.set(i, pile);
    }
  }

  /** Per-frame: resource depletion, crystal shimmer, fog fade. */
  update(dtMs: number, showFog: boolean): void {
    this.time += dtMs;
    const w = this.world;
    for (const [i, p] of this.piles) {
      const full = p.crystal ? ECONOMY.crystalPerTile : ECONOMY.scrapPerTile;
      const ratio = w.scrap[i]! / full;
      if (Math.abs(ratio - p.lastRatio) > 0.02 || (ratio === 0 && p.lastRatio !== 0)) {
        p.lastRatio = ratio;
        p.img.setScale(p.base * (0.45 + 0.55 * Math.sqrt(ratio)));
        p.img.setAlpha(ratio > 0 ? 1 : 0);
        p.glow?.setVisible(ratio > 0);
      }
      if (p.glow && ratio > 0) p.glow.setAlpha(0.18 + 0.1 * Math.sin(this.time / 500 + i));
    }
    if (this.clouds) {
      this.clouds.tilePositionX -= dtMs * 0.004;
      this.clouds.tilePositionY -= dtMs * 0.0016;
    }
    this.fogImg.setVisible(showFog);
    if (showFog) this.updateFog(dtMs);
  }

  private clouds: Phaser.GameObjects.TileSprite | null = null;

  /** Slow cloud shadows drifting over the ground (under aircraft). */
  createClouds(): void {
    const W = this.world.width * TILE;
    const H = this.world.height * TILE;
    this.clouds = this.scene.add
      .tileSprite(0, 0, W, H, "fx-clouds")
      .setOrigin(0)
      .setTileScale(3.2)
      .setAlpha(this.world.biome === "volcanic" ? 0.55 : 0.4)
      .setDepth(5);
  }

  private fogAcc = 0;

  private updateFog(dtMs: number): void {
    this.fogAcc += dtMs;
    if (this.fogAcc < 40) return; // ~25 Hz is plenty for a soft fade
    const step = Math.min(1, this.fogAcc / 250);
    this.fogAcc = 0;
    const w = this.world;
    const vis = w.fog[this.player].vis;
    const W = w.width + 2;
    const d = this.fogData.data;
    for (let y = 0; y < w.height + 2; y++)
      for (let x = 0; x < W; x++) {
        const tx = x - 1;
        const ty = y - 1;
        const inside = tx >= 0 && ty >= 0 && tx < w.width && ty < w.height;
        const v = inside ? vis[ty * w.width + tx] : Vis.Unexplored;
        const target = v === Vis.Visible ? 0 : v === Vis.Explored ? 0.5 : 0.97;
        const i = y * W + x;
        const cur = this.fogCur[i]!;
        const next = cur + (target - cur) * step;
        this.fogCur[i] = next;
        const o = i * 4;
        d[o] = 6;
        d[o + 1] = 9;
        d[o + 2] = 16;
        d[o + 3] = Math.round(next * 255);
      }
    this.fogTex.getContext().putImageData(this.fogData, 0, 0);
    this.fogTex.refresh();
  }
}
