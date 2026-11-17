import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { replay, resimulate } from "../../src/arena/record";
import { simHash } from "../arena/files";
import { measure } from "./observer";
import { MARSHAL } from "../../src/sim/ai/marshal";
import { AI_OPENER } from "../../src/sim/openers";

const args = process.argv.slice(2);
const mode = args[0];
const arg = (key: string, fallback: string) => { const i = args.indexOf(`--${key}`); return i < 0 ? fallback : args[i + 1]!; };
const root = resolve(process.env.ECONOMY_SOURCE_ROOT ?? resolve(dirname(new URL(import.meta.url).pathname), "../.."));
const git = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
const digest = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
function files(path: string): string[] { return readdirSync(path, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(path, e.name)) : [join(path, e.name)]); }
function rulesHash(path: string) {
  return digest(files(join(path, "src/sim")).filter(f => !f.includes("/ai/")).sort().map(f => f.slice(path.length) + "\n" + readFileSync(f, "utf8")).join("\n"));
}
function seeds(s: string) {
  const m = /^(\d+)-(\d+)$/.exec(s);
  const values = m ? Array.from({ length: +m[2]! - +m[1]! + 1 }, (_, i) => +m[1]! + i) : s.split(",").map(Number);
  if (!values.length || values.some(n => !Number.isSafeInteger(n) || n < 0)) throw new Error(`Invalid seeds: ${s}`);
  return values;
}

if (mode === "trace") {
  const input = resolve(arg("record", "replay.json"));
  const record = JSON.parse(readFileSync(input, "utf8"));
  const out = resolve(arg("out", "/tmp/economy-trace.jsonl"));
  const reviewRecord = arg("review-record", "");
  if (out === input || reviewRecord && [input, out].includes(resolve(reviewRecord))) throw new Error("Trace and review outputs must differ from the input record and each other");
  writeFileSync(out, "");
  const result = replay(record, { onTick(w) { if (w.tick % 50 === 0) for (const side of ["blue", "red"] as const) appendFileSync(out, JSON.stringify(measure(w, side)) + "\n"); } });
  if (reviewRecord && result.divergedAt === null) {
    const reviewed = resimulate(record, { commit: git("rev-parse", "HEAD"), sim: simHash(root) });
    if (JSON.stringify(reviewed.hashes) !== JSON.stringify(record.hashes)) throw new Error("Review record changed replay hashes");
    writeFileSync(resolve(reviewRecord), JSON.stringify(reviewed));
  }
  console.log(JSON.stringify({ checked: result.checked, divergedAt: result.divergedAt, out, currentSim: simHash(root), reviewRecord: reviewRecord || null }));
  if (result.divergedAt !== null) process.exitCode = 1;
} else if (mode === "summary") {
  const rows = readFileSync(args[1]!, "utf8").trim().split("\n").map(s => JSON.parse(s)).filter(r => r.type === "result");
  for (const enabled of [false, true]) {
    const group = rows.filter(r => r.enabled === enabled);
    if (!group.length) continue;
    const wins = group.filter(r => r.winner === r.side).length;
    const losses = group.filter(r => r.winner && r.winner !== r.side).length;
    const timeouts = group.filter(r => r.reason === "time").length;
    const draws = group.filter(r => !r.winner && r.reason !== "time").length;
    const paired = [...new Set(group.map(r => r.pair))].map(pair => group.filter(r => r.pair === pair));
    const pairs = paired.filter(games => games.length === 2 && new Set(games.map(g => g.side)).size === 2).map(games => {
      return games.reduce((n, g) => n + (g.winner === g.side ? 1 : !g.winner ? 0.5 : 0), 0) / games.length;
    });
    const score = pairs.length ? pairs.reduce((a, b) => a + b, 0) / pairs.length : null;
    const se = pairs.length > 1 ? Math.sqrt(pairs.reduce((n, p) => n + (p - score!) ** 2, 0) / (pairs.length - 1) / pairs.length) : null;
    const boundedError = Math.sqrt(Math.log(40) / (2 * pairs.length));
    console.log(JSON.stringify({ enabled, games: group.length, wins, losses, draws, timeouts, pairs: pairs.length, score,
      incompletePairs: paired.length - pairs.length,
      approximatePairCI95: se === null ? null : [Math.max(0, score! - 1.96 * se), Math.min(1, score! + 1.96 * se)],
      pairHoeffdingCI95: score === null ? null : [Math.max(0, score - boundedError), Math.min(1, score + boundedError)],
      sides: ["blue", "red"].map(side => ({ side, games: group.filter(r => r.side === side).length, wins: group.filter(r => r.side === side && r.winner === side).length })),
      fixed: [120, 180, 240, 300].map(t => {
        const observations = group.flatMap(r => (r.fixed[t] ?? []).filter((s: any) => s.side === r.side));
        const differences = group.flatMap(r => {
          const own = (r.fixed[t] ?? []).find((s: any) => s.side === r.side);
          const other = (r.fixed[t] ?? []).find((s: any) => s.side !== r.side);
          return own && other ? [{ pair: r.pair, delivered: own.delivered - other.delivered, armyHp: own.armyHp - other.armyHp }] : [];
        });
        const completePairs = [...new Set(group.map(r => r.pair))].flatMap(pair => {
          const games = differences.filter(d => d.pair === pair);
          return games.length === 2 ? [{ delivered: (games[0]!.delivered + games[1]!.delivered) / 2, armyHp: (games[0]!.armyHp + games[1]!.armyHp) / 2 }] : [];
        });
        return { seconds: t, survived: observations.length, endedBefore: group.length - observations.length,
          observedCompletePairs: completePairs.length,
          pairedMeanDeliveredDelta: completePairs.length ? completePairs.reduce((n, s) => n + s.delivered, 0) / completePairs.length : null,
          pairedMeanArmyHpDelta: completePairs.length ? completePairs.reduce((n, s) => n + s.armyHp, 0) / completePairs.length : null,
          meanDelivered: observations.length ? observations.reduce((n, s) => n + s.delivered, 0) / observations.length : null,
          meanArmyHp: observations.length ? observations.reduce((n, s) => n + s.armyHp, 0) / observations.length : null };
      }) }));
  }
} else if (mode === "h2h" || mode === "scenarios") {
  const baselineCommit = git("rev-parse", arg("baseline", "dd4785d83e08c48eee4887ee5c7e3906b4478fa4") + "^{commit}");
  const out = resolve(arg("out", "/tmp/economy-results.jsonl"));
  const artifacts = out + ".artifacts";
  mkdirSync(artifacts, { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "economy-baseline-"));
  const baselineSource = arg("baseline-source", "");
  if (baselineSource) cpSync(join(resolve(baselineSource), "src"), join(dir, "src"), { recursive: true });
  else {
    const archive = execFileSync("git", ["archive", baselineCommit, "src"], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    execFileSync("tar", ["-x", "-C", dir], { input: archive });
  }
  mkdirSync(join(dir, "tools/ai"), { recursive: true });
  cpSync(join(root, "tools/ai/adapter.ts"), join(dir, "tools/ai/adapter.ts"));
  const rules = rulesHash(root);
  const recordSim = simHash(root);
  if (rules !== rulesHash(dir)) throw new Error("Simulation rules differ: cross-version worlds are forbidden. Use a compatible baseline.");
  const config = { maps: arg("maps", "riverlands").split(","), seeds: seeds(arg("seeds", "1")), plan: arg("plan", "boom"),
    difficulty: "brutal", think: MARSHAL.brutal.think, react: MARSHAL.brutal.react, microApm: MARSHAL.brutal.microApm,
    openers: { blue: AI_OPENER, red: AI_OPENER },
    variants: arg("variants", "off,on").split(","), scenarioVariants: seeds(arg("scenario-variants", "0-2")),
    pairedSeeds: arg("paired-seeds", "independent"), baselineEnabled: arg("baseline-enabled", "off") === "on",
    opponents: mode === "scenarios" ? ["pressure", "raid"] : arg("opponents", "baseline").split(","),
    minutes: Number(arg("max-minutes", "8")), apm: Number(arg("apm", "100")), burst: Number(arg("burst", "5")), concurrency: Number(arg("concurrency", "1")), offCheck: arg("off-check", "yes") !== "no" };
  if (![config.minutes, config.apm, config.burst, config.concurrency].every(n => Number.isFinite(n) && n > 0) || !Number.isInteger(config.concurrency)) throw new Error("Invalid positive numeric configuration");
  if (config.variants.some(v => v !== "on" && v !== "off")) throw new Error("--variants accepts off,on");
  if (!["same", "independent"].includes(config.pairedSeeds)) throw new Error("--paired-seeds accepts same,independent");
  if (!["off", "on"].includes(arg("baseline-enabled", "off"))) throw new Error("--baseline-enabled accepts off,on");
  if (config.baselineEnabled && !baselineSource) throw new Error("--baseline-enabled on requires --baseline-source");
  const diff = git("diff", "HEAD", "--", "src", "tools/ai", "tests");
  const sources = files(join(root, "src")).concat(files(join(root, "tools/ai")), files(join(root, "tests"))).sort().map(f => [f.slice(root.length + 1), digest(readFileSync(f))]);
  const baselineSnapshot = baselineSource ? { path: resolve(baselineSource), sources: files(join(dir, "src")).sort().map(f => [f.slice(dir.length + 1), digest(readFileSync(f))]) } : null;
  const manifest = { version: 2, baselineCommit, baselineSnapshot, candidateCommit: git("rev-parse", "HEAD"), rules, recordSim, diff, sources, config };
  const signature = digest(JSON.stringify(manifest));
  const manifestPath = join(artifacts, "manifest.json");
  if (existsSync(manifestPath) && JSON.parse(readFileSync(manifestPath, "utf8")).signature !== signature) throw new Error("Resume configuration/source mismatch; use a new output path.");
  if (!existsSync(manifestPath)) {
    if (existsSync(out) && readFileSync(out, "utf8").trim()) throw new Error("Cannot resume results without their original artifact manifest.");
    for (const [path] of sources) {
      const target = join(artifacts, "candidate-source", path!);
      mkdirSync(dirname(target), { recursive: true }); cpSync(join(root, path!), target);
    }
    if (baselineSource) cpSync(join(dir, "src"), join(artifacts, "baseline-source", "src"), { recursive: true });
    for (const [entry, outfile] of [[join(dir, "tools/ai/adapter.ts"), "baseline.mjs"], [join(root, "tools/ai/adapter.ts"), "candidate.mjs"], [join(root, "tools/ai/worker.ts"), "worker.mjs"]]) {
      await build({ entryPoints: [entry!], outfile: join(artifacts, outfile!), bundle: true, absWorkingDir: entry!.startsWith(dir) ? dir : root, platform: "node", format: "esm", target: "node18" });
    }
    const bundles = ["baseline.mjs", "candidate.mjs", "worker.mjs"].map(f => [f, digest(readFileSync(join(artifacts, f)))]);
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, signature, bundles }, null, 2));
  } else {
    for (const [f, hash] of JSON.parse(readFileSync(manifestPath, "utf8")).bundles) if (digest(readFileSync(join(artifacts, f))) !== hash) throw new Error(`Bundle integrity mismatch: ${f}`);
  }
  writeFileSync(join(artifacts, "candidate.patch"), diff);
  const done = new Set(existsSync(out) ? readFileSync(out, "utf8").split("\n").filter(Boolean).map(s => JSON.parse(s)).map(r => r.id) : []);
  const jobs: any[] = [];
  for (const map of config.maps) for (const seed of config.seeds) for (const enabled of config.variants.map(v => v === "on"))
    for (const opponent of config.opponents) for (const variant of opponent === "pressure" || opponent === "raid" ? config.scenarioVariants : [0])
      for (const side of ["blue", "red"]) {
        const scenario = opponent === "pressure" || opponent === "raid" || opponent === "greed" ? opponent : null;
        const pair = `${map}-${seed}-${opponent}-${variant}`;
        const id = `${pair}-${enabled ? "on" : "off"}-${side}`;
        if (done.has(id)) continue;
        jobs.push({ id, pair, map, seed, enabled, offCheck: config.offCheck, scenario, variant, side, signature, baselineEnabled: config.baselineEnabled,
          botSeed: seed * 7919 + 17, opponentSeed: scenario ? 9100 + variant : seed * 7919 + (config.pairedSeeds === "same" ? 17 : 29),
          think: config.think, react: config.react, microApm: config.microApm,
          plan: config.plan, opponentPlan: opponent === "baseline" || scenario ? config.plan : opponent, apm: config.apm, burst: config.burst, minutes: config.minutes, commit: manifest.candidateCommit, sim: recordSim,
          baseline: join(artifacts, "baseline.mjs"), candidate: join(artifacts, "candidate.mjs"), trace: join(artifacts, id + ".jsonl"), record: join(artifacts, id + ".json") });
      }
  async function work() {
    while (jobs.length) {
      const job = jobs.shift()!;
      const file = join(artifacts, job.id + ".job.json");
      writeFileSync(file, JSON.stringify(job));
      writeFileSync(job.trace, "");
      const result = await new Promise<string>((ok, fail) => {
        const proc = spawn(process.execPath, [join(artifacts, "worker.mjs"), file], { stdio: ["ignore", "pipe", "inherit"] });
        let output = "";
        proc.stdout.on("data", chunk => output += chunk);
        proc.on("error", fail);
        proc.on("exit", code => code === 0 ? ok(output.trim()) : fail(new Error(`${job.id} exited ${code}`)));
      });
      JSON.parse(result);
      appendFileSync(out, result + "\n");
      console.log(job.id);
    }
  }
  try { await Promise.all(Array.from({ length: config.concurrency }, work)); }
  finally { rmSync(dir, { recursive: true, force: true }); }
} else throw new Error("Use trace, scenarios, h2h, or summary. See tools/ai/README.md.");
