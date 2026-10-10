/**
 * Squads: three thumb-sized control groups for phones. Engine-free and
 * tested; the chips live in ../ui/command.ts, the Controller owns one.
 *
 * A unit belongs to at most one squad (saving it into another moves it),
 * so each chip's count, health bar and "hurt" flash are unambiguous.
 *
 * Infantry aboard a Condor have left the field (src/sim/transport.ts) but
 * are still members: the chip keeps counting them, and selecting the squad
 * selects the Condor carrying them (the one thing you can order about).
 */
import { UNITS } from "../sim/balance";
import type { Faction, FxEvent, Unit, UnitKind, World } from "../sim/types";

export const SQUAD = {
  slots: 3,
  /** A member being hit lights its chip red this long (ms, wall clock). */
  hurtMs: 1000,
  /** Second tap on the same chip within this flies the camera there (ms). */
  doubleTapMs: 400,
  /** Hold a chip this long to save the selection into it (ms). */
  holdMs: 400
};

export interface SquadSummary {
  /** Living members. */
  count: number;
  /** Most common kind (ties: the pricier one) — the chip's icon. */
  kind: UnitKind;
  /** Σ hp / Σ max hp over the living members, 0–1. */
  hp: number;
}

export class Squads {
  readonly slots: number[][] = Array.from({ length: SQUAD.slots }, () => []);
  /** Wall-clock ms until which each chip shows "hurt". */
  private hurtUntil: number[] = Array.from({ length: SQUAD.slots }, () => -Infinity);
  /** Bumped on every assign/clear so views can tell a squad changed. */
  version = 0;

  constructor(private faction: Faction) {}

  /** Save these units (own, living) as squad i, moving any that were in another squad. */
  assign(i: number, ids: Iterable<number>, w: World): number {
    if (i < 0 || i >= this.slots.length) return 0;
    const list = [...new Set(ids)].filter((id) => w.units.get(id)?.faction === this.faction);
    const set = new Set(list);
    for (let j = 0; j < this.slots.length; j++)
      if (j !== i) this.slots[j] = this.slots[j]!.filter((id) => !set.has(id));
    this.slots[i] = list;
    this.version++;
    return list.length;
  }

  clear(i: number): void {
    if (!this.slots[i] || this.slots[i]!.length === 0) return;
    this.slots[i] = [];
    this.version++;
  }

  /** Drop members that died (members riding in a Condor stay). */
  prune(w: World): void {
    let aboard: Map<number, Aboard> | null = null;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i]!;
      if (!s.some((id) => !w.units.has(id))) continue;
      aboard ??= aboardOf(w);
      const keep = aboard;
      this.slots[i] = s.filter((id) => w.units.has(id) || keep.has(id));
    }
  }

  /**
   * What selecting squad i selects: its members on the field, plus the
   * Condor carrying any member aboard (each once).
   */
  ids(i: number, w: World): number[] {
    const out: number[] = [];
    let aboard: Map<number, Aboard> | null = null;
    for (const id of this.slots[i] ?? []) {
      // (a member Condor may already be in, for a member riding in it)
      if (w.units.has(id)) {
        if (!out.includes(id)) out.push(id);
      } else {
        aboard ??= aboardOf(w);
        const c = aboard.get(id)?.carrier;
        if (c && c.faction === this.faction && !out.includes(c.id)) out.push(c.id);
      }
    }
    return out;
  }

  /** Living members of squad i, on the field or aboard a Condor. */
  members(i: number, w: World): Unit[] {
    const out: Unit[] = [];
    let aboard: Map<number, Aboard> | null = null;
    for (const id of this.slots[i] ?? []) {
      const u = w.units.get(id);
      if (u) out.push(u);
      else {
        aboard ??= aboardOf(w);
        const p = aboard.get(id)?.unit;
        if (p) out.push(p);
      }
    }
    return out;
  }

  /** Squad index holding unit `id`, or -1. */
  slotOf(id: number): number {
    return this.slots.findIndex((s) => s.includes(id));
  }

  isEmpty(): boolean {
    return this.slots.every((s) => s.length === 0);
  }

  /** What the chip shows: dominant icon, count and health, or null when empty. */
  summary(i: number, w: World): SquadSummary | null {
    const counts = new Map<UnitKind, number>();
    let hp = 0;
    let max = 0;
    for (const u of this.members(i, w)) {
      counts.set(u.kind, (counts.get(u.kind) ?? 0) + 1);
      hp += Math.max(0, u.hp);
      max += UNITS[u.kind].hp;
    }
    if (counts.size === 0) return null;
    let kind: UnitKind | null = null;
    let n = 0;
    for (const [k, c] of counts)
      if (kind === null || c > n || (c === n && UNITS[k].cost > UNITS[kind].cost)) {
        kind = k;
        n = c;
      }
    let count = 0;
    for (const c of counts.values()) count += c;
    return { count, kind: kind!, hp: max > 0 ? hp / max : 0 };
  }

  /**
   * Where the camera should go for squad i: the member (or carrying Condor)
   * nearest the centroid, so a squad split in two doesn't land on empty ground.
   */
  focus(i: number, w: World): { x: number; y: number } | null {
    const us = this.ids(i, w).map((id) => w.units.get(id)!);
    if (us.length === 0) return null;
    const cx = us.reduce((s, u) => s + u.x, 0) / us.length;
    const cy = us.reduce((s, u) => s + u.y, 0) / us.length;
    let best = us[0]!;
    let bestD = Infinity;
    for (const u of us) {
      const d = Math.hypot(u.x - cx, u.y - cy);
      if (d < bestD) {
        best = u;
        bestD = d;
      }
    }
    return { x: best.x, y: best.y };
  }

  /** Does the current selection equal squad i exactly? */
  matches(i: number, selected: ReadonlySet<number>, w: World): boolean {
    const ids = this.ids(i, w);
    return ids.length > 0 && ids.length === selected.size && ids.every((id) => selected.has(id));
  }

  /** This tick's sim events: a hit on a member lights its chip. */
  events(fx: readonly FxEvent[], now: number): void {
    for (const ev of fx) {
      if (ev.type !== "hit" || ev.building || ev.faction !== this.faction) continue;
      const i = this.slotOf(ev.id);
      if (i >= 0) this.hurtUntil[i] = now + SQUAD.hurtMs;
    }
  }

  isHurt(i: number, now: number): boolean {
    return now < (this.hurtUntil[i] ?? -Infinity);
  }
}

interface Aboard {
  unit: Unit;
  carrier: Unit;
}

/** Every unit riding in a transport, by id (passengers are off the field: see src/sim/transport.ts). */
function aboardOf(w: World): Map<number, Aboard> {
  const out = new Map<number, Aboard>();
  for (const c of w.units.values()) {
    if (!c.passengers?.length) continue;
    for (const p of c.passengers) out.set(p.id, { unit: p, carrier: c });
  }
  return out;
}
