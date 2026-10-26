/**
 * RelaySocket: one seat of a battledrones-relay room (relay/README.md), as a
 * WebSocket that comes back by itself. The relay pairs two sockets at
 * /<code>/host and /<code>/guest and forwards each text message to the other
 * unchanged; it keeps nothing. The online duel's NetTransport carries the
 * sound duel's packets over one (src/versus/net-transport.ts); a four-player
 * battle's host holds one per friend's seat (src/ffa/).
 *
 *   const s = new RelaySocket({ code, role, onMessage })
 *   await s.opened         // the first connection, or a NetError
 *   s.send(text)           // lost while there is no open socket
 *
 * A close the relay didn't mean as final (a network change, the relay
 * restarting, a phone that slept) reconnects after 0.25, 0.5, 1, 2, then
 * every 4 s, and the relay gives the seat to the new socket. Messages sent
 * in between are lost, as packets on the air would be: what rides on top
 * resends what wasn't acknowledged. A connection that delivered messages and
 * then has gone silent for STALE_MS is reconnected once (a socket the network
 * dropped without a word looks open for minutes); it is not tried again until
 * something arrives.
 *
 * The relay's final close codes end it: `stopped` turns true and onError
 * hears why. Before the first open, `opened` rejects with a NetError instead,
 * and so it does if no connection opens in OPEN_TIMEOUT_MS (Fly may have to
 * start the relay's machine first).
 */
/** The relay's two seats of a room. */
export type RelayRole = "host" | "guest";

declare const __RELAY_URL__: string | null | undefined;

/** The deployed relay (relay/fly.toml), or the build's own (RELAY_URL at build time: vite.config.ts). */
export const RELAY_URL: string = (typeof __RELAY_URL__ === "undefined" ? null : __RELAY_URL__) ?? "wss://battledrones-relay.fly.dev";

/** Room codes: Crockford base32 (no I, L, O, U), as the relay accepts them. */
export const ROOM_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const ROOM_CODE_LENGTH = 8;
const ROOM_RE = /^[0-9A-HJKMNP-TV-Z]{6,16}$/;

/** A new room code from the platform's CSPRNG (`bytes`: tests). 8 characters, 40 bits: the relay has no other guard against guessing. */
export function roomCode(bytes: Uint8Array = crypto.getRandomValues(new Uint8Array(ROOM_CODE_LENGTH))): string {
  // (32 divides 256: & 31 is unbiased)
  return Array.from(bytes.subarray(0, ROOM_CODE_LENGTH), (b) => ROOM_ALPHABET[b & 31]).join("");
}

export const isRoomCode = (s: unknown): s is string => typeof s === "string" && ROOM_RE.test(s);

/** The relay's final close codes, and what the player is told. */
export const FINAL_CLOSE: Readonly<Record<number, string>> = {
  4000: "The relay didn't accept this room code",
  4001: "This battle was opened again in another tab or on another device",
  4002: "The relay's time limit for one connection ran out",
  4003: "This page isn't allowed to use the relay",
  4010: "Nobody else was in the battle for 10 minutes",
  4013: "The relay is full: try again later"
};

/** The first connection must open within this long. */
export const OPEN_TIMEOUT_MS = 15_000;
/** Reconnect waits, then the last one again and again. */
export const RETRY_MS = [250, 500, 1000, 2000, 4000] as const;
/** A connection that delivered messages and then nothing for this long is reconnected once. */
export const STALE_MS = 6000;

/** What a RelaySocket uses of a WebSocket (the browser's, or a test's). */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface NetTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
}

export interface RelaySocketOptions {
  code: string;
  role: RelayRole;
  /** Each text message from the other seat. */
  onMessage: (data: string) => void;
  /** Is this a message at all? One that isn't is dropped unheard, and doesn't count as hearing from the seat (default: every string). */
  accept?: (data: string) => boolean;
  /** The relay (default RELAY_URL). */
  url?: string;
  /** The socket's constructor (default the browser's WebSocket). */
  socket?: (url: string) => SocketLike;
  /** Monotonic milliseconds (default performance.now). */
  now?: () => number;
  /** Default the window's. */
  timers?: NetTimers;
  /**
   * A socket alone in its room for 10 minutes is closed by the relay (4010);
   * a seat that may wait for a friend longer than that (a lobby) reconnects
   * through it this many times before it ends (default 0: 4010 is final). A
   * bound, so a forgotten tab still lets the relay's machine sleep.
   */
  lonelyRetries?: number;
}

/** Why an online link couldn't be made, or ended (the lobby's "online" error). */
export class NetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetError";
  }
}

/** Where the socket is: the first connection on its way, open, between connections, or ended for good. */
export type NetState = "connecting" | "open" | "retrying" | "ended";

const OPEN = 1;

export class RelaySocket {
  readonly code: string;
  readonly role: RelayRole;
  readonly url: string;
  /** The first connection: resolves when it opens, rejects with a NetError (a final close, or OPEN_TIMEOUT_MS). */
  readonly opened: Promise<void>;
  /** The relay ended it, or it never opened. */
  stopped = false;
  onError: ((message: string) => void) | null = null;
  /** Every connection that opens (the first and each reconnect). */
  onOpen: (() => void) | null = null;
  /** Connections opened so far (the first is 1). */
  connections = 0;
  private readonly onMessage: (data: string) => void;
  private readonly accept: (data: string) => boolean;
  private readonly makeSocket: (url: string) => SocketLike;
  private readonly clock: () => number;
  private readonly timers: NetTimers;
  /** Lonely closes (4010) still to reconnect through. */
  private lonelyLeft: number;
  private ws: SocketLike | null = null;
  private stateNow: NetState = "connecting";
  private retries = 0;
  private retryTimer: unknown = null;
  private openTimer: unknown = null;
  private watchTimer: unknown = null;
  private lastInAt: number | null = null;
  /** A stale connection was reconnected: not again until a message arrives. */
  private staleTried = false;
  private closed = false;
  private resolveOpened!: () => void;
  private rejectOpened!: (e: NetError) => void;

  constructor(o: RelaySocketOptions) {
    if (!isRoomCode(o.code)) throw new NetError(FINAL_CLOSE[4000]!);
    this.code = o.code;
    this.role = o.role;
    this.url = `${o.url ?? RELAY_URL}/${o.code}/${o.role}`;
    this.onMessage = o.onMessage;
    this.accept = o.accept ?? (() => true);
    this.lonelyLeft = o.lonelyRetries ?? 0;
    this.makeSocket = o.socket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.clock = o.now ?? (() => performance.now());
    this.timers = o.timers ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as number),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (h) => clearInterval(h as number)
    };
    this.opened = new Promise<void>((resolve, reject) => {
      this.resolveOpened = resolve;
      this.rejectOpened = reject;
    });
    // (nobody may be awaiting it yet: a rejection is still handled)
    this.opened.catch(() => undefined);
    this.openTimer = this.timers.setTimeout(() => {
      if (this.connections === 0) this.end(`Couldn't reach the relay in ${OPEN_TIMEOUT_MS / 1000} s`);
    }, OPEN_TIMEOUT_MS);
    this.watchTimer = this.timers.setInterval(() => this.watch(), 1000);
    this.connect();
  }

  get state(): NetState {
    return this.stateNow;
  }

  /** Milliseconds since the last message arrived (Infinity: none on this connection yet). */
  sinceIn(): number {
    return this.lastInAt === null ? Infinity : this.clock() - this.lastInAt;
  }

  /** One message. Lost while there is no open socket, as a packet on the air would be. */
  send(data: string): void {
    const ws = this.ws;
    if (ws && ws.readyState === OPEN) ws.send(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stateNow = "ended";
    this.timers.clearTimeout(this.retryTimer);
    this.timers.clearTimeout(this.openTimer);
    this.timers.clearInterval(this.watchTimer);
    this.drop(1000, "bye");
    this.rejectOpened(new NetError("Closed"));
  }

  // ------------------------------------------------------------- inside ---

  private connect(): void {
    if (this.closed) return;
    let ws: SocketLike;
    try {
      ws = this.makeSocket(this.url);
    } catch (e) {
      this.end(e instanceof Error ? e.message : String(e));
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (ws !== this.ws) return;
      this.stateNow = "open";
      this.retries = 0;
      this.connections++;
      this.lastInAt = null;
      if (this.connections === 1) this.resolveOpened();
      this.onOpen?.();
    };
    ws.onmessage = (ev) => {
      if (ws !== this.ws) return;
      this.receive(ev.data);
    };
    ws.onclose = (ev) => {
      if (ws !== this.ws) return;
      this.ws = null;
      const lonelyRetry = ev.code === 4010 && this.lonelyLeft > 0;
      if (lonelyRetry) this.lonelyLeft--;
      const final = lonelyRetry ? undefined : FINAL_CLOSE[ev.code];
      if (final) this.end(final);
      else this.retry();
    };
    // (an error is always followed by a close)
    ws.onerror = () => undefined;
  }

  private retry(): void {
    if (this.closed) return;
    this.stateNow = this.connections === 0 ? "connecting" : "retrying";
    const wait = RETRY_MS[Math.min(this.retries, RETRY_MS.length - 1)]!;
    this.retries++;
    this.retryTimer = this.timers.setTimeout(() => this.connect(), wait);
  }

  /** A connection that brought messages and has gone quiet may be dead without knowing it: start a new one, once. */
  private watch(): void {
    if (this.closed || this.stateNow !== "open" || this.lastInAt === null || this.staleTried) return;
    if (this.clock() - this.lastInAt < STALE_MS) return;
    this.staleTried = true;
    this.drop(4500, "stale");
    this.retry();
  }

  /** Let the current socket go without hearing from it again. */
  private drop(code: number, reason: string): void {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try {
      ws.close(code, reason);
    } catch {
      /* already closing */
    }
  }

  private end(message: string): void {
    if (this.closed) return;
    this.stopped = true;
    // (before close(), whose own rejection would win)
    this.rejectOpened(new NetError(message));
    this.close();
    this.onError?.(message);
  }

  private receive(data: unknown): void {
    if (typeof data !== "string" || !this.accept(data)) return;
    this.lastInAt = this.clock();
    this.staleTried = false;
    this.onMessage(data);
  }
}
