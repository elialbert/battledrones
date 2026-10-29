// reach.ts [maps…]: ground reachability from blue's HQ: other HQs reachable? scrap/crystal tiles unreachable? path length HQ→HQ
import { createMapWorld, MAPS } from "../../src/sim/maps";
import { TERRAIN } from "../../src/sim/balance";
const ids = process.argv.slice(2).length ? process.argv.slice(2) : MAPS.map((m) => m.id);
for (const id of ids) {
  const w = createMapWorld(id);
  const W = w.width, H = w.height;
  const hqs = [...w.buildings.values()].filter((b: any) => b.kind === "hq");
  const blue = hqs.find((b: any) => b.faction === "blue")!;
  const dist = new Int32Array(W * H).fill(-1);
  const q: number[] = [];
  const start = (blue.ty + 1) * W + blue.tx + 3; // the tile east of the HQ's middle
  dist[start] = 0; q.push(start);
  while (q.length) {
    const i = q.shift()!; const x = i % W, y = (i / W) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx; if (dist[j] >= 0 || !TERRAIN[w.terrain[j] as 0].ground) continue;
      if (w.occupancy[j] && !hqs.some((h: any) => h.id === w.occupancy[j])) continue;
      dist[j] = dist[i] + 1; q.push(j);
    }
  }
  let lost = 0; for (let i = 0; i < W * H; i++) if ((w.terrain[i] === 2 || w.terrain[i] === 7) && dist[i] < 0) lost++;
  const others = hqs.filter((h: any) => h !== blue).map((h: any) => { let best = -1; for (let y = h.ty - 1; y <= h.ty + 3; y++) for (let x = h.tx - 1; x <= h.tx + 3; x++) { const d = dist[y * W + x]; if (d >= 0 && (best < 0 || d < best)) best = d; } return `${h.faction}:${best}`; });
  console.log(id.padEnd(16), "to", others.join(" "), "unreachable resource tiles", lost);
}
