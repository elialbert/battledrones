import * as THREE from "three";
import type { CameraRig } from "./camera";
import { fogged } from "./materials";

/**
 * Immediate-mode vector drawing ON the 3D ground — a Phaser.Graphics for the
 * battlefield: rings, arcs, lines, discs and rectangles in tile coordinates,
 * draped over the terrain heights (or at an explicit height for aircraft),
 * with line widths given in CSS pixels so they read the same at any zoom.
 * Everything drawn between clear() and flush() becomes one dynamic mesh.
 *
 * Strokes are mitred polylines (no gaps or doubled-up beads at the joints)
 * with a feathered edge and a soft dark halo, so a ring reads as crisply on
 * snow and sand as on grass or ash, and stays smooth when the adaptive
 * controller lowers the 3D resolution. Draped strokes sample the terrain
 * under both edges every third of a tile (the heightfield's own spacing),
 * so they hug slopes instead of cutting into them. Halos and edges are
 * drawn before every core and fill, so crossing and overlapping marks stay
 * whole instead of notching each other.
 */

export interface GroundGfxOpts {
  /** Darkened by the fog of war (else it reads through it). */
  fog?: boolean;
  /** Drawn over everything (no depth test): placement and calldown marks. */
  onTop?: boolean;
  order?: number;
  lift?: number;
}

/**
 * The contrast halo round every stroke: colour, width (CSS px) and peak
 * strength. It is there for the bold marks, so it scales with the square of
 * the stroke's alpha and narrows on lines under 2 px: faint ambient strokes
 * (order lines, range rings) stay light, and a 2 px selection ring outweighs
 * a 1.6 px combat ring.
 */
const HALO_COLOR = 0x04070c;
const HALO_PX = 1.6;
const HALO_ALPHA = 0.7;
/** The anti-aliased edge between a stroke and its halo (CSS px). */
const FEATHER_PX = 0.8;
/** Draped strokes and fills are split at least this often (tiles): the terrain lattice is 3 samples per tile. */
const DRAPE_STEP = 0.32;
/** A sharp joint's mitre is clamped to this many half-widths. */
const MITER_LIMIT = 3;

const c = new THREE.Color();
/** Linear 0–255 RGBA for a hex colour and alpha (vertex colours are 8-bit). */
function rgba(out: Uint8Array, hex: number, alpha: number): void {
  c.setHex(hex);
  out[0] = Math.round(c.r * 255);
  out[1] = Math.round(c.g * 255);
  out[2] = Math.round(c.b * 255);
  out[3] = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
}
const HALO_RGB = new Uint8Array(4);
rgba(HALO_RGB, HALO_COLOR, 1);

export class GroundGfx {
  readonly mesh: THREE.Mesh;
  private geo = new THREE.BufferGeometry();
  private pos: Float32Array;
  private col: Uint8Array;
  /** 16-bit indices until a frame needs more than 65536 vertices (half the upload). */
  private idx: Uint16Array | Uint32Array;
  /** Core and fill triangles, appended after the halos and edges at flush. */
  private cidx = new Uint32Array(8192);
  private vcap = 4096;
  private icap = 12288;
  private nv = 0;
  private ni = 0;
  private nc = 0;
  private lw = 2;
  private halo = 1;
  private lc = new Uint8Array([255, 255, 255, 255]);
  private fc = new Uint8Array([255, 255, 255, 255]);
  private lift: number;
  /** Scratch polyline (tiles), reused every frame: no per-shape allocations. */
  private sx = new Float64Array(256);
  private sy = new Float64Array(256);
  private sn = 0;
  /** Scratch segment directions for the polyline being stroked. */
  private dx = new Float64Array(256);
  private dz = new Float64Array(256);
  /** Scratch stroke profile across the line: offsets (× world px) and colours. */
  private off = new Float64Array(6);
  private pc = new Uint8Array(24);

  constructor(
    private rig: CameraRig,
    private heightAt: (x: number, y: number) => number,
    o: GroundGfxOpts = {}
  ) {
    this.pos = new Float32Array(this.vcap * 3);
    this.col = new Uint8Array(this.vcap * 4);
    this.idx = new Uint16Array(this.icap);
    this.attach();
    this.attachIndex();
    let mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      depthTest: !o.onTop,
      side: THREE.DoubleSide,
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4
    });
    if (o.fog) mat = fogged(mat, { clouds: false, key: "gfx" });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = o.order ?? (o.onTop ? 20 : 4);
    this.lift = o.lift ?? 0.04;
  }

  private attach(): void {
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute("color", new THREE.BufferAttribute(this.col, 4, true).setUsage(THREE.DynamicDrawUsage));
  }

  clear(): this {
    this.nv = 0;
    this.ni = 0;
    this.nc = 0;
    return this;
  }

  /**
   * Line width in CSS px. `halo` scales the dark contrast halo (0 = none: a
   * mark that is itself a dark backing, or a glow that wants no edge).
   */
  lineStyle(css: number, color: number, alpha = 1, halo = 1): this {
    this.lw = css;
    this.halo = halo;
    rgba(this.lc, color, alpha);
    return this;
  }

  fillStyle(color: number, alpha = 1): this {
    rgba(this.fc, color, alpha);
    return this;
  }

  /** World units per CSS px around a point. */
  px(x: number, y: number, h = 0): number {
    return this.rig.worldPerPx(x, y, h);
  }

  private y(x: number, z: number, h?: number): number {
    return h ?? this.heightAt(x, z) + this.lift;
  }

  // ------------------------------------------------------------ buffers ---

  private vert(x: number, y: number, z: number, k: Uint8Array, ko = 0, alpha = -1): number {
    if (this.nv >= this.vcap) {
      this.vcap *= 2;
      const p = new Float32Array(this.vcap * 3);
      p.set(this.pos);
      const cc = new Uint8Array(this.vcap * 4);
      cc.set(this.col);
      this.pos = p;
      this.col = cc;
      this.attach();
      if (this.vcap > 65536 && this.idx instanceof Uint16Array) this.growIndex(this.icap);
    }
    const i = this.nv++;
    const p = this.pos;
    p[i * 3] = x;
    p[i * 3 + 1] = y;
    p[i * 3 + 2] = z;
    const cc = this.col;
    cc[i * 4] = k[ko]!;
    cc[i * 4 + 1] = k[ko + 1]!;
    cc[i * 4 + 2] = k[ko + 2]!;
    cc[i * 4 + 3] = alpha >= 0 ? alpha : k[ko + 3]!;
    return i;
  }

  private attachIndex(): void {
    this.geo.setIndex(new THREE.BufferAttribute(this.idx, 1).setUsage(THREE.DynamicDrawUsage));
  }

  private growIndex(cap: number): void {
    this.icap = cap;
    const ii = this.vcap > 65536 ? new Uint32Array(cap) : new Uint16Array(cap);
    ii.set(this.idx);
    this.idx = ii;
    this.attachIndex();
  }

  /** A halo / edge triangle (drawn first). */
  private tri(a: number, b: number, d: number): void {
    if (this.ni + 3 > this.icap) this.growIndex(this.icap * 2);
    const ii = this.idx;
    ii[this.ni++] = a;
    ii[this.ni++] = b;
    ii[this.ni++] = d;
  }

  /** A core or fill triangle (drawn after every halo, in order). */
  private triTop(a: number, b: number, d: number): void {
    if (this.nc + 3 > this.cidx.length) {
      const ii = new Uint32Array(this.cidx.length * 2);
      ii.set(this.cidx);
      this.cidx = ii;
    }
    const ii = this.cidx;
    ii[this.nc++] = a;
    ii[this.nc++] = b;
    ii[this.nc++] = d;
  }

  // ---------------------------------------------------- scratch polyline ---

  private pt(x: number, y: number): void {
    if (this.sn >= this.sx.length) {
      const nx = new Float64Array(this.sx.length * 2);
      nx.set(this.sx);
      const ny = new Float64Array(this.sy.length * 2);
      ny.set(this.sy);
      this.sx = nx;
      this.sy = ny;
    }
    this.sx[this.sn] = x;
    this.sy[this.sn] = y;
    this.sn++;
  }

  /** Extend the scratch polyline to (x, y); a draped one is split so it follows the terrain. */
  private ptTo(x: number, y: number, draped: boolean): void {
    const n = this.sn;
    if (n > 0 && draped) {
      const x0 = this.sx[n - 1]!;
      const y0 = this.sy[n - 1]!;
      const parts = Math.ceil(Math.sqrt((x - x0) * (x - x0) + (y - y0) * (y - y0)) / DRAPE_STEP);
      for (let i = 1; i < parts; i++) this.pt(x0 + ((x - x0) * i) / parts, y0 + ((y - y0) * i) / parts);
    }
    this.pt(x, y);
  }

  /** Segments for an ellipse arc: smooth on screen, and short enough to drape. */
  private segsFor(rx: number, ry: number, span: number): number {
    const r = Math.max(rx, ry);
    const turn = Math.min(1, span / (Math.PI * 2));
    const n = Math.ceil(Math.max(r * 22 + 8, (r * Math.PI * 2) / DRAPE_STEP) * turn);
    return Math.max(turn > 0.999 ? 8 : 2, Math.min(128, n));
  }

  /** Scratch polyline along an ellipse arc (angles in radians, clockwise from east). */
  private ringPts(x: number, y: number, rx: number, ry: number, a0: number, a1: number, closed: boolean): void {
    const segs = this.segsFor(rx, ry, Math.abs(a1 - a0));
    this.sn = 0;
    const n = closed ? segs : segs + 1;
    for (let i = 0; i < n; i++) {
      const a = a0 + ((a1 - a0) * i) / segs;
      this.pt(x + Math.cos(a) * rx, y + Math.sin(a) * ry);
    }
  }

  // ------------------------------------------------------------ strokes ---

  /** Set profile vertex m: offset (CSS px) and colour; returns m + 1. */
  private prof(m: number, o: number, src: Uint8Array, a: number): number {
    this.off[m] = o;
    const pc = this.pc;
    pc[m * 4] = src[0]!;
    pc[m * 4 + 1] = src[1]!;
    pc[m * 4 + 2] = src[2]!;
    pc[m * 4 + 3] = a;
    return m + 1;
  }

  /**
   * Stroke the scratch polyline. Across the line each point carries a
   * profile — halo (fading out), the feathered edge, the solid core, and back
   * — joined to the next point's by mitred bands; open ends get a short fade.
   */
  private stroke(closed: boolean, h?: number): void {
    const n = this.sn;
    if (n < 2) return;
    const X = this.sx;
    const Y = this.sy;
    const k = this.lc;
    if (k[3] === 0) return;
    const ka = k[3]! / 255;
    const haloA = Math.round(255 * HALO_ALPHA * ka * ka * this.halo);
    const halo = haloA > 0;
    // the profile across the line, in CSS px from its centre (scaled per point)
    const off = this.off;
    const pc = this.pc;
    const hw = this.lw / 2;
    let K = 0;
    if (halo) {
      // the full width stays solid; its edge shades into the dark rim, which fades out
      const core = hw;
      const edge = hw + FEATHER_PX;
      const out = edge + HALO_PX * this.halo * Math.min(1, Math.max(0.5, hw));
      K = this.prof(K, -out, HALO_RGB, 0);
      K = this.prof(K, -edge, HALO_RGB, haloA);
      K = this.prof(K, -core, k, k[3]!);
      K = this.prof(K, core, k, k[3]!);
      K = this.prof(K, edge, HALO_RGB, haloA);
      K = this.prof(K, out, HALO_RGB, 0);
    } else {
      const core = Math.max(0, hw - FEATHER_PX / 2);
      const edge = hw + FEATHER_PX / 2;
      K = this.prof(K, -edge, k, 0);
      K = this.prof(K, -core, k, k[3]!);
      K = this.prof(K, core, k, k[3]!);
      K = this.prof(K, edge, k, 0);
    }
    const draped = h === undefined;
    const base = this.nv;
    // unit direction of each segment (i → i + 1; the last wraps when closed)
    const segs = closed ? n : n - 1;
    if (this.dx.length < n) {
      this.dx = new Float64Array(this.sx.length);
      this.dz = new Float64Array(this.sx.length);
    }
    const DX = this.dx;
    const DZ = this.dz;
    for (let i = 0; i < segs; i++) {
      const j = i + 1 < n ? i + 1 : 0;
      const ex = X[j]! - X[i]!;
      const ez = Y[j]! - Y[i]!;
      const l = Math.sqrt(ex * ex + ez * ez) || 1;
      DX[i] = ex / l;
      DZ[i] = ez / l;
    }
    let wpp = 0;
    let px0 = 0;
    for (let i = 0; i < n; i++) {
      const x = X[i]!;
      const z = Y[i]!;
      // tangent: the mean of the incoming and outgoing directions
      const ia = i > 0 ? i - 1 : closed ? n - 1 : 0;
      const ib = i < segs ? i : i - 1;
      const ax = DX[ia]!;
      const az = DZ[ia]!;
      const bx = DX[ib]!;
      const bz = DZ[ib]!;
      let tx = ax + bx;
      let tz = az + bz;
      const tl = Math.sqrt(tx * tx + tz * tz);
      if (tl < 1e-6) {
        tx = bx;
        tz = bz;
      } else {
        tx /= tl;
        tz /= tl;
      }
      const miter = Math.min(MITER_LIMIT, 1 / Math.max(1 / MITER_LIMIT, tx * bx + tz * bz));
      const yc = this.y(x, z, h);
      // (the pixel scale drifts slowly along a line: refresh it every few points)
      if ((i & 7) === 0) wpp = this.rig.worldPerPx(x, z, yc);
      if (i === 0) px0 = wpp;
      const nx = -tz * miter * wpp;
      const nz = tx * miter * wpp;
      // draped: sample the ground under both outer edges too
      const o0 = off[0]!;
      const o1 = off[K - 1]!;
      const y0 = draped ? this.y(x + nx * o0, z + nz * o0) : yc;
      const y1 = draped ? this.y(x + nx * o1, z + nz * o1) : yc;
      for (let j = 0; j < K; j++) {
        const o = off[j]!;
        let yy = y0 + ((y1 - y0) * (o - o0)) / (o1 - o0);
        if (j > 0 && j < K - 1) yy = Math.max(yy, yc);
        this.vert(x + nx * o, yy, z + nz * o, pc, j * 4);
      }
    }
    const rows = closed ? n : n - 1;
    const coreBand = (K >> 1) - 1;
    for (let i = 0; i < rows; i++) {
      const a = base + i * K;
      const b = base + ((i + 1) % n) * K;
      for (let j = 0; j < K - 1; j++) {
        if (j === coreBand) {
          this.triTop(a + j, b + j, a + j + 1);
          this.triTop(a + j + 1, b + j, b + j + 1);
        } else {
          this.tri(a + j, b + j, a + j + 1);
          this.tri(a + j + 1, b + j, b + j + 1);
        }
      }
    }
    if (closed) return;
    // open ends fade out just past the end (short, so lines meeting at a point, like a chevron, keep a clean tip)
    const cap = FEATHER_PX * 1.25;
    this.capEnd(base, K, X[0]!, Y[0]!, X[1]!, Y[1]!, cap * px0);
    const last = base + (n - 1) * K;
    this.capEnd(last, K, X[n - 1]!, Y[n - 1]!, X[n - 2]!, Y[n - 2]!, cap * wpp);
  }

  /** A fade-out cap past an open end (the row of K profile vertices at `row`), pointing away from (bx, by). */
  private capEnd(row: number, K: number, x: number, y: number, bx: number, by: number, len: number): void {
    let dx = x - bx;
    let dz = y - by;
    const l = Math.sqrt(dx * dx + dz * dz);
    if (l < 1e-9 || len <= 0) return;
    dx = (dx / l) * len;
    dz = (dz / l) * len;
    const first = this.nv;
    for (let j = 0; j < K; j++) {
      const v = (row + j) * 3;
      const p = this.pos; // (re-read: vert() may grow the buffers)
      this.vert(p[v]! + dx, p[v + 1]!, p[v + 2]! + dz, this.pc, j * 4, 0);
    }
    for (let j = 0; j < K - 1; j++) {
      this.tri(row + j, first + j, row + j + 1);
      this.tri(row + j + 1, first + j, first + j + 1);
    }
  }

  /** Stroke a polyline (closed joins the ends). */
  strokePoints(pts: { x: number; y: number }[], closed = false, h?: number): this {
    if (pts.length < 2) return this;
    const draped = h === undefined;
    this.sn = 0;
    this.pt(pts[0]!.x, pts[0]!.y);
    for (let i = 1; i < pts.length; i++) this.ptTo(pts[i]!.x, pts[i]!.y, draped);
    if (closed) {
      const f = pts[0]!;
      this.ptTo(f.x, f.y, draped);
      this.sn--; // (the closing point is the first one again)
    }
    this.stroke(closed && this.sn > 2, h);
    return this;
  }

  lineBetween(x0: number, y0: number, x1: number, y1: number, h?: number): this {
    this.sn = 0;
    this.pt(x0, y0);
    this.ptTo(x1, y1, h === undefined);
    this.stroke(false, h);
    return this;
  }

  /** Arc stroke (angles in radians, clockwise from east, like the 2D canvas). */
  arc(x: number, y: number, r: number, a0: number, a1: number, h?: number): this {
    if (r <= 0 || a1 === a0) return this;
    const full = Math.abs(a1 - a0) >= Math.PI * 2 - 1e-6;
    this.ringPts(x, y, r, r, a0, a1, full);
    this.stroke(full, h);
    return this;
  }

  strokeCircle(x: number, y: number, r: number, h?: number): this {
    return this.arc(x, y, r, 0, Math.PI * 2, h);
  }

  strokeEllipse(x: number, y: number, w: number, hgt: number, h?: number): this {
    if (w <= 0 || hgt <= 0) return this;
    this.ringPts(x, y, w / 2, hgt / 2, 0, Math.PI * 2, true);
    this.stroke(true, h);
    return this;
  }

  strokeRect(x: number, y: number, w: number, hgt: number, h?: number): this {
    const draped = h === undefined;
    this.sn = 0;
    this.pt(x, y);
    this.ptTo(x + w, y, draped);
    this.ptTo(x + w, y + hgt, draped);
    this.ptTo(x, y + hgt, draped);
    this.ptTo(x, y, draped);
    this.sn--;
    this.stroke(true, h);
    return this;
  }

  // -------------------------------------------------------------- fills ---

  /** Filled ellipse: a fan, with inner rings on big ones so it drapes over bumps. */
  private fan(x: number, y: number, rx: number, ry: number, h?: number): this {
    if (rx <= 0 || ry <= 0 || this.fc[3] === 0) return this;
    const segs = this.segsFor(rx, ry, Math.PI * 2);
    const rings = h === undefined ? Math.max(1, Math.min(4, Math.ceil(Math.max(rx, ry) / 1.2))) : 1;
    const k = this.fc;
    const centre = this.vert(x, this.y(x, y, h), y, k);
    let prev = -1;
    for (let r = 1; r <= rings; r++) {
      const f = r / rings;
      const row = this.nv;
      for (let i = 0; i < segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        const px = x + Math.cos(a) * rx * f;
        const py = y + Math.sin(a) * ry * f;
        this.vert(px, this.y(px, py, h), py, k);
      }
      for (let i = 0; i < segs; i++) {
        const j = (i + 1) % segs;
        if (prev < 0) this.triTop(centre, row + i, row + j);
        else {
          this.triTop(prev + i, row + i, prev + j);
          this.triTop(prev + j, row + i, row + j);
        }
      }
      prev = row;
    }
    return this;
  }

  fillCircle(x: number, y: number, r: number, h?: number): this {
    return this.fan(x, y, r, r, h);
  }

  fillEllipse(x: number, y: number, w: number, hgt: number, h?: number): this {
    return this.fan(x, y, w / 2, hgt / 2, h);
  }

  /** Filled rectangle, split into a grid of ~2/3-tile cells so it hugs the terrain. */
  fillRect(x: number, y: number, w: number, hgt: number, h?: number): this {
    if (w <= 0 || hgt <= 0 || this.fc[3] === 0) return this;
    const step = h === undefined ? DRAPE_STEP * 2 : Infinity;
    const nx = Math.max(1, Math.ceil(w / step));
    const ny = Math.max(1, Math.ceil(hgt / step));
    const k = this.fc;
    const base = this.nv;
    for (let j = 0; j <= ny; j++)
      for (let i = 0; i <= nx; i++) {
        const px = x + (w * i) / nx;
        const pz = y + (hgt * j) / ny;
        this.vert(px, this.y(px, pz, h), pz, k);
      }
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const a = base + j * (nx + 1) + i;
        const b = a + nx + 1;
        this.triTop(a, a + 1, b + 1);
        this.triTop(a, b + 1, b);
      }
    return this;
  }

  /** Filled convex polygon. */
  fillPoints(pts: { x: number; y: number }[], h?: number): this {
    if (pts.length < 3 || this.fc[3] === 0) return this;
    const k = this.fc;
    const base = this.nv;
    for (const p of pts) this.vert(p.x, this.y(p.x, p.y, h), p.y, k);
    for (let i = 1; i < pts.length - 1; i++) this.triTop(base, base + i, base + i + 1);
    return this;
  }

  /** Upload this frame's shapes. */
  flush(): void {
    // the cores and fills go after every halo and edge
    const n = this.ni + this.nc;
    if (n > this.icap) this.growIndex(Math.max(n, this.icap * 2));
    this.idx.set(this.cidx.subarray(0, this.nc), this.ni);
    const p = this.geo.attributes.position as THREE.BufferAttribute;
    const cc = this.geo.attributes.color as THREE.BufferAttribute;
    const ix = this.geo.index!;
    if (n > 0) {
      p.clearUpdateRanges();
      p.addUpdateRange(0, this.nv * 3);
      p.needsUpdate = true;
      cc.clearUpdateRanges();
      cc.addUpdateRange(0, this.nv * 4);
      cc.needsUpdate = true;
      ix.clearUpdateRanges();
      ix.addUpdateRange(0, n);
      ix.needsUpdate = true;
    }
    this.geo.setDrawRange(0, n);
    this.mesh.visible = n > 0;
  }

  dispose(): void {
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
