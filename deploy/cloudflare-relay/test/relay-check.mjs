// A protocol check for the relay (src/index.ts), local or deployed:
//   node test/relay-check.mjs ws://localhost:8787
//   node test/relay-check.mjs wss://battledrones-relay.elialbert.com
// Node's WebSocket (undici) can send the Origin header a page would.
const base = process.argv[2] ?? "ws://localhost:8787";
const ORIGIN = "https://battledrones.elialbert.com";
const code = () => Array.from({ length: 8 }, () => "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[Math.floor(Math.random() * 32)]).join("");

function open(path, origin = ORIGIN) {
  const ws = new WebSocket(`${base}${path}`, { headers: { Origin: origin } });
  const got = [];
  const waiters = [];
  ws.onmessage = (e) => {
    got.push(String(e.data));
    waiters.splice(0).forEach((w) => w());
  };
  const closed = new Promise((r) => (ws.onclose = (e) => r(e.code)));
  const opened = new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  const next = (ms = 3000) =>
    got.length
      ? Promise.resolve(got.shift())
      : new Promise((r, j) => {
          const t = setTimeout(() => j(new Error("no message")), ms);
          waiters.push(() => (clearTimeout(t), r(got.shift())));
        });
  return { ws, opened, closed, next, got };
}

let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}: ${e.message}`);
  }
}
const eq = (a, b) => {
  if (a !== b) throw new Error(`${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
};

await check("health", async () => {
  const r = await fetch(base.replace(/^ws/, "http") + "/health");
  eq(r.status, 200);
  eq((await r.text()).trim(), "ok");
});

await check("a page from elsewhere is refused with 4003", async () => {
  const s = open(`/${code()}/host`, "https://example.com");
  eq(await s.closed, 4003);
});

await check("a bad path is refused with 4000", async () => {
  const s = open(`/not-a-code/host`);
  eq(await s.closed, 4000);
});

await check("host and guest each hear the other, verbatim", async () => {
  const c = code();
  const h = open(`/${c}/host`);
  const g = open(`/${c}/guest`);
  await Promise.all([h.opened, g.opened]);
  h.ws.send("12 AAEC");
  eq(await g.next(), "12 AAEC");
  g.ws.send("40 /w8=");
  eq(await h.next(), "40 /w8=");
  h.ws.close();
  g.ws.close();
});

await check("a message to an empty seat is dropped", async () => {
  const c = code();
  const h = open(`/${c}/host`);
  await h.opened;
  h.ws.send("lost");
  const g = open(`/${c}/guest`);
  await g.opened;
  h.ws.send("heard");
  eq(await g.next(), "heard");
  h.ws.close();
  g.ws.close();
});

await check("a second socket for a seat replaces the first (4001), and gets its messages", async () => {
  const c = code();
  const h1 = open(`/${c}/host`);
  const g = open(`/${c}/guest`);
  await Promise.all([h1.opened, g.opened]);
  const h2 = open(`/${c}/host`);
  await h2.opened;
  eq(await h1.closed, 4001);
  g.ws.send("to the new host");
  eq(await h2.next(), "to the new host");
  h2.ws.send("from the new host");
  eq(await g.next(), "from the new host");
  h2.ws.close();
  g.ws.close();
});

await check("rooms are separate", async () => {
  const a = code();
  const b = code();
  const ah = open(`/${a}/host`);
  const ag = open(`/${a}/guest`);
  const bg = open(`/${b}/guest`);
  await Promise.all([ah.opened, ag.opened, bg.opened]);
  ah.ws.send("room a");
  eq(await ag.next(), "room a");
  await new Promise((r) => setTimeout(r, 300));
  eq(bg.got.length, 0);
  [ah, ag, bg].forEach((s) => s.ws.close());
});

await check("sending too fast is closed with 4008", async () => {
  const c = code();
  const h = open(`/${c}/host`);
  await h.opened;
  for (let i = 0; i < 300; i++) h.ws.send("x");
  eq(await h.closed, 4008);
});

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
