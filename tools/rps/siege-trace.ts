// usage: siege-trace.ts <map> <seed> <diff> <side> <foePlan> [minutes]
// Plays Siege Train against foePlan and reports its hops, what it razed and what it lost.
import { Arena, parseSeat } from "../../src/arena/match";
import { BUILDINGS, TICK_RATE } from "../../src/sim/balance";
import { hash32 } from "../../src/sim/rand";
import { MARSHAL, MARSHAL_PLANS, marshal } from "../../src/sim/ai/marshal";
import { capApm } from "../../src/sim/ai/apm";
import { SIEGE, type Hop } from "../../src/sim/ai/siege";
import { UNITS } from "../../src/sim/balance";

Object.assign(SIEGE, JSON.parse(process.env.SIEGEC || "{}"));

const [map, seed, diff = "brutal", side = "blue", foePlan = "balanced", mins = "14"] = process.argv.slice(2) as any[];
const foe = side === "blue" ? "red" : "blue";
const a: any = new Arena({ map, seed: +seed, seats: { blue: parseSeat(`bot:marshal:${diff}`), red: parseSeat(`bot:marshal:${diff}`) }, maxTicks: +mins * 60 * TICK_RATE });
const M = (MARSHAL as any)[diff];
const hops: Hop[] = [];
const seat = (f: string, plan: string, tweak: any = {}) => {
  a.seats[f].bot = capApm(marshal(f as any, hash32(+seed, f === "blue" ? 1 : 2), diff, { ...M, strategy: plan as any, tweak: { ...M.tweak, ...tweak } }), M.apm, M.burst);
};
seat(side, "siege", { ...JSON.parse(process.env.SIEGET || "{}"), siege: { ...MARSHAL_PLANS.siege.tweak!.siege!, ...JSON.parse(process.env.SIEGE || "{}"), onHop: (h: Hop) => hops.push(h) } });
seat(foe, foePlan);
const clock = (t: number) => (t < 0 ? "-" : `${Math.floor(t / TICK_RATE / 60)}:${String(Math.floor(t / TICK_RATE) % 60).padStart(2, "0")}`);
// razed from outside Turret range: every enemy building gone while a Mortar of ours stood within 9.5 of it and no armed building reached that Mortar
const last = new Map<number, any>();
let razed = 0, razedSafe = 0, peakMortars = 0, mortarsLost = 0, prevMortars = new Set<number>();
const worth = (f: string) => { const by: Record<string, number> = {}; let v = 0; for (const u of a.w.units.values() as any) if (u.faction === f && u.kind !== "harvester") { v += UNITS[u.kind as "stinger"].cost; by[u.kind] = (by[u.kind] ?? 0) + 1; } return { v, by }; };
a.onRound = () => {
  if (process.env.T && a.w.tick % (30 * TICK_RATE) === 0) {
    const o = worth(side), f = worth(foe);
    const ms: any[] = [...a.w.units.values()].filter((u: any) => u.faction === side && u.kind === "mortar");
    const mid = ms.length ? `${Math.round(ms.reduce((v, u) => v + u.x, 0) / ms.length)},${Math.round(ms.reduce((v, u) => v + u.y, 0) / ms.length)}` : "-";
    console.log(clock(a.w.tick), "us", o.v, JSON.stringify(o.by), "guns@", mid, "| foe", f.v, JSON.stringify(f.by), "scrap", a.w.players?.[side]?.scrap ?? "");
  }
  const mortars: any[] = [...a.w.units.values()].filter((u: any) => u.faction === side && u.kind === "mortar");
  peakMortars = Math.max(peakMortars, mortars.length);
  const ids = new Set<number>(mortars.map((u) => u.id));
  for (const id of prevMortars) if (!ids.has(id)) mortarsLost++;
  prevMortars = ids;
  const now = new Map<number, any>();
  for (const b of a.w.buildings.values() as any) if (b.faction === foe) now.set(b.id, b);
  for (const [id, b] of last) {
    if (now.has(id)) continue;
    const c = { x: b.tx + BUILDINGS[b.kind as "hq"].size / 2, y: b.ty + BUILDINGS[b.kind as "hq"].size / 2 };
    const by = mortars.filter((u) => Math.hypot(u.x - c.x, u.y - c.y) <= 10);
    if (!by.length) continue;
    razed++;
    const reached = by.some((u) => [...now.values()].some((t: any) => BUILDINGS[t.kind as "turret"].dps > 0 && BUILDINGS[t.kind as "turret"].targets !== "air" && Math.hypot(u.x - t.tx - 0.5, u.y - t.ty - 0.5) <= 4.5));
    if (!reached) razedSafe++;
    if (process.env.V) console.log(clock(a.w.tick), "razed", b.kind, reached ? "under fire" : "safe", "mortars by", by.length);
  }
  last.clear();
  for (const [id, b] of now) last.set(id, b);
};
a.advance();
const e = a.record.end;
const res = e.winner === side ? "W" : e.winner === foe ? "L" : "D";
if (process.env.V) for (const h of hops) console.log(`HOP ${clock(h.at)} -> ${clock(h.stopped)} to ${Math.round(h.stop.x)},${Math.round(h.stop.y)} for ${h.target || "(leg)"}${h.cut ? " CUT" : ""}`);
const first = hops.find((h) => h.stopped >= 0);
console.log(`END ${res} ${map} ${seed} ${side} vs ${foePlan} at ${clock(e.tick)} hops ${hops.length} cut ${hops.filter((h) => h.cut).length} firstStop ${clock(first?.stopped ?? -1)} razed ${razed} safe ${razedSafe} mortars peak ${peakMortars} lost ${mortarsLost}`);
