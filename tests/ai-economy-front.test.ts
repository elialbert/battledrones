import { describe, expect, it } from "vitest";
import { createAiState, tickAi } from "../src/sim/ai/commander";
import { economyDiagnostic, economyEligible, economyFields, newEconomyFront, planEconomyFront } from "../src/sim/ai/economy-front";
import { miningAccess, tendFields, type MiningAccess } from "../src/sim/ai/fields";
import { staffExpansions, tendExpansion, type ExpansionPlan } from "../src/sim/ai/expansion";
import { MARSHAL, marshal } from "../src/sim/ai/marshal";
import { capApm } from "../src/sim/ai/apm";
import { dodgeCalldowns, recheckDodge } from "../src/sim/ai/powers";
import { TICK_RATE, UNITS } from "../src/sim/balance";
import { createMapWorld } from "../src/sim/maps";
import { step } from "../src/sim/sim";
import { worldHash } from "../src/sim/checksum";
import { Terrain, type Command, type Faction, type Unit } from "../src/sim/types";
import { buildingCenter, createWorld, regionAt, removeBuilding, setTerrain, spawnBuilding, spawnUnit } from "../src/sim/world";

/** Directly constructed decision fixture; full-loop paid opponents live in tools/ai/scenarios.ts. */
function fixture(side: Faction = "blue", ample = false) {
  const w = createWorld(48, 48);
  const pos = (x: number, y: number) => side === "blue" ? { x, y } : { x: 48 - x, y: 48 - y };
  const tile = (x: number, y: number, size = 1) => side === "blue" ? { x, y } : { x: 48 - x - size, y: 48 - y - size };
  const base = tile(5, 38, 3);
  const hq = spawnBuilding(w, "hq", side, base.x, base.y);
  const foe: Faction = side === "blue" ? "red" : "blue";
  const enemy = tile(40, 5, 3);
  spawnBuilding(w, "hq", foe, enemy.x, enemy.y);
  const field = (x: number, y: number, amount: number) => {
    for (let i = 0; i < 3; i++) { const t = tile(x + i, y); setTerrain(w, t.x, t.y, Terrain.Scrap); w.scrap[t.y * 48 + t.x] = amount; }
  };
  field(3, 44, ample ? 1250 : 60);
  if (ample) { field(3, 46, 1250); field(3, 42, 1250); }
  field(16, 29, 1250);
  field(27, 39, 1250);
  const depotAt = tile(13, 31, 2);
  const depot = spawnBuilding(w, "depot", side, depotAt.x, depotAt.y);
  const otherAt = tile(25, 36, 2);
  const alternative = spawnBuilding(w, "depot", side, otherAt.x, otherAt.y);
  const miners = Array.from({ length: 8 }, () => { const p = pos(4.5, 44.5); const u = spawnUnit(w, "harvester", side, p.x, p.y);
    const t = tile(3, 44); u.order = { type: "harvest", fieldX: t.x, fieldY: t.y, phase: "harvesting" }; return u; });
  const army = Array.from({ length: 10 }, (_, i) => { const p = pos(10.5 + i * 0.2, 36.5); const u = spawnUnit(w, "stinger", side, p.x, p.y);
    const old = pos(7.5, 39.5); u.order = { type: "attackMove", ...old }; return u; });
  const s = newEconomyFront();
  const context = { home: buildingCenter(hq), enemyHome: buildingCenter(w.buildings.get(hq.id + 1)!), seen: [] as Unit[], miners, army,
    unavailable: new Set<number>(), access: undefined as unknown as MiningAccess, threatened: false, assault: false, lost: [] as { x: number; y: number }[] };
  const update = () => { context.access = miningAccess(w, side, s, context.seen, [...miners, ...army], context.lost); const cmds: Command[] = [];
    const reserved = planEconomyFront(w, side, s, context, cmds); return { cmds, reserved }; };
  return { w, side, foe, s, context, update, depot, alternative, army, miners, pos, tile };
}

describe("experimental economy assignment", () => {
  it("selects an existing expansion before depletion and reassigns units walking to obsolete staging", () => {
    const f = fixture();
    const result = f.update();
    expect(f.s.urgent).toBe(true);
    expect(f.s.plan?.depotId).toBe(f.depot.id);
    expect(result.reserved.size).toBeGreaterThan(1);
    expect(result.cmds.some(c => c.type === "attackMove" && c.unitIds.length > 1)).toBe(true);
    expect(result.cmds.some(c => c.type === "found")).toBe(false);
    expect(f.s.plan?.phase).toBe("assemble");
    expect(f.s.plan?.arrivedValue).toBe(0);
  });

  it("leaves ample dependable mining and the opening army alone", () => {
    const f = fixture("blue", true);
    const result = f.update();
    expect(f.s.urgent).toBe(false);
    expect(f.s.plan).toBeUndefined();
    expect(result.cmds).toEqual([]);
  });

  it("protects a productive forward Depot when home mining is about to end", () => {
    const f = fixture();
    for (const h of f.miners.slice(0, 4)) { h.x = 17; h.y = 29; h.order = { type: "harvest", fieldX: 16, fieldY: 29, phase: "harvesting" }; }
    f.update();
    expect(f.s.urgent).toBe(true);
    expect(f.s.sites.find(site => site.depotId === f.depot.id)!.productive).toBe(4);
    expect(f.s.plan!.depotId).toBe(f.depot.id);
    expect(f.s.plan!.depotId).not.toBe(f.alternative.id);
  });

  it("does not count unstaffed Depots or inaccessible stock as dependable mining", () => {
    const f = fixture();
    f.context.miners = [];
    f.update();
    expect(f.s.runwaySeconds).toBe(0);
    expect(f.s.urgent).toBe(true);
    expect(f.s.reason).not.toContain("runway");
    expect(f.s.sites.filter(s => s.productive > 0)).toHaveLength(0);
  });

  it("does not mistake distant miners without a serving drop-off for dependable income", () => {
    const f = fixture();
    removeBuilding(f.w, f.depot); removeBuilding(f.w, f.alternative);
    f.context.miners = f.miners.slice(0, 3);
    for (const h of f.context.miners) { h.x = 17; h.y = 29; h.order = { type: "harvest", fieldX: 16, fieldY: 29, phase: "harvesting" }; }
    f.update();
    expect(f.s.sites.some(site => site.productive > 0)).toBe(true);
    expect(f.s.runwaySeconds).toBe(0);
    expect(f.s.urgent).toBe(true);
  });

  it("prepares the next source against its readiness deadline while the current assignment still mines", () => {
    const f = fixture(); removeBuilding(f.w, f.alternative);
    f.update();
    const currentId = f.s.plan!.fieldId;
    for (const id of f.s.plan!.assigned) Object.assign(f.w.units.get(id)!, f.s.plan!.hold);
    f.w.tick += 2 * TICK_RATE; f.update();
    expect(f.s.plan!.phase).toBe("hold");
    for (const h of f.miners.slice(0, 5)) { h.x = 17; h.y = 29; h.order = { type: "harvest", fieldX: 16, fieldY: 29, phase: "harvesting" }; }
    for (const tile of economyFields(f.w, f.side).find(field => field.id === currentId)!.tiles) f.w.scrap[tile] = 500;
    f.w.tick += 25 * TICK_RATE; f.update();
    expect(f.s.sites.find(site => site.fieldId === currentId)!.raw).toBeGreaterThan(0);
    expect(f.s.urgent).toBe(true);
    expect(f.s.plan!.fieldId).not.toBe(currentId);
    expect(f.s.sites.find(site => site.fieldId === f.s.plan!.fieldId)!.construction).toBeDefined();
  });

  it("does not advance a phase when commands are dropped or refused, and retries useful movement", () => {
    const f = fixture();
    const first = f.update();
    f.w.tick += 2 * TICK_RATE; // never apply the proposed commands
    const retry = f.update();
    expect(f.s.plan?.phase).toBe("assemble");
    expect(f.s.plan?.orderedValue).toBe(0);
    expect(retry.cmds).toEqual(first.cmds);
    const approach = f.s.plan!.approach;
    for (const id of f.s.plan!.assigned) Object.assign(f.w.units.get(id)!, approach);
    f.w.tick += 2 * TICK_RATE;
    f.update();
    expect(f.s.plan?.phase).toBe("secure");
  });

  it("waits for the selected slow units and keeps the same roster when fast units lead", () => {
    const f = fixture();
    f.update();
    const slow = f.w.units.get(f.s.plan!.assigned[0]!)!;
    slow.kind = "trooper"; slow.hp = UNITS.trooper.hp;
    f.w.tick += 2 * TICK_RATE; f.update();
    const ids = [...f.s.plan!.assigned];
    for (const id of ids) if (id !== slow.id) Object.assign(f.w.units.get(id)!, f.s.plan!.approach);
    f.w.tick += 2 * TICK_RATE; f.update();
    expect(f.s.plan!.phase).toBe("assemble");
    expect(f.s.plan!.assigned).toContain(slow.id);
    Object.assign(slow, f.s.plan!.approach);
    f.w.tick += 2 * TICK_RATE; f.update();
    expect(f.s.plan!.phase).toBe("secure");
    for (const id of ids) if (id !== slow.id) Object.assign(f.w.units.get(id)!, f.s.plan!.hold);
    f.w.tick += 2 * TICK_RATE; f.update();
    expect(f.s.plan!.assigned).toContain(slow.id);
    expect(f.s.plan!.phase).not.toBe("hold");
  });

  it("protects retreat and specialist holds and never counts their promised strength", () => {
    const f = fixture();
    f.context.unavailable = new Set(f.army.slice(0, 8).map(u => u.id));
    const result = f.update();
    expect(result.reserved.size).toBe(0);
    expect(f.s.plan).toBeUndefined();
    expect(f.s.sites.some(site => !site.viable)).toBe(true);
  });

  it("lets a selected force advance while newly produced units are still at home", () => {
    const f = fixture(); f.update();
    const ids = [...f.s.plan!.assigned];
    const required = f.s.plan!.required;
    for (const id of ids) Object.assign(f.w.units.get(id)!, f.s.plan!.approach);
    for (let i = 0; i < 12; i++) f.context.army.push(spawnUnit(f.w, "trooper", f.side, 6, 40));
    f.w.tick += 2 * TICK_RATE; f.update();
    expect(f.s.plan!.phase).toBe("secure");
    expect(f.s.plan!.assigned).toEqual(ids);
    expect(f.s.plan!.required).toBe(required);
    for (let i = 0; i < 12; i++) f.context.army.push(spawnUnit(f.w, "trooper", f.side, 6, 40));
    f.w.tick += 2 * TICK_RATE; f.update();
    expect(f.s.plan!.assigned).toEqual(ids);
    expect(f.s.plan!.phase).toBe("secure");
  });

  it("judges a long deployment by physical progress rather than elapsed phase time", () => {
    const f = fixture();
    for (const u of f.army) { u.x = 0.5; u.y = 47.5; }
    f.update();
    const field = f.s.plan!.fieldId;
    for (let i = 0; i < 3; i++) {
      for (const id of f.s.plan!.assigned) {
        const u = f.w.units.get(id)!, to = f.s.plan!.approach;
        u.x += (to.x - u.x) * 0.1; u.y += (to.y - u.y) * 0.1;
      }
      f.w.tick += 30 * TICK_RATE; f.update();
      expect(f.s.plan!.fieldId).toBe(field);
      expect(f.s.plan!.phase).toBe("assemble");
    }
    f.w.tick += 41 * TICK_RATE; f.update();
    expect(f.s.plan!.phase).toBe("recover");
  });

  it("brings reinforcements up to the reached line without recalling the veterans", () => {
    const f = fixture(); f.update();
    for (const id of f.s.plan!.assigned) Object.assign(f.w.units.get(id)!, f.s.plan!.approach);
    f.w.tick += 2 * TICK_RATE; f.update();
    expect(f.s.plan!.phase).toBe("secure");
    for (const id of f.s.plan!.assigned) Object.assign(f.w.units.get(id)!, f.s.plan!.advance);
    f.w.tick += 2 * TICK_RATE; f.update();
    const before = { ...f.s.plan!.advance! }, hold = f.s.plan!.hold;
    const veterans = [...f.s.plan!.assigned];
    f.context.seen = Array.from({ length: 8 }, () => spawnUnit(f.w, "stinger", f.foe, hold.x, hold.y));
    for (let i = 0; i < 10; i++) f.context.army.push(spawnUnit(f.w, "stinger", f.side, 6, 40));
    f.w.tick += 2 * TICK_RATE;
    const result = f.update();
    expect(f.s.plan!.assigned.some(id => !veterans.includes(id))).toBe(true);
    expect(f.s.plan!.phase).toBe("secure");
    expect(Math.hypot(f.s.plan!.advance!.x - hold.x, f.s.plan!.advance!.y - hold.y))
      .toBeLessThanOrEqual(Math.hypot(before.x - hold.x, before.y - hold.y));
    for (const c of result.cmds) if (c.type === "attackMove" && c.unitIds.some(id => veterans.includes(id)))
      expect(Math.hypot(c.x - hold.x, c.y - hold.y)).toBeLessThanOrEqual(Math.hypot(before.x - hold.x, before.y - hold.y));
  });

  it("keeps the mining assignment through a small aircraft contact", () => {
    const f = fixture(); f.update();
    const field = f.s.plan!.fieldId, at = f.s.plan!.hold;
    f.context.seen = [spawnUnit(f.w, "hornet", f.foe, at.x, at.y)];
    f.w.tick += 2 * TICK_RATE; f.update();
    expect(f.s.plan!.fieldId).toBe(field);
    expect(f.s.plan!.phase).not.toBe("recover");
    expect(f.s.sites.find(s => s.fieldId === field)!.confidence).toBe("observed");
  });

  it("does not promise a Depot's existing shift to two separate fields", () => {
    const f = fixture();
    removeBuilding(f.w, f.alternative);
    for (let x = 22; x <= 24; x++) { setTerrain(f.w, x, 29, Terrain.Scrap); f.w.scrap[29 * 48 + x] = 1250; }
    f.update();
    const waiting = f.s.sites.find(site => site.entry.x === 22.5 && site.entry.y === 29.5)!;
    expect(waiting.depotId).toBe(f.depot.id);
    expect(waiting.viable).toBe(false);
    expect(waiting.reason).toContain("another live field");
    expect(f.s.plan!.fieldId).not.toBe(waiting.fieldId);
  });

  it("preserves the dry-field rule for crystal instead of converting its raw threshold", () => {
    const f = fixture(); removeBuilding(f.w, f.depot); removeBuilding(f.w, f.alternative);
    for (let x = 16; x <= 18; x++) { setTerrain(f.w, x, 29, Terrain.Crystal); f.w.scrap[29 * 48 + x] = 500; }
    const field = economyFields(f.w, f.side).find(field => field.tiles.includes(29 * 48 + 16))!;
    expect(field.raw).toBe(1500); expect(field.scrap).toBe(2400);
    f.update();
    expect(f.s.sites.some(site => site.fieldId === field.id)).toBe(false);
    expect(f.s.plan!.fieldId).not.toBe(field.id);
  });

  it("chooses another prospective field when the nearest source is a losing fight", () => {
    const f = fixture();
    removeBuilding(f.w, f.depot); removeBuilding(f.w, f.alternative);
    const at = f.pos(17, 29);
    f.context.seen = Array.from({ length: 12 }, () => spawnUnit(f.w, "mastodon", f.foe, at.x, at.y));
    f.update();
    expect(f.s.plan).toBeDefined();
    expect(f.s.plan!.hold.x).toBeGreaterThan(24);
    expect(f.s.sites.find(site => site.fieldId === f.s.plan!.fieldId)?.construction).toBeDefined();
  });

  it("does not call a productive Hold stalled merely because forty seconds pass", () => {
    const f = fixture(); f.update();
    for (const id of f.s.plan!.assigned) Object.assign(f.w.units.get(id)!, f.s.plan!.hold);
    f.w.tick += 2 * TICK_RATE; f.update();
    expect(f.s.plan!.phase).toBe("hold");
    f.w.tick += 50 * TICK_RATE; f.update();
    expect(f.s.plan!.phase).toBe("hold");
  });

  it("releases an assault reserve only after mining is safe, and reinforces renewed pressure", () => {
    const f = fixture(); f.update();
    for (const id of f.s.plan!.assigned) Object.assign(f.w.units.get(id)!, f.s.plan!.hold);
    f.w.tick += 2 * TICK_RATE; f.update();
    const initial = f.s.plan!.assigned.length;
    for (const h of f.miners) { h.x = 17; h.y = 29; h.order = { type: "harvest", fieldX: 16, fieldY: 29, phase: "harvesting" }; }
    f.context.assault = true;
    f.w.tick += 2 * TICK_RATE; f.update();
    f.w.tick += 2 * TICK_RATE; f.update();
    const mature = f.s.plan!.assigned.length, hold = f.s.plan!.hold;
    expect(f.s.urgent).toBe(false);
    expect(mature).toBeGreaterThan(0);
    expect(mature).toBeLessThan(initial);
    f.context.seen = Array.from({ length: 8 }, () => spawnUnit(f.w, "stinger", f.foe, hold.x, hold.y));
    for (let i = 0; i < 5; i++) f.context.army.push(spawnUnit(f.w, "stinger", f.side, 6, 40));
    f.w.tick += 2 * TICK_RATE; f.update();
    expect(f.s.plan!.assigned.length).toBeGreaterThan(mature);
    expect(f.s.plan!.phase).toBe("secure");
  });

  it("keeps assignment identity across depletion and small candidate fluctuations", () => {
    const f = fixture();
    f.update();
    const id = f.s.plan!.fieldId;
    const terrain = economyFields(f.w, "blue").find(field => field.id === id)!;
    f.w.scrap[terrain.live[0]!] = 0;
    f.w.tick += 2 * TICK_RATE;
    f.update();
    expect(f.s.plan?.fieldId).toBe(id);
    expect(economyFields(f.w, "blue").find(field => field.id === id)?.tiles).toEqual(terrain.tiles);
  });

  it("mirrors field choices and assignments", () => {
    const a = fixture("blue"), b = fixture("red");
    a.update(); b.update();
    expect(b.s.plan?.hold).toEqual({ x: 48 - a.s.plan!.hold.x, y: 48 - a.s.plan!.hold.y });
    expect(b.s.plan?.assigned).toEqual(a.s.plan?.assigned);
    expect(b.s.plan?.phase).toBe(a.s.plan?.phase);
  });

  it("uses a reachable live entry when a stable field also includes isolated resource tiles", () => {
    const f = fixture();
    for (let y = 28; y <= 30; y++) for (let x = 15; x <= 17; x++) if (x !== 16 || y !== 29) setTerrain(f.w, x, y, Terrain.Rock);
    f.update();
    const homeRegion = regionAt(f.w, Math.floor(f.context.home.x), Math.floor(f.context.home.y), "ground");
    expect(regionAt(f.w, 16, 29, "ground")).not.toBe(homeRegion);
    expect(f.s.sites.length).toBeGreaterThan(0);
    for (const site of f.s.sites) expect(regionAt(f.w, Math.floor(site.entry.x), Math.floor(site.entry.y), "ground")).toBe(homeRegion);
    const split = economyFields(f.w, f.side).find(field => field.tiles.includes(29 * 48 + 16))!;
    expect(split.raw).toBe(2500);
    expect(f.s.sites.find(site => site.fieldId === split.id)!.raw).toBe(1250);
  });

  it("holds a pocket's reachable approach instead of parking behind its rocks", () => {
    const f = fixture(); removeBuilding(f.w, f.alternative);
    for (let x = 27; x < 30; x++) f.w.scrap[39 * 48 + x] = 0;
    for (let x = 15; x <= 19; x++) { setTerrain(f.w, x, 28, Terrain.Rock); setTerrain(f.w, x, 30, Terrain.Rock); }
    setTerrain(f.w, 15, 29, Terrain.Rock);
    f.update();
    const site = f.s.sites.find(site => site.fieldId === f.s.plan!.fieldId)!;
    expect(f.s.plan!.hold.x).toBeGreaterThan(site.entry.x + 1);
    expect(site.route).toContainEqual(f.s.plan!.hold);
    expect(Math.hypot(f.s.plan!.hold.x - site.entry.x, f.s.plan!.hold.y - site.entry.y)).toBeLessThanOrEqual(6);
  });

  it("adapts to reconnaissance during useful movement without waiting for a Scout", () => {
    const f = fixture();
    const first = f.update();
    expect(first.cmds.length).toBeGreaterThan(0);
    expect(f.s.scout).toBeUndefined();
    const id = f.s.plan!.fieldId;
    const at = f.s.plan!.hold;
    f.context.seen = Array.from({ length: 12 }, () => spawnUnit(f.w, "mastodon", f.foe, at.x, at.y));
    f.w.tick += 2 * TICK_RATE;
    f.update();
    expect(f.s.plan?.fieldId !== id || f.s.plan?.phase === "recover").toBe(true);
    expect(f.s.sites.find(s => s.fieldId === id)?.viable).toBe(false);
    expect(f.s.sites.find(s => s.fieldId === id)?.confidence).toBe("observed");
  });

  it("retains danger after vision is lost, then allows fresh safe work after memory expires", () => {
    const f = fixture();
    const at = f.pos(17, 29);
    f.context.seen = Array.from({ length: 10 }, () => spawnUnit(f.w, "mastodon", f.foe, at.x, at.y));
    f.update();
    f.context.seen = [];
    f.w.tick += 5 * TICK_RATE;
    f.update();
    expect(f.s.sites.find(s => s.depotId === f.depot.id)?.safe).toBe(false);
    f.w.tick += 20 * TICK_RATE;
    f.update();
    expect(f.s.sites.find(s => s.depotId === f.depot.id)?.safe).toBe(true);
  });

  it("preempts for home defence and replans after the emergency", () => {
    const f = fixture(); f.update();
    const assigned = [...f.s.plan!.assigned];
    f.context.threatened = true;
    f.w.tick += 2 * TICK_RATE;
    const defence = f.update();
    expect(f.s.plan?.phase).toBe("recover");
    expect(defence.cmds.some(c => "unitIds" in c && assigned.every(id => c.unitIds.includes(id)))).toBe(true);
    expect(defence.reserved.size).toBe(0);
    f.context.threatened = false;
    f.w.tick += 2 * TICK_RATE;
    f.update();
    expect(f.s.plan?.phase).not.toBe("recover");
  });

  it("makes staffing, field selection and idle fallback agree on unsafe routes", () => {
    const f = fixture(); const at = f.pos(17, 29);
    const enemies = Array.from({ length: 5 }, () => spawnUnit(f.w, "mastodon", f.foe, at.x, at.y));
    f.w.tick++;
    const access = miningAccess(f.w, f.side, f.s, enemies, [...f.miners, ...f.army]);
    const cmds: Command[] = [];
    staffExpansions(f.w, f.side, f.context.home, f.miners, new Set(), [], cmds, access);
    expect(cmds.filter(c => c.type === "harvest").every(c => c.type === "harvest" && c.x > 20)).toBe(true);
    const evicted = f.miners[0]!; evicted.order = { type: "harvest", phase: "toField", fieldX: 16, fieldY: 29 };
    const fields: Command[] = [];
    tendFields(f.w, f.side, f.s, f.context.home, f.context.enemyHome, f.miners, new Set(), enemies, [...f.miners, ...f.army], null, fields, new Set([evicted.id]), access);
    expect(fields.some(c => "unitIds" in c && c.unitIds.includes(evicted.id))).toBe(true);
    expect(fields.filter(c => c.type === "harvest").every(c => c.type === "harvest" && !access.unsafeAt(Math.floor(c.x), Math.floor(c.y)))).toBe(true);
  });

  it("requires cover that can actually fight the observed threat before miners may enter", () => {
    const f = fixture();
    const at = f.pos(17, 29);
    const seen = [spawnUnit(f.w, "mastodon", f.foe, at.x, at.y)];
    const flak = Array.from({ length: 10 }, () => spawnUnit(f.w, "flak-crawler", f.side, at.x, at.y));
    let access = miningAccess(f.w, f.side, f.s, seen, [...f.army, ...flak]);
    expect(access.unsafeAt(16, 29)).toBe(true);
    const cover = Array.from({ length: 4 }, () => spawnUnit(f.w, "mastodon", f.side, at.x, at.y));
    f.w.tick++;
    access = miningAccess(f.w, f.side, f.s, seen, [...f.army, ...flak, ...cover]);
    expect(access.unsafeAt(16, 29)).toBe(false);
  });

  it("counts a specialist Goliath's actual ready weapons rather than its nominal price", () => {
    const f = fixture(); const at = f.pos(17, 29);
    const seen = [spawnUnit(f.w, "mastodon", f.foe, at.x, at.y)];
    const g = spawnUnit(f.w, "goliath", f.side, at.x, at.y);
    for (const weapon of Object.values(g.goliath!.weapons)) weapon.online = false;
    expect(miningAccess(f.w, f.side, f.s, seen, [g]).unsafeAt(16, 29)).toBe(true);
  });

  it("compares both sides' observed HP while still keeping unprotected miners out", () => {
    const f = fixture(), at = f.pos(17, 29);
    const enemy = spawnUnit(f.w, "mastodon", f.foe, at.x, at.y);
    const cover = spawnUnit(f.w, "mastodon", f.side, at.x, at.y); cover.hp = 800;
    expect(miningAccess(f.w, f.side, f.s, [enemy], [cover]).unsafeAt(16, 29)).toBe(true);
    enemy.hp = 600; f.w.tick++;
    expect(miningAccess(f.w, f.side, f.s, [enemy], [cover]).unsafeAt(16, 29)).toBe(false);
    f.w.tick++;
    expect(miningAccess(f.w, f.side, f.s, [enemy], []).unsafeAt(16, 29)).toBe(true);
  });

  it("preserves the baseline home-mining policy during a raid", () => {
    const f = fixture();
    const seen = Array.from({ length: 3 }, () => spawnUnit(f.w, "mastodon", f.foe, 4, 44));
    const legacy: Command[] = [], shared: Command[] = [];
    tendFields(f.w, f.side, {}, f.context.home, f.context.enemyHome, f.miners, new Set(), seen, f.army, null, legacy);
    const access = miningAccess(f.w, f.side, f.s, seen, [...f.miners, ...f.army]);
    tendFields(f.w, f.side, f.s, f.context.home, f.context.enemyHome, f.miners, new Set(), seen, f.army, null, shared, new Set(), access);
    expect(access.unsafeAt(3, 44)).toBe(false);
    expect(shared).toEqual(legacy);
    expect(shared.some(c => c.type === "move")).toBe(false);
  });

  it("does not count retreating defenders as cover for a new mining shift", () => {
    const f = fixture();
    const at = f.pos(17, 29);
    spawnUnit(f.w, "mastodon", f.foe, at.x, at.y);
    const retreating = Array.from({ length: 4 }, () => {
      const u = spawnUnit(f.w, "mastodon", f.side, at.x, at.y);
      u.order = { type: "move", ...f.context.home }; return u.id;
    });
    f.w.fog.blue.vis.fill(2);
    const s = createAiState("boom", "brutal", 1);
    s.fair = true; s.secureEconomy = true; s.economyUnavailable = new Set(retreating);
    const commands = tickAi(f.w, f.side, s);
    expect(s.economyFront!.sites.find(site => site.depotId === f.depot.id)!.safe).toBe(false);
    expect(commands.some(c => c.type === "harvest" && Math.floor(c.x) === 16 && Math.floor(c.y) === 29)).toBe(false);
  });

  it("retries a delayed founding order while withholding the crew from known danger", () => {
    const f = fixture();
    const s: { expansion?: ExpansionPlan | null } = { expansion: { tx: 21, ty: 30, crew: f.miners.slice(0, 4).map(u => u.id), since: 0 } };
    f.w.tick = 3 * TICK_RATE;
    const cmds: Command[] = [];
    tendExpansion(f.w, f.side, s, true, f.context.home, f.miners, new Set(), 0, 9, cmds, [], undefined, [], { permitted: () => true });
    expect(cmds.some(c => c.type === "found")).toBe(true);
    expect(s.expansion).toBeTruthy();
    f.w.tick++;
    const blocked: Command[] = [];
    tendExpansion(f.w, f.side, s, true, f.context.home, f.miners, new Set(), 0, 9, blocked, [], undefined, [], { permitted: () => false });
    expect(s.expansion).toBeNull();
    expect(blocked.some(c => c.type === "found")).toBe(false);
  });

  it("does not read hidden enemy positions, queues or money", () => {
    const a = fixture(), b = fixture();
    const e = spawnUnit(b.w, "mastodon", b.foe, 23, 20);
    e.order = { type: "attackMove", x: 5, y: 40 };
    b.w.factions.red.scrap = 99999;
    [...b.w.buildings.values()].find(v => v.faction === "red")!.queue.push({ kind: "harvester", remaining: 100 });
    expect(a.update().cmds).toEqual(b.update().cmds);
    expect(economyDiagnostic(a.s)).toEqual(economyDiagnostic(b.s));
  });

  it("explicitly excludes lower levels, modes, island and HQ-less starts", () => {
    const f = fixture();
    for (const difficulty of ["easy", "casual", "normal"]) expect(economyEligible(f.w, f.side, { secureEconomy: true, difficulty })).toBe(false);
    for (const map of ["archipelago", "compass-rose"]) expect(economyEligible(createMapWorld(map), "blue", { secureEconomy: true, difficulty: "brutal" })).toBe(false);
    expect(economyEligible(f.w, f.side, { difficulty: "brutal" })).toBe(false);
    f.w.ops = {} as NonNullable<typeof f.w.ops>;
    expect(economyEligible(f.w, f.side, { secureEconomy: true, difficulty: "brutal" })).toBe(false);
  });

  it("leaves commands unchanged when explicitly enabled in an excluded mode", () => {
    for (const [map, difficulty] of [["archipelago", "brutal"], ["compass-rose", "brutal"], ["riverlands", "normal"]] as const) {
      const a = createMapWorld(map, { seed: 2 }), b = createMapWorld(map, { seed: 2 });
      const options = { ...MARSHAL[difficulty], strategy: "boom" as const };
      const one = marshal("blue", 12, difficulty, options), two = marshal("blue", 12, difficulty, { ...options, secureEconomy: true });
      for (let i = 0; i < 100; i++) { const x = one.tick(a), y = two.tick(b); expect(x).toEqual(y); step(a, x); step(b, y); }
      expect(worldHash(a)).toBe(worldHash(b));
    }
  });

  it("reserves the evaluated force in assault mode before other controllers can reuse it", () => {
    const f = fixture();
    const s = createAiState("boom", "brutal", 1, { assaultValue: 1 });
    s.secureEconomy = true; s.fair = true;
    s.wave = { ids: f.army.map(u => u.id), x: 40, y: 5, tick: 0 };
    const cmds = tickAi(f.w, f.side, s);
    expect(s.economyFront?.plan?.assigned.length).toBeGreaterThan(0);
    const reserved = new Set(s.economyFront!.plan!.assigned);
    expect(s.wave?.ids.some(id => reserved.has(id))).toBe(false);
    for (const c of cmds) if ("unitIds" in c && c.unitIds.some(id => reserved.has(id))) expect(s.economyCommands?.has(c)).toBe(true);
  });

  it("removes newly reserved units from a finishing push already delayed by the cap", () => {
    const f = fixture("blue", true);
    f.w.factions.blue.scrap = 0;
    f.w.fog.blue.vis.fill(2); // an actual fresh look permits the finishing opportunity
    let assigned: number[] = [];
    const bot = capApm(marshal("blue", 9, "brutal", { ...MARSHAL.brutal, strategy: "boom", secureEconomy: true,
      react: 10, fight: { finishMin: 1, finish: 1 }, onEconomyDiagnostic(value) {
        assigned = (value as { plan?: { assigned: number[] } } | null)?.plan?.assigned ?? [];
      } }), 10, 1);
    const first = bot.tick(f.w);
    expect(first[0]?.type).toBe("harvest"); // economy uses the first action; the finishing order waits
    step(f.w, first);
    for (const c of first) if (c.type === "harvest") for (const id of c.unitIds) {
      const h = f.w.units.get(id)!;
      h.x = c.x; h.y = c.y;
      h.order = { type: "harvest", phase: "harvesting", fieldX: Math.floor(c.x), fieldY: Math.floor(c.y) };
    }
    for (let y = 42; y <= 46; y++) for (let x = 3; x <= 5; x++) if (f.w.terrain[y * 48 + x] === Terrain.Scrap) f.w.scrap[y * 48 + x] = 60;
    let sawPush = false, sawReservation = false;
    for (let i = 1; i < 80; i++) {
      const commands = bot.tick(f.w);
      sawReservation ||= assigned.length > 0;
      for (const c of commands) if (c.type === "attackMove" && Math.abs(c.x - (f.w.width - f.context.home.x)) < 1 && Math.abs(c.y - (f.w.height - f.context.home.y)) < 1) {
        sawPush = true;
        expect(c.unitIds.some(id => assigned.includes(id))).toBe(false);
      }
      step(f.w, commands);
    }
    expect(sawReservation).toBe(true);
    expect(sawPush).toBe(true);
  });

  it("retains the assignment through actual wrapper kiting without treating it as a retreat", () => {
    const f = fixture();
    f.w.fog.blue.vis.fill(2);
    for (const u of f.army) { u.kind = "lancer"; u.hp = UNITS.lancer.hp; u.x = 16; u.y = 29; u.order = { type: "idle" }; }
    spawnUnit(f.w, "stinger", "red", 19.5, 29);
    let first: number[] = [], retained = false;
    const bot = capApm(marshal("blue", 9, "brutal", { ...MARSHAL.brutal, strategy: "boom", fight: { finishMin: Infinity },
      think: 0.5, secureEconomy: true, onEconomyDiagnostic(value) {
        const p = (value as { plan?: { assigned: number[]; phase: string } } | null)?.plan;
        if (!first.length) first = [...(p?.assigned ?? [])];
        else if (f.w.tick === 5 && p?.phase !== "recover" && first.every(id => p?.assigned.includes(id))) retained = true;
      } }), 1000, 50);
    let kites = 0;
    for (let i = 0; i < 4 * TICK_RATE; i++) {
      const commands = bot.tick(f.w);
      kites += commands.filter(c => c.type === "move" && c.unitIds.some(id => first.includes(id))).length;
      step(f.w, commands);
    }
    expect(first.length).toBeGreaterThan(0);
    expect(kites).toBeGreaterThan(0);
    expect(retained).toBe(true);
  });

  it("dispatches optional reconnaissance without filtering the Scout through the escort roster", () => {
    const f = fixture();
    const scout = spawnUnit(f.w, "scout", f.side, 8, 40);
    let departed: number | undefined;
    const bot = capApm(marshal("blue", 9, "brutal", { ...MARSHAL.brutal, strategy: "boom", fight: { finishMin: Infinity },
      secureEconomy: true, onEconomyDiagnostic(value) {
        departed = (value as { scout?: { departed?: number } } | null)?.scout?.departed;
      } }), 1000, 50);
    const first = bot.tick(f.w);
    expect(first.some(c => c.type === "move" && c.unitIds.includes(scout.id))).toBe(true);
    step(f.w, first);
    for (let i = 1; i < 3 * TICK_RATE; i++) step(f.w, bot.tick(f.w));
    expect(departed).toBeGreaterThan(0);
  });

  it("retries a capped dodge and keeps a delayed finishing push off the dodging units", () => {
    const f = fixture("blue", true);
    f.w.fog.blue.vis.fill(2);
    for (const u of f.army) u.order = { type: "idle" };
    const ids = new Set(f.army.map(u => u.id));
    const bot = capApm(marshal("blue", 9, "brutal", { ...MARSHAL.brutal, strategy: "boom", secureEconomy: true,
      fight: { finishMin: 1, finish: 1 } }), 10, 1);
    step(f.w, bot.tick(f.w));
    f.w.powers.active.push({ id: 999, faction: "red", power: "barrage", x: 11.4, y: 36.5, radius: 2.5,
      startTick: -3, landTick: 80, shells: [{ x: 11.4, y: 36.5, tick: 80 }] });
    let dispatchedDodge = false;
    for (let i = 1; i < 70; i++) {
      const commands = bot.tick(f.w);
      for (const c of commands) if ("unitIds" in c && c.unitIds.some(id => ids.has(id))) {
        expect(c.type).toBe("move");
        if (c.type === "move") {
          expect(Math.hypot(c.x - 11.4, c.y - 36.5)).toBeGreaterThan(2.5);
          dispatchedDodge = true;
        }
      }
      step(f.w, commands);
    }
    expect(dispatchedDodge).toBe(true);
  });

  it("updates a delayed escape direction and never reacts early to an unnoticed reticle", () => {
    const f = fixture();
    const s = createAiState("boom", "brutal", 1), u = f.army[0]!;
    u.x = 10; u.y = 36.5;
    f.w.powers.active.push({ id: 999, faction: "red", power: "barrage", x: 11.4, y: 36.5, radius: 2.5,
      startTick: 0, landTick: 80, shells: [{ x: 11.4, y: 36.5, tick: 80 }] });
    f.w.tick = 4;
    expect(dodgeCalldowns(f.w, f.side, s).some(c => "unitIds" in c && c.unitIds.includes(u.id))).toBe(true);
    u.x = 12.5; f.w.tick++;
    const next = recheckDodge(f.w, f.side, s, u.id);
    expect(next?.type).toBe("move");
    if (next?.type === "move") expect(next.x).toBeGreaterThan(u.x);
    u.x = 20;
    expect(recheckDodge(f.w, f.side, s, u.id)).toBeNull();
    f.w.powers.active.push({ id: 1000, faction: "red", power: "emp", x: 20, y: 36.5, radius: 3,
      startTick: 5, landTick: 90, shells: [] });
    expect(recheckDodge(f.w, f.side, s, u.id)).toBeNull();
  });

  it("keeps a finishing push from overriding a retreat issued in the same packet", () => {
    const f = fixture();
    f.w.fog.blue.vis.fill(2);
    for (const u of f.army) { u.kind = "mastodon"; u.hp = UNITS.mastodon.hp; u.x = 16; u.y = 29; u.order = { type: "idle" }; }
    const hurt = f.army[0]!; hurt.hp = UNITS.mastodon.hp * 0.2;
    spawnUnit(f.w, "stinger", f.foe, 19.5, 29);
    const bot = capApm(marshal("blue", 9, "brutal", { ...MARSHAL.brutal, strategy: "boom", secureEconomy: true,
      fight: { finishMin: 1, finish: 1 } }), 1000, 50);
    const commands = bot.tick(f.w).filter(c => "unitIds" in c && c.unitIds.includes(hurt.id));
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.every(c => c.type === "move")).toBe(true);
    step(f.w, commands);
    expect(hurt.order.type).toBe("move");
  });

  it("keeps wrapper commands and replay hashes deterministic with diagnostics on or off under a cap", () => {
    const a = createMapWorld("riverlands", { seed: 3 }), b = createMapWorld("riverlands", { seed: 3 });
    const options = { ...MARSHAL.brutal, strategy: "boom" as const, secureEconomy: true };
    let snapshots = 0;
    const one = capApm(marshal("blue", 9, "brutal", options), 30, 2);
    const two = capApm(marshal("blue", 9, "brutal", { ...options, onEconomyDiagnostic(snapshot) {
      snapshots++;
      const value = snapshot as { plan?: { assigned: number[]; advance?: { x: number } }; sites?: { construction?: { tx: number } }[] } | null;
      if (value?.plan) { value.plan.assigned.length = 0; if (value.plan.advance) value.plan.advance.x = -999; }
      for (const site of value?.sites ?? []) if (site.construction) site.construction.tx = -999;
    } }), 30, 2);
    let sent = 0;
    for (let i = 0; i < 120 * TICK_RATE; i++) {
      const first = one.tick(a), second = two.tick(b);
      expect(first).toEqual(second);
      sent += first.length;
      expect(sent).toBeLessThanOrEqual(2 + Math.floor(i * 30 / (60 * TICK_RATE)));
      step(a, first); step(b, second);
    }
    expect(snapshots).toBeGreaterThan(0);
    expect(worldHash(a)).toBe(worldHash(b));
  }, 30000);
});
