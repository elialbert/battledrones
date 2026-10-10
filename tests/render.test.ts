import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EntityRenderer } from "../src/game/render/entities";
import { Canopy } from "../src/game/three/canopy";
import type { SquadRig } from "../src/game/three/infantry";
import { UNITS } from "../src/sim/balance";
import { step } from "../src/sim/sim";
import type { Faction, FxEvent, Unit, World } from "../src/sim/types";
import { createWorld, spawnUnit } from "../src/sim/world";

// The entity renderer headless: a real scene graph, a stubbed view (flat ground), no WebGL. Its light
// pools want a canvas texture: a do-nothing canvas stands in for the DOM.
const noop: unknown = new Proxy(function () {}, { get: (_t, k) => (k === Symbol.toPrimitive ? () => 0 : noop), apply: () => noop });
(globalThis as { document?: unknown }).document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => noop, style: {} }) };

const FRAME = 1000 / 60;

interface Rig {
  r: EntityRenderer;
  w: World;
  /** Effect calls by name. */
  fx: Map<string, number>;
  /** The squads the trees were last thinned over (x, y pairs). */
  thinned: number[];
  sync: (frames?: number) => void;
}

/** A renderer for blue that sees only x < 20 (and draws enemy units it's shown by `shown`). */
function setup(o: { shown?: (u: Unit) => boolean; friendly?: (f: string) => boolean } = {}): Rig {
  const w = createWorld(64, 64);
  w.tick = 50;
  const fxCalls = new Map<string, number>();
  const fx = new Proxy({} as Record<string | symbol, unknown>, {
    get: (t, k) => (k in t ? t[k] : () => fxCalls.set(String(k), (fxCalls.get(String(k)) ?? 0) + 1)),
    set: (t, k, v) => ((t[k] = v), true)
  });
  const out: Rig = { r: null!, w, fx: fxCalls, thinned: [], sync: () => {} };
  const view = {
    scene: new THREE.Scene(),
    terrain: {
      groundAt: () => 0,
      surfaceAt: () => 0,
      heightAt: () => 0,
      thinCanopy: (pts: ArrayLike<number>, n: number) => (out.thinned = Array.from(pts).slice(0, n * 2))
    },
    tweens: { add: () => {} },
    rig: { zoom: 45, pitchFor: () => 1 }
  };
  const visibleAt = (x: number) => x < 20;
  const r = new EntityRenderer(
    view as never,
    w,
    fx as never,
    visibleAt,
    () => false,
    o.friendly ?? ((f) => f === "blue"),
    o.shown ?? ((u) => visibleAt(u.x))
  );
  const prev = new Map<number, { x: number; y: number }>();
  out.r = r;
  out.sync = (frames = 1) => {
    for (let i = 0; i < frames; i++) r.sync(1, prev, FRAME);
  };
  return out;
}

const views = (r: EntityRenderer) => (r as unknown as { views: Map<number, { squad: SquadRig | null; face: number; condor: { riders: Map<number, unknown> } | null }> }).views;
const rigOf = (r: EntityRenderer, id: number) => views(r).get(id)!.squad!;
/** Each robot's world position on the ground (x, z). */
function robots(rig: SquadRig): [number, number][] {
  rig.root.updateMatrixWorld(true);
  return rig.bots.map((b) => {
    const p = b.b[0]!.getWorldPosition(new THREE.Vector3());
    return [p.x, p.z];
  });
}

afterEach(() => vi.restoreAllMocks());

describe("squads out of sight (R8)", () => {
  it("a squad trained in the fog is simply standing there when first seen, not popping in", () => {
    const { r, w, sync } = setup();
    const u = spawnUnit(w, "trooper", "red", 40, 40);
    sync(120);
    u.x = u.y = 10;
    sync();
    const rig = rigOf(r, u.id);
    expect(rig.bots.map((b) => b.pop)).toEqual([1, 1, 1, 1, 1]);
    for (const b of rig.bots) expect(b.b[0]!.scale.x).toBeGreaterThan(1);
  });

  it("robots dropped in the fog by a Condor never seen land at once, not streaking in from the map's corner", () => {
    const { r, w, fx, sync } = setup();
    const c = spawnUnit(w, "condor", "red", 45, 30);
    sync();
    const s = spawnUnit(w, "rocket-squad", "red", 45, 31);
    r.onFx({ type: "disembark", faction: "red", carrierId: c.id, unitIds: [s.id], x: 45, y: 31, bailout: false } as FxEvent);
    sync(30);
    s.x = s.y = 12;
    sync();
    const rig = rigOf(r, s.id);
    expect(rig.bots.every((b) => !b.trip)).toBe(true);
    for (const [x, z] of robots(rig)) expect(Math.hypot(x - 12, z - 12)).toBeLessThan(0.5);
    expect(fx.get("landing") ?? 0).toBe(0);
  });

  it("a squad that loses robots out of sight shows only its survivors, and no sparks from the fog", () => {
    const { r, w, fx, sync } = setup();
    const u = spawnUnit(w, "trooper", "red", 10, 10);
    sync(10);
    u.x = 40;
    sync();
    u.hp = UNITS.trooper.hp * 0.4; // 2 of 5 standing
    sync(30);
    u.x = 10;
    sync(60);
    const rig = rigOf(r, u.id);
    expect(rig.standing().length).toBe(2);
    expect(fx.get("robotDown") ?? 0).toBe(0);
  });

  it("a Sniper Team hidden in the woods in our sight settles without a spark", () => {
    const { r, w, fx, sync } = setup({ shown: (u) => u.kind !== "sniper" && u.x < 20 });
    const u = spawnUnit(w, "sniper", "red", 10, 10);
    sync(5);
    u.hp = UNITS.sniper.hp * 0.4;
    sync(200);
    expect(rigOf(r, u.id).standing().length).toBe(1);
    expect(fx.get("robotDown") ?? 0).toBe(0);
  });
});

describe("shots from units not on show (R9)", () => {
  it("muzzle() gives no point for a unit out of sight, so the shot leaves the sim's position", () => {
    const { r, w, sync } = setup();
    const a = spawnUnit(w, "sniper", "red", 40, 10);
    const b = spawnUnit(w, "stinger", "red", 41, 10);
    const c = spawnUnit(w, "sniper", "red", 10, 10);
    sync();
    expect(r.muzzle(a.id)).toBeNull();
    expect(r.muzzle(b.id)).toBeNull();
    const m = r.muzzle(c.id)!;
    expect(Math.hypot(m.x - 10, m.y - 10)).toBeLessThan(0.5);
  });
});

describe("a squad turning to fire (R10)", () => {
  it("wheels its formation round smoothly instead of every robot jumping on the shot", () => {
    const { r, w, sync } = setup({ friendly: () => true });
    const s = spawnUnit(w, "trooper", "blue", 16.5, 16.5);
    s.facing = 0;
    sync(30);
    const e = spawnUnit(w, "stinger", "red", 16.5, 19);
    e.hp = 1e9;
    let jump = -1;
    for (let t = 0; t < 200 && jump < 0; t++) {
      const fired = s.firedTick;
      step(w, []);
      const before = robots(rigOf(r, s.id));
      if (s.firedTick !== fired)
        for (const ev of w.fx) if (ev.type === "shot" && ev.sourceId === s.id) r.fired(ev.sourceId, Math.atan2(ev.tx - ev.x, -(ev.ty - ev.y)));
      sync();
      if (s.firedTick !== fired) jump = Math.max(...robots(rigOf(r, s.id)).map(([x, z], i) => Math.hypot(x - before[i]![0], z - before[i]![1])));
    }
    expect(jump).toBeGreaterThan(0);
    expect(jump).toBeLessThan(0.15);
    // …and it does come round to its new facing
    sync(60);
    expect(Math.abs(views(r).get(s.id)!.face - s.facing)).toBeLessThan(0.02);
  });
});

describe("Condor passengers (L3)", () => {
  function loaded(rig: Rig, faction: Faction, x: number) {
    const c = spawnUnit(rig.w, "condor", faction, x, 10);
    const s = spawnUnit(rig.w, "trooper", faction, x, 10);
    rig.w.units.delete(s.id);
    c.passengers = [s];
    return c;
  }

  it("are seated in our own Condors, but an enemy Condor's bay shows empty", () => {
    const rig = setup();
    const ours = loaded(rig, "blue", 8);
    const theirs = loaded(rig, "red", 12);
    rig.sync(3);
    expect(views(rig.r).get(ours.id)!.condor!.riders.size).toBe(1);
    expect(views(rig.r).get(theirs.id)!.condor!.riders.size).toBe(0);
  });

  it("are all shown to a spectator watching with the fog off", () => {
    const rig = setup({ friendly: () => true });
    const theirs = loaded(rig, "red", 12);
    rig.sync(3);
    expect(views(rig.r).get(theirs.id)!.condor!.riders.size).toBe(1);
  });
});

describe("GPU resources of views that go (L11)", () => {
  it("frees each squad rig's skeleton (its bone texture) and a Condor's own material", () => {
    const disposed = vi.spyOn(THREE.Skeleton.prototype, "dispose");
    const { r, w, sync } = setup();
    const hidden = spawnUnit(w, "trooper", "red", 40, 10);
    const dead = spawnUnit(w, "rocket-squad", "blue", 10, 10);
    const c = spawnUnit(w, "condor", "blue", 12, 12);
    const p = spawnUnit(w, "sniper", "blue", 12, 12);
    w.units.delete(p.id);
    c.passengers = [p];
    sync(3);
    const pool = (views(r).get(c.id)!.condor as unknown as { poolMat: THREE.Material }).poolMat;
    const poolGone = vi.spyOn(pool, "dispose");
    w.units.delete(hidden.id);
    sync();
    expect(disposed).toHaveBeenCalledTimes(1);
    // wiped out on show: its robots fall and sink first, then the rig goes
    w.units.delete(dead.id);
    sync();
    expect(disposed).toHaveBeenCalledTimes(1);
    sync(300);
    expect(disposed).toHaveBeenCalledTimes(2);
    // a Condor shot down with a squad aboard: its pool light and its rider's rig
    w.units.delete(c.id);
    sync();
    expect(poolGone).toHaveBeenCalled();
    expect(disposed).toHaveBeenCalledTimes(3);
  });
});

describe("woods thinned over squads (Q2)", () => {
  it("thins the trees over squads on show only: never over an enemy hidden from us", () => {
    const rig = setup({ shown: (u) => u.kind !== "sniper" && u.x < 20 });
    spawnUnit(rig.w, "trooper", "blue", 30, 30); // ours: always shown
    spawnUnit(rig.w, "sniper", "red", 10, 12); // concealed in woods, its tile in sight
    spawnUnit(rig.w, "trooper", "red", 40, 40); // in the fog
    spawnUnit(rig.w, "trooper", "red", 11, 15); // in sight
    rig.sync();
    expect(rig.thinned).toEqual([30, 30, 11, 15]);
  });

  /** One tree per spot, as a single instanced mesh. */
  function woods(spots: { x: number; y: number; s: number }[]) {
    const mesh = new THREE.InstancedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial(), spots.length);
    const canopy = new Canopy(32, 32, [{ mesh, spots }]);
    return { canopy, attr: mesh.geometry.getAttribute("canopy") as THREE.InstancedBufferAttribute };
  }

  it("clears the canopy over and in front of a squad (toward the camera), leaves the rest, and lets it grow back", () => {
    // a squad at (10, 10); trees on it, south of it (in front), the same distance north (behind), and far off
    const { canopy, attr } = woods([
      { x: 10, y: 10, s: 1 },
      { x: 10, y: 10.9, s: 1 },
      { x: 10, y: 9.1, s: 1 },
      { x: 20, y: 20, s: 1 }
    ]);
    const cot = 0.7;
    for (let i = 0; i < 30; i++) canopy.thin([10, 10], 1, cot, FRAME);
    const f = Array.from(canopy.fade);
    expect(f[0]).toBeGreaterThan(0.99);
    expect(f[1]).toBeGreaterThan(0.99);
    expect(f[2]).toBeLessThan(f[1]! - 0.3);
    expect(f[3]).toBe(0);
    expect(attr.getX(1)).toBe(f[1]);
    // the squad moves on: the woods grow back
    for (let i = 0; i < 120; i++) canopy.thin([], 0, cot, FRAME);
    expect(Array.from(canopy.fade)).toEqual([0, 0, 0, 0]);
    expect((canopy as unknown as { active: number[] }).active).toEqual([]);
  });
});
