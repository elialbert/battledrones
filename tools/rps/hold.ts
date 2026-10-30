// usage: hold.ts [policy ...]   (TECH-TIER.md "the defence that barely holds")
// A scripted base defence on each map's real blue base: TURRETS Turrets and STINGERS Stingers at the
// entrance facing red, the three Lab prerequisites (FABS Fab Plants), a Tech Lab LAB of the way built,
// and ATTACK red Stingers attack-moving in from WARN seconds out. Blue sees them coming and reacts by policy:
//   hold     keep the Lab going; every Fab Plant pumps Stingers (the only reaction Marshal has today)
//   cancel   cancel the Lab (refunded), build one more Turret, then start the Lab over; Stingers as hold
//   parallel as hold, plus one more Turret that doesn't share the build slot (a design alternative)
// Scrap: SCRAP at the start plus INCOME a second (the 70–95/s measured at Rush's 1:35–2:10 hit, rush.ts HIT=1).
// Prints one line per run (map × JIT spawn jitters) and a summary per policy: hold rate, the defence's value
// left (the margin: low but held is the goal), red left, when the Lab stands.
// Env: BAL (balance patch, as rush.ts), MAPS, TURRETS 4, STINGERS 5, ATTACK 15, LAB 0.25, WARN 15,
//   SCRAP 150, INCOME 80, FABS 2, JIT 3, Q=1 (summary only).
import * as BAL from "../../src/sim/balance";
import { BUILDINGS, TERRAIN, TICK_RATE, UNITS } from "../../src/sim/balance";
import { canPlaceBuilding } from "../../src/sim/economy";
import { baseEntrances } from "../../src/sim/ai/choke";
import { createMapWorld } from "../../src/sim/maps";
import { step } from "../../src/sim/sim";
import type { BuildingKind, Command, World } from "../../src/sim/types";
import { buildingCenter, hqOf, spawnBuilding, spawnUnit } from "../../src/sim/world";

for (const [k, v] of Object.entries(JSON.parse(process.env.BAL || "{}"))) {
  const path = k.split("."); let o: any = BAL; for (const p of path.slice(0, -1)) o = o[p]; o[path.at(-1)!] = v;
}
const E = (k: string, d: number) => (process.env[k] !== undefined ? +process.env[k]! : d);
const K = {
  turrets: E("TURRETS", 4), stingers: E("STINGERS", 5), attack: E("ATTACK", 15), lab: E("LAB", 0.25), warn: E("WARN", 15),
  scrap: E("SCRAP", 150), income: E("INCOME", 80), fabs: E("FABS", 2), jit: E("JIT", 3)
};
const MAPS = (process.env.MAPS || "riverlands frostbite dune-sea ashlands proving-grounds").split(/\s+/).filter(Boolean);
const POLICIES = process.argv.slice(2).length ? process.argv.slice(2) : ["hold", "cancel", "parallel"];
const LIMIT = 180 * TICK_RATE;

/** The placeable top-left nearest (x, y) for `kind`, or null. */
function spotNear(w: World, kind: BuildingKind, x: number, y: number, taken = new Set<string>()): { tx: number; ty: number } | null {
  const s = BUILDINGS[kind].size;
  let best: { tx: number; ty: number; d: number } | null = null;
  for (let ty = 0; ty < w.height; ty++) for (let tx = 0; tx < w.width; tx++) {
    const d = Math.hypot(tx + s / 2 - x, ty + s / 2 - y);
    if (d > 8 || (best && d >= best.d) || taken.has(`${tx},${ty}`) || !canPlaceBuilding(w, "blue", kind, tx, ty)) continue;
    best = { tx, ty, d };
  }
  return best;
}
/** The ground tile nearest (x, y). */
function groundNear(w: World, x: number, y: number): { x: number; y: number } {
  let best = { x, y, d: Infinity };
  for (let ty = 0; ty < w.height; ty++) for (let tx = 0; tx < w.width; tx++) {
    const d = Math.hypot(tx + 0.5 - x, ty + 0.5 - y);
    if (d < best.d && TERRAIN[w.terrain[ty * w.width + tx] as 0].ground) best = { x: tx + 0.5, y: ty + 0.5, d };
  }
  return best;
}

interface Run { held: boolean; end: number; defLeft: number; redLeft: number; turrets: number; stingers: number; labAt: number | null }

function run(map: string, jit: number, policy: string): Run {
  const w = createMapWorld(map, { seed: 1 });
  for (const u of [...w.units.values()]) w.units.delete(u.id);
  const hq = buildingCenter(hqOf(w, "blue")!);
  const foe = buildingCenter(hqOf(w, "red")!);
  // the front: the entrance facing red (choke maps), else the way to red's HQ, 5 tiles out
  const gate = baseEntrances(w, "blue")[0]?.hold;
  const ang = gate ? Math.atan2(gate.y - hq.y, gate.x - hq.x) : Math.atan2(foe.y - hq.y, foe.x - hq.x);
  const at = (r: number, da = 0) => ({ x: hq.x + Math.cos(ang + da) * r, y: hq.y + Math.sin(ang + da) * r });
  const put = (kind: BuildingKind, p: { x: number; y: number }) => {
    const s = spotNear(w, kind, p.x, p.y);
    if (!s) throw new Error(`${map}: no room for ${kind}`);
    return spawnBuilding(w, kind, "blue", s.tx, s.ty);
  };
  // the base behind the HQ, the Turrets in an arc in front
  const fabs = [...Array(K.fabs)].map((_, i) => put("fab-plant", at(5, Math.PI + (i - (K.fabs - 1) / 2) * 0.9)));
  put("airpad", at(5, Math.PI / 2));
  put("assembly-bay", at(5, -Math.PI / 2));
  const arc = (i: number, n: number) => at(5, (i - (n - 1) / 2) * 0.35);
  for (let i = 0; i < K.turrets; i++) put("turret", arc(i, K.turrets + 1));
  const front = at(3.5);
  for (let i = 0; i < K.stingers; i++) spawnUnit(w, "stinger", "blue", front.x + (i % 3) * 0.7 - 0.7, front.y + Math.floor(i / 3) * 0.7);
  const bf = w.factions.blue;
  bf.scrap = K.scrap;
  bf.pending = { kind: "tech-lab", remaining: (1 - K.lab) * BUILDINGS["tech-lab"].buildTime * TICK_RATE, ready: false };
  // red: WARN seconds of Stinger travel out past the Turrets, jittered sideways
  const out = 5 + K.warn * UNITS.stinger.speed;
  const o = groundNear(w, ...Object.values(at(out, (jit - (K.jit - 1) / 2) * 0.12)) as [number, number]);
  const red: number[] = [];
  for (let i = 0; i < K.attack; i++) red.push(spawnUnit(w, "stinger", "red", o.x + (i % 4) * 0.6 - 0.9, o.y + Math.floor(i / 4) * 0.6 - 0.9).id);
  w.factions.red.scrap = 0;
  const value = (f: "blue" | "red") => {
    let v = 0;
    for (const u of w.units.values()) if (u.faction === f) v += (u.hp / UNITS[u.kind].hp) * UNITS[u.kind].cost;
    for (const b of w.buildings.values()) if (b.faction === f && b.kind === "turret") v += (b.hp / BUILDINGS.turret.hp) * BUILDINGS.turret.cost;
    return v;
  };
  const defStart = value("blue");
  let spent = 0; // on new Stingers and Turrets during the fight
  let cmds: Command[] = [
    { type: "attackMove", faction: "red", unitIds: red, x: hq.x, y: hq.y },
    ...fabs.map((b): Command => ({ type: "rally", faction: "blue", buildingId: b.id, x: front.x, y: front.y }))
  ];
  let stage = policy === "cancel" ? "turret" : "lab"; // the build slot: turret → lab (cancel) | lab
  if (policy === "cancel") { bf.scrap += BUILDINGS["tech-lab"].cost; bf.pending = null; }
  const extraTurretAt = policy === "parallel" ? BUILDINGS.turret.buildTime * TICK_RATE : -1;
  if (policy === "parallel") { bf.scrap -= BUILDINGS.turret.cost; spent += BUILDINGS.turret.cost; }
  let labAt: number | null = null;
  let heldAt = -1;
  let redN = K.attack, redLostAt = 0; // (a lone red straggler that's stopped dying: stuck, the attack is over)
  for (let t = 0; t < LIMIT; t++) {
    bf.scrap += K.income / TICK_RATE;
    // the build slot
    if (!bf.pending) {
      if (stage === "turret" && bf.scrap >= BUILDINGS.turret.cost) { cmds.push({ type: "startBuilding", faction: "blue", building: "turret" }); spent += BUILDINGS.turret.cost; stage = "turret-wait"; }
      else if (stage === "lab" && labAt === null && bf.scrap >= BUILDINGS["tech-lab"].cost) cmds.push({ type: "startBuilding", faction: "blue", building: "tech-lab" });
    } else if (bf.pending.ready) {
      const s = bf.pending.kind === "turret" ? spotNear(w, "turret", ...Object.values(arc(K.turrets, K.turrets + 1)) as [number, number]) : spotNear(w, "tech-lab", ...Object.values(at(5, Math.PI * 0.75)) as [number, number]);
      if (s) cmds.push({ type: "placeBuilding", faction: "blue", tx: s.tx, ty: s.ty });
      if (bf.pending.kind === "turret") stage = "lab";
    }
    if (t === extraTurretAt) put("turret", arc(K.turrets, K.turrets + 1));
    // Stingers while red is alive (scrap after the build slot's needs)
    const redAlive = heldAt < 0 && [...w.units.values()].some((u) => u.faction === "red");
    const reserve = stage === "turret" ? BUILDINGS.turret.cost : 0;
    if (redAlive && t % 5 === 0) for (const b of fabs) if (w.buildings.has(b.id) && b.queue.length === 0 && bf.scrap - reserve >= UNITS.stinger.cost) {
      cmds.push({ type: "produce", faction: "blue", buildingId: b.id, unit: "stinger" }); spent += UNITS.stinger.cost;
    }
    step(w, cmds);
    cmds = [];
    if (!labAt && [...w.buildings.values()].some((b) => b.faction === "blue" && b.kind === "tech-lab")) labAt = w.tick;
    const blueArmed = [...w.buildings.values()].some((b) => b.faction === "blue" && b.kind === "turret") || [...w.units.values()].some((u) => u.faction === "blue");
    const n = [...w.units.values()].filter((u) => u.faction === "red").length;
    if (n < redN) (redN = n), (redLostAt = w.tick);
    if ((!redAlive || (n <= 1 && w.tick - redLostAt > 20 * TICK_RATE)) && heldAt < 0) heldAt = redLostAt;
    if (!hqOf(w, "blue") || (!blueArmed && redAlive)) break;
    if (heldAt >= 0 && labAt) break;
  }
  const turrets = [...w.buildings.values()].filter((b) => b.faction === "blue" && b.kind === "turret").length;
  const stingers = [...w.units.values()].filter((u) => u.faction === "blue").length;
  return {
    held: heldAt >= 0, end: heldAt >= 0 ? heldAt : w.tick, defLeft: value("blue") / (defStart + spent),
    redLeft: value("red") / (K.attack * UNITS.stinger.cost), turrets, stingers, labAt
  };
}

const clock = (t: number | null) => (t === null ? "-" : `${Math.floor(t / TICK_RATE / 60)}:${String(Math.floor(t / TICK_RATE) % 60).padStart(2, "0")}`);
const pct = (x: number) => `${Math.round(100 * x)}%`;
console.log(`hold.ts ${JSON.stringify(K)} BAL=${process.env.BAL || "{}"}`);
for (const policy of POLICIES) {
  const rs: Run[] = [];
  for (const map of MAPS) for (let j = 0; j < K.jit; j++) {
    const r = run(map, j, policy);
    rs.push(r);
    if (!process.env.Q) console.log(`  ${policy.padEnd(8)} ${map.padEnd(16)} j${j} ${r.held ? "HELD " : "BROKE"} at ${clock(r.end)} def left ${pct(r.defLeft).padStart(4)} (T${r.turrets} S${r.stingers}) red left ${pct(r.redLeft).padStart(4)} lab ${clock(r.labAt)}`);
  }
  const held = rs.filter((r) => r.held);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const labs = held.map((r) => r.labAt).filter((x): x is number => x !== null);
  console.log(`${policy.padEnd(8)} held ${held.length}/${rs.length}  def left when held ${pct(mean(held.map((r) => r.defLeft)))}  red left when broken ${pct(mean(rs.filter((r) => !r.held).map((r) => r.redLeft)))}  lab stands ${labs.length ? clock(mean(labs)) : "-"} (held runs)`);
}
