/**
 * Lockstep for sound duels (SOUND-DUEL.md "Lockstep"): both phones run the
 * whole sim, and only the players' orders cross the air. A turn is one tick;
 * before stepping tick t a phone seals its own turn t + D, and it steps t only
 * once it holds the peer's turn t. The phone that is ahead stalls, so the two
 * never need a shared clock, and a lost packet can only stall the match,
 * never fork it.
 *
 * Frames are latest-state: each one re-describes every turn the peer hasn't
 * acknowledged, and the transport repeats it until it's replaced, so there's
 * no ARQ. The window rule seals no more into a turn than the frame can still
 * carry, which, with the codec's split rule, means no command can ever be
 * stranded. A hash trail of the world, checked every 50 ticks and at the end,
 * catches two phones drifting apart.
 *
 * Engine-free: no DOM, no timers, no randomness; the clock is injected.
 *
 *   const ls = new Lockstep({ local, delay, mapWidth, mapHeight, capacity, setupHash: parseInt(worldHash(w), 16), now });
 *   each time the game wants to step tick t = w.tick:
 *     const cmds = ls.commandsFor(t, () => ctrl.drainCommands())  // seals turn t + D (once per tick); null: stall
 *     if (cmds) { step(w, cmds); ls.afterStep(t, parseInt(worldHash(w), 16), w.winner ? { winner: w.winner, resigned: w.resigned } : null) }
 *   for each packet:  ls.receive(p.bits, p.nbits, p.at)
 *   then:             const f = ls.frame(); if (f.version !== sent) { transport.send(f.bits, f.nbits); sent = f.version }
 *   ls.setPaused(b), ls.setRxq(rxqOf(snrDb)), ls.leave("left" | "desync"), ls.speed(), ls.status(), ls.turns()
 *
 * Game frame, MSB-first (UE/SE: Exp-Golomb, codec.ts):
 *
 *   type 2 (01)  paused 1  end 2 (0 playing, 1 left, 2 desync, 3 decided)  rxq 3  to 16 (mod 65536)
 *   span UE (to − from)  tickLag SE (to − current tick)  ack SE (ackThrough − to)  nonEmpty UE
 *     per non-empty turn, ascending: gap UE (from the previous + 1, or from `from`), count UE (− 1), commands
 *   hash 1 [hashIdx 4 (checkpoint tick / 50 mod 16), trail 16]
 *   if end = 3: endTick 16, endTrail 16
 *
 * Where the spec is silent:
 *  - once this phone's world is decided at T, its frames describe its turns
 *    past T as empty: no phone ever steps one (a phone in sync is decided at T
 *    too, and one that isn't learns of the decision from the frame that carries
 *    turn T and desyncs after stepping it). So the end report always fits once
 *    the peer holds turn T. Until then a frame that can't carry it as well as
 *    the oldest unacknowledged turn says end = 0 for the moment: the turns
 *    come first, since the peer needs turn T to check the end;
 *  - a frame that doesn't fit otherwise drops its checkpoint first (it
 *    repeats for 50 ticks), then describes fewer turns;
 *  - checkpoints are taken after stepping ticks 0, 50, 100…, so the first one
 *    also covers the setup world;
 *  - `to` is unwrapped against ackThrough, the `to` of the newest frame this
 *    phone took turns from, rather than the newest `to` heard: then only real
 *    progress moves the expectation, and a garbage frame that slipped past the
 *    CRC can't drag it out of reach of the real ones;
 *  - receive also rejects a frame with a turn past `to`, a turn of more than
 *    15 commands, or a `from` below 0: no sender writes one;
 *  - the end check is final once it's "ok", "mismatch" or "unverified" (a
 *    late reply doesn't flip a report already shown), but a desync the peer
 *    reports (end = 2) always ends the match as one, and a decided phone that
 *    learns of a desync any way reports the end check as "mismatch";
 *  - leave("left") after a desync still says desync: it's the truer reason.
 *
 * Deviations from the spec's plain FIFO queue (the window rule lets roughly one
 * full command out per round trip, so a player re-ordering a big army every
 * couple of seconds would otherwise queue orders for tens of seconds):
 *  - a resign goes to the front of the queue: it lands D ticks later, as the
 *    spec says, whatever is waiting;
 *  - a newer move or attackMove replaces queued (not yet sealed) move,
 *    attackMove, attack, harvest and stop orders, a newer attack replaces
 *    queued attacks, and a newer stop queued stops, when it names every unit
 *    of the queued one and nothing queued in between names any of them. The
 *    sim gives each named unit the newer order outright, so the queued one
 *    would only have been overridden on arrival (see enqueue). Of the newer
 *    order's pieces, those whose units have waited longest go first, so that
 *    while orders come faster than the link carries them, no unit waits for
 *    ever behind the rest. It happens on the sender before encoding, so it
 *    can't desync anything. (The one exception to "outright" is the one the
 *    split rule has too: a Goliath whose lift is still hooking follows an
 *    order only when its Condors are named in the same command, lift.ts.)
 */
import { composeTick } from "../game/local-side";
import type { Command, Faction } from "../sim/types";
import {
  BitReader, BitWriter, CodecError, canonicalize, commandBits, decodeCommands, encodeCommand, seBits, ueBits, type MapSize
} from "./codec";

/** Ticks between checkpoints (5 s). */
export const CHECKPOINT_EVERY = 50;
/** Own checkpoints kept to compare with the peer's. */
export const CHECKPOINTS_KEPT = 8;
/** The most header bits a frame describing one turn can take (tickLag and ack within their bounds, D ≤ 8). */
export const HEADER_MAX = 57;
/** Commands in one turn at most (its count is UE(count − 1) ≤ 7 bits). */
export const TURN_COMMANDS_MAX = 15;
/** A frame describes at most this many turns past `from`. */
export const SPAN_MAX = 64;
/** A frame whose `to` is further than this from ackThrough (the peer's last `to` taken) is garbage. */
export const TO_JUMP_MAX = 200;
/** No reply to the end check for this long: "Not verified". */
export const END_CHECK_MS = 10_000;
/** The trail starts here (FNV-1a's offset basis), and folds each tick's world hash in. */
export const TRAIL_START = 0x811c9dc5;

const FIXED_BITS = 2 + 1 + 2 + 3 + 16;
/** The hash flag, plus hashIdx and the trail's low 16 bits when a checkpoint rides along. */
const CHECKPOINT_BITS = 1 + 4 + 16;
const END_REPORT_BITS = 16 + 16;
/** The smallest capacity the window rule always makes progress in: an empty window and the largest single command. */
const CAPACITY_MIN = 176;

export const foldTrail = (trail: number, worldHash32: number): number => Math.imul(trail ^ worldHash32, 0x01000193) >>> 0;

/** Receive quality in 3 bits, for game and lobby frames: clamp(floor(effective SNR dB / 3), 0, 7). */
export const rxqOf = (snrDb: number | null): number =>
  snrDb === null || Number.isNaN(snrDb) ? 0 : Math.max(0, Math.min(7, Math.floor(snrDb / 3)));

export type EndState = "playing" | "left" | "desync" | "decided";
const END_CODES: readonly EndState[] = ["playing", "left", "desync", "decided"];

/** The end check, once this phone's world is decided: "pending" until the peer's end report arrives (or before the end). */
export type EndCheck = "pending" | "ok" | "mismatch" | "unverified";

export interface Decision {
  winner: Faction | "draw";
  resigned?: Faction | null;
}

export interface LockstepOptions {
  /** The side this phone commands. */
  local: Faction;
  /** Input delay D in ticks, 3–8, fixed for the match. */
  delay: number;
  mapWidth: number;
  mapHeight: number;
  /** Payload bits per packet (LinkTransport.capacity()). */
  capacity: number;
  /** parseInt(worldHash(setup world), 16): folded into the trail before tick 0. */
  setupHash: number;
  /** Monotonic milliseconds (the link's clock). */
  now: () => number;
}

export interface LockstepStatus {
  /** The tick this phone steps next. */
  tick: number;
  delay: number;
  /** The last commandsFor() stalled waiting for a peer turn. */
  stalled: boolean;
  /** Time spent stalled so far. */
  stallMs: number;
  /** ackThrough − tick: the peer turns held beyond the one about to be stepped. */
  slack: number;
  /** The peer's slack from its newest frame (ack + tickLag); null before one arrives. */
  peerSlack: number | null;
  paused: boolean;
  peerPaused: boolean;
  /** The newest packet from the peer was a lobby frame: it is still loading. */
  peerInLobby: boolean;
  end: EndState;
  peerEnd: EndState;
  /** Commands drained but not sealed yet (they wait for acks to shrink the window). */
  queued: number;
  /** Ticks the oldest of them (or the order it replaced) has waited: the HUD shows "Orders queued" past 20 (2 s). */
  queuedTicks: number;
  newestSealed: number;
  /** The peer turns this phone holds, contiguous. */
  ackThrough: number;
  /** This phone's turns the peer holds. */
  peerAck: number;
  /** When a new peer turn last arrived (the stall overlays count from it), on the injected clock. */
  lastNewTurnAt: number;
  desync: boolean;
  /** How the desync was found: a checkpoint, the end check, the peer's word (end = 2), or leave("desync"). */
  desyncReason: "checkpoint" | "end" | "peer" | "local" | null;
  endCheck: EndCheck;
  /** This phone's decided world: the tick it was decided on, and how. */
  decided: (Decision & { tick: number }) | null;
  /** The peer's receive quality of this phone (0–7), from its newest frame. */
  peerRxq: number | null;
  framesIn: number;
  /** Game frames rejected (codec errors, bounds). */
  framesBad: number;
  /** Mean ticks from an order being drained (or the queued one it replaced) to the turn it was sealed in; null before any. */
  orderDelay: number | null;
}

/** One game frame as read off the air (ticks unwrapped against what the receiver expects). */
export interface GameFrame {
  paused: boolean;
  end: EndState;
  rxq: number;
  from: number;
  to: number;
  tickLag: number;
  ack: number;
  /** Non-empty turns only, ascending, stamped with the sender's side. */
  turns: [number, Command[]][];
  checkpoint: { idx: number; trail16: number } | null;
  endReport: { tick16: number; trail16: number } | null;
}

/** The value ≡ v (mod 65536) nearest `expect`. */
export const unwrap16 = (v: number, expect: number): number => {
  let d = (v - expect) & 0xffff;
  if (d >= 0x8000) d -= 0x10000;
  return expect + d;
};

/**
 * Read a game frame (type 01). `expectTo` is the `to` the receiver expects
 * (its ackThrough). Throws CodecError on anything malformed: the whole frame
 * is rejected.
 */
export function readGameFrame(bits: Uint8Array, nbits: number, map: MapSize, sender: Faction, expectTo: number): GameFrame {
  const rd = new BitReader(bits, nbits);
  if (rd.bits(2) !== 1) throw new CodecError("not a game frame");
  const paused = rd.bit() === 1;
  const end = END_CODES[rd.bits(2)]!;
  const rxq = rd.bits(3);
  const to = unwrap16(rd.bits(16), expectTo);
  if (Math.abs(to - expectTo) > TO_JUMP_MAX) throw new CodecError(`to ${to} is too far from ${expectTo}`);
  const span = rd.ue();
  if (span > SPAN_MAX) throw new CodecError(`span ${span}`);
  const from = to - span;
  if (from < 0) throw new CodecError(`from ${from}`);
  const tickLag = rd.se();
  const ack = rd.se();
  const nonEmpty = rd.ue();
  if (nonEmpty > span + 1) throw new CodecError(`${nonEmpty} non-empty turns in ${span + 1}`);
  const turns: [number, Command[]][] = [];
  let next = from;
  for (let i = 0; i < nonEmpty; i++) {
    const turn = next + rd.ue();
    if (turn > to) throw new CodecError(`turn ${turn} is past to ${to}`);
    const count = rd.ue() + 1;
    if (count > TURN_COMMANDS_MAX) throw new CodecError(`${count} commands in a turn`);
    turns.push([turn, decodeCommands(rd, count, map, sender)]);
    next = turn + 1;
  }
  const checkpoint = rd.bit() ? { idx: rd.bits(4), trail16: rd.bits(16) } : null;
  const endReport = end === "decided" ? { tick16: rd.bits(16), trail16: rd.bits(16) } : null;
  return { paused, end, rxq, from, to, tickLag, ack, turns, checkpoint, endReport };
}

interface Sealed {
  /** The decoded form: what both phones step. */
  cmds: Command[];
  /** Its encoding, copied into every frame that describes the turn. */
  bits: Uint8Array;
  nbits: number;
}

const other = (f: Faction): Faction => (f === "blue" ? "red" : "blue");

type CommandType = Command["type"];
const MOVE_REPLACES: ReadonlySet<CommandType> = new Set(["move", "attackMove", "attack", "harvest", "stop"]);
/**
 * The queued orders a newer one of each type replaces outright, unit by unit
 * (sim.ts applyCommand). A move or attackMove resets everything those set:
 * the order, the path, the auto-target, a lift's destination, and it packs an
 * anchored Goliath up. An attack sets less than a move (no auto-target reset,
 * nothing for a unit on a lift), so it replaces only attacks, and a stop (no
 * pack-up) only stops. A harvest replaces nothing: the sim skips it off a
 * resource field or for a unit that isn't a harvester.
 */
const REPLACES: Partial<Record<CommandType, ReadonlySet<CommandType>>> = {
  move: MOVE_REPLACES,
  attackMove: MOVE_REPLACES,
  attack: new Set(["attack"]),
  stop: new Set(["stop"])
};

/** Every unit a command names: its unit list, and a Condor boarded or a Goliath lifted. */
function namedUnits(c: Command): number[] {
  const ids = "unitIds" in c ? c.unitIds.slice() : [];
  if (c.type === "board") ids.push(c.carrierId);
  if (c.type === "lift") ids.push(c.goliathId);
  return ids;
}

export class Lockstep {
  readonly local: Faction;
  readonly peer: Faction;
  readonly delay: number;
  readonly capacity: number;
  /** Bits of commands one turn can hold: TURN_MAX = capacity − 57, so a one-turn frame always fits. */
  readonly turnMax: number;
  private readonly map: MapSize;
  private readonly now: () => number;

  private tick = 0;
  private newestSealed: number;
  private ackThrough: number;
  private peerAck: number;
  private trailValue: number;
  /** Own sealed turns (turns 0 … D−1 are empty and never stored). */
  private readonly mine = new Map<number, Sealed>();
  /** Everything below this has been pruned from `mine`. */
  private pruned = 0;
  /** The peer's non-empty turns not yet stepped. */
  private readonly theirs = new Map<number, Command[]>();
  /**
   * Canonical commands waiting to be sealed, with the tick they were drained
   * on. One that took over orders it replaced keeps, per unit, when that unit
   * started waiting (`since`), and `at` is the oldest of those.
   */
  private readonly queue: { command: Command; at: number; since?: ReadonlyMap<number, number> }[] = [];

  private paused = false;
  private rxq = 0;
  private endState: EndState = "playing";
  private decision: (Decision & { tick: number; trail: number }) | null = null;
  private decidedAt = 0;
  private endCheck: EndCheck = "pending";
  private desyncReason: LockstepStatus["desyncReason"] = null;

  /** This phone's newest checkpoints: (tick, trail). */
  private readonly checkpoints: { tick: number; trail: number }[] = [];
  /** Peer checkpoints for ticks not stepped here yet: tick → trail's low 16 bits. */
  private readonly peerPending = new Map<number, number>();
  /** Every checkpoint both ways, for "Copy debug info". */
  private readonly ownTrail: [number, number][] = [];
  private readonly peerTrail: [number, number][] = [];

  private peerFrame: { paused: boolean; rxq: number; slack: number } | null = null;
  private peerEnd: EndState = "playing";
  private peerEndReport: { tick: number; trail16: number } | null = null;
  private peerInLobby = false;

  private stalled = false;
  private stallStart = 0;
  private stallMs = 0;
  private lastNewTurnAt: number;
  private framesIn = 0;
  private framesBad = 0;
  private delaySum = 0;
  private delayCount = 0;
  private readonly stepped: [number, Faction, Command[]][] = [];

  private dirty = true;
  private version = 0;
  private current: { bits: Uint8Array; nbits: number; version: number } = { bits: new Uint8Array(0), nbits: 0, version: 0 };

  constructor(o: LockstepOptions) {
    if (!Number.isInteger(o.delay) || o.delay < 3 || o.delay > 8) throw new RangeError(`input delay ${o.delay}: 3–8 ticks`);
    if (o.capacity < CAPACITY_MIN) throw new RangeError(`capacity ${o.capacity}: at least ${CAPACITY_MIN} bits`);
    this.local = o.local;
    this.peer = other(o.local);
    this.delay = o.delay;
    this.capacity = o.capacity;
    this.turnMax = o.capacity - HEADER_MAX;
    this.map = { width: o.mapWidth, height: o.mapHeight };
    this.now = o.now;
    // both phones hold turns 0 … D−1 (empty) from the start
    this.newestSealed = this.ackThrough = this.peerAck = o.delay - 1;
    this.trailValue = foldTrail(TRAIL_START, o.setupHash >>> 0);
    this.lastNewTurnAt = o.now();
  }

  // ------------------------------------------------------------ stepping ---

  /**
   * The commands to step tick `tick` with (blue's, then red's, whichever side
   * is local), or null to stall. The first call for a tick seals turn
   * tick + D from `drain()`; later calls for the same tick (a stall) drain
   * nothing. Paused, or once the match has ended, nothing is sealed and it
   * returns null.
   */
  commandsFor(tick: number, drain: () => readonly Command[]): Command[] | null {
    if (tick !== this.tick) throw new Error(`lockstep is at tick ${this.tick}, not ${tick}`);
    if (this.over() || this.paused) {
      this.endStall();
      return null;
    }
    if (this.newestSealed < tick + this.delay) this.seal(tick + this.delay, drain());
    if (this.ackThrough < tick) {
      if (!this.stalled) {
        this.stalled = true;
        this.stallStart = this.now();
      }
      return null;
    }
    this.endStall();
    // blue's, then red's: the sim applies them in array order, and ids come from one shared counter
    return composeTick(this.local, this.mine.get(tick)?.cmds ?? [], this.theirs.get(tick) ?? []);
  }

  /** After stepping `tick` with commandsFor's commands: fold the world hash into the trail; `decided` if the world now has a winner. */
  afterStep(tick: number, worldHash32: number, decided: Decision | null): void {
    if (tick !== this.tick) throw new Error(`lockstep is at tick ${this.tick}, not ${tick}`);
    this.trailValue = foldTrail(this.trailValue, worldHash32 >>> 0);
    const mine = this.mine.get(tick)?.cmds ?? [];
    const theirs = this.theirs.get(tick) ?? [];
    for (const [side, cmds] of this.local === "blue" ? ([["blue", mine], ["red", theirs]] as const) : ([["blue", theirs], ["red", mine]] as const))
      if (cmds.length) this.stepped.push([tick, side, cmds]);
    this.theirs.delete(tick);
    this.tick = tick + 1;
    if (tick % CHECKPOINT_EVERY === 0) {
      this.checkpoints.push({ tick, trail: this.trailValue });
      if (this.checkpoints.length > CHECKPOINTS_KEPT) this.checkpoints.shift();
      this.ownTrail.push([tick, this.trailValue]);
      const theirsAt = this.peerPending.get(tick);
      for (const t of [...this.peerPending.keys()]) if (t <= tick) this.peerPending.delete(t);
      if (theirsAt !== undefined) this.compare(this.trailValue, theirsAt);
      this.dirty = true;
    }
    if (decided && this.endState === "playing") {
      this.decision = { winner: decided.winner, resigned: decided.resigned ?? null, tick, trail: this.trailValue };
      this.decidedAt = this.now();
      this.endState = "decided";
      this.endStall();
      this.dirty = true;
    }
    this.prune();
    this.checkEnd();
  }

  /** Seal turn T: canonicalize what was drained onto the queue, then move commands from its front while the window rule allows. */
  private seal(T: number, drained: readonly Command[]): void {
    const ctx = { local: this.local, width: this.map.width, height: this.map.height };
    for (const c of drained) this.enqueue(canonicalize(c, ctx));
    // the frame describing peerAck + 1 … T as it stands: header (with the checkpoint reserve) and the sealed turns before T
    const from = this.peerAck + 1;
    let nonEmpty = 0;
    let body = 0;
    let last = from - 1;
    for (let u = from; u < T; u++) {
      const s = this.mine.get(u);
      if (!s?.cmds.length) continue;
      nonEmpty++;
      body += ueBits(u - last - 1) + ueBits(s.cmds.length - 1) + s.nbits;
      last = u;
    }
    const head = FIXED_BITS + ueBits(T - from) + seBits(T - this.tick) + seBits(this.ackThrough - T) + CHECKPOINT_BITS;
    const wr = new BitWriter();
    let prev: readonly number[] | null = null;
    let count = 0;
    while (this.queue.length && count < TURN_COMMANDS_MAX && T - from <= SPAN_MAX) {
      const q = this.queue[0]!;
      const turnBits = wr.nbits + commandBits(q.command, this.map, prev);
      if (turnBits > this.turnMax) break;
      if (head + ueBits(nonEmpty + 1) + body + ueBits(T - last - 1) + ueBits(count) + turnBits > this.capacity) break;
      prev = encodeCommand(wr, q.command, this.map, prev);
      this.delaySum += T - q.at;
      this.delayCount++;
      this.queue.shift();
      count++;
    }
    const bits = wr.bytes();
    // the decoded form, as the peer will read it: both phones step exactly this
    const cmds = count ? decodeCommands(new BitReader(bits, wr.nbits), count, this.map, this.local) : [];
    this.mine.set(T, { cmds, bits, nbits: wr.nbits });
    this.newestSealed = T;
    this.dirty = true;
  }

  /**
   * Queue the canonical pieces of one drained command. A resign goes to the
   * front. A command that replaces others (REPLACES) first drops each queued
   * order it makes pointless: one of a type it replaces, all of whose units it
   * names, with nothing queued between them naming any of those units (that
   * order would still have to run first). Walking back from the newest, every
   * unit a kept command names is blocked, so for each unit only the run of
   * orders right before this one goes, and its own history is unchanged but
   * for orders that would have been overridden. Each piece keeps when each of
   * its units started waiting (the drain tick of the oldest order it lost),
   * and the pieces whose units have waited longest go first, so queuedTicks
   * still says how long a unit has waited for an order.
   */
  private enqueue(pieces: readonly Command[]): void {
    const head = pieces[0];
    if (!head) return;
    const at = this.tick;
    if (head.type === "resign") {
      // (the world is decided on the tick it lands: whatever waits behind it no longer matters)
      this.queue.unshift({ command: head, at });
      return;
    }
    const replaces = REPLACES[head.type];
    if (!replaces) {
      for (const k of pieces) this.queue.push({ command: k, at });
      return;
    }
    const named = new Set(pieces.flatMap(namedUnits));
    const blocked = new Set<number>();
    /** Units whose replaced order hadn't gone out, and since when they've waited for one. */
    const waiting = new Map<number, number>();
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const q = this.queue[i]!;
      const ids = namedUnits(q.command);
      if (!ids.some((id) => named.has(id))) continue;
      if (replaces.has(q.command.type) && ids.every((id) => named.has(id) && !blocked.has(id))) {
        this.queue.splice(i, 1);
        for (const id of ids) waiting.set(id, Math.min(waiting.get(id) ?? at, q.since?.get(id) ?? q.at));
      } else for (const id of ids) blocked.add(id);
    }
    // the units that have waited longest go first: in id order the last pieces would lose every time to the
    // first ones whenever orders come faster than the window lets one whole order out
    const queued = pieces.map((command) => {
      const since = new Map<number, number>();
      for (const id of namedUnits(command)) {
        const t = waiting.get(id);
        if (t !== undefined) since.set(id, t);
      }
      return { command, at: Math.min(at, ...since.values()), since: since.size ? since : undefined };
    });
    queued.sort((p, q) => p.at - q.at); // (stable: equal waits keep their order)
    this.queue.push(...queued);
  }

  private prune(): void {
    // frames start at min(peerAck + 1, newestSealed), and the next step needs `tick`
    const keep = Math.min(this.peerAck + 1, this.tick);
    while (this.pruned < keep) this.mine.delete(this.pruned++);
  }

  // -------------------------------------------------------------- frames ---

  /** The newest frame. `version` changes on every rebuild: hand it to transport.send() then. */
  frame(): { bits: Uint8Array; nbits: number; version: number } {
    if (this.dirty) {
      this.dirty = false;
      const f = this.build();
      this.current = { ...f, version: ++this.version };
    }
    return this.current;
  }

  /**
   * Own turn u as frames describe it, if it has commands. Past this phone's
   * decision every turn is described as empty: no phone steps one, and the
   * end report then always fits.
   */
  private described(u: number): Sealed | undefined {
    const s = this.mine.get(u);
    return s?.cmds.length && !(this.decision && u > this.decision.tick) ? s : undefined;
  }

  private frameBits(from: number, to: number, checkpoint: boolean, end: EndState): number {
    let n = 0;
    let body = 0;
    let last = from - 1;
    for (let u = from; u <= to; u++) {
      const s = this.described(u);
      if (!s) continue;
      n++;
      body += ueBits(u - last - 1) + ueBits(s.cmds.length - 1) + s.nbits;
      last = u;
    }
    return (
      FIXED_BITS + ueBits(to - from) + seBits(to - this.tick) + seBits(this.ackThrough - to) + ueBits(n) + body +
      (checkpoint ? CHECKPOINT_BITS : 1) + (end === "decided" ? END_REPORT_BITS : 0)
    );
  }

  private build(): { bits: Uint8Array; nbits: number } {
    const from = Math.min(this.peerAck + 1, this.newestSealed);
    const cp = this.checkpoints[this.checkpoints.length - 1] ?? null;
    const fit = (end: EndState): { to: number; checkpoint: boolean } | null => {
      let to = Math.min(this.newestSealed, from + SPAN_MAX);
      let checkpoint = cp !== null;
      // the window rule makes the whole frame fit when a turn is sealed; a header that grew since loses the
      // checkpoint first (it repeats for 50 ticks), then the newest turns (they go out once acks arrive)
      while (this.frameBits(from, to, checkpoint, end) > this.capacity) {
        if (checkpoint) checkpoint = false;
        else if (to > from) to--;
        else return null;
      }
      return { to, checkpoint };
    };
    let end = this.endState;
    let f = fit(end);
    // (only while the peer still lacks a turn up to the decision that leaves no room for the 32-bit end
    // report: once it holds them all, the frame describes only empty turns and the report fits)
    if (!f && end === "decided") f = fit((end = "playing"));
    if (!f) throw new Error("lockstep: a one-turn frame doesn't fit"); // (TURN_MAX rules it out)
    const { to, checkpoint } = f;
    const wr = new BitWriter();
    wr.bits(0b01, 2);
    wr.bit(this.paused ? 1 : 0);
    wr.bits(END_CODES.indexOf(end), 2);
    wr.bits(this.rxq, 3);
    wr.bits(to & 0xffff, 16);
    wr.ue(to - from);
    wr.se(to - this.tick);
    wr.se(this.ackThrough - to);
    const turns: [number, Sealed][] = [];
    for (let u = from; u <= to; u++) {
      const s = this.described(u);
      if (s) turns.push([u, s]);
    }
    wr.ue(turns.length);
    let last = from - 1;
    for (const [u, s] of turns) {
      wr.ue(u - last - 1);
      wr.ue(s.cmds.length - 1);
      wr.append(s.bits, s.nbits);
      last = u;
    }
    if (checkpoint && cp) {
      wr.bit(1);
      wr.bits((cp.tick / CHECKPOINT_EVERY) & 15, 4);
      wr.bits(cp.trail & 0xffff, 16);
    } else wr.bit(0);
    if (end === "decided") {
      wr.bits(this.decision!.tick & 0xffff, 16);
      wr.bits(this.decision!.trail & 0xffff, 16);
    }
    return { bits: wr.bytes(), nbits: wr.nbits };
  }

  // ------------------------------------------------------------- receive ---

  /**
   * A packet from the peer: "game" if it was a game frame this phone took,
   * "lobby" for a lobby frame (the peer is still loading), "invalid" otherwise
   * (malformed frames are counted in framesBad; all-zero packets are nothing).
   */
  receive(bits: Uint8Array, nbits: number, at: number): "game" | "lobby" | "invalid" {
    const type = nbits >= 2 && bits.length ? bits[0]! >> 6 : 0;
    if (type === 2) {
      this.peerInLobby = true;
      return "lobby";
    }
    if (type !== 1) return "invalid";
    let f: GameFrame;
    try {
      // (expected near ackThrough: only turns taken move it, so neither a stale frame nor a garbage one can)
      f = readGameFrame(bits, nbits, this.map, this.peer, this.ackThrough);
    } catch (e) {
      if (!(e instanceof CodecError)) throw e;
      this.framesBad++;
      return "invalid";
    }
    this.framesIn++;
    this.peerInLobby = false;
    this.peerFrame = { paused: f.paused, rxq: f.rxq, slack: f.ack + f.tickLag };
    // (the peer can't hold a turn this phone hasn't sealed: a bad value never skips one)
    const holds = Math.min(f.ack + f.to, this.newestSealed);
    if (holds > this.peerAck) {
      this.peerAck = holds;
      this.dirty = true;
    }
    if (f.from <= this.ackThrough + 1 && f.to > this.ackThrough) {
      for (const [turn, cmds] of f.turns) if (turn > this.ackThrough) this.theirs.set(turn, cmds);
      this.ackThrough = f.to;
      this.lastNewTurnAt = at;
      this.dirty = true;
    }
    if (f.checkpoint) this.peerCheckpoint(f.checkpoint.idx, f.checkpoint.trail16);
    if (f.end === "left" || f.end === "desync") {
      if (this.peerEnd !== "left" && this.peerEnd !== "desync") this.peerEnd = f.end;
      if (f.end === "desync") this.desynced("peer");
      this.endStall();
    } else if (f.end === "decided") {
      if (this.peerEnd === "playing") this.peerEnd = "decided";
      if (!this.peerEndReport && f.endReport)
        this.peerEndReport = { tick: unwrap16(f.endReport.tick16, this.tick), trail16: f.endReport.trail16 };
      this.checkEnd();
    }
    return "game";
  }

  private peerCheckpoint(idx: number, trail16: number): void {
    // the checkpoint nearest this phone's own tick / 50 with that index
    const base = this.tick / CHECKPOINT_EVERY;
    const at = (idx + 16 * Math.round((base - idx) / 16)) * CHECKPOINT_EVERY;
    if (at < 0) return;
    const lastHeard = this.peerTrail[this.peerTrail.length - 1];
    if (!lastHeard || lastHeard[0] !== at) this.peerTrail.push([at, trail16]);
    if (at < this.tick) {
      const own = this.checkpoints.find((c) => c.tick === at);
      if (own) this.compare(own.trail, trail16);
    } else this.peerPending.set(at, trail16);
  }

  private compare(trail: number, trail16: number): void {
    if ((trail & 0xffff) !== trail16) this.desynced("checkpoint");
  }

  /** Compare the peer's end report with this phone's end, once both are in (or once this phone has stepped past it). */
  private checkEnd(): void {
    this.expire();
    const r = this.peerEndReport;
    if (!r || this.endCheck !== "pending" || this.endState === "left" || this.endState === "desync") return;
    if (this.decision) {
      const ok = r.tick === this.decision.tick && (this.decision.trail & 0xffff) === r.trail16;
      this.endCheck = ok ? "ok" : "mismatch";
      if (!ok) this.desynced("end");
    } else if (r.tick < this.tick) {
      // the peer was decided at a tick this phone stepped without a decision
      this.endCheck = "mismatch";
      this.desynced("end");
    }
  }

  private expire(): void {
    if (this.decision && this.endCheck === "pending" && this.now() - this.decidedAt >= END_CHECK_MS) this.endCheck = "unverified";
  }

  private desynced(reason: NonNullable<LockstepStatus["desyncReason"]>): void {
    if (this.endState === "left" || this.endState === "desync") return;
    this.endState = "desync";
    this.desyncReason = reason;
    // (a decided phone's report says so, rather than "Checking sync…" and then "Not verified")
    if (this.decision && this.endCheck === "pending") this.endCheck = "mismatch";
    this.endStall();
    this.dirty = true;
  }

  // ------------------------------------------------------------- control ---

  /** Pause is local: frames say so, nothing new is sealed, and the peer stalls within D ticks. */
  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    this.endStall();
    this.dirty = true;
  }

  /** This phone's receive quality of the peer (rxqOf(snrDb)); it rides along from the next rebuilt frame. */
  setRxq(rxq: number): void {
    this.rxq = Math.max(0, Math.min(7, Math.floor(rxq) || 0));
  }

  /** Leave ("left") or abort ("desync"): frames say so from now on (the session keeps sending them for 2 s). */
  leave(reason: "left" | "desync"): void {
    if (reason === "desync") return this.desynced("local");
    if (this.endState === "left" || this.endState === "desync") return;
    this.endState = "left";
    this.endStall();
    this.dirty = true;
  }

  /** Game speed: the slack trim, clamp(1 + 0.02 × (slack − peerSlack), 0.9, 1.1). The two phones' speeds sum to 2. */
  speed(): number {
    if (!this.peerFrame) return 1;
    return Math.max(0.9, Math.min(1.1, 1 + 0.02 * (this.ackThrough - this.tick - this.peerFrame.slack)));
  }

  /** The match is over here: this phone's world is decided, it left or desynced, or the peer left or desynced. */
  over(): boolean {
    return this.endState !== "playing" || this.peerEnd === "left" || this.peerEnd === "desync";
  }

  private endStall(): void {
    if (!this.stalled) return;
    this.stallMs += this.now() - this.stallStart;
    this.stalled = false;
  }

  // -------------------------------------------------------------- status ---

  status(): LockstepStatus {
    this.expire();
    // (the oldest drain tick: pieces that took over replaced orders keep theirs, so it isn't always the front's)
    const oldest = this.queue.reduce((t, q) => Math.min(t, q.at), this.tick);
    return {
      tick: this.tick,
      delay: this.delay,
      stalled: this.stalled,
      stallMs: this.stallMs + (this.stalled ? this.now() - this.stallStart : 0),
      slack: this.ackThrough - this.tick,
      peerSlack: this.peerFrame?.slack ?? null,
      paused: this.paused,
      peerPaused: this.peerFrame?.paused ?? false,
      peerInLobby: this.peerInLobby,
      end: this.endState,
      peerEnd: this.peerEnd,
      queued: this.queue.length,
      queuedTicks: this.tick - oldest,
      newestSealed: this.newestSealed,
      ackThrough: this.ackThrough,
      peerAck: this.peerAck,
      lastNewTurnAt: this.lastNewTurnAt,
      desync: this.endState === "desync",
      desyncReason: this.desyncReason,
      endCheck: this.endCheck,
      decided: this.decision && { winner: this.decision.winner, resigned: this.decision.resigned, tick: this.decision.tick },
      peerRxq: this.peerFrame?.rxq ?? null,
      framesIn: this.framesIn,
      framesBad: this.framesBad,
      orderDelay: this.delayCount ? this.delaySum / this.delayCount : null
    };
  }

  /** The trail after the last tick stepped. */
  trail(): number {
    return this.trailValue;
  }

  /** The turns as stepped, for Save battle: [tick, side, decoded commands], non-empty only, blue's before red's on a tick. */
  turns(): [number, Faction, Command[]][] {
    return this.stepped.slice();
  }

  /** For "Copy debug info": both trails' checkpoints (the peer's are its trails' low 16 bits) and the end. */
  debug(): { delay: number; tick: number; own: [number, number][]; peer: [number, number][]; end: { tick: number; trail: number } | null; peerEnd: { tick: number; trail16: number } | null } {
    return {
      delay: this.delay,
      tick: this.tick,
      own: this.ownTrail.slice(),
      peer: this.peerTrail.slice(),
      end: this.decision && { tick: this.decision.tick, trail: this.decision.trail },
      peerEnd: this.peerEndReport
    };
  }
}
