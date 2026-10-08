import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { ECONOMY } from "../../sim/balance";
import { Vis } from "../../sim/fog";
import { Terrain, type Biome, type Faction, type World } from "../../sim/types";
import { ModelBuilder } from "./builder";
import { fogged, fowUniforms, modelMat } from "./materials";
import { patchGround, patchLiquid, type GroundUniforms, type LiquidUniforms } from "./terrain-glsl";
import { cragGeometry, crystalGeos, scrapGeos, treeGeos, type CragSpot } from "./terrain-props";
import { PaintedColors, terrainNoise } from "./terrain-tex";
import { cloudTexture } from "./textures";

/**
 * The 3D battlefield. The map grid becomes a heightfield — rock outcrops
 * rise into craggy mesas, rivers and lava cut real channels, fords dip under
 * a shallow skin of water, rough ground buckles — and the painted terrain
 * art is draped over it as the albedo, so every map keeps its hand-painted
 * look with real relief, lighting and shadows. On top: animated water (or
 * lava, or an icy sea), bridges, instanced trees per biome, rock crags
 * coloured from the painted rock beneath, scrap heaps and glowing crystal
 * clusters that shrink as they're mined, drifting cloud shadows and the fog
 * of war. Past the map's edge the land carries on as a mirrored skirt that
 * dims and fades into the sky colour, so the world never ends in a void.
 */

/** Height of the water / lava surface. */
export const WATER_LEVEL = -0.12;
/** Lattice resolution: height samples per tile. */
const RES = 3;
/** How far the mirrored land runs past the map's edge (tiles); it has faded out by there. */
const SKIRT = 20;
/** Skirt grid lines past the lattice-fine first tile: coarser as it fades. */
const SKIRT_LINES = [1.5, 2, 2.5, 3, 4, 5, 6.5, 8, 10, 13, 16, SKIRT];

const TILE_H: Record<number, number> = {
  [Terrain.Ground]: 0,
  [Terrain.Road]: -0.02,
  [Terrain.Scrap]: 0.02,
  [Terrain.Crystal]: 0.02,
  [Terrain.Forest]: 0.03,
  [Terrain.Rough]: 0.05,
  [Terrain.Rock]: 0.95,
  [Terrain.Water]: -0.55,
  [Terrain.Bridge]: -0.55,
  [Terrain.Shallows]: -0.2
};
/** Extra noise relief by terrain (rock is craggy, rough ground lumpy). */
const TILE_NOISE: Record<number, number> = {
  [Terrain.Rock]: 0.55,
  [Terrain.Rough]: 0.07,
  [Terrain.Forest]: 0.04,
  [Terrain.Ground]: 0.025,
  [Terrain.Water]: 0.08
};

/** Flat colours per terrain, used only if the painted art is missing. */
const FALLBACK: Record<number, number> = {
  [Terrain.Ground]: 0x5b6b3a, [Terrain.Rock]: 0x55565c, [Terrain.Scrap]: 0x4b4234,
  [Terrain.Water]: 0x1f4f6b, [Terrain.Road]: 0x6b6962, [Terrain.Rough]: 0x5a4a35,
  [Terrain.Forest]: 0x2f4a24, [Terrain.Crystal]: 0x3f5a44, [Terrain.Bridge]: 0x7a6a55,
  [Terrain.Shallows]: 0x3f7a8a
};

interface BiomeLook {
  shallow: number;
  deep: number;
  /** 0 water, 1 lava, 2 icy sea. */
  liquid: number;
  rock: number;
  bridge: number;
  /** Steel bridge decks (else timber). */
  steel: boolean;
  /** Ground grain contrast, the grain's north-west emboss, sharpening of the paint. */
  detail: [number, number, number];
}

const LOOK: Record<Biome, BiomeLook> = {
  temperate: { shallow: 0x4fa8b8, deep: 0x123f5c, liquid: 0, rock: 0x7c7b77, bridge: 0x8a7a64, steel: false, detail: [0.22, 2.6, 0.55] },
  desert: { shallow: 0x5fd8d0, deep: 0x147a8a, liquid: 0, rock: 0xa45a3a, bridge: 0x9a8058, steel: false, detail: [0.2, 3.4, 0.7] },
  arctic: { shallow: 0x9fd0ea, deep: 0x0f2a44, liquid: 2, rock: 0x8a929e, bridge: 0x7c8590, steel: false, detail: [0.08, 1.8, 0.45] },
  volcanic: { shallow: 0xffd060, deep: 0xff4a10, liquid: 1, rock: 0x2e2b2a, bridge: 0x6c6660, steel: true, detail: [0.22, 2.6, 0.55] }
};

/** Deterministic hash → [0, 1). */
export const hash = (i: number, k: number) => {
  const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453;
  return x - Math.floor(x);
};

function valueNoise(x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const s = (t: number) => t * t * (3 - 2 * t);
  const h = (i: number, j: number) => hash(i * 157 + j * 311, 7);
  const a = h(x0, y0);
  const b = h(x0 + 1, y0);
  const c = h(x0, y0 + 1);
  const d = h(x0 + 1, y0 + 1);
  return a + (b - a) * s(fx) + (c - a) * s(fy) + (a - b - c + d) * s(fx) * s(fy);
}

function fbm(x: number, y: number): number {
  return valueNoise(x * 1.3, y * 1.3) * 0.55 + valueNoise(x * 2.9, y * 2.9) * 0.3 + valueNoise(x * 6.1, y * 6.1) * 0.15;
}

/** Reflect a coordinate back into [0, L] across the map's edge. */
const mirror = (v: number, L: number) => Math.min(L, Math.max(0, v < 0 ? -v : v > L ? 2 * L - v : v));

export interface TerrainArt {
  /** Painted chunks [row][col] (null = failed to load). */
  chunks: (THREE.Texture | null)[][];
  /** Painted px per tile and chunk size (px). */
  pxPerTile: number;
  chunk: number;
}

interface Pile {
  tile: number;
  mesh: THREE.InstancedMesh;
  slot: number;
  matrix: THREE.Matrix4;
  base: number;
  crystal: boolean;
  lastRatio: number;
  x: number;
  y: number;
  h: number;
  rot: number;
}

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class Terrain3D {
  readonly group = new THREE.Group();
  private W: number;
  private H: number;
  /** Height lattice, (W*RES+1) × (H*RES+1). */
  private lat: Float32Array;
  private latW: number;
  private fogTex: THREE.DataTexture;
  private fogCur: Float32Array;
  private fogBlur: Float32Array;
  private fogData: Uint8Array;
  private fogAcc = 0;
  private piles: Pile[] = [];
  private waterTime = { value: 0 };
  /** Shared by the ground and liquid shaders: noise, and the sky colour the skirt fades into. */
  private edge = {
    uTNoise: { value: terrainNoise() as THREE.Texture | null },
    uFarColor: { value: new THREE.Color(0x070a10) },
    uSkirt: { value: SKIRT }
  };
  private cloud = new THREE.Vector2();
  private time = 0;
  readonly look: BiomeLook;

  constructor(private world: World, private player: Faction, art: TerrainArt | null) {
    this.W = world.width;
    this.H = world.height;
    this.look = LOOK[world.biome];
    this.latW = this.W * RES + 1;
    this.lat = new Float32Array(this.latW * (this.H * RES + 1));
    this.buildLattice();
    this.buildGround(art);
    this.buildWater();
    this.buildBridges();
    this.buildTrees();
    this.buildRocks(art ? new PaintedColors(this.W, this.H, art.chunks, art.pxPerTile, art.chunk) : null);
    this.buildPiles();

    // fog: one texel per tile (plus a border), linearly filtered into soft edges
    const fw = this.W + 2;
    const fh = this.H + 2;
    this.fogData = new Uint8Array(fw * fh).fill(255);
    this.fogCur = new Float32Array(fw * fh).fill(1);
    this.fogBlur = new Float32Array(fw * fh);
    this.fogTex = new THREE.DataTexture(this.fogData, fw, fh, THREE.RedFormat, THREE.UnsignedByteType);
    this.fogTex.magFilter = THREE.LinearFilter;
    this.fogTex.minFilter = THREE.LinearFilter;
    this.fogTex.needsUpdate = true;
    fowUniforms.uFowMap.value = this.fogTex;
    fowUniforms.uFowSize.value.set(fw, fh);
    const clouds = cloudTexture();
    fowUniforms.uCloudMap.value = clouds;
    fowUniforms.uCloudK.value = world.biome === "volcanic" ? 0.4 : world.biome === "arctic" ? 0.22 : 0.3;
  }

  // ---------------------------------------------------------- heights --

  private tile(tx: number, ty: number): number {
    const x = Math.min(this.W - 1, Math.max(0, tx));
    const y = Math.min(this.H - 1, Math.max(0, ty));
    return this.world.terrain[y * this.W + x]!;
  }

  /** The analytic height: tile heights blended over ~a tile, plus terrain-weighted noise. */
  private heightFn(x: number, z: number): number {
    const R = 0.95;
    let sum = 0;
    let wsum = 0;
    let noise = 0;
    const tx0 = Math.floor(x - R - 0.5);
    const ty0 = Math.floor(z - R - 0.5);
    for (let ty = ty0; ty <= Math.floor(z + R); ty++)
      for (let tx = tx0; tx <= Math.floor(x + R); tx++) {
        const d = Math.hypot(tx + 0.5 - x, ty + 0.5 - z);
        if (d >= R) continue;
        const w = (1 - d / R) * (1 - d / R);
        const t = this.tile(tx, ty);
        sum += (TILE_H[t] ?? 0) * w;
        noise += (TILE_NOISE[t] ?? 0.02) * w;
        wsum += w;
      }
    if (wsum <= 0) return 0;
    const base = sum / wsum;
    const amp = noise / wsum;
    return base + (fbm(x, z) - 0.45) * amp * 2;
  }

  private buildLattice(): void {
    const rows = this.H * RES + 1;
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < this.latW; i++) this.lat[j * this.latW + i] = this.heightFn(i / RES, j / RES);
  }

  /** Terrain surface height at tile point (x, y) (bilinear on the lattice). */
  heightAt(x: number, y: number): number {
    const fx = Math.min(this.W, Math.max(0, x)) * RES;
    const fy = Math.min(this.H, Math.max(0, y)) * RES;
    const i = Math.min(this.latW - 2, Math.floor(fx));
    const j = Math.min(this.H * RES - 1, Math.floor(fy));
    const u = fx - i;
    const v = fy - j;
    const L = this.lat;
    const W = this.latW;
    const a = L[j * W + i]!;
    const b = L[j * W + i + 1]!;
    const c = L[(j + 1) * W + i]!;
    const d = L[(j + 1) * W + i + 1]!;
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }

  /** The land's height anywhere, the skirt past the edge included (the map mirrored). */
  private landAt(x: number, z: number): number {
    return this.heightAt(mirror(x, this.W), mirror(z, this.H));
  }

  /** Where a ground vehicle rides: the deck on bridges, else the terrain (fords sink a little). */
  groundAt(x: number, y: number, hover = false): number {
    const t = this.tile(Math.floor(x), Math.floor(y));
    if (t === Terrain.Bridge) return 0.02;
    const h = this.heightAt(x, y);
    return hover ? Math.max(h, WATER_LEVEL) : h;
  }

  /** Height for things that sit ON the surface (decals, rings): water counts as a floor. */
  surfaceAt(x: number, y: number): number {
    const t = this.tile(Math.floor(x), Math.floor(y));
    if (t === Terrain.Bridge) return 0.02;
    return Math.max(this.heightAt(x, y), WATER_LEVEL);
  }

  // ----------------------------------------------------------- ground --

  /**
   * Grid lines along one axis of length L: the lattice inside the map, the
   * skirt outside (fine near the edge, coarse further out), plus the mirror
   * images of chunk seams so no skirt cell straddles two painted chunks.
   */
  private lines(L: number, chunkTiles: number): number[] {
    const out: number[] = [];
    for (let i = 0; i <= L * RES; i++) out.push(i / RES);
    const far = [...Array.from({ length: RES }, (_, k) => (k + 1) / RES), ...SKIRT_LINES];
    for (let s = chunkTiles; s < L; s += chunkTiles) far.push(s, L - s);
    for (const d of far)
      if (d > 0 && d <= SKIRT) out.push(-d, L + d);
    out.sort((a, b) => a - b);
    return out.filter((v, i) => i === 0 || v - out[i - 1]! > 1e-4);
  }

  private buildGround(art: TerrainArt | null): void {
    const L = this.look;
    const uniforms: GroundUniforms = { ...this.edge, uDetail: { value: new THREE.Vector3(...L.detail) } };
    const groundMat = <T extends THREE.Material>(m: T) => fogged(m, { key: "ground", also: (s) => patchGround(s, uniforms) });
    const px = art?.pxPerTile ?? 48;
    const size = art ? art.chunk / px : Math.max(this.W, this.H); // tiles per chunk
    const nC = art ? art.chunks[0]?.length ?? 1 : 1;
    const nR = art ? art.chunks.length : 1;
    const xs = this.lines(this.W, size);
    const zs = this.lines(this.H, size);
    const NX = xs.length;

    // one mesh per painted chunk: its own cells inside the map, plus the skirt cells mirrored from it
    interface Acc { idx: number[]; pos: number[]; nor: number[]; uv: number[]; col: number[]; map: Int32Array | null; tex: THREE.Texture | null; x0: number; z0: number; w: number; h: number }
    const accs: Acc[] = [];
    for (let r = 0; r < nR; r++)
      for (let c = 0; c < nC; c++) {
        const tex = art?.chunks[r]?.[c] ?? null;
        const img = tex?.image as { width: number; height: number } | undefined;
        accs.push({ idx: [], pos: [], nor: [], uv: [], col: [], map: null, tex, x0: c * size, z0: r * size, w: img?.width ?? 1, h: img?.height ?? 1 });
      }
    // heights and normals per grid point, worked out once however many chunks share the point
    const NV = NX * zs.length;
    const hgt = new Float32Array(NV * 4).fill(NaN);
    const fc = new THREE.Color();
    const e = 0.12;
    const vert = (a: Acc, i: number, j: number): number => {
      const key = j * NX + i;
      a.map ??= new Int32Array(NV).fill(-1);
      const have = a.map[key]!;
      if (have >= 0) return have;
      const k = a.pos.length / 3;
      a.map[key] = k;
      const x = xs[i]!;
      const z = zs[j]!;
      if (Number.isNaN(hgt[key * 4])) {
        const dx = this.landAt(x + e, z) - this.landAt(x - e, z);
        const dz = this.landAt(x, z + e) - this.landAt(x, z - e);
        const inv = 1 / Math.hypot(dx / (2 * e), 1, dz / (2 * e));
        hgt[key * 4] = this.landAt(x, z);
        hgt[key * 4 + 1] = (-dx / (2 * e)) * inv;
        hgt[key * 4 + 2] = inv;
        hgt[key * 4 + 3] = (-dz / (2 * e)) * inv;
      }
      a.pos.push(x, hgt[key * 4]!, z);
      a.nor.push(hgt[key * 4 + 1]!, hgt[key * 4 + 2]!, hgt[key * 4 + 3]!);
      const sx = mirror(x, this.W);
      const sz = mirror(z, this.H);
      if (a.tex) a.uv.push(((sx - a.x0) * px) / a.w, 1 - ((sz - a.z0) * px) / a.h);
      else {
        const t = this.tile(Math.floor(sx), Math.floor(sz));
        fc.setHex(FALLBACK[t] ?? 0x555555).multiplyScalar(0.92 + hash(Math.floor(sx) * 977 + Math.floor(sz), 3) * 0.16);
        a.col.push(fc.r, fc.g, fc.b);
      }
      return k;
    };
    for (let j = 0; j < zs.length - 1; j++)
      for (let i = 0; i < NX - 1; i++) {
        // which chunk the cell's (mirrored) source lies in
        const sx = mirror((xs[i]! + xs[i + 1]!) / 2, this.W);
        const sz = mirror((zs[j]! + zs[j + 1]!) / 2, this.H);
        const c = Math.min(nC - 1, Math.floor(sx / size));
        const r = Math.min(nR - 1, Math.floor(sz / size));
        const a = accs[r * nC + c]!;
        const v00 = vert(a, i, j);
        const v10 = vert(a, i + 1, j);
        const v01 = vert(a, i, j + 1);
        const v11 = vert(a, i + 1, j + 1);
        a.idx.push(v00, v01, v10, v10, v01, v11);
      }
    for (const a of accs) {
      if (a.idx.length === 0) continue;
      const tex = a.tex;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(a.pos, 3));
      g.setAttribute("normal", new THREE.Float32BufferAttribute(a.nor, 3));
      if (tex) g.setAttribute("uv", new THREE.Float32BufferAttribute(a.uv, 2));
      else g.setAttribute("color", new THREE.Float32BufferAttribute(a.col, 3));
      g.setIndex(a.idx);
      g.computeBoundingSphere();
      let mat: THREE.Material;
      if (tex) {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.anisotropy = 8;
        tex.needsUpdate = true;
        mat = groundMat(new THREE.MeshLambertMaterial({ map: tex }));
      } else mat = groundMat(new THREE.MeshLambertMaterial({ vertexColors: true }));
      const m = new THREE.Mesh(g, mat);
      m.receiveShadow = true;
      this.group.add(m);
    }
  }

  // ------------------------------------------------------------ water --

  private buildWater(): void {
    const step = 0.5;
    const pos: number[] = [];
    const depth: number[] = [];
    const idx: number[] = [];
    const keyOf = new Map<number, number>();
    const vert = (x: number, z: number) => {
      const key = Math.round((x + SKIRT) * 2) * 10007 + Math.round((z + SKIRT) * 2);
      let k = keyOf.get(key);
      if (k === undefined) {
        k = pos.length / 3;
        keyOf.set(key, k);
        pos.push(x, WATER_LEVEL, z);
        depth.push(WATER_LEVEL - this.landAt(x, z));
      }
      return k;
    };
    // which cells of the map hold water...
    const cw = Math.round(this.W / step);
    const ch = Math.round(this.H / step);
    const wet = new Uint8Array(cw * ch);
    for (let j = 0; j < ch; j++)
      for (let i = 0; i < cw; i++) {
        const x = i * step;
        const z = j * step;
        const lo = Math.min(
          this.heightAt(x, z), this.heightAt(x + step, z), this.heightAt(x, z + step), this.heightAt(x + step, z + step),
          this.heightAt(x + step / 2, z + step / 2)
        );
        wet[j * cw + i] = lo < WATER_LEVEL - 0.005 ? 1 : 0;
      }
    // ...and the skirt's mirrored rivers carry on past the edge (a skirt cell is wet if the cell it mirrors is)
    const cell = (k: number, n: number) => (k < 0 ? -k - 1 : k >= n ? 2 * n - k - 1 : k);
    const sk = Math.round(SKIRT / step);
    for (let j = -sk; j < ch + sk; j++)
      for (let i = -sk; i < cw + sk; i++) {
        if (!wet[cell(j, ch) * cw + cell(i, cw)]) continue;
        const x = i * step;
        const z = j * step;
        const a = vert(x, z);
        const b = vert(x + step, z);
        const c = vert(x, z + step);
        const d = vert(x + step, z + step);
        idx.push(a, c, b, b, c, d);
      }
    if (idx.length === 0) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("aDepth", new THREE.Float32BufferAttribute(depth, 1));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(pos.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const L = this.look;
    const lava = L.liquid === 1;
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: lava ? 0.92 : L.liquid === 2 ? 0.34 : 0.3,
      metalness: 0,
      // (the rippled surface would mirror the studio environment's bright panels as white blotches)
      envMapIntensity: 0.5,
      transparent: !lava,
      depthWrite: lava
    });
    const uniforms: LiquidUniforms = {
      ...this.edge,
      uShallow: { value: new THREE.Color(L.shallow) },
      uDeep: { value: new THREE.Color(L.deep) },
      uMode: { value: L.liquid },
      uWT: this.waterTime
    };
    const water = fogged(mat, { key: `water${L.liquid}`, clouds: !lava, also: (s) => patchLiquid(s, uniforms) });
    const m = new THREE.Mesh(g, water);
    m.receiveShadow = !lava;
    m.renderOrder = 2;
    this.group.add(m);
  }

  // ---------------------------------------------------------- bridges --

  /**
   * Each run of bridge tiles becomes one deck laid along the crossing's own
   * axis (the painted art's bridge): planks or steel plates, kerbs and rails
   * down both sides, piers into the river and abutments on the banks. The
   * deck spans every bridge tile, so vehicles always ride on it.
   */
  private buildBridges(): void {
    const w = this.world;
    const seen = new Uint8Array(w.terrain.length);
    const decks: THREE.BufferGeometry[] = [];
    const L = this.look;
    const deck = new THREE.Color(L.bridge);
    const shade = (k: number) => deck.clone().multiplyScalar(k).getHex();
    const isDeck = (tx: number, ty: number) =>
      tx >= 0 && ty >= 0 && tx < this.W && ty < this.H && w.terrain[ty * this.W + tx] === Terrain.Bridge;
    for (let start = 0; start < w.terrain.length; start++) {
      if (seen[start] || w.terrain[start] !== Terrain.Bridge) continue;
      // flood the connected run
      const tiles: number[] = [];
      const stack = [start];
      seen[start] = 1;
      while (stack.length) {
        const i = stack.pop()!;
        tiles.push(i);
        const tx = i % this.W;
        const ty = Math.floor(i / this.W);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = tx + dx;
          const ny = ty + dy;
          if (!isDeck(nx, ny) || seen[ny * this.W + nx]) continue;
          seen[ny * this.W + nx] = 1;
          stack.push(ny * this.W + nx);
        }
      }
      let mx = 0;
      let mz = 0;
      for (const i of tiles) {
        mx += (i % this.W) + 0.5;
        mz += Math.floor(i / this.W) + 0.5;
      }
      mx /= tiles.length;
      mz /= tiles.length;
      // the bridge runs between its banks: the principal axis of the dry land touching the run
      let cxx = 0;
      let czz = 0;
      let cxz = 0;
      const bank = new Set<number>();
      for (const i of tiles)
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = (i % this.W) + dx;
            const ny = Math.floor(i / this.W) + dy;
            if (nx < 0 || ny < 0 || nx >= this.W || ny >= this.H) continue;
            const t = w.terrain[ny * this.W + nx];
            if (t === Terrain.Bridge || t === Terrain.Water || t === Terrain.Rock || bank.has(ny * this.W + nx)) continue;
            bank.add(ny * this.W + nx);
            const ddx = nx + 0.5 - mx;
            const ddz = ny + 0.5 - mz;
            cxx += ddx * ddx;
            czz += ddz * ddz;
            cxz += ddx * ddz;
          }
      const ang = bank.size > 1 ? 0.5 * Math.atan2(2 * cxz, cxx - czz) : 0;
      const ux = Math.cos(ang);
      const uz = Math.sin(ang);
      // extent along and across the axis, over every tile corner
      let a0 = Infinity;
      let a1 = -Infinity;
      let half = 0;
      for (const i of tiles) {
        const tx = i % this.W;
        const ty = Math.floor(i / this.W);
        for (const [cx, cz] of [[tx, ty], [tx + 1, ty], [tx, ty + 1], [tx + 1, ty + 1]] as const) {
          const along = (cx - mx) * ux + (cz - mz) * uz;
          const across = -(cx - mx) * uz + (cz - mz) * ux;
          a0 = Math.min(a0, along);
          a1 = Math.max(a1, along);
          half = Math.max(half, Math.abs(across));
        }
      }
      // (a diagonal run's corners overshoot its ends: pull them back to the banks)
      const diag = Math.abs(Math.sin(2 * ang));
      a0 += diag * 0.45;
      a1 -= diag * 0.45;
      half = Math.min(half, 1.55);
      const len = a1 - a0;
      const mid = (a0 + a1) / 2;
      const cx = mx + ux * mid;
      const cz = mz + uz * mid;
      const part = new ModelBuilder();
      // local frame: x along the bridge, z across, the walking surface at y = 0.03 (vehicles ride at 0.02)
      const wd = half * 2;
      part.box(len + 0.5, 0.14, wd, [0, -0.06, 0], shade(0.62));
      if (L.steel) {
        // riveted steel plates with hazard-striped kerbs
        const n = Math.max(2, Math.round(len / 0.9));
        for (let k = 0; k < n; k++)
          part.box(len / n - 0.05, 0.03, wd - 0.3, [-len / 2 + (k + 0.5) * (len / n), 0.015, 0], shade(k % 2 ? 0.9 : 1.02));
        for (const s of [-1, 1]) {
          part.box(len + 0.5, 0.07, 0.12, [0, 0.05, s * (half - 0.09)], 0x2b2d30);
          for (let k = 0; k < Math.floor(len / 0.5); k++)
            part.box(0.22, 0.072, 0.124, [-len / 2 + 0.25 + k * 0.5, 0.05, s * (half - 0.09)], 0xc89a2a);
        }
      } else {
        // planks across the deck, each a slightly different board
        const n = Math.max(4, Math.round(len / 0.21));
        for (let k = 0; k < n; k++)
          part.box((len + 0.4) / n - 0.035, 0.03, wd - 0.22, [-(len + 0.4) / 2 + (k + 0.5) * ((len + 0.4) / n), 0.015, 0], shade(0.86 + hash(k, 3) * 0.24));
        for (const s of [-1, 1]) part.box(len + 0.5, 0.09, 0.11, [0, 0.06, s * (half - 0.07)], shade(0.55));
      }
      // down both sides: a riveted truss on steel bridges, a post-and-rail fence on timber ones
      const railCol = L.steel ? 0x5a5550 : 0x5a4632;
      const bays = Math.max(2, Math.round((len + 0.2) / (L.steel ? 0.55 : 0.6)));
      const bay = (len + 0.2) / bays;
      for (const s of [-1, 1]) {
        const z = s * (half - 0.07);
        if (L.steel) {
          part.box(len + 0.3, 0.06, 0.07, [0, 0.36, z], railCol);
          for (let k = 0; k <= bays; k++) part.box(0.06, 0.34, 0.07, [-len / 2 - 0.1 + k * bay, 0.2, z], shade(0.8));
          const tilt = Math.atan2(0.3, bay) * (s > 0 ? 1 : -1);
          for (let k = 0; k < bays; k++)
            part.box(Math.hypot(bay, 0.3), 0.04, 0.05, [-len / 2 - 0.1 + (k + 0.5) * bay, 0.2, z], railCol, { rot: [0, 0, k % 2 ? tilt : -tilt] });
        } else {
          part.box(len + 0.3, 0.05, 0.06, [0, 0.25, z], railCol);
          for (let k = 0; k <= bays; k++) part.box(0.07, 0.22, 0.07, [-len / 2 - 0.1 + k * bay, 0.14, z], shade(0.5));
        }
      }
      // piers into the river, a cap beam across under each
      const piers = Math.max(1, Math.round(len / 1.8));
      for (let k = 0; k < piers; k++) {
        const x = -len / 2 + (k + 0.5) * (len / piers);
        part.box(0.24, 0.12, wd + 0.1, [x, -0.16, 0], 0x34322f);
        for (const s of [-0.6, 0.6]) part.box(0.26, 0.9, 0.26, [x, -0.62, s * half], L.steel ? 0x2a2a2c : 0x5d5850);
      }
      // abutments where the deck meets each bank
      for (const s of [-1, 1]) part.box(0.5, 0.5, wd + 0.2, [s * (len / 2 + 0.2), -0.24, 0], L.steel ? 0x3a3634 : 0x6a655c);
      const geo = part.build();
      geo.rotateY(-ang);
      geo.translate(cx, 0, cz);
      decks.push(geo);
    }
    if (decks.length === 0) return;
    const geo = decks.length === 1 ? decks[0]! : mergeGeometries(decks, false)!;
    if (decks.length > 1) for (const d of decks) d.dispose();
    geo.computeBoundingSphere();
    const m = new THREE.Mesh(geo, modelMat("normal"));
    m.userData.model = true;
    m.castShadow = true;
    m.receiveShadow = true;
    this.group.add(m);
  }

  // ------------------------------------------------------------ props --

  /** Instanced copies of a few geometry variants at (x, y, scale, rot) spots. */
  private scatter(geos: THREE.BufferGeometry[], spots: { x: number; y: number; s: number; r: number; v: number; sink?: number }[], shadows = true): void {
    geos.forEach((geo, v) => {
      const mine = spots.filter((p) => p.v % geos.length === v);
      if (mine.length === 0) return;
      const mesh = new THREE.InstancedMesh(geo, modelMat("normal"), mine.length);
      const m = new THREE.Matrix4();
      mine.forEach((p, i) => {
        _quat.setFromAxisAngle(UP, p.r);
        m.compose(_pos.set(p.x, this.heightAt(p.x, p.y) - (p.sink ?? 0.02), p.y), _quat, _scale.set(p.s, p.s, p.s));
        mesh.setMatrixAt(i, m);
      });
      mesh.castShadow = shadows;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      this.group.add(mesh);
    });
  }

  private buildTrees(): void {
    const spots: { x: number; y: number; s: number; r: number; v: number }[] = [];
    const w = this.world;
    for (let i = 0; i < w.terrain.length; i++) {
      if (w.terrain[i] !== Terrain.Forest) continue;
      const tx = i % this.W;
      const ty = Math.floor(i / this.W);
      const n = 2 + (hash(i, 1) < 0.5 ? 1 : 0);
      for (let k = 0; k < n; k++) {
        spots.push({
          x: tx + 0.2 + hash(i, 10 + k) * 0.6,
          y: ty + 0.2 + hash(i, 20 + k) * 0.6,
          s: 0.75 + hash(i, 30 + k) * 0.45,
          r: hash(i, 40 + k) * Math.PI * 2,
          v: Math.floor(hash(i, 50 + k) * 6)
        });
      }
    }
    if (spots.length) this.scatter(treeGeos(this.world.biome), spots);
  }

  /**
   * Rock crags over the outcrops (bigger in their hearts, smaller at the
   * rims) and a few loose boulders on open ground, all one merged mesh,
   * coloured from the painted rock under each so they belong to the art.
   */
  private buildRocks(painted: PaintedColors | null): void {
    const w = this.world;
    const spots: CragSpot[] = [];
    const rockCol = new THREE.Color(this.look.rock);
    const tmp = new THREE.Color();
    const isRock = (tx: number, ty: number) => tx >= 0 && ty >= 0 && tx < this.W && ty < this.H && w.terrain[ty * this.W + tx] === Terrain.Rock;
    const seat = (x: number, y: number, r: number) =>
      Math.min(this.heightAt(x, y), this.heightAt(x + r, y), this.heightAt(x - r, y), this.heightAt(x, y + r), this.heightAt(x, y - r));
    for (let i = 0; i < w.terrain.length; i++) {
      const t = w.terrain[i];
      const tx = i % this.W;
      const ty = Math.floor(i / this.W);
      if (t === Terrain.Rock) {
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && isRock(tx + dx, ty + dy)) n++;
        const heart = n >= 7;
        if (hash(i, 2) < (heart ? 0.45 : 0.6)) continue;
        const x = tx + 0.5 + (hash(i, 3) - 0.5) * 0.6;
        const y = ty + 0.5 + (hash(i, 4) - 0.5) * 0.6;
        const s = heart ? 0.5 + hash(i, 5) * 0.35 : 0.34 + hash(i, 5) * 0.22;
        const k = hash(i, 7);
        spots.push({
          x, y, s, rot: hash(i, 6) * Math.PI * 2,
          h: seat(x, y, s * 0.45) - 0.06,
          tint: painted?.at(x, y, tmp, 0.75)?.clone() ?? rockCol.clone(),
          kind: k < 0.5 ? 0 : k < 0.82 ? 1 : 2,
          seed: i
        });
      } else if ((t === Terrain.Rough || t === Terrain.Ground) && hash(i, 8) < 0.012) {
        // a few loose boulders: the biome's stone, warmed by the ground they sit in
        const x = tx + 0.5;
        const y = ty + 0.5;
        const s = 0.24 + hash(i, 9) * 0.22;
        const tint = rockCol.clone();
        const under = painted?.at(x, y, tmp, 1);
        if (under) tint.lerp(under, 0.35);
        spots.push({ x, y, s, rot: hash(i, 6) * 6, h: seat(x, y, s * 0.45) - 0.04, tint, kind: 3, seed: i });
      }
    }
    const geo = cragGeometry(spots, w.biome);
    if (!geo) return;
    const m = new THREE.Mesh(geo, modelMat("normal"));
    m.castShadow = true;
    m.receiveShadow = true;
    this.group.add(m);
  }

  private buildPiles(): void {
    const w = this.world;
    const scrap = scrapGeos();
    const crystal = crystalGeos();
    const groups = new Map<THREE.BufferGeometry, number[]>();
    for (let i = 0; i < w.terrain.length; i++) {
      const t = w.terrain[i];
      if (t !== Terrain.Scrap && t !== Terrain.Crystal) continue;
      const set = t === Terrain.Crystal ? crystal : scrap;
      const geo = set[Math.floor(hash(i, 5) * set.length)]!;
      const list = groups.get(geo) ?? [];
      list.push(i);
      groups.set(geo, list);
    }
    for (const [geo, tiles] of groups) {
      const mesh = new THREE.InstancedMesh(geo, modelMat("normal"), tiles.length);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      tiles.forEach((i, slot) => {
        const tx = i % this.W;
        const ty = Math.floor(i / this.W);
        const x = tx + 0.5 + (hash(i, 1) - 0.5) * 0.25;
        const y = ty + 0.5 + (hash(i, 2) - 0.5) * 0.25;
        const p: Pile = {
          tile: i, mesh, slot, matrix: new THREE.Matrix4(), base: 0.95 + hash(i, 4) * 0.25,
          crystal: w.terrain[i] === Terrain.Crystal, lastRatio: -1,
          x, y, h: this.heightAt(x, y), rot: hash(i, 6) * Math.PI * 2
        };
        this.piles.push(p);
        this.setPile(p, 1);
      });
      mesh.computeBoundingSphere();
      this.group.add(mesh);
    }
  }

  private setPile(p: Pile, ratio: number): void {
    const s = ratio > 0 ? p.base * (0.45 + 0.55 * Math.sqrt(ratio)) : 0.0001;
    p.matrix.compose(
      _pos.set(p.x, p.h - (ratio > 0 ? 0 : 1), p.y),
      _quat.setFromAxisAngle(UP, p.rot),
      _scale.set(s, s * (0.6 + 0.4 * Math.sqrt(Math.max(0, ratio))), s)
    );
    p.mesh.setMatrixAt(p.slot, p.matrix);
    p.mesh.instanceMatrix.needsUpdate = true;
  }

  // -------------------------------------------------------- per frame --

  update(dtMs: number, showFog: boolean): void {
    this.time += dtMs;
    const w = this.world;
    for (const p of this.piles) {
      const i = p.tile;
      const full = p.crystal ? ECONOMY.crystalPerTile : ECONOMY.scrapPerTile;
      const ratio = w.scrap[i]! / full;
      if (Math.abs(ratio - p.lastRatio) > 0.02 || (ratio === 0 && p.lastRatio !== 0)) {
        p.lastRatio = ratio;
        this.setPile(p, ratio);
      }
    }
    // the skirt fades into whatever the sky is (in the final, sRGB-encoded colour)
    const bg = (this.group.parent as THREE.Scene | null)?.background;
    if (bg instanceof THREE.Color) this.edge.uFarColor.value.copy(bg).convertLinearToSRGB();
    this.waterTime.value = this.time / 1000;
    fowUniforms.uTime.value = this.time / 1000;
    this.cloud.x -= dtMs * 0.0000125;
    this.cloud.y -= dtMs * 0.000005;
    fowUniforms.uCloudOffset.value.copy(this.cloud);
    fowUniforms.uFowOn.value = showFog ? 1 : 0;
    if (showFog) this.updateFog(dtMs);
  }

  private updateFog(dtMs: number): void {
    this.fogAcc += dtMs;
    if (this.fogAcc < 40) return; // ~25 Hz is plenty for a soft fade
    const step = Math.min(1, this.fogAcc / 250);
    this.fogAcc = 0;
    const w = this.world;
    const vis = w.fog[this.player].vis;
    const FW = this.W + 2;
    for (let y = 0; y < this.H + 2; y++)
      for (let x = 0; x < FW; x++) {
        const tx = x - 1;
        const ty = y - 1;
        const inside = tx >= 0 && ty >= 0 && tx < this.W && ty < this.H;
        const v = inside ? vis[ty * this.W + tx] : Vis.Unexplored;
        const target = v === Vis.Visible ? 0 : v === Vis.Explored ? 0.5 : 0.94;
        const i = y * FW + x;
        const cur = this.fogCur[i]!;
        this.fogCur[i] = cur + (target - cur) * step;
      }
    // a soft 3×3 blur on the CPU (a few thousand texels) keeps the shader to one fog lookup
    const FH = this.H + 2;
    const c = this.fogCur;
    const b = this.fogBlur;
    for (let y = 0; y < FH; y++)
      for (let x = 0; x < FW; x++) {
        let sum = 0;
        let wsum = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= FH) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= FW) continue;
            const wgt = (dx === 0 ? 2 : 1) * (dy === 0 ? 2 : 1);
            sum += c[yy * FW + xx]! * wgt;
            wsum += wgt;
          }
        }
        b[y * FW + x] = sum / wsum;
      }
    for (let i = 0; i < b.length; i++) this.fogData[i] = Math.round(b[i]! * 255);
    this.fogTex.needsUpdate = true;
  }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
    this.fogTex.dispose();
    fowUniforms.uFowMap.value = null;
  }
}
