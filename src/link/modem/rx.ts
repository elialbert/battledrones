/**
 * The receiver (SOUND-DUEL.md "The modem" > Receiver): acquisition, the
 * locked tracker, packet decoding and the lock's life.
 *
 *  - The sync search runs all the time over the receive band (both plans'
 *    host bands while a Join is detecting the plan). A candidate away from
 *    the current lock's syncs starts a trial: a second tracker that
 *    demodulates the candidate's first packet from the input history. Lock
 *    is declared (or moved) only when that packet passes its CRC and the
 *    gate.
 *  - A trial measures the clock first: the pilots alone over the sync and
 *    four data symbols, whose mean slope initialises ε̂. Then it demodulates
 *    for real from the sync again, with the tones where the clock puts them.
 *    Beyond about 500 ppm between the phones the slope is ambiguous by a
 *    turn of the pilots (tracker.ts). When the stream's previous sync is
 *    still in the correlator's history, one superframe earlier, the timing
 *    difference of the two (the spec's other initialisation) picks the turn;
 *    otherwise the turn whose pilots fit clearly best does.
 *  - Locked, every expected sync is re-correlated within ±5 ms: it sets the
 *    superframe's mode and trims the timing by at most 0.5 ms. If neither
 *    pattern clears 0.3, the timing stays and that superframe's packets are
 *    decoded both ways (the CRC and the gate decide); a lock that has missed
 *    its sync is dropped after 4 more packets fail.
 *  - Packets overlapping a gap are erased: neither decoded nor counted.
 *  - A packet is delivered once. When the friend's timing steps (its output
 *    latency changed) the lock can decode a packet at the old timing while a
 *    trial, started from the sync at the new one, decodes the same packet as
 *    its first: a delivery whose window starts within ¾ of the shortest
 *    packet of one already delivered is that packet again, and is dropped.
 */
import type { BandPlan, ModemMode } from "../transport";
import { DecodeJob, Decoder, softBits, toneScratch } from "./decode";
import { TS, type Timing } from "./params";
import type { InputRing } from "./ring";
import { RHO_DETECT, RHO_KEEP, type Candidate, type CorrBand, type Recorr, type SyncSearch } from "./sync";
import { EPS_LIMIT, Tracker } from "./tracker";

/** A decoded packet, held until ModemCore.take(). */
export interface RxSlot {
  bits: Uint8Array;
  nbits: number;
  mode: ModemMode;
  snrDb: number;
  sample: number;
  plan: BandPlan;
  session: boolean;
}

const JOBS = 24;
const HELD = 32;
/** Recent deliveries remembered for the duplicate check. */
const RECENT = 8;
/** Consecutive failed packets that drop a lock which has missed its sync. */
const DROP_AFTER = 4;
/** Acquisition's first pass: the sync and this many data symbols, pilots only. */
const CLOCK_SYMBOLS = 4;
/** The pilots' fit leaves the turn as unwrapped unless another fits them this much better. */
const TURN_MARGIN = 0.7;

interface Held {
  corr: CorrBand | null;
  t: number;
  mode: ModemMode;
  rho: number;
}

export class Receiver {
  private readonly t: Timing;
  private readonly ring: InputRing;
  private readonly search: SyncSearch;
  private readonly decoder = new Decoder();
  private readonly tones = toneScratch();
  private readonly trackers: [Tracker, Tracker];
  main: Tracker | null = null;
  private mainCorr: CorrBand | null = null;
  private trial: Tracker | null = null;
  /** 1: measuring the clock (pilots), 2: demodulating the first packet. */
  private trialStage = 0;
  private readonly cand: Held = { corr: null, t: 0, mode: "robust", rho: 0 };
  private readonly next: Held = { corr: null, t: 0, mode: "robust", rho: 0 };
  private hasNext = false;
  private mainGen = -1;
  private trialGen = -1;
  private gens = 0;
  /** Searching both plans' host bands (Join): the first lock sets the plan. */
  detecting = false;
  /** The peer's session key, once set. */
  sessionKey: number | null = null;
  // deferred decodes
  private readonly pool: DecodeJob[] = [];
  private readonly queue = new Int32Array(JOBS);
  private qHead = 0;
  private qCount = 0;
  private readonly freeList = new Int32Array(JOBS);
  private nFree = JOBS;
  // decoded packets awaiting take()
  readonly held: RxSlot[] = [];
  heldHead = 0;
  heldCount = 0;
  /** Window starts of the last few packets delivered (input frames; −Infinity: none). */
  private readonly recent = new Float64Array(RECENT);
  private recentHead = 0;
  // the lock's health
  private fails = 0;
  private syncMissed = false;
  private spanSeq = -1;
  private readonly spanOk = new Uint8Array(16);
  private readonly rc: Recorr = { rho: 0, t: 0, mode: null };
  /** The trial's candidate: the clock from its sync and the stream's previous one, when that was heard. */
  private readonly prevSync: Recorr = { rho: 0, t: 0, mode: null };
  private pairEps = 0;
  private hasPair = false;
  private readonly maxShift: number;
  private readonly near: number;
  // stats
  rxOk = 0;
  rxBad = 0;
  syncs = 0;
  /** The effective SNR's running mean over decoded packets (a float field, kept unboxed; see decode.ts). */
  private snr = 0;
  private hasSnr = false;
  rxMode: ModemMode | null = null;
  /** In detect mode: the plan whose host band locked first (ModemCore switches to it). */
  detected: BandPlan | null = null;

  constructor(t: Timing, ring: InputRing, search: SyncSearch) {
    this.t = t;
    this.ring = ring;
    this.search = search;
    this.trackers = [new Tracker(t), new Tracker(t)];
    for (let i = 0; i < JOBS; i++) {
      this.pool.push(new DecodeJob());
      this.freeList[i] = i;
    }
    for (let i = 0; i < HELD; i++) this.held.push({ bits: new Uint8Array(32), nbits: 0, mode: "robust", snrDb: 0, sample: 0, plan: "high", session: false });
    this.maxShift = Math.round(0.0005 * t.sr);
    this.near = Math.round(0.005 * t.sr);
    this.recent.fill(-Infinity);
  }

  get locked(): boolean {
    return this.main !== null;
  }

  get snrDb(): number | null {
    return this.hasSnr ? this.snr : null;
  }

  /** The clock estimate of the lock (the peer's stretch), or null. */
  get eps(): number | null {
    return this.main ? this.main.eps : null;
  }

  /** Listen on these bands from now on (dropping any lock). */
  configure(bands: CorrBand[], detect: boolean, mon: CorrBand | null): void {
    this.main?.stop();
    this.trial?.stop();
    this.main = null;
    this.trial = null;
    this.mainCorr = null;
    this.trialStage = 0;
    this.mainGen = this.trialGen = -1;
    this.hasNext = false;
    this.detecting = detect;
    this.syncMissed = false;
    this.fails = 0;
    this.hasSnr = false;
    this.rxMode = null;
    this.recent.fill(-Infinity);
    this.search.setBands(bands, mon, this.ring.end);
  }

  /** The light work of one process() call: candidates, trackers (within `budget` tone-samples), sync checks. */
  step(budget: number): void {
    for (let c = this.search.candidates.shift(); c; c = this.search.candidates.shift()) this.candidate(c);
    let used = 0;
    const main = this.main;
    if (main) {
      this.resolveSync(main);
      for (;;) {
        used += main.work(this.ring, budget - used);
        if (!main.finalized) break;
        this.symbol(main);
        if (this.main !== main) break;
        if (main.sfPending) this.resolveSync(main);
        if (used >= budget) break;
      }
    }
    // a trial gets what is left, but never nothing
    const trialBudget = Math.max(budget - used, budget / 3);
    let tu = 0;
    for (let tr = this.trial; tr && tr === this.trial && tu < trialBudget; ) {
      tu += tr.work(this.ring, trialBudget - tu);
      if (!tr.finalized) break;
      this.symbol(tr);
    }
  }

  private candidate(c: Candidate): void {
    const main = this.main;
    if (main && c.corr === this.mainCorr) {
      // the lock's own sync: the re-correlation handles it
      const sf = this.t.superframe * (1 + main.eps);
      const k = Math.round((c.t - main.syncT0) / sf);
      if (Math.abs(c.t - (main.syncT0 + k * sf)) <= this.near) return;
    }
    if (this.trial) {
      if (!this.hasNext || c.rho > this.next.rho) {
        this.hold(this.next, c.corr, c.t, c.mode, c.rho);
        this.hasNext = true;
      }
      return;
    }
    this.startTrial(c.corr, c.t, c.mode, c.rho);
  }

  private hold(h: Held, corr: CorrBand, t: number, mode: ModemMode, rho: number): void {
    h.corr = corr;
    h.t = t;
    h.mode = mode;
    h.rho = rho;
  }

  private startTrial(corr: CorrBand, t: number, mode: ModemMode, rho: number): void {
    const tr = this.trackers[0] === this.main ? this.trackers[1] : this.trackers[0];
    this.hold(this.cand, corr, t, mode, rho);
    // the same stream's previous sync, a superframe earlier (its stretch moves it by 2 ms at most)
    const ps = this.prevSync;
    const sf = this.t.superframe;
    this.hasPair = this.search.recorrelate(corr, t - sf, ps) && ps.rho >= RHO_DETECT && Math.abs((t - ps.t) / sf - 1) <= EPS_LIMIT;
    this.pairEps = (t - ps.t) / sf - 1;
    tr.gen = this.trialGen = ++this.gens;
    tr.begin(corr.tables, t, 0, true, false, 1 + CLOCK_SYMBOLS);
    this.trial = tr;
    this.trialStage = 1;
  }

  private abortTrial(): void {
    this.trial?.stop();
    this.trial = null;
    this.trialStage = 0;
    this.trialGen = -1;
    if (this.hasNext) {
      this.hasNext = false;
      const n = this.next;
      // still in the history? (its sync window and a few symbols after it)
      if (n.corr && n.t - this.t.ts > this.ring.oldest()) this.startTrial(n.corr, n.t, n.mode, n.rho);
    }
  }

  /** A tracker finalized a symbol. */
  private symbol(tr: Tracker): void {
    if (tr === this.trial && this.trialStage === 1) {
      if (tr.active) return;
      // the clock from the pilots' mean slope, on the right turn, then demodulate from the sync again
      const k = -1 / (Math.max(tr.nslopes, 1) * 2 * Math.PI * TS);
      let best = 1;
      for (let n = 0; n < 3; n++) {
        if (this.hasPair) {
          if (Math.abs(k * tr.slopeSum[n]! - this.pairEps) < Math.abs(k * tr.slopeSum[best]! - this.pairEps)) best = n;
        } else if (tr.fitErr[n]! < TURN_MARGIN * tr.fitErr[1]! && tr.fitErr[n]! < tr.fitErr[best]!) best = n;
      }
      const eps = k * tr.slopeSum[best]!;
      const c = this.cand;
      tr.gen = this.trialGen = ++this.gens;
      tr.begin(c.corr!.tables, c.t, Math.max(-1e-3, Math.min(1e-3, eps)), false, true, Infinity);
      tr.sfMode = c.mode;
      this.trialStage = 2;
      return;
    }
    const jd = tr.lastJ;
    if (jd === 0) return;
    const tb = tr.tb!;
    const unknown = tr.sfPending || tr.sfMode === null;
    const pr = tb.shape.robust.P;
    for (let m = 0; m < 2; m++) {
      const mode: ModemMode = m === 0 ? "fast" : "robust";
      if (!unknown && mode !== tr.sfMode) continue;
      const P = tb.shape[mode].P;
      if (jd % P !== 0) continue;
      const index = jd / P - 1;
      const first = tr === this.trial && index === 0;
      if (tr.anyErased(index * P + 1, jd)) {
        if (first) this.abortTrial();
        continue;
      }
      const job = this.alloc();
      if (!job) continue;
      softBits(tr, mode, index, job, this.tones);
      job.gen = tr.gen;
      job.sfSeq = tr.sfSeq;
      job.first = first;
      job.unknown = unknown;
      job.span = Math.floor((jd - 1) / pr);
      job.closes = unknown && mode === "robust";
      this.enqueue(job);
    }
  }

  /** The expected sync of the lock's superframe: timing trim and mode, once ρ is known there. */
  private resolveSync(main: Tracker): void {
    if (!main.sfPending || !this.mainCorr) return;
    if (!this.search.recorrelate(this.mainCorr, main.syncT0, this.rc)) return;
    main.sfPending = false;
    if (this.rc.rho >= RHO_KEEP) {
      let d = this.rc.t - main.syncT0;
      if (d > this.maxShift) d = this.maxShift;
      else if (d < -this.maxShift) d = -this.maxShift;
      main.pendingShift += d;
      main.syncT0 += d;
      main.sfMode = this.rc.mode;
      this.syncs++;
      this.syncMissed = false;
    } else {
      main.sfMode = null;
      this.syncMissed = true;
      this.fails = 0;
    }
  }

  private alloc(): DecodeJob | null {
    if (this.nFree === 0) return null;
    return this.pool[this.freeList[--this.nFree]!]!;
  }

  private enqueue(job: DecodeJob): void {
    this.queue[(this.qHead + this.qCount) % JOBS] = this.pool.indexOf(job);
    this.qCount++;
  }

  /** Whether a decode is waiting (the deferred job with priority). */
  get pending(): boolean {
    return this.qCount > 0;
  }

  /** Run one deferred decode. False when none was waiting. */
  runDecode(): boolean {
    if (this.qCount === 0) return false;
    const idx = this.queue[this.qHead]!;
    this.qHead = (this.qHead + 1) % JOBS;
    this.qCount--;
    const job = this.pool[idx]!;
    if (job.gen === this.trialGen && job.first) {
      this.decoder.run(job, this.sessionKey);
      if (job.ok) {
        this.promote();
        if (this.deliver(job)) this.rxOk++;
        this.quality(job);
      } else this.abortTrial();
    } else if (job.gen === this.mainGen && this.main) {
      this.decoder.run(job, this.sessionKey);
      this.result(job, this.main);
    }
    this.freeList[this.nFree++] = idx;
    return true;
  }

  private promote(): void {
    this.main?.stop();
    this.main = this.trial;
    this.mainGen = this.trialGen;
    this.mainCorr = this.cand.corr;
    this.trial = null;
    this.trialStage = 0;
    this.trialGen = -1;
    this.hasNext = false;
    this.fails = 0;
    this.syncMissed = false;
    this.syncs++;
    if (this.detecting && this.mainCorr) this.detected = this.mainCorr.tables.band.plan;
  }

  private result(job: DecodeJob, main: Tracker): void {
    if (this.spanSeq !== job.sfSeq) {
      this.spanSeq = job.sfSeq;
      this.spanOk.fill(0);
    }
    if (job.ok) {
      if (this.deliver(job)) this.rxOk++;
      this.fails = 0;
      this.spanOk[job.span] = 1;
      if (job.unknown && job.sfSeq === main.sfSeq && !main.sfPending && main.sfMode === null) main.sfMode = job.mode;
      this.quality(job);
      return;
    }
    if (!job.unknown) {
      this.rxBad++;
      this.fails++;
      this.quality(job);
    } else if (job.closes && !this.spanOk[job.span]) {
      this.rxBad++;
      this.fails++;
    }
    if (this.syncMissed && this.fails >= DROP_AFTER) {
      main.stop();
      this.main = null;
      this.mainCorr = null;
      this.mainGen = -1;
      this.hasSnr = false;
    }
  }

  private quality(job: DecodeJob): void {
    this.rxMode = job.mode;
    // a non-finite sample that slipped into a window would otherwise stay in the running mean for good
    if (!Number.isFinite(job.snrDb)) return;
    this.snr = this.hasSnr ? this.snr + 0.25 * (job.snrDb - this.snr) : job.snrDb;
    this.hasSnr = true;
  }

  /** Hold a decoded packet for take(), unless it was delivered already (false). */
  private deliver(job: DecodeJob): boolean {
    const near = 0.75 * job.tb!.shape.fast.P * this.t.ts;
    for (let i = 0; i < RECENT; i++) if (Math.abs(job.sample - this.recent[i]!) < near) return false;
    this.recent[this.recentHead] = job.sample;
    this.recentHead = (this.recentHead + 1) % RECENT;
    const cap = job.tb!.shape[job.mode].capacity;
    const slot = this.held[(this.heldHead + this.heldCount) % HELD]!;
    if (this.heldCount < HELD) this.heldCount++;
    else this.heldHead = (this.heldHead + 1) % HELD;
    const d = this.decoder.decoded;
    slot.bits.fill(0);
    for (let i = 0; i < cap; i++) if (d[i]) slot.bits[i >> 3] = slot.bits[i >> 3]! | (0x80 >> (i & 7));
    slot.nbits = cap;
    slot.mode = job.mode;
    slot.snrDb = job.snrDb;
    slot.sample = Math.round(job.sample);
    slot.plan = job.plan;
    slot.session = job.session;
    return true;
  }
}
