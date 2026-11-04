import { BUILDINGS, TICK_RATE, UNITS } from "../balance";
import { knownBuildings } from "../fog";
import type { Command, Faction, Unit, World } from "../types";
import { canGetWithin, dist, moveClassOf, passable } from "../world";
import type { AiState } from "./commander";

/**
 * The Feint (Strategy.feint: Marshal's plan of that name, for fun). A small,
 * loud force attacks one place while the army waits out of sight; once the
 * enemy has gone to it, the army hits somewhere else.
 *
 * - WAIT: no stock waves (the plan's assaultValue is Infinity) until `from` s
 *   and an army worth `army` that outweighs what we remember of theirs.
 * - FORM: two targets from the drop-offs we know of, the army off to a
 *   staging point away from both (a simple distance rule, FEINT.hide).
 * - OUT: FEINT.share of the army, fastest first, attacks the near target and
 *   stays there. The army goes when FEINT.bait of the feint's worth in enemy
 *   army has come to it, or FEINT.patience s after it set out, or the feint
 *   is dead, or it's found itself.
 * - SPRUNG: the army is a stock wave at the far target, the plan's waves
 *   back on (`after`), and the feint pins what it drew for FEINT.pin s
 *   before it's the army's too. When the assault ends, it's back to WAIT, for
 *   `tricks` tricks in all; then SPENT: stock waves for good.
 *
 * A real attack on the base calls the whole thing off: everything held goes
 * back to the commander, who defends. Same fog as everyone: only
 * knownBuildings and what's seen.
 */

export const FEINT = {
  /** The feint's share of the army, by value. */
  share: 0.22,
  /** Enemy army worth this many feints, seen by it, and the trap is sprung… */
  bait: 1,
  /** …if it's this share of what we remember of theirs too. */
  baitShare: 0.4,
  /** Enemy army this close to the feint counts as drawn to it. */
  reach: 10,
  /** Seconds after the feint sets out that the army goes anyway. */
  patience: 60,
  /** Seconds the army may take to reach the staging point. */
  form: 60,
  /** Share of the army at the staging point that's enough to send the feint. */
  formed: 0.7,
  /** Within this of the staging point: there. */
  stageRadius: 5,
  /** The staging point stands this far from anything of theirs we know of. */
  hide: 12,
  /** Enemy army (scrap) this close to the army waiting has found it: it goes at once. */
  foundReach: 7,
  found: 400,
  /** Seconds the feint fights on, ours to command, after the army goes. */
  pin: 20,
  /** Seconds a called-off trick waits before the next try. */
  retry: 45,
  /** Enemies this close to the army's way to a target count as at the target. */
  lane: 6,
  /** Targets closer than this are one target: the fields they mine come into it. */
  apart: 14,
  /** Seconds after it's sprung that a wave down to `waveLeft` of its worth is over, and the next trick can start. */
  waveSecs: 100,
  waveLeft: 0.4
};

type P = { x: number; y: number };
type Phase = "wait" | "form" | "out" | "sprung" | "spent";

/** One trick, for traces and tests. */
export interface Trick {
  formed: number;
  out: number;
  sprung: number;
  /** Why the army went. */
  why: "bait" | "time" | "lost" | "found" | "called off" | "";
  feintTo: P;
  mainTo: P;
  stage: P;
  feintValue: number;
  mainValue: number;
  /** The army, once it's gone. */
  wave: number[];
}

interface Memo {
  phase: Phase;
  feint: number[];
  main: number[];
  tricks: Trick[];
  /** Tricks that went off (a called-off one doesn't count). */
  done: number;
  /** No new trick before this tick. */
  nextAt: number;
  /** The feint is the commander's again from this tick (SPRUNG). */
  pinUntil: number;
  /** The wave it became (SPRUNG). */
  wave: number[];
}

const memos = new WeakMap<AiState, Memo>();
function memo(s: AiState): Memo {
  let m = memos.get(s);
  if (!m) {
    m = { phase: "wait", feint: [], main: [], tricks: [], done: 0, nextAt: 0, pinUntil: 0, wave: [] };
    memos.set(s, m);
  }
  return m;
}

/** The units the trick holds now: no other tactic gives them orders. */
export function feintHolds(s: AiState): Set<number> {
  const m = memos.get(s);
  return new Set(m ? [...m.feint, ...m.main] : []);
}

/** The trick's phase, and the tricks so far (traces and tests). */
export const feintPhase = (s: AiState): Phase => memo(s).phase;
export const feintTricks = (s: AiState): readonly Trick[] => memo(s).tricks;

export interface FeintContext {
  hqC: P;
  army: readonly Unit[];
  used: Set<number>;
  seen: readonly Unit[];
  threatened: boolean;
  /** Our army's worth that starts a trick. */
  readyAt: number;
  /** What we remember of their army (0 when it doesn't weigh)… */
  enemyArmy: number;
  /** …and the edge a trick wants over it. */
  outweigh: number;
  /** No trick here at all (Last Stand, island relays): the plan's stock waves instead. */
  barred: boolean;
  /** The drop-offs' owner in a free-for-all. */
  focus: Faction | null;
  /** Their home field (0), or a field they'd expand to (1): targets while the drop-offs known are too close together. */
  field: (leg: number) => P;
  /** Their base, known or guessed. */
  enemyHqPos: P;
}

const valueOf = (units: readonly Unit[]) => units.reduce((v, u) => v + UNITS[u.kind].cost, 0);
const armed = (e: Unit) => e.kind !== "harvester" && UNITS[e.kind].dps > 0;

/** The trick's orders this pass. */
export function planFeint(w: World, faction: Faction, s: AiState, ctx: FeintContext): Command[] {
  const spec = s.strategy.feint;
  if (!spec) return [];
  const m = memo(s);
  if (m.phase === "spent") return [];
  const alive = (ids: number[]) => ids.filter((id) => w.units.get(id)?.faction === faction);
  m.feint = alive(m.feint);
  m.main = alive(m.main);
  const waves = (on: boolean) => {
    s.strategy = { ...s.strategy, assaultValue: on ? spec.after : Infinity };
  };
  if (ctx.barred) {
    m.phase = "spent";
    m.feint = [];
    m.main = [];
    waves(true);
    return [];
  }
  const trick = m.tricks[m.tricks.length - 1];
  const callOff = () => {
    trick!.why = "called off";
    m.feint = [];
    m.main = [];
    m.phase = "wait";
    m.nextAt = w.tick + FEINT.retry * TICK_RATE;
  };

  if (m.phase === "sprung") {
    if (w.tick >= m.pinUntil) m.feint = [];
    const left = valueOf(alive(m.wave).map((id) => w.units.get(id)!));
    const over = w.tick - trick!.sprung >= FEINT.waveSecs * TICK_RATE && left < FEINT.waveLeft * trick!.mainValue;
    if (s.mode === "assault" && (!over || m.done >= spec.tricks)) return idleFeint(w, faction, m, trick!);
    if (over) s.mode = "buildup";
    m.feint = [];
    m.wave = [];
    m.phase = m.done >= spec.tricks ? "spent" : "wait";
    m.nextAt = w.tick + FEINT.retry * TICK_RATE;
    waves(m.phase === "spent");
    return [];
  }

  if ((m.phase === "form" || m.phase === "out") && ctx.threatened) {
    callOff();
    return [];
  }

  // --- wait: an army worth the trick, and somewhere to play it
  if (m.phase === "wait") {
    if (ctx.threatened || w.tick < Math.max(m.nextAt, spec.from * TICK_RATE, (s.strategy.holdUntil ?? 0) * TICK_RATE)) return [];
    const free = ctx.army
      .filter((u) => !ctx.used.has(u.id) && u.kind !== "mender" && UNITS[u.kind].dps > 0 && (u.order.type === "idle" || u.order.type === "attackMove"))
      .sort((a, b) => a.id - b.id);
    const worth = valueOf(free);
    if (worth < ctx.readyAt || worth < ctx.outweigh) return [];
    const { feintTo, mainTo } = targets(w, faction, ctx);
    const stage = stagingPoint(w, faction, ctx, feintTo, mainTo, free);
    // the feint: the fastest first, long guns never (it has to look like an attack, and get there)
    const quick = free.filter((u) => u.kind !== "mortar").sort((a, b) => UNITS[b.kind].speed - UNITS[a.kind].speed || a.id - b.id);
    const feint: Unit[] = [];
    let v = 0;
    for (const u of quick) {
      if (v >= FEINT.share * worth) break;
      feint.push(u);
      v += UNITS[u.kind].cost;
    }
    m.feint = feint.map((u) => u.id);
    const taken = new Set(m.feint);
    m.main = free.filter((u) => !taken.has(u.id)).map((u) => u.id);
    if (!m.main.length) {
      m.feint = [];
      return [];
    }
    const started: Trick = { formed: w.tick, out: -1, sprung: -1, why: "", feintTo, mainTo, stage, feintValue: v, mainValue: worth - v, wave: [] };
    m.tricks.push(started);
    spec.onTrick?.(started);
    m.phase = "form";
    for (const id of feintHolds(s)) ctx.used.add(id);
    return [{ type: "move", faction, unitIds: m.main, x: stage.x, y: stage.y }];
  }

  const t = trick!;
  const cmds: Command[] = [];
  // (what's built meanwhile joins the army where it waits: sent from home at the last moment, it marched
  // through the middle, past what the feint had drawn, and 20 units met 57 at Dune Sea with 4,000 stood at home)
  const late = ctx.army.filter((u) => !ctx.used.has(u.id) && u.order.type === "idle" && u.kind !== "mender" && UNITS[u.kind].dps > 0).map((u) => u.id);
  if (late.length) {
    m.main.push(...late);
    for (const id of late) ctx.used.add(id);
    cmds.push({ type: "move", faction, unitIds: late, x: t.stage.x, y: t.stage.y });
  }
  const main = m.main.map((id) => w.units.get(id)!);

  // --- form: the army gets to the staging point, then the feint sets out
  if (m.phase === "form") {
    if (!m.main.length) {
      callOff();
      return [];
    }
    const there = main.filter((u) => dist(u.x, u.y, t.stage.x, t.stage.y) <= FEINT.stageRadius);
    if (valueOf(there) >= FEINT.formed * valueOf(main) || w.tick - t.formed >= FEINT.form * TICK_RATE) {
      t.out = w.tick;
      m.phase = "out";
      if (m.feint.length) cmds.push({ type: "attackMove", faction, unitIds: m.feint, x: t.feintTo.x, y: t.feintTo.y });
      return cmds;
    }
  }

  // --- out: wait for them to take the bait
  if (m.phase === "out") {
    if (!m.main.length) {
      callOff();
      return [];
    }
    const feint = m.feint.map((id) => w.units.get(id)!);
    const by = (p: P, r: number) => valueOf(ctx.seen.filter((e) => armed(e) && dist(e.x, e.y, p.x, p.y) <= r));
    const drawn = feint.length ? Math.max(by(t.feintTo, FEINT.reach), ...feint.map((u) => by(u, FEINT.reach))) : 0;
    const why: Trick["why"] =
      main.some((u) => by(u, FEINT.foundReach) >= FEINT.found) ? "found"
      : drawn >= Math.max(FEINT.bait * t.feintValue, FEINT.baitShare * ctx.enemyArmy) ? "bait"
      : !feint.length ? "lost"
      : w.tick - t.out >= FEINT.patience * TICK_RATE ? "time"
      : "";
    if (why) {
      t.why = why;
      t.sprung = w.tick;
      m.phase = "sprung";
      m.done++;
      m.pinUntil = w.tick + FEINT.pin * TICK_RATE;
      waves(true);
      s.mode = "assault";
      s.waveValue = valueOf(ctx.army);
      // (where they aren't, now they've moved: the target was only ever a guess)
      const to = (t.mainTo = emptiest(w, faction, ctx, t, main));
      m.wave = t.wave = m.main;
      s.wave = { ids: [...m.wave], x: to.x, y: to.y, tick: w.tick };
      cmds.push({ type: "attackMove", faction, unitIds: m.wave, x: to.x, y: to.y });
      m.main = [];
      return cmds;
    }
    cmds.push(...idleFeint(w, faction, m, t));
  }
  return cmds;
}

/** A feint with nothing left to shoot at where it stands goes for the next thing of theirs by the target: it's meant to linger. */
function idleFeint(w: World, faction: Faction, m: Memo, t: Trick): Command[] {
  const idle = m.feint.filter((id) => w.units.get(id)?.order.type === "idle");
  if (!idle.length) return [];
  const near = knownBuildings(w, faction)
    .filter((b) => b.faction !== faction && w.buildings.has(b.id))
    .map((b) => ({ x: b.tx + BUILDINGS[b.kind].size / 2, y: b.ty + BUILDINGS[b.kind].size / 2, id: b.id }))
    .sort((a, b) => dist(a.x, a.y, t.feintTo.x, t.feintTo.y) - dist(b.x, b.y, t.feintTo.x, t.feintTo.y) || a.id - b.id)[0];
  const to = near ?? t.feintTo;
  return [{ type: "attackMove", faction, unitIds: idle, x: to.x, y: to.y }];
}

/**
 * The two targets: of the drop-offs we know of, the two farthest apart, the
 * feint at the one nearer us (it's the plausible one, and draws them out), the
 * army at the other. Closer together than FEINT.apart (often the HQ and
 * nothing else is known), the fields they mine are targets too.
 */
function targets(w: World, faction: Faction, ctx: FeintContext): { feintTo: P; mainTo: P } {
  const drops: P[] = knownBuildings(w, faction)
    .filter((b) => b.faction !== faction && (!ctx.focus || b.faction === ctx.focus) && (b.kind === "hq" || b.kind === "depot"))
    .map((b) => ({ x: b.tx + BUILDINGS[b.kind].size / 2, y: b.ty + BUILDINGS[b.kind].size / 2 }));
  if (drops.length === 0) drops.push(ctx.enemyHqPos);
  let [a, b, far] = farthest(drops);
  if (far < FEINT.apart) [a, b, far] = farthest([...drops, ctx.field(0), ctx.field(1)]);
  const near = (p: P) => dist(p.x, p.y, ctx.hqC.x, ctx.hqC.y);
  return near(a) <= near(b) ? { feintTo: a, mainTo: b } : { feintTo: b, mainTo: a };
}

/** The drop-off of theirs with the least of their army seen by it or on the way there (a tie: the farthest from the feint). */
function emptiest(w: World, faction: Faction, ctx: FeintContext, t: Trick, main: readonly Unit[]): P {
  const from = { x: main.reduce((v, u) => v + u.x, 0) / main.length, y: main.reduce((v, u) => v + u.y, 0) / main.length };
  const known = knownBuildings(w, faction)
    .filter((b) => b.faction !== faction && (!ctx.focus || b.faction === ctx.focus) && (b.kind === "hq" || b.kind === "depot") && w.buildings.has(b.id))
    .map((b) => ({ x: b.tx + BUILDINGS[b.kind].size / 2, y: b.ty + BUILDINGS[b.kind].size / 2 }));
  const scored = [t.mainTo, ...known].map((p) => ({
    p,
    there: valueOf(ctx.seen.filter((e) => armed(e) && (dist(e.x, e.y, p.x, p.y) <= FEINT.reach || offLine(e, from, p) <= FEINT.lane))),
    off: dist(p.x, p.y, t.feintTo.x, t.feintTo.y)
  }));
  return scored.filter((c) => c.off >= FEINT.apart / 2).sort((a, b) => a.there - b.there || b.off - a.off)[0]?.p ?? t.mainTo;
}

/** How far `e` is from the straight line from `a` to `b`. */
function offLine(e: P, a: P, b: P): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const k = Math.max(0, Math.min(1, ((e.x - a.x) * dx + (e.y - a.y) * dy) / Math.max(1, dx * dx + dy * dy)));
  return dist(e.x, e.y, a.x + dx * k, a.y + dy * k);
}

/** The two of `ps` farthest apart, and how far. */
function farthest(ps: P[]): [P, P, number] {
  let out: [P, P, number] = [ps[0]!, ps[0]!, 0];
  for (let i = 0; i < ps.length; i++)
    for (let j = i + 1; j < ps.length; j++) {
      const d = dist(ps[i]!.x, ps[i]!.y, ps[j]!.x, ps[j]!.y);
      if (d > out[2]) out = [ps[i]!, ps[j]!, d];
    }
  return out;
}

/**
 * Where the army waits: off to one side of the line from us to its target,
 * on the side away from the feint, FEINT.hide from anything of theirs we know
 * of, somewhere it can walk to. Candidates are taken along and across that
 * line, so red's choice is the mirror image of blue's. The nearest to the
 * target that qualifies; failing all, partway along the line.
 */
function stagingPoint(w: World, faction: Faction, ctx: FeintContext, feintTo: P, mainTo: P, army: readonly Unit[]): P {
  const len = Math.max(1, dist(ctx.hqC.x, ctx.hqC.y, mainTo.x, mainTo.y));
  const ux = (mainTo.x - ctx.hqC.x) / len;
  const uy = (mainTo.y - ctx.hqC.y) / len;
  const theirs = [
    ...knownBuildings(w, faction).filter((b) => b.faction !== faction).map((b) => ({ x: b.tx + 1, y: b.ty + 1 })),
    ...ctx.seen
  ];
  const walker = army.find((u) => moveClassOf(u.kind) === "ground") ?? army[0]!;
  let best: { p: P; score: number } | null = null;
  for (const along of [0.5, 0.4, 0.3, 0.2])
    for (const across of [8, -8, 12, -12, 16, -16]) {
      const p = { x: ctx.hqC.x + ux * len * along - uy * across, y: ctx.hqC.y + uy * len * along + ux * across };
      if (p.x < 2 || p.y < 2 || p.x > w.width - 2 || p.y > w.height - 2) continue;
      if (!passable(w, Math.floor(p.x), Math.floor(p.y), moveClassOf(walker.kind))) continue;
      if (theirs.some((e) => dist(e.x, e.y, p.x, p.y) < FEINT.hide)) continue;
      if (!canGetWithin(w, moveClassOf(walker.kind), walker.x, walker.y, p.x, p.y, 2)) continue;
      const score = dist(p.x, p.y, feintTo.x, feintTo.y) - dist(p.x, p.y, mainTo.x, mainTo.y);
      if (!best || score > best.score + 1e-6) best = { p, score };
    }
  return best?.p ?? { x: ctx.hqC.x + ux * len * 0.4, y: ctx.hqC.y + uy * len * 0.4 };
}
