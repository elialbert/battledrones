// Duel lobby layout check (SOUND-DUEL.md "The lobby"): the built app at
// ?duel=loop (a practice link: no sound, no microphone) on phone sizes in
// both orientations, a tablet and a desktop window. At each size it taps
// Duel, looks at the first step (Host, Join, Advanced, Cancel), taps Host,
// waits for the opener cards (the loop's friend pairs at once) and looks
// again.
//
// What "looks" means, for every tap target in the sheet ([data-act]):
//  - everything drawn inside it stays inside its box (a card's name, tagline
//    and "what it gives" line, its art), so what reads as one card is one;
//  - no two targets overlap;
//  - scrolled into view (the sheet may scroll), a tap at the middle of each
//    piece of it lands on that target and no other;
// and the page never scrolls sideways, nor does the sheet.
//
// Fails on any console error. Prints "LOBBY LAYOUT OK".
// Usage: node tools/duel-lobby-layout.mjs [--shots] [dist-dir | url]
// (serves dist/ by default: run `npm run build` first; SMOKE_SHOT_DIR for --shots, default /tmp)
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SHOT_DIR = process.env.SMOKE_SHOT_DIR ?? "/tmp";
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml", ".json": "application/json",
  ".webmanifest": "application/manifest+json"
};
/** Portrait and landscape phones (the smallest first), a tablet and a desktop window. */
const SIZES = [
  [320, 568], [390, 844], [568, 320], [844, 390], [932, 430], [1024, 768], [1280, 800]
];
const args = process.argv.slice(2);
const shots = args.includes("--shots");
const where = args.find((a) => !a.startsWith("--"));
let server = null;
let base = where && /^https?:/.test(where) ? where : null;
if (!base) {
  const root = resolve(where ?? join(dirname(fileURLToPath(import.meta.url)), "../dist"));
  server = createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    const file = join(root, p);
    if (!existsSync(file)) { res.writeHead(404); res.end("nf"); return; }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}/`;
}
const url = new URL("?duel=loop", base).href;

const exe = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find((p) => existsSync(p));
const browser = await chromium.launch({
  executablePath: exe,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
});
const problems = [];

/**
 * In the page: the sheet's tap targets, each checked as the header says.
 * The sheet's buttons bar (Back, Cancel) is sticky: it stays at the bottom
 * of the sheet while the rest scrolls under it, so the rest is checked
 * scrolled clear of it. Returns what's wrong, as lines.
 */
function inspect() {
  const out = [];
  const sheet = document.querySelector(".duelsheet");
  if (!sheet) return ["no sheet"];
  const bar = sheet.querySelector(".duel-actions");
  const name = (el) => el.dataset.id ?? el.dataset.act + (el.dataset.v ? `=${el.dataset.v}` : "");
  const what = (el) => (typeof el.className === "string" && el.className) || el.tagName.toLowerCase();
  const W = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > W + 1) out.push(`the page scrolls sideways (${document.documentElement.scrollWidth} > ${W})`);
  if (sheet.scrollWidth > sheet.clientWidth + 1) out.push(`the sheet scrolls sideways (${sheet.scrollWidth} > ${sheet.clientWidth})`);
  const sr = sheet.getBoundingClientRect();
  if (sr.left < -1 || sr.right > W + 1 || sr.top < -1 || sr.bottom > innerHeight + 1)
    out.push(`the sheet leaves the screen: ${[sr.left, sr.top, sr.right, sr.bottom].map(Math.round)}`);
  // (a closed Advanced keeps its buttons laid out but hidden: checkVisibility says so)
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && el.checkVisibility({ visibilityProperty: true });
  };
  const targets = [...sheet.querySelectorAll("[data-act]")].filter(shown);
  const floating = (el) => !!bar && bar.contains(el);
  // (boxes in the sheet's own coordinates, so scrolling between measurements doesn't matter; the bar's where it shows)
  const box = (el) => {
    const r = el.getBoundingClientRect();
    if (floating(el)) return { l: r.left, t: r.top, r: r.right, b: r.bottom };
    const s = sheet.getBoundingClientRect();
    return { l: r.left - s.left, t: r.top - s.top + sheet.scrollTop, r: r.right - s.left, b: r.bottom - s.top + sheet.scrollTop };
  };
  const within = (a, b) => a.l >= b.l - 1 && a.t >= b.t - 1 && a.r <= b.r + 1 && a.b <= b.b + 1;
  const overlap = (a, b) => Math.min(a.r, b.r) - Math.max(a.l, b.l) > 1 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 1;
  /** The pieces of a target a player reads or aims at: its children, and every leaf inside them. */
  const pieces = (el) => [...el.querySelectorAll("*")].filter((c) => shown(c) && (c.children.length === 0 || c.parentElement === el));
  for (const t of targets) {
    const tb = box(t);
    for (const c of pieces(t))
      if (!within(box(c), tb)) out.push(`${name(t)}: its ${what(c)} spills out (${JSON.stringify(box(c))} outside ${JSON.stringify(tb)})`);
  }
  for (let i = 0; i < targets.length; i++)
    for (let j = i + 1; j < targets.length; j++)
      if (floating(targets[i]) === floating(targets[j]) && overlap(box(targets[i]), box(targets[j])))
        out.push(`${name(targets[i])} and ${name(targets[j])} overlap`);
  for (const t of targets) {
    for (const c of [t, ...pieces(t)]) {
      let r = c.getBoundingClientRect();
      if (!floating(t)) {
        // scroll the piece to the middle of what the sheet shows above its buttons bar
        const top = sheet.getBoundingClientRect().top + sheet.clientTop;
        const bottom = bar ? bar.getBoundingClientRect().top : top + sheet.clientHeight;
        sheet.scrollTop += r.top + r.height / 2 - (top + bottom) / 2;
        r = c.getBoundingClientRect();
        const y = r.top + r.height / 2;
        const barTop = bar ? bar.getBoundingClientRect().top : Infinity;
        if (y < top || y > Math.min(bottom, barTop)) {
          out.push(`${name(t)}: its ${what(c)} can't be scrolled clear of the buttons`);
          continue;
        }
      }
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      if (x < 0 || y < 0 || x > W || y > innerHeight) {
        out.push(`${name(t)}: its ${what(c)} is off the screen`);
        continue;
      }
      const hit = document.elementFromPoint(x, y)?.closest("[data-act]");
      if (hit !== t) out.push(`${name(t)}: a tap on its ${what(c)} lands on ${hit ? name(hit) : "nothing"}`);
    }
  }
  sheet.scrollTop = 0;
  return out;
}

for (const [w, h] of SIZES) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: "block" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  const at = `${w}x${h}`;
  const shot = async (step) => {
    if (shots) await page.screenshot({ path: `${SHOT_DIR}/lobby-${step}-${at}.png` });
  };
  const check = async (step) => {
    // (the sheet's and the cards' entrance animations: measured once they're over)
    await page.waitForTimeout(700);
    await shot(step);
    for (const p of await page.evaluate(inspect)) problems.push(`${at} ${step}: ${p}`);
  };
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForSelector("#play-duel:not([disabled])", { timeout: 30000 });
  await page.locator("#play-duel").tap();
  await page.waitForSelector(".duel-role[data-act=host]", { timeout: 10000 });
  await check("roles");
  await page.locator(".duel-role[data-act=host]").tap();
  await page.waitForSelector(".duel-cards .op-card", { timeout: 45000 });
  await check("cards");
  if (shots) {
    // (what a player sees scrolled down to the cards, for the eye)
    await page.evaluate(() => document.querySelector(".duel-cards")?.scrollIntoView({ block: "start" }));
    await page.waitForTimeout(100);
    await shot("cards-scrolled");
  }
  if (errors.length) problems.push(`${at}: console errors: ${errors.join(" | ")}`);
  await ctx.close();
  console.log(`${at}: checked`);
}

await browser.close();
server?.close();
if (problems.length) {
  for (const p of problems) console.error(`FAIL: ${p}`);
  process.exitCode = 1;
} else console.log("LOBBY LAYOUT OK");
