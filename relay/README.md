# battledrones-relay

A tiny WebSocket relay for two-device multiplayer: it pairs two browsers by
room code and forwards each one's messages to the other, unchanged. It is
one Python file (`server.py`, built on [websockets](https://websockets.readthedocs.io/))
and stores nothing: the only state is the open sockets, in memory, and a
restart forgets every room.

The game runs the deterministic simulation in lockstep on both devices, so
only the players' orders cross the wire: about one ~40-byte message every
100–200 ms from each player, the same packets the sound duel sends through
the air (SOUND-DUEL.md, `src/versus/relay-transport.ts`). A 10-minute match
is around a megabyte of traffic.

## Protocol

```
GET /health              200 "ok"
WS  /<code>/<seat>       join room <code> as seat "host" or "guest"
```

- **The host's page invents the room code**: Crockford base32
  (`0-9 A-H J K M N P-T V-Z`, uppercase), 6–16 characters. Use 8 random ones
  (`crypto.getRandomValues`), about 10¹² codes: the relay has no expiry or
  rate limit on room creation, so the length is the protection against
  guessing.
- The first socket with a code makes the room. It goes away when both seats
  have left.
- Every message (text or binary, up to 1 KB) goes to the other seat if it
  is connected, and is dropped if it is not. The relay never reads them.
- A new socket for a seat that is taken **replaces** the old one, which is
  closed with 4001. A page that reloads or changes network gets its seat
  back at once, rather than waiting for the old socket to time out.
- The relay pings every 20 s, so a socket that dies quietly (a phone that
  lost signal) frees its seat within about 40 s.

Close codes:

| Code | Meaning |
|---|---|
| 4000 | Bad path: not `/<code>/host` or `/<code>/guest` |
| 4001 | Replaced by a newer socket for the same seat |
| 4003 | Origin not allowed (see `ALLOWED_ORIGINS`) |
| 4008 | Sending too fast: more than a burst of 100, then 50 a second |
| 4013 | Relay full (`MAX_ROOMS`, 2,000 by default) |

## Settings

Environment variables:

- `PORT`: the port to listen on (default 8080).
- `ALLOWED_ORIGINS`: comma-separated origins to accept, such as
  `https://simonw.github.io`. Unset means any origin. This stops other web
  pages from using the relay, but not other clients, which can send any
  `Origin` they like.
- `MAX_ROOMS`: the most rooms open at once (default 2000).

## Run it locally

```bash
cd relay
python3 -m venv .venv
.venv/bin/pip install -r requirements-test.txt
.venv/bin/python server.py           # ws://localhost:8080/K7QM2XP4/host
.venv/bin/pytest -q                  # the tests
```

## Deploy to Fly

You need [flyctl](https://fly.io/docs/flyctl/install/) and a Fly account
(`fly auth login`). From this folder:

```bash
cd relay
fly apps create battledrones-relay   # first time only
fly deploy --ha=false
```

`--ha=false` matters. By default Fly starts two machines, and the two
players of a room have to reach the same process, or they never meet. If
the app ever has more than one machine, scale it back down:

```bash
fly scale count 1
```

Check it:

```bash
curl https://battledrones-relay.fly.dev/health   # ok
fly logs                                         # join/leave lines with room counts
```

The game will connect to `wss://battledrones-relay.fly.dev/<code>/<seat>`.
Fly's proxy terminates TLS, and the server itself speaks plain WebSockets on
port 8080. If `fly ips list` shows no IPv4 address, add a shared one, which
is free: `fly ips allocate-v4 --shared`.

To accept only the game's own page, set the origin and redeploy:

```bash
fly secrets set ALLOWED_ORIGINS=https://simonw.github.io
```

You could also uncomment the line in `fly.toml`'s `[env]` instead. Local
development against the deployed relay would then need its origin added too
(`http://localhost:5173`, for example).

### Cost

`fly.toml` asks for the smallest machine (shared-cpu-1x, 256 MB) and lets it
scale to zero. Fly stops the machine when no sockets are open and starts it
again on the next connection, which adds a second or two to the first join.
You pay for running time only, plus egress, which rounds to nothing at
these message sizes.

The region is `sjc` (San Jose). Change `primary_region` to the one nearest
your players: every message goes phone → relay → phone, so the relay's
distance adds to the lockstep's input delay.

### Things to know

- **A deploy or restart ends every live match**, since the rooms exist only
  in memory. Deploy when nobody is playing.
- The logs show room codes, and Fly keeps logs for a short time only.
