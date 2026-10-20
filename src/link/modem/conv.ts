/**
 * The packet code (SOUND-DUEL.md "Coding"): the K = 7, rate-½ convolutional
 * code with generators 133 and 171 (octal), a soft-decision Viterbi decoder
 * with a zero tail, and the agreement gate. The gate re-encodes what Viterbi
 * decided and counts how many coded bits disagree with the received hard
 * decisions: 0–1% for a real packet at working SNR; for garbage 11.4% at the
 * least in a million blocks of noise, 13.1% in a million through the
 * receiver's soft bits, and 10.8% in about 500,000 of the garbage nearest a
 * codeword, a real stream read the wrong way (in the other mode, a symbol
 * off, with another packet's scrambler). So rejecting above 10% stops every
 * one of them before the CRC even looks (the CRC alone would pass one in
 * 65,536).
 *
 * The limit is 10%, where it was first 8%. Near the edge of range a weak
 * tone's hard decisions are wrong often enough that packets Viterbi decodes
 * exactly right disagree by 7–12%, and the 8% gate threw them away for no
 * garbage it stopped: robust at 80 cm with a microphone 30 times noisier
 * than the room's default delivered 68% (93% at 10%), at 90 cm 17% (65%),
 * fast at 60 cm 96% (98%), none of them wrong either way (three rooms
 * each). Decodes that Viterbi got wrong reach the CRC a little more often
 * there (at 80 cm 14 of 630 decodes against 5), each with its one chance in
 * 65,536; at working SNR none do.
 *
 * Bits are one per byte (0 or 1). Soft values are positive for bit 0.
 */

export const G0 = 0o133;
export const G1 = 0o171;
/** Memory: the encoder state is the last six input bits. */
const STATES = 64;
/** The gate's limit on disagreeing coded bits. */
export const GATE_LIMIT = 0.1;

function parity(x: number): number {
  x ^= x >> 4;
  x ^= x >> 2;
  x ^= x >> 1;
  return x & 1;
}

/**
 * Encode n bits from state 0: coded bit 2i is G0's, 2i + 1 is G1's. The
 * register is (u << 6) | state, with the newest previous bit at state bit 5.
 */
export function convEncode(bits: ArrayLike<number>, n: number, out: Uint8Array): void {
  let s = 0;
  for (let i = 0; i < n; i++) {
    const r = ((bits[i]! & 1) << 6) | s;
    out[2 * i] = parity(r & G0);
    out[2 * i + 1] = parity(r & G1);
    s = r >> 1;
  }
}

/**
 * Soft Viterbi for a zero-tailed block. Both generators tap the newest and
 * the oldest bit, so each butterfly (states 2j and 2j+1 → j and j+32) has
 * one branch metric and its negation: 32 add-compare-selects pairs a step.
 */
export class Viterbi {
  private readonly maxSteps: number;
  /** One decision bit per state per step: word 2t holds states 0–31, 2t+1 states 32–63. */
  private readonly dec: Uint32Array;
  private pm = new Float64Array(STATES);
  private nm = new Float64Array(STATES);
  /** Sign (±1) of each butterfly's base branch (state 2j, input 0) for G0 and G1. */
  private readonly s0 = new Float64Array(STATES / 2);
  private readonly s1 = new Float64Array(STATES / 2);

  constructor(maxSteps: number) {
    this.maxSteps = maxSteps;
    this.dec = new Uint32Array(maxSteps * 2);
    for (let j = 0; j < STATES / 2; j++) {
      const r = 2 * j; // input 0, from state 2j
      this.s0[j] = 1 - 2 * parity(r & G0);
      this.s1[j] = 1 - 2 * parity(r & G1);
    }
  }

  /** Decode `steps` bits (tail included) from 2·steps soft values into out. */
  decode(soft: Float64Array, steps: number, out: Uint8Array): void {
    if (steps > this.maxSteps) throw new RangeError("Viterbi block too long");
    let pm = this.pm;
    let nm = this.nm;
    const dec = this.dec;
    const s0 = this.s0;
    const s1 = this.s1;
    pm.fill(-1e9);
    pm[0] = 0;
    for (let t = 0; t < steps; t++) {
      const l0 = soft[2 * t]!;
      const l1 = soft[2 * t + 1]!;
      let lo = 0;
      let hi = 0;
      for (let j = 0; j < 32; j++) {
        const m = s0[j]! * l0 + s1[j]! * l1;
        const a = pm[2 * j]!;
        const b = pm[2 * j + 1]!;
        // to state j (input 0): from 2j with +m, from 2j+1 with −m
        const x0 = a + m;
        const x1 = b - m;
        if (x1 > x0) {
          nm[j] = x1;
          lo |= 1 << j;
        } else nm[j] = x0;
        // to state j+32 (input 1): from 2j with −m, from 2j+1 with +m
        const y0 = a - m;
        const y1 = b + m;
        if (y1 > y0) {
          nm[j + 32] = y1;
          hi |= 1 << j;
        } else nm[j + 32] = y0;
      }
      dec[2 * t] = lo;
      dec[2 * t + 1] = hi;
      const sw = pm;
      pm = nm;
      nm = sw;
    }
    this.pm = pm;
    this.nm = nm;
    // trace back from state 0 (the tail drives the encoder home)
    let s = 0;
    for (let t = steps - 1; t >= 0; t--) {
      const b = (dec[2 * t + (s >> 5)]! >>> (s & 31)) & 1;
      out[t] = s >> 5;
      s = ((s & 31) << 1) | b;
    }
  }
}

/**
 * The gate: how many of the 2·steps coded bits that re-encoding `decoded`
 * gives disagree with the hard decisions of `soft` (negative means 1).
 */
export function gateErrors(decoded: Uint8Array, steps: number, soft: Float64Array): number {
  let s = 0;
  let errs = 0;
  for (let i = 0; i < steps; i++) {
    const r = ((decoded[i]! & 1) << 6) | s;
    const c0 = parity(r & G0);
    const c1 = parity(r & G1);
    if ((soft[2 * i]! < 0 ? 1 : 0) !== c0) errs++;
    if ((soft[2 * i + 1]! < 0 ? 1 : 0) !== c1) errs++;
    s = r >> 1;
  }
  return errs;
}

/** The gate's verdict for a block of 2·steps coded bits. */
export function gatePasses(errors: number, steps: number): boolean {
  return errors <= GATE_LIMIT * 2 * steps;
}
