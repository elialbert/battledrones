/**
 * The interleaver (SOUND-DUEL.md "The modem" > Transmitter): coded bit j
 * goes to symbol s = j mod P, data tone t = (A·q + B·s) mod T and bit-in-tone
 * floor(q / T), where q = floor(j / P). Neighbouring coded bits therefore land
 * on different symbols and on tones far apart, so a faded tone or an echo-hit
 * symbol costs the Viterbi decoder scattered bits rather than a burst.
 *
 * A slot is a (symbol, data tone, bit) position, numbered symbol-major:
 * slot = (s·T + t)·b + bit. The scrambler runs in slot order.
 */
import type { Shape } from "./params";

/** slotOf[j]: the slot that coded bit j occupies. A bijection on 0…P·T·b − 1. */
export function interleaver(sh: Pick<Shape, "P" | "T" | "b" | "ilA" | "ilB">): Int32Array {
  const { P, T, b, ilA, ilB } = sh;
  const n = P * T * b;
  const slotOf = new Int32Array(n);
  for (let j = 0; j < n; j++) {
    const s = j % P;
    const q = Math.floor(j / P);
    const t = (ilA * q + ilB * s) % T;
    const bit = Math.floor(q / T);
    slotOf[j] = (s * T + t) * b + bit;
  }
  return slotOf;
}
