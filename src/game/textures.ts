import type Phaser from "phaser";

/**
 * Small procedural FX textures (glows, puffs, tracers, beams…) drawn once
 * with the 2D canvas API at boot — crisper and lighter than shipping PNGs.
 */
export function createFxTextures(scene: Phaser.Scene): void {
  const make = (key: string, w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void) => {
    if (scene.textures.exists(key)) return;
    const tex = scene.textures.createCanvas(key, w, h)!;
    draw(tex.getContext());
    tex.refresh();
  };
  const radial = (ctx: CanvasRenderingContext2D, r: number, stops: [number, string][]) => {
    const g = ctx.createRadialGradient(r, r, 0, r, r, r);
    for (const [o, c] of stops) g.addColorStop(o, c);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, r * 2, r * 2);
  };

  // soft white glow (tinted at use): lights, flashes, crystal shimmer
  make("fx-glow", 64, 64, (ctx) =>
    radial(ctx, 32, [
      [0, "rgba(255,255,255,1)"],
      [0.25, "rgba(255,255,255,0.55)"],
      [1, "rgba(255,255,255,0)"]
    ])
  );
  // smoke puff: lumpy soft grey blob
  make("fx-smoke", 64, 64, (ctx) => {
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const x = 32 + Math.cos(a) * 9;
      const y = 32 + Math.sin(a) * 9;
      const g = ctx.createRadialGradient(x, y, 0, x, y, 18);
      g.addColorStop(0, "rgba(255,255,255,0.35)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 64, 64);
    }
    radial(ctx, 32, [
      [0, "rgba(255,255,255,0.5)"],
      [1, "rgba(255,255,255,0)"]
    ]);
  });
  // spark: tiny hot dot
  make("fx-spark", 16, 16, (ctx) =>
    radial(ctx, 8, [
      [0, "rgba(255,255,255,1)"],
      [0.4, "rgba(255,230,160,0.9)"],
      [1, "rgba(255,160,40,0)"]
    ])
  );
  // tracer: elongated bright streak pointing north
  make("fx-tracer", 12, 48, (ctx) => {
    const g = ctx.createLinearGradient(0, 0, 0, 48);
    g.addColorStop(0, "rgba(255,255,230,1)");
    g.addColorStop(0.3, "rgba(255,220,120,0.9)");
    g.addColorStop(1, "rgba(255,150,40,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(6, 24, 3, 24, 0, 0, Math.PI * 2);
    ctx.fill();
  });
  // missile / rocket body pointing north
  make("fx-missile", 12, 28, (ctx) => {
    ctx.fillStyle = "#d9dde3";
    ctx.beginPath();
    ctx.moveTo(6, 0);
    ctx.lineTo(10, 7);
    ctx.lineTo(10, 22);
    ctx.lineTo(6, 20);
    ctx.lineTo(2, 22);
    ctx.lineTo(2, 7);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#7c8490";
    ctx.fillRect(2, 18, 8, 3);
    const g = ctx.createRadialGradient(6, 24, 0, 6, 24, 5);
    g.addColorStop(0, "rgba(255,240,180,1)");
    g.addColorStop(1, "rgba(255,120,20,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 18, 12, 10);
  });
  // artillery shell / bomb: dark rounded slug
  make("fx-shell", 16, 16, (ctx) => {
    const g = ctx.createRadialGradient(6, 6, 1, 8, 8, 8);
    g.addColorStop(0, "#9aa1ab");
    g.addColorStop(0.6, "#3b4048");
    g.addColorStop(1, "rgba(20,22,26,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(8, 8, 6, 0, Math.PI * 2);
    ctx.fill();
  });
  // laser beam segment: horizontal gradient (stretched along the beam)
  make("fx-beam", 4, 32, (ctx) => {
    const g = ctx.createLinearGradient(0, 0, 0, 32);
    g.addColorStop(0, "rgba(255,255,255,0)");
    g.addColorStop(0.35, "rgba(255,255,255,0.6)");
    g.addColorStop(0.5, "rgba(255,255,255,1)");
    g.addColorStop(0.65, "rgba(255,255,255,0.6)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 4, 32);
  });
  // shock ring (flak bursts, build pulses, rank-ups)
  make("fx-ring", 64, 64, (ctx) => {
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(32, 32, 28, 0, Math.PI * 2);
    ctx.stroke();
  });
  // selection ring: crisp circle with a soft outer glow
  make("fx-select", 128, 128, (ctx) => {
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.arc(64, 64, 54, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,1)";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(64, 64, 54, 0, Math.PI * 2);
    ctx.stroke();
  });
  // rank chevron
  make("fx-chevron", 20, 14, (ctx) => {
    ctx.fillStyle = "#ffd66e";
    ctx.strokeStyle = "#3a2a00";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(1, 5);
    ctx.lineTo(10, 0.5);
    ctx.lineTo(19, 5);
    ctx.lineTo(19, 11);
    ctx.lineTo(10, 6.5);
    ctx.lineTo(1, 11);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  });
}
