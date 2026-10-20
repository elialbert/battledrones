/**
 * The scrambler (SOUND-DUEL.md "The modem" > Transmitter): every packet's
 * slots are XORed with a PN sequence, so a zero-padded payload never holds
 * the data tones at one phase (which would raise the crest factor and give
 * the sync search a false pattern to find).
 *
 * A 9-bit Fibonacci LFSR with state bits s1…s9 (s1 the least significant
 * bit of the seed), output s9, feedback s9 ⊕ s5 shifted in at s1 — the
 * primitive x⁹ + x⁵ + 1, period 511. Each packet of a superframe has its own
 * seed, 1 + (37·index mod 511): distinct and never the all-zero lock-up state.
 */

export function pnSeed(packetIndex: number): number {
  return 1 + ((37 * packetIndex) % 511);
}

/** n PN bits (0 or 1) from `seed` into out. */
export function pnBits(seed: number, n: number, out: Uint8Array): void {
  let s = seed & 0x1ff;
  for (let i = 0; i < n; i++) {
    const o = (s >> 8) & 1;
    out[i] = o;
    s = ((s << 1) | (o ^ ((s >> 4) & 1))) & 0x1ff;
  }
}

/** The PN bits of packets 0…count−1, `n` each, back to back. */
export function pnTable(count: number, n: number): Uint8Array {
  const t = new Uint8Array(count * n);
  for (let p = 0; p < count; p++) pnBits(pnSeed(p), n, t.subarray(p * n, (p + 1) * n));
  return t;
}
