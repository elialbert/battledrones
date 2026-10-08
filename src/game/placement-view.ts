/**
 * Touch-friendly building placement, wired into the scene.
 *
 * Entering placement drops the ghost on a suggested valid spot near the
 * middle of the view (sim/placement.ts suggestPlacement), gliding there if
 * it's off screen. On touch a tap MOVES the ghost (snapping a tile onto a
 * valid spot if that's all it takes), dragging the ghost slides it, and
 * tapping the ghost — or the "✓ Place" chip — builds. A mouse keeps
 * one-click placement with the ghost under the cursor. A refused spot says
 * why above the ghost ("Too far from base"), and a refused build shakes it
 * with a buzz.
 */
import { BUILDINGS } from "../sim/balance";
import { inBuildRange, suggestPlacement } from "../sim/placement";
import type { BuildingKind, World } from "../sim/types";
import { sfx } from "./audio";
import { setVariant } from "./three/materials";
import { buildingDef, instance, type ModelInstance } from "./three/models";
import type { Label } from "./three/screen";
import type { View } from "./three/view";
import { radioCue } from "./announcer";
import { PLAYER, type Controller } from "./controller";
import type { GesturePointer } from "./gestures";

export interface PlacementHooks {
  view: View;
  world: World;
  ctrl: Controller;
  /** Middle of the visible battlefield (tiles), clear of the HUD. */
  viewCentre(): { x: number; y: number };
  /** Is this tile point inside the visible battlefield? */
  inView(x: number, y: number): boolean;
  glideTo(x: number, y: number): void;
  /** A one-time hint (shown once per device). */
  hint(id: string, msg: string): void;
  /** Hand a finger back to the gesture recognizer (a pinch that began on the ghost). */
  handoff(p: GesturePointer): void;
}

/** Ghost shake on a refused build (ms) and its amplitude (CSS px). */
const SHAKE_MS = 220;
const SHAKE_PX = 4;
/** Finger slop around the ghost that still counts as touching it (CSS px). */
const GHOST_SLOP_PX = 14;
/** A press on the ghost that moves less than this is a tap (CSS px). */
const TAP_SLOP_PX = 8;

export class PlacementView {
  /** The ghost: a translucent model of the building, green where it may stand, red where not. */
  private ghost: ModelInstance | null = null;
  private ghostKind: BuildingKind | null = null;
  private ghostOk: boolean | null = null;
  private label: Label;
  private kind: BuildingKind | null = null;
  private lastType: GesturePointer["pointerType"] = "touch";
  private drag: {
    id: number; sx: number; sy: number; x: number; y: number; tx0: number; ty0: number; moved: boolean;
  } | null = null;
  /** Other fingers that landed during a ghost drag (ignored until lifted). */
  private swallow = new Set<number>();
  private shake = Infinity;
  private pulse = 0;
  private zone: { key: string; runs: number[]; edges: number[] } | null = null;

  constructor(private h: PlacementHooks) {
    this.label = h.view.screen.label({ x: 0, y: 0, text: "", size: 13, color: "#ffb3a6", bg: "rgba(10, 14, 22, 0.88)", visible: false });
  }

  /** Placing, the building is ready, and the ghost has a spot. */
  private get active(): boolean {
    const c = this.h.ctrl;
    return !!c.placing && !!c.placeAt && !!this.h.world.factions[PLAYER].pending?.ready;
  }

  private worldAt(sx: number, sy: number): { x: number; y: number } {
    return this.h.view.rig.ground(sx, sy);
  }

  /** Top-left tile for a footprint centred under world point p. */
  private tileUnder(p: { x: number; y: number }): { tx: number; ty: number } {
    const size = BUILDINGS[this.h.ctrl.placing!].size;
    return { tx: Math.round(p.x - size / 2), ty: Math.round(p.y - size / 2) };
  }

  /** Is screen point (sx, sy) on the ghost (with a finger's worth of slop)? */
  private onGhost(sx: number, sy: number): boolean {
    const at = this.h.ctrl.placeAt;
    if (!at || !this.h.ctrl.placing) return false;
    const size = BUILDINGS[this.h.ctrl.placing].size;
    const p = this.worldAt(sx, sy);
    const slop = Math.max(0.3, GHOST_SLOP_PX * this.h.view.rig.worldPerPx(p.x, p.y));
    return p.x >= at.tx - slop && p.x <= at.tx + size + slop && p.y >= at.ty - slop && p.y <= at.ty + size + slop;
  }

  private enter(kind: BuildingKind): void {
    const c = this.h.viewCentre();
    const size = BUILDINGS[kind].size;
    const s = suggestPlacement(this.h.world, PLAYER, kind, c);
    this.h.ctrl.placeAt = s ?? { tx: Math.round(c.x - size / 2), ty: Math.round(c.y - size / 2) };
    if (s && !this.h.inView(s.tx + size / 2, s.ty + size / 2)) this.h.glideTo(s.tx + size / 2, s.ty + size / 2);
    this.pulse = 0;
    if (this.lastType !== "mouse")
      this.h.hint("place", "Tap the map (or drag) to move the ghost, then tap it or ✓ Place to build.");
  }

  /** Every frame, before drawing. */
  update(delta: number): void {
    const ready = !!this.h.world.factions[PLAYER].pending?.ready;
    const kind = ready ? this.h.ctrl.placing : null;
    if (kind !== this.kind) {
      this.kind = kind;
      this.drag = null;
      if (kind) this.enter(kind);
    } else if (kind && !this.h.ctrl.placeAt) this.enter(kind);
    const d = this.h.ctrl.denied;
    if (d) {
      this.h.ctrl.denied = null;
      this.refused();
    }
    this.shake += delta;
    this.pulse += delta;
  }

  /** A build was refused: shake the ghost, buzz, and say so on the radio. */
  private refused(): void {
    this.shake = 0;
    sfx.play("deny", 0.7);
    if (navigator.vibrate) navigator.vibrate([18, 40, 18]);
    radioCue("cant-build");
    const chip = document.querySelector<HTMLElement>('#chips .chip[data-id="place"]');
    if (chip) {
      chip.classList.remove("nope");
      void chip.offsetWidth;
      chip.classList.add("nope");
    }
  }

  // --------------------------------------------------------------- input --

  /** Pointer down on the canvas; true = handled here (don't pass to gestures). */
  down(p: GesturePointer): boolean {
    this.lastType = p.pointerType;
    if (this.drag) {
      if (this.drag.moved) {
        this.swallow.add(p.id); // already sliding the ghost: ignore other fingers
        return true;
      }
      // a second finger before the ghost moved: it's a pinch, give both to the gestures
      const d = this.drag;
      this.drag = null;
      this.h.handoff({ id: d.id, x: d.x, y: d.y, pointerType: "touch" });
      return false;
    }
    if (!this.active || p.pointerType === "mouse" || !this.onGhost(p.x, p.y)) return false;
    const at = this.h.ctrl.placeAt!;
    this.drag = { id: p.id, sx: p.x, sy: p.y, x: p.x, y: p.y, tx0: at.tx, ty0: at.ty, moved: false };
    return true;
  }

  move(p: GesturePointer): boolean {
    if (!this.drag) {
      // a mouse carries the ghost under the cursor
      if (p.pointerType === "mouse" && this.active) this.h.ctrl.placeAt = this.tileUnder(this.worldAt(p.x, p.y));
      return this.swallow.has(p.id);
    }
    if (p.id !== this.drag.id) return true;
    const d = this.drag;
    d.x = p.x;
    d.y = p.y;
    if (!d.moved && Math.hypot(p.x - d.sx, p.y - d.sy) > TAP_SLOP_PX) d.moved = true;
    if (d.moved && this.active) {
      const a = this.worldAt(d.sx, d.sy);
      const b = this.worldAt(p.x, p.y);
      this.h.ctrl.placeAt = { tx: d.tx0 + Math.round(b.x - a.x), ty: d.ty0 + Math.round(b.y - a.y) };
    }
    return true;
  }

  up(p: GesturePointer): boolean {
    if (this.swallow.delete(p.id)) return true;
    if (!this.drag || p.id !== this.drag.id) return false;
    const d = this.drag;
    this.drag = null;
    if (!d.moved) this.h.ctrl.commitPlacement(); // a tap on the ghost builds it
    return true;
  }

  /** A tap (or the 2nd tap of a double-tap) while placing; true = handled. */
  tap(sx: number, sy: number, type?: GesturePointer["pointerType"]): boolean {
    if (!this.active) return false;
    const t = type ?? this.lastType;
    const at = this.tileUnder(this.worldAt(sx, sy));
    if (t === "mouse") {
      this.h.ctrl.placeAt = at;
      this.h.ctrl.commitPlacement();
    } else if (this.onGhost(sx, sy)) this.h.ctrl.commitPlacement();
    else {
      this.h.ctrl.movePlacement(at.tx, at.ty);
      this.pulse = 0;
      sfx.play("click", 0.35);
    }
    return true;
  }

  // -------------------------------------------------------------- render --

  /** Draw the build zone, the footprint and the ghost (every frame). */
  draw(): void {
    const kind = this.h.ctrl.placing;
    const at = this.h.ctrl.placeAt;
    const v = this.h.view;
    if (!kind || !at || !this.active) {
      if (this.ghost) this.ghost.root.visible = false;
      this.label.visible = false;
      return;
    }
    const w = this.h.world;
    // where you may build: the build-range zone, tinted with a crisp outline
    const g = v.over;
    const z = this.buildZone(w);
    g.fillStyle(0x7ef29b, 0.07);
    for (let i = 0; i < z.runs.length; i += 3) g.fillRect(z.runs[i]!, z.runs[i + 1]!, z.runs[i + 2]!, 1);
    g.lineStyle(1.5, 0x7ef29b, 0.45);
    for (let i = 0; i < z.edges.length; i += 4) g.lineBetween(z.edges[i]!, z.edges[i + 1]!, z.edges[i + 2]!, z.edges[i + 3]!);
    const size = BUILDINGS[kind].size;
    const why = this.h.ctrl.placementProblem();
    const ok = why === null;
    const k = this.shake < SHAKE_MS ? 1 - this.shake / SHAKE_MS : 0;
    const cx = at.tx + size / 2;
    const cy = at.ty + size / 2;
    const off = k > 0 ? Math.sin((this.shake / SHAKE_MS) * Math.PI * 6) * SHAKE_PX * v.rig.worldPerPx(cx, cy) * k : 0;
    const x = at.tx + off;
    const y = at.ty;
    if (!this.ghost || this.ghostKind !== kind) {
      if (this.ghost) v.scene.remove(this.ghost.root);
      this.ghost = instance(buildingDef(kind, PLAYER), false);
      this.ghost.root.renderOrder = 21;
      this.ghost.root.traverse((o) => (o.renderOrder = 21));
      this.ghostKind = kind;
      this.ghostOk = null;
      v.scene.add(this.ghost.root);
    }
    if (this.ghostOk !== ok) {
      this.ghostOk = ok;
      setVariant(this.ghost.root, ok ? "ghostOk" : "ghostBad");
    }
    const ground = Math.max(v.terrain.heightAt(cx, cy), v.terrain.surfaceAt(cx, cy));
    this.ghost.root.visible = true;
    this.ghost.root.position.set(x + size / 2, ground, y + size / 2);
    // a valid ghost breathes, inviting the tap that builds it
    const breathe = ok ? 0.7 + 0.3 * Math.sin(this.pulse / 260) : 0.95;
    this.ghost.root.scale.set(1, ok ? 0.96 + 0.04 * breathe : 1, 1);
    const t = v.top;
    t.fillStyle(ok ? 0x37d67a : 0xe25555, 0.25).fillRect(x, y, size, size);
    t.lineStyle(2, ok ? 0x37d67a : 0xe25555, breathe).strokeRect(x, y, size, size);
    if (why) {
      this.label.text = why;
      this.label.visible = true;
      this.label.x = x + size / 2;
      this.label.y = y + size / 2;
      this.label.h = ground + (this.ghost.def.height ?? 1) + 0.2;
      this.label.dy = -6;
    } else this.label.visible = false;
  }

  /**
   * Tiles whose centre is in build range of the base, as horizontal runs
   * [x, y, length, …] and outline segments [x0, y0, x1, y1, …] (tiles).
   * Recomputed only when the set of buildings changes.
   */
  private buildZone(w: World): { runs: number[]; edges: number[] } {
    let key = "";
    for (const b of w.buildings.values()) if (b.faction === PLAYER) key += `${b.id},`;
    if (this.zone?.key === key) return this.zone;
    const inZone = new Uint8Array(w.width * w.height);
    for (let ty = 0; ty < w.height; ty++)
      for (let tx = 0; tx < w.width; tx++) if (inBuildRange(w, PLAYER, tx + 0.5, ty + 0.5)) inZone[ty * w.width + tx] = 1;
    const at = (x: number, y: number) => x >= 0 && y >= 0 && x < w.width && y < w.height && inZone[y * w.width + x] === 1;
    const runs: number[] = [];
    const edges: number[] = [];
    for (let ty = 0; ty < w.height; ty++) {
      let start = -1;
      for (let tx = 0; tx <= w.width; tx++) {
        const on = at(tx, ty);
        if (on && start < 0) start = tx;
        if (!on && start >= 0) {
          runs.push(start, ty, tx - start);
          start = -1;
        }
        if (!on) continue;
        if (!at(tx, ty - 1)) edges.push(tx, ty, tx + 1, ty);
        if (!at(tx, ty + 1)) edges.push(tx, ty + 1, tx + 1, ty + 1);
        if (!at(tx - 1, ty)) edges.push(tx, ty, tx, ty + 1);
        if (!at(tx + 1, ty)) edges.push(tx + 1, ty, tx + 1, ty + 1);
      }
    }
    this.zone = { key, runs, edges };
    return this.zone;
  }

  destroy(): void {
    if (this.ghost) this.h.view.scene.remove(this.ghost.root);
    this.h.view.screen.remove(this.label);
  }
}
