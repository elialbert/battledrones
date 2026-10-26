# The relay on Cloudflare

This fork's online relay: the protocol of `relay/server.py` (see
`relay/README.md`) as a Cloudflare Worker, with one Durable Object per room,
at `wss://battledrones-relay.elialbert.com`. It accepts only pages from
`https://battledrones.elialbert.com` (`ORIGIN` in `src/index.ts`).

The game connects to it when built with `RELAY_URL` set (`vite.config.ts`
`__RELAY_URL__`, `src/net/relay-socket.ts`); `npm run deploy:cf` does that.
Without it, a build uses the upstream Fly relay.

From the repo root:

```bash
npm run deploy:relay   # deploy this Worker
npm run deploy:cf      # build the game against it and deploy the site
```

Check it:

```bash
node deploy/cloudflare-relay/test/relay-check.mjs wss://battledrones-relay.elialbert.com
cd deploy/cloudflare-relay && npx cf dev   # local: ws://localhost:8787
```

Differences from the Python relay: there is no 4013 ("relay full"), since
rooms don't share a machine, and the relay doesn't ping. A socket that dies
quietly stays in its seat until Cloudflare notices, or until the page
reconnects and replaces it (4001), which the game does when the link goes
quiet (`STALE_MS`).
