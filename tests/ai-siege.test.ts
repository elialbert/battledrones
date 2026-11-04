import { describe, expect, it } from "vitest";
import { createAiState, type AiState } from "../src/sim/ai/commander";
import { MARSHAL_PLANS, MARSHAL_POOL, planStrategy } from "../src/sim/ai/marshal";
import { planSiege, siegeColumns, siegeHolds, siegeHops, siegePhase, type SiegeContext } from "../src/sim/ai/siege";
import { BUILDINGS, TICK_RATE, UNITS } from "../src/sim/balance";
import { createMapWorld } from "../src/sim/maps";
import type { Unit, World } from "../src/sim/types";
import { buildingCenter, dist, hqOf, spawnBuilding, spawnUnit } from "../src/sim/world";

const UNITS_TURRET_RANGE = BUILDINGS.turret.range!;
const SPEC = { from: 210, mortars: 4, army: 2000 };

/** Blue at 3:30 by its HQ: four Mortars, eight Lancers, four Stingers and a Mender. */
function setup(): { w: World; s: AiState; ctx: SiegeContext; guns: Unit[]; army: Unit[] } {
  const w = createMapWorld("dune-sea", { seed: 1 });
  w.tick = SPEC.from * TICK_RATE;
  const s = createAiState("ironclad", "brutal", 1, { siege: SPEC });
  const hqC = buildingCenter(hqOf(w, "blue")!);
  const guns: Unit[] = [];
  const army: Unit[] = [];
  for (let i = 0; i < 4; i++) guns.push(spawnUnit(w, "mortar", "blue", hqC.x + 3 + i, hqC.y + 3));
  army.push(...guns);
  for (let i = 0; i < 8; i++) army.push(spawnUnit(w, "lancer", "blue", hqC.x + 3 + (i % 4), hqC.y + 4 + Math.floor(i / 4)));
  for (let i = 0; i < 4; i++) army.push(spawnUnit(w, "stinger", "blue", hqC.x + 3 + i, hqC.y + 6));
  army.push(spawnUnit(w, "mender", "blue", hqC.x + 3, hqC.y + 7));
  const ctx: SiegeContext = {
    hqC, army, used: new Set(), seen: [], threatened: false, readyAt: 1000, enemyArmy: 0, barred: false, focus: null,
    enemyHqPos: buildingCenter(hqOf(w, "red")!)
  };
  return { w, s, ctx, guns, army };
}

describe("Siege Train (Marshal)", () => {
  it("is drawn at every level, Brutal too, and only it runs a column", () => {
    for (const pool of Object.values(MARSHAL_POOL)) expect(pool).toContain("siege");
    for (const name of Object.keys(MARSHAL_PLANS) as (keyof typeof MARSHAL_PLANS)[])
      expect(!!planStrategy(name).siege).toBe(name === "siege");
  });

  it("waits for its time, its Mortars, an army worth the trip and a quiet base", () => {
    const early = setup();
    early.w.tick -= TICK_RATE;
    expect(planSiege(early.w, "blue", early.s, early.ctx)).toEqual([]);
    const few = setup();
    few.ctx.army = few.ctx.army.filter((u) => u !== few.guns[0]);
    expect(planSiege(few.w, "blue", few.s, few.ctx)).toEqual([]);
    const small = setup();
    small.ctx.readyAt = 1e6;
    expect(planSiege(small.w, "blue", small.s, small.ctx)).toEqual([]);
    const outweighed = setup();
    outweighed.ctx.enemyArmy = 1e6;
    expect(planSiege(outweighed.w, "blue", outweighed.s, outweighed.ctx)).toEqual([]);
    const attacked = setup();
    attacked.ctx.threatened = true;
    expect(planSiege(attacked.w, "blue", attacked.s, attacked.ctx)).toEqual([]);
    for (const c of [early, few, small, outweighed, attacked]) expect(siegeColumns(c.s)).toBe(0);
  });

  it("never runs where it's barred", () => {
    const c = setup();
    c.ctx.barred = true;
    expect(planSiege(c.w, "blue", c.s, c.ctx)).toEqual([]);
    expect(siegePhase(c.s)).toBe("muster");
  });

  it("takes the guns, the Mender and the heaviest of the army, and leaves a home guard", () => {
    const c = setup();
    planSiege(c.w, "blue", c.s, c.ctx);
    const held = siegeHolds(c.s);
    expect(siegePhase(c.s)).toBe("lead");
    for (const g of c.guns) expect(held.has(g.id)).toBe(true);
    expect(held.has(c.army.find((u) => u.kind === "mender")!.id)).toBe(true);
    const left = c.army.filter((u) => !held.has(u.id));
    expect(left.length).toBeGreaterThan(0);
    expect(left.every((u) => u.kind === "stinger" || u.kind === "lancer")).toBe(true);
    expect(c.army.filter((u) => u.kind === "stinger" && held.has(u.id)).length).toBe(0); // (Lancers cost more: they go first)
  });

  it("sends the escort first, and the Mortars once it's there", () => {
    const c = setup();
    const out = planSiege(c.w, "blue", c.s, c.ctx);
    const gunIds = new Set(c.guns.map((g) => g.id));
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe("attackMove");
    expect((out[0] as { unitIds: number[] }).unitIds.some((id) => gunIds.has(id))).toBe(false);
    expect(planSiege(c.w, "blue", c.s, { ...c.ctx, used: new Set(siegeHolds(c.s)) }).filter((o) => o.type === "move")).toEqual([]);
    // the escort gets there
    const hop = siegeHops(c.s)[0]!;
    for (const u of c.army) if (siegeHolds(c.s).has(u.id) && !gunIds.has(u.id)) Object.assign(u, hop.stop);
    const next = planSiege(c.w, "blue", c.s, { ...c.ctx, used: new Set(siegeHolds(c.s)) });
    expect(siegePhase(c.s)).toBe("haul");
    const haul = next.find((o) => o.type === "move") as { unitIds: number[] };
    for (const g of c.guns) expect(haul.unitIds).toContain(g.id);
  });

  it("stops a hop for a real force, but not for a poke", () => {
    const poke = setup();
    planSiege(poke.w, "blue", poke.s, poke.ctx);
    const g = poke.guns[0]!;
    const lone = spawnUnit(poke.w, "stinger", "red", g.x + 3, g.y);
    planSiege(poke.w, "blue", poke.s, { ...poke.ctx, used: new Set(siegeHolds(poke.s)), seen: [lone] });
    expect(siegePhase(poke.s)).toBe("lead");

    const real = setup();
    planSiege(real.w, "blue", real.s, real.ctx);
    const h = real.guns[0]!;
    const force = Array.from({ length: 5 }, (_, i) => spawnUnit(real.w, "lancer", "red", h.x + 6, h.y + i));
    const out = planSiege(real.w, "blue", real.s, { ...real.ctx, used: new Set(siegeHolds(real.s)), seen: force });
    expect(siegePhase(real.s)).toBe("shell");
    expect(siegeHops(real.s)[0]!.cut).toBe(true);
    expect(out.some((o) => o.type === "stop")).toBe(true);
  });

  it("backs crowded Mortars out from under what's on them", () => {
    const c = setup();
    planSiege(c.w, "blue", c.s, c.ctx);
    const g = c.guns[0]!;
    const force = Array.from({ length: 4 }, (_, i) => spawnUnit(c.w, "stinger", "red", g.x + 1.5, g.y + i * 0.5));
    const out = planSiege(c.w, "blue", c.s, { ...c.ctx, used: new Set(siegeHolds(c.s)), seen: force });
    const back = out.find((o) => o.type === "move") as { unitIds: number[]; x: number; y: number };
    expect(back.unitIds).toContain(g.id);
    expect(dist(back.x, back.y, force[0]!.x, force[0]!.y)).toBeGreaterThan(dist(g.x, g.y, force[0]!.x, force[0]!.y));
  });

  it("runs for home from what it can't beat, and from being shot to pieces", () => {
    const c = setup();
    planSiege(c.w, "blue", c.s, c.ctx);
    const g = c.guns[0]!;
    const force = Array.from({ length: 30 }, (_, i) => spawnUnit(c.w, "mastodon", "red", g.x + 5 + (i % 5), g.y + Math.floor(i / 5)));
    const out = planSiege(c.w, "blue", c.s, { ...c.ctx, used: new Set(siegeHolds(c.s)), seen: force });
    expect(siegePhase(c.s)).toBe("muster");
    expect(siegeHolds(c.s).size).toBe(0);
    const home = out.find((o) => o.type === "move") as { x: number; y: number };
    expect({ x: home.x, y: home.y }).toEqual({ x: c.ctx.hqC.x, y: c.ctx.hqC.y });

    const shot = setup();
    planSiege(shot.w, "blue", shot.s, shot.ctx);
    for (const u of shot.guns) shot.w.units.delete(u.id);
    planSiege(shot.w, "blue", shot.s, { ...shot.ctx, used: new Set(siegeHolds(shot.s)) });
    expect(siegePhase(shot.s)).toBe("muster");
    expect(planSiege(shot.w, "blue", shot.s, shot.ctx)).toEqual([]); // (the next column waits)
  });

  it("stops out of a known Turret's reach, with the Turret in the Mortars'", () => {
    const c = setup();
    const g = c.guns[0]!;
    const turret = spawnBuilding(c.w, "turret", "red", Math.floor(g.x) + 12, Math.floor(g.y));
    c.w.fog.blue.known.set(turret.id, { id: turret.id, kind: "turret", faction: "red", tx: turret.tx, ty: turret.ty });
    planSiege(c.w, "blue", c.s, c.ctx);
    const hop = siegeHops(c.s)[0]!;
    expect(hop.target).toBe("turret");
    const d = dist(hop.stop.x, hop.stop.y, turret.tx + 0.5, turret.ty + 0.5);
    expect(d).toBeGreaterThan(UNITS_TURRET_RANGE);
    expect(d).toBeLessThanOrEqual(UNITS.mortar.range);
  });
});
