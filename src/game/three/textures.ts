import * as THREE from "three";

/**
 * Procedural textures drawn once with the 2D canvas API: the particle atlas
 * (glow, smoke, spark, rings, glint, scorch, debris), the drifting cloud
 * shadows and the noise the water and lava shaders scroll.
 */

/** Cells of the 4×2 particle atlas. */
export const TEX = {
  glow: 0,
  smoke: 1,
  spark: 2,
  ring: 3,
  select: 4,
  glint: 5,
  scorch: 6,
  debris: 7
} as const;
export type TexCell = (typeof TEX)[keyof typeof TEX];

const CELL = 128;

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!];
}

/** Deterministic PRNG for repeatable textures. */
function prng(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

export function particleAtlas(): THREE.CanvasTexture {
  const [c, ctx] = canvas(CELL * 4, CELL * 2);
  const cell = (i: number, draw: (ctx: CanvasRenderingContext2D, r: number) => void) => {
    ctx.save();
    ctx.translate((i % 4) * CELL + CELL / 2, Math.floor(i / 4) * CELL + CELL / 2);
    ctx.beginPath();
    ctx.rect(-CELL / 2, -CELL / 2, CELL, CELL);
    ctx.clip();
    draw(ctx, CELL / 2 - 2);
    ctx.restore();
  };
  const radial = (ctx: CanvasRenderingContext2D, r: number, stops: [number, string][], x = 0, y = 0) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    for (const [o, col] of stops) g.addColorStop(o, col);
    ctx.fillStyle = g;
    ctx.fillRect(-CELL / 2, -CELL / 2, CELL, CELL);
  };
  cell(TEX.glow, (ctx, r) =>
    radial(ctx, r, [
      [0, "rgba(255,255,255,1)"],
      [0.22, "rgba(255,255,255,0.6)"],
      [0.55, "rgba(255,255,255,0.14)"],
      [1, "rgba(255,255,255,0)"]
    ])
  );
  cell(TEX.smoke, (ctx, r) => {
    const rnd = prng(11);
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + rnd();
      const d = r * (0.18 + rnd() * 0.22);
      radial(ctx, r * (0.45 + rnd() * 0.2), [
        [0, "rgba(255,255,255,0.42)"],
        [1, "rgba(255,255,255,0)"]
      ], Math.cos(a) * d, Math.sin(a) * d);
    }
    radial(ctx, r * 0.8, [
      [0, "rgba(255,255,255,0.55)"],
      [1, "rgba(255,255,255,0)"]
    ]);
  });
  cell(TEX.spark, (ctx, r) =>
    radial(ctx, r * 0.6, [
      [0, "rgba(255,255,255,1)"],
      [0.35, "rgba(255,236,180,0.95)"],
      [1, "rgba(255,170,60,0)"]
    ])
  );
  cell(TEX.ring, (ctx, r) => {
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.arc(0, 0, r - 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.lineWidth = 5;
    ctx.stroke();
  });
  cell(TEX.select, (ctx, r) => {
    ctx.strokeStyle = "rgba(255,255,255,0.3)";
    ctx.lineWidth = 14;
    ctx.beginPath();
    ctx.arc(0, 0, r - 10, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,1)";
    ctx.lineWidth = 6;
    ctx.stroke();
  });
  cell(TEX.glint, (ctx, r) => {
    radial(ctx, r * 0.4, [
      [0, "rgba(255,255,255,1)"],
      [1, "rgba(255,255,255,0)"]
    ]);
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    for (const [w, h] of [[4, r * 0.95], [r * 0.95, 4]] as const) {
      ctx.beginPath();
      ctx.moveTo(-w, 0);
      ctx.lineTo(0, -h);
      ctx.lineTo(w, 0);
      ctx.lineTo(0, h);
      ctx.closePath();
      ctx.fill();
    }
  });
  cell(TEX.scorch, (ctx, r) => {
    const rnd = prng(5);
    for (let i = 0; i < 14; i++) {
      const a = rnd() * Math.PI * 2;
      const d = r * rnd() * 0.45;
      radial(ctx, r * (0.25 + rnd() * 0.35), [
        [0, "rgba(255,255,255,0.5)"],
        [1, "rgba(255,255,255,0)"]
      ], Math.cos(a) * d, Math.sin(a) * d);
    }
    // splatter streaks
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    for (let i = 0; i < 16; i++) {
      const a = rnd() * Math.PI * 2;
      ctx.lineWidth = 2 + rnd() * 4;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r * 0.3, Math.sin(a) * r * 0.3);
      ctx.lineTo(Math.cos(a) * r * (0.6 + rnd() * 0.35), Math.sin(a) * r * (0.6 + rnd() * 0.35));
      ctx.stroke();
    }
  });
  cell(TEX.debris, (ctx, r) => {
    ctx.fillStyle = "rgba(255,255,255,1)";
    ctx.beginPath();
    ctx.moveTo(-r * 0.5, -r * 0.3);
    ctx.lineTo(r * 0.2, -r * 0.55);
    ctx.lineTo(r * 0.55, r * 0.1);
    ctx.lineTo(r * 0.05, r * 0.5);
    ctx.lineTo(-r * 0.45, r * 0.25);
    ctx.closePath();
    ctx.fill();
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

/** Soft blobs wrapped around the edges so the texture tiles seamlessly (R = shadow). */
export function cloudTexture(): THREE.CanvasTexture {
  const S = 256;
  const [c, ctx] = canvas(S, S);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, S, S);
  const rnd = prng(7);
  for (let i = 0; i < 22; i++) {
    const x = rnd() * S;
    const y = rnd() * S;
    const r = 20 + rnd() * 60;
    for (const ox of [-S, 0, S])
      for (const oy of [-S, 0, S]) {
        const g = ctx.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
        g.addColorStop(0, "rgba(255,255,255,0.5)");
        g.addColorStop(0.6, "rgba(255,255,255,0.22)");
        g.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = g;
        ctx.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
      }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** Tileable value noise (R, G, B = three octaves) for water ripples and lava flow. */
export function noiseTexture(): THREE.DataTexture {
  const S = 128;
  const data = new Uint8Array(S * S * 4);
  const rnd = prng(3);
  const grids = [8, 16, 32].map((n) => {
    const g = new Float32Array(n * n);
    for (let i = 0; i < g.length; i++) g[i] = rnd();
    return { n, g };
  });
  const smooth = (t: number) => t * t * (3 - 2 * t);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      grids.forEach(({ n, g }, k) => {
        const fx = (x / S) * n;
        const fy = (y / S) * n;
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const tx = smooth(fx - x0);
        const ty = smooth(fy - y0);
        const at = (i: number, j: number) => g[((j + n) % n) * n + ((i + n) % n)]!;
        const v =
          at(x0, y0) * (1 - tx) * (1 - ty) + at(x0 + 1, y0) * tx * (1 - ty) + at(x0, y0 + 1) * (1 - tx) * ty + at(x0 + 1, y0 + 1) * tx * ty;
        data[(y * S + x) * 4 + k] = Math.round(v * 255);
      });
      data[(y * S + x) * 4 + 3] = 255;
    }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

let disc: THREE.CanvasTexture | null = null;
/** A soft round glow (white; tinted by the material) for light pools on the ground. */
export function discTexture(): THREE.CanvasTexture {
  if (disc) return disc;
  const [c, ctx] = canvas(128, 128);
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 63);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.35, "rgba(255,255,255,0.55)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  disc = new THREE.CanvasTexture(c);
  disc.colorSpace = THREE.SRGBColorSpace;
  return disc;
}
