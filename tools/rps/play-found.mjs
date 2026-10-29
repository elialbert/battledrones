// Drive the Found Depot flow in a real browser: 4 harvesters, the chip or V, the ghost, the crew's walk, the site.
// Usage: node tools/rps/play-found.mjs <outDir> [width] [height] [map]
import { chromium } from "playwright-core";
import { existsSync, mkdirSync } from "node:fs";
const [out, W = "1280", H = "800", map = "riverlands"] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const phone = +W < +H;
const exe = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/usr/bin/google-chrome"].find((p) => existsSync(p));
const browser = await chromium.launch({ executablePath: exe, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: +W, height: +H }, deviceScaleFactor: 1, hasTouch: phone, isMobile: phone });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
await page.evaluate((m) => localStorage.setItem("battledrones.settings", JSON.stringify({ mapId: m, difficulty: "easy" })), map);
await page.reload({ waitUntil: "networkidle" });
await (phone ? page.tap("#play") : page.click("#play"));
await page.waitForSelector(".op-card", { timeout: 60000 });
await (phone ? page.tap(".op-card[data-id=industry]") : page.click(".op-card[data-id=industry]"));
await page.waitForFunction(() => window.__bd?.world?.tick > 5, null, { timeout: 60000 });
const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: `${out}/${name}.png` }); };
const info = (label) => page.evaluate((label) => {
  const b = window.__bd, w = b.world, me = b.player;
  const hv = [...w.units.values()].filter((u) => u.faction === me && u.kind === "harvester");
  const deps = [...w.buildings.values()].filter((x) => x.faction === me && x.kind === "depot");
  return `${label}: t=${(w.tick / 20).toFixed(0)}s scrap=${Math.floor(w.factions[me].scrap)} harvesters=${hv.length} orders=${[...new Set(hv.map((u) => u.order?.type))].join("/")} depots=${deps.map((d) => `${d.tx},${d.ty} hp${Math.round(d.hp)}${d.founding ? " founding" + d.founding : ""}`).join(" ")}`;
}, label);
// a bank and four more harvesters
await page.evaluate(() => {
  const b = window.__bd, w = b.world, me = b.player;
  w.factions[me].scrap = 3000;
  const hq = [...w.buildings.values()].find((x) => x.faction === me && x.kind === "hq");
  for (let i = 0; i < 4; i++) b.ctrl.enqueue({ type: "produce", faction: me, buildingId: hq.id, unit: "harvester" });
  b.scene.step(100, 500);
});
console.log(await info("after 50 s"));
await page.evaluate(() => {
  const b = window.__bd, w = b.world, me = b.player;
  b.ctrl.selectUnits([...w.units.values()].filter((u) => u.faction === me && u.kind === "harvester").map((u) => u.id));
  b.scene.step(100, 1);
});
await shot("1-selected");
if (phone) {
  const chip = page.locator(".chip[data-id=found]");
  console.log("chip:", await chip.textContent());
  await chip.tap();
} else await page.keyboard.press("v");
await page.evaluate(() => window.__bd.scene.step(100, 1));
console.log("placing:", await page.evaluate(() => [window.__bd.ctrl.placing, window.__bd.ctrl.foundCrew?.length]));
// the target: the scrap field second nearest the HQ (its middle), then the legal spot nearest it toward the HQ
const site = await page.evaluate(() => {
  const b = window.__bd, w = b.world, me = b.player, c = b.ctrl;
  const hq = [...w.buildings.values()].find((x) => x.faction === me && x.kind === "hq");
  const cl = [];
  for (let i = 0; i < w.terrain.length; i++) if (w.terrain[i] === 2) {
    const x = i % w.width, y = (i / w.width) | 0;
    const k = cl.find((k) => Math.hypot(k.x / k.n - x, k.y / k.n - y) < 6);
    if (k) { k.x += x; k.y += y; k.n++; } else cl.push({ x, y, n: 1 });
  }
  const fs = cl.filter((k) => k.n > 4).map((k) => [k.x / k.n, k.y / k.n]);
  fs.sort((a, b) => Math.hypot(a[0] - hq.tx, a[1] - hq.ty) - Math.hypot(b[0] - hq.tx, b[1] - hq.ty));
  const f = fs[1];
  let best = null;
  for (let ty = 0; ty < w.height; ty++) for (let tx = 0; tx < w.width; tx++) {
    const d = Math.hypot(tx + 1 - f[0], ty + 1 - f[1]);
    if (d > 9 || (best && d >= best.d)) continue;
    c.movePlacement(tx, ty, false);
    if (!c.placementProblem()) best = { tx, ty, d };
  }
  c.placeAt = null;
  return { field: f, x: best.tx + 1, y: best.ty + 1 };
});
console.log("site", JSON.stringify(site));
await page.evaluate(([x, y]) => { const r = window.__bd.cam; r.centerOn(x, y); }, [site.x, site.y]);
await page.waitForTimeout(300);
// first try right on the wasteland next to the field: refused
const onWaste = await page.evaluate(([x, y]) => window.__bd.toScreen(x, y), (() => { const dx = site.field[0] - site.x, dy = site.field[1] - site.y, d = Math.hypot(dx, dy); return [site.field[0] + (dx / d) * 2.5, site.field[1] + (dy / d) * 2.5]; })());
if (phone) await page.touchscreen.tap(onWaste.x, onWaste.y); else await page.mouse.move(onWaste.x, onWaste.y);
await page.evaluate(() => window.__bd.scene.step(100, 1));
console.log("problem near field:", await page.evaluate(() => window.__bd.ctrl.placementProblem()), await page.evaluate(() => JSON.stringify(window.__bd.ctrl.placeAt)));
await shot("2-ghost-refused");
const p = await page.evaluate(([x, y]) => window.__bd.toScreen(x, y), [site.x, site.y]);
if (phone) await page.touchscreen.tap(p.x, p.y); else await page.mouse.move(p.x, p.y);
await page.evaluate(() => window.__bd.scene.step(100, 1));
console.log("problem at site:", await page.evaluate(() => window.__bd.ctrl.placementProblem()), await page.evaluate(() => JSON.stringify(window.__bd.ctrl.placeAt)));
await shot("3-ghost");
if (phone) {
  // tapping the ghost (or the ✓ chip) founds it
  const ok = page.locator(".chip[data-id=place]");
  if (await ok.count()) await ok.first().tap(); else await page.touchscreen.tap(p.x, p.y);
} else await page.mouse.click(p.x, p.y);
await page.evaluate(() => window.__bd.scene.step(100, 2));
console.log(await info("ordered"));
await page.evaluate(() => window.__bd.scene.step(100, 40));
console.log(await info("+4 s"));
await shot("4-walking");
for (let i = 0; i < 12; i++) {
  await page.evaluate(() => window.__bd.scene.step(100, 20));
  const s = await info("…");
  if (s.includes("founding")) { console.log(s); break; }
}
await shot("5-founding");
await page.evaluate(() => window.__bd.scene.step(100, 200));
console.log(await info("+20 s"));
await shot("6-going-up");
await page.evaluate(() => window.__bd.scene.step(100, 150));
console.log(await info("+35 s"));
await shot("7-done");
console.log("errors:", errors.length ? errors : "none");
await browser.close();
