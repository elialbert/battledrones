import { describe, expect, it } from "vitest";
import { Arena } from "../src/arena/match";
import { frameOf } from "../src/arena/frame";
import { observeState, renderObservation } from "../src/arena/observe";
import { replay, worldHash } from "../src/arena/record";
import { ECONOMY } from "../src/sim/balance";
import { anchorBlocker, goliathsOf } from "../src/sim/goliath";

const arena = () => new Arena({ map: "archipelago", seed: 42, mutators: ["armada"], seats: { blue: { kind: "agent" }, red: { kind: "agent" } } });

describe("Goliath Armada briefing and observations", () => {
  it("plays and deterministically replays an Archipelago landing, anchoring, and first production for both sides", () => {
    const a = arena();
    a.resolve();
    for (const side of ["blue", "red"] as const) expect(a.orders(side, [{ unload: "goliath" }])).not.toContain("refused:");
    a.resolve();
    const bases = {} as Record<"blue" | "red", number>;
    for (const side of ["blue", "red"] as const) {
      const g = goliathsOf(a.w, side).find((u) => !anchorBlocker(a.w, u));
      expect(g).toBeDefined();
      bases[side] = g!.id;
      expect(a.orders(side, [{ anchor: [g!.id] }])).not.toContain("refused:");
    }
    a.resolve();
    for (const side of ["blue", "red"] as const) {
      expect(a.w.units.get(bases[side])!.goliath!.mode).toBe("anchored");
      expect(a.orders(side, [{ produce: "harvester", at: bases[side] }, { build: "factory" }])).not.toContain("refused:");
    }
    for (let n = 0; n < 8; n++) a.resolve();
    for (const side of ["blue", "red"] as const) {
      expect([...a.w.units.values()].some((u) => u.faction === side && u.kind === "harvester")).toBe(true);
      expect([...a.w.buildings.values()].some((b) => b.faction === side && b.kind === "fab-plant" && b.outpost), a.observe(side)).toBe(true);
    }
    const restored = replay(a.record);
    expect(restored.divergedAt).toBeNull();
    expect(worldHash(restored.world)).toBe(worldHash(a.w));
  });

  it("starts both sides without an opener, HQ, or invented HQ coordinates", () => {
    const a = arena();
    for (const side of ["blue", "red"] as const) {
      const text = a.briefing(side);
      expect(text).toContain("four airborne Goliaths carried by eight Condors");
      expect(text).toContain("You have no HQ");
      expect(text).toContain("last Goliath is destroyed");
      expect(text).toContain('"anchor"');
      expect(text).toContain('"pack_up"');
      expect(text).toContain('"lift"');
      expect(text).not.toContain("Your HQ is in the lower left");
      expect(text).not.toContain("Everyone also starts with an HQ");
      expect(a.observe(side)).toContain("Openers are disabled");
      expect(a.observe(side)).not.toContain("CHOOSE YOUR OPENER");
      expect(a.w.factions[side].scrap).toBe(ECONOMY.startingScrap);
      expect(a.endRound(side)).toContain("Openers are disabled");
    }
    a.resolve();
    expect(a.round).toBe(1);
    expect(a.w.tick).toBe(0);
    expect(a.record.openers).toEqual({});
    expect(a.w.buildings.size).toBe(0);
    for (const side of ["blue", "red"] as const) {
      const obs = observeState(a.w, side);
      expect(obs.units.filter((u) => u.kind === "goliath")).toHaveLength(4);
      expect(obs.units.filter((u) => u.kind === "condor")).toHaveLength(8);
    }
  });

  it("shows own lift, weapon, training and rally state in each side's frame without exposing enemy queues", () => {
    const a = arena();
    for (const side of ["blue", "red"] as const) {
      const u = goliathsOf(a.w, side)[0]!;
      const g = u.goliath!;
      const fr = frameOf(a.w, side);
      g.lift!.dest = fr.center(17, 29);
      g.lift!.setDown = true;
      g.queue.push({ kind: side === "blue" ? "harvester" : "sniper", remaining: 42 });
      g.rally = fr.center(11, 28);
      const obs = observeState(a.w, side);
      const own = obs.units.find((v) => v.id === u.id)!;
      const extras = own.extra.join(" ");
      expect(extras).toContain(`airborne with #${g.lift!.carriers[0]},#${g.lift!.carriers[1]} to 17,29 (landing)`);
      expect(extras).toContain("weapons ready: mg");
      expect(extras).toContain("(paused until anchored)");
      expect(extras).toContain("rally 11,28");
      expect(obs.enemies.filter((v) => v.kind === "goliath").every((v) => v.airborne)).toBe(true);
      expect(obs.enemies.every((v) => !("queue" in v) && !("extra" in v))).toBe(true);
      const text = renderObservation(obs, { round: 1, lastRound: 240, roundSecs: 5 });
      expect(text).toContain("airborne");
    }
    const blue = renderObservation(observeState(a.w, "blue"), { round: 1, lastRound: 240, roundSecs: 5 });
    expect(blue).not.toContain("sniper(5s)");
  });
});
