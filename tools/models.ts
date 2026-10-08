// Dev-only model gallery: every unit, building and objective model for both
// factions on a ground plate, lit like the game. `npm run dev`, then open
// /tools/models.html (?faction=red, ?zoom=80, ?only=units|buildings).
import * as THREE from "three";
import { Stage } from "../src/game/three/stage";
import { buildingDef, crateDef, instance, podDef, uplinkDef, unitDef, chuteGeometry, modelMesh, rubbleGeometry } from "../src/game/three/models";
import { setVariant } from "../src/game/three/materials";
import { UNIT_KINDS, BUILDING_KINDS } from "../src/game/assets";

const q = new URLSearchParams(location.search);
const stage = new Stage(document.getElementById("game")!, Math.min(2, devicePixelRatio));
stage.setBiome((q.get("biome") as "temperate") ?? "temperate");
const plate = new THREE.Mesh(new THREE.PlaneGeometry(40, 30), new THREE.MeshLambertMaterial({ color: 0x5b6b3a }));
plate.rotation.x = -Math.PI / 2;
plate.position.set(9, 0, 4);
plate.receiveShadow = true;
stage.scene.add(plate);

const facs = (q.get("faction") ?? "blue,red").split(",") as ("blue" | "red")[];
const only = q.get("only");
facs.forEach((f, fi) => {
  if (only !== "buildings")
    UNIT_KINDS.forEach((k, i) => {
      const inst = instance(unitDef(k, f));
      const air = ["scout", "wasp", "raptor", "hornet", "mender"].includes(k);
      inst.root.position.set(i * 1.6, air ? 0.9 : 0, fi * 1.8 - 1);
      inst.body.rotation.y = -0.5;
      if (inst.turret) inst.turret.rotation.y = 0.6;
      if (inst.cargo) inst.cargo.visible = true;
      stage.scene.add(inst.root);
    });
  if (only !== "units")
    BUILDING_KINDS.forEach((k, i) => {
      const inst = instance(buildingDef(k, f));
      inst.root.position.set(i * 3 - 1, 0, 4 + fi * 3.4);
      if (inst.turret) inst.turret.rotation.y = 0.5;
      stage.scene.add(inst.root);
    });
});
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
const wreck = instance(unitDef("titan", "blue"));
setVariant(wreck.root, "burnt");
wreck.root.position.set(-6.5, 0, -1);
stage.scene.add(wreck.root);

stage.rig.bounds = { x0: -100, y0: -100, x1: 100, y1: 100 };
stage.rig.zoom = Number(q.get("zoom") ?? 46);
stage.rig.centerOn(Number(q.get("x") ?? 7), Number(q.get("y") ?? 4));
const loop = () => {
  stage.render();
  requestAnimationFrame(loop);
};
loop();
addEventListener("resize", () => stage.resize());
(window as unknown as { ready: boolean }).ready = true;
