// Export every skirmish map's terrain grid to art/maps/<id>.json for the
// offline terrain renderer (art/terrain.py), and print ASCII previews.
// Usage: npx vite-node tools/export-maps.ts [--ascii]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILDINGS } from "../src/sim/balance";
import { MAPS, createMapWorld } from "../src/sim/maps";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "../art/maps");
mkdirSync(OUT, { recursive: true });
const ascii = process.argv.includes("--ascii");
// terrain enum -> char: Ground . Rock # Scrap $ Water ~ Road = Rough : Forest T Crystal * Bridge H Shallows ,
const CH = ".#$~=:T*H,";

for (const def of MAPS) {
  const w = createMapWorld(def.id);
  const rows: string[] = [];
  for (let ty = 0; ty < w.height; ty++) {
    let row = "";
    for (let tx = 0; tx < w.width; tx++) row += String(w.terrain[ty * w.width + tx]);
    rows.push(row);
  }
  const hqs = [...w.buildings.values()].map((b) => ({ faction: b.faction, tx: b.tx, ty: b.ty, size: BUILDINGS[b.kind].size }));
  writeFileSync(
    join(OUT, `${def.id}.json`),
    JSON.stringify({ id: def.id, name: def.name, biome: def.biome, width: w.width, height: w.height, seed: def.seed, hqs, terrain: rows }, null, 1)
  );
  console.log(`${def.id}: ${w.width}x${w.height} ${def.biome}`);
  if (ascii) {
    for (let ty = 0; ty < w.height; ty++) {
      let row = "";
      for (let tx = 0; tx < w.width; tx++) {
        const b = w.occupancy[ty * w.width + tx];
        row += b ? (w.buildings.get(b)!.faction === "blue" ? "B" : "R") : CH[w.terrain[ty * w.width + tx]!];
      }
      console.log(row);
    }
  }
}
