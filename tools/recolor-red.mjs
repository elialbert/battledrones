// Generate the red-faction variant of a blue-faction sprite sheet by
// hue-shifting blue accent pixels to red (grays untouched).
// Usage: node tools/recolor-red.mjs <blue.png> <red.png>
import { PNG } from "pngjs";
import { readFileSync, writeFileSync } from "node:fs";

function rgb2hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, s, l];
}

function hsl2rgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

const [, , src, dst] = process.argv;
const img = PNG.sync.read(readFileSync(src));
for (let i = 0; i < img.data.length; i += 4) {
  if (img.data[i + 3] === 0) continue;
  const [h, s, l] = rgb2hsl(img.data[i], img.data[i + 1], img.data[i + 2]);
  if (h >= 165 && h <= 260 && s > 0.18) {
    const [r, g, b] = hsl2rgb(4, Math.min(1, s * 1.05), l);
    img.data[i] = r;
    img.data[i + 1] = g;
    img.data[i + 2] = b;
  }
}
writeFileSync(dst, PNG.sync.write(img));
console.log(`wrote ${dst}`);
