// Last Stand tuning harness: how many waves does a defender survive?
//   npx vite-node tools/survival.ts [ai|human|both] [map|all] [easy|normal|hard|all] [seeds]
// "ai"    = blue is a Normal Balanced AI commander (src/sim/ai/commander.ts)
// "human" = blue is a scripted, reasonable phone player: reacts once a
//           second, keeps factory queues one deep, builds a few turrets,
//           counters the announced wave theme and pulls its army onto
//           attackers near the base — but never calls waves early.
// Prints waves survived per map and difficulty (plus run length and kills).
import { createAiState, tickAi } from "../src/sim/ai/commander";
import { BUILDINGS, TICK_RATE, UNITS } from "../src/sim/balance";
import { canPlaceBuilding, nearestScrapTile, unitBlocker } from "../src/sim/economy";
import { isVisible } from "../src/sim/fog";
import { MAPS, createMapWorld } from "../src/sim/maps";
import { survivalStatus, wavesSurvived, type SurvivalDifficulty } from "../src/sim/modes/survival";
import { step } from "../src/sim/sim";
import type { BuildingKind, Command, UnitKind, World } from "../src/sim/types";
import { buildingCenter, dist, hqOf } from "../src/sim/world";

type Defender = "ai" | "human";
type Brain = (w: World) => Command[];

function aiDefender(seed: number): Brain {
  const s = createAiState("balanced", "normal", seed);
  return (w) => tickAi(w, "blue", s);
}

/** A scripted "decent phone player" (see the header). */
function humanDefender(w0: World): Brain {
  const hq = hqOf(w0, "blue")!;
  const hqC = buildingCenter(hq);
  const field = nearestScrapTile(w0, hqC.x, hqC.y)!;
  const guard = { x: (field.x + hqC.x) / 2 + 1, y: (field.y + hqC.y) / 2 - 1 };
  const toward = (p: { x: number; y: number }, d: number) => {
    const len = Math.max(1, dist(hqC.x, hqC.y, p.x, p.y));
    return { x: hqC.x + ((p.x - hqC.x) / len) * d, y: hqC.y + ((p.y - hqC.y) / len) * d };
  };
  const front = toward({ x: w0.width / 2, y: w0.height / 2 }, 5);
  const build: BuildingKind[] = ["fab-plant", "turret", "airpad", "tech-lab", "turret", "sam-site", "turret", "fab-plant", "sam-site", "turret"];
  let bi = 0;
  let heldFor = 0;
  const spot = (w: World, kind: BuildingKind, anchor: { x: number; y: number }) => {
    const size = BUILDINGS[kind].size;
    let best: { tx: number; ty: number } | null = null;
    let bd = Infinity;
    for (let ty = 0; ty < w.height; ty++)
      for (let tx = 0; tx < w.width; tx++) {
        const d = Math.hypot(tx + size / 2 - anchor.x, ty + size / 2 - anchor.y);
        if (d < bd && canPlaceBuilding(w, "blue", kind, tx, ty)) {
          bd = d;
          best = { tx, ty };
        }
      }
    return best;
  };
  return (w) => {
    if (w.tick % TICK_RATE !== 0) return [];
    const cmds: Command[] = [];
    const f = w.factions.blue;
    const st = survivalStatus(w)!;
    const mine = [...w.units.values()].filter((u) => u.faction === "blue");
    const myB = [...w.buildings.values()].filter((b) => b.faction === "blue");
    const hqB = myB.find((b) => b.kind === "hq");
    if (!hqB) return cmds;
    const army = mine.filter((u) => u.kind !== "harvester");
    const foes = [...w.units.values()].filter((u) => u.faction === "red" && isVisible(w, "blue", Math.floor(u.x), Math.floor(u.y)));
    const airThreat = st.nextTheme === "air" || foes.filter((u) => UNITS[u.kind].domain === "air").length >= 2;
    let scrap = f.scrap;
    if (f.pending?.ready) {
      const k = f.pending.kind;
      const anchor = k === "turret" || k === "sam-site" ? (bi % 2 ? front : guard) : toward({ x: w.width / 2, y: w.height / 2 }, 2);
      const s = spot(w, k, anchor);
      if (s) cmds.push({ type: "placeBuilding", faction: "blue", tx: s.tx, ty: s.ty });
    } else if (!f.pending && bi < build.length) {
      const next = build[bi]!;
      const req = BUILDINGS[next].requires;
      if (scrap >= BUILDINGS[next].cost && (!req || req.some((r) => myB.some((b) => b.kind === r)))) {
        cmds.push({ type: "startBuilding", faction: "blue", building: next });
        scrap -= BUILDINGS[next].cost;
        bi++;
      }
    }
    if (mine.filter((u) => u.kind === "harvester").length + hqB.queue.length < 4 && scrap >= 150) {
      cmds.push({ type: "produce", faction: "blue", buildingId: hqB.id, unit: "harvester" });
      scrap -= 150;
    }
    const count = (k: UnitKind) => army.filter((u) => u.kind === k).length;
    for (const b of myB) {
      if (b.queue.length >= 1) continue;
      let kind: UnitKind | null = null;
      if (b.kind === "fab-plant") {
        if (airThreat && count("flak-crawler") < 2 + Math.floor(st.wave / 3)) kind = "flak-crawler";
        else if (!unitBlocker(w, "blue", "titan")) kind = army.length % 3 === 0 ? "titan" : army.length % 3 === 1 ? "lancer" : "stinger";
        else kind = "stinger";
      } else if (b.kind === "airpad") kind = airThreat ? "raptor" : count("mender") < 2 && army.length > 8 ? "mender" : "wasp";
      if (!kind || scrap < UNITS[kind].cost) continue;
      cmds.push({ type: "produce", faction: "blue", buildingId: b.id, unit: kind });
      scrap -= UNITS[kind].cost;
      if (!b.rally) cmds.push({ type: "rally", faction: "blue", buildingId: b.id, x: guard.x, y: guard.y });
    }
    // fight whatever is hitting the base; otherwise hold toward the next wave
    const near = foes
      .map((u) => ({ u, d: Math.min(...myB.map((b) => dist(u.x, u.y, buildingCenter(b).x, buildingCenter(b).y))) }))
      .filter((e) => e.d < 15)
      .sort((a, b) => a.d - b.d);
    const idle = army.filter((u) => u.order.type === "idle" && u.autoTargetId === null);
    if (near[0] && idle.length > 0) {
      cmds.push({ type: "attackMove", faction: "blue", unitIds: idle.map((u) => u.id), x: near[0].u.x, y: near[0].u.y });
    } else if (st.warned && st.site && heldFor !== st.next && army.length > 0) {
      heldFor = st.next;
      const hold = toward(st.site, 7);
      cmds.push({ type: "attackMove", faction: "blue", unitIds: army.map((u) => u.id), x: hold.x, y: hold.y });
    }
    return cmds;
  };
}

export interface SurvivalRun {
  waves: number;
  min: number;
  kills: number;
  lost: number;
  spawnTimes: number[];
}

export function survivalRun(map: string, difficulty: SurvivalDifficulty, seed: number, defender: Defender = "ai", maxMin = 45): SurvivalRun {
  const w = createMapWorld(map, { seed, survival: { difficulty } });
  const brain = defender === "ai" ? aiDefender(seed) : humanDefender(w);
  const spawnTimes: number[] = [];
  const log = process.env.SURV_LOG === "1";
  const t = () => { const s = w.tick / TICK_RATE; return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`; };
  const value = (f: string) =>
    [...w.units.values()].filter((u) => u.faction === f && u.kind !== "harvester").reduce((v, u) => v + UNITS[u.kind].cost, 0);
  let lostAt = 0;
  for (let i = 0; i < maxMin * 60 * TICK_RATE && !w.winner; i++) {
    step(w, brain(w));
    for (const e of w.fx) {
      if (e.type === "waveSpawned") {
        spawnTimes.push(w.tick / TICK_RATE);
        lostAt = w.factions.blue.stats.unitsLost;
        if (log) {
          const blds = [...w.buildings.values()].filter((b) => b.faction === "blue").map((b) => b.kind);
          console.log(`  ${t()} wave ${e.wave} ${e.name} (${e.count}) | blue army ${value("blue")} scrap ${Math.floor(w.factions.blue.scrap)} harvested ${w.factions.blue.stats.scrapHarvested} | defences ${blds.filter((k) => k === "turret" || k === "sam-site").length} buildings ${blds.length}`);
        }
      }
      if (log && e.type === "waveCleared") console.log(`  ${t()}   cleared ${e.wave}: blue lost ${w.factions.blue.stats.unitsLost - lostAt} units, +${e.bonus}`);
      if (log && e.type === "waveIncoming" && e.early) console.log(`  ${t()}   wave ${e.wave} called early +${e.early}`);
      if (log && e.type === "death" && e.faction === "blue" && e.buildingKind) console.log(`  ${t()}   lost ${e.buildingKind}`);
    }
    if (log && w.tick % 600 === 0) console.log(`  ${t()}   red live ${[...w.units.values()].filter((u) => u.faction === "red").length} (${value("red")}) pending ${w.survival!.pending.length}`);
  }
  const st = w.factions.blue.stats;
  return { waves: wavesSurvived(w), min: w.tick / TICK_RATE / 60, kills: st.unitsKilled, lost: st.unitsLost, spawnTimes };
}

function main(): void {
  const defArg = process.argv[2] ?? "ai";
  const mapArg = process.argv[3] ?? "all";
  const diffArg = process.argv[4] ?? "normal";
  const seeds = Number(process.argv[5] ?? 3);
  const defenders: Defender[] = defArg === "both" ? ["ai", "human"] : [defArg as Defender];
  const maps = MAPS.filter((m) => mapArg === "all" || m.id === mapArg);
  const diffs: SurvivalDifficulty[] = diffArg === "all" ? ["easy", "normal", "hard"] : [diffArg as SurvivalDifficulty];
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  for (const def of defenders)
    for (const d of diffs) {
      const all: number[] = [];
      for (const m of maps) {
        const runs: SurvivalRun[] = [];
        for (let k = 0; k < seeds; k++) runs.push(survivalRun(m.id, d, 1000 + k * 7919, def));
        const waves = runs.map((r) => r.waves);
        all.push(...waves);
        console.log(
          `${def.padEnd(5)} ${d.padEnd(6)} ${m.id.padEnd(16)} waves ${waves.join(",").padEnd(12)}` +
            ` mean ${(waves.reduce((a, b) => a + b, 0) / waves.length).toFixed(1).padStart(4)}` +
            `  len ${runs.map((r) => r.min.toFixed(1)).join(",")}m  kills ${runs.map((r) => r.kills).join(",")}` +
            `  first spawns ${runs[0]!.spawnTimes.slice(0, 4).map(fmt).join(" ")}`
        );
      }
      all.sort((a, b) => a - b);
      console.log(`${def} ${d}: median ${all[Math.floor(all.length / 2)]} waves (min ${all[0]}, max ${all[all.length - 1]}, n=${all.length})\n`);
    }
}

main();
