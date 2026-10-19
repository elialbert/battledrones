/**
 * The sound link's seam (SOUND-DUEL.md "Link layer"): what the lockstep and
 * the pairing see of a link, whatever carries it — the acoustic modem in an
 * AudioWorklet (WorkletTransport), two modems in a simulated room (RoomLink),
 * a frame-level simulation (PacketAir) or a test relay. Types, and the
 * rotation rule every transport shares.
 */

/** "fast": differential QPSK, short packets; "robust": differential BPSK, packets twice as long. Same payload. */
export type ModemMode = "robust" | "fast";
/** "high": host 9.525–12.5 kHz, guest 15.975–18.95 kHz; "low": host 5.025–6.5 kHz, guest 8.025–9.5 kHz. */
export type BandPlan = "high" | "low";
/** Which phone's band: the host's or the guest's. */
export type BandRole = "host" | "guest";

/** Payload bits per packet, the same in both modes. */
export const PAYLOAD_BITS: Record<BandPlan, number> = { high: 188, low: 186 };

/**
 * One frame for the air. A transport holds a list of them and sends one per
 * packet, in key rotation (SOUND-DUEL.md "Segments and rotation"): after a
 * packet carrying key k, the next carries the first frame whose key is greater
 * than k, wrapping to the first. A list of one repeats in every packet.
 */
export interface OutFrame {
  /** MSB-first: bit i is (bits[i >> 3] >> (7 - (i & 7))) & 1. */
  bits: Uint8Array;
  nbits: number;
  /** Ascending within a list (the lockstep uses each segment's start turn). */
  key: number;
}

/** A packet that arrived intact (CRC and Viterbi gate passed). */
export interface LinkPacket {
  /** MSB-first: bit i is (bits[i >> 3] >> (7 - (i & 7))) & 1. */
  bits: Uint8Array;
  nbits: number;
  /** Effective SNR of the packet (dB), when the link measures it. */
  snrDb: number | null;
  /** When it was decoded, on this link's clock (ms). */
  at: number;
  /** It passed the session CRC (a game frame of this pairing), not the default one. */
  session: boolean;
}

export interface LinkStats {
  locked: boolean;
  snrDb: number | null;
  rxOk: number;
  rxBad: number;
  txMode: ModemMode;
  rxMode: ModemMode | null;
  /** Milliseconds since the last good packet (Infinity: none yet). */
  sinceRx: number;
  /** Effective SNR of this phone's own transmission at its own microphone (the route check), dB. */
  ownSnrDb: number | null;
  /** Speaker-to-own-microphone delay (ms). */
  loopbackMs: number | null;
  plan: BandPlan;
}

export interface LinkTransport {
  /** Payload bits per packet (constant for a band plan). */
  capacity(): number;
  /** The frames packets take from now on, one each in key rotation, until replaced. Each nbits ≤ capacity(); keys ascending; at least one. */
  send(frames: readonly OutFrame[]): void;
  /** Packets received since the last call. */
  poll(): LinkPacket[];
  /** Start times of the packets that went out since the last call, on this link's clock (ms). */
  slots(): number[];
  /** Monotonic milliseconds. */
  now(): number;
  /** The transmit mode from the next superframe on. */
  setMode(mode: ModemMode): void;
  /** Turn on the session CRC for game frames (SOUND-DUEL.md "Replay protection"). */
  setSessionKey(hostNonce: number, guestNonce: number): void;
  stats(): LinkStats;
  close(): void;
}

/**
 * Which of `frames` the next packet carries, given the key the previous packet
 * carried (null: none yet): the first whose key is greater, wrapping to the
 * first. Allocation-free, so the AudioWorklet can call it per packet.
 */
export function nextFrameIndex(frames: readonly { key: number }[], lastKey: number | null): number {
  if (lastKey === null) return 0;
  for (let i = 0; i < frames.length; i++) if (frames[i]!.key > lastKey) return i;
  return 0;
}
