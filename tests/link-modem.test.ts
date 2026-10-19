// The acoustic modem end to end (SOUND-DUEL.md "The modem", "Link layer"):
// two ModemCores in the simulated Room, both transmitting at once, each
// hearing its own speaker 40 dB louder than its friend's, through a
// distorting speaker, over game audio, at 44.1 and 48 kHz with their clocks
// 300 ppm apart. Then acquisition, gaps, mode switches, plan detection, the
// self-monitor and self-test, the session CRC, latency, RoomLink and CPU;
// and what a phone's surroundings and its audio thread can throw at it: a
// steady tone in the band, a latency that moves, a frame counter that goes
// back, a non-finite sample, a bad gain.
import { describe, expect, it } from "vitest";
import html from "../radio-probe.html?raw";
import { ModemCore, type ModemConfig, type RxPacket } from "../src/link/modem/core";
import { FFT, selectInPlace } from "../src/link/modem/dsp";
import { ToneWeights } from "../src/link/modem/outlier";
import { CLIP, PACKET_SYMBOLS, SUPERFRAME_SYMBOLS, TS, timing, toneAmplitude } from "../src/link/modem/params";
import { RoomLink } from "../src/link/room-transport";
import { Room, type RoomEndpoint, type RoomOptions } from "../src/link/sim/room";
import type { LinkPacket, ModemMode, OutFrame } from "../src/link/transport";
import { hash32 } from "../src/sim/rand";

const code = /<script id="probe-core">([\s\S]*?)<\/script>/.exec(html)![1]!;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Probe: any = new Function("window", `${code}\nreturn ProbeCore;`)({});

const SUPERFRAME_S = SUPERFRAME_SYMBOLS * TS;

/** A lobby-type frame (10…) carrying a packet counter, then filler that depends on it, `nbits` long. */
function frameOf(k: number, side: number, nbits = 188): Uint8Array {
  const b = new Uint8Array(24);
  b[0] = 0x80 | ((k >>> 24) & 0x3f);
  b[1] = (k >>> 16) & 255;
  b[2] = (k >>> 8) & 255;
  b[3] = k & 255;
  for (let i = 4; i < 24; i++) b[i] = hash32(k, side, i) & 255;
  for (let i = nbits; i < 192; i++) b[i >> 3] = b[i >> 3]! & ~(0x80 >> (i & 7));
  return b;
}
const counterOf = (p: RxPacket) => (((p.bits[0]! & 0x3f) << 24) | (p.bits[1]! << 16) | (p.bits[2]! << 8) | p.bits[3]!) >>> 0;

interface Heard {
  /** True time the receiver's block that delivered it ended. */
  at: number;
  p: RxPacket;
}

/**
 * Two modems (A host, B guest) in a room, each sending a fresh numbered
 * frame in every packet. Records what was sent when, and what arrived.
 */
class Duplex {
  readonly room: Room;
  readonly m: [ModemCore, ModemCore];
  /** Per sender: packet number → [slot frame, slot true time]. */
  readonly sent: [Map<number, [number, number]>, Map<number, [number, number]>] = [new Map(), new Map()];
  /** Per receiver: packet number → when it (first) arrived. */
  readonly heard: [Map<number, Heard>, Map<number, Heard>] = [new Map(), new Map()];
  /** Per receiver: packets whose payload was not what was sent (false accepts). */
  readonly wrong = [0, 0];
  /** Per receiver: packets delivered more than once. */
  readonly dups = [0, 0];
  private readonly k = [0, 0];
  /** Per sender: packet number → the length its frame was set with (a Join detecting the plan offers less than a packet carries). */
  private readonly nbits: [Map<number, number>, Map<number, number>] = [new Map(), new Map()];

  constructor(o: RoomOptions, mode: ModemMode, cfg: [Partial<ModemConfig>, Partial<ModemConfig>] = [{}, {}]) {
    const sr = [o.a?.sampleRate ?? 48000, o.b?.sampleRate ?? 48000];
    const a = new ModemCore({ sampleRate: sr[0]!, plan: "high", tx: "host", rx: "guest", ...cfg[0] });
    const b = new ModemCore({ sampleRate: sr[1]!, plan: "high", tx: "guest", rx: "host", ...cfg[1] });
    this.m = [a, b];
    for (const s of [0, 1] as const) {
      this.m[s].setTxMode(mode);
      this.setFrame(s);
    }
    this.room = new Room(o, a, b);
    this.room.onBlock = (side, f) => this.block(side, f);
  }

  private block(side: 0 | 1, f: number): void {
    const m = this.m[side];
    for (const s of m.takeSlots()) {
      this.sent[side].set(this.k[side]!, [s.sample, this.room.timeOf(side, s.sample)]);
      this.k[side]!++;
      this.setFrame(side);
    }
    const at = this.room.timeOf(side, f + 128);
    for (const p of m.take()) {
      const k = counterOf(p);
      const ref = frameOf(k, 1 - side, Math.min(p.nbits, this.nbits[1 - side]!.get(k) ?? p.nbits));
      if (!p.bits.every((v, i) => v === ref[i] || i >= 24)) this.wrong[side]!++;
      else if (this.heard[side].has(k)) this.dups[side]!++;
      else this.heard[side].set(k, { at, p });
    }
    m.takeGaps();
  }

  /** The sender's next numbered frame, as long as its modem takes now. */
  private setFrame(side: 0 | 1): void {
    const m = this.m[side];
    const k = this.k[side]!;
    this.nbits[side].set(k, m.capacity());
    m.setPayload(frameOf(k, side, m.capacity()), m.capacity());
  }

  /** Of the packets `from` started in [t0, t1] (true time), how many the other phone decoded. */
  delivery(from: 0 | 1, t0: number, t1: number): { n: number; ok: number; frac: number } {
    let n = 0;
    let ok = 0;
    for (const [k, [, t]] of this.sent[from]) {
      if (t < t0 || t > t1) continue;
      n++;
      if (this.heard[1 - from]!.has(k)) ok++;
    }
    return { n, ok, frac: n ? ok / n : 0 };
  }

  /** Arrival times at `to` of the packets the other phone started after t (sorted). */
  arrivals(to: 0 | 1, t: number): number[] {
    const out: number[] = [];
    for (const [k, h] of this.heard[to]) if (this.sent[1 - to]!.get(k)![1] > t) out.push(h.at);
    return out.sort((x, y) => x - y);
  }
}

/** A modem whose output reaches the speaker `extra()` frames late: a route whose latency can change. */
function delayedOutput(m: ModemCore, extra: () => number): RoomEndpoint {
  const line = new Float32Array(1 << 16);
  const tmp = new Float32Array(128);
  let w = 0;
  return {
    process(i, o, f) {
      m.process(i, tmp, f);
      const e = extra();
      for (let k = 0; k < o.length; k++) {
        line[(w + k) & 0xffff] = tmp[k]!;
        o[k] = line[(w + k - e) & 0xffff]!;
      }
      w += o.length;
    }
  };
}

/** A modem whose microphone also hears a steady tone. */
function withTone(m: ModemCore, sr: number, hz: number, amp: number): RoomEndpoint {
  return {
    process(i, o, f) {
      for (let k = 0; k < i.length; k++) i[k] = i[k]! + amp * Math.sin((2 * Math.PI * hz * (f! + k)) / sr + 0.3);
      m.process(i, o, f);
    }
  };
}

/**
 * One modem hearing itself through a plain 75 ms loopback (self-test), block
 * by block: `frame` may be moved between calls, and `onBlock` sees each
 * output.
 */
function selfLoop(self: ModemCore, sr: number) {
  const out = new Float32Array(128);
  const inp = new Float32Array(128);
  const delay = new Float32Array(1 << 16);
  const lag = Math.round(0.075 * sr);
  const st = { frame: 0, onBlock: null as ((out: Float32Array) => void) | null };
  const run = (seconds: number) => {
    for (const end = st.frame + seconds * sr; st.frame < end; st.frame += 128) {
      const f = st.frame;
      for (let i = 0; i < 128; i++) inp[i] = 0.3 * delay[(f + i) & 0xffff]! + 1e-4 * Math.sin(f + i);
      self.process(inp, out, f);
      for (let i = 0; i < 128; i++) delay[(f + i + lag) & 0xffff] = out[i]!;
      st.onBlock?.(out);
    }
  };
  return { st, run };
}

describe("the simulated room", () => {
  it(
    "reads like the phones the probe measured: effective SNR 17–31 dB at 10 cm and 9–19 dB at 30 cm",
    () => {
      for (const [dist, lo, hi] of [
        [10, 17, 31],
        [30, 9, 19]
      ] as const) {
        for (const srA of [48000, 44100]) {
          const probe = Probe.render(48000).samples as Float32Array;
          const rec = new Float32Array(Math.ceil((probe.length / 48000 + 2) * srA));
          let w = 0;
          let pos = 0;
          const listener: RoomEndpoint = {
            process(i, o) {
              if (w + i.length <= rec.length) rec.set(i, w);
              w += i.length;
              o.fill(0);
            }
          };
          const player: RoomEndpoint = {
            process(_i, o) {
              for (let k = 0; k < o.length; k++) o[k] = pos < probe.length ? probe[pos++]! : 0;
            }
          };
          const room = new Room({ seed: dist + srA, distanceCm: dist, a: { sampleRate: srA, ppm: 80 }, b: {} }, listener, player);
          room.run(probe.length / 48000 + 1.5);
          const res = Probe.analyze(rec.subarray(0, w), srA);
          expect(res.found).toBe(true);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const eff = res.bands.map((b: any) => Math.min(b.snr, b.evm)) as number[];
          for (const e of eff) {
            expect(e).toBeGreaterThanOrEqual(lo);
            expect(e).toBeLessThanOrEqual(hi);
          }
        }
      }
    },
    90_000
  );
});

describe("two modems through the room, both transmitting", () => {
  // the worst the spec asks for: own path +40 dB with the phones' symbols unaligned, a distorting speaker, game audio
  const hard = (sr: number, ppm: number) => ({ ownDb: 40, jammerDb: -30, sampleRate: sr, ppm });
  const cases: [string, ModemMode, number, number, [number, number, number], number, number][] = [
    // name, mode, distance, seconds, [A's ppm, B's rate, B's ppm], seed, required delivery
    ["robust at 20 cm, 48/48 kHz, +300 ppm", "robust", 20, 30, [0, 48000, 300], 11, 0.99],
    ["robust at 20 cm, 48/44.1 kHz, −300 ppm", "robust", 20, 30, [0, 44100, -300], 12, 0.99],
    ["robust at 40 cm, 48/48 kHz, −300 ppm", "robust", 40, 30, [0, 48000, -300], 13, 0.95],
    ["robust at 40 cm, 48/44.1 kHz, +300 ppm", "robust", 40, 30, [0, 44100, 300], 14, 0.95],
    ["fast at 20 cm, 48/48 kHz, −300 ppm", "fast", 20, 20, [0, 48000, -300], 15, 0.98],
    ["fast at 20 cm, 48/44.1 kHz, +300 ppm", "fast", 20, 20, [0, 44100, 300], 16, 0.98],
    // each phone 300 ppm off, in opposite directions: 600 ppm apart (a 19 kHz pilot turns more than π a symbol)
    ["robust at 20 cm, 48/44.1 kHz, +300 and −300 ppm", "robust", 20, 20, [300, 44100, -300], 17, 0.99]
  ];
  for (const [name, mode, dist, secs, [ppmA, srB, ppmB], seed, need] of cases) {
    it(
      `${name}: ≥ ${need * 100}% of packets both ways, none wrong or twice, within the latency bound`,
      () => {
        const d = new Duplex({ seed, distanceCm: dist, a: hard(48000, ppmA), b: hard(srB, ppmB) }, mode);
        // B's clock against A's (positive: fast)
        const ppm = ((1 + ppmB * 1e-6) / (1 + ppmA * 1e-6) - 1) * 1e6;
        d.room.run(secs);
        const warm = 3;
        for (const from of [0, 1] as const) {
          const r = d.delivery(from, warm, secs - 1);
          expect(r.n).toBeGreaterThan(((secs - warm - 1) / (PACKET_SYMBOLS.high[mode] * TS)) * 0.85);
          expect(r.frac, `${from ? "B→A" : "A→B"} ${r.ok}/${r.n}`).toBeGreaterThanOrEqual(need);
          expect(d.wrong[1 - from]).toBe(0);
          expect(d.dups[1 - from]).toBe(0);
          // latency: packet start → delivered, at most (TS + P·TS) + one block + the room's delay
          const to = (1 - from) as 0 | 1;
          const P = PACKET_SYMBOLS.high[mode];
          for (const [k, h] of d.heard[to]) {
            const [frame, t] = d.sent[from].get(k)!;
            if (t < warm) continue;
            const roomDelay = d.room.timeOf(to, d.room.arrival(from, frame)) - t;
            expect(h.at - t).toBeLessThanOrEqual(TS + P * TS + 128 / d.room.sampleRate(to) + roomDelay + 1e-9);
          }
        }
        // the clock estimate found the skew
        const st = d.m[0].stats();
        expect(st.locked).toBe(true);
        expect(Math.abs(st.clockPpm! - ppm)).toBeLessThan(10);
        expect(Math.abs(d.m[1].stats().clockPpm! + ppm)).toBeLessThan(10);
        // at gain 1 a clip a minute or so is the multitone's own peaks (see the clip test below)
        expect(st.clips).toBeLessThanOrEqual(1);
      },
      120_000
    );
  }

  it(
    "acquires from 50 random starts and never locks off the true timing",
    () => {
      for (let trial = 0; trial < 50; trial++) {
        const start = (hash32(trial, 77) / 2 ** 32) * SUPERFRAME_S * 1000;
        const d = new Duplex({ seed: 200 + trial, distanceCm: 40, a: { ...hard(48000, 0), startMs: 1000 + start }, b: { ...hard(44100, 150), startMs: 0 } }, "robust");
        // run until A hears its first packet (at most a superframe and a half after it starts)
        let first: [number, Heard] | null = null;
        for (let t = 0; t < 1 + start / 1000 + 1.5 * SUPERFRAME_S + 1 && !first; t += 0.1) {
          d.room.run(0.1);
          for (const e of d.heard[0]) first = first && first[1].at <= e[1].at ? first : e;
        }
        expect(first, `trial ${trial} never locked`).not.toBeNull();
        const [k, h] = first!;
        const [frame] = d.sent[1].get(k)!;
        // the packet's first DFT window: its useful start as A hears the direct sound, less the back-off
        const expected = d.room.arrival(1, frame + timing(44100).cp) - timing(48000).backoff;
        expect(Math.abs(h.p.sample - expected), `trial ${trial}`).toBeLessThan(0.001 * 48000);
      }
    },
    180_000
  );

  it(
    "recovers within one superframe when the sender's frame counter jumps 40 ms or 700 ms",
    () => {
      for (const ms of [40, 700]) {
        const d = new Duplex({ seed: 30 + ms, distanceCm: 20, a: { ownDb: 30 }, b: { ownDb: 30, ppm: 150 } }, "robust");
        d.room.run(5);
        const t = d.room.time;
        d.room.jump(1, ms);
        d.room.run(5);
        const resumed = t + ms / 1000;
        // the friend hears the sender again within a superframe of it coming back
        const a = d.arrivals(0, resumed);
        expect(a.length).toBeGreaterThan(10);
        expect(a[0]! - resumed, `${ms} ms jump`).toBeLessThanOrEqual(SUPERFRAME_S);
        // and the sender, which only lost its input meanwhile, keeps hearing its friend
        const b = d.arrivals(1, resumed);
        expect(b[0]! - resumed).toBeLessThanOrEqual(SUPERFRAME_S);
        expect(d.wrong).toEqual([0, 0]);
      }
    },
    120_000
  );

  it(
    "recovers within 2.5 s of a 1 s capture gap, keeping its timing, and reports the gap",
    () => {
      const d = new Duplex({ seed: 41, distanceCm: 20, a: { ownDb: 30 }, b: { ownDb: 30, sampleRate: 44100, ppm: -200 } }, "robust");
      const gaps: { sample: number; frames: number }[] = [];
      const block = d.room.onBlock!;
      d.room.onBlock = (side, f) => {
        if (side === 0) gaps.push(...d.m[0].takeGaps());
        block(side, f);
      };
      d.room.run(5);
      const t = d.room.time;
      const syncs = d.m[0].stats().syncs;
      d.room.captureGap(0, 1000);
      d.room.run(6);
      const a = d.arrivals(0, t + 1);
      expect(a[0]! - (t + 1)).toBeLessThanOrEqual(2.5);
      // it kept its lock through the gap (no new acquisition), and said when the gap began and how long it was
      expect(d.m[0].stats().locked).toBe(true);
      expect(d.m[0].stats().syncs).toBeGreaterThan(syncs);
      expect(gaps.length).toBe(2);
      expect(gaps[0]!.frames).toBe(0);
      expect(Math.abs(gaps[1]!.frames - 48000)).toBeLessThanOrEqual(256);
      expect(gaps[1]!.sample).toBe(gaps[0]!.sample);
      // no packet that overlapped the gap was decoded (nor counted bad)
      expect(d.m[0].stats().rxBad).toBe(0);
    },
    60_000
  );

  it(
    "switches mode at the next superframe, and the receiver follows without losing packets",
    () => {
      const d = new Duplex({ seed: 51, distanceCm: 20, a: { ownDb: 35, jammerDb: -30 }, b: { ownDb: 35, jammerDb: -30, ppm: 120 } }, "robust");
      d.room.run(5);
      d.m[1].setTxMode("fast");
      expect(d.m[1].stats().txMode).toBe("robust"); // not before the next superframe
      d.room.run(6);
      expect(d.m[1].stats().txMode).toBe("fast");
      d.m[1].setTxMode("robust");
      d.room.run(6);
      const modes = [...d.heard[0].values()].sort((x, y) => x.at - y.at).map((h) => h.p.mode[0]);
      const runs = modes.join("").replace(/(.)\1+/g, "$1");
      expect(runs).toBe("rfr");
      const r = d.delivery(1, 3, 16);
      expect(r.frac).toBeGreaterThanOrEqual(0.98);
      expect(d.m[0].stats().rxBad).toBe(0);
    },
    60_000
  );

  // the Join may be handed either plan: while it detects, it transmits in the high guest band, clear of both host bands
  for (const [plan, joinPlan] of [
    ["low", "high"],
    ["high", "high"],
    ["low", "low"],
    ["high", "low"]
  ] as const) {
    it(
      `a Join that detects the plan (given "${joinPlan}") finds a host on the ${plan} plan, and moves its own transmission there`,
      () => {
        const seed = 61 + (plan === "low" ? 0 : 1) + (joinPlan === "low" ? 2 : 0);
        const d = new Duplex({ seed, distanceCm: 20, a: { ownDb: 30 }, b: { ownDb: 30, ppm: 90 } }, "robust", [{ plan }, { plan: joinPlan, rx: "detect" }]);
        expect(d.m[1].stats().plan).toBe("high");
        // until it locks it offers what either plan carries: a frame accepted now must fit the plan it finds
        expect(d.m[1].capacity()).toBe(186);
        expect(() => d.m[1].setPayload(frameOf(1, 1), 188)).toThrow(RangeError);
        d.room.run(8);
        const g = d.m[1].stats();
        expect(g.plan).toBe(plan);
        expect(g.locked).toBe(true);
        expect(d.m[1].capacity()).toBe(plan === "high" ? 188 : 186);
        // the host hears the guest in its plan's guest band
        expect(d.m[0].stats().locked).toBe(true);
        expect(d.arrivals(0, 4).length).toBeGreaterThan(5);
        expect(d.wrong).toEqual([0, 0]);
      },
      60_000
    );
  }
});

describe("one phone alone", () => {
  it(
    "the self-monitor hears its own pilots and measures the loopback; a silent speaker fails the route check",
    () => {
      const d = new Duplex({ seed: 71, distanceCm: 20, a: { ownDb: 30, outLatencyMs: 22, inLatencyMs: 53 }, b: { ownDb: 30, outputDb: -100, sampleRate: 44100 } }, "robust");
      d.room.run(6);
      const a = d.m[0].stats();
      expect(a.ownSnrDb!).toBeGreaterThan(25);
      expect(Math.abs(a.loopbackMs! - d.room.loopback(0) * 1000)).toBeLessThan(0.5);
      // B's sound goes nowhere (an earpiece, a headset): it can't hear itself, and neither can A
      const b = d.m[1].stats();
      expect(b.ownSnrDb!).toBeLessThan(10);
      expect(a.locked).toBe(false);
    },
    60_000
  );

  it(
    "the self-monitor follows its loopback when the route's latency moves, a little or a lot",
    () => {
      const sr = 48000;
      let extra = 0.01 * sr;
      const d = new Duplex({ seed: 5, distanceCm: 20, a: { ownDb: 30 }, b: { ownDb: 30, ppm: 50 } }, "robust");
      d.room.setEndpoint(0, delayedOutput(d.m[0], () => extra));
      const base = d.room.loopback(0) * 1000;
      const check = (ms: number) => {
        const st = d.m[0].stats();
        expect(Math.abs(st.loopbackMs! - (base + ms)), `loopback with ${ms} ms more`).toBeLessThan(0.5);
        expect(st.ownSnrDb!).toBeGreaterThan(25);
      };
      d.room.run(5);
      check(10);
      // within the window around the known loopback: found at the next sync
      extra = 0.03 * sr;
      d.room.run(4.5);
      check(30);
      extra = 0.015 * sr;
      d.room.run(4.5);
      check(15);
      // far outside it: two syncs missed, then the full search finds it again
      extra = 0.09 * sr;
      d.room.run(9);
      check(90);
    },
    60_000
  );

  it(
    "in self-test mode decodes its own packets",
    () => {
      for (const sr of [48000, 44100, 96000, 192000]) {
        const self = new ModemCore({ sampleRate: sr, plan: "high", tx: "guest", rx: "guest" });
        const quiet: RoomEndpoint = { process: (_i, o) => o.fill(0) };
        const room = new Room({ seed: 81, a: { sampleRate: sr, ownDb: 20 } }, self, quiet);
        self.setPayload(new Uint8Array([0x81, 0x23, 0x45]), 24);
        const got: RxPacket[] = [];
        room.onBlock = (side) => {
          if (side === 0) got.push(...self.take());
        };
        room.run(6);
        expect(got.length).toBeGreaterThan(18);
        for (const p of got) expect([...p.bits.slice(0, 4)]).toEqual([0x81, 0x23, 0x45, 0]);
        expect(self.stats().rxBad).toBe(0);
      }
    },
    60_000
  );
});

describe("the session CRC", () => {
  it(
    "game frames pass only between phones holding the same nonces; lobby frames always pass",
    () => {
      const game = new Uint8Array([0x40, 0x12, 0x34]); // type 01
      const lobby = new Uint8Array([0x80, 0x56, 0x78]); // type 10
      // both lock on lobby frames, then pair (or not) and send `frame`
      const run = (keyA: [number, number] | null, keyB: [number, number] | null, frame: Uint8Array) => {
        const a = new ModemCore({ sampleRate: 48000, plan: "high", tx: "host", rx: "guest" });
        const b = new ModemCore({ sampleRate: 48000, plan: "high", tx: "guest", rx: "host" });
        a.setPayload(lobby, 24);
        const room = new Room({ seed: 91, distanceCm: 20 }, a, b);
        const got: RxPacket[] = [];
        room.onBlock = (side) => {
          if (side === 1) got.push(...b.take());
          else a.take();
        };
        room.run(3);
        expect(b.stats().locked).toBe(true);
        if (keyA) a.setSessionKey(...keyA);
        if (keyB) b.setSessionKey(...keyB);
        a.setPayload(frame, 24);
        got.length = 0;
        const bad = b.stats().rxBad;
        room.run(3.5);
        // the packets that started before the switch still carry the old frame
        return { got: got.filter((p) => p.bits[1] === frame[1]), bad: b.stats().rxBad - bad };
      };
      const same = run([1111, 2222], [1111, 2222], game);
      expect(same.got.length).toBeGreaterThan(10);
      expect(same.got.every((p) => p.session)).toBe(true);
      expect(same.bad).toBe(0);
      // another pairing's key (a recording, a second pair of phones): every game frame fails its CRC
      const other = run([1111, 2222], [1111, 2223], game);
      expect(other.got.length).toBe(0);
      expect(other.bad).toBeGreaterThan(10);
      const lob = run([1111, 2222], [3333, 4444], lobby);
      expect(lob.got.length).toBeGreaterThan(10);
      expect(lob.got.every((p) => !p.session)).toBe(true);
      // before any pairing, game frames go out under the default CRC and arrive (session: false)
      const none = run(null, null, game);
      expect(none.got.length).toBeGreaterThan(10);
      expect(none.got.every((p) => !p.session)).toBe(true);
    },
    60_000
  );
});

describe("a steady tone in the receive band (coil whine, a beacon, a harmonic of game audio)", () => {
  // the friend's tone as A hears it at 20 cm (direct-path gain 0.005); its whole band is 20.8 dB over that
  const friendTone = toneAmplitude(120, 1) * 0.005;
  const cases: [string, number, number][] = [
    ["on a data tone, 30 dB over the friend's tone there", 17500, 30],
    ["on a pilot, 30 dB over the friend's tone there", 17575, 30],
    ["between two tones (leaking into a dozen), 20 dB over the friend's", 17512.5, 20]
  ];
  for (const [name, hz, db] of cases) {
    it(
      `${name}: acquired, tracked and decoded as if it weren't there`,
      () => {
        const d = new Duplex({ seed: 21, distanceCm: 20, a: { ownDb: 30 }, b: { ownDb: 30, ppm: 100 } }, "robust");
        d.room.setEndpoint(0, withTone(d.m[0], 48000, hz, friendTone * Math.pow(10, db / 20)));
        d.room.run(12);
        const r = d.delivery(1, 3, 11);
        expect(r.frac, `${r.ok}/${r.n}`).toBeGreaterThanOrEqual(0.98);
        expect(d.wrong[0]).toBe(0);
        // the tone steers neither the clock estimate nor the soft bits
        expect(Math.abs(d.m[0].stats().clockPpm! - 100)).toBeLessThan(10);
      },
      60_000
    );
  }
});

describe("what the audio thread and the phone throw at it", () => {
  it(
    "a friend whose output latency steps 8 ms later, then 6 ms earlier: every packet still arrives, and only once",
    () => {
      const sr = 48000;
      let extra = 0.01 * sr;
      const d = new Duplex({ seed: 9, distanceCm: 20, a: { ownDb: 35, jammerDb: -30 }, b: { ownDb: 35, jammerDb: -30, ppm: 100 } }, "robust");
      d.room.setEndpoint(1, delayedOutput(d.m[1], () => extra));
      d.room.run(6);
      extra = 0.018 * sr;
      d.room.run(7);
      extra = 0.012 * sr;
      d.room.run(7);
      expect(d.dups[0]).toBe(0);
      expect(d.wrong[0]).toBe(0);
      expect(d.delivery(1, 3, 19).frac).toBeGreaterThanOrEqual(0.95);
      expect(d.m[0].stats().locked).toBe(true);
    },
    60_000
  );

  it(
    "a frame counter that goes back (mid-symbol, or by a second): the output stays finite and quiet, and decoding resumes",
    () => {
      const sr = 48000;
      const self = new ModemCore({ sampleRate: sr, plan: "high", tx: "host", rx: "host" });
      self.setPayload(new Uint8Array([0x81]), 8);
      const loop = selfLoop(self, sr);
      let bad = 0;
      let peak = 0;
      loop.st.onBlock = (out) => {
        for (const v of out) {
          if (!Number.isFinite(v)) bad++;
          else peak = Math.max(peak, Math.abs(v));
        }
      };
      loop.run(6);
      const ok0 = self.stats().rxOk;
      expect(ok0).toBeGreaterThan(10);
      for (const back of [3000, 50000]) {
        loop.st.frame -= back;
        const before = self.stats().rxOk;
        loop.run(6);
        expect(self.stats().rxOk, `after going back ${back}`).toBeGreaterThan(before + 10);
      }
      expect(bad).toBe(0);
      expect(peak).toBeLessThanOrEqual(CLIP);
      expect(self.stats().clips).toBe(0);
      expect(self.stats().rxBad).toBe(0);
    },
    60_000
  );

  it(
    "a NaN or an infinity at the microphone is a moment of missing input, not a poison",
    () => {
      const d = new Duplex({ seed: 3, distanceCm: 20, a: { ownDb: 35, jammerDb: -30 }, b: { ownDb: 35, jammerDb: -30, sampleRate: 44100, ppm: 120 } }, "robust");
      const a = d.m[0];
      let inject: number | null = null;
      d.room.setEndpoint(0, {
        process(i, o, f) {
          if (inject !== null) i[5] = inject;
          inject = null;
          a.process(i, o, f);
        }
      });
      d.room.run(5);
      inject = NaN;
      d.room.run(3);
      inject = Infinity;
      d.room.run(3);
      inject = -Infinity;
      d.room.run(3);
      const st = a.stats();
      expect(st.locked).toBe(true);
      expect(Number.isFinite(st.snrDb!)).toBe(true);
      expect(Number.isFinite(st.clockPpm!)).toBe(true);
      expect(Number.isFinite(st.ownSnrDb!)).toBe(true);
      expect(Number.isFinite(st.inputPeak)).toBe(true);
      expect(d.delivery(1, 6, 13).frac).toBeGreaterThanOrEqual(0.9);
      expect(d.wrong[0]).toBe(0);
    },
    60_000
  );

  it("a gain that is NaN keeps the last good one; a negative one is silence; none above 1.5", () => {
    const inp = new Float32Array(128).fill(1e-4);
    const out = new Float32Array(128);
    const frames = new Map<ModemCore, number>();
    const peakOf = (m: ModemCore) => {
      let peak = 0;
      const f0 = frames.get(m) ?? 0;
      for (let f = f0; f < f0 + 48000; f += 128) {
        m.process(inp, out, f);
        for (const v of out) peak = Number.isFinite(v) ? Math.max(peak, Math.abs(v)) : Infinity;
      }
      frames.set(m, f0 + 48000);
      return peak;
    };
    const cfg: ModemConfig = { sampleRate: 48000, plan: "high", tx: "host", rx: "guest" };
    const nan = peakOf(new ModemCore({ ...cfg, gain: NaN }));
    expect(nan).toBeGreaterThan(0.3);
    expect(nan).toBeLessThan(CLIP);
    const half = new ModemCore({ ...cfg, gain: 0.5 });
    const p = peakOf(half);
    half.reconfigure({ gain: NaN });
    expect(peakOf(half)).toBeLessThan(1.3 * p);
    expect(peakOf(new ModemCore({ ...cfg, gain: -1 }))).toBe(0);
    expect(peakOf(new ModemCore({ ...cfg, gain: Infinity }))).toBeLessThanOrEqual(CLIP);
  });

  it(
    "at the default gain the transmitter clips about once a minute at most: both plans, both modes, 20 s of changing payloads each",
    () => {
      // 120 tones at −15 dBFS sum to nearly Gaussian samples (σ ≈ 0.18), so ±0.9 is 5σ: rare at gain 1, not never.
      // (Measured over 60 s: about 0.02 clips a second at gain 1, 0.1 at 1.1, 2 at 1.25 and 30 at 1.5.)
      let clips = 0;
      for (const plan of ["high", "low"] as const) {
        for (const mode of ["robust", "fast"] as const) {
          const m = new ModemCore({ sampleRate: 48000, plan, tx: "guest", rx: "host" });
          m.setTxMode(mode);
          const inp = new Float32Array(128).fill(1e-4);
          const out = new Float32Array(128);
          const bits = new Uint8Array(24);
          let k = 0;
          let peak = 0;
          for (let f = 0; f < 20 * 48000; f += 128) {
            if (m.takeSlots().length > 0) {
              k++;
              for (let i = 0; i < 24; i++) bits[i] = hash32(k, plan.length, i) & 255;
              m.setPayload(bits, m.capacity());
            }
            m.process(inp, out, f);
            for (const v of out) peak = Math.max(peak, Math.abs(v));
          }
          expect(k).toBeGreaterThan(40); // 20 s of packets (the low plan's robust ones are 400 ms long)
          expect(peak).toBeLessThanOrEqual(CLIP);
          clips += m.stats().clips;
        }
      }
      expect(clips).toBeLessThanOrEqual(4);
    },
    60_000
  );
});

describe("DSP pieces", () => {
  it("an FFT run in parts equals one run whole; the in-place select finds the k-th smallest", () => {
    const n = 4096;
    const fft = new FFT(n);
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      re[i] = Math.sin(0.37 * i) + (hash32(i, 1) / 2 ** 32 - 0.5);
      im[i] = Math.cos(1.3 * i);
    }
    const r2 = Float64Array.from(re);
    const i2 = Float64Array.from(im);
    fft.run(re, im, false);
    const P = fft.passes;
    for (const [a, b] of [
      [0, 3],
      [3, 8],
      [8, P]
    ] as const)
      fft.runPasses(r2, i2, false, a, b);
    for (let i = 0; i < n; i++) {
      expect(r2[i]).toBeCloseTo(re[i]!, 9);
      expect(i2[i]).toBeCloseTo(im[i]!, 9);
    }
    for (let trial = 0; trial < 200; trial++) {
      const len = 1 + (hash32(trial, 2) % 300);
      const a = Float64Array.from({ length: len }, (_, i) => (trial % 3 === 0 ? hash32(trial, i) % 5 : hash32(trial, i) / 2 ** 32));
      const sorted = Float64Array.from(a).sort();
      const k = hash32(trial, 3) % len;
      expect(selectInPlace(a, len, k)).toBe(sorted[k]);
    }
  });

  it("a tone counts as interfered only when it stands far over its neighbours, not when the band's level slopes", () => {
    const tw = new ToneWeights(105, 4);
    // a speaker rolling off 15 dB across the band, with ±2 dB of ripple
    for (let i = 0; i < 105; i++) tw.mag[i] = Math.pow(10, (-15 * i) / 104 / 10) * Math.pow(10, (2 * Math.sin(i * 1.7)) / 10);
    let plain = 0;
    for (let i = 0; i < 105; i++) plain += tw.mag[i]!;
    expect(tw.update(105)).toBeCloseTo(plain, 9);
    for (let i = 0; i < 105; i++) expect(tw.gain[i]).toBe(1);
    // one tone 20 dB up: weighted for next to nothing, and no one else touched
    tw.mag[40] = tw.mag[40]! * 100;
    tw.update(105);
    expect(tw.gain[40]!).toBeLessThan(0.01);
    for (let i = 0; i < 105; i++) if (i !== 40) expect(tw.gain[i]).toBe(1);
  });
});

describe("RoomLink", () => {
  it(
    "carries frames both ways as two LinkTransports, each on its own clock",
    () => {
      const link = new RoomLink({ seed: 5, distanceCm: 20, b: { sampleRate: 44100, ppm: 100 } });
      expect(link.a.capacity()).toBe(188);
      expect(() => link.a.send([{ bits: new Uint8Array(24), nbits: 189, key: 0 }])).toThrow(RangeError);
      link.a.send([{ bits: new Uint8Array([0x81, 1, 2, 3]), nbits: 32, key: 0 }]);
      link.b.send([{ bits: new Uint8Array([0x82, 4, 5, 6]), nbits: 32, key: 0 }]);
      let lastA = -1;
      const pa: LinkPacket[] = [];
      const pb: LinkPacket[] = [];
      const slots: number[] = [];
      for (let i = 0; i < 60; i++) {
        link.advance(100);
        const now = link.a.now();
        expect(now).toBeGreaterThan(lastA);
        lastA = now;
        pa.push(...link.a.poll());
        pb.push(...link.b.poll());
        slots.push(...link.a.slots());
      }
      expect(pa.length).toBeGreaterThan(20);
      expect(pb.length).toBeGreaterThan(20);
      expect([...pa[0]!.bits.slice(0, 4)]).toEqual([0x82, 4, 5, 6]);
      expect([...pb[0]!.bits.slice(0, 4)]).toEqual([0x81, 1, 2, 3]);
      for (const p of pa) {
        expect(p.nbits).toBe(188);
        expect(p.at).toBeLessThan(link.a.now());
      }
      // robust packets start 200 ms apart (250 ms across a sync symbol)
      const gaps = slots.slice(1).map((s, i) => Math.round(s - slots[i]!));
      expect(new Set(gaps)).toEqual(new Set([200, 250]));
      const st = link.a.stats();
      expect(st.locked).toBe(true);
      expect(st.rxBad).toBe(0);
      expect(st.sinceRx).toBeLessThan(600);
      expect(st.plan).toBe("high");
      link.b.close();
      link.advance(3000);
      link.a.poll();
      link.advance(3000);
      expect(link.a.poll().length).toBe(0);
    },
    60_000
  );
});

/** A lobby-type frame (10…) naming its key in bits 8–23, then filler that depends on the key: 184 bits. */
function keyed(key: number): OutFrame {
  const bits = new Uint8Array(23);
  bits[0] = 0x80;
  bits[1] = key >> 8;
  bits[2] = key & 255;
  for (let i = 3; i < 23; i++) bits[i] = hash32(key, 99, i) & 255;
  return { bits, nbits: 184, key };
}
/** The key a keyed() frame names, once its filler checks out (-1 otherwise). */
function keyOf(p: LinkPacket): number {
  const key = (p.bits[1]! << 8) | p.bits[2]!;
  const ref = keyed(key).bits;
  return p.nbits === 188 && ref.every((v, i) => p.bits[i] === v) && p.bits[23] === 0 ? key : -1;
}

/**
 * A RoomLink whose host sends keyed frames to the guest: every host packet
 * start with its key (from onSlot), and every packet the guest decoded with
 * the slot it came from, matched by when its first DFT window should reach
 * the guest's microphone (the slot's frame through the room, as the
 * acquisition test above computes it).
 */
function keyedLink(seed: number) {
  const link = new RoomLink({ seed, distanceCm: 20, mode: "fast", b: { sampleRate: 44100, ppm: -150 } });
  const [ta, tb] = [timing(48000), timing(44100)];
  const sent: { key: number | null; ms: number }[] = [];
  link.onSlot = (side, s) => {
    if (side !== 0) return;
    // the guest's RoomLink stamps a packet at its first DFT window, on its own clock
    const at = link.room.arrival(0, s.sample + ta.cp) - tb.backoff;
    sent.push({ key: s.key, ms: (at * 1000) / 44100 });
  };
  const got: { key: number; zero: boolean; sent: { key: number | null; ms: number } | undefined }[] = [];
  const run = (ms: number) => {
    for (let t = 0; t < ms; t += 100) {
      link.advance(100);
      for (const p of link.b.poll()) got.push({ key: keyOf(p), zero: p.bits.every((v) => v === 0), sent: sent.find((x) => Math.abs(x.ms - p.at) < 1) });
    }
  };
  return { link, sent, got, run };
}

/** The keys a list of frames rotates through after a packet carrying `last`, n packets' worth. */
function rotation(keys: number[], last: number | null, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    last = keys.find((k) => last === null || k > last) ?? keys[0]!;
    out.push(last);
  }
  return out;
}

describe("RoomLink: a list of frames in key rotation", () => {
  it(
    "sends one frame per packet, every key in order, cycling; each packet arrives carrying the key its slot named",
    () => {
      const { link, sent, got, run } = keyedLink(21);
      // before any list: packets of zeros (type 00, which no layer above accepts), with no key
      run(1000);
      expect(sent.length).toBeGreaterThan(5);
      expect(sent.every((s) => s.key === null)).toBe(true);
      for (const g of got) expect([g.zero, g.sent?.key]).toEqual([true, null]);
      got.length = 0;
      const before = sent.length;
      link.a.send([keyed(10), keyed(20), keyed(30)]);
      run(8000);
      const keys = sent.slice(before).map((s) => s.key);
      expect(keys.length).toBeGreaterThan(60);
      expect(keys).toEqual(rotation([10, 20, 30], null, keys.length));
      // the guest heard them all, in the same order, each the frame its slot carried (a packet that started
      // before the list, still in the air when it was handed over, carries zeros)
      for (const g of got.filter((g) => g.sent?.key === null)) expect(g.zero).toBe(true);
      const heard = got.filter((g) => g.sent?.key !== null);
      expect(heard.length).toBeGreaterThan(keys.length - 5);
      for (const g of heard) expect(g.key).toBe(g.sent?.key);
      expect(heard.map((g) => g.key)).toEqual(rotation([10, 20, 30], null, heard.length));
    },
    60_000
  );

  it(
    "continues by key when the list is replaced mid-rotation, and keeps the old list when a new one breaks a rule",
    () => {
      const { link, sent, got, run } = keyedLink(22);
      const lists: [number[], number[]] = [
        [5, 25, 35],
        [10, 20]
      ];
      let swaps = 0;
      const slot = link.onSlot!;
      link.onSlot = (side, s) => {
        slot(side, s);
        // right after a packet carrying 20, then after one carrying 35: the next packet takes the new list
        if (side === 0 && ((swaps === 0 && s.key === 20 && sent.length > 30) || (swaps === 1 && s.key === 35))) link.a.send(lists[swaps++]!.map(keyed));
      };
      link.a.send([keyed(10), keyed(20), keyed(30)]);
      run(10000);
      expect(swaps).toBe(2);
      const keys = sent.map((s) => s.key!);
      const i = keys.findIndex((k, j) => k === 20 && j > 30);
      const j = keys.indexOf(35, i);
      // 10 20 30 … up to a 20; then the first keys over 20 in the new list, 25 and 35; then, after 35, the next list wraps to 10
      expect(keys.slice(0, i + 1)).toEqual(rotation([10, 20, 30], null, i + 1));
      expect(keys.slice(i + 1, j + 1)).toEqual([25, 35]);
      expect(keys.slice(j + 1)).toEqual(rotation([10, 20], 35, keys.length - j - 1));
      // the guest heard the same sequence (a packet or two at the start lost to acquisition)
      expect(got.length).toBeGreaterThan(80);
      for (const g of got) expect(g.key).toBe(g.sent?.key);
      const heard = got.map((g) => g.key).join(" ");
      expect(heard).toContain("10 20 25 35 10 20 10 20");
      // a list that breaks a rule throws and leaves the one in place
      const bad: OutFrame[][] = [[], Array.from({ length: 9 }, (_, k) => keyed(k)), [keyed(4), keyed(4)], [keyed(4), keyed(3)], [{ ...keyed(1), nbits: 189 }], [{ ...keyed(1), key: NaN }], [{ bits: new Uint8Array(2), nbits: 17, key: 1 }]];
      for (const list of bad) expect(() => link.a.send(list), JSON.stringify(list.map((f) => [f.key, f.nbits]))).toThrow(RangeError);
      const n = sent.length;
      run(1000);
      expect(sent.slice(n).map((s) => s.key)).toEqual(rotation([10, 20], sent[n - 1]!.key, sent.length - n));
    },
    60_000
  );

  it(
    "never cuts a frame to fit: after a switch to the low plan, one longer than it carries goes out as zeros, and the rotation goes on past it",
    () => {
      // the self-test, so one modem hears its own packets in either plan
      const sr = 48000;
      const self = new ModemCore({ sampleRate: sr, plan: "high", tx: "host", rx: "host" });
      // 188 bits, its last four set: cut to 186 it would still pass its CRC
      const long: OutFrame = { bits: Uint8Array.from([...keyed(1).bits, 0xf0]), nbits: 188, key: 1 };
      const short = keyed(2);
      const kindOf = (p: RxPacket) => {
        const head = (f: OutFrame) => f.bits.slice(0, 23).every((v, i) => p.bits[i] === v);
        if (p.bits.every((v) => v === 0)) return "zeros";
        if (head(short) && p.bits[23] === 0) return "2";
        if (head(long)) return p.nbits === 188 && p.bits[23] === 0xf0 ? "1" : `1 cut to ${p.nbits} bits`;
        return "?";
      };
      const got: { plan: string; kind: string }[] = [];
      const keys: (number | null)[] = [];
      const loop = selfLoop(self, sr);
      loop.st.onBlock = () => {
        for (const p of self.take()) got.push({ plan: p.plan, kind: kindOf(p) });
        for (const s of self.takeSlots()) keys.push(s.key);
      };
      self.setPayloads([long, short]);
      loop.run(5);
      expect(new Set(got.map((g) => g.kind))).toEqual(new Set(["1", "2"]));
      self.reconfigure({ plan: "low" });
      expect(self.capacity()).toBe(186);
      const n = keys.length;
      loop.run(8);
      const low = got.filter((g) => g.plan === "low");
      expect(low.length).toBeGreaterThan(10);
      expect(new Set(low.map((g) => g.kind))).toEqual(new Set(["zeros", "2"]));
      // past the packet or two already latched in the high band, the slots alternate: frame 1's turn (zeros, no key), then 2
      const after = keys.slice(n + 2);
      // (robust on the low plan: five packets a superframe)
      expect(after.length).toBeGreaterThan(14);
      after.forEach((k, i) => expect(k).toBe(i === 0 ? (after[1] === 2 ? null : 2) : after[i - 1] === 2 ? null : 2));
      expect(self.stats().rxBad).toBe(0);
    },
    60_000
  );
});

describe("the modem's CPU and globals", () => {
  it("uses only the AudioWorklet's globals", () => {
    const sources = {
      ...import.meta.glob("../src/link/modem/**/*.ts", { query: "?raw", import: "default", eager: true }),
      ...import.meta.glob("../src/sim/rand.ts", { query: "?raw", import: "default", eager: true })
    } as Record<string, string>;
    expect(Object.keys(sources).length).toBeGreaterThan(10);
    const banned = /\b(performance|setTimeout|setInterval|requestAnimationFrame|self|window|document|location|TextEncoder|TextDecoder|crypto|fetch)\b|import\.meta|\bimport\(|Math\.random/;
    for (const [path, src] of Object.entries(sources)) {
      // code only: no comments, no string literals
      const body = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "")
        .replace(/"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""');
      const hit = banned.exec(body);
      expect(hit, `${path} uses ${hit?.[0]}`).toBeNull();
    }
  });

  it(
    "runs 60 s of a duel with 128-frame blocks under 0.7 ms at p99 (and the room with two modems over 5× real time)",
    () => {
      const d = new Duplex({ seed: 101, distanceCm: 30, a: { ownDb: 40, jammerDb: -30 }, b: { ownDb: 40, jammerDb: -30, sampleRate: 44100, ppm: -250 } }, "fast");
      // time ModemCore A's process() alone
      const a = d.m[0];
      const times: number[] = [];
      const timed: RoomEndpoint = {
        process(i, o, f) {
          const t0 = performance.now();
          a.process(i, o, f);
          times.push(performance.now() - t0);
        }
      };
      d.room.setEndpoint(0, timed);
      d.room.run(2); // warm the JIT
      times.length = 0;
      const t0 = performance.now();
      d.room.run(60);
      const wall = (performance.now() - t0) / 1000;
      times.sort((x, y) => x - y);
      const p99 = times[Math.floor(times.length * 0.99)]!;
      expect(times.length).toBeGreaterThan(22000);
      expect(p99).toBeLessThan(0.7);
      expect(60 / wall).toBeGreaterThan(5);
      // the duel kept going meanwhile
      expect(d.delivery(1, 3, 61).frac).toBeGreaterThan(0.95);
    },
    120_000
  );

  it(
    "process() allocates nothing of its own: a few bytes per block at most (the odd number V8 boxes)",
    async () => {
      const sr = 48000;
      // its own signal through a plain 75 ms loopback (self-test), so it locks, tracks and decodes all along
      const self = new ModemCore({ sampleRate: sr, plan: "high", tx: "host", rx: "host" });
      const out = new Float32Array(128);
      const inp = new Float32Array(128);
      const delay = new Float32Array(4096);
      // three frames in key rotation: the packet start's pick allocates nothing either
      self.setPayloads([1, 2, 3].map((key) => ({ bits: new Uint8Array([0x81, key]), nbits: 16, key })));
      let f = 0;
      const step = () => {
        for (let i = 0; i < 128; i++) inp[i] = 0.3 * delay[(f + i) & 4095]! + 1e-4 * Math.sin(f + i);
        self.process(inp, out, f);
        for (let i = 0; i < 128; i++) delay[(f + i + 3600) & 4095] = out[i]!;
        f += 128;
      };
      // warm up: the JIT, the lock
      while (f < 10 * sr) step();
      self.take();
      // what each 10 s stretch adds to V8's young generation (a stretch a scavenge emptied doesn't count)
      const v8 = (await import(/* @vite-ignore */ "node:v8" as string)) as { getHeapSpaceStatistics(): { space_name: string; space_used_size: number }[] };
      const young = () => v8.getHeapSpaceStatistics().find((x) => x.space_name === "new_space")!.space_used_size;
      let perBlock = Infinity;
      for (let attempt = 0; attempt < 6; attempt++) {
        const h0 = young();
        const end = f + 10 * sr;
        while (f < end) step();
        const h1 = young();
        if (h1 >= h0) perBlock = Math.min(perBlock, (h1 - h0) / ((10 * sr) / 128));
      }
      expect(self.stats().rxOk).toBeGreaterThan(50);
      expect(perBlock, `${perBlock.toFixed(1)} bytes per block`).toBeLessThan(64);
    },
    60_000
  );
});
