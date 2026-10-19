/**
 * The receiver's input history: the last 2.7 s or so of microphone samples,
 * indexed by input frame (the AudioWorklet's currentFrame domain), and the
 * recent gaps — stretches whose samples never arrived (a frame-counter jump,
 * or a block of digital silence while transmitting). Gaps are zero-filled,
 * so timing survives them, and any symbol window that overlaps one is
 * treated as erased rather than decoded.
 *
 * Acquisition finds a sync some 100 ms after it went by, so the first
 * packet after it is demodulated from here; afterwards the trackers keep
 * reading from here too, normally a block behind the newest sample.
 */

export const RING_SIZE = 1 << 17;
const GAPS = 16;

export class InputRing {
  readonly buf = new Float32Array(RING_SIZE);
  /** Every sample from `start` to before `end` has been written (absolute input frames). */
  start = 0;
  end = 0;
  private readonly gapFrom = new Float64Array(GAPS);
  private readonly gapTo = new Float64Array(GAPS);
  private gapHead = 0;

  constructor() {
    this.gapFrom.fill(-1);
    this.gapTo.fill(-1);
  }

  /** The oldest sample still held. */
  oldest(): number {
    return Math.max(this.start, this.end - RING_SIZE);
  }

  /** Start (or restart) at frame `at`, as if everything before it were history we never had. */
  reset(at: number): void {
    this.start = this.end = at;
    this.buf.fill(0);
    this.gapFrom.fill(-1);
    this.gapTo.fill(-1);
  }

  /** Append samples at `end`. */
  write(x: Float32Array, from: number, to: number): void {
    let p = this.end % RING_SIZE;
    for (let i = from; i < to; i++) {
      this.buf[p] = x[i]!;
      p = p + 1 === RING_SIZE ? 0 : p + 1;
    }
    this.end += to - from;
  }

  /** Append `n` missing samples as zeros, and remember them as a gap. */
  skip(n: number): void {
    const from = this.end;
    const fill = Math.min(n, RING_SIZE);
    let p = (this.end + n - fill) % RING_SIZE;
    for (let i = 0; i < fill; i++) {
      this.buf[p] = 0;
      p = p + 1 === RING_SIZE ? 0 : p + 1;
    }
    this.end += n;
    this.markGap(from, this.end);
  }

  /** Remember [from, to) as missing input (extends the newest gap when they touch). */
  markGap(from: number, to: number): void {
    const last = (this.gapHead + GAPS - 1) % GAPS;
    if (this.gapTo[last]! >= from && this.gapFrom[last]! >= 0 && this.gapFrom[last]! <= from) {
      this.gapTo[last] = Math.max(this.gapTo[last]!, to);
      return;
    }
    this.gapFrom[this.gapHead] = from;
    this.gapTo[this.gapHead] = to;
    this.gapHead = (this.gapHead + 1) % GAPS;
  }

  /** Does [from, to) overlap a gap? */
  overlapsGap(from: number, to: number): boolean {
    for (let g = 0; g < GAPS; g++) {
      const a = this.gapFrom[g]!;
      if (a < 0) continue;
      if (a < to && this.gapTo[g]! > from) return true;
    }
    return false;
  }

  /** Copy samples [from, to) into dst at dstOff (they must still be held). */
  copy(from: number, to: number, dst: Float32Array | Float64Array, dstOff: number): void {
    let p = from % RING_SIZE;
    for (let i = from, o = dstOff; i < to; i++, o++) {
      dst[o] = this.buf[p]!;
      p = p + 1 === RING_SIZE ? 0 : p + 1;
    }
  }

  /** Are samples [from, to) all exactly zero (or not held)? */
  silent(from: number, to: number): boolean {
    if (from < this.oldest()) return true;
    let p = from % RING_SIZE;
    for (let i = from; i < to; i++) {
      if (this.buf[p] !== 0) return false;
      p = p + 1 === RING_SIZE ? 0 : p + 1;
    }
    return true;
  }
}
