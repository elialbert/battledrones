import { BUILDINGS, TICK_RATE, UNITS } from "../balance";
import { nearestScrapTile } from "../economy";
import { knownBuildings } from "../fog";
import { isInfantry } from "../infantry";
import { bannedBy } from "../rules";
import { dropPoint, isLoaded } from "../transport";
import type { Command, Faction, Unit, World } from "../types";
import { dist } from "../world";
import type { AiState } from "./commander";
import { AA_COVER, aaSources, aaStrengthAt, seenEnemies } from "./intel";

/**
 * The commander's Condor drops (INFANTRY.md "AI"): Rush and Balanced keep one
 * dropship, load two infantry squads into it at home, fly it at the enemy's
 * harvester line on a route clear of the anti-air they can see or remember,
 * set the squads down a little short of the harvesters and let them fight.
 * The empty Condor flies home and goes again once two more squads are free;
 * a lost one is rebuilt (a few times a match). Ordinary board / unload /
 * move commands, same fog as everyone. Easy never drops.
 */

export const CONDOR_AI = {
  /** No drop boards before this (s): the opening settles first. */
  from: 150,
  /** Seconds from one drop landing (or being called off) to the next boarding. */
  every: 45,
  /** A boarding not finished in this long (s) goes with whoever is aboard, or is called off. */
  boardTimeout: 25,
  /** A loaded Condor that finds no clear route in this long (s) sets its squads down at home. */
  waitTimeout: 40,
  /** Seconds dropped squads raid on their own before they rejoin the army. */
  raid: 50,
  /** Condors built per match, at most (a lost one is rebuilt until then)… */
  maxBuilt: 3,
  /** …but no sooner than this (s) after the last one went down. */
  rebuild: 90,
  /** Drop this far (tiles) short of the harvesters, on the side facing home. */
  standoff: 2.5,
  /** Squads at least this healthy (share of max HP) are sent. */
  minHp: 0.7,
  /** Squads farther than this (tiles) from the Condor, or from home, aren't called to board. */
  reach: 16,
  /** A Condor that loses this share of its max HP on the way to its waypoint turns back. */
  abortLoss: 0.3,
  /** Dropped squads go for a harvester (or Depot) they know of within this many tiles; else they hold the field. */
  chase: 8,
  /** Visible armed enemy ground value within this radius (tiles) of a drop point… */
  guardRadius: 6,
  /** …above this share of the squads' own value makes it a trap, not a raid. */
  guardShare: 0.8
};

type Phase = "ready" | "boarding" | "loaded" | "transit" | "drop" | "return";

interface Memo {
  phase: Phase;
  condorId: number | null;
  /** Squads boarding or aboard. */
  squads: number[];
  /** Tick the current phase began. */
  since: number;
  waypoint: { x: number; y: number } | null;
  drop: { x: number; y: number } | null;
  /** Squads set down on a raid, the tick they rejoin the army, and the harvester line they work. */
  raiders: number[];
  raidUntil: number;
  field: { x: number; y: number } | null;
  /** Tick of the last landing (or called-off drop). */
  lastDrop: number;
  /** HP when the current trip began, and whether it turned back hurt (the squads then walk). */
  launchHp: number;
  turnedBack: boolean;
  built: number;
  lostTick: number;
}

const memos = new WeakMap<AiState, Memo>();
function memo(s: AiState): Memo {
  let m = memos.get(s);
  if (!m) {
    m = {
      phase: "ready", condorId: null, squads: [], since: 0, waypoint: null, drop: null,
      raiders: [], raidUntil: 0, field: null, lastDrop: -1e9, launchHp: 0, turnedBack: false, built: 0, lostTick: -1e9
    };
    memos.set(s, m);
  }
  return m;
}

/**
 * Does this commander fly Condor drops at all? Rush and Balanced do; never
 * on Easy, in Last Stand, under rules that ban infantry or the Condor, or
 * for a commander told never to raid (an op's dug-in defender).
 */
export function dropsCondors(w: World, faction: Faction, s: AiState): boolean {
  if (s.difficulty === "easy" || w.survival || !Number.isFinite(s.strategy.harassGroup)) return false;
  if (s.strategy.name !== "rush" && s.strategy.name !== "balanced") return false;
  return bannedBy(w, "condor", faction) === null && bannedBy(w, "trooper", faction) === null;
}

/**
 * Should the airpad build a Condor now? One at a time, once infantry is in
 * play, from shortly before the first drop is due; a lost one is rebuilt
 * after a pause, up to CONDOR_AI.maxBuilt a match. `have` counts Condors
 * alive and queued.
 */
export function wantCondor(w: World, faction: Faction, s: AiState, have: number, squads: number): boolean {
  if (have > 0 || !dropsCondors(w, faction, s)) return false;
  const m = memo(s);
  if (m.built >= CONDOR_AI.maxBuilt || w.tick - m.lostTick < CONDOR_AI.rebuild * TICK_RATE) return false;
  return w.tick >= (CONDOR_AI.from - 20) * TICK_RATE && squads >= 2;
}

/** Squads the drop plan has a claim on this pass (boarding, or out raiding): other tactics leave them be. */
export function condorHolds(w: World, s: AiState): number[] {
  const m = memos.get(s);
  if (!m) return [];
  const out: number[] = [];
  if (m.phase === "boarding") for (const id of m.squads) if (w.units.has(id)) out.push(id);
  if (w.tick < m.raidUntil) for (const id of m.raiders) if (w.units.has(id)) out.push(id);
  return out;
}

export interface CondorContext {
  army: Unit[];
  /** Units already given orders this pass (updated in place). */
  used: Set<number>;
  hqC: { x: number; y: number };
  /** A real attack on the base is under way: no drops, and a loaded Condor sets its squads down at home. */
  threatened: boolean;
}

/** One decision pass of the drop plan: board, fly, drop, raid, come home. */
export function planCondor(w: World, faction: Faction, s: AiState, ctx: CondorContext): Command[] {
  const cmds: Command[] = [];
  if (!dropsCondors(w, faction, s)) return cmds;
  const m = memo(s);
  const tps = TICK_RATE;
  // where the Condor waits: just behind the HQ, away from the enemy, over ground squads can walk up to
  const enemyGuess = { x: w.width - ctx.hqC.x, y: w.height - ctx.hqC.y };
  const back = Math.max(1, dist(ctx.hqC.x, ctx.hqC.y, enemyGuess.x, enemyGuess.y));
  const behind = {
    x: ctx.hqC.x - ((enemyGuess.x - ctx.hqC.x) / back) * 2.5,
    y: ctx.hqC.y - ((enemyGuess.y - ctx.hqC.y) / back) * 2.5
  };
  const home = dropPoint(w, faction, behind.x, behind.y) ?? behind;

  planRaiders(w, faction, m, ctx, cmds);

  // --- our Condor (built at the airpad): track it, notice when it's lost --
  let c = m.condorId !== null ? w.units.get(m.condorId) : undefined;
  if (!c) {
    if (m.condorId !== null) {
      m.lostTick = w.tick; // shot down: its squads bailed out (or went down with it)
      m.condorId = null;
    }
    for (const u of w.units.values())
      if (u.faction === faction && u.kind === "condor") {
        c = u;
        break;
      }
    if (!c) {
      setPhase(m, "ready", w.tick);
      m.squads = [];
      return cmds;
    }
    m.condorId = c.id;
    m.built++;
    setPhase(m, "ready", w.tick);
    m.squads = [];
    m.turnedBack = false;
  }
  const condor = c;
  const cap = UNITS.condor.capacity ?? 2;
  const aboard = () => (condor.passengers ?? []).map((p) => p.id);
  const unloadHome = () => {
    cmds.push({ type: "unload", faction, unitIds: [condor.id] });
    m.lastDrop = w.tick;
    setPhase(m, "return", w.tick);
  };
  const goHome = () => {
    if (dist(condor.x, condor.y, home.x, home.y) > 2 && condor.order.type === "idle")
      cmds.push({ type: "move", faction, unitIds: [condor.id], x: home.x, y: home.y });
  };

  switch (m.phase) {
    case "ready": {
      if (isLoaded(condor)) {
        setPhase(m, "loaded", w.tick);
        break;
      }
      goHome();
      if (ctx.threatened || w.tick < CONDOR_AI.from * tps || w.tick - m.lastDrop < CONDOR_AI.every * tps) break;
      if (condor.order.type !== "idle") break;
      const picks = ctx.army
        .filter(
          (u) =>
            isInfantry(u.kind) && u.kind !== "sniper" && u.order.type === "idle" && !ctx.used.has(u.id) &&
            u.hp >= UNITS[u.kind].hp * CONDOR_AI.minHp &&
            dist(u.x, u.y, condor.x, condor.y) <= CONDOR_AI.reach && dist(u.x, u.y, ctx.hqC.x, ctx.hqC.y) <= CONDOR_AI.reach
        )
        .sort((a, b) => dist(a.x, a.y, condor.x, condor.y) - dist(b.x, b.y, condor.x, condor.y))
        .slice(0, cap);
      if (picks.length < cap) break;
      m.squads = picks.map((u) => u.id);
      for (const id of m.squads) ctx.used.add(id);
      cmds.push({ type: "board", faction, unitIds: m.squads, carrierId: condor.id });
      setPhase(m, "boarding", w.tick);
      break;
    }
    case "boarding": {
      const inHold = aboard();
      const walking = m.squads.filter((id) => {
        const u = w.units.get(id);
        return !!u && u.order.type === "board" && u.order.carrierId === condor.id;
      });
      m.squads = [...inHold, ...walking];
      const late = w.tick - m.since > CONDOR_AI.boardTimeout * tps;
      if (ctx.threatened) {
        // the base needs everyone: off the ramp
        if (walking.length > 0) cmds.push({ type: "stop", faction, unitIds: walking });
        if (inHold.length > 0) unloadHome();
        else setPhase(m, "ready", w.tick);
        m.lastDrop = w.tick;
      } else if (inHold.length >= cap || (inHold.length > 0 && (walking.length === 0 || late))) {
        if (walking.length > 0) cmds.push({ type: "stop", faction, unitIds: walking });
        setPhase(m, "loaded", w.tick);
      } else if (inHold.length === 0 && (walking.length === 0 || late)) {
        if (walking.length > 0) cmds.push({ type: "stop", faction, unitIds: walking });
        m.lastDrop = w.tick; // try again later
        setPhase(m, "ready", w.tick);
      }
      break;
    }
    case "loaded": {
      if (!isLoaded(condor)) {
        setPhase(m, "ready", w.tick);
        break;
      }
      if (condor.order.type !== "idle") break;
      if (ctx.threatened || m.turnedBack || w.tick - m.since > CONDOR_AI.waitTimeout * tps) {
        unloadHome(); // (squads a Condor turned back with walk from here)
        m.turnedBack = false;
        break;
      }
      const plan = planDrop(w, faction, condor, ctx.hqC);
      if (!plan) break; // no clear way in yet: wait
      m.squads = aboard();
      m.drop = plan.drop;
      m.field = plan.line;
      m.waypoint = plan.waypoint;
      m.launchHp = condor.hp;
      if (plan.waypoint) {
        cmds.push({ type: "move", faction, unitIds: [condor.id], x: plan.waypoint.x, y: plan.waypoint.y });
        setPhase(m, "transit", w.tick);
      } else {
        cmds.push({ type: "unload", faction, unitIds: [condor.id], x: plan.drop.x, y: plan.drop.y });
        setPhase(m, "drop", w.tick);
      }
      break;
    }
    case "transit": {
      if (!isLoaded(condor)) {
        setPhase(m, "return", w.tick);
        break;
      }
      if (condor.hp < m.launchHp - UNITS.condor.hp * CONDOR_AI.abortLoss) {
        // taking fire on the way out: turn back with the squads
        cmds.push({ type: "move", faction, unitIds: [condor.id], x: home.x, y: home.y });
        m.lastDrop = w.tick;
        m.turnedBack = true;
        setPhase(m, "return", w.tick);
        break;
      }
      const wp = m.waypoint;
      if (wp && dist(condor.x, condor.y, wp.x, wp.y) > 1.5 && condor.order.type === "move") break;
      // over the waypoint: re-check the way in from here, then drop
      const plan = planDrop(w, faction, condor, ctx.hqC);
      if (plan && !plan.waypoint) {
        m.drop = plan.drop;
        m.field = plan.line;
        cmds.push({ type: "unload", faction, unitIds: [condor.id], x: plan.drop.x, y: plan.drop.y });
        setPhase(m, "drop", w.tick);
      } else if (plan?.waypoint) {
        m.drop = plan.drop;
        m.field = plan.line;
        m.waypoint = plan.waypoint;
        cmds.push({ type: "move", faction, unitIds: [condor.id], x: plan.waypoint.x, y: plan.waypoint.y });
        setPhase(m, "transit", w.tick);
      } else {
        cmds.push({ type: "move", faction, unitIds: [condor.id], x: home.x, y: home.y });
        setPhase(m, "return", w.tick);
      }
      break;
    }
    case "drop": {
      if (!isLoaded(condor)) {
        // down: the squads go for the harvesters, the Condor heads home
        m.raiders = m.squads.filter((id) => w.units.has(id));
        m.raidUntil = w.tick + CONDOR_AI.raid * tps;
        m.squads = [];
        m.lastDrop = w.tick;
        planRaiders(w, faction, m, ctx, cmds);
        cmds.push({ type: "move", faction, unitIds: [condor.id], x: home.x, y: home.y });
        setPhase(m, "return", w.tick);
      } else if (condor.order.type !== "unload") {
        setPhase(m, "loaded", w.tick); // knocked off course (a dodge): plan again
      } else if (condor.order.hover < 0 && m.drop && guarded(seenEnemies(w, faction), condor, m.drop)) {
        // the landing zone turned out to be held (seen on the way in): pick another, or go home
        const plan = planDrop(w, faction, condor, ctx.hqC);
        if (plan) {
          m.drop = plan.drop;
          m.field = plan.line;
          m.waypoint = plan.waypoint;
          if (plan.waypoint) {
            cmds.push({ type: "move", faction, unitIds: [condor.id], x: plan.waypoint.x, y: plan.waypoint.y });
            setPhase(m, "transit", w.tick);
          } else cmds.push({ type: "unload", faction, unitIds: [condor.id], x: plan.drop.x, y: plan.drop.y });
        } else {
          cmds.push({ type: "move", faction, unitIds: [condor.id], x: home.x, y: home.y });
          m.lastDrop = w.tick;
          setPhase(m, "return", w.tick);
        }
      }
      break;
    }
    case "return": {
      if (condor.order.type === "unload") break; // setting squads down at home
      if (condor.order.type === "idle" && dist(condor.x, condor.y, home.x, home.y) <= 2.5)
        setPhase(m, isLoaded(condor) ? "loaded" : "ready", w.tick);
      else goHome();
      break;
    }
  }
  return cmds;
}

function setPhase(m: Memo, p: Phase, tick: number): void {
  if (m.phase !== p) m.since = tick;
  m.phase = p;
}

/**
 * Dropped squads work the harvester line: a harvester they can see close by
 * gets shot (a short chase, not into the base), else a known Depot close by,
 * else they hold the field the harvesters come back to (attack-moving onto
 * it, so they fight whatever turns up). They rejoin the army when the raid
 * time is up.
 */
function planRaiders(w: World, faction: Faction, m: Memo, ctx: CondorContext, cmds: Command[]): void {
  if (m.raiders.length === 0) return;
  m.raiders = m.raiders.filter((id) => w.units.has(id));
  if (w.tick >= m.raidUntil) {
    m.raiders = []; // back to the army
    return;
  }
  const idle = m.raiders.map((id) => w.units.get(id)!).filter((u) => u.order.type === "idle" && u.autoTargetId === null);
  if (idle.length === 0) return;
  const cx = idle.reduce((a, u) => a + u.x, 0) / idle.length;
  const cy = idle.reduce((a, u) => a + u.y, 0) / idle.length;
  const ids = idle.map((u) => u.id);
  let best: { id: number; d: number } | null = null;
  for (const e of seenEnemies(w, faction)) {
    if (e.kind !== "harvester") continue;
    const d = dist(e.x, e.y, cx, cy);
    if (d <= CONDOR_AI.chase && (!best || d < best.d)) best = { id: e.id, d };
  }
  if (best) {
    for (const id of ids) ctx.used.add(id);
    cmds.push({ type: "attack", faction, unitIds: ids, targetId: best.id });
    return;
  }
  let depot: { x: number; y: number; d: number } | null = null;
  for (const kb of knownBuildings(w, faction)) {
    if (kb.kind !== "depot") continue;
    const size = BUILDINGS[kb.kind].size;
    const d = dist(kb.tx + size / 2, kb.ty + size / 2, cx, cy);
    if (d <= CONDOR_AI.chase && (!depot || d < depot.d)) depot = { x: kb.tx + size / 2, y: kb.ty + size / 2, d };
  }
  const goal = depot ?? m.field;
  if (!goal || dist(goal.x, goal.y, cx, cy) <= 2) return; // holding the field: wait for the harvesters
  for (const id of ids) ctx.used.add(id);
  cmds.push({ type: "attackMove", faction, unitIds: ids, x: goal.x, y: goal.y });
}

/** Is a drop point held by more visible armed ground enemies than the squads aboard could take on? */
function guarded(seen: Unit[], c: Unit, p: { x: number; y: number }): boolean {
  const squads = (c.passengers ?? []).reduce((v, u) => v + UNITS[u.kind].cost, 0);
  let v = 0;
  for (const e of seen)
    if (UNITS[e.kind].dps > 0 && UNITS[e.kind].domain === "ground" && dist(e.x, e.y, p.x, p.y) <= CONDOR_AI.guardRadius)
      v += UNITS[e.kind].cost;
  return v > squads * CONDOR_AI.guardShare;
}

/**
 * Where to drop and how to get there: a point CONDOR_AI.standoff short of an
 * enemy harvester line (a visible harvester, a known Depot, else the mirror
 * image of our own field) that no visible guard holds, no more anti-air on
 * it than AA_COVER, reached on a straight line or around one flank waypoint
 * that stays clear. Candidates are generated relative to the line of flight,
 * so red's choice is the mirror image of blue's. Null when every way in is
 * covered.
 */
function planDrop(
  w: World,
  faction: Faction,
  c: Unit,
  hqC: { x: number; y: number }
): { drop: { x: number; y: number }; waypoint: { x: number; y: number } | null; line: { x: number; y: number } } | null {
  const seen = seenEnemies(w, faction);
  const sources = aaSources(w, faction, seen);
  const covered = (x: number, y: number) => aaStrengthAt(sources, x, y) >= AA_COVER;
  const clear = (ax: number, ay: number, bx: number, by: number) => {
    const n = Math.max(1, Math.ceil(dist(ax, ay, bx, by)));
    for (let i = 1; i <= n; i++) if (covered(ax + ((bx - ax) * i) / n, ay + ((by - ay) * i) / n)) return false;
    return true;
  };
  const inMap = (p: { x: number; y: number }) => ({
    x: Math.min(w.width - 1, Math.max(1, p.x)),
    y: Math.min(w.height - 1, Math.max(1, p.y))
  });
  // harvester lines, nearest to us first
  const lines: { x: number; y: number }[] = [];
  for (const e of seen) if (e.kind === "harvester") lines.push({ x: e.x, y: e.y });
  for (const kb of knownBuildings(w, faction)) if (kb.kind === "depot") lines.push({ x: kb.tx + 1, y: kb.ty + 1 });
  if (lines.length === 0) {
    // their home field: the mirror image of ours
    const own = nearestScrapTile(w, hqC.x, hqC.y, faction);
    lines.push(own ? { x: w.width - own.x - 0.5, y: w.height - own.y - 0.5 } : { x: w.width - hqC.x, y: w.height - hqC.y });
  }
  lines.sort((a, b) => dist(a.x, a.y, hqC.x, hqC.y) - dist(b.x, b.y, hqC.x, hqC.y));
  const ANGLES = [0, 0.7, -0.7, 1.4, -1.4, 2.1, -2.1];
  const SIDE = [6, -6, 10, -10, 14, -14];
  for (const t of lines.slice(0, 4)) {
    // approach from our side of it
    const d0 = Math.max(0.01, dist(c.x, c.y, t.x, t.y));
    const ux = (c.x - t.x) / d0;
    const uy = (c.y - t.y) / d0;
    for (const a of ANGLES) {
      const dx = ux * Math.cos(a) - uy * Math.sin(a);
      const dy = ux * Math.sin(a) + uy * Math.cos(a);
      const drop = inMap({ x: t.x + dx * CONDOR_AI.standoff, y: t.y + dy * CONDOR_AI.standoff });
      if (covered(drop.x, drop.y) || guarded(seen, c, drop)) continue;
      if (clear(c.x, c.y, drop.x, drop.y)) return { drop, waypoint: null, line: t };
      // around a flank: a waypoint off to the side of the straight line
      const len = Math.max(0.01, dist(c.x, c.y, drop.x, drop.y));
      const px = -(drop.y - c.y) / len;
      const py = (drop.x - c.x) / len;
      const mx = (c.x + drop.x) / 2;
      const my = (c.y + drop.y) / 2;
      for (const k of SIDE) {
        const wp = inMap({ x: mx + px * k, y: my + py * k });
        if (clear(c.x, c.y, wp.x, wp.y) && clear(wp.x, wp.y, drop.x, drop.y)) return { drop, waypoint: wp, line: t };
      }
    }
  }
  return null;
}
