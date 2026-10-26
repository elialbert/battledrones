/**
 * The four-player online battle as every page plays it (FFA.md "The turn
 * log"): the world set up from the agreed FfaSetup, the turn log, and the
 * commanders. Engine-free and deterministic: two pages holding the same log
 * step the same orders on every tick, so their worlds stay the same.
 *
 * Tick n's orders are its logged ones (people's, stamped with their side)
 * plus whatever the commanders playing a seat order this tick (tickAi, run
 * here on every page at the same tick, from the same seed), each side's in
 * canonical side order. A control event in tick n's entry hands a seat to a
 * stand-in commander (its person left) or back (they returned), from tick n.
 */
import { DIFFICULTY, createAiState, tickAi, type AiState } from "../sim/ai/commander";
import type { BattleRecord, SeatInfo } from "../arena/record";
import { worldHash } from "../sim/checksum";
import { setupWorld } from "../sim/setup";
import { sidesOf } from "../sim/sides";
import type { Command, Faction, World } from "../sim/types";
import { isControl, isHash, isTickEnd, type FfaSetup, type LogEvent } from "./protocol";

declare const __SIM_HASH__: string | undefined;
/** A world hash every this many ticks: the record's trail (arena/record.ts HASH_EVERY, not imported: the arena loads on demand). */
export const HASH_EVERY = 100;

/** Where a tick's events sit in the log: [start, end) and the index of its end marker. */
interface TickSpan {
  start: number;
  end: number;
}

export class FfaMatch {
  readonly world: World;
  readonly setup: FfaSetup;
  /** The turn log as held so far. */
  readonly log: LogEvent[] = [];
  /** Each sealed tick's events in the log (index: the tick). */
  private readonly spans: TickSpan[] = [];
  /** The commanders playing a seat now: the setup's AI seats, and stand-ins for people who left. */
  private readonly ais = new Map<Faction, AiState>();
  /** The host's world hashes from the log, and this page's, by tick (compared once both are known). */
  private readonly theirHash = new Map<number, string>();
  private readonly ownHash = new Map<number, string>();
  /** The first tick whose hashes disagree (null: none so far). */
  desyncAt: number | null = null;
  /** The orders each tick was stepped with (the replay's turns), and the hash trail every HASH_EVERY ticks. */
  private readonly turns: [number, Faction, Command[]][] = [];
  private readonly hashes: [number, string][] = [];
  private readonly created = new Date().toISOString();
  /** The orders handed out for the tick being stepped (afterStep logs them). */
  private stepping: Command[] | null = null;
  private stepTick = -1;

  constructor(setup: FfaSetup) {
    this.setup = setup;
    this.world = setupWorld({ map: setup.map, seed: setup.seed, mutators: setup.mutators, openers: setup.openers });
    for (const p of setup.seats) if (p.kind === "ai") this.ais.set(p.side, createAiState(p.strategy, p.difficulty, p.seed));
  }

  /** Ticks sealed in the log so far (tick n is playable once n < sealed()). */
  sealed(): number {
    return this.spans.length;
  }

  /** Is this side played by a commander now (an AI seat, or a stand-in)? */
  aiPlays(f: Faction): boolean {
    return this.ais.has(f);
  }

  /** Who plays a seat now, for the HUD: its person's name, or the commander's. */
  playerOf(f: Faction): string {
    const plan = this.setup.seats.find((p) => p.side === f);
    const ai = this.ais.get(f);
    if (ai) return plan?.kind === "human" ? `${plan.name} (AI stand-in)` : `${ai.strategy.label} AI`;
    return plan?.kind === "human" ? plan.name : "";
  }

  /**
   * Append events to the log (a guest: as they arrive, in order). Tick ends
   * must come in order, one per tick; anything else is a broken log (false).
   */
  append(events: readonly LogEvent[]): boolean {
    for (const e of events) {
      if (isTickEnd(e)) {
        if (e !== this.spans.length) return false;
        const start = this.spans.length ? this.spans[this.spans.length - 1]!.end + 1 : 0;
        this.spans.push({ start, end: this.log.length });
      } else if (isHash(e)) this.noteHash(this.theirHash, e.h[0], e.h[1]);
      this.log.push(e);
    }
    return true;
  }

  /**
   * Tick `tick`'s orders, every side's, in canonical side order: people's from
   * the log, the commanders' from tickAi (run now: call once per tick, right
   * before the step). Null while the tick isn't sealed.
   */
  commandsFor(tick: number): Command[] | null {
    if (this.stepTick === tick && this.stepping) return this.stepping;
    const span = this.spans[tick];
    if (!span || tick !== this.world.tick) return null;
    const people: Command[] = [];
    for (let i = span.start; i < span.end; i++) {
      const e = this.log[i]!;
      if (isTickEnd(e) || isHash(e)) continue;
      if (isControl(e)) this.control(e.ai, e.on);
      else people.push(e);
    }
    const w = this.world;
    const out: Command[] = [];
    for (const f of sidesOf(w)) {
      const ai = this.ais.get(f);
      if (ai) out.push(...tickAi(w, f, ai));
      else for (const c of people) if (c.faction === f) out.push(c);
    }
    this.stepping = out;
    this.stepTick = tick;
    return out;
  }

  /** After each step: the record's turns and hash trail, and this page's hash against the host's. Returns the hash at a check tick (else null). */
  afterStep(w: World): string | null {
    const cmds = this.stepTick === w.tick - 1 ? this.stepping ?? [] : [];
    this.stepping = null;
    const t = w.tick - 1;
    for (const f of sidesOf(w)) {
      const theirs = cmds.filter((c) => c.faction === f);
      if (theirs.length) this.turns.push([t, f, theirs]);
    }
    if (w.tick % HASH_EVERY !== 0) return null;
    const h = worldHash(w);
    this.hashes.push([w.tick, h]);
    this.noteHash(this.ownHash, w.tick, h);
    return h;
  }

  /** This page's hash trail so far: [tick, hash] every HASH_EVERY ticks (tools read it to compare pages). */
  trail(): readonly [number, string][] {
    return this.hashes;
  }

  /** The battle record (Copy replay JSON): the setup, every side's orders as stepped (commanders' too), the hash trail. */
  record(): BattleRecord {
    const w = this.world;
    const seats = Object.fromEntries(
      this.setup.seats.map((p) => [p.side, { player: p.kind === "ai" ? `ai:${p.strategy}:${p.difficulty}` : `online:${p.name}` } satisfies SeatInfo])
    ) as BattleRecord["seats"];
    const income: Partial<Record<Faction, number>> = {};
    for (const p of this.setup.seats) if (p.kind === "ai" && DIFFICULTY[p.difficulty].incomeMult !== 1) income[p.side] = DIFFICULTY[p.difficulty].incomeMult;
    const end = w.winner
      ? { tick: w.tick, winner: w.winner === "draw" ? null : w.winner, reason: w.resigned ? ("resign" as const) : ("hq" as const) }
      : null;
    return {
      v: 1,
      commit: null,
      sim: typeof __SIM_HASH__ === "undefined" ? null : __SIM_HASH__,
      created: this.created,
      map: this.setup.map,
      mutators: this.setup.mutators.slice(),
      seed: this.setup.seed,
      round: 1,
      maxTicks: w.tick,
      openers: { ...this.setup.openers },
      seats,
      frames: "own",
      turns: this.turns.map(([t, f, c]) => [t, f, c]),
      radio: [],
      hashes: this.hashes.slice(),
      log: [],
      tick: w.tick,
      end,
      usage: {},
      // (the AI seats' income handicap: a replay steps their orders without them, as arena/match.ts records it)
      ...(Object.keys(income).length ? { income } : {})
    };
  }

  // ------------------------------------------------------------- inside ---

  /** A seat changes hands from this tick: a stand-in commander takes over, or gives it back. */
  private control(f: Faction, on: boolean): void {
    if (!on) {
      // (a setup's AI seat is never handed to anyone; the person plays on at their own income, whatever the commander had)
      if (this.setup.seats.find((p) => p.side === f)?.kind === "human" && this.ais.delete(f)) this.world.factions[f].incomeMult = 1;
      return;
    }
    if (this.ais.has(f)) return;
    const s = this.setup.standIn;
    const seat = this.setup.seats.findIndex((p) => p.side === f);
    this.ais.set(f, createAiState(s.strategy, s.difficulty, (s.seed + seat * 7919) | 0));
  }

  private noteHash(into: Map<number, string>, tick: number, h: string): void {
    into.set(tick, h);
    const a = this.ownHash.get(tick);
    const b = this.theirHash.get(tick);
    if (a !== undefined && b !== undefined && a !== b && this.desyncAt === null) this.desyncAt = tick;
  }
}
