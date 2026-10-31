import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocalSide } from "../src/game/controller";
import { HINTS, HintQueue } from "../src/game/hints";
import { createTutorial } from "../src/ui/tutorial";
import { createWorld, spawnBuilding, spawnUnit } from "../src/sim/world";

function setup(opts: { done?: boolean; blocked?: boolean; spectator?: boolean; ops?: boolean } = {}) {
  setLocalSide("blue");
  const store = new Map<string, string>(opts.done ? [["battledrones.tutorial", "done"]] : []);
  const setItem = vi.fn((k: string, v: string) => { if (opts.blocked) throw Error("blocked"); store.set(k, v); });
  vi.stubGlobal("localStorage", { getItem: (k: string) => { if (opts.blocked) throw Error("blocked"); return store.get(k) ?? null; }, setItem });
  const world = createWorld(64, 64);
  if (opts.ops) world.ops = {} as NonNullable<typeof world.ops>;
  let seconds = 0;
  const hints = new HintQueue();
  const tutorial = createTutorial({ world, spectator: opts.spectator ?? false, matchSeconds: () => seconds }, hints);
  return { world, hints, store, setItem, offer: (s: number) => { seconds = s; tutorial.update(); }, show: () => hints.update(HINTS.gapS, false) };
}

afterEach(() => { vi.unstubAllGlobals(); setLocalSide("blue"); });

describe("first-run tutorial", () => {
  it.each([{ done: true }, { blocked: true }, { spectator: true }, { ops: true }])("skips when %j", (opts) => {
    const f = setup(opts);
    f.offer(500);
    expect(f.hints.size).toBe(0);
    expect(f.setItem).not.toHaveBeenCalled();
  });

  it("starts strictly after four seconds and waits for Fab Plant before advancing", () => {
    const f = setup();
    f.offer(4); expect(f.show()).toBeNull();
    f.offer(4.01); f.offer(10); expect(f.hints.size).toBe(1);
    const h = f.show();
    expect(h).toMatchObject({ id: "tut-0", priority: HINTS.priority.tutorial, ttlS: 600 });
    expect(h?.msg).toContain("Open Base");
    f.offer(40); expect(f.show()).toBeNull();
    spawnBuilding(f.world, "airpad", "blue", 5, 5);
    f.offer(40); expect(f.show()).toBeNull();
    spawnBuilding(f.world, "fab-plant", "blue", 10, 5);
    f.offer(40); expect(f.show()?.id).toBe("tut-1");
    expect(f.setItem).not.toHaveBeenCalled();
  });

  it.each([false, true])("uses opener wording and skips factory lesson (army: %s)", (army) => {
    const f = setup();
    spawnBuilding(f.world, "airpad", "blue", 5, 5);
    if (army) spawnUnit(f.world, "wasp", "blue", 10, 10);
    f.offer(5);
    expect(f.show()?.msg).toContain(army ? "Tap a unit (or" : "Train tanks in Vehicles");
    for (let i = 0; i < 3; i++) spawnUnit(f.world, "stinger", "blue", 10 + i, 10);
    f.offer(30); expect(f.show()).toBeNull();
    f.offer(31); expect(f.show()?.id).toBe("tut-2");
  });

  it("discards stale opener wording and only advances when the replacement is shown", () => {
    const f = setup();
    f.offer(5);
    spawnBuilding(f.world, "fab-plant", "blue", 5, 5);
    spawnUnit(f.world, "stinger", "blue", 10, 10);
    expect(f.hints.update(0, true)).toBeNull();
    expect(f.hints.size).toBe(0);
    f.offer(6);
    expect(f.show()?.msg).toContain("Tap a unit (or");
    f.offer(40); expect(f.show()).toBeNull(); // fewer than three army units
    spawnUnit(f.world, "harvester", "blue", 10, 10);
    spawnUnit(f.world, "condor", "blue", 10, 10);
    spawnUnit(f.world, "stinger", "red", 10, 10);
    f.offer(40); expect(f.show()).toBeNull();
    spawnUnit(f.world, "stinger", "blue", 11, 10);
    spawnUnit(f.world, "stinger", "blue", 12, 10);
    f.offer(40); expect(f.show()?.id).toBe("tut-2");
  });

  it.each(["shown", "already-built", "built-while-waiting"])("persists completion at the proper moment: %s", (finish) => {
    const f = setup();
    spawnBuilding(f.world, "fab-plant", "blue", 5, 5);
    for (let i = 0; i < 3; i++) spawnUnit(f.world, "stinger", "blue", 10 + i, 10);
    f.offer(5); f.show(); f.offer(31); f.show();
    f.offer(150); expect(f.hints.size).toBe(0);
    if (finish === "already-built") spawnBuilding(f.world, "tech-lab", "blue", 15, 15);
    f.offer(151);
    if (finish === "already-built") expect(f.hints.size).toBe(0);
    else {
      expect(f.store.has("battledrones.tutorial")).toBe(false);
      if (finish === "shown") expect(f.show()?.id).toBe("tut-3");
      else {
        spawnBuilding(f.world, "tech-lab", "blue", 15, 15);
        expect(f.show()).toBeNull(); // stale Tech Lab advice is rejected
        f.offer(152);
      }
    }
    expect(f.store.get("battledrones.tutorial")).toBe("done");
    expect(f.setItem).toHaveBeenCalledTimes(1);
    f.offer(200); expect(f.show()).toBeNull();
  });

  it("uses the shared queue's pause, priority and expiry rules", () => {
    const f = setup();
    f.offer(5);
    f.hints.offer({ id: "placement", msg: "place", priority: HINTS.priority.placement });
    for (let i = 0; i < 100; i++) expect(f.hints.update(0, true)).toBeNull();
    expect(f.hints.now).toBe(0);
    expect(f.show()?.id).toBe("placement");
    f.offer(6); expect(f.hints.size).toBe(1);
    expect(f.show()?.id).toBe("tut-0");
  });
});
