import { describe, expect, it } from "vitest";
import { endOf, setupWorld as recordSetup, worldHash as recordHash } from "../src/arena/record";
import { worldHash } from "../src/sim/checksum";
import { setupWorld } from "../src/sim/setup";
import { step } from "../src/sim/sim";

const SETUP = { map: "riverlands", seed: 42, mutators: [], openers: { blue: "blitz", red: "airwing" } } as const;

describe("resign (sound duels)", () => {
  it("hands the match to the other side on the tick it's applied", () => {
    const w = setupWorld({ ...SETUP, mutators: [] });
    for (let i = 0; i < 20; i++) step(w, []);
    step(w, [{ type: "resign", faction: "red" }]);
    expect(w.winner).toBe("blue");
    expect(w.resigned).toBe("red");
    expect(w.fx).toContainEqual({ type: "resign", faction: "red" });
    const tick = w.tick;
    step(w, []);
    expect(w.tick).toBe(tick); // a decided world stands still on both phones
    expect(endOf(w.tick, w.winner!, w.resigned)).toEqual({ tick, winner: "blue", reason: "resign" });
  });

  it("is a draw when both sides resign on the same tick", () => {
    const w = setupWorld({ ...SETUP, mutators: [] });
    step(w, [
      { type: "resign", faction: "blue" },
      { type: "resign", faction: "red" }
    ]);
    expect(w.winner).toBe("draw");
    expect(w.resigned).toBeNull();
  });

  it("leaves an HQ kill recorded as one", () => {
    expect(endOf(100, "red")).toEqual({ tick: 100, winner: "red", reason: "hq" });
    expect(endOf(100, "draw")).toEqual({ tick: 100, winner: null, reason: "love" });
  });
});

describe("match setup and hashing live in the sim", () => {
  it("are the same functions the battle records use", () => {
    expect(recordSetup).toBe(setupWorld);
    expect(recordHash).toBe(worldHash);
  });

  it("builds the same world every time", () => {
    const a = setupWorld({ ...SETUP, mutators: [] });
    const b = setupWorld({ ...SETUP, mutators: [] });
    expect(worldHash(a)).toBe(worldHash(b));
    for (let i = 0; i < 50; i++) {
      step(a, []);
      step(b, []);
    }
    expect(worldHash(a)).toBe(worldHash(b));
  });
});
