import { describe, expect, it } from "vitest";
import { FOG, UNITS } from "../src/sim/balance";
import { isExplored, isVisible, knownBuildings } from "../src/sim/fog";
import { step } from "../src/sim/sim";
import { createWorld, spawnBuilding, spawnUnit } from "../src/sim/world";

const settleFog = (w: ReturnType<typeof createWorld>) => {
  for (let i = 0; i <= FOG.intervalTicks; i++) step(w, []);
};

describe("fog of war", () => {
  it("starts fully unexplored for both sides", () => {
    const w = createWorld(24, 24);
    expect(isExplored(w, "blue", 5, 5)).toBe(false);
    expect(isVisible(w, "red", 5, 5)).toBe(false);
  });

  it("a unit reveals a circle of its sight radius", () => {
    const w = createWorld(24, 24);
    spawnUnit(w, "stinger", "blue", 12.5, 12.5);
    settleFog(w);
    const sight = UNITS.stinger.sight;
    expect(isVisible(w, "blue", 12, 12)).toBe(true);
    expect(isVisible(w, "blue", 12 + sight - 1, 12)).toBe(true);
    expect(isVisible(w, "blue", 12 + sight + 2, 12)).toBe(false);
    // the other side saw nothing
    expect(isVisible(w, "red", 12, 12)).toBe(false);
  });

  it("vacated ground decays to explored, not unexplored", () => {
    const w = createWorld(32, 32);
    const u = spawnUnit(w, "scout", "blue", 5.5, 5.5);
    settleFog(w);
    expect(isVisible(w, "blue", 5, 5)).toBe(true);
    step(w, [{ type: "move", faction: "blue", unitIds: [u.id], x: 28.5, y: 28.5 }]);
    for (let i = 0; i < 100; i++) step(w, []);
    expect(isVisible(w, "blue", 5, 5)).toBe(false);
    expect(isExplored(w, "blue", 5, 5)).toBe(true);
  });

  it("remembers enemy buildings seen, even after leaving", () => {
    const w = createWorld(32, 32);
    spawnBuilding(w, "hq", "red", 10, 10);
    const u = spawnUnit(w, "scout", "blue", 12.5, 14.5);
    settleFog(w);
    expect(knownBuildings(w, "blue").some((b) => b.kind === "hq")).toBe(true);
    step(w, [{ type: "move", faction: "blue", unitIds: [u.id], x: 30.5, y: 30.5 }]);
    for (let i = 0; i < 100; i++) step(w, []);
    // still remembered though no longer visible
    expect(knownBuildings(w, "blue").some((b) => b.kind === "hq")).toBe(true);
  });

  it("forgets a remembered building once its tile is re-seen empty", () => {
    const w = createWorld(32, 32);
    const barn = spawnBuilding(w, "turret", "red", 10, 10);
    spawnUnit(w, "scout", "blue", 12.5, 12.5);
    settleFog(w);
    expect(knownBuildings(w, "blue")).toHaveLength(1);
    w.buildings.delete(barn.id); // razed while we watch
    settleFog(w);
    expect(knownBuildings(w, "blue")).toHaveLength(0);
  });

  it("buildings provide sight too", () => {
    const w = createWorld(24, 24);
    spawnBuilding(w, "hq", "blue", 10, 10);
    settleFog(w);
    expect(isVisible(w, "blue", 11, 8)).toBe(true);
  });
});
