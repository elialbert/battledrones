"""
The Battle Drones relay: pairs two browsers by room code and forwards each
one's WebSocket messages to the other, verbatim. It keeps nothing but the
open sockets in memory and writes nothing anywhere; a restart forgets every
room. See README.md.

    GET /health                 200 "ok" (Fly's health check)
    WS  /<code>/<seat>          join room <code> as seat "host" or "guest"

The host's page invents the code (Crockford base32, 6-16 characters). The
first socket with a code makes the room; it goes away when both have left.
A message is forwarded to the other seat if it is connected, and dropped if
not, as a packet sent into an empty room would be. The relay never reads
one.

A second socket for a seat that is already taken replaces the first (closed
with 4001), so a page that reloads or changes network gets its seat back
before the old socket times out.

Close codes the client can act on:
    4000  bad path (not /<code>/host or /<code>/guest)
    4001  replaced by a newer socket for the same seat
    4003  origin not allowed
    4008  sending too fast
    4013  relay full
"""

import asyncio
import logging
import os
import re
import signal
import time
from http import HTTPStatus

from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosed

PATH = re.compile(r"^/([0-9A-HJKMNP-TV-Z]{6,16})/(host|guest)$")
# Packets are ~40 bytes of base64 and go out every 100-200 ms per seat
MAX_MESSAGE_BYTES = 1024
RATE_PER_SECOND = 50
BURST = 100
MAX_ROOMS = int(os.environ.get("MAX_ROOMS", "2000"))
# Comma-separated; unset or empty: any origin
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()]

log = logging.getLogger("relay")

# room code -> {"host": socket, "guest": socket}
rooms: dict[str, dict[str, ServerConnection]] = {}
# close() tasks in flight (asyncio keeps only weak references to tasks)
background: set[asyncio.Task] = set()


def other(seat: str) -> str:
    return "guest" if seat == "host" else "host"


def close_later(ws: ServerConnection, code: int, reason: str) -> None:
    """Close ws without waiting: a dead socket takes close_timeout to give up."""
    task = asyncio.create_task(ws.close(code, reason))
    background.add(task)
    task.add_done_callback(background.discard)


def process_request(connection: ServerConnection, request):
    if request.path == "/health":
        return connection.respond(HTTPStatus.OK, "ok\n")
    return None


async def handler(ws: ServerConnection) -> None:
    if ALLOWED_ORIGINS and ws.request.headers.get("Origin") not in ALLOWED_ORIGINS:
        await ws.close(4003, "origin not allowed")
        return
    match = PATH.match(ws.request.path)
    if not match:
        await ws.close(4000, "bad path")
        return
    code, seat = match.groups()
    room = rooms.get(code)
    if room is None:
        if len(rooms) >= MAX_ROOMS:
            await ws.close(4013, "relay full")
            return
        room = rooms[code] = {}
    old = room.get(seat)
    room[seat] = ws
    if old is not None:
        close_later(old, 4001, "replaced")
    log.info("join %s %s (%d rooms)", code, seat, len(rooms))

    tokens, last = float(BURST), time.monotonic()
    try:
        async for message in ws:
            if room.get(seat) is not ws:
                # replaced, or closed for sending too fast: keep reading,
                # since the close handshake waits behind what is queued
                continue
            now = time.monotonic()
            tokens = min(BURST, tokens + (now - last) * RATE_PER_SECOND)
            last = now
            if tokens < 1:
                del room[seat]
                close_later(ws, 4008, "sending too fast")
                continue
            tokens -= 1
            peer = room.get(other(seat))
            if peer is not None:
                try:
                    await peer.send(message)
                except ConnectionClosed:
                    # (the peer is closing: its own handler cleans up)
                    pass
    except ConnectionClosed:
        # (a dropped connection, or one this relay closed with a 4xxx code)
        pass
    finally:
        if room.get(seat) is ws:
            del room[seat]
        if not room and rooms.get(code) is room:
            del rooms[code]
        log.info("leave %s %s (%d rooms)", code, seat, len(rooms))


def relay(host: str = "0.0.0.0", port: int = 8080):
    """The server, to use as `async with relay(...) as server:`."""
    return serve(
        handler,
        host,
        port,
        process_request=process_request,
        max_size=MAX_MESSAGE_BYTES,
        # dead sockets (a phone that lost signal) free their seat within ~40 s
        ping_interval=20,
        ping_timeout=20,
    )


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    # (the library logs every connection, health checks included)
    logging.getLogger("websockets").setLevel(logging.WARNING)
    port = int(os.environ.get("PORT", "8080"))
    async with relay(port=port) as server:
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, server.close)
        log.info("listening on %d", port)
        await server.wait_closed()


if __name__ == "__main__":
    asyncio.run(main())
