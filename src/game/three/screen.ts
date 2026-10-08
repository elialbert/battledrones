import type { CameraRig } from "./camera";

/**
 * A 2D canvas laid over the WebGL view for crisp screen-space marks: health
 * bars, rank chevrons, the box-select rectangle and floating labels ("+100",
 * "VETERAN", "Too far from base"). Labels are anchored to a world point and
 * re-projected every frame, so they ride along with the camera.
 */

export const LABEL_FONT = '"Rajdhani", "Segoe UI", system-ui, -apple-system, sans-serif';

export interface Label {
  /** Anchor (tiles) and height above the ground (world units). */
  x: number;
  y: number;
  h: number;
  text: string;
  /** Font size, CSS px. */
  size: number;
  color: string;
  stroke?: string;
  /** Optional backing plate (placement reasons). */
  bg?: string;
  /** Screen offset (CSS px), animated by the owner. */
  dx: number;
  dy: number;
  scale: number;
  alpha: number;
  shadow?: boolean;
  /** Origin: 1 = bottom-centre (the default), 0.5 = centre. */
  oy?: number;
  visible: boolean;
}

export class ScreenLayer {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  private labels = new Set<Label>();
  private dpr = 1;

  constructor(parent: HTMLElement, private rig: CameraRig) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "overlay2d";
    this.canvas.style.pointerEvents = "none";
    parent.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;
  }

  resize(w: number, h: number, dpr: number): void {
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
  }

  /** Start a frame: clear, CSS-px transform. */
  begin(): CanvasRenderingContext2D {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    return ctx;
  }

  /** Create a label (drawn until removed). */
  label(spec: Partial<Label> & { x: number; y: number; text: string }): Label {
    const l: Label = {
      h: 0, size: 18, color: "#ffffff", dx: 0, dy: 0, scale: 1, alpha: 1, visible: true,
      ...spec
    };
    this.labels.add(l);
    return l;
  }

  remove(l: Label | null | undefined): void {
    if (l) this.labels.delete(l);
  }

  has(l: Label): boolean {
    return this.labels.has(l);
  }

  /** Draw every live label (after the frame's bars and marks). */
  drawLabels(): void {
    const ctx = this.ctx;
    for (const l of this.labels) {
      if (!l.visible || l.alpha <= 0.01 || !l.text) continue;
      const p = this.rig.project(l.x, l.y, l.h);
      if (p.behind) continue;
      const size = l.size * l.scale;
      if (size < 2) continue;
      ctx.save();
      ctx.globalAlpha = Math.min(1, l.alpha);
      ctx.font = `bold ${size.toFixed(1)}px ${LABEL_FONT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = l.oy === 0.5 ? "middle" : "alphabetic";
      const x = p.x + l.dx;
      const y = p.y + l.dy - (l.oy === 0.5 ? 0 : size * 0.18);
      if (l.bg) {
        const w = ctx.measureText(l.text).width + 14;
        const hh = size + 6;
        ctx.fillStyle = l.bg;
        roundRect(ctx, x - w / 2, y - hh + size * 0.25, w, hh, 5);
        ctx.fill();
      }
      if (l.shadow) {
        ctx.shadowColor = "rgba(0,0,0,0.55)";
        ctx.shadowBlur = 6;
        ctx.shadowOffsetY = 2;
      }
      if (l.stroke) {
        ctx.lineJoin = "round";
        ctx.lineWidth = Math.max(2.5, size / 4.2);
        ctx.strokeStyle = l.stroke;
        ctx.strokeText(l.text, x, y);
        ctx.shadowColor = "transparent";
      }
      ctx.fillStyle = l.color;
      ctx.fillText(l.text, x, y);
      ctx.restore();
    }
  }

  clearLabels(): void {
    this.labels.clear();
  }

  destroy(): void {
    this.labels.clear();
    this.canvas.remove();
  }
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
