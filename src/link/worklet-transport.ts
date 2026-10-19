/**
 * WorkletTransport (SOUND-DUEL.md "Link layer", "Worklet"): the real
 * LinkTransport, the main thread's side of the modem running in an
 * AudioWorklet (worklet.ts). It turns LinkTransport calls into messages to
 * the processor and the processor's messages into packets, slots, stats and
 * gaps on this link's clock.
 *
 * Use: `await loadWorklet(ctx)` once per context, then
 * `new WorkletTransport(ctx, cfg)`, which creates the node (2 input channels,
 * "explicit", "discrete"; one output channel) and connects its output to the
 * speakers; the rig connects the microphone to `node`.
 *
 * Clock. now() is performance.now() − t0: monotonic, and it runs on while
 * the context is suspended or rebuilt (the context's own clock stops with
 * it). Every message from the worklet carries `sample`, a frame in the
 * context's currentFrame domain, and is stamped on arrival as
 * `now() − max(0, (ctx.currentTime × sr − sample) / sr × 1000)`: when that
 * frame was on this clock, as nearly as the main thread can tell. A packet's
 * `at` is its last sample (transport.ts): the frame of its first DFT window,
 * as the worklet reports it, plus the back-off, P − 1 whole symbols and a
 * useful part for its plan and mode. A slot is its first symbol, a gap its
 * start.
 *
 * Skips. A context that stops rendering for a while (suspended, interrupted,
 * an audio thread that stalls) carries its currentFrame on from where it
 * stopped, so the modem can't tell anything happened while the friend's
 * stream moved on. Its transmitter would carry on with its superframe, and
 * the friend, whose lock on it is now out of date, would wait up to a
 * superframe (2 s) for its next sync; its receiver would keep a stale lock
 * until the friend's next sync. So at every message from the worklet the
 * transport reads how far the context's clock lies behind its own,
 * now() − currentTime × 1000. That only grows when the context stops while
 * time goes on (a busy main thread reads currentTime as fresh as ever, so a
 * late message doesn't fake it). Once the readings have stood more than
 * SKIP_MIN_MS above their lowest for SKIP_CONFIRM_MS, and stopped moving,
 * the step is a stretch the modem neither heard nor played, and the
 * transport posts it as {t:"skip", frames}. Stopped moving: the lowest
 * reading of the first half of the last SKIP_CONFIRM_MS and the lowest of
 * the second agree within SETTLE_MS, and the skip is the lower of the two.
 * Readings run late, never early, so the lowest of a few is the truest; but
 * one taken while the stall was still going on (a message read late, while
 * currentTime stood still) is early for the step it ends at: taken as the
 * step, it left a 200 ms stop of Chromium's audio service skipped 33–97 ms
 * short in 4 stops of 8, the rest too small to skip ever after, and the
 * modem's frame counter off by it. And a render thread that catches up
 * renders what it owes late, faster than real time, so the readings fall
 * back: frames it did render are not a skip. Both show as a floor still
 * moving, rising or falling, so neither goes over until it stands. (A
 * context that stands for SKIP_CONFIRM_MS before it catches up, or one
 * catching up at under SETTLE_MS a half, can't be told from one that lost
 * the time; nor can a reading late in both halves alike.)
 * The modem takes a skip as a jump of its frame counter: it
 * starts a new superframe, so the friend hears this phone again about half
 * a second after the skip whatever the phase, and its receiver takes the
 * stretch as a gap of known length, keeping its lock, which is right if the
 * input moved on by exactly the skip. In the room model it does, and this
 * phone hears the friend again as soon. In Chromium it doesn't quite: a
 * MediaStream input comes back on a 10 ms grid about 20 ms off what the
 * context's clock says, past the receiver's tolerance (3 ms short to 9 ms
 * long), so this phone's receiver usually re-acquires on the friend's next
 * sync as it would without the skip (tools/worklet-smoke.mjs measures both).
 * The gap comes out of takeGaps() like any other.
 *
 * Where the spec is silent:
 *  - the constructor throws a RangeError for a config whose sampleRate is not
 *    the context's, or whose plan the rate can't carry (the worklet would
 *    only post the same error later); reconfigure() throws for the same;
 *  - capacity() is the smaller of the plan last configured here and the plan
 *    the worklet last reported, and while a Join detects the plan (rx
 *    "detect", until a report shows it locked) the smaller plan's, as
 *    ModemCore's is: a frame sized to it fits whichever plan the modem is on
 *    while the news crosses;
 *  - send() checks the list as ModemCore does and throws where it was made;
 *  - gaps are pulled with takeGaps() as {at, ms}: at is when the gap began
 *    on this link's clock, ms 0 when it starts (still open) and its length
 *    when capture resumes;
 *  - a step of the context's clock under SKIP_MIN_MS is left alone (below
 *    it the readings' own jitter, up to an audio callback's length on a
 *    phone, could fake one; a stall that short costs the lock at worst, and
 *    the modem re-acquires as before);
 *  - a stats report older than STALE_MS (four reporting periods: the
 *    context isn't rendering) or from a modem that stopped no longer speaks
 *    for the modem: stats() then reads unlocked, with no SNR or receive
 *    mode (the counters and the plan stay), and modemStats() returns null;
 *  - an error the worklet marks fatal (the modem stopped) or the processor
 *    failing makes the report stale at once;
 *  - poll(), slots() and takeGaps() keep at most 256 entries each when
 *    nobody pulls them (the oldest go);
 *  - after close(), send() and the setters do nothing, and poll(), slots()
 *    and takeGaps() return nothing;
 *  - a transport that replaces another (a rebuilt context) takes the old
 *    one's t0 (options.t0), so now() runs on across it.
 */
import { detectPlan, payloadProblem, type ModemConfig, type ModemStats } from "./modem/core";
import { PACKET_SYMBOLS, rateProblem, timing, type Timing } from "./modem/params";
import { PAYLOAD_BITS, type BandPlan, type LinkPacket, type LinkStats, type LinkTransport, type ModemMode, type OutFrame } from "./transport";
import workletUrl from "./worklet.ts?worker&url";
import { MODEM_PROCESSOR, type FromWorklet, type ToWorklet } from "./worklet-protocol";

const loaded = new WeakMap<BaseAudioContext, Promise<void>>();

/**
 * Add the modem's worklet module to a context, once per context: every call
 * for the same context shares one addModule. A failure (a stale build whose
 * asset is gone) rejects, and the next call tries again.
 */
export function loadWorklet(ctx: BaseAudioContext): Promise<void> {
  let p = loaded.get(ctx);
  if (!p) {
    const q = ctx.audioWorklet.addModule(workletUrl);
    loaded.set(ctx, q);
    q.catch(() => {
      if (loaded.get(ctx) === q) loaded.delete(ctx);
    });
    p = q;
  }
  return p;
}

export interface WorkletTransportOptions {
  /** The clock now() reads (ms, monotonic). Default performance.now(). */
  clock?: () => number;
  /** now()'s zero on that clock. Default: the clock's reading when the transport is made. */
  t0?: number;
  /** Makes the node (tests pass a fake). Default: new AudioWorkletNode(ctx, name, options). */
  createNode?: (ctx: BaseAudioContext, name: string, options: AudioWorkletNodeOptions) => AudioWorkletNode;
}

/** Entries a queue keeps when nobody pulls it. */
const KEEP = 256;
/** How far (ms) the context's clock must fall behind this link's, and stay, to count as a stretch it did not render. */
const SKIP_MIN_MS = 100;
/** How long (ms of this link's clock) it must stay there first, with a reading in each half of the last this-many ms. */
const SKIP_CONFIRM_MS = 200;
/**
 * The lowest readings of the two halves agree within this (ms) once the step
 * stands. Above a reading's own spread (a few ms on a desktop, where the
 * lowest of a half is rarely late by more), below a render thread catching
 * up at 1.15× real time.
 */
const SETTLE_MS = 15;
/** Readings past the step kept (a ring): a few seconds of messages, many more than SKIP_CONFIRM_MS needs. */
const STEP_READINGS = 64;
/**
 * Added to every skip (ms). A receiver window that lands early sits in the
 * cyclic prefix, one that lands late takes in the next symbol: in the room
 * a skip from 3 ms short to 9 ms long costs nothing, 8 ms short or 15 ms long
 * a packet, 60 ms either way the lock. So aim at the middle.
 */
const SKIP_LEAD_MS = 3;
/**
 * The baseline is the lowest of this many ordinary readings (about two
 * seconds of messages): enough for one to come soon after an audio callback,
 * few enough that the baseline follows drift between the audio and system
 * clocks, or a step too small to skip, within seconds. Counted in readings,
 * not time, so a suspension (when none arrive) doesn't age it out.
 */
const LAG_READINGS = 20;
/** A stats report this old (ms) no longer speaks for the modem: four reporting periods with none. */
const STALE_MS = 1000;
/** capacity() while a Join detects the plan: what either plan carries. */
const DETECT_BITS = Math.min(PAYLOAD_BITS.high, PAYLOAD_BITS.low);

function push<T>(q: T[], v: T): void {
  if (q.length >= KEEP) q.shift();
  q.push(v);
}

export class WorkletTransport implements LinkTransport {
  /** The modem's node: the rig connects the microphone to it. Its output already goes to ctx.destination. */
  readonly node: AudioWorkletNode;
  /** now()'s zero on the clock. */
  readonly t0: number;
  /** The worklet's errors: a sample rate the modem can't use, a message it refused, a fault in process(), the processor failing. */
  onError: ((message: string) => void) | null = null;
  private readonly ctx: BaseAudioContext;
  private readonly sr: number;
  private readonly t: Timing;
  private readonly clock: () => number;
  private readonly port: MessagePort;
  /** The config as last set from here, and the plan the modem starts on with it (Join's detection starts on high where the rate allows). */
  private readonly cfg: ModemConfig;
  private plan: BandPlan;
  /** A Join detecting the plan, as far as this side knows: rx "detect" configured, and no report since has shown a lock. */
  private searching: boolean;
  /** A lock reported from before a reconfigure to "detect" reached the worklet: not the detection's, so wait for a report without one first. */
  private oldLock = false;
  private report: ModemStats | null = null;
  /** When the newest report arrived, on this link's clock. */
  private reportAt = -Infinity;
  /** The modem stopped (a fatal error, the processor failing): nothing it reported holds any more. */
  private dead = false;
  /** The last LAG_READINGS ordinary readings of now() − currentTime × 1000 (a ring), whose lowest is the baseline. */
  private readonly lags = new Float64Array(LAG_READINGS);
  private lagCount = 0;
  private lagNext = 0;
  /** Readings in a row more than SKIP_MIN_MS above the baseline: the newest STEP_READINGS (a ring: when, and how far behind), how many, and when the first came. */
  private readonly stepAt = new Float64Array(STEP_READINGS);
  private readonly stepD = new Float64Array(STEP_READINGS);
  private stepN = 0;
  private stepNext = 0;
  private stepSince = 0;
  private readonly inbox: LinkPacket[] = [];
  private readonly starts: number[] = [];
  private readonly gaps: { at: number; ms: number }[] = [];
  private lastRxAt: number | null = null;
  private closed = false;

  /** Call after loadWorklet(ctx) has resolved. */
  constructor(ctx: BaseAudioContext, cfg: ModemConfig, opts: WorkletTransportOptions = {}) {
    if (cfg.sampleRate !== ctx.sampleRate) throw new RangeError(`a modem config for ${cfg.sampleRate} Hz on a ${ctx.sampleRate} Hz context`);
    const problem = rateProblem(ctx.sampleRate, cfg.plan);
    if (problem) throw new RangeError(problem);
    this.ctx = ctx;
    this.sr = ctx.sampleRate;
    this.t = timing(ctx.sampleRate);
    this.clock = opts.clock ?? (() => performance.now());
    this.t0 = opts.t0 ?? this.clock();
    this.cfg = { ...cfg };
    this.plan = detectPlan(cfg);
    this.searching = cfg.rx === "detect";
    const make = opts.createNode ?? ((c, name, o) => new AudioWorkletNode(c, name, o));
    this.node = make(ctx, MODEM_PROCESSOR, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 2,
      channelCountMode: "explicit",
      channelInterpretation: "discrete",
      processorOptions: { ...cfg }
    });
    this.port = this.node.port;
    this.port.onmessage = (e: MessageEvent<FromWorklet>) => this.receive(e.data);
    this.node.onprocessorerror = () => {
      this.dead = true;
      this.onError?.("the sound link's audio processor failed");
    };
    this.node.connect(ctx.destination);
  }

  capacity(): number {
    if (this.searching) return DETECT_BITS;
    const reported = this.report?.plan ?? this.plan;
    return Math.min(PAYLOAD_BITS[this.plan], PAYLOAD_BITS[reported]);
  }

  /** The frames packets carry, one each in key rotation, until replaced. Copies them; throws a RangeError for a list that breaks a rule. */
  send(frames: readonly OutFrame[]): void {
    if (this.closed) return;
    const problem = payloadProblem(frames, this.capacity());
    if (problem) throw new RangeError(problem);
    const copies = frames.map((f) => ({ bits: f.bits.slice(0, (f.nbits + 7) >> 3), nbits: f.nbits, key: f.key }));
    this.post(
      { t: "payload", frames: copies },
      copies.map((f) => f.bits.buffer)
    );
  }

  poll(): LinkPacket[] {
    return this.inbox.splice(0);
  }

  slots(): number[] {
    return this.starts.splice(0);
  }

  now(): number {
    return this.clock() - this.t0;
  }

  setMode(mode: ModemMode): void {
    this.post({ t: "mode", mode });
  }

  setSessionKey(hostNonce: number, guestNonce: number): void {
    this.post({ t: "session", hostNonce, guestNonce });
  }

  /** From the newest stats report; once that is stale (see above), unlocked with no SNR or receive mode, the counters kept. */
  stats(): LinkStats {
    const s = this.report;
    const live = this.live();
    return {
      locked: live?.locked ?? false,
      snrDb: live?.snrDb ?? null,
      rxOk: s?.rxOk ?? 0,
      rxBad: s?.rxBad ?? 0,
      // (the modem starts robust)
      txMode: s?.txMode ?? "robust",
      rxMode: live?.rxMode ?? null,
      sinceRx: this.lastRxAt === null ? Infinity : Math.max(0, this.now() - this.lastRxAt),
      ownSnrDb: live?.ownSnrDb ?? null,
      loopbackMs: s?.loopbackMs ?? null,
      plan: s?.plan ?? this.plan
    };
  }

  close(): void {
    if (this.closed) return;
    this.post({ t: "close" });
    this.closed = true;
    this.port.onmessage = null;
    this.node.onprocessorerror = null;
    this.node.disconnect();
    this.inbox.length = 0;
    this.starts.length = 0;
    this.gaps.length = 0;
  }

  /** Change plan, roles or gain (ModemCore.reconfigure: the transmitter at its next symbol, the receiver at its next block). */
  reconfigure(cfg: Partial<ModemConfig>): void {
    if (cfg.sampleRate !== undefined && cfg.sampleRate !== this.sr) throw new RangeError("a modem's sample rate is its context's");
    if (cfg.plan) {
      const problem = rateProblem(this.sr, cfg.plan);
      if (problem) throw new RangeError(problem);
    }
    if (this.closed) return;
    const c = this.cfg;
    c.plan = cfg.plan ?? c.plan;
    c.tx = cfg.tx ?? c.tx;
    c.rx = cfg.rx ?? c.rx;
    this.plan = detectPlan(c);
    const searching = c.rx === "detect";
    if (searching && !this.searching) this.oldLock = this.report?.locked ?? false;
    this.searching = searching;
    this.post({ t: "config", plan: cfg.plan, tx: cfg.tx, rx: cfg.rx, gain: cfg.gain });
  }

  /** The transmit level (the modem clamps it to 0 … 1.5 and keeps the last good one for NaN; the lobby offers up to 1.1). */
  setGain(gain: number): void {
    this.post({ t: "config", gain });
  }

  /** The worklet's newest stats report (about four a second): null before the first, and while it is stale (see above). */
  modemStats(): ModemStats | null {
    return this.live();
  }

  /**
   * The plan a Join's detection found, once a report of its own showed the
   * lock (ModemCore then receives that plan's host band and sends in its
   * guest band); null while it searches, and for a config that doesn't
   * detect. The rig rebuilds a context's transport on it, not on "detect"
   * again: frames sized to the plan found must fit the new one at once.
   */
  detectedPlan(): BandPlan | null {
    return this.cfg.rx === "detect" && !this.searching ? (this.report?.plan ?? null) : null;
  }

  /** Capture gaps since the last call: `at` when each began on this link's clock, `ms` 0 when it starts and its length when capture resumes. */
  takeGaps(): { at: number; ms: number }[] {
    return this.gaps.splice(0);
  }

  private post(msg: ToWorklet, transfer: Transferable[] = []): void {
    if (this.closed) return;
    this.port.postMessage(msg, transfer);
  }

  /** The newest report, while it still speaks for the modem. */
  private live(): ModemStats | null {
    return this.report && !this.dead && this.now() - this.reportAt < STALE_MS ? this.report : null;
  }

  /** When frame `sample` was, on this link's clock. */
  private stamp(sample: number): number {
    return this.now() - Math.max(0, ((this.ctx.currentTime * this.sr - sample) / this.sr) * 1000);
  }

  /** A reading of how far the context's clock lies behind this link's, at a message from the worklet: posts a skip for a step that stays (see above). */
  private watchClock(): void {
    // (messages still arriving while the context is suspended say nothing about when it runs again)
    if (this.ctx.state !== "running") return;
    const now = this.now();
    const d = now - this.ctx.currentTime * 1000;
    let lag = Infinity;
    for (let i = 0; i < this.lagCount; i++) lag = Math.min(lag, this.lags[i]!);
    if (this.lagCount === 0 || d < lag + SKIP_MIN_MS) {
      this.keepLag(d);
      this.stepN = this.stepNext = 0;
      return;
    }
    // a step: its readings start here (a second step on top of it only keeps the floor moving a while longer)
    if (this.stepN === 0) this.stepSince = now;
    this.stepAt[this.stepNext] = now;
    this.stepD[this.stepNext] = d;
    this.stepNext = (this.stepNext + 1) % STEP_READINGS;
    this.stepN = Math.min(this.stepN + 1, STEP_READINGS);
    if (now - this.stepSince < SKIP_CONFIRM_MS) return;
    // the lowest reading of each half of the last SKIP_CONFIRM_MS: the step stands once they agree (a half without a
    // reading reads Infinity, which agrees with nothing)
    let older = Infinity;
    let newer = Infinity;
    for (let i = 0; i < this.stepN; i++) {
      const age = now - this.stepAt[i]!;
      if (age > SKIP_CONFIRM_MS) continue;
      if (age >= SKIP_CONFIRM_MS / 2) older = Math.min(older, this.stepD[i]!);
      else newer = Math.min(newer, this.stepD[i]!);
    }
    if (!(Math.abs(older - newer) <= SETTLE_MS)) return;
    // the lowest reading of the settled step against the lowest before it (readings run late, never early, and the
    // few since the step sit no nearer the truth than the many before it, so this errs long, if anything), and the lead
    const step = Math.min(older, newer);
    this.post({ t: "skip", frames: Math.round(((step - lag + SKIP_LEAD_MS) * this.sr) / 1000) });
    // the clocks stand apart by the step from now on
    this.lagCount = this.lagNext = 0;
    this.keepLag(step);
    this.stepN = this.stepNext = 0;
  }

  private keepLag(d: number): void {
    this.lags[this.lagNext] = d;
    this.lagNext = (this.lagNext + 1) % LAG_READINGS;
    this.lagCount = Math.min(this.lagCount + 1, LAG_READINGS);
  }

  private receive(msg: FromWorklet): void {
    if (this.closed) return;
    this.watchClock();
    switch (msg.t) {
      case "rx": {
        // (the packet's last sample: its first DFT window, the back-off, P − 1 whole symbols and a useful part)
        const t = this.t;
        const at = this.stamp(msg.sample + t.backoff + (PACKET_SYMBOLS[msg.plan][msg.mode] - 1) * t.ts + t.N);
        push(this.inbox, { bits: msg.bits, nbits: msg.nbits, snrDb: msg.snrDb, at, session: msg.session });
        this.lastRxAt = at;
        break;
      }
      case "slot":
        push(this.starts, this.stamp(msg.sample));
        break;
      case "stats":
        this.report = {
          sample: msg.sample,
          locked: msg.locked,
          plan: msg.plan,
          rxMode: msg.rxMode,
          txMode: msg.txMode,
          snrDb: msg.snrDb,
          rxOk: msg.rxOk,
          rxBad: msg.rxBad,
          syncs: msg.syncs,
          clockPpm: msg.clockPpm,
          txPackets: msg.txPackets,
          ownSnrDb: msg.ownSnrDb,
          loopbackMs: msg.loopbackMs,
          clips: msg.clips,
          inputPeak: msg.inputPeak
        };
        this.reportAt = this.now();
        if (this.searching) {
          // the detection is done once a report of its own shows a lock (ModemCore leaves "detect" as it locks)
          if (!msg.locked) this.oldLock = false;
          else if (!this.oldLock) this.searching = false;
        }
        break;
      case "gap":
        push(this.gaps, { at: this.stamp(msg.sample), ms: (msg.frames / this.sr) * 1000 });
        break;
      case "error":
        if (msg.fatal) this.dead = true;
        this.onError?.(msg.message);
        break;
    }
  }
}
