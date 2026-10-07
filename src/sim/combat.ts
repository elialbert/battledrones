import { BUILDINGS, COMBAT, DAMAGE_VS, TERRAIN, TICK_RATE, UNITS, shotDamage, type ArmedStats } from "./balance";
import { moveUnitToward } from "./movement";
import type { ArmorClass, Building, Domain, Faction, TargetDomain, Unit, World } from "./types";
import { buildingCenter, distToBuilding, removeBuilding, terrainAt } from "./world";

type Attacker = { unit: Unit } | { building: Building };

export const canHit = (targets: TargetDomain, domain: Domain): boolean =>
  targets === "both" || targets === domain;

function unitDomain(u: Unit): Domain {
  return UNITS[u.kind].domain;
}

interface TargetRef {
  id: number;
  x: number;
  y: number;
  dist: number;
}

/**
 * Best valid enemy (unit or building) within `radius` of (x, y): nearest,
 * with armed units preferred over unarmed ones and buildings.
 */
export function findTarget(
  w: World,
  faction: Faction,
  targets: TargetDomain,
  x: number,
  y: number,
  radius: number,
  minRange = 0
): TargetRef | null {
  if (targets === "none") return null;
  let best: TargetRef | null = null;
  let bestScore = Infinity;
  for (const u of w.units.values()) {
    if (u.faction === faction || !canHit(targets, unitDomain(u))) continue;
    const d = Math.hypot(u.x - x, u.y - y);
    if (d > radius || d < minRange) continue;
    const s = d + (UNITS[u.kind].targets === "none" && !UNITS[u.kind].heal ? 1.5 : 0);
    if (s < bestScore) {
      bestScore = s;
      best = { id: u.id, x: u.x, y: u.y, dist: d };
    }
  }
  // buildings are ground targets
  if (canHit(targets, "ground"))
    for (const b of w.buildings.values()) {
      if (b.faction === faction) continue;
      const d = distToBuilding(b, x, y);
      if (d > radius || d < minRange) continue;
      const s = d + (BUILDINGS[b.kind].targets === "none" ? 3 : 1);
      if (s < bestScore) {
        bestScore = s;
        const c = buildingCenter(b);
        best = { id: b.id, x: c.x, y: c.y, dist: d };
      }
    }
  return best;
}

function targetPosition(w: World, id: number): { x: number; y: number; domain: Domain } | null {
  const u = w.units.get(id);
  if (u) return { x: u.x, y: u.y, domain: unitDomain(u) };
  const b = w.buildings.get(id);
  if (b) {
    const c = buildingCenter(b);
    return { x: c.x, y: c.y, domain: "ground" };
  }
  return null;
}

/** Distance from (x, y) to a target: footprint edge for buildings. */
function distTo(w: World, id: number, x: number, y: number): number {
  const b = w.buildings.get(id);
  if (b) return distToBuilding(b, x, y);
  const u = w.units.get(id);
  return u ? Math.hypot(u.x - x, u.y - y) : Infinity;
}

/** Armor + cover multiplier for a hit of `dmgType` on entity `id`. */
function damageMult(w: World, id: number, dmgType: keyof typeof DAMAGE_VS): number {
  const u = w.units.get(id);
  let armor: ArmorClass = "structure";
  let cover = 1;
  if (u) {
    armor = UNITS[u.kind].armor;
    if (unitDomain(u) === "ground") cover = TERRAIN[terrainAt(w, Math.floor(u.x), Math.floor(u.y))].cover;
  }
  return DAMAGE_VS[dmgType][armor] * cover;
}

/** Record of who hit whom this tick, for retaliation. */
interface Incident {
  victimId: number;
  attackerId: number;
}

function applyDamage(
  w: World,
  id: number,
  damage: number,
  attackerId: number,
  incidents: Incident[]
): void {
  const u = w.units.get(id);
  if (u) {
    u.hp -= damage;
    u.damagedTick = w.tick;
    u.lastAttackerId = attackerId;
    incidents.push({ victimId: id, attackerId });
    w.fx.push({ type: "hit", faction: u.faction, id, x: u.x, y: u.y, building: false, attackerId });
    return;
  }
  const b = w.buildings.get(id);
  if (b) {
    b.hp -= damage;
    b.damagedTick = w.tick;
    b.lastAttackerId = attackerId;
    incidents.push({ victimId: id, attackerId });
    const c = buildingCenter(b);
    w.fx.push({ type: "hit", faction: b.faction, id, x: c.x, y: c.y, building: true, attackerId });
  }
}

/** Splash damage around a point to every enemy the weapon can hit. */
function splash(
  w: World,
  faction: Faction,
  x: number,
  y: number,
  radius: number,
  damage: number,
  dmgType: keyof typeof DAMAGE_VS,
  targets: TargetDomain,
  attackerId: number,
  incidents: Incident[]
): void {
  for (const u of w.units.values()) {
    if (u.faction === faction || !canHit(targets, unitDomain(u))) continue;
    const d = Math.hypot(u.x - x, u.y - y);
    if (d > radius) continue;
    applyDamage(w, u.id, damage * (1 - 0.5 * (d / radius)) * damageMult(w, u.id, dmgType), attackerId, incidents);
  }
  if (canHit(targets, "ground"))
    for (const b of w.buildings.values()) {
      if (b.faction === faction) continue;
      const d = distToBuilding(b, x, y);
      if (d > radius) continue;
      applyDamage(w, b.id, damage * (1 - 0.5 * (d / radius)) * damageMult(w, b.id, dmgType), attackerId, incidents);
    }
}

function fire(w: World, attacker: Attacker, targetId: number, incidents: Incident[]): void {
  const isUnit = "unit" in attacker;
  const holder = isUnit ? attacker.unit : attacker.building;
  if (holder.cooldown > 0) return;
  const stats: ArmedStats = isUnit ? UNITS[attacker.unit.kind] : BUILDINGS[attacker.building.kind];
  const src = isUnit ? { x: attacker.unit.x, y: attacker.unit.y } : buildingCenter(attacker.building);
  const t = targetPosition(w, targetId);
  if (!t) return;
  const interval = stats.shotInterval ?? COMBAT.shotInterval;
  holder.cooldown = Math.max(1, Math.round(interval * TICK_RATE));
  const angle = Math.atan2(t.x - src.x, -(t.y - src.y));
  holder.firedTick = w.tick;
  if (isUnit) {
    const u = attacker.unit;
    u.aim = angle;
    if (!UNITS[u.kind].turret) u.facing = angle;
  } else {
    attacker.building.facing = angle;
  }
  const rank = isUnit ? attacker.unit.rank : 0;
  const damage = shotDamage(stats) * (1 + rank * COMBAT.rankDamage);
  const dmgType = stats.dmgType ?? "kinetic";
  const fromAir = isUnit && unitDomain(attacker.unit) === "air";
  const vsAir = t.domain === "air" ? stats.airMult ?? 1 : 1;
  const fx = stats.fx ?? "cannon";
  w.fx.push({
    type: "shot", fx, x: src.x, y: src.y, tx: t.x, ty: t.y,
    fromAir, air: t.domain === "air", sourceId: holder.id
  });
  if (stats.projectileSpeed) {
    // slow simulated shell/bomb aimed at where the target is NOW (dodgeable)
    w.projectiles.push({
      id: w.nextId++, faction: holder.faction, fx,
      sx: src.x, sy: src.y, x: src.x, y: src.y, tx: t.x, ty: t.y,
      speed: stats.projectileSpeed / TICK_RATE,
      damage, splash: stats.splash ?? 0.6, dmgType, targets: stats.targets,
      sourceId: holder.id, fromAir
    });
    return;
  }
  if (stats.splash) {
    splash(w, holder.faction, t.x, t.y, stats.splash, damage, dmgType, stats.targets, holder.id, incidents);
    return;
  }
  applyDamage(w, targetId, damage * vsAir * damageMult(w, targetId, dmgType), holder.id, incidents);
}

/** Advance in-flight projectiles; detonate on arrival. */
function tickProjectiles(w: World, incidents: Incident[]): void {
  const keep = [];
  for (const p of w.projectiles) {
    const d = Math.hypot(p.tx - p.x, p.ty - p.y);
    if (d > p.speed) {
      p.x += ((p.tx - p.x) / d) * p.speed;
      p.y += ((p.ty - p.y) / d) * p.speed;
      keep.push(p);
      continue;
    }
    splash(w, p.faction, p.tx, p.ty, p.splash, p.damage, p.dmgType, p.targets, p.sourceId, incidents);
    w.fx.push({ type: "explosion", x: p.tx, y: p.ty, size: p.splash, air: false, kind: "impact" });
  }
  w.projectiles = keep;
}

/** Menders: repair the most damaged friendly nearby. */
function tickHealer(w: World, u: Unit, engaged: Set<number>): void {
  const stats = UNITS[u.kind];
  const reach = stats.range + COMBAT.acquireBonus + (u.order.type === "idle" ? 2.5 : 0);
  let best: { id: number; x: number; y: number; d: number; unit: boolean } | null = null;
  let bestScore = Infinity;
  for (const o of w.units.values()) {
    if (o.faction !== u.faction || o.id === u.id || o.hp >= UNITS[o.kind].hp) continue;
    const d = Math.hypot(o.x - u.x, o.y - u.y);
    if (d > reach) continue;
    const s = d + (o.hp / UNITS[o.kind].hp) * 3;
    if (s < bestScore) {
      bestScore = s;
      best = { id: o.id, x: o.x, y: o.y, d, unit: true };
    }
  }
  for (const b of w.buildings.values()) {
    if (b.faction !== u.faction || b.hp >= BUILDINGS[b.kind].hp) continue;
    const d = distToBuilding(b, u.x, u.y);
    if (d > reach) continue;
    const s = d + 2 + (b.hp / BUILDINGS[b.kind].hp) * 3;
    if (s < bestScore) {
      bestScore = s;
      const c = buildingCenter(b);
      best = { id: b.id, x: c.x, y: c.y, d, unit: false };
    }
  }
  if (!best) return;
  if (best.d > stats.range) {
    if (u.order.type === "idle") {
      moveUnitToward(w, u, best.x, best.y);
      engaged.add(u.id);
    }
    return;
  }
  engaged.add(u.id);
  u.aim = Math.atan2(best.x - u.x, -(best.y - u.y));
  const amount = (stats.heal ?? 0) / TICK_RATE;
  if (best.unit) {
    const o = w.units.get(best.id)!;
    o.hp = Math.min(UNITS[o.kind].hp, o.hp + amount);
  } else {
    const b = w.buildings.get(best.id)!;
    b.hp = Math.min(BUILDINGS[b.kind].hp, b.hp + amount);
  }
  if (w.tick % 5 === 0)
    w.fx.push({ type: "heal", x: u.x, y: u.y, tx: best.x, ty: best.y, sourceId: u.id, targetId: best.id });
}

/**
 * Combat pass. Returns the set of unit ids that should NOT move this tick
 * because they are engaging (in range of their target) or healing.
 */
export function tickCombat(w: World): Set<number> {
  const engaged = new Set<number>();
  const incidents: Incident[] = [];

  for (const u of w.units.values()) {
    if (u.cooldown > 0) u.cooldown--;
    const stats = UNITS[u.kind];
    if (u.rank >= 3 && u.hp < stats.hp && w.tick % TICK_RATE === 0)
      u.hp = Math.min(stats.hp, u.hp + stats.hp * COMBAT.eliteRegen);
    if (stats.heal) {
      tickHealer(w, u, engaged);
      continue;
    }
    if (stats.targets === "none") continue;
    const minRange = stats.minRange ?? 0;

    let targetId: number | null = null;
    if (u.order.type === "attack") {
      const t = targetPosition(w, u.order.targetId);
      if (!t || !canHit(stats.targets, t.domain)) {
        u.order = { type: "idle" };
      } else {
        targetId = u.order.targetId;
      }
    }
    if (targetId === null) {
      // auto-acquire while idle or attack-moving
      const acquire = stats.range + COMBAT.acquireBonus;
      if (u.autoTargetId !== null) {
        const d = distTo(w, u.autoTargetId, u.x, u.y);
        if (d > acquire + 0.5 || d < minRange) u.autoTargetId = null;
      }
      if (u.autoTargetId === null && (u.order.type === "idle" || u.order.type === "attackMove")) {
        const found = findTarget(w, u.faction, stats.targets, u.x, u.y, acquire, minRange);
        u.autoTargetId = found?.id ?? null;
      }
      targetId = u.autoTargetId;
    }
    if (targetId === null) continue;
    const d = distTo(w, targetId, u.x, u.y);
    if (d <= stats.range && d >= minRange) {
      engaged.add(u.id);
      fire(w, { unit: u }, targetId, incidents);
    } else if (u.order.type === "idle" && d > stats.range && targetId === u.autoTargetId) {
      // idle units close the last short gap to something in acquire range
      const t = targetPosition(w, targetId);
      if (t) moveUnitToward(w, u, t.x, t.y);
      engaged.add(u.id);
    }
  }

  for (const b of w.buildings.values()) {
    if (b.cooldown > 0) b.cooldown--;
    const stats = BUILDINGS[b.kind];
    if (stats.targets === "none") continue;
    const c = buildingCenter(b);
    const found = findTarget(w, b.faction, stats.targets, c.x, c.y, stats.range + BUILDINGS[b.kind].size / 2 - 0.5);
    if (found) fire(w, { building: b }, found.id, incidents);
  }

  tickProjectiles(w, incidents);
  retaliate(w, incidents);
  return engaged;
}

/** Idle victims (and idle armed neighbours) turn on whoever shot them. */
function retaliate(w: World, incidents: Incident[]): void {
  const seen = new Set<number>();
  for (const { victimId, attackerId } of incidents) {
    if (seen.has(victimId)) continue;
    seen.add(victimId);
    const attacker = targetPosition(w, attackerId);
    if (!attacker) continue;
    const victim = w.units.get(victimId) ?? null;
    const vb = victim ? null : w.buildings.get(victimId) ?? null;
    const vx = victim ? victim.x : vb ? buildingCenter(vb).x : 0;
    const vy = victim ? victim.y : vb ? buildingCenter(vb).y : 0;
    const faction = victim?.faction ?? vb?.faction;
    for (const u of w.units.values()) {
      if (u.faction !== faction || u.order.type !== "idle") continue;
      const stats = UNITS[u.kind];
      if (stats.targets === "none" || !canHit(stats.targets, attacker.domain)) continue;
      const self = u.id === victimId;
      if (!self && Math.hypot(u.x - vx, u.y - vy) > COMBAT.assistRadius) continue;
      if (Math.hypot(u.x - attacker.x, u.y - attacker.y) > COMBAT.retaliateRange) continue;
      // already busy with a target in range? keep shooting that instead
      if (u.autoTargetId !== null && distTo(w, u.autoTargetId, u.x, u.y) <= stats.range) continue;
      u.order = { type: "attack", targetId: attackerId };
      u.path = null;
    }
  }
}

/** XP needed for each rank, as a multiple of the unit's own cost. */
function rankFor(u: Unit): number {
  const cost = UNITS[u.kind].cost;
  let r = 0;
  for (const k of COMBAT.rankXp) if (u.xp >= k * cost) r++;
  return r;
}

/**
 * Credit a kill. The faction stat always goes to the victim's enemy (every
 * source of damage is hostile), even when the killer has since died or is a
 * building; XP and the kill count go to the killing unit if it still lives.
 */
function creditKill(w: World, victimFaction: Faction, killerId: number | null, victimCost: number, building: boolean): void {
  const enemy = victimFaction === "blue" ? "red" : "blue";
  const stats = w.factions[enemy].stats;
  if (building) stats.buildingsKilled++;
  else stats.unitsKilled++;
  if (killerId === null) return;
  const k = w.units.get(killerId);
  if (!k || k.faction === victimFaction) return;
  k.kills++;
  k.xp += victimCost;
  const r = rankFor(k);
  if (r > k.rank) {
    k.rank = r;
    w.fx.push({ type: "rankUp", id: k.id });
  }
}

/** Killer id/kind if the last attacker is still alive this tick. */
function killerOf(w: World, id: number | null): { killerId: number | null; killerKind: Unit["kind"] | null } {
  if (id === null) return { killerId: null, killerKind: null };
  const u = w.units.get(id);
  if (u) return { killerId: id, killerKind: u.kind };
  return w.buildings.has(id) ? { killerId: id, killerKind: null } : { killerId: null, killerKind: null };
}

/** Remove dead entities, emit explosions, and settle the winner. */
export function cleanupDeaths(w: World): void {
  for (const [id, u] of w.units) {
    if (u.hp > 0) continue;
    w.units.delete(id);
    w.factions[u.faction].stats.unitsLost++;
    const killer = killerOf(w, u.lastAttackerId);
    creditKill(w, u.faction, u.lastAttackerId, UNITS[u.kind].cost, false);
    const air = unitDomain(u) === "air";
    w.fx.push({ type: "explosion", x: u.x, y: u.y, size: UNITS[u.kind].radius * 2, air, kind: "unit" });
    w.fx.push({
      type: "death", id, faction: u.faction, unitKind: u.kind, buildingKind: null,
      x: u.x, y: u.y, air, value: UNITS[u.kind].cost, ...killer, rank: u.rank, kills: u.kills
    });
  }
  for (const b of [...w.buildings.values()]) {
    if (b.hp > 0) continue;
    removeBuilding(w, b);
    w.factions[b.faction].stats.buildingsLost++;
    const killer = killerOf(w, b.lastAttackerId);
    const value = BUILDINGS[b.kind].cost || 500;
    creditKill(w, b.faction, b.lastAttackerId, value, true);
    const c = buildingCenter(b);
    w.fx.push({ type: "explosion", x: c.x, y: c.y, size: BUILDINGS[b.kind].size, air: false, kind: "building" });
    w.fx.push({
      type: "death", id: b.id, faction: b.faction, unitKind: null, buildingKind: b.kind,
      x: c.x, y: c.y, air: false, value, ...killer, rank: 0, kills: 0
    });
    if (b.kind === "hq" && w.winner === null)
      w.winner = b.faction === "blue" ? "red" : "blue";
  }
}
