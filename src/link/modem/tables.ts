/**
 * Everything both ends of the modem derive from a band at one sample rate:
 * its tones, the transmit oscillator steps, the sync and pilot phases, and
 * each mode's packet geometry, interleaver and scrambler sequences. Built
 * once per band when a ModemCore starts, so switching bands (a reconfigure,
 * or the guest finding the host's plan) never allocates on the audio thread.
 */
import type { BandPlan, BandRole, ModemMode } from "../transport";
import { interleaver } from "./interleave";
import { band, DATA_SYMBOLS, MIN_RATE, pilotPhases, shape, syncPhases, type Band, type Shape, type Timing } from "./params";
import { pnTable } from "./scramble";

export interface BandTables {
  band: Band;
  /** Each tone's step per sample, ω, and 2·cos ω (the oscillator's recurrence). */
  w: Float64Array;
  c2: Float64Array;
  /** Per tone: −ω·TCP, which sets its state at the symbol's start (whole quarter turns: ω·TCP = k·π/2). */
  start: Float64Array;
  pilot: Float64Array;
  sync: Record<ModemMode, Float64Array>;
  shape: Record<ModemMode, Shape>;
  slotOf: Record<ModemMode, Int32Array>;
  /** PN bits per packet index of the superframe, `coded` each. */
  pn: Record<ModemMode, Uint8Array>;
}

export function bandTables(t: Timing, plan: BandPlan, role: BandRole): BandTables {
  const b = band(plan, role);
  const n = b.k.length;
  const w = new Float64Array(n);
  const c2 = new Float64Array(n);
  const start = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = (2 * Math.PI * b.hz[i]!) / t.sr;
    c2[i] = 2 * Math.cos(w[i]!);
    start[i] = -(Math.PI / 2) * (b.k[i]! % 4);
  }
  const fast = shape(plan, "fast");
  const robust = shape(plan, "robust");
  return {
    band: b,
    w,
    c2,
    start,
    pilot: pilotPhases(b.pilots.length),
    sync: { fast: syncPhases(b.T, "fast"), robust: syncPhases(b.T, "robust") },
    shape: { fast, robust },
    slotOf: { fast: interleaver(fast), robust: interleaver(robust) },
    pn: { fast: pnTable(DATA_SYMBOLS / fast.P, fast.coded), robust: pnTable(DATA_SYMBOLS / robust.P, robust.coded) }
  };
}

export const bandKey = (plan: BandPlan, role: BandRole): string => `${plan}:${role}`;

/** Tables for every band the rate supports (the high plan needs 44.1 kHz or more). */
export function allBandTables(t: Timing): Map<string, BandTables> {
  const m = new Map<string, BandTables>();
  for (const plan of ["high", "low"] as const) {
    if (t.sr < MIN_RATE[plan]) continue;
    for (const role of ["host", "guest"] as const) m.set(bandKey(plan, role), bandTables(t, plan, role));
  }
  return m;
}
