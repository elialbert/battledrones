// Observer only: complete-world measurements must never feed bot decisions.
import { BUILDINGS, ECONOMY, TICK_RATE, UNITS } from "../../src/sim/balance";
import type { Faction, World } from "../../src/sim/types";
import { economyFields } from "../../src/sim/ai/economy-front";
import { dist } from "../../src/sim/world";

export function measure(w: World, side: Faction) {
  const units = [...w.units.values()].filter(u => u.faction === side);
  const miners = units.filter(u => u.kind === "harvester");
  const army = units.filter(u => u.kind !== "harvester" && UNITS[u.kind].dps > 0);
  const buildings = [...w.buildings.values()].filter(b => b.faction === side);
  const mix: Record<string, number> = {};
  for (const h of miners) {
    const k = h.order.type === "harvest" ? h.order.phase : h.order.type;
    mix[k] = (mix[k] ?? 0) + 1;
  }
  return { tick: w.tick, seconds: w.tick / TICK_RATE, side,
    delivered: w.factions[side].stats.scrapHarvested,
    rawLeft: w.scrap.reduce((a, b) => a + b, 0),
    miners: miners.length, cargo: miners.reduce((n, u) => n + u.cargo, 0), mix,
    army: army.reduce((n, u) => n + UNITS[u.kind].cost, 0),
    armyCount: army.length,
    armyHp: army.reduce((n, u) => n + UNITS[u.kind].cost * u.hp / UNITS[u.kind].hp, 0),
    bank: w.factions[side].scrap,
    queues: buildings.map(b => ({ id: b.id, kind: b.kind, queue: b.queue.map(q => q.kind) })),
    buildingValue: buildings.reduce((n, b) => n + BUILDINGS[b.kind].cost, 0),
    uplinks: w.objectives.uplinks.filter(l => l.owner === side).length,
    uplinkIncome: w.objectives.stats[side].uplinkScrap,
    crates: w.objectives.stats[side].crates, crateIncome: w.objectives.stats[side].crateScrap,
    fields: economyFields(w, side).map(f => ({ id: f.id, raw: f.raw, scrap: f.scrap })),
    depots: buildings.filter(b => b.kind === "depot").map(b => ({ id: b.id, x: b.tx, y: b.ty, hp: b.hp })) };
}

export class EconomyObserver {
  private before = new Map<number, { cargo: number; unloading: boolean; side: Faction }>();
  private queues = new Set<object>();
  private pending = new Map<Faction, object | null>();
  private unloadingAt = new Map<number, number>();
  private depots = new Map<number, { side: Faction; born: number; firstDelivery: number | null; delivered: number; lost: number | null }>();
  private totals = new Map<Faction, { minersLost: number; crewConsumed: number; cargoLost: number; armyLost: number; armySpend: number; minerSpend: number; buildingSpend: number; uplinkSeconds: number }>();
  private history = new Map<Faction, { tick: number; delivered: number; sent: number }[]>();
  private commands = new Map<Faction, number[]>();
  private mix = new Map<Faction, Record<string, number>>();
  constructor(private w: World) {
    for (const side of ["blue", "red"] as const) this.totals.set(side, { minersLost: 0, crewConsumed: 0, cargoLost: 0, armyLost: 0, armySpend: 0, minerSpend: 0, buildingSpend: 0, uplinkSeconds: 0 });
  }
  beforeStep() {
    this.before.clear(); this.queues.clear();
    for (const u of this.w.units.values()) if (u.kind === "harvester") this.before.set(u.id, { cargo: u.cargo, unloading: u.order.type === "harvest" && u.order.phase === "unloading", side: u.faction });
    for (const b of this.w.buildings.values()) for (const q of b.queue) this.queues.add(q);
    for (const side of ["blue", "red"] as const) this.pending.set(side, this.w.factions[side].pending);
  }
  sent(side: Faction, cmds: { type: string }[], apm: number, burst: number) {
    const times = (this.commands.get(side) ?? []).filter(t => this.w.tick - t < 60 * TICK_RATE);
    times.push(...cmds.map(() => this.w.tick)); this.commands.set(side, times);
    if (times.length > apm + burst) throw new Error(`Rolling action cap exceeded by ${side}`);
    const mix = this.mix.get(side) ?? {};
    for (const c of cmds) mix[c.type] = (mix[c.type] ?? 0) + 1;
    this.mix.set(side, mix);
  }
  afterStep() {
    const w = this.w;
    for (const b of w.buildings.values()) {
      if (b.kind === "depot" && !this.depots.has(b.id)) {
        this.depots.set(b.id, { side: b.faction, born: w.tick, firstDelivery: null, delivered: 0, lost: null });
        if (b.founding !== undefined) this.totals.get(b.faction)!.buildingSpend += ECONOMY.expansion.cost;
      }
      for (const q of b.queue) if (!this.queues.has(q)) {
        const totals = this.totals.get(b.faction)!;
        if (q.kind === "harvester") totals.minerSpend += q.paid ?? UNITS[q.kind].cost;
        else totals.armySpend += q.paid ?? UNITS[q.kind].cost;
      }
    }
    for (const side of ["blue", "red"] as const) {
      const pending = w.factions[side].pending;
      if (pending && pending !== this.pending.get(side)) this.totals.get(side)!.buildingSpend += BUILDINGS[pending.kind].cost;
      this.totals.get(side)!.uplinkSeconds += w.objectives.uplinks.filter(l => l.owner === side).length / TICK_RATE;
    }
    for (const ev of w.fx) {
      if (ev.type === "deposit") {
        const depot = [...w.buildings.values()].find(b => b.faction === ev.faction && BUILDINGS[b.kind].dropOff && dist(ev.x, ev.y, b.tx + BUILDINGS[b.kind].size / 2, b.ty + BUILDINGS[b.kind].size / 2) < 0.1);
        if (depot) this.unloadingAt.set(ev.id, depot.id);
      } else if (ev.type === "founded") this.totals.get(ev.faction)!.crewConsumed++;
      else if (ev.type === "death") {
        const totals = this.totals.get(ev.faction)!;
        if (ev.unitKind === "harvester") { totals.minersLost++; totals.cargoLost += this.before.get(ev.id)?.cargo ?? 0; }
        else if (ev.unitKind) totals.armyLost += ev.value;
        if (this.depots.has(ev.id)) this.depots.get(ev.id)!.lost = w.tick;
      }
    }
    for (const [id, before] of this.before) if (before.unloading) {
      const u = w.units.get(id);
      const site = this.depots.get(this.unloadingAt.get(id) ?? -1);
      if (u && site && u.cargo < before.cargo) { site.delivered += before.cargo - u.cargo; site.firstDelivery ??= w.tick; }
    }
  }
  sample(side: Faction, sent: number) {
    const base = measure(this.w, side);
    const history = (this.history.get(side) ?? []).filter(s => this.w.tick - s.tick <= 30 * TICK_RATE);
    history.push({ tick: this.w.tick, delivered: base.delivered, sent }); this.history.set(side, history);
    return { ...base, ...this.totals.get(side),
      miningIncome30s: history.length > 1 ? base.delivered - history[0]!.delivered : null,
      incomeWindowSeconds: (this.w.tick - history[0]!.tick) / TICK_RATE,
      rolling60sCommands: this.commands.get(side)?.length ?? 0, commandMix: { ...this.mix.get(side) },
      expansions: [...this.depots].filter(([, d]) => d.side === side).map(([id, d]) => ({ id, ...d })) };
  }
}
