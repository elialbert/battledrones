// Four-player online smoke: three pages of the built app (the host and two
// friends), one browser context each, play a four-player battle on Compass
// Rose through the deployed relay (relay/README.md, src/ffa/), over the real
// internet. The fourth seat nobody joins goes to an AI commander.
//
// The relay accepts only the game's own origins, so the pages are served as
// https://simonw.github.io/battledrones/ (as tools/online-smoke.mjs does):
// every request there is answered from dist/, while the WebSockets to the
// relay go out for real.
//
//   1. The host taps "Battle friends online" on Compass Rose; the lobby shows
//      a battle code and a link for each friend's seat. Two friends open
//      theirs (red and green), give their names, Join, and pick an opener;
//      the host's lobby shows them, and Start says "2 friends, 1 AI".
//   2. The battle: the three pages are stepped with __bd.scene.step()
//      (undrawn). Every page plays the same world (the hash trails agree);
//      the pause line says 🌐 and the roster names the friends.
//   3. The end: green, red, then the host resign from the pause menu, a
//      moment apart; each is knocked out on every page, and the AI on purple
//      wins. Every page shows the report: DEFEAT, its place of 4, "online".
//   4. Rematch: the host taps Rematch and its new lobby has the same battle
//      code; red taps Rematch, joins again from its link, and the host's
//      lobby shows them. Both Cancel.
//
// Fails on any console error. Prints "FFA SMOKE OK".
// Usage: npm run build && node tools/ffa-smoke.mjs [--shots]
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
const RAF_MS = 250;
/** The battle goes on to this tick before the resigns. */
const MATCH_TICKS = 300;
/** A page held on one tick this long fails. */
const STUCK_MS = 30_000;

let failed = false;
const fail = (msg) => { console.error(`FAIL: ${msg}`); failed = true; process.exitCode = 1; };
const check = (ok, msg) => { if (!ok) fail(msg); return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const log = (msg) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)} s] ${msg}`);

if (!existsSync(join(ROOT, "index.html"))) throw new Error("no dist/index.html: run `npm run build` first");
const exe = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/opt/pw-browsers/chromium"].find((p) => existsSync(p));
const browser = await chromium.launch({
  executablePath: exe,
  ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY } } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"]
});
const SETTINGS = JSON.stringify({ mapId: "compass-rose", difficulty: "normal", mode: "skirmish", mutators: [] });
const pages = {};
for (const name of ["host", "red", "green"]) {
  const context = await browser.newContext({
    viewport: { width: 844, height: 390 }, deviceScaleFactor: 1, hasTouch: true, ignoreHTTPSErrors: true,
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
  }, SETTINGS);
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${name}: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`${name}: ${String(e)}`));
  pages[name] = { name, context, page, errors };
}
const { host, red, green } = pages;
const all = [host, red, green];
const each = (fn) => Promise.all(all.map(fn));
const text = (p, sel) => p.page.evaluate((q) => document.querySelector(q)?.innerText ?? "", sel).catch(() => "");
const shot = async (p, label) => {
  if (!shots) return;
  await p.page.evaluate(() => window.__bd?.scene?.step(0, 1)).catch(() => undefined);
  await p.page.screenshot({ path: `${SHOT_DIR}/ffa-${label}-${p.name}.png`, animations: "disabled" });
};
/** Two undrawn frames of 100 ms on each page in the battle. */
const stepAll = () =>
  each((p) =>
    p.page
      .evaluate(() => {
        if (!window.__bd?.scene || !window.__ffa) return;
        for (let i = 0; i < 2; i++) window.__bd.scene.step(100, 1, false);
      })
      .catch(() => undefined)
  );
const ticks = () => each((p) => p.page.evaluate(() => window.__ffa?.tick ?? -1).catch(() => -1));
async function run(ms, until) {
  const T = Date.now();
  while (Date.now() - T < ms) {
    await stepAll();
    if (await until()) return true;
    await sleep(30);
  }
  return false;
}
async function goTo(what, to) {
  const T = Date.now();
  let last = await ticks();
  const held = all.map(() => Date.now());
  for (;;) {
    await stepAll();
    const now = await ticks();
    if (now.every((t) => t >= to)) return void log(`${what}: ticks ${now.join(" / ")} after ${((Date.now() - T) / 1000).toFixed(1)} s`);
    for (let i = 0; i < all.length; i++) {
      if (now[i] !== last[i]) held[i] = Date.now();
      else if (now[i] < to && Date.now() - held[i] > STUCK_MS) return void fail(`${what}: ${all[i].name} was held on tick ${now[i]} for ${STUCK_MS / 1000} s`);
    }
    last = now;
    await sleep(30);
  }
}
/** Tap a button in a sheet: scrolled to the middle first (Playwright scrolls it to the edge, under the sheet's sticky buttons). */
async function tap(p, sel) {
  const l = p.page.locator(sel);
  await l.waitFor({ timeout: 30000 });
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.tap();
}
const outOn = (p) => p.page.evaluate(() => (window.__bd?.world.out ?? []).map((o) => o.faction)).catch(() => []);
async function resign(p, side) {
  await p.page.locator("#btn-menu").tap();
  await p.page.locator("#p-resign").tap();
  await p.page.locator("#p-yes").tap();
  check(await run(30000, async () => (await each(outOn)).every((o) => o.includes(side))), `${side}'s resign didn't knock it out on every page`);
  log(`${side} is out on every page`);
}

// ------------------------------------------------------- 1. the lobby ---

log("1. the lobby");
await host.page.goto(BASE, { waitUntil: "networkidle" });
await host.page.waitForSelector("#play-online:not([disabled])", { timeout: 30000 });
check(/up to 4/.test(await text(host, "#play-online")), `the online button on Compass Rose: "${await text(host, "#play-online")}"`);
await tap(host, "#play-online");
await host.page.waitForSelector(".ffa-sheet #ffa-seats .ffa-seat", { timeout: 30000 });
const code = (await text(host, ".ffa-lbl b")).trim();
check(/^[0-9A-HJKMNP-TV-Z]{8}$/.test(code), `the battle code: "${code}"`);
await tap(host, "[data-copy='1']");
await sleep(200);
const redLink = await host.page.evaluate(() => navigator.clipboard.readText());
check(redLink === `${BASE}#ffa=${code}-1`, `red's invite link: ${redLink}`);
log(`code ${code}; red's link ${redLink}`);
await tap(host, "[data-qr='2']");
check((await host.page.locator(".ffa-qr svg").count()) === 1, "green's QR code didn't show");
await shot(host, "1-lobby");

for (const [p, seat, name] of [[red, 1, "Ann"], [green, 2, "Bo"]]) {
  await p.page.goto(`${BASE}#ffa=${code}-${seat}`, { waitUntil: "networkidle" });
  await p.page.waitForSelector("#ffa-join", { timeout: 30000 });
  await p.page.locator("#ffa-name").fill(name);
  await tap(p, "#ffa-join");
  await p.page.waitForSelector(".ffa-sheet .ffa-seats", { timeout: 30000 });
  await tap(p, "[data-pick='blitz']");
}
check(
  await run(20000, async () => {
    const seats = await text(host, "#ffa-seats");
    return /Ann/.test(seats) && /Bo/.test(seats) && /Blitz/.test(seats);
  }),
  `the host's lobby doesn't show both friends and their picks: "${await text(host, "#ffa-seats")}"`
);
check(/2 friends, 1 AI/.test(await text(host, "#ffa-start")), `Start: "${await text(host, "#ffa-start")}"`);
check(/Ann/.test(await text(green, ".ffa-seats")), "green's lobby doesn't show Ann");
await shot(red, "1-joined");

// ------------------------------------------------------- 2. the battle ---

log("2. the battle");
await tap(host, "#ffa-start");
await each((p) => p.page.waitForFunction(() => window.__bd?.scene && window.__ffa, null, { timeout: 120000, polling: 250 }));
for (const p of all) await p.page.screenshot({ clip: { x: 0, y: 0, width: 4, height: 4 }, timeout: 120000 });
await each((p) => p.page.evaluate(() => cancelAnimationFrame(window.__bd.scene.raf)));
const sides = await each((p) => p.page.evaluate(() => window.__bd.player));
check(sides.join() === "blue,red,green", `the sides: ${sides.join()}`);
await goTo("the battle starts", 20);

await red.page.locator("#btn-menu").tap();
const pauseLine = await text(red, "#pause .time");
check(/vs your friends · 🌐 \d+ ms/.test(pauseLine), `the pause line: "${pauseLine}"`);
const before = (await ticks())[1];
await stepAll();
await stepAll();
check((await ticks())[1] > before, "the battle stopped under red's pause menu");
await red.page.locator("#p-resume").tap();
const roster = await text(red, "#versus");
check(/You/.test(roster) && /Host/.test(roster) && /Bo/.test(roster) && /AI/.test(roster), `red's roster: "${roster}"`);

for (const p of all)
  await p.page.evaluate(() => {
    const { world: w, ctrl, player: me } = window.__bd;
    const ids = [...w.units.values()].filter((u) => u.faction === me && u.kind !== "harvester").map((u) => u.id);
    if (ids.length) ctrl.enqueue({ type: "attackMove", faction: me, unitIds: ids, x: w.width / 2, y: w.height / 2 });
  });
await goTo(`on to tick ${MATCH_TICKS}`, MATCH_TICKS);
{
  const trails = await each((p) => p.page.evaluate(() => window.__ffa.trail()));
  const byTick = new Map(trails[0]);
  let compared = 0;
  for (const t of trails.slice(1))
    for (const [tick, h] of t)
      if (byTick.has(tick)) {
        compared++;
        check(byTick.get(tick) === h, `the worlds differ at tick ${tick}`);
      }
  check(compared >= 4, `only ${compared} hashes compared`);
  log(`hash trails agree at ${compared} checks`);
  check((await each((p) => p.page.evaluate(() => window.__ffa.desync()))).every((d) => d === null), "a page says it's out of sync");
  await each((p) => shot(p, "2-battle"));
}

// ---------------------------------------------------------- 3. the end ---

log("3. the end");
await resign(green, "green");
await resign(red, "red");
await resign(host, "blue");
check(await run(30000, async () => (await each((p) => p.page.evaluate(() => window.__bd.world.winner ?? null))).every((w) => w === "purple")), "purple didn't win on every page");
check(await run(60000, async () => (await each((p) => p.page.locator("#again").isVisible())).every(Boolean)), "the report didn't show on every page");
{
  const heads = await each((p) => text(p, ".aar-head"));
  log(`reports: ${heads.map((h) => JSON.stringify(h.replace(/\s+/g, " "))).join(" | ")}`);
  const places = { host: "2nd of 4", red: "3rd of 4", green: "4th of 4" };
  all.forEach((p, i) => {
    check(/DEFEAT/.test(heads[i]) && heads[i].includes(places[p.name]) && /online/.test(heads[i]), `${p.name}'s report: "${heads[i]}"`);
    check(/Purple · Balanced AI|Purple/.test(heads[i]), `${p.name}'s placings name purple`);
  });
  check(/Blue · Host/.test(heads[1]) && /Green · Bo/.test(heads[1]), `red's placings don't name the players: "${heads[1]}"`);
  await each((p) => shot(p, "3-report"));
}

// ---------------------------------------------------------- 4. rematch ---

log("4. rematch");
await host.page.locator("#again").tap();
await host.page.waitForSelector(".ffa-sheet #ffa-seats", { timeout: 60000 });
check((await text(host, ".ffa-lbl b")).trim() === code, "the host's rematch lobby has another battle code");
await red.page.locator("#again").tap();
await red.page.waitForSelector("#ffa-join", { timeout: 60000 });
await tap(red, "#ffa-join");
check(
  await run(30000, async () => /Ann/.test(await text(host, "#ffa-seats"))),
  `the host's rematch lobby doesn't show Ann: "${await text(host, "#ffa-seats")}"`
);
log("red is back in the host's lobby");
await tap(host, "#ffa-cancel");
await tap(red, "#ffa-menu");

const errors = all.flatMap((p) => p.errors);
for (const e of errors) fail(`console: ${e}`);
await browser.close();
if (!failed) console.log("FFA SMOKE OK");
