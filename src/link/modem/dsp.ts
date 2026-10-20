/**
 * Small DSP helpers for the modem (SOUND-DUEL.md "The modem"): an in-place
 * radix-2 FFT with its tables built once, and Kaiser-windowed FIR design.
 * Pure arithmetic on typed arrays, so they run unchanged in the AudioWorklet:
 * everything is allocated in a constructor, never per call.
 */

/** In-place complex FFT of a fixed power-of-two size. */
export class FFT {
  readonly size: number;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly rev: Uint32Array;

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) throw new RangeError(`FFT size ${size} is not a power of two`);
    this.size = size;
    this.cos = new Float64Array(size / 2);
    this.sin = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / size);
      this.sin[i] = Math.sin((2 * Math.PI * i) / size);
    }
    this.rev = new Uint32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
  }

  /** The transform's passes: the bit-reversal, then one per butterfly stage. */
  get passes(): number {
    return Math.log2(this.size) + 1;
  }

  /** X[k] = Σ x[n]·e^{∓j2πkn/M}: forward (−) or inverse (+, unscaled). */
  run(re: Float64Array, im: Float64Array, inverse: boolean): void {
    this.runPasses(re, im, inverse, 0, this.passes);
  }

  /**
   * Passes [first, last) of run(), so a large transform can be spread over
   * several audio blocks (pass 0 is the bit-reversal, pass p ≥ 1 the
   * butterflies of length 2^p).
   */
  runPasses(re: Float64Array, im: Float64Array, inverse: boolean, first: number, last: number): void {
    const n = this.size;
    if (first === 0) {
      const rev = this.rev;
      for (let i = 0; i < n; i++) {
        const j = rev[i]!;
        if (j > i) {
          const tr = re[i]!;
          re[i] = re[j]!;
          re[j] = tr;
          const ti = im[i]!;
          im[i] = im[j]!;
          im[j] = ti;
        }
      }
    }
    const sgn = inverse ? 1 : -1;
    const ct = this.cos;
    const st = this.sin;
    for (let len = 1 << Math.max(1, first), end = 1 << (last - 1); len <= end; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const wr = ct[t]!;
          const wi = sgn * st[t]!;
          const a = i + k;
          const b = a + half;
          const xr = re[b]! * wr - im[b]! * wi;
          const xi = re[b]! * wi + im[b]! * wr;
          re[b] = re[a]! - xr;
          im[b] = im[a]! - xi;
          re[a] = re[a]! + xr;
          im[a] = im[a]! + xi;
        }
      }
    }
  }
}

/** The zeroth-order modified Bessel function, for Kaiser windows. */
function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 60; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

/** Kaiser β for a stopband `atten` dB down (Kaiser's formula). */
export function kaiserBeta(atten: number): number {
  if (atten > 50) return 0.1102 * (atten - 8.7);
  if (atten >= 21) return 0.5842 * Math.pow(atten - 21, 0.4) + 0.07886 * (atten - 21);
  return 0;
}

/**
 * A linear-phase band-pass FIR (odd length), passing loHz…hiHz with its
 * −6 dB points there: a Kaiser-windowed difference of two sincs. Unit gain in
 * the passband.
 */
export function bandpassFir(sr: number, loHz: number, hiHz: number, length: number, atten = 60): Float64Array {
  if ((length & 1) === 0) throw new RangeError("the FIR length must be odd");
  const h = new Float64Array(length);
  const mid = (length - 1) / 2;
  const beta = kaiserBeta(atten);
  const i0b = besselI0(beta);
  const a = loHz / sr;
  const b = hiHz / sr;
  for (let i = 0; i < length; i++) {
    const n = i - mid;
    const ideal = n === 0 ? 2 * (b - a) : (Math.sin(2 * Math.PI * b * n) - Math.sin(2 * Math.PI * a * n)) / (Math.PI * n);
    const r = n / mid;
    h[i] = ideal * (besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0b);
  }
  return h;
}

/**
 * The k-th smallest of a[0 … n − 1] (k from 0), found in place by Hoare's
 * selection: no allocation, no recursion. Reorders a.
 */
export function selectInPlace(a: Float64Array, n: number, k: number): number {
  let lo = 0;
  let hi = n - 1;
  while (hi > lo) {
    const pivot = a[(lo + hi) >> 1]!;
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (a[i]! < pivot) i++;
      while (a[j]! > pivot) j--;
      if (i <= j) {
        const t = a[i]!;
        a[i] = a[j]!;
        a[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else break;
  }
  return a[k]!;
}
