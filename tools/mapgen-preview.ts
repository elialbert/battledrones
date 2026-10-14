// Render generated maps (src/sim/mapgen.ts) to PNG previews, to eyeball the generator.
// Usage: npx vite-node tools/mapgen-preview.ts [random-<biome>-<code>…] [--roll N] [--biome B] [--out DIR] [--ascii]
// With no ids it rolls 2 maps per biome. Rolls use a fixed menu seed, so a run is repeatable.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { BIOMES, parseRandomMapId, randomMapDef, randomMapId } from "../src/sim/mapgen";
import { BUILDINGS } from "../src/sim/balance";
import type { Biome } from "../src/sim/types";

const args = process.argv.slice(2);
const opt = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const out = opt("--out") ?? "art/previews/random";
const roll = Number(opt("--roll") ?? 0);
const only = opt("--biome") as Biome | undefined;
const ascii = args.includes("--ascii");
const ids = args.filter((a) => !a.startsWith("--"));
let s = 0x5eed;
const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
if (!ids.length) for (const b of only ? [only] : BIOMES) for (let i = 0; i < (roll || 2); i++) ids.push(randomMapId(b, Math.floor(rnd() * 2 ** 32)));

/** Tile colours per terrain code (Ground…Deep), with the biome's ground, water and woods. */
const PALETTE: Record<Biome, number[]> = {
  temperate: [0x6f8f4e, 0x6b6660, 0xb08a3c, 0x3d6f9e, 0x9c8f78, 0x7d6a4a, 0x2f5a2c, 0x7fd8e8, 0xa0522d, 0x7fb0c8, 0x23476e],
  desert: [0xd9b77a, 0x9a6a45, 0x8a7a5a, 0x3f8fae, 0xb8a080, 0xc49a62, 0x6e8a3a, 0x7fd8e8, 0x8b5a2b, 0x8fc4c8, 0x23476e],
  arctic: [0xe6edf2, 0x6e7680, 0x8a8a7a, 0x5a8fb8, 0xb0b4b8, 0xc4ccd4, 0x3e5e4e, 0x7fd8e8, 0x6a5040, 0xb4d8ea, 0x2a4a70],
  volcanic: [0x4a403a, 0x1f1b1a, 0x8a7a5a, 0xe2581c, 0x6e6660, 0x77665a, 0x4f4a2c, 0x7fd8e8, 0x9a9aa0, 0xc07040, 0x8a2010],
  tropical: [0x5fa04a, 0x6b6660, 0xb08a3c, 0x2f9fb0, 0xb8a888, 0x8a7a4a, 0x1f6a2a, 0x7fd8e8, 0x9a6a3a, 0x7fd0c8, 0x18507a]
};
// terrain enum -> char: Ground . Rock # Scrap $ Water ~ Road = Rough : Forest T Crystal * Bridge H Shallows , Deep (space)
const CH = ".#$~=:T*H, ";
const PX = 4;

/** A minimal RGB PNG (one IDAT, filter 0 rows). */
function png(width: number, height: number, rgb: Uint8Array): Buffer {
  const table = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc = (b: Buffer) => {
    let c = -1;
    for (const x of b) c = table[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

mkdirSync(out, { recursive: true });
for (const id of ids) {
  const parsed = parseRandomMapId(id);
  const def = parsed && randomMapDef(id);
  if (!def?.random) {
    console.error(`not a random map id: ${id}`);
    continue;
  }
  const S = def.size;
  const g = def.random.terrain;
  const W = S * PX;
  const rgb = new Uint8Array(W * W * 3);
  const put = (x: number, y: number, c: number) => {
    if (x < 0 || y < 0 || x >= W || y >= W) return;
    rgb.set([c >> 16, (c >> 8) & 0xff, c & 0xff], (y * W + x) * 3);
  };
  const pal = PALETTE[def.biome];
  for (let ty = 0; ty < S; ty++)
    for (let tx = 0; tx < S; tx++) {
      const t = g[ty * S + tx]!;
      for (let py = 0; py < PX; py++)
        for (let px = 0; px < PX; px++) {
          // a faint grain so flat ground reads as ground
          const shade = (tx * 7 + ty * 13 + px + py) % 5 === 0 ? 0x080808 : 0;
          put(tx * PX + px, ty * PX + py, Math.max(0, pal[t]! - shade));
        }
    }
  const box = (cx: number, cy: number, r: number, c: number) => {
    for (let y = Math.round((cy - r) * PX); y <= (cy + r) * PX; y++)
      for (let x = Math.round((cx - r) * PX); x <= (cx + r) * PX; x++) put(x, y, c);
  };
  const ring = (cx: number, cy: number, r: number, c: number) => {
    for (let a = 0; a < 64; a++) put(Math.round((cx + Math.cos(a / 10) * r) * PX), Math.round((cy + Math.sin(a / 10) * r) * PX), c);
  };
  const hs = BUILDINGS.hq.size;
  const [hx, hy] = def.hq;
  box(hx + hs / 2, hy + hs / 2, hs / 2, 0x2a6cff);
  box(S - hx - hs / 2, S - hy - hs / 2, hs / 2, 0xff3030);
  for (const u of def.uplinks) {
    const [x, y] = Array.isArray(u) ? u : u.at;
    for (const [px, py] of [[x, y], [S - x, S - y]]) {
      box(px!, py!, 0.6, 0xffffff);
      ring(px!, py!, 2, 0xffffff);
    }
  }
  for (const [x, y] of def.dropSites) {
    box(x, y, 0.4, 0xffe000);
    box(S - x, S - y, 0.4, 0xffe000);
  }
  const file = join(out, `${def.id}.png`);
  writeFileSync(file, png(W, W, rgb));
  console.log(`${file}  ${def.name} (${def.random.layout}) — ${def.blurb}`);
  if (ascii)
    for (let ty = 0; ty < S; ty++) {
      let row = "";
      for (let tx = 0; tx < S; tx++) row += CH[g[ty * S + tx]!];
      console.log(row);
    }
}
