import { afterEach, describe, expect, it } from "vitest";
import { Controller, setLocalSide } from "../src/game/controller";
import { TICK_RATE, UNITS } from "../src/sim/balance";
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

  it("keeps the producer building one at a time, without stacking a queue", () => {
    const { w, fab, ctrl } = setup();
    ctrl.toggleAutoBuild("stinger");
    const scrap = w.factions.blue.scrap;
    step(w, ctrl.drainCommands());
    expect(kinds(fab.queue)).toEqual(["stinger"]);
    expect(w.factions.blue.scrap).toBe(scrap - UNITS.stinger.cost);
    expect(ctrl.drainCommands()).toEqual([]);
    fab.queue[0]!.remaining = 1;
    step(w, []);
    expect(fab.queue).toHaveLength(0);
    step(w, ctrl.drainCommands());
    expect(kinds(fab.queue)).toEqual(["stinger"]);
  });

  it("waits behind manual orders, then picks up", () => {
    const { w, fab, ctrl } = setup();
    produceUnit(w, "blue", fab.id, "mortar");
    ctrl.toggleAutoBuild("stinger");
    expect(ctrl.drainCommands()).toEqual([]);
    fab.queue[0]!.remaining = 1;
    step(w, []);
    step(w, ctrl.drainCommands());
    expect(kinds(fab.queue)).toEqual(["stinger"]);
  });

  it("alternates enabled kinds, the one with fewest in the field first", () => {
    const { w, fab, ctrl } = setup();
    const other = spawnBuilding(w, "fab-plant", "blue", 14, 2);
    spawnUnit(w, "stinger", "blue", 20, 20);
    ctrl.toggleAutoBuild("stinger");
    ctrl.toggleAutoBuild("flak-crawler");
    step(w, ctrl.drainCommands());
    expect(kinds(fab.queue)).toEqual(["flak-crawler"]);
    expect(kinds(other.queue)).toEqual(["stinger"]);
  });

  it("spreads short scrap across producers", () => {
    const { w, fab, ctrl } = setup();
    const other = spawnBuilding(w, "fab-plant", "blue", 14, 2);
    ctrl.toggleAutoBuild("stinger");
    w.factions.blue.scrap = UNITS.stinger.cost + 1;
    step(w, ctrl.drainCommands());
    expect(fab.queue.length + other.queue.length).toBe(1);
    expect(ctrl.drainCommands()).toEqual([]);
  });

  it("turning it off cancels its queued units (refunded), all but the one in production", () => {
    const { w, fab, ctrl } = setup();
    for (const k of ["stinger", "stinger", "mortar", "stinger", "stinger"] as const) produceUnit(w, "blue", fab.id, k);
    ctrl.toggleAutoBuild("stinger");
    expect(ctrl.drainCommands()).toEqual([]);
    const scrap = w.factions.blue.scrap;
    ctrl.toggleAutoBuild("stinger");
    expect(ctrl.isAutoBuilding("stinger")).toBe(false);
    step(w, ctrl.drainCommands());
    expect(kinds(fab.queue)).toEqual(["stinger", "mortar"]);
    expect(w.factions.blue.scrap).toBe(scrap + 3 * UNITS.stinger.cost);
    expect(ctrl.drainCommands()).toEqual([]);
  });

  it("turning it off cancels an order still in flight (it isn't in production yet)", () => {
    const { w, fab, ctrl } = setup();
    ctrl.trackInFlight();
    ctrl.toggleAutoBuild("stinger");
    const sent = ctrl.drainCommands();
    expect(sent).toHaveLength(1);
    ctrl.toggleAutoBuild("stinger");
    step(w, [...sent, ...ctrl.drainCommands()]);
    expect(fab.queue).toHaveLength(0);
  });

  it("counts production in flight and retries after an order can no longer land", () => {
    const { w, ctrl } = setup();
    ctrl.trackInFlight();
    ctrl.toggleAutoBuild("stinger");
    const first = ctrl.drainCommands();
    expect(first).toHaveLength(1);
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
    ctrl.toggleAutoBuild("harvester");
    step(w, ctrl.drainCommands());
    expect(g.goliath!.queue).toHaveLength(1);
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
