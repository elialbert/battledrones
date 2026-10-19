import { describe, expect, it } from "vitest";
import { endOf, replay, type BattleRecord } from "../src/arena/record";
import { parseRecord } from "../src/game/replay";
import { PacketAir, type PacketAirOptions } from "../src/link/packet-air";
import type { LinkTransport } from "../src/link/transport";
import { createAiState, tickAi, type AiState, type StrategyName } from "../src/sim/ai/commander";
import { worldHash } from "../src/sim/checksum";
import { allowedOpener, pickAiOpener, type OpenerId } from "../src/sim/openers";
import { hash32 } from "../src/sim/rand";
import type { MutatorId } from "../src/sim/rules";
import { setupWorld, type MatchSetup } from "../src/sim/setup";
import { step } from "../src/sim/sim";
import type { Command, Faction, World } from "../src/sim/types";
import { hqOf, spawnUnit } from "../src/sim/world";
import { BitWriter, C_MAX, canonicalize, commandBits } from "../src/versus/codec";
import {
  CHECKPOINT_EVERY, END_CHECK_MS, HEADER_MAX, Lockstep, TRAIL_START, foldTrail, readGameFrame, rxqOf, unwrap16
} from "../src/versus/lockstep";

const MAP = { width: 56, height: 56 };

// ------------------------------------------------------------- the wire ---

/** Two Locksteps on a perfect wire: frames cross whenever exchange() runs; the clock moves with advance(). */
function wire(o: { delay?: number; capacity?: number; setupHash?: number } = {}) {
  let t = 0;
  const now = () => t;
  const mk = (local: Faction) =>
    new Lockstep({ local, delay: o.delay ?? 4, mapWidth: MAP.width, mapHeight: MAP.height, capacity: o.capacity ?? 188, setupHash: o.setupHash ?? 0x1234, now });
  const a = mk("blue");
  const b = mk("red");
  const sizes: number[] = [];
  const exchange = (dir: "both" | "ab" | "ba" = "both") => {
    const fa = a.frame();
    const fb = b.frame();
    sizes.push(fa.nbits, fb.nbits);
    if (dir !== "ba") b.receive(fa.bits, fa.nbits, t);
    if (dir !== "ab") a.receive(fb.bits, fb.nbits, t);
  };
  return { a, b, exchange, sizes, advance: (ms: number) => void (t += ms), now };
}

/** Step a lockstep's tick if it can, folding a stand-in world hash; returns the commands or null. */
function tryStep(ls: Lockstep, drain: () => Command[] = () => [], hash = (t: number) => hash32(t, 77), decided: (t: number) => boolean = () => false) {
  const t = ls.status().tick;
  const cmds = ls.commandsFor(t, drain);
  if (cmds) ls.afterStep(t, hash(t), decided(t) ? { winner: "blue", resigned: null } : null);
  return cmds;
}

/** A hand-built game frame header, for the rejection cases. */
function rawFrame(f: { type?: number; to: number; span?: number; tickLag?: number; ack?: number; nonEmpty?: number }) {
  const wr = new BitWriter();
  wr.bits(f.type ?? 1, 2);
  wr.bits(0, 1 + 2 + 3);
  wr.bits(f.to & 0xffff, 16);
  wr.ue(f.span ?? 0);
  wr.se(f.tickLag ?? 0);
  wr.se(f.ack ?? 0);
  wr.ue(f.nonEmpty ?? 0);
  wr.bit(0);
  return { bits: wr.bytes(), nbits: wr.nbits };
}

describe("lockstep turns and frames", () => {
  it("starts holding turns 0 … D−1, with a one-turn frame", () => {
    const { a } = wire({ delay: 5 });
    const s = a.status();
    expect([s.tick, s.newestSealed, s.ackThrough, s.peerAck, s.slack]).toEqual([0, 4, 4, 4, 4]);
    expect(a.trail()).toBe(foldTrail(TRAIL_START, 0x1234));
    const f = a.frame();
    expect(f.nbits).toBeLessThanOrEqual(HEADER_MAX);
    const g = readGameFrame(f.bits, f.nbits, MAP, "blue", 4);
    expect(g).toMatchObject({ from: 4, to: 4, tickLag: 4, ack: 0, turns: [], end: "playing", paused: false, checkpoint: null });
    expect(a.frame().version).toBe(f.version); // (unchanged: no rebuild)
  });

  it("seals once per tick, and stalls at tick D without the peer", () => {
    const { a, advance } = wire({ delay: 4 });
    let drained = 0;
    const drain = () => {
      drained++;
      return [{ type: "stop", faction: "blue", unitIds: [drained] } as Command];
    };
    for (let t = 0; t < 4; t++) expect(tryStep(a, drain)).toEqual([]); // (turns 0 … D−1 are empty)
    for (let i = 0; i < 5; i++) {
      expect(tryStep(a, drain)).toBeNull();
      advance(100);
    }
    expect(drained).toBe(5); // ticks 0 … 4 sealed turns 4 … 8, once each
    const s = a.status();
    expect(s).toMatchObject({ tick: 4, stalled: true, newestSealed: 8, ackThrough: 3, slack: -1 });
    expect(s.stallMs).toBe(500);
  });

  it("steps the same decoded commands on both phones, blue's first", () => {
    const { a, b, exchange } = wire({ delay: 4 });
    const raw: Record<Faction, Command> = {
      blue: { type: "move", faction: "blue", unitIds: [9, 3, 3], x: 10.123456, y: 7.77 },
      red: { type: "attack", faction: "blue" /* (stamped by the receiver as red) */, unitIds: [44], targetId: 3 }
    };
    const stepped: Record<Faction, Command[][]> = { blue: [], red: [] };
    for (let t = 0; t < 12; t++) {
      for (const [ls, side] of [[a, "blue"], [b, "red"]] as const) {
        const cmds = tryStep(ls, () => (t === 0 ? [raw[side]] : []));
        if (cmds) stepped[side].push(cmds);
      }
      exchange();
    }
    expect(stepped.blue).toEqual(stepped.red);
    const ctx = { width: 56, height: 56 };
    expect(stepped.blue[4]).toEqual([...canonicalize(raw.blue, { ...ctx, local: "blue" }), ...canonicalize(raw.red, { ...ctx, local: "red" })]);
    expect(stepped.blue[4]![0]).toEqual({ type: "move", faction: "blue", unitIds: [3, 9], x: 161.5 / 16, y: 124.5 / 16 });
    expect(stepped.blue[4]![1]!.faction).toBe("red");
    expect(a.turns()).toEqual(b.turns());
    expect(a.turns()).toEqual([[4, "blue", [stepped.blue[4]![0]]], [4, "red", [stepped.blue[4]![1]]]]);
    expect(a.trail()).toBe(b.trail());
  });

  it("keeps every frame within capacity, and queued orders go out as acks come back", () => {
    const { a, b, exchange, sizes } = wire({ delay: 4 });
    // 40 orders at once, many of them long lists: far more than one frame holds
    const burst: Command[] = [];
    for (let i = 0; i < 40; i++)
      burst.push(
        i % 3 === 0
          ? { type: "attackMove", faction: "blue", unitIds: Array.from({ length: 30 }, (_, j) => 300 + i * 50 + j * 7), x: i + 0.3, y: 20.7 }
          : i % 3 === 1
            ? { type: "produce", faction: "blue", buildingId: 100 + i, unit: "scout" }
            : { type: "rally", faction: "blue", buildingId: 3, x: i * 1.1, y: 4.4 }
      );
    const want = burst.flatMap((c) => canonicalize(c, { local: "blue", ...MAP }));
    expect(want.length).toBeGreaterThan(55);
    let maxQueued = 0;
    for (let t = 0; t < 400; t++) {
      tryStep(a, () => (t === 0 ? burst : []));
      tryStep(b);
      maxQueued = Math.max(maxQueued, a.status().queued);
      // acks come back three ticks later, as over the air
      if (t % 3 === 0) exchange();
    }
    expect(maxQueued).toBeGreaterThan(30);
    expect(a.status().queued).toBe(0);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(188);
    const got = b.turns().filter(([, side]) => side === "blue");
    for (const [, , cmds] of got) {
      expect(cmds.length).toBeLessThanOrEqual(15);
      expect(cmds.reduce((n, c) => n + commandBits(c, MAP), 0)).toBeLessThanOrEqual(a.turnMax);
    }
    expect(got.flatMap(([, , cmds]) => cmds)).toEqual(want);
    expect(a.trail()).toBe(b.trail());
  });

  it("takes only game frames it can trust", () => {
    const { a } = wire({ delay: 4 });
    const before = a.status();
    const lobby = new Uint8Array(24);
    lobby[0] = 0b10000000;
    expect(a.receive(lobby, 188, 0)).toBe("lobby");
    expect(a.status().peerInLobby).toBe(true);
    expect(a.receive(new Uint8Array(24), 188, 0)).toBe("invalid"); // (all zeros: no payload yet)
    expect(a.receive(new Uint8Array(24).fill(255), 188, 0)).toBe("invalid");
    expect(a.status().framesBad).toBe(0);
    const ok = rawFrame({ to: 3 });
    expect(a.receive(ok.bits, 188, 0)).toBe("game");
    expect(a.status().peerInLobby).toBe(false);
    const bad = [
      { ...rawFrame({ to: 3 }), nbits: 20 }, // truncated
      rawFrame({ to: 3 + 201 }), // `to` too far from the last one
      rawFrame({ to: 70, span: 65 }), // span > 64
      rawFrame({ to: 3, span: 5 }), // from < 0
      rawFrame({ to: 10, span: 2, nonEmpty: 4 }) // more non-empty turns than turns
    ];
    for (const f of bad) expect(a.receive(f.bits, f.nbits, 0)).toBe("invalid");
    const after = a.status();
    expect(after.framesBad).toBe(bad.length);
    expect([after.ackThrough, after.peerAck, after.newestSealed]).toEqual([before.ackThrough, before.peerAck, before.newestSealed]);
    // a `to` past 65535 unwraps to the value nearest the last one
    expect(unwrap16(5, 65530)).toBe(65541);
    expect(unwrap16(65530, 5)).toBe(-6);
    expect(unwrap16(1234, 1234 + 65536 * 3)).toBe(1234 + 65536 * 3);
  });

  it("is unharmed by duplicate, stale and reordered frames", () => {
    const { a, b, advance } = wire({ delay: 5 });
    const old: { bits: Uint8Array; nbits: number }[] = [];
    let seed = 5;
    const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
    for (let t = 0; t < 600; t++) {
      tryStep(a, () => (t % 7 === 0 ? [{ type: "attackMove", faction: "blue", unitIds: [t, t + 2], x: t % 50, y: 3 }] : []));
      tryStep(b, () => (t % 5 === 0 ? [{ type: "produce", faction: "red", buildingId: t, unit: "wasp" }] : []));
      const fb = b.frame();
      old.push(fb);
      // a hears b's frames late, twice, and now and then one from the past
      if (rnd() < 0.7) {
        const f = old[Math.max(0, old.length - 1 - Math.floor(rnd() * 4))]!;
        a.receive(f.bits, f.nbits, t * 100);
        a.receive(f.bits, f.nbits, t * 100);
      }
      if (rnd() < 0.2) {
        const f = old[Math.floor(rnd() * old.length)]!;
        a.receive(f.bits, f.nbits, t * 100);
      }
      const fa = a.frame();
      if (rnd() < 0.7) b.receive(fa.bits, fa.nbits, t * 100);
      advance(100);
    }
    expect(a.status().tick).toBeGreaterThan(300);
    const n = Math.min(a.status().tick, b.status().tick);
    const upTo = (ls: Lockstep) => ls.turns().filter(([t]) => t < n);
    expect(upTo(a)).toEqual(upTo(b));
    // (frames from more than 200 turns ago are rejected, harmlessly)
    expect(a.status().framesBad).toBeGreaterThan(0);
  });

  it("pauses locally: frames say so, nothing is sealed, and the peer stalls within D ticks", () => {
    const { a, b, exchange } = wire({ delay: 4 });
    for (let t = 0; t < 20; t++) {
      tryStep(a);
      tryStep(b);
      exchange();
    }
    a.setPaused(true);
    let drained = 0;
    const sealed = a.status().newestSealed;
    for (let t = 0; t < 30; t++) {
      expect(tryStep(a, () => (drained++, []))).toBeNull();
      tryStep(b);
      exchange();
    }
    expect(drained).toBe(0);
    expect(a.status().newestSealed).toBe(sealed);
    const f = a.frame();
    expect(readGameFrame(f.bits, f.nbits, MAP, "blue", sealed).paused).toBe(true);
    const sb = b.status();
    expect(sb).toMatchObject({ stalled: true, peerPaused: true });
    expect(sb.tick - a.status().tick).toBeLessThanOrEqual(4 + 1);
    a.setPaused(false);
    for (let t = 0; t < 30; t++) {
      tryStep(a);
      tryStep(b);
      exchange();
    }
    expect(b.status().peerPaused).toBe(false);
    expect(a.status().tick).toBeGreaterThan(40);
    expect(a.turns()).toEqual(b.turns());
  });

  it("balances the two phones' slack, at 1× on average", () => {
    const { a, b, exchange } = wire({ delay: 6 });
    expect(a.speed()).toBe(1); // (no peer frame yet)
    // b runs ahead: it holds fewer of a's turns than a holds of b's
    for (let t = 0; t < 2; t++) {
      tryStep(b);
      exchange();
    }
    exchange(); // (each now holds the other's current slack)
    const sa = a.status();
    const sb = b.status();
    expect(sa.peerSlack).toBe(sb.slack);
    expect(a.speed()).toBeCloseTo(1 + 0.02 * (sa.slack - sb.slack), 12);
    expect(a.speed()).toBeGreaterThan(1);
    expect(a.speed() + b.speed()).toBeCloseTo(2, 12);
    // (clamped to ±10%)
    for (let t = 0; t < 4; t++) {
      tryStep(b);
      exchange();
    }
    exchange();
    expect([a.speed(), b.speed()]).toEqual([1.1, 0.9]);
    expect(rxqOf(null)).toBe(0);
    expect([-3, 0, 8.9, 9, 20, 21, 99].map(rxqOf)).toEqual([0, 0, 2, 3, 6, 7, 7]);
  });

  it("ends both phones as desync when a checkpoint differs", () => {
    const { a, b, exchange } = wire({ delay: 4 });
    // a's world drifts at tick 120: its trail differs from then on
    const drift = (t: number) => hash32(t, 77) ^ (t >= 120 ? 1 : 0);
    for (let i = 0; i < 300 && !(a.over() && b.over()); i++) {
      tryStep(a, undefined, drift);
      tryStep(b);
      exchange();
    }
    for (const s of [a.status(), b.status()]) expect(s.desync).toBe(true);
    expect([a.status().desyncReason, b.status().desyncReason]).toContain("checkpoint");
    expect(Math.max(a.status().tick, b.status().tick)).toBeLessThanOrEqual(150 + 4 + 2);
    // and the debug trails show where
    expect(a.debug().own.map(([t]) => t)).toEqual([0, 50, 100, 150].filter((t) => t < a.status().tick));
  });

  it("checks the end: in sync, out of sync, one-sided, unanswered", () => {
    const end = (o: { hashA?: (t: number) => number; decidedA: (t: number) => boolean; decidedB: (t: number) => boolean; deaf?: boolean }) => {
      const w = wire({ delay: 4 });
      for (let i = 0; i < 200; i++) {
        tryStep(w.a, undefined, o.hashA, o.decidedA);
        tryStep(w.b, undefined, undefined, o.decidedB);
        // (deaf: a stops hearing b once a's world is decided)
        w.exchange(o.deaf && w.a.status().end === "decided" ? "ab" : "both");
        w.advance(100);
      }
      return [w.a.status(), w.b.status()] as const;
    };
    const at = (T: number) => (t: number) => t === T;
    // both decided at 70 with equal trails
    let [sa, sb] = end({ decidedA: at(70), decidedB: at(70) });
    expect([sa.endCheck, sb.endCheck]).toEqual(["ok", "ok"]);
    expect(sa).toMatchObject({ end: "decided", peerEnd: "decided", desync: false, decided: { tick: 70, winner: "blue" } });
    // both decided at 70, but the worlds drifted at 60 (after the last checkpoint)
    [sa, sb] = end({ hashA: (t) => hash32(t, 77) + (t >= 60 ? 1 : 0), decidedA: at(70), decidedB: at(70) });
    expect([sa.desync, sb.desync]).toEqual([true, true]);
    expect([sa.endCheck, sb.endCheck]).toEqual(["mismatch", "mismatch"]);
    expect(sa.desyncReason).toBe("end");
    // only a's world is decided at 70: b steps 70 without a decision
    [sa, sb] = end({ decidedA: at(70), decidedB: () => false });
    expect([sa.desync, sb.desync]).toEqual([true, true]);
    expect(sb.desyncReason).toBe("end");
    expect(sa.desyncReason).toBe("peer");
    // a never hears b's end report: "Not verified" after 10 s
    [sa, sb] = end({ decidedA: at(70), decidedB: at(70), deaf: true });
    expect(sa.endCheck).toBe("unverified");
    expect(sb.endCheck).toBe("ok");
    expect(END_CHECK_MS).toBe(10_000);
  });

  it("gets the end report through when the turns around the decision are full", () => {
    const T = 70;
    // as many orders as a turn takes: the window rule fills turn tick + D almost to TURN_MAX
    const many = (): Command[] =>
      Array.from({ length: 15 }, (_, j): Command => ({ type: "produce", faction: "blue", buildingId: 1000 + j, unit: "scout" }));
    // the full turn is T + D (past the decision: no one steps it) or T itself (the peer needs it to check the end)
    for (const fullTurn of [T + 4, T])
      for (const oneSided of [false, true]) {
        const { a, b, exchange, advance } = wire({ delay: 4 });
        let endless = 0; // (a's frames after its decision that had to leave the end report out)
        let filled = 0; // (the orders the full turn took)
        for (let i = 0; i < 200; i++) {
          const before = a.status().tick;
          tryStep(a, () => (a.status().tick === fullTurn - 4 ? many() : []), undefined, (t) => t === T);
          if (before === fullTurn - 4) filled = 15 - a.status().queued;
          tryStep(b, undefined, undefined, (t) => !oneSided && t === T);
          if (a.status().decided && a.status().end === "decided") {
            const f = a.frame();
            const g = readGameFrame(f.bits, f.nbits, MAP, "blue", a.status().newestSealed);
            if (g.end === "playing") endless++;
            // (past the decision every turn is described as empty)
            for (const [turn] of g.turns) expect(turn).toBeLessThanOrEqual(T);
          }
          exchange();
          advance(100);
        }
        const [sa, sb] = [a.status(), b.status()];
        const label = `full turn ${fullTurn}, ${oneSided ? "one-sided" : "in sync"}`;
        // the turn really was full (and when it's T, the peer stepped it)
        expect(filled, label).toBeGreaterThanOrEqual(3);
        if (fullTurn === T) expect(b.turns().find(([t, side]) => t === T && side === "blue")?.[2].length, label).toBe(filled);
        expect(endless, label).toBeLessThanOrEqual(3);
        if (!oneSided) {
          expect([sa.endCheck, sb.endCheck], label).toEqual(["ok", "ok"]);
          expect([sa.peerEnd, sb.peerEnd], label).toEqual(["decided", "decided"]);
        } else {
          // b steps T without a decision, hears a's report and ends, instead of stalling for good at T + D + 1
          expect([sa.desync, sb.desync], label).toEqual([true, true]);
          expect([sa.desyncReason, sb.desyncReason], label).toEqual(["peer", "end"]);
          expect([sa.endCheck, sb.endCheck], label).toEqual(["mismatch", "mismatch"]);
          expect(sb.tick, label).toBe(T + 1);
          expect(b.over(), label).toBe(true);
        }
      }
  });

  it("can't be pushed out of step by garbage frames that pass the CRC", () => {
    const { a, b, exchange } = wire({ delay: 4 });
    for (let t = 0; t < 100; t++) {
      tryStep(a);
      tryStep(b);
      exchange();
    }
    // frames 150 turns apart, each within 200 of the one before it: had each moved the expectation, the real
    // ones would be out of reach (`to` is expected near ackThrough, which only turns taken move)
    const { ackThrough, peerAck } = a.status();
    const got = [150, 300, 450].map((d) => {
      const f = rawFrame({ to: ackThrough + d, ack: peerAck - (ackThrough + d) });
      return a.receive(f.bits, f.nbits, 0);
    });
    expect(got).toEqual(["game", "invalid", "invalid"]);
    expect(a.status()).toMatchObject({ ackThrough, peerAck, framesBad: 2 });
    for (let t = 0; t < 300; t++) {
      tryStep(a);
      tryStep(b);
      exchange();
    }
    expect(a.status()).toMatchObject({ tick: 400, framesBad: 2, stalled: false });
    expect(b.status().tick).toBe(400);
  });

  describe("the order queue", () => {
    /** Blue's commands as the peer stepped them, [tick, command], over a wire where blue drains orders(tick) and frames cross every tick. */
    const blueSteps = (orders: (tick: number) => Command[], ticks = 150) => {
      const { a, b, exchange } = wire({ delay: 4 });
      for (let i = 0; i < ticks; i++) {
        tryStep(a, () => orders(a.status().tick));
        tryStep(b);
        exchange();
      }
      expect(a.status().queued).toBe(0);
      expect(a.turns()).toEqual(b.turns());
      return b.turns().flatMap(([t, side, cmds]) => (side === "blue" ? cmds.map((c) => [t, c] as const) : []));
    };
    const U = Array.from({ length: 30 }, (_, i) => 400 + i * 41); // (5 pieces)
    const F = Array.from({ length: 30 }, (_, i) => 3000 + i * 41); // (filler: keeps the window busy for a few ticks)
    const move = (unitIds: number[], x: number): Command => ({ type: "move", faction: "blue", unitIds, x, y: 10 });
    const idsOf = (cs: readonly Command[]) => cs.flatMap((c) => ("unitIds" in c ? c.unitIds : []));
    const at = (x: number) => (c: Command) => c.type === "move" && Math.floor(c.x) === x;

    it("lets a newer move replace the queued pieces of an older one, the longest waiting first", () => {
      const steps = blueSteps((t) => (t === 0 ? [move(U, 10)] : t === 1 ? [move(U, 20)] : []));
      const first = steps.map(([, c]) => c).filter(at(10));
      const second = steps.map(([, c]) => c).filter(at(20));
      const pieces = canonicalize(move(U, 10), { local: "blue", ...MAP }).length;
      // only what went out before the second order: its other pieces were dropped
      expect(first.length).toBeGreaterThan(0);
      expect(first.length).toBeLessThan(pieces);
      // every unit gets the second order, the ones that lost the first one before the rest
      const sent = new Set(idsOf(first));
      expect(idsOf(second)).toEqual([...U.filter((id) => !sent.has(id)), ...U.filter((id) => sent.has(id))]);
    });

    it("keeps a queued order when anything queued after it names one of its units", () => {
      const board: Command = { type: "board", faction: "blue", unitIds: [U[29]!], carrierId: 7 };
      const steps = blueSteps((t) => (t === 0 ? [move(U, 10), board] : t === 1 ? [move(U, 20)] : [])).map(([, c]) => c);
      const firstWith = (pred: (c: Command) => boolean) => steps.findIndex((c) => pred(c) && idsOf([c]).includes(U[29]!));
      // the piece of the first move that names the boarding unit still goes out, then the board, then the second move
      expect(firstWith(at(10))).toBeGreaterThanOrEqual(0);
      expect(firstWith(at(10))).toBeLessThan(steps.indexOf(steps.find((c) => c.type === "board")!));
      expect(steps.findIndex((c) => c.type === "board")).toBeLessThan(firstWith(at(20)));
      expect(new Set(idsOf(steps.filter(at(20))))).toEqual(new Set(U));
    });

    it("replaces only what the sim overrides outright", () => {
      const V = [5, 6];
      const order = (type: Command["type"], tag: number): Command => {
        switch (type) {
          case "move":
          case "attackMove":
          case "harvest":
            return { type, faction: "blue", unitIds: V, x: tag, y: 3 };
          case "attack":
            return { type, faction: "blue", unitIds: V, targetId: tag };
          case "unload":
            return { type, faction: "blue", unitIds: V, x: tag, y: 3 };
          case "stop":
          case "anchor":
            return { type, faction: "blue", unitIds: V };
          default:
            throw new Error(type);
        }
      };
      const cases: [Command["type"], Command["type"], boolean][] = [
        ["move", "move", true], ["attack", "move", true], ["harvest", "attackMove", true], ["stop", "move", true],
        ["move", "attackMove", true], ["stop", "stop", true], ["attack", "attack", true],
        // a stop doesn't pack an anchored Goliath up, an attack leaves a lift's destination, a harvest may not apply
        ["move", "stop", false], ["move", "attack", false], ["attackMove", "attack", false], ["harvest", "harvest", false],
        ["anchor", "move", false], ["unload", "move", false]
      ];
      for (const [older, newer, replaced] of cases) {
        const steps = blueSteps((t) => (t === 0 ? [move(F, 30), order(older, 11)] : t === 1 ? [order(newer, 22)] : []), 60).map(([, c]) => c);
        const olders = steps.filter((c) => c.type === older && idsOf([c]).join() === V.join());
        expect(olders.length - (older === newer ? 1 : 0), `${older} then ${newer}`).toBe(replaced ? 0 : 1);
      }
      // and only when the newer one names every unit of the queued one
      const steps = blueSteps((t) => (t === 0 ? [move(F, 30), move([5, 6, 7], 11)] : t === 1 ? [move([5, 6], 22)] : []), 60).map(([, c]) => c);
      expect(steps.filter(at(11)).length).toBe(1);
    });

    it("puts a resign first: it lands D ticks later, whatever is waiting", () => {
      const steps = blueSteps((t) => (t === 0 ? [move(F, 30), move(U, 31)] : t === 2 ? [{ type: "resign", faction: "blue" }] : []));
      const resignAt = steps.find(([, c]) => c.type === "resign")![0];
      expect(resignAt).toBe(2 + 4);
      expect(steps.filter(([t, c]) => c.type === "move" && t > resignAt).length).toBeGreaterThan(3);
    });
  });

  it("tells the peer when this phone leaves or aborts", () => {
    for (const reason of ["left", "desync"] as const) {
      const { a, b, exchange } = wire({ delay: 4 });
      for (let t = 0; t < 30; t++) {
        tryStep(a);
        tryStep(b);
        exchange();
      }
      a.leave(reason);
      expect(a.over()).toBe(true);
      expect(tryStep(a)).toBeNull();
      exchange();
      const sb = b.status();
      expect(sb.peerEnd).toBe(reason);
      expect(b.over()).toBe(true);
      expect(tryStep(b)).toBeNull();
      expect(sb.desync).toBe(reason === "desync");
      if (reason === "desync") expect(sb.desyncReason).toBe("peer");
      // (a desync stays a desync: leaving afterwards still says so)
      a.leave("left");
      expect(a.status().end).toBe(reason);
    }
  });
});

// ------------------------------------------------------------- PacketAir ---

/** A 10-bit frame: type then a byte. */
const tiny = (type: number, v: number) => {
  const wr = new BitWriter();
  wr.bits(type, 2);
  wr.bits(v, 8);
  return wr;
};
const byteOf = (p: { bits: Uint8Array }) => ((p.bits[0]! << 2) | (p.bits[1]! >> 6)) & 0xff;

describe("PacketAir", () => {
  it("sends the newest payload every period at each end's own phase, and delivers it after the latency", () => {
    const air = new PacketAir({ mode: "fast", phaseMs: [10, 60], clockOffsetMs: [0, 5000] });
    expect([air.a.capacity(), air.b.capacity()]).toEqual([188, 188]);
    air.a.send(tiny(2, 1).bytes(), 10);
    air.advance(95);
    air.a.send(tiny(2, 2).bytes(), 10); // (latched by the next packet, at 110)
    air.advance(400);
    expect(air.a.slots()).toEqual([10, 110, 210, 310, 410]);
    expect(air.b.slots()).toEqual([5060, 5160, 5260, 5360, 5460]); // (on b's own clock)
    const got = air.b.poll();
    expect(got.map((p) => p.at)).toEqual([5260, 5360, 5460]);
    expect(got.map(byteOf)).toEqual([1, 2, 2]);
    // as the modem delivers it: the whole payload, zero-padded
    for (const p of got) {
      expect(p).toMatchObject({ nbits: 188, session: false, snrDb: 30 });
      expect(p.bits.length).toBe(24);
      expect([...p.bits.slice(2)].every((b) => b === 0)).toBe(true);
    }
    expect(air.a.poll()).toEqual([]); // (b never sent anything)
    expect(() => air.a.send(new Uint8Array(30), 189)).toThrow(RangeError);
    // a mode change takes effect at the next packet
    air.a.setMode("robust");
    air.advance(1000);
    expect(air.a.slots()).toEqual([510, 710, 910, 1110, 1310]);
    expect(air.a.stats()).toMatchObject({ txMode: "robust", plan: "high" });
    expect(air.b.stats()).toMatchObject({ rxMode: "robust", rxOk: 9, rxBad: 0, locked: true }); // (the starts up to 1245 have arrived)
  });

  it("drops game frames between ends whose session keys differ", () => {
    const deliver = (ka: [number, number] | null, kb: [number, number] | null) => {
      const air = new PacketAir({ mode: "fast", latencyMs: 0 });
      if (ka) air.a.setSessionKey(...ka);
      if (kb) air.b.setSessionKey(...kb);
      air.a.send(tiny(1, 9).bytes(), 10); // a game frame
      air.b.send(tiny(2, 9).bytes(), 10); // a lobby frame
      air.advance(1000);
      return [air.b.poll().map((p) => p.session), air.a.poll().map((p) => p.session)];
    };
    const ten = (v: boolean) => Array.from({ length: 10 }, () => v);
    expect(deliver([1, 2], [1, 2])).toEqual([ten(true), ten(false)]);
    expect(deliver([1, 2], [1, 3])).toEqual([[], ten(false)]); // (lobby frames always pass)
    expect(deliver([1, 2], null)).toEqual([[], ten(false)]);
    expect(deliver(null, null)).toEqual([ten(false), ten(false)]);
  });

  it("loses packets as seeded: Bernoulli, bursts and outages", () => {
    const losses = (o: PacketAirOptions, ms = 200_000) => {
      const air = new PacketAir({ mode: "fast", latencyMs: 0, phaseMs: [0, 50], ...o });
      air.a.send(tiny(2, 0).bytes(), 10);
      const got: boolean[] = [];
      for (let t = 0; t < ms; t += 100) {
        air.advance(100);
        got.push(air.b.poll().length > 0);
      }
      return got;
    };
    const p30 = losses({ loss: 0.3, seed: 5 });
    const rate = p30.filter((ok) => !ok).length / p30.length;
    expect(rate).toBeGreaterThan(0.27);
    expect(rate).toBeLessThan(0.33);
    expect(losses({ loss: 0.3, seed: 5 })).toEqual(p30);
    expect(losses({ loss: 0.3, seed: 6 })).not.toEqual(p30);
    // Gilbert–Elliott: losses come in runs
    const ge = losses({ burst: { pGoodToBad: 0.02, pBadToGood: 0.25 }, seed: 5 });
    let runs = 0;
    let lost = 0;
    ge.forEach((ok, i) => {
      if (!ok) lost++;
      if (!ok && (i === 0 || ge[i - 1])) runs++;
    });
    expect(lost / runs).toBeGreaterThan(3);
    // an outage cuts one way only
    const air = new PacketAir({ mode: "fast", latencyMs: 250 });
    air.a.send(tiny(2, 0).bytes(), 10);
    air.b.send(tiny(2, 0).bytes(), 10);
    air.advance(1000);
    air.a.poll();
    air.b.poll();
    air.outage(3000, "ab");
    air.advance(3000);
    expect(air.b.poll().length).toBe(2); // (the packets already in the air)
    expect(air.a.poll().length).toBe(30);
    expect(air.b.stats().rxBad).toBe(30);
    air.advance(1000);
    expect(air.b.poll().length).toBeGreaterThan(5);
    // a closed end stops sending and hearing
    air.a.slots();
    air.a.close();
    air.advance(1000);
    expect(air.a.slots().length).toBe(0);
    expect(air.a.poll()).toEqual([]);
    const landed = air.b.poll().length; // (what was already in the air still lands: 250 ms of 100 ms packets)
    expect(landed >= 2 && landed <= 3).toBe(true);
    air.advance(1000);
    expect(air.b.poll()).toEqual([]);
  });
});

// ------------------------------------------------- two worlds over the air ---

interface Phone {
  side: Faction;
  w: World;
  /** null: a human, whose orders the scenario injects through `extra`. */
  ai: AiState | null;
  ls: Lockstep;
  link: LinkTransport;
  acc: number;
  last: number;
  next: number;
  frameMs: number;
  sent: number;
  /** The trail after each tick stepped. */
  trails: number[];
  /** [tick, worldHash] every 100 ticks, as a battle record keeps them. */
  hashes: [number, string][];
  /** Extra orders the scenario injects, drained with the AI's. */
  extra: Command[];
  paused: boolean;
  sawPeerPaused: boolean;
  maxFrame: number;
  desyncAt: number | null;
  /** The most orders queued, and the longest an order waited in the queue (ticks), seen after any update before the end. */
  maxQueued: number;
  maxQueuedTicks: number;
}

interface Run {
  air: PacketAir;
  setup: MatchSetup;
  blue: Phone;
  red: Phone;
}

interface Scenario {
  map: string;
  seed: number;
  mutators?: MutatorId[];
  /** Blue's and red's AI; null for a human. */
  strategies?: [StrategyName | null, StrategyName | null];
  delay?: number;
  /** Each phone steps at most this far. */
  ticks: number;
  air?: PacketAirOptions;
  /** Every 2 ms of air time. */
  every?: (r: Run) => void;
  /** After a phone steps a tick. */
  afterStep?: (p: Phone, tick: number, r: Run) => void;
  /** Run until this holds (default: both phones at `ticks`, or over). */
  until?: (r: Run) => boolean;
  /** Changes made to both worlds alike before the match starts (folded into the setup hash). */
  prepare?: (w: World) => void;
}

/** Two phones, each with its own world, AI and Lockstep, joined by PacketAir; each phone's AI orders only its own side. */
function duel(s: Scenario): Run {
  const [bs, rs] = s.strategies ?? ["balanced", "rush"];
  const mutators = s.mutators ?? [];
  const probe = setupWorld({ map: s.map, seed: s.seed, mutators, openers: {} });
  const openers: Partial<Record<Faction, OpenerId>> = {};
  for (const [side, strat] of [["blue", bs], ["red", rs]] as const) {
    const o = allowedOpener(probe, side, pickAiOpener(strat ?? "balanced", s.seed, side));
    if (o) openers[side] = o;
  }
  const setup: MatchSetup = { map: s.map, seed: s.seed, mutators, openers };
  const air = new PacketAir({ seed: s.seed, mode: "fast", clockOffsetMs: [0, 987_654], ...s.air });
  air.a.setSessionKey(4242, 777);
  air.b.setSessionKey(4242, 777);
  const phone = (side: Faction, link: LinkTransport, strat: StrategyName | null, frameMs: number, phase: number): Phone => {
    const w = setupWorld(setup);
    s.prepare?.(w);
    return {
      side, w, link, frameMs,
      // (normal difficulty only: tickAi writes incomeMult, and normal's is the default both worlds have)
      ai: strat && createAiState(strat, "normal", hash32(s.seed, side === "blue" ? 1 : 2)),
      ls: new Lockstep({ local: side, delay: s.delay ?? 5, mapWidth: w.width, mapHeight: w.height, capacity: link.capacity(), setupHash: parseInt(worldHash(w), 16), now: () => link.now() }),
      acc: 0, last: 0, next: phase, sent: 0, trails: [], hashes: [], extra: [], paused: false, sawPeerPaused: false, maxFrame: 0, desyncAt: null,
      maxQueued: 0, maxQueuedTicks: 0
    };
  };
  const r: Run = { air, setup, blue: phone("blue", air.a, bs, 16, 3), red: phone("red", air.b, rs, 11, 0) };
  const done = s.until ?? ((r: Run) => [r.blue, r.red].every((p) => p.w.tick >= s.ticks || p.ls.over()));
  const limit = s.ticks * 100 * 3 + 60_000;
  while (!done(r) && air.now() < limit) {
    air.advance(2);
    s.every?.(r);
    for (const p of [r.blue, r.red]) update(p, r, s);
  }
  expect(air.now(), "the scenario ran out of time").toBeLessThan(limit);
  return r;
}

/** One phone's frame: take the packets, step the ticks the clock allows (stalling when the peer's turn is missing), send a new frame. */
function update(p: Phone, r: Run, s: Scenario): void {
  const now = r.air.now();
  if (now < p.next) return;
  const dt = now - p.last;
  p.last = now;
  p.next = now + p.frameMs;
  for (const pk of p.link.poll()) p.ls.receive(pk.bits, pk.nbits, pk.at);
  if (!p.paused) p.acc += dt * p.ls.speed();
  for (let n = 0; p.acc >= 100 && n < 8 && p.w.tick < s.ticks; n++) {
    const t = p.w.tick;
    const cmds = p.ls.commandsFor(t, () => [...(p.ai ? tickAi(p.w, p.side, p.ai) : []), ...p.extra.splice(0)]);
    if (!cmds) {
      p.acc = 99.9; // (GameScene: hold the pose, no catch-up burst)
      break;
    }
    step(p.w, cmds);
    p.ls.afterStep(t, parseInt(worldHash(p.w), 16), p.w.winner ? { winner: p.w.winner, resigned: p.w.resigned } : null);
    p.trails[t] = p.ls.trail();
    if (p.w.tick % 100 === 0) p.hashes.push([p.w.tick, worldHash(p.w)]);
    p.acc -= 100;
    s.afterStep?.(p, t, r);
    if (p.w.winner) break; // (GameScene stops stepping a decided world)
  }
  const st = p.ls.status();
  if (!p.ls.over()) {
    p.maxQueued = Math.max(p.maxQueued, st.queued);
    p.maxQueuedTicks = Math.max(p.maxQueuedTicks, st.queuedTicks);
  }
  if (st.stalled && st.peerPaused) p.sawPeerPaused = true;
  if (st.desync && p.desyncAt === null) p.desyncAt = p.w.tick;
  const f = p.ls.frame();
  if (f.version !== p.sent) {
    p.link.send(f.bits, f.nbits); // (throws past capacity)
    p.sent = f.version;
    p.maxFrame = Math.max(p.maxFrame, f.nbits);
  }
}

/** The first tick below `n` whose trails differ (−1: none). */
function firstDiff(r: Run, n: number): number {
  for (let t = 0; t < n; t++) if (r.blue.trails[t] === undefined || r.blue.trails[t] !== r.red.trails[t]) return t;
  return -1;
}

/** The match as a battle record, from the turns one phone stepped. */
function recordOf(r: Run, p: Phone): BattleRecord {
  const w = p.w;
  return {
    v: 1, commit: null, sim: null, created: "2026-10-19T00:00:00.000Z",
    map: r.setup.map, mutators: r.setup.mutators, seed: r.setup.seed, round: 1, maxTicks: w.tick, openers: r.setup.openers,
    seats: { blue: { player: "sound-duel:host" }, red: { player: "sound-duel:guest" } },
    frames: "own", turns: p.ls.turns(), radio: [], hashes: p.hashes, log: [], tick: w.tick,
    end: w.winner ? endOf(w.tick, w.winner, w.resigned) : null, usage: {}
  };
}

function expectReplays(r: Run, p: Phone): void {
  const rec = parseRecord(JSON.stringify(recordOf(r, p)));
  const res = replay(rec);
  expect(res.divergedAt).toBeNull();
  expect(res.checked).toBe(p.hashes.length);
  expect(worldHash(res.world)).toBe(worldHash(p.w));
}

const FIVE_MINUTES = 3000;

describe("two phones in lockstep over PacketAir, an AI on each", () => {
  it("keep identical hash trails at 0% loss, and the battle record replays", { timeout: 120_000 }, () => {
    const r = duel({ map: "riverlands", seed: 42, ticks: FIVE_MINUTES });
    expect(firstDiff(r, FIVE_MINUTES)).toBe(-1);
    for (const p of [r.blue, r.red]) {
      const s = p.ls.status();
      expect(p.w.tick).toBe(FIVE_MINUTES);
      expect(s.stallMs).toBeLessThanOrEqual(300);
      expect(s.framesBad).toBe(0);
      expect(s.desync).toBe(false);
      expect(p.maxFrame).toBeLessThanOrEqual(188);
    }
    expect(worldHash(r.blue.w)).toBe(worldHash(r.red.w));
    expect(r.blue.ls.turns()).toEqual(r.red.ls.turns());
    expect(r.blue.ls.turns().length).toBeGreaterThan(200);
    expectReplays(r, r.red);
  });

  for (const [loss, map, seed, mutators, strategies, delay, stall] of [
    [0.1, "archipelago", 7, ["airborne"], ["airswarm", "boom"], 5, 3_000],
    [0.3, "ashlands", 3, ["nomads"], ["ironclad", "balanced"], 6, 12_000]
  ] as const)
    it(`keep identical hash trails at ${loss * 100}% loss`, { timeout: 120_000 }, () => {
      const r = duel({ map, seed, mutators: [...mutators], strategies: [...strategies], delay, ticks: FIVE_MINUTES, air: { loss } });
      expect(firstDiff(r, FIVE_MINUTES)).toBe(-1);
      for (const p of [r.blue, r.red]) {
        expect(p.w.tick).toBe(FIVE_MINUTES);
        expect(p.ls.status().stallMs).toBeLessThanOrEqual(stall);
        expect(p.ls.status().desync).toBe(false);
      }
    });

  it("keep identical hash trails through 3 s dropouts and burst loss", { timeout: 120_000 }, () => {
    const cuts: [number, "both" | "ab" | "ba"][] = [[60_000, "both"], [150_000, "ab"], [240_000, "ba"]];
    const r = duel({
      map: "random-volcanic-k3x9a", seed: 9, mutators: ["veterans", "goldrush"], strategies: ["rush", "boom"], ticks: FIVE_MINUTES,
      air: { burst: { pGoodToBad: 0.02, pBadToGood: 0.3 } },
      every: (r) => {
        while (cuts.length && r.air.now() >= cuts[0]![0]) r.air.outage(3000, cuts.shift()![1]);
      }
    });
    expect(firstDiff(r, FIVE_MINUTES)).toBe(-1);
    expect([r.blue.w.tick, r.red.w.tick]).toEqual([FIVE_MINUTES, FIVE_MINUTES]);
    const stalls = [r.blue, r.red].map((p) => p.ls.status().stallMs);
    expect(Math.max(...stalls)).toBeGreaterThan(2500); // (the dropouts really stalled the match)
    for (const s of stalls) expect(s).toBeLessThanOrEqual(25_000);
  });

  it("keep identical hash trails with bursts of 30-unit orders", { timeout: 120_000 }, () => {
    // burst n's orders go to cells of their own: tile column n, at the 1/16-tile rows MOVE_ROW and ATTACK_ROW
    const MOVE_ROW = Math.floor((20 + Math.E / 7) * 16);
    const ATTACK_ROW = Math.floor(41.0001 * 16);
    const bursts: Record<Faction, { at: number; ids: number[] }[]> = { blue: [], red: [] };
    const cellOf = (c: Command) => ("x" in c && c.x !== undefined && c.y !== undefined ? { n: Math.floor(c.x), row: Math.floor(c.y * 16) } : null);
    const r = duel({
      map: "riverlands", seed: 8, strategies: ["balanced", "balanced"], delay: 4, ticks: FIVE_MINUTES,
      afterStep: (p, t) => {
        if (t % 100 !== 50 || t > FIVE_MINUTES - 300) return;
        // a select-all order: every unit of this side, padded with ids nobody owns (sparse, as a long match's
        // ids are: wrecks, crates and effects share the counter), raw float coordinates
        const mine = [...p.w.units.values()].filter((u) => u.faction === p.side).map((u) => u.id);
        const ids = [...mine, ...Array.from({ length: 30 }, (_, i) => 5000 + 40 * t + 37 * i)].slice(0, 30).reverse();
        const n = bursts[p.side].length;
        bursts[p.side].push({ at: t, ids });
        // (an attackMove, which the move right after it replaces in the queue, then the move)
        p.extra.push({ type: "attackMove", faction: p.side, unitIds: ids, x: n + 0.37, y: 41.0001 });
        p.extra.push({ type: "move", faction: p.side, unitIds: ids, x: n + Math.PI / 10, y: 20 + Math.E / 7 });
      }
    });
    expect(bursts.blue.length + bursts.red.length).toBeGreaterThan(40);
    expect(firstDiff(r, FIVE_MINUTES)).toBe(-1);
    for (const p of [r.blue, r.red]) {
      const s = p.ls.status();
      expect(p.w.tick).toBe(FIVE_MINUTES);
      expect(p.maxFrame).toBeLessThanOrEqual(188);
      expect(s.queued).toBe(0); // (every burst went out)
      expect(s.stallMs).toBeLessThanOrEqual(3_000);
      const stepped = p.ls.turns().filter(([, side]) => side === p.side).flatMap(([t, , cmds]) => cmds.map((c) => [t, c] as const));
      let split = 0;
      bursts[p.side].forEach(({ at, ids }, n) => {
        const pieces = stepped
          .filter(([, c]) => c.type === "move" && cellOf(c)?.n === n && cellOf(c)?.row === MOVE_ROW)
          .map(([, c]) => c as Extract<Command, { type: "move" }>);
        if (pieces.length > 1) split++;
        for (const c of pieces) expect(commandBits(c, MAP)).toBeLessThanOrEqual(C_MAX);
        const got = new Set(pieces.flatMap((c) => c.unitIds));
        // the attackMove never went out: the move replaced it before either was sealed
        expect(stepped.some(([, c]) => c.type === "attackMove" && cellOf(c)?.n === n && cellOf(c)?.row === ATTACK_ROW)).toBe(false);
        // every unit got this order, or a newer move or attackMove replaced it in the queue (padding ids: never)
        for (const id of ids)
          if (!got.has(id))
            expect(stepped.some(([t, c]) => t > at && (c.type === "move" || c.type === "attackMove") && c.unitIds.includes(id)), `burst ${n} id ${id}`).toBe(true);
        for (const id of ids) if (id >= 5000) expect(got.has(id)).toBe(true);
      });
      expect(split).toBeGreaterThan(5);
    }
  });

  for (const every of [10, 20])
    it(`keep a player's orders flowing when they re-order a 30-unit army every ${every / 10} s`, { timeout: 120_000 }, () => {
      // blue is a player with no AI: from tick 100 to 1300 they select their whole army and a-move it every 1 or
      // 2 s, as often as or more often than the window rule lets one such order out; order n goes to its own cell
      // (column n % 50, row n / 50), so each landed piece says which order it was
      const orders: { at: number; ids: number[] }[] = [];
      const TICKS = 1500;
      const r = duel({
        map: "riverlands", seed: 8, strategies: [null, "balanced"], delay: 5, ticks: TICKS,
        prepare: (w) => {
          // (ids 10 apart, as in a long match: red's spare scouts take the ones between)
          for (let i = 0; i < 30; i++) {
            spawnUnit(w, "stinger", "blue", 8 + (i % 6), 40 + Math.floor(i / 6));
            for (let j = 0; j < 9; j++) spawnUnit(w, "scout", "red", 48, 8);
          }
        },
        afterStep: (p, t) => {
          if (p.side !== "blue" || t < 100 || t > 1300 || t % every) return;
          const army = [...p.w.units.values()].filter((u) => u.faction === "blue" && u.kind === "stinger").map((u) => u.id);
          const n = orders.length;
          orders.push({ at: t, ids: army });
          p.extra.push({ type: "attackMove", faction: "blue", unitIds: army, x: 0.5 + (n % 50), y: 0.5 + Math.floor(n / 50) });
        }
      });
      // (the army may well win: then both phones end on the same tick)
      const end = r.blue.w.tick;
      expect(r.red.w.tick).toBe(end);
      expect(end === TICKS || r.blue.w.winner !== null).toBe(true);
      expect(firstDiff(r, end)).toBe(-1);
      // when each unit's orders landed: [tick, order]
      const landed = new Map<number, [number, number][]>();
      for (const [t, side, cmds] of r.red.ls.turns())
        for (const c of cmds)
          if (side === "blue" && c.type === "attackMove")
            for (const id of c.unitIds) landed.set(id, [...(landed.get(id) ?? []), [t, Math.floor(c.y) * 50 + Math.floor(c.x)]]);
      // every unit hears an order at least as new as each one given within 6 s, none waiting for ever behind the
      // rest (in plain FIFO order the queue grew for as long as the orders kept coming: 20–40 s behind at 2 s)
      let worst = 0;
      const checked = orders.filter(({ at }) => at + 50 <= end);
      expect(checked.length).toBeGreaterThan(400 / every);
      for (const [n, { at, ids }] of checked.entries())
        for (const id of ids) {
          const first = landed.get(id)?.find(([, m]) => m >= n);
          expect(first, `order ${n}, unit ${id}`).toBeDefined();
          worst = Math.max(worst, first![0] - at);
        }
      expect(worst).toBeLessThanOrEqual(60);
      const s = r.blue.ls.status();
      if (end === TICKS) expect(s.queued).toBe(0);
      expect(r.blue.maxQueued).toBeLessThanOrEqual(10);
      expect(r.blue.maxQueuedTicks).toBeLessThanOrEqual(50);
      expect(s.stallMs).toBeLessThanOrEqual(1_000);
    });

  it("keep identical hash trails with pauses on both phones", { timeout: 120_000 }, () => {
    const pauses: [number, "blue" | "red", number][] = [[50_000, "red", 8_000], [120_000, "blue", 2_000]];
    let sealedAtPause = -1;
    let pausedPhone: Phone | null = null;
    let until = 0;
    const r = duel({
      map: "proving-grounds", seed: 4, strategies: ["boom", "ironclad"], delay: 4, ticks: 2000, air: { latencyMs: 150 },
      every: (r) => {
        const now = r.air.now();
        if (!pausedPhone && pauses.length && now >= pauses[0]![0]) {
          const [, side, ms] = pauses.shift()!;
          pausedPhone = r[side];
          pausedPhone.paused = true;
          pausedPhone.ls.setPaused(true);
          sealedAtPause = pausedPhone.ls.status().newestSealed;
          until = now + ms;
        } else if (pausedPhone && now >= until) {
          // nothing was sealed while paused, and the other phone got no further than D + 1 ticks ahead
          expect(pausedPhone.ls.status().newestSealed).toBe(sealedAtPause);
          const other = pausedPhone === r.blue ? r.red : r.blue;
          expect(other.w.tick - pausedPhone.w.tick).toBeLessThanOrEqual(4 + 1);
          pausedPhone.paused = false;
          pausedPhone.ls.setPaused(false);
          pausedPhone = null;
        }
      }
    });
    expect(pauses).toEqual([]);
    expect([r.blue.w.tick, r.red.w.tick]).toEqual([2000, 2000]);
    expect(firstDiff(r, 2000)).toBe(-1);
    // each saw "Friend paused" once it stalled
    expect([r.blue.sawPeerPaused, r.red.sawPeerPaused]).toEqual([true, true]);
  });

  it("end on the same tick when a side resigns, check the end, and the record replays", { timeout: 120_000 }, () => {
    const r = duel({
      map: "riverlands", seed: 42, ticks: FIVE_MINUTES,
      afterStep: (p, t) => {
        if (p.side === "red" && t === 900) p.extra.push({ type: "resign", faction: "red" });
      },
      until: (r) => [r.blue, r.red].every((p) => p.ls.status().endCheck !== "pending")
    });
    const [sb, sr] = [r.blue.ls.status(), r.red.ls.status()];
    expect(sb.decided!.tick).toBe(sr.decided!.tick);
    expect(sb.decided!.tick).toBeGreaterThanOrEqual(900 + 5);
    expect(sb.decided).toEqual({ winner: "blue", resigned: "red", tick: sb.decided!.tick });
    expect([sb.endCheck, sr.endCheck]).toEqual(["ok", "ok"]);
    for (const p of [r.blue, r.red]) expect([p.w.winner, p.w.resigned, p.w.tick]).toEqual(["blue", "red", sb.decided!.tick + 1]);
    expect(firstDiff(r, sb.decided!.tick + 1)).toBe(-1);
    expectReplays(r, r.blue);
  });

  it("catch a desync injected into one world at the next checkpoint", { timeout: 120_000 }, () => {
    const r = duel({
      map: "riverlands", seed: 42, ticks: 1400,
      afterStep: (p, t) => {
        if (p.side === "blue" && t === 1230) p.w.factions.blue.scrap += 7;
      }
    });
    expect(firstDiff(r, 1400)).toBe(1231);
    for (const p of [r.blue, r.red]) {
      expect(p.ls.status().desync).toBe(true);
      expect(p.desyncAt!).toBeGreaterThan(1250);
      expect(p.desyncAt!).toBeLessThanOrEqual(1250 + 2 * 5 + 2);
    }
    expect([r.blue.ls.status().desyncReason, r.red.ls.status().desyncReason]).toContain("checkpoint");
    expect(CHECKPOINT_EVERY).toBe(50);
  });

  it("catch a desync after the last checkpoint at the end check", { timeout: 120_000 }, () => {
    const r = duel({
      map: "riverlands", seed: 42, ticks: 1400,
      afterStep: (p, t) => {
        if (p.side === "blue" && t === 1210) p.extra.push({ type: "resign", faction: "blue" });
        if (p.side === "red" && t === 1205) p.w.factions.red.scrap += 3;
      },
      until: (r) => [r.blue, r.red].every((p) => p.ls.over() && p.ls.status().desync)
    });
    const T = r.blue.ls.status().decided?.tick ?? r.red.ls.status().decided!.tick;
    const reasons = [r.blue.ls.status().desyncReason, r.red.ls.status().desyncReason];
    // (the resign normally lands before tick 1250; if a burst held it back, checkpoint 1250 catches the drift instead)
    expect(reasons).toContain(T < 1250 ? "end" : "checkpoint");
    for (const p of [r.blue, r.red]) expect(p.ls.status().desync).toBe(true);
  });

  it("catch a world decided on one phone only", { timeout: 120_000 }, () => {
    const r = duel({
      map: "riverlands", seed: 42, ticks: 1000,
      afterStep: (p, t) => {
        if (p.side === "blue" && t === 700) hqOf(p.w, "blue")!.hp = 0; // (blue's HQ falls on this phone alone: decided on the next step)
      },
      until: (r) => r.blue.ls.status().desync && r.red.ls.status().desync
    });
    // (and the decided phone's report says out of sync, not "Checking sync…" and then "Not verified")
    expect(r.blue.ls.status()).toMatchObject({ desync: true, desyncReason: "peer", decided: { tick: 701 }, endCheck: "mismatch" });
    expect(r.red.ls.status()).toMatchObject({ desync: true, desyncReason: "end", decided: null, endCheck: "mismatch" });
  });

  it("tell the other phone when one leaves or aborts", { timeout: 60_000 }, () => {
    for (const reason of ["left", "desync"] as const) {
      let leftAt = -1;
      const r = duel({
        map: "riverlands", seed: 42, ticks: 600,
        afterStep: (p, t, run) => {
          if (p.side === "blue" && t === 300) {
            p.ls.leave(reason);
            leftAt = run.air.now();
          }
        },
        until: (r) => r.red.ls.over()
      });
      const s = r.red.ls.status();
      expect(s.peerEnd).toBe(reason);
      expect(s.desync).toBe(reason === "desync");
      // within a packet period and the latency (plus a frame each side)
      expect(r.air.now() - leftAt).toBeLessThanOrEqual(100 + 250 + 40);
      expect(r.red.w.tick).toBeLessThanOrEqual(301 + 5);
    }
  });

  it("say \"Not verified\" when the peer's end report never arrives", { timeout: 120_000 }, () => {
    let cut = false;
    const r = duel({
      map: "riverlands", seed: 42, ticks: FIVE_MINUTES,
      afterStep: (p, t) => {
        if (p.side === "red" && t === 600) p.extra.push({ type: "resign", faction: "red" });
      },
      every: (r) => {
        // blue stops hearing red the moment blue's world is decided
        if (!cut && r.blue.ls.status().end === "decided") {
          cut = true;
          r.air.outage(30_000, "ba");
        }
      },
      until: (r) => r.blue.ls.status().endCheck !== "pending" && r.red.ls.status().endCheck !== "pending"
    });
    expect(r.blue.ls.status().endCheck).toBe("unverified");
    expect(r.red.ls.status().endCheck).toBe("ok");
  });
});
