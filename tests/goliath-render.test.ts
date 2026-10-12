import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { finaleBanner } from "../src/game/finale";
import { EntityRenderer } from "../src/game/render/entities";
import type { GoliathView } from "../src/game/render/goliath";
import { clearMat, modelMat } from "../src/game/three/materials";
import { GOLIATH, TICK_RATE, UNITS } from "../src/sim/balance";
import type { Building, FxEvent, Unit, World } from "../src/sim/types";
import { createWorld, spawnBuilding, spawnUnit } from "../src/sim/world";

// The Goliath and Gantry views headless: a real scene graph, a stubbed view (flat ground), no WebGL
// (as in render.test.ts). Effects are counted by name.
const noop: unknown = new Proxy(function () {}, { get: (_t, k) => (k === Symbol.toPrimitive ? () => 0 : noop), apply: () => noop });
(globalThis as { document?: unknown }).document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => noop, style: {} }) };

const FRAME = 1000 / 60;

interface Rig {
  r: EntityRenderer;
  w: World;
  fx: Map<string, number>;
  sync: (frames?: number, alpha?: number) => void;
}

/** A renderer for blue that sees only x < 20, and draws enemy units it's shown by `shown` (default: tile in sight). */
function setup(o: { shown?: (u: Unit) => boolean } = {}): Rig {
  const w = createWorld(64, 64);
  w.tick = 50;
  const fxCalls = new Map<string, number>();
  const fx = new Proxy({} as Record<string | symbol, unknown>, {
    get: (t, k) => (k in t ? t[k] : k === "liquid" ? () => false : () => fxCalls.set(String(k), (fxCalls.get(String(k)) ?? 0) + 1)),
    set: (t, k, v) => ((t[k] = v), true)
  });
  const view = {
    scene: new THREE.Scene(),
    terrain: { groundAt: () => 0, surfaceAt: () => 0, heightAt: () => 0, thinCanopy: () => {} },
    tweens: { add: () => {}, after: () => {} },
    rig: { zoom: 45, pitchFor: () => 1, onScreen: () => true, shake: () => fxCalls.set("shake", (fxCalls.get("shake") ?? 0) + 1) }
  };
  const visibleAt = (x: number) => x < 20;
  const r = new EntityRenderer(view as never, w, fx as never, visibleAt, () => false, (f) => f === "blue", o.shown ?? ((u) => visibleAt(u.x)));
  const prev = new Map<number, { x: number; y: number }>();
  return {
    r, w, fx: fxCalls,
    sync: (frames = 1, alpha = 1) => {
      for (let i = 0; i < frames; i++) r.sync(alpha, prev, FRAME);
    }
  };
}

const views = (r: EntityRenderer) => (r as unknown as { views: Map<number, { goliath: GoliathView | null; m: { root: THREE.Object3D; parts: Record<string, THREE.Object3D> } }> }).views;
const toppling = (r: EntityRenderer) => (r as unknown as { toppling: GoliathView[] }).toppling;
/** Every model mesh under `o`. */
function meshes(o: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  o.traverse((m) => {
    if ((m as THREE.Mesh).isMesh && m.userData.model) out.push(m as THREE.Mesh);
  });
  return out;
}

describe("always visible: the Goliath and the Gantry", () => {
  it("draws an enemy Goliath and Gantry deep in the fog, live and clear of it (fog-free twins of the model materials)", () => {
    const { r, w, sync } = setup({ shown: (u) => u.kind === "goliath" || u.x < 20 });
    const g = spawnUnit(w, "goliath", "red", 50, 50);
    const b = spawnBuilding(w, "gantry", "red", 40, 40);
    sync(2);
    const gv = views(r).get(g.id)!;
    const bv = views(r).get(b.id)!;
    expect(gv.m.root.visible).toBe(true);
    expect(bv.m.root.visible).toBe(true);
    for (const m of [...meshes(gv.m.root), ...meshes(bv.m.root)]) {
      expect(m.userData.clear).toBe(true);
      expect(m.material).toBe(clearMat("normal"));
    }
    // a hit flash keeps to the twins
    r.hitFlash(g.id);
    sync();
    expect(meshes(gv.m.root)[0]!.material).toBe(clearMat("flash"));
    expect(clearMat("flash")).not.toBe(modelMat("flash"));
    // (same program as the plain material: only a uniform differs)
    expect(clearMat("normal").customProgramCacheKey()).toBe(modelMat("normal").customProgramCacheKey());
  });

  it("an enemy Gantry destroyed out of sight goes at once, never left standing as a remembered ghost", () => {
    const { r, w, sync, fx } = setup();
    const b = spawnBuilding(w, "gantry", "red", 40, 40);
    sync(2);
    w.buildings.delete(b.id);
    sync();
    expect(views(r).has(b.id)).toBe(false);
    expect(fx.get("rubble")).toBe(1);
  });

  it("an enemy Gantry's health is shown live (it is never only remembered)", () => {
    const { r, w, sync } = setup();
    const b = spawnBuilding(w, "gantry", "red", 40, 40);
    b.hp = BUILDINGS_GANTRY_HP / 2;
    sync();
    expect(r.shownHp(b.id)).toBeCloseTo(0.5);
  });
});

const BUILDINGS_GANTRY_HP = 1200;

describe("a Goliath's guns", () => {
  it("fires each weapon from its own muzzle: mortars from the shoulder pods, the laser from the eye, cannons from the arms", () => {
    const { r, w, sync } = setup();
    const g = spawnUnit(w, "goliath", "blue", 10, 10);
    g.facing = 0;
    sync(3);
    const at = (fx: "shell" | "laser" | "heavy-cannon" | "mg") => {
      r.fired(g.id, 0, fx);
      return r.muzzle(g.id, fx)!;
    };
    const shell = at("shell");
    const shell2 = at("shell");
    const eye = at("laser");
    const cannon = at("heavy-cannon");
    const cannon2 = at("heavy-cannon");
    const mg = at("mg");
    // the pods and the eye sit high, the guns lower, and the two pods (and the two arms) take turns
    expect(shell.h).toBeGreaterThan(2);
    expect(eye.h).toBeGreaterThan(2);
    expect(cannon.h).toBeLessThan(eye.h);
    expect(mg.h).toBeLessThan(eye.h);
    expect(Math.sign(shell.x - 10)).toBe(-Math.sign(shell2.x - 10));
    expect(Math.sign(cannon.x - 10)).toBe(-Math.sign(cannon2.x - 10));
    // facing north, the cannons and the eye point ahead (north: -y)
    expect(cannon.y).toBeLessThan(9.4);
    expect(eye.y).toBeLessThan(10);
  });
});

describe("anchoring", () => {
  it("lowers the body and drives the spikes from the sim's own timer, and they bite with a thump and a shake", () => {
    const { r, w, sync, fx } = setup();
    const g = spawnUnit(w, "goliath", "blue", 10, 10);
    sync(2);
    const gv = views(r).get(g.id)!.goliath!;
    const pelvis = gv.rig.j.pelvis;
    const stand = pelvis.position.y;
    const total = Math.round(GOLIATH.anchorTime * TICK_RATE);
    g.goliath!.mode = "anchoring";
    for (let t = total; t >= 0; t -= 2) {
      g.goliath!.modeTicks = t;
      sync(12);
    }
    g.goliath!.mode = "anchored";
    g.goliath!.modeTicks = 0;
    sync(60);
    expect(pelvis.position.y).toBeLessThan(stand - 0.25);
    expect(gv.rig.j.rodFL.position.y).toBeLessThan(-0.25);
    expect(fx.get("sound")).toBeGreaterThan(0);
    expect(fx.get("shake")).toBe(1);
  });
});

describe("a Goliath's death", () => {
  it("topples, slams down and sinks away, then its view goes", () => {
    const { r, w, sync, fx } = setup();
    const g = spawnUnit(w, "goliath", "blue", 10, 10);
    sync(2);
    const gv = views(r).get(g.id)!.goliath!;
    w.units.delete(g.id);
    sync();
    expect(toppling(r)).toHaveLength(1);
    sync(Math.round(1600 / FRAME));
    // (it lies on its side, about 80° over)
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(gv.rig.j.body.quaternion);
    expect(up.y).toBeLessThan(0.2);
    expect(fx.get("slam")).toBe(1);
    sync(Math.round(5000 / FRAME));
    expect(toppling(r)).toHaveLength(0);
    expect(gv.root.parent).toBeNull();
  });
});

describe("the Gantry's stages", () => {
  function gantry(): { rig: Rig; b: Building; parts: () => Record<string, THREE.Object3D> } {
    const rig = setup();
    const b = spawnBuilding(rig.w, "gantry", "blue", 4, 4);
    rig.sync();
    return { rig, b, parts: () => views(rig.r).get(b.id)!.m.parts };
  }
  const shown = (p: Record<string, THREE.Object3D>) => [0, 1, 2, 3].filter((i) => p[`stage${i}`]!.visible);

  it("builds the Goliath up in four stages from the head of its queue, lights on while it works", () => {
    const { rig, b, parts } = gantry();
    expect(shown(parts())).toEqual([]);
    expect(parts().lightsOn!.visible).toBe(false);
    const total = UNITS.goliath.buildTime * TICK_RATE;
    b.queue.push({ kind: "goliath", remaining: total });
    for (const [k, stage] of [[0.1, 0], [0.3, 1], [0.6, 2], [0.9, 3]] as const) {
      b.queue[0]!.remaining = Math.round(total * (1 - k));
      rig.sync();
      expect(shown(parts())).toEqual([stage]);
    }
    expect(parts().lightsOn!.visible).toBe(true);
  });

  it("rolls out: the mech leaves the cradle as the real Goliath, starting where it stood, and the arms swing clear", () => {
    const { rig, b, parts } = gantry();
    const total = UNITS.goliath.buildTime * TICK_RATE;
    b.queue.push({ kind: "goliath", remaining: Math.round(total * 0.05) });
    rig.sync();
    b.queue.length = 0;
    const g = spawnUnit(rig.w, "goliath", "blue", 5.5, 10.5);
    rig.r.onFx({ type: "goliathRollout", faction: "blue", id: g.id, buildingId: b.id, x: g.x, y: g.y } as FxEvent);
    rig.sync();
    expect(shown(parts())).toEqual([]);
    const gv = views(rig.r).get(g.id)!.goliath!;
    // (it starts on the cradle, at the Gantry's middle, not where the sim put it)
    expect(Math.hypot(gv.gx - 5.5, gv.gy - 5.5)).toBeLessThan(0.3);
    rig.sync(Math.round(600 / FRAME));
    expect(parts().armL!.rotation.y).toBeGreaterThan(1);
    rig.sync(Math.round(5000 / FRAME));
    expect(Math.hypot(gv.gx - 5.5, gv.gy - 10.5)).toBeLessThan(0.05);
  });

  it("holds its work still while it's EMP'd", () => {
    const { rig, b } = gantry();
    const total = UNITS.goliath.buildTime * TICK_RATE;
    b.queue.push({ kind: "goliath", remaining: Math.round(total * 0.5) });
    rig.w.powers.stunned.set(b.id, rig.w.tick + 100);
    const work = () => (views(rig.r).get(b.id) as unknown as { gantry: { work: number } }).gantry.work;
    const before = work();
    rig.sync(30, 0.5);
    expect(work()).toBe(before);
    expect(rig.fx.get("weld") ?? 0).toBe(0);
  });
});

describe("Robot Love", () => {
  it("walks the two Goliaths to meet, eyes pink, hearts rising", () => {
    const { r, w, sync, fx } = setup();
    const a = spawnUnit(w, "goliath", "blue", 8, 10);
    const b = spawnUnit(w, "goliath", "red", 12, 10);
    sync(2);
    r.love([a.id, b.id], 10, 10);
    sync(Math.round(4200 / FRAME));
    const va = views(r).get(a.id)!.goliath!;
    const vb = views(r).get(b.id)!.goliath!;
    expect(Math.hypot(va.gx - vb.gx, va.gy - vb.gy)).toBeLessThan(2.4);
    // facing each other
    expect(Math.abs(Math.sin(va.face) - 1)).toBeLessThan(0.05);
    expect(Math.abs(Math.sin(vb.face) + 1)).toBeLessThan(0.05);
    const love = va.rig.meshes.find((m) => m.part === "eyeLove")!.mesh;
    expect(love.visible).toBe(true);
    expect(fx.get("hearts")).toBeGreaterThan(5);
  });
});

describe("the finale's banner", () => {
  const at = { x: 1, y: 2, player: "blue" as const, spectator: false };
  it("keeps its keys, and names what decided it", () => {
    expect(finaleBanner({ ...at, cause: "hq", winner: "blue" })).toMatchObject({ key: "victory", text: "Enemy HQ destroyed" });
    expect(finaleBanner({ ...at, cause: "hq", winner: "red" })).toMatchObject({ key: "defeat", text: "Our HQ has fallen" });
    expect(finaleBanner({ ...at, cause: "goliath", winner: "blue" })).toMatchObject({ key: "victory", text: "Enemy Goliath destroyed" });
    expect(finaleBanner({ ...at, cause: "goliath", winner: "red" })).toMatchObject({ key: "defeat", text: "Our last Goliath has fallen" });
    expect(finaleBanner({ ...at, spectator: true, cause: "goliath", winner: "blue" })).toMatchObject({ key: "hq-destroyed", text: "Red Goliath destroyed" });
    expect(finaleBanner({ ...at, spectator: true, cause: "hq", winner: "red" })).toMatchObject({ key: "hq-destroyed", text: "Blue HQ destroyed" });
    expect(finaleBanner({ ...at, cause: "love", winner: "draw" })).toMatchObject({ key: "draw", sub: "It's a draw", tone: "good" });
  });
});
