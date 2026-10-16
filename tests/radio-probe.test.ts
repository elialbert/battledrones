// The radio probe page (radio-probe.html) measures a phone-to-phone sound
// link. Its analysis core runs here against simulated rooms: a resampled,
// clock-skewed, echoing, noisy, band-limited copy of the probe, with speaker
// distortion for the sender's own recording.
import { describe, expect, it } from "vitest";
import html from "../radio-probe.html?raw";

const code = /<script id="probe-core">([\s\S]*?)<\/script>/.exec(html)![1]!;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const P: any = new Function("window", `${code}\nreturn ProbeCore;`)({});

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r: () => number) {
  return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
}

/** RBJ low-pass biquad, in place. */
function lowpass(x: Float64Array, sr: number, fc: number) {
  const w = (2 * Math.PI * fc) / sr;
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
  const c = Math.cos(w);
  const a0 = 1 + alpha;
  const b0 = (1 - c) / 2 / a0, b1 = (1 - c) / a0, b2 = b0, a1 = (-2 * c) / a0, a2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = b0 * x[i]! + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]!; y2 = y1; y1 = y;
    x[i] = y;
  }
}

interface Room {
  srOut: number;
  /** Clock skew: one sender-second lasts (1 + ppm·1e-6) listener-seconds. */
  ppm: number;
  /** When the probe's first sample arrives, in listener seconds. */
  delay: number;
  gain: number;
  /** Noise standard deviation per sample. */
  noise: number;
  rt60?: number;
  /** Diffuse echo energy relative to the direct sound, dB. */
  reverbDb?: number;
  lowpassHz?: number;
  /** Speaker distortion: y = x + h2·x². */
  h2?: number;
  tail?: number;
  seed?: number;
}

/** The probe as another phone's microphone would record it. */
function channel(tx: Float32Array, srTx: number, room: Room): Float32Array {
  const r = rng(room.seed ?? 7);
  const src = Float64Array.from(tx, (v) => v + (room.h2 ?? 0) * v * v);
  const durOut = room.delay + (tx.length / srTx) * (1 + room.ppm * 1e-6) + (room.tail ?? 1);
  const n = Math.ceil(durOut * room.srOut);
  const y = new Float64Array(n);
  // windowed-sinc resampling onto the listener's clock
  const fc = 0.47 * Math.min(srTx, room.srOut) / srTx; // cutoff, cycles per input sample
  const H = 24;
  for (let i = 0; i < n; i++) {
    const tau = (i / room.srOut - room.delay) / (1 + room.ppm * 1e-6);
    const pos = tau * srTx;
    if (pos < -H || pos > tx.length + H) continue;
    const k0 = Math.floor(pos);
    let acc = 0;
    for (let k = k0 - H + 1; k <= k0 + H; k++) {
      if (k < 0 || k >= src.length) continue;
      const d = pos - k;
      const s = d === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * d) / (Math.PI * d);
      const w = 0.42 + 0.5 * Math.cos((Math.PI * d) / H) + 0.08 * Math.cos((2 * Math.PI * d) / H);
      acc += src[k]! * s * w;
    }
    y[i] = acc * room.gain;
  }
  if (room.lowpassHz) {
    lowpass(y, room.srOut, room.lowpassHz);
    lowpass(y, room.srOut, room.lowpassHz);
  }
  // diffuse echo: decaying random reflections after 1.5 ms
  const out = Float64Array.from(y);
  if (room.rt60) {
    const count = 400;
    const span = room.rt60;
    const taps: [number, number][] = [];
    let energy = 0;
    for (let i = 0; i < count; i++) {
      const t = 0.0015 + r() * span;
      const g = gauss(r) * Math.exp((-6.9 * t) / room.rt60);
      taps.push([Math.round(t * room.srOut), g]);
      energy += g * g;
    }
    const scale = Math.sqrt(Math.pow(10, (room.reverbDb ?? -6) / 10) / energy);
    for (const [d, g] of taps) for (let i = 0; i + d < n; i++) out[i + d] = out[i + d]! + y[i]! * g * scale;
  }
  return Float32Array.from(out, (v) => v + room.noise * gauss(r));
}

const SR = 48000;
const probe = P.render(SR).samples as Float32Array;

describe("radio probe sequence", () => {
  it("fits the schedule and stays under full scale", () => {
    expect(probe.length).toBe(Math.ceil(P.T_END * SR));
    let peak = 0;
    for (const v of probe) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeLessThanOrEqual(0.9);
    expect(peak).toBeGreaterThan(0.8);
    expect(P.BANDS).toHaveLength(20);
    for (const b of P.BANDS) expect(b.freqs.length).toBeGreaterThanOrEqual(20);
  });

  it("reads back its own tones and data exactly when looped back digitally", () => {
    const x = new Float32Array(probe.length + SR);
    x.set(probe, SR / 2);
    const res = P.analyze(x, SR);
    expect(res.found).toBe(true);
    expect(Math.abs(res.ppm)).toBeLessThan(0.5);
    for (const b of res.bands) {
      expect(b.dqpsk).toBe(0);
      expect(b.evm).toBeGreaterThan(40);
    }
  });
});

describe("radio probe listening through a room", () => {
  const room: Room = { srOut: 44100, ppm: 85, delay: 0.7, gain: 0.05, noise: 0.0008, rt60: 0.3, reverbDb: -8, lowpassHz: 12000 };
  const rec = channel(probe, SR, room);
  const t0 = performance.now();
  const res = P.analyze(rec, room.srOut);
  const ms = performance.now() - t0;

  it("finds both chirps and the clock offset between the phones", () => {
    expect(res.found).toBe(true);
    expect(res.ppm).toBeGreaterThan(85 - 3);
    expect(res.ppm).toBeLessThan(85 + 3);
    expect(ms).toBeLessThan(4000);
  });

  it("decodes the speech-band tones cleanly and sees the high bands roll off", () => {
    for (let b = 0; b < 8; b++) {
      expect(res.bands[b].snr).toBeGreaterThan(15);
      expect(res.bands[b].dbpsk).toBeLessThan(0.01);
    }
    expect(res.bands[3].snr - res.bands[19].snr).toBeGreaterThan(10);
  });

  it("measures the room's echo", () => {
    expect(res.ir.t10).toBeGreaterThan(0);
    expect(res.ir.t20).toBeGreaterThan(res.ir.t10 - 0.01);
    expect(res.ir.t20).toBeLessThan(300);
    expect(res.ir.drr).toBeGreaterThan(0);
    expect(res.ir.drr).toBeLessThan(20);
  });

  it("is found as it arrives, a chunk at a time", () => {
    const det = new P.Detector(room.srOut);
    let pair = null;
    for (let total = 2048; total <= rec.length && !pair; total += 2048 * 8)
      pair = det.update((a: number, z: number) => rec.subarray(a, z), total);
    expect(pair).not.toBeNull();
    expect(Math.abs(pair.a.pos - res.span[0])).toBeLessThan(1);
    expect(Math.abs(pair.b.pos - res.span[1])).toBeLessThan(1);
  });
});

describe("radio probe signal-to-noise calibration", () => {
  it("matches the SNR expected from the tone amplitude and the noise", () => {
    const room: Room = { srOut: SR, ppm: -40, delay: 0.4, gain: 0.02, noise: 0.002 };
    const res = P.analyze(channel(probe, SR, room), SR);
    expect(res.found).toBe(true);
    const tone = P.render(SR).toneAmp * room.gain;
    const M = Math.round(P.TU * SR);
    const expected = 10 * Math.log10((tone * tone) / ((4 * room.noise * room.noise) / M));
    for (const b of res.bands.slice(0, 18)) expect(Math.abs(b.snr - expected)).toBeLessThan(1.5);
  });

  it("counts errors once the noise is high", () => {
    const room: Room = { srOut: SR, ppm: 20, delay: 0.4, gain: 0.004, noise: 0.004 };
    const res = P.analyze(channel(probe, SR, room), SR);
    expect(res.found).toBe(true);
    const mid = res.bands[4];
    expect(mid.snr).toBeLessThan(8);
    expect(mid.dqpsk).toBeGreaterThan(0.05);
    expect(mid.dqpsk).toBeGreaterThan(mid.dbpsk);
  });

  it("reports nothing found in plain noise", () => {
    const r = rng(3);
    const x = Float32Array.from({ length: SR * 15 }, () => 0.01 * gauss(r));
    expect(P.analyze(x, SR).found).toBe(false);
  });
});

describe("radio probe on the sending phone", () => {
  // The sender records itself: loud, distorted by its own speaker, and late
  // by the loopback latency. Recording sample 0 is at AudioContext time 10 s.
  const tStart = 10.3;
  const latency = 0.1234;
  const own: Room = { srOut: SR, ppm: 0, delay: tStart - 10 + latency, gain: 0.3, noise: 0.0002, h2: 0.4, rt60: 0.2, reverbDb: -12 };
  const rec = channel(probe, SR, own);
  const timeAt = (i: number) => 10 + i / SR;
  const send = P.analyze(rec, SR, { role: "send", timeAt, tStart });

  it("measures the loopback latency", () => {
    expect(send.found).toBe(true);
    expect(send.latency[0]).toBeCloseTo(latency * 1000, 0);
    expect(send.latency[1]).toBeCloseTo(latency * 1000, 0);
  });

  it("sees the speaker's second harmonic land an octave up", () => {
    const above = (x: number, y: number) => send.spill[x][y] - send.noise[y];
    expect(above(1, 3)).toBeGreaterThan(15); // sending 2–3 kHz, heard at 4–5 kHz
    expect(above(1, 4)).toBeGreaterThan(15); // and 5–6 kHz
    // harmonics only go up: below the band there's only echo smearing symbol edges, far weaker
    expect(above(3, 1)).toBeLessThan(above(1, 3) - 15);
    expect(send.spill[3][1]).toBeLessThan(send.spill[3][3] - 40);
  });

  it("feeds the full-duplex check", () => {
    const room: Room = { srOut: SR, ppm: 30, delay: 0.5, gain: 0.03, noise: 0.0005 };
    const listen = P.analyze(channel(probe, SR, room), SR);
    const d = P.duplex(listen, send);
    expect(d.sinr[1][3]).toBeLessThan(d.sinr[3][1] - 10);
    expect(d.best[0].sinr).toBeGreaterThan(15);
    expect(d.peerRel).toBeLessThan(-10);
  });
});

describe("radio probe latency test", () => {
  it("times each chirp's round trip", () => {
    const clicks = P.renderClicks(SR) as Float32Array;
    const tStart = 5.5;
    const latency = 0.0876;
    const rec = channel(clicks, SR, { srOut: SR, ppm: 0, delay: tStart - 5 + latency, gain: 0.2, noise: 0.0005, rt60: 0.2 });
    const res = P.analyzeLatency(rec, SR, (i: number) => 5 + i / SR, (t: number) => (t - 5) * SR, tStart);
    expect(res.heard).toBe(P.CLICKS);
    expect(res.mean).toBeCloseTo(latency * 1000, 0);
    expect(res.sd).toBeLessThan(0.1);
  });
});
