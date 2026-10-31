import { BUILDINGS, ECONOMY, GOLIATH, TICK_RATE, UNITS } from "../../sim/balance";
import type { Faction, World } from "../../sim/types";
import { buildingCenter } from "../../sim/world";
import { PLAYER, type Controller } from "../controller";
import type { View } from "../three/view";
import type { ScreenRect } from "../three/screen";
import type { EntityRenderer } from "./entities";
import type { CombatJuice } from "./juice-view";

/** Radius of an order's waypoint ring (CSS px). */
const WAYPOINT_PX = 7;
/** Production meters in the producer's side colour (blue is blue on both phones of a sound duel). */
const METER: Record<Faction, string> = { blue: "#6eb0ff", red: "#ff7a6a", green: "#5fe07f", purple: "#b98cff" };
/** Box-select dashes (CSS px), their dark rims (each 1 px longer at both ends), and none. */
const DASH = [6, 4];
const DASH_RIM = [8, 2];
const NO_DASH: number[] = [];

/** Selection and status marks. Reads current world contents on every draw, including after replay restore. */
export class OverlayRenderer {
  private waypoints: { key: number; x: number; y: number; col: number }[] = [];
  private chevrons: number[] = [];
  private goliathDown = [false, false, false];

  constructor(
    private readonly view: Pick<View, "ground" | "over" | "rig" | "screen" | "dpr">,
    private readonly world: World,
    private readonly ctrl: Pick<Controller, "selectedUnits" | "selectedBuilding" | "ahead">,
    private readonly entities: Pick<EntityRenderer, "pos" | "isShown" | "shownHp" | "ranked" | "goliathMarks">,
    private readonly juice: Pick<CombatJuice, "healthBar" | "meter">
  ) {}

  /**
   * Selection rings, order lines and waypoints, building selection and range.
   * Selection outranks the combat rings under it
   * (bolder, fully opaque, a faint fill under our own units); a selection's
   * orders share one waypoint per target, joined by thin unhaloed lines.
   */
  drawWorld(): void {
    const g = this.view.ground;
    const w = this.world;
    const marks = this.waypoints;
    let nMarks = 0;
    for (const id of this.ctrl.selectedUnits) {
      const u = w.units.get(id);
      const p = this.entities.pos(id);
      if (!u || !p) continue;
      const air = UNITS[u.kind].domain === "air";
      const r = UNITS[u.kind].radius * 1.12 + 0.14;
      const own = u.faction === PLAYER;
      // aircraft: ring the craft itself (at altitude), not the ground under it
      const at = air ? p.h - 0.1 : undefined;
      if (own) g.fillStyle(0x7ef29b, 0.1).fillEllipse(p.x, p.y, r * 2.1, r * 2.1, at);
      g.lineStyle(2.5, own ? 0x7ef29b : 0xff7a6a, 1).strokeEllipse(p.x, p.y, r * 2.1, r * 2.1, at);
      if (!own) continue;
      const o = u.order;
      let tx = 0;
      let ty = 0;
      let key = 0;
      let col = 0x7ef29b;
      if (o.type === "move" || o.type === "attackMove") {
        tx = o.x;
        ty = o.y;
        // (orders to the same tile share a waypoint: one tap sends the whole selection there)
        key = (Math.floor(o.x) * 4096 + Math.floor(o.y)) * 2 + (o.type === "move" ? 2 : 1);
        col = o.type === "move" ? 0x7ec1ff : 0x7ef29b;
      } else if (o.type === "attack") {
        const t = this.entities.pos(o.targetId);
        if (!t || !this.entities.isShown(o.targetId)) continue;
        tx = t.gx;
        ty = t.gy;
        key = -1 - o.targetId;
        col = 0xff5a4a;
      } else if (o.type === "board") {
        // a squad walking to its Condor: a blue line to the craft
        const t = this.entities.pos(o.carrierId);
        if (!t) continue;
        tx = t.gx;
        ty = t.gy;
        key = -1e7 - o.carrierId;
        col = 0x7ec1ff;
      } else if (o.type === "unload") {
        // a Condor flying a drop: a gold waypoint where the squads land
        tx = o.x;
        ty = o.y;
        key = -2e7 - (Math.floor(o.x) * 4096 + Math.floor(o.y));
        col = 0xffe066;
      } else continue;
      let m = 0;
      while (m < nMarks && marks[m]!.key !== key) m++;
      if (m === nMarks) {
        const mk = marks[nMarks] ?? (marks[nMarks] = { key: 0, x: 0, y: 0, col: 0 });
        mk.key = key;
        mk.x = tx;
        mk.y = ty;
        mk.col = col;
        nMarks++;
      }
      const mk = marks[m]!;
      // the line stops at the waypoint's ring
      const dx = mk.x - p.gx;
      const dy = mk.y - p.gy;
      const d = Math.hypot(dx, dy);
      const stop = WAYPOINT_PX * g.px(mk.x, mk.y);
      if (d > stop) g.lineStyle(1.2, col, 0.35, 0).lineBetween(p.gx, p.gy, mk.x - (dx / d) * stop, mk.y - (dy / d) * stop);
    }
    for (let i = 0; i < nMarks; i++) {
      const mk = marks[i]!;
      const px = g.px(mk.x, mk.y);
      g.lineStyle(1.5, mk.col, 0.85).strokeCircle(mk.x, mk.y, WAYPOINT_PX * px);
      g.fillStyle(mk.col, 0.9).fillCircle(mk.x, mk.y, 2.5 * px);
    }

    const sb = this.ctrl.selectedBuilding !== null ? w.buildings.get(this.ctrl.selectedBuilding) : null;
    if (sb) {
      const size = BUILDINGS[sb.kind].size;
      g.lineStyle(2.5, 0x7ef29b, 1).strokeRect(sb.tx + 0.03, sb.ty + 0.03, size - 0.06, size - 0.06);
      const st = BUILDINGS[sb.kind];
      const c = buildingCenter(sb);
      if (st.range > 0) g.lineStyle(1.2, 0xffffff, 0.3).strokeCircle(c.x, c.y, st.range + size / 2);
      // (a sound duel: a new rally point still on its way already shows)
      const rally = this.ctrl.ahead().rally(sb.id) ?? sb.rally;
      if (rally) g.lineStyle(1.5, 0xffe066, 0.8).lineBetween(c.x, c.y, rally.x, rally.y).strokeCircle(rally.x, rally.y, 0.16);
    }
    // Goliaths' build rings, threat rings and anchoring arcs (read through the fog: they're always seen)
    this.entities.goliathMarks(this.view.over, this.ctrl.selectedUnits);
  }

  /** Screen-space marks over the 3D view: health and production bars, chevrons, the box select. */
  drawScreen(box: ScreenRect | null): void {
    const rig = this.view.rig;
    const ctx = this.view.screen.begin();
    const w = this.world;
    // health bars (damaged or selected) and veterancy
    for (const u of w.units.values()) {
      const max = UNITS[u.kind].hp;
      const selected = this.ctrl.selectedUnits.has(u.id);
      const harvesterLoad = u.kind === "harvester" && u.faction === PLAYER && selected;
      if (u.hp >= max && !selected) continue;
      if (!this.entities.isShown(u.id)) continue;
      const p = this.entities.pos(u.id);
      if (!p) continue;
      const s = rig.project(p.x, p.y, p.top + 0.12);
      if (s.behind) continue;
      if (u.goliath) {
        // a Goliath's bar is wider and taller, notched where each weapon goes offline
        const gw = Math.min(120, Math.max(60, (UNITS[u.kind].radius * 2.4) / rig.worldPerPx(p.x, p.y)));
        // (amber while that weapon is down: offline, or rebooting after the Menders brought it back)
        GOLIATH_MARK_WEAPONS.forEach((k, i) => (this.goliathDown[i] = !u.goliath!.weapons[k].online));
        this.juice.healthBar(ctx, u.id, s.x - gw / 2, s.y - 11, gw, u.hp / max, u.faction === PLAYER, 5, GOLIATH_MARKS, this.goliathDown);
        continue;
      }
      const bw = Math.min(64, Math.max(30, (UNITS[u.kind].radius * 2.2) / rig.worldPerPx(p.x, p.y)));
      this.juice.healthBar(ctx, u.id, s.x - bw / 2, s.y - 10, bw, u.hp / max, u.faction === PLAYER);
      // the load rides 2 px under the health bar, in the same frame style
      if (harvesterLoad) this.juice.meter(ctx, s.x - bw / 2, s.y - 4, bw, 3, u.cargo / ECONOMY.harvesterCapacity, "#ffd66e");
    }
    // infantry training under our own anchored Goliaths
    for (const u of w.units.values()) {
      const head = u.goliath?.queue[0];
      if (!head || u.faction !== PLAYER || !this.entities.isShown(u.id)) continue;
      const p = this.entities.pos(u.id);
      if (!p) continue;
      const s = rig.project(p.x, p.y, p.h);
      if (s.behind) continue;
      const mw = Math.min(90, Math.max(44, 1.6 / rig.worldPerPx(p.x, p.y)));
      this.juice.meter(ctx, s.x - mw / 2, s.y + 6, mw, 4, 1 - head.remaining / (UNITS[head.kind].buildTime * TICK_RATE), METER[u.faction]);
    }
    for (const b of w.buildings.values()) {
      const size = BUILDINGS[b.kind].size;
      if (!this.entities.isShown(b.id)) continue;
      const p = this.entities.pos(b.id);
      if (!p) continue;
      const bw = Math.min(150, Math.max(36, (size * 0.8) / rig.worldPerPx(p.x, p.y)));
      // (none on an enemy building we only remember: its health is out of sight)
      const ratio = this.entities.shownHp(b.id);
      if (ratio !== null && (ratio < 1 || this.ctrl.selectedBuilding === b.id)) {
        const s = rig.project(p.x, p.y, p.top + 0.1);
        if (!s.behind) this.juice.healthBar(ctx, b.id, s.x - bw / 2, s.y - 11, bw, ratio, b.faction === PLAYER, 5);
      }
      // production progress under our factories (and under an enemy Gantry: its Goliath is public)
      const head = b.queue[0];
      if (head && (b.faction === PLAYER || BUILDINGS[b.kind].alwaysVisible)) {
        const total = UNITS[head.kind].buildTime * TICK_RATE;
        const s = rig.project(p.x, b.ty + size, p.h - 0.4);
        if (!s.behind) this.juice.meter(ctx, s.x - bw / 2, s.y - 8, bw, 4, 1 - head.remaining / total, METER[b.faction]);
      }
    }
    // veterancy chevrons float above the unit, on the device pixel grid (crisp, and no shimmer as the camera glides)
    const dpr = this.view.dpr;
    const chev = this.chevrons;
    let n = 0;
    for (const r of this.entities.ranked()) {
      const s = rig.project(r.x, r.y, r.h + 0.12);
      if (s.behind) continue;
      const y = Math.round((s.y - 20) * dpr) / dpr;
      for (let i = 0; i < r.rank; i++) {
        const last = i === r.rank - 1;
        chev[n++] = Math.round((s.x - (r.rank - 1) * 7 + i * 14) * dpr) / dpr;
        chev[n++] = y;
        chev[n++] = last ? 0.8 + (1 - r.pop) * 0.8 : 0.8;
      }
    }
    if (n > 0) {
      // a soft drop shadow lifts the gold off sand and snow: the same shapes a pixel lower, dark with a
      // feathered rim (one path for them all, and no canvas shadowBlur, which blurs a mask per draw)
      const drop = Math.max(1, Math.round(dpr)) / dpr;
      ctx.beginPath();
      for (let i = 0; i < n; i += 3) chevron(ctx, chev[i]!, chev[i + 1]! + drop, chev[i + 2]!);
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fill();
      ctx.lineWidth = 2.6;
      ctx.strokeStyle = "rgba(0,0,0,0.2)";
      ctx.stroke();
      ctx.beginPath();
      for (let i = 0; i < n; i += 3) chevron(ctx, chev[i]!, chev[i + 1]!, chev[i + 2]!);
      ctx.fillStyle = "#ffd66e";
      ctx.fill();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = "#3a2a00";
      ctx.stroke();
    }
    if (box) {
      const b = box;
      // edges through device pixel centres: the strokes sit on the pixel grid instead of straddling it
      const x = pxCentre(Math.min(b.x0, b.x1), dpr);
      const y = pxCentre(Math.min(b.y0, b.y1), dpr);
      const bw = pxCentre(Math.max(b.x0, b.x1), dpr) - x;
      const bh = pxCentre(Math.max(b.y0, b.y1), dpr) - y;
      ctx.fillStyle = "rgba(126,242,155,0.08)";
      ctx.fillRect(x, y, bw, bh);
      // marching green dashes, each with a 1 px dark rim (a dash 1 px longer at both ends): the edge
      // reads on snow, and on sand the gaps stay sand instead of making a dark frame
      const march = (performance.now() / 40) % 10;
      ctx.setLineDash(DASH_RIM);
      ctx.lineDashOffset = 1 - march;
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = "rgba(4,7,12,0.55)";
      ctx.strokeRect(x, y, bw, bh);
      ctx.setLineDash(DASH);
      ctx.lineDashOffset = -march;
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "rgba(126,242,155,0.95)";
      ctx.strokeRect(x, y, bw, bh);
      ctx.setLineDash(NO_DASH);
      ctx.lineDashOffset = 0;
    }
  }
}

/** Where a Goliath's weapons go offline, notched on its health bar (mortars, laser, cannons). */
const GOLIATH_MARK_WEAPONS = ["mortars", "laser", "cannons"] as const;
const GOLIATH_MARKS = GOLIATH_MARK_WEAPONS.map((k) => GOLIATH.weapons[k].lostBelow);

/** The centre of the device pixel under CSS coordinate `v`. */
function pxCentre(v: number, dpr: number): number {
  return (Math.floor(v * dpr) + 0.5) / dpr;
}

/** Add a rank chevron centred on (x, y), scaled by k, to the current path (drawn gold by drawScreen). */
function chevron(ctx: CanvasRenderingContext2D, x: number, y: number, k: number): void {
  ctx.moveTo(x - 9 * k, y - 2 * k);
  ctx.lineTo(x, y - 6.5 * k);
  ctx.lineTo(x + 9 * k, y - 2 * k);
  ctx.lineTo(x + 9 * k, y + 4 * k);
  ctx.lineTo(x, y - 0.5 * k);
  ctx.lineTo(x - 9 * k, y + 4 * k);
  ctx.closePath();
}
