// Duel audio session check (SOUND-DUEL.md "Rig", "Rematch"): the built app
// in Chromium with a fake microphone, and navigator.audioSession stubbed the
// way Safari keeps it. Each page's type is its own and starts "auto", but
// setting it sets the tab's override (here sessionStorage), which outlives
// the page; every AudioContext made logs the override it was made under.
// A context made under play-and-record can take a 16 kHz rate on an iPhone
// (src/link/rig.ts "The rate"), so none may be:
//
//   1. the menu, its first touch (the game's context), Duel (the rig: its
//      context, then play-and-record), Host; then the player reloads with the
//      lobby open. The lobby's pagehide closes the rig, and the next page's
//      boot puts the session back before its first touch makes a context;
//   2. a sound duel's rematch boot and its reconnect tap: the game's context
//      (none until this tap) and the rig's, both before play-and-record;
//      then Cancel, and the session is "auto" again.
//
// Prints "AUDIO SESSION OK".
// Usage: node tools/duel-audio-session.mjs [dist-dir | url]
// (serves dist/ by default: run `npm run build` first)
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml", ".json": "application/json",
  ".webmanifest": "application/manifest+json"
};
const where = process.argv.slice(2).find((a) => !a.startsWith("--"));
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
  // (localhost is a secure context: the menu offers the sound duel)
  await new Promise((r) => server.listen(0, "localhost", r));
  base = `http://localhost:${server.address().port}/`;
}

/** In every page, before its scripts: the stub and the context log (console lines "[session] …"). */
function stub() {
  const KEY = "__audioSessionOverride";
  const override = () => sessionStorage.getItem(KEY) ?? "auto";
  let type = "auto";
  const session = {
    get type() {
      return type;
    },
    set type(t) {
      type = t;
      sessionStorage.setItem(KEY, t);
      console.info(`[session] type = ${t}`);
    }
  };
  Object.defineProperty(Navigator.prototype, "audioSession", { get: () => session, configurable: true });
  const AC = window.AudioContext;
  window.AudioContext = class extends AC {
    constructor(...a) {
      super(...a);
      console.info(`[session] new context under ${override()}`);
    }
  };
  console.info(`[session] page load under ${override()}`);
}

const exe = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/usr/bin/google-chrome"].find((p) => existsSync(p));
const browser = await chromium.launch({
  executablePath: exe,
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: "block", permissions: ["microphone"] });
await ctx.addInitScript(stub);
const page = await ctx.newPage();
const log = [];
const errors = [];
page.on("console", (m) => {
  if (m.text().startsWith("[session] ")) log.push(m.text().slice(10));
  else if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(String(e)));
const problems = [];
const expectLog = (step, want) => {
  const got = log.splice(0);
  console.log(`${step}:\n  ${got.join("\n  ")}`);
  for (const line of got) if (line.includes("context under play-and-record")) problems.push(`${step}: a ${line}`);
  for (const w of want) if (!got.includes(w)) problems.push(`${step}: no "${w}" in [${got.join(", ")}]`);
  return got;
};
const override = () => page.evaluate(() => sessionStorage.getItem("__audioSessionOverride") ?? "auto");

// 1. the menu, Duel, Host, and the player's own reload with the lobby open
await page.goto(base, { waitUntil: "networkidle" });
await page.waitForSelector("#play-duel:not([disabled])", { timeout: 30000 });
await page.locator("#howto").tap(); // (the first touch: the game's context)
await page.locator("#play-duel").tap();
await page.waitForSelector(".duel-role[data-act=host]", { timeout: 10000 });
await page.locator(".duel-role[data-act=host]").tap();
await page.waitForSelector(".duel-meter", { timeout: 10000 });
expectLog("menu, Duel, Host", ["new context under auto", "type = play-and-record"]);
if ((await override()) !== "play-and-record") problems.push("the lobby isn't in play-and-record");
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector("#play-duel:not([disabled])", { timeout: 30000 });
await page.locator("#howto").tap();
await page.waitForTimeout(300);
const after = expectLog("reload with the lobby open, then a touch", ["type = auto", "new context under auto"]);
// (the lobby's pagehide put it back as the page went, and the boot did before any context)
const loaded = after.findIndex((l) => l.startsWith("page load under"));
const reset = after.findIndex((l, i) => i > loaded && l === "type = auto");
const made = after.findIndex((l) => l.startsWith("new context"));
if (after[loaded] !== "page load under auto") problems.push(`the reloaded page: "${after[loaded]}" (the lobby's pagehide didn't close the rig)`);
if (!(reset > loaded && reset < made)) problems.push("the boot didn't put the session back before the first context");

// 2. a rematch boot and its reconnect tap, then Cancel
await page.evaluate(() => {
  sessionStorage.setItem("battledrones.duel", JSON.stringify({ role: "host", plan: "high", micMode: "raw", hostSide: "red", mapId: "riverlands", mutators: [] }));
  sessionStorage.setItem("battledrones.rematch", "duel");
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector("#duel-rematch:not([disabled])", { timeout: 30000 });
expectLog("rematch boot", ["type = auto"]);
await page.locator("#duel-rematch").tap();
await page.waitForSelector(".duelsheet", { timeout: 10000 });
const tap = expectLog("rematch tap", ["new context under auto", "type = play-and-record"]);
const underAuto = tap.filter((l) => l === "new context under auto").length;
if (underAuto < 2) problems.push(`the rematch tap made ${underAuto} context(s) under auto, not two (the game's and the rig's)`);
await page.locator(".duelsheet [data-act=cancel]").tap();
await page.waitForTimeout(500);
expectLog("Cancel", ["type = auto"]);
if ((await override()) !== "auto") problems.push("Cancel left the session in play-and-record");

if (errors.length) problems.push(`console errors: ${errors.join(" | ")}`);
await browser.close();
server?.close();
if (problems.length) {
  for (const p of problems) console.error(`FAIL: ${p}`);
  process.exitCode = 1;
} else console.log("AUDIO SESSION OK");
