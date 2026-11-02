import { describe, expect, it } from "vitest";
import { createMapWorld } from "../src/sim/maps";
import { tickMovement } from "../src/sim/movement";
import type { Faction, Unit, UnitKind, UnitOrder, World } from "../src/sim/types";
import { passable, spawnUnit } from "../src/sim/world";

/** An open 5×5 patch of ground on Proving Grounds: its centre. */
function openSpot(w: World): { x: number; y: number } {
  for (let ty = 5; ty < w.height - 5; ty++)
    for (let tx = 5; tx < w.width - 5; tx++) {
      let ok = true;
      for (let dy = -2; dy <= 2 && ok; dy++) for (let dx = -2; dx <= 2 && ok; dx++) ok = passable(w, tx + dx, ty + dy, "ground");
      if (ok && ![...w.buildings.values()].some((b) => Math.hypot(b.tx - tx, b.ty - ty) < 8)) return { x: tx + 0.5, y: ty + 0.5 };
    }
  throw new Error("no open ground");
}

const FOUND: UnitOrder = { type: "found", tx: 0, ty: 0 };
const FULL: UnitOrder = { type: "harvest", fieldX: 0, fieldY: 0, phase: "toBase" };
const EMPTY: UnitOrder = { type: "harvest", fieldX: 0, fieldY: 0, phase: "toField" };

/** Two units overlapping side by side, one separation pass: how far each was pushed. */
function bump(a: { kind: UnitKind; order: UnitOrder; cargo?: number }, b: { kind: UnitKind; order: UnitOrder; cargo?: number; faction?: Faction }) {
  const w = createMapWorld("proving-grounds");
  const p = openSpot(w);
  const put = (s: typeof b, x: number): Unit => {
    const u = spawnUnit(w, s.kind, s.faction ?? "blue", x, p.y);
    u.order = s.order;
    u.cargo = s.cargo ?? 0;
    u.facing = Math.PI / 2; // (facing +x: b is dead ahead of a)
    return u;
  };
  const ua = put(a, p.x);
  const ub = put(b, p.x + 0.3);
  tickMovement(w, new Set());
  return { a: Math.hypot(ua.x - p.x, ua.y - p.y), b: Math.hypot(ub.x - (p.x + 0.3), ub.y - p.y) };
}

describe("harvesters' right of way (movement.ts harvesterRank): founding > full > empty", () => {
  it("a founding harvester shoulders a full one aside, and a full one an empty one; it keeps its own line", () => {
    for (const [hi, lo] of [
      [{ kind: "harvester", order: FOUND }, { kind: "harvester", order: FULL, cargo: 50 }],
      [{ kind: "harvester", order: FULL, cargo: 50 }, { kind: "harvester", order: EMPTY }],
      [{ kind: "harvester", order: FOUND }, { kind: "harvester", order: EMPTY }]
    ] as const) {
      // (whichever of the pair comes first in the world's units)
      for (const [a, b, mover] of [[hi, lo, "b"], [lo, hi, "a"]] as const) {
        const d = bump(a, b);
        expect(d[mover]).toBeGreaterThan(0.2);
        expect(d[mover === "a" ? "b" : "a"]).toBe(0);
      }
    }
  });

  it("a founding harvester pushes its own army aside, a Stinger or a squad; other harvesters share the push with the army", () => {
    for (const kind of ["stinger", "trooper"] as const) {
      const d = bump({ kind: "harvester", order: FOUND }, { kind, order: { type: "idle" } });
      expect(d.a, kind).toBe(0);
      expect(d.b, kind).toBeGreaterThan(0.2);
    }
    const full = bump({ kind: "harvester", order: FULL, cargo: 50 }, { kind: "stinger", order: { type: "idle" } });
    expect(full.a).toBeGreaterThan(0);
    expect(full.b).toBeGreaterThan(0);
  });

  it("gives no right of way against the enemy: a founding harvester and an enemy Stinger share the push", () => {
    const d = bump({ kind: "harvester", order: FOUND }, { kind: "stinger", order: { type: "idle" }, faction: "red" });
    expect(d.a).toBeGreaterThan(0);
    expect(d.b).toBeGreaterThan(0);
  });
});
