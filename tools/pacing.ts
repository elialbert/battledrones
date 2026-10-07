// Pacing & snowball panel: the AI-vs-AI measurements behind DESIGN.md's
// "Balance & pacing" table.
//   npx vite-node tools/pacing.ts run <out.jsonl> [--seeds N] [--shard i/n] [--maps a,b] [--tune JSON]
//   npx vite-node tools/pacing.ts summary <a.jsonl> [b.jsonl ...]
// `run` plays every ordered pair of distinct personalities on every map
// (Normal vs Normal, each AI on its personality's opener, Uplinks and
// supply drops on, 25-minute cap) `--seeds` times with different match
// seeds, one JSON line per match (see pacing-match.ts). Shard it across
// processes (`--shard 0/4` … `3/4`) and feed all the files to `summary`.
// `--tune '{"POWERS.passive":0.05,"STRATEGIES.rush.assaultValue":1200}'`
// overrides exported balance numbers (and AI personalities) for an A/B run.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import * as balance from "../src/sim/balance";
import { STRATEGIES, type StrategyName } from "../src/sim/ai/commander";
import { MAPS } from "../src/sim/maps";
import type { Faction } from "../src/sim/types";
import { playMatch, type Match } from "./pacing-match";

const SIDES: Faction[] = ["blue", "red"];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function applyTune(json: string | undefined): void {
  if (!json) return;
  const roots: Record<string, unknown> = { ...balance, STRATEGIES };
  for (const [path, v] of Object.entries(JSON.parse(json) as Record<string, unknown>)) {
    const parts = path.split(".");
    let o = roots as Record<string, unknown>;
    for (const p of parts.slice(0, -1)) o = o[p] as Record<string, unknown>;
    const last = parts[parts.length - 1]!;
    if (!o || !(last in o)) throw new Error(`no such tunable: ${path}`);
    o[last] = v;
  }
}

function run(): void {
  const out = process.argv[3];
  if (!out) throw new Error("usage: pacing.ts run <out.jsonl> [--seeds N] [--shard i/n] [--maps a,b] [--tune JSON]");
  applyTune(arg("--tune"));
  const seeds = Number(arg("--seeds") ?? 1);
  const [shard, shards] = (arg("--shard") ?? "0/1").split("/").map(Number) as [number, number];
  const maps = arg("--maps")?.split(",") ?? MAPS.map((x) => x.id);
  const names = Object.keys(STRATEGIES) as StrategyName[];
  writeFileSync(out, "");
  let idx = 0;
  for (let s = 0; s < seeds; s++)
    for (const map of maps)
      for (const b of names)
        for (const r of names) {
          if (b === r) continue;
          const job = idx++;
          if (job % shards !== shard) continue;
          const m = playMatch(map, b, r, 7000 + job * 13 + s * 1000, 11 + job * 2);
          appendFileSync(out, JSON.stringify(m) + "\n");
        }
}

function summary(): void {
  const d: Match[] = process.argv
    .slice(3)
    .flatMap((f) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Match));
  const q = (a: number[], p: number) => {
    const s = [...a].sort((x, y) => x - y);
    return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : NaN;
  };
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  const mmss = (x: number) => (isNaN(x) ? "-" : `${Math.floor(x / 60)}:${String(Math.round(x % 60)).padStart(2, "0")}`);
  const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "-");
  const dec = d.filter((x) => x.winner !== "draw");
  const len = dec.map((x) => x.min * 60);
  console.log(`matches ${d.length}, 25-minute draws ${d.length - dec.length} (${pct(d.length - dec.length, d.length)})`);
  console.log(`decided length: median ${mmss(q(len, 0.5))}, p10 ${mmss(q(len, 0.1))}, p90 ${mmss(q(len, 0.9))}, mean ${mmss(mean(len))}`);
  const fcd = d.map((x) => x.firstCombatDeath).filter((x): x is number => x !== null);
  console.log(`first combat-unit death: median ${mmss(q(fcd, 0.5))}`);
  const fights = dec.map((x) => x.fights.length);
  console.log(`big fights (>= 1000 destroyed) per decided match: median ${q(fights, 0.5)}, mean ${mean(fights).toFixed(1)}, >= 3 in ${pct(fights.filter((n) => n >= 3).length, fights.length)}`);
  console.log(
    "side ahead by > 200 value went on to win: " +
      [2, 3, 4, 5]
        .map((min) => {
          const led = dec.filter((x) => x.leadAt[min]);
          return `${min}:00 ${pct(led.filter((x) => x.leadAt[min] === x.winner).length, led.length)} (n=${led.length})`;
        })
        .join(", ")
  );
  console.log(
    `lead changes: median ${q(d.map((x) => x.leadChanges), 0.5)}, mean ${mean(d.map((x) => x.leadChanges)).toFixed(1)}; ` +
      `winner had been 800+ behind in ${pct(dec.filter((x) => x.wasBehind[x.winner as Faction]).length, dec.length)}`
  );
  const bins = new Array(10).fill(0);
  const cbins = new Array(10).fill(0);
  for (const x of d) x.bins.forEach((v, i) => (bins[i] += v)), x.combatBins.forEach((v, i) => (cbins[i] += v));
  const mid = (b: number[]) => pct(b.slice(3, 7).reduce((x, y) => x + y, 0), b.reduce((x, y) => x + y, 0));
  console.log(`unit deaths in the middle 40% of the HQ-HQ line: ${mid(bins)} (combat units ${mid(cbins)})`);
  const per = d.flatMap((x) => SIDES.map((s) => Object.values(x.calldowns[s]).reduce((a, b) => a + b, 0)));
  const kinds: Record<string, number> = {};
  for (const x of d) for (const s of SIDES) for (const [k, v] of Object.entries(x.calldowns[s])) kinds[k] = (kinds[k] ?? 0) + v;
  console.log(
    `calldowns per AI per match: median ${q(per, 0.5)}, mean ${mean(per).toFixed(1)}, 4-8 in ${pct(per.filter((n) => n >= 4 && n <= 8).length, per.length)} (` +
      Object.entries(kinds).map(([k, v]) => `${k} ${(v / per.length).toFixed(1)}`).join(", ") + ")"
  );
  const lost = d.map((x) => x.uplinkLost);
  console.log(
    `Uplinks: ${mean(d.map((x) => x.uplinkFlips)).toFixed(1)} flips per match, changed hands in ${pct(lost.filter((n) => n > 0).length, d.length)} of matches; ` +
      `supply crates claimed ${pct(d.reduce((a, x) => a + x.cratesClaimed, 0), d.reduce((a, x) => a + x.cratesLanded, 0))}`
  );
  const wins: Record<string, [number, number]> = {};
  for (const x of d)
    for (const s of SIDES) {
      const p = x[s];
      wins[p] ??= [0, 0];
      wins[p]![1]++;
      if (x.winner === s) wins[p]![0]++;
    }
  console.log("personality win rates: " + Object.entries(wins).map(([k, [w, n]]) => `${k} ${pct(w, n)}`).join(", "));
}

if (process.argv[2] === "run") run();
else if (process.argv[2] === "summary") summary();
else console.log("usage: pacing.ts run <out.jsonl> [--seeds N] [--shard i/n] [--maps a,b] [--tune JSON] | summary <files...>");
