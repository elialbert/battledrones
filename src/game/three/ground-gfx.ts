import * as THREE from "three";
import type { CameraRig } from "./camera";
import { fogged } from "./materials";

/**
 * Immediate-mode vector drawing ON the 3D ground — a Phaser.Graphics for the
 * battlefield: rings, arcs, lines, discs and rectangles in tile coordinates,
 * draped over the terrain heights (or at an explicit height for aircraft),
 * with line widths given in CSS pixels so they read the same at any zoom.
 * Everything drawn between clear() and flush() becomes one dynamic mesh.
 */

export interface GroundGfxOpts {
  /** Darkened by the fog of war (else it reads through it). */
  fog?: boolean;
  /** Drawn over everything (no depth test): placement and calldown marks. */
  onTop?: boolean;
  order?: number;
  lift?: number;
}

const c = new THREE.Color();

export class GroundGfx {
  readonly mesh: THREE.Mesh;
  private geo = new THREE.BufferGeometry();
  private pos: Float32Array;
  private col: Float32Array;
  private cap = 4096;
  private n = 0;
  private lw = 2;
  private lc = [1, 1, 1, 1];
  private fc = [1, 1, 1, 1];
  private lift: number;

  constructor(
    private rig: CameraRig,
    private heightAt: (x: number, y: number) => number,
    o: GroundGfxOpts = {}
  ) {
    this.pos = new Float32Array(this.cap * 3);
    this.col = new Float32Array(this.cap * 4);
    this.attach();
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
    this.geo.setAttribute("color", new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
  }

  clear(): this {
    this.n = 0;
    return this;
  }

  /** Line width in CSS px. */
  lineStyle(css: number, color: number, alpha = 1): this {
    c.setHex(color);
    this.lw = css;
    this.lc = [c.r, c.g, c.b, alpha];
    return this;
  }

  fillStyle(color: number, alpha = 1): this {
    c.setHex(color);
    this.fc = [c.r, c.g, c.b, alpha];
    return this;
  }

  /** World units per CSS px around a point. */
  px(x: number, y: number, h = 0): number {
    return this.rig.worldPerPx(x, y, h);
  }

  private y(x: number, z: number, h?: number): number {
    return h ?? this.heightAt(x, z) + this.lift;
  }

  private v(x: number, y: number, z: number, k: number[]): void {
    if (this.n >= this.cap) {
      this.cap *= 2;
      const p = new Float32Array(this.cap * 3);
      p.set(this.pos);
      const cc = new Float32Array(this.cap * 4);
      cc.set(this.col);
      this.pos = p;
      this.col = cc;
      this.attach();
    }
    const i = this.n++;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.col[i * 4] = k[0]!;
    this.col[i * 4 + 1] = k[1]!;
    this.col[i * 4 + 2] = k[2]!;
    this.col[i * 4 + 3] = k[3]!;
  }

  /** A thick segment as a quad (width w world units). */
  private seg(x0: number, z0: number, x1: number, z1: number, w: number, h?: number): void {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    if (len < 1e-5) return;
    const nx = (-dz / len) * (w / 2);
    const nz = (dx / len) * (w / 2);
    const y0 = this.y(x0, z0, h);
    const y1 = this.y(x1, z1, h);
    const k = this.lc;
    this.v(x0 + nx, y0, z0 + nz, k);
    this.v(x1 + nx, y1, z1 + nz, k);
    this.v(x1 - nx, y1, z1 - nz, k);
    this.v(x0 + nx, y0, z0 + nz, k);
    this.v(x1 - nx, y1, z1 - nz, k);
    this.v(x0 - nx, y0, z0 - nz, k);
  }

  /** Stroke a polyline (closed joins the ends). */
  strokePoints(pts: { x: number; y: number }[], closed = false, h?: number): this {
    if (pts.length < 2) return this;
    const mid = pts[Math.floor(pts.length / 2)]!;
    const w = this.lw * this.px(mid.x, mid.y, h ?? 0);
    const n = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      this.segFine(a.x, a.y, b.x, b.y, w, h);
    }
    return this;
  }

  /** Long segments are split so they follow the terrain. */
  private segFine(x0: number, y0: number, x1: number, y1: number, w: number, h?: number): void {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const parts = h === undefined ? Math.max(1, Math.ceil(len / 0.5)) : 1;
    for (let i = 0; i < parts; i++) {
      const a = i / parts;
      const b = (i + 1) / parts;
      this.seg(x0 + (x1 - x0) * a, y0 + (y1 - y0) * a, x0 + (x1 - x0) * b, y0 + (y1 - y0) * b, w, h);
    }
  }

  lineBetween(x0: number, y0: number, x1: number, y1: number, h?: number): this {
    const w = this.lw * this.px((x0 + x1) / 2, (y0 + y1) / 2, h ?? 0);
    this.segFine(x0, y0, x1, y1, w, h);
    return this;
  }

  private ring(x: number, y: number, rx: number, ry: number, a0: number, a1: number): { x: number; y: number }[] {
    const span = Math.abs(a1 - a0);
    const segs = Math.max(8, Math.min(72, Math.ceil(Math.max(rx, ry) * 22 * (span / (Math.PI * 2))) + 8));
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i <= segs; i++) {
      const a = a0 + ((a1 - a0) * i) / segs;
      pts.push({ x: x + Math.cos(a) * rx, y: y + Math.sin(a) * ry });
    }
    return pts;
  }

  /** Arc stroke (angles in radians, clockwise from east, like the 2D canvas). */
  arc(x: number, y: number, r: number, a0: number, a1: number, h?: number): this {
    if (r <= 0) return this;
    const pts = this.ring(x, y, r, r, a0, a1);
    const w = this.lw * this.px(x, y, h ?? 0);
    for (let i = 0; i < pts.length - 1; i++) this.seg(pts[i]!.x, pts[i]!.y, pts[i + 1]!.x, pts[i + 1]!.y, w, h);
    return this;
  }

  strokeCircle(x: number, y: number, r: number, h?: number): this {
    return this.arc(x, y, r, 0, Math.PI * 2, h);
  }

  strokeEllipse(x: number, y: number, w: number, hgt: number, h?: number): this {
    const pts = this.ring(x, y, w / 2, hgt / 2, 0, Math.PI * 2);
    return this.strokePoints(pts, false, h);
  }

  private fan(x: number, y: number, rx: number, ry: number, h?: number): this {
    const pts = this.ring(x, y, rx, ry, 0, Math.PI * 2);
    const cy = this.y(x, y, h);
    const k = this.fc;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      this.v(x, cy, y, k);
      this.v(a.x, this.y(a.x, a.y, h), a.y, k);
      this.v(b.x, this.y(b.x, b.y, h), b.y, k);
    }
    return this;
  }

  fillCircle(x: number, y: number, r: number, h?: number): this {
    return this.fan(x, y, r, r, h);
  }

  fillEllipse(x: number, y: number, w: number, hgt: number, h?: number): this {
    return this.fan(x, y, w / 2, hgt / 2, h);
  }

  /** Filled rectangle, split into ~1-tile cells so it hugs the terrain. */
  fillRect(x: number, y: number, w: number, hgt: number, h?: number): this {
    const nx = Math.max(1, Math.ceil(w));
    const ny = Math.max(1, Math.ceil(hgt));
    const k = this.fc;
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const x0 = x + (w * i) / nx;
        const x1 = x + (w * (i + 1)) / nx;
        const z0 = y + (hgt * j) / ny;
        const z1 = y + (hgt * (j + 1)) / ny;
        const a = this.y(x0, z0, h);
        const b = this.y(x1, z0, h);
        const cc = this.y(x1, z1, h);
        const d = this.y(x0, z1, h);
        this.v(x0, a, z0, k);
        this.v(x1, b, z0, k);
        this.v(x1, cc, z1, k);
        this.v(x0, a, z0, k);
        this.v(x1, cc, z1, k);
        this.v(x0, d, z1, k);
      }
    return this;
  }

  strokeRect(x: number, y: number, w: number, hgt: number, h?: number): this {
    return this.strokePoints(
      [
        { x, y },
        { x: x + w, y },
        { x: x + w, y: y + hgt },
        { x, y: y + hgt }
      ],
      true,
      h
    );
  }

  /** Filled convex polygon. */
  fillPoints(pts: { x: number; y: number }[], h?: number): this {
    if (pts.length < 3) return this;
    const k = this.fc;
    const o = pts[0]!;
    for (let i = 1; i < pts.length - 1; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      this.v(o.x, this.y(o.x, o.y, h), o.y, k);
      this.v(a.x, this.y(a.x, a.y, h), a.y, k);
      this.v(b.x, this.y(b.x, b.y, h), b.y, k);
    }
    return this;
  }

  /** Upload this frame's shapes. */
  flush(): void {
    const p = this.geo.attributes.position as THREE.BufferAttribute;
    const cc = this.geo.attributes.color as THREE.BufferAttribute;
    if (this.n > 0) {
      p.clearUpdateRanges();
      p.addUpdateRange(0, this.n * 3);
      p.needsUpdate = true;
      cc.clearUpdateRanges();
      cc.addUpdateRange(0, this.n * 4);
      cc.needsUpdate = true;
    }
    this.geo.setDrawRange(0, this.n);
    this.mesh.visible = this.n > 0;
  }

  dispose(): void {
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
