import { describe, expect, it } from "vitest";
import { STRATEGIES, createAiState, tickAi } from "../src/sim/ai/commander";
import { planCalldowns } from "../src/sim/ai/powers";
import { OBJECTIVES, POWERS, TICK_RATE, UNITS } from "../src/sim/balance";
import { tickFog } from "../src/sim/fog";
import type { Command, Faction, World } from "../src/sim/types";
import { buildingCenter, createWorld, hqOf, spawnBuilding, spawnUnit } from "../src/sim/world";
import { playMatch } from "../tools/pacing-match";

/**
 * The balance pass's pacing rules (DESIGN.md "Balance & pacing"): the AI
 * gathers real waves and leaves a lull between them, the bar drops late,
 * calldowns are rare big moments, and objectives pay but don't decide.
 */

/** Open ground, two HQs, no fields: red's economy guard holds at its HQ, 9 tiles behind its staging point. */
function field(): World {
  const w = createWorld(48, 48);
  spawnBuilding(w, "hq", "blue", 2, 43);
  spawnBuilding(w, "hq", "red", 43, 2);
  return w;
}

/** A red army of Stingers: `staged` of them at the staging point, `guards` at home. */
function armyAt(w: World, staged: number, guards: number) {
  const c = buildingCenter(hqOf(w, "red")!);
  const far = { x: w.width - c.x, y: w.height - c.y };
  const len = Math.hypot(far.x - c.x, far.y - c.y);
  const stage = { x: c.x + ((far.x - c.x) / len) * 9, y: c.y + ((far.y - c.y) / len) * 9 };
  const ids: number[] = [];
  for (let i = 0; i < staged; i++)
    ids.push(spawnUnit(w, "stinger", "red", stage.x + (i % 3) * 0.7 - 0.7, stage.y + Math.floor(i / 3) * 0.7 - 0.7).id);
  // beside the HQ, on the side away from the staging point
  for (let i = 0; i < guards; i++) spawnUnit(w, "stinger", "red", c.x + 2.2, c.y + 0.5 + i * 0.7);
  return { c, far, stage, ids };
}

/** Did any command send units at the enemy HQ (the wave launching)? */
const launched = (cmds: Command[], far: { x: number; y: number }) =>
  cmds.some(
    (c) => (c.type === "attackMove" || c.type === "move") && Math.hypot(c.x - far.x, c.y - far.y) < 3 && c.faction === "red"
  );

describe("AI waves", () => {
  const assaultAt = STRATEGIES.balanced.assaultValue;
  const per = UNITS.stinger.cost;

  it("holds a wave at the staging point until three quarters of the assault threshold has gathered", () => {
    // 1,800 of army: assault mode. 8 Stingers staged = 1,200, under 75% of 1,700 (the old 60% bar launched it)
    const w = field();
    const p = armyAt(w, 8, 4);
    expect(8 * per).toBeLessThan(assaultAt * 0.75);
    expect(8 * per).toBeGreaterThan(assaultAt * 0.6);
    const s = createAiState("balanced", "normal", 1);
    const cmds = tickAi(w, "red", s);
    expect(s.mode).toBe("assault");
    expect(launched(cmds, p.far)).toBe(false);
  });

  it("launches the whole staged group once it has gathered", () => {
    const w = field();
    const p = armyAt(w, 9, 4); // 1,350 ≥ 1,275
    const s = createAiState("balanced", "normal", 1);
    const cmds = tickAi(w, "red", s);
    expect(s.mode).toBe("assault");
    const wave = cmds.find((c) => c.type === "attackMove" && Math.hypot(c.x - p.far.x, c.y - p.far.y) < 3);
    expect(wave).toBeDefined();
    expect(new Set((wave as { unitIds: number[] }).unitIds)).toEqual(new Set(p.ids));
  });

  it("lowers the bar for an all-in push from 7:00, not before", () => {
    // 11 Stingers = 1,650: short of 1,700 at 7:00, enough at 9:00 (6% a minute off)
    const at = (minutes: number) => {
      const w = field();
      armyAt(w, 7, 4);
      w.tick = minutes * 60 * TICK_RATE;
      const s = createAiState("balanced", "normal", 1);
      tickAi(w, "red", s);
      return s.mode;
    };
    expect(at(7)).toBe("buildup");
    expect(at(9)).toBe("assault");
  });

  it("every personality still waits for a real army (no sub-1,000 trickle waves)", () => {
    for (const st of Object.values(STRATEGIES)) expect(st.assaultValue * 0.75).toBeGreaterThanOrEqual(1000);
  });
});

describe("calldowns stay big moments", () => {
  function clump(n: number): { w: World; cmds: Command[] } {
    const w = createWorld(40, 40);
    spawnBuilding(w, "hq", "blue", 2, 2);
    spawnBuilding(w, "hq", "red", 35, 35);
    for (let i = 0; i < n; i++) spawnUnit(w, "stinger", "blue", 18 + (i % 3) * 0.6, 18 + Math.floor(i / 3) * 0.6);
    tickFog(w);
    w.fog.red.vis.fill(2);
    w.powers.meter.red = 100;
    const s = createAiState("balanced", "normal", 1);
    const red = [...w.units.values()].filter((u) => u.faction === "red");
    const cmds = planCalldowns(w, "red" as Faction, s, {
      mode: "buildup", hqC: { x: 36.5, y: 36.5 }, guardPoint: { x: 33, y: 33 }, enemyHqPos: { x: 3.5, y: 3.5 }, army: red, threats: []
    });
    return { w, cmds };
  }

  it("the AI doesn't spend a Barrage on a handful of Stingers, but shells a real column", () => {
    const small = clump(5); // 750
    expect(small.cmds.some((c) => c.type === "calldown" && c.power === "barrage")).toBe(false);
    const big = clump(6); // 900
    expect(big.cmds.some((c) => c.type === "calldown" && c.power === "barrage")).toBe(true);
  });

  it("the meter is fed by fighting: passive charge alone doesn't buy an EMP in 10 minutes, and losses charge 4× faster than kills", () => {
    expect(POWERS.passive * 600).toBeLessThan(POWERS.emp.cost);
    expect(POWERS.perScrapLost / POWERS.perScrapKilled).toBeGreaterThanOrEqual(4);
    // a held Uplink is a nudge, not a second engine
    expect(OBJECTIVES.uplink.charge).toBeLessThan(POWERS.passive * 2);
  });
});

describe("pacing panel (tools/pacing.ts)", () => {
  it("replays a match identically and its metrics add up", () => {
    const a = playMatch("frostbite", "boom", "rush", 7013, 13);
    const b = playMatch("frostbite", "boom", "rush", 7013, 13);
    expect(b).toEqual(a);
    expect(a.winner).not.toBe("draw");
    // every 10 s window is accounted for, and fights are runs inside it
    expect(a.series.length).toBe(Math.ceil((a.min * 60) / 10));
    for (const f of a.fights) {
      const destroyed = a.series.slice(f.start / 10, f.end / 10).reduce((x, y) => x + y, 0);
      expect(f.destroyed).toBe(destroyed);
      expect(f.destroyed).toBeGreaterThanOrEqual(1000);
    }
    expect(a.bins.reduce((x, y) => x + y, 0)).toBeGreaterThanOrEqual(a.combatBins.reduce((x, y) => x + y, 0));
    expect(a.firstCombatDeath).not.toBeNull();
  }, 30000);
});
