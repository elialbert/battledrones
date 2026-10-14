/**
 * "Since your last turn": what one side would have heard and seen while the
 * sim ran — its losses and kills, what it built, the radio announcer's
 * alerts — gathered from each tick's fx through the same filters the game
 * puts between the sim and the player's screen. An enemy death shows only if
 * it was in sight or one of ours made the kill; enemy units are named only
 * when seen. Public events (Uplinks, supply drops, calldown telegraphs) reach
 * both sides, as they do in the game.
 */
import { UNITS } from "../sim/balance";
import { isVisible } from "../sim/fog";
import { CRATE_NAMES } from "../sim/objectives";
import { POWER_NAMES } from "../sim/powers";
import { unitSeenBy } from "../sim/infantry";
import type { Faction, FxEvent, UnitKind, World } from "../sim/types";
import { enemyOf, frameOf, type Frame } from "./frame";

/** Visible armed enemies this close (tiles) to our buildings, harvesters or Goliaths are "near the base" (awareness.ts uses 12). */
export const NEAR_BASE = 12;

interface Attacked {
  label: string;
  hits: number;
  by: Set<string>;
}

/** Why a `wait` should end early: our HQ or a Goliath hit, an enemy calldown telegraphed, enemies near the base. */
export type Urgent = "hq" | "goliath" | "strike" | "inbound";

export class SideLog {
  private readonly side: Faction;
  private lost = new Map<string, number[]>();
  private lostAt: string[] = [];
  private killed = new Map<string, number>();
  private built = new Map<string, number[]>();
  private finished: string[] = [];
  private attacked = new Map<number, Attacked>();
  private notes: string[] = [];
  private airSeen = new Set<number>();
  private salvage = 0;
  private start: { harvested: number; uplinks: number; crates: number } | null = null;
  /** Urgent things since the last take(), for `wait`. */
  urgent = new Set<Urgent>();

  constructor(side: Faction) {
    this.side = side;
  }

  /** Feed the world right after a step(): its fx are that tick's events. */
  tick(w: World): void {
    const side = this.side;
    const fr = frameOf(w, side);
    if (!this.start) this.start = this.income(w);
    for (const ev of w.fx) this.event(w, fr, ev);
    // enemy aircraft spotted for the first time (the announcer's "Enemy aircraft detected")
    if (w.tick % 5 === 0) {
      for (const u of w.units.values()) {
        if (u.faction === side || UNITS[u.kind].domain !== "air" || this.airSeen.has(u.id)) continue;
        if (!unitSeenBy(w, side, u)) continue;
        this.airSeen.add(u.id);
        const [x, y] = fr.tile(u.x, u.y);
        this.say(`Enemy aircraft detected: ${u.kind} #${u.id} at ${x},${y}`);
      }
      if (nearBase(w, side).length > 0) this.urgent.add("inbound");
    }
  }

  private event(w: World, fr: Frame, ev: FxEvent): void {
    const side = this.side;
    const at = (x: number, y: number) => fr.tile(x, y).join(",");
    switch (ev.type) {
      case "death": {
        const what = ev.unitKind ?? ev.buildingKind!;
        if (ev.faction === side) {
          // A lethal hit has already removed the unit before this log sees its hit event.
          if (ev.unitKind === "goliath") this.urgent.add("goliath");
          if (ev.buildingKind) this.lostAt.push(`${what} #${ev.id} at ${at(ev.x, ev.y)}`);
          else push(this.lost, what, ev.id);
        } else {
          const ours = ev.killerId !== null && isOurs(w, side, ev.killerId);
          if (ours || isVisible(w, side, Math.floor(ev.x), Math.floor(ev.y))) {
            this.killed.set(what, (this.killed.get(what) ?? 0) + 1);
            if (ev.buildingKind) this.say(`Destroyed enemy ${what} #${ev.id} at ${at(ev.x, ev.y)}`);
          }
        }
        break;
      }
      case "built": {
        if (ev.faction !== side) break;
        const u = w.units.get(ev.id);
        const b = w.buildings.get(ev.id);
        if (u) push(this.built, u.kind, u.id);
        else if (b) this.finished.push(`${b.kind} #${b.id} at ${fr.topLeft(b.kind, b.tx, b.ty).join(",")}`);
        break;
      }
      case "hit": {
        if (ev.faction !== side) break;
        const b = ev.building ? w.buildings.get(ev.id) : null;
        const u = ev.building ? null : w.units.get(ev.id);
        // Goliaths are bases too, including the airborne bases under Armada.
        if (!b && u?.kind !== "harvester" && !u?.goliath) break;
        if (b?.kind === "hq") this.urgent.add("hq");
        if (u?.goliath) this.urgent.add("goliath");
        const label = b ? `${b.kind} #${b.id} at ${fr.topLeft(b.kind, b.tx, b.ty).join(",")}` : `${u!.kind} #${ev.id} at ${at(ev.x, ev.y)}`;
        const a = this.attacked.get(ev.id) ?? { label, hits: 0, by: new Set<string>() };
        a.hits++;
        const attacker = w.units.get(ev.attackerId);
        if (attacker && attacker.faction !== side && unitSeenBy(w, side, attacker)) a.by.add(attacker.kind);
        this.attacked.set(ev.id, a);
        break;
      }
      case "rankUp": {
        const u = w.units.get(ev.id);
        if (u?.faction === side) this.say(`${u.kind} #${u.id} ranked up to ★${u.rank}`);
        break;
      }
      case "calldown": {
        const who = ev.faction === side ? "Our" : "ENEMY";
        if (ev.faction !== side) this.urgent.add("strike");
        this.say(`${who} ${POWER_NAMES[ev.power]} called at ${at(ev.x, ev.y)} (radius ${ev.radius}), lands at ${clockOf(ev.landTick)}`);
        break;
      }
      case "calldownImpact": {
        if (ev.power === "barrage") break; // (one per shell: the telegraph said enough)
        const who = ev.faction === side ? "Our" : "Enemy";
        const crew = ev.power === "droppod" && ev.faction === side ? ` (crew ${ev.unitIds.map((i) => "#" + i).join(" ")})` : "";
        this.say(`${who} ${POWER_NAMES[ev.power]} landed at ${at(ev.x, ev.y)}: ${ev.hits} hit${crew}`);
        break;
      }
      case "stun":
        if (ev.faction === side) this.say(`EMP: ${ev.ids.length} of ours stunned at ${at(ev.x, ev.y)} until ${clockOf(ev.until)}`);
        break;
      case "powerOnline":
        if (ev.faction === side) this.say(`${POWER_NAMES[ev.power]} is online`);
        break;
      case "uplinkFlip": {
        const name = `Uplink #${ev.id} at ${at(ev.x, ev.y)}`;
        if (ev.owner === side) this.say(`We captured ${name}`);
        else if (ev.owner) this.say(`The enemy captured ${name}`);
        else if (ev.prev === side) this.say(`We lost ${name} (now neutral)`);
        else this.say(`The enemy lost ${name} (now neutral)`);
        break;
      }
      case "crateIncoming":
        this.say(`Supply drop inbound: ${CRATE_NAMES[ev.reward]} crate #${ev.id} at ${at(ev.x, ev.y)}, lands ${clockOf(ev.landTick)}`);
        break;
      case "crateClaimed":
        if (ev.faction === side) this.say(`We claimed crate #${ev.id} (${CRATE_NAMES[ev.reward]})${ev.scrap ? `: +${Math.round(ev.scrap)} scrap` : ""}`);
        else this.say(`The enemy claimed crate #${ev.id} at ${at(ev.x, ev.y)} (${CRATE_NAMES[ev.reward]})`);
        break;
      case "crateExpired":
        this.say(`Crate #${ev.id} at ${at(ev.x, ev.y)} burnt out unclaimed`);
        break;
      case "salvage":
        if (ev.faction === side) this.salvage += ev.value;
        break;
      case "lifeline":
        if (ev.faction === side) this.say(`A free Condor #${ev.id} flew in at ${at(ev.x, ev.y)}${ev.squad ? " with a Trooper Squad aboard" : ""}`);
        break;
      case "disembark":
        if (ev.faction === side && ev.bailout) this.say(`Condor #${ev.carrierId} shot down: squads ${ev.unitIds.map((i) => "#" + i).join(" ")} bailed out at ${at(ev.x, ev.y)}`);
        break;
    }
  }

  /** A line of news (kept in order, capped so a long wait can't flood the observation). */
  say(line: string): void {
    if (this.notes.length < 40) this.notes.push(line);
    else if (this.notes.length === 40) this.notes.push("… (more events cut)");
  }

  private income(w: World) {
    const f = w.factions[this.side];
    const o = w.objectives.stats[this.side];
    return { harvested: f.stats.scrapHarvested, uplinks: o.uplinkScrap, crates: o.crateScrap };
  }

  /** The digest since the last call, as lines, and start a new one. */
  take(w: World): string[] {
    const out: string[] = [];
    const fr = frameOf(w, this.side);
    const fmt = (m: Map<string, number[]>) => [...m].map(([k, ids]) => `${ids.length} ${k} (${ids.map((i) => "#" + i).join(" ")})`).join(", ");
    if (this.lost.size || this.lostAt.length) out.push(`LOST: ${[fmt(this.lost), ...this.lostAt].filter(Boolean).join(", ")}`);
    if (this.killed.size) out.push(`KILLED: ${[...this.killed].map(([k, n]) => `${n} ${k}`).join(", ")}`);
    if (this.built.size || this.finished.length) out.push(`BUILT: ${[fmt(this.built), ...this.finished].filter(Boolean).join(", ")}`);
    for (const a of this.attacked.values())
      out.push(`UNDER ATTACK: ${a.label} (${a.hits} hit${a.hits > 1 ? "s" : ""}${a.by.size ? ` by ${[...a.by].join(", ")}` : ", attacker unseen"})`);
    const near = nearBase(w, this.side);
    if (near.length) {
      const kinds = new Map<UnitKind, number>();
      for (const u of near) kinds.set(u.kind, (kinds.get(u.kind) ?? 0) + 1);
      const c = near.reduce((s, u) => ({ x: s.x + u.x / near.length, y: s.y + u.y / near.length }), { x: 0, y: 0 });
      out.push(`ENEMIES NEAR YOUR BASE: ${[...kinds].map(([k, n]) => `${n} ${k}`).join(", ")} around ${fr.tile(c.x, c.y).join(",")}`);
    }
    out.push(...this.notes);
    if (this.start) {
      const now = this.income(w);
      const parts = [
        [now.harvested - this.start.harvested, "harvested"],
        [now.uplinks - this.start.uplinks, "from Uplinks"],
        [now.crates - this.start.crates, "from crates"],
        [this.salvage, "salvaged"]
      ].filter(([v]) => (v as number) >= 1).map(([v, what]) => `+${Math.round(v as number)} ${what}`);
      if (parts.length) out.push(`INCOME: ${parts.join(", ")}`);
    }
    this.lost.clear();
    this.lostAt = [];
    this.killed.clear();
    this.built.clear();
    this.finished = [];
    this.attacked.clear();
    this.notes = [];
    this.salvage = 0;
    this.start = this.income(w);
    this.urgent.clear();
    return out;
  }
}

/** Visible armed enemy units within NEAR_BASE tiles of `side`'s buildings, harvesters or Goliaths. */
export function nearBase(w: World, side: Faction) {
  const guards: { x: number; y: number }[] = [];
  for (const b of w.buildings.values()) if (b.faction === side) guards.push({ x: b.tx + 1, y: b.ty + 1 });
  for (const u of w.units.values()) if (u.faction === side && (u.kind === "harvester" || u.goliath)) guards.push(u);
  const out = [];
  for (const u of w.units.values()) {
    if (u.faction === side || u.faction !== enemyOf(side)) continue;
    const st = UNITS[u.kind];
    if ((st.targets === "none" || st.dps <= 0) && !st.capacity) continue;
    if (!guards.some((g) => Math.hypot(g.x - u.x, g.y - u.y) <= NEAR_BASE)) continue;
    if (!unitSeenBy(w, side, u)) continue;
    out.push(u);
  }
  return out;
}

function isOurs(w: World, side: Faction, id: number): boolean {
  return (w.units.get(id) ?? w.buildings.get(id))?.faction === side;
}

function push(m: Map<string, number[]>, k: string, id: number) {
  const a = m.get(k);
  if (a) a.push(id);
  else m.set(k, [id]);
}

const clockOf = (tick: number) => {
  const s = Math.ceil(tick / 10);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
