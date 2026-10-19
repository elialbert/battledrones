/**
 * RoomLink (SOUND-DUEL.md "Link layer"): two ModemCores — host and guest —
 * in a simulated Room, run in 128-frame blocks, each exposed as the
 * LinkTransport its phone's upper layers would see. It is the real modem
 * end to end, without the browser: what WorkletTransport carries over the
 * AudioWorklet's port, this hands over directly after every block.
 *
 * Clocks: each end's now() is its own phone's frame counter in ms (phones
 * share no clock, and theirs run at their own rate and skew). A packet's
 * `at` is when its first DFT window began on that clock, as
 * WorkletTransport stamps it; slots() are packet starts on the same clock.
 *
 * advance(ms) runs the room that much true time; tests drive it like
 * PacketAir.advance.
 */
import { ModemCore, type ModemConfig } from "./modem/core";
import { Room, type RoomEndpoint, type RoomOptions } from "./sim/room";
import type { BandPlan, LinkPacket, LinkStats, LinkTransport, ModemMode } from "./transport";

export interface RoomLinkOptions extends RoomOptions {
  /** The host's band plan (default high). */
  plan?: BandPlan;
  /** The guest listens for the host's band ("host", the default) or detects the plan, as Join does in the lobby. */
  guestRx?: "host" | "detect";
  /** Both ends' starting transmit mode (default robust). */
  mode?: ModemMode;
  gain?: number;
}

class RoomEnd implements LinkTransport, RoomEndpoint {
  readonly modem: ModemCore;
  private readonly link: RoomLink;
  private readonly side: 0 | 1;
  private readonly sr: number;
  private readonly inbox: LinkPacket[] = [];
  private readonly starts: number[] = [];
  private lastAt: number | null = null;
  closed = false;

  constructor(link: RoomLink, side: 0 | 1, cfg: ModemConfig) {
    this.link = link;
    this.side = side;
    this.sr = cfg.sampleRate;
    this.modem = new ModemCore(cfg);
  }

  process(input: Float32Array, output: Float32Array, frame?: number): void {
    if (this.closed) {
      output.fill(0);
      return;
    }
    this.modem.process(input, output, frame);
    const ms = 1000 / this.sr;
    for (const s of this.modem.takeSlots()) this.starts.push(s.sample * ms);
    for (const p of this.modem.take()) {
      const at = p.sample * ms;
      this.inbox.push({ bits: p.bits, nbits: p.nbits, snrDb: p.snrDb, at, session: p.session });
      this.lastAt = at;
    }
    this.modem.takeGaps();
  }

  capacity(): number {
    return this.modem.capacity();
  }

  send(bits: Uint8Array, nbits: number): void {
    if (this.closed) return;
    this.modem.setPayload(bits, nbits);
  }

  poll(): LinkPacket[] {
    return this.inbox.splice(0);
  }

  slots(): number[] {
    return this.starts.splice(0);
  }

  now(): number {
    return this.link.room.localMs(this.side);
  }

  setMode(mode: ModemMode): void {
    this.modem.setTxMode(mode);
  }

  setSessionKey(hostNonce: number, guestNonce: number): void {
    this.modem.setSessionKey(hostNonce, guestNonce);
  }

  stats(): LinkStats {
    const s = this.modem.stats();
    return {
      locked: s.locked,
      snrDb: s.snrDb,
      rxOk: s.rxOk,
      rxBad: s.rxBad,
      txMode: s.txMode,
      rxMode: s.rxMode,
      sinceRx: this.lastAt === null ? Infinity : Math.max(0, this.now() - this.lastAt),
      ownSnrDb: s.ownSnrDb,
      loopbackMs: s.loopbackMs,
      plan: s.plan
    };
  }

  close(): void {
    this.closed = true;
    this.inbox.length = 0;
    this.starts.length = 0;
  }
}

export class RoomLink {
  /** The host's end and the guest's. */
  readonly a: LinkTransport;
  readonly b: LinkTransport;
  readonly room: Room;
  readonly modems: [ModemCore, ModemCore];

  constructor(o: RoomLinkOptions = {}) {
    const plan = o.plan ?? "high";
    const rate = (s: RoomOptions["a"]) => s?.sampleRate ?? 48000;
    const host = new RoomEnd(this, 0, { sampleRate: rate(o.a), plan, tx: "host", rx: "guest", gain: o.gain });
    const guest = new RoomEnd(this, 1, { sampleRate: rate(o.b), plan, tx: "guest", rx: o.guestRx ?? "host", gain: o.gain });
    if (o.mode) for (const e of [host, guest]) e.modem.setTxMode(o.mode);
    this.a = host;
    this.b = guest;
    this.modems = [host.modem, guest.modem];
    this.room = new Room(o, host, guest);
  }

  /** Run the room `ms` of true time. */
  advance(ms: number): void {
    this.room.run(ms / 1000);
  }

  /** The room's true time (ms). */
  now(): number {
    return this.room.time * 1000;
  }
}
