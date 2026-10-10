import { describe, expect, it } from "vitest";
import { BUILDINGS, LIFELINE, POWERS, TICK_RATE, UNITS } from "../src/sim/balance";
import { canPlaceBuilding } from "../src/sim/economy";
import { isInfantry } from "../src/sim/infantry";
import { hasCondor, lifelineRoute, squadCount } from "../src/sim/lifeline";
import { MAPS, createMapWorld, mapById } from "../src/sim/maps";
import { findPath } from "../src/sim/movement";
import { mirrorPoint, presence, uplinkIncome } from "../src/sim/objectives";
import { targetBlocker } from "../src/sim/powers";
import { rulesOf } from "../src/sim/rules";
import { step } from "../src/sim/sim";
import { carrierOf } from "../src/sim/transport";
import { Terrain, type Faction, type Unit, type World } from "../src/sim/types";
import { hqOf, onHomeLand, passable, regionAt, setTerrain, spawnUnit, terrainAt } from "../src/sim/world";

const ISLAND_MAPS = MAPS.filter((m) => m.islands);
const runTicks = (w: World, n: number) => {
  for (let i = 0; i < n; i++) step(w, []);
};
const own = (w: World, f: Faction, kind: Unit["kind"]) => [...w.units.values()].filter((u) => u.faction === f && u.kind === kind);
/** A tile just below the HQ (the HQ's own tiles are a building: no path starts there). */
const besideHq = (w: World, f: Faction) => {
  const hq = hqOf(w, f)!;
  return f === "blue" ? { x: hq.tx + 1.5, y: hq.ty + 4.5 } : { x: hq.tx + 1.5, y: hq.ty - 1.5 };
};

describe("the island map", () => {
  it("exists, last in the picker", () => {
    expect(ISLAND_MAPS.map((m) => m.id)).toEqual(["archipelago"]);
    expect(MAPS.at(-1)!.id).toBe("archipelago");
    expect(MAPS[0]!.id).toBe("proving-grounds");
  });

  for (const def of ISLAND_MAPS)
    describe(def.name, () => {
      const w = createMapWorld(def.id, { objectives: true });
      const b = besideHq(w, "blue");
      const r = besideHq(w, "red");

      it("joins the two HQs only by its bridges: cut them and nothing on the ground crosses", () => {
        expect(findPath(w, b.x, b.y, r.x, r.y)).not.toBeNull();
        const cut = createMapWorld(def.id);
        for (let i = 0; i < cut.width * cut.height; i++)
          if (cut.terrain[i] === Terrain.Bridge) setTerrain(cut, i % cut.width, Math.floor(i / cut.width), Terrain.Deep);
        for (const mc of ["ground", "foot", "hover"] as const) expect(findPath(cut, b.x, b.y, r.x, r.y, mc), mc).toBeNull();
      });

      it("puts every Uplink on an island only infantry can take, with room to land and dodge", () => {
        const ls = w.objectives.uplinks;
        expect(ls.length).toBeGreaterThanOrEqual(5);
        const home = (f: Faction) => regionAt(w, Math.floor(besideHq(w, f).x), Math.floor(besideHq(w, f).y), "foot");
        for (const l of ls) {
          expect(l.infantryOnly).toBe(true);
          const reg = regionAt(w, Math.floor(l.x), Math.floor(l.y), "foot");
          expect(reg).toBeGreaterThan(0);
          expect(reg).not.toBe(home("blue"));
          expect(reg).not.toBe(home("red"));
          // no tank, no hover tank: the island's ground and hover regions hold no HQ either
          for (const mc of ["ground", "hover"] as const) {
            const at = regionAt(w, Math.floor(l.x), Math.floor(l.y), mc);
            for (const f of ["blue", "red"] as const)
              expect(at, mc).not.toBe(regionAt(w, Math.floor(besideHq(w, f).x), Math.floor(besideHq(w, f).y), mc));
          }
          // squads can stand at least 4 tiles out from the relay all round (land two drops, dodge a Barrage)
          for (let a = 0; a < 16; a++) {
            const x = l.x + Math.cos((a / 16) * Math.PI * 2) * 3.6;
            const y = l.y + Math.sin((a / 16) * Math.PI * 2) * 3.6;
            expect(regionAt(w, Math.floor(x), Math.floor(y), "foot"), `(${x.toFixed(1)}, ${y.toFixed(1)})`).toBe(reg);
          }
        }
      });

      it("has no ford anywhere: every tile of sea is water or open sea", () => {
        for (let i = 0; i < w.width * w.height; i++) expect(w.terrain[i]).not.toBe(Terrain.Shallows);
      });

      it("keeps harvesting scarce: one small field by each HQ and a couple of crystals", () => {
        let tiles = 0;
        for (let i = 0; i < w.width * w.height; i++) if (w.terrain[i] === Terrain.Scrap || w.terrain[i] === Terrain.Crystal) tiles++;
        expect(tiles / 2).toBeLessThanOrEqual(12);
      });

      it("starts each side with a free Condor beside its HQ, its Trooper Squad aboard", () => {
        for (const f of ["blue", "red"] as const) {
          const [c, ...more] = own(w, f, "condor");
          expect(more).toHaveLength(0);
          expect(c!.free).toBe(true);
          expect(c!.passengers!.map((p) => p.kind)).toEqual(["trooper"]);
          expect(own(w, f, "trooper")).toHaveLength(0);
        }
        const [cb] = own(w, "blue", "condor");
        const [cr] = own(w, "red", "condor");
        const m = mirrorPoint(w, cb!.x, cb!.y);
        expect(cr!.x).toBeCloseTo(m.x, 9);
        expect(cr!.y).toBeCloseTo(m.y, 9);
        // the AI plans around a given Condor (rules.startUnits), yet the match isn't "mutated"
        expect(rulesOf(w).startUnits).toContain("condor");
        expect(rulesOf(w).mutators).toEqual([]);
      });

      it("drops Air War, and doesn't double the Condor under Airborne", () => {
        const aw = createMapWorld(def.id, { mutators: ["airwar", "veterans"] });
        expect(rulesOf(aw).mutators).toEqual(["veterans"]);
        const ab = createMapWorld(def.id, { mutators: ["airborne"] });
        for (const f of ["blue", "red"] as const) expect(own(ab, f, "condor")).toHaveLength(1);
      });
    });
});

describe("island Uplinks", () => {
  const fresh = () => createMapWorld("archipelago", { objectives: true });
  const centre = (w: World) => w.objectives.uplinks.find((l) => l.x === 48 && l.y === 48)!;

  it("count only robot infantry: aircraft, the Condor and hover tanks neither take nor freeze them", () => {
    const w = fresh();
    const l = centre(w);
    const red = (["condor", "scout", "wasp", "mender", "lancer", "stinger"] as const).map((k) => spawnUnit(w, k, "red", l.x + 0.5, l.y));
    expect(presence(w, l)).toEqual({ blue: 0, red: 0 });
    spawnUnit(w, "trooper", "blue", l.x - 0.5, l.y);
    expect(presence(w, l)).toEqual({ blue: 2, red: 0 });
    // the unarmed ones stay and hover over the zone: they don't freeze the bar
    for (const u of red) if (UNITS[u.kind].dps > 0) w.units.delete(u.id);
    runTicks(w, 16 * TICK_RATE);
    expect(l.owner).toBe("blue");
  });

  it("pay only while the holder's squads stand in them", () => {
    const w = fresh();
    const l = centre(w);
    const sq = spawnUnit(w, "trooper", "blue", l.x, l.y);
    runTicks(w, 16 * TICK_RATE);
    expect(l.owner).toBe("blue");
    expect(l.crewed).toBe(true);
    expect(uplinkIncome(w, "blue")).toBe(l.income! * 60);
    const s0 = w.factions.blue.scrap;
    const m0 = w.powers.meter.blue;
    runTicks(w, 10 * TICK_RATE);
    const paid = w.factions.blue.scrap - s0;
    // gone: the relay stays blue's, but pays nothing
    w.units.delete(sq.id);
    runTicks(w, 2);
    expect(l.owner).toBe("blue");
    expect(l.crewed).toBe(false);
    expect(uplinkIncome(w, "blue")).toBe(0);
    const s1 = w.factions.blue.scrap;
    const m1 = w.powers.meter.blue;
    runTicks(w, 10 * TICK_RATE);
    const trickle = (rulesOf(w).hqTrickle ?? 0) * 10;
    expect(paid).toBeCloseTo(trickle + l.income! * 10, 0);
    expect(w.factions.blue.scrap - s1).toBeCloseTo(trickle, 0);
    // the ⚡ charge stopped too: only the passive fill is left
    expect(m1 - m0).toBeGreaterThan(POWERS.passive * 10 + 0.1);
    expect(w.powers.meter.blue - m1).toBeCloseTo(POWERS.passive * 10, 1);
  });
});

describe("only a Condor reaches an island", () => {
  it("no Drop Pod lands on one, even with eyes on it", () => {
    const w = createMapWorld("archipelago", { mutators: ["clearskies"] });
    runTicks(w, 1); // (the fog's first pass)
    expect(targetBlocker(w, "blue", "droppod", 48.5, 50.5)).toMatch(/islands/);
    const b = besideHq(w, "blue");
    expect(targetBlocker(w, "blue", "droppod", b.x + 4, b.y - 8)).toBeNull();
  });

  it("no building goes up on one", () => {
    const w = createMapWorld("archipelago");
    // an island Ground tile, with a friendly building in range of it in every other way
    let spot: { x: number; y: number } | null = null;
    for (let y = 44; y < 52 && !spot; y++)
      for (let x = 44; x < 52 && !spot; x++)
        if (terrainAt(w, x, y) === Terrain.Ground && terrainAt(w, x + 1, y) === Terrain.Ground) spot = { x, y };
    expect(spot).not.toBeNull();
    expect(onHomeLand(w, "blue", spot!.x, spot!.y)).toBe(false);
    const hq = hqOf(w, "blue")!;
    expect(canPlaceBuilding(w, "blue", "turret", hq.tx + 4, hq.ty)).toBe(true);
    // even with a friendly building in build range of it (planted by the test: a shore outpost)
    const outpost = { ...hq, id: 99999, kind: "radar" as const, tx: spot!.x - 4, ty: spot!.y };
    w.buildings.set(outpost.id, outpost);
    expect(BUILDINGS.turret.size).toBe(1);
    expect(canPlaceBuilding(w, "blue", "turret", spot!.x, spot!.y)).toBe(false);
  });
});

describe("the free replacement Condor", () => {
  const kill = (w: World, u: Unit) => {
    u.hp = 0;
    runTicks(w, 1);
  };

  it("flies in from the edge nearest the HQ after LIFELINE.delay, with a squad when the side is short", () => {
    const w = createMapWorld("archipelago");
    const [c] = own(w, "blue", "condor");
    // land the squad first so the lost Condor doesn't take it down too
    const squad = c!.passengers!.pop()!;
    squad.x = besideHq(w, "blue").x;
    squad.y = besideHq(w, "blue").y;
    w.units.set(squad.id, squad);
    const meter = w.powers.meter.blue;
    kill(w, c!);
    expect(w.wrecks.some((r) => r.kind === "condor")).toBe(false); // a free Condor leaves nothing to salvage
    expect(w.powers.meter.blue).toBeCloseTo(meter + POWERS.passive / TICK_RATE, 6); // …and charges nothing
    expect(hasCondor(w, "blue")).toBe(false);
    expect(w.lifeline!.blue.due).not.toBeNull();
    runTicks(w, LIFELINE.delay * TICK_RATE - 2);
    expect(own(w, "blue", "condor")).toHaveLength(0);
    runTicks(w, 2);
    const [fresh] = own(w, "blue", "condor");
    expect(fresh).toBeDefined();
    expect(fresh!.free).toBe(true);
    // one squad on the field (< LIFELINE.squadUnder): a free one comes aboard
    expect(squadCount(w, "blue")).toBe(2);
    expect(fresh!.passengers![0]!.free).toBe(true);
    // at the map edge, heading for the HQ
    const route = lifelineRoute(w, "blue")!;
    expect(Math.min(fresh!.x, w.width - fresh!.x, fresh!.y, w.height - fresh!.y)).toBeLessThan(LIFELINE.edgeInset + 0.5);
    expect(fresh!.order).toEqual({ type: "move", x: route.to.x, y: route.to.y });
    runTicks(w, 15 * TICK_RATE);
    expect(Math.hypot(fresh!.x - route.to.x, fresh!.y - route.to.y)).toBeLessThan(1.5);
  });

  it("brings no squad to a side that already has two, and never while a Condor is being built", () => {
    const w = createMapWorld("archipelago");
    const [c] = own(w, "blue", "condor");
    spawnUnit(w, "trooper", "blue", besideHq(w, "blue").x, besideHq(w, "blue").y);
    spawnUnit(w, "rocket-squad", "blue", besideHq(w, "blue").x + 1, besideHq(w, "blue").y);
    kill(w, c!); // (its squad went down with it, over its own base: bailed out)
    const squads = squadCount(w, "blue");
    expect(squads).toBeGreaterThanOrEqual(2);
    runTicks(w, LIFELINE.delay * TICK_RATE + 1);
    const [fresh] = own(w, "blue", "condor");
    expect(fresh!.passengers).toEqual([]);
    // an Airpad building one holds the free one back
    const w2 = createMapWorld("archipelago");
    const [c2] = own(w2, "blue", "condor");
    const hq = hqOf(w2, "blue")!;
    const pad = { ...hq, id: 99998, kind: "airpad" as const, tx: hq.tx + 5, ty: hq.ty - 4, queue: [{ kind: "condor" as const, remaining: 9999 }] };
    w2.buildings.set(pad.id, pad);
    kill(w2, c2!);
    expect(w2.lifeline!.blue.due).toBeNull();
  });

  it("routes are mirror images for the two sides", () => {
    const w = createMapWorld("archipelago");
    const b = lifelineRoute(w, "blue")!;
    const r = lifelineRoute(w, "red")!;
    expect(r.from.x).toBeCloseTo(w.width - b.from.x, 9);
    expect(r.from.y).toBeCloseTo(w.height - b.from.y, 9);
    expect(r.to.x).toBeCloseTo(w.width - b.to.x, 9);
    expect(r.to.y).toBeCloseTo(w.height - b.to.y, 9);
    expect(passable(w, Math.floor(b.to.x), Math.floor(b.to.y), "air")).toBe(true);
  });

  it("isn't handed out on other maps, nor in Last Stand on this one", () => {
    expect(createMapWorld("riverlands").lifeline).toBeUndefined();
    expect(createMapWorld("archipelago", { survival: { difficulty: "normal" } }).lifeline).toBeUndefined();
    expect(mapById("archipelago").lastStand).toBe(false);
    expect(isInfantry("trooper") && UNITS.condor.capacity).toBe(2);
    expect(carrierOf(createMapWorld("riverlands"), 1)).toBeNull();
  });
});
