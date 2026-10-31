import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocalSide } from "../src/game/controller";
import { wastelandOverlay } from "../src/game/terrain-paint";
import { GOLIATH } from "../src/sim/balance";
import { Vis } from "../src/sim/fog";
import { Terrain } from "../src/sim/types";
import { createWorld, spawnBuilding, spawnUnit } from "../src/sim/world";
import { createMinimap, type MinimapApi, type MinimapPing } from "../src/ui/minimap";

vi.mock("../src/game/assets", () => ({ mapThumbUrl: (id: string) => `thumb:${id}` }));
vi.mock("../src/game/terrain-paint", () => ({ wastelandOverlay: vi.fn(() => ({ waste: true })) }));

/** Record canvas operations with the paint active at each call, without a browser or rasterizer. */
class Paint {
  fillStyle = "";
  strokeStyle = "";
  lineWidth = 1;
  calls: { op: string; args: unknown[]; fill: string; stroke: string; width: number }[] = [];
  record(op: string, ...args: unknown[]) {
    this.calls.push({ op, args, fill: this.fillStyle, stroke: this.strokeStyle, width: this.lineWidth });
  }
  clearRect(...args: number[]) { this.record("clear", ...args); }
  drawImage(...args: unknown[]) { this.record("image", ...args); }
  fillRect(...args: number[]) { this.record("rect", ...args); }
  beginPath() { this.record("begin"); }
  closePath() { this.record("close"); }
  moveTo(...args: number[]) { this.record("move", ...args); }
  lineTo(...args: number[]) { this.record("line", ...args); }
  arc(...args: number[]) { this.record("arc", ...args); }
  fill() { this.record("fill"); }
  stroke() { this.record("stroke"); }
}

class Thumb {
  complete = true;
  naturalWidth = 256;
  src = "";
  constructor() { thumbs.push(this); }
}
let thumbs: Thumb[];

beforeEach(() => {
  thumbs = [];
  vi.stubGlobal("Image", Thumb);
  vi.mocked(wastelandOverlay).mockClear();
});
afterEach(() => {
  setLocalSide("blue");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setup(opts: Partial<MinimapApi> = {}) {
  const paint = new Paint();
  const canvas = Object.assign(new EventTarget(), {
    width: 0, height: 0,
    getContext: () => paint,
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 128, height: 64 }),
    setPointerCapture: vi.fn()
  });
  const w = createWorld(64, 64);
  w.fog.blue.vis.fill(Vis.Visible);
  const api: MinimapApi = {
    world: w,
    ctrl: { showFog: true, spectator: false },
    viewQuad: () => [{ x: 1, y: 2 }, { x: 3, y: 2 }, { x: 3, y: 4 }, { x: 1, y: 4 }],
    centerCamera: vi.fn(), matchSeconds: () => 10,
    ...opts
  };
  const mini = createMinimap(canvas as unknown as HTMLCanvasElement, api);
  const rects = (color: string) => paint.calls.filter((c) => c.op === "rect" && c.fill === color).map((c) => c.args);
  return { ...mini, w: api.world, api, paint, canvas, rects };
}

describe("the minimap canvas", () => {
  it("maps CSS-sized pointer drags to world coordinates and captures the pointer", () => {
    const { canvas, api } = setup();
    const fire = (type: string, clientX: number, clientY: number) => {
      const e = Object.assign(new Event(type, { bubbles: true }), { pointerId: 7, clientX, clientY });
      canvas.dispatchEvent(e);
      return e;
    };
    expect([canvas.width, canvas.height]).toEqual([256, 256]);
    fire("pointermove", 74, 52);
    expect(api.centerCamera).not.toHaveBeenCalled();
    expect(fire("pointerdown", 74, 52).cancelBubble).toBe(true);
    expect(canvas.setPointerCapture).toHaveBeenCalledWith(7);
    expect(api.centerCamera).toHaveBeenLastCalledWith(32, 32);
    fire("pointermove", 138, 84);
    expect(api.centerCamera).toHaveBeenLastCalledWith(64, 64);
    fire("pointerup", 138, 84);
    fire("pointermove", 10, 20);
    expect(api.centerCamera).toHaveBeenCalledTimes(2);
  });

  it("waits for the thumbnail and puts built-in wasteland over it, while generated maps need no overlay", () => {
    const { draw, paint, rects } = setup();
    const thumb = thumbs[0]!;
    thumb.complete = false;
    draw([]);
    expect(rects("#26301f")).toEqual([[0, 0, 256, 256]]);
    expect(paint.calls.filter((c) => c.op === "image")).toEqual([]);
    thumb.complete = true;
    thumb.naturalWidth = 0;
    draw([]);
    expect(paint.calls.filter((c) => c.op === "image")).toEqual([]);
    paint.calls = [];
    thumb.naturalWidth = 256;
    draw([]);
    expect(paint.calls.filter((c) => c.op === "image").map((c) => c.args)).toEqual([
      [thumb, 0, 0, 256, 256], [{ waste: true }, 0, 0]
    ]);
    const w = createWorld(64, 64);
    w.mapId = "random-temperate-k3x9a";
    const generated = setup({ world: w });
    generated.draw([]);
    expect(wastelandOverlay).toHaveBeenCalledTimes(1);
    expect(generated.paint.calls.filter((c) => c.op === "image")).toHaveLength(1);
  });

  it("shrouds resources by exploration and reads live fog toggles", () => {
    const { w, api, draw, paint, rects } = setup();
    w.fog.blue.vis[0] = Vis.Unexplored;
    w.fog.blue.vis[1] = Vis.Explored;
    w.scrap[0] = w.scrap[1] = w.scrap[2] = 10;
    draw([]);
    expect(rects("rgba(5,7,12,0.96)")).toEqual([[0, 0, 4.5, 4.5]]);
    expect(rects("rgba(5,7,12,0.5)")).toEqual([[4, 0, 4.5, 4.5]]);
    expect(rects("rgba(255,214,110,0.55)")).toEqual([[5, 1, 2, 2], [9, 1, 2, 2]]);
    api.ctrl.showFog = false;
    paint.calls = [];
    draw([]);
    expect(rects("rgba(5,7,12,0.96)")).toEqual([]);
    expect(rects("rgba(5,7,12,0.5)")).toEqual([]);
    expect(rects("rgba(255,214,110,0.55)")).toHaveLength(3);
  });

  it("uses opaque whole-pixel Uncharted shroud over fractional tiles", () => {
    const w = createWorld(108, 108);
    w.fog.blue.vis.fill(Vis.Visible);
    w.fog.blue.vis[1] = Vis.Unexplored;
    const { draw, rects } = setup({ world: w, uncharted: true });
    draw([]);
    expect(rects("rgb(5,7,12)")).toEqual([[2, 0, 3, 3]]);
    expect(rects("rgba(5,7,12,0.96)")).toEqual([]);
  });

  it("draws remembered enemy buildings and own buildings, revealing live enemies when fog is off", () => {
    setLocalSide("red");
    const { w, api, draw, paint, rects } = setup();
    spawnBuilding(w, "turret", "red", 2, 3);
    spawnBuilding(w, "turret", "blue", 10, 11);
    w.fog.red.known.set(99, { id: 99, kind: "turret", faction: "green", tx: 20, ty: 21 });
    draw([]);
    expect(rects("#ff4a3a")).toEqual([[8, 12, 4, 4]]);
    expect(rects("#2fbf55")).toEqual([[80, 84, 4, 4]]);
    expect(rects("#3d8bff")).toEqual([]);
    api.ctrl.showFog = false;
    paint.calls = [];
    draw([]);
    expect(rects("#3d8bff")).toEqual([[40, 44, 4, 4]]);
    expect(rects("#2fbf55")).toEqual([]);
  });

  it("hides unseen enemies and concealed snipers but always marks Goliaths above ordinary units", () => {
    const { w, draw, paint, rects } = setup();
    w.tick = 100;
    spawnUnit(w, "stinger", "red", 40, 40);
    w.fog.blue.vis[40 * w.width + 40] = Vis.Unexplored;
    spawnUnit(w, "sniper", "red", 30, 30);
    w.terrain[30 * w.width + 30] = Terrain.Forest;
    const g = spawnUnit(w, "goliath", "red", 50, 50);
    g.goliath!.mode = "anchored";
    w.fog.blue.vis[50 * w.width + 50] = Vis.Unexplored;
    spawnUnit(w, "stinger", "blue", 3, 4);
    draw([]);
    expect(rects("#ffb0a0")).toEqual([]);
    expect(rects("#9fd0ff")).toEqual([[10, 14, 4, 4]]);
    expect(paint.calls.find((c) => c.op === "arc")?.args).toEqual([
      200, 200, (GOLIATH.buildRing + GOLIATH.footprint / 2) * 4, 0, Math.PI * 2
    ]);
    expect(paint.calls.find((c) => c.op === "fill")?.fill).toBe("#ff7a66");
    expect(paint.calls.find((c) => c.op === "stroke")?.stroke).toBe("rgba(255,140,120,0.6)");
    expect(paint.calls.findIndex((c) => c.op === "fill")).toBeGreaterThan(paint.calls.findIndex((c) => c.fill === "#9fd0ff"));
  });

  it("keeps faction tints for all four sides and switches to blue's spectator tints", () => {
    setLocalSide("purple");
    const { w, api, draw, paint, rects } = setup();
    api.ctrl.showFog = false;
    for (const f of ["blue", "red", "green", "purple"] as const) spawnUnit(w, "stinger", f, 10, 10);
    draw([]);
    for (const color of ["#78bcff", "#ffb0a0", "#8ee6a4", "#e3ccff"]) expect(rects(color)).toHaveLength(1);
    api.ctrl.spectator = true;
    paint.calls = [];
    draw([]);
    for (const color of ["#9fd0ff", "#ffb0a0", "#8ee6a4", "#c9a8ff"]) expect(rects(color)).toHaveLength(1);
  });

  it("layers wrecks, units, objectives, calldowns, pings, Last Stand and the camera outline in order", () => {
    vi.spyOn(performance, "now").mockReturnValue(1234);
    const { w, draw, paint } = setup({
      wrecks: () => [{ x: 1, y: 1 }],
      calldowns: () => [{ x: 6, y: 6, r: 2, enemy: true }],
      minimapOverlay: (ctx, k) => { ctx.fillStyle = "objectives"; ctx.fillRect(k, 0, 1, 1); }
    });
    spawnUnit(w, "stinger", "blue", 2, 2);
    const overlay = vi.fn((ctx: CanvasRenderingContext2D, k: number, now: number) => {
      ctx.fillStyle = "survival";
      ctx.fillRect(k, now, 1, 1);
    });
    draw([{ x: 7, y: 7, t: 9 }], overlay);
    expect(overlay).toHaveBeenCalledWith(paint, 4, 1234);
    expect(paint.calls.filter((c) => ["rect", "stroke"].includes(c.op)).map((c) => c.op === "rect" ? c.fill : c.stroke)).toEqual([
      "#ffd66e", "#9fd0ff", "objectives", "#ff3b30", `rgba(255,80,60,${1 - 1 / 3})`, "survival", "rgba(255,255,255,0.85)"
    ]);
    expect(paint.calls.filter((c) => c.op === "move").at(-1)?.args).toEqual([4, 8]);
  });

  it("expires pings only after three match seconds and animates both inbound rings on match time", () => {
    let seconds = 10;
    const { draw, paint } = setup({ matchSeconds: () => seconds });
    const hit = { x: 1, y: 1, t: 7 };
    const inbound: MinimapPing = { x: 2, y: 2, t: 9, kind: "inbound" };
    const pings: MinimapPing[] = [{ x: 3, y: 3, t: 6.9 }, hit, inbound];
    draw(pings);
    expect(pings).toEqual([hit, inbound]);
    const arcs = () => paint.calls.filter((c) => c.op === "arc").map((c) => c.args.slice(0, 3));
    const first = arcs();
    expect(first).toEqual([[8, 8, 20], [8, 8, expect.closeTo(11.6)], [4, 4, 28]]);
    paint.calls = [];
    draw(pings);
    expect(arcs()).toEqual(first);
    seconds = 12.01;
    paint.calls = [];
    draw(pings);
    expect(pings).toEqual([]);
    expect(arcs()).toEqual([]);
  });
});
