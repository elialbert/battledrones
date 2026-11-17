// Re-seat Marshal on a battle record and print its posture (src/sim/ai/posture.ts) over the game.
//
// The bot seat's seed and plan come from the record (seats[side].bot, difficulty from
// "bot:marshal:<difficulty>"); the other side's orders are replayed as recorded. The re-seated
// bot's orders are checked against the record's: a match means the trace shows what that game's
// Marshal thought. A mismatch (a record from an older bot) means the world goes on as recorded and
// the posture shown is what this build's Marshal would have thought in that world, not what it did.
//
// Usage: npx vite-node tools/ai/posture-trace.ts <record.json> [--every 10] [--from <s>] [--reads] [--side red]
// Observer only: the full-world columns (army, mined, queues) never feed the bot.
import { readFileSync } from "node:fs";
import type { BattleRecord } from "../../src/arena/record";
import { seatMarshal, type PlanName } from "../../src/sim/ai/marshal";
import { BUILDINGS, TICK_RATE, UNITS } from "../../src/sim/balance";
import { setupWorld } from "../../src/sim/setup";
import { step } from "../../src/sim/sim";
import type { Command, Difficulty, Faction, World } from "../../src/sim/types";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--") && !/^\d+$/.test(a) && a !== "red" && a !== "blue");
const opt = (k: string) => { const i = args.indexOf(`--${k}`); return i < 0 ? undefined : args[i + 1]; };
if (!file) throw new Error("usage: npx vite-node tools/ai/posture-trace.ts <record.json> [--every 10] [--side red]");
const r = JSON.parse(readFileSync(file, "utf8")) as BattleRecord;
const every = Math.max(1, Math.round(Number(opt("every") ?? 10) * TICK_RATE));
const from = Number(opt("from") ?? 0) * TICK_RATE;
/** --reads: print each sample's raw reads too. */
const withReads = args.includes("--reads");
const side = (opt("side") ?? (["red", "blue"] as const).find((f) => (r.seats as any)?.[f]?.bot)) as Faction | undefined;
const seat = side && (r.seats as any)[side];
if (!side || !seat?.bot) throw new Error("no bot seat with a seed and plan in this record (seats.<side>.bot)");
const difficulty = ((seat.player as string).split(":")[2] ?? "brutal") as Difficulty;
const bot = seatMarshal(side, seat.bot.seed, difficulty, seat.bot.plan as PlanName);
const w = setupWorld(r);
const end = r.end?.tick ?? r.tick;
const byTick = new Map<number, [Faction, Command[]][]>();
for (const [t, f, cmds] of r.turns as [number, Faction, Command[]][]) (byTick.get(t) ?? byTick.set(t, []).get(t)!).push([f, cmds]);

const enemy: Faction = side === "red" ? "blue" : "red";
const armyOf = (f: Faction) => [...w.units.values()].filter((u) => u.faction === f && u.kind !== "harvester" && UNITS[u.kind].dps > 0).reduce((n, u) => n + UNITS[u.kind].cost, 0);
const PRODUCERS = new Set(["fab-plant", "airpad", "assembly-bay", "gantry"]);
function row(w: World, f: Faction) {
  const bs = [...w.buildings.values()].filter((b) => b.faction === f);
  return {
    army: armyOf(f),
    mined: w.factions[f].stats.scrapHarvested,
    factories: bs.filter((b) => PRODUCERS.has(b.kind)).length,
    depots: bs.filter((b) => b.kind === "depot").length,
    queued: bs.reduce((n, b) => n + b.queue.reduce((m, q) => m + (q.paid ?? UNITS[q.kind].cost), 0), 0),
    buildingValue: bs.reduce((n, b) => n + BUILDINGS[b.kind].cost, 0)
  };
}
const pct = (x: number) => String(Math.round(x * 100)).padStart(3);
const t = (tick: number) => `${Math.floor(tick / TICK_RATE / 60)}:${String(Math.floor(tick / TICK_RATE) % 60).padStart(2, "0")}`;

console.log(`${r.map}, ${side} Marshal ${difficulty} ${seat.bot.plan} (seed ${seat.bot.seed}), record commit ${r.commit}, to ${t(end)}`);
console.log("time  | army econ tech | curve A/E/T  | lean     | want fac depotCap | ours: army mined fac dep queued | theirs: army mined fac dep | reasons");
let mismatches = 0;
let firstMismatch: number | null = null;
while (w.tick < end && !w.winner) {
  const mine = bot.tick(w);
  const recorded = (byTick.get(w.tick) ?? []).filter(([f]) => f === side).flatMap(([, c]) => c);
  if (JSON.stringify(mine) !== JSON.stringify(recorded)) { mismatches++; firstMismatch ??= w.tick; }
  // (the record's orders drive the world either way: it's the game that was played)
  const cmds = (byTick.get(w.tick) ?? []).flatMap(([, c]) => c);
  if (w.tick % every === 0 && w.tick > from) {
    const p = bot.posture?.();
    const o = row(w, side), e = row(w, enemy);
    if (p)
      console.log(
        `${t(w.tick).padStart(5)} | ${pct(p.army)} ${pct(p.economy)} ${pct(p.tech)}  | ${pct(p.base.army)}/${pct(p.base.economy)}/${pct(p.base.tech)} | ${(p.lean ?? "-").padEnd(8)} | ${String(p.wantFactories).padStart(4)} ${String(p.depotCap).padStart(8)} |` +
          ` ${String(o.army).padStart(10)} ${String(o.mined).padStart(5)} ${String(o.factories).padStart(3)} ${String(o.depots).padStart(3)} ${String(o.queued).padStart(6)} |` +
          ` ${String(e.army).padStart(12)} ${String(e.mined).padStart(5)} ${String(e.factories).padStart(3)} ${String(e.depots).padStart(3)} | ${p.reasons.join(" ")}${withReads && p.reads ? " " + JSON.stringify(p.reads) : ""}`
      );
  }
  step(w, cmds);
}
console.log(mismatches ? `orders: ${mismatches} ticks differ from the record (first ${t(firstMismatch!)}): the posture shown is this build's view of that world` : "orders: match the record tick for tick (0 mismatches)");
