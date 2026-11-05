import { describe, expect, it } from "vitest";
import { DOCTRINE, doctrineUnit, readEnemy, reviewDoctrine, underDoctrine, type DoctrineState, type Seen } from "../src/sim/ai/doctrine";
import { MARSHAL, marshalStrategy } from "../src/sim/ai/marshal";
import { UNITS } from "../src/sim/balance";
import type { UnitKind } from "../src/sim/types";

const army = (...kinds: [UnitKind, number][]): Seen[] =>
  kinds.flatMap(([kind, n]) => Array.from({ length: n }, () => ({ kind, value: UNITS[kind].cost })));
const R = 10;
const armour = (since = 0): DoctrineState => ({ name: "armour", since, turn: {} });
const stingers = army(["stinger", 12]);

describe("reading the enemy army", () => {
  it("answers an air force with guns that shoot up", () => {
    expect(readEnemy(army(["wasp", 6], ["stinger", 4]))).toBe("armour");
  });
  it("takes to the air over a ground army with no anti-air", () => {
    expect(readEnemy(stingers)).toBe("air");
  });
  it("brings Rocket Squads to heavy armour that has anti-air by it", () => {
    expect(readEnemy(army(["mastodon", 4], ["flak-crawler", 5], ["stinger", 2]))).toBe("rockets");
  });
  it("says nothing on a glimpse, or on an army with no clear answer", () => {
    expect(readEnemy(army(["stinger", 2]))).toBeNull();
    expect(readEnemy(army(["flak-crawler", 6], ["stinger", 6]))).toBeNull();
  });
});

describe("a doctrine's commitment", () => {
  const plan = { from: DOCTRINE.from };
  it("waits for its start time", () => {
    expect(reviewDoctrine(undefined, plan, (DOCTRINE.from - 1) * R, R, stingers)).toBeUndefined();
    expect(reviewDoctrine(undefined, plan, DOCTRINE.from * R, R, stingers)?.name).toBe("air");
  });
  it("stands for its hold, then changes on a new read", () => {
    const start = DOCTRINE.from * R;
    const d = armour(start);
    expect(reviewDoctrine(d, plan, start + (DOCTRINE.hold - 1) * R, R, stingers)).toBe(d);
    expect(reviewDoctrine(d, plan, start + DOCTRINE.hold * R, R, stingers)?.name).toBe("air");
  });
  it("stays put on a read that says nothing, and reports only real changes", () => {
    const d = armour();
    const log: string[] = [];
    const p = { ...plan, onSwitch: (n: string) => log.push(n) };
    const late = (DOCTRINE.from + DOCTRINE.hold) * R;
    expect(reviewDoctrine(d, p, late, R, [])).toBe(d);
    expect(reviewDoctrine(d, p, late, R, army(["wasp", 8]))).toBe(d);
    expect(log).toEqual([]);
  });
});

describe("who plays one", () => {
  it("every plan on Hard and Brutal but Siege Train, whose army is the plan; none below", () => {
    expect(marshalStrategy({ ...MARSHAL.hard, strategy: "balanced" }).doctrine?.from).toBe(DOCTRINE.from);
    expect(marshalStrategy({ ...MARSHAL.brutal, strategy: "rush" }).doctrine?.from).toBe(DOCTRINE.from);
    expect(marshalStrategy({ ...MARSHAL.hard, strategy: "siege" }).doctrine).toBeUndefined();
    expect(marshalStrategy({ ...MARSHAL.normal, strategy: "balanced" }).doctrine).toBeUndefined();
  });
});

describe("orders under a doctrine", () => {
  it("changes an order for another army's unit into its own, in turn", () => {
    const d = armour();
    expect(underDoctrine(d, "fab-plant", "stinger")).toBe("lancer");
    expect(underDoctrine(d, "fab-plant", "mastodon")).toBe("flak-crawler");
    expect(underDoctrine(d, "fab-plant", "lancer")).toBe("lancer");
  });
  it("stops a factory it has no use for", () => {
    expect(underDoctrine(armour(), "airpad", "wasp")).toBeNull();
    expect(doctrineUnit(armour(), "assembly-bay")).toBeNull();
  });
  it("leaves support and Goliaths alone", () => {
    for (const k of ["scout", "condor", "mender"] as const) expect(underDoctrine(armour(), "airpad", k)).toBe(k);
    expect(underDoctrine(armour(), "gantry", "goliath")).toBe("goliath");
  });
  it("changes nothing with no doctrine in force", () => {
    expect(underDoctrine(undefined, "fab-plant", "stinger")).toBe("stinger");
  });
});
