/**
 * Narrowband interference (a deviation from SOUND-DUEL.md's soft-bit and
 * pilot-fit formulas, which weight every tone by its magnitude alone).
 *
 * A steady tone in the receive band — coil whine, a fan, an ultrasonic
 * beacon, a harmonic of game audio — lands on one or two of the friend's
 * tones and makes them far louder than their neighbours. Weighted by
 * magnitude, such a tone becomes the most trusted one in the band: its
 * soft bits sit at the clamp, four times as sure as any clean bit, though
 * its phase is the interferer's and half of them are wrong; one loud pilot
 * steers the clock fit wherever its interferer points. A channel peak, by
 * contrast, rises only a few dB over the tones beside it.
 *
 * Two signatures give such a tone away.
 *
 *  - It is loud. Each tone is measured against the median of its
 *    neighbourhood (a few tones either side, so a band whose level slopes —
 *    a speaker rolling off at 18 kHz — is not mistaken for interference). Up
 *    to OUTLIER times that median the tone keeps its magnitude weight,
 *    exactly as the spec has it; beyond, the weight falls as OUTLIER³/r² (r
 *    its ratio to the median), so a tone a steady interferer has made 10 dB
 *    louder counts for a tenth of a clean one, and 20 dB louder for next to
 *    nothing: an erasure, which the code corrects with ease, rather than
 *    four confident errors, which it can't. (ToneWeights, below: the data
 *    tones per packet in decode.ts, the pilots per symbol in tracker.ts.)
 *  - It is steady. A tone between two of the friend's leaks into a dozen of
 *    them, each only a little louder than its neighbours. But the scrambled
 *    data turns each tone's differential product d̃ at random, symbol after
 *    symbol, while an interferer adds the same rotation every time, so the
 *    running mean of d̃ (tracker.ts) is the interferer's share. A data tone
 *    whose signal stands less than twice over that share has its weight
 *    scaled by (SIR/2)², SIR being the ratio of the two (decode.ts).
 *
 * Neither changes anything when no tone is interfered.
 */

/** How far over its neighbourhood's median a tone may rise before it is treated as interfered. */
export const OUTLIER = 2;

/**
 * Per-tone neighbourhood medians and weights, over arrays allocated once
 * (this runs on the audio thread, per packet and per symbol).
 */
export class ToneWeights {
  /** Each tone's magnitude (filled by the caller), its neighbourhood's median, and its gain (1, or less when interfered). */
  readonly mag: Float64Array;
  readonly ref: Float64Array;
  readonly gain: Float64Array;
  private readonly win: Float64Array;
  private readonly half: number;

  /** `half` tones either side make the neighbourhood. */
  constructor(max: number, half: number) {
    this.mag = new Float64Array(max);
    this.ref = new Float64Array(max);
    this.gain = new Float64Array(max);
    this.win = new Float64Array(2 * half + 1);
    this.half = half;
  }

  /**
   * From mag[0 … n − 1], fill ref (the median of the 2·half + 1 tones around
   * each, the window shifted inward at the band's ends) and gain. Returns
   * Σ min(mag, OUTLIER·ref): the plain sum of the magnitudes whenever no tone
   * is interfered.
   */
  update(n: number): number {
    const w = Math.min(2 * this.half + 1, n);
    const mid = (w - 1) >> 1;
    const mag = this.mag;
    const win = this.win;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const lo = Math.min(Math.max(i - this.half, 0), n - w);
      // insertion sort of the window: at most 9 values
      for (let a = 0; a < w; a++) {
        const v = mag[lo + a]!;
        let b = a;
        while (b > 0 && win[b - 1]! > v) {
          win[b] = win[b - 1]!;
          b--;
        }
        win[b] = v;
      }
      const ref = win[mid]!;
      const m = mag[i]!;
      this.ref[i] = ref;
      // OUTLIER³/r² as a gain on the magnitude: (OUTLIER/r)³, capped at 1 (branch-free; see decode.ts)
      const q = (OUTLIER * ref) / Math.max(m, 1e-300);
      this.gain[i] = Math.min(1, q * q * q);
      sum += Math.min(m, OUTLIER * ref);
    }
    return sum;
  }
}
