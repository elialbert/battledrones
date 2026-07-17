// Headless smoke test: serves docs/, boots the game, asserts the sim runs,
// orders the starting harvester to mine, and verifies income arrives.
// Usage: node tools/smoke.mjs [width] [height] [--shots]
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../docs");
const SHOT_DIR = process.env.SMOKE_SHOT_DIR ?? "/tmp";
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".json": "application/json",
  ".webmanifest": "application/manifest+json"
};
const server = createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  const file = join(ROOT, p);
  if (!existsSync(file)) { res.writeHead(404); res.end("nf"); return; }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(8899, r));

const [, , w = "390", h = "844", shots = ""] = process.argv;
const exe = existsSync("/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell")
  ? "/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell"
  : undefined;
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: +w, height: +h }, hasTouch: true });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exitCode = 1; };

await page.goto("http://localhost:8899/", { waitUntil: "networkidle" });
await page.waitForTimeout(500);
if (shots) await page.screenshot({ path: `${SHOT_DIR}/shot-splash-${w}x${h}.png` });

await page.tap("#play");
await page.waitForFunction(() => window.__bd?.world?.tick > 5, null, { timeout: 15000 });
if (shots) await page.screenshot({ path: `${SHOT_DIR}/shot-game-${w}x${h}.png` });

// the sim advances at ~10 ticks/sec
const t1 = await page.evaluate(() => window.__bd.world.tick);
await page.waitForTimeout(2000);
const t2 = await page.evaluate(() => window.__bd.world.tick);
if (t2 - t1 < 10) fail(`sim too slow: ${t2 - t1} ticks in 2s`);

// REAL input path: tap the Harv button — the HQ queue must grow. This
// catches anything invisible swallowing pointer events over the HUD.
const harvBtn = [...(await page.$$("#grp-units .bb"))][0];
await harvBtn.tap();
// the command drains into the sim on the next tick — allow a moment
const queuedOk = await page
  .waitForFunction(
    () => {
      const w = window.__bd.world;
      const hq = [...w.buildings.values()].find(
        (b) => b.faction === "blue" && b.kind === "hq"
      );
      return hq.queue.length === 1;
    },
    null,
    { timeout: 3000 }
  )
  .then(() => true, () => false);
if (!queuedOk) fail("HUD tap did not queue a harvester");

// REAL input path: tap the harvester on the canvas — it must get selected.
// The starting spot sits at the map edge where HUD widgets overlap the
// camera-clamped view, so teleport it somewhere clear first (sim-legal:
// this tests the input path, not pathfinding).
const harvScreen = await page.evaluate(() => {
  const { world, cam } = window.__bd;
  const u = [...world.units.values()].find(
    (v) => v.faction === "blue" && v.kind === "harvester"
  );
  u.x = (cam.worldView.x + 200 / cam.zoom) / 64;
  u.y = (cam.worldView.y + 200 / cam.zoom) / 64;
  return { x: 200, y: 200, id: u.id };
});
await page.touchscreen.tap(harvScreen.x, harvScreen.y);
await page.waitForTimeout(300);
const selected = await page.evaluate(() => [...window.__bd.ctrl.selectedUnits]);
if (!selected.includes(harvScreen.id))
  fail(`canvas tap did not select the harvester (selected=${JSON.stringify(selected)})`);

// order the starting harvester to the home scrap field; scrap must rise
await page.evaluate(() => {
  const { world, ctrl } = window.__bd;
  const harv = [...world.units.values()].find(
    (u) => u.faction === "blue" && u.kind === "harvester"
  );
  ctrl.enqueue({ type: "harvest", faction: "blue", unitIds: [harv.id], x: 13.5, y: 37.5 });
});
const scrap0 = await page.evaluate(() => window.__bd.world.factions.blue.scrap);
await page.waitForFunction(
  (s0) => window.__bd.world.factions.blue.scrap > s0 + 50,
  scrap0,
  { timeout: 60000 }
);

// the AI must be doing something: buildings or units beyond the starting set
await page.waitForFunction(
  () => {
    const w = window.__bd.world;
    const redBuildings = [...w.buildings.values()].filter((b) => b.faction === "red");
    const redUnits = [...w.units.values()].filter((u) => u.faction === "red");
    return redBuildings.length + redUnits.length > 2;
  },
  null,
  { timeout: 90000 }
);

if (shots) {
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${SHOT_DIR}/shot-late-${w}x${h}.png` });
}

if (errors.length) fail(`console errors: ${JSON.stringify(errors)}`);
console.log(process.exitCode ? "SMOKE FAILED" : `SMOKE OK (${w}x${h})`);
await browser.close();
server.close();
