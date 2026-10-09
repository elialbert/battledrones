import type { CameraRig } from "./camera";

/**
 * A 2D canvas laid over the WebGL view for crisp screen-space marks: health
 * bars, rank chevrons, the box-select rectangle and floating labels ("+100",
 * "VETERAN", "Too far from base"). Labels are anchored to a world point and
 * re-projected every frame, so they ride along with the camera; they are
 * snapped to whole device pixels so text stays sharp at any pixel ratio.
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
  /** The plate's rim colour (default: a faint light edge). */
  border?: string;
  /** The plate points down at its anchor with a small tail. */
  tail?: boolean;
  /** Keep the label at least this many CSS px inside the screen edges. */
  pin?: number;
  /** Screen rects (CSS px, HUD widgets) a plated label slides sideways off. */
  avoid?: readonly ScreenRect[];
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

export interface ScreenRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Plate padding (CSS px) and corner radius, shared by every plated label. */
const PLATE_PAD_X = 9;
const PLATE_PAD_Y = 4;
const PLATE_R = 6;
const TAIL = 6;

export class ScreenLayer {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  private labels = new Set<Label>();
  private dpr = 1;
  private w = 1;
  private h = 1;
  /** Font strings by half-pixel size (labels tween their scale every frame). */
  private fonts = new Map<number, string>();

  constructor(parent: HTMLElement, private rig: CameraRig) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "overlay2d";
    this.canvas.style.pointerEvents = "none";
    parent.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;
  }

  resize(w: number, h: number, dpr: number): void {
    this.dpr = dpr;
    this.w = w;
    this.h = h;
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

  /** Snap a CSS-px coordinate to the device pixel grid. */
  private snap(v: number): number {
    return Math.round(v * this.dpr) / this.dpr;
  }

  private font(size: number): string {
    const k = Math.round(size * 2);
    let f = this.fonts.get(k);
    if (!f) {
      f = `bold ${(k / 2).toFixed(1)}px ${LABEL_FONT}`;
      this.fonts.set(k, f);
    }
    return f;
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
      ctx.font = this.font(size);
      ctx.textAlign = "center";
      ctx.textBaseline = l.oy === 0.5 ? "middle" : "alphabetic";
      const ax = p.x + l.dx;
      let x = ax;
      let y = p.y + l.dy - (l.oy === 0.5 ? 0 : size * 0.18);
      if (l.bg) {
        const w = Math.round(ctx.measureText(l.text).width + PLATE_PAD_X * 2);
        const hh = Math.round(size + PLATE_PAD_Y * 2);
        // the plate spans the cap height and descenders round the baseline y
        const above = size * 0.78 + PLATE_PAD_Y;
        const tail = l.tail ? TAIL : 0;
        y -= tail;
        const m = l.pin ?? 0;
        if (l.pin !== undefined) {
          x = Math.min(this.w - m - w / 2, Math.max(m + w / 2, x));
          y = Math.min(this.h - m - tail - (hh - above), Math.max(m + above, y));
        }
        if (l.avoid)
          for (const r of l.avoid) {
            // under a HUD widget: slide to whichever side of it is nearer and still on screen
            if (x + w / 2 <= r.x0 || x - w / 2 >= r.x1 || y - above + hh + tail <= r.y0 || y - above >= r.y1) continue;
            const toL = r.x0 - 4 - w / 2;
            const toR = r.x1 + 4 + w / 2;
            const okL = toL >= m + w / 2;
            const okR = toR <= this.w - m - w / 2;
            if (okL && (!okR || x - toL <= toR - x)) x = toL;
            else if (okR) x = toR;
          }
        x = this.snap(x);
        y = this.snap(y);
        // (the 1 px rim sits on the device pixel grid: half-pixel offset when it spans an odd count)
        const o = (Math.round(this.dpr) % 2) / (2 * this.dpr);
        const top = Math.round(y - above) + o;
        const left = Math.round(x - w / 2) + o;
        // a soft drop shadow lifts the plate off busy terrain
        ctx.shadowColor = "rgba(0,0,0,0.45)";
        ctx.shadowBlur = 8;
        ctx.shadowOffsetY = 2;
        plate(ctx, left, top, w, hh, PLATE_R, l.tail ? Math.min(left + w - PLATE_R - TAIL, Math.max(left + PLATE_R + TAIL, ax)) : null);
        ctx.fillStyle = l.bg;
        ctx.fill();
        ctx.shadowColor = "transparent";
        ctx.lineWidth = 1;
        ctx.strokeStyle = l.border ?? "rgba(255,255,255,0.14)";
        ctx.stroke();
      } else {
        if (l.pin !== undefined) x = Math.min(this.w - l.pin, Math.max(l.pin, x));
        x = this.snap(x);
        y = this.snap(y);
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

/** A rounded plate path; with `tailX`, a small tail under it points down at that x. */
function plate(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, tailX: number | null): void {
  if (tailX === null) {
    roundRect(ctx, x, y, w, h, r);
    return;
  }
  const b = y + h;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, b, r);
  ctx.arcTo(x + w, b, x, b, r);
  ctx.lineTo(tailX + TAIL, b);
  ctx.lineTo(tailX, b + TAIL);
  ctx.lineTo(tailX - TAIL, b);
  ctx.arcTo(x, b, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
