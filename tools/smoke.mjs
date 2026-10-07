// Headless smoke test: serves docs/ (or uses a given URL), boots the game
// and drives the REAL input paths with taps: construct + place a Fab Plant
// (tap moves the ghost, tapping the ghost builds), queue a Stinger, select
// it on the canvas, save it as squad 1 and order it around, open an info
// card, pause/resume. Fails on any console error.
// Usage: node tools/smoke.mjs [width] [height] [--shots] [url]
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../docs");
const SHOT_DIR = process.env.SMOKE_SHOT_DIR ?? "/tmp";
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".webp": "image/webp", ".json": "application/json",
  ".webmanifest": "application/manifest+json"
};
const [, , w = "390", h = "844", shots = "", urlArg] = process.argv;
let server = null;
if (!urlArg) {
  server = createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    const file = join(ROOT, p);
    if (!existsSync(file)) { res.writeHead(404); res.end("nf"); return; }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(8899, r));
}
const url = urlArg ?? "http://localhost:8899/";

const exe = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find((p) => existsSync(p));
const browser = await chromium.launch({
  executablePath: exe,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
});
const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 2, hasTouch: true });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exitCode = 1; };
const shot = async (name) => { if (shots) await page.screenshot({ path: `${SHOT_DIR}/smoke-${name}-${w}x${h}.png` }); };
/** Run the game loop n × 100 ms of sim time without waiting in real time. */
const ff = (n) =>
  page.evaluate((k) => {
    const s = window.__bd.scene;
    for (let i = 0; i < k; i++) {
      s.game.loop.rawDelta = 100;
      s.update(0, 100);
    }
  }, n);
const world = (fn, arg) => page.evaluate(fn, arg);

await page.goto(url, { waitUntil: "networkidle" });
await page.evaluate(() => localStorage.setItem("battledrones.settings", JSON.stringify({ mapId: "riverlands", difficulty: "easy" })));
await page.reload({ waitUntil: "networkidle" });
await shot("menu");
await page.tap("#play");
await page.waitForFunction(() => window.__bd?.world?.tick > 5, null, { timeout: 30000 });
await page.waitForTimeout(500);
await shot("start");

// the sim advances at ~10 ticks/sec in real time (after texture-upload warm-up;
// headless Chrome renders in software, so be lenient)
await page.waitForTimeout(2500);
const t1 = await world(() => window.__bd.world.tick);
await page.waitForTimeout(3000);
const t2 = await world(() => window.__bd.world.tick);
if (t2 - t1 < 15) fail(`sim too slow: ${t2 - t1} ticks in 3s`);

// the starting harvester goes to work on its own
await ff(60);
const mining = await world(() => [...window.__bd.world.units.values()].some((u) => u.faction === "blue" && u.kind === "harvester" && u.order.type === "harvest"));
if (!mining) fail("starting harvester is not harvesting");

// 1. construct a Fab Plant from the build bar (real tap)
const btn = (name) => page.locator(".bb", { has: page.locator(".nm", { hasText: new RegExp(`^${name}$`) }) });
await btn("Fab").tap();
await ff(2);
const pending = await world(() => window.__bd.world.factions.blue.pending?.kind);
if (pending !== "fab-plant") fail(`Fab tap did not start construction (pending=${pending})`);
await ff(110); // 10 s build
await btn("Fab").tap(); // ready: enter placement mode
const placing = await world(() => window.__bd.ctrl.placing);
if (placing !== "fab-plant") fail(`ready Fab tap did not enter placement (placing=${placing})`);
// tap a valid spot near the HQ, found via the sim's own rules
const spot = await world(() => {
  const { world: w, cam, scene } = window.__bd;
  const hq = [...w.buildings.values()].find((b) => b.faction === "blue" && b.kind === "hq");
  const dpr = scene.game.registry.get("dpr");
  for (let r = 1; r < 7; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const tx = hq.tx + dx, ty = hq.ty + dy;
        if (!window.__bd.canPlace(tx, ty)) continue;
        const wx = (tx + 1) * 64, wy = (ty + 1) * 64;
        cam.centerOn(wx, wy);
        cam.preRender();
        const sx = (wx - cam.worldView.x) * cam.zoom / dpr, sy = (wy - cam.worldView.y) * cam.zoom / dpr;
        return { sx, sy, tx, ty };
      }
  return null;
});
if (!spot) fail("no valid Fab spot found");
else {
  const isPlaced = () => world(() => [...window.__bd.world.buildings.values()].some((b) => b.faction === "blue" && b.kind === "fab-plant"));
  // on touch a tap moves the ghost there (no build yet) …
  await page.touchscreen.tap(spot.sx, spot.sy);
  await page.waitForTimeout(350); // let the double-tap window lapse
  await ff(2);
  if (!(await isPlaced())) {
    const at = await world(() => window.__bd.ctrl.placeAt);
    if (!at || at.tx !== spot.tx || at.ty !== spot.ty) fail(`tapping the map did not move the ghost (placeAt=${JSON.stringify(at)})`);
    // … and tapping the ghost builds it
    await page.touchscreen.tap(spot.sx, spot.sy);
    await ff(3);
  }
  if (!(await isPlaced())) fail("tapping the ghost did not place the Fab Plant");
}
await shot("placed");

// 2. queue a Stinger from the Vehicles tab
await page.locator(".tab[data-tab=ground]").tap();
await btn("Stinger").tap();
await ff(3);
const queued = await world(() => [...window.__bd.world.buildings.values()].some((b) => b.kind === "fab-plant" && b.faction === "blue" && b.queue.length > 0));
if (!queued) fail("Stinger tap did not queue production");
await ff(80);
const sid = await world(() => [...window.__bd.world.units.values()].find((u) => u.faction === "blue" && u.kind === "stinger")?.id);
if (!sid) fail("no Stinger was produced");

// 3. select it by tapping it on the canvas, then order it somewhere
if (sid) {
  const pos = await world((id) => {
    const { world: w, cam, scene } = window.__bd;
    const u = w.units.get(id);
    const dpr = scene.game.registry.get("dpr");
    cam.centerOn(u.x * 64, u.y * 64);
    cam.preRender();
    return { sx: (u.x * 64 - cam.worldView.x) * cam.zoom / dpr, sy: (u.y * 64 - cam.worldView.y) * cam.zoom / dpr };
  }, sid);
  await ff(1);
  await page.touchscreen.tap(pos.sx, pos.sy);
  await page.waitForTimeout(350); // let the double-tap window lapse
  const sel = await world(() => [...window.__bd.ctrl.selectedUnits]);
  if (!sel.includes(sid)) fail(`canvas tap did not select the Stinger (selected=${JSON.stringify(sel)})`);
  // hold squad chip 1: the selection is saved as squad 1
  const sq = await page.locator(".sq").first().boundingBox();
  await page.mouse.move(sq.x + sq.width / 2, sq.y + sq.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(550);
  await page.mouse.up();
  const squad = await world(() => window.__bd.ctrl.squads.slots[0]);
  if (!squad.includes(sid)) fail(`holding squad chip 1 did not save the Stinger (squad=${JSON.stringify(squad)})`);
  await page.touchscreen.tap(pos.sx + 60, pos.sy - 60);
  await ff(2);
  const order = await world((id) => window.__bd.world.units.get(id)?.order.type, sid);
  if (order !== "attackMove" && order !== "idle") fail(`ground tap gave order ${order}`);
  if (order !== "attackMove") fail("ground tap did not issue attack-move");
  await shot("selected");
}

// 4. long-press a build button: the info card opens
await page.locator(".tab[data-tab=air]").tap();
const wasp = btn("Wasp");
const box = await wasp.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.waitForTimeout(600);
await page.mouse.up();
if (await page.locator("#card").isHidden()) fail("long-press did not open the info card");
await shot("card");
await page.locator("#card-x").click();

// 5. pause and resume
await page.locator("#btn-menu").tap();
const paused = await world(() => window.__bd.ctrl.paused);
if (!paused || (await page.locator("#pause").isHidden())) fail("pause button did not pause");
await shot("paused");
await page.locator("#p-resume").tap();
if (await world(() => window.__bd.ctrl.paused)) fail("resume did not unpause");

// 6. the AI must be doing something
await ff(600);
const aiActive = await world(() => [...window.__bd.world.buildings.values()].filter((b) => b.faction === "red").length > 1);
if (!aiActive) fail("AI built nothing in the first minutes");
await shot("late");

if (errors.length) fail(`console errors: ${JSON.stringify(errors.slice(0, 10))}`);
console.log(process.exitCode ? "SMOKE FAILED" : `SMOKE OK (${w}x${h})`);
await browser.close();
server?.close();
