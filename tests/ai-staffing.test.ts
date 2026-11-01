import { describe, expect, it } from "vitest";
import { BUILDINGS, TICK_RATE } from "../src/sim/balance";
import { createMapWorld } from "../src/sim/maps";
import { step } from "../src/sim/sim";
import { hqOf } from "../src/sim/world";
import { seatMarshal } from "../src/sim/ai/marshal";

describe("Marshal's harvesters at an expansion", () => {
  // (Riverlands' (34,47) field is out past the base: ai/fields.ts called its Depot's miners home and
  // ai/expansion.ts sent them straight back, every think, and at 30 APM the build order waited up to 74 s)
  it("aren't traded back and forth between it and home, and the build order isn't held up at 30 APM", () => {
    const w = createMapWorld("riverlands", { seed: 3 });
    const bot = seatMarshal("blue", 3, "normal", "wall");
    const redHq = hqOf(w, "red")!;
    const fields = new Map<number, string[]>();
    let backAgain = 0;
    let waiting = -1;
    let longest = 0;
    for (let i = 0; i < 7 * 60 * TICK_RATE && !w.winner; i++) {
      const cmds = bot.tick(w);
      for (const c of cmds)
        if (c.type === "harvest")
          for (const id of c.unitIds) {
            const to = `${Math.round(c.x)},${Math.round(c.y)}`;
            const was = fields.get(id) ?? [];
            if (was.length >= 2 && was[was.length - 2] === to && was[was.length - 1] !== to) backAgain++;
            fields.set(id, [...was, to]);
          }
      // (nothing going up and scrap to spare, but no start sent: how long)
      const f = w.factions.blue;
      if (cmds.some((c) => c.type === "startBuilding")) waiting = -1;
      else if (!f.pending && f.scrap >= BUILDINGS.turret.cost + 400 && waiting < 0) waiting = i;
      if (waiting >= 0) longest = Math.max(longest, (i - waiting) / TICK_RATE);
      step(w, cmds);
      redHq.hp = BUILDINGS.hq.hp;
    }
    expect(backAgain).toBeLessThanOrEqual(2);
    expect(longest).toBeLessThan(20);
  }, 60000);
});
