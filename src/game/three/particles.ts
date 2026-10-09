import * as THREE from "three";
import { TEX, particleAtlas, type TexCell } from "./textures";

/**
 * GPU-instanced particles: every puff of smoke, fire, spark, dust, shock
 * ring and scorch mark is one instance of a quad in one of three pools
 * (alpha-blended marks lying on the ground, alpha-blended matter, additive
 * light), drawn in that order so a scorch mark never cuts into the smoke
 * above it. Quads either face the camera or lie flat on the ground. The CPU
 * integrates motion and writes the instance buffers once per frame; drawing
 * is three calls whatever the count. Particle records are recycled, so a
 * busy fight doesn't feed the GC.
 */

export interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Lifetime and age, ms. */
  life: number;
  t: number;
  size0: number;
  size1: number;
  alpha0: number;
  alpha1: number;
  /** Start tint… */
  r: number;
  g: number;
  b: number;
  /** …and end tint (fire cools from yellow to red, smoke thins to grey). */
  r1: number;
  g1: number;
  b1: number;
  tex: number;
  rot: number;
  spin: number;
  /** Units/s² added to vy (negative falls). */
  gravity: number;
  /** Fraction of velocity kept per second. */
  drag: number;
  flat: boolean;
  /** Fraction of the life spent fading in (0: born at full alpha). */
  fadeIn: number;
  /** Alpha falls off fast, then lingers faint (a flame that burns out) instead of thinning evenly. */
  fadeFast: boolean;
  /** Grow fast then settle (a blast front) instead of linearly. */
  easeOut: boolean;
}

export interface EmitCfg {
  tex: TexCell;
  /** A second cell picked half the time, for variety. */
  tex2?: TexCell;
  additive?: boolean;
  /** Lifetime range, ms. */
  life: [number, number];
  /** Horizontal speed range (units/s), random direction. */
  speed?: [number, number];
  /** Vertical speed range (units/s). */
  up?: [number, number];
  size: [number, number];
  /** End size multiplier range (relative to the start size). */
  grow?: [number, number];
  alpha?: [number, number];
  tints: number[];
  /** End tint (default: the start tint). */
  end?: number;
  gravity?: number;
  drag?: number;
  spin?: number;
  /** Largest random start rotation (radians; default a full turn when flat or spinning). Lit smoke keeps it small. */
  rot?: number;
  flat?: boolean;
  /** Random spawn offset radius (units). */
  spread?: number;
  /** Constant drift added to the horizontal velocity (units/s, +x east, +z south): smoke leans downwind. */
  wind?: [number, number];
  fadeIn?: number;
  fadeFast?: boolean;
  easeOut?: boolean;
}

const VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec4 iColor;
attribute vec3 iMisc; // size, rotation, tex + 16 * flat
varying vec2 vUv;
varying vec4 vColor;
void main() {
  float c = cos( iMisc.y );
  float s = sin( iMisc.y );
  vec2 q = vec2( position.x * c - position.y * s, position.x * s + position.y * c ) * iMisc.x;
  float isFlat = step( 16.0, iMisc.z );
  float cellI = iMisc.z - isFlat * 16.0;
  vec3 right = vec3( viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0] );
  vec3 up = vec3( viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1] );
  // flat quads face up (quad +y runs north), so they aren't back-face culled
  vec3 world = mix( iPos + right * q.x + up * q.y, iPos + vec3( q.x, 0.0, -q.y ), isFlat );
  gl_Position = projectionMatrix * viewMatrix * vec4( world, 1.0 );
  float col = mod( cellI, 4.0 );
  float row = floor( cellI / 4.0 + 0.01 );
  vUv = vec2( ( col + uv.x ) / 4.0, ( ( 3.0 - row ) + uv.y ) / 4.0 );
  vColor = iColor;
}
`;
const FRAG = /* glsl */ `
uniform sampler2D map;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  vec4 t = texture2D( map, vUv );
  gl_FragColor = vec4( vColor.rgb * t.rgb, vColor.a * t.a );
  if ( gl_FragColor.a < 0.003 ) discard;
  #include <colorspace_fragment>
}
`;

const col = new THREE.Color();

function blank(): Particle {
  return {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, t: 0, size0: 1, size1: 1, alpha0: 1, alpha1: 0,
    r: 1, g: 1, b: 1, r1: 1, g1: 1, b1: 1, tex: 0, rot: 0, spin: 0, gravity: 0, drag: 1, flat: false, fadeIn: 0, fadeFast: false, easeOut: false
  };
}

class Pool {
  readonly mesh: THREE.Mesh;
  private list: Particle[] = [];
  /** Dead particle records, reused by the next spawns. */
  private free: Particle[] = [];
  private pos: Float32Array;
  private color: Float32Array;
  private misc: Float32Array;
  private geo: THREE.InstancedBufferGeometry;
  private attrs: THREE.InstancedBufferAttribute[];

  constructor(readonly cap: number, map: THREE.Texture, additive: boolean, order: number) {
    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute("position", quad.attributes.position!);
    geo.setAttribute("uv", quad.attributes.uv!);
    this.pos = new Float32Array(cap * 3);
    this.color = new Float32Array(cap * 4);
    this.misc = new Float32Array(cap * 3);
    const aPos = new THREE.InstancedBufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    const aColor = new THREE.InstancedBufferAttribute(this.color, 4).setUsage(THREE.DynamicDrawUsage);
    const aMisc = new THREE.InstancedBufferAttribute(this.misc, 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("iPos", aPos);
    geo.setAttribute("iColor", aColor);
    geo.setAttribute("iMisc", aMisc);
    this.attrs = [aPos, aColor, aMisc];
    geo.instanceCount = 0;
    this.geo = geo;
    const mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: map } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = order;
  }

  /** A fresh (recycled) record to fill in and then add(). */
  take(): Particle {
    const p = this.free.pop() ?? blank();
    p.vx = p.vy = p.vz = 0;
    p.t = 0;
    p.size0 = p.size1 = 1;
    p.alpha0 = 1;
    p.alpha1 = 0;
    p.r = p.g = p.b = p.r1 = p.g1 = p.b1 = 1;
    p.rot = p.spin = p.gravity = 0;
    p.drag = 1;
    p.flat = false;
    p.fadeIn = 0;
    p.fadeFast = false;
    p.easeOut = false;
    return p;
  }

  add(p: Particle): void {
    // (over the cap, the oldest go at the next update: the list is in spawn order)
    this.list.push(p);
  }

  get count(): number {
    return Math.min(this.list.length, this.cap);
  }

  update(dtMs: number): void {
    const dt = dtMs / 1000;
    const list = this.list;
    let n = 0;
    // full: the oldest make way
    const over = list.length - this.cap;
    for (let i = 0; i < list.length; i++) {
      const p = list[i]!;
      p.t += dtMs;
      if (p.t >= p.life || i < over) {
        this.free.push(p);
        continue;
      }
      if (dt > 0) {
        p.vy += p.gravity * dt;
        if (p.drag < 1) {
          const k = Math.pow(p.drag, dt);
          p.vx *= k;
          p.vy *= k;
          p.vz *= k;
        }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.z += p.vz * dt;
        p.rot += p.spin * dt;
      }
      const k = p.t / p.life;
      const sk = p.easeOut ? 1 - (1 - k) * (1 - k) : k;
      let a = p.alpha0 + (p.alpha1 - p.alpha0) * (p.fadeFast ? 1 - (1 - k) * (1 - k) : k);
      if (p.fadeIn > 0 && k < p.fadeIn) a *= k / p.fadeIn;
      this.pos[n * 3] = p.x;
      this.pos[n * 3 + 1] = p.y;
      this.pos[n * 3 + 2] = p.z;
      this.color[n * 4] = p.r + (p.r1 - p.r) * k;
      this.color[n * 4 + 1] = p.g + (p.g1 - p.g) * k;
      this.color[n * 4 + 2] = p.b + (p.b1 - p.b) * k;
      this.color[n * 4 + 3] = a;
      this.misc[n * 3] = p.size0 + (p.size1 - p.size0) * sk;
      this.misc[n * 3 + 1] = p.rot;
      this.misc[n * 3 + 2] = p.tex + (p.flat ? 16 : 0);
      list[n++] = p;
    }
    list.length = n;
    this.geo.instanceCount = n;
    if (n > 0)
      for (const a of this.attrs) {
        a.clearUpdateRanges();
        a.addUpdateRange(0, n * a.itemSize);
        a.needsUpdate = true;
      }
  }

  clear(): void {
    for (const p of this.list) this.free.push(p);
    this.list.length = 0;
    this.geo.instanceCount = 0;
  }
}

const rand = (r: [number, number]) => r[0] + Math.random() * (r[1] - r[0]);

export class Particles {
  readonly add: Pool;
  readonly norm: Pool;
  /** Alpha-blended marks lying on the ground (scorch, markers, rings): drawn first. */
  readonly ground: Pool;
  readonly group = new THREE.Group();

  constructor() {
    const atlas = particleAtlas();
    this.ground = new Pool(500, atlas, false, 3.5); // (under the ground marks, order 4)
    this.norm = new Pool(2400, atlas, false, 5);
    this.add = new Pool(3000, atlas, true, 6);
    this.group.add(this.ground.mesh, this.norm.mesh, this.add.mesh);
  }

  private pool(additive: boolean | undefined, flat: boolean | undefined): Pool {
    return additive ? this.add : flat ? this.ground : this.norm;
  }

  /** One particle with full control (the end tint defaults to the start tint). */
  spawn(p: Partial<Particle> & { x: number; y: number; z: number; life: number; tex: number }, additive = false): void {
    const pool = this.pool(additive, p.flat);
    const full = Object.assign(pool.take(), p);
    if (p.r1 === undefined) {
      full.r1 = full.r;
      full.g1 = full.g;
      full.b1 = full.b;
    }
    pool.add(full);
  }

  /** `count` particles at tile point (x, y), height h. */
  emit(cfg: EmitCfg, x: number, y: number, h: number, count = 1): void {
    const pool = this.pool(cfg.additive, cfg.flat);
    const al = cfg.alpha ?? [1, 0];
    const rotMax = cfg.rot ?? (cfg.flat || cfg.spin ? Math.PI * 2 : 0);
    for (let i = 0; i < count; i++) {
      const p = pool.take();
      const a = Math.random() * Math.PI * 2;
      const sp = cfg.speed ? rand(cfg.speed) : 0;
      const size = rand(cfg.size);
      const off = cfg.spread ? Math.random() * cfg.spread : 0;
      const oa = Math.random() * Math.PI * 2;
      p.x = x + Math.cos(oa) * off;
      p.y = h;
      p.z = y + Math.sin(oa) * off;
      p.vx = Math.cos(a) * sp + (cfg.wind ? cfg.wind[0] : 0);
      p.vz = Math.sin(a) * sp + (cfg.wind ? cfg.wind[1] : 0);
      p.vy = cfg.up ? rand(cfg.up) : 0;
      p.life = rand(cfg.life);
      p.size0 = size;
      p.size1 = size * (cfg.grow ? rand(cfg.grow) : 1);
      p.alpha0 = al[0];
      p.alpha1 = al[1];
      col.setHex(cfg.tints[Math.floor(Math.random() * cfg.tints.length)] ?? 0xffffff);
      p.r = col.r;
      p.g = col.g;
      p.b = col.b;
      if (cfg.end !== undefined) col.setHex(cfg.end);
      p.r1 = col.r;
      p.g1 = col.g;
      p.b1 = col.b;
      p.tex = cfg.tex2 !== undefined && Math.random() < 0.5 ? cfg.tex2 : cfg.tex;
      p.rot = rotMax > 0 ? (Math.random() - 0.5) * 2 * Math.min(Math.PI, rotMax) : 0;
      p.spin = cfg.spin ? (Math.random() - 0.5) * cfg.spin : 0;
      p.gravity = cfg.gravity ?? 0;
      p.drag = cfg.drag ?? 1;
      p.flat = cfg.flat ?? false;
      p.fadeIn = cfg.fadeIn ?? 0;
      p.fadeFast = cfg.fadeFast ?? false;
      p.easeOut = cfg.easeOut ?? false;
      pool.add(p);
    }
  }

  update(dtMs: number): void {
    this.ground.update(dtMs);
    this.norm.update(dtMs);
    this.add.update(dtMs);
  }

  get count(): number {
    return this.ground.count + this.norm.count + this.add.count;
  }

  /** How full the smoke-and-matter pool is (0–1): optional puffs (missile trails) thin out as it fills, so they never crowd out longer smoke. */
  get load(): number {
    return this.norm.count / this.norm.cap;
  }

  clear(): void {
    this.ground.clear();
    this.norm.clear();
    this.add.clear();
  }
}

export { TEX };
