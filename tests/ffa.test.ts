/**
 * The four-player online battle (FFA.md): its wire format, and a host with
 * three friends' pages over a fake relay (rooms of two seats, latency, the
 * 1 KB and rate limits), on fake timers. Every page steps the turn log as
 * GameScene would through the feed, and "people" are commanders driving
 * each seat's orders on that seat's own page, so the orders cross the wire.
 */
import { describe, expect, it } from "vitest";
import { createAiState, tickAi, type AiState } from "../src/sim/ai/commander";
import { worldHash } from "../src/sim/checksum";
import { step } from "../src/sim/sim";
import type { Command, Faction } from "../src/sim/types";
import { FfaGuest } from "../src/ffa/guest";
import { DROP_MS, FfaHost } from "../src/ffa/host";
import { FfaMatch } from "../src/ffa/match";
import {
  MAX_MESSAGE, MAX_UNITS, SEAT_SIDE, chunk, ffaInviteUrl, parseFfaInvite, readGuestMsg, readHostMsg, sanitizeCommand, seatRoom, splitOrder,
  type FfaSetup
} from "../src/ffa/protocol";
import { RelaySocket, type NetTimers, type SocketLike } from "../src/net/relay-socket";
import { FfaFeed, type FfaFeedEnv } from "../src/ffa/feed";
import { Controller, setLocalSide } from "../src/game/controller";

// ------------------------------------------------------------ fakes ---

function fakeTime() {
  let t = 0;
  let seq = 0;
  const due = new Map<number, { at: number; fn: () => void; every: number | null }>();
  const timers: NetTimers = {
    setTimeout: (fn, ms) => (due.set(++seq, { at: t + ms, fn, every: null }), seq),
    clearTimeout: (h) => void due.delete(h as number),
    setInterval: (fn, ms) => (due.set(++seq, { at: t + ms, fn, every: ms }), seq),
    clearInterval: (h) => void due.delete(h as number)
  };
  const advance = (ms: number) => {
    const end = t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void; every: number | null }] | null = null;
      for (const e of due) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      const [id, d] = next;
      t = d.at;
      if (d.every === null) due.delete(id);
      else d.at += Math.max(1, d.every);
      d.fn();
    }
    t = end;
  };
  return { now: () => t, timers, advance };
}

/** The relay as relay/server.py runs it: two seats a room, a newer socket replaces the seat's old one (4001), 1 KB, 50/s after a burst of 100. */
class FakeRelay {
  readonly rooms = new Map<string, { host?: FakeWs; guest?: FakeWs }>();
  latency = 40;
  /** Rooms whose network is down (a friend's phone in a tunnel): no connection opens, open ones are cut. */
  readonly down = new Set<string>();
  /** The biggest message seen, and any socket closed for sending too fast. */
  biggest = 0;
  tooFast: string[] = [];
  constructor(readonly time: ReturnType<typeof fakeTime>) {}
  socket = (url: string): SocketLike => new FakeWs(this, url);
  cut(code: string): void {
    this.down.add(code);
    const r = this.rooms.get(code);
    for (const ws of [r?.host, r?.guest]) ws?.lost();
  }
  mend(code: string): void {
    this.down.delete(code);
  }
}

class FakeWs implements SocketLike {
  readyState = 0;
  onopen: SocketLike["onopen"] = null;
  onclose: SocketLike["onclose"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onerror: SocketLike["onerror"] = null;
  readonly code: string;
  readonly role: "host" | "guest";
  private tokens = 100;
  private tokensAt: number;
  constructor(private readonly relay: FakeRelay, url: string) {
    const m = /\/([0-9A-Z]+)\/(host|guest)$/.exec(url)!;
    this.code = m[1]!;
    this.role = m[2] as "host" | "guest";
    this.tokensAt = relay.time.now();
    relay.time.timers.setTimeout(() => this.join(), 5);
  }
  private join(): void {
    if (this.readyState !== 0) return;
    if (this.relay.down.has(this.code)) {
      this.readyState = 3;
      this.onclose?.({ code: 1006, reason: "" });
      return;
    }
    const room = this.relay.rooms.get(this.code) ?? {};
    this.relay.rooms.set(this.code, room);
    const old = room[this.role];
    room[this.role] = this;
    if (old && old !== this) old.closeBy(4001);
    this.readyState = 1;
    this.onopen?.({});
  }
  send(data: string): void {
    if (this.readyState !== 1) return;
    expect(data.length).toBeLessThanOrEqual(1024);
    this.relay.biggest = Math.max(this.relay.biggest, data.length);
    const now = this.relay.time.now();
    this.tokens = Math.min(100, this.tokens + ((now - this.tokensAt) / 1000) * 50);
    this.tokensAt = now;
    if (this.tokens < 1) {
      this.relay.tooFast.push(`${this.code}/${this.role}`);
      this.closeBy(4008);
      return;
    }
    this.tokens -= 1;
    const room = this.relay.rooms.get(this.code);
    const peer = this.role === "host" ? room?.guest : room?.host;
    if (!peer) return;
    this.relay.time.timers.setTimeout(() => {
      if (peer.readyState === 1) peer.onmessage?.({ data });
    }, this.relay.latency);
  }
  close(): void {
    this.leave();
    this.readyState = 3;
  }
  /** The relay closed it. */
  closeBy(code: number): void {
    if (this.readyState === 3) return;
    this.leave();
    this.readyState = 3;
    this.onclose?.({ code, reason: "" });
  }
  /** The network dropped it. */
  lost(): void {
    this.closeBy(1006);
  }
  private leave(): void {
    const room = this.relay.rooms.get(this.code);
    if (room?.[this.role] === this) delete room[this.role];
  }
}

// ------------------------------------------------------------ pages ---

const CODE = "K7QM2XP4";
const BUILD = "test-build";

/** A page in the battle: its match, and the "person" playing its seat (a commander driving orders through the wire). */
interface Page {
  side: Faction;
  match: () => FfaMatch | null;
  /** This page's orders for the tick it's about to step, sent the way the feed sends them. */
  give: (cmds: Command[], tick: number) => void;
  /** May it step tick n (the host: seal it)? */
  ready: (tick: number) => boolean;
  after: (hash: string | null, tick: number) => void;
  person: AiState | null;
  hashes: Map<number, string>;
  /** Steps per 100 ms frame at most (a friend's page catching up runs faster). */
  maxSteps: number;
}

function hostPage(host: FfaHost): Page {
  return {
    side: "blue",
    match: () => host.match,
    give: (cmds, tick) => host.orders(cmds, tick),
    ready: (tick) => host.seal(tick),
    after: (h, tick) => host.stepped(h, tick),
    person: createAiState("balanced", "normal", 11),
    hashes: new Map(),
    maxSteps: 1
  };
}

function guestPage(g: FfaGuest, person: AiState | null = createAiState("rush", "normal", 20 + g.seat)): Page {
  return {
    side: g.side,
    match: () => g.match,
    give: (cmds) => g.orders(cmds),
    ready: (tick) => !!g.match && tick < g.match.sealed(),
    after: () => undefined,
    person,
    hashes: new Map(),
    maxSteps: 8
  };
}

/** One 100 ms frame of a page: step what it may, as GameScene does through the feed. */
function frame(p: Page): void {
  const m = p.match();
  if (!m || m.world.winner) return;
  for (let i = 0; i < p.maxSteps; i++) {
    const w = m.world;
    const tick = w.tick;
    if (!p.ready(tick)) break;
    // (the person's orders for this tick, given on their own page: they land a round trip later on every page)
    if (p.person && !m.aiPlays(p.side) && !w.out?.some((o) => o.faction === p.side)) p.give(tickAi(w, p.side, p.person), tick);
    const cmds = m.commandsFor(tick);
    if (!cmds) break;
    step(w, cmds);
    const h = m.afterStep(w);
    if (h) p.hashes.set(w.tick, h);
    p.after(h, w.tick);
    if (w.winner) break;
  }
}

function lobby(opts: { friends: number[]; picks?: Partial<Record<number, "blitz" | "industry" | "airwing">> } = { friends: [1, 2, 3] }) {
  const time = fakeTime();
  const relay = new FakeRelay(time);
  let r = 0;
  const host = new FfaHost({
    code: CODE, build: BUILD, map: "compass-rose", mutators: [], difficulty: "normal",
    strategy: () => "balanced",
    // (a fixed stream: the same battle every run)
    random: () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff),
    socket: relay.socket, now: time.now, timers: time.timers
  });
  const guests = opts.friends.map(
    (seat) => new FfaGuest({ code: CODE, seat, build: BUILD, name: `P${seat + 1}`, socket: relay.socket, now: time.now, timers: time.timers })
  );
  time.advance(500);
  for (const g of guests) {
    const pick = opts.picks?.[g.seat];
    if (pick) g.setPick(pick);
  }
  time.advance(500);
  return { time, relay, host, guests };
}

/** Run every page for `ms` of fake time, a frame each 100 ms. */
function run(pages: Page[], time: ReturnType<typeof fakeTime>, ms: number): void {
  for (let t = 0; t < ms; t += 100) {
    for (const p of pages) frame(p);
    time.advance(100);
  }
}

/** Every page's hash at every check tick they both reached agrees. */
function expectSame(pages: Page[]): number {
  let compared = 0;
  const [a, ...rest] = pages;
  for (const b of rest)
    for (const [tick, h] of b.hashes) {
      const mine = a!.hashes.get(tick);
      if (mine === undefined) continue;
      expect(h, `${b.side} at tick ${tick}`).toBe(mine);
      compared++;
    }
  return compared;
}

// ------------------------------------------------------------ tests ---

describe("four-player protocol", () => {
  it("invites each friend to a seat of their own, read back from the fragment", () => {
    const url = ffaInviteUrl({ origin: "https://simonw.github.io", pathname: "/battledrones/" }, CODE, 2);
    expect(url).toBe("https://simonw.github.io/battledrones/#ffa=K7QM2XP4-2");
    expect(parseFfaInvite(new URL(url).hash)).toEqual({ code: CODE, seat: 2 });
    expect(parseFfaInvite("#ffa=k7qm2xp4-3")).toEqual({ code: CODE, seat: 3 });
    expect(parseFfaInvite("#ffa=K7QM2XP4-0")).toBeNull(); // (seat 0 is the host's)
    expect(parseFfaInvite("#ffa=K7QM2XP4-4")).toBeNull();
    expect(parseFfaInvite("#ffa=ILOU0000-1")).toBeNull();
    expect(parseFfaInvite("#vs=K7QM2XP4")).toBeNull();
    expect(seatRoom(CODE, 1)).toBe("K7QM2XP41");
    expect(SEAT_SIDE).toEqual(["blue", "red", "green", "purple"]);
  });

  it("stamps a friend's order with their seat's side, and drops what isn't an order", () => {
    expect(sanitizeCommand({ type: "move", faction: "blue", unitIds: [1, 2], x: 3.5, y: 4 }, "green")).toEqual({
      type: "move", faction: "green", unitIds: [1, 2], x: 3.5, y: 4
    });
    expect(sanitizeCommand({ type: "resign", faction: "blue" }, "purple")).toEqual({ type: "resign", faction: "purple" });
    expect(sanitizeCommand({ type: "move", unitIds: "all", x: 1, y: 1 }, "red")).toBeNull();
    expect(sanitizeCommand({ type: "produce", buildingId: 3, unit: "deathstar" }, "red")).toBeNull();
    expect(sanitizeCommand({ type: "teleport" }, "red")).toBeNull();
    expect(sanitizeCommand({ type: "move", unitIds: [1], x: Infinity, y: 0 }, "red")).toBeNull();
    expect(readGuestMsg('{"t":"cmd","seq":0,"c":[{"type":"stop","unitIds":[4]}]}')).toEqual({ t: "cmd", seq: 0, c: [{ type: "stop", unitIds: [4] }] });
    expect(readGuestMsg("not json")).toBeNull();
    expect(readGuestMsg('{"t":"hello","proto":1}')).toBeNull();
    expect(readHostMsg('{"t":"ev","from":0,"e":[{"ai":"red","on":true},{"h":[100,"abc"]},0],"ack":-1}')).toEqual({
      t: "ev", from: 0, e: [{ ai: "red", on: true }, { h: [100, "abc"] }, 0], ack: -1
    });
    // (a log event that isn't one spoils the message: a page acts only on well-formed logs)
    expect(readHostMsg('{"t":"ev","from":0,"e":[{"type":"teleport","faction":"red"}],"ack":-1}')).toBeNull();
  });

  it("carries any 32-bit seed in the setup", () => {
    const setup: FfaSetup = {
      id: "K7QM2XP4-x", map: "compass-rose", seed: 0x7fffffff, mutators: [], openers: { blue: "blitz" },
      seats: [
        { side: "blue", kind: "human", name: "Host" },
        { side: "red", kind: "ai", strategy: "rush", difficulty: "hard", seed: -0x7fffffff },
        { side: "green", kind: "human", name: "Ann" },
        { side: "purple", kind: "ai", strategy: "boom", difficulty: "easy", seed: 2_000_000_000 }
      ],
      standIn: { strategy: "balanced", difficulty: "normal", seed: 1_999_999_999 }
    };
    expect(readHostMsg(JSON.stringify({ t: "start", setup }))).toEqual({ t: "start", setup });
  });

  it("splits a long unit list, keeping a lifted Goliath with its Condors in the first piece", () => {
    const ids = Array.from({ length: 200 }, (_, i) => i + 1);
    const parts = splitOrder({ type: "move", faction: "red", unitIds: ids, x: 1, y: 1 }, new Set([150, 151, 152]));
    expect(parts).toHaveLength(Math.ceil(200 / MAX_UNITS));
    expect((parts[0] as { unitIds: number[] }).unitIds.slice(0, 3)).toEqual([150, 151, 152]);
    expect(parts.flatMap((p) => (p as { unitIds: number[] }).unitIds).sort((a, b) => a - b)).toEqual(ids);
    expect(splitOrder({ type: "resign", faction: "red" })).toHaveLength(1);
  });

  it("packs log events into messages under the limit, at least one each", () => {
    const events = Array.from({ length: 400 }, (_, i) => (i % 3 ? i : { type: "move", faction: "red", unitIds: [i, i + 1, i + 2], x: i, y: i }));
    const parts = chunk(events, 48);
    expect(parts.flat()).toEqual(events);
    for (const p of parts) expect(JSON.stringify({ t: "ev", from: 123456, e: p, ack: 12345 }).length).toBeLessThanOrEqual(MAX_MESSAGE);
  });
});

describe("a lobby's seat waiting for a friend", () => {
  it("reconnects through the relay's lonely close twice, then gives up (a forgotten tab lets the relay sleep)", () => {
    const time = fakeTime();
    const relay = new FakeRelay(time);
    const made: FakeWs[] = [];
    let error: string | null = null;
    const s = new RelaySocket({
      code: seatRoom(CODE, 1), role: "host", onMessage: () => undefined, lonelyRetries: 2,
      socket: (u) => {
        const ws = relay.socket(u) as FakeWs;
        made.push(ws);
        return ws;
      },
      now: time.now, timers: time.timers
    });
    s.onError = (m) => (error = m);
    for (let i = 0; i < 3; i++) {
      time.advance(1000);
      expect(s.state).toBe("open");
      made.at(-1)!.closeBy(4010);
    }
    time.advance(1000);
    expect(made).toHaveLength(3);
    expect(s.stopped).toBe(true);
    expect(error).toMatch(/10 minutes/);
  });
});

describe("a four-player battle over the relay", () => {
  it("the lobby: friends join their seats, picks show, an open seat goes to an AI at Start", () => {
    const { host, guests, time, relay } = lobby({ friends: [1, 3], picks: { 1: "blitz", 3: "airwing" } });
    const views = host.views();
    expect(views.map((v) => v.kind)).toEqual(["host", "friend", "open", "friend"]);
    expect(views[1]).toMatchObject({ name: "P2", pick: "blitz", online: true });
    expect(guests[0]!.phase).toBe("lobby");
    expect(guests[1]!.seats()?.map((v) => v.kind)).toEqual(["host", "friend", "open", "friend"]);
    const setup = host.start();
    expect(setup.seats.map((s) => s.kind)).toEqual(["human", "human", "ai", "human"]);
    expect(setup.openers).toMatchObject({ blue: "industry", red: "blitz", purple: "airwing" });
    expect(setup.openers.green).toBeDefined(); // (the AI's own pick)
    time.advance(200);
    for (const g of guests) {
      expect(g.phase).toBe("playing");
      expect(g.match!.setup).toEqual(setup);
    }
    // a friend opening the open seat's link now finds the battle started without it
    const late = new FfaGuest({ code: CODE, seat: 2, build: BUILD, name: "Late", socket: relay.socket, now: time.now, timers: time.timers });
    time.advance(1000);
    expect(late.phase).toBe("ended");
    expect(late.ended?.why).toBe("started");
    expect(host.match!.setup.seats[2]!.kind).toBe("ai");
  });

  it("a friend's page on another build can't join", () => {
    const { time, relay, host } = lobby({ friends: [] });
    const g = new FfaGuest({ code: CODE, seat: 1, build: "other", name: "Old", socket: relay.socket, now: time.now, timers: time.timers });
    time.advance(1000);
    expect(g.phase).toBe("ended");
    expect(g.ended?.why).toBe("version");
    expect(host.views()[1]!.kind).toBe("open");
  });

  it("four pages play the same battle: orders cross the wire, every world hash agrees", () => {
    const { time, relay, host, guests } = lobby();
    host.start();
    time.advance(200);
    const pages = [hostPage(host), ...guests.map((g) => guestPage(g))];
    run(pages, time, 150_000);
    const m = host.match!;
    expect(m.world.tick).toBeGreaterThan(1300);
    // every page is within a few ticks of the host, and they agree at every check tick
    for (const g of guests) expect(m.world.tick - g.match!.world.tick).toBeLessThan(10);
    expect(expectSame(pages)).toBeGreaterThan(30);
    for (const g of guests) expect(g.match!.desyncAt).toBeNull();
    // people's orders came through: every side has built something beyond its start
    const log = m.log.filter((e) => typeof e === "object" && "type" in e) as Command[];
    for (const f of ["red", "green", "purple"] as const) expect(log.filter((c) => c.faction === f).length, f).toBeGreaterThan(20);
    expect(log.filter((c) => c.faction === "blue").length).toBeGreaterThan(20);
    expect(relay.biggest).toBeLessThanOrEqual(1024);
    expect(relay.tooFast).toEqual([]);
  });

  it("a friend who drops gets an AI stand-in on every page at the same tick, and their seat back when they return", () => {
    const { time, relay, host, guests } = lobby();
    host.start();
    time.advance(200);
    const pages = [hostPage(host), ...guests.map((g) => guestPage(g))];
    run(pages, time, 20_000);
    const green = guests[1]!;
    relay.cut(seatRoom(CODE, 2));
    run(pages, time, DROP_MS + 4000);
    const m = host.match!;
    expect(m.aiPlays("green")).toBe(true);
    expect(m.playerOf("green")).toBe("P3 (AI stand-in)");
    // (the green page holds no log past its drop: it is behind)
    expect(m.world.tick - green.match!.world.tick).toBeGreaterThan(100);
    relay.mend(seatRoom(CODE, 2));
    run(pages, time, 20_000);
    expect(m.aiPlays("green")).toBe(false);
    expect(green.match!.aiPlays("green")).toBe(false);
    expect(m.world.tick - green.match!.world.tick).toBeLessThan(10);
    // the control events are in the log, and the green page stepped them where the host did
    const controls = m.log.filter((e) => typeof e === "object" && "ai" in e);
    expect(controls).toEqual([{ ai: "green", on: true }, { ai: "green", on: false }]);
    expect(expectSame(pages)).toBeGreaterThan(10);
    expect(m.world.factions.green.incomeMult).toBe(1);
  });

  it("a friend's page that reloads mid-battle rejoins: the setup and the whole log again, caught up fast", () => {
    const { time, relay, host, guests } = lobby();
    host.start();
    time.advance(200);
    let pages = [hostPage(host), ...guests.map((g) => guestPage(g))];
    run(pages, time, 40_000);
    // the purple page goes (a reload): a new page for the same seat
    const old = guests[2]!;
    old.close();
    const fresh = new FfaGuest({ code: CODE, seat: 3, build: BUILD, name: "P4", socket: relay.socket, now: time.now, timers: time.timers });
    let started = 0;
    fresh.onStart = () => started++;
    pages = [pages[0]!, pages[1]!, pages[2]!, guestPage(fresh)];
    run(pages, time, 30_000);
    expect(started).toBe(1);
    const m = host.match!;
    expect(fresh.match!.setup.id).toBe(m.setup.id);
    expect(m.world.tick - fresh.match!.world.tick).toBeLessThan(10);
    expect(expectSame([pages[0]!, pages[3]!])).toBeGreaterThan(5);
    expect(relay.tooFast).toEqual([]);
  });

  it("a page whose world drifts says so, and the host hears it", () => {
    const { time, host, guests } = lobby();
    host.start();
    time.advance(200);
    let desync: number | null = null;
    host.onDesync = (t) => (desync = t);
    const pages = [hostPage(host), ...guests.map((g) => guestPage(g))];
    run(pages, time, 5000);
    // (a bit flipped on the red page)
    guests[0]!.match!.world.factions.red.scrap += 1;
    run(pages, time, 15_000);
    const m = guests[0]!.match!;
    expect(m.desyncAt).not.toBeNull();
    guests[0]!.desync(m.desyncAt!);
    time.advance(200);
    expect(desync).toBe(m.desyncAt);
    host.close("desync");
    time.advance(200);
    expect(guests[1]!.ended?.why).toBe("desync");
  });

  it("a battle to its end: the record replays to the same world, and a new page waits for the host's rematch", () => {
    const { time, relay, host, guests } = lobby();
    host.start();
    time.advance(200);
    const pages = [hostPage(host), ...guests.map((g) => guestPage(g))];
    run(pages, time, 60_000);
    // three of them resign, a moment apart: the last one standing wins
    host.orders([{ type: "resign", faction: "blue" }], host.match!.world.tick);
    run(pages, time, 1000);
    guests[0]!.orders([{ type: "resign", faction: "red" }]);
    guests[1]!.orders([{ type: "resign", faction: "green" }]);
    run(pages, time, 3000);
    const m = host.match!;
    expect(m.world.winner).toBe("purple");
    expect(m.world.out?.map((o) => o.faction)).toEqual(["blue", "red", "green"]);
    run(pages, time, 2000);
    for (const g of guests) {
      expect(g.match!.world.winner).toBe("purple");
      expect(worldHash(g.match!.world)).toBe(worldHash(m.world));
    }
    // the record: every order stepped, replayed without the commanders, ends the same
    const rec = m.record();
    const replay = new FfaMatch({ ...m.setup, seats: m.setup.seats.map((s) => ({ side: s.side, kind: "human" as const, name: "x" })) } as FfaSetup);
    const byTick = new Map<number, Command[]>();
    for (const [t, , c] of rec.turns) byTick.set(t, [...(byTick.get(t) ?? []), ...c]);
    for (const [f, k] of Object.entries(rec.income ?? {})) replay.world.factions[f as Faction].incomeMult = k;
    while (replay.world.tick < m.world.tick) step(replay.world, byTick.get(replay.world.tick) ?? []);
    expect(worldHash(replay.world)).toBe(worldHash(m.world));
    // a new page on the red seat while the host's report is up: told to wait, not replayed into the old battle
    guests[0]!.close();
    const next = new FfaGuest({ code: CODE, seat: 1, build: BUILD, name: "P2", socket: relay.socket, now: time.now, timers: time.timers });
    time.advance(1000);
    expect(next.match).toBeNull();
    expect(next.hostFinishing).toBe(true);
  }, 120_000);
});

// ------------------------------------------------------------ the feed ---

describe("the four-player feed (what GameScene plays through)", () => {
  /** A page's scene as the feed sees it: a real Controller, and what it was told. */
  function scenePage(feed: FfaFeed, time: ReturnType<typeof fakeTime>) {
    const ctrl = new Controller(feed.world);
    ctrl.trackInFlight();
    const told = { aborts: [] as string[], alerts: [] as string[] };
    feed.attach({ ctrl, abort: (r) => told.aborts.push(r), alert: (m) => told.alerts.push(m) });
    /** One frame, as GameScene.update: step what the feed hands over (a guest's catch-up: several). */
    const frame = (steps = 1) => {
      for (let i = 0; i < steps; i++) {
        if (feed.world.winner) break;
        const cmds = feed.commands(feed.world.tick);
        if (!cmds) break;
        step(feed.world, cmds);
        feed.afterTick(feed.world);
      }
      feed.frame();
    };
    return { ctrl, told, frame, time };
  }

  function feeds() {
    const { time, relay, host, guests } = lobby({ friends: [1] });
    host.start();
    time.advance(200);
    const env = (): Partial<FfaFeedEnv> => ({
      document: null, session: null, reload: () => undefined, forgetInvite: () => undefined,
      setTimeout: (fn, ms) => time.timers.setTimeout(fn, ms), now: time.now
    });
    const hostFeed = new FfaFeed({ host, local: "blue", env: env() });
    const guestFeed = new FfaFeed({ guest: guests[0]!, local: "red", env: env() });
    const hp = scenePage(hostFeed, time);
    setLocalSide("red"); // (the red page's Controller gives red's orders)
    const gp = scenePage(guestFeed, time);
    setLocalSide("blue");
    const both = (ms: number) => {
      for (let t = 0; t < ms; t += 100) {
        hp.frame();
        gp.frame(4);
        time.advance(100);
      }
    };
    return { time, relay, host, guest: guests[0]!, hostFeed, guestFeed, hp, gp, both };
  }

  it("labels the seats, and its HUD parts say what leaving and resigning do here", () => {
    const { hostFeed, guestFeed } = feeds();
    expect(hostFeed.labels.blue).toBe("Host");
    expect(hostFeed.labels.red).toBe("P2");
    expect(hostFeed.labels.green).toBe("Balanced AI");
    expect(hostFeed.live).toBe(true);
    expect(hostFeed.duel.asks?.leave).toMatch(/ends for everyone/);
    expect(guestFeed.duel.asks?.leave).toMatch(/AI takes over/);
    expect(hostFeed.outNote).toMatch(/Keep this page open/);
    expect(guestFeed.outNote).toBeUndefined();
  });

  it("a friend's order goes to the host, comes back sealed into a tick, and lands on both pages", () => {
    const { hp, gp, both, guestFeed, hostFeed } = feeds();
    both(1000);
    const w = guestFeed.world;
    const harv = [...w.units.values()].find((u) => u.faction === "red" && u.kind === "harvester")!;
    gp.ctrl.enqueue({ type: "stop", faction: "red", unitIds: [harv.id] });
    both(100);
    expect(gp.ctrl.inFlight).toHaveLength(1);
    both(1500);
    expect(gp.ctrl.inFlight).toEqual([]);
    const sealed = hostFeed.match.log.filter((e) => typeof e === "object" && "type" in e && e.type === "stop" && e.faction === "red");
    expect(sealed).toHaveLength(1);
    // (both pages at the same tick hold the same world)
    for (let i = 0; i < 40 && hostFeed.world.tick > guestFeed.world.tick; i++) {
      gp.frame();
      gp.time.advance(50);
    }
    expect(guestFeed.world.tick).toBe(hostFeed.world.tick);
    expect(worldHash(guestFeed.world)).toBe(worldHash(hostFeed.world));
    expect(hp.ctrl.inFlight).toEqual([]);
  });

  it("Resign knocks this side out on every page; the others play on", () => {
    const { gp, both, guestFeed, hostFeed } = feeds();
    both(1000);
    guestFeed.duel.resign(false);
    expect(gp.ctrl.locked).toBe(true);
    both(1500);
    expect(hostFeed.world.out?.map((o) => o.faction)).toEqual(["red"]);
    expect(guestFeed.world.out?.map((o) => o.faction)).toEqual(["red"]);
    expect(guestFeed.duel.resigning()).toBe(true);
    expect(hostFeed.world.winner).toBeFalsy();
  });

  it("the host's page leaving mid-battle: a friend's page plays out the log it holds, then ends with no result", () => {
    const { host, both, gp, hp, time } = feeds();
    both(3000);
    host.close("left");
    for (let t = 0; t < 3000; t += 100) {
      gp.frame(4);
      time.advance(100);
    }
    expect(gp.told.aborts).toEqual(["host"]);
    expect(hp.told.aborts).toEqual([]);
  });

  it("a friend's page that drifts ends the battle for everyone: no contest", () => {
    const { both, guestFeed, gp, hp } = feeds();
    both(3000);
    guestFeed.world.factions.red.scrap += 5;
    both(12_000);
    expect(gp.told.aborts).toEqual(["split"]);
    expect(hp.told.aborts).toEqual(["split"]);
  });

  it("a friend drops: every page says an AI stands in, and that they're back", () => {
    const { relay, both, hp } = feeds();
    both(2000);
    relay.cut(seatRoom(CODE, 1));
    both(DROP_MS + 3000);
    relay.mend(seatRoom(CODE, 1));
    both(15_000);
    expect(hp.told.alerts).toEqual(["P2 (Red) dropped: an AI plays for them until they're back", "P2 (Red) is back"]);
  });
});

describe("the four-player chunk's import rules", () => {
  const sources = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
  const valueImports = (src: string) => [...src.matchAll(/^import (?!type )[^;]*?from "([^"]+)"/gm)].map((m) => m[1]!);

  it("nothing outside src/ffa imports it but types; main.ts loads it with one import(\"./ffa/lobby\")", () => {
    for (const [path, src] of Object.entries(sources)) {
      if (path.startsWith("../src/ffa/")) continue;
      for (const spec of valueImports(src)) expect(/(^|\/)ffa\//.test(spec), `${path} imports ${spec}`).toBe(false);
    }
    expect(sources["../src/main.ts"]!.match(/import\("\.\/ffa\/lobby"\)/g)).toHaveLength(1);
  });

  it("src/ffa uses neither the sound duel nor the battle viewer", () => {
    for (const [path, src] of Object.entries(sources)) {
      if (!path.startsWith("../src/ffa/")) continue;
      for (const spec of valueImports(src)) expect(/(^|\/)(versus|link|arena)\//.test(spec), `${path} imports ${spec}`).toBe(false);
    }
  });
});
