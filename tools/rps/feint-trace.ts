// usage: feint-trace.ts <map> <seed> <diff> <side> <foePlan> [minutes]
// Plays The Feint against foePlan and reports each trick: when the army reached its target, and where the enemy's army was then.
import { Arena, parseSeat } from "../../src/arena/match";
import { TICK_RATE, UNITS } from "../../src/sim/balance";
import { hash32 } from "../../src/sim/rand";
import { MARSHAL, MARSHAL_PLANS, marshal } from "../../src/sim/ai/marshal";
import { capApm } from "../../src/sim/ai/apm";
import { type Trick } from "../../src/sim/ai/feint";

const [map, seed, diff = "brutal", side = "blue", foePlan = "balanced", mins = "12"] = process.argv.slice(2) as any[];
const foe = side === "blue" ? "red" : "blue";
const a: any = new Arena({ map, seed: +seed, seats: { blue: parseSeat(`bot:marshal:${diff}`), red: parseSeat(`bot:marshal:${diff}`) }, maxTicks: +mins * 60 * TICK_RATE });
const M = (MARSHAL as any)[diff];
const tricks: Trick[] = [];
const seat = (f: string, plan: string, tweak: any = {}) => {
  a.seats[f].bot = capApm(marshal(f as any, hash32(+seed, f === "blue" ? 1 : 2), diff, { ...M, strategy: plan as any, tweak: { ...M.tweak, ...tweak } }), M.apm, M.burst);
};
const spec = { ...MARSHAL_PLANS.feint.tweak!.feint!, ...JSON.parse(process.env.FEINT || "{}"), onTrick: (t: Trick) => tricks.push(t) };
seat(side, "feint", { feint: spec });
seat(foe, foePlan);
const clock = (t: number) => (t < 0 ? "-" : `${Math.floor(t / TICK_RATE / 60)}:${String(Math.floor(t / TICK_RATE) % 60).padStart(2, "0")}`);
const reported = new Map<Trick, boolean>();
const atSpring = new Map<Trick, string>();
const armyAt = (f: string, p: any, r: number) => [...a.w.units.values()].filter((u: any) => u.faction === f && u.kind !== "harvester" && UNITS[u.kind as "stinger"].dps > 0 && (!p || Math.hypot(u.x - p.x, u.y - p.y) <= r)).reduce((v: number, u: any) => v + UNITS[u.kind as "stinger"].cost, 0);
const lines: string[] = [];
a.onRound = () => {
  if (process.env.V && a.w.tick % (5 * TICK_RATE) === 0) for (const t of tricks) {
    if (t.sprung < 0 || a.w.tick - t.sprung > 70 * TICK_RATE) continue;
    const us: any[] = t.wave.map((id) => a.w.units.get(id)).filter(Boolean);
    const c = (l: any[]) => (l.length ? `${Math.round(l.reduce((v, u) => v + u.x, 0) / l.length)},${Math.round(l.reduce((v, u) => v + u.y, 0) / l.length)}` : "-");
    const foes: any[] = [...a.w.units.values()].filter((u: any) => u.faction === foe && u.kind !== "harvester" && UNITS[u.kind as "stinger"].dps > 0);
    const orders: Record<string, number> = {};
    for (const u of us) orders[u.order.type] = (orders[u.order.type] ?? 0) + 1;
    const near = us.length ? foes.filter((e) => us.some((u) => Math.hypot(u.x - e.x, u.y - e.y) < 8)).length : 0;
    console.log(clock(a.w.tick), "wave", us.length, c(us), JSON.stringify(orders), "to", Math.round(t.mainTo.x), Math.round(t.mainTo.y), "stage", Math.round(t.stage.x), Math.round(t.stage.y), "feintTo", Math.round(t.feintTo.x), Math.round(t.feintTo.y), "| foe", foes.length, c(foes), "nearWave", near);
  }
  for (const t of tricks) {
    if (t.sprung >= 0 && !atSpring.has(t)) atSpring.set(t, `spring: foe ${armyAt(foe, null, 0)} @feint ${armyAt(foe, t.feintTo, 10)} @main ${armyAt(foe, t.mainTo, 10)}`);
    if (t.sprung < 0 || reported.get(t)) continue;
    const landed = armyAt(side, t.mainTo, 10), goal = t.wave.reduce((v, id) => v + 0, 0) + t.mainValue;
    const timedOut = a.w.tick - t.sprung >= 60 * TICK_RATE;
    if (landed < 0.3 * goal && !timedOut) continue;
    reported.set(t, true);
    const gap = Math.round(Math.hypot(t.feintTo.x - t.mainTo.x, t.feintTo.y - t.mainTo.y));
    const f = armyAt(foe, t.feintTo, 10), m2 = armyAt(foe, t.mainTo, 10);
    lines.push(`TRICK formed ${clock(t.formed)} out ${clock(t.out)} sprung ${clock(t.sprung)} (${t.why}) ${timedOut ? "NOLAND" : f > m2 ? "landedWON" : "landed"} ${clock(a.w.tick)} gap ${gap} feint ${t.feintValue} main ${t.mainValue} ours@main ${landed} | foe army ${armyAt(foe, null, 0)} @feint ${f} @main ${m2} | ${atSpring.get(t)}`);
  }
};
a.advance();
const e = a.record.end;
const res = e.winner === side ? "W" : e.winner === foe ? "L" : "D";
for (const l of lines) console.log(l);
console.log(`END ${res} ${map} ${seed} ${side} vs ${foePlan} at ${clock(e.tick)} tricks ${tricks.filter((t) => t.sprung >= 0).length} calledOff ${tricks.filter((t) => t.why === "called off").length} never ${tricks.filter((t) => t.why === "").length}`);
