import * as THREE from "three";
import { prng } from "./terrain-props";

/**
 * Textures the terrain shaders share, made once on the CPU:
 *
 * - **Terrain noise**: a 256² tileable RGBA texture. R and G are two
 *   independent fractal noises (ripples, flow, heat, ground grain); B is a
 *   cellular pattern — the distance to the nearest cell border — that the
 *   liquids threshold into crisp ice floes and lava crust plates; A is a
 *   random value per cell (which floes exist, how hot a plate glows).
 * - **Painted colours**: a few texels per tile read back from the painted
 *   terrain chunks, so crags and boulders take their colour from the art
 *   they stand on, and the open ground past the map's edge the colour of
 *   the map's own.
 * - **Texture mean**: a loaded texture's average colour, read back once, so
 *   the rock material can be laid on as detail around its own average.
 */

const S = 256;
/** Cells per side of the cellular pattern (32 px each). */
const CELLS = 8;

/** Tileable fractal value noise into one channel of `out` (0..1). */
function fractal(out: Uint8Array, ch: number, seed: number): void {
  const rnd = prng(seed);
  const acc = new Float32Array(S * S);
  const ix0 = new Int32Array(S);
  const ix1 = new Int32Array(S);
  const wx = new Float32Array(S);
  [4, 8, 16, 32, 64].forEach((n, k) => {
    const g = new Float32Array(n * n);
    for (let i = 0; i < g.length; i++) g[i] = rnd();
    const w = Math.pow(0.55, k);
    // (smoothstep-interpolated lattice; the x weights are the same on every row)
    for (let x = 0; x < S; x++) {
      const f = (x / S) * n;
      const i = Math.floor(f);
      const t = f - i;
      ix0[x] = i % n;
      ix1[x] = (i + 1) % n;
      wx[x] = t * t * (3 - 2 * t);
    }
    for (let y = 0; y < S; y++) {
      const f = (y / S) * n;
      const j = Math.floor(f);
      const t = f - j;
      const ty = t * t * (3 - 2 * t);
      const r0 = (j % n) * n;
      const r1 = ((j + 1) % n) * n;
      for (let x = 0; x < S; x++) {
        const a = ix0[x]!;
        const b = ix1[x]!;
        const tx = wx[x]!;
        const top = g[r0 + a]! + (g[r0 + b]! - g[r0 + a]!) * tx;
        const bot = g[r1 + a]! + (g[r1 + b]! - g[r1 + a]!) * tx;
        const k = y * S + x;
        acc[k] = acc[k]! + w * (top + (bot - top) * ty);
      }
    }
  });
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < acc.length; i++) {
    lo = Math.min(lo, acc[i]!);
    hi = Math.max(hi, acc[i]!);
  }
  // stretch to the full 0..1 range so thresholds in the shaders mean the same everywhere
  for (let i = 0; i < acc.length; i++) out[i * 4 + ch] = Math.round(((acc[i]! - lo) / (hi - lo)) * 255);
}

/** Tileable cellular pattern: B = distance to the cell border (F2 − F1), A = per-cell value. */
function cellular(out: Uint8Array, seed: number): void {
  const rnd = prng(seed);
  const cs = S / CELLS;
  const px = new Float32Array(CELLS * CELLS);
  const py = new Float32Array(CELLS * CELLS);
  const pv = new Float32Array(CELLS * CELLS);
  for (let j = 0; j < CELLS; j++)
    for (let i = 0; i < CELLS; i++) {
      px[j * CELLS + i] = (i + 0.15 + rnd() * 0.7) * cs;
      py[j * CELLS + i] = (j + 0.15 + rnd() * 0.7) * cs;
      pv[j * CELLS + i] = rnd();
    }
  // the points of a ring of cells round the tile too, wrapped, so every cell sees its 3×3 neighbours
  const P = CELLS + 2;
  const qx = new Float32Array(P * P);
  const qy = new Float32Array(P * P);
  const qv = new Float32Array(P * P);
  for (let j = 0; j < P; j++)
    for (let i = 0; i < P; i++) {
      const si = (i - 1 + CELLS) % CELLS;
      const sj = (j - 1 + CELLS) % CELLS;
      qx[j * P + i] = px[sj * CELLS + si]! + (i - 1 - si) * cs;
      qy[j * P + i] = py[sj * CELLS + si]! + (j - 1 - sj) * cs;
      qv[j * P + i] = pv[sj * CELLS + si]!;
    }
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const ci = Math.floor(x / cs) + 1;
      const cj = Math.floor(y / cs) + 1;
      let f1 = Infinity;
      let f2 = Infinity;
      let v = 0;
      for (let j = cj - 1; j <= cj + 1; j++)
        for (let i = ci - 1; i <= ci + 1; i++) {
          const k = j * P + i;
          const dx = qx[k]! - x - 0.5;
          const dy = qy[k]! - y - 0.5;
          const d = dx * dx + dy * dy;
          if (d < f1) {
            f2 = f1;
            f1 = d;
            v = qv[k]!;
          } else if (d < f2) f2 = d;
        }
      const i = (y * S + x) * 4;
      out[i + 2] = Math.round(Math.min(1, (Math.sqrt(f2) - Math.sqrt(f1)) / cs) * 255);
      out[i + 3] = Math.round(v * 255);
    }
}

let noise: THREE.DataTexture | null = null;

/** The shared tileable terrain noise (see above). */
export function terrainNoise(): THREE.DataTexture {
  if (noise) return noise;
  const data = new Uint8Array(S * S * 4);
  fractal(data, 0, 11);
  fractal(data, 1, 29);
  cellular(data, 5);
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  noise = tex;
  return tex;
}

/** A loaded texture's average colour (linear), from its image drawn onto a 2D canvas; null if it can't be read. */
export function textureMean(tex: THREE.Texture): THREE.Color | null {
  try {
    const img = tex.image as (CanvasImageSource & { width: number; height: number }) | undefined;
    if (!img || !img.width) return null;
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    // (averaged in linear light, like the shader sees it: a table for the sRGB decode)
    const lin = new Float32Array(256);
    const col = new THREE.Color();
    for (let i = 0; i < 256; i++) lin[i] = col.setRGB(i / 255, 0, 0, THREE.SRGBColorSpace).r;
    let r = 0;
    let g = 0;
    let b = 0;
    for (let i = 0; i < px.length; i += 4) {
      r += lin[px[i]!]!;
      g += lin[px[i + 1]!]!;
      b += lin[px[i + 2]!]!;
    }
    const n = px.length / 4;
    return n ? col.setRGB(r / n, g / n, b / n) : null;
  } catch {
    return null;
  }
}

// --------------------------------------------------------- painted colours --

/** Texels per tile in the read-back colour map. */
const PER_TILE = 2;

/**
 * A coarse copy of the painted terrain (PER_TILE² texels a tile), read back
 * once at load by drawing each chunk small onto a 2D canvas. `at` returns a
 * linear-space colour; missing chunks (or a blocked canvas) give null.
 */
export class PaintedColors {
  private data: Float32Array | null = null;
  private w: number;
  private h: number;

  constructor(
    W: number,
    H: number,
    chunks: (THREE.Texture | null)[][],
    pxPerTile: number,
    chunk: number
  ) {
    this.w = W * PER_TILE;
    this.h = H * PER_TILE;
    try {
      const c = document.createElement("canvas");
      c.width = this.w;
      c.height = this.h;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      const k = PER_TILE / pxPerTile;
      let any = false;
      chunks.forEach((row, r) =>
        row.forEach((tex, col) => {
          const img = tex?.image as CanvasImageSource & { width: number; height: number } | undefined;
          if (!img || !img.width) return;
          ctx.drawImage(img, col * chunk * k, r * chunk * k, img.width * k, img.height * k);
          any = true;
        })
      );
      if (!any) return;
      const px = ctx.getImageData(0, 0, this.w, this.h).data;
      const out = new Float32Array(this.w * this.h * 3);
      const col = new THREE.Color();
      for (let i = 0; i < this.w * this.h; i++) {
        col.setRGB(px[i * 4]! / 255, px[i * 4 + 1]! / 255, px[i * 4 + 2]! / 255, THREE.SRGBColorSpace);
        out[i * 3] = col.r;
        out[i * 3 + 1] = col.g;
        out[i * 3 + 2] = col.b;
      }
      this.data = out;
    } catch {
      this.data = null;
    }
  }

  /** The painted colour around tile point (x, y), averaged over about `r` tiles (linear), into `out`. */
  at(x: number, y: number, out: THREE.Color, r = 0.5): THREE.Color | null {
    const d = this.data;
    if (!d) return null;
    const n = Math.max(0, Math.round(r * PER_TILE - 0.5));
    const cx = Math.floor(x * PER_TILE);
    const cy = Math.floor(y * PER_TILE);
    let sr = 0;
    let sg = 0;
    let sb = 0;
    let cnt = 0;
    for (let j = cy - n; j <= cy + n; j++)
      for (let i = cx - n; i <= cx + n; i++) {
        const ii = Math.min(this.w - 1, Math.max(0, i));
        const jj = Math.min(this.h - 1, Math.max(0, j));
        const k = (jj * this.w + ii) * 3;
        sr += d[k]!;
        sg += d[k + 1]!;
        sb += d[k + 2]!;
        cnt++;
      }
    return out.setRGB(sr / cnt, sg / cnt, sb / cnt);
  }
}
