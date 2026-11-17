import { describe, expect, it } from "vitest";
import { pressureOpponent } from "../tools/ai/scenarios";
import { createWith } from "../tools/ai/adapter";
import { capApm } from "../src/sim/ai/apm";
import { TICK_RATE } from "../src/sim/balance";
import { AI_OPENER } from "../src/sim/openers";
import { setupWorld } from "../src/sim/setup";
import { step } from "../src/sim/sim";

describe("paid economy pressure fixture", () => {
  it("retains Brutal's economy while replacing military destinations", () => {
    const w = setupWorld({ map: "riverlands", seed: 1, mutators: [], openers: { blue: AI_OPENER, red: AI_OPENER } });
    const bot = capApm(pressureOpponent("red", "pressure", 0, createWith), 100, 5);
    for (let i = 0; i < 90 * TICK_RATE; i++) step(w, bot.tick(w));
    // Replacing opts.tweak used to discard the preset's twelve-miner target,
    // making this opponent arrive with the economy of a much weaker level.
    const miners = [...w.units.values()].filter(u => u.faction === "red" && u.kind === "harvester");
    expect(miners.length).toBeGreaterThanOrEqual(10);
    expect(w.factions.red.stats.scrapHarvested).toBeGreaterThan(5000);
    expect(w.factions.red.incomeMult).toBe(1);
  });
});
