import { afterEach, describe, expect, it, vi } from "vitest";
import { Controller, setLocalSide } from "../src/game/controller";
import { OverlayRenderer } from "../src/game/render/overlays";
import type { EntityRenderer } from "../src/game/render/entities";
import { restoreWorld } from "../src/game/restore";
import { BUILDINGS, ECONOMY, GOLIATH, TICK_RATE, UNITS } from "../src/sim/balance";
import { buildingCenter, createWorld, spawnBuilding, spawnUnit } from "../src/sim/world";

afterEach(() => { setLocalSide("blue"); vi.restoreAllMocks(); });

function setup(side: "blue" | "red" = "blue") {
  setLocalSide(side);
  const world = createWorld(64, 64);
  const ctrl = new Controller(world);
  const ground = {
    fillStyle: vi.fn().mockReturnThis(), fillEllipse: vi.fn().mockReturnThis(),
    lineStyle: vi.fn().mockReturnThis(), strokeEllipse: vi.fn().mockReturnThis(),
    lineBetween: vi.fn().mockReturnThis(), strokeCircle: vi.fn().mockReturnThis(),
    fillCircle: vi.fn().mockReturnThis(), strokeRect: vi.fn().mockReturnThis(), px: () => 0.1
  };
  const ctx = { beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), closePath: vi.fn(), fill: vi.fn(), stroke: vi.fn(),
    fillRect: vi.fn(), strokeRect: vi.fn(), setLineDash: vi.fn(), lineDashOffset: 0 };
  const screen = { begin: vi.fn(() => ctx), drawLabels: vi.fn() };
  const rig = { project: vi.fn((x: number, y: number, h: number) => ({ x: x * 10 + 0.23, y: y * 10 - h * 10 + 0.27, behind: x < 0 })), worldPerPx: () => 0.1 };
  const hidden = new Set<number>();
  const known = new Set<number>();
  const ranks: Array<{ x: number; y: number; h: number; rank: number; pop: number }> = [];
  const entities = {
    pos: vi.fn((id: number) => {
      const u = world.units.get(id);
      const b = world.buildings.get(id);
      const c = b ? buildingCenter(b) : null;
      const x = u?.x ?? c?.x; const y = u?.y ?? c?.y;
      return x === undefined || y === undefined ? null : { x, y, gx: x, gy: y, h: 2, top: 3 };
    }),
    isShown: (id: number) => !hidden.has(id),
    shownHp: (id: number) => known.has(id) ? null : world.buildings.get(id)!.hp / BUILDINGS[world.buildings.get(id)!.kind].hp,
    ranked: function* () { yield* ranks; },
    goliathMarks: vi.fn()
  } satisfies Pick<EntityRenderer, "pos" | "isShown" | "shownHp" | "ranked" | "goliathMarks">;
  const juice = { healthBar: vi.fn(), meter: vi.fn() };
  const over = {};
  const renderer = new OverlayRenderer({ ground, over, screen, rig, dpr: 2 } as never, world, ctrl, entities, juice);
  return { world, ctrl, ground, over, ctx, screen, rig, hidden, known, ranks, entities, juice, renderer };
}

describe("world and screen overlays", () => {
  it("deduplicates shared move waypoints, stops lines at the ring and reuses scratch objects", () => {
    const f = setup();
    const a = spawnUnit(f.world, "stinger", "blue", 5, 10);
    const b = spawnUnit(f.world, "stinger", "blue", 6, 10);
    a.order = b.order = { type: "move", x: 20, y: 10 };
    f.ctrl.selectedUnits = new Set([a.id, b.id]);
    f.renderer.drawWorld();
    expect(f.ground.strokeCircle).toHaveBeenCalledTimes(1);
    expect(f.ground.strokeCircle.mock.calls[0]?.slice(0, 2)).toEqual([20, 10]);
    expect(f.ground.strokeCircle.mock.calls[0]?.[2]).toBeCloseTo(0.7);
    expect(f.ground.lineBetween.mock.calls[0]).toEqual([5, 10, 19.3, 10]);
    expect(f.ground.lineBetween.mock.calls[1]).toEqual([6, 10, 19.3, 10]);
    expect(f.entities.goliathMarks).toHaveBeenCalledWith(f.over, f.ctrl.selectedUnits);
    const scratch = (f.renderer as unknown as { waypoints: object[] }).waypoints;
    const first = scratch[0];
    f.ground.strokeCircle.mockClear();
    a.order = b.order = { type: "attackMove", x: 25, y: 10 };
    f.renderer.drawWorld();
    expect((f.renderer as unknown as { waypoints: object[] }).waypoints).toBe(scratch);
    expect(scratch[0]).toBe(first);
    expect(f.ground.strokeCircle).toHaveBeenCalledTimes(1);
    f.ctrl.selectedUnits.clear(); f.ground.strokeCircle.mockClear(); f.renderer.drawWorld();
    expect(f.ground.strokeCircle).not.toHaveBeenCalled();
  });

  it("rings aircraft at altitude, colors enemy selection and hides attack lines to unseen targets", () => {
    const f = setup();
    const air = spawnUnit(f.world, "wasp", "blue", 5, 5);
    const enemy = spawnUnit(f.world, "stinger", "red", 15, 5);
    air.order = { type: "attack", targetId: enemy.id };
    f.ctrl.selectedUnits = new Set([air.id, enemy.id]);
    f.hidden.add(enemy.id);
    f.renderer.drawWorld();
    expect(f.ground.strokeEllipse.mock.calls[0]?.[4]).toBe(1.9);
    expect(f.ground.lineStyle).toHaveBeenCalledWith(2.5, 0xff7a6a, 1);
    expect(f.ground.lineBetween).not.toHaveBeenCalled();
    f.hidden.clear(); f.renderer.drawWorld();
    expect(f.ground.lineStyle).toHaveBeenCalledWith(1.2, 0xff5a4a, 0.35, 0);
    expect(f.ground.lineBetween).toHaveBeenCalledTimes(1);
  });

  it("uses in-flight rally previews over the stored rally and retains building ranges", () => {
    const f = setup();
    const b = spawnBuilding(f.world, "turret", "blue", 10, 10);
    b.rally = { x: 20, y: 20 };
    f.ctrl.selectedBuilding = b.id;
    f.ctrl.trackInFlight();
    f.ctrl.enqueue({ type: "rally", faction: "blue", buildingId: b.id, x: 25, y: 30 });
    f.ctrl.drainCommands();
    f.renderer.drawWorld();
    const c = buildingCenter(b);
    expect(f.ground.strokeRect).toHaveBeenCalledWith(10.03, 10.03, BUILDINGS.turret.size - 0.06, BUILDINGS.turret.size - 0.06);
    expect(f.ground.strokeCircle).toHaveBeenCalledWith(c.x, c.y, BUILDINGS.turret.range + BUILDINGS.turret.size / 2);
    expect(f.ground.lineBetween).toHaveBeenCalledWith(c.x, c.y, 25, 30);
  });

  it("never draws live HP for hidden units or remembered buildings; only enemy Gantry production is public", () => {
    const f = setup();
    const hidden = spawnUnit(f.world, "stinger", "red", 10, 10); hidden.hp /= 2; f.hidden.add(hidden.id);
    const remembered = spawnBuilding(f.world, "fab-plant", "red", 10, 15); remembered.hp /= 2; f.known.add(remembered.id);
    const enemy = spawnBuilding(f.world, "fab-plant", "red", 15, 15); enemy.queue.push({ kind: "stinger", remaining: 5 });
    const gantry = spawnBuilding(f.world, "gantry", "red", 20, 20); gantry.queue.push({ kind: "goliath", remaining: 10 });
    const own = spawnBuilding(f.world, "fab-plant", "blue", 5, 5); own.queue.push({ kind: "stinger", remaining: 20 });
    f.renderer.drawScreen(null);
    expect(f.juice.healthBar).not.toHaveBeenCalled();
    expect(f.juice.meter).toHaveBeenCalledTimes(2);
    expect(f.juice.meter.mock.calls.map((c) => c[6])).toEqual(["#ff7a6a", "#6eb0ff"]);
    expect(f.juice.meter.mock.calls[0]?.[5]).toBe(1 - 10 / (UNITS.goliath.buildTime * TICK_RATE));
  });

  it("draws selected own harvester load and own Goliath training from the red seat", () => {
    const f = setup("red");
    const h = spawnUnit(f.world, "harvester", "red", 10, 10); h.cargo = ECONOMY.harvesterCapacity / 2;
    const g = spawnUnit(f.world, "goliath", "red", 15, 15);
    g.goliath!.mode = "anchored";
    g.goliath!.queue.push({ kind: "trooper", remaining: UNITS.trooper.buildTime * TICK_RATE / 2 });
    const enemy = spawnUnit(f.world, "goliath", "blue", 20, 20);
    enemy.goliath!.queue.push({ kind: "trooper", remaining: 10 });
    f.ctrl.selectedUnits.add(h.id);
    f.renderer.drawScreen(null);
    expect(f.juice.healthBar.mock.calls[0]?.[6]).toBe(true);
    expect(f.juice.meter.mock.calls.map((c) => [c[5], c[6]])).toEqual([[0.5, "#ffd66e"], [0.5, "#ff7a6a"]]);
  });

  it("notches Goliath health bars and reuses the down-state buffer without leaking the previous unit's state", () => {
    const f = setup();
    const a = spawnUnit(f.world, "goliath", "blue", 10, 10); a.hp /= 2;
    const b = spawnUnit(f.world, "goliath", "red", 20, 20); b.hp /= 2;
    a.goliath!.weapons.mortars.online = false;
    const downs: boolean[][] = [];
    const refs: unknown[] = [];
    f.juice.healthBar.mockImplementation((...args: unknown[]) => { refs.push(args[9]); downs.push([...(args[9] as boolean[])]); });
    f.renderer.drawScreen(null);
    expect(downs).toEqual([[true, false, false], [false, false, false]]);
    expect(refs[0]).toBe(refs[1]);
    expect(f.juice.healthBar.mock.calls[0]?.[8]).toEqual([GOLIATH.weapons.mortars.lostBelow, GOLIATH.weapons.laser.lostBelow, GOLIATH.weapons.cannons.lostBelow]);
  });

  it("snaps chevrons and box edges to DPR, batches paths, and resets marching dashes", () => {
    const f = setup();
    vi.spyOn(performance, "now").mockReturnValue(80);
    f.ranks.push({ x: 5, y: 5, h: 1, rank: 2, pop: 0.5 });
    f.renderer.drawScreen({ x0: 20.3, y0: 30.3, x1: 10.1, y1: 5.1 });
    expect(f.ctx.beginPath).toHaveBeenCalledTimes(2); // one shadow path and one gold path
    expect(f.ctx.fillRect).toHaveBeenCalledWith(10.25, 5.25, 10, 25);
    expect(f.ctx.setLineDash.mock.calls).toEqual([[[8, 2]], [[6, 4]], [[]]]);
    expect(f.ctx.lineDashOffset).toBe(0);
    expect(f.ctx.moveTo.mock.calls[0]?.[0]).toBeCloseTo(35.8);
    expect(f.ctx.moveTo.mock.calls[0]?.[1]).toBeCloseTo(18.4);
    expect(f.ctx.moveTo.mock.calls[1]?.[0]).toBeCloseTo(46.2);
    expect(f.ctx.moveTo.mock.calls[1]?.[1]).toBeCloseTo(17.6); // promotion pop scales the last chevron
    const scratch = (f.renderer as unknown as { chevrons: number[] }).chevrons;
    f.ranks.length = 0; f.ctx.beginPath.mockClear(); f.ctx.setLineDash.mockClear();
    f.renderer.drawScreen(null);
    expect((f.renderer as unknown as { chevrons: number[] }).chevrons).toBe(scratch);
    expect(f.ctx.beginPath).not.toHaveBeenCalled();
    expect(f.ctx.setLineDash).not.toHaveBeenCalled();
    expect(f.screen.drawLabels).not.toHaveBeenCalled(); // GameScene draws labels after these marks
  });

  it("reads replacement collections after replay restore", () => {
    const f = setup();
    const old = spawnUnit(f.world, "stinger", "blue", 5, 5); old.hp /= 2;
    const saved = createWorld(64, 64);
    const replacement = spawnUnit(saved, "harvester", "blue", 25, 30); replacement.hp /= 2;
    restoreWorld(f.world, saved);
    f.renderer.drawScreen(null);
    expect(f.juice.healthBar).toHaveBeenCalledTimes(1);
    expect(f.rig.project).toHaveBeenCalledWith(25, 30, 3.12);
  });
});
