import type { Command } from "../sim/types";

/** The same point, as the codec gives it back (snapped to the centre of its 1/16-tile cell); both missing counts too. */
const samePoint = (a: { x?: number; y?: number }, b: { x?: number; y?: number }): boolean =>
  a.x === undefined || b.x === undefined ? a.x === b.x : Math.abs(a.x - b.x) <= 1 / 16 && Math.abs(a.y! - b.y!) <= 1 / 16;

/** The same order, its unit list aside (its faction too: the codec stamps the sender's side). */
function sameOrder(a: Command, b: Command): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case "startBuilding":
      return b.type === a.type && a.building === b.building;
    case "placeBuilding":
      return b.type === a.type && a.tx === b.tx && a.ty === b.ty;
    case "produce":
    case "cancelProduce":
      return (b.type === "produce" || b.type === "cancelProduce") && a.buildingId === b.buildingId && a.unit === b.unit;
    case "move":
    case "attackMove":
    case "harvest":
    case "unload":
      return samePoint(a, b as typeof a);
    case "attack":
      return b.type === a.type && a.targetId === b.targetId;
    case "board":
      return b.type === a.type && a.carrierId === b.carrierId;
    case "lift":
      return b.type === a.type && a.goliathId === b.goliathId;
    case "sell":
      return b.type === a.type && a.buildingId === b.buildingId;
    case "rally":
      return b.type === a.type && a.buildingId === b.buildingId && samePoint(a, b);
    case "calldown":
      return b.type === a.type && a.power === b.power && samePoint(a, b);
    default:
      return true;
  }
}

/**
 * Orders drained but not applied yet, oldest first, each with the tick it
 * was drained on. An interactive feed carries them: they land D ticks
 * after the tap, or later while the link holds them up. The Controller
 * owns whether tracking is enabled and invalidates its preview cache.
 */
export class InFlight {
  private flights: { c: Command; at: number }[] = [];

  get length(): number {
    return this.flights.length;
  }

  /** The orders on their way, oldest first. */
  get commands(): Command[] {
    return this.flights.map((f) => f.c);
  }

  /** Retain each command's original drain tick, including after a partial landing. */
  add(commands: readonly Command[], at: number): void {
    for (const c of commands) this.flights.push({ c, at });
  }

  /**
   * This side's commands that a step just applied: their in-flight copies
   * come off, the oldest of each that matches, as the lockstep keeps their
   * order. The codec splits a long unit list into pieces the lockstep may
   * seal into turns of their own: each piece takes just its units off.
   */
  landed(applied: readonly Command[]): void {
    const fl = this.flights;
    for (const c of applied) {
      if (!("unitIds" in c)) {
        const i = fl.findIndex((f) => sameOrder(f.c, c));
        if (i >= 0) fl.splice(i, 1);
        continue;
      }
      let left: readonly number[] = c.unitIds;
      for (let i = 0; i < fl.length && left.length > 0; i++) {
        const f = fl[i]!.c;
        if (!("unitIds" in f) || !sameOrder(f, c) || !f.unitIds.some((id) => left.includes(id))) continue;
        const rest = f.unitIds.filter((id) => !left.includes(id));
        left = left.filter((id) => !f.unitIds.includes(id));
        if (rest.length > 0) fl[i] = { c: { ...f, unitIds: rest }, at: fl[i]!.at };
        else fl.splice(i--, 1);
      }
    }
  }

  /**
   * Everything drained on tick `through` or before has landed or never will
   * (the feed knows: the lockstep had none of it waiting, and its turn is
   * stepped). Return whether any remaining orders were removed.
   */
  settled(through: number): boolean {
    const fl = this.flights;
    if (!fl.length || fl[0]!.at > through) return false;
    this.flights = fl.filter((f) => f.at > through);
    return true;
  }

  /** No order on its way will land (the match ended without a result). */
  drop(): void {
    this.flights.splice(0);
  }
}
