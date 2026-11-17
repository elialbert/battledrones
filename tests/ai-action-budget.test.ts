import { describe, expect, it } from "vitest";
import { capApm } from "../src/sim/ai/apm";
import type { Command } from "../src/sim/types";
import { createWorld } from "../src/sim/world";
import { TICK_RATE } from "../src/sim/balance";

describe("nested bot action budgets", () => {
  it("reports the strictest enclosing budget without granting more actions", () => {
    const budgets: number[][] = [], receipts: Command[][] = [];
    const commands: Command[] = [0, 1, 2].map(x => ({ type: "move", faction: "blue", unitIds: [x], x, y: 1 }));
    const bot = capApm(capApm({ tick: () => commands,
      actionBudget(apm, burst) { budgets.push([apm, burst]); }, sent(sent) { receipts.push(sent); }
    }, 175, 5), 100, 1);
    expect(budgets).toEqual([[175, 5], [100, 1]]);
    const w = createWorld(16, 16);
    let sent = 0;
    for (w.tick = 0; w.tick < 60 * TICK_RATE; w.tick++) {
      const actual = bot.tick(w);
      sent += actual.length;
      expect(receipts.at(-1)).toEqual(actual);
      expect(sent).toBeLessThanOrEqual(1 + Math.floor(w.tick * 100 / (60 * TICK_RATE)));
    }
    expect(receipts[0]).toHaveLength(1);
  });

  it("preserves an inner cap when the enclosing cap is looser", () => {
    let effective = 0;
    capApm(capApm({ tick: () => [], actionBudget(apm) { effective = apm; } }, 30, 2), 175, 5);
    expect(effective).toBe(30);
  });
});
