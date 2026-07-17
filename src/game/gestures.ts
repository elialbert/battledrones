/**
 * Pointer-event gesture recognizer implementing the DESIGN.md control spec.
 * Pure and engine-free: callers feed pointer events with timestamps and call
 * tick() each frame so the long-press timer can fire while a finger holds
 * still. Coordinates are whatever space the caller uses (screen pixels).
 */

export interface GesturePointer {
  id: number;
  x: number;
  y: number;
  pointerType: "touch" | "mouse" | "pen";
  /** Mouse button for down events: 0 left, 1 middle, 2 right. */
  button?: number;
}

export interface GestureCallbacks {
  onTap(x: number, y: number, pointerType: "touch" | "mouse" | "pen"): void;
  onDoubleTap(x: number, y: number): void;
  onBoxStart(x: number, y: number): void;
  onBoxMove(x: number, y: number): void;
  onBoxEnd(x: number, y: number): void;
  /** Screen-space camera pan delta. */
  onPan(dx: number, dy: number): void;
  /** A pan gesture ended (finger/button lifted) — for momentum. */
  onPanEnd?(): void;
  /** Relative zoom factor since the previous pinch event, centred on (cx, cy). */
  onPinch(scale: number, cx: number, cy: number): void;
  onRightClick(x: number, y: number): void;
  onWheel(deltaY: number, x: number, y: number): void;
}

export const TAP_SLOP_PX = 8;
export const HOLD_DELAY_MS = 250;
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_SLOP_PX = 24;
/** Finger distance must change this much before a pinch starts zooming —
 * otherwise two-finger pans wobble the zoom from natural finger jitter. */
export const PINCH_ACTIVATE_PX = 16;

type Mode = "idle" | "pending" | "pan" | "box" | "multi" | "mousepan";

interface Tracked {
  id: number;
  x: number;
  y: number;
}

export class GestureRecognizer {
  private mode: Mode = "idle";
  private pointers = new Map<number, Tracked>();
  private downX = 0;
  private downY = 0;
  private downTime = 0;
  private downType: "touch" | "mouse" | "pen" = "touch";
  private lastX = 0;
  private lastY = 0;
  private lastTapTime = -Infinity;
  private lastTapX = 0;
  private lastTapY = 0;
  private pinchDist = 0;
  private pinchStartDist = 0;
  private pinchActive = false;

  constructor(private cb: GestureCallbacks) {}

  down(p: GesturePointer, now: number): void {
    if (p.pointerType === "mouse" && p.button === 2) {
      this.cb.onRightClick(p.x, p.y);
      return;
    }
    this.pointers.set(p.id, { id: p.id, x: p.x, y: p.y });

    if (this.pointers.size === 2) {
      this.enterMulti();
      return;
    }
    if (this.pointers.size > 2) return;

    if (p.pointerType === "mouse" && p.button === 1) {
      this.mode = "mousepan";
    } else {
      this.mode = "pending";
    }
    this.downX = p.x;
    this.downY = p.y;
    this.downTime = now;
    this.downType = p.pointerType;
    this.lastX = p.x;
    this.lastY = p.y;
  }

  move(p: GesturePointer, now: number): void {
    const t = this.pointers.get(p.id);
    if (t) {
      t.x = p.x;
      t.y = p.y;
    }

    switch (this.mode) {
      case "pending": {
        const moved = Math.hypot(p.x - this.downX, p.y - this.downY) > TAP_SLOP_PX;
        if (!moved) break;
        if (now - this.downTime >= HOLD_DELAY_MS || this.downType === "mouse") {
          // mouse drags box-select immediately; touch only after the hold
          this.mode = "box";
          this.cb.onBoxStart(this.downX, this.downY);
          this.cb.onBoxMove(p.x, p.y);
        } else {
          this.mode = "pan";
          this.cb.onPan(p.x - this.downX, p.y - this.downY);
        }
        this.lastX = p.x;
        this.lastY = p.y;
        break;
      }
      case "pan":
      case "mousepan":
        this.cb.onPan(p.x - this.lastX, p.y - this.lastY);
        this.lastX = p.x;
        this.lastY = p.y;
        break;
      case "box":
        this.cb.onBoxMove(p.x, p.y);
        break;
      case "multi": {
        const [a, b] = [...this.pointers.values()];
        if (!a || !b) break;
        const cx = (a.x + b.x) / 2;
        const cy = (a.y + b.y) / 2;
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        this.cb.onPan(cx - this.lastX, cy - this.lastY);
        if (!this.pinchActive && Math.abs(dist - this.pinchStartDist) > PINCH_ACTIVATE_PX)
          this.pinchActive = true;
        if (this.pinchActive && this.pinchDist > 0 && dist > 0)
          this.cb.onPinch(dist / this.pinchDist, cx, cy);
        this.lastX = cx;
        this.lastY = cy;
        this.pinchDist = dist;
        break;
      }
      case "idle":
        break;
    }
  }

  up(p: GesturePointer, now: number): void {
    if (p.pointerType === "mouse" && p.button === 2) return;
    this.pointers.delete(p.id);

    switch (this.mode) {
      case "pending": {
        // never promoted: tap if quick, degenerate box if it was a long hold
        if (now - this.downTime >= HOLD_DELAY_MS) {
          this.cb.onBoxStart(this.downX, this.downY);
          this.cb.onBoxEnd(p.x, p.y);
        } else if (
          now - this.lastTapTime <= DOUBLE_TAP_MS &&
          Math.hypot(p.x - this.lastTapX, p.y - this.lastTapY) <= DOUBLE_TAP_SLOP_PX
        ) {
          this.lastTapTime = -Infinity;
          this.cb.onDoubleTap(p.x, p.y);
        } else {
          this.lastTapTime = now;
          this.lastTapX = p.x;
          this.lastTapY = p.y;
          this.cb.onTap(p.x, p.y, this.downType);
        }
        this.mode = "idle";
        break;
      }
      case "box":
        this.cb.onBoxEnd(p.x, p.y);
        this.mode = "idle";
        break;
      case "pan":
      case "mousepan":
        this.cb.onPanEnd?.();
        this.mode = "idle";
        break;
      case "multi":
        if (this.pointers.size < 2) {
          this.cb.onPanEnd?.();
          this.mode = "idle";
        }
        break;
      case "idle":
        break;
    }
    if (this.pointers.size === 0 && this.mode !== "idle") this.mode = "idle";
  }

  cancel(p: GesturePointer): void {
    this.pointers.delete(p.id);
    if (this.mode === "box") this.cb.onBoxEnd(this.lastX, this.lastY);
    this.mode = this.pointers.size >= 2 ? "multi" : "idle";
  }

  wheel(deltaY: number, x: number, y: number): void {
    this.cb.onWheel(deltaY, x, y);
  }

  /** Call every frame: fires the long-press box start while holding still. */
  tick(now: number): void {
    if (this.mode === "pending" && this.downType !== "mouse" && now - this.downTime >= HOLD_DELAY_MS) {
      this.mode = "box";
      this.cb.onBoxStart(this.downX, this.downY);
      if (navigator.vibrate) navigator.vibrate(10);
    }
  }

  private enterMulti(): void {
    if (this.mode === "box") this.cb.onBoxEnd(this.lastX, this.lastY);
    this.mode = "multi";
    const [a, b] = [...this.pointers.values()];
    if (a && b) {
      this.lastX = (a.x + b.x) / 2;
      this.lastY = (a.y + b.y) / 2;
      this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      this.pinchStartDist = this.pinchDist;
      this.pinchActive = false;
    }
  }
}
