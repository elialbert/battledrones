/**
 * Biome ambience: a quiet looped bed under the score so a map sounds like a
 * place — wind and birdsong in the temperate lands, surf and gulls on the reef, desert hiss and gusts,
 * an arctic whistle, a volcanic rumble with crackles. Built from two looped
 * noise buffers, a few filters and one slow LFO; the occasional bird or
 * crackle is scheduled by the music clock (tick()). Ducked by the battle
 * intensity so it fills the quiet stretches and steps back in a fight.
 */
import type { Biome } from "../sim/types";

/** Base bed level per biome, before the intensity duck. */
const LEVEL: Record<Biome, number> = { temperate: 0.22, desert: 0.15, arctic: 0.17, volcanic: 0.25, tropical: 0.2 };

interface Bed {
  sources: AudioScheduledSourceNode[];
  out: GainNode;
}

export class Ambience {
  private bed: Bed | null = null;
  private biome: Biome | null = null;
  private brown: AudioBuffer;
  private white: AudioBuffer;
  private nextEvent = 0;
  private duckLevel = 1;
  /** Transient voices (birds, crackles) alive right now. */
  live = 0;

  constructor(private ctx: BaseAudioContext, private dest: AudioNode) {
    this.brown = loopNoise(ctx, 5, true);
    this.white = loopNoise(ctx, 3.7, false);
  }

  get current(): Biome | null {
    return this.biome;
  }

  /** Fade in the bed for `biome` (replacing any other) at time `at`. */
  start(biome: Biome, at: number): void {
    if (this.biome === biome && this.bed) return;
    this.stop(at);
    this.biome = biome;
    this.bed = this.build(biome, at);
    this.nextEvent = at + 2 + Math.random() * 4;
  }

  /** Fade the bed out at `at` and release its nodes. */
  stop(at: number): void {
    const bed = this.bed;
    if (!bed) return;
    this.bed = null;
    this.biome = null;
    bed.out.gain.cancelScheduledValues(at);
    bed.out.gain.setTargetAtTime(0, at, 0.3);
    for (const s of bed.sources) s.stop(at + 1.6);
    if (bed.sources[0]) bed.sources[0].onended = () => bed.out.disconnect();
    else bed.out.disconnect();
  }

  /** Battle intensity 0–1: ambience × (1 − 0.7·I). */
  duck(intensity: number, now: number): void {
    const d = 1 - 0.7 * Math.max(0, Math.min(1, intensity));
    if (!this.bed || !this.biome || Math.abs(d - this.duckLevel) < 0.02) return;
    this.duckLevel = d;
    this.bed.out.gain.setTargetAtTime(LEVEL[this.biome] * d, now, 0.8);
  }

  /** Schedule the bed's occasional events (birds, crackles) up to `horizon`. */
  tick(horizon: number): void {
    if (!this.bed || !this.biome) return;
    while (this.nextEvent < horizon) {
      const t = this.nextEvent;
      if (this.biome === "temperate") {
        this.bird(t);
        this.nextEvent = t + 6 + Math.random() * 6;
      } else if (this.biome === "volcanic") {
        this.crackle(t);
        this.nextEvent = t + 0.6 + Math.random() * 2.4;
      } else if (this.biome === "tropical") {
        if (Math.random() < 0.3) this.wave(t);
        else this.gulls(t);
        this.nextEvent = t + 7 + Math.random() * 7;
      } else this.nextEvent = Infinity;
    }
  }

  // ------------------------------------------------------------- beds ---

  private build(biome: Biome, at: number): Bed {
    const c = this.ctx;
    const out = c.createGain();
    out.gain.setValueAtTime(0, at);
    out.gain.setTargetAtTime(LEVEL[biome] * this.duckLevel, at, 1.2);
    out.connect(this.dest);
    const sources: AudioScheduledSourceNode[] = [];
    const loop = (buf: AudioBuffer, rate: number) => {
      const s = c.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      s.playbackRate.value = rate;
      s.start(at, Math.random() * buf.duration);
      sources.push(s);
      return s;
    };
    const filter = (type: BiquadFilterType, f: number, q: number) => {
      const n = c.createBiquadFilter();
      n.type = type;
      n.frequency.value = f;
      n.Q.value = q;
      return n;
    };
    const gain = (v: number) => {
      const g = c.createGain();
      g.gain.value = v;
      return g;
    };
    /** A slow sine LFO wobbling `param` by ±depth. */
    const lfo = (param: AudioParam, hz: number, depth: number) => {
      const o = c.createOscillator();
      o.frequency.value = hz;
      const d = gain(depth);
      o.connect(d).connect(param);
      o.start(at);
      sources.push(o);
    };
    const gust = gain(0.6);
    gust.connect(out);
    switch (biome) {
      case "temperate": {
        // wind through grass: low band of brown noise breathing in gusts
        loop(this.brown, 1).connect(filter("bandpass", 420, 0.6)).connect(gain(1.1)).connect(gust);
        loop(this.white, 0.9).connect(filter("bandpass", 1900, 0.9)).connect(gain(0.012)).connect(gust);
        lfo(gust.gain, 0.07, 0.38);
        break;
      }
      case "desert": {
        // a low roar of moving air and fine sand hiss, gusting
        loop(this.brown, 0.85).connect(filter("lowpass", 280, 0.5)).connect(gain(1.0)).connect(gust);
        loop(this.white, 1).connect(filter("highpass", 5200, 0.5)).connect(gain(0.05)).connect(gust);
        lfo(gust.gain, 0.09, 0.45);
        break;
      }
      case "arctic": {
        // a thin resonant whistle that slides around, over low wind
        const whistle = filter("bandpass", 1400, 9);
        loop(this.white, 1).connect(whistle).connect(gain(0.35)).connect(gust);
        lfo(whistle.frequency, 0.05, 420);
        loop(this.brown, 1.1).connect(filter("lowpass", 380, 0.5)).connect(gain(0.8)).connect(gust);
        break;
      }
      case "tropical": {
        // surf rolling in about every ten seconds, its foam hiss, and a trade wind in the palms
        const swell = gain(0.5);
        swell.connect(gust);
        loop(this.brown, 0.8).connect(filter("lowpass", 320, 0.6)).connect(gain(1.0)).connect(swell);
        loop(this.white, 1).connect(filter("bandpass", 2400, 0.8)).connect(gain(0.05)).connect(swell);
        lfo(swell.gain, 0.1, 0.42);
        loop(this.white, 0.95).connect(filter("highpass", 5500, 0.5)).connect(gain(0.012)).connect(gust);
        lfo(gust.gain, 0.05, 0.3);
        break;
      }
      case "volcanic": {
        // a deep ground rumble; crackle bursts come from tick()
        loop(this.brown, 0.7).connect(filter("lowpass", 120, 0.9)).connect(gain(0.3)).connect(gust);
        loop(this.brown, 1.3).connect(filter("bandpass", 260, 1.2)).connect(gain(0.6)).connect(gust);
        lfo(gust.gain, 0.04, 0.25);
        break;
      }
    }
    return { sources, out };
  }

  // ----------------------------------------------------------- events ---

  /** A short songbird phrase: 2–5 FM chirps. */
  private bird(t: number): void {
    if (!this.bed || this.live > 6) return;
    const c = this.ctx;
    const n = 2 + Math.floor(Math.random() * 4);
    const base = 2400 + Math.random() * 1400;
    let at = t;
    for (let i = 0; i < n; i++) {
      const dur = 0.05 + Math.random() * 0.05;
      const o = c.createOscillator();
      o.type = "sine";
      const f0 = base * (0.9 + Math.random() * 0.25);
      o.frequency.setValueAtTime(f0, at);
      o.frequency.exponentialRampToValueAtTime(f0 * (1.25 + Math.random() * 0.3), at + dur * 0.6);
      o.frequency.exponentialRampToValueAtTime(f0 * 0.85, at + dur);
      const m = c.createOscillator();
      m.frequency.value = 35 + Math.random() * 40;
      const md = c.createGain();
      md.gain.value = 140;
      m.connect(md).connect(o.frequency);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.06, at + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      o.connect(g).connect(this.bed.out);
      o.start(at);
      m.start(at);
      o.stop(at + dur + 0.02);
      m.stop(at + dur + 0.02);
      this.live++;
      o.onended = () => {
        this.live--;
        g.disconnect();
      };
      at += dur + 0.04 + Math.random() * 0.08;
    }
  }

  /** A cluster of lava crackles: tiny filtered noise ticks. */
  private crackle(t: number): void {
    if (!this.bed || this.live > 6) return;
    const c = this.ctx;
    const s = c.createBufferSource();
    s.buffer = this.white;
    const hp = c.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 1600 + Math.random() * 1200;
    const g = c.createGain();
    g.gain.value = 0;
    const n = 3 + Math.floor(Math.random() * 6);
    let at = t;
    for (let i = 0; i < n; i++) {
      const v = 0.15 + Math.random() * 0.4;
      g.gain.setValueAtTime(v, at);
      g.gain.setTargetAtTime(0, at + 0.002, 0.006);
      at += 0.015 + Math.random() * 0.06;
    }
    s.connect(hp).connect(g).connect(this.bed.out);
    s.start(t, Math.random() * 3);
    s.stop(at + 0.05);
    this.live++;
    s.onended = () => {
      this.live--;
      g.disconnect();
    };
  }

  /** Two or three gulls crying "kee-ah" somewhere along the shore. */
  private gulls(t: number): void {
    if (!this.bed || this.live > 6) return;
    const c = this.ctx;
    const n = 2 + Math.floor(Math.random() * 2);
    let at = t;
    for (let i = 0; i < n; i++) {
      const dur = 0.28 + Math.random() * 0.12;
      const o = c.createOscillator();
      o.type = "triangle";
      const f0 = 1650 + Math.random() * 250;
      o.frequency.setValueAtTime(f0, at);
      o.frequency.exponentialRampToValueAtTime(f0 * 0.64, at + dur);
      const vib = c.createOscillator();
      vib.frequency.value = 6;
      const vd = c.createGain();
      vd.gain.value = 50;
      vib.connect(vd).connect(o.frequency);
      const bp = c.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 1900;
      bp.Q.value = 2.5;
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.04, at + 0.04);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      o.connect(bp).connect(g).connect(this.bed.out);
      o.start(at);
      vib.start(at);
      o.stop(at + dur + 0.02);
      vib.stop(at + dur + 0.02);
      this.live++;
      o.onended = () => {
        this.live--;
        g.disconnect();
      };
      at += dur + 0.12 + Math.random() * 0.25;
    }
  }

  /** A nearer wave breaking on the reef: a swell of brown noise opening up and closing. */
  private wave(t: number): void {
    if (!this.bed || this.live > 6) return;
    const c = this.ctx;
    const s = c.createBufferSource();
    s.buffer = this.brown;
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(250, t);
    lp.frequency.exponentialRampToValueAtTime(1400, t + 0.5);
    lp.frequency.exponentialRampToValueAtTime(300, t + 2.7);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.5);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.7);
    s.connect(lp).connect(g).connect(this.bed.out);
    s.start(t, Math.random() * 3);
    s.stop(t + 2.8);
    this.live++;
    s.onended = () => {
      this.live--;
      g.disconnect();
    };
  }
}

/**
 * A seamless noise loop: brown (integrated, warm) or white. The brown walk
 * is detrended so its end meets its start — no click at the loop point.
 */
function loopNoise(ctx: BaseAudioContext, seconds: number, brown: boolean): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  if (!brown) {
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }
  let b = 0;
  for (let i = 0; i < len; i++) {
    b = (b + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    d[i] = b * 3.5;
  }
  const drift = d[len - 1]! - d[0]!;
  let peak = 0;
  for (let i = 0; i < len; i++) {
    d[i] = d[i]! - (drift * i) / (len - 1);
    peak = Math.max(peak, Math.abs(d[i]!));
  }
  if (peak > 1) for (let i = 0; i < len; i++) d[i] = d[i]! / peak;
  return buf;
}
