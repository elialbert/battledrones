/**
 * A replay's seek back (GameScene.seek): the world is put back to a saved
 * copy in place (src/game/restore.ts), and must then play on exactly as the
 * battle did, a free-for-all's knockouts included.
 */
import { describe, expect, it } from "vitest";
import { restoreWorld } from "../src/game/restore";
import { worldHash } from "../src/sim/checksum";
import { createMapWorld } from "../src/sim/maps";
import { step } from "../src/sim/sim";
import type { World } from "../src/sim/types";

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
