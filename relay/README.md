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
  lost signal) is gone within about 45 s.
- A seat waits at most 10 minutes for the other one, counted from when the
  room was made or the other seat left, and no socket stays longer than 2
  hours. Both limits exist so that a forgotten tab can't keep the machine
  from scaling to zero (below).
- Only the game's own pages may connect: `https://simonw.github.io` and
  `https://*.simonw.workers.dev`. A socket from anywhere else, or with no
  `Origin` header, is closed with 4003. The list is hard-coded (`ORIGIN` in
  `server.py`), so a page served from `localhost` can't use the relay. This
  stops other web pages from using it, but not other programs, which can
  send any `Origin` they like.

Close codes. The client should not reconnect after 4002, 4003 or 4010:

| Code | Meaning |
|---|---|
| 4000 | Bad path: not `/<code>/host` or `/<code>/guest` |
| 4001 | Replaced by a newer socket for the same seat |
| 4002 | Open too long (`MAX_AGE_SECONDS`) |
| 4003 | Origin not allowed |
| 4008 | Sending too fast: more than a burst of 100, then 50 a second |
| 4010 | Alone in the room too long (`LONELY_SECONDS`) |
| 4013 | Relay full (`MAX_ROOMS`) |

## Settings

Environment variables:

- `PORT`: the port to listen on (default 8080).
- `LONELY_SECONDS`: how long a seat waits alone (default 600).
- `MAX_AGE_SECONDS`: the longest a socket stays open (default 7200).
- `MAX_ROOMS`: the most rooms open at once (default 2000).

## Run it locally

With [uv](https://docs.astral.sh/uv/), from this folder:

```bash
cd relay
uv run pytest       # the tests
uv run server.py    # ws://localhost:8080/K7QM2XP4/host
```

`uv run` creates the environment from `pyproject.toml` and `uv.lock` the
first time, so there is no separate install step.

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

### Scaling to zero

`fly.toml` asks for the smallest machine (shared-cpu-1x, 256 MB) with
`auto_stop_machines = "suspend"`, `auto_start_machines = true` and
`min_machines_running = 0`. Every few minutes Fly's proxy checks whether
the machine has any connections. When it has none, the proxy suspends it:
the machine's memory is saved to a snapshot, and no CPU or RAM is billed.
The next connection resumes it in a few hundred milliseconds. The first
connection after a deploy is a cold start instead, a second or two, because
a deploy discards the snapshot. Either way the game's first join waits a
moment longer, and nothing is lost: rooms only exist while sockets are
open.

Two things could keep the machine awake, and the server deals with both:

- **A dead socket**, such as a phone that went out of range. The relay's
  pings find it and close it within about 45 s.
- **A forgotten tab** that keeps a live socket open. A seat alone for 10
  minutes is closed (4010), and so is any socket open for 2 hours (4002).
  So the machine suspends at most about 10 minutes plus the proxy's check
  interval after the last match ends.

Fly's health check (`/health`, every 30 s) shouldn't count as traffic:
the proxy looks at the connections it routes to the machine. Fly's docs
don't say so explicitly, though. If the machine never suspends, delete the
`[[http_service.checks]]` block from `fly.toml`, since nothing else depends
on it.

To check that it works after deploying, leave it alone for 15 minutes
and look at the machine's state, which should read `suspended`:

```bash
fly machine list
```

Then `curl https://battledrones-relay.fly.dev/health` should wake it, and
`fly machine list` should read `started` again. If it ever reads `stopped`
rather than `suspended`, Fly couldn't take a snapshot and fell back to
stopping it, which works the same with a slower wake.

### Cost

You pay for the time the machine runs, a small charge for its stopped root
filesystem, and egress, which rounds to nothing at these message sizes. See
[Fly's pricing](https://fly.io/docs/about/pricing/).

The region is `sjc` (San Jose). Change `primary_region` to the one nearest
your players: every message goes phone → relay → phone, so the relay's
distance adds to the lockstep's input delay.

### Things to know

- **A deploy or restart ends every live match**, since the rooms exist only
  in memory. Deploy when nobody is playing.
- The logs show room codes, and Fly keeps logs for a short time only.
