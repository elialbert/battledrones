import * as THREE from "three";
import { ECONOMY } from "../../sim/balance";
import { Vis } from "../../sim/fog";
import { Terrain, type Biome, type Faction, type World } from "../../sim/types";
import { ModelBuilder, type Vec3 } from "./builder";
import { fogged, fowUniforms, modelMat } from "./materials";
import { cloudTexture, noiseTexture } from "./textures";

/**
 * The 3D battlefield. The map grid becomes a heightfield — rock outcrops
 * rise into craggy mesas, rivers and lava cut real channels, fords dip under
 * a shallow skin of water, rough ground buckles — and the painted terrain
 * art is draped over it as the albedo, so every map keeps its hand-painted
 * look with real relief, lighting and shadows. On top: animated water (or
 * lava, or icy meltwater), bridge decks, instanced trees and boulders per
 * biome, scrap heaps and glowing crystal clusters that shrink as they're
 * mined, the map's earthen edge, drifting cloud shadows and the fog of war.
 */

/** Height of the water / lava surface. */
export const WATER_LEVEL = -0.12;
/** Lattice resolution: height samples per tile. */
const RES = 3;

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
  edge: number;
  shallow: number;
  deep: number;
  /** 0 water, 1 lava, 2 icy water. */
  liquid: number;
  rock: number;
  bridge: number;
}

const LOOK: Record<Biome, BiomeLook> = {
  temperate: { edge: 0x3b2c1f, shallow: 0x4fa8b8, deep: 0x123f5c, liquid: 0, rock: 0x7c7b77, bridge: 0x8a8274 },
  desert: { edge: 0x80603a, shallow: 0x5fd8d0, deep: 0x147a8a, liquid: 0, rock: 0xa45a3a, bridge: 0x9a8058 },
  arctic: { edge: 0x6c7a8c, shallow: 0x9fd0ea, deep: 0x0f2a44, liquid: 2, rock: 0x8a929e, bridge: 0x7c8590 },
  volcanic: { edge: 0x231915, shallow: 0xffd060, deep: 0xff4a10, liquid: 1, rock: 0x2e2b2a, bridge: 0x4a3f38 }
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
  private waterMat: THREE.MeshStandardMaterial | null = null;
  private waterTime = { value: 0 };
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
    this.buildEdges();
    this.buildWater();
    this.buildBridges();
    this.buildTrees();
    this.buildRocks();
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

  private buildGround(art: TerrainArt | null): void {
    const anis = 8;
    const make = (x0: number, z0: number, x1: number, z1: number, mat: THREE.Material, uv?: (x: number, z: number) => [number, number]) => {
      const xs = this.axis(x0, x1);
      const zs = this.axis(z0, z1);
      const nx = xs.length;
      const nz = zs.length;
      const pos = new Float32Array(nx * nz * 3);
      const nor = new Float32Array(nx * nz * 3);
      const uvs = new Float32Array(nx * nz * 2);
      const col = uv ? null : new Float32Array(nx * nz * 3);
      const c = new THREE.Color();
      const e = 0.12;
      for (let j = 0; j < nz; j++)
        for (let i = 0; i < nx; i++) {
          const x = xs[i]!;
          const z = zs[j]!;
          const k = j * nx + i;
          pos[k * 3] = x;
          pos[k * 3 + 1] = this.heightAt(x, z);
          pos[k * 3 + 2] = z;
          const dx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
          const dz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
          const n = new THREE.Vector3(-dx / (2 * e), 1, -dz / (2 * e)).normalize();
          nor[k * 3] = n.x;
          nor[k * 3 + 1] = n.y;
          nor[k * 3 + 2] = n.z;
          if (uv) {
            const [u, v] = uv(x, z);
            uvs[k * 2] = u;
            uvs[k * 2 + 1] = v;
          } else if (col) {
            const t = this.tile(Math.floor(x), Math.floor(z));
            c.setHex(FALLBACK[t] ?? 0x555555).multiplyScalar(0.92 + hash(Math.floor(x) * 977 + Math.floor(z), 3) * 0.16);
            col[k * 3] = c.r;
            col[k * 3 + 1] = c.g;
            col[k * 3 + 2] = c.b;
          }
        }
      const idx: number[] = [];
      for (let j = 0; j < nz - 1; j++)
        for (let i = 0; i < nx - 1; i++) {
          const a = j * nx + i;
          const b = a + 1;
          const cc = a + nx;
          const d = cc + 1;
          idx.push(a, cc, b, b, cc, d);
        }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      g.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
      if (uv) g.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
      if (col) g.setAttribute("color", new THREE.BufferAttribute(col, 3));
      g.setIndex(idx);
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, mat);
      m.receiveShadow = true;
      this.group.add(m);
    };

    const fallbackMat = () => fogged(new THREE.MeshLambertMaterial({ vertexColors: true }), { key: "ground" });
    if (!art) {
      make(0, 0, this.W, this.H, fallbackMat());
      return;
    }
    const px = art.pxPerTile;
    const size = art.chunk / px; // tiles per chunk
    art.chunks.forEach((row, r) =>
      row.forEach((tex, c) => {
        const x0 = c * size;
        const z0 = r * size;
        const x1 = Math.min(this.W, (c + 1) * size);
        const z1 = Math.min(this.H, (r + 1) * size);
        if (x0 >= this.W || z0 >= this.H) return;
        if (!tex) {
          make(x0, z0, x1, z1, fallbackMat());
          return;
        }
        const img = tex.image as { width: number; height: number };
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.anisotropy = anis;
        tex.needsUpdate = true;
        const mat = fogged(new THREE.MeshLambertMaterial({ map: tex }), { key: "ground" });
        make(x0, z0, x1, z1, mat, (x, z) => [((x - x0) * px) / img.width, 1 - ((z - z0) * px) / img.height]);
      })
    );
  }

  /** Lattice coordinates between a and b, including both ends exactly. */
  private axis(a: number, b: number): number[] {
    const out = [a];
    for (let k = Math.floor(a * RES) + 1; k / RES < b - 1e-6; k++) if (k / RES > a + 1e-6) out.push(k / RES);
    out.push(b);
    return out;
  }

  /** The map's earthen sides, so the battlefield reads as a raised table. */
  private buildEdges(): void {
    const b = new ModelBuilder();
    const depth = -2.2;
    const col = this.look.edge;
    const side = (pts: [number, number][]) => {
      for (let i = 0; i < pts.length - 1; i++) {
        const [x0, z0] = pts[i]!;
        const [x1, z1] = pts[i + 1]!;
        const h0 = this.heightAt(x0, z0);
        const h1 = this.heightAt(x1, z1);
        const g = new THREE.BufferGeometry();
        const v = new Float32Array([x0, h0, z0, x1, h1, z1, x1, depth, z1, x0, h0, z0, x1, depth, z1, x0, depth, z0]);
        g.setAttribute("position", new THREE.BufferAttribute(v, 3));
        g.computeVertexNormals();
        const shade = 0.75 + hash(i, x0 + z0) * 0.25;
        b.add(g, [0, 0, 0], new THREE.Color(col).multiplyScalar(shade).getHex());
      }
    };
    const n = this.W * 2;
    const edge = (f: (k: number) => [number, number]) => side(Array.from({ length: n + 1 }, (_, i) => f(i / n)));
    edge((k) => [k * this.W, 0]);
    edge((k) => [this.W, k * this.H]);
    edge((k) => [this.W * (1 - k), this.H]);
    edge((k) => [0, this.H * (1 - k)]);
    const m = new THREE.Mesh(b.build(), modelMat("normal"));
    m.userData.model = true;
    this.group.add(m);
    // a dark apron beneath, catching the eye at the map border
    const apron = new THREE.Mesh(
      new THREE.PlaneGeometry(this.W + 400, this.H + 400),
      new THREE.MeshBasicMaterial({ color: 0x05070b })
    );
    apron.rotation.x = -Math.PI / 2;
    apron.position.set(this.W / 2, depth, this.H / 2);
    this.group.add(apron);
  }

  // ------------------------------------------------------------ water --

  private buildWater(): void {
    const step = 0.5;
    const pos: number[] = [];
    const depth: number[] = [];
    const idx: number[] = [];
    const keyOf = new Map<number, number>();
    const vert = (x: number, z: number) => {
      const key = Math.round(x * 2) * 10007 + Math.round(z * 2);
      let k = keyOf.get(key);
      if (k === undefined) {
        k = pos.length / 3;
        keyOf.set(key, k);
        pos.push(x, WATER_LEVEL, z);
        depth.push(WATER_LEVEL - this.heightAt(x, z));
      }
      return k;
    };
    for (let z = 0; z < this.H; z += step)
      for (let x = 0; x < this.W; x += step) {
        const lo = Math.min(
          this.heightAt(x, z), this.heightAt(x + step, z), this.heightAt(x, z + step), this.heightAt(x + step, z + step),
          this.heightAt(x + step / 2, z + step / 2)
        );
        if (lo >= WATER_LEVEL - 0.005) continue;
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
    const L = this.look;
    const lava = L.liquid === 1;
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: lava ? 0.8 : 0.12,
      metalness: 0,
      transparent: !lava,
      depthWrite: lava
    });
    const noise = noiseTexture();
    const uniforms = {
      uShallow: { value: new THREE.Color(L.shallow) },
      uDeep: { value: new THREE.Color(L.deep) },
      uMode: { value: L.liquid },
      uNoise: { value: noise },
      uWT: this.waterTime
    };
    this.waterMat = fogged(mat, {
      key: `water${L.liquid}`,
      clouds: !lava,
      also: (s) => {
        Object.assign(s.uniforms, uniforms);
        s.vertexShader = s.vertexShader
          .replace("#include <common>", "#include <common>\nattribute float aDepth;\nvarying float vDepth;\nvarying vec2 vXZ;\nuniform float uWT;")
          .replace(
            "#include <begin_vertex>",
            `#include <begin_vertex>
            vDepth = aDepth;
            vXZ = position.xz;
            transformed.y += sin( position.x * 1.7 + uWT * 1.3 ) * 0.008 + cos( position.z * 1.3 + uWT * 1.1 ) * 0.008;`
          );
        s.fragmentShader = s.fragmentShader
          .replace(
            "#include <common>",
            `#include <common>
            varying float vDepth; varying vec2 vXZ;
            uniform vec3 uShallow; uniform vec3 uDeep; uniform float uMode; uniform sampler2D uNoise; uniform float uWT;`
          )
          .replace(
            "#include <color_fragment>",
            `#include <color_fragment>
            float dk = smoothstep( 0.0, 0.32, vDepth );
            float n1 = texture2D( uNoise, vXZ * 0.11 + vec2( uWT * 0.013, uWT * 0.007 ) ).r;
            float n2 = texture2D( uNoise, vXZ * 0.23 - vec2( uWT * 0.011, -uWT * 0.017 ) ).g;
            float n = ( n1 + n2 ) * 0.5;
            vec3 wc = mix( uShallow, uDeep, dk );
            float alpha = mix( 0.18, 0.88, dk );
            if ( uMode < 0.5 ) {
              float r1 = texture2D( uNoise, vXZ * 0.9 + vec2( uWT * 0.05, uWT * 0.03 ) ).b;
              float r2 = texture2D( uNoise, vXZ * 1.3 - vec2( uWT * 0.04, -uWT * 0.06 ) ).b;
              float sparkle = smoothstep( 0.78, 0.95, r1 * r2 * 1.6 );
              wc *= 0.9 + 0.2 * n;
              wc += vec3( 0.25, 0.3, 0.32 ) * sparkle * dk;
              float foam = 1.0 - smoothstep( 0.0, 0.06, vDepth );
              wc = mix( wc, vec3( 0.9, 0.95, 0.95 ), foam * ( 0.45 + 0.4 * n ) );
              alpha = max( alpha, foam * 0.55 );
            } else if ( uMode > 1.5 ) {
              float ice = smoothstep( 0.55, 0.6, texture2D( uNoise, vXZ * 0.17 ).b );
              wc = mix( wc, vec3( 0.82, 0.9, 0.97 ), ice * 0.85 );
              alpha = max( alpha, ice * 0.9 );
              float foam = 1.0 - smoothstep( 0.0, 0.07, vDepth );
              wc = mix( wc, vec3( 0.88, 0.94, 1.0 ), foam * 0.6 );
            } else {
              wc = vec3( 0.06, 0.02, 0.01 );
              alpha = 1.0;
            }
            diffuseColor = vec4( wc, alpha );`
          )
          .replace(
            "#include <emissivemap_fragment>",
            `#include <emissivemap_fragment>
            if ( uMode > 0.5 && uMode < 1.5 ) {
              float f1 = texture2D( uNoise, vXZ * 0.16 + vec2( uWT * 0.02, uWT * 0.012 ) ).r;
              float f2 = texture2D( uNoise, vXZ * 0.37 - vec2( uWT * 0.017, uWT * 0.025 ) ).g;
              float heat = clamp( f1 * 0.65 + f2 * 0.55 - 0.15, 0.0, 1.0 );
              float crust = smoothstep( 0.3, 0.18, heat );
              vec3 hot = mix( uDeep, uShallow, smoothstep( 0.45, 0.95, heat ) );
              totalEmissiveRadiance = mix( hot * ( 1.1 + heat * 1.6 ), vec3( 0.12, 0.03, 0.01 ), crust * 0.85 );
              totalEmissiveRadiance *= smoothstep( 0.0, 0.08, vDepth ) * 0.85 + 0.15;
            }`
          );
      }
    });
    const m = new THREE.Mesh(g, this.waterMat);
    m.receiveShadow = !lava;
    m.renderOrder = 2;
    this.group.add(m);
  }

  // ---------------------------------------------------------- bridges --

  private buildBridges(): void {
    const w = this.world;
    const b = new ModelBuilder();
    const deck = this.look.bridge;
    const isDeck = (tx: number, ty: number) => {
      if (tx < 0 || ty < 0 || tx >= this.W || ty >= this.H) return false;
      const t = w.terrain[ty * this.W + tx];
      return t === Terrain.Bridge;
    };
    const landish = (tx: number, ty: number) => {
      if (tx < 0 || ty < 0 || tx >= this.W || ty >= this.H) return false;
      const t = w.terrain[ty * this.W + tx];
      return t !== Terrain.Water && t !== Terrain.Shallows && t !== Terrain.Bridge && t !== Terrain.Rock;
    };
    let any = false;
    for (let ty = 0; ty < this.H; ty++)
      for (let tx = 0; tx < this.W; tx++) {
        if (!isDeck(tx, ty)) continue;
        any = true;
        const cx = tx + 0.5;
        const cz = ty + 0.5;
        b.box(1.02, 0.1, 1.02, [cx, -0.04, cz], new THREE.Color(deck).multiplyScalar(0.7).getHex());
        for (let k = 0; k < 4; k++)
          b.box(0.23, 0.02, 0.96, [tx + 0.14 + k * 0.24, 0.02, cz], new THREE.Color(deck).multiplyScalar(0.85 + (((tx + ty + k) % 3) * 0.08)).getHex());
        b.box(0.18, 0.62, 0.18, [cx, -0.38, cz], 0x3a3834);
        // railings along the sides that face open water
        const rail = (x: number, z: number, horiz: boolean) => {
          b.box(horiz ? 1.0 : 0.05, 0.05, horiz ? 0.05 : 1.0, [x, 0.14, z], 0x2c2e31);
          for (const o of [-0.4, 0, 0.4]) b.box(0.04, 0.12, 0.04, [horiz ? x + o : x, 0.08, horiz ? z : z + o], 0x2c2e31);
        };
        const ns = isDeck(tx, ty - 1) || isDeck(tx, ty + 1) || landish(tx, ty - 1) || landish(tx, ty + 1);
        const ew = isDeck(tx - 1, ty) || isDeck(tx + 1, ty) || landish(tx - 1, ty) || landish(tx + 1, ty);
        if (ns && !ew) {
          rail(tx + 0.03, cz, false);
          rail(tx + 0.97, cz, false);
        } else if (ew && !ns) {
          rail(cx, ty + 0.03, true);
          rail(cx, ty + 0.97, true);
        }
      }
    if (!any) return;
    const m = new THREE.Mesh(b.build(), modelMat("normal"));
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
      const q = new THREE.Quaternion();
      mine.forEach((p, i) => {
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.r);
        m.compose(new THREE.Vector3(p.x, this.heightAt(p.x, p.y) - (p.sink ?? 0.02), p.y), q, new THREE.Vector3(p.s, p.s, p.s));
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

  private buildRocks(): void {
    const spots: { x: number; y: number; s: number; r: number; v: number; sink: number }[] = [];
    const w = this.world;
    for (let i = 0; i < w.terrain.length; i++) {
      if (w.terrain[i] !== Terrain.Rock || hash(i, 2) < 0.35) continue;
      const tx = i % this.W;
      const ty = Math.floor(i / this.W);
      spots.push({
        x: tx + 0.15 + hash(i, 3) * 0.7,
        y: ty + 0.15 + hash(i, 4) * 0.7,
        s: 0.6 + hash(i, 5) * 0.8,
        r: hash(i, 6) * Math.PI * 2,
        v: Math.floor(hash(i, 7) * 3),
        sink: 0.12
      });
    }
    // a few loose boulders scattered on open ground too
    for (let i = 0; i < w.terrain.length; i++) {
      const t = w.terrain[i];
      if ((t !== Terrain.Rough && t !== Terrain.Ground) || hash(i, 8) > 0.012) continue;
      spots.push({ x: (i % this.W) + 0.5, y: Math.floor(i / this.W) + 0.5, s: 0.25 + hash(i, 9) * 0.25, r: hash(i, 6) * 6, v: Math.floor(hash(i, 7) * 3), sink: 0.05 });
    }
    if (spots.length) this.scatter(rockGeos(this.world.biome, this.look.rock), spots);
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
      new THREE.Vector3(p.x, p.h - (ratio > 0 ? 0 : 1), p.y),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.rot),
      new THREE.Vector3(s, s * (0.6 + 0.4 * Math.sqrt(Math.max(0, ratio))), s)
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

// ----------------------------------------------------- prop geometries ---

function treeGeos(biome: Biome): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const ico = (r: number, at: Vec3, col: number, b: ModelBuilder, sc: Vec3 = [1, 1, 1]) =>
    b.add(new THREE.IcosahedronGeometry(r, 0), at, col, { scale: sc, rot: [at[0] * 3, at[2] * 5, 0] });
  for (let v = 0; v < 6; v++) {
    const b = new ModelBuilder();
    const k = v / 5;
    if (biome === "temperate") {
      if (v % 3 === 2) {
        b.cyl(0.04, 0.06, 0.3, 5, [0, 0.15, 0], 0x4a3626);
        for (let i = 0; i < 3; i++) b.cone(0.32 - i * 0.07, 0.4, 7, [0, 0.38 + i * 0.22, 0], [0x2c5430, 0x335e34, 0x3b6a3a][i]!);
      } else {
        b.cyl(0.04, 0.06, 0.42, 5, [0, 0.21, 0], 0x5a4030);
        ico(0.32, [0, 0.6, 0], [0x3f6a2a, 0x4a7a30, 0x5a8434][v % 3]!, b, [1, 0.85, 1]);
        ico(0.22, [0.15, 0.72, 0.08], 0x5a8a34, b);
        ico(0.2, [-0.14, 0.52, -0.1], 0x36602a, b);
      }
    } else if (biome === "arctic") {
      b.cyl(0.04, 0.06, 0.3, 5, [0, 0.15, 0], 0x3e3228);
      for (let i = 0; i < 3; i++) {
        const y = 0.36 + i * 0.22;
        const r = 0.32 - i * 0.075;
        b.cone(r, 0.38, 7, [0, y, 0], [0x24402f, 0x2a4836, 0x30503c][i]!);
        b.cone(r * 0.82, 0.2, 7, [0, y + 0.1, 0], 0xeef4ff);
      }
    } else if (biome === "desert") {
      if (v % 2 === 0) {
        let x = 0;
        let y = 0;
        for (let i = 0; i < 4; i++) {
          b.cyl(0.04, 0.05, 0.24, 5, [x, y + 0.12, 0], 0x8a6a48, { rot: [0, 0, -0.12 - i * 0.04] });
          x += 0.025 + i * 0.012;
          y += 0.23;
        }
        for (let i = 0; i < 7; i++) {
          const a = (i / 7) * Math.PI * 2;
          b.box(0.42, 0.012, 0.09, [x + Math.cos(a) * 0.18, y + 0.02, Math.sin(a) * 0.18], [0x5f8a32, 0x6f9a3a][i % 2]!, {
            rot: [0, -a, -0.45]
          });
        }
        b.sphere(0.05, [x, y + 0.03, 0], 0x6a4a2a, { w: 5, h: 4 });
      } else {
        ico(0.24, [0, 0.18, 0], 0x6b8a3a, b, [1.2, 0.7, 1.1]);
        ico(0.16, [0.18, 0.14, 0.1], 0x7c9a44, b, [1, 0.7, 1]);
      }
    } else if (v % 3 !== 2) {
      // volcanic: charred dead trees and ash shrubs with smouldering embers
      b.cyl(0.035, 0.07, 0.6, 5, [0, 0.3, 0], 0x2a2522, { rot: [0.05 * k, 0, 0.08] });
      b.cyl(0.02, 0.03, 0.32, 4, [0.1, 0.58, 0], 0x2a2522, { rot: [0, 0, -0.7] });
      b.cyl(0.02, 0.03, 0.28, 4, [-0.09, 0.5, 0.04], 0x2a2522, { rot: [0.3, 0, 0.8] });
      b.cyl(0.015, 0.02, 0.22, 4, [0.02, 0.66, -0.08], 0x2a2522, { rot: [-0.7, 0, 0] });
      ico(0.05, [0.18, 0.66, 0], 0xff6a20, b);
    } else {
      ico(0.2, [0, 0.12, 0], 0x3a3330, b, [1.2, 0.6, 1.1]);
      ico(0.13, [0.16, 0.1, 0.08], 0x2e2826, b, [1, 0.6, 1]);
      ico(0.04, [0.08, 0.2, 0.06], 0xff7a2a, b);
    }
    out.push(b.build());
  }
  // the volcanic embers glow
  if (biome === "volcanic")
    for (const g of out) {
      const col = g.attributes.color!;
      const glow = g.attributes.glow!;
      for (let i = 0; i < col.count; i++) if (col.getX(i) > 0.6) glow.setX(i, 0.8);
    }
  return out;
}

function rockGeos(biome: Biome, col: number): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  for (let v = 0; v < 3; v++) {
    const b = new ModelBuilder();
    const c = new THREE.Color(col);
    const dark = c.clone().multiplyScalar(0.75).getHex();
    b.add(new THREE.DodecahedronGeometry(0.42, 0), [0, 0.18, 0], v === 1 ? dark : col, { scale: [1, 0.62, 0.85], rot: [0.3 * v, v, 0.2] });
    b.add(new THREE.DodecahedronGeometry(0.26, 0), [0.28, 0.1, 0.12], dark, { scale: [1, 0.7, 1], rot: [v, 0.4, 0.3] });
    if (v !== 2) b.add(new THREE.IcosahedronGeometry(0.18, 0), [-0.24, 0.07, -0.16], col, { scale: [1, 0.8, 1], rot: [0.5, v * 2, 0] });
    if (biome === "arctic") b.add(new THREE.DodecahedronGeometry(0.3, 0), [0, 0.36, 0], 0xf0f5ff, { scale: [1, 0.3, 0.8], rot: [0, v, 0] });
    out.push(b.build());
  }
  return out;
}

function scrapGeos(): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const cols = [0x6e5238, 0x8a6a3a, 0x5a5f66, 0x7a4a2a, 0x9a7a44, 0x46494e];
  for (let v = 0; v < 3; v++) {
    const b = new ModelBuilder();
    let s = v * 7919 + 13;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    b.sphere(0.36, [0, -0.06, 0], 0x4a3f33, { w: 8, h: 4, phi: Math.PI / 2, scale: [1, 0.45, 1] });
    for (let i = 0; i < 9; i++) {
      const a = rnd() * Math.PI * 2;
      const d = rnd() * 0.24;
      const col = cols[Math.floor(rnd() * cols.length)]!;
      const x = Math.cos(a) * d;
      const z = Math.sin(a) * d;
      const y = 0.06 + (0.24 - d) * 0.4;
      if (i % 3 === 0) b.cyl(0.05, 0.05, 0.22, 6, [x, y, z], col, { rot: [rnd() * 3, rnd() * 3, rnd() * 3] });
      else b.box(0.08 + rnd() * 0.14, 0.04 + rnd() * 0.08, 0.06 + rnd() * 0.12, [x, y, z], col, { rot: [rnd() * 1.2, rnd() * 3, rnd() * 1.2] });
    }
    b.box(0.05, 0.05, 0.05, [0.05, 0.2, -0.02], 0xffd66e, { glow: 0.5, rot: [0.6, 0.4, 0] });
    out.push(b.build());
  }
  return out;
}

function crystalGeos(): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  for (let v = 0; v < 3; v++) {
    const b = new ModelBuilder();
    let s = v * 104729 + 7;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    b.add(new THREE.DodecahedronGeometry(0.22, 0), [0, 0.02, 0], 0x3a3f3a, { scale: [1.3, 0.4, 1.2] });
    const n = 5 + v;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rnd();
      const d = i === 0 ? 0 : 0.1 + rnd() * 0.14;
      const h = (i === 0 ? 0.5 : 0.22 + rnd() * 0.22) * 1.1;
      const r = i === 0 ? 0.07 : 0.04 + rnd() * 0.03;
      const lean = i === 0 ? 0 : 0.35 + rnd() * 0.3;
      const col = [0x3dffa0, 0x2fd88a, 0x6dffc0][i % 3]!;
      const x = Math.cos(a) * d;
      const z = Math.sin(a) * d;
      b.cyl(0, r, h, 5, [x + Math.cos(a) * Math.sin(lean) * h * 0.5, h * 0.5 * Math.cos(lean), z + Math.sin(a) * Math.sin(lean) * h * 0.5], col, {
        glow: 0.55,
        rot: [Math.sin(a) * lean, 0, -Math.cos(a) * lean]
      });
    }
    out.push(b.build());
  }
  return out;
}
