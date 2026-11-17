import { appendFileSync, readFileSync } from "node:fs";
import { writeRecord } from "../arena/files";
import { capApm } from "../../src/sim/ai/apm";
import { AI_OPENER } from "../../src/sim/openers";
import { setupWorld } from "../../src/sim/setup";
import { step } from "../../src/sim/sim";
import { HASH_EVERY, endOf, replay, worldHash, type BattleRecord } from "../../src/arena/record";
import { TICK_RATE } from "../../src/sim/balance";
import type { Command } from "../../src/sim/types";
import { measure, EconomyObserver } from "./observer";
import { pressureOpponent } from "./scenarios";

const job = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const base = await import(job.baseline);
const next = await import(job.candidate);
const sides = ["blue", "red"] as const;
const record: BattleRecord = { v: 1, commit: job.commit, sim: job.sim, created: new Date().toISOString(),
  map: job.map, seed: job.seed, mutators: [], round: 50, maxTicks: job.minutes * 60 * TICK_RATE,
  openers: { blue: AI_OPENER, red: AI_OPENER }, frames: "own", seats: { blue: { player: "economy" }, red: { player: "economy" } },
  turns: [], hashes: [], log: [], radio: [], usage: {}, tick: 0, end: null };
const w = setupWorld(record);
const observer = new EconomyObserver(w);
const proposed = { blue: 0, red: 0 }, sent = { blue: 0, red: 0 };
let diagnostic: any = null;
let phase = "";
let planningTick = -1;
/** The candidate's posture (ai/posture.ts), when it has one: traced every sample. */
let candidatePosture: (() => unknown) | undefined;
const performanceBySide = { blue: { total: 0, max: 0, plans: [] as number[] }, red: { total: 0, max: 0, plans: [] as number[] } };
const bots = sides.map(side => {
  const candidate = side === job.side;
  const botSeed = candidate ? job.botSeed : job.opponentSeed;
  const bot = !candidate && job.scenario ? pressureOpponent(side, job.scenario, job.variant, base.createWith)
    : (candidate ? next : base).create(side, botSeed, candidate ? job.plan : job.opponentPlan, candidate ? job.enabled : !!job.baselineEnabled, (snapshot: any) => {
      if (!candidate) return;
      diagnostic = snapshot;
      if (candidate) planningTick = w.tick;
      const key = `${snapshot?.plan?.fieldId}:${snapshot?.plan?.phase}:${snapshot?.reason}`;
      if (key !== phase) { appendFileSync(job.trace, JSON.stringify({ type: "assignment", tick: w.tick, side, diagnostic: snapshot }) + "\n"); phase = key; }
    });
  record.seats[side] = { player: candidate ? `candidate:${job.enabled}` : job.scenario ?? `baseline:${job.opponentPlan}:${!!job.baselineEnabled}`,
    bot: { seed: botSeed, plan: candidate ? job.plan : job.scenario ? ["boom", "ironclad", "balanced"][job.variant % 3] : job.opponentPlan },
    settings: { apm: job.apm, burst: job.burst, think: job.think, react: job.react, microApm: job.microApm, variant: job.variant,
      secureEconomy: candidate ? job.enabled : !!job.baselineEnabled, experimentSource: job.signature } };
  if (candidate) candidatePosture = bot.posture?.bind(bot);
  const tick = bot.tick.bind(bot);
  bot.tick = (world: typeof w) => {
    const start = performance.now();
    const commands = tick(world);
    const ms = performance.now() - start;
    const perf = performanceBySide[side];
    perf.total += ms; perf.max = Math.max(perf.max, ms);
    if (candidate && planningTick === w.tick) perf.plans.push(ms);
    proposed[side] += commands.length; return commands;
  };
  return capApm(bot, job.apm, job.burst);
});
const offReference = !job.enabled && !job.baselineEnabled && job.offCheck !== false ? capApm(base.create(job.side, job.botSeed, job.plan, false), job.apm, job.burst) : null;
const samples: ReturnType<typeof measure>[] = [];
const start = performance.now();
while (!w.winner && w.tick < record.maxTicks) {
  const commands: Command[] = [];
  for (const [i, side] of sides.entries()) {
    const cmds = bots[i]!.tick(w);
    if (side === job.side && offReference && JSON.stringify(cmds) !== JSON.stringify(offReference.tick(w))) throw new Error(`Feature-off behavior differs from frozen baseline at tick ${w.tick}`);
    sent[side] += cmds.length;
    observer.sent(side, cmds, job.apm, job.burst);
    if (cmds.length) record.turns.push([w.tick, side, cmds]);
    commands.push(...cmds);
  }
  observer.beforeStep();
  step(w, commands);
  observer.afterStep();
  if (w.tick % HASH_EVERY === 0) record.hashes.push([w.tick, worldHash(w)]);
  if (w.tick % (5 * TICK_RATE) === 0) for (const side of sides) {
    const sample = { type: "sample", ...observer.sample(side, sent[side]), proposed: proposed[side], sent: sent[side], diagnostic: side === job.side ? diagnostic : null,
      posture: side === job.side ? candidatePosture?.() ?? null : null };
    samples.push(sample);
    appendFileSync(job.trace, JSON.stringify(sample) + "\n");
  }
  if (w.tick % (60 * TICK_RATE) === 0) { record.tick = w.tick; writeRecord(job.record, record); }
}
record.tick = w.tick;
record.end = w.winner ? endOf(w.tick, w.winner, w.resigned) : { tick: w.tick, winner: null, reason: "time" };
writeRecord(job.record, record);
const verified = replay(record);
if (verified.divergedAt !== null) throw new Error(`Replay diverged at ${verified.divergedAt}`);
const fixed: Record<string, unknown> = {};
for (const seconds of [120, 180, 240, 300]) fixed[seconds] = samples.filter(s => s.seconds === seconds);
console.log(JSON.stringify({ type: "result", id: job.id, pair: job.pair, side: job.side, enabled: job.enabled,
  sourceSignature: job.signature,
  map: job.map, seed: job.seed, scenario: job.scenario, variant: job.variant, winner: record.end.winner,
  reason: record.end.reason, seconds: w.tick / TICK_RATE, wallMs: performance.now() - start,
  proposed, sent, fixed, final: sides.map(side => observer.sample(side, sent[side])), checkedHashes: verified.checked,
  offEquivalent: offReference ? true : null,
  performance: sides.map(side => { const p = performanceBySide[side]; const plans = [...p.plans].sort((a, b) => a - b);
    return { side, botTickMs: p.total, worstBotTickMs: p.max, planningPasses: plans.length,
      planningP95Ms: plans.length ? plans[Math.min(plans.length - 1, Math.floor(plans.length * 0.95))] : null }; }),
  record: job.record, trace: job.trace }));
