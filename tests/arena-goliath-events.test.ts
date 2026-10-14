import { describe, expect, it } from "vitest";
import { nearBase, SideLog } from "../src/arena/events";
import { Arena, parseSeat } from "../src/arena/match";
import { createMapWorld } from "../src/sim/maps";
import type { Unit, World } from "../src/sim/types";
import { createWorld, spawnBuilding, spawnUnit } from "../src/sim/world";

function hit(w: World, u: Unit, attackerId: number): void {
  w.fx.push({ type: "hit", faction: u.faction, id: u.id, x: u.x, y: u.y, building: false, attackerId });
}

describe("Goliath base alerts in the arena", () => {
  it("recognizes an airborne Armada base without revealing nearby hidden enemies", () => {
    const w = createMapWorld("archipelago", { seed: 42, mutators: ["armada"] });
    const g = [...w.units.values()].find((u) => u.faction === "blue" && u.goliath)!;
    expect(w.buildings.size).toBe(0);
    expect(g.goliath!.lift!.phase).toBe("carrying");
    const visible = spawnUnit(w, "goliath", "red", g.x + 7, g.y);
    const hidden = spawnUnit(w, "wasp", "red", g.x + 6, g.y);
    w.fog.blue.vis.fill(0);
    expect(nearBase(w, "blue").map((u) => u.id)).toContain(visible.id);
    expect(nearBase(w, "blue").map((u) => u.id)).not.toContain(hidden.id);
    const log = new SideLog("blue");
    log.tick(w);
    expect(log.urgent.has("inbound")).toBe(true);
    expect(log.take(w).join("\n")).not.toContain("wasp");
  });

  it("wakes a waiting Armada commander as enemies approach its Goliaths", () => {
    const a = new Arena({ map: "archipelago", seed: 42, mutators: ["armada"], seats: { blue: parseSeat("agent"), red: parseSeat("agent") } });
    a.resolve();
    a.wait("blue", 4);
    a.endRound("red");
    a.advance();
    expect(a.round).toBe(2);
    expect(a.turnOpen("blue")).toBe(false);
    const g = [...a.w.units.values()].find((u) => u.faction === "blue" && u.goliath)!;
    spawnUnit(a.w, "wasp", "red", g.x + 4, g.y);
    a.endRound("red");
    a.advance();
    expect(a.round).toBe(3);
    expect(a.turnOpen("blue")).toBe(true);
    expect(a.observe("blue")).toMatch(/Your wait was cut short:.*enemies are near your base/);
  });

  it("reports a hit to an owned Goliath without exposing an unseen attacker", () => {
    const w = createWorld(40, 40);
    const g = spawnUnit(w, "goliath", "blue", 10, 10);
    const attacker = spawnUnit(w, "lancer", "red", 35, 35);
    hit(w, g, attacker.id);
    w.tick = 1;
    const log = new SideLog("blue");
    log.tick(w);
    expect([...log.urgent]).toEqual(["goliath"]);
    const news = log.take(w).join("\n");
    expect(news).toContain(`UNDER ATTACK: goliath #${g.id} at 10,10 (1 hit, attacker unseen)`);
    expect(news).not.toContain("lancer");
    expect(log.urgent.size).toBe(0);
  });

  it("still wakes for a lethal Goliath hit after the simulator removed the unit", () => {
    const w = createWorld(40, 40);
    const g = spawnUnit(w, "goliath", "blue", 10, 10);
    w.units.delete(g.id);
    w.fx.push({ type: "death", id: g.id, faction: "blue", unitKind: "goliath", buildingKind: null, x: g.x, y: g.y, air: false, value: 1600, killerId: null, killerKind: null, rank: 0, kills: 0 });
    w.tick = 1;
    const log = new SideLog("blue");
    log.tick(w);
    expect(log.urgent.has("goliath")).toBe(true);
    expect(log.take(w).join("\n")).toContain(`LOST: 1 goliath (#${g.id})`);
  });

  it("preserves HQ and harvester alerts without waking for ordinary combat-unit hits", () => {
    const w = createWorld(40, 40);
    const hq = spawnBuilding(w, "hq", "blue", 2, 2);
    const harvester = spawnUnit(w, "harvester", "blue", 7, 7);
    const stinger = spawnUnit(w, "stinger", "blue", 8, 8);
    w.fx.push({ type: "hit", faction: "blue", id: hq.id, x: 3.5, y: 3.5, building: true, attackerId: 999 });
    hit(w, harvester, 999);
    hit(w, stinger, 999);
    w.tick = 1;
    const log = new SideLog("blue");
    log.tick(w);
    expect([...log.urgent]).toEqual(["hq"]);
    const news = log.take(w).join("\n");
    expect(news).toContain(`UNDER ATTACK: hq #${hq.id}`);
    expect(news).toContain(`UNDER ATTACK: harvester #${harvester.id}`);
    expect(news).not.toContain("stinger");
  });
});
