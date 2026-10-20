import { describe, expect, it } from "vitest";
import { replay } from "../src/arena/record";
import { applyOpenersCanonical, composeTick } from "../src/game/local-side";
import { MatchRecorder } from "../src/game/recorder";
import { createAiState, tickAi, type AiState } from "../src/sim/ai/commander";
import { worldHash } from "../src/sim/checksum";
import { createMapWorld, type MatchOptions } from "../src/sim/maps";
import { OPS, opAiState, opById } from "../src/sim/ops";
import { allowedOpener, pickAiOpener } from "../src/sim/openers";
import { step } from "../src/sim/sim";
import type { Faction } from "../src/sim/types";

/**
 * A match the way GameScene plays one it set up itself: the world from its
 * MatchOptions, the openers dealt before tick 0, then each tick both
 * commanders' commands (blue's first) stepped and handed to the recorder.
 * The record must replay to the same world, hash for hash.
 */
function play(map: string, opts: MatchOptions, ticks: number, o: { blue?: AiState | null; red?: AiState | null; openers?: boolean } = {}) {
  const w = createMapWorld(map, opts);
  const blue = o.blue ?? null;
  const red = o.red ?? null;
  const rec = new MatchRecorder(w.mapId, opts, { blue: { player: blue ? "ai" : "none" }, red: { player: red ? "ai" : "none" } });
  if (o.openers) {
    const picks: Partial<Record<Faction, ReturnType<typeof pickAiOpener>>> = {};
    for (const [f, s] of [["blue", blue], ["red", red]] as const) {
      const pick = s && allowedOpener(w, f, pickAiOpener(s.strategy.name, w.seed, f));
      if (pick) picks[f] = pick;
    }
    applyOpenersCanonical(w, picks);
    rec.setOpeners(picks);
  }
  while (w.tick < ticks && !w.winner) {
    const cmds = composeTick("blue", blue ? tickAi(w, "blue", blue) : [], red ? tickAi(w, "red", red) : []);
    step(w, cmds);
    rec.stepped(w, cmds);
  }
  return { w, record: rec.record(w) };
}

/** The record replays to the world it was made from. */
function replaysExactly({ w, record }: ReturnType<typeof play>) {
  const json = JSON.parse(JSON.stringify(record));
  const r = replay(json);
  expect(r.divergedAt).toBeNull();
  expect(r.checked).toBeGreaterThan(0);
  expect(r.world.tick).toBe(w.tick);
  expect(worldHash(r.world)).toBe(worldHash(w));
}

describe("a match played here, as a battle record (Copy replay JSON)", () => {
  it("a skirmish against a Hard AI: openers, the AI's income handicap, mutators", () => {
    const m = play("riverlands", { seed: 1234, objectives: true, mutators: ["rapidfab"] }, 1200, {
      blue: createAiState("rush", "normal", 7),
      red: createAiState("balanced", "hard", 8),
      openers: true
    });
    expect(m.record.income).toEqual({ red: 1.3 });
    expect(m.record.mutators).toEqual(["rapidfab"]);
    expect(Object.keys(m.record.openers).sort()).toEqual(["blue", "red"]);
    expect(m.record.turns.length).toBeGreaterThan(10);
    expect(m.record.hashes.length).toBe(12);
    replaysExactly(m);
  });

  it("an AI vs AI match played to its end has its end", () => {
    const m = play("proving-grounds", { seed: 99, objectives: true }, 9000, {
      blue: createAiState("rush", "hard", 1),
      red: createAiState("boom", "easy", 2),
      openers: true
    });
    if (m.w.winner) expect(m.record.end).toMatchObject({ tick: m.w.tick, reason: expect.any(String) });
    else expect(m.record.end).toBeNull();
    replaysExactly(m);
  });

  it("a Last Stand: the waves come again the same way", () => {
    const m = play("riverlands", { seed: 42, survival: { difficulty: "hard" } }, 2400, { blue: createAiState(undefined, "normal", 3) });
    expect(m.record.survival).toEqual({ difficulty: "hard" });
    expect(m.w.survival).toBeTruthy();
    replaysExactly(m);
  });

  for (const op of OPS)
    it(`op ${op.id}: its own setup and enemy`, () => {
      const def = opById(op.id)!;
      const m = play(def.map, { seed: 5, op: op.id }, 900, { blue: createAiState(undefined, "normal", 4), red: opAiState(def, 6) });
      expect(m.record.op).toBe(op.id);
      replaysExactly(m);
    });
});
