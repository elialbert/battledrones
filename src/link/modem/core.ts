/**
 * ModemCore (SOUND-DUEL.md "The modem" > ModemCore API): the whole acoustic
 * modem behind one process(input, output) call per audio block, the same in
 * the AudioWorklet, in the simulated room and in Node tests. It transmits in
 * one band and receives in another (or the same, for the one-phone
 * self-test), all the time.
 *
 * Each call renders exactly its block from the oscillator bank, writes the
 * input into the history ring, lets the trackers fold in what they can
 * within a budget, and runs at most one deferred heavy job (a Viterbi decode
 * first, else one FFT of the sync search). Nothing is allocated in process()
 * after construction; take(), takeSlots(), takeGaps() and stats() build the
 * messages.
 *
 * Allowed globals only (the worklet's rule): no timers, performance, self,
 * import.meta, TextEncoder or crypto anywhere under src/link/modem.
 *
 * The frame. process() takes an optional third argument, the block's first
 * frame (the worklet's currentFrame). Without it blocks are taken as
 * back to back. A frame ahead of the expected one is a jump: the frames in
 * between were never rendered or captured, so the transmitter skips them
 * (and restarts its superframe at the next symbol boundary) and the
 * receiver zero-fills them as a gap of known length.
 *
 * A capture gap alone (blocks of digital silence, or of non-finite samples:
 * the microphone, not the audio thread, failed) leaves the transmitter be.
 * The spec restarts the superframe after any local gap, but here the output
 * was rendered on time all along, so the friend's lock on it is intact, and
 * a restart would only make the friend lose a superframe re-acquiring it.
 *
 * Re-acquiring a friend. When the receiver wins a lock on a friend it had
 * not heard for over REACQUIRE_S (its previous packet delivered that long
 * before the new lock's first), the transmitter starts a new superframe at
 * its next symbol boundary: the friend may have lost this phone too, and
 * its next sync would otherwise be up to a superframe away. The case is a
 * phone whose context was suspended. It starts a new superframe on its
 * skip, and its friend re-acquires it within a second; but its own
 * microphone comes back about 20 ms off the context's clock (Chromium), so
 * its lock on the friend is stale and it waited for the friend's next sync,
 * up to 2.5 s. With the friend's restart it hears it about half a second
 * after the friend re-acquired it (the room with that offset, 24
 * suspensions: 1.68 s after the resume on average and 2.75 s at worst
 * without, 1.12 and 1.80 with). It can't ping-pong: a restart costs a
 * friend that was hearing this phone at most half a second between packets
 * (0.30 to 0.49 s measured), under REACQUIRE_S, so the friend's own
 * re-acquisition doesn't restart it in turn; and a phone restarts at most
 * once per RESTART_GUARD_S, its own restarts on a jump or a counter going
 * back included (a phone that just restarted on its skip is being
 * re-acquired already). The cost: when both lost each other but one kept
 * its lock (a loss shorter than its sync check), that one gets the other's
 * restart for nothing, half a second between packets once.
 *
 * Plan detection. A Join (rx "detect") searches both plans' host bands, and
 * until it locks it transmits in the high plan's guest band (16–19 kHz),
 * whatever plan it was given, when the rate carries it: the low plan's guest
 * band ends 25 Hz below the high host band, and its own loud signal there
 * would bury the host's sync in the very band it is searching. Its
 * capacity() meanwhile is the smaller of the two plans' (186 bits), not the
 * spec's 188: a frame sized to it must still fit if detection picks the low
 * plan.
 *
 * Payloads (SOUND-DUEL.md "Segments and rotation"). setPayloads() hands over
 * a list of frames; each packet takes the next one in key rotation at its
 * first symbol, and its slot event names the key it carried.
 *
 * Where the spec is silent:
 *  - a list holds at most 8 frames (MAX_PAYLOADS; the lockstep's K is at
 *    most 4). A list that breaks a rule (empty, too long, keys not strictly
 *    ascending or not finite, a frame over capacity or with fewer bytes than
 *    its nbits) throws a RangeError and leaves the old list in place;
 *  - a packet sent before any list carries all zeros, and its slot's key is
 *    null; so does a packet whose payload is longer than the band now on air
 *    carries (a list set before a switch to the low plan): it is never cut
 *    to fit, which would deliver, CRC and all, a frame nobody sent;
 *  - the last key sent outlives a new list, a frame counter going back and a
 *    reconfiguration: rotation follows which frame went out last, and none
 *    of these change that.
 */
import type { BandPlan, BandRole, ModemMode, OutFrame } from "../transport";
import { crcKey } from "./crc";
import { clampGain, MIN_RATE, rateProblem, timing, type Timing } from "./params";
import { InputRing } from "./ring";
import { Receiver } from "./rx";
import { SelfMonitor } from "./monitor";
import { SyncSearch, type CorrBand } from "./sync";
import { allBandTables, bandKey } from "./tables";
import { MAX_PAYLOADS, Transmitter } from "./tx";

export type { BandPlan, BandRole, ModemMode, OutFrame } from "../transport";
export { MAX_PAYLOADS } from "./tx";

export interface ModemConfig {
  sampleRate: number;
  plan: BandPlan;
  tx: BandRole;
  /** The band received: the other role's, the same (self-test), or "detect" (Join in the lobby: either plan's host band). */
  rx: BandRole | "detect";
  gain?: number;
}

export interface RxPacket {
  bits: Uint8Array;
  nbits: number;
  mode: ModemMode;
  snrDb: number;
  /** Input frame of the first sample of the packet's first (nominal, N-sample) DFT window. */
  sample: number;
  plan: BandPlan;
  session: boolean;
}

export interface ModemStats {
  sample: number;
  locked: boolean;
  plan: BandPlan;
  rxMode: ModemMode | null;
  txMode: ModemMode;
  snrDb: number | null;
  rxOk: number;
  rxBad: number;
  syncs: number;
  /** The friend's sample clock against this phone's, while locked: positive when it runs fast (ppm). */
  clockPpm: number | null;
  txPackets: number;
  ownSnrDb: number | null;
  loopbackMs: number | null;
  /** Transmitted samples clipped at ±0.9 (a fault). */
  clips: number;
  /** The largest |input| since the last stats(). */
  inputPeak: number;
}

/** A packet start (the worklet's {t:"slot"} message). */
export interface SlotEvent {
  /** The frame its first symbol starts at. */
  sample: number;
  /** A running packet number. */
  index: number;
  /** The key of the payload it carries; null when there was no payload yet (it carries zeros). */
  key: number | null;
}

/** A capture gap: once when it starts (frames 0), once with its length when input resumes. */
export interface GapEvent {
  sample: number;
  frames: number;
}

/** Tone-samples of DFT work per call: the lock's tracker live needs about 15,000 at 48 kHz. */
const BUDGET = 48_000;
const MONITOR_BUDGET = 8_000;
/** A lock won on a friend not heard for longer than this (s) restarts this phone's superframe (see above)... */
const REACQUIRE_S = 1;
/** ...unless it restarted, for that or on a jump, less than this long ago (s). */
const RESTART_GUARD_S = 5;
/** Blocks longer than this are processed in pieces. */
const PIECE = 512;
const NONE: never[] = Object.freeze([]) as unknown as never[];

export class ModemCore {
  private readonly t: Timing;
  private cfg: Required<ModemConfig>;
  private readonly ring = new InputRing();
  private readonly search: SyncSearch;
  private readonly tx: Transmitter;
  private readonly rx: Receiver;
  private readonly mon: SelfMonitor;
  /** Each band's correlator, and the receive band lists, looked up without building keys (no allocation on the audio thread). */
  private readonly corrs: Record<BandPlan, Record<BandRole, CorrBand | null>>;
  private readonly single: Record<BandPlan, Record<BandRole, CorrBand[]>>;
  private readonly detectSet: CorrBand[];
  /** capacity() while a Join detects the plan: the smallest of the plans this rate carries. */
  private readonly detectCapacity: number;
  private pendingRx = false;
  private keys: [number, number] | null = null;
  private started = false;
  private next = 0;
  private inGap = false;
  private gapStart = 0;
  private gapLen = 0;
  private peak = 0;
  /** Frame of this phone's newest superframe restart (a jump, the counter going back, or a re-acquisition), and the frames that must pass before the next re-acquisition restarts it. */
  private lastRestart = -Infinity;
  private readonly restartGuard: number;
  private readonly gapSample = new Float64Array(16);
  private readonly gapFrames = new Float64Array(16);
  private gapCount = 0;

  constructor(cfg: ModemConfig) {
    const problem = rateProblem(cfg.sampleRate, cfg.plan);
    if (problem) throw new RangeError(problem);
    this.cfg = { ...cfg, plan: detectPlan(cfg), gain: clampGain(cfg.gain, 1) };
    this.t = timing(cfg.sampleRate);
    const tables = allBandTables(this.t);
    let cap = Infinity;
    for (const b of tables.values()) cap = Math.min(cap, b.shape.fast.capacity);
    this.detectCapacity = cap;
    this.search = new SyncSearch(this.t, tables);
    this.tx = new Transmitter(this.t, tables, this.cfg.plan, cfg.tx, this.cfg.gain, "robust");
    this.rx = new Receiver(this.t, this.ring, this.search);
    this.rx.reacquireAfter = REACQUIRE_S * cfg.sampleRate;
    this.restartGuard = RESTART_GUARD_S * cfg.sampleRate;
    this.mon = new SelfMonitor(this.t);
    // every receive configuration's band list, made now so a switch never allocates
    const c = (plan: BandPlan, role: BandRole) => this.search.corr.get(bandKey(plan, role)) ?? null;
    this.corrs = { high: { host: c("high", "host"), guest: c("high", "guest") }, low: { host: c("low", "host"), guest: c("low", "guest") } };
    const list = (x: CorrBand | null) => (x ? [x] : []);
    this.single = {
      high: { host: list(this.corrs.high.host), guest: list(this.corrs.high.guest) },
      low: { host: list(this.corrs.low.host), guest: list(this.corrs.low.guest) }
    };
    this.detectSet = [this.corrs.high.host, this.corrs.low.host].filter((x): x is CorrBand => x !== null);
    this.applyRx();
  }

  /** The receive bands and the monitor's band for the current config. */
  private applyRx(): void {
    const { plan, tx, rx } = this.cfg;
    const bands = rx === "detect" ? this.detectSet : this.single[plan][rx];
    const own = this.corrs[plan][tx]!;
    this.rx.configure(bands, rx === "detect", own);
    this.mon.configure(own);
    this.applyKeys();
    this.pendingRx = false;
  }

  private applyKeys(): void {
    if (!this.keys) {
      this.tx.setSessionKey(null);
      this.rx.sessionKey = null;
      return;
    }
    const [h, g] = this.keys;
    const { tx, rx } = this.cfg;
    this.tx.setSessionKey(crcKey(tx, h, g));
    this.rx.sessionKey = crcKey(rx === "detect" ? "host" : rx, h, g);
  }

  process(input: Float32Array, output: Float32Array, frame?: number): void {
    const n = output.length;
    const f0 = frame ?? this.next;
    for (let i = 0; i < n; i += PIECE) this.block(input, output, i, Math.min(PIECE, n - i), f0 + i);
  }

  private block(input: Float32Array, output: Float32Array, off: number, n: number, frame: number): void {
    if (!this.started) {
      this.started = true;
      this.ring.reset(frame);
      this.next = frame;
    }
    if (this.pendingRx) this.applyRx();
    if (frame !== this.next) {
      if (frame > this.next) {
        // a jump: those frames were never rendered nor captured
        const lost = frame - this.next;
        this.endGap();
        this.gapEvent(this.next, 0);
        this.gapEvent(this.next, lost);
        this.ring.skip(lost);
        this.tx.jumped();
        this.lastRestart = frame;
      } else {
        // the counter went back: start over from here
        this.endGap();
        this.ring.reset(frame);
        this.search.restart();
        this.tx.resetTimeline();
        this.mon.reset();
        this.applyRx();
        this.lastRestart = frame;
      }
      this.next = frame;
    }
    // a live microphone hearing its own speaker never gives digital silence: a block of it is missing input,
    // and so is a block holding a NaN or an infinity (which would otherwise spread through every sum it meets)
    let silent = true;
    let finite = true;
    let peak = this.peak;
    for (let i = off; i < off + n; i++) {
      const v = input[i]!;
      if (v !== 0) silent = false;
      if (v - v !== 0) finite = false;
      const a = v < 0 ? -v : v;
      if (a > peak && a < Infinity) peak = a;
    }
    this.peak = peak;
    if (silent || !finite) {
      if (!this.inGap) {
        this.inGap = true;
        this.gapStart = frame;
        this.gapLen = 0;
        this.gapEvent(frame, 0);
      }
      this.gapLen += n;
      this.ring.skip(n);
    } else {
      this.endGap();
      this.ring.write(input, off, off + n);
    }
    this.tx.process(output, off, n, frame);
    this.rx.step(BUDGET);
    this.mon.step(this.tx, this.search, this.ring, MONITOR_BUDGET);
    // one deferred heavy job: a waiting decode first, else the sync search's next FFT
    if (!this.rx.runDecode()) this.search.runJob(this.ring);
    if (this.rx.detected) this.planFound(this.rx.detected);
    if (this.rx.reacquired) {
      // a friend heard again after a long silence may have lost this phone too: a sync for it now (see above)
      this.rx.reacquired = false;
      if (frame - this.lastRestart > this.restartGuard) {
        this.tx.restartSuperframe();
        this.lastRestart = frame;
      }
    }
    this.next = frame + n;
  }

  private endGap(): void {
    if (!this.inGap) return;
    this.inGap = false;
    this.gapEvent(this.gapStart, this.gapLen);
  }

  private gapEvent(sample: number, frames: number): void {
    if (this.gapCount === this.gapSample.length) return;
    this.gapSample[this.gapCount] = sample;
    this.gapFrames[this.gapCount] = frames;
    this.gapCount++;
  }

  /** Join's plan detection locked on `plan`'s host band: transmit in its guest band and keep receiving there. */
  private planFound(plan: BandPlan): void {
    this.rx.detected = null;
    this.rx.detecting = false;
    if (this.cfg.rx !== "detect") return;
    this.cfg.plan = plan;
    this.cfg.rx = "host";
    this.tx.reconfigure(plan, this.cfg.tx, this.cfg.gain);
    // keep the lock that found it: only the monitor and the keys move
    const own = this.corrs[plan][this.cfg.tx]!;
    this.mon.configure(own);
    this.search.setBands(this.single[plan].host, own, this.ring.end);
    this.applyKeys();
  }

  /**
   * The frames packets carry from the next packet start on, one each in key
   * rotation, until replaced: MSB-first, each nbits ≤ capacity(), keys
   * strictly ascending, 1 to MAX_PAYLOADS of them. Copied; a list that breaks
   * a rule throws a RangeError and changes nothing.
   */
  setPayloads(frames: readonly OutFrame[]): void {
    const problem = payloadProblem(frames, this.capacity());
    if (problem) throw new RangeError(problem);
    this.tx.setPayloads(frames);
  }

  /** A list of one frame, key 0: what every packet repeats (the lobby's case, and the tests'). */
  setPayload(bits: Uint8Array, nbits: number): void {
    this.setPayloads([{ bits, nbits, key: 0 }]);
  }

  /** The transmit mode from the next superframe. */
  setTxMode(mode: ModemMode): void {
    this.tx.setMode(mode);
  }

  /** Enable the session CRC for game frames (both directions). */
  setSessionKey(hostNonce: number, guestNonce: number): void {
    this.keys = [hostNonce, guestNonce];
    this.applyKeys();
  }

  /** Change plan, roles or gain. The transmitter switches at its next symbol boundary, the receiver at the next block. */
  reconfigure(cfg: Partial<ModemConfig>): void {
    if (cfg.sampleRate !== undefined && cfg.sampleRate !== this.cfg.sampleRate) throw new RangeError("a ModemCore's sample rate is fixed");
    const plan = cfg.plan ?? this.cfg.plan;
    const problem = rateProblem(this.cfg.sampleRate, plan);
    if (problem) throw new RangeError(problem);
    const next: Required<ModemConfig> = {
      sampleRate: this.cfg.sampleRate,
      plan,
      tx: cfg.tx ?? this.cfg.tx,
      rx: cfg.rx ?? this.cfg.rx,
      gain: clampGain(cfg.gain, this.cfg.gain)
    };
    next.plan = detectPlan(next);
    const rxChanged = next.plan !== this.cfg.plan || next.tx !== this.cfg.tx || next.rx !== this.cfg.rx;
    this.cfg = next;
    this.tx.reconfigure(next.plan, next.tx, next.gain);
    if (rxChanged) this.pendingRx = true;
    this.applyKeys();
  }

  /** Payload bits per packet: constant for a plan; while a Join detects the plan, the smaller plan's, which fits whichever it finds. */
  capacity(): number {
    return this.cfg.rx === "detect" ? this.detectCapacity : this.tx.capacity();
  }

  /** Packets decoded since the last call. */
  take(): RxPacket[] {
    const rx = this.rx;
    if (rx.heldCount === 0) return NONE;
    const out: RxPacket[] = [];
    while (rx.heldCount > 0) {
      const h = rx.held[rx.heldHead]!;
      rx.heldHead = (rx.heldHead + 1) % rx.held.length;
      rx.heldCount--;
      out.push({ bits: h.bits.slice(0, (h.nbits + 7) >> 3), nbits: h.nbits, mode: h.mode, snrDb: h.snrDb, sample: h.sample, plan: h.plan, session: h.session });
    }
    return out;
  }

  /** Packet starts since the last call: the frame each packet's first symbol starts at, a running packet number, and the key it carries. */
  takeSlots(): SlotEvent[] {
    const tx = this.tx;
    if (tx.slotCount === 0) return NONE;
    const out: SlotEvent[] = [];
    for (let i = 0; i < tx.slotCount; i++) {
      const key = tx.slotKey[i]!;
      out.push({ sample: tx.slotFrames[i]!, index: tx.slotIndex[i]!, key: Number.isNaN(key) ? null : key });
    }
    tx.slotCount = 0;
    return out;
  }

  /** Capture gaps since the last call (the worklet's {t:"gap"} messages). */
  takeGaps(): GapEvent[] {
    if (this.gapCount === 0) return NONE;
    const out: GapEvent[] = [];
    for (let i = 0; i < this.gapCount; i++) out.push({ sample: this.gapSample[i]!, frames: this.gapFrames[i]! });
    this.gapCount = 0;
    return out;
  }

  stats(): ModemStats {
    const rx = this.rx;
    const eps = rx.eps;
    const peak = this.peak;
    this.peak = 0;
    return {
      sample: this.next,
      locked: rx.locked,
      plan: this.cfg.plan,
      rxMode: rx.locked ? rx.rxMode : null,
      txMode: this.tx.airMode,
      snrDb: rx.locked ? rx.snrDb : null,
      rxOk: rx.rxOk,
      rxBad: rx.rxBad,
      syncs: rx.syncs,
      // ε̂ is the stretch of the friend's symbols on our clock: a clock fast by x stretches them by 1/(1 + x) − 1
      clockPpm: eps === null ? null : (1 / (1 + eps) - 1) * 1e6,
      txPackets: this.tx.txPackets,
      ownSnrDb: this.mon.ownSnrDb,
      loopbackMs: this.mon.loopbackMs,
      clips: this.tx.clips,
      inputPeak: peak
    };
  }
}

/**
 * What is wrong with a payload list for packets of `capacity` bits, or null:
 * 1 to MAX_PAYLOADS frames, each 0 ≤ nbits ≤ capacity with the bytes to hold
 * them, keys finite and strictly ascending. (WorkletTransport checks a list
 * with it on the main thread, so a bad one throws where it was made.)
 */
export function payloadProblem(frames: readonly OutFrame[], capacity: number): string | null {
  if (frames.length < 1 || frames.length > MAX_PAYLOADS) return `a list of ${frames.length} payloads (1 to ${MAX_PAYLOADS})`;
  for (let i = 0; i < frames.length; i++) {
    const { bits, nbits, key } = frames[i]!;
    if (!Number.isInteger(nbits) || nbits < 0 || nbits > capacity) return `a ${nbits}-bit payload in a ${capacity}-bit packet`;
    if (bits.length * 8 < nbits) return `a ${nbits}-bit payload in ${bits.length} bytes`;
    if (!Number.isFinite(key) || (i > 0 && !(key > frames[i - 1]!.key))) return "payload keys must be finite and strictly ascending";
  }
  return null;
}

/** The plan a ModemCore starts on: a Join detecting the plan starts on the high one wherever the rate carries it (see above). */
export function detectPlan(cfg: ModemConfig): BandPlan {
  return cfg.rx === "detect" && cfg.sampleRate >= MIN_RATE.high ? "high" : cfg.plan;
}
