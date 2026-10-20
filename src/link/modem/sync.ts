/**
 * Acquisition (SOUND-DUEL.md "The modem" > Receiver): a normalized
 * correlation of the band-passed input with the sync symbol's data tones,
 * ρ(t) = |⟨x_bp, template⟩| / (‖x_bp‖·‖template‖) over the 40 ms useful
 * length, for pattern A (robust) and B (fast), computed by FFT overlap-save
 * spread across the audio blocks.
 *
 * Three details the spec's formula leaves open:
 *
 *  - The inner product is the analytic one (its magnitude, the correlation's
 *    envelope). The real correlation of a 3 kHz band oscillates at the band's
 *    centre frequency, so at 17 kHz a peak falling between two samples could
 *    read as little as 0.4 of itself; the envelope is smooth, polarity-blind
 *    and reads the same whatever the phase.
 *  - The band-pass is folded into the overlap-save kernels: x_bp = h ∗ x for
 *    the norm, (template ∗ h) for the inner product. Both outputs are
 *    band-limited, so each inverse FFT takes only the band's bins and runs a
 *    quarter of the size, giving ρ at every 4th sample (the envelope is far
 *    smoother than that).
 *  - A real FFT is done as a half-size complex one.
 *
 * The candidate must be the maximum within ±45 ms, where the spec says
 * ±50: under a symbol. A sender whose frame counter jumps just after a sync
 * starts a new superframe at the next symbol boundary, so its new sync can
 * come exactly one symbol after the old one, which (as strong or stronger)
 * hid it at ±50 ms; the trial on the old sync then failed (its packet was
 * cut by the jump) and the receiver waited a superframe for the next. The
 * echoes the window is there for, 8–15 ms on and the room's tail below
 * them, stay well inside ±45 ms.
 *
 * And one addition: before the band-pass, any FFT bin whose power stands
 * EXCISE times over the median of the band's bins is zeroed. A steady tone
 * in the band (coil whine, a beacon, a harmonic of game audio) otherwise
 * fills ‖x_bp‖: one 9 dB louder than the friend's whole band divides ρ by
 * three and hides every sync. The friend's own spectrum never stands that
 * far over its median, so without such a tone nothing changes.
 *
 * The forward FFT, then three small inverse FFTs per band (x_bp, A, B) are
 * separate jobs, at most one per process() call. Above 96 kHz each FFT is
 * itself split into parts, a few passes each, so no one job grows with the
 * rate faster than the audio block shrinks.
 */
import { bandpassFir, FFT, selectInPlace } from "./dsp";
import type { Timing } from "./params";
import type { BandTables } from "./tables";
import type { ModemMode } from "../transport";

/** ρ is computed at every DECIM-th input sample. */
export const DECIM = 4;
/** Decimated ρ history per band and pattern (with DECIM 4, 131,072 input samples). */
const RHO_SIZE = 1 << 15;
const RHO_MASK = RHO_SIZE - 1;
/** Detection thresholds. */
export const RHO_DETECT = 0.4;
export const RHO_MARGIN = 0.15;
export const RHO_KEEP = 0.3;
/** A correlator FFT bin this many times the band's median power is a narrowband interferer, and is zeroed. */
const EXCISE = 30;

export interface Candidate {
  corr: CorrBand;
  /** First-path estimate of the sync's useful start (input frame, fractional). */
  t: number;
  mode: ModemMode;
  rho: number;
}

/** One band's correlator: kernels and its ρ history. */
export class CorrBand {
  readonly tables: BandTables;
  /** First FFT bin of the band's window of Md bins. */
  readonly kLo: number;
  /** The band's own bins within the window: [inLo, inHi). */
  readonly inLo: number;
  readonly inHi: number;
  /** 2·conj(spectrum) over the window: the band-pass (for x_bp), and template ∗ band-pass for A and B. */
  readonly hRe: Float64Array;
  readonly hIm: Float64Array;
  readonly aRe: Float64Array;
  readonly aIm: Float64Array;
  readonly bRe: Float64Array;
  readonly bIm: Float64Array;
  readonly tNorm: number;
  readonly rhoA = new Float32Array(RHO_SIZE);
  readonly rhoB = new Float32Array(RHO_SIZE);
  /** ρ is known for decimated indices [from, done). */
  from = 0;
  done = 0;
  // the candidate detector
  private best = -1;
  private bestR = 0;

  constructor(t: Timing, tables: BandTables, M: number, Md: number, h: Float64Array) {
    this.tables = tables;
    const b = tables.band;
    const binHz = t.sr / M;
    const margin = 1300;
    this.kLo = Math.floor((b.loHz - margin) / binHz);
    if (Math.ceil((b.hiHz + margin) / binHz) - this.kLo >= Md) throw new Error("band too wide for the correlator window");
    this.inLo = Math.ceil(b.loHz / binHz) - this.kLo;
    this.inHi = Math.floor(b.hiHz / binHz) + 1 - this.kLo;
    const fft = new FFT(M);
    const spec = (x: Float64Array): [Float64Array, Float64Array] => {
      const re = new Float64Array(M);
      const im = new Float64Array(M);
      re.set(x.subarray(0, Math.min(M, x.length)));
      fft.run(re, im, false);
      const wr = new Float64Array(Md);
      const wi = new Float64Array(Md);
      for (let i = 0; i < Md; i++) {
        wr[i] = 2 * re[this.kLo + i]!;
        wi[i] = -2 * im[this.kLo + i]!;
      }
      return [wr, wi];
    };
    [this.hRe, this.hIm] = spec(h);
    const tmpl = (mode: ModemMode): Float64Array => {
      const ph = tables.sync[mode];
      const out = new Float64Array(t.N);
      for (let d = 0; d < b.T; d++) {
        const w = (2 * Math.PI * b.hz[b.data[d]!]!) / t.sr;
        // cos(w·n + φ) by rotation, re-anchored every 256 samples
        for (let n0 = 0; n0 < t.N; n0 += 256) {
          let cr = Math.cos(w * n0 + ph[d]!);
          let ci = Math.sin(w * n0 + ph[d]!);
          const rr = Math.cos(w);
          const ri = Math.sin(w);
          for (let n = n0; n < Math.min(t.N, n0 + 256); n++) {
            out[n] = out[n]! + cr;
            const nr = cr * rr - ci * ri;
            ci = cr * ri + ci * rr;
            cr = nr;
          }
        }
      }
      return out;
    };
    const ta = tmpl("robust");
    const tb = tmpl("fast");
    let e = 0;
    for (let n = 0; n < t.N; n++) e += ta[n]! * ta[n]!;
    this.tNorm = Math.sqrt(e);
    const conv = (x: Float64Array): Float64Array => {
      const y = new Float64Array(x.length + h.length - 1);
      for (let i = 0; i < x.length; i++) for (let j = 0; j < h.length; j++) y[i + j] = y[i + j]! + x[i]! * h[j]!;
      return y;
    };
    [this.aRe, this.aIm] = spec(conv(ta));
    [this.bRe, this.bIm] = spec(conv(tb));
  }

  /** Forget everything (the band was just switched on). Its history starts at decimated index n. */
  reset(n: number): void {
    this.from = this.done = n;
    this.best = -1;
    this.bestR = 0;
  }

  /** ρ of one pattern at decimated index n (0 outside what is known; kept a float, see decode.ts). */
  rho(mode: ModemMode, n: number): number {
    const v = (mode === "robust" ? this.rhoA : this.rhoB)[n & RHO_MASK]!;
    return n >= this.from && n < this.done ? v : v * 0;
  }

  /** The stronger pattern's ρ at n. */
  peak(n: number): number {
    const v = Math.max(this.rhoA[n & RHO_MASK]!, this.rhoB[n & RHO_MASK]!);
    return n >= this.from && n < this.done ? v : v * 0;
  }

  /** Feed the detector the new values [n0, n1); push candidates. */
  detect(n0: number, n1: number, W: number, F: number, out: CandidateQueue): void {
    for (let n = n0; n < n1; n++) {
      const r = this.peak(n);
      if (r >= RHO_DETECT && (this.best < 0 || r > this.bestR)) {
        this.best = n;
        this.bestR = r;
      }
      if (this.best >= 0 && n - this.best >= W) {
        this.finalize(this.best, W, F, out);
        this.best = -1;
        this.bestR = 0;
      }
    }
  }

  private finalize(c: number, W: number, F: number, out: CandidateQueue): void {
    const r = this.peak(c);
    for (let i = c - W; i <= c + W; i++) if (this.peak(i) > r) return;
    const a = this.rho("robust", c);
    const b = this.rho("fast", c);
    if (Math.abs(a - b) < RHO_MARGIN) return;
    const mode: ModemMode = a > b ? "robust" : "fast";
    out.push(this, this.firstPath(c, mode, F), mode, r);
  }

  /**
   * The first path: the earliest sample within F (15 ms) before the maximum
   * at c whose ρ reaches half the maximum's (the crossing interpolated between
   * the decimated samples). Returns an input frame.
   */
  firstPath(c: number, mode: ModemMode, F: number): number {
    const thr = 0.5 * this.rho(mode, c);
    for (let i = Math.max(this.from, c - F); i <= c; i++) {
      const v = this.rho(mode, i);
      if (v < thr) continue;
      const u = i > this.from && i > c - F ? this.rho(mode, i - 1) : v;
      const frac = u < thr ? (thr - u) / Math.max(v - u, 1e-12) : 1;
      return DECIM * (i - 1 + Math.min(1, frac));
    }
    return DECIM * c;
  }
}

/** A small ring of candidates found by the detectors. */
export class CandidateQueue {
  private readonly items: Candidate[] = [];
  private head = 0;
  private count = 0;

  constructor(size: number) {
    for (let i = 0; i < size; i++) this.items.push({ corr: null as unknown as CorrBand, t: 0, mode: "robust", rho: 0 });
  }

  push(corr: CorrBand, t: number, mode: ModemMode, rho: number): void {
    const size = this.items.length;
    const i = (this.head + this.count) % size;
    const c = this.items[i]!;
    c.corr = corr;
    c.t = t;
    c.mode = mode;
    c.rho = rho;
    if (this.count < size) this.count++;
    else this.head = (this.head + 1) % size;
  }

  /** The oldest candidate (valid until the next push), or null. */
  shift(): Candidate | null {
    if (this.count === 0) return null;
    const c = this.items[this.head]!;
    this.head = (this.head + 1) % this.items.length;
    this.count--;
    return c;
  }

  clear(): void {
    this.count = 0;
  }
}

/** A sync re-correlation's result. */
export interface Recorr {
  /** The stronger pattern's ρ at its maximum in the window. */
  rho: number;
  /** First-path timing (input frame), when rho ≥ RHO_KEEP. */
  t: number;
  /** The superframe's mode, when the stronger pattern beat the other by RHO_MARGIN. */
  mode: ModemMode | null;
}

export class SyncSearch {
  readonly corr = new Map<string, CorrBand>();
  readonly M: number;
  readonly Md: number;
  /** Input samples (a multiple of DECIM) and decimated outputs per block. */
  readonly hop: number;
  readonly hopD: number;
  /** Half the band-pass length: x_bp at t needs x up to t + Dh. */
  private readonly Dh: number;
  private readonly nD: number;
  /** ±45 ms (the candidate must be the maximum: see the header), 15 ms (first-path look-back), ±5 ms (re-correlation), in decimated samples. */
  readonly W: number;
  readonly F: number;
  readonly R: number;
  private readonly half: FFT;
  /** The forward FFT runs in this many jobs; the next part to run (≥ fwdParts: done). */
  private readonly fwdParts: number;
  private fwdNext = 0;
  private readonly small: FFT;
  /** Each band's inverse FFTs run in this many jobs. */
  private readonly bandSplits: number;
  private readonly zRe: Float64Array;
  private readonly zIm: Float64Array;
  private readonly twRe: Float64Array;
  private readonly twIm: Float64Array;
  private readonly xwRe: Float64Array;
  private readonly xwIm: Float64Array;
  private readonly yRe: Float64Array;
  private readonly yIm: Float64Array;
  private readonly energy: Float64Array;
  private readonly magA: Float64Array;
  private readonly binPower: Float64Array;
  /** Correlator bins zeroed as narrowband interference, in all. */
  excised = 0;
  /** Bands searched for candidates, and the self-monitor's band (searched only where asked). */
  private main: CorrBand[] = [];
  private mon: CorrBand | null = null;
  /** The block in progress: its first decimated output, its band list and the next job. */
  private n0 = 0;
  private started = false;
  private readonly blockBands: CorrBand[];
  private readonly inBuf: Float64Array;
  private blockCount = 0;
  private stage = -1;
  private silentBlock = false;
  /** Self-monitor windows wanted, in decimated indices [from, to). */
  private readonly monFrom = new Float64Array(4);
  private readonly monTo = new Float64Array(4);
  readonly candidates = new CandidateQueue(8);

  constructor(t: Timing, tables: Map<string, BandTables>) {
    let L = 2 * Math.round((3.3 * t.sr) / 2000) + 1;
    if (L < 31) L = 31;
    let M = 1024;
    while (M < 2 * t.N + L) M *= 2;
    this.M = M;
    this.Md = M / DECIM;
    this.Dh = (L - 1) / 2;
    this.hop = DECIM * Math.floor((M - t.N - L + 1) / DECIM);
    this.hopD = this.hop / DECIM;
    this.nD = t.N / DECIM;
    this.W = Math.round((0.045 * t.sr) / DECIM);
    this.F = Math.round((0.015 * t.sr) / DECIM);
    this.R = Math.round((0.005 * t.sr) / DECIM);
    if (!Number.isInteger(this.nD)) throw new Error("the useful symbol must be a multiple of the decimation");
    for (const [key, tb] of tables) {
      const h = bandpassFir(t.sr, tb.band.loHz - 500, tb.band.hiHz + 500, L, 60);
      this.corr.set(key, new CorrBand(t, tb, M, this.Md, h));
    }
    this.half = new FFT(M / 2);
    // a 2048-point transform's worth of passes per job (the first also copies and packs the block)
    this.fwdParts = Math.max(1, M / 4096);
    this.small = new FFT(this.Md);
    this.bandSplits = Math.max(1, this.Md / 2048);
    this.zRe = new Float64Array(M / 2);
    this.zIm = new Float64Array(M / 2);
    this.twRe = new Float64Array(M / 2);
    this.twIm = new Float64Array(M / 2);
    for (let k = 0; k < M / 2; k++) {
      this.twRe[k] = Math.cos((2 * Math.PI * k) / M);
      this.twIm[k] = -Math.sin((2 * Math.PI * k) / M);
    }
    this.xwRe = new Float64Array(this.Md);
    this.xwIm = new Float64Array(this.Md);
    this.yRe = new Float64Array(this.Md);
    this.yIm = new Float64Array(this.Md);
    this.energy = new Float64Array(this.hopD);
    this.magA = new Float64Array(this.hopD);
    this.binPower = new Float64Array(this.Md);
    this.monFrom.fill(-1);
    this.monTo.fill(-1);
    this.inBuf = new Float64Array(M);
    const any = this.corr.values().next().value;
    if (!any) throw new Error("no band to search at this rate");
    this.blockBands = [any, any, any];
  }

  /** Search these bands (and compute the monitor's band where asked) from input frame `at` on. */
  setBands(main: CorrBand[], mon: CorrBand | null, at: number): void {
    for (const c of main) if (!this.main.includes(c)) c.reset(Math.ceil(at / DECIM));
    if (mon && mon !== this.mon && !main.includes(mon)) mon.reset(Math.ceil(at / DECIM));
    this.main = main;
    this.mon = mon;
    this.candidates.clear();
    // the block in progress is dropped; the next starts where its first output would have been
    if (this.started) {
      this.stage = -1;
      this.n0 = Math.max(this.n0, Math.ceil(at / DECIM));
      for (const c of main) if (c.done < this.n0) c.reset(this.n0);
    }
  }

  /** Start over from whatever the input ring holds (its frame counter was reset). */
  restart(): void {
    this.started = false;
    this.stage = -1;
    this.candidates.clear();
  }

  /** Where ρ is known up to for this band (decimated, exclusive). */
  doneUntil(c: CorrBand): number {
    return c.done;
  }

  /** Ask for the monitor band's ρ over input frames [from, to). */
  wantMonitor(from: number, to: number): void {
    let slot = 0;
    for (let i = 0; i < 4; i++) if (this.monTo[i]! < this.monTo[slot]!) slot = i;
    this.monFrom[slot] = Math.floor(from / DECIM);
    this.monTo[slot] = Math.ceil(to / DECIM) + 1;
  }

  /** Is a job ready to run (input for the next block has arrived, or one is under way)? */
  ready(ringEnd: number, ringOldest: number): boolean {
    if (this.stage >= 0) return true;
    if (!this.started) {
      this.n0 = Math.ceil((ringOldest + this.Dh) / DECIM);
      for (let i = 0; i < this.main.length; i++) this.main[i]!.reset(this.n0);
      if (this.mon) this.mon.reset(this.n0);
      this.started = true;
    }
    return ringEnd >= this.n0 * DECIM - this.Dh + this.M;
  }

  /** Run one job (one FFT). False when there was nothing to do. */
  runJob(ring: { copy(from: number, to: number, dst: Float64Array, off: number): void; silent(from: number, to: number): boolean; end: number; oldest(): number }): boolean {
    if (!this.ready(ring.end, ring.oldest())) return false;
    if (this.stage < 0) {
      const b = this.n0 * DECIM - this.Dh;
      if (b < ring.oldest()) {
        // fell behind the ring (a long stall): skip ahead
        this.n0 = Math.ceil((ring.end - this.M + this.Dh) / DECIM);
        for (let i = 0; i < this.main.length; i++) this.main[i]!.reset(this.n0);
        if (this.mon) this.mon.reset(this.n0);
        return false;
      }
      this.blockCount = 0;
      for (let i = 0; i < this.main.length; i++) this.blockBands[this.blockCount++] = this.main[i]!;
      if (this.mon && !this.main.includes(this.mon) && this.monWanted(this.n0, this.n0 + this.hopD)) this.blockBands[this.blockCount++] = this.mon;
      this.silentBlock = ring.silent(b, b + this.M);
      if (this.silentBlock) {
        for (let i = 0; i < this.blockCount; i++) this.finishBand(this.blockBands[i]!, true);
        this.n0 += this.hopD;
        return false;
      }
      this.forward(ring, b);
      this.stage = 0;
      return true;
    }
    if (this.fwdNext < this.fwdParts) {
      this.forwardPart();
      return true;
    }
    // per band: x_bp's energy, then A, then B, each in bandSplits pieces
    const per = 3 * this.bandSplits;
    const sub = this.stage % per;
    this.bandJob(this.blockBands[Math.floor(this.stage / per)]!, Math.floor(sub / this.bandSplits), sub % this.bandSplits);
    this.stage++;
    if (this.stage >= per * this.blockCount) {
      this.stage = -1;
      this.n0 += this.hopD;
    }
    return true;
  }

  private monWanted(n0: number, n1: number): boolean {
    for (let i = 0; i < 4; i++) {
      if (this.monTo[i]! < 0) continue;
      if (this.monFrom[i]! < n1 && this.monTo[i]! > n0) return true;
    }
    return false;
  }

  /** The block's real FFT, as a half-size complex FFT of even + j·odd samples (its first part, when split). */
  private forward(ring: { copy(from: number, to: number, dst: Float64Array, off: number): void }, b: number): void {
    const M = this.M;
    const zr = this.zRe;
    const zi = this.zIm;
    const s = this.inBuf;
    ring.copy(b, b + M, s, 0);
    for (let m = 0; m < M / 2; m++) {
      zr[m] = s[2 * m]!;
      zi[m] = s[2 * m + 1]!;
    }
    this.fwdNext = 0;
    this.forwardPart();
  }

  private forwardPart(): void {
    const n = this.half.passes;
    const p = this.fwdNext++;
    this.half.runPasses(this.zRe, this.zIm, false, Math.round((p * n) / this.fwdParts), Math.round(((p + 1) * n) / this.fwdParts));
  }

  /** X over the band's window (from the half-size FFT), into xw. */
  private bandSpectrum(c: CorrBand): void {
    const H = this.M / 2;
    const zr = this.zRe;
    const zi = this.zIm;
    for (let i = 0; i < this.Md; i++) {
      const k = c.kLo + i;
      const a = k % H;
      const b2 = (H - a) % H;
      const ar = zr[a]!;
      const ai = zi[a]!;
      const br = zr[b2]!;
      const bi = zi[b2]!;
      const er = 0.5 * (ar + br);
      const ei = 0.5 * (ai - bi);
      const or = 0.5 * (ai + bi);
      const oi = 0.5 * (br - ar);
      const kk = k % (2 * H);
      // W^k for k < M/2 from the table; W^(k+M/2) = −W^k
      const sg = kk >= H ? -1 : 1;
      const wr = sg * this.twRe[kk % H]!;
      const wi = sg * this.twIm[kk % H]!;
      this.xwRe[i] = er + wr * or - wi * oi;
      this.xwIm[i] = ei + wr * oi + wi * or;
    }
  }

  /** Zero the window's bins that stand EXCISE times over the median power of the band's bins. */
  private excise(c: CorrBand): void {
    const xr = this.xwRe;
    const xi = this.xwIm;
    const pw = this.binPower;
    const n = c.inHi - c.inLo;
    for (let i = 0; i < n; i++) {
      const a = xr[c.inLo + i]!;
      const b = xi[c.inLo + i]!;
      pw[i] = a * a + b * b;
    }
    const lim = EXCISE * selectInPlace(pw, n, n >> 1);
    for (let i = 0; i < this.Md; i++) {
      const a = xr[i]!;
      const b = xi[i]!;
      if (a * a + b * b > lim) {
        xr[i] = 0;
        xi[i] = 0;
        this.excised++;
      }
    }
  }

  /**
   * One piece of a band's job. Part 0: x_bp's analytic signal, whose output
   * is the energy of every window [t, t + N) of the block. Parts 1 and 2:
   * pattern A's and B's analytic correlations, whose outputs are |c| and
   * then ρ for both. Piece 0 forms the product spectrum, the last piece
   * reads the output, and every piece runs its share of the inverse FFT.
   */
  private bandJob(c: CorrBand, part: number, piece: number): void {
    if (piece === 0) {
      if (part === 0) {
        this.bandSpectrum(c);
        this.excise(c);
        this.times(c.hRe, c.hIm);
      } else if (part === 1) this.times(c.aRe, c.aIm);
      else this.times(c.bRe, c.bIm);
    }
    const n = this.small.passes;
    this.small.runPasses(this.yRe, this.yIm, true, Math.round((piece * n) / this.bandSplits), Math.round(((piece + 1) * n) / this.bandSplits));
    if (piece < this.bandSplits - 1) return;
    if (part === 0) this.energies();
    else if (part === 1) this.magnitudes();
    else this.rhos(c);
  }

  /** y = xw·kernel over the window. */
  private times(kr: Float64Array, ki: Float64Array): void {
    const yr = this.yRe;
    const yi = this.yIm;
    for (let i = 0; i < this.Md; i++) {
      const xr = this.xwRe[i]!;
      const xi = this.xwIm[i]!;
      yr[i] = xr * kr[i]! - xi * ki[i]!;
      yi[i] = xr * ki[i]! + xi * kr[i]!;
    }
  }

  /** x_bp's analytic signal (in y) → the energy of every window [t, t + N) of the block. */
  private energies(): void {
    const yr = this.yRe;
    const yi = this.yIm;
    const nD = this.nD;
    let e = 0;
    for (let i = 0; i < nD; i++) e += yr[i]! * yr[i]! + yi[i]! * yi[i]!;
    const en = this.energy;
    for (let n = 0; n < this.hopD; n++) {
      en[n] = e;
      const a = n;
      const z = n + nD;
      e += yr[z]! * yr[z]! + yi[z]! * yi[z]! - (yr[a]! * yr[a]! + yi[a]! * yi[a]!);
    }
  }

  /** Pattern A's correlation (in y) → its magnitudes. */
  private magnitudes(): void {
    const yr = this.yRe;
    const yi = this.yIm;
    const mag = this.magA;
    for (let n = 0; n < this.hopD; n++) mag[n] = Math.sqrt(yr[n]! * yr[n]! + yi[n]! * yi[n]!);
  }

  /** Pattern B's correlation (in y) → ρ for both patterns. */
  private rhos(c: CorrBand): void {
    const yr = this.yRe;
    const yi = this.yIm;
    // ρ = |c| / (‖x_bp‖·‖template‖), ‖x_bp‖² ≈ (DECIM / 2)·Σ|x_a|² over the decimated window
    const n0 = this.n0;
    const en = this.energy;
    const ma = this.magA;
    for (let n = 0; n < this.hopD; n++) {
      const norm = Math.sqrt((DECIM / 2) * en[n]!) * c.tNorm;
      const mb = Math.sqrt(yr[n]! * yr[n]! + yi[n]! * yi[n]!);
      const idx = (n0 + n) & RHO_MASK;
      const inv = 1 / Math.max(norm, 1e-30);
      c.rhoA[idx] = ma[n]! * inv;
      c.rhoB[idx] = mb * inv;
    }
    this.finishBand(c, false);
  }

  private finishBand(c: CorrBand, silent: boolean): void {
    const n0 = this.n0;
    const n1 = n0 + this.hopD;
    if (silent) {
      for (let n = n0; n < n1; n++) {
        c.rhoA[n & RHO_MASK] = 0;
        c.rhoB[n & RHO_MASK] = 0;
      }
    }
    if (c.done < n0 || c.from > n0) c.reset(n0);
    c.done = n1;
    if (c.done - c.from > RHO_SIZE - 1) c.from = c.done - (RHO_SIZE - 1);
    if (this.main.includes(c)) c.detect(n0, n1, this.W, this.F, this.candidates);
  }

  /**
   * Re-correlate around an expected sync (useful start e, input frames):
   * the maximum within ±5 ms, the first-path rule, the mode. Null until ρ is
   * known past the window.
   */
  recorrelate(c: CorrBand, e: number, out: Recorr): boolean {
    const mid = Math.round(e / DECIM);
    if (c.done <= mid + this.R) return false;
    let best = mid - this.R;
    let r = -Infinity;
    for (let n = mid - this.R; n <= mid + this.R; n++) {
      const v = c.peak(n);
      if (v > r) {
        r = v;
        best = n;
      }
    }
    out.rho = r;
    out.mode = null;
    out.t = e;
    if (r < RHO_KEEP) return true;
    const a = c.rho("robust", best);
    const b = c.rho("fast", best);
    const mode: ModemMode = a > b ? "robust" : "fast";
    if (Math.abs(a - b) >= RHO_MARGIN) out.mode = mode;
    out.t = c.firstPath(best, mode, this.F);
    return true;
  }

  /** The maximum of one pattern's ρ over input frames [from, to), for the self-monitor: [rho, first-path frame]. */
  findIn(c: CorrBand, mode: ModemMode, from: number, to: number, out: Recorr): boolean {
    const n0 = Math.ceil(from / DECIM);
    const n1 = Math.floor(to / DECIM);
    if (c.done < n1) return false;
    let best = n0;
    let r = -Infinity;
    for (let n = n0; n < n1; n++) {
      const v = c.rho(mode, n);
      if (v > r) {
        r = v;
        best = n;
      }
    }
    out.rho = r;
    out.mode = mode;
    out.t = r > 0 ? c.firstPath(best, mode, this.F) : from;
    return true;
  }
}
