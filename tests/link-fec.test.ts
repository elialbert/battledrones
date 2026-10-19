// The sound link's error control (SOUND-DUEL.md "The modem" > Transmitter,
// Decoding): CRC-16 and the session keys, the K = 7 convolutional code with
// its soft Viterbi decoder and agreement gate, the interleaver and the
// scrambler.
import { describe, expect, it } from "vitest";
import { convEncode, gateErrors, gatePasses, Viterbi } from "../src/link/modem/conv";
import { CRC_INIT, crc16, crcKey } from "../src/link/modem/crc";
import { interleaver } from "../src/link/modem/interleave";
import { shape } from "../src/link/modem/params";
import { pnBits, pnSeed } from "../src/link/modem/scramble";
import { hash32 } from "../src/sim/rand";

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const bitsOf = (s: string) => {
  const b: number[] = [];
  for (const ch of s) for (let i = 7; i >= 0; i--) b.push((ch.charCodeAt(0) >> i) & 1);
  return b;
};

describe("CRC-16", () => {
  it("matches the CCITT check values (MSB first, no final XOR)", () => {
    expect(crc16(bitsOf("123456789"), 72, 0xffff)).toBe(0x29b1); // CRC-16/CCITT-FALSE
    expect(crc16(bitsOf("123456789"), 72, 0)).toBe(0x31c3); // CRC-16/XMODEM: same polynomial, register at 0
    expect(crc16(bitsOf("A"), 8, CRC_INIT)).toBe(0xb915);
    expect(crc16([], 0, CRC_INIT)).toBe(0xffff);
  });

  it("derives a session key per transmitting role from both nonces, never 0", () => {
    const h = 1234;
    const g = 5678;
    expect(crcKey("host", h, g)).toBe(hash32(h, g, 7, 0) & 0xffff);
    expect(crcKey("guest", h, g)).toBe(hash32(h, g, 7, 1) & 0xffff);
    expect(crcKey("host", h, g)).not.toBe(crcKey("guest", h, g));
    expect(crcKey("host", h, g)).not.toBe(crcKey("host", h, g + 1));
    // a pair whose hash has zero low bits falls back to 0xFFFF rather than a zero register
    expect(hash32(1316, 15, 7, 0) & 0xffff).toBe(0);
    expect(crcKey("host", 1316, 15)).toBe(0xffff);
  });

  it("a frame sealed under one key fails under another", () => {
    const r = rng(9);
    const bits = Array.from({ length: 188 }, () => (r() < 0.5 ? 1 : 0));
    const a = crc16(bits, 188, crcKey("host", 11, 22));
    expect(crc16(bits, 188, crcKey("host", 11, 22))).toBe(a);
    expect(crc16(bits, 188, crcKey("host", 11, 23))).not.toBe(a);
    expect(crc16(bits, 188, CRC_INIT)).not.toBe(a);
  });
});

describe("convolutional code and Viterbi", () => {
  const steps = 210; // high plan: 188 payload + 16 CRC + 6 tail
  const v = new Viterbi(256);
  const coded = new Uint8Array(2 * steps);
  const soft = new Float64Array(2 * steps);
  const out = new Uint8Array(steps);

  function packet(r: () => number): Uint8Array {
    const info = new Uint8Array(steps);
    for (let i = 0; i < steps - 6; i++) info[i] = r() < 0.5 ? 1 : 0;
    return info;
  }

  it("decodes a clean block exactly, and the gate sees no disagreement", () => {
    const info = packet(rng(1));
    convEncode(info, steps, coded);
    for (let i = 0; i < 2 * steps; i++) soft[i] = coded[i] ? -1 : 1;
    v.decode(soft, steps, out);
    expect([...out]).toEqual([...info]);
    expect(gateErrors(out, steps, soft)).toBe(0);
  });

  it("corrects scattered hard errors", () => {
    const r = rng(2);
    for (let trial = 0; trial < 200; trial++) {
      const info = packet(r);
      convEncode(info, steps, coded);
      for (let i = 0; i < 2 * steps; i++) soft[i] = coded[i] ? -1 : 1;
      // 12 flipped bits, at least 12 coded bits apart (the code's free distance is 10)
      const start = Math.floor(r() * 20);
      for (let e = 0; e < 12; e++) {
        const j = start + e * 32 + Math.floor(r() * 12);
        soft[j] = -soft[j]!;
      }
      v.decode(soft, steps, out);
      expect([...out]).toEqual([...info]);
      expect(gatePasses(gateErrors(out, steps, soft), steps)).toBe(true);
    }
  });

  it("corrects soft noise well below the hard-decision threshold", () => {
    const r = rng(3);
    let failures = 0;
    let gated = 0;
    for (let trial = 0; trial < 500; trial++) {
      const info = packet(r);
      convEncode(info, steps, coded);
      // Eb/N0 ≈ 3.5 dB at rate ½: σ = 0.6 (about 5% raw bit errors)
      for (let i = 0; i < 2 * steps; i++) soft[i] = (coded[i] ? -1 : 1) + 0.6 * Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
      v.decode(soft, steps, out);
      if (out.some((b, i) => b !== info[i])) failures++;
      if (!gatePasses(gateErrors(out, steps, soft), steps)) gated++;
    }
    expect(failures).toBeLessThan(5);
    expect(gated).toBeLessThan(5);
  });

  // a million garbage packets in four parts (each part well inside its timeout on a slow machine)
  for (const part of [0, 1, 2, 3]) {
    it(
      `with the gate and the CRC, accepts none of a million garbage packets (part ${part + 1} of 4)`,
      () => {
        const r = rng(4 + part * 1000);
        const cap = 188;
        let gateStops = 0;
        let accepted = 0;
        for (let n = 0; n < 250_000; n++) {
          // garbage: what a receiver makes of noise, soft values of random sign and size
          for (let i = 0; i < 2 * steps; i++) soft[i] = (r() - 0.5) * 8;
          v.decode(soft, steps, out);
          if (!gatePasses(gateErrors(out, steps, soft), steps)) {
            gateStops++;
            continue;
          }
          let got = 0;
          for (let i = 0; i < 16; i++) got = (got << 1) | out[cap + i]!;
          if (crc16(out, cap, CRC_INIT) === got) accepted++;
        }
        expect(accepted).toBe(0);
        // the gate alone stops nearly all of them (the CRC sees the rest)
        expect(gateStops).toBeGreaterThan(249_700);
      },
      180_000
    );
  }
});

describe("interleaver", () => {
  for (const plan of ["high", "low"] as const) {
    for (const mode of ["fast", "robust"] as const) {
      it(`${plan} ${mode}: a bijection that spreads neighbouring bits over symbols and tones`, () => {
        const sh = shape(plan, mode);
        const slotOf = interleaver(sh);
        expect(sh.coded).toBe(sh.P * sh.T * sh.b);
        expect(new Set(slotOf).size).toBe(sh.coded);
        expect(Math.min(...slotOf)).toBe(0);
        expect(Math.max(...slotOf)).toBe(sh.coded - 1);
        const at = (j: number) => {
          const slot = slotOf[j]!;
          const st = Math.floor(slot / sh.b);
          return { s: Math.floor(st / sh.T), t: st % sh.T };
        };
        const minApart = plan === "high" ? 8 : 4;
        for (let j = 0; j + 12 <= sh.coded; j++) {
          const w = Array.from({ length: 12 }, (_, i) => at(j + i));
          // any 12 consecutive coded bits: distinct tones, every symbol of the packet
          expect(new Set(w.map((x) => x.t)).size).toBe(12);
          expect(new Set(w.map((x) => x.s)).size).toBe(Math.min(12, sh.P));
          // and those sharing a symbol are far apart in frequency
          for (let a = 0; a < 12; a++)
            for (let b = a + 1; b < 12; b++) {
              if (w[a]!.s !== w[b]!.s) continue;
              const d = Math.abs(w[a]!.t - w[b]!.t);
              expect(Math.min(d, sh.T - d)).toBeGreaterThanOrEqual(minApart);
            }
        }
      });
    }
  }

  it("uses the spec's constants: (8, 56) for 105 data tones, (17, 4) for 52", () => {
    expect([shape("high", "fast").ilA, shape("high", "fast").ilB]).toEqual([8, 56]);
    expect([shape("low", "robust").ilA, shape("low", "robust").ilB]).toEqual([17, 4]);
  });
});

describe("scrambler", () => {
  it("gives every packet of a superframe its own non-zero 9-bit seed", () => {
    const seeds = Array.from({ length: 20 }, (_, i) => pnSeed(i));
    expect(new Set(seeds).size).toBe(20);
    for (const s of seeds) {
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThan(512);
    }
    expect(seeds.slice(0, 3)).toEqual([1, 38, 75]);
  });

  it("is a maximal-length sequence (period 511) whose packets' sequences barely correlate", () => {
    const long = new Uint8Array(1100);
    pnBits(1, 1100, long);
    let period = 0;
    for (let p = 1; p <= 600 && !period; p++) {
      let same = true;
      for (let i = 0; i < 500 && same; i++) same = long[i] === long[i + p];
      if (same) period = p;
    }
    expect(period).toBe(511);
    const seqs = Array.from({ length: 20 }, (_, i) => {
      const b = new Uint8Array(420);
      pnBits(pnSeed(i), 420, b);
      return b;
    });
    for (let a = 0; a < 20; a++)
      for (let b = a + 1; b < 20; b++) {
        let c = 0;
        for (let i = 0; i < 420; i++) c += seqs[a]![i] === seqs[b]![i] ? 1 : -1;
        expect(Math.abs(c / 420)).toBeLessThan(0.2);
      }
  });
});
