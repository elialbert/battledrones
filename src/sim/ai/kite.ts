/**
 * Kiting (Marshal's fight micro): units that outrange what's coming at them
 * step back out of its reach, then stop and shoot, and step back again. A
 * unit can't fire on the move (combat.ts), so each step trades a shot or so
 * for staying out of reach, and pays when the enemy has to close a range gap
 * under fire: Lancers (5.5) against Stingers (3.2), Mastodons (4) and
 * Troopers (3), Mortars against anything short-ranged and slow.
 *
 * One move order a look for a fight's kiters together (orders cost actions:
 * a human backs a group off with one drag, not a click per tank), to one spot
 * straight away from what threatens them. They arrive, go idle, auto-target
 * and fire until the next look moves them again.
 */
import { UNITS } from "../balance";
import { atan2, cos, hypot, sin } from "../fmath";
import type { Unit, World } from "../types";
import { distToBuilding, domainOf, moveClassOf, passable } from "../world";
import { USELESS, effectivenessVs } from "./intel";

export const KITE = {
  /** Only kite something we outrange by at least this (tiles). */
  edge: 1,
  /** Step back once a threat is this close to having us in its range (tiles past its range). */
  margin: 1.2,
  /** Step back to this far inside our own range of the nearest threat. */
  keep: 0.4,
  /**
   * …unless it's already this far inside its range and at least as fast as
   * us: running from a Stinger on top of you only stops you shooting it.
   */
  deep: 0.6,
  /** A step back: at most this many seconds of driving. */
  step: 1,
  /** Don't kite what's this many times faster than us (it closes the gap anyway, and we stop shooting). */
  faster: 1.25,
  /** Only kite a threat we're (about) the nearest of its targets: one busy with our front line isn't coming for us. */
  nearest: 0.5,
  /** Units that can kite this close to one that steps back go with it. */
  group: 3
};
export type Kite = typeof KITE;

/** Can `e` hurt `u` at all? */
function threatens(e: Unit, u: Unit): boolean {
  const st = UNITS[e.kind];
  if (st.dps <= 0) return false;
  return effectivenessVs(e.kind, UNITS[u.kind].armor, domainOf(u)) >= USELESS;
}

/**
 * The kiting move for `ours` (one fight's units) against `theirs`: the units
 * that should step back and where to, or null when none should. `home`
 * breaks ties toward safety: the step leans that way when it's behind us.
 */
export function kiteStep(
  w: World,
  ours: Unit[],
  theirs: Unit[],
  home: { x: number; y: number } | null,
  k: Kite = KITE
): { ids: number[]; x: number; y: number } | null {
  // the units that can kite: armed, and nothing near that can hit them outranges them (or comes close to it)
  const able = new Set<Unit>();
  for (const u of ours) {
    const st = UNITS[u.kind];
    if (st.dps <= 0 || st.heal || u.goliath) continue;
    const danger = theirs.filter((e) => threatens(e, u));
    if (!danger.length) continue;
    if (danger.some((e) => UNITS[e.kind].range + k.edge > st.range && hypot(e.x - u.x, e.y - u.y) <= UNITS[e.kind].range + 4)) continue;
    able.add(u);
  }
  if (!able.size) return null;
  const side = ours[0]!.faction;
  const buildings = [...w.buildings.values()].filter((b) => b.faction === side);
  const kiters: Unit[] = [];
  let ax = 0;
  let ay = 0;
  let wsum = 0;
  let far = 1;
  for (const u of able) {
    const st = UNITS[u.kind];
    let want = false;
    for (const e of theirs) {
      // (what we can't hurt we don't kite: that's running away)
      if (!threatens(e, u) || !threatens(u, e)) continue;
      const est = UNITS[e.kind];
      if (est.speed > k.faster * st.speed) continue;
      const de = hypot(e.x - u.x, e.y - u.y);
      const gap = de - est.range;
      if (gap > k.margin) continue;
      if (gap < -k.deep && est.speed >= st.speed) continue;
      // (busy with our front line: something of ours that can't kite, or a building of ours, is clearly nearer it)
      if (ours.some((v) => !able.has(v) && threatens(e, v) && hypot(e.x - v.x, e.y - v.y) < de - k.nearest)) continue;
      if (est.targets !== "air" && buildings.some((b) => distToBuilding(b, e.x, e.y) < de - k.nearest)) continue;
      want = true;
      // how far back puts it at our range less `keep`, given it follows
      const back = ((st.range - k.keep - de) * st.speed) / Math.max(0.3, st.speed - est.speed);
      far = Math.max(far, back);
      // push away from it, harder the closer it is
      const wgt = (k.margin + 1 - gap) * est.dps;
      ax += (e.x - u.x) * wgt;
      ay += (e.y - u.y) * wgt;
      wsum += wgt;
    }
    if (want) kiters.push(u);
  }
  // the kiters' neighbours that can kite step back with them (a group keeps together)
  if (kiters.length)
    for (const u of able)
      if (!kiters.includes(u) && kiters.some((v) => hypot(u.x - v.x, u.y - v.y) <= k.group)) kiters.push(u);
  if (!kiters.length || wsum <= 0) return null;
  // the kiters' middle, and away from the weighted threat
  const cx = kiters.reduce((a, u) => a + u.x, 0) / kiters.length;
  const cy = kiters.reduce((a, u) => a + u.y, 0) / kiters.length;
  let dx = -ax / wsum;
  let dy = -ay / wsum;
  let len = hypot(dx, dy);
  if (len < 1e-6) return null;
  dx /= len;
  dy /= len;
  // lean toward home when home is behind us (don't back into a corner of their base)
  if (home) {
    const hx = home.x - cx;
    const hy = home.y - cy;
    const hl = hypot(hx, hy);
    if (hl > 2 && (hx * dx + hy * dy) / hl > 0) {
      dx = dx * 0.7 + (hx / hl) * 0.3;
      dy = dy * 0.7 + (hy / hl) * 0.3;
      len = hypot(dx, dy);
      dx /= len;
      dy /= len;
    }
  }
  const slowest = Math.min(...kiters.map((u) => UNITS[u.kind].speed));
  const d = Math.min(slowest * k.step, far);
  // straight back if the ground's there, else the nearest heading either side of it
  const base = atan2(dx, -dy);
  for (const turn of [0, 0.4, -0.4, 0.8, -0.8, 1.2, -1.2]) {
    const a = base + turn;
    const x = cx + sin(a) * d;
    const y = cy - cos(a) * d;
    if (kiters.every((u) => passable(w, Math.floor(x), Math.floor(y), moveClassOf(u.kind))))
      return { ids: kiters.map((u) => u.id), x, y };
  }
  return null;
}
