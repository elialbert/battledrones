// Dev-only model gallery: every unit, building and objective model for both
// factions on a ground plate, lit like the game. `npm run dev`, then open
// /tools/models.html (?faction=red, ?zoom=80, ?x=7&y=4 to centre, ?only=units|buildings).
//
// Robot infantry has its own yard north of the vehicles (centre ?x=4&y=-3.8): each
// squad animated as on the map — ?anim=walk (default: marching east, cadence from
// its speed), idle, aim, fall (robots drop one by one, then stand back up),
// still (?face=rad turns them: 0 north, 3.14 toward the camera). A loaded Condor hovers beside them with its ramp down. ?t=ms freezes
// the animation at that time (for screenshots); window.gallery.at(ms) moves it.
//
// ?only=condor lines up the dropship per faction: loaded and hovering low with its ramp down, loaded in
// flight, empty — then a Mastodon, a Trooper Squad and a Hornet for scale (?cface=rad turns the Condors).
// ?only=condor-ring shows it loaded at six headings, its ramp up and down by turns.
// ?pitch=deg overrides the camera's pitch (8 for a side view).
import * as THREE from "three";
import { Stage } from "../src/game/three/stage";
import { buildingDef, crateDef, instance, podDef, uplinkDef, unitDef, unitScale, chuteGeometry, modelMesh, rubbleGeometry } from "../src/game/three/models";
import { baySeats, SquadRig, type BotKind } from "../src/game/three/infantry";
import { setVariant } from "../src/game/three/materials";
import { UNIT_KINDS, BUILDING_KINDS } from "../src/game/assets";
import { UNITS } from "../src/sim/balance";

const q = new URLSearchParams(location.search);
const stage = new Stage(document.getElementById("game")!, Math.min(2, devicePixelRatio));
stage.setBiome((q.get("biome") as "temperate") ?? "temperate");
const plate = new THREE.Mesh(new THREE.PlaneGeometry(40, 34), new THREE.MeshLambertMaterial({ color: 0x5b6b3a }));
plate.rotation.x = -Math.PI / 2;
plate.position.set(9, 0, 2);
plate.receiveShadow = true;
stage.scene.add(plate);

const facs = (q.get("faction") ?? "blue,red").split(",") as ("blue" | "red")[];
const only = q.get("only");
const anim = q.get("anim") ?? "walk";
const BOTS: BotKind[] = ["trooper", "rocket-squad", "sniper"];
const AIR: string[] = ["scout", "wasp", "raptor", "hornet", "mender", "condor"];
// units at their in-game size (unitScale), each row spaced to fit its biggest hulls
const box = new THREE.Box3();
const yard: { rig: SquadRig; kind: BotKind; x: number; z: number }[] = [];
const riders: { rig: SquadRig; ready: number }[] = [];
const cface = -Number(q.get("cface") ?? 0.35);

/** A Condor at (x, z), `y` up, riders aboard, its ramp `ramp` of the way open. */
function condor(f: "blue" | "red", x: number, y: number, z: number, load: BotKind[], ramp: number, face = cface): void {
  const c = instance(unitDef("condor", f));
  const s = unitScale("condor");
  c.root.scale.setScalar(s);
  c.root.position.set(x, y, z);
  c.body.rotation.y = face;
  c.ramp!.rotation.x = ramp * c.def.ramp!.open;
  const bay = new THREE.Group();
  bay.scale.setScalar(1 / s);
  c.body.add(bay);
  load.forEach((k, side) => {
    const r = new SquadRig(k, f, 30 + side + riders.length);
    r.seat(baySeats(k, side, s));
    bay.add(r.root);
    // (ramp down: on their feet, ready to drop)
    riders.push({ rig: r, ready: ramp });
  });
  stage.scene.add(c.root);
}

facs.forEach((f, fi) => {
  if (only === "condor-ring") {
    // every heading, loaded, ramp up and down by turns
    for (let i = 0; i < 6; i++) condor(f, i * 2.1, 1.35, fi * 2.4, i % 3 ? ["trooper", "rocket-squad"] : ["sniper", "trooper"], i % 2, (-i * Math.PI) / 3);
    return;
  }
  if (only === "condor") {
    const z = fi * 2.6;
    condor(f, 0, 0.62, z, fi ? ["sniper", "trooper"] : ["trooper", "rocket-squad"], 1);
    condor(f, 2.4, 1.35, z, fi ? ["rocket-squad", "trooper"] : ["trooper", "sniper"], 0);
    condor(f, 4.8, 1.35, z, [], 0);
    const ti = instance(unitDef("mastodon", f));
    ti.root.scale.setScalar(unitScale("mastodon"));
    ti.body.rotation.y = cface;
    ti.root.position.set(7.1, 0, z);
    stage.scene.add(ti.root);
    const sq = new SquadRig("trooper", f, 3 + fi);
    sq.root.position.set(9.1, 0, z);
    sq.root.rotation.y = cface;
    stage.scene.add(sq.root);
    yard.push({ rig: sq, kind: "trooper", x: 9.1, z });
    const h = instance(unitDef("hornet", f));
    h.root.scale.setScalar(unitScale("hornet"));
    h.body.rotation.y = cface;
    h.root.position.set(11.1, 1.35, z);
    stage.scene.add(h.root);
    return;
  }
  if (only !== "buildings") {
    let x = 0;
    UNIT_KINDS.forEach((k) => {
      if ((BOTS as string[]).includes(k)) return;
      const inst = instance(unitDef(k, f));
      inst.root.scale.setScalar(unitScale(k));
      inst.body.rotation.y = -0.5;
      if (inst.turret) inst.turret.rotation.y = 0.6;
      if (inst.cargo) inst.cargo.visible = true;
      const w = box.setFromObject(inst.root).max.x - box.min.x;
      inst.root.position.set(x + w / 2, AIR.includes(k) ? 0.9 : 0, fi * 2.2 - 1.4);
      x += w + 0.35;
      stage.scene.add(inst.root);
    });
    // the infantry yard: a lane per squad
    BOTS.forEach((k, ki) => {
      const rig = new SquadRig(k, f, fi * 7 + ki + 1);
      const at = { rig, kind: k, x: ki * 3.2, z: fi * 1.3 - 4.4 };
      rig.root.position.set(at.x + 1.2, 0, at.z);
      rig.root.rotation.y = -Number(q.get("face") ?? 0.5);
      stage.scene.add(rig.root);
      yard.push(at);
    });
    // a loaded Condor, ramp down, hovering low beside them
    condor(f, 10.6, 0.75, fi * 1.9 - 4.4, fi ? ["sniper", "trooper"] : ["trooper", "rocket-squad"], 1);
  }
  if (only !== "units" && !only?.startsWith("condor"))
    BUILDING_KINDS.forEach((k, i) => {
      const inst = instance(buildingDef(k, f));
      inst.root.position.set(i * 3 - 1, 0, 4 + fi * 3.4);
      if (inst.turret) inst.turret.rotation.y = 0.5;
      stage.scene.add(inst.root);
    });
});
if (!only?.startsWith("condor")) {
  const extras = [instance(uplinkDef()), instance(crateDef()), instance(podDef("blue")), instance(podDef("blue", true))];
  extras.forEach((e, i) => {
    e.root.position.set(-4, 0, -1 + i * 2.4);
    stage.scene.add(e.root);
  });
  const chute = modelMesh(chuteGeometry());
  chute.position.set(-6.5, 0.5, 2);
  stage.scene.add(chute);
  const rub = modelMesh(rubbleGeometry(2, 1));
  rub.position.set(-6.5, 0, 5.5);
  stage.scene.add(rub);
  const wreck = instance(unitDef("mastodon", "blue"));
  setVariant(wreck.root, "burnt");
  wreck.root.position.set(-6.5, 0, -1);
  stage.scene.add(wreck.root);
}

/** Advance every robot to animation time `t` (ms), in frame-sized steps from where it is. */
let now = 0;
function at(t: number): void {
  while (now < t) {
    const dt = Math.min(16, t - now);
    now += dt;
    for (const y of yard) {
      const n = UNITS[y.kind].squad ?? 1;
      const speed = anim === "walk" ? UNITS[y.kind].speed : 0;
      if (anim === "walk" && only !== "condor") {
        // march east along the lane, round and round
        y.rig.root.rotation.y = -Math.PI / 2;
        y.rig.root.position.x = y.x + ((now / 1000) * speed) % 2.6;
      }
      const cyc = (n + 2) * 1400;
      const alive = anim === "fall" ? Math.max(0, n - Math.floor((now % cyc) / 1400)) : n;
      y.rig.update({ dt, speed, aim: anim === "aim" ? 1 : 0, pitch: 0, alive });
    }
    for (const r of riders) r.rig.update({ dt, speed: 0, aim: 0, pitch: 0, alive: r.rig.spec.n, ready: r.ready });
  }
}
const freeze = q.get("t");
if (freeze !== null) at(Number(freeze));

stage.rig.bounds = { x0: -100, y0: -100, x1: 100, y1: 100 };
const pitch = q.get("pitch");
if (pitch !== null) stage.rig.pitchFor = () => THREE.MathUtils.degToRad(Number(pitch));
stage.rig.zoom = Number(q.get("zoom") ?? 46);
stage.rig.centerOn(Number(q.get("x") ?? 7), Number(q.get("y") ?? 4));
let last = performance.now();
const loop = () => {
  const t = performance.now();
  if (freeze === null && anim !== "still") at(now + Math.min(50, t - last));
  last = t;
  stage.render();
  requestAnimationFrame(loop);
};
loop();
addEventListener("resize", () => stage.resize());
(window as unknown as { ready: boolean; gallery: { at(ms: number): void } }).ready = true;
(window as unknown as { gallery: { at(ms: number): void } }).gallery = { at };
