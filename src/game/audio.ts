/**
 * Procedural sound effects: every sound is synthesised with WebAudio
 * (filtered noise bursts, oscillator sweeps) — zero audio assets to load.
 * Voices are rate-limited per sound and capped overall so a big battle
 * stays a rumble rather than a wall of clipping noise.
 *
 * The engine also owns the shared AudioContext and the mix: three buses
 * (sfx, music, voice) feed one master gain and the glue compressor. The
 * adaptive score (music.ts) and the announcer play into their own buses,
 * each with its own on/off setting, persisted with the master mute.
 */

export type SfxName =
  | "cannon" | "heavy" | "mg" | "flak" | "rocket" | "missile" | "laser" | "shell" | "bomb"
  | "explosion" | "bigExplosion" | "build" | "ready" | "click" | "alert" | "heal" | "rank" | "sell"
  | "victory" | "defeat"
  | "kill" | "lost" | "coin";

export type AudioChannel = "sfx" | "music" | "voice";

/** Player audio settings: a master mute plus one switch per bus. */
export interface AudioSettings {
  muted: boolean;
  music: boolean;
  sfx: boolean;
  voice: boolean;
}

export const AUDIO_SETTINGS_KEY = "battledrones.audio";
/** Pre-music builds stored only a master mute flag here. */
const LEGACY_MUTE_KEY = "battledrones.muted";

/** Parse stored settings (tolerating junk), falling back to the legacy mute flag. */
export function parseAudioSettings(raw: string | null, legacyMuted: string | null = null): AudioSettings {
  const s: AudioSettings = { muted: legacyMuted === "1", music: true, sfx: true, voice: true };
  if (!raw) return s;
  try {
    const o = JSON.parse(raw) as Partial<Record<keyof AudioSettings, unknown>> | null;
    if (o && typeof o === "object")
      for (const k of ["muted", "music", "sfx", "voice"] as const) if (typeof o[k] === "boolean") s[k] = o[k];
  } catch {
    /* corrupt entry: defaults */
  }
  return s;
}

const MASTER_GAIN = 0.55;
/** Bus levels under the master: music ships at 60% so it sits under the battle. */
const BUS_GAIN: Record<AudioChannel, number> = { sfx: 1, music: 0.6, voice: 1 };

/** What the music and voice layers need from the engine once audio is unlocked. */
export interface AudioEngine {
  ctx: AudioContext;
  /** Connect music here: it passes the duck stage and the Music on/off level. */
  musicIn: AudioNode;
  /** Connect announcer lines here (the Voice on/off level). */
  voiceIn: AudioNode;
  /** Shared 2 s white-noise buffer. */
  noise: AudioBuffer;
}

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buses: Record<AudioChannel, GainNode> | null = null;
  /** Music passes through this before its bus level; ducked by big sounds and voice lines. */
  private duckNode: GainNode | null = null;
  private duckUntil = 0;
  private noise: AudioBuffer | null = null;
  private last = new Map<SfxName, number>();
  private voices = 0;
  private readyFns = new Set<(e: AudioEngine) => void>();
  private changeFns = new Set<(s: AudioSettings) => void>();
  private wantUnlock = false;
  readonly settings: AudioSettings;

  constructor() {
    let raw: string | null = null;
    let legacy: string | null = null;
    try {
      raw = localStorage.getItem(AUDIO_SETTINGS_KEY);
      legacy = localStorage.getItem(LEGACY_MUTE_KEY);
    } catch {
      /* ignore */
    }
    this.settings = parseAudioSettings(raw, legacy);
    if (typeof document !== "undefined") {
      // a hidden tab makes no sound and burns no battery; come back on return
      document.addEventListener("visibilitychange", () => {
        if (!this.ctx) return;
        if (document.hidden) void this.ctx.suspend();
        else void this.ctx.resume();
      });
      // Touch browsers only count pointerup/touchend (not pointerdown) as a
      // gesture that may start audio, and iOS can leave the context
      // suspended or "interrupted" after a call or an app switch: on every
      // gesture, create (once asked to) or resume the context until it runs
      const wake = () => {
        if (document.hidden) return;
        // creating the context outside an activating gesture leaves it suspended (and warns)
        const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
        if (ua && !ua.isActive) return;
        if (!this.ctx) {
          if (this.wantUnlock) this.unlock();
        } else if (this.ctx.state !== "running") void this.ctx.resume();
      };
      // the events that count as a user gesture: mouse down, touch/pen up, keys
      for (const ev of ["mousedown", "pointerup", "touchend", "keydown"])
        window.addEventListener(ev, wake, { capture: true, passive: true });
    }
  }

  /** Master mute (one tap): silences every bus. */
  get muted(): boolean {
    return this.settings.muted;
  }

  /** The live engine, once unlock() has created it. */
  get engine(): AudioEngine | null {
    if (!this.ctx || !this.buses || !this.duckNode || !this.noise) return null;
    return { ctx: this.ctx, musicIn: this.duckNode, voiceIn: this.buses.voice, noise: this.noise };
  }

  /** Is this bus audible right now (not muted and switched on)? */
  enabled(ch: AudioChannel): boolean {
    return !this.settings.muted && this.settings[ch];
  }

  /** Start audio on the next user gesture (menu music, a rematch that skipped the menu). */
  unlockOnGesture(): void {
    this.wantUnlock = true;
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
    this.master.gain.value = this.settings.muted ? 0 : MASTER_GAIN;
    // gentle compression glues overlapping battle sounds together
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(this.ctx.destination);
    const bus = (ch: AudioChannel) => {
      const g = this.ctx!.createGain();
      g.gain.value = this.settings[ch] ? BUS_GAIN[ch] : 0;
      g.connect(this.master!);
      return g;
    };
    this.buses = { sfx: bus("sfx"), music: bus("music"), voice: bus("voice") };
    this.duckNode = this.ctx.createGain();
    this.duckNode.connect(this.buses.music);
    const len = this.ctx.sampleRate * 2; // 2 s: longer than any sound + its random offset
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const e = this.engine!;
    for (const fn of this.readyFns) fn(e);
  }

  /** Run `fn` with the engine as soon as audio is unlocked (now, if it already is). */
  onReady(fn: (e: AudioEngine) => void): () => void {
    this.readyFns.add(fn);
    const e = this.engine;
    if (e) fn(e);
    return () => this.readyFns.delete(fn);
  }

  /** Subscribe to settings changes (mute or any bus switch). */
  onChange(fn: (s: AudioSettings) => void): () => void {
    this.changeFns.add(fn);
    return () => this.changeFns.delete(fn);
  }

  setMuted(m: boolean): void {
    this.settings.muted = m;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : MASTER_GAIN, this.ctx.currentTime, 0.05);
    this.saved();
  }

  /** Switch one bus (Music / SFX / Voice) on or off. */
  setChannel(ch: AudioChannel, on: boolean): void {
    this.settings[ch] = on;
    if (this.buses && this.ctx) this.buses[ch].gain.setTargetAtTime(on ? BUS_GAIN[ch] : 0, this.ctx.currentTime, 0.08);
    this.saved();
  }

  private saved(): void {
    try {
      localStorage.setItem(AUDIO_SETTINGS_KEY, JSON.stringify(this.settings));
      localStorage.removeItem(LEGACY_MUTE_KEY);
    } catch {
      /* ignore */
    }
    for (const fn of this.changeFns) fn(this.settings);
  }

  /**
   * Duck the music by `db` decibels for `seconds` (then recover over ~0.4 s):
   * big explosions, alarms and announcer lines cut through the score.
   */
  duck(db: number, seconds: number): void {
    const ctx = this.ctx;
    const node = this.duckNode;
    if (!ctx || !node) return;
    const now = ctx.currentTime;
    const g = node.gain;
    const level = Math.pow(10, -Math.abs(db) / 20);
    // a deeper or longer duck may extend a running one, never cut it short
    const until = Math.max(this.duckUntil, now + seconds);
    this.duckUntil = until;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.setTargetAtTime(Math.min(level, g.value), now, 0.03);
    g.setTargetAtTime(1, until, 0.4);
  }

  /**
   * Play a sound at volume `vol` (0–1, already distance-attenuated by the
   * caller). `pitch` scales the recipe's frequencies where it supports it.
   */
  play(name: SfxName, vol = 1, pitch = 1): void {
    const ctx = this.ctx;
    if (!ctx || !this.buses || !this.enabled("sfx") || vol < 0.03) return;
    const now = ctx.currentTime;
    const minGap = GAP[name] ?? 0.05;
    if (now - (this.last.get(name) ?? -1) < minGap) return;
    // feedback cues keep two reserved voices so a loud battle can't swallow them
    if (this.voices > (PRIORITY.has(name) ? 16 : 14)) return;
    this.last.set(name, now);
    const duck = DUCKS[name];
    if (duck && vol >= 0.25) this.duck(duck[0] * Math.min(1, vol), duck[1]);
    const out = ctx.createGain();
    out.gain.value = vol;
    out.connect(this.buses.sfx);
    this.voices++;
    const dur = RECIPES[name](ctx, out, now, this.noise!, pitch);
    setTimeout(() => {
      this.voices--;
      out.disconnect();
    }, (dur + 0.1) * 1000);
  }
}

/** Sounds that duck the music: [dB, seconds]. */
const DUCKS: Partial<Record<SfxName, [number, number]>> = {
  bigExplosion: [6, 0.6],
  alert: [5, 0.6],
  victory: [6, 1.2],
  defeat: [6, 1.2]
};

const GAP: Partial<Record<SfxName, number>> = {
  mg: 0.07, flak: 0.06, cannon: 0.05, laser: 0.06, explosion: 0.06, heal: 0.4, alert: 3, click: 0.02,
  kill: 0.08, lost: 0.08, coin: 0.1
};

/** Short feedback cues that may use the reserved voices above the battle cap. */
const PRIORITY = new Set<SfxName>(["kill", "lost", "coin", "alert"]);

type Recipe = (ctx: AudioContext, out: AudioNode, t: number, noise: AudioBuffer, pitch: number) => number;

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
  },
  // an enemy died where you can see it: a bright two-note "ting" over a metal crunch
  kill: (c, o, t, n) => {
    noiseBurst(c, o, t, n, 0.06, "highpass", 2600, 0.25);
    tone(c, o, t, "sine", 1600, 1580, 0.09, 0.17);
    tone(c, o, t, "sine", 2400, 2380, 0.13, 0.15, 0.04);
    return 0.2;
  },
  // one of yours died: a low power-down whine
  lost: (c, o, t) => {
    const osc = c.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(420, t);
    osc.frequency.exponentialRampToValueAtTime(60, t + 0.35);
    const f = c.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = 900;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.24, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.36);
    osc.connect(f).connect(g).connect(o);
    osc.start(t);
    osc.stop(t + 0.38);
    tone(c, o, t, "sine", 210, 45, 0.34, 0.2);
    return 0.4;
  },
  // scrap delivered: a coin blip whose pitch climbs on a delivery streak
  coin: (c, o, t, _n, p) => {
    tone(c, o, t, "triangle", 1320 * p, 1320 * p, 0.06, 0.1);
    tone(c, o, t, "triangle", 1760 * p, 1760 * p, 0.14, 0.1, 0.04);
    tone(c, o, t, "sine", 3520 * p, 3520 * p, 0.08, 0.025, 0.04);
    return 0.2;
  }
};

export const sfx = new Sfx();
