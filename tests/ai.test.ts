import { describe, expect, it } from "vitest";
import { createAiState, tickAi } from "../src/sim/ai/commander";
import { TICK_RATE } from "../src/sim/balance";
import { createSkirmishWorld } from "../src/sim/map";
import { step } from "../src/sim/sim";
import { spawnUnit } from "../src/sim/world";
import type { World } from "../src/sim/types";

function runWithAi(w: World, seconds: number, state = createAiState()) {
  for (let i = 0; i < seconds * TICK_RATE; i++) {
    if (w.winner) break;
    step(w, tickAi(w, "red", state));
  }
  return state;
}

describe("AI commander", () => {
  it("follows the opening build order: harvesters, fab plant, airpad", () => {
    const w = createSkirmishWorld();
    runWithAi(w, 120);
    const red = [...w.units.values()].filter((u) => u.faction === "red");
    const redBuildings = [...w.buildings.values()].filter((b) => b.faction === "red");
    expect(red.filter((u) => u.kind === "harvester").length).toBeGreaterThanOrEqual(2);
    expect(redBuildings.some((b) => b.kind === "fab-plant")).toBe(true);
    expect(redBuildings.some((b) => b.kind === "airpad")).toBe(true);
  });

  it("keeps its harvesters mining (economy grows)", () => {
    const w = createSkirmishWorld();
    runWithAi(w, 90);
    // it has been spending, so measure gross income: scrap removed from fields
    let fieldScrap = 0;
    for (let i = 0; i < w.scrap.length; i++) fieldScrap += w.scrap[i]!;
    const fresh = createSkirmishWorld();
    let freshScrap = 0;
    for (let i = 0; i < fresh.scrap.length; i++) freshScrap += fresh.scrap[i]!;
    expect(fieldScrap).toBeLessThan(freshScrap);
  });

  it("builds anti-air after spotting enemy air power", () => {
    const w = createSkirmishWorld();
    const state = createAiState();
    runWithAi(w, 100, state);
    // park blue wasps on top of the red base, in plain sight
    for (let i = 0; i < 4; i++) spawnUnit(w, "wasp", "blue", 40.5 + i * 0.3, 8.5);
    runWithAi(w, 90, state);
    const flak = [...w.units.values()].filter(
      (u) => u.faction === "red" && u.kind === "flak-crawler"
    );
    expect(state.seenAir).toBeGreaterThan(1);
    expect(flak.length).toBeGreaterThanOrEqual(1);
  });

  it("escalates to assault mode once its army is large", () => {
    const w = createSkirmishWorld();
    const state = createAiState();
    // hand it a big army
    for (let i = 0; i < 6; i++) {
      spawnUnit(w, "stinger", "red", 38.5 + (i % 3), 8.5 + Math.floor(i / 3));
      spawnUnit(w, "wasp", "red", 34.5 + (i % 3), 8.5 + Math.floor(i / 3));
    }
    runWithAi(w, 10, state);
    expect(state.mode).toBe("assault");
  });

  it("beats a completely passive opponent inside 12 minutes", () => {
    const w = createSkirmishWorld();
    runWithAi(w, 12 * 60);
    expect(w.winner).toBe("red");
  }, 30000);
});
