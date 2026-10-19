import { describe, expect, it } from "vitest";
import { replay } from "../src/arena/record";
import { planTicks } from "../src/game/awareness";
import { Controller, buildView } from "../src/game/controller";
import { ReplayFeed, parseRecord } from "../src/game/replay";
import { PacketAir } from "../src/link/packet-air";
import type { LostReason, MicMode, RigState } from "../src/link/rig";
import type { BandRole } from "../src/link/transport";
import { createAiState, tickAi, type AiState } from "../src/sim/ai/commander";
import { BUILDINGS, UNITS } from "../src/sim/balance";
import { OPENERS } from "../src/sim/openers";
import { worldHash } from "../src/sim/checksum";
import { hash32 } from "../src/sim/rand";
import { step } from "../src/sim/sim";
import type { Command, Faction, Unit, UnitKind, World } from "../src/sim/types";
import { hqOf, spawnUnit } from "../src/sim/world";
import { setupWorld } from "../src/sim/setup";
import type { AbortReason } from "../src/game/GameScene";
import { VersusFeed, liftGroupsFirst, type DuelRig, type FeedEnv } from "../src/versus/feed";
import { orderRows } from "../src/versus/hud";
import { RECORD_KEY, REMATCH_KEY, readRematch, readTally } from "../src/versus/records";
import { Session } from "../src/versus/session";

// VersusFeed (SOUND-DUEL.md "MatchFeed and GameScene") driven as GameScene drives it: a real Controller, the
// game loop's planTicks, a null from commands() holding the pose, two Sessions paired over PacketAir on a fake
// clock. No DOM: the feed's browser pieces are stand-ins (no timers, memory storage, a counted reload).

const BUILD = 0x5eed;
const rng = (seed: number) => {
  let i = 0;
  return () => hash32(seed, 0xfeed, i++) / 4294967296;
};

/** sessionStorage / localStorage in memory, counting writes. */
class Mem {
  readonly m = new Map<string, string>();
  readonly sets: [string, string][] = [];
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.sets.push([k, v]);
    this.m.set(k, v);
  }
  writes(k: string): number {
    return this.sets.filter(([key]) => key === k).length;
  }
}

interface Phone {
  role: BandRole;
  s: Session;
  feed: VersusFeed | null;
  ctrl: Controller | null;
  frameMs: number;
  next: number;
  last: number;
  acc: number;
  cardsAt: number | null;
  /** Don't step (the page's game is held: its link and pump run on). */
  hold: boolean;
  /** The world tick each drain of the Controller came on. */
  drains: number[];
  /** Every non-null commands() result, by tick. */
  stepped: Map<number, Command[]>;
  aborts: { reason: AbortReason; info?: string }[];
  skips: number;
  exits: number;
  reloads: number;
  local: Mem;
  session: Mem;
  ai: AiState | null;
  aiTick: number;
}

interface Opts {
  seed: number;
  practice?: boolean;
  /** Each phone's world right after its feed is made, before any step (the same on both). */
  prepare?: (w: World) => void;
  /** AIs play both sides (their orders go through the Controller). */
  ai?: boolean;
  /** The lockstep gets the Controller's commands as drained, not through the feed's lift grouping (a control run). */
  raw?: boolean;
  /** A phone's audio rig (default none, as on a practice link). */
  rigs?: Partial<Record<BandRole, DuelRig>>;
}

interface Run {
  air: PacketAir;
  host: Phone;
  guest: Phone;
  opts: Opts;
}

function phone(role: BandRole, air: PacketAir, seed: number, frameMs: number): Phone {
  const link = role === "host" ? air.a : air.b;
  const s = new Session({ transport: link, role, build: BUILD, random: rng(seed), ...(role === "host" ? { host: { map: "riverlands", mutators: [] } } : {}) });
  return {
    role, s, feed: null, ctrl: null, frameMs, next: 0, last: 0, acc: 0, cardsAt: null, hold: false, drains: [], stepped: new Map(),
    aborts: [], skips: 0, exits: 0, reloads: 0, local: new Mem(), session: new Mem(), ai: null, aiTick: -1
  };
}

function pair(opts: Opts): Run {
  const air = new PacketAir({ seed: opts.seed, clockOffsetMs: [0, 31_337], mode: "robust", latencyMs: 250, phaseMs: [30, 170] });
  const r: Run = { air, host: phone("host", air, opts.seed * 2 + 1, 16), guest: phone("guest", air, opts.seed * 2 + 2, 11), opts };
  r.guest.next = 5;
  runUntil(r, () => !!r.host.feed && !!r.guest.feed, 60_000);
  return r;
}

/** Advance the air in 2 ms steps, each phone getting its animation frames, until `done` (or `limitMs` of air time: fails). */
function runUntil(r: Run, done: () => boolean, limitMs: number): void {
  const end = r.air.now() + limitMs;
  while (!done()) {
    expect(r.air.now(), "ran out of time").toBeLessThan(end);
    r.air.advance(2);
    for (const p of [r.host, r.guest]) frame(p, r);
  }
}

const runFor = (r: Run, ms: number) => {
  const end = r.air.now() + ms;
  runUntil(r, () => r.air.now() >= end, ms + 10);
};

/** One animation frame: the lobby until the match is agreed, then the feed as GameScene drives it. */
function frame(p: Phone, r: Run): void {
  const now = r.air.now();
  if (now < p.next) return;
  const dt = now - p.last;
  p.last = now;
  p.next = now + p.frameMs;
  if (!p.feed) {
    p.s.pump();
    const st = p.s.pairing.state();
    if (st.phase === "picking") {
      p.cardsAt ??= now;
      if (now - p.cardsAt >= (p.role === "host" ? 300 : 700)) p.s.pick(st.offered[0]!);
    }
    if (p.s.phase === "starting") start(p, r);
    return;
  }
  const f = p.feed;
  const ctrl = p.ctrl!;
  const w = f.world;
  if (!ctrl.paused && !p.hold && !f.abortReason && !w.winner) {
    const plan = planTicks(p.acc, dt, f.speed());
    p.acc = plan.acc;
    for (let i = 0; i < plan.ticks; i++) {
      if (w.winner) break;
      if (p.ai && p.aiTick !== w.tick) {
        p.aiTick = w.tick;
        for (const c of tickAi(w, f.local, p.ai)) ctrl.enqueue(c);
      }
      const t = w.tick;
      const cmds = r.opts.raw ? f.session.commandsFor(t, () => ctrl.drainCommands()) : f.commands(t);
      if (!cmds) {
        p.acc = 100 * 0.999; // (GameScene: hold the pose, no catch-up burst)
        break;
      }
      p.stepped.set(t, cmds);
      step(w, cmds);
      f.afterTick(w);
    }
  }
  f.frame(dt);
}

/** The match is agreed: the feed (beginMatch), a Controller on its world, and the scene's stand-in. */
function start(p: Phone, r: Run): void {
  const env: Partial<FeedEnv> = {
    setInterval: () => null, clearInterval: () => undefined, requestAnimationFrame: null, document: null, window: null,
    local: p.local, session: p.session, reload: () => p.reloads++
  };
  const feed = new VersusFeed({ session: p.s, rig: r.opts.rigs?.[p.role] ?? null, practice: !!r.opts.practice, onExit: () => p.exits++, env });
  r.opts.prepare?.(feed.world);
  const ctrl = new Controller(feed.world);
  ctrl.trackInFlight();
  const drain = ctrl.drainCommands.bind(ctrl);
  ctrl.drainCommands = () => {
    p.drains.push(feed.world.tick);
    return drain();
  };
  feed.attach({ ctrl, abort: (reason, info) => p.aborts.push({ reason, ...(info !== undefined ? { info } : {}) }), skipFinale: () => p.skips++ });
  if (r.opts.ai) p.ai = createAiState(feed.local === "blue" ? "balanced" : "rush", "normal", hash32(r.opts.seed, feed.local === "blue" ? 1 : 2));
  p.feed = feed;
  p.ctrl = ctrl;
}

const tickOf = (p: Phone) => p.feed!.world.tick;
const sideOf = (r: Run, f: Faction) => (r.host.feed!.local === f ? r.host : r.guest);
const ls = (p: Phone) => p.s.lockstep!.status();

describe("VersusFeed as GameScene drives it", () => {
  it("seals once per tick, and a stall consumes no input", { timeout: 60_000 }, () => {
    const r = pair({ seed: 3 });
    runUntil(r, () => tickOf(r.host) >= 40 && tickOf(r.guest) >= 40, 30_000);
    // the guest's game holds (its link and pump run on): the host stalls on its turns
    r.guest.hold = true;
    runUntil(r, () => ls(r.host).stalled && r.host.s.status().waiting !== null, 5000);
    const stalledAt = tickOf(r.host);
    const drainsAtStall = r.host.drains.length;
    const side = r.host.feed!.local;
    const hq = hqOf(r.host.feed!.world, side)!;
    // an order given while stalled: nothing drains it while the stall lasts
    r.host.ctrl!.enqueue({ type: "rally", faction: side, buildingId: hq.id, x: 20.5, y: 21.5 });
    runFor(r, 2000);
    expect(tickOf(r.host)).toBe(stalledAt);
    expect(r.host.drains.length).toBe(drainsAtStall);
    expect(ls(r.host).stallMs).toBeGreaterThan(1500);
    // the pause menu's ways out: "Resign and leave" while packets arrive; Leave once "Signal lost" has shown (5 s)
    expect(r.host.feed!.duel.exits()).toEqual({ resignAndLeave: true, leave: false });
    runFor(r, 3500);
    expect(r.host.feed!.duel.exits()).toEqual({ resignAndLeave: true, leave: true });
    expect(r.host.drains.length).toBe(drainsAtStall);
    r.guest.hold = false;
    runUntil(r, () => tickOf(r.host) > stalledAt + r.host.s.result()!.delay + 2, 10_000);
    // it was sealed by the next tick's drain: turn stalledAt + 1 + D
    const D = r.host.s.result()!.delay;
    const landed = [...r.host.stepped].find(([, cmds]) => cmds.some((c) => c.type === "rally"));
    expect(landed?.[0]).toBe(stalledAt + 1 + D);
    // sealing happened once per tick, on every tick commands() was asked for, in order
    for (const p of [r.host, r.guest]) {
      const n = p.drains.length;
      expect(p.drains).toEqual(Array.from({ length: n }, (_, i) => i));
      expect(n).toBeGreaterThanOrEqual(tickOf(p));
      expect(n).toBeLessThanOrEqual(tickOf(p) + 1);
    }
  });

  it("steps blue's orders before red's on both phones, canonical, with the local side red", { timeout: 60_000 }, () => {
    const r = pair({ seed: 5 });
    runUntil(r, () => tickOf(r.host) >= 20 && tickOf(r.guest) >= 20, 30_000);
    const red = sideOf(r, "red");
    const blue = sideOf(r, "blue");
    expect(red.feed!.local).toBe("red");
    expect(red.feed!.config.local).toBe("red");
    const units = (p: Phone, f: Faction) => [...p.feed!.world.units.values()].filter((u) => u.faction === f).map((u) => u.id);
    const [ra, rb] = units(red, "red").slice(-2) as [number, number];
    const [ba] = units(blue, "blue").slice(-1) as [number];
    // red's order: ids unsorted with a duplicate, a point off the 1/16-tile grid; blue's on the same tick
    red.ctrl!.enqueue({ type: "move", faction: "red", unitIds: [rb, ra, rb], x: 30.123, y: 20.987 });
    blue.ctrl!.enqueue({ type: "move", faction: "blue", unitIds: [ba], x: 25.5, y: 30.5 });
    runUntil(r, () => tickOf(r.host) >= 60 && tickOf(r.guest) >= 60, 20_000);
    const n = Math.min(tickOf(r.host), tickOf(r.guest));
    for (const p of [r.host, r.guest]) {
      for (const [, cmds] of p.stepped) {
        // blue's commands, then red's, whichever side this phone plays
        const firstRed = cmds.findIndex((c) => c.faction === "red");
        if (firstRed >= 0) expect(cmds.slice(firstRed).every((c) => c.faction === "red")).toBe(true);
      }
      const log = p.feed!.turnLog().filter(([t]) => t < n);
      // the turn log: blue's entry before red's on a tick, each entry one side's
      for (let i = 1; i < log.length; i++) expect(log[i]![0] > log[i - 1]![0] || (log[i - 1]![1] === "blue" && log[i]![1] === "red")).toBe(true);
      for (const [, side, cmds] of log) expect(cmds.every((c) => c.faction === side)).toBe(true);
      expect(p.feed!.turnLog()).toEqual(p.s.lockstep!.turns());
    }
    // both phones stepped exactly the same commands
    const upTo = (p: Phone) => p.feed!.turnLog().filter(([t]) => t < n);
    expect(upTo(r.host)).toEqual(upTo(r.guest));
    // red's order as stepped: canonical (sorted, no duplicate, on the grid), stamped red
    const redMove = upTo(red).find(([, side, cmds]) => side === "red" && cmds.some((c) => c.type === "move"));
    expect(redMove?.[2]).toEqual([{ type: "move", faction: "red", unitIds: [Math.min(ra, rb), Math.max(ra, rb)], x: (Math.floor(30.123 * 16) + 0.5) / 16, y: (Math.floor(20.987 * 16) + 0.5) / 16 }]);
    const blueMove = upTo(red).find(([, side, cmds]) => side === "blue" && cmds.some((c) => c.type === "move"));
    expect(blueMove?.[2]).toEqual([{ type: "move", faction: "blue", unitIds: [ba], x: 25.53125, y: 30.53125 }]);
    expect(ls(r.host).desync || ls(r.guest).desync).toBe(false);
  });

  it("seals nothing while paused, and the friend sees it paused", { timeout: 60_000 }, () => {
    const r = pair({ seed: 7 });
    runUntil(r, () => tickOf(r.host) >= 30 && tickOf(r.guest) >= 30, 30_000);
    const p = r.guest;
    p.ctrl!.paused = true; // (the HUD's pause menu)
    runFor(r, 100);
    const sealed = ls(p).newestSealed;
    const drains = p.drains.length;
    expect(ls(p).paused).toBe(true);
    const side = p.feed!.local;
    p.ctrl!.enqueue({ type: "stop", faction: side, unitIds: [[...p.feed!.world.units.values()].find((u) => u.faction === side)!.id] });
    // (even if the loop asked: nothing is sealed or drained while paused)
    expect(p.feed!.commands(tickOf(p))).toBeNull();
    runFor(r, 4000);
    expect(ls(p).newestSealed).toBe(sealed);
    expect(p.drains.length).toBe(drains);
    // the friend stalls within D ticks and waits on a paused friend
    expect(ls(r.host).peerPaused).toBe(true);
    expect(r.host.s.status().waiting?.why).toBe("paused");
    p.ctrl!.paused = false;
    const at = tickOf(p);
    runUntil(r, () => tickOf(p) > at + 10 && tickOf(r.host) > at + 10, 10_000);
    expect(p.drains.length).toBeGreaterThan(drains);
    expect([...p.stepped.values()].some((cmds) => cmds.some((c) => c.type === "stop"))).toBe(true);
  });

  /** A blue Goliath first in id order, 27 blue units, then two Condors far off, with spent ids between them (a long match's gaps). */
  const army = (ids: { g: number; condors: number[]; all: number[] }) => (w: World) => {
    const hq = hqOf(w, "blue")!;
    const spend = () => {
      for (let i = 0; i < 12; i++) w.units.delete(spawnUnit(w, "scout", "red", w.width - 2, 2).id);
    };
    const blue = (kind: UnitKind, x: number, y: number): Unit => {
      const u = spawnUnit(w, kind, "blue", x, y);
      spend();
      return u;
    };
    const near = (i: number) => ({ x: hq.tx + 6 + (i % 6), y: hq.ty - 4 - Math.floor(i / 6) });
    const g = blue("goliath", hq.tx + 4, hq.ty - 8);
    const rest: Unit[] = [];
    for (let i = 0; i < 27; i++) rest.push(blue("stinger", near(i).x, near(i).y));
    const a = blue("condor", hq.tx + 20, hq.ty - 24);
    const b = blue("condor", hq.tx + 22, hq.ty - 24);
    ids.g = g.id;
    ids.condors = [a.id, b.id];
    ids.all = [g.id, ...rest.map((u) => u.id), a.id, b.id];
  };

  /** The lift, then a select-all move of the 30 while it is still hooking on (and the world as it was then). */
  function liftAndMove(raw: boolean): { r: Run; blue: Phone; ids: { g: number; condors: number[]; all: number[] }; to: { x: number; y: number }; hooking: World } {
    const ids = { g: 0, condors: [] as number[], all: [] as number[] };
    const r = pair({ seed: 11, prepare: army(ids), raw });
    const blue = sideOf(r, "blue");
    const w = blue.feed!.world;
    blue.ctrl!.enqueue({ type: "lift", faction: "blue", unitIds: ids.condors, goliathId: ids.g });
    runUntil(r, () => w.units.get(ids.g)!.goliath!.lift?.phase === "hooking", 20_000);
    const hooking = structuredClone(w);
    // open ground north-east of blue's HQ, on the codec's 1/16-tile grid
    const hq = hqOf(w, "blue")!;
    const to = { x: (Math.floor((hq.tx + 14.5) * 16) + 0.5) / 16, y: (Math.floor((hq.ty - 14.5) * 16) + 0.5) / 16 };
    blue.ctrl!.enqueue({ type: "move", faction: "blue", unitIds: ids.all, ...to });
    const named = () => {
      const seen = new Set<number>();
      for (const [, cmds] of blue.stepped) for (const c of cmds) if (c.type === "move" && c.faction === "blue") for (const id of c.unitIds) seen.add(id);
      return ids.all.every((id) => seen.has(id));
    };
    runUntil(r, named, 20_000);
    const at = tickOf(blue);
    // a few more ticks on both phones
    runUntil(r, () => tickOf(r.host) >= at + 3 && tickOf(r.guest) >= at + 3, 10_000);
    return { r, blue, ids, to, hooking };
  }

  it("hands a hooking lift to the lockstep as its own command first: a 30-unit select-all all moves", { timeout: 60_000 }, () => {
    const { r, blue, ids, to, hooking } = liftAndMove(false);
    // the codec would have split it, the Goliath into an earlier piece than its Condors
    const w = blue.feed!.world;
    const moves = [...blue.stepped.values()].flatMap((cmds) => cmds.filter((c): c is Extract<Command, { type: "move" }> => c.type === "move"));
    expect(moves.length).toBeGreaterThanOrEqual(3);
    expect(moves[0]!.unitIds).toEqual([ids.g, ...ids.condors]);
    for (const p of [r.host, r.guest]) {
      const pw = p.feed!.world;
      expect(pw.units.get(ids.g)!.goliath!.lift).toBeNull();
      // (the pieces land a round trip apart: the fast Condors may be there already)
      for (const id of ids.all) {
        const u = pw.units.get(id)!;
        if (u.order.type !== "move") expect(Math.hypot(u.x - to.x, u.y - to.y), `unit ${id} (${u.kind}) is ${u.order.type}`).toBeLessThan(1.5);
        else expect(u.order, `unit ${id}`).toMatchObject({ type: "move", ...to });
      }
    }
    expect(w.units.get(ids.g)!.order.type).toBe("move");
    expect(ls(r.host).desync || ls(r.guest).desync).toBe(false);
    // (liftGroupsFirst by itself: the group, then the rest, nothing else touched)
    const rest = ids.all.filter((id) => id !== ids.g && !ids.condors.includes(id));
    expect(liftGroupsFirst(hooking, [{ type: "move", faction: "blue", unitIds: ids.all, x: 1.5, y: 1.5 }])).toEqual([
      { type: "move", faction: "blue", unitIds: [ids.g, ...ids.condors], x: 1.5, y: 1.5 },
      { type: "move", faction: "blue", unitIds: rest, x: 1.5, y: 1.5 }
    ]);
    // a hooking Goliath whose Condors aren't named: unchanged (it waits, as one command leaves it)
    const noCondors: Command = { type: "stop", faction: "blue", unitIds: [ids.g, ...rest] };
    expect(liftGroupsFirst(hooking, [noCondors])).toEqual([noCondors]);
    // (and once it is up, or with no lift at all, nothing changes)
    expect(liftGroupsFirst(w, [{ type: "move", faction: "blue", unitIds: ids.all, x: 1.5, y: 1.5 }])).toHaveLength(1);
  });

  it("(control) without the grouping, the hooking Goliath misses the split order", { timeout: 60_000 }, () => {
    const { r, ids } = liftAndMove(true);
    for (const p of [r.host, r.guest]) {
      const pw = p.feed!.world;
      expect(pw.units.get(ids.g)!.order.type).not.toBe("move");
      for (const id of ids.condors) expect(pw.units.get(id)?.order.type).toBe("move");
    }
  });

  it("groups a lift still on its way the same: a select-all right after the lift tap all moves", { timeout: 60_000 }, () => {
    const ids = { g: 0, condors: [] as number[], all: [] as number[] };
    const r = pair({ seed: 11, prepare: army(ids) });
    const blue = sideOf(r, "blue");
    const w = blue.feed!.world;
    blue.ctrl!.enqueue({ type: "lift", faction: "blue", unitIds: ids.condors, goliathId: ids.g });
    const d0 = blue.drains.length;
    runUntil(r, () => blue.drains.length > d0, 2000);
    // the lift is sealed, D ticks from landing: the world doesn't know of it yet, and the select-all comes now
    expect(w.units.get(ids.g)!.goliath!.lift).toBeNull();
    const hq = hqOf(w, "blue")!;
    const to = { x: (Math.floor((hq.tx + 14.5) * 16) + 0.5) / 16, y: (Math.floor((hq.ty - 14.5) * 16) + 0.5) / 16 };
    blue.ctrl!.enqueue({ type: "move", faction: "blue", unitIds: ids.all, ...to });
    const d1 = blue.drains.length;
    runUntil(r, () => blue.drains.length > d1, 2000);
    expect(w.units.get(ids.g)!.goliath!.lift).toBeNull();
    const named = () => {
      const seen = new Set<number>();
      for (const [, cmds] of blue.stepped) for (const c of cmds) if (c.type === "move" && c.faction === "blue") for (const id of c.unitIds) seen.add(id);
      return ids.all.every((id) => seen.has(id));
    };
    runUntil(r, named, 20_000);
    const at = tickOf(blue);
    runUntil(r, () => tickOf(r.host) >= at + 3 && tickOf(r.guest) >= at + 3, 10_000);
    const moves = [...blue.stepped.values()].flatMap((cmds) => cmds.filter((c): c is Extract<Command, { type: "move" }> => c.type === "move"));
    expect(moves[0]!.unitIds).toEqual([ids.g, ...ids.condors]);
    for (const p of [r.host, r.guest]) {
      const g = p.feed!.world.units.get(ids.g)!;
      // (the lift landed first, hooking on; the group called it off and took the order)
      expect(g.goliath!.lift).toBeNull();
      expect(g.order, "the Goliath").toMatchObject({ type: "move", ...to });
    }
    expect(ls(r.host).desync || ls(r.guest).desync).toBe(false);
    // (liftGroupsFirst with a lift on its way, or one earlier in the same drain: the same group; one after it: nothing)
    const rest = ids.all.filter((id) => id !== ids.g && !ids.condors.includes(id));
    const lift: Command = { type: "lift", faction: "blue", unitIds: ids.condors, goliathId: ids.g };
    const move: Command = { type: "move", faction: "blue", unitIds: ids.all, x: 1.5, y: 1.5 };
    const grouped = [
      { ...move, unitIds: [ids.g, ...ids.condors] },
      { ...move, unitIds: rest }
    ];
    expect(liftGroupsFirst(w, [move], [{ goliathId: ids.g, condors: ids.condors }])).toEqual(grouped);
    expect(liftGroupsFirst(w, [lift, move])).toEqual([lift, ...grouped]);
    expect(liftGroupsFirst(w, [move, lift])).toEqual([move, lift]);
  });

  it("keeps a turn log and hashes that replay through parseRecord with no divergence", { timeout: 120_000 }, () => {
    const r = pair({ seed: 13, ai: true });
    runUntil(r, () => tickOf(r.host) >= 1250 && tickOf(r.guest) >= 1250, 300_000);
    for (const p of [r.host, r.guest]) {
      const rec = p.feed!.record();
      const hostBlue = (p.feed!.local === "blue") === (p.role === "host");
      expect(rec.seats).toEqual({ blue: { player: `sound-duel:${hostBlue ? "host" : "guest"}` }, red: { player: `sound-duel:${hostBlue ? "guest" : "host"}` } });
      expect(rec.hashes.length).toBe(Math.floor(tickOf(p) / 100));
      expect(rec.turns.length).toBeGreaterThan(50);
      expect(rec.turns).toEqual(p.s.lockstep!.turns());
      const back = parseRecord(JSON.stringify(rec));
      const res = replay(back);
      expect(res.divergedAt).toBeNull();
      expect(res.checked).toBe(rec.hashes.length);
      expect(worldHash(res.world)).toBe(worldHash(p.feed!.world));
      expect(rec.end).toEqual({ tick: tickOf(p), winner: null, reason: "aborted" });
    }
    const n = Math.min(tickOf(r.host), tickOf(r.guest));
    const upTo = (p: Phone) => p.feed!.turnLog().filter(([t]) => t < n);
    expect(upTo(r.host)).toEqual(upTo(r.guest));
  });
});

describe("the report's order delay", () => {
  it("is the real time from the drain to this phone's step, a stall on the way included", { timeout: 60_000 }, () => {
    const r = pair({ seed: 29 });
    runUntil(r, () => tickOf(r.host) >= 30 && tickOf(r.guest) >= 30, 30_000);
    const p = r.host;
    const D = p.s.result()!.delay;
    const side = p.feed!.local;
    const hq = hqOf(p.feed!.world, side)!;
    expect(p.feed!.reportView().link.orders).toBeNull();
    const rallies = () => [...p.stepped.values()].flat().filter((c) => c.type === "rally" && c.faction === side).length;
    // an order on a clear link lands D ticks after its drain: about D × 100 ms
    p.ctrl!.enqueue({ type: "rally", faction: side, buildingId: hq.id, x: 20.5, y: 21.5 });
    runUntil(r, () => rallies() === 1, 3000);
    const one = p.feed!.reportView().link.orders!;
    expect(one.meanMs).toBe(one.worstMs);
    expect(Math.abs(one.meanMs - D * 100)).toBeLessThanOrEqual(60);
    // the friend's game holds (its link runs on): the host steps on through the friend's turns it holds, D past
    // the friend's tick. An order drained once the host is ahead of the friend is sealed past them, so it waits
    // out the stall: from its drain to the step, 2 s of hold and the friend's next turn's trip
    r.guest.hold = true;
    const g = tickOf(r.guest);
    runUntil(r, () => tickOf(p) > g, 2000);
    const drains = p.drains.length;
    p.ctrl!.enqueue({ type: "rally", faction: side, buildingId: hq.id, x: 22.5, y: 21.5 });
    runUntil(r, () => p.drains.length > drains, 1000);
    expect(p.drains.at(-1)! + D).toBeGreaterThan(ls(p).ackThrough);
    runFor(r, 2000);
    expect(rallies()).toBe(1);
    expect(ls(p).stalled).toBe(true);
    r.guest.hold = false;
    runUntil(r, () => rallies() === 2, 5000);
    const both = p.feed!.reportView().link.orders!;
    expect(both.worstMs).toBeGreaterThanOrEqual(2000);
    expect(both.worstMs).toBeLessThanOrEqual(3000);
    expect(both.meanMs).toBeCloseTo((one.meanMs + both.worstMs) / 2, 6);
    // (the lockstep's count in ticks still says D: it never sees the stall)
    expect(ls(p).orderDelay).toBe(D);
    expect(p.feed!.reportView().link.orders).toEqual(ls(p).orderWait);
  });

  it("reads as the mean and the worst", () => {
    expect(orderRows(null)).toEqual([["Order delay", "–"], ["Slowest order", "–"]]);
    expect(orderRows({ meanMs: 620.4, worstMs: 1420 })).toEqual([["Order delay", "620 ms average"], ["Slowest order", "1.4 s"]]);
    expect(orderRows({ meanMs: 412, worstMs: 12_400 })).toEqual([["Order delay", "412 ms average"], ["Slowest order", "12 s"]]);
  });
});

describe("orders in flight", () => {
  it("count as applied in the build bar until the tick they land", { timeout: 60_000 }, () => {
    const r = pair({ seed: 23 });
    runUntil(r, () => tickOf(r.host) >= 20 && tickOf(r.guest) >= 20, 30_000);
    const p = r.host;
    const ctrl = p.ctrl!;
    const w = p.feed!.world;
    const side = p.feed!.local;
    const f = w.factions[side];
    const hq = hqOf(w, side)!;
    expect(f.pending).toBeNull();
    // (the Controller's own PLAYER is blue in this process: view the side through buildView's rules directly)
    const view = () => buildView(w, side, ctrl.inFlight);
    ctrl.enqueue({ type: "startBuilding", faction: side, building: "fab-plant" });
    ctrl.enqueue({ type: "produce", faction: side, buildingId: hq.id, unit: "harvester" });
    const at = tickOf(p);
    runUntil(r, () => p.drains.length > at + 1, 2000);
    // drained and sealed, not applied yet: the bar shows them done
    expect(f.pending).toBeNull();
    expect(ctrl.inFlight!.map((c) => c.type)).toEqual(["startBuilding", "produce"]);
    expect(view().pending).toMatchObject({ kind: "fab-plant", ready: false });
    expect(view().extra(hq.id, "harvester")).toBe(1);
    expect(view().scrap).toBe(f.scrap - BUILDINGS["fab-plant"].cost - UNITS.harvester.cost);
    // landed: the world has them, nothing is in flight, and the bar shows the world as it is
    runUntil(r, () => f.pending !== null, 3000);
    expect(ctrl.inFlight).toEqual([]);
    expect(f.pending).toMatchObject({ kind: "fab-plant" });
    expect(hq.queue.map((q) => q.kind)).toEqual(["harvester"]);
    expect(view().extra(hq.id)).toBe(0);
    expect(view().scrap).toBe(f.scrap);
  });

  it("are nothing without an interactive feed", () => {
    const c = new Controller(setupLikeWorld());
    c.enqueue({ type: "startBuilding", faction: "blue", building: "fab-plant" });
    c.drainCommands();
    expect(c.inFlight).toBeNull();
    expect(c.view().pending).toBeNull();
  });
});

describe("the duel's record", () => {
  /** Blue resigns; both phones step it, the end check settles. */
  function resigned(practice: boolean): Run {
    const r = pair({ seed: 17, practice });
    runUntil(r, () => tickOf(r.host) >= 30 && tickOf(r.guest) >= 30, 30_000);
    const blue = sideOf(r, "blue");
    blue.feed!.duel.resign(false);
    expect(blue.ctrl!.locked).toBe(true);
    expect(blue.feed!.duel.resigning()).toBe(true);
    runUntil(r, () => [r.host, r.guest].every((p) => ls(p).endCheck === "ok"), 20_000);
    for (const p of [r.host, r.guest]) expect(p.feed!.world.winner).toBe("red");
    runFor(r, 3000);
    return r;
  }

  it("is written once, at the end, and the way out reloads once", { timeout: 60_000 }, () => {
    const r = resigned(false);
    const blue = sideOf(r, "blue");
    const red = sideOf(r, "red");
    for (const p of [r.host, r.guest]) expect(p.local.writes(RECORD_KEY)).toBe(1);
    expect(readTally(blue.local)).toEqual({ w: 0, l: 1, d: 0, abandoned: 0, noContest: 0 });
    expect(readTally(red.local)).toEqual({ w: 1, l: 0, d: 0, abandoned: 0, noContest: 0 });
    expect(blue.feed!.outcome).toBe("loss");
    expect(red.feed!.outcome).toBe("win");
    const rec = red.feed!.record();
    expect(rec.end).toEqual({ tick: tickOf(red), winner: "red", reason: "resign" });
    expect(replay(parseRecord(JSON.stringify(rec))).divergedAt).toBeNull();
    // the battle viewer labels the phones plainly; the record keeps its seats
    const viewer = new ReplayFeed(parseRecord(JSON.stringify(rec)), null, false);
    const hostSide: Faction = red.role === "host" ? "red" : "blue";
    const guestSide: Faction = hostSide === "red" ? "blue" : "red";
    expect(rec.seats[hostSide].player).toBe("sound-duel:host");
    expect(viewer.labels).toEqual({ [hostSide]: `Host phone · ${OPENERS[rec.openers[hostSide]!].name}`, [guestSide]: `Guest phone · ${OPENERS[rec.openers[guestSide]!].name}` });
    // Menu on blue, Rematch on red: the end goes out, then the page reloads (once), the record untouched
    blue.feed!.duel.menu();
    red.feed!.duel.rematch();
    runUntil(r, () => blue.reloads > 0 && red.reloads > 0, 5000);
    runFor(r, 1000);
    for (const p of [blue, red]) {
      expect([p.reloads, p.exits]).toEqual([1, 1]);
      expect(p.local.writes(RECORD_KEY)).toBe(1);
      expect(p.s.phase).toBe("closed");
    }
    // the rematch: same roles and band, the sides swapped
    expect(red.session.getItem(REMATCH_KEY)).toBe("duel");
    const res = red.s.result()!;
    expect(readRematch(red.session)).toEqual({ role: res.role, plan: res.plan, micMode: "raw", hostSide: res.config.hostSide === "blue" ? "red" : "blue", mapId: "riverlands", mutators: [] });
    expect(blue.session.getItem(REMATCH_KEY)).toBeNull();
    expect(blue.aborts).toEqual([]);
  });

  it("is never written on a practice link", { timeout: 60_000 }, () => {
    const r = resigned(true);
    for (const p of [r.host, r.guest]) {
      expect(p.local.writes(RECORD_KEY)).toBe(0);
      expect(p.feed!.outcome).not.toBeNull();
      p.feed!.duel.menu();
    }
    runUntil(r, () => r.host.reloads > 0 && r.guest.reloads > 0, 5000);
    for (const p of [r.host, r.guest]) expect(p.local.writes(RECORD_KEY)).toBe(0);
  });

  it("counts a friend leaving, and this phone leaving, as abandoned (once)", { timeout: 60_000 }, () => {
    const r = pair({ seed: 19 });
    runUntil(r, () => tickOf(r.host) >= 30 && tickOf(r.guest) >= 30, 30_000);
    r.guest.feed!.duel.leave();
    expect(r.guest.aborts.map((a) => a.reason)).toEqual(["lost"]);
    runUntil(r, () => r.host.aborts.length > 0, 5000);
    runFor(r, 3000);
    expect(r.host.aborts.map((a) => a.reason)).toEqual(["left"]);
    for (const p of [r.host, r.guest]) {
      expect(p.local.writes(RECORD_KEY)).toBe(1);
      expect(readTally(p.local).abandoned).toBe(1);
      expect(p.ctrl!.inFlight).toEqual([]);
    }
    expect(r.guest.s.status().closable).toBe(true);
  });
});

describe("the duel's record when the worlds drift apart", () => {
  /**
   * Red's world drifts from blue's (one scrap) and blue resigns. Blue's game holds once the resign is sealed,
   * so red is decided first, its end check waiting on blue's report; `then` runs there, and blue plays on.
   */
  function drifted(then: (r: Run, red: Phone, blue: Phone) => void): { r: Run; red: Phone } {
    const r = pair({ seed: 31 });
    runUntil(r, () => tickOf(r.host) >= 10 && tickOf(r.guest) >= 10, 30_000);
    const red = sideOf(r, "red");
    const blue = sideOf(r, "blue");
    red.feed!.world.factions.red.scrap += 1;
    blue.feed!.duel.resign(false);
    const d0 = blue.drains.length;
    runUntil(r, () => blue.drains.length > d0, 2000);
    blue.hold = true;
    runUntil(r, () => ls(red).decided !== null, 10_000);
    expect(ls(red).endCheck).toBe("pending");
    expect(red.feed!.world.winner).toBe("red");
    then(r, red, blue);
    blue.hold = false;
    return { r, red };
  }

  it("counts no contest when the end check fails while Rematch waits for the end to go out", { timeout: 60_000 }, () => {
    const { r, red } = drifted((_, p) => p.feed!.duel.rematch());
    runUntil(r, () => red.reloads > 0, 5000);
    expect(ls(red).desync).toBe(true);
    expect(red.feed!.outcome).toBe("noContest");
    expect(readTally(red.local)).toEqual({ w: 0, l: 0, d: 0, abandoned: 0, noContest: 1 });
    expect(red.local.writes(RECORD_KEY)).toBe(1);
  });

  it("turns a result counted as Not verified into no contest when the friend then reports the desync", { timeout: 60_000 }, () => {
    // blue's packets don't reach red for 12 s: red's end check runs out first
    const { r, red } = drifted((run, _, blue) => run.air.outage(12_000, blue.role === "host" ? "ab" : "ba"));
    runUntil(r, () => red.feed!.outcome !== null, 15_000);
    expect(ls(red).endCheck).toBe("unverified");
    expect(red.feed!.outcome).toBe("win");
    expect(readTally(red.local).w).toBe(1);
    expect(red.feed!.reportView().sync).toBe("unverified");
    runUntil(r, () => red.aborts.length > 0, 10_000);
    expect(red.aborts.map((a) => a.reason)).toEqual(["desync"]);
    expect(red.feed!.outcome).toBe("noContest");
    expect(readTally(red.local)).toEqual({ w: 0, l: 0, d: 0, abandoned: 0, noContest: 1 });
    expect(red.feed!.reportView()).toMatchObject({ sync: "desync", record: "0 wins · 0 losses · 0 draws · 1 with no result" });
  });
});

/** The rig as the feed reads it: lost on demand, its reconnects working or failing as told. */
class FakeRig implements DuelRig {
  state: RigState = "running";
  failures = 0;
  micMode: MicMode = "raw";
  /** What the next reconnect resolves. */
  works = false;
  capture = 2000;
  private readonly lost = new Set<(reason: LostReason) => void>();
  onLost(fn: (reason: LostReason) => void): () => void {
    this.lost.add(fn);
    return () => this.lost.delete(fn);
  }
  lose(): void {
    this.state = "lost";
    this.capture = 0;
    for (const f of this.lost) f("context");
  }
  reconnect(): Promise<boolean> {
    if (this.works) {
      this.state = "running";
      this.failures = 0;
    } else this.failures++;
    return Promise.resolve(this.works);
  }
  captureOkMs(): number {
    return this.capture;
  }
}

const settled = () => new Promise((r) => setTimeout(r, 0));

describe("the reconnect cover", () => {
  it("covers the match until the tap works, offers Leave after 2 failures, and never covers the end screen", { timeout: 60_000 }, async () => {
    const rig = new FakeRig();
    const r = pair({ seed: 37, rigs: { host: rig } });
    runUntil(r, () => tickOf(r.host) >= 20 && tickOf(r.guest) >= 20, 30_000);
    const f = r.host.feed!;
    expect(f.overlay().reconnect).toBeNull();
    rig.lose();
    expect(f.overlay().reconnect).toEqual({ phase: "lost", leave: false });
    f.reconnect();
    expect(f.overlay().reconnect).toEqual({ phase: "trying", leave: false });
    await settled();
    expect(f.overlay().reconnect).toEqual({ phase: "failed", leave: false });
    // it works: "Listening…" until capture has run gap-free for 1.5 s
    rig.works = true;
    f.reconnect();
    await settled();
    expect(f.overlay().reconnect).toEqual({ phase: "settling", leave: false });
    rig.capture = 1600;
    f.pump();
    expect(f.overlay().reconnect).toBeNull();
    // lost again, and two taps fail: Leave
    rig.works = false;
    rig.lose();
    for (let i = 0; i < 2; i++) {
      f.reconnect();
      await settled();
    }
    expect(f.overlay().reconnect).toEqual({ phase: "failed", leave: true });
    // the cover's Leave: no result, and the end screen isn't covered (its Main menu is the way out)
    f.duel.leave();
    expect(r.host.aborts.map((a) => a.reason)).toEqual(["lost"]);
    expect(f.overlay().reconnect).toBeNull();
    expect(f.reportView().relink).toBeNull();
  });

  it("leaves a decided match's report uncovered: the report offers the reconnect instead", { timeout: 60_000 }, async () => {
    const rig = new FakeRig();
    const r = pair({ seed: 17, rigs: { host: rig } });
    runUntil(r, () => tickOf(r.host) >= 30 && tickOf(r.guest) >= 30, 30_000);
    r.guest.feed!.duel.resign(false);
    runUntil(r, () => [r.host, r.guest].every((p) => ls(p).endCheck === "ok"), 20_000);
    const f = r.host.feed!;
    expect(f.reportView().relink).toBeNull();
    rig.lose();
    f.pump();
    expect(f.overlay().reconnect).toBeNull();
    expect(f.reportView().relink).toBe("lost");
    for (let i = 0; i < 3; i++) {
      f.reconnect();
      await settled();
    }
    expect(f.overlay().reconnect).toBeNull();
    expect(f.reportView().relink).toBe("failed");
    rig.works = true;
    f.reconnect();
    await settled();
    expect(f.reportView().relink).toBe("settling");
    rig.capture = 1600;
    f.pump();
    expect(f.reportView().relink).toBeNull();
  });
});

describe("the report after the match", () => {
  it("says when the friend is back in the lobby (its reloaded page, under a new nonce)", { timeout: 60_000 }, () => {
    const r = pair({ seed: 17 });
    runUntil(r, () => tickOf(r.host) >= 30 && tickOf(r.guest) >= 30, 30_000);
    r.guest.feed!.duel.resign(false);
    runUntil(r, () => [r.host, r.guest].every((p) => ls(p).endCheck === "ok"), 20_000);
    const f = r.host.feed!;
    expect(f.reportView().friendInLobby).toBe(false);
    // the friend taps Rematch: its end goes out, then its page reloads
    r.guest.feed!.duel.rematch();
    runUntil(r, () => r.guest.reloads > 0, 5000);
    runFor(r, 1500);
    expect(f.reportView().friendInLobby).toBe(false);
    // the reloaded page opens the same phone's link and pairs again: lobby frames
    Object.assign(r.air.b, { closed: false });
    const again = new Session({ transport: r.air.b, role: "guest", build: BUILD, random: rng(99) });
    runUntil(r, () => (again.pump(), f.reportView().friendInLobby), 5000);
    expect(f.abortReason).toBeNull();
    expect(f.outcome).toBe("win");
  });
});

/** A world of the duels' map, no feed. */
const setupLikeWorld = (): World => setupWorld({ map: "riverlands", seed: 1, mutators: [], openers: {} });
