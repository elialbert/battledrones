// harvester income: N harvesters on a map, with or without a depot by the nearest field
import { createMapWorld } from "../../src/sim/maps";
import { step } from "../../src/sim/sim";
import { spawnUnit, buildingCenter, spawnBuilding, terrainAt, buildingAtTile } from "../../src/sim/world";
import { nearestScrapTile } from "../../src/sim/economy";
import { TICK_RATE, TERRAIN } from "../../src/sim/balance";
const [map, n, depot] = process.argv.slice(2);
const w: any = createMapWorld(map, { seed: 1 });
const hq0: any = [...w.buildings.values()].find((b: any) => b.kind === "hq" && b.faction === "blue"); const hq = buildingCenter(hq0);
for (let i = 1; i < +n; i++) spawnUnit(w, "harvester", "blue", hq.x + 4.5, hq.y + 1.5 + (i % 3));
const f = nearestScrapTile(w, hq.x, hq.y, "blue")!;
if (depot) { let sp: any = null, bd = 1e9;
  for (let ty = f.y - 6; ty <= f.y + 6; ty++) for (let tx = f.x - 6; tx <= f.x + 6; tx++) {
    let ok = true;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) { const t = terrainAt(w, tx + dx, ty + dy); if (!TERRAIN[t]?.buildable || buildingAtTile(w, tx + dx, ty + dy)) ok = false; }
    const d = Math.hypot(tx + 1 - f.x, ty + 1 - f.y); if (ok && d < bd) { bd = d; sp = { tx, ty }; } } spawnBuilding(w, "depot", "blue", sp.tx, sp.ty); }
const ids = [...w.units.values()].filter((u: any) => u.faction === "blue" && u.kind === "harvester").map((u: any) => u.id);
step(w, [{ type: "harvest", faction: "blue", unitIds: ids, x: f.x + 0.5, y: f.y + 0.5 } as any]);
console.log("field dist", Math.hypot(f.x - hq.x, f.y - hq.y).toFixed(1));
// warm up 30 s, then measure 60 s
for (let t = 0; t < 30 * TICK_RATE; t++) step(w, []);
const s0 = w.factions.blue.stats.scrapHarvested;
for (let t = 0; t < 60 * TICK_RATE; t++) step(w, []);
const per = (w.factions.blue.stats.scrapHarvested - s0) / +n;
console.log(map, depot ? "DEPOT" : "", "n=" + n, "per harvester/min", per.toFixed(0), "payback s", (150 / per * 60).toFixed(0));
