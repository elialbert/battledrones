import { describe, expect, it } from "vitest";
import { forwardStage, type AiState } from "../src/sim/ai/commander";
import { AI_OPENER } from "../src/sim/openers";
import { setupWorld } from "../src/sim/setup";
import { buildingCenter, dist, hqOf, passable } from "../src/sim/world";

describe("forward staging point", () => {
  for (const map of ["riverlands", "frostbite", "ashlands"]) {
    it(`gathers waves on our side of ${map}, out past the base, on open ground`, () => {
      const w = setupWorld({ map, seed: 1, mutators: [], openers: { blue: AI_OPENER, red: AI_OPENER } } as any);
      const at = (["blue", "red"] as const).map((side) => {
        const hq = buildingCenter(hqOf(w, side)!);
        const enemy = buildingCenter(hqOf(w, side === "blue" ? "red" : "blue")!);
        const p = forwardStage(w, side, {} as AiState, hq, enemy)!;
        expect(p).toBeTruthy();
        expect(passable(w, Math.floor(p.x), Math.floor(p.y), "ground")).toBe(true);
        expect(dist(p.x, p.y, hq.x, hq.y)).toBeGreaterThan(9);
        expect(dist(p.x, p.y, hq.x, hq.y)).toBeLessThan(dist(p.x, p.y, enemy.x, enemy.y));
        return p;
      });
      // (the sides' points mirror each other: neither side gets the better ground)
      expect(at[0]!.x + at[1]!.x).toBeCloseTo(w.width, 0);
      expect(at[0]!.y + at[1]!.y).toBeCloseTo(w.height, 0);
    });
  }
});
