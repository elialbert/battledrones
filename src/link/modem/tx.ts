/**
 * The transmitter (SOUND-DUEL.md "The modem" > Transmitter). Its timeline is
 * the AudioWorklet's frame counter: symbols start on frames that are whole
 * multiples of the symbol length, so a jump in the counter (frames the audio
 * thread never rendered) skips samples instead of delaying everything after
 * it, and the peer sees a dropout rather than a shifted stream.
 *
 * Each symbol is the band's tones at equal amplitude over prefix + useful
 * part, from a persistent oscillator bank: a tone's state is set once at its
 * symbol's start and stepped sample by sample, so a block's output is exactly
 * that block's samples whatever the block size. A symbol runs on for TW
 * samples into the next one's prefix while the next fades in (raised
 * cosine), which keeps the spectrum tight at the symbol edges.
 *
 * Phases change differentially: pilots never change, a sync symbol puts
 * pattern A (the superframe is robust) or B (fast) on the data tones, and the
 * data symbols after it add 0/π (robust) or Gray-coded quarter turns (fast)
 * to each data tone.
 *
 * Payloads. The transmitter holds a list of up to MAX_PAYLOADS frames, each
 * with a key, and every packet latches one at its first symbol: the first
 * whose key is greater than the last key sent, wrapping to the first
 * (transport.ts nextFrameIndex, the rule every transport shares). The last
 * key sent outlives the list, so a new list continues the rotation by key
 * rather than starting over: a segment that was just sent waits its turn
 * even if the list around it changed. A payload longer than the band on air
 * carries (a list set before a switch to the low plan) is never cut to fit:
 * a cut frame would pass its CRC as something nobody sent. Its packet goes
 * out as zeros instead, and the rotation moves on past it.
 */
import { nextFrameIndex, type BandPlan, type BandRole, type ModemMode, type OutFrame } from "../transport";
import { convEncode } from "./conv";
import { CRC_INIT, crc16 } from "./crc";
import { CLIP, CRC_BITS, SUPERFRAME_SYMBOLS, toneAmplitude, type Shape, type Timing } from "./params";
import { bandKey, type BandTables } from "./tables";

/**
 * One oscillator bank: a symbol's tone states. Each tone is a real
 * second-order recurrence, y[n+1] = 2cos(ω)·y[n] − y[n−1], which produces
 * A·cos(ωn + θ) for one multiply a sample (a complex rotation takes four).
 */
class Bank {
  on = false;
  tb: BandTables | null = null;
  /** y[n] (the next output) and y[n−1] per tone. */
  readonly y1: Float64Array;
  readonly y0: Float64Array;
  constructor(max: number) {
    this.y1 = new Float64Array(max);
    this.y0 = new Float64Array(max);
  }
}

/** The most frames a payload list holds: the lockstep sends at most K = 4 segments; the rest is headroom. */
export const MAX_PAYLOADS = 8;
/** Room for one payload, one bit per byte (a packet carries at most 188). */
const PAYLOAD_ROOM = 256;

/** Gray map of a DQPSK bit pair (first bit, second bit) to quarter turns: 00→0, 01→1, 11→2, 10→3. */
const GRAY = [0, 1, 3, 2];

export interface SyncMark {
  /** Frame of the sync's useful part (the start of the 40 ms the receiver correlates). */
  useful: number;
  mode: ModemMode;
}

export class Transmitter {
  private readonly t: Timing;
  private readonly byPlan: Record<BandPlan, Record<BandRole, BandTables | undefined>>;
  private tb: BandTables;
  private gain: number;
  private pendingBand: BandTables | null = null;
  private pendingGain: number | null = null;
  private mode: ModemMode;
  private pendingMode: ModemMode;
  /** Start a superframe (a sync symbol) at the next boundary. */
  private restart = true;
  /** The symbol on air: its start frame and its index in the superframe (0 is the sync). */
  private symStart = 0;
  private j = 0;
  private cur: Bank;
  private prev: Bank;
  /** Absolute phase of every tone in the current symbol (relative to its useful start). */
  private readonly phase: Float64Array;
  private readonly fadeIn: Float64Array;
  private readonly accCur: Float64Array;
  private readonly accPrev: Float64Array;
  /** The payload list: frame i's bits one per byte from i·PAYLOAD_ROOM (zero-padded), its length and its key. */
  private readonly payload = new Uint8Array(MAX_PAYLOADS * PAYLOAD_ROOM);
  private readonly payloadBits = new Int32Array(MAX_PAYLOADS);
  private readonly keys: { key: number }[] = Array.from({ length: MAX_PAYLOADS }, () => ({ key: 0 }));
  /** The first n of `keys` for every n, made once, so the rotation rule reads exactly the list held without one being built per packet. */
  private readonly keyLists: { key: number }[][] = Array.from({ length: MAX_PAYLOADS + 1 }, (_, n) => this.keys.slice(0, n));
  private payloadCount = 0;
  /** The key the last packet carried, once one has (it survives a new list). */
  private lastKey = 0;
  private sentKey = false;
  /** CRC registers for game frames, once the session key is set. */
  private sessionKey: number | null = null;
  // the packet on air
  private readonly info = new Uint8Array(256);
  private readonly coded = new Uint8Array(512);
  private readonly slots = new Uint8Array(512);
  // outputs for ModemCore
  txPackets = 0;
  clips = 0;
  /** Packet starts since the last read: frame, running packet number, and the key of the payload it carries (NaN: none). */
  readonly slotFrames = new Float64Array(64);
  readonly slotIndex = new Float64Array(64);
  readonly slotKey = new Float64Array(64);
  slotCount = 0;
  /** The last few syncs sent (for the self-monitor), newest at (syncHead − 1) mod 8. */
  readonly syncs: SyncMark[] = Array.from({ length: 8 }, () => ({ useful: -Infinity, mode: "robust" as ModemMode }));
  syncHead = 0;

  constructor(t: Timing, bands: Map<string, BandTables>, plan: BandPlan, role: BandRole, gain: number, mode: ModemMode) {
    this.t = t;
    this.byPlan = {
      high: { host: bands.get(bandKey("high", "host")), guest: bands.get(bandKey("high", "guest")) },
      low: { host: bands.get(bandKey("low", "host")), guest: bands.get(bandKey("low", "guest")) }
    };
    this.tb = this.bandOf(plan, role);
    this.gain = gain;
    this.mode = this.pendingMode = mode;
    let max = 0;
    for (const b of bands.values()) max = Math.max(max, b.band.k.length);
    this.cur = new Bank(max);
    this.prev = new Bank(max);
    this.phase = new Float64Array(max);
    this.fadeIn = new Float64Array(t.tw);
    for (let i = 0; i < t.tw; i++) this.fadeIn[i] = 0.5 - 0.5 * Math.cos((Math.PI * (i + 0.5)) / t.tw);
    this.accCur = new Float64Array(1024);
    this.accPrev = new Float64Array(1024);
  }

  private bandOf(plan: BandPlan, role: BandRole): BandTables {
    const b = this.byPlan[plan][role];
    if (!b) throw new Error("no such band at this rate");
    return b;
  }

  /** The mode of the superframe on air. */
  get airMode(): ModemMode {
    return this.mode;
  }

  /** Payload bits per packet in the band on air, or the one it is switching to. */
  capacity(): number {
    return (this.pendingBand ?? this.tb).shape.fast.capacity;
  }

  /**
   * The payload list from the next packet start on. ModemCore has checked it:
   * 1 to MAX_PAYLOADS frames, keys ascending, each nbits within capacity.
   * Copied: the caller's buffers are free once this returns.
   */
  setPayloads(frames: readonly OutFrame[]): void {
    for (let f = 0; f < frames.length; f++) {
      const { bits, nbits, key } = frames[f]!;
      const base = f * PAYLOAD_ROOM;
      for (let i = 0; i < nbits; i++) this.payload[base + i] = (bits[i >> 3]! >> (7 - (i & 7))) & 1;
      this.payload.fill(0, base + nbits, base + PAYLOAD_ROOM);
      this.payloadBits[f] = nbits;
      this.keys[f]!.key = key;
    }
    this.payloadCount = frames.length;
  }

  setMode(mode: ModemMode): void {
    this.pendingMode = mode;
  }

  setSessionKey(key: number | null): void {
    this.sessionKey = key;
  }

  /** From the next symbol boundary: a new band (a new superframe follows) and/or gain. */
  reconfigure(plan: BandPlan, role: BandRole, gain: number): void {
    const b = this.bandOf(plan, role);
    if (b !== this.tb || this.pendingBand) this.pendingBand = b;
    this.pendingGain = gain;
  }

  /**
   * Frames were lost (a jump): what was on air is gone; resume with a sync at
   * the next boundary, in silence until then. (Forgetting the symbol's start
   * matters when the counter went back: the start would lie ahead, and the
   * crossfade would read before its table.)
   */
  jumped(): void {
    this.cur.on = false;
    this.prev.on = false;
    this.restart = true;
    this.symStart = -Infinity;
  }

  /** The frame counter went back: a jump, and the syncs already sent belong to a timeline that is gone. */
  resetTimeline(): void {
    this.jumped();
    for (let i = 0; i < this.syncs.length; i++) this.syncs[i]!.useful = -Infinity;
  }

  /** Output samples out[off … off + len − 1], frames frame … frame + len − 1. */
  process(out: Float32Array, off: number, len: number, frame: number): void {
    const ts = this.t.ts;
    let i = 0;
    while (i < len) {
      const f = frame + i;
      const into = ((f % ts) + ts) % ts;
      if (into === 0) this.boundary(f);
      const end = Math.min(len, i + (ts - into));
      this.render(out, off + i, off + end, f);
      i = end;
    }
  }

  private boundary(f: number): void {
    // the symbol on air fades out over the next TW samples
    const sw = this.prev;
    this.prev = this.cur;
    this.cur = sw;
    this.cur.on = false;
    if (this.pendingGain !== null) {
      this.gain = this.pendingGain;
      this.pendingGain = null;
    }
    if (this.pendingBand) {
      // a new band: the peer has to find it, so it starts with a sync
      this.tb = this.pendingBand;
      this.pendingBand = null;
      this.restart = true;
    }
    if (this.restart) {
      this.restart = false;
      this.j = 0;
    } else {
      this.j = (this.j + 1) % SUPERFRAME_SYMBOLS;
    }
    this.symStart = f;
    const tb = this.tb;
    const b = tb.band;
    if (this.j === 0) {
      this.mode = this.pendingMode;
      const sync = tb.sync[this.mode];
      for (let p = 0; p < b.pilots.length; p++) this.phase[b.pilots[p]!] = tb.pilot[p]!;
      for (let d = 0; d < b.T; d++) this.phase[b.data[d]!] = sync[d]!;
      const m = this.syncs[this.syncHead]!;
      m.useful = f + this.t.cp;
      m.mode = this.mode;
      this.syncHead = (this.syncHead + 1) % this.syncs.length;
    } else {
      const sh = tb.shape[this.mode];
      const idx = this.j - 1;
      const s = idx % sh.P;
      if (s === 0) this.latch(Math.floor(idx / sh.P), f);
      this.modulate(s, sh);
    }
    // the new symbol's oscillator states at its first sample
    const amp = toneAmplitude(b.k.length, this.gain);
    const c = this.cur;
    c.tb = tb;
    c.on = true;
    for (let k = 0; k < b.k.length; k++) {
      const th = this.phase[k]! + tb.start[k]!;
      c.y1[k] = amp * Math.cos(th);
      c.y0[k] = amp * Math.cos(th - tb.w[k]!);
    }
  }

  /**
   * A packet starts: take the next payload in key rotation from the newest
   * list, add the CRC and tail, encode, interleave, scramble. No list yet, or
   * a payload longer than this band carries: all zeros (a type-00 frame,
   * which no layer above accepts), and the slot's key is NaN (none).
   */
  private latch(index: number, f: number): void {
    const tb = this.tb;
    const sh = tb.shape[this.mode];
    const cap = sh.capacity;
    const info = this.info;
    let from = 0;
    let nbits = 0;
    let key = NaN;
    if (this.payloadCount > 0) {
      const i = nextFrameIndex(this.keyLists[this.payloadCount]!, this.sentKey ? this.lastKey : null);
      // its turn is taken either way, so the rotation goes on past a payload that no longer fits
      this.lastKey = this.keys[i]!.key;
      this.sentKey = true;
      if (this.payloadBits[i]! <= cap) {
        from = i * PAYLOAD_ROOM;
        nbits = this.payloadBits[i]!;
        key = this.lastKey;
      }
    }
    for (let i = 0; i < cap; i++) info[i] = i < nbits ? this.payload[from + i]! : 0;
    // a game frame (type 01) uses the session CRC once there is one
    const game = info[0] === 0 && info[1] === 1;
    const crc = crc16(info, cap, game && this.sessionKey !== null ? this.sessionKey : CRC_INIT);
    for (let i = 0; i < CRC_BITS; i++) info[cap + i] = (crc >> (15 - i)) & 1;
    info.fill(0, cap + CRC_BITS, sh.steps);
    convEncode(info, sh.steps, this.coded);
    const slotOf = tb.slotOf[this.mode];
    for (let j = 0; j < sh.coded; j++) this.slots[slotOf[j]!] = this.coded[j]!;
    const pn = tb.pn[this.mode];
    const base = index * sh.coded;
    for (let s = 0; s < sh.coded; s++) this.slots[s] = this.slots[s]! ^ pn[base + s]!;
    if (this.slotCount < this.slotFrames.length) {
      this.slotFrames[this.slotCount] = f;
      this.slotIndex[this.slotCount] = this.txPackets;
      this.slotKey[this.slotCount] = key;
      this.slotCount++;
    }
    this.txPackets++;
  }

  /** Symbol s of the packet: each data tone's phase change from its slot bits. */
  private modulate(s: number, sh: Shape): void {
    const b = this.tb.band;
    const T = sh.T;
    if (sh.b === 1) {
      for (let t = 0; t < T; t++) if (this.slots[s * T + t]) this.phase[b.data[t]!] = this.phase[b.data[t]!]! + Math.PI;
    } else {
      for (let t = 0; t < T; t++) {
        const o = (s * T + t) * 2;
        const q = GRAY[(this.slots[o]! << 1) | this.slots[o + 1]!]!;
        this.phase[b.data[t]!] = this.phase[b.data[t]!]! + (q * Math.PI) / 2;
      }
    }
    for (let t = 0; t < T; t++) {
      const k = b.data[t]!;
      this.phase[k] = this.phase[k]! % (2 * Math.PI);
    }
  }

  /** Output samples i0…i1 − 1 of the block (frames f…), all inside the current symbol. */
  private render(out: Float32Array, i0: number, i1: number, f: number): void {
    const tw = this.t.tw;
    const acc = this.accCur;
    const accP = this.accPrev;
    for (let s = i0; s < i1; ) {
      const m = Math.min(i1 - s, acc.length);
      const off = f + (s - i0) - this.symStart;
      acc.fill(0, 0, m);
      if (this.cur.on) this.run(this.cur, acc, m);
      if (off < tw) {
        // the crossfade: this symbol fades in (from silence, or over the previous one fading out)
        const k = Math.min(m, tw - off);
        const fin = this.fadeIn;
        if (this.prev.on) {
          accP.fill(0, 0, k);
          this.run(this.prev, accP, k);
          for (let i = 0; i < k; i++) acc[i] = fin[off + i]! * acc[i]! + (1 - fin[off + i]!) * accP[i]!;
        } else {
          for (let i = 0; i < k; i++) acc[i] = fin[off + i]! * acc[i]!;
        }
      }
      if (off + m >= tw) this.prev.on = false;
      // clip branch-free (a float set from a constant in a branch gets boxed per sample; see decode.ts)
      for (let i = 0; i < m; i++) {
        const a = acc[i]!;
        const v = Math.min(CLIP, Math.max(-CLIP, a));
        if (v !== a) this.clips++;
        out[s + i] = v;
      }
      s += m;
    }
  }

  /** Add a bank's tones for m samples into acc, stepping its recurrences. */
  private run(bank: Bank, acc: Float64Array, m: number): void {
    const tb = bank.tb!;
    const n = tb.band.k.length;
    const c2 = tb.c2;
    const Y1 = bank.y1;
    const Y0 = bank.y0;
    // four tones at a time: each recurrence is a serial chain, so interleaving them keeps the multiplier busy
    let k = 0;
    for (; k + 3 < n; k += 4) {
      const c0 = c2[k]!;
      const c1 = c2[k + 1]!;
      const c3 = c2[k + 2]!;
      const c4 = c2[k + 3]!;
      let a1 = Y1[k]!;
      let a0 = Y0[k]!;
      let b1 = Y1[k + 1]!;
      let b0 = Y0[k + 1]!;
      let d1 = Y1[k + 2]!;
      let d0 = Y0[k + 2]!;
      let e1 = Y1[k + 3]!;
      let e0 = Y0[k + 3]!;
      for (let i = 0; i < m; i++) {
        acc[i] = acc[i]! + (a1 + b1 + d1 + e1);
        let y = c0 * a1 - a0;
        a0 = a1;
        a1 = y;
        y = c1 * b1 - b0;
        b0 = b1;
        b1 = y;
        y = c3 * d1 - d0;
        d0 = d1;
        d1 = y;
        y = c4 * e1 - e0;
        e0 = e1;
        e1 = y;
      }
      Y1[k] = a1;
      Y0[k] = a0;
      Y1[k + 1] = b1;
      Y0[k + 1] = b0;
      Y1[k + 2] = d1;
      Y0[k + 2] = d0;
      Y1[k + 3] = e1;
      Y0[k + 3] = e0;
    }
    for (; k < n; k++) {
      let y1 = Y1[k]!;
      let y0 = Y0[k]!;
      const c = c2[k]!;
      for (let i = 0; i < m; i++) {
        acc[i] = acc[i]! + y1;
        const y = c * y1 - y0;
        y0 = y1;
        y1 = y;
      }
      Y1[k] = y1;
      Y0[k] = y0;
    }
  }
}
