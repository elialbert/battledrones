// Screenshot every map's home field and a far field, to judge the Wasteland look.
import { chromium } from "playwright-core";
import { existsSync, mkdirSync } from "node:fs";
const out = process.argv[2]; mkdirSync(out, { recursive: true });
const maps = (process.argv[3] ?? "proving-grounds,riverlands,dune-sea,frostbite,ashlands,compass-rose,archipelago").split(",");
const zoom = +(process.env.ZOOM ?? 40);
const exe = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/usr/bin/google-chrome"].find((p) => existsSync(p));
const browser = await chromium.launch({ executablePath: exe, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
for (const map of maps) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => console.log(map, "ERR", String(e)));
  await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
  await page.evaluate((m) => localStorage.setItem("battledrones.settings", JSON.stringify({ mapId: m, difficulty: "normal" })), map);
  await page.reload({ waitUntil: "networkidle" });
  await page.click("#play");
  await page.waitForSelector(".op-card", { timeout: 60000 });
  await page.click(".op-card");
  await page.waitForFunction(() => window.__bd?.world?.tick > 5, null, { timeout: 60000 });
  // fields: tiles of terrain 2 (scrap), clustered; pick the one nearest the player's HQ and the map centre
  const spots = process.env.SPOT ? [process.env.SPOT.split(",").map(Number)] : await page.evaluate(() => {
    const w = window.__bd.world; const W = w.width; 
    const grid = w.terrain; const H = grid.length / W;
    const hq = [...w.buildings.values()].find((e) => e.kind === "hq" && e.faction === window.__bd.player);
    let best = null, bd = 1e9, mid = null, md = 1e9;
    for (let i = 0; i < grid.length; i++) if (grid[i] === 2) {
      const x = i % W, y = (i / W) | 0;
      const d = Math.hypot(x - hq.tx, y - hq.ty); if (d < bd) { bd = d; best = [x, y]; }
      const d2 = Math.hypot(x - W / 2, y - H / 2); if (d2 < md) { md = d2; mid = [x, y]; }
    }
    return [best, mid];
  });
  for (const [i, s] of spots.entries()) {
    if (!s) continue;
    await page.evaluate(([x, y, z]) => { window.__bd.scene.setFog(null); const r = window.__bd.cam; r.zoom = z; r.centerOn(x, y); }, [s[0], s[1], zoom]);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${out}/${map}-${i}.png` });
  }
  await page.close();
}
await browser.close();
