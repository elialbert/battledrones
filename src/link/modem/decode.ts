/**
 * Packet decoding (SOUND-DUEL.md "The modem" > Receiver > Soft bits,
 * Decoding). When a tracker completes a packet's symbols, its soft bits are
 * taken at once (cheap, and it frees the tracker's storage), and the heavy
 * part — Viterbi, the agreement gate and the CRC — runs later as one of the
 * deferred jobs, at most one per process() call.
 *
 * Soft values are positive for bit 0, scaled by μ, the mean |d̃| over the
 * packet's data tones, and clamped to ±4. Robust: λ = Re(d̃)/μ (a 1 is a turn
 * of π). Fast: z = d̃·e^{−jπ/4}, λ0 = Re(z)/μ, λ1 = −Im(z)/μ (the two bits of
 * the Gray-coded quarter turn).
 *
 * One departure from the spec's formula (outlier.ts): a data tone carrying a
 * steady interferer is weighted down. One whose mean |d̃| over the packet
 * rises r > OUTLIER times over the median of the tones around it has its
 * soft values scaled by (OUTLIER/r)³ and its share of μ capped at OUTLIER
 * times that median, so one loud tone neither shouts down the code nor
 * shrinks every clean tone's λ; one whose signal stands less than twice
 * over the running mean of its d̃ (the interferer's share, once that mean
 * rests on STEADY_MIN symbols and stands out of the products' spread) is
 * scaled by the square of half that ratio. With no interferer this is the
 * spec's λ exactly.
 *
 * Impulses (SOUND-DUEL.md "Soft bits" > Impulses). A screen tap is a click
 * of a few milliseconds at the phone's own microphone; it spoils one
 * symbol's DFT, so both differentials that use it, and from about 20 dB over
 * the friend in its band each click costs about a packet (two of a
 * high-plan packet's symbols, or one each of two packets:
 * tests/link-modem.test.ts). Weighting the hit symbols down by their pilots'
 * phase errors would save most of those packets only if the gate counted
 * their bits out too, and then it no longer tells garbage from a packet:
 * with a quarter of a packet's symbols out, noise decodes to 7% disagreement
 * at the least, and with half of them (a click inside a high-plan packet)
 * to 0.4%, leaving the CRC alone to judge. So clicks cost their packets: how
 * loud real taps are in these bands (their sound is mostly below 9 kHz) is
 * not measured yet.
 */
import type { BandPlan, ModemMode } from "../transport";
import { gateErrors, gatePasses, Viterbi } from "./conv";
import { CRC_BITS } from "./params";
import { CRC_INIT, crc16 } from "./crc";
import { ToneWeights } from "./outlier";
import type { BandTables } from "./tables";
import type { Tracker } from "./tracker";

const CLAMP = 4;
/*
 * A note on the arithmetic below and in the other per-block paths: a float
 * variable that a branch sets to an integer literal (`l = 4`, `: 0`) is kept
 * boxed by V8, and every value it then holds is a fresh heap object. On the
 * audio thread that is garbage per sample, so clamps are Math.min/Math.max
 * and guards divide by Math.max(x, tiny) instead.
 */

export class DecodeJob {
  /** The tracker generation it came from (stale generations are dropped). */
  gen = 0;
  /** The tracker's superframe count when the packet completed. */
  sfSeq = 0;
  mode: ModemMode = "robust";
  plan: BandPlan = "high";
  tb: BandTables | null = null;
  /** Packet index within the superframe (its scrambler seed). */
  index = 0;
  readonly soft = new Float64Array(512);
  snrDb = 0;
  /** Nominal window start of the packet's first symbol (input frame). */
  sample = 0;
  /** The first packet after an acquisition candidate (its verdict decides the lock). */
  first = false;
  /** The superframe's mode was not known: decoded both ways. `span` is the robust packet it falls in; `closes` marks the robust job, last of its span. */
  unknown = false;
  span = 0;
  closes = false;
  // results
  ok = false;
  session = false;
}

/** Data tones either side of a tone that make its neighbourhood (outlier.ts). */
const NEAR = 4;
/** A tone keeps its full weight while its signal stands over a steady interferer's share by 1/STEADY. */
const STEADY = 0.5;
/**
 * The steady shares are used once their mean rests on this many symbols.
 * A mean of a few is too rough to tell an interferer from the data, and a
 * packet's own symbols weigh too much in it: from a trial's first packet's
 * four alone, a clean tone whose four bits agreed (one in eight) read as
 * interfered, and was dropped.
 */
const STEADY_MIN = 16;

/** Per-tone scratch for softBits, one per receiver (allocated once). */
export function toneScratch(): ToneWeights {
  return new ToneWeights(105, NEAR);
}

/** Take a completed packet's soft bits from the tracker: symbols index·P + 1 … (index + 1)·P of the superframe. */
export function softBits(tr: Tracker, mode: ModemMode, index: number, job: DecodeJob, tw: ToneWeights): void {
  const tb = tr.tb!;
  const sh = tb.shape[mode];
  const { P, T, b, coded } = sh;
  const base = index * P * T;
  const dr = tr.dRe;
  const di = tr.dIm;
  // each data tone's mean |d̃| over the packet, then its weight against its neighbours
  const mag = tw.mag;
  for (let t = 0; t < T; t++) {
    let m = 0;
    for (let s = 0; s < P; s++) {
      const i = base + s * T + t;
      m += Math.sqrt(dr[i]! * dr[i]! + di[i]! * di[i]!);
    }
    mag[t] = m / P;
  }
  const mu = tw.update(T) / T;
  const gain = tw.gain;
  // a steady interferer's share of each tone (the mean of d̃, once it rests on STEADY_MIN symbols and stands out of
  // what its spread leaves in a mean: tracker.ts): weight the tone by its signal-to-interference ratio
  const sr = tr.steadyRe;
  const si = tr.steadyIm;
  const sv = tr.steadyVar;
  const known = +(tr.steadyN >= STEADY_MIN);
  for (let t = 0; t < T; t++) {
    const j2 = sr[t]! * sr[t]! + si[t]! * si[t]!;
    const J = Math.sqrt(j2) * +(j2 > tr.steadyFloor * sv[t]!) * known;
    const q = (STEADY * Math.max(mag[t]! - J, 0)) / Math.max(J, 1e-300);
    gain[t] = gain[t]! * Math.min(1, q * q);
  }
  const inv = 1 / Math.max(mu, 1e-300);
  const slotOf = tb.slotOf[mode];
  const pn = tb.pn[mode];
  const pnBase = index * coded;
  const soft = job.soft;
  const c = Math.SQRT1_2;
  for (let j = 0; j < coded; j++) {
    const slot = slotOf[j]!;
    const bit = b === 2 ? slot & 1 : 0;
    const st = b === 2 ? slot >> 1 : slot;
    const i = base + st; // st = s·T + t: the slot's symbol and tone, in storage order
    const r = dr[i]!;
    const m = di[i]!;
    const g = inv * gain[st % T]!;
    const raw = b === 1 ? r * g : bit === 0 ? c * (r + m) * g : -c * (m - r) * g;
    const l = Math.min(CLAMP, Math.max(-CLAMP, raw));
    soft[j] = pn[pnBase + slot] ? -l : l;
  }
  job.tb = tb;
  job.mode = mode;
  job.plan = tb.band.plan;
  job.index = index;
  job.snrDb = tr.snrDb(index * P + 1, (index + 1) * P);
  job.sample = tr.winAt[index * P + 1]!;
}

export class Decoder {
  private readonly viterbi = new Viterbi(256);
  readonly decoded = new Uint8Array(256);
  /** Packets decoded in all (garbage included), and those the gate stopped. */
  runs = 0;
  gated = 0;

  /**
   * Viterbi, the gate, then the CRC: the session key first (when there is
   * one; a game frame must match it), then 0xFFFF (anything but a game frame
   * of the session). Sets job.ok and job.session; the payload is `decoded`.
   */
  run(job: DecodeJob, sessionKey: number | null): void {
    const sh = job.tb!.shape[job.mode];
    this.runs++;
    job.ok = false;
    job.session = false;
    const d = this.decoded;
    this.viterbi.decode(job.soft, sh.steps, d);
    if (!gatePasses(gateErrors(d, sh.steps, job.soft), sh.steps)) {
      this.gated++;
      return;
    }
    const cap = sh.capacity;
    let got = 0;
    for (let i = 0; i < CRC_BITS; i++) got = (got << 1) | d[cap + i]!;
    const game = d[0] === 0 && d[1] === 1;
    if (sessionKey !== null && game && crc16(d, cap, sessionKey) === got) {
      job.ok = true;
      job.session = true;
      return;
    }
    if ((!game || sessionKey === null) && crc16(d, cap, CRC_INIT) === got) job.ok = true;
  }
}
