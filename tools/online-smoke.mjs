// Online smoke: two pages of the built app, one browser context each, play an
// online duel through the deployed relay (relay/README.md,
// src/versus/net-transport.ts), over the real internet.
//
// The relay accepts only the game's own origins, so the pages are served as
// https://simonw.github.io/battledrones/: every request there is answered
// from dist/ (Playwright's routing), while the WebSocket to the relay goes out
// for real.
//
//   1. The host taps "Duel a friend online" and reads the invite link off the
//      lobby; the guest opens it and taps "Join the battle". They pair (the
//      host's map and mutators, blue and red) and show the opener cards.
//   2. The match: each taps an opener, the match loads, and the pages are
//      stepped with __bd.scene.step() (undrawn, as tools/duel-smoke.mjs does).
//      The pause line says 🌐; past tick MATCH_TICKS the guest resigns from
//      the pause menu. Both decide on the same tick with the same world hash
//      and trail, the end check says "In sync ✓", and the report says
//      "online" and "🌐 Online duel".
//   3. Rematch: the host taps Rematch, then "Rematch · tap to start" (no
//      microphone); the guest sees "Your friend is back in the lobby", does
//      the same, and they pair in the same room with the sides swapped. Both
//      Cancel.
//
// Fails on any console error. Prints "ONLINE SMOKE OK".
// Usage: npm run build && node tools/online-smoke.mjs [--shots]
// (SMOKE_SHOT_DIR for --shots, default /tmp; HTTPS_PROXY, if set, is the browser's proxy)
import { chromium } from "playwright-core";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../dist");
const SHOT_DIR = process.env.SMOKE_SHOT_DIR ?? "/tmp";
const ORIGIN = "https://simonw.github.io";
const BASE = `${ORIGIN}/battledrones/`;
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".webp": "image/webp", ".json": "application/json",
  ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".mp3": "audio/mpeg", ".ogg": "audio/ogg"
};
const shots = process.argv.includes("--shots");
/** Each page's animation frames come this far apart (ms), as in the relay smoke. */
const RAF_MS = 250;
/** The match goes on to this tick before the resign. */
const MATCH_TICKS = 200;
/** A page held on one tick this long fails. */
const STUCK_MS = 20_000;

let failed = false;
const fail = (msg) => { console.error(`FAIL: ${msg}`); failed = true; process.exitCode = 1; };
const check = (ok, msg) => { if (!ok) fail(msg); return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const log = (msg) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)} s] ${msg}`);

if (!existsSync(join(ROOT, "index.html"))) throw new Error("no dist/index.html: run `npm run build` first");
const exe = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/usr/bin/google-chrome"].find((p) => existsSync(p));
const browser = await chromium.launch({
  executablePath: exe,
  ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY } } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"]
});
/** Each phone's menu: the host offers its map and mutators; the guest's own picks must not matter. */
const SETTINGS = {
  host: { mapId: "riverlands", difficulty: "normal", mode: "skirmish", mutators: ["rapidfab"] },
  guest: { mapId: "frostbite", difficulty: "normal", mode: "skirmish", mutators: [] }
};
const phones = {};
for (const name of ["host", "guest"]) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true, ignoreHTTPSErrors: true,
    // (the service worker would fetch past the routing)
    serviceWorkers: "block",
    permissions: ["clipboard-read", "clipboard-write"]
  });
  await context.route(`${ORIGIN}/**`, (route) => {
    let p = decodeURIComponent(new URL(route.request().url()).pathname);
    if (!p.startsWith("/battledrones/")) return route.fulfill({ status: 404, body: "nf" });
    p = p.slice("/battledrones".length);
    if (p.endsWith("/")) p += "index.html";
    const file = join(ROOT, p);
    if (!existsSync(file)) return route.fulfill({ status: 404, body: "nf" });
    return route.fulfill({ status: 200, contentType: MIME[extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
  });
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
  phones[name] = { name, context, page, errors };
}
const { host, guest } = phones;
const both = (fn) => Promise.all([fn(host), fn(guest)]);
const text = (p, sel) => p.page.evaluate((q) => document.querySelector(q)?.innerText ?? "", sel).catch(() => "");
const shot = async (p, label) => {
  if (!shots) return;
  await p.page.evaluate(() => window.__bd?.scene?.step(0, 1)).catch(() => undefined);
  await p.page.screenshot({ path: `${SHOT_DIR}/online-${label}-${p.name}.png`, animations: "disabled" });
};
async function paired(p) {
  await p.page.waitForSelector(".duel-cards .op-card", { timeout: 60000 });
  return { line: await text(p, ".duel-paired"), map: await text(p, ".duel-map"), muts: await text(p, ".duel-muts") };
}
async function cancel(p) {
  await p.page.locator(".duelsheet [data-act=cancel]").tap();
  await p.page.waitForSelector(".duel-wrap", { state: "detached", timeout: 10000 });
}
/** Two undrawn frames of 100 ms on each page in a match. */
const stepBoth = () =>
  both((p) =>
    p.page
      .evaluate(() => {
        if (!window.__bd?.scene || !window.__duel) return;
        for (let i = 0; i < 2; i++) window.__bd.scene.step(100, 1, false);
      })
      .catch(() => undefined)
  );
const ticks = () => both((p) => p.page.evaluate(() => window.__duel.tick));
/** Step both pages until `until()` holds, or `ms` pass. */
async function run(ms, until) {
  const T = Date.now();
  while (Date.now() - T < ms) {
    await stepBoth();
    if (await until()) return true;
    await sleep(30);
  }
  return false;
}
/** Step both pages until each reaches `to`; fails if either is held on one tick for STUCK_MS. */
async function goTo(what, to) {
  const T = Date.now();
  let last = await ticks();
  let held = [Date.now(), Date.now()];
  for (;;) {
    await stepBoth();
    const now = await ticks();
    if (now.every((t) => t >= to)) return void log(`${what}: ticks ${now.join(" / ")} after ${((Date.now() - T) / 1000).toFixed(1)} s`);
    for (const i of [0, 1]) {
      if (now[i] !== last[i]) held[i] = Date.now();
      else if (now[i] < to && Date.now() - held[i] > STUCK_MS) return void fail(`${what}: the ${i ? "guest" : "host"} was held on tick ${now[i]} for ${STUCK_MS / 1000} s`);
    }
    last = now;
    await sleep(30);
  }
}

// ------------------------------------------------------- 1. invite and join ---

log("1. invite and join");
await host.page.goto(BASE, { waitUntil: "networkidle" });
await host.page.waitForSelector("#play-online:not([disabled])", { timeout: 30000 });
await host.page.locator("#play-online").tap();
await host.page.waitForSelector(".duel-invite-url", { timeout: 30000 });
const invite = await host.page.locator(".duel-invite-url").inputValue();
log(`invite: ${invite}`);
check(/^https:\/\/simonw\.github\.io\/battledrones\/#vs=[0-9A-HJKMNP-TV-Z]{8}$/.test(invite), `the invite link: ${invite}`);
check(/open the link/.test(await text(host, ".duel-status")), "the host doesn't say it waits for the friend to open the link");
check((await host.page.locator(".duel-noise").count()) === 0, "the online lobby shows the sound warning");
await host.page.locator("[data-act=copy]").tap();
await sleep(200);
check((await host.page.evaluate(() => navigator.clipboard.readText())) === invite, "Copy link didn't put the link on the clipboard");
await shot(host, "1-invite");

await guest.page.goto(invite, { waitUntil: "networkidle" });
await guest.page.waitForSelector("#duel-join:not([disabled])", { timeout: 30000 });
await shot(guest, "1-join");
await guest.page.locator("#duel-join").tap();
check((await guest.page.evaluate(() => location.hash)) === "", "the invite stayed in the guest's URL after Join");
{
  const [h, g] = await both(paired);
  log(`paired: host "${h.line}", guest "${g.line}"; ${h.map}`);
  check(/you play blue/i.test(h.line) && /you play red/i.test(g.line), `sides: host "${h.line}", guest "${g.line}"`);
  check(/Riverlands/.test(h.map) && h.map === g.map, `the map: host "${h.map}", guest "${g.map}" (the host's Riverlands)`);
  check(/Rapid Fab/.test(h.muts) && h.muts === g.muts, `the mutators: host "${h.muts}", guest "${g.muts}"`);
  await both((p) => shot(p, "1-paired"));
}

// ----------------------------------------------------------- 2. the match ---

log("2. the match");
for (const p of [host, guest]) await p.page.locator(".duel-cards .op-card").first().tap();
await both((p) => p.page.waitForFunction(() => window.__bd?.scene && window.__duel?.state === "match", null, { timeout: 120000, polling: 250 }));
for (const p of [host, guest]) await p.page.screenshot({ clip: { x: 0, y: 0, width: 4, height: 4 }, timeout: 120000 });
await both((p) => p.page.evaluate(() => cancelAnimationFrame(window.__bd.scene.raf)));
const D = await host.page.evaluate(() => window.__duel.delay);
log(`both matches are up; input delay D ${D} (${D * 100} ms)`);
check(D >= 3 && D <= 8 && D === (await guest.page.evaluate(() => window.__duel.delay)), `the input delay: ${D}`);
check((await host.page.evaluate(() => window.__bd.player)) === "blue" && (await guest.page.evaluate(() => window.__bd.player)) === "red", "the host plays blue and the guest red");
await goTo("the match goes on", 2 * D + 1);

await host.page.locator("#btn-menu").tap();
const pauseLine = await text(host, "#pause .time");
check(/vs your friend · 🌐 \d+ ms/.test(pauseLine), `the pause line: "${pauseLine}"`);
await shot(host, "2-paused");
await host.page.locator("#p-resume").tap();

for (const p of [host, guest])
  await p.page.evaluate(() => {
    const { world: w, ctrl, player: me } = window.__bd;
    const ids = [...w.units.values()].filter((u) => u.faction === me && u.kind !== "harvester").map((u) => u.id);
    if (ids.length) ctrl.enqueue({ type: "attackMove", faction: me, unitIds: ids, x: w.width / 2, y: w.height / 2 });
  });
await goTo(`on to tick ${MATCH_TICKS}`, MATCH_TICKS);
await both((p) => shot(p, "2-match"));

log("the guest resigns");
await guest.page.locator("#btn-menu").tap();
await guest.page.locator("#p-resign").tap();
await guest.page.locator("#p-yes").tap();
check(await run(30000, async () => (await both((p) => p.page.evaluate(() => window.__duel.result?.tick ?? null))).every((t) => t !== null)), "the resign didn't decide both matches");
check(await run(60000, async () => (await both((p) => p.page.locator("#again").isVisible())).every(Boolean)), "the report didn't show on both phones");
const synced = await run(15000, async () => (await both((p) => text(p, ".duel-sync"))).every((t) => /In sync/.test(t)));
{
  const res = await both((p) => p.page.evaluate(() => window.__duel.result));
  const end = await both((p) => p.page.evaluate(() => ({ tick: window.__duel.tick, trail: window.__duel.trail(), hash: window.__duel.hash() })));
  log(`results: ${JSON.stringify(res)}`);
  log(`ends: ${JSON.stringify(end)}`);
  for (const r of res) check(r && r.winner === "blue" && r.resigned === "red" && !r.desync, `the result: ${JSON.stringify(r)}`);
  check(res[0]?.tick === res[1]?.tick && res[0].tick >= MATCH_TICKS, "the two phones decided on different ticks");
  check(end[0].tick === end[1].tick && end[0].hash === end[1].hash && end[0].trail === end[1].trail, "the two worlds differ at the end");
  check(synced && res.every((r) => r?.endCheck === "ok"), `the end check: ${JSON.stringify(res.map((r) => r?.endCheck))}`);
  const heads = await both((p) => text(p, ".aar-head"));
  check(/VICTORY/.test(heads[0]) && /DEFEAT/.test(heads[1]), "the report's headline isn't VICTORY / DEFEAT");
  for (const h of heads) check(/vs your friend · Riverlands · .* · online/.test(h), `the report's line: "${h}"`);
  for (const p of [host, guest]) {
    check(/Online duel/i.test(await text(p, ".duel-h")), `the ${p.name}'s report section isn't "Online duel"`);
    check(/Your record/.test(await text(p, ".duel-rec")), `the ${p.name}'s report keeps no record`);
  }
  await both((p) => shot(p, "2-report"));
}

// ------------------------------------------------------------ 3. rematch ---

log("3. rematch");
await host.page.locator("#again").tap();
await host.page.waitForSelector("#duel-rematch:not([disabled])", { timeout: 30000 });
check(/tap to start/.test(await text(host, "#duel-rematch")), `the online rematch asks for the microphone: "${await text(host, "#duel-rematch")}"`);
await host.page.locator("#duel-rematch").tap();
check(await run(30000, async () => /Your friend is back in the lobby/.test(await text(guest, ".duel-back"))), "the guest's report didn't say \"Your friend is back in the lobby\"");
await guest.page.locator("#again").tap();
await guest.page.waitForSelector("#duel-rematch:not([disabled])", { timeout: 30000 });
await guest.page.locator("#duel-rematch").tap();
{
  const [h, g] = await both(paired);
  log(`rematch paired: host "${h.line}", guest "${g.line}"`);
  check(/you play red/i.test(h.line) && /you play blue/i.test(g.line), `the rematch didn't swap sides: host "${h.line}", guest "${g.line}"`);
  check(/Riverlands/.test(h.map) && h.map === g.map, "the rematch isn't on the same map");
}
await both(cancel);

const errors = [...host.errors, ...guest.errors];
if (errors.length) fail(`console errors: ${JSON.stringify(errors.slice(0, 10))}`);
console.log(failed ? "ONLINE SMOKE FAILED" : "ONLINE SMOKE OK");
await browser.close();
