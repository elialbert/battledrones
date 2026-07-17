import { BUILDINGS, COMBAT, TICK_RATE, UNITS } from "./balance";
import type { Building, Faction, TargetDomain, Unit, World } from "./types";
import { buildingCenter, distToBuilding } from "./world";

type Attacker = { unit: Unit } | { building: Building };

const canHit = (targets: TargetDomain, domain: "ground" | "air"): boolean =>
  targets === "both" || targets === domain;

function unitDomain(u: Unit): "ground" | "air" {
  return UNITS[u.kind].domain;
}

interface TargetRef {
  id: number;
  x: number;
  y: number;
  dist: number;
}

/** Nearest valid enemy (unit or building) within `radius` of (x, y). */
export function findTarget(
  w: World,
  faction: Faction,
  targets: TargetDomain,
  x: number,
  y: number,
  radius: number
): TargetRef | null {
  if (targets === "none") return null;
  let best: TargetRef | null = null;
  for (const u of w.units.values()) {
    if (u.faction === faction || !canHit(targets, unitDomain(u))) continue;
    const d = Math.hypot(u.x - x, u.y - y);
    if (d <= radius && (!best || d < best.dist)) best = { id: u.id, x: u.x, y: u.y, dist: d };
  }
  // buildings are ground targets
  if (canHit(targets, "ground"))
    for (const b of w.buildings.values()) {
      if (b.faction === faction) continue;
      const d = distToBuilding(b, x, y);
      if (d <= radius && (!best || d < best.dist)) {
        const c = buildingCenter(b);
        best = { id: b.id, x: c.x, y: c.y, dist: d };
      }
    }
  return best;
}

function targetPosition(w: World, id: number): { x: number; y: number; domain: "ground" | "air" } | null {
  const u = w.units.get(id);
  if (u) return { x: u.x, y: u.y, domain: unitDomain(u) };
  const b = w.buildings.get(id);
  if (b) {
    const c = buildingCenter(b);
    return { x: c.x, y: c.y, domain: "ground" };
  }
  return null;
}

function applyDamage(w: World, id: number, damage: number): void {
  const u = w.units.get(id);
  if (u) {
    u.hp -= damage;
    return;
  }
  const b = w.buildings.get(id);
  if (b) b.hp -= damage;
}

function fire(w: World, attacker: Attacker, targetId: number): void {
  const isUnit = "unit" in attacker;
  const stats = isUnit ? UNITS[attacker.unit.kind] : BUILDINGS[attacker.building.kind];
  const src = isUnit
    ? { x: attacker.unit.x, y: attacker.unit.y }
    : buildingCenter(attacker.building);
  const t = targetPosition(w, targetId);
  if (!t) return;
  const holder = isUnit ? attacker.unit : attacker.building;
  if (holder.cooldown > 0) return;
  holder.cooldown = Math.round(COMBAT.shotInterval * TICK_RATE);
  holder.facing = Math.atan2(t.x - src.x, -(t.y - src.y));
  applyDamage(w, targetId, stats.dps * COMBAT.shotInterval);
  w.fx.push({ type: "shot", x: src.x, y: src.y, tx: t.x, ty: t.y, air: t.domain === "air" });
}

/**
 * Combat pass. Returns the set of unit ids that should NOT move this tick
 * because they are engaging (in range of their target).
 */
export function tickCombat(w: World): Set<number> {
  const engaged = new Set<number>();

  for (const u of w.units.values()) {
    if (u.cooldown > 0) u.cooldown--;
    const stats = UNITS[u.kind];
    if (stats.targets === "none") continue;

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
      if (u.autoTargetId !== null) {
        const t = targetPosition(w, u.autoTargetId);
        if (!t || t === null || Math.hypot(t.x - u.x, t.y - u.y) > stats.range + COMBAT.acquireBonus + 0.5)
          u.autoTargetId = null;
      }
      if (u.autoTargetId === null && (u.order.type === "idle" || u.order.type === "attackMove")) {
        const found = findTarget(w, u.faction, stats.targets, u.x, u.y, stats.range + COMBAT.acquireBonus);
        u.autoTargetId = found?.id ?? null;
      }
      targetId = u.autoTargetId;
    }
    if (targetId === null) continue;
    const t = targetPosition(w, targetId);
    if (!t) continue;
    const d = Math.hypot(t.x - u.x, t.y - u.y);
    const inRange =
      d <= stats.range ||
      (w.buildings.has(targetId) && distToBuilding(w.buildings.get(targetId)!, u.x, u.y) <= stats.range);
    if (inRange) {
      engaged.add(u.id);
      fire(w, { unit: u }, targetId);
    }
  }

  for (const b of w.buildings.values()) {
    if (b.cooldown > 0) b.cooldown--;
    const stats = BUILDINGS[b.kind];
    if (stats.targets === "none") continue;
    const c = buildingCenter(b);
    const found = findTarget(w, b.faction, stats.targets, c.x, c.y, stats.range);
    if (found) fire(w, { building: b }, found.id);
  }

  return engaged;
}

/** Remove dead entities, emit explosions, and settle the winner. */
export function cleanupDeaths(w: World): void {
  for (const [id, u] of w.units) {
    if (u.hp > 0) continue;
    w.units.delete(id);
    w.factions[u.faction].stats.unitsLost++;
    w.fx.push({ type: "explosion", x: u.x, y: u.y, air: unitDomain(u) === "air" });
  }
  for (const [id, b] of w.buildings) {
    if (b.hp > 0) continue;
    w.buildings.delete(id);
    const c = buildingCenter(b);
    w.fx.push({ type: "explosion", x: c.x, y: c.y });
    if (b.kind === "hq" && w.winner === null)
      w.winner = b.faction === "blue" ? "red" : "blue";
    // footprint freed: ground paths through here may open up
    for (const u of w.units.values()) u.path = null;
  }
}
