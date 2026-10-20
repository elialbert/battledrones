/**
 * Symbol tracking (SOUND-DUEL.md "The modem" > Receiver > Window, Clock
 * tracking): one received symbol stream, from a sync on.
 *
 * Window. Each symbol's DFT is a WOLA window: N + β samples starting β/2
 * before the nominal window (which starts TCP − backoff after the symbol's
 * start), tapered over β at both ends (0.5 − 0.5 cos). The phone's own
 * transmission, 15–40 dB louder and changing phase at instants unrelated to
 * the peer's symbols, leaks through a rectangular window at about −40 dB; the
 * taper takes that to about −80 dB while passing the peer's tones exactly.
 *
 * The fold. Folding the tapered ends onto each other and taking the N-point
 * DFT is the same as evaluating the tapered window's transform with every
 * sample at its own position, as long as the tone is on the N-sample grid.
 * Off the grid it is not: at f/(1 + ε̂) the literal fold turns the window
 * back into a rectangle for every tone that is on the grid, which is
 * exactly the phone's own signal, and at ±300 ppm a +40 dB own path then
 * leaks in as loud as the friend. So the window is evaluated with each
 * sample at its true position (one Goertzel recurrence per tone over the
 * N + β samples): the spec's WOLA bit for bit at ε̂ = 0, and the own signal
 * stays 80 dB down at any ε̂. The friend's tones, periodic over its own
 * stretched symbol, stay orthogonal to within ε (−70 dB).
 *
 * Clock. The peer's sample clock differs from ours by up to ±300 ppm, which
 * both drifts the symbol timing and shifts every tone by ε·f. The tracker
 * keeps an estimate ε̂ of the stretch (one peer second lasts 1 + ε of ours):
 * windows advance by TS·sr·(1 + ε̂) in a fractional accumulator, start at the
 * rounded position with the remainder δ applied as a phase, and each tone is
 * evaluated at f/(1 + ε̂) — the frequency the stretch actually puts it at.
 * (The spec writes f·(1 + ε̂); to first order that is the same correction
 * with the opposite sign, which would double the error instead of removing
 * it, so this follows the stretch the advance and the update rule define.)
 * Per symbol, the pilots' differential phases are fitted with a slope
 * through the origin, s = −2π·Δτ, which updates ε̂ ← ε̂ − 0.1·s/(2π·TS) and
 * is removed from every tone's differential product. Each pilot weighs in
 * with its magnitude, as the spec has it, except one that stands far above
 * the pilots beside it (outlier.ts): that is a steady interferer, whose
 * phase says nothing about the clock, and it is weighted down — in the fit,
 * and in the pilot phase errors that make the effective SNR.
 *
 * The tracker reads the input ring at its own pace: live it trails the
 * newest block, and after acquisition it catches up from history within a
 * per-call budget. It stores each data symbol's differential products for
 * the packet decoder, and per symbol the pilots' squared phase errors (the
 * effective SNR).
 *
 * An erased window (one over a gap) costs nothing of the budget, so the
 * windows that start before the oldest sample the ring holds are passed
 * over in one step, timing, superframe count and all, not one per loop:
 * after a frame-counter jump of an hour (a phone suspended that long, its
 * clock catching up on resume) the lock otherwise walked all 72,000 of the
 * symbols it missed in the one process() call, 110–230 ms of audio thread.
 * What is left of a gap is within the ring, at most its 2.7 s (55 symbols).
 */
import { DATA_SYMBOLS, SUPERFRAME_SYMBOLS, TS, type Timing } from "./params";
import { ToneWeights } from "./outlier";
import type { InputRing } from "./ring";
import type { BandTables } from "./tables";
import type { ModemMode } from "../transport";

/** The clock loop's gain per symbol. */
const LOOP_GAIN = 0.1;
/** ε̂ never strays beyond this (a stretch of 0.1% is already far outside any phone). */
export const EPS_LIMIT = 1e-3;
const MAX_TONES = 120;
const MAX_DATA = 105;
/** Pilots either side of a pilot that make its neighbourhood (outlier.ts). */
const PILOT_NEAR = 2;
/**
 * The running mean of each data tone's differential product: its gain per
 * symbol, once it rests on 1/STEADY_GAIN symbols (before, it is their plain
 * mean).
 */
const STEADY_GAIN = 1 / 32;

export class Tracker {
  private readonly t: Timing;
  tb: BandTables | null = null;
  active = false;
  /** Set by the receiver: which acquisition this tracker belongs to. */
  gen = 0;
  /** Compute the pilots only (acquisition's first pass, the self-monitor). */
  pilotsOnly = false;
  /** Let the pilots steer ε̂. */
  adapt = true;
  /** Stop after this many symbols (acquisition's first pass). */
  maxSymbols = Infinity;
  /** Useful start (input frame, fractional) of the symbol in the current window, and the clock estimate. */
  t0 = 0;
  eps = 0;
  /** Superframe index of the current window's symbol (0: the sync). */
  j = 0;
  /** Symbols finalized since begin(). */
  symbols = 0;
  /** The current superframe: a running count, its sync's useful start, its mode (null: not known, decode both). */
  sfSeq = 0;
  syncT0 = 0;
  sfMode: ModemMode | null = null;
  /** The superframe's sync still awaits re-correlation. */
  sfPending = false;
  /** A timing correction (samples) to apply at the next symbol boundary. */
  pendingShift = 0;
  /** After work(): a symbol was finalized, and which. */
  finalized = false;
  lastJ = 0;
  // the window in progress
  private ready = false;
  private w0 = 0;
  private cursor = 0;
  private delta = 0;
  private winErased = false;
  private readonly len: number;
  private readonly wts: Float64Array;
  private readonly chunk: Float64Array;
  // per active tone
  private nt = 0;
  private readonly tones = new Int32Array(MAX_TONES);
  private readonly w = new Float64Array(MAX_TONES);
  /** Goertzel per tone: 2·cos ω and the two states. */
  private readonly coef = new Float64Array(MAX_TONES);
  private readonly s1 = new Float64Array(MAX_TONES);
  private readonly s2 = new Float64Array(MAX_TONES);
  private readonly prevRe = new Float64Array(MAX_TONES);
  private readonly prevIm = new Float64Array(MAX_TONES);
  private readonly xRe = new Float64Array(MAX_TONES);
  private readonly xIm = new Float64Array(MAX_TONES);
  private prevErased = true;
  private readonly pw = new ToneWeights(16, PILOT_NEAR);
  /** Per data symbol (index j − 1) of the superframe, per data tone: the differential product, rotation removed. */
  readonly dRe = new Float64Array(DATA_SYMBOLS * MAX_DATA);
  readonly dIm = new Float64Array(DATA_SYMBOLS * MAX_DATA);
  /** Per superframe symbol: Σ pilot phase error², how many, erased, nominal window start. */
  readonly perr = new Float64Array(SUPERFRAME_SYMBOLS);
  readonly pcnt = new Float64Array(SUPERFRAME_SYMBOLS);
  readonly erased = new Uint8Array(SUPERFRAME_SYMBOLS);
  readonly winAt = new Float64Array(SUPERFRAME_SYMBOLS);
  /**
   * Per data tone, the running mean of its differential product. The
   * scrambled data averages to nothing, so what remains is a steady
   * interferer's share (outlier.ts). And the running mean of the products'
   * squared distance from it, their spread, by which that share is judged:
   * a burst of noise louder than the friend leaves a mean as large as the
   * burst's spread allows, fading only at STEADY_GAIN a symbol, and judged
   * by its size alone every tone read as interfered and every packet failed
   * long after the burst, the lock kept all along: up to 4–5 s after 0.5 to
   * 1.5 s of noise 20 dB over the friend in its band (at 20 cm), and longer
   * than the 10 s watched after 1.5 s of it 38 dB over. The spread fades
   * with the mean, so the share stays judged as noise, and the packets
   * decode again at once (0.2–0.9 s after the burst, a packet or two).
   */
  readonly steadyRe = new Float64Array(MAX_DATA);
  readonly steadyIm = new Float64Array(MAX_DATA);
  readonly steadyVar = new Float64Array(MAX_DATA);
  /**
   * A mean of products that average to nothing still has a size: its
   * expected square is a share of their spread, 1/n while it is the plain
   * mean of n of them, falling to STEADY_GAIN / (2 − STEADY_GAIN) = 1/63 as
   * a running mean. A share counts as an interferer's only once its square
   * stands past four times that (decode.ts), which a share of noise alone
   * does once in e⁴, 2 tones of 105. The plain mean at first lets a
   * trial's first packet, which decides the lock, use the shares of the 16
   * symbols just before its sync (rx.ts), of which the running mean started
   * from zero read only 40%.
   */
  steadyFloor = 4;
  steadyN = 0;
  private steadyNoise = 1;
  /**
   * Acquisition's first pass: the pilot slopes summed over its symbols, and
   * the pilots' weighted squared residuals, for the fit as unwrapped (index
   * 1) and for the fits one turn either side (0: −2π, 2: +2π). Beyond about
   * ±500 ppm between the phones a 19 kHz pilot turns by more than π per
   * symbol and the unwrap lands on the wrong turn; across the band's 3 kHz
   * the wrong turn fits visibly worse, so the receiver keeps the best. The
   * sums only mean that while every symbol is unwrapped on the same turn:
   * near ±600 ppm the pilots' mean turn lies close to π, and each symbol's
   * own mean would fall on either side of it by chance, mixing two turns in
   * the sum (none of the three fits is then the truth: at 50 cm the guest
   * of a pair 600 ppm apart was never acquired in fast mode). So from the
   * second symbol on, the pilots are unwrapped against the mean of the
   * symbols before.
   */
  readonly slopeSum = new Float64Array(3);
  readonly fitErr = new Float64Array(3);
  nslopes = 0;

  constructor(t: Timing) {
    this.t = t;
    this.len = t.N + t.beta;
    this.wts = new Float64Array(this.len);
    for (let i = 0; i < this.len; i++) {
      let w = 1;
      if (i < t.beta) w = 0.5 - 0.5 * Math.cos((Math.PI * (i + 0.5)) / t.beta);
      else if (i >= t.N) w = 0.5 + 0.5 * Math.cos((Math.PI * (i - t.N + 0.5)) / t.beta);
      this.wts[i] = w;
    }
    this.chunk = new Float64Array(this.len);
  }

  /** Start at the symbol whose useful part starts at t0 (input frame): a sync, or symbol j0 of the superframe before one. */
  begin(tb: BandTables, t0: number, eps: number, pilotsOnly: boolean, adapt: boolean, maxSymbols: number, j0 = 0): void {
    this.tb = tb;
    this.active = true;
    this.pilotsOnly = pilotsOnly;
    this.adapt = adapt;
    this.maxSymbols = maxSymbols;
    this.t0 = t0;
    this.eps = eps;
    this.j = j0;
    this.symbols = 0;
    this.sfSeq++;
    this.syncT0 = t0;
    this.sfMode = null;
    this.sfPending = false;
    this.pendingShift = 0;
    this.ready = false;
    this.prevErased = true;
    this.nslopes = 0;
    this.slopeSum.fill(0);
    this.fitErr.fill(0);
    this.finalized = false;
    const b = tb.band;
    this.nt = 0;
    if (pilotsOnly) for (let p = 0; p < b.pilots.length; p++) this.tones[this.nt++] = b.pilots[p]!;
    else for (let k = 0; k < b.k.length; k++) this.tones[this.nt++] = k;
    this.erased.fill(0);
    this.perr.fill(0);
    this.pcnt.fill(0);
    this.steadyRe.fill(0);
    this.steadyIm.fill(0);
    this.steadyVar.fill(0);
    this.steadyN = 0;
    this.steadyNoise = 1;
    this.steadyFloor = 4;
  }

  stop(): void {
    this.active = false;
  }

  /**
   * Fold available input into the current window, finalizing it when it is
   * complete. Stops after one finalized symbol (so the caller can act on it)
   * or when `budget` tone-samples are spent. Returns the tone-samples used.
   */
  work(ring: InputRing, budget: number): number {
    this.finalized = false;
    let used = 0;
    while (this.active) {
      if (!this.ready) this.setup(ring);
      const end = this.w0 + this.len;
      if (this.winErased || this.w0 < ring.oldest()) {
        const behind = this.behind(ring.oldest());
        this.winErased = true;
        this.finalize(ring);
        if (behind > 1 && this.active) this.passOver(behind - 1);
        return used;
      }
      const avail = Math.min(ring.end, end);
      if (avail <= this.cursor) return used;
      const room = Math.floor((budget - used) / this.nt);
      if (room <= 0) return used;
      const upto = Math.min(avail, this.cursor + room);
      this.accumulate(ring, upto);
      used += this.nt * (upto - this.cursor);
      this.cursor = upto;
      if (this.cursor === end) {
        this.finalize(ring);
        return used;
      }
    }
    return used;
  }

  /** How many symbols, from the current window's on, have windows that start before `oldest` (at least 1). */
  private behind(oldest: number): number {
    return Math.max(1, Math.floor((oldest - this.w0 - this.pendingShift) / (this.t.ts * (1 + this.eps))));
  }

  /**
   * Pass over the next n symbols, all erased (their windows start before the
   * oldest sample held), as finalizing them one by one would: each superframe
   * position they take erased, the clock and timing advanced by n symbols,
   * and when they cross a superframe boundary, its sync (the newest crossed)
   * awaits re-correlation.
   */
  private passOver(n: number): void {
    const step = this.t.ts * (1 + this.eps);
    for (let i = Math.max(0, n - SUPERFRAME_SYMBOLS); i < n; i++) {
      const j = (this.j + i) % SUPERFRAME_SYMBOLS;
      this.winAt[j] = this.t0 + i * step - this.t.backoff;
      this.erased[j] = 1;
      this.perr[j] = 0;
      this.pcnt[j] = 0;
    }
    const wraps = Math.floor((this.j + n) / SUPERFRAME_SYMBOLS);
    this.t0 += n * step;
    this.j = (this.j + n) % SUPERFRAME_SYMBOLS;
    this.lastJ = (this.j + SUPERFRAME_SYMBOLS - 1) % SUPERFRAME_SYMBOLS;
    this.symbols += n;
    if (wraps > 0) {
      this.sfSeq += wraps;
      this.syncT0 = this.t0 - this.j * step;
      this.sfMode = null;
      this.sfPending = true;
    }
    if (this.symbols >= this.maxSymbols) this.active = false;
  }

  /** Where the next symbol's window will need input up to (for scheduling). */
  windowEnd(): number {
    return this.w0 + this.len;
  }

  private setup(ring: InputRing): void {
    const t = this.t;
    const nominal = this.t0 - t.backoff;
    const start = nominal - t.beta / 2;
    this.w0 = Math.round(start);
    this.delta = nominal - (this.w0 + t.beta / 2);
    this.cursor = this.w0;
    this.ready = true;
    this.winErased = ring.overlapsGap(this.w0, this.w0 + this.len);
    const hz = this.tb!.band.hz;
    const scale = (2 * Math.PI) / (t.sr * (1 + this.eps));
    for (let i = 0; i < this.nt; i++) {
      const w = hz[this.tones[i]!]! * scale;
      this.w[i] = w;
      this.coef[i] = 2 * Math.cos(w);
      this.s1[i] = 0;
      this.s2[i] = 0;
    }
  }

  /** Window samples [cursor, upto): taper, then each tone's Goertzel recurrence. */
  private accumulate(ring: InputRing, upto: number): void {
    const off = this.cursor - this.w0;
    const n = upto - this.cursor;
    const x = this.chunk;
    ring.copy(this.cursor, upto, x, 0);
    const wts = this.wts;
    for (let i = 0; i < n; i++) x[i] = x[i]! * wts[off + i]!;
    const nt = this.nt;
    const coef = this.coef;
    const S1 = this.s1;
    const S2 = this.s2;
    // four tones at a time: each recurrence is a serial chain, so interleaving them keeps the multiplier busy
    let k = 0;
    for (; k + 3 < nt; k += 4) {
      const c0 = coef[k]!;
      const c1 = coef[k + 1]!;
      const c2 = coef[k + 2]!;
      const c3 = coef[k + 3]!;
      let a1 = S1[k]!;
      let a2 = S2[k]!;
      let b1 = S1[k + 1]!;
      let b2 = S2[k + 1]!;
      let d1 = S1[k + 2]!;
      let d2 = S2[k + 2]!;
      let e1 = S1[k + 3]!;
      let e2 = S2[k + 3]!;
      for (let i = 0; i < n; i++) {
        const v = x[i]!;
        const a0 = v + c0 * a1 - a2;
        a2 = a1;
        a1 = a0;
        const b0 = v + c1 * b1 - b2;
        b2 = b1;
        b1 = b0;
        const d0 = v + c2 * d1 - d2;
        d2 = d1;
        d1 = d0;
        const e0 = v + c3 * e1 - e2;
        e2 = e1;
        e1 = e0;
      }
      S1[k] = a1;
      S2[k] = a2;
      S1[k + 1] = b1;
      S2[k + 1] = b2;
      S1[k + 2] = d1;
      S2[k + 2] = d2;
      S1[k + 3] = e1;
      S2[k + 3] = e2;
    }
    for (; k < nt; k++) {
      const c = coef[k]!;
      let s1 = S1[k]!;
      let s2 = S2[k]!;
      for (let i = 0; i < n; i++) {
        const s0 = x[i]! + c * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      S1[k] = s1;
      S2[k] = s2;
    }
  }

  private finalize(ring: InputRing): void {
    const t = this.t;
    const j = this.j;
    const erased = this.winErased || ring.overlapsGap(this.w0, this.w0 + this.len);
    this.winAt[j] = this.t0 - t.backoff;
    this.erased[j] = erased || (j > 0 && this.prevErased) ? 1 : 0;
    this.perr[j] = 0;
    this.pcnt[j] = 0;
    const nt = this.nt;
    // Goertzel: Σ x[i]·e^{−jωi} = e^{−jω(L−1)}·(s1 − e^{−jω}·s2); then referenced to i = β/2 and turned by e^{+jωδ}
    const xr = this.xRe;
    const xi = this.xIm;
    const turn = t.beta / 2 - (this.len - 1) + this.delta;
    for (let k = 0; k < nt; k++) {
      if (erased) {
        xr[k] = 0;
        xi[k] = 0;
        continue;
      }
      const w = this.w[k]!;
      const s1 = this.s1[k]!;
      const s2 = this.s2[k]!;
      const yr = s1 - Math.cos(w) * s2;
      const yi = Math.sin(w) * s2;
      const c = Math.cos(w * turn);
      const s = Math.sin(w * turn);
      xr[k] = yr * c - yi * s;
      xi[k] = yr * s + yi * c;
    }
    if (j > 0 && !this.erased[j]) this.differential(xr, xi);
    // this symbol becomes the reference for the next
    for (let k = 0; k < nt; k++) {
      this.prevRe[k] = xr[k]!;
      this.prevIm[k] = xi[k]!;
    }
    this.prevErased = erased;
    this.finalized = true;
    this.lastJ = j;
    this.symbols++;
    // advance: the clock estimate's step, plus any timing correction (with the reference re-referenced to it)
    const shift = this.pendingShift;
    this.pendingShift = 0;
    if (shift !== 0) {
      for (let k = 0; k < nt; k++) {
        const th = this.w[k]! * shift;
        const c = Math.cos(th);
        const s = Math.sin(th);
        const r = this.prevRe[k]! * c - this.prevIm[k]! * s;
        this.prevIm[k] = this.prevRe[k]! * s + this.prevIm[k]! * c;
        this.prevRe[k] = r;
      }
    }
    this.t0 += t.ts * (1 + this.eps) + shift;
    this.j = (j + 1) % SUPERFRAME_SYMBOLS;
    if (this.j === 0) {
      this.sfSeq++;
      this.syncT0 = this.t0;
      this.sfMode = null;
      this.sfPending = true;
    }
    this.ready = false;
    if (this.symbols >= this.maxSymbols) this.active = false;
  }

  /** d = X(m)·conj(X(m−1)); fit and remove the pilots' slope; store the data tones; collect pilot errors. */
  private differential(xr: Float64Array, xi: Float64Array): void {
    const tb = this.tb!;
    const b = tb.band;
    const hz = b.hz;
    const nt = this.nt;
    const dr = this.chunk; // reuse as scratch: d for every active tone, re at 2k, im at 2k+1
    for (let k = 0; k < nt; k++) {
      const pr = this.prevRe[k]!;
      const pi = this.prevIm[k]!;
      dr[2 * k] = xr[k]! * pr + xi[k]! * pi;
      dr[2 * k + 1] = xi[k]! * pr - xr[k]! * pi;
    }
    // pilots: their positions among the active tones, magnitudes and weights (an interfered one weighs little)
    const pilots = b.pilots;
    const np = pilots.length;
    const stride = this.pilotsOnly ? 1 : 0;
    const pw = this.pw;
    for (let p = 0; p < np; p++) {
      const k = stride ? p : pilots[p]!;
      const r = dr[2 * k]!;
      const i = dr[2 * k + 1]!;
      pw.mag[p] = Math.sqrt(r * r + i * i);
    }
    pw.update(np);
    const pg = pw.gain;
    let zr = 0;
    let zi = 0;
    let wsum = 0;
    let fsum = 0;
    for (let p = 0; p < np; p++) {
      const k = stride ? p : pilots[p]!;
      const g = pg[p]!;
      const m = pw.mag[p]! * g;
      zr += dr[2 * k]! * g;
      zi += dr[2 * k + 1]! * g;
      wsum += m;
      fsum += m * hz[pilots[p]!]!;
    }
    let s = 0;
    if (wsum > 0) {
      // unwrap each pilot against a slope, then fit through the origin. The slope is the symbol's own mean, except
      // while measuring the clock: there it is the mean of the symbols before, so every symbol lands on the same turn
      // (see slopeSum)
      const s0 = !this.adapt && this.nslopes > 0 ? this.slopeSum[1]! / this.nslopes : Math.atan2(zi, zr) / (fsum / wsum);
      let num = 0;
      let den = 0;
      let sa = 0;
      let saa = 0;
      for (let p = 0; p < np; p++) {
        const k = stride ? p : pilots[p]!;
        const f = hz[pilots[p]!]!;
        const r = dr[2 * k]!;
        const i = dr[2 * k + 1]!;
        const m = pw.mag[p]! * pg[p]!;
        const a = s0 * f + wrap(Math.atan2(i, r) - s0 * f);
        num += m * f * a;
        den += m * f * f;
        sa += m * a;
        saa += m * a * a;
      }
      den = Math.max(den, 1e-300);
      s = num / den;
      if (!this.adapt) {
        // the fits with every pilot a turn lower, as unwrapped, and a turn higher: slope and residual
        this.nslopes++;
        for (let n = 0; n < 3; n++) {
          const y = 2 * Math.PI * (n - 1);
          const a1 = num + y * fsum;
          this.slopeSum[n] = this.slopeSum[n]! + a1 / den;
          this.fitErr[n] = this.fitErr[n]! + (saa + 2 * y * sa + y * y * wsum - (a1 * a1) / den);
        }
      }
    }
    if (this.adapt) {
      this.eps -= (LOOP_GAIN * s) / (2 * Math.PI * TS);
      if (this.eps > EPS_LIMIT) this.eps = EPS_LIMIT;
      else if (this.eps < -EPS_LIMIT) this.eps = -EPS_LIMIT;
    }
    // pilot residuals (an interfered pilot counts as much as its weight: 1, or less)
    let e2 = 0;
    let cnt = 0;
    for (let p = 0; p < np; p++) {
      const k = stride ? p : pilots[p]!;
      const r = dr[2 * k]!;
      const i = dr[2 * k + 1]!;
      const e = wrap(Math.atan2(i, r) - s * hz[pilots[p]!]!);
      e2 += pg[p]! * e * e;
      cnt += pg[p]!;
    }
    this.perr[this.j] = e2;
    this.pcnt[this.j] = cnt;
    if (this.pilotsOnly) return;
    // data tones, rotation removed
    const base = (this.j - 1) * b.T;
    const g = Math.max(STEADY_GAIN, 1 / (this.steadyN + 1));
    this.steadyN++;
    this.steadyNoise = (1 - g) * (1 - g) * this.steadyNoise + g * g;
    this.steadyFloor = 4 * this.steadyNoise;
    for (let d = 0; d < b.T; d++) {
      const k = b.data[d]!;
      const th = -s * hz[k]!;
      const c = Math.cos(th);
      const sn = Math.sin(th);
      const r = dr[2 * k]!;
      const i = dr[2 * k + 1]!;
      const yr = r * c - i * sn;
      const yi = r * sn + i * c;
      this.dRe[base + d] = yr;
      this.dIm[base + d] = yi;
      const er = yr - this.steadyRe[d]!;
      const ei = yi - this.steadyIm[d]!;
      this.steadyRe[d] = this.steadyRe[d]! + g * er;
      this.steadyIm[d] = this.steadyIm[d]! + g * ei;
      this.steadyVar[d] = this.steadyVar[d]! + g * (er * er + ei * ei - this.steadyVar[d]!);
    }
  }

  /** Mean effective SNR (dB) of superframe symbols [j1, j2]: 1 / mean(pilot phase error²). */
  snrDb(j1: number, j2: number): number {
    let e = 0;
    let n = 0;
    for (let j = j1; j <= j2; j++) {
      e += this.perr[j]!;
      n += this.pcnt[j]!;
    }
    if (n === 0) return 0;
    return 10 * Math.log10(n / Math.max(e, 1e-9));
  }

  /** Any of superframe symbols [j1, j2] erased? */
  anyErased(j1: number, j2: number): boolean {
    for (let j = j1; j <= j2; j++) if (this.erased[j]) return true;
    return false;
  }
}

function wrap(a: number): number {
  return a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
}
