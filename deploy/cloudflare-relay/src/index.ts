/**
 * The Battle Drones relay as a Cloudflare Worker: the same protocol as
 * relay/server.py (see relay/README.md), for this fork's pages at
 * battledrones.elialbert.com.
 *
 *     GET /health                 200 "ok"
 *     WS  /<code>/<seat>          join room <code> as seat "host" or "guest"
 *
 * Each room is one Durable Object (named by its code), so both seats of a
 * room always meet in the same place. It forwards each message to the other
 * seat verbatim, and drops it if that seat is empty. Sockets are accepted
 * with the Hibernation API: an idle room costs nothing, and everything it
 * must remember lives in each socket's attachment and in storage.
 *
 * Close codes are relay/server.py's:
 *     4000  bad path            4001  replaced by a newer socket for the seat
 *     4002  open too long       4003  origin not allowed
 *     4008  sending too fast    4010  alone in the room too long
 * (4013 "relay full" never happens: rooms don't share a machine.)
 */
import { DurableObject } from "cloudflare:workers";

const PATH = /^\/([0-9A-HJKMNP-TV-Z]{6,16})\/(host|guest)$/;
// This fork's pages only (the Python relay's list is simonw's)
const ORIGIN = /^https:\/\/battledrones\.elialbert\.com$/;
// Packets are ~40 bytes of base64 and go out every 100-200 ms per seat
const MAX_MESSAGE_BYTES = 1024;
const RATE_PER_SECOND = 50;
const BURST = 100;
const LONELY_MS = 600_000;
const MAX_AGE_MS = 7_200_000;

type Seat = "host" | "guest";

/** What a socket remembers across hibernation. */
interface Attachment {
  seat: Seat;
  opened: number;
  /** Rate limit: a token bucket. */
  tokens: number;
  last: number;
  /** Closed by the relay (replaced, too fast, alone or open too long): no longer in its seat. */
  evicted?: boolean;
}

const other = (seat: Seat): Seat => (seat === "host" ? "guest" : "host");

/** Answer the upgrade, then close at once with `code`: the page hears why, as from the Python relay. */
function refuse(code: number, reason: string): Response {
  const [client, server] = Object.values(new WebSocketPair());
  server!.accept();
  server!.close(code, reason);
  return new Response(null, { status: 101, webSocket: client });
}

export default {
  async fetch(request: Request, _env: unknown, ctx: ExecutionContext & { exports: { Room: DurableObjectNamespace<Room> } }): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok\n");
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response("The Battle Drones relay: WebSockets only (see /health)\n", { status: 426 });
    if (!ORIGIN.test(request.headers.get("Origin") ?? "")) return refuse(4003, "origin not allowed");
    const match = PATH.exec(url.pathname);
    if (!match) return refuse(4000, "bad path");
    return ctx.exports.Room.get(ctx.exports.Room.idFromName(match[1]!)).fetch(request);
  }
};

export class Room extends DurableObject {
  /** The sockets in their seats (evicted ones may still be closing). */
  private live(seat?: Seat): WebSocket[] {
    return this.ctx.getWebSockets(seat).filter((ws) => !(ws.deserializeAttachment() as Attachment | null)?.evicted);
  }

  async fetch(request: Request): Promise<Response> {
    const seat = new URL(request.url).pathname.split("/")[2] as Seat;
    const [client, server] = Object.values(new WebSocketPair());
    const now = Date.now();
    // a new room: alone from now
    if (this.live().length === 0) await this.ctx.storage.put("aloneSince", now);
    // the new socket takes the seat straight over: the room stays as full or as lonely as it was
    for (const old of this.live(seat)) {
      old.serializeAttachment({ ...(old.deserializeAttachment() as Attachment), evicted: true });
      try {
        old.close(4001, "replaced");
      } catch {
        /* already closed */
      }
    }
    this.ctx.acceptWebSocket(server!, [seat]);
    server!.serializeAttachment({ seat, opened: now, tokens: BURST, last: now } satisfies Attachment);
    await this.schedule();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const a = ws.deserializeAttachment() as Attachment;
    if (a.evicted) return;
    const bytes = typeof message === "string" ? new TextEncoder().encode(message).length : message.byteLength;
    if (bytes > MAX_MESSAGE_BYTES) return this.evict(ws, 1009, "message too big");
    const now = Date.now();
    a.tokens = Math.min(BURST, a.tokens + ((now - a.last) / 1000) * RATE_PER_SECOND);
    a.last = now;
    if (a.tokens < 1) return this.evict(ws, 4008, "sending too fast");
    a.tokens -= 1;
    ws.serializeAttachment(a);
    for (const peer of this.live(other(a.seat))) {
      try {
        peer.send(message);
      } catch {
        /* (the peer is closing: its own close cleans up) */
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    await this.leave(ws);
    try {
      ws.close(code, reason);
    } catch {
      /* (already closed, or a code that can't be sent back, such as 1005) */
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.leave(ws);
  }

  /** The room's deadlines: a socket open MAX_AGE_MS, or a lone seat waiting LONELY_MS. */
  async alarm(): Promise<void> {
    const now = Date.now();
    for (const ws of this.live())
      if (now - (ws.deserializeAttachment() as Attachment).opened >= MAX_AGE_MS) await this.evict(ws, 4002, "open too long");
    const live = this.live();
    const aloneSince = (await this.ctx.storage.get<number>("aloneSince")) ?? now;
    if (live.length === 1 && now - aloneSince >= LONELY_MS) await this.evict(live[0]!, 4010, "alone too long");
    await this.schedule();
  }

  /** Take ws out of its seat and close it with `code`. */
  private async evict(ws: WebSocket, code: number, reason: string): Promise<void> {
    await this.leave(ws);
    try {
      ws.close(code, reason);
    } catch {
      /* already closed */
    }
  }

  /** ws leaves its seat: a full room becomes a lonely one, and the deadlines move. */
  private async leave(ws: WebSocket): Promise<void> {
    const a = ws.deserializeAttachment() as Attachment | null;
    if (!a || a.evicted) return;
    const wasFull = this.live().length === 2;
    ws.serializeAttachment({ ...a, evicted: true });
    if (wasFull) await this.ctx.storage.put("aloneSince", Date.now());
    await this.schedule();
  }

  /** Wake for the next deadline; an empty room forgets everything. */
  private async schedule(): Promise<void> {
    const live = this.live();
    if (live.length === 0) {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      return;
    }
    let next = Math.min(...live.map((ws) => (ws.deserializeAttachment() as Attachment).opened + MAX_AGE_MS));
    if (live.length === 1) next = Math.min(next, ((await this.ctx.storage.get<number>("aloneSince")) ?? Date.now()) + LONELY_MS);
    await this.ctx.storage.setAlarm(next);
  }
}
