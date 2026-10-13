// Scratch gallery: candidate new models for the Raptor (too like the Lancer: both were team-edged
// deltas), the Lancer (should read as a hover tank) and the Hornet (a big Scout: four rotors).
// `npm run dev`, then /tools/unit-alts.html. A unit is a design id below, or a UnitKind for today's model.
//   ?view=lineup&kind=<k>      today's model and every candidate for raptor|lancer|hornet, its neighbours behind
//   ?view=roster&kind=<k>      one row per candidate, among the units it must not be mistaken for
//   ?view=close&d=<unit>       one model up close, blue and red (?face=rad ?pitch=deg ?zoom=)
//   ?view=battle&lancer=<unit>&raptor=<unit>&hornet=<unit>   a mixed skirmish at play zoom
//   ?view=duel&d=<unit>        Lancers on the ground with three of <unit> overhead
// Screenshots: progress-shots/unit-alts/.
import * as THREE from "three";
import { Stage } from "../src/game/three/stage";
import { ModelBuilder, type Vec3 } from "../src/game/three/builder";
import { instance, unitDef, unitScale, TEAMS, GM, GM_D, GM_L, AMBER, WHITE, TRACK, BARREL, type ModelDef } from "../src/game/three/models";
import type { UnitKind } from "../src/sim/types";
import { UNITS } from "../src/sim/balance";

type Team = (typeof TEAMS)["blue"];
const EXHAUST = 0xffa040;
const GLASS = 0xcf7f2a;
const partB = () => new ModelBuilder({ grade: 0.26 });
const hullB = () => new ModelBuilder({ grade: 0.3, ao: [0.12, 0.4] });
const light = (b: ModelBuilder, at: Vec3, s = 0.03, hex = AMBER) => b.box(s, s * 0.8, s, at, hex, { glow: 1 });

/** An air-to-air missile along -Z: white body, team nose, dark cruciform tail fins. */
function missile(b: ModelBuilder, at: Vec3, len: number, t: Team, r = 0.018): void {
  const [x, y, z] = at;
  b.tube(r, len, 6, [x, y, z], WHITE);
  b.cone(r, r * 2.6, 6, [x, y, z - len / 2 - r * 1.3], t.main, { rot: [-Math.PI / 2, 0, 0] });
  b.box(r * 3.4, 0.004, r * 1.8, [x, y, z + len / 2 - r], GM_D);
  b.box(0.004, r * 3.4, r * 1.8, [x, y, z + len / 2 - r], GM_D);
}

/** A glowing jet nozzle pointing +Z at `at`. */
function nozzle(b: ModelBuilder, at: Vec3, r: number): void {
  b.tube(r, 0.06, 8, at, GM_D);
  b.sphere(r * 0.85, [at[0], at[1], at[2] + 0.03], EXHAUST, { glow: 1, w: 6, h: 4, scale: [1, 1, 0.7] });
}

/** Amber canopy bubble centred at `at`. */
function canopy(b: ModelBuilder, at: Vec3, r = 0.04, len = 2.4): void {
  b.sphere(r, at, GLASS, { glow: 0.45, w: 8, h: 5, scale: [1, 0.65, len] });
}

/** A bomb along -Z: dark body, team nose, cruciform tail fins. */
function bomb(b: ModelBuilder, at: Vec3, t: Team, r = 0.032): void {
  const [x, y, z] = at;
  b.tube(r, r * 4.5, 8, at, GM_D);
  b.sphere(r, [x, y, z - r * 2.25], t.main, { w: 6, h: 4 });
  b.box(r * 2.6, 0.005, r * 1.4, [x, y, z + r * 2.4], GM_D);
  b.box(0.005, r * 2.6, r * 1.4, [x, y, z + r * 2.4], GM_D);
}

/** A laser lance along -Z from z0 at height y: emitter block, barrel, three focusing coils, a glowing lens. */
function lance(b: ModelBuilder, y: number, z0: number, len: number): void {
  b.block(0.1, 0.07, 0.1, [0, y, z0 - 0.03], GM_D, { bevel: 0.015 });
  b.tube(0.026, len, 6, [0, y, z0 - len / 2], BARREL);
  for (let i = 0; i < 3; i++) b.torus(0.042, 0.013, [0, y, z0 - len * (0.3 + i * 0.2)], GM_L, { seg: 8 });
  b.tube(0.038, 0.04, 8, [0, y, z0 - len - 0.01], GM_D);
  b.sphere(0.03, [0, y, z0 - len - 0.035], AMBER, { glow: 1, w: 6, h: 4 });
}

/** A tapered octagonal skirt, flat faces to the front, back and sides, `w` × `d` at its foot. */
function skirt(b: ModelBuilder, w: number, d: number, h: number, taper: number, at: Vec3, hex: number, glow = 0): void {
  const k = 1 / Math.cos(Math.PI / 8);
  b.add(new THREE.CylinderGeometry(1 - taper, 1, h, 8, 1, false, Math.PI / 8), at, hex, { scale: [(w / 2) * k, 1, (d / 2) * k], glow });
}

/** A chamfered-rectangle outline: half-widths at the front and back, half-length, corner cut. */
function octo(hwF: number, hwB: number, hd: number, c: number): [number, number][] {
  return [[-hwF + c, -hd], [hwF - c, -hd], [hwF, -hd + c], [hwB, hd - c], [hwB - c, hd], [-hwB + c, hd], [-hwB, hd - c], [-hwF, -hd + c]];
}

/** A propeller spinning about z: `n` blades and a hub. */
function propGeo(r: number, n = 3): THREE.BufferGeometry {
  const b = new ModelBuilder();
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    b.box(r, r * 0.24, 0.008, [(Math.cos(a) * r) / 2, (Math.sin(a) * r) / 2, 0], 0x1a1c1f, { rot: [0, 0, a] });
  }
  b.cyl(r * 0.22, r * 0.22, 0.03, 6, [0, 0, 0], GM_L, { rot: [Math.PI / 2, 0, 0] });
  return b.build();
}

/** Mirror a 2D outline (points with x ≥ 0) to the left side. */
const mirror = (pts: [number, number][]): [number, number][] => pts.map(([x, z]) => [-x, z] as [number, number]).reverse();

type Kind = "raptor" | "lancer" | "hornet";
type Design = { kind: Kind; id: string; name: string; blurb: string; make: (t: Team) => ModelDef };

const DESIGNS: Design[] = [
  // ------------------------------------------------------ Raptor (interceptor) candidates ---
  {
    kind: "raptor",
    id: "berkut",
    name: "A · Forward-swept",
    blurb: "Wings sweep forward from the tail, canards at the nose, twin canted fins",
    make: (t) => {
      const b = partB();
      b.fuselage([[-0.56, 0.008, 0.0, -0.02], [-0.44, 0.042, 0.035, -0.035], [-0.26, 0.068, 0.05, -0.048], [0.0, 0.098, 0.05, -0.05], [0.3, 0.105, 0.042, -0.042], [0.43, 0.09, 0.03, -0.035]], [0, 0, 0], GM, { chamfer: 0.025, edge: 1.35 });
      b.fuselage([[-0.2, 0.026, 0.06, 0.04], [0.32, 0.026, 0.06, 0.04]], [0, 0, 0], t.main, { chamfer: 0.008, edge: 1.4 });
      canopy(b, [0, 0.055, -0.3]);
      // intakes under the canards
      b.pairBlock(0.05, 0.06, 0.16, [0.085, -0.02, -0.1], GM_D, { bevel: 0.012 });
      for (const s of [1, -1]) {
        // canards, team colour
        const can: [number, number][] = [[0.06, -0.27], [0.2, -0.2], [0.2, -0.165], [0.06, -0.15]];
        b.prism(s > 0 ? can : mirror(can), 0.014, [0, 0.0, 0], t.main);
        // the forward-swept wing: dark underskin, gunmetal top, a team panel over most of it
        const wing: [number, number][] = [[0.08, 0.06], [0.47, -0.12], [0.49, -0.03], [0.09, 0.38]];
        const top: [number, number][] = [[0.09, 0.075], [0.46, -0.105], [0.475, -0.04], [0.1, 0.355]];
        const panel: [number, number][] = [[0.11, 0.1], [0.45, -0.09], [0.465, -0.048], [0.12, 0.33]];
        b.prism(s > 0 ? wing : mirror(wing), 0.026, [0, -0.04, 0], GM_D);
        b.prism(s > 0 ? top : mirror(top), 0.012, [0, -0.016, 0], GM);
        b.prism(s > 0 ? panel : mirror(panel), 0.01, [0, -0.006, 0], t.main);
        // small tailplanes
        const tail: [number, number][] = [[0.09, 0.33], [0.24, 0.41], [0.24, 0.46], [0.09, 0.45]];
        b.prism(s > 0 ? tail : mirror(tail), 0.012, [0, -0.02, 0], GM);
        // twin fins, canted out
        b.prism([[0, 0.24], [0, 0.44], [0.13, 0.46], [0.13, 0.38]], 0.012, [s * 0.07, 0.04, 0], t.main, { rot: [0, 0, Math.PI / 2 - s * 0.35] });
        missile(b, [s * 0.49, -0.04, -0.06], 0.24, t);
        nozzle(b, [s * 0.05, 0, 0.44], 0.04);
        light(b, [s * 0.47, -0.02, -0.13], 0.022);
      }
      return { hull: b.build(), mount: [0, 0, 0], muzzle: [0, -0.03, -0.5], rotors: [], height: 0.15 };
    }
  },
  {
    kind: "raptor",
    id: "lightning",
    name: "B · Twin-boom",
    blurb: "Short pod between two engine booms, straight wing, tailplane bridging the booms",
    make: (t) => {
      const b = partB();
      // the central pod
      b.fuselage([[-0.5, 0.01, 0.0, -0.02], [-0.4, 0.05, 0.04, -0.04], [-0.24, 0.075, 0.06, -0.05], [0.05, 0.08, 0.055, -0.05], [0.2, 0.05, 0.03, -0.03]], [0, 0, 0], GM, { chamfer: 0.025, edge: 1.35 });
      canopy(b, [0, 0.06, -0.26], 0.042, 2.2);
      b.fuselage([[-0.12, 0.03, 0.066, 0.05], [0.15, 0.02, 0.045, 0.03]], [0, 0, 0], t.main, { chamfer: 0.008 });
      nozzle(b, [0, 0, 0.21], 0.035);
      // the straight wing across everything, team panels outboard of the booms
      const wing: [number, number][] = [[0.0, -0.08], [0.5, -0.04], [0.52, 0.05], [0.0, 0.1]];
      b.prism([...wing, ...mirror(wing).slice(1, -1)], 0.024, [0, -0.03, 0], GM_D);
      for (const s of [1, -1]) {
        const top: [number, number][] = [[0.27, -0.065], [0.49, -0.035], [0.505, 0.04], [0.27, 0.075]];
        b.prism(s > 0 ? top : mirror(top), 0.01, [0, -0.008, 0], t.main);
        const x = s * 0.22;
        // the boom: intake at the front, nozzle at the back
        b.fuselage([[-0.34, 0.035, 0.03, -0.035], [-0.26, 0.05, 0.045, -0.05], [0.2, 0.05, 0.045, -0.045], [0.42, 0.032, 0.03, -0.03]], [x, 0, 0], GM, { chamfer: 0.02, edge: 1.35 });
        b.tube(0.03, 0.02, 8, [x, 0, -0.345], 0x15171a);
        b.fuselage([[-0.22, 0.016, 0.054, 0.04], [0.3, 0.014, 0.046, 0.03]], [x, 0, 0], t.main, { chamfer: 0.006 });
        nozzle(b, [x, 0, 0.43], 0.03);
        // fin on each boom
        b.prism([[0, 0.28], [0, 0.42], [0.13, 0.44], [0.13, 0.37]], 0.012, [x - 0.006, 0.03, 0], t.main, { rot: [0, 0, Math.PI / 2] });
        missile(b, [s * 0.38, -0.055, -0.02], 0.2, t);
        light(b, [s * 0.515, -0.02, 0.0], 0.022);
      }
      // the tailplane bridging the booms
      b.block(0.48, 0.02, 0.09, [0, 0.03, 0.37], t.main, { bevel: 0.008 });
      return { hull: b.build(), mount: [0, 0, 0], muzzle: [0, -0.03, -0.5], rotors: [], height: 0.15 };
    }
  },
  {
    kind: "raptor",
    id: "pincer",
    name: "C · Pincer",
    blurb: "Two long missile prongs reach forward past a set-back cockpit: an open, forked nose",
    make: (t) => {
      const b = partB();
      // the body, set back between the prongs
      b.fuselage([[-0.26, 0.03, 0.03, -0.02], [-0.16, 0.08, 0.06, -0.045], [0.1, 0.11, 0.065, -0.05], [0.34, 0.1, 0.05, -0.045], [0.44, 0.08, 0.035, -0.035]], [0, 0, 0], GM, { chamfer: 0.03, edge: 1.35 });
      canopy(b, [0, 0.065, -0.12], 0.045, 2.0);
      b.fuselage([[0.0, 0.03, 0.074, 0.05], [0.36, 0.024, 0.06, 0.04]], [0, 0, 0], t.main, { chamfer: 0.008 });
      for (const s of [1, -1]) {
        const x = s * 0.2;
        // a prong: a slim armoured boom out to a gun tip, a team stripe down its top
        b.fuselage([[-0.6, 0.012, 0.012, -0.012], [-0.52, 0.032, 0.03, -0.03], [-0.2, 0.042, 0.04, -0.04], [0.22, 0.045, 0.04, -0.04], [0.32, 0.03, 0.03, -0.03]], [x, 0, 0], GM, { chamfer: 0.016, edge: 1.35 });
        b.fuselage([[-0.5, 0.018, 0.05, 0.03], [0.2, 0.02, 0.05, 0.03]], [x, 0, 0], t.main, { chamfer: 0.006, edge: 1.4 });
        light(b, [x, 0.0, -0.61], 0.02);
        // the yoke from body to prong, and a missile slung inside each prong
        b.block(0.13, 0.04, 0.2, [s * 0.13, -0.005, 0.06], GM_D, { bevel: 0.01 });
        missile(b, [s * 0.145, -0.035, -0.32], 0.24, t);
        // swept wings outboard, team tops
        const wing: [number, number][] = [[0.22, -0.02], [0.45, 0.2], [0.45, 0.28], [0.22, 0.24]];
        b.prism(s > 0 ? wing : mirror(wing), 0.022, [0, -0.035, 0], GM_D);
        const top: [number, number][] = [[0.24, 0.02], [0.44, 0.21], [0.44, 0.265], [0.24, 0.225]];
        b.prism(s > 0 ? top : mirror(top), 0.01, [0, -0.015, 0], t.main);
        light(b, [s * 0.455, -0.01, 0.25], 0.022);
        // twin fins at the body's tail, nozzles under them
        b.prism([[0, 0.22], [0, 0.42], [0.12, 0.44], [0.12, 0.36]], 0.012, [s * 0.06, 0.04, 0], GM, { rot: [0, 0, Math.PI / 2 - s * 0.3] });
        nozzle(b, [s * 0.045, 0, 0.45], 0.036);
      }
      return { hull: b.build(), mount: [0, 0, 0], muzzle: [0, -0.03, -0.6], rotors: [], height: 0.15 };
    }
  },
  {
    kind: "raptor",
    id: "ring",
    name: "D · Ring-wing",
    blurb: "Needle fuselage, canards up front, a big team-coloured ring wing round the engines",
    make: (t) => {
      const b = partB();
      b.fuselage([[-0.6, 0.008, 0.0, -0.02], [-0.46, 0.04, 0.032, -0.035], [-0.25, 0.062, 0.048, -0.048], [0.15, 0.075, 0.05, -0.05], [0.4, 0.06, 0.04, -0.04]], [0, 0, 0], GM, { chamfer: 0.025, edge: 1.35 });
      canopy(b, [0, 0.05, -0.32]);
      for (const s of [1, -1]) {
        const can: [number, number][] = [[0.05, -0.3], [0.18, -0.2], [0.18, -0.16], [0.05, -0.17]];
        b.prism(s > 0 ? can : mirror(can), 0.014, [0, -0.005, 0], GM_L);
        nozzle(b, [s * 0.035, 0, 0.42], 0.03);
      }
      // the ring: four struts out from the fuselage, a team band round its leading edge
      const rz = 0.25;
      const R = 0.3;
      for (let i = 0; i < 4; i++) {
        const a = Math.PI / 4 + (i * Math.PI) / 2;
        b.box(R, 0.014, 0.12, [(Math.cos(a) * R) / 2, (Math.sin(a) * R) / 2, rz + 0.02], GM_D, { rot: [0, 0, a] });
        missile(b, [Math.cos(a) * (R + 0.035), Math.sin(a) * (R + 0.035), rz - 0.02], 0.2, t, 0.016);
      }
      b.torus(R, 0.026, [0, 0, rz], t.main, { seg: 28, scale: [1, 1, 3.6] });
      b.torus(R + 0.006, 0.024, [0, 0, rz + 0.075], GM_D, { seg: 28, scale: [1, 1, 0.9] });
      light(b, [0, R + 0.03, rz], 0.024);
      light(b, [R + 0.03, 0, rz], 0.022);
      light(b, [-R - 0.03, 0, rz], 0.022);
      return { hull: b.build(), mount: [0, 0, 0], muzzle: [0, -0.03, -0.55], rotors: [], height: 0.3 };
    }
  },
  {
    kind: "raptor",
    id: "eagle",
    name: "E · Swept + tailplanes",
    blurb: "Classic air-superiority jet: slim swept wings, separate tailplanes, twin team fins",
    make: (t) => {
      const b = partB();
      b.fuselage([[-0.56, 0.008, 0.0, -0.02], [-0.44, 0.045, 0.035, -0.035], [-0.26, 0.065, 0.05, -0.045], [-0.12, 0.12, 0.045, -0.05], [0.3, 0.12, 0.04, -0.045], [0.44, 0.1, 0.03, -0.035]], [0, 0, 0], GM, { chamfer: 0.025, edge: 1.35 });
      canopy(b, [0, 0.055, -0.3]);
      b.fuselage([[-0.18, 0.024, 0.056, 0.04], [0.3, 0.024, 0.05, 0.035]], [0, 0, 0], GM_L, { chamfer: 0.008 });
      for (const s of [1, -1]) {
        const wing: [number, number][] = [[0.1, -0.12], [0.46, 0.13], [0.46, 0.2], [0.1, 0.17]];
        b.prism(s > 0 ? wing : mirror(wing), 0.022, [0, -0.035, 0], GM_D);
        const top: [number, number][] = [[0.13, -0.08], [0.45, 0.145], [0.45, 0.19], [0.13, 0.155]];
        b.prism(s > 0 ? top : mirror(top), 0.01, [0, -0.015, 0], t.main);
        const tail: [number, number][] = [[0.1, 0.27], [0.27, 0.4], [0.27, 0.46], [0.1, 0.45]];
        b.prism(s > 0 ? tail : mirror(tail), 0.014, [0, -0.03, 0], GM);
        b.prism([[0, 0.22], [0, 0.42], [0.15, 0.44], [0.15, 0.35]], 0.012, [s * 0.1, 0.035, 0], t.main, { rot: [0, 0, Math.PI / 2 - s * 0.2] });
        missile(b, [s * 0.47, -0.035, 0.12], 0.22, t);
        missile(b, [s * 0.3, -0.06, 0.06], 0.2, t);
        nozzle(b, [s * 0.055, 0, 0.45], 0.042);
        light(b, [s * 0.465, -0.01, 0.2], 0.022);
      }
      return { hull: b.build(), mount: [0, 0, 0], muzzle: [0, -0.03, -0.5], rotors: [], height: 0.15 };
    }
  },
  // ------------------------------------------------ Lancer (hover laser tank) candidates ---
  {
    kind: "lancer",
    id: "gravtank",
    name: "L1 · Skirted grav-tank",
    blurb: "A real tank hull on a dark armoured skirt, lift glow leaking out under it, a long coiled laser lance",
    make: (t) => {
      const b = hullB();
      // the lift field: an amber rim just proud of the skirt's foot; the skirt; the hull on it
      skirt(b, 0.66, 0.97, 0.022, 0, [0, 0.03, 0.0], AMBER, 1);
      skirt(b, 0.58, 0.88, 0.09, 0.04, [0, 0.08, 0], TRACK);
      b.block(0.56, 0.13, 0.82, [0, 0.19, 0.02], GM, { taper: 0.14, bevel: 0.035 });
      b.block(0.46, 0.05, 0.16, [0, 0.19, -0.38], GM_D, { rot: [0.5, 0, 0], bevel: 0.015 });
      // team deck plates either side of the turret and across the back (not fenders: it has no tracks)
      b.pairBlock(0.1, 0.02, 0.5, [0.15, 0.265, 0.02], t.main, { bevel: 0.008 });
      b.block(0.3, 0.02, 0.1, [0, 0.265, 0.34], t.main, { bevel: 0.008 });
      // engine grilles glowing at the back, lift vents along the flanks
      for (const s of [1, -1]) {
        b.box(0.11, 0.04, 0.012, [s * 0.12, 0.19, 0.434], EXHAUST, { glow: 1 });
        for (const z of [-0.2, 0.0, 0.2]) b.box(0.012, 0.025, 0.08, [s * 0.282, 0.19, z], 0x15171a);
      }
      light(b, [0.15, 0.2, -0.47]);
      light(b, [-0.15, 0.2, -0.47]);
      const tu = partB();
      tu.drum(0.17, 0.13, 0.09, 6, [0, 0.045, 0.02], GM, { bevel: 0.02 });
      tu.drum(0.11, 0.09, 0.025, 6, [0, 0.1, 0.04], t.main, { bevel: 0.01 });
      lance(tu, 0.05, -0.1, 0.46);
      tu.pairBlock(0.03, 0.06, 0.1, [0.09, 0.06, 0.13], GM_D, { bevel: 0.008 });
      light(tu, [-0.08, 0.1, -0.05], 0.022);
      return { hull: b.build(), turret: tu.build(), mount: [0, 0.255, 0.04], muzzle: [0, 0.05, -0.6], rotors: [], height: 0.45 };
    }
  },
  {
    kind: "lancer",
    id: "twinpod",
    name: "L2 · Twin-pod hover tank",
    blurb: "A rounded slab of a hull slung between two big lift-engine pods, each glowing underneath",
    make: (t) => {
      const b = hullB();
      skirt(b, 0.42, 0.84, 0.07, 0.12, [0, 0.075, 0], TRACK);
      b.fuselage([[-0.48, 0.13, 0.2, 0.08], [-0.38, 0.2, 0.25, 0.07], [-0.1, 0.22, 0.28, 0.07], [0.3, 0.21, 0.27, 0.08], [0.43, 0.17, 0.24, 0.1]], [0, 0, 0], GM, { chamfer: 0.05, edge: 1.35 });
      b.block(0.3, 0.05, 0.12, [0, 0.24, -0.4], GM_D, { rot: [0.45, 0, 0], bevel: 0.012 });
      b.block(0.22, 0.02, 0.16, [0, 0.285, 0.26], t.main, { bevel: 0.008 });
      for (const s of [1, -1]) {
        const x = s * 0.33;
        b.block(0.14, 0.06, 0.18, [s * 0.235, 0.19, 0.1], GM_D, { bevel: 0.012 });
        // the pod: an intake at the front, a team band along the top, a glowing nozzle, a lift vent under it
        b.fuselage([[-0.13, 0.07, 0.25, 0.11], [-0.07, 0.1, 0.28, 0.08], [0.25, 0.1, 0.28, 0.08], [0.34, 0.075, 0.26, 0.1]], [x, 0, 0], GM, { chamfer: 0.04, edge: 1.35 });
        b.fuselage([[-0.05, 0.05, 0.296, 0.27], [0.25, 0.05, 0.296, 0.27]], [x, 0, 0], t.main, { chamfer: 0.012, edge: 1.35 });
        b.box(0.11, 0.07, 0.012, [x, 0.18, -0.135], 0x15171a);
        b.box(0.12, 0.08, 0.012, [x, 0.18, 0.345], EXHAUST, { glow: 0.9 });
        b.cyl(0.085, 0.085, 0.012, 10, [x, 0.074, 0.1], AMBER, { glow: 1 });
        light(b, [x + s * 0.1, 0.2, -0.06], 0.022);
      }
      const tu = partB();
      tu.block(0.26, 0.075, 0.26, [0, 0.0375, 0.02], GM, { taper: 0.2, bevel: 0.02 });
      tu.block(0.14, 0.02, 0.14, [0, 0.083, 0.04], t.main, { bevel: 0.008 });
      lance(tu, 0.04, -0.1, 0.42);
      return { hull: b.build(), turret: tu.build(), mount: [0, 0.28, -0.1], muzzle: [0, 0.04, -0.56], rotors: [], height: 0.45 };
    }
  },
  {
    kind: "lancer",
    id: "hovercraft",
    name: "L3 · Hovercraft",
    blurb: "A fat black inflated skirt all round a flat deck, twin ducted props at the stern, the lance turret up front",
    make: (t) => {
      const b = hullB();
      const hw = 0.27;
      const hd = 0.44;
      const rc = 0.13;
      const tr = 0.058;
      const y = 0.065;
      // the inflated skirt: a fat black bumper round the whole craft
      for (const s of [1, -1]) {
        b.tube(tr, 2 * (hd - rc), 8, [s * hw, y, 0], TRACK);
        b.cyl(tr, tr, 2 * (hw - rc), 8, [0, y, s * hd], TRACK, { rot: [0, 0, Math.PI / 2] });
      }
      for (const [sx, sz, a] of [[1, 1, 0], [-1, 1, Math.PI / 2], [-1, -1, Math.PI], [1, -1, Math.PI * 1.5]] as [number, number, number][])
        b.add(new THREE.TorusGeometry(rc, tr, 6, 6, Math.PI / 2), [sx * (hw - rc), y, sz * (hd - rc)], TRACK, { rot: [Math.PI / 2, 0, a] });
      // the deck and a low armoured cabin, team gunwales, a sloped bow
      b.prism(octo(0.26, 0.26, 0.43, 0.12), 0.06, [0, 0.07, 0], GM);
      b.block(0.32, 0.09, 0.46, [0, 0.175, -0.04], GM, { taper: 0.15, bevel: 0.03 });
      b.block(0.3, 0.035, 0.12, [0, 0.15, -0.33], GM_D, { rot: [0.45, 0, 0], bevel: 0.012 });
      b.pairBlock(0.05, 0.02, 0.56, [0.215, 0.14, 0.0], t.main, { bevel: 0.008 });
      light(b, [0.12, 0.16, -0.4]);
      light(b, [-0.12, 0.16, -0.4]);
      // twin ducted props at the stern, rudders behind them
      const props: Vec3[] = [];
      for (const s of [1, -1]) {
        const x = s * 0.135;
        b.box(0.03, 0.12, 0.06, [x, 0.18, 0.34], GM_D);
        b.torus(0.105, 0.024, [x, 0.285, 0.34], t.main, { seg: 16, scale: [1, 1, 2.4] });
        b.cyl(0.02, 0.02, 0.05, 6, [x, 0.285, 0.34], GM_L, { rot: [Math.PI / 2, 0, 0] });
        b.box(0.012, 0.16, 0.06, [x, 0.285, 0.43], GM_D);
        props.push([x, 0.285, 0.34]);
      }
      const tu = partB();
      tu.drum(0.13, 0.1, 0.075, 6, [0, 0.0375, 0.02], GM, { bevel: 0.015 });
      tu.drum(0.08, 0.065, 0.02, 6, [0, 0.085, 0.04], t.main, { bevel: 0.008 });
      lance(tu, 0.04, -0.08, 0.4);
      const pg = propGeo(0.09, 3);
      return {
        hull: b.build(), turret: tu.build(), mount: [0, 0.22, -0.1], muzzle: [0, 0.04, -0.52], height: 0.45,
        rotors: props.map((at, i) => ({ geo: pg, at, axis: "z" as const, speed: i ? -30 : 30 }))
      };
    }
  },
  // ------------------------------------------------------- Hornet (heavy bomber) candidates ---
  {
    kind: "hornet",
    id: "fortress",
    name: "H1 · Flying fortress",
    blurb: "Long glazed-nose fuselage, a broad straight wing with four engine nacelles, bombs slung between them",
    make: (t) => {
      const b = partB();
      b.fuselage([[-0.52, 0.02, 0.03, -0.03], [-0.45, 0.07, 0.065, -0.07], [-0.32, 0.1, 0.085, -0.085], [0.22, 0.1, 0.085, -0.08], [0.5, 0.035, 0.055, -0.01]], [0, 0, 0], GM, { chamfer: 0.035, edge: 1.35 });
      b.sphere(0.06, [0, -0.005, -0.465], GLASS, { glow: 0.45, w: 8, h: 5, scale: [1, 0.9, 1.1] });
      canopy(b, [0, 0.085, -0.3], 0.045, 1.8);
      b.fuselage([[-0.2, 0.03, 0.098, 0.08], [0.42, 0.02, 0.07, 0.05]], [0, 0, 0], t.main, { chamfer: 0.008 });
      const half: [number, number][] = [[0.0, -0.13], [0.76, -0.05], [0.76, 0.04], [0.0, 0.11]];
      b.prism([...half, ...mirror(half).slice(1, -1)], 0.028, [0, -0.04, 0], GM_D);
      for (const s of [1, -1]) {
        const top: [number, number][] = [[0.1, -0.11], [0.75, -0.04], [0.75, 0.03], [0.1, 0.095]];
        b.prism(s > 0 ? top : mirror(top), 0.012, [0, -0.014, 0], GM);
        const panel: [number, number][] = [[0.12, -0.095], [0.745, -0.038], [0.745, 0.028], [0.12, 0.085]];
        b.prism(s > 0 ? panel : mirror(panel), 0.01, [0, -0.004, 0], t.main);
        for (const x of [0.25, 0.47]) {
          b.fuselage([[-0.21, 0.03, 0.03, -0.03], [-0.18, 0.048, 0.045, -0.05], [0.06, 0.048, 0.045, -0.05], [0.12, 0.034, 0.035, -0.035]], [s * x, -0.03, 0], GM, { chamfer: 0.02, edge: 1.35 });
          b.tube(0.03, 0.01, 8, [s * x, -0.03, -0.215], 0x15171a);
          nozzle(b, [s * x, -0.03, 0.12], 0.03);
        }
        bomb(b, [s * 0.36, -0.085, 0.0], t);
        const tail: [number, number][] = [[0.0, 0.38], [0.27, 0.45], [0.27, 0.51], [0.0, 0.5]];
        b.prism(s > 0 ? tail : mirror(tail), 0.012, [0, 0.0, 0], t.main);
        light(b, [s * 0.765, -0.02, 0.0], 0.024);
      }
      b.prism([[0, 0.28], [0, 0.5], [0.17, 0.53], [0.17, 0.44]], 0.014, [0.007, 0.05, 0], GM, { rot: [0, 0, Math.PI / 2] });
      return { hull: b.build(), mount: [0, 0, 0], muzzle: [0, -0.1, 0.0], rotors: [], height: 0.2 };
    }
  },
  {
    kind: "hornet",
    id: "wing",
    name: "H2 · Flying wing",
    blurb: "A wide stealth-bomber boomerang with a sawtooth trailing edge, dorsal intakes and big team wing panels",
    make: (t) => {
      const b = partB();
      const half: [number, number][] = [[0, -0.4], [0.76, 0.13], [0.75, 0.19], [0.5, 0.31], [0.34, 0.2], [0.17, 0.31], [0, 0.22]];
      const outline = [...half, ...mirror(half).slice(1, -1)];
      b.prism(outline, 0.03, [0, -0.04, 0], GM_D);
      b.prism(outline, 0.012, [0, -0.012, 0], GM, { scale: [0.975, 1, 0.95] });
      for (const s of [1, -1]) {
        const panel: [number, number][] = [[0.3, -0.155], [0.68, 0.105], [0.68, 0.17], [0.5, 0.27], [0.36, 0.18], [0.3, 0.14]];
        b.prism(s > 0 ? panel : mirror(panel), 0.01, [0, -0.002, 0], t.main);
        b.block(0.08, 0.035, 0.12, [s * 0.12, 0.06, -0.04], GM_D, { bevel: 0.01 });
        b.box(0.06, 0.02, 0.012, [s * 0.12, 0.065, -0.1], 0x15171a);
        b.box(0.1, 0.014, 0.025, [s * 0.1, 0.004, 0.255], EXHAUST, { glow: 1 });
        light(b, [s * 0.76, -0.01, 0.16], 0.024);
      }
      b.fuselage([[-0.38, 0.03, 0.0, -0.03], [-0.3, 0.1, 0.05, -0.05], [-0.1, 0.2, 0.08, -0.055], [0.1, 0.2, 0.07, -0.05], [0.24, 0.1, 0.03, -0.03]], [0, 0, 0], GM, { chamfer: 0.04, edge: 1.35 });
      b.sphere(0.06, [0, 0.05, -0.24], GLASS, { glow: 0.45, w: 8, h: 5, scale: [1.5, 0.5, 0.8] });
      b.prism([[0, -0.15], [0.06, -0.06], [0.06, -0.03], [0, -0.1], [-0.06, -0.03], [-0.06, -0.06]], 0.008, [0, 0.083, 0], t.main);
      return { hull: b.build(), mount: [0, 0, 0], muzzle: [0, -0.06, 0.05], rotors: [], height: 0.15 };
    }
  },
  {
    kind: "hornet",
    id: "airship",
    name: "H3 · Armoured airship",
    blurb: "A big slow armoured envelope with team bands, cruciform tail fins, a bomb gondola and two pusher props",
    make: (t) => {
      const b = partB();
      const L = 0.62;
      const RX = 0.25;
      const RY = 0.21;
      const Y = 0.05;
      const r = (z: number) => Math.sqrt(Math.max(0, 1 - (z / L) ** 2));
      b.sphere(1, [0, Y, 0], GM, { w: 16, h: 12, scale: [RX, L, RY], rot: [Math.PI / 2, 0, 0] });
      // armour bands round it (team fore and aft, dark ribs between), a team stripe along the spine
      for (const [z, hex, w] of [[-0.36, t.main, 1.8], [-0.12, GM_D, 0.8], [0.12, GM_D, 0.8], [0.36, t.main, 1.8]] as [number, number, number][])
        b.torus(RX * r(z) + 0.004, 0.012, [0, Y, z], hex, { seg: 18, scale: [1, RY / RX, w] });
      const spine = [-0.5, -0.36, -0.15, 0.05, 0.25, 0.42, 0.54].map((z) => {
        const top = Y + RY * r(z) + 0.004;
        return [z, 0.03, top, top - 0.03] as [number, number, number, number];
      });
      b.fuselage(spine, [0, 0, 0], t.main, { chamfer: 0.008, edge: 1.3 });
      b.sphere(0.05, [0, Y, -L + 0.02], GM_D, { w: 8, h: 5 });
      light(b, [0, Y, -L - 0.03], 0.024);
      // cruciform tail fins
      const fin: [number, number][] = [[0.1, 0.4], [0.3, 0.56], [0.3, 0.68], [0.06, 0.64]];
      b.prism(fin, 0.014, [0.007, Y, 0], t.main, { rot: [0, 0, Math.PI / 2] });
      b.prism(fin, 0.014, [-0.007, Y, 0], t.main, { rot: [0, 0, -Math.PI / 2] });
      for (const s of [1, -1]) {
        b.prism(s > 0 ? fin : mirror(fin), 0.014, [0, Y - 0.007, 0], t.main);
        light(b, [s * 0.3, Y, 0.62], 0.02);
      }
      // the bomb gondola: amber windows, bombs racked underneath
      b.block(0.13, 0.07, 0.34, [0, Y - RY - 0.02, 0.0], GM_D, { bevel: 0.015 });
      b.pair(0.004, 0.018, 0.24, [0.066, Y - RY - 0.01, 0.0], AMBER, { glow: 0.7 });
      for (const z of [-0.1, 0.0, 0.1]) bomb(b, [0, Y - RY - 0.075, z], t, 0.022);
      // two engine pods on outriggers with pusher props
      const props: Vec3[] = [];
      for (const s of [1, -1]) {
        b.box(0.14, 0.016, 0.05, [s * 0.27, Y - 0.07, 0.14], GM_D);
        b.tube(0.042, 0.17, 8, [s * 0.35, Y - 0.07, 0.14], GM);
        b.tube(0.045, 0.03, 8, [s * 0.35, Y - 0.07, 0.08], t.main);
        b.cone(0.03, 0.04, 6, [s * 0.35, Y - 0.07, 0.24], GM_D, { rot: [Math.PI / 2, 0, 0] });
        props.push([s * 0.35, Y - 0.07, 0.262]);
      }
      const pg = propGeo(0.075, 3);
      return {
        hull: b.build(), mount: [0, 0, 0], muzzle: [0, Y - RY - 0.08, 0], height: 0.3,
        rotors: props.map((at, i) => ({ geo: pg, at, axis: "z" as const, speed: i ? -26 : 26 }))
      };
    }
  }
];

// --------------------------------------------------------------- scene ---

const q = new URLSearchParams(location.search);
const view = q.get("view") ?? "lineup";
const stage = new Stage(document.getElementById("game")!, Math.min(2, devicePixelRatio));
stage.setBiome((q.get("biome") as "temperate") ?? "temperate");
// (the stage turns shadows off on software GL: back on, they show who's flying)
const st = stage as unknown as { renderer: THREE.WebGLRenderer; sun: THREE.DirectionalLight };
st.renderer.shadowMap.enabled = true;
st.sun.castShadow = true;
st.renderer.setPixelRatio(Number(q.get("dpr") ?? 1));
stage.resize();
const plate = new THREE.Mesh(new THREE.PlaneGeometry(80, 60), new THREE.MeshLambertMaterial({ color: q.get("ground") ?? "#5b6b3a" }));
plate.rotation.x = -Math.PI / 2;
plate.receiveShadow = true;
stage.scene.add(plate);

const AIR_H = 1.35;
const HOVER_H = 0.12;
const AIR = new Set<string>(["scout", "wasp", "raptor", "hornet", "mender", "condor"]);
/** Each candidate at its unit's size on the map: longest side in tiles (models.ts UNIT_SIZE), with the 1.12 bump. */
const SIZE: Record<Kind, number> = { raptor: 1.15, lancer: 1.05, hornet: 1.5 };
const design = (id: string) => DESIGNS.find((d) => d.id === id);
const defs = new Map<string, ModelDef>();
function designDef(id: string, f: "blue" | "red"): ModelDef {
  const key = `${id}/${f}`;
  let d = defs.get(key);
  if (!d) {
    d = design(id)!.make(TEAMS[f]);
    defs.set(key, d);
  }
  return d;
}
function designScale(id: string): number {
  const d = designDef(id, "blue");
  const box = d.hull.boundingBox!.clone();
  if (d.turret) box.union(d.turret.boundingBox!.clone().translate(new THREE.Vector3(...d.mount)));
  return (SIZE[design(id)!.kind] * 1.12) / Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
}
/** A candidate's name, or today's unit's. */
const nameOf = (id: string) => design(id)?.name ?? UNITS[id as UnitKind].name;

const labels: { el: HTMLDivElement; at: THREE.Vector3 }[] = [];
function label(text: string, sub: string, at: THREE.Vector3): void {
  const el = document.createElement("div");
  el.className = "lbl";
  el.innerHTML = `<b>${text}</b>${sub ? `<span>${sub}</span>` : ""}`;
  document.body.appendChild(el);
  labels.push({ el, at });
}

const spinning: { obj: THREE.Object3D; axis: "y" | "z"; speed: number }[] = [];
/** Place a unit (a candidate id, or a UnitKind for today's model) at its height: flying, hovering or grounded. */
function place(id: string, f: "blue" | "red", x: number, z: number, face: number, bank = 0): THREE.Group {
  const d = design(id);
  const kind = (d ? d.kind : id) as UnitKind;
  const inst = instance(d ? designDef(id, f) : unitDef(kind, f));
  inst.root.scale.setScalar(d ? designScale(id) : unitScale(kind));
  const air = AIR.has(kind);
  inst.root.position.set(x, air ? AIR_H : kind === "lancer" ? HOVER_H : 0, z);
  inst.body.rotation.set(air ? -0.08 : 0, -face, bank);
  if (inst.turret) inst.turret.rotation.y = 0.35;
  spinning.push(...inst.rotors);
  stage.scene.add(inst.root);
  return inst.root;
}
/** Label a placed unit just below it on screen. */
const box = new THREE.Box3();
function labelUnder(root: THREE.Object3D, text: string, sub = ""): void {
  box.setFromObject(root);
  label(text, sub, new THREE.Vector3(root.position.x, box.min.y, box.max.z + 0.15));
}

let center: [number, number] = [0, 0];
const factions = (q.get("faction") ?? "blue").split(",") as ("blue" | "red")[];
const kind = (q.get("kind") ?? "raptor") as Kind;
const cands = [kind as string, ...DESIGNS.filter((d) => d.kind === kind).map((d) => d.id)];
const raptorPick = q.get("raptor") ?? "lightning";
const face = Number(q.get("face") ?? 0.35);
if (view === "lineup") {
  // its neighbours today behind, then today's model and every candidate
  const NEIGHBOURS: Record<Kind, string[]> = { raptor: ["lancer", "wasp"], lancer: ["stinger", "flak-crawler", "mastodon"], hornet: ["scout", "condor", "mender"] };
  const f = factions[0]!;
  const sp = kind === "hornet" ? 2.7 : 2.4;
  const mid = ((cands.length - 1) * sp) / 2;
  NEIGHBOURS[kind].forEach((id, i, all) => {
    const r = place(id, f, mid + (i - (all.length - 1) / 2) * sp, 0, face);
    labelUnder(r, nameOf(id), "today");
  });
  cands.forEach((id, i) => {
    const r = place(id, f, i * sp, 3.4, face);
    labelUnder(r, design(id) ? nameOf(id) : `${nameOf(id)} — today`);
  });
  center = [mid, 1.8];
} else if (view === "roster") {
  // one row per candidate, among the units it must not be mistaken for ("*" the candidate, "@raptor" the Raptor pick)
  const ROSTER: Record<Kind, string[]> = {
    raptor: ["lancer", "scout", "wasp", "*", "hornet", "mender", "condor"],
    lancer: ["stinger", "flak-crawler", "mortar", "mastodon", "*", "harvester", "@raptor"],
    hornet: ["scout", "wasp", "@raptor", "*", "mender", "condor"]
  };
  const cols = ROSTER[kind];
  const sp = kind === "hornet" ? 1.95 : kind === "lancer" ? 1.6 : 1.75;
  const rowH = kind === "hornet" ? 2.3 : 2.1;
  const f = factions[0]!;
  cands.forEach((id, r) => {
    const z = r * rowH;
    cols.forEach((c, i) => place(c === "*" ? id : c === "@raptor" ? raptorPick : c, f, i * sp, z, 0.3));
    label(design(id) ? nameOf(id) : `${nameOf(id)} — today`, "", new THREE.Vector3(-sp * 0.95, kind === "lancer" ? 0 : AIR_H, z + 0.1));
  });
  cols.forEach((c, i) => {
    const id = c === "*" ? kind : c === "@raptor" ? raptorPick : c;
    const n = c === "@raptor" ? (design(raptorPick) ? "Raptor (B)" : "Raptor") : nameOf(id);
    label(n, "", new THREE.Vector3(i * sp, AIR.has(design(id)?.kind ?? id) ? AIR_H : 0, -1.05));
  });
  center = [((cols.length - 1) * sp) / 2 - 0.6, ((cands.length - 1) * rowH) / 2];
} else if (view === "close") {
  const id = q.get("d") ?? "raptor";
  const roots = factions.map((f, fi) => place(id, f, fi * Number(q.get("gap") ?? 1.9), 0, Number(q.get("face") ?? 2.5)));
  center = [((factions.length - 1) * Number(q.get("gap") ?? 1.9)) / 2, -roots[0]!.position.y - 0.1];
} else if (view === "duel") {
  // Lancers (or a Lancer candidate) on the ground, three aircraft over them, then the same the other way round
  const g = q.get("ground") ?? "lancer";
  const a = q.get("air") ?? "raptor";
  const spots: [number, number, number][] = [[-1.1, 0.9, 0.2], [0.3, 1.5, -0.1], [1.3, 0.4, 0.4]];
  const air: [number, number, number][] = [[-0.6, -0.4, 2.9], [0.8, 0.1, 3.3], [1.9, -1.1, 3.0]];
  const f0 = factions[0]!;
  const f1 = (factions[1] ?? (f0 === "blue" ? "red" : "blue")) as "blue" | "red";
  for (const [x, z, r] of spots) place(g, f0, x, z, r);
  for (const [x, z, r] of air) place(a, f1, x, z, r, 0.2);
  for (const [x, z, r] of spots) place(g, f1, x + 4.6, z - 0.6, r + 2.9);
  for (const [x, z, r] of air) place(a, f0, x + 4.6, z - 0.1, r - 3.0, -0.2);
  center = [2.3, 0.6];
} else if (view === "battle") {
  // a mixed skirmish: blue pushing north-east, red coming the other way, both air forces overhead
  const L = q.get("lancer") ?? "lancer";
  const R = q.get("raptor") ?? "raptor";
  const H = q.get("hornet") ?? "hornet";
  // (aircraft sit south of their ground units: at altitude they show about a tile further north)
  const units: [string, number, number][] = [
    [L, 0.0, 3.6], [L, 1.4, 4.2], [L, 0.8, 2.6], ["stinger", 2.6, 3.4], ["stinger", -1.0, 4.4], ["mastodon", 2.3, 5.1],
    [R, 2.8, 1.4], [R, 4.2, 2.0], [H, 0.4, 0.7], ["scout", 4.7, 0.5], ["condor", -1.5, 1.8]
  ];
  for (const [id, x, z] of units) {
    place(id, "blue", x, z, 0.75, 0.15);
    place(id, "red", 11 - x, 5.2 - z, 0.75 + Math.PI, -0.15);
  }
  center = [5.5, 2.2];
}

stage.rig.bounds = { x0: -100, y0: -100, x1: 100, y1: 100 };
const pitch = q.get("pitch");
if (pitch !== null) stage.rig.pitchFor = () => THREE.MathUtils.degToRad(Number(pitch));
stage.rig.zoom = Number(q.get("zoom") ?? (view === "close" ? 160 : view === "battle" || view === "duel" ? 50 : 60));
// (close-ups look at the model, not the ground under it)
if (view === "close") center[1] = center[1] / Math.tan(stage.rig.pitchFor(stage.rig.zoom));
stage.rig.centerOn(Number(q.get("x") ?? center[0]), Number(q.get("y") ?? center[1]));

const v = new THREE.Vector3();
let last = performance.now();
const loop = () => {
  const now = performance.now();
  const dt = q.has("still") ? 0 : Math.min(50, now - last);
  last = now;
  for (const r of spinning) r.obj.rotation[r.axis] += (r.speed * dt) / 1000;
  stage.render();
  for (const l of labels) {
    v.copy(l.at).project(stage.rig.camera);
    l.el.style.left = `${((v.x + 1) / 2) * innerWidth}px`;
    l.el.style.top = `${((1 - v.y) / 2) * innerHeight}px`;
  }
  requestAnimationFrame(loop);
};
loop();
addEventListener("resize", () => stage.resize());
(window as unknown as { ready: boolean }).ready = true;
