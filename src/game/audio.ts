/**
 * Procedural sound effects: every sound is synthesised with WebAudio
 * (filtered noise bursts, oscillator sweeps) — zero audio assets to load.
 * Voices are rate-limited per sound and capped overall so a big battle
 * stays a rumble rather than a wall of clipping noise.
 */

export type SfxName =
  | "cannon" | "heavy" | "mg" | "flak" | "rocket" | "missile" | "laser" | "shell" | "bomb"
  | "explosion" | "bigExplosion" | "build" | "ready" | "click" | "alert" | "heal" | "rank" | "sell"
  | "victory" | "defeat";

const MUTE_KEY = "battledrones.muted";

class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private last = new Map<SfxName, number>();
  private voices = 0;
  muted = false;

  constructor() {
    try {
      this.muted = localStorage.getItem(MUTE_KEY) === "1";
    } catch {
      /* ignore */
    }
  }

  /** Must be called from a user gesture (browsers block autoplay). */
  unlock(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.55;
    // gentle compression glues overlapping battle sounds together
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(this.ctx.destination);
    const len = this.ctx.sampleRate * 2; // 2 s: longer than any sound + its random offset
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.55, this.ctx.currentTime, 0.05);
    try {
      localStorage.setItem(MUTE_KEY, m ? "1" : "0");
    } catch {
      /* ignore */
    }
  }

  /** Play a sound at volume `vol` (0–1, already distance-attenuated by the caller). */
  play(name: SfxName, vol = 1): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.muted || vol < 0.03) return;
    const now = ctx.currentTime;
    const minGap = GAP[name] ?? 0.05;
    if (now - (this.last.get(name) ?? -1) < minGap) return;
    if (this.voices > 14) return;
    this.last.set(name, now);
    const out = ctx.createGain();
    out.gain.value = vol;
    out.connect(this.master);
    this.voices++;
    const dur = RECIPES[name](ctx, out, now, this.noise!);
    setTimeout(() => {
      this.voices--;
      out.disconnect();
    }, (dur + 0.1) * 1000);
  }
}

const GAP: Partial<Record<SfxName, number>> = {
  mg: 0.07, flak: 0.06, cannon: 0.05, laser: 0.06, explosion: 0.06, heal: 0.4, alert: 3, click: 0.02
};

type Recipe = (ctx: AudioContext, out: AudioNode, t: number, noise: AudioBuffer) => number;

function noiseBurst(
  ctx: AudioContext, out: AudioNode, t: number, noise: AudioBuffer,
  dur: number, filter: BiquadFilterType, freq: number, gain: number, freqEnd?: number
): void {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.playbackRate.value = 0.8 + Math.random() * 0.4;
  const f = ctx.createBiquadFilter();
  f.type = filter;
  f.frequency.setValueAtTime(freq, t);
  if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(f).connect(g).connect(out);
  src.start(t, Math.random() * 0.4, dur + 0.05);
}

function tone(
  ctx: AudioContext, out: AudioNode, t: number, type: OscillatorType,
  f0: number, f1: number, dur: number, gain: number, delay = 0
): void {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t + delay);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + delay + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t + delay);
  g.gain.exponentialRampToValueAtTime(gain, t + delay + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + delay + dur);
  o.connect(g).connect(out);
  o.start(t + delay);
  o.stop(t + delay + dur + 0.02);
}

const RECIPES: Record<SfxName, Recipe> = {
  cannon: (c, o, t, n) => {
    noiseBurst(c, o, t, n, 0.12, "lowpass", 2200, 0.5, 300);
    tone(c, o, t, "sine", 160, 50, 0.12, 0.5);
    return 0.15;
  },
  heavy: (c, o, t, n) => {
    noiseBurst(c, o, t, n, 0.3, "lowpass", 1400, 0.8, 120);
    tone(c, o, t, "sine", 110, 32, 0.3, 0.9);
    return 0.32;
  },
  mg: (c, o, t, n) => {
    noiseBurst(c, o, t, n, 0.04, "highpass", 1800, 0.35);
    noiseBurst(c, o, t + 0.06, n, 0.04, "highpass", 1800, 0.3);
    return 0.12;
  },
  flak: (c, o, t, n) => {
    noiseBurst(c, o, t, n, 0.06, "bandpass", 1300, 0.6);
    noiseBurst(c, o, t + 0.08, n, 0.06, "bandpass", 1100, 0.5);
    return 0.16;
  },
  rocket: (c, o, t, n) => {
    noiseBurst(c, o, t, n, 0.28, "bandpass", 600, 0.45, 2400);
    return 0.3;
  },
  missile: (c, o, t, n) => {
    noiseBurst(c, o, t, n, 0.4, "bandpass", 500, 0.4, 3000);
    tone(c, o, t, "triangle", 900, 1500, 0.2, 0.05);
    return 0.42;
  },
  laser: (c, o, t) => {
    tone(c, o, t, "sawtooth", 1400, 180, 0.16, 0.12);
    tone(c, o, t, "sine", 2200, 600, 0.12, 0.12);
    return 0.18;
  },
  shell: (c, o, t, n) => {
    noiseBurst(c, o, t, n, 0.25, "lowpass", 900, 0.8, 80);
    tone(c, o, t, "sine", 90, 40, 0.25, 0.8);
    return 0.28;
  },
  bomb: (c, o, t) => {
    tone(c, o, t, "sine", 1100, 350, 0.35, 0.08);
    return 0.36;
  },
  explosion: (c, o, t, n) => {
    noiseBurst(c, o, t, n, 0.6, "lowpass", 1600, 0.9, 90);
    tone(c, o, t, "sine", 90, 28, 0.45, 0.8);
    return 0.62;
  },
  bigExplosion: (c, o, t, n) => {
    noiseBurst(c, o, t, n, 1.4, "lowpass", 1200, 1, 50);
    noiseBurst(c, o, t + 0.12, n, 1.0, "lowpass", 700, 0.7, 60);
    tone(c, o, t, "sine", 70, 22, 1.1, 1);
    return 1.45;
  },
  build: (c, o, t) => {
    tone(c, o, t, "triangle", 520, 520, 0.12, 0.25);
    tone(c, o, t, "triangle", 780, 780, 0.18, 0.25, 0.1);
    return 0.3;
  },
  ready: (c, o, t) => {
    tone(c, o, t, "sine", 660, 660, 0.1, 0.22);
    tone(c, o, t, "sine", 990, 990, 0.16, 0.22, 0.09);
    return 0.28;
  },
  click: (c, o, t) => {
    tone(c, o, t, "square", 1800, 900, 0.03, 0.06);
    return 0.05;
  },
  alert: (c, o, t) => {
    tone(c, o, t, "square", 880, 880, 0.12, 0.12);
    tone(c, o, t, "square", 660, 660, 0.12, 0.12, 0.16);
    tone(c, o, t, "square", 880, 880, 0.12, 0.12, 0.32);
    return 0.46;
  },
  heal: (c, o, t) => {
    tone(c, o, t, "sine", 700, 1100, 0.25, 0.05);
    return 0.26;
  },
  rank: (c, o, t) => {
    tone(c, o, t, "triangle", 660, 660, 0.1, 0.2);
    tone(c, o, t, "triangle", 880, 880, 0.1, 0.2, 0.08);
    tone(c, o, t, "triangle", 1320, 1320, 0.2, 0.2, 0.16);
    return 0.38;
  },
  sell: (c, o, t) => {
    tone(c, o, t, "triangle", 900, 450, 0.2, 0.2);
    return 0.22;
  },
  victory: (c, o, t) => {
    [523, 659, 784, 1046].forEach((f, i) => tone(c, o, t, "triangle", f, f, 0.35, 0.25, i * 0.14));
    return 1;
  },
  defeat: (c, o, t) => {
    [392, 330, 262, 196].forEach((f, i) => tone(c, o, t, "triangle", f, f * 0.98, 0.4, 0.25, i * 0.2));
    return 1.2;
  }
};

export const sfx = new Sfx();
