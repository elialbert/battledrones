/**
 * Each side's own frame (AGENT-BATTLES.md): every map is point-symmetric and
 * red plays it turned 180°, so the arena shows every agent the map from its
 * own corner — its HQ lower left, the enemy's upper right — and turns its
 * orders back. In a mirror match the two sides then read identical
 * observations, apart from the ids.
 *
 * Tiles: own tile (fx, fy) is world tile (W-1-fx, H-1-fy) for red. Points
 * (unit positions) turn about the map centre: x → W - x.
 */
import { BUILDINGS } from "../sim/balance";
import type { BuildingKind, Faction, World } from "../sim/types";

export interface Frame {
  side: Faction;
  flip: boolean;
  width: number;
  height: number;
  /** A world point in this side's frame (continuous). */
  pt(x: number, y: number): { x: number; y: number };
  /** The own-frame tile a world point stands on. */
  tile(x: number, y: number): [number, number];
  /** Centre of own-frame tile (fx, fy), as a world point. */
  center(fx: number, fy: number): { x: number; y: number };
  /** World tile of own-frame tile (fx, fy). */
  worldTile(fx: number, fy: number): [number, number];
  /** Own-frame top-left of a building footprint whose world top-left is (tx, ty). */
  topLeft(kind: BuildingKind, tx: number, ty: number): [number, number];
  /** World top-left of a footprint whose own-frame top-left is (fx, fy). */
  worldTopLeft(kind: BuildingKind, fx: number, fy: number): [number, number];
}

export function frameOf(w: Pick<World, "width" | "height">, side: Faction): Frame {
  const W = w.width;
  const H = w.height;
  const flip = side === "red";
  const size = (k: BuildingKind) => BUILDINGS[k].size;
  return {
    side,
    flip,
    width: W,
    height: H,
    pt: (x, y) => (flip ? { x: W - x, y: H - y } : { x, y }),
    tile: (x, y) => {
      const p = flip ? { x: W - x, y: H - y } : { x, y };
      return [clamp(Math.floor(p.x), 0, W - 1), clamp(Math.floor(p.y), 0, H - 1)];
    },
    center: (fx, fy) => {
      const x = Math.floor(fx) + 0.5;
      const y = Math.floor(fy) + 0.5;
      return flip ? { x: W - x, y: H - y } : { x, y };
    },
    worldTile: (fx, fy) => (flip ? [W - 1 - Math.floor(fx), H - 1 - Math.floor(fy)] : [Math.floor(fx), Math.floor(fy)]),
    topLeft: (kind, tx, ty) => (flip ? [W - tx - size(kind), H - ty - size(kind)] : [tx, ty]),
    worldTopLeft: (kind, fx, fy) => (flip ? [W - Math.floor(fx) - size(kind), H - Math.floor(fy) - size(kind)] : [Math.floor(fx), Math.floor(fy)])
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export const enemyOf = (f: Faction): Faction => (f === "blue" ? "red" : "blue");

/** "3:05" for a tick count. */
export function clock(tick: number, tickRate = 10): string {
  const s = Math.floor(tick / tickRate);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
