import { describe, expect, it } from "vitest";
import { STRATEGIES, createAiState, tickAi } from "../src/sim/ai/commander";
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
    runWithAi(w, 120, createAiState("balanced"));
    const red = [...w.units.values()].filter((u) => u.faction === "red");
    const redBuildings = [...w.buildings.values()].filter((b) => b.faction === "red");
    expect(red.filter((u) => u.kind === "harvester").length).toBeGreaterThanOrEqual(2);
    expect(redBuildings.some((b) => b.kind === "fab-plant")).toBe(true);
    expect(redBuildings.some((b) => b.kind === "airpad")).toBe(true);
  });

  it("keeps its harvesters mining (economy grows)", () => {
    const w = createSkirmishWorld();
    runWithAi(w, 90, createAiState("balanced"));
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
    const state = createAiState("balanced");
    runWithAi(w, 100, state);
    // park blue wasps mid-map with a red scout beside them: red plainly
    // sees enemy air, and wasps (ground-only weapons) can't kill the scout
    // — nothing dies, no HQ gets razed, the match keeps running
    for (let i = 0; i < 4; i++) spawnUnit(w, "wasp", "blue", 18.5 + i * 0.4, 18.5);
    spawnUnit(w, "scout", "red", 19.5, 19.5);
    let sawFlak = false;
    for (let i = 0; i < 90 * TICK_RATE; i++) {
      step(w, tickAi(w, "red", state));
      if (
        [...w.units.values()].some(
          (u) => u.faction === "red" && u.kind === "flak-crawler"
        )
      )
        sawFlak = true;
    }
    expect(state.seenAir).toBeGreaterThan(1);
    expect(sawFlak).toBe(true);
  });

  it("escalates to assault mode once its army is large", () => {
    const w = createSkirmishWorld();
    const state = createAiState("balanced");
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
    runWithAi(w, 12 * 60, createAiState("balanced"));
    expect(w.winner).toBe("red");
  }, 30000);

  it("every strategy beats a passive opponent inside 15 minutes", () => {
    for (const name of Object.keys(STRATEGIES) as (keyof typeof STRATEGIES)[]) {
      const w = createSkirmishWorld();
      runWithAi(w, 15 * 60, createAiState(name));
      expect(w.winner, `strategy ${name} failed to win`).toBe("red");
    }
  }, 120000);

  it("skyforce fields air units and turrets only — zero ground combat units", () => {
    const w = createSkirmishWorld();
    const state = createAiState("skyforce");
    for (let i = 0; i < 6 * 60 * TICK_RATE && !w.winner; i++) {
      step(w, tickAi(w, "red", state));
      for (const u of w.units.values())
        if (u.faction === "red")
          expect(["harvester", "scout", "wasp", "raptor"]).toContain(u.kind);
    }
    const redBuildings = [...w.buildings.values()].filter((b) => b.faction === "red");
    expect(redBuildings.some((b) => b.kind === "airpad")).toBe(true);
    expect(redBuildings.some((b) => b.kind === "fab-plant")).toBe(false);
    expect(redBuildings.some((b) => b.kind === "turret")).toBe(true);
    // it actually fields an air force
    const air = [...w.units.values()].filter(
      (u) => u.faction === "red" && (u.kind === "wasp" || u.kind === "raptor")
    );
    expect(air.length).toBeGreaterThan(0);
  }, 60000);

  it("AI vs AI reaches a decisive result inside 25 minutes", () => {
    const w = createSkirmishWorld();
    const red = createAiState("rush");
    const blue = createAiState("boom");
    for (let i = 0; i < 25 * 60 * TICK_RATE && !w.winner; i++)
      step(w, [...tickAi(w, "red", red), ...tickAi(w, "blue", blue)]);
    expect(w.winner).not.toBeNull();
  }, 120000);
});
