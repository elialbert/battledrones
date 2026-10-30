import { describe, expect, it } from "vitest";
import { capApm } from "../src/sim/ai/apm";
import { kiteStep } from "../src/sim/ai/kite";
import { MARSHAL, marshal } from "../src/sim/ai/marshal";
import { TICK_RATE, UNITS } from "../src/sim/balance";
import { step } from "../src/sim/sim";
import type { Command, UnitKind, World } from "../src/sim/types";
import { createWorld, spawnBuilding, spawnUnit } from "../src/sim/world";

const unitsOf = (w: World, f: string) => [...w.units.values()].filter((u) => u.faction === f);

describe("kiting (ai/kite.ts)", () => {
  it("steps Lancers back from Stingers about to reach them, away from the Stingers", () => {
    const w = createWorld(40, 20);
    const ours = [spawnUnit(w, "lancer", "blue", 10, 10), spawnUnit(w, "lancer", "blue", 10, 11)];
    // 4 tiles off: inside a Lancer's 5.5, 0.8 outside a Stinger's 3.2
    const theirs = [spawnUnit(w, "stinger", "red", 14, 10.5)];
    const s = kiteStep(w, ours, theirs, null)!;
    expect(s.ids.sort()).toEqual(ours.map((u) => u.id).sort());
    expect(s.x).toBeLessThan(10);
  });

  it("leaves them be while the Stingers are still far off", () => {
    const w = createWorld(40, 20);
    const ours = [spawnUnit(w, "lancer", "blue", 10, 10)];
    expect(kiteStep(w, ours, [spawnUnit(w, "stinger", "red", 16, 10)], null)).toBeNull();
  });

  it("doesn't kite what outranges it, what it can't hurt, or what's much faster", () => {
    const w = createWorld(40, 20);
    const lancer = [spawnUnit(w, "lancer", "blue", 10, 10)];
    expect(kiteStep(w, lancer, [spawnUnit(w, "lancer", "red", 14, 10)], null)).toBeNull();
    expect(kiteStep(w, lancer, [spawnUnit(w, "wasp", "red", 13, 10)], null)).toBeNull();
    const flak = [spawnUnit(w, "flak-crawler", "blue", 10, 15)];
    expect(kiteStep(w, flak, [spawnUnit(w, "stinger", "red", 13.5, 15)], null)).toBeNull();
  });

  it("doesn't back off from a Stinger busy with our Mastodon in front", () => {
    const w = createWorld(40, 20);
    const ours = [spawnUnit(w, "lancer", "blue", 10, 10), spawnUnit(w, "mastodon", "blue", 13, 10)];
    expect(kiteStep(w, ours, [spawnUnit(w, "stinger", "red", 14.5, 10)], null)).toBeNull();
  });

  it("keeps running from a slow Mastodon even once it's in range", () => {
    const w = createWorld(40, 20);
    const ours = [spawnUnit(w, "lancer", "blue", 10, 10)];
    expect(kiteStep(w, ours, [spawnUnit(w, "mastodon", "red", 13, 10)], null)).not.toBeNull();
  });

  it("Hard Marshal's Lancers kite a cost-equal Stinger charge and come out ahead", () => {
    const fight = (kite: boolean) => {
      const w = createWorld(80, 40);
      spawnBuilding(w, "hq", "blue", 2, 17);
      spawnBuilding(w, "hq", "red", 75, 17);
      const army = (kind: UnitKind, f: "blue" | "red", x: number) =>
        Array.from({ length: Math.round(1800 / UNITS[kind].cost) }, (_, i) => spawnUnit(w, kind, f, x + (i % 3) * 0.9, 17 + Math.floor(i / 3) * 0.9).id);
      const A = army("lancer", "blue", 24);
      const B = army("stinger", "red", 50);
      const M = MARSHAL.hard;
      const bot = capApm(marshal("blue", 1, "hard", { ...M, strategy: "balanced", fight: { ...M.fight, kite } }), M.apm, M.burst);
      for (let t = 0; t < 120 * TICK_RATE && unitsOf(w, "blue").length && unitsOf(w, "red").length; t++) {
        const cmds: Command[] =
          t === 0
            ? [
                { type: "attackMove", faction: "red", unitIds: B, x: 4, y: 18 },
                { type: "attackMove", faction: "blue", unitIds: A, x: 40, y: 18 }
              ]
            : [];
        step(w, [...cmds, ...bot.tick(w)]);
      }
      return unitsOf(w, "blue").reduce((s, u) => s + u.hp, 0) - unitsOf(w, "red").reduce((s, u) => s + u.hp, 0);
    };
    // (standing still, six Lancers lose to twelve Stingers)
    expect(fight(false)).toBeLessThan(0);
    expect(fight(true)).toBeGreaterThan(0);
  });
});
