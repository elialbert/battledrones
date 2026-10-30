// Kiting duels (ai/kite.ts): cost-equal armies attack-move into each other on open ground;
// blue kites (one order a look, a token budget like Marshal's micro), or doesn't. Prints the
// score each way (+1 = blue wiped red, nothing lost) and the gain.
//   npx vite-node tools/rps/kite.ts                      the stock matchups
//   npx vite-node tools/rps/kite.ts lancer:stinger 3x lancer+3x stinger:stinger
//   KITE='{"margin":1.5}' REACT=0.5 MICRO=60 BUDGET=1800 SEEDS=4
import { TICK_RATE, UNITS } from "../../src/sim/balance";
import { step } from "../../src/sim/sim";
import type { Command, UnitKind, World } from "../../src/sim/types";
import { createWorld, spawnUnit } from "../../src/sim/world";
import { KITE, kiteStep } from "../../src/sim/ai/kite";

const K = { ...KITE, ...JSON.parse(process.env.KITE || "{}") };
const REACT = Math.round(+(process.env.REACT || 0.5) * TICK_RATE);
const MICRO = +(process.env.MICRO || 60);
const BUDGET = +(process.env.BUDGET || 1800);
const SEEDS = +(process.env.SEEDS || 3);

/** "3x lancer+3x stinger" → kinds; a bare kind is BUDGET's worth of it. */
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
  const ids = (kinds: UnitKind[], f: "blue" | "red", x: number) =>
    kinds.map((k, i) => spawnUnit(w, k, f, x + (i % 3) * 0.9 + seed * 0.13, 17 + Math.floor(i / 3) * 0.9 + seed * 0.07).id);
  const A = ids(a, "blue", 24);
  const B = ids(b, "red", 52);
  step(w, [
    { type: "attackMove", faction: "blue", unitIds: A, x: 70, y: 18 },
    { type: "attackMove", faction: "red", unitIds: B, x: 6, y: 18 }
  ]);
  const value = (f: string) => [...w.units.values()].filter((u) => u.faction === f).reduce((s, u) => s + UNITS[u.kind].cost, 0);
  const va = value("blue");
  const vb = value("red");
  let tokens = MICRO * 60;
  let held = 0;
  let t = 0;
  for (; t < 180 * TICK_RATE; t++) {
    const cmds: Command[] = [];
    tokens = Math.min(60 * TICK_RATE + REACT * MICRO, tokens + MICRO);
    if (kite && t % REACT === 0 && tokens >= 60 * TICK_RATE) {
      const ours = [...w.units.values()].filter((u) => u.faction === "blue");
      const theirs = [...w.units.values()].filter((u) => u.faction === "red");
      const s = kiteStep(w, ours, theirs, { x: 4, y: 18 }, K);
      if (s) {
        cmds.push({ type: "move", faction: "blue", unitIds: s.ids, x: s.x, y: s.y });
        tokens -= 60 * TICK_RATE;
        held = t + 15;
      }
    }
    // the plan: idle blues with nothing in reach get the attack-move again (Marshal's plan does, every think)
    if (t % 15 === 0 && t >= held) {
      const idle = [...w.units.values()].filter((u) => u.faction === "blue" && u.order.type === "idle" && u.autoTargetId === null).map((u) => u.id);
      if (idle.length) cmds.push({ type: "attackMove", faction: "blue", unitIds: idle, x: 70, y: 18 });
    }
    step(w, cmds);
    const blue = [...w.units.values()].some((u) => u.faction === "blue");
    const red = [...w.units.values()].some((u) => u.faction === "red");
    if (!blue || !red) break;
  }
  const left = (f: string) =>
    [...w.units.values()].filter((u) => u.faction === f).reduce((s, u) => s + (u.hp / UNITS[u.kind].hp) * UNITS[u.kind].cost, 0);
  return { score: left("blue") / va - left("red") / vb, secs: t / TICK_RATE };
}

const STOCK = [
  "lancer:stinger", "lancer:mastodon", "lancer:trooper", "lancer:rocket-squad", "lancer:lancer", "lancer:flak-crawler",
  "mortar:stinger", "mortar:mastodon", "sniper:trooper", "mastodon:trooper", "rocket-squad:trooper",
  "3x lancer+4x stinger:stinger", "4x lancer+2x mastodon:4x stinger+2x mastodon"
];
const specs = process.argv.slice(2).length ? process.argv.slice(2) : STOCK;
console.log(`kite ${JSON.stringify(K)} react ${REACT / TICK_RATE}s micro ${MICRO}/min`);
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
  console.log(`${spec.padEnd(44)} off ${f(off)} (${(so / SEEDS).toFixed(0)}s)  kite ${f(on)} (${(sn / SEEDS).toFixed(0)}s)  gain ${f(on - off)}`);
}
