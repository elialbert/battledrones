/**
 * World hashes: battle records pin one every 100 ticks (AGENT-BATTLES.md),
 * and sound duels fold one into a trail every tick to catch two phones
 * drifting apart (SOUND-DUEL.md). Never change what worldHash covers: saved
 * records pin its values.
 */
import type { World } from "./types";
import { sidesOf } from "./sides";

const buf = new DataView(new ArrayBuffer(8));

/** FNV-1a over the bytes of numbers. */
class Fnv {
  h = 0x811c9dc5;
  num(n: number): void {
    buf.setFloat64(0, n);
    for (let i = 0; i < 8; i++) {
      this.h ^= buf.getUint8(i);
      this.h = Math.imul(this.h, 0x01000193);
    }
  }
  str(s: string): void {
    for (let i = 0; i < s.length; i++) {
      this.h ^= s.charCodeAt(i) & 0xff;
      this.h = Math.imul(this.h, 0x01000193);
    }
  }
  hex(): string {
    return (this.h >>> 0).toString(16).padStart(8, "0");
  }
}

/** A hash of everything that matters in the world: any drift shows up within 100 ticks. */
export function worldHash(w: World): string {
  const h = new Fnv();
  h.num(w.tick);
  h.num(w.nextId);
  // (the sides playing: blue and red in every duel and every saved record)
  for (const f of sidesOf(w)) {
    h.num(w.factions[f].scrap);
    h.num(w.powers.meter[f]);
    h.num(w.factions[f].pending?.remaining ?? -1);
  }
  for (const id of [...w.units.keys()].sort((a, b) => a - b)) {
    const u = w.units.get(id)!;
    h.num(id);
    h.str(u.kind);
    h.num(u.x);
    h.num(u.y);
    h.num(u.hp);
    h.str(u.order.type);
    h.num(u.cargo);
  }
  for (const id of [...w.buildings.keys()].sort((a, b) => a - b)) {
    const b = w.buildings.get(id)!;
    h.num(id);
    h.num(b.hp);
    h.num(b.queue.length);
    h.num(b.queue[0]?.remaining ?? -1);
  }
  h.num(w.projectiles.length);
  h.num(w.wrecks.length);
  for (const l of w.objectives.uplinks) {
    h.num(l.progress);
    if (l.bar !== undefined) h.str(l.bar ?? "-"); // (a free-for-all's: whose bar it is)
  }
  if (w.out) for (const o of w.out) h.str(o.faction);
  h.str(w.winner ?? "-");
  return h.hex();
}
