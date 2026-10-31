import { BUILDINGS, GOLIATH } from "../sim/balance";
import { Vis } from "../sim/fog";
import { unitSeenBy } from "../sim/infantry";
import { isRandomMapId } from "../sim/mapgen";
import type { Faction, Unit, World } from "../sim/types";
import { mapThumbUrl } from "../game/assets";
import { PLAYER, isRooted, type Controller } from "../game/controller";
import { wastelandOverlay } from "../game/terrain-paint";

/** The world, camera and optional marks needed by the minimap. */
export interface MinimapApi {
  world: World;
  ctrl: Pick<Controller, "showFog" | "spectator">;
  /** The ground the camera sees (tiles; a trapezoid under the tilted view), outlined on the minimap. */
  viewQuad(): { x: number; y: number }[];
  centerCamera(wx: number, wy: number): void;
  matchSeconds(): number;
  /** Battlefield wrecks the player knows about (tiles), drawn as gold minimap dots. */
  wrecks?: () => { x: number; y: number }[];
  /** Calldown reticles in flight (tiles), drawn as rings on the minimap. */
  calldowns?: () => { x: number; y: number; r: number; enemy: boolean }[];
  /** Extra minimap marks (map objectives), drawn over the unit blips; k = minimap px per tile. */
  minimapOverlay?: (ctx: CanvasRenderingContext2D, k: number) => void;
  /**
   * Uncharted (mode.ts unchartedMatch, read once at the start): the map is played blind. The minimap
   * shows only what's been scouted, the pause menu has no map reveal, and the end screen reveals it.
   */
  uncharted?: boolean;
}

export interface MinimapPing {
  x: number;
  y: number;
  t: number;
  kind?: "hit" | "inbound";
}

const MINIMAP_PX = 256;
/** Under Uncharted, unscouted ground on the minimap: solid (the usual shroud's colour, opaque). */
const MINIMAP_SHROUD = "rgb(5,7,12)";
/**
 * Minimap marks in side colours, not friend and foe: blue is blue on both
 * phones of a sound duel. Unit blips come in two tints of each side's colour,
 * the brighter one for our own army so it still stands out. Blue's own tint
 * and red's foe tint are the two the minimap always used, so blue's player
 * sees it exactly as before; a red player sees red lifted a step and blue
 * dimmed by about the same step (7 L*), still clear of blue's building fill.
 */
const MINIMAP_SIDE: Record<Faction, { building: string; own: string; foe: string; ring: string; goliath: string; goliathRim: string }> = {
  blue: { building: "#3d8bff", own: "#9fd0ff", foe: "#78bcff", ring: "rgba(159,208,255,0.6)", goliath: "#cfe8ff", goliathRim: "#1d4f8f" },
  red: { building: "#ff4a3a", own: "#ffccc2", foe: "#ffb0a0", ring: "rgba(255,140,120,0.6)", goliath: "#ff7a66", goliathRim: "#5a0f08" },
  green: { building: "#2fbf55", own: "#c2f7cf", foe: "#8ee6a4", ring: "rgba(150,240,170,0.6)", goliath: "#c8ffd6", goliathRim: "#0f4d22" },
  purple: { building: "#9a55ff", own: "#e3ccff", foe: "#c9a8ff", ring: "rgba(200,160,255,0.6)", goliath: "#e6d4ff", goliathRim: "#3a1270" }
};

/**
 * The minimap blip of one of side `f`'s units, as `pov`'s player sees it. A
 * spectator (null) has no army of its own and sees what blue's player sees,
 * which is what spectators have always seen.
 */
export function minimapDot(f: Faction, pov: Faction | null): string {
  const side = MINIMAP_SIDE[f];
  return f === (pov ?? "blue") ? side.own : side.foe;
}

/**
 * Under Uncharted, the minimap's unexplored tiles as solid rects (x, y, w, h, … in px of an S-px
 * minimap): a run per row, on whole pixels, covering every pixel an unexplored tile touches —
 * translucent tiles meeting mid-pixel would let the map's thumbnail through at their seams.
 */
export function shroudRects(vis: ArrayLike<number>, W: number, H: number, S: number): number[] {
  const k = S / W;
  const out: number[] = [];
  for (let ty = 0; ty < H; ty++) {
    const y0 = Math.floor(ty * k);
    const y1 = Math.ceil((ty + 1) * k);
    for (let tx = 0; tx < W; ) {
      if (vis[ty * W + tx] !== Vis.Unexplored) {
        tx++;
        continue;
      }
      const run = tx;
      while (tx < W && vis[ty * W + tx] === Vis.Unexplored) tx++;
      const x0 = Math.floor(run * k);
      out.push(x0, y0, Math.ceil(tx * k) - x0, y1 - y0);
    }
  }
  return out;
}

/** Canvas setup and camera dragging; the HUD decides when to draw and which pings to show. */
export function createMinimap(minimap: HTMLCanvasElement, api: MinimapApi) {
  const w = api.world;
  const uncharted = !!api.uncharted;
  minimap.width = MINIMAP_PX;
  minimap.height = MINIMAP_PX;
  const mctx = minimap.getContext("2d")!;
  // (under Uncharted it only ever shows through scouted tiles: draw)
  const thumb = new Image();
  thumb.src = mapThumbUrl(api.world.mapId);
  // (the built-in maps' painted thumbs predate the Wasteland round the fields: it's laid over them;
  // a generated map's thumb is painted with it)
  const wasteLayer = isRandomMapId(api.world.mapId) ? null : wastelandOverlay(api.world, MINIMAP_PX);

  const miniMove = (e: PointerEvent) => {
    const r = minimap.getBoundingClientRect();
    api.centerCamera(((e.clientX - r.left) / r.width) * w.width, ((e.clientY - r.top) / r.height) * w.height);
  };
  let miniDown = false;
  minimap.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    miniDown = true;
    minimap.setPointerCapture(e.pointerId);
    miniMove(e);
  });
  minimap.addEventListener("pointermove", (e) => miniDown && miniMove(e));
  minimap.addEventListener("pointerup", () => (miniDown = false));

  /** Remove expired pings in place; the late overlay sits below the camera outline. */
  function draw(pings: MinimapPing[], overlay?: (ctx: CanvasRenderingContext2D, k: number, now: number) => void): void {
    const S = MINIMAP_PX;
    const k = S / w.width;
    const fogOn = api.ctrl.showFog;
    const vis = w.fog[PLAYER].vis;
    mctx.clearRect(0, 0, S, S);
    if (thumb.complete && thumb.naturalWidth > 0) {
      mctx.drawImage(thumb, 0, 0, S, S);
      if (wasteLayer) mctx.drawImage(wasteLayer, 0, 0);
    } else {
      mctx.fillStyle = "#26301f";
      mctx.fillRect(0, 0, S, S);
    }
    if (fogOn) {
      for (let ty = 0; ty < w.height; ty++)
        for (let tx = 0; tx < w.width; tx++) {
          const v = vis[ty * w.width + tx];
          if (v === Vis.Visible || (uncharted && v === Vis.Unexplored)) continue;
          mctx.fillStyle = v === Vis.Unexplored ? "rgba(5,7,12,0.96)" : "rgba(5,7,12,0.5)";
          mctx.fillRect(tx * k, ty * k, k + 0.5, k + 0.5);
        }
      if (uncharted) {
        mctx.fillStyle = MINIMAP_SHROUD;
        const r = shroudRects(vis, w.width, w.height, S);
        for (let i = 0; i < r.length; i += 4) mctx.fillRect(r[i]!, r[i + 1]!, r[i + 2]!, r[i + 3]!);
      }
    }
    // resource fields that still hold anything
    mctx.fillStyle = "rgba(255,214,110,0.55)";
    for (let i = 0; i < w.terrain.length; i++) {
      if (w.scrap[i]! <= 0) continue;
      const tx = i % w.width;
      const ty = (i - tx) / w.width;
      if (fogOn && vis[i] === Vis.Unexplored) continue;
      mctx.fillRect(tx * k + k * 0.25, ty * k + k * 0.25, k * 0.5, k * 0.5);
    }
    // wrecks worth salvaging (fog-respecting: the renderer only lists ones we've seen)
    mctx.fillStyle = "#ffd66e";
    for (const r of api.wrecks?.() ?? []) mctx.fillRect(r.x * k - 2, r.y * k - 2, 4, 4);
    const enemyBuildings = fogOn
      ? [...w.fog[PLAYER].known.values()]
      : [...w.buildings.values()].filter((b) => b.faction !== PLAYER);
    for (const kb of enemyBuildings) {
      const size = BUILDINGS[kb.kind].size;
      mctx.fillStyle = MINIMAP_SIDE[kb.faction].building;
      mctx.fillRect(kb.tx * k, kb.ty * k, size * k, size * k);
    }
    for (const b of w.buildings.values()) {
      if (b.faction !== PLAYER) continue;
      const size = BUILDINGS[b.kind].size;
      mctx.fillStyle = MINIMAP_SIDE[b.faction].building;
      mctx.fillRect(b.tx * k, b.ty * k, size * k, size * k);
    }
    const goliaths: Unit[] = [];
    for (const u of w.units.values()) {
      // (in sight, and not a Sniper Team hidden in the woods; an enemy Goliath can't hide)
      if (u.faction !== PLAYER && fogOn && !unitSeenBy(w, PLAYER, u)) continue;
      mctx.fillStyle = minimapDot(u.faction, api.ctrl.spectator ? null : PLAYER);
      if (u.goliath) goliaths.push(u);
      else mctx.fillRect(u.x * k - 2, u.y * k - 2, 4, 4);
    }
    // Goliaths on top: a big outlined diamond (anchored ones ringed with their build ring)
    for (const u of goliaths) {
      const side = MINIMAP_SIDE[u.faction];
      const x = u.x * k;
      const y = u.y * k;
      if (isRooted(u)) {
        mctx.strokeStyle = side.ring;
        mctx.lineWidth = 1;
        mctx.beginPath();
        mctx.arc(x, y, Math.max(7, (GOLIATH.buildRing + GOLIATH.footprint / 2) * k), 0, Math.PI * 2);
        mctx.stroke();
      }
      // (the minimap shows at under half its canvas size on a phone: a unit blip is ~2 px there, this ~8)
      const r = 9;
      mctx.beginPath();
      mctx.moveTo(x, y - r);
      mctx.lineTo(x + r, y);
      mctx.lineTo(x, y + r);
      mctx.lineTo(x - r, y);
      mctx.closePath();
      mctx.fillStyle = side.goliath;
      mctx.fill();
      mctx.strokeStyle = side.goliathRim;
      mctx.lineWidth = 2.5;
      mctx.stroke();
    }
    api.minimapOverlay?.(mctx, k); // Uplinks and supply crates (render/objectives.ts)
    // calldown reticles in flight (public: shown through the fog)
    for (const c of api.calldowns?.() ?? []) {
      mctx.strokeStyle = c.enemy ? "#ff3b30" : "#ffd23f";
      mctx.lineWidth = 2;
      mctx.beginPath();
      mctx.arc(c.x * k, c.y * k, Math.max(4, c.r * k), 0, Math.PI * 2);
      mctx.stroke();
    }
    // alert pings
    const now = api.matchSeconds();
    for (let i = pings.length - 1; i >= 0; i--) {
      const p = pings[i]!;
      const age = now - p.t;
      if (age > 3) {
        pings.splice(i, 1);
        continue;
      }
      if (p.kind === "inbound") {
        // a raid on its way: two amber rings, bigger and slower
        for (const off of [0, 0.6]) {
          const a = Math.max(0, age - off);
          mctx.strokeStyle = `rgba(255,190,70,${Math.max(0, 1 - a / 3)})`;
          mctx.lineWidth = 3;
          mctx.beginPath();
          mctx.arc(p.x * k, p.y * k, 6 + a * 14, 0, Math.PI * 2);
          mctx.stroke();
        }
        continue;
      }
      mctx.strokeStyle = `rgba(255,80,60,${1 - age / 3})`;
      mctx.lineWidth = 2;
      mctx.beginPath();
      mctx.arc(p.x * k, p.y * k, 4 + age * 8, 0, Math.PI * 2);
      mctx.stroke();
    }
    overlay?.(mctx, k, performance.now());
    const quad = api.viewQuad();
    mctx.strokeStyle = "rgba(255,255,255,0.85)";
    mctx.lineWidth = 1.5;
    mctx.beginPath();
    quad.forEach((p, i) => (i === 0 ? mctx.moveTo(p.x * k, p.y * k) : mctx.lineTo(p.x * k, p.y * k)));
    mctx.closePath();
    mctx.stroke();
  }

  return { draw };
}
