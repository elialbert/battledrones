// Headless balance harness.
//   npx vite-node tools/balance.ts duels          cost-equal unit duel matrix
//   npx vite-node tools/balance.ts matches [map] [--classic]
//                                                 AI-vs-AI round robin (every map, or one), each AI
//                                                 taking its personality's opener (--classic: none)
//   npx vite-node tools/balance.ts passive        each strategy vs a passive foe
import { STRATEGIES, createAiState, tickAi, type StrategyName } from "../src/sim/ai/commander";
import { TICK_RATE, UNITS } from "../src/sim/balance";
import { MAPS, createMapWorld, mapById } from "../src/sim/maps";
import { pickAiOpener } from "../src/sim/openers";
import { step } from "../src/sim/sim";
import type { UnitKind, World } from "../src/sim/types";
import { createWorld, spawnUnit } from "../src/sim/world";

const COMBAT: UnitKind[] = ["stinger", "flak-crawler", "mortar", "titan", "lancer", "wasp", "raptor", "hornet"];
const BUDGET = 1800;

/** Army A (blue) vs army B (red), equal scrap, attack-moving into each other. */
function duel(a: UnitKind, b: UnitKind, seed: number): number {
  const w = createWorld(40, 40);
  const spawnArmy = (kind: UnitKind, faction: "blue" | "red", x: number) => {
    const n = Math.max(1, Math.round(BUDGET / UNITS[kind].cost));
    const ids: number[] = [];
    for (let i = 0; i < n; i++)
      ids.push(spawnUnit(w, kind, faction, x + (i % 3) * 0.8 + seed * 0.01, 16 + Math.floor(i / 3) * 0.8).id);
    return ids;
  };
  const A = spawnArmy(a, "blue", 8);
  const B = spawnArmy(b, "red", 30);
  step(w, [
    { type: "attackMove", faction: "blue", unitIds: A, x: 32, y: 17 },
    { type: "attackMove", faction: "red", unitIds: B, x: 8, y: 17 }
  ]);
  for (let t = 0; t < 120 * TICK_RATE; t++) {
    step(w, []);
    const blue = [...w.units.values()].some((u) => u.faction === "blue");
    const red = [...w.units.values()].some((u) => u.faction === "red");
    if (!blue || !red) break;
    // units that can't hit anything on the other side just idle: stop early
    if (t % 50 === 0 && t > 300 && w.fx.every((f) => f.type !== "shot")) break;
  }
  const left = (f: "blue" | "red") =>
    [...w.units.values()].filter((u) => u.faction === f).reduce((s, u) => s + (u.hp / UNITS[u.kind].hp) * UNITS[u.kind].cost, 0);
  // +1 = A wiped B with nothing lost; -1 = the reverse
  return (left("blue") - left("red")) / BUDGET;
}

function duels(): void {
  const pad = (s: string, n = 8) => s.slice(0, n).padStart(n);
  console.log(`cost-equal duels (${BUDGET} scrap each): row army vs column army, + = row wins`);
  console.log(pad("") + COMBAT.map((k) => pad(k)).join(""));
  for (const a of COMBAT) {
    let row = pad(a);
    for (const b of COMBAT) row += pad(a === b ? "-" : ((duel(a, b, 0) - duel(b, a, 0)) / 2).toFixed(2));
    console.log(row);
  }
}

const classic = process.argv.includes("--classic");

function match(map: string, blue: StrategyName, red: StrategyName, maxMin = 25): { winner: string; min: number; w: World } {
  const seed = mapById(map).seed;
  const w = createMapWorld(
    map,
    classic ? {} : { openers: { blue: pickAiOpener(blue, seed, "blue"), red: pickAiOpener(red, seed, "red") } }
  );
  const sb = createAiState(blue, "normal", 1);
  const sr = createAiState(red, "normal", 2);
  for (let i = 0; i < maxMin * 60 * TICK_RATE && !w.winner; i++)
    step(w, [...tickAi(w, "blue", sb), ...tickAi(w, "red", sr)]);
  return { winner: w.winner ?? "draw", min: w.tick / TICK_RATE / 60, w };
}

function matches(): void {
  const names = Object.keys(STRATEGIES) as StrategyName[];
  const wins: Record<string, number> = Object.fromEntries(names.map((n) => [n, 0]));
  const games: Record<string, number> = Object.fromEntries(names.map((n) => [n, 0]));
  const built: Record<string, number> = {};
  let draws = 0;
  let totalMin = 0;
  let n = 0;
  const only = process.argv.slice(3).find((a) => !a.startsWith("--"));
  for (const map of MAPS.filter((m) => !only || m.id === only)) {
    for (let i = 0; i < names.length; i++)
      for (let j = 0; j < names.length; j++) {
        if (i === j) continue;
        const { winner, min, w } = match(map.id, names[i]!, names[j]!);
        n++;
        totalMin += min;
        games[names[i]!]!++;
        games[names[j]!]!++;
        if (winner === "blue") wins[names[i]!]!++;
        else if (winner === "red") wins[names[j]!]!++;
        else draws++;
        for (const f of ["blue", "red"] as const) void f;
        for (const u of w.units.values()) built[u.kind] = (built[u.kind] ?? 0) + 1;
        process.stdout.write(`${map.id} ${names[i]} vs ${names[j]}: ${winner} @ ${min.toFixed(1)}m\n`);
      }
  }
  console.log("\nwin rates:");
  for (const s of names) console.log(`  ${s.padEnd(10)} ${((100 * wins[s]!) / games[s]!).toFixed(0)}%`);
  console.log(`draws ${draws}/${n}, mean length ${(totalMin / n).toFixed(1)} min`);
  console.log("units alive at match end:", built);
}

function passive(): void {
  for (const map of MAPS)
    for (const s of Object.keys(STRATEGIES) as StrategyName[]) {
      const w = createMapWorld(map.id);
      const st = createAiState(s, "normal", 3);
      for (let i = 0; i < 20 * 60 * TICK_RATE && !w.winner; i++) step(w, tickAi(w, "red", st));
      console.log(`${map.id.padEnd(16)} ${s.padEnd(10)} ${w.winner ?? "none"} @ ${(w.tick / 600).toFixed(1)}m`);
    }
}

const mode = process.argv[2] ?? "duels";
if (mode === "duels") duels();
else if (mode === "matches") matches();
else if (mode === "passive") passive();
