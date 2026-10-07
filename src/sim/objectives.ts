import { COMBAT, OBJECTIVES, POWERS, TICK_RATE, UNITS } from "./balance";
import { worldPick, worldRandom } from "./rand";
import type { Crate, CrateReward, Faction, ObjectiveState, Unit, Uplink, World } from "./types";
import { buildingAtTile, inBounds, passable, spawnUnit } from "./world";

/**
 * Map objectives: reasons to fight in the middle of the map.
 *
 * UPLINK RELAYS sit at contested spots (2–3 per map, mirrored for fairness).
 * Units standing in an Uplink's zone push its capture bar toward their side
 * (harvesters don't count, aircraft count half); with both sides inside the
 * bar freezes. Holding one pays a trickle of scrap, lights up the fog around
 * it and charges the Command meter. Uplinks are not buildings: nothing
 * occupies their tiles and nothing can shoot them, so combat never sees them.
 *
 * SUPPLY DROPS: from 1:30, every 75 s a pair of crates — one at a drop site,
 * one at its mirror image, holding the same reward — is announced to both
 * sides 10 s before it lands. The first non-harvester unit to reach a crate
 * claims it. All randomness is seeded (rand.ts), so matches replay exactly.
 */

const U = OBJECTIVES.uplink;
const D = OBJECTIVES.drops;
const ticks = (secs: number) => Math.round(secs * TICK_RATE);

export const CRATE_REWARDS: CrateReward[] = ["scrap", "veterans", "repair", "charge", "unit"];

/** Short names for HUD lines ("Supply drop inbound: Veterans"). */
export const CRATE_NAMES: Record<CrateReward, string> = {
  scrap: `${D.scrap} scrap`,
  veterans: "Veterans",
  repair: "Field Repair",
  charge: `+${D.charge} command charge`,
  unit: "Free Lancer"
};

export function createObjectiveState(): ObjectiveState {
  const zero = () => ({ uplinkScrap: 0, crateScrap: 0, captures: 0, crates: 0 });
  return { uplinks: [], crates: [], dropSites: [], drops: 0, lastSite: -1, stats: { blue: zero(), red: zero() } };
}

/** The point-mirror of (x, y): maps are symmetric under a 180° turn about the centre. */
export function mirrorPoint(w: World, x: number, y: number): { x: number; y: number } {
  return { x: w.width - x, y: w.height - y };
}

/**
 * Put a map's objectives into the world: an Uplink at each listed point and
 * at its mirror (a point at the very centre is its own mirror: one relay),
 * and the supply-drop sites. Points are blue-side; tiles are continuous.
 */
export function setupObjectives(w: World, uplinks: [number, number][], dropSites: [number, number][]): void {
  const o = w.objectives;
  const add = (x: number, y: number) => {
    if (o.uplinks.some((l) => Math.hypot(l.x - x, l.y - y) < 0.01)) return;
    o.uplinks.push({ id: w.nextId++, x, y, owner: null, progress: 0, pushing: null, contested: false });
  };
  for (const [x, y] of uplinks) {
    add(x, y);
    const m = mirrorPoint(w, x, y);
    add(m.x, m.y);
  }
  o.dropSites = dropSites.map(([x, y]) => ({ x, y }));
}

/** Tick the drop with index k lands, and the tick it is announced. */
export function dropLandTick(k: number): number {
  return ticks(D.first + k * D.every);
}
export function dropAnnounceTick(k: number): number {
  return dropLandTick(k) - ticks(D.warning);
}

/** Tick the next drop will be announced, or null when this match has none. */
export function nextDropTick(w: World): number | null {
  return w.objectives.dropSites.length > 0 ? dropAnnounceTick(w.objectives.drops) : null;
}

/** Capture-zone presence: units inside, harvesters excluded, aircraft at half weight. */
export function presence(w: World, l: Uplink): Record<Faction, number> {
  const p = { blue: 0, red: 0 };
  const r2 = U.radius * U.radius;
  for (const u of w.units.values()) {
    if (u.kind === "harvester") continue;
    const dx = u.x - l.x;
    const dy = u.y - l.y;
    if (dx * dx + dy * dy > r2) continue;
    p[u.faction] += UNITS[u.kind].domain === "air" ? U.airWeight : 1;
  }
  return p;
}

const sign = (f: Faction) => (f === "blue" ? 1 : -1);

/** The bar value an Uplink rests at with nobody around: its owner's full bar, or 0. */
const restOf = (l: Uplink) => (l.owner ? 100 * sign(l.owner) : 0);

function towards(v: number, target: number, d: number): number {
  return v < target ? Math.min(target, v + d) : Math.max(target, v - d);
}

/** Advance one Uplink's capture bar and settle who owns it. */
function tickUplink(w: World, l: Uplink): void {
  const p = presence(w, l);
  const dt = 1 / TICK_RATE;
  l.contested = p.blue > 0 && p.red > 0;
  if (l.contested) {
    l.pushing = null; // both sides inside: the bar freezes
  } else if (p.blue > 0 || p.red > 0) {
    const f: Faction = p.blue > 0 ? "blue" : "red";
    const target = 100 * sign(f);
    if (l.progress === target) l.pushing = null; // fully held already
    else {
      if (l.pushing !== f)
        w.fx.push({ type: "uplinkContest", id: l.id, x: l.x, y: l.y, faction: f, owner: l.owner });
      l.pushing = f;
      l.progress = towards(l.progress, target, Math.min(U.maxRate, U.perUnit * p[f]) * dt);
    }
  } else {
    l.pushing = null;
    l.progress = towards(l.progress, restOf(l), U.settle * dt);
  }
  // ownership: lost the moment the bar is pushed back to (or past) neutral,
  // taken when it fills all the way to one side
  if (l.owner && l.progress * sign(l.owner) <= 0) {
    const prev = l.owner;
    l.owner = null;
    w.fx.push({ type: "uplinkFlip", id: l.id, x: l.x, y: l.y, owner: null, prev, by: prev === "blue" ? "red" : "blue" });
  }
  if (!l.owner && Math.abs(l.progress) >= 100) {
    const f: Faction = l.progress > 0 ? "blue" : "red";
    l.owner = f;
    w.objectives.stats[f].captures++;
    w.fx.push({ type: "uplinkFlip", id: l.id, x: l.x, y: l.y, owner: f, prev: null, by: f });
  }
}

/** Per tick, after deaths and salvage: capture bars, Uplink income, and supply drops. */
export function tickObjectives(w: World): void {
  const o = w.objectives;
  if (o.uplinks.length === 0 && o.dropSites.length === 0 && o.crates.length === 0) return;
  for (const l of o.uplinks) tickUplink(w, l);
  // owned Uplinks: scrap once a second (like the HQ trickle), charge every tick
  const paySecond = (w.tick + 1) % TICK_RATE === 0;
  for (const l of o.uplinks) {
    if (!l.owner) continue;
    const m = w.powers.meter;
    m[l.owner] = Math.min(POWERS.meterMax, m[l.owner] + U.charge / TICK_RATE);
    if (!paySecond) continue;
    const f = w.factions[l.owner];
    const amount = U.income * f.incomeMult;
    f.scrap += amount;
    o.stats[l.owner].uplinkScrap += amount;
  }
  if (o.dropSites.length > 0 && w.tick >= dropAnnounceTick(o.drops)) announceDrop(w);
  if (o.crates.length > 0) tickCrates(w);
}

/** Weighted, seeded reward roll for drop k (shared by both of its crates). */
export function rollReward(w: World, k: number): CrateReward {
  const weights = D.weights;
  const total = CRATE_REWARDS.reduce((s, r) => s + (weights[r] ?? 0), 0);
  let x = worldRandom(w, "drop-reward", k) * total;
  for (const r of CRATE_REWARDS) {
    x -= weights[r] ?? 0;
    if (x < 0) return r;
  }
  return "scrap";
}

/** Which drop site drop k uses: seeded, never the same site twice running. */
export function pickDropSite(w: World, k: number, last: number): number {
  const n = w.objectives.dropSites.length;
  let i = worldPick(w, n, "drop-site", k);
  if (n > 1 && i === last) i = (i + 1 + worldPick(w, n - 1, "drop-site-reroll", k)) % n;
  return i;
}

/** Where a crate aimed at (x, y) can land: the spot, or the nearest open ground within 3 tiles. */
export function crateSpot(w: World, x: number, y: number): { x: number; y: number } | null {
  const ok = (tx: number, ty: number) => inBounds(w, tx, ty) && passable(w, tx, ty, "ground");
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (ok(tx, ty)) return { x, y };
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (let dy = -3; dy <= 3; dy++)
    for (let dx = -3; dx <= 3; dx++) {
      if (!ok(tx + dx, ty + dy)) continue;
      const d = Math.hypot(dx, dy);
      if (d < bestD) {
        bestD = d;
        best = { x: tx + dx + 0.5, y: ty + dy + 0.5 };
      }
    }
  return best;
}

/** Announce drop number `o.drops`: a crate at a drop site and one at its mirror. */
function announceDrop(w: World): void {
  const o = w.objectives;
  const k = o.drops++;
  const site = pickDropSite(w, k, o.lastSite);
  o.lastSite = site;
  const reward = rollReward(w, k);
  const s = o.dropSites[site]!;
  const m = mirrorPoint(w, s.x, s.y);
  const landTick = dropLandTick(k);
  for (const at of [s, m]) {
    const spot = crateSpot(w, at.x, at.y);
    if (!spot) continue;
    const c: Crate = {
      id: w.nextId++, x: spot.x, y: spot.y, reward, drop: k,
      announcedTick: w.tick, landTick, expireTick: landTick + ticks(D.ttl)
    };
    o.crates.push(c);
    w.fx.push({ type: "crateIncoming", id: c.id, x: c.x, y: c.y, reward, landTick, drop: k });
  }
}

/** Crates land, get claimed by the nearest non-harvester unit in reach, or burn out. */
function tickCrates(w: World): void {
  const o = w.objectives;
  const reach = D.claimRadius;
  const keep: Crate[] = [];
  for (const c of o.crates) {
    if (w.tick < c.landTick) {
      keep.push(c);
      continue;
    }
    if (w.tick === c.landTick) w.fx.push({ type: "crateLanded", id: c.id, x: c.x, y: c.y, reward: c.reward });
    if (w.tick >= c.expireTick) {
      w.fx.push({ type: "crateExpired", id: c.id, x: c.x, y: c.y });
      continue;
    }
    // a building put down over the crate takes it for its owner
    const b = buildingAtTile(w, Math.floor(c.x), Math.floor(c.y));
    if (b) {
      claimCrate(w, c, b.faction, b.id);
      continue;
    }
    let best: Unit | null = null;
    let bestD = reach;
    for (const u of w.units.values()) {
      if (u.kind === "harvester") continue;
      const dx = u.x - c.x;
      if (dx > reach || dx < -reach) continue;
      const dy = u.y - c.y;
      if (dy > reach || dy < -reach) continue;
      const d = Math.hypot(dx, dy);
      // nearest wins; ties go to the earliest-built (Map order + strict <)
      if (d <= bestD && (best === null || d < bestD)) {
        best = u;
        bestD = d;
      }
    }
    if (best) claimCrate(w, c, best.faction, best.id);
    else keep.push(c);
  }
  o.crates = keep;
}

/** Hand a crate's reward to `faction` and announce it. */
export function claimCrate(w: World, c: Crate, faction: Faction, collectorId: number): void {
  const o = w.objectives;
  const f = w.factions[faction];
  let amount = 0;
  /** Share of the kit that went unused (it's stripped for scrap instead). */
  let unused = 0;
  const unitIds: number[] = [];
  const near = (r: number) =>
    [...w.units.values()].filter((u) => u.faction === faction && Math.hypot(u.x - c.x, u.y - c.y) <= r);
  switch (c.reward) {
    case "scrap":
      amount = D.scrap * f.incomeMult;
      f.scrap += amount;
      o.stats[faction].crateScrap += amount;
      break;
    case "veterans":
      for (const u of near(D.veteranRadius)) {
        if (u.kind === "harvester" || u.rank >= COMBAT.rankXp.length) continue;
        promote(u);
        unitIds.push(u.id);
        w.fx.push({ type: "rankUp", id: u.id });
      }
      amount = unitIds.length;
      break;
    case "repair":
      for (const u of near(D.repairRadius)) {
        const max = UNITS[u.kind].hp;
        if (u.hp >= max) continue;
        const healed = Math.min(max - u.hp, max * D.repairShare);
        u.hp += healed;
        amount += healed;
        unitIds.push(u.id);
      }
      amount = Math.round(amount);
      break;
    case "charge": {
      const m = w.powers.meter;
      const before = m[faction];
      m[faction] = Math.min(POWERS.meterMax, before + D.charge);
      amount = Math.round(m[faction] - before);
      unused = 1 - (m[faction] - before) / D.charge;
      break;
    }
    case "unit": {
      const u = spawnUnit(w, D.unit, faction, c.x, c.y);
      for (let r = 0; r < D.unitRank; r++) promote(u);
      u.facing = u.aim = faction === "blue" ? 0 : Math.PI;
      unitIds.push(u.id);
      amount = UNITS[D.unit].cost;
      break;
    }
  }
  // a kit with nothing to work on (no one hurt, meter full…) is stripped for scrap instead
  if ((c.reward === "veterans" || c.reward === "repair") && amount <= 0) unused = 1;
  let scrap = c.reward === "scrap" ? amount : 0;
  if (unused > 0.01) {
    scrap = Math.round(D.fallbackScrap * unused * f.incomeMult);
    f.scrap += scrap;
    o.stats[faction].crateScrap += scrap;
  }
  o.stats[faction].crates++;
  w.fx.push({
    type: "crateClaimed", id: c.id, x: c.x, y: c.y, faction, collectorId, reward: c.reward, amount, unitIds, scrap
  });
}

/** One veterancy rank up, with the XP that rank takes (so kills keep counting from there). */
function promote(u: Unit): void {
  if (u.rank >= COMBAT.rankXp.length) return;
  u.rank++;
  u.xp = Math.max(u.xp, COMBAT.rankXp[u.rank - 1]! * UNITS[u.kind].cost);
}

/**
 * Would a building footprint sit on an Uplink's platform or a supply crate?
 * (Placement rule: objectives stay open ground.)
 */
export function blocksObjective(w: World, tx: number, ty: number, size: number): boolean {
  const o = w.objectives;
  if (o.uplinks.length === 0 && o.crates.length === 0) return false;
  const gap = (x: number, y: number) =>
    Math.hypot(Math.max(tx - x, 0, x - (tx + size)), Math.max(ty - y, 0, y - (ty + size)));
  for (const l of o.uplinks) if (gap(l.x, l.y) < PAD_RADIUS) return true;
  for (const c of o.crates) if (gap(c.x, c.y) < 0.5) return true;
  return false;
}

/** The Uplink platform's footprint radius (tiles): no building may overlap it. */
export const PAD_RADIUS = 1.2;

/** Uplinks each side holds (HUD, AI). */
export function uplinksHeld(w: World): Record<Faction, number> {
  const n = { blue: 0, red: 0 };
  for (const l of w.objectives.uplinks) if (l.owner) n[l.owner]++;
  return n;
}

/** Scrap per minute a side earns from its Uplinks right now (before income multipliers). */
export function uplinkIncome(w: World, f: Faction): number {
  return uplinksHeld(w)[f] * U.income * 60;
}
