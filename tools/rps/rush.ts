// usage: rush.ts <map> <seed> <diff> <side> <ourPlan> <foePlan> [q]
// ourPlan / foePlan: a Marshal plan name, or a variant key from VARIANTS below ("plan+variant").
import { Arena, parseSeat } from "../../src/arena/match";
import { TICK_RATE, UNITS } from "../../src/sim/balance";
import { hash32 } from "../../src/sim/rand";
import { buildingAtTile, setTerrain } from "../../src/sim/world";
import { MARSHAL, marshal } from "../../src/sim/ai/marshal";
import { capApm } from "../../src/sim/ai/apm";
import { VARIANTS } from "./variants";
import * as BAL from "../../src/sim/balance";
// BAL='{"UNITS.harvester.cost":200,"ECONOMY.depotMinFromHq":12}'
for (const [k, v] of Object.entries(JSON.parse(process.env.BAL || "{}"))) {
  const path = k.split("."); let o: any = BAL; for (const p of path.slice(0, -1)) o = o[p]; o[path.at(-1)!] = v;
}

const [map, seed, diff = "hard", side = "blue", ours = "rush", theirs = "greed", quiet] = process.argv.slice(2) as any[];
const foe = side === "blue" ? "red" : "blue";
const a: any = new Arena({ map, seed: +seed, seats: { blue: parseSeat(`bot:marshal:${diff}`), red: parseSeat(`bot:marshal:${diff}`) }, maxTicks: 20 * 60 * TICK_RATE });
const M = MARSHAL[diff as "hard"];
function seat(f: string, spec: string) {
  const [plan, v] = spec.split("+");
  const V = v ? VARIANTS[v] : {};
  if (v && !V) throw new Error("no variant " + v);
  const { fast, fight, ...tweak } = V as any;
  a.seats[f].bot = capApm(
    marshal(f as any, hash32(+seed, f === "blue" ? 1 : 2), diff, { ...M, ...(fast !== undefined ? { fast } : {}), ...(fight ? { fight: { ...M.fight, ...fight } } : {}), strategy: plan as any, tweak: { ...M.tweak, ...tweak } }),
    M.apm, M.burst);
}
seat(side, ours);
seat(foe, theirs);
// WALL="R,gap,n": a rock ring R tiles round each HQ with n gaps of `gap` tiles (toward the foe; ±45° if 2): chokepoints
if (process.env.WALL) {
  const [R, gap, n] = process.env.WALL.split(",").map(Number);
  const hqs: any[] = [...a.w.buildings.values()].filter((b: any) => b.kind === "hq");
  for (const hq of hqs) {
    const cx = hq.tx + 1.5, cy = hq.ty + 1.5;
    const other = hqs.find((o) => o !== hq)!;
    const toward = Math.atan2(other.ty - hq.ty, other.tx - hq.tx);
    const gaps = n === 1 ? [toward] : n === 2 ? [toward - Math.PI / 4, toward + Math.PI / 4] : [];
    for (let ty = 0; ty < a.w.height; ty++) for (let tx = 0; tx < a.w.width; tx++) {
      const d = Math.hypot(tx + 0.5 - cx, ty + 0.5 - cy);
      if (d < R || d >= R + 2.2) continue;
      const ang = Math.atan2(ty + 0.5 - cy, tx + 0.5 - cx);
      if (gaps.some((g) => Math.abs(Math.atan2(Math.sin(ang - g), Math.cos(ang - g))) * R < gap / 2)) continue;
      const t = a.w.terrain[ty * a.w.width + tx];
      if (![0, 4, 5, 6, 9, 11].includes(t) || buildingAtTile(a.w, tx, ty)) continue; // ground, road, rough, woods, wasteland
      setTerrain(a.w, tx, ty, 1);
    }
  }
  if (process.env.SHOW) for (let y = 0; y < a.w.height; y++) console.log([...Array(a.w.width)].map((_, x) => hqs.some((h) => x >= h.tx && x < h.tx + 3 && y >= h.ty && y < h.ty + 3) ? "H" : ".#$~=r^*BsDw"[a.w.terrain[y * a.w.width + x]]).join(""));
}
const clock = (t: number) => `${Math.floor(t / TICK_RATE / 60)}:${String(Math.floor(t / TICK_RATE) % 60).padStart(2, "0")}`;
const army = (f: string) => [...a.w.units.values()].filter((u: any) => u.faction === f && u.kind !== "harvester" && UNITS[u.kind as "stinger"].dps > 0).reduce((v: number, u: any) => v + UNITS[u.kind as "stinger"].cost, 0);
const count = (f: string, k: string) => [...a.w.buildings.values()].filter((b: any) => b.faction === f && b.kind === k).length;
const harv = (f: string) => [...a.w.units.values()].filter((u: any) => u.faction === f && u.kind === "harvester").length;
const snap: string[] = [];
const firsts: Record<string, string> = {};
let firstHit = "";
let hitSnap = "", at2 = "";
const mined: [number, number][] = []; // [tick, foe scrap harvested so far], the last 30 s
// when each side's depots go up (a new one standing, founded or built)
const depotAt: Record<string, string[]> = { blue: [], red: [] };
const depotSeen = new Set<number>();
const exps: Record<number, any> = {};
const lostKinds: Record<string, Record<string, number>> = { blue: {}, red: {} };
const seenU = new Map<number, any>();
// tier 2 (units the Tech Lab unlocks): when each side's Lab stands, its first tier-2 unit, tier-2 share of army value at 3/5 min
const T2 = new Set(Object.entries(UNITS).filter(([, u]: any) => u.requires === "tech-lab").map(([k]) => k));
const lab: Record<string, string> = {}, t2: Record<string, string> = {}, t2share: Record<string, string[]> = { blue: [], red: [] };
a.onRound = () => {
  const w = a.w;
  for (const b of w.buildings.values()) if (b.kind === "tech-lab" && !lab[b.faction]) lab[b.faction] = clock(w.tick);
  for (const u of w.units.values()) if (T2.has(u.kind) && !t2[u.faction]) t2[u.faction] = clock(w.tick);
  if (w.tick === 180 * TICK_RATE || w.tick === 300 * TICK_RATE) for (const f of [side, foe]) {
    const all = army(f), hi = [...w.units.values()].filter((u: any) => u.faction === f && T2.has(u.kind)).reduce((v: number, u: any) => v + UNITS[u.kind as "stinger"].cost, 0);
    t2share[f]!.push(all ? Math.round(100 * hi / all) + "%" : "-");
  }
  if (process.env.COMP) {
    const alive = new Set(w.units.keys());
    for (const [id, u] of seenU) if (!alive.has(id)) { lostKinds[u.faction][u.kind] = (lostKinds[u.faction][u.kind] ?? 0) + 1; seenU.delete(id); }
    for (const u of w.units.values()) seenU.set(u.id, { faction: u.faction, kind: u.kind });
    if (w.tick % (30 * TICK_RATE) === 0 && w.tick > 0 && w.tick <= 300 * TICK_RATE) {
      for (const f of [side, foe]) {
        const bs: Record<string, number> = {}; for (const b of w.buildings.values()) if (b.faction === f) bs[b.kind] = (bs[b.kind] ?? 0) + 1;
        const us: Record<string, number> = {}; for (const u of w.units.values()) if (u.faction === f) us[u.kind] = (us[u.kind] ?? 0) + 1;
        const hq: any = [...w.buildings.values()].find((b: any) => b.faction === f && b.kind === "hq");
        console.log(clock(w.tick), f === side ? "US " : "FOE", "hq" + Math.round(hq?.hp ?? 0), "scrap" + Math.round(w.factions[f].scrap), JSON.stringify(bs), JSON.stringify(us), "lost", JSON.stringify(lostKinds[f]));
      }
    }
  }
  if (process.env.TURRETS && w.tick % (30 * TICK_RATE) === 0 && w.tick > 0 && w.tick <= 240 * TICK_RATE) {
    const hq: any = [...w.buildings.values()].find((b: any) => b.faction === foe && b.kind === "hq");
    console.log(clock(w.tick), "foe turrets (dist from HQ):", [...w.buildings.values()].filter((b: any) => b.faction === foe && (b.kind === "turret")).map((b: any) => `(${b.tx},${b.ty}) ${Math.hypot(b.tx + 0.5 - hq.tx - 1.5, b.ty + 0.5 - hq.ty - 1.5).toFixed(1)}`).join(" "),
      "| army near gate", [...w.units.values()].filter((u: any) => u.faction === foe && u.kind !== "harvester" && Math.hypot(u.x - +process.env.TURRETS!.split(",")[0]!, u.y - +process.env.TURRETS!.split(",")[1]!) < 6).length,
      "| foe scrap", Math.round(w.factions[foe].scrap));
  }
  for (const b of w.buildings.values()) if (b.faction === side && !firsts[b.kind]) firsts[b.kind] = clock(w.tick);
  for (const b of w.buildings.values()) if (b.kind === "depot" && !depotSeen.has(b.id)) { depotSeen.add(b.id); depotAt[b.faction]!.push(clock(w.tick)); }
  // the foe's expansions while they go up: seen by us (k), hit (h), killed (x)
  for (const b of w.buildings.values()) if (b.faction === foe && b.founding !== undefined) {
    const e = (exps[b.id] ??= { k: false, h: false, x: false, at: clock(w.tick) });
    if (w.fog[side].known.has(b.id)) e.k = true;
    if (b.hp < BAL.BUILDINGS.depot.hp * BAL.ECONOMY.expansion.siteHp * 0.95 || (e.lastHp !== undefined && b.hp < e.lastHp)) e.h = true;
    e.lastHp = b.hp;
  }
  for (const [id, e] of Object.entries(exps)) if (!e.x && e.lastHp !== undefined && !w.buildings.has(+id)) e.x = true;
  for (const b of w.buildings.values()) if (b.faction === foe && b.kind === "depot" && !firsts["foeDepot"]) firsts["foeDepot"] = clock(w.tick);
  if (!firstHit && w.factions[foe].stats.unitsLost > 1) firstHit = clock(w.tick);
  // HIT=1: the first time 6+ of our combat units stand within 12 tiles of the foe's HQ, what each side has
  // (TECH-TIER.md "defence that barely holds"): turrets, units, the building going up and how far, scrap, 30 s income
  mined.push([w.tick, w.factions[foe].stats.scrapHarvested]);
  while (mined[0]![0] < w.tick - 30 * TICK_RATE) mined.shift();
  if (process.env.HIT && w.tick === 120 * TICK_RATE) {
    const p = w.factions[foe].pending;
    at2 = `foe@2:00 turrets${count(foe, "turret")} lab${count(foe, "tech-lab")} pending ${p ? p.kind + Math.round(100 * (1 - p.remaining / (BAL.BUILDINGS[p.kind as "turret"].buildTime * TICK_RATE))) + "%" : "-"} army${army(foe)} | ours army${army(side)}`;
  }
  if (process.env.HIT && !hitSnap) {
    const hq: any = [...w.buildings.values()].find((b: any) => b.faction === foe && b.kind === "hq");
    const near = hq && [...w.units.values()].filter((u: any) => u.faction === side && u.kind !== "harvester" && UNITS[u.kind as "stinger"].dps > 0 && Math.hypot(u.x - hq.tx - 1.5, u.y - hq.ty - 1.5) < 12);
    if (near && near.length >= 6) {
      const kinds = (f: string) => { const o: Record<string, number> = {}; for (const u of w.units.values() as any) if (u.faction === f && u.kind !== "harvester" && UNITS[u.kind as "stinger"].dps > 0) o[u.kind] = (o[u.kind] ?? 0) + 1; return JSON.stringify(o); };
      const p = w.factions[foe].pending;
      const pend = p ? `${p.kind}${Math.round(100 * (1 - p.remaining / (BAL.BUILDINGS[p.kind as "turret"].buildTime * TICK_RATE)))}%` : "-";
      hitSnap = `HIT ${clock(w.tick)} near${near.length} ours${kinds(side)} | foe turrets${count(foe, "turret")} lab${count(foe, "tech-lab")} pending ${pend} scrap${Math.round(w.factions[foe].scrap)} inc/s${((mined.at(-1)![1] - mined[0]![1]) / Math.max(1, (mined.at(-1)![0] - mined[0]![0]) / TICK_RATE)).toFixed(1)} units${kinds(foe)}`;
    }
  }
  for (const m of [3, 4, 5, 6, 8]) if (w.tick === m * 60 * TICK_RATE) {
    const s = (f: string) => `h${harv(f)} d${count(f, "depot")} mined${Math.round(w.factions[f].stats.scrapHarvested)} army${army(f)} lost${w.factions[f].stats.unitsLost}`;
    snap.push(`${m}m us[${s(side)}] foe[${s(foe)}]`);
  }
};
if (process.env.DEPOTS) a.maxTicks = 90 * TICK_RATE;
a.advance();
if (process.env.DEPOTS) {
  const hq: any = [...a.w.buildings.values()].find((b: any) => b.faction === side && b.kind === "hq");
  for (const b of a.w.buildings.values() as any) if (b.faction === side && b.kind === "depot") {
    let near = 99; for (let i = 0; i < a.w.terrain.length; i++) if (a.w.terrain[i] === 2) near = Math.min(near, Math.hypot(i % a.w.width - b.tx - 1, Math.floor(i / a.w.width) - b.ty - 1));
    console.log("depot", b.tx, b.ty, "fromHQ", Math.hypot(b.tx - hq.tx, b.ty - hq.ty).toFixed(1), "nearestScrap", near.toFixed(1));
  }
}
const e = a.record.end;
const res = e.winner === side ? "W" : e.winner === foe ? "L" : "D";
if (!quiet) { console.log(firsts, "foeLost2+", firstHit); for (const s of snap) console.log(s); }
if (process.env.HIT) console.log(hitSnap || "HIT none", "|", at2);
console.log("END", res, map, seed, side, ours, "vs", theirs, clock(e.tick), "depots", depotAt[side]!.join(","), "|", depotAt[foe]!.join(","), "exp", Object.values(exps).map((e: any) => e.at + (e.k ? "k" : "") + (e.h ? "h" : "") + (e.x ? "x" : "")).join(","),
  "t2", [side, foe].map((f) => `lab${lab[f] ?? "-"} first${t2[f] ?? "-"} share${t2share[f]!.join("/") || "-"}`).join(" | "));
