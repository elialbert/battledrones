import asyncio
import http.client

import pytest
from websockets.asyncio.client import connect as ws_connect
from websockets.exceptions import ConnectionClosed

import server

GAME = "https://simonw.github.io"


def connect(url, origin=GAME):
    return ws_connect(url, origin=origin)


def run(test):
    """Run test(url) against a relay on a free port."""

    async def go():
        server.rooms.clear()
        async with server.relay("127.0.0.1", 0) as srv:
            port = srv.sockets[0].getsockname()[1]
            await test(f"ws://127.0.0.1:{port}", port)
        assert server.rooms == {}

    asyncio.run(go())


async def closed_with(ws) -> int:
    with pytest.raises(ConnectionClosed):
        await asyncio.wait_for(ws.recv(), 2)
    return ws.close_code


def test_forwards_both_ways_verbatim():
    async def t(url, port):
        async with connect(f"{url}/K7QM2XP4/host") as host, connect(f"{url}/K7QM2XP4/guest") as guest:
            await host.send("AAEC/w==")
            assert await asyncio.wait_for(guest.recv(), 2) == "AAEC/w=="
            await guest.send(b"\x00\x01")
            assert await asyncio.wait_for(host.recv(), 2) == b"\x00\x01"

    run(t)


def test_rooms_are_separate_and_a_lone_seat_hears_nothing():
    async def t(url, port):
        async with connect(f"{url}/AAAAAA/host") as a, connect(f"{url}/BBBBBB/guest") as b:
            await a.send("hello")
            await b.send("hello")
            with pytest.raises(TimeoutError):
                await asyncio.wait_for(b.recv(), 0.3)
            with pytest.raises(TimeoutError):
                await asyncio.wait_for(a.recv(), 0.3)

    run(t)


def test_a_message_before_the_friend_arrives_is_dropped():
    async def t(url, port):
        async with connect(f"{url}/K7QM2XP4/host") as host:
            await host.send("early")
            await asyncio.sleep(0.1)
            async with connect(f"{url}/K7QM2XP4/guest") as guest:
                await host.send("late")
                assert await asyncio.wait_for(guest.recv(), 2) == "late"

    run(t)


def test_a_new_socket_replaces_the_old_one_in_its_seat():
    async def t(url, port):
        async with connect(f"{url}/K7QM2XP4/host") as old, connect(f"{url}/K7QM2XP4/guest") as guest:
            async with connect(f"{url}/K7QM2XP4/host") as new:
                assert await closed_with(old) == 4001
                await guest.send("to the new host")
                assert await asyncio.wait_for(new.recv(), 2) == "to the new host"

    run(t)


@pytest.mark.parametrize("path", ["/", "/K7QM2XP4", "/K7QM2XP4/spectator", "/k7qm2xp4/host", "/K7QM2/host", "/ILOU00/host"])
def test_bad_paths_are_closed(path):
    async def t(url, port):
        async with connect(url + path) as ws:
            assert await closed_with(ws) == 4000

    run(t)


def test_sending_too_fast_is_closed():
    async def t(url, port):
        async with connect(f"{url}/K7QM2XP4/host") as ws:
            for _ in range(server.BURST + 10):
                try:
                    await ws.send("x")
                except ConnectionClosed:
                    break
            assert await closed_with(ws) == 4008

    run(t)


@pytest.mark.parametrize(
    "origin,allowed",
    [
        ("https://simonw.github.io", True),
        ("https://battledrones.simonw.workers.dev", True),
        ("https://preview.battledrones.simonw.workers.dev", True),
        (None, False),
        ("http://simonw.github.io", False),
        ("https://simonw.github.io.evil.example", False),
        ("https://evil.github.io", False),
        ("https://simonw.workers.dev", False),
        ("https://evilsimonw.workers.dev", False),
        ("https://x.simonw.workers.dev.evil.example", False),
        ("https://other.workers.dev", False),
        ("https://x.simonw.workers.dev/", False),
        ("https://simonw.github.io:8443", False),
        ("http://localhost:5173", False),
    ],
)
def test_origins(origin, allowed):
    async def t(url, port):
        async with connect(f"{url}/K7QM2XP4/host", origin=origin) as a:
            if not allowed:
                assert await closed_with(a) == 4003
                return
            async with connect(f"{url}/K7QM2XP4/guest") as b:
                await a.send("ok")
                assert await asyncio.wait_for(b.recv(), 2) == "ok"

    run(t)


def test_alone_too_long(monkeypatch):
    monkeypatch.setattr(server, "WATCH_SECONDS", 0.05)
    monkeypatch.setattr(server, "LONELY_SECONDS", 0.2)

    async def t(url, port):
        async with connect(f"{url}/K7QM2XP4/host") as host:
            assert await closed_with(host) == 4010
        # a pair is never alone; when one leaves, the other's wait starts then
        async with connect(f"{url}/AAAAAA/host") as host:
            async with connect(f"{url}/AAAAAA/guest") as guest:
                await asyncio.sleep(0.4)
                await host.send("still here")
                assert await asyncio.wait_for(guest.recv(), 2) == "still here"
            started = asyncio.get_running_loop().time()
            assert await closed_with(host) == 4010
            assert asyncio.get_running_loop().time() - started >= 0.15

    run(t)


def test_open_too_long(monkeypatch):
    monkeypatch.setattr(server, "WATCH_SECONDS", 0.05)
    monkeypatch.setattr(server, "MAX_AGE_SECONDS", 0.3)

    async def t(url, port):
        async with connect(f"{url}/K7QM2XP4/host") as host, connect(f"{url}/K7QM2XP4/guest") as guest:
            assert await closed_with(host) == 4002
            assert await closed_with(guest) == 4002

    run(t)


def test_relay_full(monkeypatch):
    monkeypatch.setattr(server, "MAX_ROOMS", 1)

    async def t(url, port):
        async with connect(f"{url}/AAAAAA/host"), connect(f"{url}/BBBBBB/host") as ws:
            assert await closed_with(ws) == 4013

    run(t)


def test_a_silent_socket_is_dropped(monkeypatch):
    """A client that never answers pings (a phone gone from the network) frees its seat and the room."""
    monkeypatch.setattr(server, "PING_SECONDS", 0.2)
    monkeypatch.setattr(server, "CLOSE_SECONDS", 0.2)

    async def t(url, port):
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        writer.write(
            b"GET /K7QM2XP4/host HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            b"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n"
            b"Origin: https://simonw.github.io\r\n\r\n"
        )
        assert (await reader.readline()).startswith(b"HTTP/1.1 101")
        for _ in range(50):
            await asyncio.sleep(0.05)
            if "K7QM2XP4" in server.rooms:
                break
        assert "K7QM2XP4" in server.rooms
        # (never read again, so never pong)
        for _ in range(40):
            await asyncio.sleep(0.05)
            if not server.rooms:
                break
        assert server.rooms == {}
        writer.close()

    run(t)


def test_health():
    async def t(url, port):
        def get():
            c = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
            c.request("GET", "/health")
            r = c.getresponse()
            return r.status, r.read()

        assert await asyncio.to_thread(get) == (200, b"ok\n")

    run(t)
