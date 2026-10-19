// Duel smoke (SOUND-DUEL.md "Dev and test modes"): two pages of the built app,
// one browser context each, play a sound duel through the relay
// (?duel=relay, src/versus/relay-transport.ts) instead of the air. Node is
// the air between them: each page's window.__duelOut hands its packets here,
// and they reach the other page's window.__duelIn after a seeded delay
// (--latency ms plus up to --jitter ms, in order, as sound arrives), with
// seeded Bernoulli loss (--loss) and one outage of --outage ms one way.
//
//   1. The lobby by hand: both pages at ?duel=relay, Duel, then Host on one
//      and Join on the other. They pair (the host's map and mutators, blue
//      and red) and show the opener cards; both Cancel and get the menu back.
//   2. The match: ?duel=relay&seat=host and &seat=guest pair at once. Each
//      taps an opener card, the match loads, and from then on the pages are
//      advanced with __bd.scene.step(): a hidden page gets no animation
//      frames, so nothing here waits on them. (Each page's own frames are
//      held to one every RAF_MS: the two pages share one software renderer,
//      and drawing at full rate starves both to a tick or two a second.)
//      Orders (a build bar tap, moves through the Controller), the outage
//      (both stall, "Waiting for your friend…", then go on), a pause (the
//      friend stalls within D ticks: "Friend paused"), then, past tick
//      MATCH_TICKS, the guest resigns from the pause menu.
//      Both must decide on the same tick with the same world hash and hash
//      trail (sampled at every tick both pages were seen on), show the report
//      (VICTORY / DEFEAT, "In sync ✓", "Practice link (no sound)") and save
//      the same battle (Save battle: turns and the hash every 100 ticks).
//      No win/loss record is written on a practice link.
//   3. Rematch: the host taps Rematch and reconnects from the reloaded page;
//      the guest, still on its report, shows "Your friend is back in the
//      lobby: tap Rematch", taps it and reconnects. They pair in the same
//      roles with the sides swapped, and both Cancel.
//
// Fails on any console error. Prints "DUEL SMOKE OK".
// Usage: node tools/duel-smoke.mjs [--seed=1] [--loss=0.1] [--latency=120] [--jitter=80] [--outage=2500] [--shots] [url]
// (serves dist/: run `npm run build` first; SMOKE_SHOT_DIR for --shots, default /tmp)
//
// Where the spec is silent:
//  - the relay's delay never reorders packets (sound arrives in order), and
//    the seed fixes the loss and delay draws, not the match: each page draws
//    its pairing nonces from crypto, so the map seed differs run to run;
//  - Host / Join is driven on pages without a seat (a seat pairs at once, so
//    its lobby has no role to tap), then the match runs on seated pages;
//  - each page's own animation frames are slowed to one every RAF_MS by an
//    init script, and the smoke steps the scene undrawn
//    (__bd.scene.step(100, 1, false)), drawing only for --shots;
//  - the hash trails are compared at every tick both pages were sampled at
//    (two per step call), on top of the lockstep's own checkpoints and end
//    check, the final world hash and the saved battles' hash every 100 ticks.
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../dist");
const SHOT_DIR = process.env.SMOKE_SHOT_DIR ?? "/tmp";
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".webp": "image/webp", ".json": "application/json",
  ".webmanifest": "application/manifest+json"
};
const args = process.argv.slice(2);
const opt = (name, def) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? Number(a.slice(name.length + 3)) : def;
};
const SEED = opt("seed", 1);
const LOSS = opt("loss", 0.1);
const LATENCY = opt("latency", 120);
const JITTER = opt("jitter", 80);
const OUTAGE = opt("outage", 2500);
const shots = args.includes("--shots");
const urlArg = args.find((a) => !a.startsWith("--"));
/** Each page's animation frames come this far apart (ms): see 2. above. */
const RAF_MS = 4000;
/** The match goes on to this tick before the resign: the saved battle has a world hash every 100. */
const MATCH_TICKS = 320;
for (const [k, v] of Object.entries({ seed: SEED, loss: LOSS, latency: LATENCY, jitter: JITTER, outage: OUTAGE }))
  if (!Number.isFinite(v) || v < 0) throw new Error(`--${k} must be a number ≥ 0`);

let server = null;
if (!urlArg) {
  if (!existsSync(join(ROOT, "index.html"))) throw new Error("no dist/index.html: run `npm run build` first");
  server = createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    const file = join(ROOT, p);
    if (!existsSync(file)) { res.writeHead(404); res.end("nf"); return; }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(8897, r));
}
const base = new URL(urlArg ?? "http://localhost:8897/");
const urlFor = (seat) => {
  const u = new URL(base);
  u.searchParams.set("duel", "relay");
  if (seat) u.searchParams.set("seat", seat);
  return u.href;
};

let failed = false;
const fail = (msg) => { console.error(`FAIL: ${msg}`); failed = true; process.exitCode = 1; };
const check = (ok, msg) => { if (!ok) fail(msg); return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)} s] ${msg}`);
const T0 = Date.now();

/** mulberry32: the relay's loss and delay draws. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------ the air ---

/**
 * The relay between the two pages: what one page's __duelOut sends reaches the
 * other's __duelIn after LATENCY + jitter ms (never overtaking the packet
 * before it), unless the loss draw or an outage drops it. Each direction has
 * its own seeded draws.
 */
class Air {
  constructor(seed) {
    this.ends = new Map();
    this.dirs = new Map();
    this.seed = seed;
    this.timer = setInterval(() => this.deliver(), 10);
  }
  /** One page, as `name`, whose packets go to `to`. */
  async attach(name, to, page) {
    const dir = { from: name, to, rand: rng(this.seed * 2 + this.dirs.size + 1), queue: [], last: 0, busy: false, sent: 0, lost: 0, delivered: 0, cutUntil: 0 };
    this.dirs.set(name, dir);
    this.ends.set(name, page);
    await page.exposeFunction("__duelOut", (b64, nbits) => this.send(name, b64, nbits));
  }
  send(from, b64, nbits) {
    const d = this.dirs.get(from);
    const now = Date.now();
    d.sent++;
    // (draw both always, so the pattern doesn't depend on the outage)
    const lost = d.rand() < LOSS;
    const at = Math.max(d.last, now + LATENCY + d.rand() * JITTER);
    if (lost || now < d.cutUntil) return void d.lost++;
    d.last = at;
    d.queue.push({ at, b64, nbits });
  }
  /** Drop everything `from` sends for `ms`. */
  cut(from, ms) {
    this.dirs.get(from).cutUntil = Date.now() + ms;
  }
  deliver() {
    const now = Date.now();
    for (const d of this.dirs.values()) {
      if (d.busy) continue;
      let n = 0;
      while (n < d.queue.length && d.queue[n].at <= now) n++;
      if (!n) continue;
      const due = d.queue.splice(0, n).map((p) => [p.b64, p.nbits]);
      const page = this.ends.get(d.to);
      d.busy = true;
      // (no __duelIn yet, or a page reloading: lost, as on the air)
      page
        .evaluate((list) => {
          for (const [b, n] of list) window.__duelIn?.(b, n);
        }, due)
        .then(() => (d.delivered += due.length), () => undefined)
        .finally(() => (d.busy = false));
    }
  }
  stats() {
    return [...this.dirs.values()].map((d) => `${d.from}→${d.to} ${d.sent} sent, ${d.lost} lost, ${d.delivered} delivered`).join("; ");
  }
  close() {
    clearInterval(this.timer);
  }
}

// ---------------------------------------------------------- the pages ---

const exe = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find((p) => existsSync(p));
const browser = await chromium.launch({
  executablePath: exe,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"]
});
/** Each phone's menu: the host offers its map and mutators; the guest's own picks must not matter. */
const SETTINGS = {
  host: { mapId: "riverlands", difficulty: "normal", mode: "skirmish", mutators: ["rapidfab"] },
  guest: { mapId: "frostbite", difficulty: "normal", mode: "skirmish", mutators: [] }
};
const air = new Air(SEED);
const phones = {};
for (const name of ["host", "guest"]) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true, acceptDownloads: true });
  // (the page's own frames, slowed: the smoke steps the game itself)
  await context.addInitScript((ms) => {
    window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), ms);
    window.cancelAnimationFrame = (id) => clearTimeout(id);
  }, RAF_MS);
  await context.addInitScript((s) => {
    try {
      localStorage.setItem("battledrones.settings", s);
    } catch {
      /* ignore */
    }
  }, JSON.stringify(SETTINGS[name]));
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${name}: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`${name}: ${String(e)}`));
  phones[name] = { name, context, page, errors, trail: new Map() };
}
await air.attach("host", "guest", phones.host.page);
await air.attach("guest", "host", phones.guest.page);
const both = (fn) => Promise.all([fn(phones.host), fn(phones.guest)]);
/** A screenshot (--shots), the battlefield drawn first. */
const shot = async (p, label) => {
  if (!shots) return;
  await p.page.evaluate(() => window.__bd?.scene?.step(0, 1)).catch(() => undefined);
  await p.page.screenshot({ path: `${SHOT_DIR}/duel-${label}-${p.name}.png` });
};
/** The text of the first element `sel` finds now ("" if none: no waiting for it). */
const text = (p, sel) => p.page.evaluate((q) => document.querySelector(q)?.innerText ?? "", sel).catch(() => "");

/** The Duel button on the menu, once its chunk is in (Skirmish tab). */
async function tapDuel(p) {
  await p.page.waitForSelector("#play-duel:not([disabled])", { timeout: 30000 });
  await p.page.locator("#play-duel").tap();
  await p.page.waitForSelector(".duelsheet", { timeout: 10000 });
}

/** Wait for the opener cards (paired) and read the paired line and the map line. */
async function paired(p) {
  await p.page.waitForSelector(".duel-cards .op-card", { timeout: 45000 });
  return { line: await text(p, ".duel-paired"), map: await text(p, ".duel-map"), muts: await text(p, ".duel-muts") };
}

/** Cancel the lobby: the sheet goes, and the Duel button comes back. */
async function cancel(p) {
  await p.page.locator(".duelsheet [data-act=cancel]").tap();
  await p.page.waitForSelector(".duel-wrap", { state: "detached", timeout: 10000 });
  await p.page.waitForSelector("#play-duel:not([disabled])", { timeout: 10000 });
}

// --------------------------------------------------- 1. the lobby by hand ---

log("1. the lobby: Host and Join");
await both((p) => p.page.goto(urlFor(null), { waitUntil: "networkidle" }));
check((await both((p) => p.page.evaluate(() => document.visibilityState))).every((v) => v === "visible"), "a page isn't visible: its frames would say paused");
await both(tapDuel);
check(await phones.host.page.locator(".duel-practice").isVisible(), "the lobby doesn't say it's a practice link");
await phones.host.page.locator(".duel-role[data-act=host]").tap();
await phones.guest.page.locator(".duel-role[data-act=join]").tap();
{
  const [h, g] = await both(paired);
  log(`paired: host "${h.line}", guest "${g.line}"`);
  check(/you play blue/i.test(h.line) && /you play red/i.test(g.line), `sides: host "${h.line}", guest "${g.line}"`);
  check(/Riverlands/.test(h.map) && h.map === g.map, `the map: host "${h.map}", guest "${g.map}" (the host's Riverlands)`);
  check(/Rapid Fab/.test(h.muts) && h.muts === g.muts, `the mutators: host "${h.muts}", guest "${g.muts}" (the host's Rapid Fab)`);
  await both((p) => shot(p, "1-paired"));
}
await both(cancel);

// ----------------------------------------------------------- 2. the match ---

log("2. the match: seats");
await phones.host.page.goto(urlFor("host"), { waitUntil: "networkidle" });
await phones.guest.page.goto(urlFor("guest"), { waitUntil: "networkidle" });
await both(tapDuel);
// (a seat pairs at once: no Host / Join)
check((await phones.host.page.locator(".duel-role").count()) === 0, "a seat page offered Host / Join");
await both(paired);
const picks = {};
for (const p of [phones.host, phones.guest]) {
  const ids = await p.page.locator(".duel-cards .op-card").evaluateAll((els) => els.map((e) => e.dataset.id));
  picks[p.name] = p.name === "host" ? ids[0] : ids[ids.length - 1];
  await p.page.locator(`.duel-cards .op-card[data-id="${picks[p.name]}"]`).tap();
}
log(`picks: host ${picks.host}, guest ${picks.guest}`);
await both((p) => p.page.waitForFunction(() => window.__bd?.scene && window.__duel?.state === "match", null, { timeout: 90000 }));
log("both matches are up");

const player = async (p) => p.page.evaluate(() => window.__bd.player);
check((await player(phones.host)) === "blue" && (await player(phones.guest)) === "red", "the host plays blue and the guest red");
{
  const w = await both((p) => p.page.evaluate(() => ({ map: window.__bd.world.mapId, rules: JSON.stringify(window.__bd.world.rules ?? null) })));
  check(w[0].map === "riverlands" && w[1].map === "riverlands", `both play the host's map: ${JSON.stringify(w)}`);
  check(w[0].rules === w[1].rules && w[0].rules !== "null", `both play the host's mutators: ${JSON.stringify(w)}`);
}
check((await phones.host.page.locator(".duel-wrap").count()) === 0, "the lobby sheet stayed up into the match");

/** Every tick a page was seen at, with its hash trail there: both pages must agree wherever both were seen. */
const sample = (p, list) => {
  for (const [tick, trail] of list) if (tick >= 0 && trail !== null) p.trail.set(tick, trail);
};
/**
 * Two frames of 100 ms on each page in a match, undrawn (a tick each at most:
 * the lockstep holds it to the turns that have arrived), and its tick and
 * trail after each. A page on the menu or reloading is left alone.
 */
const stepBoth = () =>
  both((p) =>
    p.page
      .evaluate(() => {
        if (!window.__bd?.scene || !window.__duel) return [];
        const seen = [];
        for (let i = 0; i < 2; i++) {
          window.__bd.scene.step(100, 1, false);
          seen.push([window.__duel.tick, window.__duel.trail()]);
        }
        return seen;
      })
      .then((s) => sample(p, s), () => undefined)
  );
/** Advance both pages for `ms` of real time (the link sets the pace). */
async function run(ms, until = null) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await stepBoth();
    if (until && (await until())) return true;
    await sleep(30);
  }
  return false;
}
const tick = (p) => p.page.evaluate(() => window.__duel.tick);
const ticks = () => both(tick);

await run(3000);
const [t0h, t0g] = await ticks();
log(`ticks after 3 s: host ${t0h}, guest ${t0g}`);
check(t0h > 5 && t0g > 5, "the match doesn't advance");
// the openers both picked are in both worlds
{
  const kinds = await both((p) => p.page.evaluate(() => [...window.__bd.world.buildings.values()].map((b) => `${b.faction}:${b.kind}`).sort().join(",")));
  check(kinds[0] === kinds[1], `the buildings differ: host ${kinds[0]} / guest ${kinds[1]}`);
}

// orders: a build bar tap on each phone (real taps, once it has the scrap), and a move through the Controller
const btn = (p, name) => p.page.locator(".bb", { has: p.page.locator(".nm", { hasText: new RegExp(`^${name}$`) }) });
const rich = await run(30000, async () =>
  (await both((p) => p.page.evaluate(() => window.__bd.world.factions[window.__bd.player].scrap >= 300 && !window.__bd.world.factions[window.__bd.player].pending))).every(Boolean)
);
check(rich, "no scrap for a Fab Plant after 30 s");
/** Each side's Fab Plants, built or under construction (an opener may have brought one). */
const fabs = (p) =>
  p.page.evaluate(() => {
    const w = window.__bd.world;
    const n = (f) => [...w.buildings.values()].filter((b) => b.faction === f && b.kind === "fab-plant").length + (w.factions[f].pending?.kind === "fab-plant" ? 1 : 0);
    return { blue: n("blue"), red: n("red") };
  });
const fabsBefore = await fabs(phones.host);
for (const p of [phones.host, phones.guest]) await btn(p, "Fab").tap();
const moved = {};
for (const p of [phones.host, phones.guest])
  moved[p.name] = await p.page.evaluate(() => {
    const { world: w, ctrl, player: me } = window.__bd;
    const ids = [...w.units.values()].filter((u) => u.faction === me && u.kind !== "harvester").map((u) => u.id);
    if (ids.length) ctrl.enqueue({ type: "move", faction: me, unitIds: ids, x: w.width / 2, y: w.height / 2 });
    return ids;
  });
log(`orders: Fab on both, moves for ${moved.host.length} host and ${moved.guest.length} guest units`);
await run(4000);
// (both phones' worlds have both sides' Fab Plants; the saved battle below has the orders as stepped)
for (const p of [phones.host, phones.guest]) {
  const now = await fabs(p);
  check(now.blue > fabsBefore.blue && now.red > fabsBefore.red, `the Fab taps didn't land on the ${p.name}'s phone: ${JSON.stringify(fabsBefore)} → ${JSON.stringify(now)}`);
}
await both((p) => shot(p, "2-match"));

// the outage: the host's packets don't reach the guest for OUTAGE ms
if (OUTAGE > 0) {
  log(`outage: host→guest cut for ${OUTAGE} ms`);
  air.cut("host", OUTAGE);
  let waited = false;
  await run(OUTAGE, async () => {
    if (!waited) waited = /Waiting for your friend/.test(await text(phones.guest, ".duel-stall:not([hidden])"));
    return false;
  });
  check(OUTAGE < 1500 || waited, "the guest didn't show \"Waiting for your friend…\" in the outage");
  const before = await ticks();
  await run(4000);
  const after = await ticks();
  log(`after the outage: host ${before[0]} → ${after[0]}, guest ${before[1]} → ${after[1]}`);
  check(after[0] > before[0] + 10 && after[1] > before[1] + 10, "the match didn't go on after the outage");
}

// pause: the host pauses; the guest stalls within D ticks and says so
log("pause");
await phones.host.page.locator("#btn-menu").tap();
check(await phones.host.page.evaluate(() => window.__bd.ctrl.paused), "the pause button didn't pause");
const pauseLine = await text(phones.host, "#pause .time");
const D = Math.round(Number(/🔊 (\d+) ms/.exec(pauseLine)?.[1] ?? NaN) / 100);
check(/vs your friend · 🔊 \d+ ms/.test(pauseLine) && D >= 3 && D <= 8, `the pause line: "${pauseLine}"`);
check((await phones.host.page.locator("#p-resign").count()) === 1, "no Resign in the pause menu");
check((await phones.host.page.locator("#p-quit, #p-fog").count()) === 0, "the duel's pause menu offers Quit or the fog toggle");
await shot(phones.host, "3-paused");
const hostAt = await tick(phones.host);
let friendPaused = false;
await run(3500, async () => {
  if (!friendPaused) friendPaused = /Friend paused/.test(await text(phones.guest, ".duel-stall:not([hidden])"));
  return false;
});
const [hostHeld, guestHeld] = await ticks();
await run(1000);
const [, guestHeld2] = await ticks();
log(`paused at host tick ${hostAt} (D ${D}): host ${hostHeld}, guest ${guestHeld} → ${guestHeld2}`);
check(hostHeld === hostAt, "the paused phone stepped on");
check(guestHeld2 === guestHeld && guestHeld <= hostAt + D + 1, `the friend didn't stall within D ticks of the pause (${guestHeld2} vs ${hostAt} + ${D})`);
check(friendPaused, "the friend didn't show \"Friend paused\"");
await shot(phones.guest, "3-friend-paused");
await phones.host.page.locator("#p-resume").tap();
await run(4000);
{
  const [h, g] = await ticks();
  check(h > hostHeld + 10 && g > guestHeld + 10, `the match didn't go on after the pause: host ${h}, guest ${g}`);
}

// more orders, then the guest resigns from the pause menu
for (const p of [phones.host, phones.guest])
  await p.page.evaluate(() => {
    const { world: w, ctrl, player: me } = window.__bd;
    const ids = [...w.units.values()].filter((u) => u.faction === me && u.kind !== "harvester").map((u) => u.id);
    if (ids.length) ctrl.enqueue({ type: "attackMove", faction: me, unitIds: ids, x: w.width / 2, y: w.height / 2 });
  });
const long = await run(90000, async () => (await ticks()).every((t) => t >= MATCH_TICKS));
check(long, `the match didn't reach tick ${MATCH_TICKS}: ${JSON.stringify(await ticks())}`);
log("the guest resigns");
await phones.guest.page.locator("#btn-menu").tap();
await phones.guest.page.locator("#p-resign").tap();
await phones.guest.page.locator("#p-yes").tap();
check(!(await phones.guest.page.evaluate(() => window.__bd.ctrl.paused)), "the pause menu stayed up after Resign");
const decided = await run(30000, async () => {
  const r = await both((p) => p.page.evaluate(() => window.__duel.result?.tick ?? null));
  return r.every((t) => t !== null);
});
check(decided, "the resign didn't decide both matches");
// the finale, then the report: step on until both show it
const reported = await run(60000, async () => (await both((p) => p.page.locator("#again").isVisible())).every(Boolean));
check(reported, "the report didn't show on both phones");
// the end check: "In sync ✓" on both
const synced = await run(15000, async () => (await both((p) => text(p, ".duel-sync"))).every((t) => /In sync/.test(t)));
{
  const res = await both((p) => p.page.evaluate(() => window.__duel.result));
  const end = await both((p) => p.page.evaluate(() => ({ tick: window.__duel.tick, trail: window.__duel.trail(), hash: window.__duel.hash() })));
  log(`results: ${JSON.stringify(res)}`);
  log(`ends: ${JSON.stringify(end)}`);
  for (const r of res) check(r && r.winner === "blue" && r.resigned === "red" && !r.desync, `the result: ${JSON.stringify(r)}`);
  check(res[0]?.tick === res[1]?.tick, "the two phones decided on different ticks");
  check(end[0].tick === end[1].tick && end[0].hash === end[1].hash && end[0].trail === end[1].trail, "the two worlds differ at the end");
  check(synced && res.every((r) => r?.endCheck === "ok"), `the end check: ${JSON.stringify(res.map((r) => r?.endCheck))}`);
}
// the hash trail wherever both pages were seen at the same tick
{
  const common = [...phones.host.trail.keys()].filter((t) => phones.guest.trail.has(t));
  const differ = common.filter((t) => phones.host.trail.get(t) !== phones.guest.trail.get(t));
  log(`trails: ${phones.host.trail.size} host and ${phones.guest.trail.size} guest ticks seen, ${common.length} in common`);
  check(common.length >= MATCH_TICKS * 0.6, `too few ticks seen on both pages (${common.length})`);
  check(differ.length === 0, `the hash trails differ at ticks ${differ.slice(0, 10).join(", ")}`);
}
// the report
{
  const heads = await both((p) => text(p, ".aar-head"));
  log(`heads: ${JSON.stringify(heads)}`);
  check(/VICTORY/.test(heads[0]) && /DEFEAT/.test(heads[1]), "the report's headline isn't VICTORY / DEFEAT");
  for (const h of heads) check(/vs your friend · Riverlands · .* · practice link \(no sound\)/.test(h), `the report's line: "${h}"`);
  for (const p of [phones.host, phones.guest]) {
    check(/Practice link \(no sound\)/.test(await text(p, ".duel-rec")), "the report doesn't say practice link");
    check((await p.page.locator("#duel-save").count()) === 1 && (await p.page.locator("#menu").count()) === 1, "Save battle or Main menu missing");
    check((await p.page.evaluate(() => localStorage.getItem("battledrones.soundduel"))) === null, "a practice link wrote the win/loss record");
    // (the duel played the host's map and mutators, and saved neither over this phone's menu picks)
    const kept = await p.page.evaluate(() => JSON.parse(localStorage.getItem("battledrones.settings") ?? "null"));
    check(kept?.mapId === SETTINGS[p.name].mapId && JSON.stringify(kept?.mutators) === JSON.stringify(SETTINGS[p.name].mutators), `the duel saved over the ${p.name}'s settings: ${JSON.stringify(kept)}`);
  }
  await both((p) => shot(p, "4-report"));
}
// Save battle: the same battle on both phones
{
  const recs = await both(async (p) => {
    const [dl] = await Promise.all([p.page.waitForEvent("download", { timeout: 10000 }), p.page.locator("#duel-save").tap()]);
    return JSON.parse(readFileSync(await dl.path(), "utf8"));
  });
  const keep = (r) => JSON.stringify({ map: r.map, mutators: r.mutators, seed: r.seed, openers: r.openers, seats: r.seats, turns: r.turns, hashes: r.hashes, tick: r.tick, end: r.end, maxTicks: r.maxTicks });
  log(`records: ${recs[0].turns?.length} turns, ${recs[0].hashes?.length} hashes, end ${JSON.stringify(recs[0].end)}`);
  check(keep(recs[0]) === keep(recs[1]), "the two phones saved different battles");
  check(recs[0].v === 1 && recs[0].frames === "own" && recs[0].hashes?.length >= 3 && recs[0].turns?.length >= 4, "the saved battle is thin");
  check(recs[0].seats?.blue?.player === "sound-duel:host" && recs[0].seats?.red?.player === "sound-duel:guest", `the seats: ${JSON.stringify(recs[0].seats)}`);
  // both sides' orders as stepped: the Fab taps, and the moves with the units they named
  const cmds = recs[0].turns.flatMap(([, , list]) => list);
  for (const f of ["blue", "red"]) {
    check(cmds.some((c) => c.faction === f && c.type === "startBuilding" && c.building === "fab-plant"), `${f}'s Fab tap isn't in the saved battle`);
    const ids = moved[f === "blue" ? "host" : "guest"];
    const sent = cmds.filter((c) => c.faction === f && c.type === "move").flatMap((c) => c.unitIds);
    check(ids.every((id) => sent.includes(id)), `${f}'s move isn't in the saved battle (${JSON.stringify(ids)})`);
    check(cmds.some((c) => c.faction === f && c.type === "resign") === (f === "red"), `the saved resigns: ${JSON.stringify(cmds.filter((c) => c.type === "resign"))}`);
  }
}

// --------------------------------------------------------- 3. rematch ---

log("3. rematch");
await phones.host.page.locator("#again").tap();
await phones.host.page.waitForSelector("#duel-rematch:not([disabled])", { timeout: 20000 });
await shot(phones.host, "5-rematch-boot");
await phones.host.page.locator("#duel-rematch").tap();
// (the guest is still on its report: the host's lobby frames say it's back)
const back = await run(20000, async () => /Your friend is back in the lobby/.test(await text(phones.guest, ".duel-back")));
check(back, "the guest's report didn't say \"Your friend is back in the lobby\"");
await shot(phones.guest, "5-friend-back");
await phones.guest.page.locator("#again").tap();
await phones.guest.page.waitForSelector("#duel-rematch:not([disabled])", { timeout: 20000 });
await phones.guest.page.locator("#duel-rematch").tap();
{
  const [h, g] = await both(paired);
  log(`rematch paired: host "${h.line}", guest "${g.line}"`);
  check(/you play red/i.test(h.line) && /you play blue/i.test(g.line), `the rematch didn't swap sides: host "${h.line}", guest "${g.line}"`);
  check(/Riverlands/.test(h.map) && h.map === g.map && /Rapid Fab/.test(h.muts) && h.muts === g.muts, "the rematch isn't on the same map and mutators");
  await both((p) => shot(p, "5-rematch-paired"));
}
await both(cancel);

log(`air: ${air.stats()}`);
const errors = [...phones.host.errors, ...phones.guest.errors];
if (errors.length) fail(`console errors: ${JSON.stringify(errors.slice(0, 10))}`);
console.log(failed ? "DUEL SMOKE FAILED" : `DUEL SMOKE OK (seed ${SEED}, loss ${LOSS}, latency ${LATENCY}+${JITTER} ms, outage ${OUTAGE} ms)`);
air.close();
await browser.close();
server?.close();
