/**
 * Who is in the match, and each side's own frame of the map.
 *
 * A classic match is blue against red, and every 2-player map is point-
 * symmetric: red plays it turned 180°. A four-player map (MapDef.players: 4)
 * is symmetric under a quarter turn about its centre, and seats one side in
 * each corner: blue bottom left, then clockwise green (top left), red (top
 * right, where it always sits) and purple (bottom right). Each side's frame is
 * the map turned so its own HQ sits bottom left, as blue sees it: a search
 * whose tie-breaks depend on scan order runs in that frame, so mirror-image
 * situations resolve as mirror images for every side (world.ts sideFrame).
 *
 * `World.sides` lists the sides playing, in the canonical order every tick's
 * commands and every per-side loop use (blue, red, green, purple). Absent, as in
 * every 2-player world and every saved record, it is blue and red: nothing
 * about those matches changes.
 *
 * In a four-player match it is every side for itself: anything not yours is
 * hostile. A side is out once its HQ and every Goliath are gone (its forces
 * self-destruct, combat.ts eliminate); the last side standing wins.
 */
import type { Faction, World } from "./types";

/** Every side there can be, in canonical order. */
export const FACTIONS: readonly Faction[] = ["blue", "red", "green", "purple"];
/** A classic match's sides. */
export const DUO: readonly Faction[] = ["blue", "red"];

export const isFaction = (s: unknown): s is Faction => typeof s === "string" && (FACTIONS as readonly string[]).includes(s);

/** The sides playing this match, in canonical order. */
export const sidesOf = (w: World): readonly Faction[] => w.sides ?? DUO;

/** More than two sides: a free-for-all (otherwise every rule plays exactly as a duel always has). */
export const isMulti = (w: World): boolean => (w.sides?.length ?? 2) > 2;

/** One value per side there can be (every Record<Faction, …> in the world has all four). */
export function perSide<T>(make: (f: Faction) => T): Record<Faction, T> {
  return { blue: make("blue"), red: make("red"), green: make("green"), purple: make("purple") };
}

/** The other sides playing, in canonical order. */
export const rivalsOf = (w: World, f: Faction): Faction[] => sidesOf(w).filter((s) => s !== f);

/**
 * The one enemy of a duel. (A free-for-all has several: code that needs
 * this must ask rivalsOf, or the side a kill or a strike came from.)
 */
export const otherSide = (f: Faction): Faction => (f === "blue" ? "red" : "blue");

/** Quarter turns (clockwise on screen) from blue's frame to this side's: blue 0, green 1, red 2, purple 3. */
export const QUARTER: Readonly<Record<Faction, 0 | 1 | 2 | 3>> = { blue: 0, green: 1, red: 2, purple: 3 };

/** The side whose frame is `q` quarter turns from blue's. */
export const SIDE_AT_QUARTER: readonly Faction[] = ["blue", "green", "red", "purple"];

/**
 * A vector turned by q quarter turns (clockwise on screen, y down): one turn
 * takes (dx, dy) to (−dy, dx). Two is (−dx, −dy), exactly red's mirror.
 */
export function turnVec(q: number, dx: number, dy: number): [number, number] {
  switch (q & 3) {
    case 1:
      return [-dy, dx];
    case 2:
      return [-dx, -dy];
    case 3:
      return [dy, -dx];
    default:
      return [dx, dy];
  }
}

/**
 * A point (continuous tile coordinates) turned q quarter turns about the
 * centre of a w × h map. One turn takes (x, y) to (h − y, x), which needs a
 * square map; two is (w − x, h − y), red's mirror, on any map.
 */
export function turnPoint(q: number, width: number, height: number, x: number, y: number): { x: number; y: number } {
  switch (q & 3) {
    case 1:
      return { x: height - y, y: x };
    case 2:
      return { x: width - x, y: height - y };
    case 3:
      return { x: y, y: width - x };
    default:
      return { x, y };
  }
}

/** The top-left tile of a size² footprint at top-left (tx, ty), turned q quarter turns (as turnPoint). */
export function turnTile(q: number, width: number, height: number, tx: number, ty: number, size = 1): [number, number] {
  switch (q & 3) {
    case 1:
      return [height - ty - size, tx];
    case 2:
      return [width - tx - size, height - ty - size];
    case 3:
      return [ty, width - tx - size];
    default:
      return [tx, ty];
  }
}

/** How many copies a map's symmetry makes of each feature: 4 on a four-player map, else 2. */
export const symmetryOf = (w: World): 2 | 4 => (isMulti(w) ? 4 : 2);

/** The quarter turns that carry a feature onto its symmetric copies: [0, 2] on a 2-player map, [0, 1, 2, 3] on a four-player one. */
export const symmetryTurns = (w: World): readonly number[] => (isMulti(w) ? [0, 1, 2, 3] : [0, 2]);
