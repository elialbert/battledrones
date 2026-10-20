import asyncio
import http.client

import pytest
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

import server


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


def test_origin_allow_list(monkeypatch):
    monkeypatch.setattr(server, "ALLOWED_ORIGINS", ["https://simonw.github.io"])

    async def t(url, port):
        async with connect(f"{url}/K7QM2XP4/host", origin="https://evil.example") as ws:
            assert await closed_with(ws) == 4003
        async with connect(f"{url}/K7QM2XP4/host", origin="https://simonw.github.io") as a:
            async with connect(f"{url}/K7QM2XP4/guest", origin="https://simonw.github.io") as b:
                await a.send("ok")
                assert await asyncio.wait_for(b.recv(), 2) == "ok"

    run(t)


def test_relay_full(monkeypatch):
    monkeypatch.setattr(server, "MAX_ROOMS", 1)

    async def t(url, port):
        async with connect(f"{url}/AAAAAA/host"), connect(f"{url}/BBBBBB/host") as ws:
            assert await closed_with(ws) == 4013

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
