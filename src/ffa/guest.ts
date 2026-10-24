/**
 * A friend's page in a four-player online battle (FFA.md "A friend"): the
 * "guest" seat of its own relay room, <code><seat>. It says hello (and again
 * on every reconnect, saying what it holds, so the host sends on from there),
 * picks an opener in the lobby, and once the battle starts plays the turn
 * log as it arrives. Its orders go to the host numbered, and are sent again
 * until the host's ack covers them. Engine-free: sockets and the clock come
 * in through options.
 */
import type { OpenerId } from "../sim/openers";
import type { Command } from "../sim/types";
import { RelaySocket, type NetTimers, type SocketLike } from "../net/relay-socket";
import { FfaMatch } from "./match";
import {
  FFA_PROTO, LONELY_RETRIES, SEAT_SIDE, chunk, readHostMsg, seatRoom, splitOrder,
  type FfaSetup, type GuestMsg, type HostMsg, type SeatView
} from "./protocol";

/** How often the guest says how far it is (and pings). */
const AT_MS = 500;
/** Orders not acknowledged this long are sent again. */
const RESEND_MS = 1200;
/** No word from the host for this long: it's gone quiet (the HUD says so). */
export const HOST_QUIET_MS = 5000;

export interface GuestOptions {
  code: string;
  seat: number;
  build: string;
  name: string;
  url?: string;
  socket?: (url: string) => SocketLike;
  now?: () => number;
  timers?: NetTimers;
}

export type GuestPhase = "joining" | "lobby" | "playing" | "ended";

export class FfaGuest {
  readonly code: string;
  readonly seat: number;
  phase: GuestPhase = "joining";
  /** The lobby as the host last showed it. */
  lobby: Extract<HostMsg, { t: "lobby" }> | null = null;
  match: FfaMatch | null = null;
  /** Why it ended (the host's end, or the relay's final close). */
  ended: { why: "left" | "desync" | "version" | "started" | "error"; message?: string } | null = null;
  /** The host's last battle is still on its screen: this page waits for its Rematch (the next lobby). */
  hostFinishing = false;
  /** Round trip to the host (ms), from pings. */
  rtt: number | null = null;
  onChange: (() => void) | null = null;
  /** The battle started (or this page rejoined it): the setup to play. */
  onStart: ((setup: FfaSetup) => void) | null = null;
  readonly socket: RelaySocket;
  private readonly clock: () => number;
  private readonly timers: NetTimers;
  private readonly timer: unknown;
  /** Orders sent and not acknowledged, from seq `base`. */
  private unacked: Command[] = [];
  private base = 0;
  private sentAt = -Infinity;
  private heard = -Infinity;
  private pick: OpenerId | null = null;
  private readonly name: string;
  private readonly build: string;

  constructor(o: GuestOptions) {
    this.code = o.code;
    this.seat = o.seat;
    this.name = o.name;
    this.build = o.build;
    this.clock = o.now ?? (() => performance.now());
    this.timers = o.timers ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as number),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (h) => clearInterval(h as number)
    };
    this.socket = new RelaySocket({
      code: seatRoom(o.code, o.seat),
      role: "guest",
      lonelyRetries: LONELY_RETRIES,
      onMessage: (text) => this.receive(text),
      ...(o.url !== undefined ? { url: o.url } : {}),
      ...(o.socket ? { socket: o.socket } : {}),
      now: this.clock,
      timers: this.timers
    });
    this.socket.onOpen = () => this.hello();
    this.socket.onError = (message) => this.end({ why: "error", message });
    this.timer = this.timers.setInterval(() => this.beat(), AT_MS);
  }

  get side() {
    return SEAT_SIDE[this.seat]!;
  }

  /** The seats as the lobby shows them (null before the host's first word). */
  seats(): SeatView[] | null {
    return this.lobby?.seats ?? null;
  }

  /** Has the host gone quiet (its page closed, or the link is down)? */
  hostQuiet(): boolean {
    return this.phase !== "ended" && this.clock() - this.heard > HOST_QUIET_MS;
  }

  setPick(id: OpenerId): void {
    this.pick = id;
    this.post({ t: "pick", opener: id });
  }

  /** Orders given on this page: numbered, sent now and again until acknowledged. */
  orders(cmds: readonly Command[]): void {
    if (!cmds.length || this.phase === "ended") return;
    for (const c of cmds) this.unacked.push(...splitOrder(c));
    this.sendOrders();
  }

  /** Leave (the battle goes on with a stand-in): tell the host, and let the room go. */
  leave(): void {
    if (this.phase === "ended") return;
    this.post({ t: "bye" });
    this.end({ why: "left" }, true);
  }

  /** This page's world drifted from the host's at `tick`: say so (the host ends the battle for everyone). */
  desync(tick: number): void {
    this.post({ t: "desync", tick });
  }

  close(): void {
    this.timers.clearInterval(this.timer);
    this.socket.close();
  }

  // ------------------------------------------------------------- inside ---

  private post(msg: GuestMsg): void {
    this.socket.send(JSON.stringify(msg));
  }

  private hello(): void {
    const m = this.match;
    this.post({ t: "hello", proto: FFA_PROTO, build: this.build, name: this.name, match: m?.setup.id ?? null, have: m ? m.log.length : -1 });
    // (the host may have restarted its lobby: our pick again; and our orders again, from the oldest not acknowledged)
    if (this.pick && !m) this.post({ t: "pick", opener: this.pick });
    this.sentAt = -Infinity;
    this.sendOrders();
  }

  private sendOrders(): void {
    if (!this.unacked.length || this.socket.state !== "open") return;
    let seq = this.base;
    // (the envelope: {"t":"cmd","seq":123456,"c":[…]})
    for (const c of chunk(this.unacked, 36)) {
      this.post({ t: "cmd", seq, c });
      seq += c.length;
    }
    this.sentAt = this.clock();
  }

  /** Twice a second: how far we are, a ping, and orders that seem lost again. */
  private beat(): void {
    if (this.phase === "ended") return;
    const m = this.match;
    if (m) this.post({ t: "at", have: m.log.length, tick: m.world.tick });
    this.post({ t: "ping", at: this.clock() });
    if (this.unacked.length && this.clock() - this.sentAt > RESEND_MS) this.sendOrders();
  }

  private receive(text: string): void {
    const msg = readHostMsg(text);
    if (!msg) return;
    this.heard = this.clock();
    switch (msg.t) {
      case "over":
        if (this.phase === "joining" && !this.hostFinishing) {
          this.hostFinishing = true;
          this.onChange?.();
        }
        return;
      case "lobby":
        if (msg.proto !== FFA_PROTO) return this.end({ why: "version" });
        this.lobby = msg;
        this.hostFinishing = false;
        if (this.phase === "joining") this.phase = "lobby";
        this.onChange?.();
        return;
      case "start": {
        // (a rejoin of the match already held: the log carries on; another one: start over)
        if (this.match?.setup.id === msg.setup.id) return;
        this.match = new FfaMatch(msg.setup);
        this.phase = "playing";
        this.onStart?.(msg.setup);
        this.onChange?.();
        return;
      }
      case "ev": {
        const m = this.match;
        if (!m) return;
        this.ack(msg.ack);
        const have = m.log.length;
        // (in order: skip what we hold already; past a gap, wait: our next "at" brings it again)
        if (msg.from > have) return;
        if (!m.append(msg.e.slice(have - msg.from))) this.end({ why: "desync" });
        return;
      }
      case "pong":
        this.rtt = Math.max(0, this.clock() - msg.at);
        return;
      case "end":
        this.end({ why: msg.why });
        return;
    }
  }

  /** The host holds our orders through seq `ack`. */
  private ack(ack: number): void {
    const n = ack + 1 - this.base;
    if (n <= 0) return;
    this.unacked.splice(0, n);
    this.base += n;
  }

  private end(why: NonNullable<FfaGuest["ended"]>, quiet = false): void {
    if (this.phase === "ended") return;
    this.phase = "ended";
    this.ended = why;
    if (!quiet) this.onChange?.();
    this.timers.setTimeout(() => this.close(), 300);
  }
}
