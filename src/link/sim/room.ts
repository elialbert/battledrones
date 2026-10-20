/**
 * A simulated room for two phones (SOUND-DUEL.md "Modules", tests/link-modem):
 * a seeded, sample-level, streaming model of what each phone's microphone
 * hears while both transmit. Each phone runs its own endpoint (a ModemCore,
 * or anything with process(input, output, frame)) in 128-frame blocks at its
 * own sample rate and clock; the room steps whichever phone's next block
 * comes first in true time, so every sound arrives through causal paths.
 *
 * Per phone:
 *  - a sample rate (44.1 or 48 kHz), a clock skew (ppm) and output and input
 *    latencies (speaker after process(), and microphone before it);
 *  - a speaker: the modem's output plus optional game audio, either the
 *    built-in jammer (synthesised explosions, blips, music and hats, put
 *    through the band guard as SOUND-DUEL.md specifies it: a 300 Hz
 *    high-pass and the game's own guard FIR, src/game/guard-fir.ts, then set
 *    to an RMS level) or a loop the caller made (tests/link-guard.test.ts
 *    plays a battle mix through a model of the whole guard chain), then a
 *    polynomial nonlinearity (h2, h3, h5) computed at twice the rate so its
 *    products above Nyquist don't fold back into the bands (in a real
 *    speaker they are ultrasound, and the microphone's anti-alias filter
 *    removes them);
 *  - the own path, 15–40 dB louder than the peer's direct sound: the speaker
 *    to its own microphone a few centimetres away, with a small IR, at the
 *    measured round trip (75 ms by default);
 *  - the peer path: the direct sound (∝ 1/distance), a cluster of
 *    reflections 8–15 ms after it and a diffuse decay (sparse early
 *    reflections, then a feedback delay network; RT60 0.3–0.5 s), both of
 *    fixed level (the room's, so the farther the phones the more they
 *    dominate), then resampled onto the listener's rate and clock with a
 *    windowed sinc;
 *  - microphone noise, an optional band limit (low-pass), clipping at ±1,
 *    and injected capture gaps: input zeros, or a frame-counter jump (the
 *    audio thread missed J frames: nothing rendered, nothing captured);
 *  - optional screen taps: the player's fingers on this phone's glass, which
 *    its own microphone hears as clicks (see TAP_MS).
 *
 * Calibration. The peer path's levels are tuned so the radio probe's own
 * analysis (21.3 ms symbols, 5.3 ms prefix) reads an effective SNR of about
 * 17–31 dB at 10 cm and 9–19 dB at 30 cm, the range measured between two
 * phones in October 2026 (tests/link-modem.test.ts checks it).
 *
 * Nothing here reads a clock or Math.random: one seed decides the room.
 */
import { guardFir } from "../../game/guard-fir";
import type { BandPlan } from "../transport";

/** Anything that renders a block of output from a block of input (a ModemCore). */
export interface RoomEndpoint {
  process(input: Float32Array, output: Float32Array, frame?: number): void;
}

export interface SpeakerModel {
  /** y = x + h2·x² + h3·x³ + h5·x⁵ (x in full-scale units). */
  h2: number;
  h3: number;
  h5: number;
}

export interface RoomSide {
  /** Hz (default 48000). */
  sampleRate?: number;
  /** This phone's clock runs fast by this much (default 0). */
  ppm?: number;
  /** process() output → speaker, and microphone → process() input (ms; defaults 30 and 45: a 75 ms round trip). */
  outLatencyMs?: number;
  inLatencyMs?: number;
  /** True time of this phone's frame 0 (ms; default a seeded 0–200 ms, so the phones' symbols don't line up). */
  startMs?: number;
  /** The own path's level over the peer's direct sound at this microphone (dB, default 30). */
  ownDb?: number;
  /** The whole speaker's level (dB, default 0): far below 0 is sound gone to the earpiece or a headset, heard by neither microphone. */
  outputDb?: number;
  /** Microphone noise, standard deviation per sample (default 1e-5, about −100 dBFS). */
  noise?: number;
  /** A band limit at the microphone (two RBJ low-pass sections), Hz. */
  lowpassHz?: number;
  /** Game audio at the speaker, RMS dBFS after the guard (default none): the built-in jammer. */
  jammerDb?: number | null;
  /**
   * Game audio at the speaker as the caller made it, in place of the built-in
   * jammer: samples at this phone's rate, already through the guard and at
   * their final level (full scale ±1), looped from a seeded place.
   */
  game?: Float32Array | null;
  /** Which plan's guard FIR the game audio went through (default "high"). */
  guard?: BandPlan;
  /** Speaker nonlinearity (default: harmonics about 40–60 dB down at the modem's level); null for a linear speaker. */
  speaker?: SpeakerModel | null;
  /** Screen taps at this phone, heard by its own microphone (default none). */
  screenTaps?: ScreenTaps | null;
}

/**
 * Screen taps: clicks at seeded random times (a Poisson process, none within
 * another), each a burst of white noise decaying over TAP_MS. A white click
 * reaches all the modem's bands alike: its power within a 3 kHz band (the
 * high plan's) over its 3 ms is about `db` − 17 dB, within a 1.5 kHz band
 * (the low plan's) `db` − 20. A real tap's sound is mostly below 9 kHz (a
 * burst at about 8 kHz, then 4 kHz, then a thump: Shumailov et al.,
 * "Hearing your touch", 2019): quieter than this in the high plan's bands,
 * perhaps not in the low plan's guest band (8–9.5 kHz). How loud taps
 * really are at a phone's own microphone is not measured yet.
 */
export interface ScreenTaps {
  /** Taps a second, on average. */
  perSecond: number;
  /** The click's level as it starts: the RMS of its noise at onset (dBFS). */
  db: number;
}

export interface RoomOptions {
  seed?: number;
  /** Phone-to-phone distance (cm, default 20). */
  distanceCm?: number;
  /** Reverberation time (s, default a seeded 0.3–0.5). */
  rt60?: number;
  a?: RoomSide;
  b?: RoomSide;
}

/** Direct-sound gain at 10 cm: the modem's −15 dBFS band reaches the other microphone at about −55 dBFS. */
const DIRECT_10CM = 0.01;
/** The room's diffuse field and early-reflection cluster, in energy relative to the 10 cm direct sound. */
const DIFFUSE_DB = -25;
const CLUSTER_DB = -22;
const SPEED = 343;
export const DEFAULT_SPEAKER: SpeakerModel = { h2: 0.07, h3: 0.09, h5: 0.14 };

/** Sample rings are written twice (at i and i + RING), so any span up to RING long reads contiguously. */
const RING = 1 << 17;
const MASK = RING - 1;
const BLOCK = 128;
/** Windowed-sinc resampler: taps each side, and fractional phases (the nearest is used: 1/4096-sample steps). */
const HALF = 16;
const PHASES = 2048;

function mulberry(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(r: () => number): number {
  return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
}

/** A sparse impulse response: delays (samples) and gains. */
interface Taps {
  d: Int32Array;
  g: Float64Array;
}

function taps(list: [number, number][]): Taps {
  return { d: Int32Array.from(list, (x) => x[0]), g: Float64Array.from(list, (x) => x[1]) };
}

/** RBJ biquad low-pass, streaming. */
class Biquad {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  private readonly b0: number;
  private readonly b1: number;
  private readonly b2: number;
  private readonly a1: number;
  private readonly a2: number;
  constructor(sr: number, fc: number, high = false) {
    const w = (2 * Math.PI * fc) / sr;
    const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
    const c = Math.cos(w);
    const a0 = 1 + alpha;
    if (high) {
      this.b0 = (1 + c) / 2 / a0;
      this.b1 = -(1 + c) / a0;
    } else {
      this.b0 = (1 - c) / 2 / a0;
      this.b1 = (1 - c) / a0;
    }
    this.b2 = this.b0;
    this.a1 = (-2 * c) / a0;
    this.a2 = (1 - alpha) / a0;
  }
  run(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/**
 * The speaker's nonlinearity at twice the rate: upsample with a half-band
 * filter, apply the polynomial, filter and decimate. (At the base rate the
 * guest band's second harmonic, 32–38 kHz, would fold back to 6–16 kHz, right
 * into the other band.) The half-band passes 19 kHz of a 44.1 kHz base and
 * stops what folds back by 50 dB, under products already 40 dB down; the
 * whole is a fixed delay of K samples.
 */
class Speaker {
  private readonly m: SpeakerModel;
  private readonly h: Float64Array;
  /** Half the half-band's length, and the model's delay in samples. */
  readonly K = 23;
  /** Base-rate history (the last K samples, then the block) and 2×-rate history (the last 2K, then the block's). */
  private readonly hx: Float64Array;
  private readonly hw: Float64Array;

  constructor(m: SpeakerModel) {
    this.m = m;
    const K = this.K;
    this.h = new Float64Array(2 * K + 1);
    const beta = 4.6;
    const i0 = (v: number) => {
      let s = 1;
      let t = 1;
      for (let k = 1; k < 40; k++) {
        t *= (v * v) / (4 * k * k);
        s += t;
      }
      return s;
    };
    // half-band: ½ at the centre, sin(πk/2)/(πk) elsewhere (zero at even k), Kaiser-windowed
    for (let k = -K; k <= K; k++) {
      const ideal = k === 0 ? 0.5 : Math.sin((Math.PI * k) / 2) / (Math.PI * k);
      const r = k / K;
      this.h[k + K] = ideal * (i0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0(beta));
    }
    this.hx = new Float64Array(K + BLOCK);
    this.hw = new Float64Array(2 * K + 2 * BLOCK);
  }

  /** In place: buf[off … off + n − 1], n ≤ 128. */
  run(buf: Float32Array, off: number, n: number): void {
    const K = this.K;
    const h = this.h;
    const hx = this.hx;
    const hw = this.hw;
    const { h2, h3, h5 } = this.m;
    for (let i = 0; i < n; i++) hx[K + i] = buf[off + i]!;
    for (let i = 0; i < n; i++) {
      // the 2× pair centred on base sample c = (newest − (K+1)/2): x[c], and the interpolation between c and c + 1
      const qc = K + i - (K + 1) / 2;
      let odd = 0;
      for (let k = 1; k <= K; k += 2) odd += h[K + k]! * (hx[qc - (k - 1) / 2]! + hx[qc + (k + 1) / 2]!);
      const u = hx[qc]!;
      const v = 2 * odd;
      const u2 = u * u;
      const v2 = v * v;
      hw[2 * K + 2 * i] = u + h2 * u2 + h3 * u2 * u + h5 * u2 * u2 * u;
      hw[2 * K + 2 * i + 1] = v + h2 * v2 + h3 * v2 * v + h5 * v2 * v2 * v;
      // low-pass at 2× and keep the even samples
      const e = K + 2 * i + 1;
      let y = 0.5 * hw[e]!;
      for (let k = 1; k <= K; k += 2) y += h[K + k]! * (hw[e - k]! + hw[e + k]!);
      buf[off + i] = y;
    }
    hx.copyWithin(0, n, n + K);
    hw.copyWithin(0, 2 * n, 2 * n + 2 * K);
  }
}

/** A windowed-sinc fractional resampler table (cut-off in cycles per source sample). */
function sincTable(fc: number): Float32Array {
  const t = new Float32Array((PHASES + 1) * 2 * HALF);
  for (let ph = 0; ph <= PHASES; ph++) {
    const frac = ph / PHASES;
    for (let i = 0; i < 2 * HALF; i++) {
      // tap i multiplies source sample k0 − HALF + 1 + i; its distance from the read point
      const d = frac + HALF - 1 - i;
      const s = d === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * d) / (Math.PI * d);
      const w = Math.abs(d) >= HALF ? 0 : 0.42 + 0.5 * Math.cos((Math.PI * d) / HALF) + 0.08 * Math.cos((2 * Math.PI * d) / HALF);
      t[ph * 2 * HALF + i] = s * w;
    }
  }
  return t;
}

/** Synthesised game audio (explosions, blips, a music bed, hats), through the band guard, looped. */
function gameAudio(sr: number, seconds: number, rmsDb: number, plan: BandPlan, seed: number): Float32Array {
  const r = mulberry(seed);
  const n = Math.round(seconds * sr);
  const x = new Float64Array(n);
  // music bed: a bass note and a square-ish lead (odd harmonics to 5) every quarter second
  for (let note = 0; note < seconds * 4; note++) {
    const f0 = 55 * Math.pow(2, Math.floor(r() * 24) / 12);
    const lead = 440 * Math.pow(2, Math.floor(r() * 24) / 12);
    const a = Math.round((note / 4) * sr);
    const z = Math.min(n, a + Math.round(0.25 * sr));
    for (let i = a; i < z; i++) {
      const t = (i - a) / sr;
      const env = Math.exp(-t * 6);
      const p = 2 * Math.PI * lead * t;
      x[i] = x[i]! + 0.3 * env * Math.sin(2 * Math.PI * f0 * t) + 0.08 * env * (Math.sin(p) + Math.sin(3 * p) / 3 + Math.sin(5 * p) / 5);
    }
  }
  // explosions (decaying noise, low-passed by a one-pole) and hats (differenced noise)
  for (let e = 0; e < seconds * 1.5; e++) {
    const a = Math.floor(r() * n);
    const len = Math.round((0.2 + 0.4 * r()) * sr);
    const hat = r() < 0.5;
    let lp = 0;
    let prev = 0;
    for (let i = a; i < Math.min(n, a + len); i++) {
      const t = (i - a) / sr;
      const w = 2 * r() - 1;
      lp += 0.08 * (w - lp);
      const v = hat ? w - prev : lp * 4;
      prev = w;
      x[i] = x[i]! + (hat ? 0.08 : 0.8) * Math.exp(-t * (hat ? 30 : 5)) * v;
    }
  }
  // blips: short square waves at 880 and 1800 Hz
  for (let b = 0; b < seconds * 2; b++) {
    const a = Math.floor(r() * n);
    const f = r() < 0.5 ? 880 : 1800;
    for (let i = a; i < Math.min(n, a + Math.round(0.06 * sr)); i++) x[i] = x[i]! + 0.1 * (Math.sin((2 * Math.PI * f * (i - a)) / sr) >= 0 ? 1 : -1);
  }
  // the guard: high-pass ~300 Hz, then the game's FIR (high plan: flat to 8 kHz, 70 dB down from 9.5 kHz; low: 4 kHz, 60 dB from 5 kHz)
  const hp1 = new Biquad(sr, 300, true);
  const hp2 = new Biquad(sr, 300, true);
  for (let i = 0; i < n; i++) x[i] = hp2.run(hp1.run(x[i]!));
  const fir = guardFir(sr, plan);
  // circular convolution (the loop has no seam): the input with its end copied in front
  const L = fir.length;
  const xp = new Float64Array(n + L);
  xp.set(x.subarray(n - L), 0);
  xp.set(x, L);
  const y = new Float32Array(n);
  let e = 0;
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = 0; k < L; k++) acc += fir[k]! * xp[L + i - k]!;
    y[i] = acc;
    e += acc * acc;
  }
  const scale = Math.pow(10, rmsDb / 20) / Math.sqrt(e / n);
  for (let i = 0; i < n; i++) y[i] = y[i]! * scale;
  return y;
}

/** The game-audio loop at unit RMS, made once per rate and guard (each phone starts it at its own seeded place). */
const gameLoops = new Map<string, Float32Array>();
function gameLoop(sr: number, plan: BandPlan): Float32Array {
  const key = `${sr}:${plan}`;
  let g = gameLoops.get(key);
  if (!g) {
    g = gameAudio(sr, 4, 0, plan, 0x3c6ef372);
    gameLoops.set(key, g);
  }
  return g;
}

/** A tap's decay time constant and length (ms). */
const TAP_TAU_MS = 1;
export const TAP_MS = 3;

/** Gaussian noise, precomputed: each block reads 128 values from a random place. */
const NOISE = 1 << 16;
let noiseTable: Float32Array | null = null;
function gaussTable(): Float32Array {
  if (noiseTable) return noiseTable;
  const r = mulberry(0x6e6f6973);
  noiseTable = new Float32Array(NOISE + BLOCK);
  for (let i = 0; i < NOISE + BLOCK; i++) noiseTable[i] = gauss(r);
  return noiseTable;
}

/**
 * The diffuse tail: a feedback delay network (four lines of 30–44 ms mixed by
 * a Householder matrix, each losing 60 dB per RT60), which builds the dense,
 * exponentially decaying echo of a room for a few operations a sample, where
 * sparse taps would need hundreds. It is fed the speaker 4 ms late, so its
 * first returns come after the sparse early reflections it continues.
 */
class Fdn {
  private readonly l0: Float64Array;
  private readonly l1: Float64Array;
  private readonly l2: Float64Array;
  private readonly l3: Float64Array;
  private p0 = 0;
  private p1 = 0;
  private p2 = 0;
  private p3 = 0;
  private readonly g0: number;
  private readonly g1: number;
  private readonly g2: number;
  private readonly g3: number;
  /** Output gain: set so the tail carries its share of the room's diffuse energy. */
  scale = 1;

  constructor(sr: number, rt60: number) {
    const len = (s: number) => Math.round(s * sr) | 1;
    this.l0 = new Float64Array(len(0.0297));
    this.l1 = new Float64Array(len(0.0371));
    this.l2 = new Float64Array(len(0.0411));
    this.l3 = new Float64Array(len(0.0437));
    const g = (n: number) => Math.pow(10, (-3 * n) / (sr * rt60));
    this.g0 = g(this.l0.length);
    this.g1 = g(this.l1.length);
    this.g2 = g(this.l2.length);
    this.g3 = g(this.l3.length);
  }

  run(x: number): number {
    const v0 = this.g0 * this.l0[this.p0]!;
    const v1 = this.g1 * this.l1[this.p1]!;
    const v2 = this.g2 * this.l2[this.p2]!;
    const v3 = this.g3 * this.l3[this.p3]!;
    const h = 0.5 * (v0 + v1 + v2 + v3);
    this.l0[this.p0] = v0 - h + x;
    this.l1[this.p1] = v1 - h + x;
    this.l2[this.p2] = v2 - h + x;
    this.l3[this.p3] = v3 - h + x;
    if (++this.p0 === this.l0.length) this.p0 = 0;
    if (++this.p1 === this.l1.length) this.p1 = 0;
    if (++this.p2 === this.l2.length) this.p2 = 0;
    if (++this.p3 === this.l3.length) this.p3 = 0;
    return this.scale * (v0 + v1 + v2 + v3);
  }

  /** Energy of the unscaled impulse response over `n` samples (and the state cleared again). */
  energy(n: number): number {
    const keep = this.scale;
    this.scale = 1;
    let e = 0;
    for (let i = 0; i < n; i++) {
      const y = this.run(i === 0 ? 1 : 0);
      e += y * y;
    }
    this.l0.fill(0);
    this.l1.fill(0);
    this.l2.fill(0);
    this.l3.fill(0);
    this.scale = keep;
    return e;
  }
}

/** One phone in the room. */
class Phone {
  readonly sr: number;
  /** Samples per true second. */
  readonly rate: number;
  readonly t0: number;
  readonly outLat: number;
  readonly inLat: number;
  endpoint: RoomEndpoint;
  /** The next block's frame. */
  frame = 0;
  /** Speaker signal, by output frame (doubled ring). */
  readonly spk = new Float32Array(2 * RING);
  /** The speaker through the peer path's IR (at this phone's rate), by output frame: what the other phone resamples (doubled ring). */
  readonly far = new Float32Array(2 * RING);
  /** The room's diffuse tail of this speaker (doubled ring): part of the peer path, and of the own path. */
  readonly tail = new Float32Array(2 * RING);
  fdn: Fdn | null = null;
  /** The tail is fed the speaker this many samples late. */
  predelay = 0;
  private readonly acc = new Float64Array(BLOCK);
  private readonly blk = new Float32Array(BLOCK);
  readonly mic = new Float32Array(BLOCK);
  readonly out = new Float32Array(BLOCK);
  ownDelay = 0;
  own: Taps = taps([]);
  peer: Taps = taps([]);
  noise: number;
  readonly speaker: Speaker | null;
  readonly outGain: number;
  readonly jam: Float32Array | null;
  private readonly jamGain: number;
  private jamPos = 0;
  readonly lp: [Biquad, Biquad] | null;
  readonly rand: () => number;
  /** Pending: a frame jump, and capture gaps (input frames [from, to) zeroed). */
  jump = 0;
  readonly zeros: [number, number][] = [];
  /** Screen taps (null: none): their own random stream, so a room without them is the room it always was; the next tap's onset (input frame), and where its noise is read from. */
  readonly screenTaps: ScreenTaps | null;
  readonly tapRand: () => number;
  nextTap = Infinity;
  tapNoise = 0;

  constructor(o: RoomSide, seed: number, endpoint: RoomEndpoint) {
    this.sr = o.sampleRate ?? 48000;
    this.rate = this.sr * (1 + (o.ppm ?? 0) * 1e-6);
    const r = mulberry(seed);
    this.rand = mulberry(seed ^ 0x5bd1e995);
    this.t0 = (o.startMs ?? 200 * r()) / 1000;
    this.outLat = (o.outLatencyMs ?? 30) / 1000;
    this.inLat = (o.inLatencyMs ?? 45) / 1000;
    if (this.outLat + this.inLat < 0.008) throw new RangeError("a phone's output plus input latency must be at least 8 ms");
    this.endpoint = endpoint;
    this.noise = o.noise ?? 1e-5;
    const sp = o.speaker === undefined ? DEFAULT_SPEAKER : o.speaker;
    this.speaker = sp ? new Speaker(sp) : null;
    this.outGain = Math.pow(10, (o.outputDb ?? 0) / 20);
    if (o.game && o.game.length > 0) {
      this.jam = o.game;
      this.jamGain = 1;
    } else {
      this.jam = o.jammerDb === undefined || o.jammerDb === null ? null : gameLoop(this.sr, o.guard ?? "high");
      this.jamGain = o.jammerDb === undefined || o.jammerDb === null ? 0 : Math.pow(10, o.jammerDb / 20);
    }
    this.jamPos = Math.floor(r() * (this.jam?.length ?? 1));
    this.lp = o.lowpassHz ? [new Biquad(this.sr, o.lowpassHz), new Biquad(this.sr, o.lowpassHz)] : null;
    this.screenTaps = o.screenTaps && o.screenTaps.perSecond > 0 ? o.screenTaps : null;
    this.tapRand = mulberry(seed ^ 0x7a9b3c1d);
    if (this.screenTaps) {
      this.nextTap = this.tapAfter(0);
      this.tapNoise = Math.floor(this.tapRand() * NOISE);
    }
  }

  /** The onset of the tap after frame f (an exponential wait). */
  tapAfter(f: number): number {
    return f + Math.max(1, Math.round((-Math.log(1 - this.tapRand()) / this.screenTaps!.perSecond) * this.sr));
  }

  /** True time of frame n. */
  time(n: number): number {
    return this.t0 + n / this.rate;
  }

  /** The speaker for frames [f, f + n), n ≤ 128: the endpoint's output (or silence) plus the game, through the nonlinearity. */
  speak(out: Float32Array | null, f: number, n: number): void {
    const blk = this.blk;
    for (let i = 0; i < n; i++) blk[i] = out ? out[i]! : 0;
    const jam = this.jam;
    if (jam) {
      for (let i = 0; i < n; i++) {
        blk[i] = blk[i]! + this.jamGain * jam[this.jamPos]!;
        this.jamPos = this.jamPos + 1 === jam.length ? 0 : this.jamPos + 1;
      }
    }
    if (this.speaker) this.speaker.run(blk, 0, n);
    if (this.outGain !== 1) for (let i = 0; i < n; i++) blk[i] = blk[i]! * this.outGain;
    const spk = this.spk;
    const w = f & MASK;
    for (let i = 0; i < n; i++) {
      const j = (w + i) & MASK;
      spk[j] = blk[i]!;
      spk[j + RING] = blk[i]!;
    }
    // the peer path's IR, applied at the source
    const acc = this.acc;
    acc.fill(0, 0, n);
    const { d, g } = this.peer;
    for (let k = 0; k < d.length; k++) {
      const base = (f - d[k]!) & MASK;
      const gk = g[k]!;
      for (let i = 0; i < n; i++) acc[i] = acc[i]! + gk * spk[base + i]!;
    }
    const far = this.far;
    const tail = this.tail;
    const fdn = this.fdn;
    const pre = (f - this.predelay) & MASK;
    for (let i = 0; i < n; i++) {
      const j = (w + i) & MASK;
      const v = fdn ? fdn.run(spk[pre + i]!) : 0;
      tail[j] = v;
      tail[j + RING] = v;
      far[j] = acc[i]! + v;
      far[j + RING] = acc[i]! + v;
    }
  }
}

export class Room {
  private readonly phones: [Phone, Phone];
  /** Called after each block a phone processes. */
  onBlock: ((side: 0 | 1, frame: number) => void) | null = null;
  readonly distanceCm: number;
  readonly rt60: number;
  /** Peer-path acoustic delay of the direct sound (s). */
  readonly direct: number;
  private readonly tables: [Float32Array, Float32Array];
  private readonly noise = gaussTable();
  private now = 0;

  constructor(o: RoomOptions, a: RoomEndpoint, b: RoomEndpoint) {
    const seed = o.seed ?? 1;
    const r = mulberry(seed);
    this.distanceCm = o.distanceCm ?? 20;
    this.rt60 = o.rt60 ?? 0.3 + 0.2 * r();
    this.phones = [new Phone(o.a ?? {}, seed * 2 + 11, a), new Phone(o.b ?? {}, seed * 2 + 12, b)];
    this.direct = this.distanceCm / 100 / SPEED;
    const sides = [o.a ?? {}, o.b ?? {}];
    for (const i of [0, 1] as const) {
      const p = this.phones[i];
      p.peer = this.peerIr(p, mulberry(seed * 7 + 31 * i + 3));
      // the own path: the peer's direct level at this mic, raised by ownDb, after the round trip
      const own = DIRECT_10CM * (10 / this.distanceCm) * Math.pow(10, (sides[i]!.ownDb ?? 30) / 20);
      p.ownDelay = Math.round((p.outLat + p.inLat + 0.0003) * p.sr);
      p.own = this.ownIr(p.sr, own, mulberry(seed * 13 + 7 * i + 5));
    }
    // resampling cut-off: below both Nyquists, in cycles per source sample
    const fc = (src: Phone, dst: Phone) => (0.46 * Math.min(src.sr, dst.sr)) / src.sr;
    this.tables = [sincTable(fc(this.phones[1], this.phones[0])), sincTable(fc(this.phones[0], this.phones[1]))];
  }

  /** The peer path from a speaker (at its rate): direct, the 8–15 ms cluster, the diffuse decay. */
  /**
   * The peer path from a speaker (at its rate): the direct sound, the 8–15 ms
   * cluster, early diffuse reflections from 2 ms, and the tail (the FDN).
   * The diffuse energy decays as e^{−13.8·t/RT60} from 2 ms on; the sparse
   * taps carry its share before the tail's first returns (34 ms), the tail
   * the rest.
   */
  private peerIr(p: Phone, r: () => number): Taps {
    const sr = p.sr;
    const direct = DIRECT_10CM * (10 / this.distanceCm);
    const list: [number, number][] = [[0, direct]];
    const ref = DIRECT_10CM * DIRECT_10CM;
    const nc = 8;
    const cl: [number, number][] = [];
    let ec = 0;
    for (let i = 0; i < nc; i++) {
      const g = gauss(r);
      cl.push([Math.round((0.008 + 0.007 * r()) * sr), g]);
      ec += g * g;
    }
    const sc = Math.sqrt((ref * Math.pow(10, CLUSTER_DB / 10)) / ec);
    for (const [d, g] of cl) list.push([d, g * sc]);
    const k = 13.8 / this.rt60;
    const t0 = 0.002;
    const t1 = 0.034;
    const total = ref * Math.pow(10, DIFFUSE_DB / 10);
    const early = total * (1 - Math.exp(-k * (t1 - t0)));
    const nd = 30;
    const df: [number, number][] = [];
    let ed = 0;
    for (let i = 0; i < nd; i++) {
      const t = t0 + r() * (t1 - t0);
      const g = gauss(r) * Math.exp((-k / 2) * t);
      df.push([Math.round(t * sr), g]);
      ed += g * g;
    }
    const sd = Math.sqrt(early / ed);
    for (const [d, g] of df) list.push([d, g * sd]);
    // the tail: its first returns arrive at predelay + 30 ms ≈ t1
    const fdn = new Fdn(sr, this.rt60);
    p.predelay = Math.round(0.004 * sr);
    const e = fdn.energy(Math.round(1.5 * this.rt60 * sr));
    fdn.scale = Math.sqrt((total - early) / e);
    p.fdn = fdn;
    return taps(list);
  }

  /** The own path: the speaker a few centimetres from its microphone, the phone's body and the table (the room's tail is added on its own). */
  private ownIr(sr: number, gain: number, r: () => number): Taps {
    const list: [number, number][] = [[0, gain]];
    for (let i = 0; i < 3; i++) list.push([Math.round((0.0004 + 0.0025 * r()) * sr), gain * 0.2 * gauss(r)]);
    return taps(list);
  }

  /** True time (s) the room has run to. */
  get time(): number {
    return this.now;
  }

  /** The next block's frame on a phone. */
  frame(side: 0 | 1): number {
    return this.phones[side].frame;
  }

  /** True time of a phone's frame. */
  timeOf(side: 0 | 1, frame: number): number {
    return this.phones[side].time(frame);
  }

  /** A phone's own clock (its frame counter, in ms) at true time t (default: now). */
  localMs(side: 0 | 1, t = this.now): number {
    const p = this.phones[side];
    return Math.max(0, ((t - p.t0) * p.rate * 1000) / p.sr);
  }

  /** A phone's sample rate. */
  sampleRate(side: 0 | 1): number {
    return this.phones[side].sr;
  }

  /** Swap a phone's endpoint (a fresh modem, say), from its next block. */
  setEndpoint(side: 0 | 1, e: RoomEndpoint): void {
    this.phones[side].endpoint = e;
  }

  /** The input frame at which `to` hears the direct sound of `from`'s output frame (fractional). */
  arrival(from: 0 | 1, outFrame: number): number {
    const p = this.phones[from];
    const q = this.phones[1 - from]!;
    const t = p.time(outFrame + (p.speaker?.K ?? 0)) + p.outLat + this.direct + q.inLat;
    return (t - q.t0) * q.rate;
  }

  /** A phone's own round trip (s): from process() output to the same sound in its input. */
  loopback(side: 0 | 1): number {
    const p = this.phones[side];
    return (p.ownDelay + (p.speaker?.K ?? 0)) / p.sr;
  }

  /** Zero a phone's microphone input for `ms` from its next block (a capture gap). */
  captureGap(side: 0 | 1, ms: number): void {
    const p = this.phones[side];
    p.zeros.push([p.frame, p.frame + Math.round((ms / 1000) * p.sr)]);
  }

  /** Make a phone's frame counter jump by `ms` at its next block (frames never rendered or captured). */
  jump(side: 0 | 1, ms: number): void {
    this.phones[side].jump += Math.round((ms / 1000) * this.phones[side].sr);
  }

  /** Run the room `seconds` of true time forward. */
  run(seconds: number): void {
    const until = this.now + seconds;
    const a = this.phones[0];
    const b = this.phones[1];
    for (;;) {
      const ta = a.time(a.frame);
      const tb = b.time(b.frame);
      const side: 0 | 1 = ta <= tb ? 0 : 1;
      const t = Math.min(ta, tb);
      if (t >= until) break;
      this.step(side);
    }
    this.now = until;
  }

  private step(side: 0 | 1): void {
    const p = this.phones[side];
    if (p.jump > 0) {
      // the audio thread stalled: the speaker is silent (bar the game), the input lost
      const J = p.jump;
      p.jump = 0;
      for (let i = 0; i < J; i += BLOCK) p.speak(null, p.frame + i, Math.min(BLOCK, J - i));
      p.frame += J;
    }
    const f = p.frame;
    this.hear(side, f);
    p.out.fill(0);
    p.endpoint.process(p.mic, p.out, f);
    p.speak(p.out, f, BLOCK);
    p.frame = f + BLOCK;
    this.onBlock?.(side, f);
  }

  /** Add the screen taps that sound during frames [f, f + 128) to the microphone block. */
  private tap(p: Phone, f: number): void {
    const amp = Math.pow(10, p.screenTaps!.db / 20);
    const len = Math.round((TAP_MS / 1000) * p.sr);
    const tau = (TAP_TAU_MS / 1000) * p.sr;
    // p.nextTap is the onset of the tap sounding now, or of the next one
    while (p.nextTap < f + BLOCK) {
      const onset = p.nextTap;
      const to = Math.min(f + BLOCK, onset + len);
      for (let n = Math.max(f, onset); n < to; n++) {
        const k = n - onset;
        p.mic[n - f] = p.mic[n - f]! + amp * Math.exp(-k / tau) * this.noise[(p.tapNoise + k) % NOISE]!;
      }
      if (onset + len > f + BLOCK) break;
      // the next, after this one has died away (a finger doesn't tap twice in 3 ms)
      p.nextTap = p.tapAfter(onset + len);
      p.tapNoise = Math.floor(p.tapRand() * NOISE);
    }
  }

  /** The microphone block of phone `side` at frames [f, f + 128). */
  private hear(side: 0 | 1, f: number): void {
    const p = this.phones[side];
    const q = this.phones[1 - side]!;
    const mic = p.mic;
    // own path
    const { d, g } = p.own;
    const spk = p.spk;
    mic.fill(0);
    for (let k = 0; k < d.length; k++) {
      const base = (f - p.ownDelay - d[k]!) & MASK;
      const gk = g[k]!;
      for (let i = 0; i < BLOCK; i++) mic[i] = mic[i]! + gk * spk[base + i]!;
    }
    // the room's tail of its own sound
    const tail = p.tail;
    const tb = (f - p.ownDelay) & MASK;
    for (let i = 0; i < BLOCK; i++) mic[i] = mic[i]! + tail[tb + i]!;
    // peer path: the other phone's far signal, resampled onto this phone's clock
    const table = this.tables[side];
    const far = q.far;
    const lag = p.inLat + this.direct + q.outLat;
    const pos0 = (p.time(f) - lag - q.t0) * q.rate;
    const step = q.rate / p.rate;
    const W = 2 * HALF;
    for (let i = 0; i < BLOCK; i++) {
      const pos = pos0 + i * step;
      const k0 = Math.floor(pos);
      if (k0 < HALF) continue;
      const o = (((pos - k0) * PHASES + 0.5) | 0) * W;
      const base = (k0 - HALF + 1) & MASK;
      let acc = 0;
      for (let j = 0; j < W; j++) acc += table[o + j]! * far[base + j]!;
      mic[i] = mic[i]! + acc;
    }
    // noise, screen taps, band limit, clipping, gaps
    const nz = this.noise;
    const at = Math.floor(p.rand() * NOISE);
    const sd = p.noise;
    for (let i = 0; i < BLOCK; i++) mic[i] = mic[i]! + sd * nz[at + i]!;
    if (p.screenTaps) this.tap(p, f);
    if (p.lp) for (let i = 0; i < BLOCK; i++) mic[i] = p.lp[1].run(p.lp[0].run(mic[i]!));
    for (let i = 0; i < BLOCK; i++) mic[i] = Math.min(1, Math.max(-1, mic[i]!));
    for (let z = 0; z < p.zeros.length; z++) {
      const [a, b] = p.zeros[z]!;
      for (let i = 0; i < BLOCK; i++) if (f + i >= a && f + i < b) mic[i] = 0;
    }
    while (p.zeros.length && p.zeros[0]![1] <= f) p.zeros.shift();
  }
}
