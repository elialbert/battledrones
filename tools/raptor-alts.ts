// Scratch gallery: alternative Raptor (interceptor) models, to tell it apart from the Lancer
// (a delta-shaped hover tank). `npm run dev`, then /tools/raptor-alts.html
//   ?view=lineup               every design in flight beside a Lancer and a Wasp, labelled
//   ?view=battle&d=<id>        three Lancers on the ground with three of design <id> overhead
//   ?view=close&d=<id>         one design up close, blue and red, ?face=rad ?pitch=deg ?zoom=
//   ?view=air                  the whole airpad roster, one row per candidate, beside a Lancer
// Screenshots: progress-shots/raptor-alts/.
import * as THREE from "three";
import { Stage } from "../src/game/three/stage";
import { ModelBuilder, type Vec3 } from "../src/game/three/builder";
import { instance, unitDef, unitScale, TEAMS, GM, GM_D, GM_L, AMBER, WHITE, type ModelDef } from "../src/game/three/models";
import type { UnitKind } from "../src/sim/types";

type Team = (typeof TEAMS)["blue"];
const EXHAUST = 0xffa040;
const GLASS = 0xcf7f2a;
const partB = () => new ModelBuilder({ grade: 0.26 });
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

/** Mirror a 2D outline (points with x ≥ 0) to the left side. */
const mirror = (pts: [number, number][]): [number, number][] => pts.map(([x, z]) => [-x, z] as [number, number]).reverse();

type Design = { id: string; name: string; blurb: string; make: (t: Team) => ModelDef };

const DESIGNS: Design[] = [
  {
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
const plate = new THREE.Mesh(new THREE.PlaneGeometry(60, 40), new THREE.MeshLambertMaterial({ color: 0x5b6b3a }));
plate.rotation.x = -Math.PI / 2;
plate.receiveShadow = true;
stage.scene.add(plate);

const AIR_H = 1.35;
const HOVER_H = 0.12;
/** Every Raptor at the current Raptor's size on the map (longest side 1.15 tiles, the 1.12 bump). */
const RAPTOR_SIZE = 1.15 * 1.12;
const defs = new Map<string, ModelDef>();
function designDef(id: string, f: "blue" | "red"): ModelDef {
  const key = `${id}/${f}`;
  let d = defs.get(key);
  if (!d) {
    d = DESIGNS.find((x) => x.id === id)!.make(TEAMS[f]);
    defs.set(key, d);
  }
  return d;
}
function designScale(id: string): number {
  const box = designDef(id, "blue").hull.boundingBox!;
  return RAPTOR_SIZE / Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
}

const labels: { el: HTMLDivElement; at: THREE.Vector3 }[] = [];
function label(text: string, sub: string, at: THREE.Vector3): void {
  const el = document.createElement("div");
  el.className = "lbl";
  el.innerHTML = `<b>${text}</b>${sub ? `<span>${sub}</span>` : ""}`;
  document.body.appendChild(el);
  labels.push({ el, at });
}

/** Place a unit: `id` is a UnitKind or a design id ("current" = today's Raptor). */
function place(id: string, f: "blue" | "red", x: number, z: number, face: number, bank = 0): THREE.Group {
  const isDesign = DESIGNS.some((d) => d.id === id);
  const kind = (id === "current" ? "raptor" : id) as UnitKind;
  const inst = instance(isDesign ? designDef(id, f) : unitDef(kind, f));
  inst.root.scale.setScalar(isDesign ? designScale(id) : unitScale(kind));
  const air = isDesign || ["raptor", "wasp", "scout", "hornet", "mender", "condor"].includes(kind);
  inst.root.position.set(x, air ? AIR_H : kind === "lancer" ? HOVER_H : 0, z);
  inst.body.rotation.set(air ? -0.08 : 0, -face, bank);
  if (inst.turret) inst.turret.rotation.y = 0.35;
  stage.scene.add(inst.root);
  return inst.root;
}

let center: [number, number] = [0, 0];
const factions = (q.get("faction") ?? "blue").split(",") as ("blue" | "red")[];
if (view === "lineup") {
  // two rows: today's pair, then each alternative; aircraft fly at AIR_H so they sit "north" of their shadow
  const ids = ["lancer", "current", "wasp", ...DESIGNS.map((d) => d.id)];
  const names: Record<string, [string, string]> = {
    lancer: ["Lancer", "hover laser tank (ground)"],
    current: ["Raptor — today", "delta interceptor"],
    wasp: ["Wasp", "strike drone (air)"]
  };
  for (const d of DESIGNS) names[d.id] = [d.name, ""];
  const face = Number(q.get("face") ?? 0.35);
  factions.forEach((f, fi) => {
    ids.forEach((id, i) => {
      const col = i < 3 ? i : i - 3;
      const row = i < 3 ? 0 : 1;
      const x = i < 3 ? col * 2.4 + 2.4 : col * 2.4;
      const z = row * 3.2 + fi * 6.6;
      const root = place(id, f, x, z, face);
      if (fi === 0) label(names[id]![0], names[id]![1], new THREE.Vector3(x, root.position.y, z + 0.8));
    });
  });
  center = [4.8, 1.6 + (factions.length - 1) * 3.1];
} else if (view === "battle") {
  const id = q.get("d") ?? "current";
  // a skirmish: blue Lancers advancing up the field, red Raptors (or the alternative) coming in over them, and vice versa
  const spots: [number, number, number][] = [[-1.1, 0.9, 0.2], [0.3, 1.5, -0.1], [1.3, 0.4, 0.4]];
  const air: [number, number, number][] = [[-0.6, -0.4, 2.9], [0.8, 0.1, 3.3], [1.9, -1.1, 3.0]];
  const f0 = factions[0]!;
  const f1 = (factions[1] ?? (f0 === "blue" ? "red" : "blue")) as "blue" | "red";
  for (const [x, z, a] of spots) place("lancer", f0, x, z, a);
  for (const [x, z, a] of air) place(id, f1, x, z, a, 0.2);
  // and a mixed second group: the other side's Lancers with their own aircraft
  for (const [x, z, a] of spots) place("lancer", f1, x + 4.6, z - 0.6, a + 2.9);
  for (const [x, z, a] of air) place(id, f0, x + 4.6, z - 0.1, a - 3.0, -0.2);
  center = [2.3, 0.6];
} else if (view === "air") {
  // the whole airpad roster, one row per Raptor candidate, beside a Lancer
  const rows = ["current", ...DESIGNS.map((d) => d.id)];
  const f = factions[0]!;
  rows.forEach((id, r) => {
    const z = r * 2.1;
    ["lancer", "scout", "wasp", id, "hornet", "mender", "condor"].forEach((k, i) => place(k, f, i * 1.75, z, 0.3));
    const d = DESIGNS.find((x) => x.id === id);
    label(d ? d.name : "Raptor — today", "", new THREE.Vector3(-2.1, AIR_H, z + 0.1));
  });
  ["Lancer", "Scout", "Wasp", "Raptor", "Hornet", "Mender", "Condor"].forEach((n, i) =>
    label(n, "", new THREE.Vector3(i * 1.75, i ? AIR_H : 0, i ? -1.15 : -0.85))
  );
  center = [4.4, 4.0];
} else if (view === "close") {
  const id = q.get("d") ?? "current";
  const face = Number(q.get("face") ?? 0.6);
  factions.forEach((f, fi) => place(id, f, fi * 1.9, 0, face));
  center = [(factions.length - 1) * 0.95, NaN];
  plate.material.color.set(q.get("ground") ?? "#5b6b3a");
}

stage.rig.bounds = { x0: -100, y0: -100, x1: 100, y1: 100 };
const pitch = q.get("pitch");
if (pitch !== null) stage.rig.pitchFor = () => THREE.MathUtils.degToRad(Number(pitch));
stage.rig.zoom = Number(q.get("zoom") ?? (view === "close" ? 150 : view === "battle" ? 60 : 46));
// (close-ups look at the aircraft, not the ground under it)
if (Number.isNaN(center[1])) center[1] = -AIR_H / Math.tan(stage.rig.pitchFor(stage.rig.zoom));
stage.rig.centerOn(Number(q.get("x") ?? center[0]), Number(q.get("y") ?? center[1]));

const v = new THREE.Vector3();
const loop = () => {
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
