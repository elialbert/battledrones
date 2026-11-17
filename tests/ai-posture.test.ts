import { describe, expect, it } from "vitest";
import { seatMarshal } from "../src/sim/ai/marshal";
import { seenEnemies } from "../src/sim/ai/intel";
import { MARSHAL_PLANS } from "../src/sim/ai/marshal";
import {
  curveAt, newPosture, POSTURE, POSTURE_CURVES, postureReads, reviewPosture,
  type Area, type Posture, type PostureReads, type Shares
} from "../src/sim/ai/posture";
import { TICK_RATE } from "../src/sim/balance";
import { tickFog } from "../src/sim/fog";
import { AI_OPENER } from "../src/sim/openers";
import { setupWorld } from "../src/sim/setup";
import { step } from "../src/sim/sim";
import type { AiState } from "../src/sim/ai/commander";
import { buildingCenter, hqOf, spawnUnit } from "../src/sim/world";

const AREAS: Area[] = ["army", "economy", "tech"];
const sum = (s: Shares) => s.army + s.economy + s.tech;
const quiet: PostureReads = {
  ourArmy: 1000, enemyArmy: 1000, attacked: false, ourDepots: 1, enemyDepots: 1, quietFor: 0,
  teching: false, ourIncome: 20, enemyIncome: 20, enemyDefences: 0, fieldsLow: false
};
/** Thinks every 2 s from `from` for `seconds`, the same reads each time. */
function run(plan: string, reads: Partial<PostureReads> | null, seconds: number, from = 60, start?: Posture): Posture {
  let p = start ?? newPosture(plan, true).posture;
  for (let t = from; t < from + seconds; t += 2) p = reviewPosture(p, plan, t * TICK_RATE, reads && { ...quiet, ...reads });
  return p;
}

describe("plan curves", () => {
  it("cover every Marshal plan, and sum to 1 all game", () => {
    for (const plan of Object.keys(MARSHAL_PLANS)) {
      expect(POSTURE_CURVES[plan], plan).toBeTruthy();
      for (let t = 0; t <= 900; t += 15) expect(sum(curveAt(plan, t))).toBeCloseTo(1, 9);
    }
  });
  it("interpolate between keys, and hold after the last", () => {
    expect(curveAt("balanced", 60).army).toBeCloseTo(0.475, 9);
    expect(curveAt("balanced", 60).economy).toBeCloseTo(0.375, 9);
    expect(curveAt("rush", 0).army).toBe(0.75);
    expect(curveAt("boom", 2000)).toEqual(curveAt("boom", 420));
  });
  it("follow the curve alone with no reads (Easy, Casual)", () => {
    const p = run("boom", null, 200);
    for (const a of AREAS) expect(p[a]).toBeCloseTo(p.base[a], 2);
    expect(p.reasons).toEqual([]);
  });
});

describe("bounds and smoothing", () => {
  const extremes: Partial<PostureReads>[] = [
    { attacked: true },
    { ourArmy: 100, enemyArmy: 5000, teching: true, enemyDepots: 4, quietFor: 200 },
    { ourArmy: 9000, enemyArmy: 900, fieldsLow: true, teching: true, enemyDepots: 4, ourIncome: 50, enemyIncome: 5 }
  ];
  it("never pull a share more than POSTURE.pull off the curve, and always sum to 1", () => {
    for (const plan of Object.keys(POSTURE_CURVES))
      for (const reads of extremes) {
        let p = newPosture(plan, true).posture;
        for (let t = 0; t < 600; t += 2) {
          p = reviewPosture(p, plan, t * TICK_RATE, { ...quiet, ...reads });
          expect(sum(p)).toBeCloseTo(1, 9);
          for (const a of AREAS) {
            expect(p[a]).toBeGreaterThanOrEqual(-1e-9);
            expect(Math.abs(p[a] - p.base[a])).toBeLessThanOrEqual(POSTURE.pull + 1e-6);
          }
        }
      }
  });
  it("move at most POSTURE.step a second, and get there on a sustained read", () => {
    const before = run("balanced", {}, 20);
    const after = reviewPosture(before, "balanced", 80 * TICK_RATE, { ...quiet, attacked: true });
    for (const a of AREAS) expect(Math.abs(after[a] - before[a])).toBeLessThanOrEqual(2 * POSTURE.step + 1e-9);
    const later = run("balanced", { attacked: true }, 30, 80, after);
    expect(later.army).toBeCloseTo(later.target.army, 6);
    expect(later.army - later.base.army).toBeCloseTo(POSTURE.pull, 2);
  });
});

describe("reads", () => {
  it("outnumbered pulls toward army, from tech first", () => {
    const p = run("balanced", { ourArmy: 1000, enemyArmy: 2000 }, 30);
    expect(p.reasons).toContain("outnumbered");
    expect(p.army).toBeGreaterThan(p.base.army + 0.1);
    expect(p.tech).toBeLessThan(p.base.tech);
  });
  it("is graded: a little outnumbered is a little more army", () => {
    const little = run("balanced", { ourArmy: 1700, enemyArmy: 2000 }, 30);
    const lot = run("balanced", { ourArmy: 1000, enemyArmy: 2000 }, 30);
    expect(little.reasons).toContain("outnumbered");
    expect(little.army).toBeGreaterThan(little.base.army);
    expect(little.army).toBeLessThan(lot.army - 0.05);
    expect(run("balanced", { ourArmy: 1850, enemyArmy: 2000 }, 30).reasons).not.toContain("outnumbered");
  });
  it("a glimpse isn't a read", () => {
    expect(run("balanced", { ourArmy: 100, enemyArmy: POSTURE.minRead - 1 }, 30).reasons).not.toContain("outnumbered");
  });
  it("a raid at home overrides the rest", () => {
    const p = run("boom", { attacked: true, ourArmy: 9000, enemyArmy: 900, fieldsLow: true }, 30);
    expect(p.reasons).toEqual(["attacked"]);
    expect(p.army).toBeGreaterThan(p.base.army + 0.2);
  });
});

describe("the greed rule", () => {
  const greedy = { enemyDepots: 3, ourDepots: 1 };
  it("Boom, leaning economy and ahead on it, out-greeds them", () => {
    const p = run("boom", { ...greedy, ourIncome: 30, enemyIncome: 20 }, 30, 0);
    expect(p.lean).toBe("economy");
    expect(p.reasons).toContain("greedy:outgreed");
    expect(p.economy).toBeGreaterThan(p.base.economy);
  });
  it("Rush, leaning army and able to win, closes it out", () => {
    const p = run("rush", { ...greedy, ourArmy: 3000, enemyArmy: 1000, enemyDefences: 1 }, 30, 0);
    expect(p.lean).toBe("army");
    expect(p.reasons).toContain("greedy:closeOut");
    expect(p.army).toBeGreaterThan(p.base.army + 0.05);
  });
  it("Rush into a fortress doesn't close out", () => {
    expect(run("rush", { ...greedy, ourArmy: 3000, enemyArmy: 1000, enemyDefences: 4 }, 30, 0).reasons).toContain("greedy:punish");
  });
  it("Balanced, no lean, punishes the greed with a little more army", () => {
    const p = run("balanced", { ...greedy }, 30);
    expect(p.reasons).toContain("greedy:punish");
    expect(p.army).toBeGreaterThan(p.base.army);
  });
  it("an enemy sitting at home with a small army reads as greedy too", () => {
    expect(run("balanced", { quietFor: POSTURE.quiet, ourArmy: 1200, enemyArmy: 900 }, 10).reasons).toContain("greedy:punish");
    expect(run("balanced", { quietFor: POSTURE.quiet - 1, ourArmy: 1200, enemyArmy: 900 }, 2).reasons).not.toContain("greedy:punish");
  });
});

describe("a lean's commitment", () => {
  it("holds for POSTURE.hold seconds, then follows the shares", () => {
    // Balanced pulled to army by a raid, then the raid ends: the shares slide back, the lean stays a while
    const pulled = run("balanced", { attacked: true }, 30);
    expect(pulled.lean).toBe("army");
    const since = pulled.leanSince;
    const early = run("balanced", {}, since / TICK_RATE + POSTURE.hold - 2 - 90, 90, pulled);
    expect(early.lean).toBe("army");
    expect(early.leanSince).toBe(since);
    const late = run("balanced", {}, POSTURE.hold + 10, 90, pulled);
    expect(late.lean).toBeNull();
  });
});

describe("fog", () => {
  const world = () => setupWorld({ map: "riverlands", seed: 1, mutators: [], openers: { blue: AI_OPENER, red: AI_OPENER } } as any);
  it("reads nothing it can't see: hidden harvesters, tech units and Tech Labs don't count", () => {
    const w = world();
    tickFog(w);
    const red = buildingCenter(hqOf(w, "red")!);
    for (let i = 0; i < 6; i++) spawnUnit(w, "harvester", "red", red.x + 2, red.y + (i % 3));
    spawnUnit(w, "lancer", "red", red.x - 2, red.y);
    tickFog(w);
    const seen = seenEnemies(w, "blue");
    expect(seen.length).toBe(0);
    const { memo } = newPosture("balanced", true);
    const blue = buildingCenter(hqOf(w, "blue")!);
    const reads = postureReads(w, "blue", {} as AiState, memo, {
      seen, armyValue: 0, enemyArmy: 0, threatened: false, home: blue, enemyHome: red, enemyHq: red, focus: null, fieldsLow: false
    });
    expect(reads.teching).toBe(false);
    expect(memo.miners.size).toBe(0);
    expect(reads.enemyDepots).toBe(0);
    expect(reads.quietFor).toBeGreaterThanOrEqual(0);
  });
  it("in a game, a Brutal Marshal doesn't read an enemy army it hasn't seen", () => {
    const w = world();
    const bot = seatMarshal("blue", 7, "brutal", "balanced");
    const red = buildingCenter(hqOf(w, "red")!);
    for (let i = 0; i < 12; i++) spawnUnit(w, "lancer", "red", red.x - 3, red.y + (i % 4) - 2);
    for (let t = 0; t < 30 * TICK_RATE; t++) step(w, bot.tick(w));
    const p = bot.posture!()!;
    expect(p).toBeTruthy();
    expect(p.reasons).not.toContain("outnumbered");
    expect(p.reasons).not.toContain("teching:match");
    expect(p.reasons).not.toContain("teching:hit");
  });
});
