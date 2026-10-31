import { BUILDINGS, ECONOMY, TICK_RATE, UNITS } from "../sim/balance";
import { paidFor } from "../sim/economy";
import { unitCost } from "../sim/goliath";
import type { Command, Faction, PendingBuilding, UnitKind, World } from "../sim/types";

/**
 * A side's construction, scrap and queues as the build bar shows them: the
 * world's, with the placement and production orders still on their way
 * applied (Controller.inFlight). In a sound duel an order lands D ticks after
 * the tap, and the bar must not offer the same tap again meanwhile: a placed
 * building is no longer ready to place, one started is under construction,
 * a unit ordered is queued and paid for, a building sold is paid back and
 * gone, an anchored Goliath packing up trains no more. Without orders in
 * flight it is the world's own state.
 */
export interface BuildView {
  scrap: number;
  pending: PendingBuilding | null;
  /** Units queued at producer `id` beyond its queue in the world (of `kind` only, when given; negative: cancels on their way). */
  extra(id: number, kind?: UnitKind): number;
  /** Is producer `id` gone (sold), or a Goliath packing up (it trains only anchored)? */
  closed(id: number): boolean;
}

/** buildView's rules: each order as the sim would take it now (economy.ts), in the order they were given. */
export function buildView(w: World, side: Faction, orders: readonly Command[] | null): BuildView {
  const f = w.factions[side];
  if (!orders?.length) return { scrap: f.scrap, pending: f.pending, extra: () => 0, closed: () => false };
  let scrap = f.scrap;
  let pending: PendingBuilding | null = f.pending;
  const queued: { id: number; kind: UnitKind; n: number; paid: number }[] = [];
  const closed = new Set<number>();
  for (const c of orders)
    switch (c.type) {
      case "startBuilding":
        if (!pending && scrap >= BUILDINGS[c.building].cost) {
          scrap -= BUILDINGS[c.building].cost;
          pending = { kind: c.building, remaining: BUILDINGS[c.building].buildTime * TICK_RATE, ready: false };
        }
        break;
      case "cancelBuilding":
        if (pending) scrap += BUILDINGS[pending.kind].cost;
        pending = null;
        break;
      case "placeBuilding":
        if (pending?.ready) pending = null;
        break;
      case "produce": {
        const cost = unitCost(w, side, c.unit);
        if (scrap >= cost && !closed.has(c.buildingId)) {
          scrap -= cost;
          queued.push({ id: c.buildingId, kind: c.unit, n: 1, paid: cost });
        }
        break;
      }
      case "cancelProduce": {
        // (one of ours still on its way goes first; else one the world holds, refunded)
        let i = -1;
        for (let k = queued.length - 1; k >= 0; k--)
          if (queued[k]!.id === c.buildingId && queued[k]!.kind === c.unit && queued[k]!.n > 0) {
            i = k;
            break;
          }
        if (i >= 0) {
          scrap += queued[i]!.paid;
          queued.splice(i, 1);
        } else {
          scrap += UNITS[c.unit].cost;
          queued.push({ id: c.buildingId, kind: c.unit, n: -1, paid: 0 });
        }
        break;
      }
      case "sell": {
        // (economy.ts sellBuilding: its health's share of the price, and what its queue paid: ours on the way
        // in, the cancels on the way, refunded already, out)
        const b = w.buildings.get(c.buildingId);
        if (!b || b.faction !== side || b.kind === "hq" || closed.has(b.id)) break;
        let paid = b.queue.reduce((s, q) => s + paidFor(q), 0);
        for (let k = queued.length - 1; k >= 0; k--)
          if (queued[k]!.id === b.id) {
            paid += queued[k]!.n > 0 ? queued[k]!.paid : -UNITS[queued[k]!.kind].cost;
            queued.splice(k, 1);
          }
        scrap += Math.floor(BUILDINGS[b.kind].cost * ECONOMY.sellRefund * (b.hp / BUILDINGS[b.kind].hp) + paid);
        closed.add(b.id);
        break;
      }
      case "packUp":
        for (const id of c.unitIds) {
          const g = w.units.get(id)?.goliath;
          if (g && (g.mode === "anchored" || g.mode === "anchoring")) closed.add(id);
        }
        break;
    }
  return {
    scrap,
    pending,
    extra: (id, kind) => queued.reduce((n, q) => n + (q.id === id && (kind === undefined || q.kind === kind) ? q.n : 0), 0),
    closed: (id) => closed.has(id)
  };
}
