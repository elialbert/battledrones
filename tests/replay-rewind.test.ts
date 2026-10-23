/**
 * A replay's seek back (GameScene.seek): the world is put back to a saved
 * copy in place (src/game/restore.ts), and must then play on exactly as the
 * battle did, a free-for-all's knockouts included.
 */
import { describe, expect, it } from "vitest";
import { Chronicle } from "../src/game/chronicle";
import { restoreWorld } from "../src/game/restore";
import { createAiState, tickAi } from "../src/sim/ai/commander";
import { sidesOf } from "../src/sim/sides";
import { worldHash } from "../src/sim/checksum";
import { createMapWorld } from "../src/sim/maps";
import { step } from "../src/sim/sim";
import type { Command, World } from "../src/sim/types";

const run = (w: World, ticks: number) => {
  for (let i = 0; i < ticks; i++) step(w, []);
};

describe("a replay rewound past a knockout", () => {
  it("plays on as the battle did: the knockout is undone with the rest", () => {
    const w = createMapWorld("compass-rose", { seed: 3, objectives: true });
    run(w, 200);
    const saved = structuredClone(w);
    // green goes out (a free-for-all's resign knocks the side out), and its army with it
    step(w, [{ type: "resign", faction: "green" }]);
    run(w, 50);
    expect(w.out?.map((o) => o.faction)).toEqual(["green"]);
    const later = structuredClone(w);

    restoreWorld(w, saved);
    expect(w.out).toBeUndefined();
    expect(w.tick).toBe(200);
    const twin = structuredClone(saved);
    run(w, 300);
    run(twin, 300);
    expect(worldHash(w)).toBe(worldHash(twin));
    expect([...w.units.values()].some((u) => u.faction === "green")).toBe(true);

    // (as the seek did it before: the knockout list stayed, and green's army fell from the keyframe on)
    Object.assign(later, structuredClone(saved));
    expect(later.out?.map((o) => o.faction)).toEqual(["green"]);
    run(later, 300);
    expect(worldHash(later)).not.toBe(worldHash(twin));
  });

  it("keeps the same World object, so the scene and its presenters keep theirs", () => {
    const w = createMapWorld("riverlands", { seed: 1, objectives: true });
    const saved = structuredClone(w);
    run(w, 20);
    const same = w;
    restoreWorld(w, saved);
    expect(w).toBe(same);
    expect(worldHash(w)).toBe(worldHash(saved));
  });
});

describe("the report's chronicle, rewound with a replay", () => {
  it("ends as it would have with no rewind: nothing played twice is counted twice", () => {
    const w = createMapWorld("compass-rose", { seed: 5, objectives: true });
    const ais = Object.fromEntries(sidesOf(w).map((f, i) => [f, createAiState("rush", "normal", 40 + i)]));
    const c = new Chronicle(w);
    const turns = new Map<number, Command[]>();
    // (a tick as GameScene plays it: the step, its events to the chronicle, the chronicle's sample)
    const tick = (cmds: Command[]) => {
      step(w, cmds);
      for (const ev of w.fx) c.onFx(ev);
      c.tick();
    };
    let saved: World | null = null;
    let kept = c.snapshot();
    for (let t = 0; t < 4000; t++) {
      const cmds = sidesOf(w).flatMap((f) => tickAi(w, f, ais[f]!));
      turns.set(w.tick, cmds);
      tick(cmds);
      if (w.tick === 2400) {
        saved = structuredClone(w);
        kept = c.snapshot();
      }
    }
    const straight = c.snapshot();
    expect(straight.deaths.length).toBeGreaterThan(20);

    restoreWorld(w, saved!);
    c.restore(kept);
    expect(c.samples.at(-1)!.t).toBe(240);
    while (w.tick < 4000) tick(turns.get(w.tick)!);
    expect(c.snapshot()).toEqual(straight);
  }, 60_000);
});
