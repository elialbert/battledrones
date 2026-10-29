// chain.ts [maps] : for each field on blue's side outside the HQ's zone, the fewest turrets chained out from the
// base (each extends the zone by ECONOMY.extendRadius) before a Depot can stand within 4 tiles of the field.
// EXTEND=3 overrides the radius. Turret: BUILDINGS.turret (cost, buildTime), built one at a time.
import { BUILDINGS, ECONOMY } from "../../src/sim/balance";
import { createMapWorld, MAPS } from "../../src/sim/maps";
import { foundBlocker } from "../../src/sim/economy";
import { Terrain } from "../../src/sim/types";
import { hqOf } from "../../src/sim/world";
if (process.env.EXTEND) (ECONOMY as any).extendRadius = +process.env.EXTEND;
const ids = process.argv[2] ? process.argv[2].split(",") : MAPS.map((m) => m.id);
const T = BUILDINGS.turret;
for (const id of ids) {
  const w = createMapWorld(id);
  const W = w.width;
  const hq = hqOf(w, "blue")!;
  const hc = { x: hq.tx + 1.5, y: hq.ty + 1.5 };
  const rq = hqOf(w, "red")!;
  const ok = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < w.height && foundBlocker(w, "blue", x, y) === null;
  // distance from the HQ footprint's edge (as distToBuilding)
  const fromHq = (x: number, y: number) => Math.hypot(Math.max(hq.tx - x, 0, x - (hq.tx + 3)), Math.max(hq.ty - y, 0, y - (hq.ty + 3)));
  // BFS: turrets[t] = turrets needed to have one standing on tile t
  const R = ECONOMY.extendRadius + 0.5; // centre to an adjacent 1-tile footprint
  const turrets = new Int32Array(W * w.height).fill(-1);
  let frontier: number[] = [];
  for (let y = 0; y < w.height; y++) for (let x = 0; x < W; x++) if (ok(x, y) && fromHq(x + 0.5, y + 0.5) <= ECONOMY.buildRadius) { turrets[y * W + x] = 1; frontier.push(y * W + x); }
  for (let k = 1; frontier.length && k < 30; k++) {
    const next: number[] = [];
    for (const t of frontier) {
      const tx = t % W, ty = Math.floor(t / W), r = Math.ceil(R);
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const x = tx + dx, y = ty + dy;
        if (Math.hypot(dx, dy) > R || !ok(x, y) || turrets[y * W + x] !== -1) continue;
        turrets[y * W + x] = k + 1; next.push(y * W + x);
      }
    }
    frontier = next;
  }
  // fields: clusters of scrap/crystal on blue's side
  const tiles: [number, number][] = [];
  for (let i = 0; i < W * w.height; i++) if (w.terrain[i] === Terrain.Scrap || w.terrain[i] === Terrain.Crystal) tiles.push([i % W, Math.floor(i / W)]);
  const fields: { x: number; y: number; n: number }[] = [];
  for (const [x, y] of tiles) { const f = fields.find((f) => Math.hypot(f.x / f.n - x, f.y / f.n - y) < 5); if (f) { f.x += x; f.y += y; f.n++; } else fields.push({ x, y, n: 1 }); }
  const out: string[] = [];
  for (const f of fields) {
    const fx = f.x / f.n, fy = f.y / f.n;
    if (Math.hypot(fx - hc.x, fy - hc.y) > Math.hypot(fx - rq.tx - 1.5, fy - rq.ty - 1.5)) continue; // theirs
    // a depot (2x2) within 4 tiles of the field, the fewest turrets with one in reach of it (0: the HQ's zone)
    let best = Infinity;
    for (let y = Math.floor(fy - 6); y <= fy + 6; y++) for (let x = Math.floor(fx - 6); x <= fx + 6; x++) {
      if (Math.hypot(x + 1 - fx, y + 1 - fy) > 4.5 || !ok(x, y)) continue;
      if (fromHq(x + 1, y + 1) <= ECONOMY.buildRadius) { best = 0; continue; }
      for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) {
        const k = turrets[(y + dy) * W + x + dx];
        if (k === undefined || k < 1 || y + dy < 0 || x + dx < 0 || x + dx >= W) continue;
        // turret footprint to the depot's centre
        const d = Math.hypot(Math.max(x + dx - (x + 1), 0, x + 1 - (x + dx + 1)), Math.max(y + dy - (y + 1), 0, y + 1 - (y + dy + 1)));
        if (d <= ECONOMY.extendRadius) best = Math.min(best, k);
      }
    }
    const far = Math.hypot(fx - hc.x, fy - hc.y).toFixed(0);
    out.push(best === 0 ? `${far}t: in zone` : best === Infinity ? `${far}t: unreachable` : `${far}t: ${best} turrets (${best * T.cost} scrap, ${best * T.buildTime}s)`);
  }
  console.log(id.padEnd(16), out.join(" | "));
}
