import { describe, expect, it } from "vitest";
import { HINTS, HintQueue } from "../src/game/hints";

/** Run the queue for `secs` in 0.1 s steps, collecting what it shows. */
function run(q: HintQueue, secs: number, quiet: (t: number) => boolean = () => false): { id: string; t: number }[] {
  const out: { id: string; t: number }[] = [];
  for (let i = 0; i < Math.round(secs * 10); i++) {
    const h = q.update(0.1, quiet(q.now));
    if (h) out.push({ id: h.id, t: Math.round(q.now * 10) / 10 });
  }
  return out;
}

describe("hint queue", () => {
  it("never shows two hints closer than the gap, most important first", () => {
    const q = new HintQueue();
    q.offer({ id: "salvage", msg: "s", priority: HINTS.priority.salvage });
    q.offer({ id: "tut-0", msg: "t", priority: HINTS.priority.tutorial });
    q.offer({ id: "calldowns", msg: "c", priority: HINTS.priority.calldowns });
    const shown = run(q, 40);
    expect(shown.map((s) => s.id)).toEqual(["tut-0", "calldowns", "salvage"]);
    for (let i = 1; i < shown.length; i++) expect(shown[i]!.t - shown[i - 1]!.t).toBeGreaterThanOrEqual(HINTS.gapS - 1e-6);
  });

  it("ignores a duplicate offer while one is waiting, and calls onShow once when shown", () => {
    const q = new HintQueue();
    let shown = 0;
    expect(q.offer({ id: "a", msg: "1", priority: 1, onShow: () => shown++ })).toBe(true);
    expect(q.offer({ id: "a", msg: "2", priority: 1 })).toBe(false);
    expect(q.update(0.1, false)?.msg).toBe("1");
    expect(shown).toBe(1);
    expect(q.size).toBe(0);
  });

  it("holds hints back while quiet (banners, opener cards) and while paused", () => {
    const q = new HintQueue();
    q.offer({ id: "a", msg: "a", priority: 2, ttlS: 60 });
    // quiet for the first 5 s
    const shown = run(q, 8, (t) => t < 5);
    expect(shown.map((s) => s.id)).toEqual(["a"]);
    expect(shown[0]!.t).toBeGreaterThanOrEqual(5);
    // paused: the clock doesn't move, so nothing ages or shows
    q.offer({ id: "b", msg: "b", priority: 2, ttlS: 1 });
    for (let i = 0; i < 100; i++) expect(q.update(0, true)).toBeNull();
    expect(q.has("b")).toBe(true);
  });

  it("drops stale and no-longer-true hints", () => {
    const q = new HintQueue();
    let placing = true;
    q.offer({ id: "first", msg: "x", priority: 2 });
    expect(q.update(0.1, false)?.id).toBe("first");
    // waits behind the gap; the player finishes placing meanwhile
    q.offer({ id: "place", msg: "p", priority: 0, valid: () => placing });
    q.offer({ id: "old", msg: "o", priority: 4, ttlS: 5 });
    run(q, 3);
    placing = false;
    const shown = run(q, 30);
    expect(shown).toEqual([]);
    expect(q.size).toBe(0);
  });

  it("a hint whose condition holds can be re-offered after it was dropped", () => {
    const q = new HintQueue();
    q.offer({ id: "first", msg: "x", priority: 2 });
    q.update(0.1, false);
    let ready = false;
    const offer = () => ready && q.offer({ id: "calldowns", msg: "c", priority: 3, valid: () => ready });
    ready = true;
    offer();
    ready = false;
    run(q, 1);
    expect(q.has("calldowns")).toBe(false);
    ready = true;
    offer();
    const shown = run(q, 15);
    expect(shown.map((s) => s.id)).toEqual(["calldowns"]);
  });
});
