/**
 * NetTransport: the duel's LinkTransport over the internet, through the
 * battledrones-relay WebSocket server (relay/README.md). The relay pairs two
 * sockets at /<code>/host and /<code>/guest and forwards each message to the
 * other unchanged; it keeps nothing.
 *
 * Everything above the wire is RelayTransport's: the same packets (the
 * frame's bytes, the modem's CRC-16 under the lobby's or the session's key,
 * the sender's mode), the same 100 ms (fast) or 200 ms (robust) packet clock
 * and key rotation. NetTransport hands it a window whose __duelOut sends
 * each packet as one text message, `<nbits> <base64>`, and feeds what
 * arrives to its __duelIn. So the pairing, the session and the lockstep play
 * an online duel exactly as they play the relay smoke's.
 *
 *   const t = new NetTransport({ code, role })
 *   await t.opened         // the first connection, or a NetError
 *
 * The socket is a RelaySocket (src/net/relay-socket.ts): it comes back by itself
 * after a close the relay didn't mean as final, and reconnects a connection
 * that has gone silent; packets lost in between are lost, as on the air, and
 * the lockstep resends what wasn't acknowledged. A message that isn't a
 * packet is dropped unheard.
 *
 * The relay's final close codes end the transport: `stopped` turns true and
 * onError hears why (the lobby shows it). Before the first open, `opened`
 * rejects with a NetError instead, and so it does if no connection opens in
 * OPEN_TIMEOUT_MS (Fly may have to start the relay's machine first).
 */
import { type BandRole, type LinkPacket, type LinkStats, type LinkTransport, type ModemMode, type OutFrame } from "../link/transport";
import { RelayTransport, type RelayWindow } from "./relay-transport";
import { RelaySocket, type NetState, type NetTimers, type SocketLike } from "../net/relay-socket";

export {
  FINAL_CLOSE, NetError, OPEN_TIMEOUT_MS, RELAY_URL, RETRY_MS, ROOM_ALPHABET, ROOM_CODE_LENGTH, STALE_MS, isRoomCode, roomCode,
  type NetState, type NetTimers, type SocketLike
} from "../net/relay-socket";

/** The invite link: this page (its version path included) with `#vs=<code>`. */
export function inviteUrl(loc: Pick<Location, "origin" | "pathname">, code: string): string {
  return `${loc.origin}${loc.pathname}#vs=${code}`;
}

/** The room code in an invite link's fragment (`#vs=K7QM2XP4`), or null. Lower case is read as upper. */
export function parseInvite(hash: string): string | null {
  const m = /^#vs=([0-9a-z]+)$/i.exec(hash.trim());
  const code = m ? m[1]!.toUpperCase() : null;
  return code !== null && /^[0-9A-HJKMNP-TV-Z]{6,16}$/.test(code) ? code : null;
}

export interface NetOptions {
  code: string;
  role: BandRole;
  /** The relay (default RELAY_URL). */
  url?: string;
  /** The socket's constructor (default the browser's WebSocket). */
  socket?: (url: string) => SocketLike;
  /** Monotonic milliseconds (default performance.now). */
  now?: () => number;
  /** Default the window's. */
  timers?: NetTimers;
}

/** A packet as one text message: `<nbits> <base64>` (null: not one). */
function parsePacket(data: string): { nbits: number; base64: string } | null {
  const sp = data.indexOf(" ");
  const nbits = Number(data.slice(0, sp));
  if (sp <= 0 || !Number.isInteger(nbits)) return null;
  return { nbits, base64: data.slice(sp + 1) };
}

export class NetTransport implements LinkTransport {
  readonly code: string;
  readonly role: BandRole;
  readonly url: string;
  /** The first connection: resolves when it opens, rejects with a NetError (a final close, or OPEN_TIMEOUT_MS). */
  readonly opened: Promise<void>;
  onError: ((message: string) => void) | null = null;
  private readonly relay: RelayTransport;
  private readonly win: RelayWindow;
  private readonly socket: RelaySocket;

  constructor(o: NetOptions) {
    this.code = o.code;
    this.role = o.role;
    this.win = { __duelOut: (base64, nbits) => this.socket.send(`${nbits} ${base64}`) };
    const clock = o.now ?? (() => performance.now());
    const timers = o.timers ?? {
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (h: unknown) => clearTimeout(h as number),
      setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
      clearInterval: (h: unknown) => clearInterval(h as number)
    };
    // (the relay transport first: a socket that opens at once may hear a packet before the constructor returns)
    this.relay = new RelayTransport({ role: o.role, win: this.win, now: clock, timers });
    this.socket = new RelaySocket({
      code: o.code,
      role: o.role,
      ...(o.url !== undefined ? { url: o.url } : {}),
      ...(o.socket ? { socket: o.socket } : {}),
      now: clock,
      timers,
      accept: (data) => parsePacket(data) !== null,
      onMessage: (data) => {
        const p = parsePacket(data)!;
        this.win.__duelIn?.(p.base64, p.nbits);
      }
    });
    this.socket.onError = (message) => {
      this.relay.close();
      this.onError?.(message);
    };
    this.url = this.socket.url;
    this.opened = this.socket.opened;
  }

  /** The relay ended it, or it never opened (the lobby: LobbyLink.stopped, set before onError). */
  get stopped(): boolean {
    return this.socket.stopped;
  }

  /** Connections opened so far (the first is 1). */
  get connections(): number {
    return this.socket.connections;
  }

  get state(): NetState {
    return this.socket.state;
  }

  // ---------------------------------------------------------- LinkTransport ---

  capacity(): number {
    return this.relay.capacity();
  }

  send(frames: readonly OutFrame[]): void {
    this.relay.send(frames);
  }

  poll(): LinkPacket[] {
    return this.relay.poll();
  }

  slots(): number[] {
    return this.relay.slots();
  }

  now(): number {
    return this.relay.now();
  }

  setMode(mode: ModemMode): void {
    this.relay.setMode(mode);
  }

  setSessionKey(hostNonce: number, guestNonce: number): void {
    this.relay.setSessionKey(hostNonce, guestNonce);
  }

  stats(): LinkStats {
    return this.relay.stats();
  }

  /** Send what is due (the relay's own timer does; so may a frame loop). */
  tick(): void {
    this.relay.tick();
  }

  close(): void {
    this.relay.close();
    this.socket.close();
  }
}
