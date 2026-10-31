import { describe, expect, it } from "vitest";
import { createAiState, tickAi, type AiState } from "../src/sim/ai/commander";
import { STRIKE, strikePhase } from "../src/sim/ai/hornets";
import { MARSHAL_PLANS, planStrategy } from "../src/sim/ai/marshal";
import { BUILDINGS, TICK_RATE } from "../src/sim/balance";
import { canPlaceBuilding } from "../src/sim/economy";
import { createMapWorld } from "../src/sim/maps";
import { step } from "../src/sim/sim";
import type { BuildingKind, Command, Unit, World } from "../src/sim/types";
import { buildingCenter, hqOf, spawnBuilding, spawnUnit } from "../src/sim/world";

function runRed(w: World, secs: number, s: AiState, each?: (cmds: Command[]) => void): void {
  const blueHq = hqOf(w, "blue");
  if (blueHq) blueHq.hp = 1e9;
  for (let i = 0; i < secs * TICK_RATE && !w.winner; i++) {
    const c = tickAi(w, "red", s);
    each?.(c);
    step(w, c);
  }
}

function placeNear(w: World, kind: BuildingKind, x: number, y: number): void {
  const size = BUILDINGS[kind].size;
  let best: [number, number] | null = null;
  let bestD = Infinity;
  for (let ty = 0; ty < w.height; ty++)
    for (let tx = 0; tx < w.width; tx++) {
      const d = Math.hypot(tx + size / 2 - x, ty + size / 2 - y);
      if (d < bestD && canPlaceBuilding(w, "red", kind, tx, ty)) {
        bestD = d;
        best = [tx, ty];
      }
    }
  spawnBuilding(w, kind, "red", best![0], best![1]);
}

/** A Hornet Strike commander for red on Riverlands (HQs in opposite corners). */
function strikeWorld(strike = true) {
  const w = createMapWorld("riverlands");
  const ai = createAiState("airswarm", "normal", 1, planStrategy("strike"));
  if (strike) ai.hornetStyle = MARSHAL_PLANS.strike.hornets;
  const c = buildingCenter(hqOf(w, "red")!);
  return { w, ai, c };
}

describe("the Hornet strike (Marshal's Hornet Strike)", () => {
  it("has the Airpads build Hornets before anything else till there's a wing", () => {
    const hornetsOrdered = (strike: boolean) => {
      const { w, ai, c } = strikeWorld(strike);
      for (const k of ["airpad", "airpad", "tech-lab", "fab-plant"] as const) placeNear(w, k, c.x - 4, c.y + 3);
      // (800 for two Hornets, and the next Depot: it jumps the order, commander.ts nextBuilding)
      w.factions.red.scrap = 800 + BUILDINGS.depot.cost;
      w.tick = 120 * TICK_RATE;
      const cmds = tickAi(w, "red", ai);
      return cmds.filter((x) => x.type === "produce" && x.unit === "hornet").length;
    };
    expect(hornetsOrdered(true)).toBe(2);
    expect(hornetsOrdered(false)).toBeLessThan(2);
  });

  it("hides a wing by a far corner, then bombs their HQ once their army comes at ours", () => {
    const { w, ai, c } = strikeWorld();
    const blueHq = hqOf(w, "blue")!;
    const target = buildingCenter(blueHq);
    const wing: Unit[] = [];
    for (let i = 0; i < STRIKE.wing; i++) wing.push(spawnUnit(w, "hornet", "red", c.x + 2 + (i % 3), c.y + 2 + Math.floor(i / 3)));
    runRed(w, 60, ai);
    expect(strikePhase(ai)).toBe("park");
    // out by the map's edge, well away from both HQs
    const at = wing[0]!;
    expect(Math.min(at.x, at.y, w.width - at.x, w.height - at.y)).toBeLessThanOrEqual(STRIKE.inset + 2);
    expect(Math.hypot(at.x - target.x, at.y - target.y)).toBeGreaterThan(15);
    expect(Math.hypot(at.x - c.x, at.y - c.y)).toBeGreaterThan(15);
    // their army on our half: the wing goes for their HQ
    for (let i = 0; i < 6; i++) spawnUnit(w, "stinger", "blue", c.x - 6 + (i % 3), c.y + 7 + Math.floor(i / 3));
    const orders: Command[] = [];
    runRed(w, 4, ai, (cmds) => orders.push(...cmds));
    expect(strikePhase(ai)).toBe("strike");
    const ids = new Set(wing.map((u) => u.id));
    const toHq = orders.filter(
      (o) =>
        (o.type === "attack" && o.targetId === blueHq.id) ||
        (o.type === "move" && Math.hypot(o.x - target.x, o.y - target.y) < 3)
    );
    expect(toHq.some((o) => "unitIds" in o && o.unitIds.every((id) => ids.has(id)))).toBe(true);
    // …and no other tactic sends a Hornet of the wing anywhere else
    for (const o of orders)
      if ("unitIds" in o && o.unitIds.some((id) => ids.has(id))) expect(toHq).toContain(o);
  }, 30000);
});
