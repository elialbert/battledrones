import { afterEach, describe, expect, it } from "vitest";
import { Controller, setLocalSide } from "../src/game/controller";
import { ECONOMY, TICK_RATE, UNITS } from "../src/sim/balance";
import { worldHash } from "../src/sim/checksum";
import { produceUnit } from "../src/sim/economy";
import { step } from "../src/sim/sim";
import { createWorld, spawnBuilding, spawnUnit } from "../src/sim/world";

function setup() {
  const w = createWorld(40, 40);
  spawnBuilding(w, "hq", "blue", 2, 2);
  spawnBuilding(w, "hq", "red", 34, 34);
  const fab = spawnBuilding(w, "fab-plant", "blue", 8, 2);
  spawnBuilding(w, "tech-lab", "blue", 8, 8);
  w.factions.blue.scrap = 10_000;
  return { w, fab, ctrl: new Controller(w) };
}

afterEach(() => setLocalSide("blue"));

describe("unit autobuild", () => {
  const kinds = (q: { kind: string }[]) => q.map((x) => x.kind);
  const count = (q: { kind: string }[], k: string) => q.filter((x) => x.kind === k).length;

  it("fills every free slot behind manual orders", () => {
    const { w, fab, ctrl } = setup();
    produceUnit(w, "blue", fab.id, "mortar");
    ctrl.toggleAutoBuild("stinger");
    const scrap = w.factions.blue.scrap;
    step(w, ctrl.drainCommands());
    expect(kinds(fab.queue)).toEqual(["mortar", ...Array(ECONOMY.maxQueue - 1).fill("stinger")]);
    expect(w.factions.blue.scrap).toBe(scrap - (ECONOMY.maxQueue - 1) * UNITS.stinger.cost);
    expect(ctrl.drainCommands()).toEqual([]);
    fab.queue[0]!.remaining = 1;
    step(w, []);
    step(w, ctrl.drainCommands());
    expect(kinds(fab.queue)).toEqual(Array(ECONOMY.maxQueue).fill("stinger"));
  });

  it("splits the slots evenly between enabled kinds", () => {
    const { w, fab, ctrl } = setup();
    ctrl.toggleAutoBuild("stinger");
    ctrl.toggleAutoBuild("flak-crawler");
    step(w, ctrl.drainCommands());
    expect(fab.queue).toHaveLength(ECONOMY.maxQueue);
    expect(count(fab.queue, "stinger")).toBe(ECONOMY.maxQueue / 2);
    expect(count(fab.queue, "flak-crawler")).toBe(ECONOMY.maxQueue / 2);
  });

  it("rebalances a full queue when another kind is enabled, refunding the surplus and keeping the head", () => {
    const { w, fab, ctrl } = setup();
    ctrl.toggleAutoBuild("stinger");
    step(w, ctrl.drainCommands());
    step(w, []);
    const head = fab.queue[0]!;
    ctrl.toggleAutoBuild("flak-crawler");
    for (let i = 0; i < 20; i++) step(w, ctrl.drainCommands());
    expect(fab.queue[0]).toBe(head);
    expect(fab.queue).toHaveLength(ECONOMY.maxQueue);
    expect(count(fab.queue, "stinger")).toBe(ECONOMY.maxQueue / 2);
    expect(count(fab.queue, "flak-crawler")).toBe(ECONOMY.maxQueue / 2);
    expect(ctrl.drainCommands()).toEqual([]);
  });

  it("leaves other kinds' orders alone and waits for queue space", () => {
    const { w, fab, ctrl } = setup();
    for (let i = 0; i < ECONOMY.maxQueue; i++) produceUnit(w, "blue", fab.id, "mortar");
    ctrl.toggleAutoBuild("stinger");
    ctrl.toggleAutoBuild("flak-crawler");
    expect(ctrl.drainCommands()).toEqual([]);
    fab.queue[0]!.remaining = 1;
    step(w, []);
    step(w, ctrl.drainCommands());
    expect(count(fab.queue, "mortar")).toBe(ECONOMY.maxQueue - 1);
    expect(fab.queue).toHaveLength(ECONOMY.maxQueue);
  });

  it("waits for scrap, spreading what there is across producers", () => {
    const { w, fab, ctrl } = setup();
    const other = spawnBuilding(w, "fab-plant", "blue", 14, 2);
    ctrl.toggleAutoBuild("stinger");
    w.factions.blue.scrap = UNITS.stinger.cost * 2 + 1;
    step(w, ctrl.drainCommands());
    expect(fab.queue).toHaveLength(1);
    expect(other.queue).toHaveLength(1);
    expect(ctrl.drainCommands()).toEqual([]);
  });

  it("turning it off leaves the queued units to finish", () => {
    const { w, fab, ctrl } = setup();
    ctrl.toggleAutoBuild("stinger");
    step(w, ctrl.drainCommands());
    ctrl.toggleAutoBuild("stinger");
    expect(ctrl.isAutoBuilding("stinger")).toBe(false);
    fab.queue[0]!.remaining = 1;
    step(w, ctrl.drainCommands());
    expect(fab.queue).toHaveLength(ECONOMY.maxQueue - 1);
    expect(ctrl.drainCommands()).toEqual([]);
  });

  it("counts production in flight and retries after an order can no longer land", () => {
    const { w, ctrl } = setup();
    ctrl.trackInFlight();
    ctrl.toggleAutoBuild("stinger");
    const first = ctrl.drainCommands();
    expect(first).toHaveLength(ECONOMY.maxQueue);
    expect(ctrl.drainCommands()).toEqual([]);
    ctrl.settled(w.tick); // no longer in flight, but never applied
    expect(ctrl.drainCommands()).toEqual(first);
  });

  it("resumes after losing and rebuilding its producers", () => {
    const { w, fab, ctrl } = setup();
    ctrl.toggleAutoBuild("stinger");
    w.buildings.delete(fab.id);
    expect(ctrl.drainCommands()).toEqual([]);
    const replacement = spawnBuilding(w, "fab-plant", "blue", 20, 2);
    expect(ctrl.drainCommands()[0]).toMatchObject({ buildingId: replacement.id });
  });

  it("fills an anchored Goliath's training queue too, and not its paused one", () => {
    const { w, ctrl } = setup();
    const g = spawnUnit(w, "goliath", "blue", 16, 16);
    g.goliath!.mode = "anchored";
    const bay = spawnBuilding(w, "assembly-bay", "blue", 14, 2);
    ctrl.toggleAutoBuild("trooper");
    step(w, ctrl.drainCommands());
    expect(g.goliath!.queue).toHaveLength(ECONOMY.maxQueue);
    expect(bay.queue).toHaveLength(ECONOMY.maxQueue);
    g.goliath!.mode = "walking";
    expect(ctrl.drainCommands()).toEqual([]);
  });

  it("sends ordinary production commands that replay to the same world", () => {
    const live = setup();
    const replay = setup();
    live.ctrl.toggleAutoBuild("stinger");
    for (let i = 0; i < UNITS.stinger.buildTime * TICK_RATE * 2 + 5; i++) {
      const commands = live.ctrl.drainCommands();
      step(live.w, commands);
      step(replay.w, commands);
    }
    expect(live.w.factions.blue.stats.unitsBuilt).toBe(2);
    expect(live.fab.queue).toHaveLength(ECONOMY.maxQueue);
    expect(worldHash(replay.w)).toBe(worldHash(live.w));
  });

  it("respects the local faction, pause, spectator mode, order locking and game over", () => {
    const { w, ctrl } = setup();
    setLocalSide("red");
    ctrl.toggleAutoBuild("harvester");
    for (const flag of ["paused", "spectator", "locked"] as const) {
      ctrl[flag] = true;
      expect(ctrl.drainCommands()).toEqual([]);
      ctrl[flag] = false;
    }
    expect(ctrl.drainCommands()[0]).toMatchObject({ faction: "red", unit: "harvester" });
    w.winner = "red";
    expect(ctrl.drainCommands()).toEqual([]);
  });
});
