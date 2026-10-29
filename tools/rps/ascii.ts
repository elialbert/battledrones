// ascii.ts <map> [x0 y0 x1 y1] : the map's tiles as text (HQs H/E), x labels every 5 (tens digit row + units digit row), y on the left
import { createMapWorld, mapById } from "../../src/sim/maps";
const [id, ...r] = process.argv.slice(2);
const w = createMapWorld(id!);
const [x0, y0, x1, y1] = r.length ? r.map(Number) : [0, 0, w.width - 1, w.height - 1];
const CH = ".#$~=r^*BsDw"; // Ground Rock Scrap Water Road Rough Forest Crystal Bridge Shallows Deep Wasteland
console.log(id, w.width, "hq", mapById(id!).hq);
let h1 = "    ", h2 = "    ";
for (let x = x0; x <= x1; x++) { h1 += x % 5 === 0 ? String(Math.floor(x / 10)) : " "; h2 += x % 5 === 0 ? String(x % 10) : " "; }
console.log(h1); console.log(h2);
for (let y = y0; y <= y1; y++) {
  let row = String(y).padStart(3) + " ";
  for (let x = x0; x <= x1; x++) {
    const b = [...w.buildings.values()].find((b) => x >= b.tx && x < b.tx + 3 && y >= b.ty && y < b.ty + 3 && b.kind === "hq");
    row += b ? (b.faction === "blue" ? "H" : "E") : CH[w.terrain[y * w.width + x]!]!;
  }
  console.log(row);
}
