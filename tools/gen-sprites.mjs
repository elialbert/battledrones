// Generates placeholder sprite sheets for Battle Drones.
// Output layout, frame sizes, and frame order are the contract with real art —
// see ART.md. Regenerate with: npm run sprites
import { PNG } from "pngjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const OUT = new URL("../public/", import.meta.url).pathname;

// Real (non-placeholder) art now lives at these paths — never overwrite it.
const REAL_ART = new Set([
  "assets/sprites/fx/explosion.png",
  "assets/sprites/fx/bolt.png",
  "assets/sprites/fx/muzzle.png",
  "assets/sprites/terrain/tiles.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  ...["blue", "red"].flatMap((f) => [
    ...["harvester", "scout", "stinger", "flak-crawler", "wasp", "raptor"].map(
      (u) => `assets/sprites/units/${f}/${u}.png`
    ),
    ...["hq", "fab-plant", "airpad", "turret-base", "turret-head"].map(
      (b) => `assets/sprites/buildings/${f}/${b}.png`
    )
  ])
]);

// ---------------------------------------------------------------- raster ---
class Raster {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.d = new Uint8Array(w * h * 4);
  }
  set(x, y, c) {
    x |= 0;
    y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const [r, g, b, a = 255] = c;
    const i = (y * this.w + x) * 4;
    const d = this.d;
    if (a >= 255) {
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
      d[i + 3] = 255;
      return;
    }
    const sa = a / 255;
    const da = d[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa <= 0) return;
    d[i] = (r * sa + d[i] * da * (1 - sa)) / oa;
    d[i + 1] = (g * sa + d[i + 1] * da * (1 - sa)) / oa;
    d[i + 2] = (b * sa + d[i + 2] * da * (1 - sa)) / oa;
    d[i + 3] = oa * 255;
  }
  rect(x, y, w, h, c) {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.set(i, j, c);
  }
  circle(cx, cy, r, c) {
    for (let j = Math.floor(cy - r); j <= cy + r; j++)
      for (let i = Math.floor(cx - r); i <= cx + r; i++)
        if ((i - cx) ** 2 + (j - cy) ** 2 <= r * r) this.set(i, j, c);
  }
  ring(cx, cy, r, thick, c) {
    const inner = (r - thick) ** 2;
    for (let j = Math.floor(cy - r); j <= cy + r; j++)
      for (let i = Math.floor(cx - r); i <= cx + r; i++) {
        const d2 = (i - cx) ** 2 + (j - cy) ** 2;
        if (d2 <= r * r && d2 >= inner) this.set(i, j, c);
      }
  }
  // even-odd scanline polygon fill; pts = [[x,y],...]
  poly(pts, c) {
    const ys = pts.map((p) => p[1]);
    const y0 = Math.floor(Math.min(...ys));
    const y1 = Math.ceil(Math.max(...ys));
    for (let y = y0; y <= y1; y++) {
      const xs = [];
      for (let k = 0; k < pts.length; k++) {
        const [ax, ay] = pts[k];
        const [bx, by] = pts[(k + 1) % pts.length];
        if (ay <= y + 0.5 !== by <= y + 0.5)
          xs.push(ax + ((y + 0.5 - ay) * (bx - ax)) / (by - ay));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2)
        for (let x = Math.round(xs[k]); x < Math.round(xs[k + 1]); x++) this.set(x, y, c);
    }
  }
  line(x0, y0, x1, y1, c) {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let s = 0; s <= steps; s++)
      this.set(x0 + ((x1 - x0) * s) / steps, y0 + ((y1 - y0) * s) / steps, c);
  }
}

// Nearest-neighbour rotation about the raster centre, θ clockwise on screen.
function rotated(src, theta) {
  const dst = new Raster(src.w, src.h);
  const cx = src.w / 2 - 0.5;
  const cy = src.h / 2 - 0.5;
  const cos = Math.cos(-theta);
  const sin = Math.sin(-theta);
  for (let y = 0; y < dst.h; y++)
    for (let x = 0; x < dst.w; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const sx = Math.round(cx + dx * cos - dy * sin);
      const sy = Math.round(cy + dx * sin + dy * cos);
      if (sx < 0 || sy < 0 || sx >= src.w || sy >= src.h) continue;
      const si = (sy * src.w + sx) * 4;
      const di = (y * dst.w + x) * 4;
      dst.d.set(src.d.subarray(si, si + 4), di);
    }
  return dst;
}

function sheet(frames, frameW, frameH, cols) {
  const rows = Math.ceil(frames.length / cols);
  const out = new Raster(cols * frameW, rows * frameH);
  frames.forEach((f, n) => {
    const ox = (n % cols) * frameW;
    const oy = Math.floor(n / cols) * frameH;
    for (let y = 0; y < f.h; y++)
      for (let x = 0; x < f.w; x++) {
        const si = (y * f.w + x) * 4;
        if (f.d[si + 3] === 0) continue;
        const di = ((oy + y) * out.w + (ox + x)) * 4;
        out.d.set(f.d.subarray(si, si + 4), di);
      }
  });
  return out;
}

function save(relPath, raster) {
  if (REAL_ART.has(relPath)) {
    console.log(`skip ${relPath} (real art)`);
    return;
  }
  const png = new PNG({ width: raster.w, height: raster.h });
  png.data = Buffer.from(raster.d);
  const full = join(OUT, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, PNG.sync.write(png));
  console.log(`wrote ${relPath} (${raster.w}x${raster.h})`);
}

// deterministic pseudo-random so regenerating never dirties git
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 2 ** 32);
}

// --------------------------------------------------------------- palette ---
const HULL = { light: [168, 178, 194], mid: [116, 126, 144], dark: [72, 80, 96] };
const TEAM = {
  blue: { main: [72, 148, 255], dark: [38, 92, 180] },
  red: { main: [238, 84, 72], dark: [164, 46, 40] }
};
const GLASS = [140, 220, 255];
const SCRAP = [96, 205, 178];
const SCRAP_DARK = [58, 140, 120];

// Direction convention (ART.md): frame i faces i*45° clockwise starting at
// North. Painters draw facing North (up); we rotate for the other 7 frames.
const dirFrames = (paint, size = 32) => {
  const base = new Raster(size, size);
  paint(base);
  return Array.from({ length: 8 }, (_, i) => (i === 0 ? base : rotated(base, (i * Math.PI) / 4)));
};

// ----------------------------------------------------------- unit painters --
function paintHarvester(r, team, loaded) {
  r.poly([[8, 6], [23, 6], [25, 26], [6, 26]], HULL.mid);
  r.rect(6, 8, 3, 18, HULL.dark); // left track
  r.rect(23, 8, 3, 18, HULL.dark); // right track
  r.rect(9, 7, 14, 3, team.main); // cab stripe
  r.rect(10, 12, 12, 12, HULL.dark); // cargo bay
  if (loaded) {
    r.rect(11, 13, 10, 10, SCRAP_DARK);
    r.rect(12, 14, 8, 8, SCRAP);
    r.rect(14, 16, 4, 4, [220, 240, 230]);
  }
  r.rect(13, 3, 6, 4, team.dark); // intake scoop
}

function paintScout(r, team) {
  // small quadcopter: X-frame, four rotors
  for (const [x, y] of [[9, 9], [23, 9], [9, 23], [23, 23]]) {
    r.line(16, 16, x, y, HULL.dark);
    r.ring(x, y, 4, 1, HULL.light);
    r.circle(x, y, 1.5, HULL.mid);
  }
  r.circle(16, 16, 3.5, team.main);
  r.set(16, 13, GLASS);
}

function paintStinger(r, team) {
  r.poly([[10, 10], [22, 10], [23, 27], [9, 27]], HULL.mid); // hull
  r.rect(8, 12, 3, 15, HULL.dark); // tracks
  r.rect(21, 12, 3, 15, HULL.dark);
  r.circle(16, 18, 4, team.main); // turret ring
  r.rect(15, 4, 3, 14, HULL.light); // barrel
  r.rect(15, 4, 3, 3, HULL.dark);
}

function paintFlakCrawler(r, team) {
  r.poly([[9, 12], [23, 12], [24, 28], [8, 28]], HULL.mid);
  r.rect(7, 14, 3, 13, HULL.dark);
  r.rect(22, 14, 3, 13, HULL.dark);
  r.circle(16, 20, 5, team.dark); // mount
  r.rect(11, 4, 3, 15, HULL.light); // twin flak barrels
  r.rect(18, 4, 3, 15, HULL.light);
  r.rect(11, 4, 3, 2, team.main);
  r.rect(18, 4, 3, 2, team.main);
  r.ring(16, 20, 3, 1, [230, 230, 120]); // radar dish
}

function paintWasp(r, team) {
  r.poly([[16, 2], [21, 14], [19, 26], [13, 26], [11, 14]], HULL.light); // dart body
  r.poly([[16, 2], [18, 10], [14, 10]], team.main); // nose
  for (const [x, y] of [[7, 12], [25, 12]]) {
    r.line(16, 14, x, y, HULL.dark);
    r.ring(x, y, 4, 1, HULL.mid);
  }
  r.rect(14, 26, 5, 3, team.dark); // tail
  r.set(16, 12, GLASS);
}

function paintRaptor(r, team) {
  r.poly([[16, 1], [24, 22], [16, 18], [8, 22]], HULL.light); // swept-wing arrow
  r.poly([[16, 5], [19, 14], [13, 14]], team.main);
  r.rect(15, 18, 3, 8, HULL.mid); // tail boom
  for (const [x, y] of [[10, 24], [22, 24]]) r.ring(x, y, 3, 1, HULL.dark); // rear rotors
  r.set(16, 8, GLASS);
}

function paintShadow(r) {
  r.circle(32, 32, 18, [0, 0, 0, 70]);
  r.circle(32, 32, 12, [0, 0, 0, 60]);
}

// ------------------------------------------------------ building painters --
function cracks(r, seed, count) {
  const rnd = lcg(seed);
  for (let i = 0; i < count; i++) {
    let x = rnd() * r.w;
    let y = rnd() * r.h;
    for (let s = 0; s < 8; s++) {
      r.set(x, y, [20, 20, 24]);
      x += rnd() * 4 - 2;
      y += rnd() * 4 - 2;
    }
  }
}

function paintHQ(r, team, state) {
  const s = 96;
  r.rect(4, 4, s - 8, s - 8, HULL.dark);
  r.rect(8, 8, s - 16, s - 16, HULL.mid);
  if (state === 2) {
    // rubble
    const rnd = lcg(7);
    r.rect(8, 8, s - 16, s - 16, [52, 50, 54]);
    for (let i = 0; i < 60; i++)
      r.rect(8 + rnd() * (s - 24), 8 + rnd() * (s - 24), 3 + rnd() * 6, 3 + rnd() * 6, [
        70 + rnd() * 30,
        68 + rnd() * 28,
        70 + rnd() * 26
      ]);
    cracks(r, 11, 30);
    return;
  }
  r.rect(12, 12, s - 24, 8, team.main); // banner strip
  r.circle(s / 2, s / 2 + 4, 20, HULL.light); // dome
  r.circle(s / 2, s / 2 + 4, 12, team.dark);
  r.circle(s / 2, s / 2 + 4, 5, GLASS);
  r.rect(14, s - 26, 20, 14, HULL.dark); // vehicle door (south-west)
  r.rect(16, s - 24, 16, 10, [40, 44, 52]);
  for (const x of [16, s - 22]) r.rect(x, 26, 6, 6, [230, 230, 120]); // lights
  if (state === 1) {
    cracks(r, 3, 22);
    r.circle(70, 30, 8, [30, 28, 30, 200]); // scorch
    r.circle(26, 62, 6, [30, 28, 30, 200]);
  }
}

function paintFabPlant(r, team, state) {
  const s = 64;
  r.rect(3, 3, s - 6, s - 6, HULL.dark);
  r.rect(6, 6, s - 12, s - 12, HULL.mid);
  if (state === 2) {
    const rnd = lcg(13);
    r.rect(6, 6, s - 12, s - 12, [52, 50, 54]);
    for (let i = 0; i < 30; i++)
      r.rect(6 + rnd() * (s - 18), 6 + rnd() * (s - 18), 3 + rnd() * 5, 3 + rnd() * 5, [
        70 + rnd() * 30,
        68 + rnd() * 28,
        70 + rnd() * 26
      ]);
    cracks(r, 17, 18);
    return;
  }
  for (let i = 0; i < 3; i++) r.rect(10, 10 + i * 10, s - 20, 6, HULL.light); // roof ridges
  r.rect(10, 10, s - 20, 3, team.main);
  r.rect(s / 2 - 9, s - 18, 18, 12, HULL.dark); // south door
  r.rect(s / 2 - 7, s - 16, 14, 8, [40, 44, 52]);
  r.rect(s / 2 - 7, s - 16, 14, 2, [230, 230, 120]);
  if (state === 1) {
    cracks(r, 5, 14);
    r.circle(46, 18, 6, [30, 28, 30, 200]);
  }
}

function paintAirpad(r, team, state) {
  const s = 64;
  r.rect(3, 3, s - 6, s - 6, HULL.dark);
  r.rect(6, 6, s - 12, s - 12, [64, 70, 82]);
  if (state === 2) {
    const rnd = lcg(23);
    for (let i = 0; i < 26; i++)
      r.rect(6 + rnd() * (s - 18), 6 + rnd() * (s - 18), 3 + rnd() * 5, 3 + rnd() * 5, [
        70 + rnd() * 30,
        68 + rnd() * 28,
        70 + rnd() * 26
      ]);
    cracks(r, 29, 18);
    return;
  }
  r.ring(s / 2, s / 2, 22, 3, team.main); // landing circle
  r.ring(s / 2, s / 2, 12, 2, HULL.light);
  // drone glyph in the middle
  r.circle(s / 2, s / 2, 3, HULL.light);
  for (const [x, y] of [[-7, -7], [7, -7], [-7, 7], [7, 7]]) {
    r.line(s / 2, s / 2, s / 2 + x, s / 2 + y, HULL.light);
    r.ring(s / 2 + x, s / 2 + y, 2.5, 1, HULL.light);
  }
  if (state === 1) {
    cracks(r, 31, 14);
    r.circle(18, 46, 6, [30, 28, 30, 200]);
  }
}

function paintTurretBase(r, team) {
  r.circle(16, 16, 13, HULL.dark);
  r.circle(16, 16, 10, HULL.mid);
  r.ring(16, 16, 13, 2, team.dark);
  for (const [x, y] of [[8, 8], [24, 8], [8, 24], [24, 24]]) r.set(x, y, HULL.light); // bolts
}

function paintTurretHead(r, team) {
  r.circle(16, 18, 6, HULL.light);
  r.circle(16, 18, 3, team.main);
  r.rect(13, 2, 2, 16, HULL.light); // twin barrels, facing north
  r.rect(17, 2, 2, 16, HULL.light);
  r.rect(13, 2, 2, 3, HULL.dark);
  r.rect(17, 2, 2, 3, HULL.dark);
}

// -------------------------------------------------------------- terrain ----
function groundTile(seed, tint) {
  const r = new Raster(32, 32);
  const rnd = lcg(seed);
  r.rect(0, 0, 32, 32, tint);
  for (let i = 0; i < 46; i++) {
    const v = rnd() * 18 - 9;
    r.set(rnd() * 32, rnd() * 32, [tint[0] + v, tint[1] + v, tint[2] + v]);
  }
  for (let i = 0; i < 5; i++)
    r.rect(rnd() * 30, rnd() * 30, 2, 1, [tint[0] - 14, tint[1] - 14, tint[2] - 12]);
  return r;
}

function rockTile(seed) {
  const r = groundTile(seed, [88, 78, 62]);
  const rnd = lcg(seed * 3 + 1);
  for (let i = 0; i < 4; i++) {
    const cx = 6 + rnd() * 20;
    const cy = 6 + rnd() * 20;
    const rad = 5 + rnd() * 5;
    r.circle(cx, cy, rad, [96, 98, 108]);
    r.circle(cx - rad / 3, cy - rad / 3, rad / 2, [128, 130, 140]);
    r.circle(cx + rad / 3, cy + rad / 2, rad / 3, [66, 68, 78]);
  }
  return r;
}

function scrapTile(seed, amount) {
  const r = groundTile(seed, [88, 78, 62]);
  const rnd = lcg(seed * 7 + 5);
  const bits = Math.round(16 * amount);
  for (let i = 0; i < bits; i++) {
    const x = 3 + rnd() * 26;
    const y = 3 + rnd() * 26;
    r.rect(x, y, 2 + rnd() * 3, 2 + rnd() * 3, rnd() > 0.3 ? SCRAP : [214, 160, 74]);
    r.set(x, y, [230, 250, 240]);
  }
  if (amount === 0)
    for (let i = 0; i < 8; i++) r.rect(3 + rnd() * 26, 3 + rnd() * 26, 2, 2, SCRAP_DARK);
  return r;
}

// ------------------------------------------------------------------- fx ----
function paintMuzzle(r) {
  for (const [len, c] of [
    [10, [255, 220, 120, 200]],
    [6, [255, 250, 200, 255]]
  ]) {
    r.poly([[16, 16 - len], [19, 16], [16, 16 + len], [13, 16]], c);
    r.poly([[16 - len, 16], [16, 19], [16 + len, 16], [16, 13]], c);
  }
}

function paintBolt(r) {
  // energy bolt pointing north; engine rotates to flight angle
  r.rect(14, 6, 4, 20, [120, 200, 255, 180]);
  r.rect(15, 4, 2, 24, [235, 250, 255]);
}

function explosionFrame(i) {
  const r = new Raster(32, 32);
  const t = i / 5;
  const rad = 4 + t * 11;
  if (i < 4) {
    r.circle(16, 16, rad, [180 + 60 * (1 - t), 70 + 40 * (1 - t), 30, 230]);
    r.circle(16, 16, rad * 0.65, [255, 160 + 60 * (1 - t), 60, 255]);
    if (i < 2) r.circle(16, 16, rad * 0.35, [255, 250, 210]);
  } else {
    const a = i === 4 ? 150 : 80;
    r.ring(16, 16, rad, 4, [90, 86, 88, a]);
    r.circle(16, 16, rad * 0.4, [70, 66, 68, a * 0.6]);
  }
  return r;
}

// ------------------------------------------------------------------ icons --
function appIcon(size) {
  const r = new Raster(size, size);
  const u = size / 32;
  r.rect(0, 0, size, size, [16, 20, 28]);
  r.ring(16 * u, 16 * u, 14 * u, 1.5 * u, TEAM.blue.dark);
  for (const [x, y] of [[8, 8], [24, 8], [8, 24], [24, 24]]) {
    r.line(16 * u, 16 * u, x * u, y * u, HULL.mid);
    r.ring(x * u, y * u, 4.5 * u, 1.5 * u, HULL.light);
  }
  r.circle(16 * u, 16 * u, 4 * u, TEAM.blue.main);
  return r;
}

// ------------------------------------------------------------------ main ---
for (const [faction, team] of Object.entries(TEAM)) {
  const U = (n) => `assets/sprites/units/${faction}/${n}`;
  save(
    U("harvester.png"),
    sheet(
      [
        ...dirFrames((r) => paintHarvester(r, team, false)),
        ...dirFrames((r) => paintHarvester(r, team, true))
      ],
      32,
      32,
      8
    )
  );
  save(U("scout.png"), sheet(dirFrames((r) => paintScout(r, team)), 32, 32, 8));
  save(U("stinger.png"), sheet(dirFrames((r) => paintStinger(r, team)), 32, 32, 8));
  save(U("flak-crawler.png"), sheet(dirFrames((r) => paintFlakCrawler(r, team)), 32, 32, 8));
  save(U("wasp.png"), sheet(dirFrames((r) => paintWasp(r, team)), 32, 32, 8));
  save(U("raptor.png"), sheet(dirFrames((r) => paintRaptor(r, team)), 32, 32, 8));

  const B = (n) => `assets/sprites/buildings/${faction}/${n}`;
  save(B("hq.png"), sheet([0, 1, 2].map((s) => {
    const r = new Raster(96, 96);
    paintHQ(r, team, s);
    return r;
  }), 96, 96, 3));
  save(B("fab-plant.png"), sheet([0, 1, 2].map((s) => {
    const r = new Raster(64, 64);
    paintFabPlant(r, team, s);
    return r;
  }), 64, 64, 3));
  save(B("airpad.png"), sheet([0, 1, 2].map((s) => {
    const r = new Raster(64, 64);
    paintAirpad(r, team, s);
    return r;
  }), 64, 64, 3));
  save(B("turret-base.png"), sheet([(() => {
    const r = new Raster(32, 32);
    paintTurretBase(r, team);
    return r;
  })()], 32, 32, 1));
  save(B("turret-head.png"), sheet(dirFrames((r) => paintTurretHead(r, team)), 32, 32, 8));
}

save("assets/sprites/units/shadow.png", sheet([(() => {
  const r = new Raster(64, 64);
  paintShadow(r);
  return r;
})()], 64, 64, 1));

save(
  "assets/sprites/terrain/tiles.png",
  sheet(
    [
      groundTile(1, [96, 84, 64]),
      groundTile(2, [92, 82, 66]),
      groundTile(3, [98, 88, 70]),
      rockTile(4),
      rockTile(5),
      scrapTile(6, 1),
      scrapTile(7, 0.5),
      scrapTile(8, 0)
    ],
    32,
    32,
    8
  )
);

save("assets/sprites/fx/muzzle.png", sheet([(() => {
  const r = new Raster(32, 32);
  paintMuzzle(r);
  return r;
})()], 32, 32, 1));
save("assets/sprites/fx/bolt.png", sheet([(() => {
  const r = new Raster(32, 32);
  paintBolt(r);
  return r;
})()], 32, 32, 1));
save("assets/sprites/fx/explosion.png", sheet([0, 1, 2, 3, 4, 5].map(explosionFrame), 32, 32, 6));

save("icons/icon-192.png", appIcon(192));
save("icons/icon-512.png", appIcon(512));

console.log("done");
