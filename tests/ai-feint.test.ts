import { describe, expect, it } from "vitest";
import { createAiState, type AiState } from "../src/sim/ai/commander";
import { FEINT, feintHolds, feintPhase, feintTricks, planFeint, type FeintContext } from "../src/sim/ai/feint";
import { MARSHAL_PLANS, MARSHAL_POOL, planFitsMap, planStrategy } from "../src/sim/ai/marshal";
import { TICK_RATE, UNITS } from "../src/sim/balance";
import { MAPS, createMapWorld, mapById } from "../src/sim/maps";
import type { Unit, World } from "../src/sim/types";
import { buildingCenter, hqOf, spawnUnit } from "../src/sim/world";

const SPEC = { from: 240, army: 3000, after: 1700, tricks: 2 };

/** Blue at 4:00 with an army worth the trick around its HQ: Lancers and four quicker Stingers. */
function setup(): { w: World; s: AiState; ctx: FeintContext; army: Unit[] } {
  const w = createMapWorld("dune-sea", { seed: 1 });
  w.tick = SPEC.from * TICK_RATE;
  const s = createAiState("balanced", "brutal", 1, { assaultValue: Infinity, feint: SPEC });
  const hqC = buildingCenter(hqOf(w, "blue")!);
  const foe = buildingCenter(hqOf(w, "red")!);
  const army: Unit[] = [];
  for (let i = 0; i < 12; i++) army.push(spawnUnit(w, "lancer", "blue", hqC.x + 3 + (i % 4), hqC.y + 3 + Math.floor(i / 4)));
  for (let i = 0; i < 4; i++) army.push(spawnUnit(w, "stinger", "blue", hqC.x + 3 + i, hqC.y + 7));
  const ctx: FeintContext = {
    hqC, army, used: new Set(), seen: [], threatened: false, readyAt: 1000, enemyArmy: 0, outweigh: 0, barred: false, focus: null,
    enemyHqPos: foe, field: (leg) => ({ x: foe.x + (leg ? -14 : 8), y: foe.y + (leg ? 14 : 8) })
  };
  return { w, s, ctx, army };
}

/** Plays the trick up to the feint setting out. */
function sendFeint({ w, s, ctx, army }: ReturnType<typeof setup>): void {
  planFeint(w, "blue", s, ctx);
  const stage = feintTricks(s)[0]!.stage;
  for (const u of army) if (!feintHolds(s).has(u.id) || u.kind === "lancer") Object.assign(u, stage);
  ctx.used = new Set(feintHolds(s));
  planFeint(w, "blue", s, ctx);
  expect(feintPhase(s)).toBe("out");
}

describe("The Feint (Marshal)", () => {
  it("is drawn at every level but Brutal, and only it plays the trick", () => {
    for (const [level, pool] of Object.entries(MARSHAL_POOL)) expect(pool.includes("feint")).toBe(level !== "brutal");
    for (const name of Object.keys(MARSHAL_PLANS) as (keyof typeof MARSHAL_PLANS)[])
      expect(!!planStrategy(name).feint).toBe(name === "feint");
  });

  it("is played on maps with room for it: Ashlands and random maps, no smaller, no islands, no free-for-alls", () => {
    expect(MAPS.filter((m) => planFitsMap("feint", m)).map((m) => m.id)).toEqual(["ashlands"]);
    expect(planFitsMap("feint", mapById("random-desert-a1"))).toBe(true);
    for (const m of MAPS) expect(planFitsMap("rush", m)).toBe(true); // (every other plan goes anywhere)
  });

  it("waits for its time, and for an army worth the trick that outweighs theirs", () => {
    const early = setup();
    early.w.tick -= TICK_RATE;
    expect(planFeint(early.w, "blue", early.s, early.ctx)).toEqual([]);
    const small = setup();
    small.ctx.readyAt = 1e6;
    expect(planFeint(small.w, "blue", small.s, small.ctx)).toEqual([]);
    const outweighed = setup();
    outweighed.ctx.outweigh = 1e6;
    expect(planFeint(outweighed.w, "blue", outweighed.s, outweighed.ctx)).toEqual([]);
    expect(feintPhase(outweighed.s)).toBe("wait");
  });

  it("splits off its share, the fastest first, and sends the rest to a staging point clear of the targets", () => {
    const { w, s, ctx, army } = setup();
    const cmds = planFeint(w, "blue", s, ctx);
    expect(feintPhase(s)).toBe("form");
    const t = feintTricks(s)[0]!;
    const total = army.reduce((v, u) => v + UNITS[u.kind].cost, 0);
    expect(t.feintValue).toBeGreaterThanOrEqual(FEINT.share * total);
    expect(t.feintValue).toBeLessThan(0.5 * total);
    expect(t.mainValue + t.feintValue).toBe(total);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toMatchObject({ type: "move", x: t.stage.x, y: t.stage.y });
    expect(feintHolds(s).size).toBe(army.length);
    const quickest = [...army].sort((a, b) => UNITS[b.kind].speed - UNITS[a.kind].speed)[0]!;
    expect((cmds[0] as { unitIds: number[] }).unitIds).not.toContain(quickest.id);
    expect(Math.hypot(t.stage.x - t.feintTo.x, t.stage.y - t.feintTo.y)).toBeGreaterThanOrEqual(FEINT.hide);
  });

  it("springs when the bait is taken: the army's a wave, and the stock waves are back", () => {
    const g = setup();
    sendFeint(g);
    const { w, s, ctx } = g;
    const t = feintTricks(s)[0]!;
    const n = Math.ceil((FEINT.bait * t.feintValue) / UNITS.lancer.cost);
    for (let i = 0; i < n; i++) (ctx.seen as Unit[]).push(spawnUnit(w, "lancer", "red", t.feintTo.x + 1, t.feintTo.y + 1));
    const cmds = planFeint(w, "blue", s, ctx);
    expect(feintPhase(s)).toBe("sprung");
    expect(t.why).toBe("bait");
    expect(s.mode).toBe("assault");
    expect(s.strategy.assaultValue).toBe(SPEC.after);
    expect(s.wave?.ids.length).toBeGreaterThan(0);
    expect(cmds.some((c) => c.type === "attackMove" && c.x === t.mainTo.x && c.y === t.mainTo.y)).toBe(true);
    // (the feint stays ours, pinning them, while the army is the commander's again)
    expect(feintHolds(s).size).toBeGreaterThan(0);
    for (const id of s.wave!.ids) expect(feintHolds(s).has(id)).toBe(false);
  });

  it("goes anyway when its patience runs out", () => {
    const g = setup();
    sendFeint(g);
    g.w.tick += FEINT.patience * TICK_RATE;
    planFeint(g.w, "blue", g.s, g.ctx);
    expect(feintTricks(g.s)[0]!.why).toBe("time");
  });

  it("calls it all off when the base is attacked, and hands everything back", () => {
    const g = setup();
    sendFeint(g);
    g.ctx.threatened = true;
    expect(planFeint(g.w, "blue", g.s, g.ctx)).toEqual([]);
    expect(feintPhase(g.s)).toBe("wait");
    expect(feintHolds(g.s).size).toBe(0);
    expect(feintTricks(g.s)[0]!.why).toBe("called off");
  });

  it("plays no trick where it can't, and doesn't sit on its army: stock waves instead", () => {
    const { w, s, ctx } = setup();
    ctx.barred = true;
    expect(planFeint(w, "blue", s, ctx)).toEqual([]);
    expect(feintPhase(s)).toBe("spent");
    expect(s.strategy.assaultValue).toBe(SPEC.after);
  });

  it("is spent after its tricks, and the stock waves stay on", () => {
    const g = setup();
    sendFeint(g);
    const { w, s, ctx } = g;
    w.tick += FEINT.patience * TICK_RATE;
    planFeint(w, "blue", s, ctx);
    s.strategy = { ...s.strategy, feint: { ...SPEC, tricks: 1 } };
    s.mode = "buildup";
    planFeint(w, "blue", s, ctx);
    expect(feintPhase(s)).toBe("spent");
    expect(s.strategy.assaultValue).toBe(SPEC.after);
  });
});
