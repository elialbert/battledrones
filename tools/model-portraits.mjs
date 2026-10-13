// HUD portraits shot from the 3D models (public/assets/icons/<kind>.webp), for the units whose
// models were redesigned after the painted portraits (ART.md): the model gallery's ?icon=<kind>
// view from about the game camera's angle, shot on black and on white (the pair gives a clean
// alpha), then fitted to 112 px in a 128 px square like the painted ones (art/process.py make_icon).
// Usage: npx vite --port 5173, then node tools/model-portraits.mjs raptor lancer hornet
//   [--url=http://localhost:5173/tools/models.html] [--pitch=60] (degrees below the horizon)
import { chromium } from "playwright-core";
import { existsSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const kinds = args.filter((a) => !a.startsWith("--"));
const opt = Object.fromEntries(args.filter((a) => a.startsWith("--")).map((a) => a.slice(2).split("=")));
const url = opt.url ?? "http://localhost:5173/tools/models.html";
const pitch = opt.pitch ?? "60";
const exe = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find((p) => existsSync(p));
const browser = await chromium.launch({
  executablePath: exe,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
});
const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });

for (const kind of kinds) {
  const shots = [];
  for (const bg of ["#000000", "#ffffff"]) {
    await page.goto(`${url}?icon=${kind}&bg=${encodeURIComponent(bg)}&pitch=${pitch}`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
    await page.waitForTimeout(500);
    shots.push(`data:image/png;base64,${(await page.screenshot()).toString("base64")}`);
  }
  const webp = await page.evaluate(async ([black, white]) => {
    const load = async (src) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const x = c.getContext("2d");
      x.drawImage(img, 0, 0);
      return x.getImageData(0, 0, c.width, c.height);
    };
    const B = await load(black);
    const W = await load(white);
    const { width: w, height: h } = B;
    const out = new ImageData(w, h);
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let i = 0; i < w * h; i++) {
      // over black a pixel is a·c, over white a·c + (1 − a): the difference is 1 − a
      let d = 0;
      for (let k = 0; k < 3; k++) d += W.data[i * 4 + k] - B.data[i * 4 + k];
      const a = Math.min(1, Math.max(0, 1 - d / 765));
      if (a < 1 / 255) continue;
      for (let k = 0; k < 3; k++) out.data[i * 4 + k] = Math.min(255, B.data[i * 4 + k] / a);
      out.data[i * 4 + 3] = Math.round(a * 255);
      if (a > 8 / 255) {
        const px = i % w, py = (i / w) | 0;
        x0 = Math.min(x0, px); x1 = Math.max(x1, px);
        y0 = Math.min(y0, py); y1 = Math.max(y1, py);
      }
    }
    const src = document.createElement("canvas");
    src.width = w;
    src.height = h;
    src.getContext("2d").putImageData(out, 0, 0);
    const s = 112 / Math.max(x1 - x0 + 1, y1 - y0 + 1);
    const dst = document.createElement("canvas");
    dst.width = dst.height = 128;
    const g = dst.getContext("2d");
    g.imageSmoothingQuality = "high";
    const dw = (x1 - x0 + 1) * s;
    const dh = (y1 - y0 + 1) * s;
    g.drawImage(src, x0, y0, x1 - x0 + 1, y1 - y0 + 1, (128 - dw) / 2, (128 - dh) / 2, dw, dh);
    return dst.toDataURL("image/webp", 0.9);
  }, shots);
  const file = `public/assets/icons/${kind}.webp`;
  writeFileSync(file, Buffer.from(webp.split(",")[1], "base64"));
  console.log(file);
}
await browser.close();
