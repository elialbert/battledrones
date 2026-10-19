/**
 * What the main thread and the modem's AudioWorklet say to each other
 * (SOUND-DUEL.md "Worklet" > Messages), and the name the processor is
 * registered under. Its own tiny module so each side can name the other
 * without loading its code: the main thread never imports worklet.ts (only
 * its URL), and the worklet never imports anything that touches the DOM.
 * Types apart, it holds one string.
 */
import type { GapEvent, ModemStats, RxPacket, SlotEvent } from "./modem/core";
import type { BandPlan, BandRole, ModemMode, OutFrame } from "./transport";

/** The name worklet.ts registers its processor under, and WorkletTransport creates its node by. */
export const MODEM_PROCESSOR = "battledrones-modem";

/** Main thread → worklet. */
export type ToWorklet =
  /** The frames packets carry from the next packet start on, in key rotation (ModemCore.setPayloads). */
  | { t: "payload"; frames: OutFrame[] }
  /** The transmit mode from the next superframe. */
  | { t: "mode"; mode: ModemMode }
  /** Enable the session CRC. */
  | { t: "session"; hostNonce: number; guestNonce: number }
  /** ModemCore.reconfigure: the fields given change, the rest stay. */
  | { t: "config"; plan?: BandPlan; tx?: BandRole; rx?: BandRole | "detect"; gain?: number }
  /**
   * The context stopped rendering for this many frames' worth of time while
   * the world went on (suspended, interrupted, stalled), a whole number ≥ 1:
   * from its next block the modem takes them as a jump of its frame counter.
   */
  | { t: "skip"; frames: number }
  /** Stop: process() returns false from the next block on. */
  | { t: "close" };

/**
 * Worklet → main thread. Every `sample` is a frame in the context's
 * currentFrame domain as the context's clock runs now: the modem's own frame
 * less the frames skipped so far, so the main thread maps it to its clock
 * with the context's currentTime alone.
 */
export type FromWorklet =
  | ({ t: "rx" } & RxPacket)
  | ({ t: "slot" } & SlotEvent)
  /** About four a second. */
  | ({ t: "stats" } & ModemStats)
  /** A capture gap: once when it starts (frames 0), once with its length when capture resumes. */
  | ({ t: "gap" } & GapEvent)
  /**
   * The modem could not start (a sample rate it can't use) or stopped (a
   * fault in process()): fatal, nothing more comes from it. Or a message it
   * refused, which changed nothing: not fatal.
   */
  | { t: "error"; message: string; fatal: boolean };
