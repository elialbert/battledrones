#!/usr/bin/env node
// sweep.mjs [name=BALjson ...] : every config × PAIRS × maps × SEEDS × both sides, one queue, P at a time.
//   node tools/rps/sweep.mjs base='{}' tech='{"BUILDINGS.tech-lab.cost":560}'
// A config is a BAL patch (as rush.ts takes it); a bare name means {}. "base" is added if missing (NOBASE=1: not).
// Env: PAIRS ("rush:greed rush:turtle greed:turtle"), SEEDS ("1 2"), MAPS (all six), DIFF (hard),
//   P (12 = physical cores), OUT (/tmp/rps), RUN (a timestamp), RPS_TREE (this repo), Q=1 (no progress).
// Bundles rush.ts once (so src can be edited mid-run), reuses cached results of identical games
// (same bundle, BAL, args), runs the longest games first, writes $OUT/<run>/results.txt and a table.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tree = resolve(process.env.RPS_TREE || join(here, "../.."));
const OUT = process.env.OUT || "/tmp/rps";
const RUN = process.env.RUN || new Date().toISOString().slice(5, 19).replace(/[-:T]/g, "");
const P = +(process.env.P || 12);
const DIFF = process.env.DIFF || "hard";
const PAIRS = (process.env.PAIRS || "rush:greed rush:turtle greed:turtle").split(/\s+/).filter(Boolean);
const SEEDS = (process.env.SEEDS || "1 2").split(/\s+/).filter(Boolean);
const MAPS = (process.env.MAPS || "riverlands frostbite dune-sea archipelago ashlands proving-grounds").split(/\s+/).filter(Boolean);
const quiet = !!process.env.Q;

const configs = [];
for (const arg of process.argv.slice(2)) {
  const i = arg.indexOf("=");
  const name = i < 0 ? arg : arg.slice(0, i);
  const bal = i < 0 ? {} : JSON.parse(arg.slice(i + 1));
  configs.push({ name, bal: JSON.stringify(bal) });
}
if (!configs.some((c) => c.name === "base") && !process.env.NOBASE) configs.unshift({ name: "base", bal: "{}" });

const dir = join(OUT, RUN);
const cacheDir = join(OUT, "cache");
mkdirSync(dir, { recursive: true });
mkdirSync(cacheDir, { recursive: true });

// one bundle for the whole run
const bundle = join(dir, "rush.mjs");
execFileSync(join(tree, "node_modules/.bin/esbuild"), ["tools/rps/rush.ts", "--bundle", "--platform=node", "--format=esm", `--outfile=${bundle}`, "--log-level=warning"], { cwd: tree, stdio: "inherit" });
const bundleHash = createHash("sha1").update(readFileSync(bundle)).digest("hex").slice(0, 10);
let git = "?";
try { git = execFileSync("git", ["-C", tree, "rev-parse", "--short", "HEAD"]).toString().trim() + (execFileSync("git", ["-C", tree, "status", "--porcelain", "src"]).toString().trim() ? "+dirty" : ""); } catch {}

// cache: one line per finished game, "<key>\t<END line>"; durations by game args (any BAL)
const cacheFile = join(cacheDir, "results.tsv");
const cache = new Map();
if (existsSync(cacheFile)) for (const l of readFileSync(cacheFile, "utf8").split("\n")) { const [k, v] = l.split("\t"); if (v) cache.set(k, v); }
const durFile = join(cacheDir, "durations.json");
const dur = existsSync(durFile) ? JSON.parse(readFileSync(durFile, "utf8")) : {};

const games = [];
for (const c of configs) for (const pair of PAIRS) {
  const [ours, theirs] = pair.split(":");
  for (const map of MAPS) for (const seed of SEEDS) for (const side of ["blue", "red"]) {
    const args = [map, seed, DIFF, side, ours, theirs, "q"];
    const argKey = args.join(" ");
    games.push({ cfg: c.name, bal: c.bal, pair, args, argKey, key: `${bundleHash} ${c.bal} ${argKey}` });
  }
}
const results = join(dir, "results.txt");
writeFileSync(results, `# run ${RUN} git ${git} bundle ${bundleHash} diff ${DIFF} seeds ${SEEDS.join(",")}\n`);
for (const c of configs) appendFileSync(results, `# config ${c.name} ${c.bal}\n`);

const todo = games.filter((g) => !cache.has(g.key)).sort((a, b) => (dur[b.argKey] ?? 1e9) - (dur[a.argKey] ?? 1e9));
const t0 = Date.now();
let done = 0;
function record(g, line) { g.line = line; appendFileSync(results, `${g.cfg} ${g.pair} ${line}\n`); }
for (const g of games) if (cache.has(g.key)) record(g, cache.get(g.key));
if (!quiet) console.error(`sweep ${RUN}: ${games.length} games, ${games.length - todo.length} cached, ${todo.length} to play, ${P} at a time (git ${git}, bundle ${bundleHash})`);

function play(g) {
  return new Promise((res) => {
    const start = Date.now();
    const ch = spawn("node", [bundle, ...g.args], { env: { ...process.env, BAL: g.bal }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    ch.stdout.on("data", (d) => (out += d));
    ch.stderr.on("data", (d) => (out += d));
    const kill = setTimeout(() => ch.kill("SIGKILL"), 180_000);
    ch.on("close", () => {
      clearTimeout(kill);
      const line = out.trim().split("\n").reverse().find((l) => l.startsWith("END")) ?? `ERR ${g.argKey} ${out.trim().split("\n").at(-1) ?? ""}`;
      if (line.startsWith("END")) {
        cache.set(g.key, line);
        appendFileSync(cacheFile, `${g.key}\t${line}\n`);
        dur[g.argKey] = Date.now() - start;
      }
      record(g, line);
      done++;
      if (!quiet && (done % Math.max(1, Math.round(todo.length / 10)) === 0 || done === todo.length))
        console.error(`  ${done}/${todo.length}  ${((Date.now() - t0) / 1000).toFixed(0)} s`);
      res();
    });
  });
}
const queue = [...todo];
await Promise.all(Array.from({ length: Math.min(P, queue.length) }, async () => { while (queue.length) await play(queue.shift()); }));
writeFileSync(durFile, JSON.stringify(dur));

// table: score = (W + D/2) / N for the pair's left plan; delta vs base with a 95% interval
const secs = (c) => { const [m, s] = c.split(":").map(Number); return m * 60 + s; };
function tally(cfg, pair) {
  const gs = games.filter((g) => g.cfg === cfg && g.pair === pair);
  const r = { W: 0, L: 0, D: 0, E: 0, n: 0, len: 0 };
  for (const g of gs) {
    const f = g.line.split(" ");
    if (f[0] !== "END") { r.E++; continue; }
    r[f[1]]++; r.n++; r.len += secs(f[9]);
  }
  r.p = r.n ? (r.W + r.D / 2) / r.n : NaN;
  r.var = r.n ? r.p * (1 - r.p) / r.n : NaN;
  return r;
}
const pct = (x) => (x * 100).toFixed(0).padStart(3) + "%";
let table = `\nrun ${RUN}  git ${git}  ${DIFF}  seeds ${SEEDS.join(",")}  ${((Date.now() - t0) / 1000).toFixed(0)} s\n`;
table += "config".padEnd(14) + PAIRS.map((p) => p.padEnd(30)).join("") + "\n";
for (const c of configs) {
  let row = c.name.padEnd(14);
  for (const pair of PAIRS) {
    const r = tally(c.name, pair), b = tally("base", pair);
    let cell = `${r.W}-${r.L}-${r.D}${r.E ? ` E${r.E}` : ""} ${pct(r.p)}`;
    if (c.name !== "base" && configs.some((c) => c.name === "base")) {
      const d = r.p - b.p, ci = 1.96 * Math.sqrt(Math.max(r.var + b.var, 1 / (4 * r.n * r.n)));
      cell += ` ${d >= 0 ? "+" : "-"}${pct(Math.abs(d)).trim()}±${(ci * 100).toFixed(0)}${Math.abs(d) > ci ? "*" : ""}`;
    } else if (r.n) cell += ` ±${(1.96 * Math.sqrt(r.var) * 100).toFixed(0)}`;
    row += cell.padEnd(30);
  }
  table += row + "\n";
}
// tier 2 by plan (rush.ts "t2": ours | theirs): median Tech Lab and first tier-2 unit time, mean tier-2 army share at 3/5 min
const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, "0")}`;
const med = (xs) => (xs.length ? mmss(xs.sort((a, b) => a - b)[xs.length >> 1]) : "-");
const plans = [...new Set(PAIRS.flatMap((p) => p.split(":")))];
table += "\ntier 2 (median Lab, median first unit, mean share of army value at 3/5 min; games without one: n/a)\n" + "config".padEnd(14) + plans.map((p) => p.padEnd(34)).join("") + "\n";
for (const c of configs) {
  let row = c.name.padEnd(14);
  for (const plan of plans) {
    const labs = [], firsts = [], s3 = [], s5 = [];
    let none = 0;
    for (const g of games.filter((g) => g.cfg === c.name && g.line?.includes(" t2 "))) {
      const [ours, theirs] = g.pair.split(":");
      const segs = g.line.split(" t2 ")[1].split(" | ");
      for (const [i, who] of [[0, ours], [1, theirs]]) {
        if (who !== plan) continue;
        const m = segs[i].match(/lab(\S+) first(\S+) share(\S+)/);
        if (!m) continue;
        if (m[1] !== "-") labs.push(secs(m[1])); else none++;
        if (m[2] !== "-") firsts.push(secs(m[2]));
        const sh = m[3].split("/");
        if (sh[0] && sh[0] !== "-") s3.push(parseFloat(sh[0]));
        if (sh[1] && sh[1] !== "-") s5.push(parseFloat(sh[1]));
      }
    }
    const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) + "%" : "-");
    row += `${med(labs)} ${med(firsts)} ${avg(s3)}/${avg(s5)}${none ? ` n/a${none}` : ""}`.padEnd(34);
  }
  table += row + "\n";
}
table += "score = left plan's (W + D/2)/N; * = change vs base outside its 95% interval\n";
appendFileSync(results, table.split("\n").map((l) => (l ? "# " + l : l)).join("\n"));
writeFileSync(join(dir, "table.txt"), table);
console.log(table);
console.error(`results: ${results}`);
