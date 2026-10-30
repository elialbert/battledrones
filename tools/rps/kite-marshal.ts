// Kiting with Marshal's own fight micro (ai/kite.ts in marshal.ts fights()): blue is Hard Marshal
// (kiting, or not), red cost-equal attack-moves at blue's HQ across open ground. Prints the score
// each way (+1 = blue wiped red, nothing lost).
//   npx vite-node tools/rps/kite-marshal.ts [blue:red ...]   (army specs as in kite.ts)
//   DIFF=hard SEEDS=4 BUDGET=1800
import { TICK_RATE, UNITS } from "../../src/sim/balance";
import { step } from "../../src/sim/sim";
import type { Command, UnitKind, World } from "../../src/sim/types";
import { createWorld, spawnBuilding, spawnUnit } from "../../src/sim/world";
import { MARSHAL, marshal } from "../../src/sim/ai/marshal";
import { capApm } from "../../src/sim/ai/apm";

const DIFF = (process.env.DIFF || "hard") as "hard";
const BUDGET = +(process.env.BUDGET || 1800);
const SEEDS = +(process.env.SEEDS || 4);

function army(spec: string): UnitKind[] {
  const parts = spec.split("+");
  if (parts.length === 1 && !spec.includes("x ")) return Array(Math.max(1, Math.round(BUDGET / UNITS[spec as UnitKind].cost))).fill(spec);
  return parts.flatMap((p) => {
    const m = p.trim().match(/^(\d+)x (.+)$/)!;
    return Array(+m[1]!).fill(m[2]);
  });
}

function fight(a: UnitKind[], b: UnitKind[], kite: boolean, seed: number): { score: number; secs: number } {
  const w: World = createWorld(80, 40);
  spawnBuilding(w, "hq", "blue", 2, 17);
  spawnBuilding(w, "hq", "red", 75, 17);
  for (const f of ["blue", "red"] as const) w.factions[f].scrap = 0;
  const ids = (kinds: UnitKind[], f: "blue" | "red", x: number) =>
    kinds.map((k, i) => spawnUnit(w, k, f, x + (i % 3) * 0.9 + seed * 0.13, 17 + Math.floor(i / 3) * 0.9 + seed * 0.07).id);
  const A = ids(a, "blue", 24);
  const B = ids(b, "red", 50);
  const M = MARSHAL[DIFF];
  const bot = capApm(marshal("blue", 1000 + seed, DIFF, { ...M, strategy: "balanced", fight: { ...M.fight, kite } }), M.apm, M.burst);
  const value = (f: string) => [...w.units.values()].filter((u) => u.faction === f).reduce((s, u) => s + UNITS[u.kind].cost, 0);
  const va = value("blue");
  const vb = value("red");
  let t = 0;
  for (; t < 180 * TICK_RATE; t++) {
    const cmds: Command[] = t === 0 ? [{ type: "attackMove", faction: "red", unitIds: B, x: 4, y: 18 }, { type: "attackMove", faction: "blue", unitIds: A, x: 40, y: 18 }] : [];
    // red re-attacks with anything idle (the attack-move ends at blue's HQ)
    if (t % 20 === 10) {
      const idle = [...w.units.values()].filter((u) => u.faction === "red" && u.order.type === "idle" && u.autoTargetId === null).map((u) => u.id);
      if (idle.length) cmds.push({ type: "attackMove", faction: "red", unitIds: idle, x: 4, y: 18 });
    }
    cmds.push(...bot.tick(w));
    step(w, cmds);
    if (w.winner) break;
    const blue = [...w.units.values()].some((u) => u.faction === "blue");
    const red = [...w.units.values()].some((u) => u.faction === "red");
    if (!blue || !red) break;
  }
  const left = (f: string) =>
    [...w.units.values()].filter((u) => u.faction === f).reduce((s, u) => s + (u.hp / UNITS[u.kind].hp) * UNITS[u.kind].cost, 0);
  return { score: left("blue") / va - left("red") / vb, secs: t / TICK_RATE };
}

const STOCK = [
  "lancer:stinger", "lancer:mastodon", "lancer:trooper", "lancer:rocket-squad", "mortar:mastodon", "sniper:trooper",
  "3x lancer+4x stinger:stinger", "4x lancer+2x mastodon:4x stinger+2x mastodon", "3x lancer+2x mortar+3x stinger:5x stinger+2x mastodon"
];
const specs = process.argv.slice(2).length ? process.argv.slice(2) : STOCK;
console.log(`Marshal ${DIFF}, kiting vs not`);
for (const spec of specs) {
  const [sa, sb] = spec.split(":");
  const a = army(sa!);
  const b = army(sb!);
  let off = 0, on = 0, so = 0, sn = 0;
  for (let s = 0; s < SEEDS; s++) {
    const x = fight(a, b, false, s);
    const y = fight(a, b, true, s);
    off += x.score; on += y.score; so += x.secs; sn += y.secs;
  }
  const f = (n: number) => (n / SEEDS).toFixed(2).padStart(6);
  console.log(`${spec.padEnd(56)} off ${f(off)} (${(so / SEEDS).toFixed(0)}s)  kite ${f(on)} (${(sn / SEEDS).toFixed(0)}s)  gain ${f(on - off)}`);
}
