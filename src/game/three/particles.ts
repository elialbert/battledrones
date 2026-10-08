import * as THREE from "three";
import { TEX, particleAtlas, type TexCell } from "./textures";

/**
 * GPU-instanced particles: every puff of smoke, fire, spark, dust, shock
 * ring and scorch mark is one instance of a quad in one of two pools
 * (additive light, alpha-blended matter). Quads either face the camera or
 * lie flat on the ground. The CPU integrates motion and writes the
 * instance buffers once per frame; drawing is two calls whatever the count.
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
  r: number;
  g: number;
  b: number;
  tex: number;
  rot: number;
  spin: number;
  /** Units/s² added to vy (negative falls). */
  gravity: number;
  /** Fraction of velocity kept per second. */
  drag: number;
  flat: boolean;
}

export interface EmitCfg {
  tex: TexCell;
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
  gravity?: number;
  drag?: number;
  spin?: number;
  flat?: boolean;
  /** Random spawn offset radius (units). */
  spread?: number;
}

const VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec4 iColor;
attribute vec3 iMisc; // size, rotation, tex + 8 * flat
varying vec2 vUv;
varying vec4 vColor;
void main() {
  float c = cos( iMisc.y );
  float s = sin( iMisc.y );
  vec2 q = vec2( position.x * c - position.y * s, position.x * s + position.y * c ) * iMisc.x;
  float isFlat = step( 8.0, iMisc.z );
  float cellI = iMisc.z - isFlat * 8.0;
  vec3 right = vec3( viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0] );
  vec3 up = vec3( viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1] );
  vec3 world = mix( iPos + right * q.x + up * q.y, iPos + vec3( q.x, 0.0, q.y ), isFlat );
  gl_Position = projectionMatrix * viewMatrix * vec4( world, 1.0 );
  float col = mod( cellI, 4.0 );
  float row = floor( cellI / 4.0 + 0.01 );
  vUv = vec2( ( col + uv.x ) / 4.0, ( ( 1.0 - row ) + uv.y ) / 2.0 );
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

class Pool {
  readonly mesh: THREE.Mesh;
  private list: Particle[] = [];
  private pos: Float32Array;
  private color: Float32Array;
  private misc: Float32Array;
  private geo: THREE.InstancedBufferGeometry;
  private aPos: THREE.InstancedBufferAttribute;
  private aColor: THREE.InstancedBufferAttribute;
  private aMisc: THREE.InstancedBufferAttribute;

  constructor(private cap: number, map: THREE.Texture, additive: boolean) {
    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute("position", quad.attributes.position!);
    geo.setAttribute("uv", quad.attributes.uv!);
    this.pos = new Float32Array(cap * 3);
    this.color = new Float32Array(cap * 4);
    this.misc = new Float32Array(cap * 3);
    this.aPos = new THREE.InstancedBufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aColor = new THREE.InstancedBufferAttribute(this.color, 4).setUsage(THREE.DynamicDrawUsage);
    this.aMisc = new THREE.InstancedBufferAttribute(this.misc, 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("iPos", this.aPos);
    geo.setAttribute("iColor", this.aColor);
    geo.setAttribute("iMisc", this.aMisc);
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
    this.mesh.renderOrder = additive ? 6 : 5;
  }

  add(p: Particle): void {
    if (this.list.length >= this.cap) this.list.shift();
    this.list.push(p);
  }

  get count(): number {
    return this.list.length;
  }

  update(dtMs: number): void {
    const dt = dtMs / 1000;
    const out: Particle[] = [];
    for (const p of this.list) {
      p.t += dtMs;
      if (p.t >= p.life) continue;
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
      out.push(p);
    }
    this.list = out;
    const n = out.length;
    for (let i = 0; i < n; i++) {
      const p = out[i]!;
      const k = p.t / p.life;
      this.pos[i * 3] = p.x;
      this.pos[i * 3 + 1] = p.y;
      this.pos[i * 3 + 2] = p.z;
      this.color[i * 4] = p.r;
      this.color[i * 4 + 1] = p.g;
      this.color[i * 4 + 2] = p.b;
      this.color[i * 4 + 3] = p.alpha0 + (p.alpha1 - p.alpha0) * k;
      this.misc[i * 3] = p.size0 + (p.size1 - p.size0) * k;
      this.misc[i * 3 + 1] = p.rot;
      this.misc[i * 3 + 2] = p.tex + (p.flat ? 8 : 0);
    }
    this.geo.instanceCount = n;
    if (n > 0) {
      for (const a of [this.aPos, this.aColor, this.aMisc]) {
        a.clearUpdateRanges();
        a.addUpdateRange(0, n * a.itemSize);
        a.needsUpdate = true;
      }
    }
  }

  clear(): void {
    this.list = [];
    this.geo.instanceCount = 0;
  }
}

const rand = (r: [number, number]) => r[0] + Math.random() * (r[1] - r[0]);

export class Particles {
  readonly add: Pool;
  readonly norm: Pool;
  readonly group = new THREE.Group();

  constructor() {
    const atlas = particleAtlas();
    this.norm = new Pool(2600, atlas, false);
    this.add = new Pool(3200, atlas, true);
    this.group.add(this.norm.mesh, this.add.mesh);
  }

  /** One particle with full control. */
  spawn(p: Partial<Particle> & { x: number; y: number; z: number; life: number; tex: number }, additive = false): void {
    const full: Particle = {
      vx: 0, vy: 0, vz: 0, t: 0, size0: 1, size1: 1, alpha0: 1, alpha1: 0,
      r: 1, g: 1, b: 1, rot: 0, spin: 0, gravity: 0, drag: 1, flat: false,
      ...p
    };
    (additive ? this.add : this.norm).add(full);
  }

  /** `count` particles at tile point (x, y), height h. */
  emit(cfg: EmitCfg, x: number, y: number, h: number, count = 1): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = cfg.speed ? rand(cfg.speed) : 0;
      const size = rand(cfg.size);
      const grow = cfg.grow ? rand(cfg.grow) : 1;
      const al = cfg.alpha ?? [1, 0];
      col.setHex(cfg.tints[Math.floor(Math.random() * cfg.tints.length)] ?? 0xffffff);
      const off = cfg.spread ? Math.random() * cfg.spread : 0;
      const oa = Math.random() * Math.PI * 2;
      this.spawn(
        {
          x: x + Math.cos(oa) * off,
          y: h,
          z: y + Math.sin(oa) * off,
          vx: Math.cos(a) * sp,
          vz: Math.sin(a) * sp,
          vy: cfg.up ? rand(cfg.up) : 0,
          life: rand(cfg.life),
          size0: size,
          size1: size * grow,
          alpha0: al[0],
          alpha1: al[1],
          r: col.r,
          g: col.g,
          b: col.b,
          tex: cfg.tex,
          rot: cfg.flat || cfg.spin ? Math.random() * Math.PI * 2 : 0,
          spin: cfg.spin ? (Math.random() - 0.5) * cfg.spin : 0,
          gravity: cfg.gravity ?? 0,
          drag: cfg.drag ?? 1,
          flat: cfg.flat ?? false
        },
        cfg.additive
      );
    }
  }

  update(dtMs: number): void {
    this.norm.update(dtMs);
    this.add.update(dtMs);
  }

  get count(): number {
    return this.norm.count + this.add.count;
  }

  clear(): void {
    this.norm.clear();
    this.add.clear();
  }
}

export { TEX };
