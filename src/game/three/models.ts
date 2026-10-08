import * as THREE from "three";
import type { BuildingKind, Faction, UnitKind } from "../../sim/types";
import { ModelBuilder, type Vec3 } from "./builder";
import { modelMat } from "./materials";

/**
 * Every vehicle, aircraft, building and map objective as a procedural
 * low-poly model in the game's painted style: weathered gunmetal, royal-blue
 * (or crimson) team panels, amber lights. Units point north (-Z) with their
 * origin on the ground at the hull centre; buildings sit centred on their
 * footprint. Turrets, heads, dishes and rotors are separate parts so they
 * can track targets and spin.
 *
 * World units are tiles (1 = one map tile).
 */

export const GM = 0x545a62;
export const GM_D = 0x34383e;
export const GM_L = 0x7d858f;
export const TRACK = 0x1e2023;
export const BARREL = 0x2a2d31;
export const AMBER = 0xffb43a;
export const WHITE = 0xd6dbe1;
export const HAZ = 0xe0b23a;
export const HAZ_D = 0x2b2a28;
const GREEN = 0x5dff8a;

interface Team {
  main: number;
  dark: number;
  light: number;
}

export const TEAMS: Record<Faction, Team> = {
  blue: { main: 0x2c66e0, dark: 0x1c3f8c, light: 0x6ea2ff },
  red: { main: 0xd83a2e, dark: 0x8a2018, light: 0xff7a62 }
};

/** A spinning part: geometry pivoting at its own origin, placed at `at`, spinning about `axis`. */
export interface Rotor {
  geo: THREE.BufferGeometry;
  at: Vec3;
  axis: "y" | "z";
  speed: number;
}

export interface ModelDef {
  hull: THREE.BufferGeometry;
  /** Rotating turret / head, pivoting at its origin, mounted at `mount` in hull space. */
  turret?: THREE.BufferGeometry;
  mount: Vec3;
  /** Muzzle point in turret space (or hull space without a turret). */
  muzzle: Vec3;
  rotors: Rotor[];
  /** Harvester's scrap load (shown when full). */
  cargo?: THREE.BufferGeometry;
  /** Model height, for labels and bars. */
  height: number;
}

// ------------------------------------------------------------ helpers ---

/** A barrel of length `len` from base point `at`, pitched up by `pitch`, along -Z. */
function barrel(b: ModelBuilder, at: Vec3, r: number, len: number, pitch: number, hex: number, seg = 6): void {
  const dy = Math.sin(pitch);
  const dz = -Math.cos(pitch);
  b.tube(r, len, seg, [at[0], at[1] + (dy * len) / 2, at[2] + (dz * len) / 2], hex, { rot: [pitch, 0, 0] });
}

/** End of a pitched barrel. */
function barrelTip(at: Vec3, len: number, pitch: number): Vec3 {
  return [at[0], at[1] + Math.sin(pitch) * len, at[2] - Math.cos(pitch) * len];
}

function wheels(b: ModelBuilder, x: number, y: number, r: number, w: number, zs: number[]): void {
  for (const z of zs) {
    b.cyl(r, r, w, 10, [x, y, z], TRACK, { rot: [0, 0, Math.PI / 2] });
    b.cyl(r, r, w, 10, [-x, y, z], TRACK, { rot: [0, 0, Math.PI / 2] });
    b.cyl(r * 0.45, r * 0.45, w + 0.01, 6, [x, y, z], GM_L, { rot: [0, 0, Math.PI / 2] });
    b.cyl(r * 0.45, r * 0.45, w + 0.01, 6, [-x, y, z], GM_L, { rot: [0, 0, Math.PI / 2] });
  }
}

/** A tracked running gear: track block, road wheels and a team fender. */
function tracks(b: ModelBuilder, x: number, w: number, h: number, len: number, z = 0, fender?: number): void {
  for (const s of [1, -1]) {
    b.box(w, h, len, [s * x, h / 2 + 0.01, z], TRACK);
    b.box(w * 0.9, 0.02, len * 0.94, [s * x, h + 0.01, z], 0x2c2f33);
    const n = Math.max(3, Math.round(len / 0.16));
    for (let i = 0; i < n; i++) {
      const wz = z - len / 2 + (len * (i + 0.5)) / n;
      b.cyl(h * 0.32, h * 0.32, w + 0.012, 8, [s * x, h * 0.42, wz], GM_D, { rot: [0, 0, Math.PI / 2] });
    }
    if (fender !== undefined) b.box(w + 0.02, 0.025, len * 0.82, [s * x, h + 0.025, z + len * 0.04], fender);
  }
}

function light(b: ModelBuilder, at: Vec3, s = 0.03, hex = AMBER): void {
  b.box(s, s * 0.8, s, at, hex, { glow: 1 });
}

/** A rotor: two crossed blades and a hub. */
function rotorGeo(r: number, axis: "y" | "z" = "y"): THREE.BufferGeometry {
  const b = new ModelBuilder();
  const rot: Vec3 = axis === "z" ? [Math.PI / 2, 0, 0] : [0, 0, 0];
  b.box(r * 2, 0.008, r * 0.18, [0, 0, 0], 0x1a1c1f, { rot });
  b.box(r * 0.18, 0.008, r * 2, [0, 0, 0], 0x1a1c1f, { rot });
  b.cyl(r * 0.22, r * 0.22, 0.03, 6, [0, 0, 0], GM_L, { rot });
  return b.build();
}

// -------------------------------------------------------------- units ---

type UnitBuilder = (t: Team) => ModelDef;

const UNIT_MODELS: Record<UnitKind, UnitBuilder> = {
  stinger: (t) => {
    const b = new ModelBuilder();
    tracks(b, 0.235, 0.17, 0.15, 0.8, 0, t.main);
    b.slab(0.34, 0.14, 0.72, [0, 0.2, 0.02], GM, 0.16);
    b.box(0.32, 0.05, 0.14, [0, 0.19, -0.37], GM_D, { rot: [0.55, 0, 0] });
    b.box(0.26, 0.045, 0.16, [0, 0.29, 0.27], GM_D);
    b.pair(0.03, 0.03, 0.06, [0.08, 0.32, 0.33], BARREL);
    light(b, [0.12, 0.22, -0.41]);
    light(b, [-0.12, 0.22, -0.41]);
    const hull = b.build();
    const tu = new ModelBuilder();
    tu.cyl(0.14, 0.17, 0.11, 7, [0, 0.055, 0], GM);
    tu.cyl(0.11, 0.14, 0.035, 7, [0, 0.127, 0], GM_L);
    tu.pair(0.05, 0.04, 0.16, [0.12, 0.07, 0.03], t.main);
    barrel(tu, [0, 0.065, -0.1], 0.026, 0.36, 0.02, BARREL);
    tu.tube(0.036, 0.06, 6, [0, 0.07, -0.45], GM_D);
    tu.cyl(0.045, 0.045, 0.025, 6, [0.04, 0.155, 0.04], GM_D);
    light(tu, [-0.085, 0.13, -0.07], 0.025);
    return { hull, turret: tu.build(), mount: [0, 0.27, 0.04], muzzle: [0, 0.07, -0.48], rotors: [], height: 0.45 };
  },

  "flak-crawler": (t) => {
    const b = new ModelBuilder();
    tracks(b, 0.25, 0.18, 0.16, 0.84, 0, t.main);
    b.slab(0.4, 0.16, 0.78, [0, 0.21, 0], GM, 0.12);
    b.box(0.36, 0.06, 0.1, [0, 0.21, -0.41], GM_D, { rot: [0.45, 0, 0] });
    b.cyl(0.012, 0.012, 0.14, 4, [0.13, 0.36, 0.32], GM_D);
    b.cyl(0.075, 0.02, 0.025, 8, [0.13, 0.44, 0.32], GM_L, { rot: [0.6, 0, 0] });
    light(b, [0.13, 0.23, -0.44]);
    light(b, [-0.13, 0.23, -0.44]);
    const hull = b.build();
    const tu = new ModelBuilder();
    tu.slab(0.3, 0.13, 0.3, [0, 0.065, 0.03], GM, 0.15);
    tu.box(0.2, 0.02, 0.18, [0, 0.14, 0.05], t.main);
    const pitch = 0.42;
    for (const x of [-0.11, -0.05, 0.05, 0.11]) barrel(tu, [x, 0.08, -0.08], 0.017, 0.34, pitch, BARREL, 5);
    tu.box(0.3, 0.07, 0.05, [0, 0.085, -0.12], GM_D, { rot: [pitch, 0, 0] });
    light(tu, [0, 0.12, -0.13], 0.025);
    return { hull, turret: tu.build(), mount: [0, 0.29, 0.02], muzzle: barrelTip([0, 0.08, -0.08], 0.36, pitch), rotors: [], height: 0.6 };
  },

  mortar: (t) => {
    const b = new ModelBuilder();
    b.box(0.34, 0.1, 0.84, [0, 0.15, 0], GM_D);
    wheels(b, 0.21, 0.1, 0.1, 0.08, [-0.28, 0, 0.28]);
    b.slab(0.34, 0.13, 0.58, [0, 0.26, 0.1], GM, 0.15);
    b.box(0.3, 0.13, 0.2, [0, 0.27, -0.3], GM);
    b.box(0.24, 0.05, 0.02, [0, 0.3, -0.405], AMBER, { glow: 0.5 });
    b.pair(0.015, 0.06, 0.4, [0.172, 0.26, 0.1], t.main);
    b.box(0.26, 0.025, 0.16, [0, 0.34, -0.3], t.main);
    b.pair(0.06, 0.03, 0.14, [0.22, 0.08, 0.36], GM_L);
    const hull = b.build();
    const tu = new ModelBuilder();
    tu.cyl(0.13, 0.15, 0.06, 8, [0, 0.03, 0], GM);
    tu.pair(0.03, 0.12, 0.1, [0.08, 0.1, 0], GM_D);
    const pitch = 0.85;
    barrel(tu, [0, 0.1, 0.02], 0.055, 0.34, pitch, BARREL, 8);
    barrel(tu, [0, 0.1, 0.02], 0.062, 0.1, pitch, t.main, 8);
    const tip = barrelTip([0, 0.1, 0.02], 0.34, pitch);
    tu.tube(0.068, 0.04, 8, [tip[0], tip[1] - 0.015, tip[2] + 0.012], GM_D, { rot: [pitch, 0, 0] });
    return { hull, turret: tu.build(), mount: [0, 0.33, 0.14], muzzle: tip, rotors: [], height: 0.6 };
  },

  titan: (t) => {
    const b = new ModelBuilder();
    tracks(b, 0.37, 0.21, 0.21, 0.5, -0.27, t.main);
    tracks(b, 0.37, 0.21, 0.21, 0.5, 0.27, t.main);
    b.slab(0.6, 0.22, 1.02, [0, 0.27, 0], GM, 0.12);
    b.box(0.56, 0.09, 0.2, [0, 0.25, -0.53], GM_D, { rot: [0.5, 0, 0] });
    b.pair(0.03, 0.12, 0.92, [0.475, 0.22, 0], t.dark);
    b.pair(0.14, 0.03, 0.36, [0.2, 0.39, 0.12], t.main);
    b.box(0.4, 0.05, 0.2, [0, 0.4, 0.38], GM_D);
    for (const x of [-0.12, 0, 0.12]) b.box(0.07, 0.02, 0.16, [x, 0.43, 0.38], BARREL);
    light(b, [0.2, 0.26, -0.57]);
    light(b, [-0.2, 0.26, -0.57]);
    const hull = b.build();
    const tu = new ModelBuilder();
    tu.slab(0.44, 0.17, 0.46, [0, 0.085, 0.05], GM, 0.18);
    tu.box(0.3, 0.13, 0.09, [0, 0.09, -0.2], GM_D);
    for (const x of [-0.075, 0.075]) {
      barrel(tu, [x, 0.095, -0.22], 0.035, 0.56, 0.01, BARREL);
      tu.tube(0.05, 0.08, 6, [x, 0.1, -0.78], GM_D);
    }
    tu.box(0.08, 0.02, 0.3, [0, 0.18, 0.08], t.main);
    tu.pair(0.04, 0.09, 0.26, [0.225, 0.08, 0.06], t.main);
    tu.cyl(0.06, 0.07, 0.05, 6, [0.11, 0.195, 0.14], GM_L);
    light(tu, [-0.12, 0.18, -0.12], 0.03);
    return { hull, turret: tu.build(), mount: [0, 0.39, 0.06], muzzle: [0, 0.1, -0.82], rotors: [], height: 0.75 };
  },

  lancer: (t) => {
    const b = new ModelBuilder();
    b.prism([[0, -0.52], [0.38, 0.28], [0.22, 0.4], [-0.22, 0.4], [-0.38, 0.28]], 0.1, [0, 0.1, 0], GM);
    b.prism([[0, -0.38], [0.25, 0.22], [-0.25, 0.22]], 0.06, [0, 0.2, 0], GM_L);
    b.box(0.045, 0.02, 0.52, [0.19, 0.205, -0.02], t.main, { rot: [0, -0.44, 0] });
    b.box(0.045, 0.02, 0.52, [-0.19, 0.205, -0.02], t.main, { rot: [0, 0.44, 0] });
    b.box(0.4, 0.02, 0.06, [0, 0.205, 0.33], t.main);
    for (const [x, z] of [[0.3, 0.3], [-0.3, 0.3], [0, -0.38]] as [number, number][]) {
      b.cyl(0.09, 0.1, 0.08, 10, [x, 0.1, z], GM_D);
      b.cyl(0.07, 0.07, 0.02, 10, [x, 0.055, z], AMBER, { glow: 1 });
    }
    const hull = b.build();
    const tu = new ModelBuilder();
    tu.cyl(0.1, 0.13, 0.08, 6, [0, 0.04, 0], GM);
    tu.tube(0.022, 0.42, 6, [0, 0.05, -0.26], GM_L);
    tu.tube(0.036, 0.04, 8, [0, 0.05, -0.12], t.main);
    tu.tube(0.034, 0.035, 8, [0, 0.05, -0.36], GM_D);
    tu.sphere(0.034, [0, 0.05, -0.48], AMBER, { glow: 1, w: 6, h: 4 });
    tu.box(0.06, 0.03, 0.08, [0, 0.09, 0.03], t.main);
    return { hull, turret: tu.build(), mount: [0, 0.26, 0.06], muzzle: [0, 0.05, -0.5], rotors: [], height: 0.45 };
  },

  harvester: (t) => {
    const b = new ModelBuilder();
    b.box(0.4, 0.1, 0.86, [0, 0.16, 0], GM_D);
    wheels(b, 0.24, 0.11, 0.11, 0.1, [-0.3, 0, 0.3]);
    b.box(0.4, 0.2, 0.24, [0, 0.31, -0.29], GM);
    b.box(0.36, 0.03, 0.2, [0, 0.425, -0.29], t.main);
    b.box(0.32, 0.07, 0.02, [0, 0.34, -0.415], AMBER, { glow: 0.55 });
    b.cyl(0.022, 0.022, 0.04, 6, [0.12, 0.46, -0.24], AMBER, { glow: 1 });
    b.box(0.46, 0.08, 0.12, [0, 0.13, -0.5], GM_L, { rot: [-0.35, 0, 0] });
    for (const x of [-0.16, -0.08, 0, 0.08, 0.16]) b.cone(0.022, 0.06, 4, [x, 0.08, -0.57], GM_D, { rot: [-Math.PI / 2 - 0.3, 0, 0] });
    // the cargo bin
    b.box(0.4, 0.03, 0.56, [0, 0.22, 0.14], GM_D);
    b.box(0.42, 0.18, 0.03, [0, 0.3, -0.14], GM);
    b.box(0.42, 0.18, 0.03, [0, 0.3, 0.42], GM);
    b.pair(0.03, 0.18, 0.56, [0.2, 0.3, 0.14], GM);
    b.pair(0.012, 0.05, 0.5, [0.218, 0.32, 0.14], t.main);
    const hull = b.build();
    const c = new ModelBuilder();
    const lumps: [number, number, number, number][] = [
      [-0.1, 0.0, 0.05, 0x8a6a3a], [0.08, 0.1, 0.06, 0xb08a4a], [-0.05, 0.25, 0.05, 0x6e5a40],
      [0.1, 0.3, 0.045, 0x9a7a44], [0, 0.15, 0.06, 0xc9a65a], [-0.12, 0.33, 0.04, 0x7a6448]
    ];
    lumps.forEach(([x, z, s, col], i) =>
      c.box(s * 2.2, s * 1.6, s * 2, [x, 0.36, z], col, { rot: [i * 0.7, i * 1.3, i * 0.4] })
    );
    c.cone(0.03, 0.09, 5, [0.05, 0.4, 0.22], GREEN, { glow: 0.6 });
    return { hull, mount: [0, 0, 0], muzzle: [0, 0.3, -0.5], rotors: [], cargo: c.build(), height: 0.5 };
  },

  scout: (t) => {
    const b = new ModelBuilder();
    b.sphere(0.1, [0, 0, 0], GM, { w: 8, h: 6, scale: [1, 0.6, 1.3] });
    b.sphere(0.038, [0, -0.01, -0.125], AMBER, { glow: 1, w: 6, h: 4 });
    b.box(0.03, 0.02, 0.4, [0, 0, 0], GM_D, { rot: [0, Math.PI / 4, 0] });
    b.box(0.03, 0.02, 0.4, [0, 0, 0], GM_D, { rot: [0, -Math.PI / 4, 0] });
    const at: Vec3[] = [];
    for (const [x, z] of [[0.14, -0.14], [-0.14, -0.14], [0.14, 0.14], [-0.14, 0.14]] as [number, number][]) {
      b.cyl(0.03, 0.03, 0.05, 8, [x, 0.005, z], GM);
      b.torus(0.085, 0.01, [x, 0.02, z], z < 0 ? t.main : GM_L, { rot: [Math.PI / 2, 0, 0], seg: 14 });
      at.push([x, 0.04, z]);
    }
    b.box(0.06, 0.025, 0.05, [0, 0.055, 0.02], t.main);
    const rg = rotorGeo(0.075);
    return { hull: b.build(), mount: [0, 0, 0], muzzle: [0, 0, -0.15], rotors: at.map((p) => ({ geo: rg, at: p, axis: "y", speed: 40 })), height: 0.15 };
  },

  wasp: (t) => {
    const b = new ModelBuilder();
    b.tube(0.06, 0.46, 6, [0, 0, 0.02], GM, { scale: [1, 1, 0.8] });
    b.cone(0.06, 0.14, 6, [0, 0, -0.27], GM_L, { rot: [-Math.PI / 2, 0, 0] });
    b.sphere(0.035, [0, 0.04, -0.14], AMBER, { glow: 0.6, w: 6, h: 4, scale: [1, 0.6, 1.6] });
    for (const s of [1, -1]) {
      b.prism([[s * 0.04, 0.06], [s * 0.36, -0.08], [s * 0.38, 0.01], [s * 0.06, 0.16]], 0.025, [0, -0.012, 0], GM_D);
      b.prism([[s * 0.28, -0.045], [s * 0.36, -0.08], [s * 0.38, 0.01], [s * 0.3, 0.04]], 0.03, [0, -0.01, 0], t.main);
      b.tube(0.035, 0.2, 6, [s * 0.19, -0.04, -0.02], GM_D);
      b.cone(0.035, 0.05, 6, [s * 0.19, -0.04, -0.145], 0xc84a3a, { rot: [-Math.PI / 2, 0, 0] });
    }
    b.torus(0.085, 0.016, [0, 0.03, 0.27], GM_L, { seg: 12 });
    b.cyl(0.06, 0.06, 0.01, 8, [0, 0.03, 0.28], AMBER, { glow: 1, rot: [Math.PI / 2, 0, 0] });
    b.box(0.015, 0.1, 0.1, [0, 0.08, 0.2], t.main);
    return {
      hull: b.build(), mount: [0, 0, 0], muzzle: [0, -0.04, -0.22],
      rotors: [{ geo: rotorGeo(0.075, "z"), at: [0, 0.03, 0.265], axis: "z", speed: 50 }], height: 0.15
    };
  },

  raptor: (t) => {
    const b = new ModelBuilder();
    b.prism([[0, -0.5], [0.42, 0.3], [0.13, 0.26], [0, 0.34], [-0.13, 0.26], [-0.42, 0.3]], 0.04, [0, -0.02, 0], GM);
    b.slab(0.13, 0.09, 0.72, [0, 0.03, -0.02], GM_L, 0.3);
    b.sphere(0.05, [0, 0.08, -0.2], AMBER, { glow: 0.5, w: 8, h: 5, scale: [1, 0.6, 2.2] });
    b.pair(0.015, 0.15, 0.15, [0.1, 0.1, 0.24], GM_D, { rot: [0, 0, 0.28] });
    b.pair(0.17, 0.045, 0.05, [0.22, 0.0, 0.08], t.main, { rot: [0, 0.62, 0] });
    b.box(0.05, 0.05, 0.3, [0, 0.03, -0.32], t.main);
    b.pair(0.012, 0.012, 0.18, [0.29, -0.04, 0.1], WHITE);
    for (const s of [1, -1]) {
      b.tube(0.042, 0.12, 8, [s * 0.06, 0.0, 0.33], GM_D);
      b.sphere(0.035, [s * 0.06, 0, 0.395], AMBER, { glow: 1, w: 6, h: 4 });
    }
    return { hull: b.build(), mount: [0, 0, 0], muzzle: [0, -0.03, -0.45], rotors: [], height: 0.15 };
  },

  hornet: (t) => {
    const b = new ModelBuilder();
    b.slab(0.26, 0.14, 0.82, [0, -0.02, 0], GM, 0.2);
    b.sphere(0.07, [0, 0.03, -0.36], AMBER, { glow: 0.5, w: 8, h: 5, scale: [1, 0.6, 1.4] });
    b.box(0.2, 0.025, 0.4, [0, 0.06, 0.06], t.main);
    b.box(0.16, 0.04, 0.32, [0, -0.1, 0.05], GM_D);
    for (const z of [-0.04, 0.06, 0.16]) b.tube(0.03, 0.09, 6, [0, -0.13, z], BARREL, { rot: [0, Math.PI / 2, 0] });
    const at: Vec3[] = [];
    for (const [x, z] of [[0.38, -0.28], [-0.38, -0.28], [0.38, 0.3], [-0.38, 0.3]] as [number, number][]) {
      const len = Math.hypot(x, z);
      b.box(0.05, 0.035, len, [x / 2, 0, z / 2], GM_D, { rot: [0, Math.atan2(x, z), 0] });
      b.torus(0.15, 0.026, [x, 0.01, z], z < 0 ? t.main : GM_L, { rot: [Math.PI / 2, 0, 0], seg: 16 });
      b.cyl(0.04, 0.05, 0.06, 8, [x, 0.0, z], GM);
      at.push([x, 0.035, z]);
    }
    light(b, [0.08, 0.04, 0.4]);
    light(b, [-0.08, 0.04, 0.4]);
    const rg = rotorGeo(0.13);
    return { hull: b.build(), mount: [0, 0, 0], muzzle: [0, -0.14, 0.05], rotors: at.map((p) => ({ geo: rg, at: p, axis: "y", speed: 30 })), height: 0.2 };
  },

  mender: (t) => {
    const b = new ModelBuilder();
    b.cyl(0.17, 0.19, 0.08, 12, [0, 0, 0], GM_L);
    b.sphere(0.11, [0, 0.03, 0], GM, { w: 10, h: 5, phi: Math.PI / 2 });
    b.box(0.13, 0.02, 0.04, [0, 0.145, 0], GREEN, { glow: 1 });
    b.box(0.04, 0.02, 0.13, [0, 0.145, 0], GREEN, { glow: 1 });
    b.torus(0.25, 0.018, [0, 0, 0], t.main, { rot: [Math.PI / 2, 0, 0], seg: 20 });
    b.cyl(0.05, 0.03, 0.04, 8, [0, -0.06, 0], GREEN, { glow: 0.8 });
    const at: Vec3[] = [];
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + Math.PI / 6;
      const x = Math.cos(a) * 0.25;
      const z = Math.sin(a) * 0.25;
      b.cyl(0.03, 0.03, 0.04, 6, [x, 0.01, z], GM_D);
      at.push([x, 0.04, z]);
    }
    const rg = rotorGeo(0.07);
    return { hull: b.build(), mount: [0, 0, 0], muzzle: [0, -0.06, 0], rotors: at.map((p) => ({ geo: rg, at: p, axis: "y", speed: 36 })), height: 0.15 };
  }
};

// ---------------------------------------------------------- buildings ---

const BUILDING_MODELS: Record<BuildingKind, (t: Team) => ModelDef> = {
  hq: (t) => {
    const b = new ModelBuilder();
    b.slab(2.9, 0.16, 2.9, [0, 0.06, 0], GM_D, 0.03);
    b.slab(2.3, 0.44, 2.3, [0, 0.36, 0], GM, 0.08);
    for (const x of [-1.05, 1.05])
      for (const z of [-1.05, 1.05]) {
        b.cyl(0.26, 0.31, 0.74, 8, [x, 0.37, z], GM);
        b.cyl(0.27, 0.27, 0.08, 8, [x, 0.76, z], t.main);
        b.cyl(0.2, 0.25, 0.06, 8, [x, 0.83, z], GM_L);
        light(b, [x, 0.89, z], 0.05);
      }
    b.sphere(0.74, [0, 0.56, 0], GM_L, { w: 16, h: 7, phi: Math.PI / 2 });
    b.torus(0.75, 0.045, [0, 0.6, 0], t.main, { rot: [Math.PI / 2, 0, 0], seg: 24 });
    b.torus(0.5, 0.03, [0, 1.06, 0], GM_D, { rot: [Math.PI / 2, 0, 0], seg: 20 });
    b.cyl(0.025, 0.045, 0.7, 6, [0, 1.6, 0], GM_D);
    b.sphere(0.055, [0, 1.95, 0], AMBER, { glow: 1, w: 6, h: 4 });
    b.cyl(0.18, 0.04, 0.05, 10, [0.62, 1.0, -0.55], GM_L, { rot: [0.7, 0.6, 0] });
    for (const [x, z, ry] of [[0, 1.16, 0], [0, -1.16, 0], [1.16, 0, Math.PI / 2], [-1.16, 0, Math.PI / 2]] as Vec3[])
      b.box(1.0, 0.17, 0.025, [x, 0.4, z], t.main, { rot: [0, ry, 0] });
    for (const [x, z, ry] of [[0, -1.17, 0], [1.17, 0, Math.PI / 2], [-1.17, 0, Math.PI / 2]] as Vec3[])
      b.box(0.8, 0.035, 0.02, [x, 0.25, z], AMBER, { rot: [0, ry, 0], glow: 0.7 });
    b.box(0.74, 0.28, 0.06, [0, 0.28, 1.17], GM_D);
    b.box(0.62, 0.035, 0.02, [0, 0.44, 1.2], AMBER, { glow: 1 });
    b.box(0.82, 0.04, 0.38, [0, 0.12, 1.36], GM_L, { rot: [0.22, 0, 0] });
    b.box(0.3, 0.12, 0.2, [-0.75, 0.64, 0.55], GM_D);
    b.box(0.24, 0.1, 0.3, [0.7, 0.63, 0.7], GM_D);
    return { hull: b.build(), mount: [0, 0, 0], muzzle: [0, 1.1, 0], rotors: [], height: 2.0 };
  },

  "fab-plant": (t) => {
    const b = new ModelBuilder();
    b.slab(1.92, 0.12, 1.92, [0, 0.05, 0], GM_D, 0.03);
    b.box(1.7, 0.62, 1.3, [0, 0.41, -0.16], GM);
    for (let i = 0; i < 3; i++) {
      const z = -0.66 + i * 0.44;
      b.box(1.66, 0.04, 0.46, [0, 0.82, z], GM_L, { rot: [-0.38, 0, 0] });
      b.box(1.5, 0.16, 0.02, [0, 0.82, z + 0.2], AMBER, { glow: 0.35 });
    }
    b.box(1.04, 0.46, 0.05, [0, 0.34, 0.51], GM_D);
    for (let i = 0; i < 3; i++) b.box(1.0, 0.05, 0.02, [0, 0.2 + i * 0.13, 0.54], t.main);
    b.box(1.22, 0.03, 0.42, [0, 0.12, 0.73], GM_L);
    light(b, [0.57, 0.6, 0.54], 0.05);
    light(b, [-0.57, 0.6, 0.54], 0.05);
    b.pair(0.025, 0.22, 0.92, [0.86, 0.46, -0.16], t.main);
    b.cyl(0.1, 0.13, 0.86, 8, [0.62, 1.0, -0.62], GM_D);
    b.cyl(0.11, 0.11, 0.06, 8, [0.62, 1.4, -0.62], t.main);
    b.box(0.08, 0.5, 0.08, [-0.72, 1.0, 0.36], GM_D);
    b.box(0.08, 0.08, 0.9, [-0.72, 1.24, 0.0], GM_D);
    return { hull: b.build(), mount: [0, 0, 0], muzzle: [0, 0.5, 0], rotors: [], height: 1.4 };
  },

  airpad: (t) => {
    const b = new ModelBuilder();
    b.slab(1.95, 0.14, 1.95, [0, 0.07, 0], GM_D, 0.02);
    b.cyl(0.8, 0.8, 0.03, 28, [0, 0.155, 0], GM);
    b.torus(0.64, 0.035, [0, 0.172, 0], t.main, { rot: [Math.PI / 2, 0, 0], seg: 28 });
    for (const x of [-0.16, 0.16]) b.box(0.08, 0.012, 0.5, [x, 0.175, 0], 0xc9ced4);
    b.box(0.32, 0.012, 0.08, [0, 0.175, 0], 0xc9ced4);
    for (const x of [-0.86, 0.86]) for (const z of [-0.86, 0.86]) light(b, [x, 0.17, z], 0.06);
    b.box(0.36, 0.72, 0.36, [0.76, 0.5, -0.76], GM);
    b.box(0.46, 0.2, 0.46, [0.76, 0.92, -0.76], GM_L);
    b.box(0.48, 0.07, 0.48, [0.76, 0.94, -0.76], AMBER, { glow: 0.45 });
    b.box(0.5, 0.03, 0.5, [0.76, 1.03, -0.76], t.main);
    b.cyl(0.012, 0.012, 0.3, 4, [0.86, 1.2, -0.86], GM_D);
    for (const z of [-0.5, -0.82]) b.cyl(0.13, 0.13, 0.32, 10, [-0.8, 0.3, z], GM_L, { rot: [Math.PI / 2, 0, 0] });
    return { hull: b.build(), mount: [0, 0, 0], muzzle: [0, 0.4, 0], rotors: [], height: 1.1 };
  },

  "tech-lab": (t) => {
    const b = new ModelBuilder();
    b.slab(1.92, 0.12, 1.92, [0, 0.06, 0], GM_D, 0.03);
    b.cyl(0.84, 0.92, 0.5, 8, [0, 0.37, 0], GM, { rot: [0, Math.PI / 8, 0] });
    b.cyl(0.86, 0.86, 0.08, 8, [0, 0.5, 0], t.main, { rot: [0, Math.PI / 8, 0] });
    b.cyl(0.7, 0.84, 0.08, 8, [0, 0.66, 0], GM_L, { rot: [0, Math.PI / 8, 0] });
    b.sphere(0.48, [0, 0.66, 0], 0xff8a24, { glow: 1, w: 14, h: 6, phi: Math.PI / 2 });
    b.torus(0.5, 0.03, [0, 0.72, 0], GM_D, { rot: [Math.PI / 2, 0, 0], seg: 20 });
    b.torus(0.38, 0.025, [0, 0.95, 0], GM_D, { rot: [Math.PI / 2, 0, 0], seg: 18 });
    b.torus(0.48, 0.025, [0, 0.66, 0], GM_D, { seg: 20 });
    b.torus(0.48, 0.025, [0, 0.66, 0], GM_D, { rot: [0, Math.PI / 2, 0], seg: 20 });
    for (const [x, z] of [[0.68, 0.68], [-0.68, 0.68], [0.68, -0.68], [-0.68, -0.68]] as [number, number][]) {
      b.cyl(0.035, 0.06, 0.95, 6, [x, 0.55, z], GM_L);
      b.sphere(0.045, [x, 1.05, z], AMBER, { glow: 1, w: 6, h: 4 });
    }
    b.box(0.42, 0.3, 0.32, [0, 0.27, 0.86], GM_D);
    b.box(0.32, 0.06, 0.02, [0, 0.33, 1.02], AMBER, { glow: 0.8 });
    return { hull: b.build(), mount: [0, 0, 0], muzzle: [0, 0.6, 0], rotors: [], height: 1.2 };
  },

  depot: (t) => {
    const b = new ModelBuilder();
    b.slab(1.92, 0.12, 1.92, [0, 0.06, 0], GM_D, 0.03);
    for (const x of [-0.46, 0.46]) {
      b.cyl(0.32, 0.32, 0.9, 14, [x, 0.57, -0.42], GM);
      b.cone(0.33, 0.24, 14, [x, 1.14, -0.42], GM_L);
      b.cyl(0.335, 0.335, 0.08, 14, [x, 0.76, -0.42], t.main);
      b.cyl(0.335, 0.335, 0.05, 14, [x, 0.3, -0.42], GM_D);
    }
    b.box(1.32, 0.32, 0.62, [0, 0.28, 0.46], GM);
    b.box(1.12, 0.02, 0.42, [0, 0.445, 0.46], 0x121315);
    b.box(1.22, 0.05, 0.02, [0, 0.3, 0.775], t.main);
    b.box(0.18, 0.06, 0.74, [0, 0.66, 0.02], GM_D, { rot: [-0.5, 0, 0] });
    light(b, [0.62, 0.47, 0.76], 0.05);
    light(b, [-0.62, 0.47, 0.76], 0.05);
    return { hull: b.build(), mount: [0, 0, 0], muzzle: [0, 0.5, 0], rotors: [], height: 1.25 };
  },

  turret: (t) => {
    const b = new ModelBuilder();
    b.cyl(0.4, 0.46, 0.22, 8, [0, 0.11, 0], GM_D, { rot: [0, Math.PI / 8, 0] });
    b.cyl(0.41, 0.41, 0.05, 8, [0, 0.19, 0], t.main, { rot: [0, Math.PI / 8, 0] });
    b.cyl(0.3, 0.38, 0.04, 8, [0, 0.235, 0], GM, { rot: [0, Math.PI / 8, 0] });
    const hull = b.build();
    const h = new ModelBuilder();
    h.slab(0.36, 0.17, 0.36, [0, 0.085, 0.03], GM, 0.2);
    for (const x of [-0.065, 0.065]) {
      h.tube(0.026, 0.4, 6, [x, 0.095, -0.3], BARREL);
      h.tube(0.037, 0.06, 6, [x, 0.095, -0.5], GM_D);
    }
    h.pair(0.03, 0.09, 0.22, [0.19, 0.085, 0.04], t.main);
    light(h, [0, 0.17, -0.1], 0.035);
    return { hull, turret: h.build(), mount: [0, 0.255, 0], muzzle: [0, 0.095, -0.54], rotors: [], height: 0.6 };
  },

  "sam-site": (t) => {
    const b = new ModelBuilder();
    b.slab(0.86, 0.18, 0.86, [0, 0.09, 0], GM_D, 0.06);
    for (const x of [-0.34, 0.34]) for (const z of [-0.34, 0.34]) b.box(0.13, 0.03, 0.13, [x, 0.19, z], t.main);
    b.pair(0.03, 0.06, 0.4, [0.43, 0.1, 0], t.main);
    const hull = b.build();
    const h = new ModelBuilder();
    h.cyl(0.22, 0.25, 0.08, 8, [0, 0.04, 0], GM);
    h.pair(0.04, 0.22, 0.12, [0.21, 0.17, 0.02], GM_D);
    const pitch = 0.34;
    h.box(0.36, 0.2, 0.42, [0, 0.26, -0.02], GM, { rot: [pitch, 0, 0] });
    h.pair(0.02, 0.09, 0.34, [0.185, 0.27, -0.02], t.main, { rot: [pitch, 0, 0] });
    h.box(0.3, 0.02, 0.12, [0, 0.38, 0.1], GM_D, { rot: [pitch, 0, 0] });
    for (const x of [-0.11, 0, 0.11])
      for (const y of [0.21, 0.3]) {
        const base: Vec3 = [x, y, 0.12];
        barrel(h, base, 0.032, 0.42, pitch, WHITE);
        const tip = barrelTip(base, 0.42, pitch);
        h.cone(0.032, 0.07, 6, [tip[0], tip[1] + Math.sin(pitch) * 0.035, tip[2] - Math.cos(pitch) * 0.035], 0xc8402e, {
          rot: [pitch - Math.PI / 2, 0, 0]
        });
      }
    return { hull, turret: h.build(), mount: [0, 0.18, 0], muzzle: barrelTip([0, 0.26, 0.12], 0.5, pitch), rotors: [], height: 0.65 };
  },

  radar: (t) => {
    const b = new ModelBuilder();
    b.slab(0.82, 0.2, 0.82, [0, 0.1, 0], GM_D, 0.08);
    b.pair(0.05, 0.05, 0.6, [0.4, 0.17, 0], t.main);
    b.box(0.6, 0.05, 0.05, [0, 0.17, 0.4], t.main);
    const hull = b.build();
    const h = new ModelBuilder();
    h.cyl(0.05, 0.08, 0.42, 6, [0, 0.21, 0], GM);
    h.sphere(0.42, [0, 0.655, -0.29], GM_L, { w: 14, h: 4, phi: 0.95, rot: [Math.PI / 2 + 0.38, 0, 0] });
    h.torus(0.34, 0.02, [0, 0.565, -0.064], t.main, { rot: [0.38, 0, 0], seg: 18 });
    h.tube(0.012, 0.3, 4, [0, 0.62, -0.2], GM_D, { rot: [0.38, 0, 0] });
    h.sphere(0.03, [0, 0.676, -0.343], AMBER, { glow: 1, w: 6, h: 4 });
    return { hull, turret: h.build(), mount: [0, 0.2, 0], muzzle: [0, 0.5, 0], rotors: [], height: 0.95 };
  }
};

// --------------------------------------------------------- objectives ---

function uplinkModel(): ModelDef {
  const b = new ModelBuilder();
  b.cyl(1.0, 1.06, 0.14, 28, [0, 0.07, 0], GM_D);
  b.cyl(0.9, 0.9, 0.03, 28, [0, 0.155, 0], GM);
  const n = 18;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    b.box(0.32, 0.05, 0.11, [Math.cos(a) * 0.95, 0.15, Math.sin(a) * 0.95], i % 2 ? HAZ : HAZ_D, { rot: [0, -a - Math.PI / 2, 0] });
  }
  b.cyl(0.3, 0.4, 0.32, 8, [0, 0.32, 0], GM);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    light(b, [Math.cos(a) * 0.7, 0.18, Math.sin(a) * 0.7], 0.06);
  }
  const hull = b.build();
  const h = new ModelBuilder();
  h.cyl(0.08, 0.12, 0.3, 6, [0, 0.15, 0], GM_D);
  h.sphere(0.6, [0, 0.64, -0.395], GM_L, { w: 16, h: 4, phi: 0.85, rot: [Math.PI / 2 + 0.6, 0, 0] });
  h.torus(0.45, 0.025, [0, 0.416, -0.068], HAZ, { rot: [0.6, 0, 0], seg: 20 });
  h.tube(0.014, 0.42, 4, [0, 0.535, -0.24], GM_D, { rot: [0.6, 0, 0] });
  h.sphere(0.04, [0, 0.65, -0.41], AMBER, { glow: 1, w: 6, h: 4 });
  return { hull, turret: h.build(), mount: [0, 0.46, 0], muzzle: [0, 0.8, 0], rotors: [], height: 1.4 };
}

function crateModel(): ModelDef {
  const b = new ModelBuilder();
  b.box(0.5, 0.36, 0.5, [0, 0.19, 0], GM);
  for (const y of [0.08, 0.3]) b.box(0.52, 0.06, 0.52, [0, y, 0], HAZ);
  for (const x of [-0.24, 0.24]) for (const z of [-0.24, 0.24]) b.box(0.05, 0.38, 0.05, [x, 0.19, z], HAZ_D);
  b.box(0.52, 0.04, 0.52, [0, 0.39, 0], HAZ_D);
  b.cyl(0.04, 0.05, 0.05, 6, [0, 0.43, 0], AMBER, { glow: 1 });
  return { hull: b.build(), mount: [0, 0, 0], muzzle: [0, 0.4, 0], rotors: [], height: 0.5 };
}

/** Parachute canopy over its attachment point (the origin): eight gores, gold and cream. */
function chuteGeo(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  const r = 0.75;
  const theta = 1.05;
  const top = 1.25;
  for (let i = 0; i < 8; i++) {
    const g = new THREE.SphereGeometry(r, 3, 5, (i / 8) * Math.PI * 2, Math.PI / 4, 0, theta);
    b.add(g, [0, top - r * Math.cos(theta), 0], i % 2 ? 0xf2b632 : 0xece4cf, { scale: [1, 0.75, 1] });
  }
  const rimY = top - r * Math.cos(theta);
  const rimR = r * Math.sin(theta);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const x = Math.cos(a) * rimR;
    const z = Math.sin(a) * rimR;
    const len = Math.hypot(x, rimY, z);
    const mid: Vec3 = [x / 2, rimY / 2, z / 2];
    const g = new THREE.CylinderGeometry(0.006, 0.006, len, 3);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(x, rimY, z).normalize());
    const e = new THREE.Euler().setFromQuaternion(q);
    b.add(g, mid, 0xe8e2cc, { rot: [e.x, e.y, e.z] });
  }
  return b.build();
}

function podModel(t: Team): ModelDef {
  const b = new ModelBuilder();
  b.cone(0.2, 0.22, 10, [0, 0.11, 0], GM_D, { rot: [Math.PI, 0, 0] });
  b.cyl(0.21, 0.2, 0.5, 10, [0, 0.47, 0], WHITE);
  b.cyl(0.215, 0.215, 0.07, 10, [0, 0.55, 0], t.main);
  b.cyl(0.18, 0.21, 0.08, 10, [0, 0.76, 0], GM_D);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    b.box(0.02, 0.16, 0.12, [Math.cos(a) * 0.22, 0.7, Math.sin(a) * 0.22], GM_L, { rot: [0, -a, 0] });
  }
  return { hull: b.build(), mount: [0, 0, 0], muzzle: [0, 0.4, 0], rotors: [], height: 0.8 };
}

function podOpenModel(t: Team): ModelDef {
  const b = new ModelBuilder();
  b.cyl(0.13, 0.15, 0.12, 10, [0, 0.06, 0], WHITE);
  b.cyl(0.07, 0.07, 0.02, 8, [0, 0.125, 0], 0x202328);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const x = Math.cos(a) * 0.24;
    const z = Math.sin(a) * 0.24;
    b.box(0.16, 0.03, 0.26, [x, 0.05, z], GM_L, { rot: [0, -a + Math.PI / 2, 0.0] });
    b.box(0.14, 0.035, 0.05, [x * 1.1, 0.06, z * 1.1], t.main, { rot: [0, -a + Math.PI / 2, 0] });
  }
  return { hull: b.build(), mount: [0, 0, 0], muzzle: [0, 0.1, 0], rotors: [], height: 0.2 };
}

/** Deterministic rubble heap for a destroyed building of `size` tiles. */
function rubbleGeo(size: number, seed: number): THREE.BufferGeometry {
  let s = seed * 9301 + 49297;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const b = new ModelBuilder();
  const n = Math.round(10 + size * size * 5);
  const cols = [GM_D, 0x3a3631, 0x55504a, 0x2a2826, 0x6a645c];
  for (let i = 0; i < n; i++) {
    const x = (rnd() - 0.5) * size * 0.85;
    const z = (rnd() - 0.5) * size * 0.85;
    const w = 0.08 + rnd() * 0.25 * Math.min(2, size);
    const h = 0.04 + rnd() * 0.16;
    b.box(w, h, w * (0.5 + rnd()), [x, h / 2, z], cols[Math.floor(rnd() * cols.length)]!, { rot: [rnd() * 0.6, rnd() * 3, rnd() * 0.6] });
  }
  for (let i = 0; i < 2 + size * 2; i++) {
    const x = (rnd() - 0.5) * size * 0.7;
    const z = (rnd() - 0.5) * size * 0.7;
    b.box(0.03, 0.03, 0.3 + rnd() * 0.4 * size, [x, 0.1, z], 0x45403a, { rot: [rnd() * 0.8 - 0.4, rnd() * 3, rnd() * 0.5] });
  }
  return b.build();
}

// -------------------------------------------------------------- library ---

export interface ModelInstance {
  root: THREE.Group;
  /** The body (rotates with the hull facing). */
  body: THREE.Group;
  turret: THREE.Object3D | null;
  rotors: { obj: THREE.Object3D; axis: "y" | "z"; speed: number }[];
  cargo: THREE.Mesh | null;
  def: ModelDef;
}

const cache = new Map<string, ModelDef>();

function def(key: string, make: () => ModelDef): ModelDef {
  let d = cache.get(key);
  if (!d) {
    d = make();
    cache.set(key, d);
  }
  return d;
}

export function unitDef(kind: UnitKind, f: Faction): ModelDef {
  return def(`u/${f}/${kind}`, () => UNIT_MODELS[kind](TEAMS[f]));
}

export function buildingDef(kind: BuildingKind, f: Faction): ModelDef {
  return def(`b/${f}/${kind}`, () => BUILDING_MODELS[kind](TEAMS[f]));
}

export function uplinkDef(): ModelDef {
  return def("obj/uplink", uplinkModel);
}

export function crateDef(): ModelDef {
  return def("obj/crate", crateModel);
}

export function podDef(f: Faction, open = false): ModelDef {
  return def(`pod/${f}/${open}`, () => (open ? podOpenModel : podModel)(TEAMS[f]));
}

/** Longest side of each unit in tiles (as the painted sprites were sized), before the 3D readability bump. */
const UNIT_SIZE: Record<UnitKind, number> = {
  harvester: 1.15, scout: 0.85, stinger: 0.95, "flak-crawler": 1.0, mortar: 1.15, titan: 1.45,
  lancer: 1.05, wasp: 1.0, raptor: 1.15, hornet: 1.5, mender: 0.85
};
/** Units read a touch bigger than their footprint in 3D, as in any RTS. */
const UNIT_BUMP = 1.12;
const scales = new Map<UnitKind, number>();

/** Uniform scale that brings a unit model to its intended size on the map. */
export function unitScale(kind: UnitKind): number {
  let s = scales.get(kind);
  if (s === undefined) {
    const d = unitDef(kind, "blue");
    const box = d.hull.boundingBox!.clone();
    if (d.turret) box.union(d.turret.boundingBox!.clone().translate(new THREE.Vector3(...d.mount)));
    const size = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
    s = (UNIT_SIZE[kind] / size) * UNIT_BUMP;
    scales.set(kind, s);
  }
  return s;
}

let chute: THREE.BufferGeometry | null = null;
export function chuteGeometry(): THREE.BufferGeometry {
  return (chute ??= chuteGeo());
}

const rubbles = new Map<string, THREE.BufferGeometry>();
export function rubbleGeometry(size: number, variant: number): THREE.BufferGeometry {
  const key = `${size}/${variant}`;
  let g = rubbles.get(key);
  if (!g) {
    g = rubbleGeo(size, variant + 1);
    rubbles.set(key, g);
  }
  return g;
}

/** A mesh using the shared model material (swappable variants). */
export function modelMesh(geo: THREE.BufferGeometry, shadows = true): THREE.Mesh {
  const m = new THREE.Mesh(geo, modelMat("normal"));
  m.userData.model = true;
  m.castShadow = shadows;
  m.receiveShadow = shadows;
  return m;
}

/** Build a scene-graph instance of a model (geometry shared). */
export function instance(d: ModelDef, shadows = true): ModelInstance {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  body.add(modelMesh(d.hull, shadows));
  let turret: THREE.Object3D | null = null;
  if (d.turret) {
    turret = new THREE.Group();
    turret.position.set(...d.mount);
    turret.add(modelMesh(d.turret, shadows));
    body.add(turret);
  }
  const rotors = d.rotors.map((r) => {
    const obj = modelMesh(r.geo, false);
    obj.position.set(...r.at);
    body.add(obj);
    return { obj, axis: r.axis, speed: r.speed };
  });
  let cargo: THREE.Mesh | null = null;
  if (d.cargo) {
    cargo = modelMesh(d.cargo, shadows);
    cargo.visible = false;
    body.add(cargo);
  }
  return { root, body, turret, rotors, cargo, def: d };
}
