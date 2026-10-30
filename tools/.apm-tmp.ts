// Brutal (variant APM on `side`) vs Brutal as it stands. usage: apm <map> <seed> <side> <plan>
// env APM, BURST, MICRO, THINK for the variant seat
import { Arena, parseSeat } from "../src/arena/match";
import { TICK_RATE } from "../src/sim/balance";
import { hash32 } from "../src/sim/rand";
import { MARSHAL, marshal } from "../src/sim/ai/marshal";
import { capApm } from "../src/sim/ai/apm";
const [map, seedS, side, plan] = process.argv.slice(2) as any[];
const seed = +seedS;
const a: any = new Arena({ map, seed, seats: { blue: parseSeat("bot:marshal:brutal"), red: parseSeat("bot:marshal:brutal") }, maxTicks: 15 * 60 * TICK_RATE });
const M = MARSHAL.brutal;
const stat: Record<string, { want: number; sent: number; perMin: number[] }> = {};
for (const f of ["blue", "red"] as const) {
  const v = f === side;
  const apm = v && process.env.APM ? +process.env.APM : M.apm;
  const burst = v && process.env.BURST ? +process.env.BURST : M.burst;
  const micro = v && process.env.MICRO ? +process.env.MICRO : M.microApm;
  const think = v && process.env.THINK ? +process.env.THINK : M.think;
  const inner = marshal(f, hash32(seed, f === "blue" ? 1 : 2), "brutal", { ...M, think, microApm: micro, strategy: plan, tweak: { ...M.tweak } });
  const st = (stat[f] = { want: 0, sent: 0, perMin: [] });
  const counting = { ...inner, tick: (w: any) => { const c = inner.tick(w); st.want += c.length; return c; } };
  const capped = capApm(counting as any, apm, burst);
  a.seats[f].bot = { ...capped, tick: (w: any) => { const c = capped.tick(w); st.sent += c.length; const m = Math.floor(w.tick / 600); st.perMin[m] = (st.perMin[m] ?? 0) + c.length; return c; } };
}
a.advance();
const e = a.record.end;
const other = side === "blue" ? "red" : "blue";
const r = e.winner === side ? "W" : e.winner === other ? "L" : "D";
const t = e.tick / TICK_RATE;
const s = stat[other]!, v = stat[side]!;
console.log("END", r, map, seed, side, plan, `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`,
  `base drop ${Math.round(100 * (1 - s.sent / Math.max(1, s.want)))}% max/min ${Math.max(...s.perMin.filter(Boolean))}`,
  `var drop ${Math.round(100 * (1 - v.sent / Math.max(1, v.want)))}% max/min ${Math.max(...v.perMin.filter(Boolean))}`);
