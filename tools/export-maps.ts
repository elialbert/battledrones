// Export every skirmish map's terrain grid to art/maps/<id>.json for the
// offline terrain renderer (art/terrain.py), and print ASCII previews.
// Usage: npx vite-node tools/export-maps.ts [--ascii] [<map id>…]
// Map ids (built-in, or generated: random-<biome>-<code>) export just those maps; none exports every built-in one.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILDINGS } from "../src/sim/balance";
import { MAPS, createMapWorld, isKnownMapId, mapById } from "../src/sim/maps";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "../art/maps");
mkdirSync(OUT, { recursive: true });
const ascii = process.argv.includes("--ascii");
const ids = process.argv.slice(2).filter((a) => !a.startsWith("--"));
for (const id of ids)
  if (!isKnownMapId(id)) {
    console.error(`unknown map "${id}": ${MAPS.map((m) => m.id).join(", ")}, or random-<biome>-<code>`);
    process.exit(1);
  }
// terrain enum -> char: Ground . Rock # Scrap $ Water ~ Road = Rough : Forest T Crystal * Bridge H Shallows , Deep (space) Wasteland -
const CH = ".#$~=:T*H, -";

for (const def of ids.length ? ids.map(mapById) : MAPS) {
  const w = createMapWorld(def.id);
  const rows: string[] = [];
  for (let ty = 0; ty < w.height; ty++) {
    let row = "";
    // one base-36 digit per tile (codes 10+ are letters: Deep is "a"), read back with int(c, 36)
    for (let tx = 0; tx < w.width; tx++) row += w.terrain[ty * w.width + tx]!.toString(36);
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
