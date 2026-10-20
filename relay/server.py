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

So that a forgotten tab can't keep the machine awake (Fly stops it only
when no sockets are open), a seat waits at most LONELY_SECONDS for the
other one, and no socket stays longer than MAX_AGE_SECONDS.

Close codes the client can act on (it should not reconnect after 4002, 4003
or 4010):
    4000  bad path (not /<code>/host or /<code>/guest)
    4001  replaced by a newer socket for the same seat
    4002  open too long (MAX_AGE_SECONDS)
    4003  origin not allowed
    4008  sending too fast
    4010  alone in the room too long (LONELY_SECONDS)
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
LONELY_SECONDS = float(os.environ.get("LONELY_SECONDS", "600"))
MAX_AGE_SECONDS = float(os.environ.get("MAX_AGE_SECONDS", "7200"))
# How often each socket checks those two
WATCH_SECONDS = 10.0
# A dead socket (a phone that lost signal, with nothing to say so) fails to
# answer a ping, and is gone within two pings and a close wait: 45 s
PING_SECONDS = 20.0
CLOSE_SECONDS = 5.0
# The game's own pages: https://simonw.github.io and https://*.simonw.workers.dev
ORIGIN = re.compile(r"^https://(?:simonw\.github\.io|(?:[a-z0-9-]+\.)+simonw\.workers\.dev)$")

log = logging.getLogger("relay")


class Room:
    def __init__(self) -> None:
        # "host" and "guest" -> socket
        self.seats: dict[str, ServerConnection] = {}
        # when the room last had fewer than two seats filled
        self.alone_since = time.monotonic()

    def evict(self, seat: str, ws: ServerConnection) -> None:
        """Take ws out of its seat, if it is still there."""
        if self.seats.get(seat) is ws:
            if len(self.seats) == 2:
                self.alone_since = time.monotonic()
            del self.seats[seat]


# room code -> Room
rooms: dict[str, Room] = {}
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


async def watch(ws: ServerConnection, room: Room, seat: str) -> None:
    """Close ws when it has been alone or open too long."""
    opened = time.monotonic()
    while True:
        await asyncio.sleep(WATCH_SECONDS)
        now = time.monotonic()
        if now - opened > MAX_AGE_SECONDS:
            code, reason = 4002, "open too long"
        elif len(room.seats) < 2 and now - room.alone_since > LONELY_SECONDS:
            code, reason = 4010, "alone too long"
        else:
            continue
        room.evict(seat, ws)
        close_later(ws, code, reason)
        return


async def handler(ws: ServerConnection) -> None:
    if not ORIGIN.match(ws.request.headers.get("Origin") or ""):
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
        room = rooms[code] = Room()
    old = room.seats.get(seat)
    room.seats[seat] = ws
    if old is not None:
        close_later(old, 4001, "replaced")
    log.info("join %s %s (%d rooms)", code, seat, len(rooms))

    watcher = asyncio.create_task(watch(ws, room, seat))
    tokens, last = float(BURST), time.monotonic()
    try:
        async for message in ws:
            if room.seats.get(seat) is not ws:
                # evicted (replaced, too fast, alone or open too long): keep
                # reading, since the close handshake waits behind what is queued
                continue
            now = time.monotonic()
            tokens = min(BURST, tokens + (now - last) * RATE_PER_SECOND)
            last = now
            if tokens < 1:
                room.evict(seat, ws)
                close_later(ws, 4008, "sending too fast")
                continue
            tokens -= 1
            peer = room.seats.get(other(seat))
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
        watcher.cancel()
        room.evict(seat, ws)
        if not room.seats and rooms.get(code) is room:
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
        ping_interval=PING_SECONDS,
        ping_timeout=PING_SECONDS,
        close_timeout=CLOSE_SECONDS,
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
