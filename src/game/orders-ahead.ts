import { GOLIATH, TICK_RATE } from "../sim/balance";
import { isInfantry, isTransport } from "../sim/infantry";
import { canCarry, liftBlocker, liftedBy } from "../sim/lift";
import { isLoaded } from "../sim/transport";
import type { Command, GoliathMode, PowerKind, Unit, UnitOrder, World } from "../sim/types";
import { isResource, tileIndex } from "../sim/world";

/** The lift a unit belongs to: the Goliath itself (hooked on or carried), or the Goliath its Condor is lifting. */
const liftOf = (w: World, u: Unit): Unit | null => (u.goliath?.lift ? u : liftedBy(w, u));

/**
 * The player's units as the Controller reads them (Controller.ahead()): the
 * world's, with this side's own orders still on their way applied, in the
 * order they were given. In a sound duel an order lands D ticks after the
 * tap (later while the link holds it up), and a tap that builds on the one
 * before must find that one done, as single player does a tick later: two
 * Condors sent to lift a Goliath and then the map tapped fly the lift there
 * once it is up; squads sent to board and then an island tapped drop there
 * once aboard; a Goliath told to anchor and then the map tapped stays dug in
 * and sets a rally point; a second ⚓ packs it up. So every read that decides
 * such a tap goes through here: each unit's order, a Goliath's mode and lift,
 * a building sold, a rally point moved, the calldowns fired. The rules are
 * the sim's (sim.ts applyCommand, lift.ts routeLiftCommand and
 * applyLiftCommand, transport.ts, goliath.ts), taken as succeeding where they
 * hang on the ground (an anchor the Controller checked when it sent it): an
 * order the sim then refuses just never shows once it lands. Only reads
 * change here: what is sent, and how the sim applies it, never do. With no
 * orders on their way it is the world as it is.
 */
export interface OrdersAhead {
  /** Unit `u` with its order, and a Goliath's mode and lift, as the orders on their way leave them: a copy, or `u` itself when none touches it. */
  unit(u: Unit): Unit;
  /** The lift `u` belongs to (liftOf): its Goliath as unit() has it, or null. */
  liftOf(u: Unit): Unit | null;
  /** Is building `id` sold by an order on its way? */
  sold(id: number): boolean;
  /** Producer `id`'s rally point as the newest order on its way sets it (null: none does). */
  rally(id: number): { x: number; y: number } | null;
  /** The calldowns on their way, oldest first. */
  readonly fired: readonly PowerKind[];
}

const IDLE: UnitOrder = { type: "idle" };
/** The orders a lift takes (lift.ts LiftOrder): they call off one still hooking on when they name its Condors. */
const isLiftOrder = (c: Command): boolean => c.type === "move" || c.type === "attackMove" || c.type === "unload" || c.type === "stop";

/** ordersAhead's rules, over the world's units and the commands in the order they were given. */
export function ordersAhead(w: World, orders: readonly Command[] | null): OrdersAhead {
  if (!orders?.length) return { unit: (u) => u, liftOf: (u) => liftOf(w, u), sold: () => false, rally: () => null, fired: [] };
  const copies = new Map<number, Unit>();
  const sold = new Set<number>();
  const rally = new Map<number, { x: number; y: number }>();
  const fired: PowerKind[] = [];
  /** Unit `id` as the orders so far leave it. */
  const get = (id: number): Unit | undefined => copies.get(id) ?? w.units.get(id);
  /** Unit `u`'s copy to change (its Goliath state copied too: nothing of the world's is ever touched). */
  const edit = (u: Unit): Unit => {
    let c = copies.get(u.id);
    if (!c) {
      c = u.goliath ? { ...u, goliath: { ...u.goliath } } : { ...u };
      copies.set(u.id, c);
    }
    return c;
  };
  /** goliath.ts setMode: the transition starts from the top, so the HUD's progress reads 0%. */
  const setMode = (u: Unit, mode: GoliathMode, seconds: number) => {
    const g = edit(u).goliath!;
    g.mode = mode;
    g.modeTicks = Math.round(seconds * TICK_RATE);
  };
  /** lift.ts liftedBy, on the units as the orders so far leave them. */
  const liftedByNow = (c: Unit): Unit | null => {
    if (c.order.type !== "lift") return null;
    const g = get(c.order.goliathId);
    return g?.goliath?.lift?.carriers.includes(c.id) ? g : null;
  };
  /** The units command `c` names that are its side's, as they stand now. */
  const named = (c: Extract<Command, { unitIds: number[] }>, lifting?: ReadonlySet<number>): Unit[] => {
    const out: Unit[] = [];
    for (const id of c.unitIds) {
      const u = get(id);
      if (u && u.faction === c.faction && !lifting?.has(id)) out.push(u);
    }
    return out;
  };
  for (const c of orders) {
    // a lift's own orders first (lift.ts routeLiftCommand): they leave its members out of the rest, and one
    // naming the Condors of a lift still hooking on calls it off (its Condors go idle and take the order)
    const lifting = new Set<number>();
    if ("unitIds" in c && c.type !== "lift")
      for (const id of c.unitIds) {
        // (each as it stands now: a Condor named earlier may have called this one's lift off)
        const u = get(id);
        if (!u || u.faction !== c.faction) continue;
        const g = u.goliath?.lift ? u : liftedByNow(u);
        const lift = g?.goliath?.lift;
        if (!g || !lift) continue;
        lifting.add(u.id);
        if (lift.phase !== "hooking" || u.goliath || !isLiftOrder(c)) continue;
        for (const id of lift.carriers) {
          const k = get(id);
          if (k?.order.type === "lift" && k.order.goliathId === g.id) edit(k).order = IDLE;
        }
        edit(g).goliath!.lift = null;
        lifting.delete(u.id);
        lifting.delete(g.id);
      }
    switch (c.type) {
      case "move":
      case "attackMove":
        for (const u of named(c, lifting)) {
          const e = edit(u);
          e.order = { type: c.type, x: c.x, y: c.y };
          // (goliath.ts orderedToMove: an anchored Goliath packs up first)
          if (e.goliath && !e.goliath.lift && (e.goliath.mode === "anchored" || e.goliath.mode === "anchoring")) setMode(e, "packing", GOLIATH.packTime);
        }
        break;
      case "attack":
        for (const u of named(c, lifting)) edit(u).order = { type: "attack", targetId: c.targetId };
        break;
      case "harvest": {
        const tx = Math.floor(c.x);
        const ty = Math.floor(c.y);
        if (tx < 0 || ty < 0 || tx >= w.width || ty >= w.height || !isResource(w, tileIndex(w, tx, ty))) break;
        for (const u of named(c, lifting)) if (u.kind === "harvester") edit(u).order = { type: "harvest", fieldX: tx, fieldY: ty, phase: "toField" };
        break;
      }
      case "stop":
        for (const u of named(c, lifting)) edit(u).order = IDLE;
        break;
      case "board": {
        const carrier = get(c.carrierId);
        if (!carrier || carrier.faction !== c.faction || !isTransport(carrier.kind)) break;
        for (const u of named(c)) if (isInfantry(u.kind)) edit(u).order = { type: "board", carrierId: carrier.id, ticks: 0 };
        break;
      }
      case "unload":
        for (const u of named(c, lifting)) if (isLoaded(u)) edit(u).order = { type: "unload", x: c.x ?? u.x, y: c.y ?? u.y, hover: -1 };
        break;
      case "anchor":
        for (const u of named(c))
          if (u.goliath && !u.goliath.lift && u.goliath.mode === "walking") {
            edit(u).order = IDLE;
            setMode(u, "anchoring", GOLIATH.anchorTime);
          }
        break;
      case "packUp":
        for (const u of named(c)) if (u.goliath?.mode === "anchored" || u.goliath?.mode === "anchoring") setMode(u, "packing", GOLIATH.packTime);
        break;
      case "lift": {
        const g = get(c.goliathId);
        if (!g || g.faction !== c.faction || !g.goliath) break;
        const condors = named(c).filter((u, i, all) => canCarry(u) && all.indexOf(u) === i);
        if (liftBlocker(condors, g)) break;
        // (the two nearest, ties to the earlier-built)
        condors.sort((a, b) => dist(a, g) - dist(b, g) || a.id - b.id);
        const [a, b] = condors as [Unit, Unit];
        for (const k of [a, b]) edit(k).order = { type: "lift", goliathId: g.id };
        const e = edit(g);
        e.order = IDLE;
        e.goliath!.lift = { carriers: [a.id, b.id], phase: "hooking", dest: null, setDown: false };
        break;
      }
      case "sell":
        sold.add(c.buildingId);
        break;
      case "rally":
        rally.set(c.buildingId, { x: c.x, y: c.y });
        break;
      case "calldown":
        fired.push(c.power);
        break;
    }
  }
  return {
    unit: (u) => copies.get(u.id) ?? u,
    liftOf: (u) => {
      const a = copies.get(u.id) ?? u;
      return a.goliath?.lift ? a : liftedByNow(a);
    },
    sold: (id) => sold.has(id),
    rally: (id) => rally.get(id) ?? null,
    fired
  };
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
