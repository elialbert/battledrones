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
  it("appends replacements behind manual orders only after the queued type finishes", () => {
    const { w, fab, ctrl } = setup();
    produceUnit(w, "blue", fab.id, "stinger");
    produceUnit(w, "blue", fab.id, "mortar");
    ctrl.toggleAutoBuild("stinger");
    expect(ctrl.drainCommands()).toEqual([]);
    fab.queue[0]!.remaining = 1;
    step(w, []);
    const scrap = w.factions.blue.scrap;
    const commands = ctrl.drainCommands();
    expect(commands).toEqual([{ type: "produce", faction: "blue", buildingId: fab.id, unit: "stinger" }]);
    step(w, commands);
    expect(fab.queue.map((q) => q.kind)).toEqual(["mortar", "stinger"]);
    expect(fab.queue[1]!.remaining).toBe(UNITS.stinger.buildTime * TICK_RATE);
    expect(w.factions.blue.scrap).toBe(scrap - UNITS.stinger.cost);
    expect(ctrl.drainCommands()).toEqual([]);
  });

  it("starts an empty queue and turning it off leaves the queued unit to finish", () => {
    const { w, fab, ctrl } = setup();
    ctrl.toggleAutoBuild("stinger");
    step(w, ctrl.drainCommands());
    expect(fab.queue).toHaveLength(1);
    ctrl.toggleAutoBuild("stinger");
    expect(ctrl.isAutoBuilding("stinger")).toBe(false);
    expect(fab.queue).toHaveLength(1);
    fab.queue[0]!.remaining = 1;
    step(w, ctrl.drainCommands());
    expect(fab.queue).toHaveLength(0);
    expect(ctrl.drainCommands()).toEqual([]);
  });

  it("waits for scrap and counts manual orders before spending on autobuild", () => {
    const { w, fab, ctrl } = setup();
    ctrl.toggleAutoBuild("stinger");
    w.factions.blue.scrap = UNITS.stinger.cost - 1;
    expect(ctrl.drainCommands()).toEqual([]);
    w.factions.blue.scrap = UNITS.stinger.cost;
    ctrl.enqueue({ type: "produce", faction: "blue", buildingId: fab.id, unit: "stinger" });
    const commands = ctrl.drainCommands();
    expect(commands).toHaveLength(1);
    step(w, commands);
    expect(w.factions.blue.scrap).toBe(0);
    fab.queue[0]!.remaining = 1;
    step(w, []);
    expect(ctrl.drainCommands()).toEqual([]);
    w.factions.blue.scrap = UNITS.stinger.cost;
    step(w, ctrl.drainCommands());
    expect(fab.queue).toHaveLength(1);
    expect(w.factions.blue.scrap).toBe(0);
  });

  it("waits for queue space and supports multiple enabled kinds without filling the queue", () => {
    const { w, fab, ctrl } = setup();
    for (let i = 0; i < ECONOMY.maxQueue; i++) produceUnit(w, "blue", fab.id, "mortar");
    ctrl.toggleAutoBuild("stinger");
    ctrl.toggleAutoBuild("flak-crawler");
    expect(ctrl.drainCommands()).toEqual([]);
    fab.queue[0]!.remaining = 1;
    step(w, []);
    step(w, ctrl.drainCommands());
    expect(fab.queue).toHaveLength(ECONOMY.maxQueue);
    expect(fab.queue.at(-1)!.kind).toBe("stinger");
    fab.queue[0]!.remaining = 1;
    step(w, []);
    step(w, ctrl.drainCommands());
    expect(fab.queue.at(-1)!.kind).toBe("flak-crawler");
    expect(ctrl.drainCommands()).toEqual([]);
  });

  it("counts production in flight and retries after an order can no longer land", () => {
    const { w, fab, ctrl } = setup();
    ctrl.trackInFlight();
    ctrl.toggleAutoBuild("stinger");
    const first = ctrl.drainCommands();
    expect(first).toHaveLength(1);
    expect(ctrl.drainCommands()).toEqual([]);
    expect(ctrl.drainCommands()).toEqual([]);
    step(w, first);
    ctrl.landed(first);
    expect(ctrl.drainCommands()).toEqual([]);
    fab.queue[0]!.remaining = 1;
    step(w, []);
    const second = ctrl.drainCommands();
    expect(second).toEqual(first);
    ctrl.settled(w.tick); // no longer in flight, but never applied
    expect(ctrl.drainCommands()).toEqual(second);
  });

  it("uses the shortest available queue and resumes after losing and rebuilding a producer", () => {
    const { w, fab, ctrl } = setup();
    const other = spawnBuilding(w, "fab-plant", "blue", 14, 2);
    produceUnit(w, "blue", fab.id, "mortar");
    ctrl.toggleAutoBuild("stinger");
    expect(ctrl.drainCommands()[0]).toMatchObject({ buildingId: other.id });
    w.buildings.delete(fab.id);
    w.buildings.delete(other.id);
    expect(ctrl.drainCommands()).toEqual([]);
    const replacement = spawnBuilding(w, "fab-plant", "blue", 20, 2);
    expect(ctrl.drainCommands()[0]).toMatchObject({ buildingId: replacement.id });
  });

  it("supports a selected anchored Goliath and does not duplicate its paused training queue", () => {
    const { w, ctrl } = setup();
    const g = spawnUnit(w, "goliath", "blue", 16, 16);
    g.goliath!.mode = "anchored";
    spawnBuilding(w, "assembly-bay", "blue", 14, 2);
    ctrl.selectUnits([g.id]);
    ctrl.toggleAutoBuild("trooper");
    const commands = ctrl.drainCommands();
    expect(commands[0]).toMatchObject({ buildingId: g.id, unit: "trooper" });
    step(w, commands);
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
    expect(live.fab.queue).toHaveLength(1);
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
