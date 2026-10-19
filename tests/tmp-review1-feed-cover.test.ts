import { describe, expect, it } from "vitest";
import { replay } from "../src/arena/record";
import { planTicks } from "../src/game/awareness";
import { Controller, buildView } from "../src/game/controller";
import { parseRecord } from "../src/game/replay";
import { PacketAir } from "../src/link/packet-air";
import type { BandRole } from "../src/link/transport";
import { createAiState, tickAi, type AiState } from "../src/sim/ai/commander";
import { BUILDINGS, UNITS } from "../src/sim/balance";
import { worldHash } from "../src/sim/checksum";
import { hash32 } from "../src/sim/rand";
import { step } from "../src/sim/sim";
import type { Command, Faction, Unit, UnitKind, World } from "../src/sim/types";
import { hqOf, spawnUnit } from "../src/sim/world";
import { setupWorld } from "../src/sim/setup";
import type { AbortReason } from "../src/game/GameScene";
import { VersusFeed, liftGroupsFirst, type FeedEnv } from "../src/versus/feed";
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
  const feed = new VersusFeed({ session: p.s, rig: (p.role === "host" ? hostRig : null) as unknown as Rig | null, practice: !!r.opts.practice, onExit: () => p.exits++, env });
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
const ls = (p: Phone) => p.s.lockstep!.status();
// ---------------- review: reconnect cover after Leave / after the end ----------------
import type { Rig } from "../src/link/rig";
import type { OverlayState } from "../src/versus/hud";

interface FakeRig {
  state: string; failures: number; micMode: "raw"; lostFns: ((r: string) => void)[];
  onLost(fn: (r: string) => void): () => void; captureOkMs(): number; reconnect(): Promise<boolean>;
}
function fakeRig(): FakeRig {
  const r: FakeRig = {
    state: "running", failures: 0, micMode: "raw", lostFns: [],
    onLost(fn) { r.lostFns.push(fn); return () => undefined; },
    captureOkMs: () => 0,
    reconnect: async () => { r.failures++; return false; }
  };
  return r;
}

let hostRig: FakeRig | null = null;
function pairWithRig(seed: number, rig: FakeRig): Run {
  hostRig = rig;
  const r = pair({ seed });
  hostRig = null;
  return r;
}

const ov = (f: VersusFeed) => (f as unknown as { overlay(): OverlayState }).overlay();

describe("review: the reconnect cover", () => {
  it("offers Leave after 2 failures, and after that Leave the cover is gone (or offers a way out)", { timeout: 60_000 }, async () => {
    const rig = fakeRig();
    const r = pairWithRig(23, rig);
    runUntil(r, () => tickOf(r.host) >= 30 && tickOf(r.guest) >= 30, 30_000);
    const f = r.host.feed!;
    for (const fn of rig.lostFns) fn("context");
    rig.state = "lost";
    f.pump();
    expect(ov(f).reconnect).toEqual({ phase: "lost", leave: false });
    for (let i = 0; i < 2; i++) {
      (f as unknown as { reconnect(): void }).reconnect();
      await Promise.resolve(); await Promise.resolve();
    }
    f.pump();
    expect(rig.failures).toBe(2);
    expect(ov(f).reconnect).toEqual({ phase: "failed", leave: true });
    // the cover's Leave (hooks.leave -> feed.leave)
    (f as unknown as { leave(): void }).leave();
    expect(r.host.aborts.map((a) => a.reason)).toEqual(["lost"]);
    f.pump();
    const after = ov(f);
    console.log("after Leave:", JSON.stringify(after));
    // the end screen (z 30) is under the cover (z 36): the cover must go, or keep a way out
    expect(after.reconnect === null || after.reconnect.leave).toBe(true);
  });

  it("after a decided match, a lost link's cover keeps a way out", { timeout: 60_000 }, async () => {
    const rig = fakeRig();
    const r = pairWithRig(29, rig);
    runUntil(r, () => tickOf(r.host) >= 30 && tickOf(r.guest) >= 30, 30_000);
    const guest = r.guest;
    guest.feed!.duel.resign(false);
    runUntil(r, () => [r.host, r.guest].every((p) => ls(p).endCheck === "ok"), 20_000);
    const f = r.host.feed!;
    expect(f.world.winner).not.toBeNull();
    for (const fn of rig.lostFns) fn("context");
    rig.state = "lost";
    for (let i = 0; i < 3; i++) {
      (f as unknown as { reconnect(): void }).reconnect();
      await Promise.resolve(); await Promise.resolve();
    }
    f.pump();
    const st = ov(f);
    console.log("decided, after 3 failed taps:", JSON.stringify(st), "failures", rig.failures);
    expect(st.reconnect === null || st.reconnect.leave).toBe(true);
  });
});
