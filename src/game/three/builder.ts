import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/**
 * Low-poly model construction: primitives placed, rotated and coloured,
 * then merged into ONE vertex-coloured geometry per part (hull, turret,
 * rotor…) so a whole vehicle costs a couple of draw calls. Each vertex also
 * carries a `glow` weight the model shader turns into emission (lights,
 * engines, lenses).
 */

export type Vec3 = [number, number, number];

export interface PartOpts {
  /** Euler rotation (radians, XYZ). */
  rot?: Vec3;
  /** Emission strength 0–1. */
  glow?: number;
  /** Non-uniform scale applied before rotation. */
  scale?: Vec3;
}

const color = new THREE.Color();

export class ModelBuilder {
  private parts: THREE.BufferGeometry[] = [];

  /** Add any geometry (consumed: it is transformed and recoloured in place). */
  add(geo: THREE.BufferGeometry, at: Vec3, hex: number, o: PartOpts = {}): this {
    let g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(...at),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...(o.rot ?? [0, 0, 0]))),
      new THREE.Vector3(...(o.scale ?? [1, 1, 1]))
    );
    g.applyMatrix4(m);
    for (const name of Object.keys(g.attributes)) if (name !== "position" && name !== "normal") g.deleteAttribute(name);
    const n = g.attributes.position!.count;
    color.setHex(hex);
    const cols = new Float32Array(n * 3);
    const glow = new Float32Array(n).fill(o.glow ?? 0);
    for (let i = 0; i < n; i++) {
      cols[i * 3] = color.r;
      cols[i * 3 + 1] = color.g;
      cols[i * 3 + 2] = color.b;
    }
    g.setAttribute("color", new THREE.BufferAttribute(cols, 3));
    g.setAttribute("glow", new THREE.BufferAttribute(glow, 1));
    if (!g.attributes.normal) g.computeVertexNormals();
    g = g as THREE.BufferGeometry;
    this.parts.push(g);
    return this;
  }

  box(w: number, h: number, d: number, at: Vec3, hex: number, o?: PartOpts): this {
    return this.add(new THREE.BoxGeometry(w, h, d), at, hex, o);
  }

  /** A box whose top face is narrower (a sloped-armour slab). */
  slab(w: number, h: number, d: number, at: Vec3, hex: number, inset = 0.2, o?: PartOpts): this {
    const g = new THREE.BoxGeometry(w, h, d);
    const p = g.attributes.position!;
    for (let i = 0; i < p.count; i++)
      if (p.getY(i) > 0) {
        p.setX(i, p.getX(i) * (1 - inset));
        p.setZ(i, p.getZ(i) * (1 - inset * 0.6));
      }
    g.computeVertexNormals();
    return this.add(g, at, hex, o);
  }

  cyl(rTop: number, rBot: number, h: number, seg: number, at: Vec3, hex: number, o?: PartOpts): this {
    return this.add(new THREE.CylinderGeometry(rTop, rBot, h, seg), at, hex, o);
  }

  /** A cylinder lying along -Z (barrels, pods, fuselages), centred at `at`. */
  tube(r: number, len: number, seg: number, at: Vec3, hex: number, o: PartOpts = {}): this {
    const rot: Vec3 = o.rot ?? [0, 0, 0];
    return this.add(new THREE.CylinderGeometry(r, r, len, seg), at, hex, { ...o, rot: [rot[0] - Math.PI / 2, rot[1], rot[2]] });
  }

  cone(r: number, h: number, seg: number, at: Vec3, hex: number, o?: PartOpts): this {
    return this.add(new THREE.ConeGeometry(r, h, seg), at, hex, o);
  }

  sphere(r: number, at: Vec3, hex: number, o: PartOpts & { w?: number; h?: number; phi?: number } = {}): this {
    const g = new THREE.SphereGeometry(r, o.w ?? 10, o.h ?? 6, 0, Math.PI * 2, 0, o.phi ?? Math.PI);
    return this.add(g, at, hex, o);
  }

  torus(r: number, tube: number, at: Vec3, hex: number, o: PartOpts & { seg?: number } = {}): this {
    return this.add(new THREE.TorusGeometry(r, tube, 5, o.seg ?? 16), at, hex, o);
  }

  /** Extrude a 2D outline (points in the XZ plane, -Z forward) upward by `h`. */
  prism(points: [number, number][], h: number, at: Vec3, hex: number, o?: PartOpts): this {
    const shape = new THREE.Shape(points.map(([x, z]) => new THREE.Vector2(x, -z)));
    const g = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
    // shape lies in XY extruded along +Z: stand it up so the extrusion is +Y
    g.rotateX(-Math.PI / 2);
    return this.add(g, at, hex, o);
  }

  /** Mirror-paired box (x and -x). */
  pair(w: number, h: number, d: number, at: Vec3, hex: number, o?: PartOpts): this {
    this.box(w, h, d, at, hex, o);
    const r = o?.rot;
    return this.box(w, h, d, [-at[0], at[1], at[2]], hex, r ? { ...o, rot: [r[0], -r[1], -r[2]] } : o);
  }

  get empty(): boolean {
    return this.parts.length === 0;
  }

  build(): THREE.BufferGeometry {
    const g = mergeGeometries(this.parts, false)!;
    for (const p of this.parts) p.dispose();
    this.parts = [];
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}
