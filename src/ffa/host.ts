/**
 * The host of a four-player online battle (FFA.md "The host"): the page that
 * made the battle code. It holds the "host" seat of each friend seat's relay
 * room, keeps the lobby, sets the match up, and seals the turn log: each tick
 * it takes the orders that have reached it (its own after HOST_DELAY ticks,
 * so it has no edge on its friends' round trip), stamps them with their
 * seat's side, and sends the log on to every friend.
 *
 * A friend who goes quiet for DROP_MS gets a stand-in commander (a control
 * event in the log, so every page switches on the same tick), and their seat
 * back once they have caught up again. A friend falling behind (a slow phone,
 * a weak link) makes the host wait up to STALL_MAX_MS, then the battle goes
 * on and they catch up by playing faster. Engine-free: the sockets and the
 * clock come in through options (tests drive it with fakes).
 */
import { allowedOpener, OPENER_IDS, type OpenerId } from "../sim/openers";
import { seatMarshal, type PlanName } from "../sim/ai/marshal";
import { setupWorld } from "../sim/setup";
import type { Difficulty } from "../sim/ai/commander";
import type { MutatorId } from "../sim/rules";
import type { Command, Faction } from "../sim/types";
import { RelaySocket, type NetTimers, type SocketLike } from "../net/relay-socket";
import { FfaMatch } from "./match";
import {
  FFA_PROTO, LONELY_RETRIES, SEATS, SEAT_SIDE, chunk, readGuestMsg, sanitizeCommand, seatRoom, splitOrder,
  type FfaSetup, type GuestMsg, type HostMsg, type LogEvent, type SeatPlan, type SeatView
} from "./protocol";

/** The host's own orders land this many ticks after they're given: about a friend's round trip through the relay. */
export const HOST_DELAY = 2;
/** A friend not heard from for this long gets a stand-in commander. */
export const DROP_MS = 12_000;
/** A friend this many ticks behind the host makes it wait… */
export const LAG_TICKS = 40;
/** …for at most this long at a time, then the battle goes on without waiting. */
export const STALL_MAX_MS = 8000;
/** A seat handed to a stand-in is given back once its person is within this many ticks of the host. */
const RETURN_TICKS = 12;
/** Log events sent and not acknowledged this long are sent again (the relay drops what a missing socket would have had). */
const RESEND_MS = 1500;
/**
 * Messages a seat's socket may send a second, and in one burst: the relay
 * closes a socket past 50 a second after a burst of 100 (relay/README.md,
 * 4008). A rejoin's catch-up on a long log goes out at this pace.
 */
export const SEND_RATE = 30;
const SEND_BURST = 60;

export interface HostOptions {
  code: string;
  /** The host's build (FFA.md "Build check"): a friend with another can't join. */
  build: string;
  map: string;
  mutators: MutatorId[];
  /** Marshal's difficulty in the open seats. */
  difficulty: Difficulty;
  /** Marshal's plan for an open seat at `difficulty` (the menu's rules decide which fit). */
  plan: (difficulty: Difficulty) => PlanName;
  random: () => number;
  /** The relay (default the deployed one) and the pieces (tests). */
  url?: string;
  socket?: (url: string) => SocketLike;
  now?: () => number;
  timers?: NetTimers;
}

interface FriendSeat {
  seat: number;
  side: Faction;
  socket: RelaySocket;
  /** A person said hello on this seat (they keep it: joined stays true when they drop). */
  joined: boolean;
  name: string;
  pick: OpenerId | null;
  /** When we last heard from them (any message). */
  heard: number;
  /** Log events they hold (from their at / hello), and how many we've sent on this connection. */
  have: number;
  sent: number;
  /** When `have` last moved (resend if it stalls short of `sent`). */
  haveAt: number;
  /** The tick they have played to. */
  tick: number;
  /** The next order seq we expect from them. */
  seq: number;
  /** Their orders waiting for the next tick to seal. */
  queue: Command[];
  /** A stand-in commander plays their seat (they dropped), or they left for good (bye). */
  standIn: boolean;
  left: boolean;
  /** When they fell behind LAG_TICKS (null: they aren't), and whether that wait has run out. */
  lagSince: number | null;
  lagWaived: boolean;
  /** Messages this seat's socket may still send now (SEND_RATE), and when that was counted. */
  budget: number;
  budgetAt: number;
}

export type HostPhase = "lobby" | "playing" | "ended";

export class FfaHost {
  readonly code: string;
  phase: HostPhase = "lobby";
  match: FfaMatch | null = null;
  /** The host's own opener pick, and name. */
  pick: OpenerId = "industry";
  name = "Host";
  /** Something changed that the lobby shows (seats, picks, connections). */
  onChange: (() => void) | null = null;
  /** A friend reported their world isn't the host's: the battle is no contest. */
  onDesync: ((tick: number) => void) | null = null;
  /** A seat's socket ended for good (the relay's final close): why. */
  onError: ((seat: number, message: string) => void) | null = null;
  readonly seats: FriendSeat[] = [];
  private readonly o: HostOptions;
  private readonly clock: () => number;
  /** The host's orders, each due on a tick. */
  private readonly own: { due: number; c: Command }[] = [];
  /** Control events to seal into the next tick. */
  private readonly controls: { ai: Faction; on: boolean }[] = [];

  constructor(o: HostOptions) {
    this.o = o;
    this.code = o.code;
    this.clock = o.now ?? (() => performance.now());
    for (let seat = 1; seat < SEATS; seat++) {
      const socket = new RelaySocket({
        code: seatRoom(o.code, seat),
        role: "host",
        lonelyRetries: LONELY_RETRIES,
        onMessage: (text) => this.receive(seat, text),
        ...(o.url !== undefined ? { url: o.url } : {}),
        ...(o.socket ? { socket: o.socket } : {}),
        ...(o.now ? { now: o.now } : {}),
        ...(o.timers ? { timers: o.timers } : {})
      });
      const f: FriendSeat = {
        seat, side: SEAT_SIDE[seat]!, socket, joined: false, name: `Player ${seat + 1}`, pick: null, heard: -Infinity,
        have: 0, sent: 0, haveAt: this.clock(), tick: 0, seq: 0, queue: [], standIn: false, left: false, lagSince: null, lagWaived: false,
        budget: SEND_BURST, budgetAt: this.clock()
      };
      // (a new connection: what the old one carried may be lost: send the log again from what they last said they hold)
      socket.onOpen = () => {
        f.sent = f.have;
        if (this.phase === "lobby") this.sendLobby(f);
      };
      socket.onError = (message) => this.onError?.(seat, message);
      this.seats.push(f);
    }
  }

  /** The lobby's seats as every page shows them. */
  views(): SeatView[] {
    const out: SeatView[] = [{ seat: 0, side: SEAT_SIDE[0]!, kind: "host", name: this.name, pick: this.pick, online: true }];
    for (const f of this.seats)
      out.push({ seat: f.seat, side: f.side, kind: f.joined ? "friend" : "open", name: f.name, pick: f.pick, online: this.online(f) });
    return out;
  }

  /** Is the friend there now (an open socket we've heard from lately)? */
  online(f: FriendSeat): boolean {
    return f.joined && !f.left && f.socket.state === "open" && this.clock() - f.heard < 4000;
  }

  setPick(id: OpenerId): void {
    this.pick = id;
    this.broadcastLobby();
    this.onChange?.();
  }

  setName(name: string): void {
    this.name = name.replace(/[\u0000-\u001f<>&"]/g, "").slice(0, 24) || "Host";
    this.broadcastLobby();
    this.onChange?.();
  }

  /**
   * Start the battle: every seat nobody joined goes to a commander, and the
   * setup goes out to the friends who did (a friend who joins later can't).
   */
  start(): FfaSetup {
    if (this.match) return this.match.setup;
    const o = this.o;
    const rnd = () => (o.random() * 0x7fffffff) | 0;
    // (the rules may ban an opener, Air War's Fab Plants: every pick is checked against a world set up without any)
    const bare = setupWorld({ map: o.map, seed: 0, mutators: o.mutators, openers: {} });
    const seats: SeatPlan[] = [{ side: SEAT_SIDE[0]!, kind: "human", name: this.name }];
    for (const f of this.seats)
      seats.push(f.joined && !f.left ? { side: f.side, kind: "human", name: f.name } : { side: f.side, kind: "ai", plan: o.plan(o.difficulty), difficulty: o.difficulty, seed: rnd() });
    const seed = rnd();
    const openers: Partial<Record<Faction, OpenerId>> = {};
    seats.forEach((p, i) => {
      const want = p.kind === "ai" ? seatMarshal(p.side, p.seed, p.difficulty, p.plan).opener! : i === 0 ? this.pick : this.seats[i - 1]!.pick ?? OPENER_IDS[0]!;
      const ok = allowedOpener(bare, p.side, want);
      if (ok) openers[p.side] = ok;
    });
    const setup: FfaSetup = {
      id: `${this.code}-${rnd().toString(36)}`,
      map: o.map, seed, mutators: o.mutators.slice(), openers, seats,
      // (a stand-in plays for a person: Normal)
      standIn: { plan: o.plan("normal"), difficulty: "normal", seed: rnd() }
    };
    this.match = new FfaMatch(setup);
    this.phase = "playing";
    // (a seat that went to a commander keeps its room: a friend opening its link late hears the battle started without them)
    for (const f of this.seats) {
      if (!f.joined || f.left) continue;
      f.have = f.sent = 0;
      f.haveAt = this.clock();
      this.send(f, { t: "start", setup });
    }
    this.onChange?.();
    return setup;
  }

  /** The host's own orders, given this tick: they land HOST_DELAY ticks on. */
  orders(cmds: readonly Command[], tick: number): void {
    for (const c of cmds) for (const part of splitOrder(c)) this.own.push({ due: tick + HOST_DELAY, c: part });
  }

  /**
   * Seal tick `tick` into the log (once): the seats changing hands, every order
   * that has reached the host for it, then the tick's end. False while a
   * friend falling behind makes the host wait.
   */
  seal(tick: number): boolean {
    const m = this.match;
    if (!m) return false;
    if (tick < m.sealed()) return true;
    if (this.waiting(tick)) return false;
    this.watchSeats(tick);
    const ev: LogEvent[] = [...this.controls.splice(0)];
    for (const f of this.seats) {
      // (a stand-in plays the seat: its person's late orders go nowhere)
      if (!m.aiPlays(f.side)) ev.push(...f.queue);
      f.queue.length = 0;
    }
    while (this.own.length && this.own[0]!.due <= tick) ev.push(this.own.shift()!.c);
    ev.push(tick);
    m.append(ev);
    return true;
  }

  /** After the host steps a tick: its world hash goes into the log at check ticks, and the log goes out. */
  stepped(hash: string | null, tick: number): void {
    if (hash !== null) this.match?.append([{ h: [tick, hash] }]);
    this.flush();
  }

  /** Send every friend the log they're missing (and resend what seems lost). Call every frame. */
  flush(): void {
    const m = this.match;
    if (!m) return;
    const now = this.clock();
    for (const f of this.seats) {
      if (!f.joined || f.left || f.socket.state !== "open") continue;
      if (f.have < f.sent && now - f.haveAt > RESEND_MS) {
        f.sent = f.have;
        f.haveAt = now;
      }
      if (f.sent >= m.log.length) continue;
      let from = f.sent;
      // (the envelope: {"t":"ev","from":123456,"e":[…],"ack":12345}; a long catch-up in pieces, at the relay's pace)
      for (const e of chunk(m.log.slice(f.sent, f.sent + 4000), 48)) {
        if (this.refill(f) < 11) break; // (room kept for pongs and the end)
        this.send(f, { t: "ev", from, e, ack: f.seq - 1 });
        from += e.length;
      }
      f.sent = from;
    }
  }

  /** Who the host is waiting for, if anyone (the HUD's "Waiting for…" line). */
  waitingFor(): FriendSeat | null {
    return this.seats.find((f) => f.lagSince !== null && !f.lagWaived) ?? null;
  }

  /** The battle is over or abandoned: tell the friends, and let the rooms go. */
  close(why: "left" | "desync" = "left"): void {
    if (this.phase === "ended") return;
    this.phase = "ended";
    for (const f of this.seats) {
      if (f.joined) this.send(f, { t: "end", why });
      // (a moment for the end to go out before the socket goes)
      (this.o.timers ?? { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) }).setTimeout(() => f.socket.close(), 300);
    }
  }

  // ------------------------------------------------------------- inside ---

  /** Should the host hold tick `tick` for a friend falling behind? */
  private waiting(tick: number): boolean {
    const now = this.clock();
    let wait = false;
    for (const f of this.seats) {
      const live = this.online(f) && !f.standIn;
      if (!live || tick - f.tick <= LAG_TICKS) {
        if (f.lagSince !== null && (!live || tick - f.tick <= LAG_TICKS / 2)) {
          f.lagSince = null;
          f.lagWaived = false;
        }
        continue;
      }
      f.lagSince ??= now;
      if (!f.lagWaived && now - f.lagSince > STALL_MAX_MS) f.lagWaived = true;
      if (!f.lagWaived) wait = true;
    }
    return wait;
  }

  /** Seats changing hands this tick: a friend gone quiet gets a stand-in, and one back (and caught up) gets the seat back. */
  private watchSeats(tick: number): void {
    const m = this.match!;
    const now = this.clock();
    for (const f of this.seats) {
      if (!f.joined || m.setup.seats[f.seat]?.kind !== "human") continue;
      const gone = f.left || now - f.heard > DROP_MS;
      if (gone && !f.standIn) {
        f.standIn = true;
        this.controls.push({ ai: f.side, on: true });
        this.onChange?.();
      } else if (!gone && f.standIn && !f.left && this.online(f) && tick - f.tick <= RETURN_TICKS) {
        f.standIn = false;
        this.controls.push({ ai: f.side, on: false });
        this.onChange?.();
      }
    }
  }

  private send(f: FriendSeat, msg: HostMsg): void {
    this.refill(f);
    f.budget -= 1;
    f.socket.send(JSON.stringify(msg));
  }

  /** The messages the seat's socket may send now (SEND_RATE a second, up to SEND_BURST). */
  private refill(f: FriendSeat): number {
    const now = this.clock();
    f.budget = Math.min(SEND_BURST, f.budget + ((now - f.budgetAt) / 1000) * SEND_RATE);
    f.budgetAt = now;
    return f.budget;
  }

  private sendLobby(f: FriendSeat): void {
    const o = this.o;
    this.send(f, { t: "lobby", proto: FFA_PROTO, seat: f.seat, seats: this.views(), map: o.map, mutators: o.mutators.slice(), difficulty: o.difficulty });
  }

  private broadcastLobby(): void {
    if (this.phase !== "lobby") return;
    for (const f of this.seats) if (f.joined) this.sendLobby(f);
  }

  private receive(seat: number, text: string): void {
    const f = this.seats[seat - 1]!;
    const msg = readGuestMsg(text);
    if (!msg) return;
    f.heard = this.clock();
    this.handle(f, msg);
  }

  private handle(f: FriendSeat, msg: GuestMsg): void {
    const m = this.match;
    switch (msg.t) {
      case "hello": {
        if (msg.proto !== FFA_PROTO || msg.build !== this.o.build) {
          this.send(f, { t: "end", why: "version" });
          return;
        }
        // (a page that doesn't hold the battle, once it's decided: it waits for the host's next lobby)
        if (m?.world.winner && msg.match !== m.setup.id) {
          this.send(f, { t: "over" });
          return;
        }
        // (once the battle is under way, only the person it was set up with sits here)
        if (m && m.setup.seats[f.seat]?.kind !== "human") {
          this.send(f, { t: "end", why: "started" });
          return;
        }
        const fresh = !f.joined;
        f.joined = true;
        f.left = false;
        if (msg.name) f.name = msg.name;
        if (m) {
          // a rejoin: the setup again if their page doesn't hold this match, then the log from what they have
          const same = msg.match === m.setup.id && msg.have >= 0;
          if (!same) {
            this.send(f, { t: "start", setup: m.setup });
            // (a fresh page numbers its orders from 0 again)
            f.seq = 0;
            f.queue.length = 0;
          }
          f.have = f.sent = same ? Math.min(msg.have, m.log.length) : 0;
          f.haveAt = this.clock();
          this.flush();
        } else this.broadcastLobby();
        if (fresh || !m) this.onChange?.();
        return;
      }
      case "pick":
        if (this.phase !== "lobby") return;
        f.pick = msg.opener;
        this.broadcastLobby();
        this.onChange?.();
        return;
      case "cmd": {
        // in order: the part we haven't had yet (a resend overlaps what arrived), nothing past a gap
        if (msg.seq > f.seq) return;
        const fresh = msg.c.slice(f.seq - msg.seq);
        f.seq += fresh.length;
        if (!m) return;
        for (const raw of fresh) {
          const c = sanitizeCommand(raw, f.side);
          if (c) f.queue.push(...splitOrder(c));
        }
        return;
      }
      case "at":
        if (msg.have > f.have) {
          f.have = msg.have;
          f.haveAt = this.clock();
        }
        f.tick = Math.max(f.tick, msg.tick);
        return;
      case "desync":
        this.onDesync?.(msg.tick);
        return;
      case "ping":
        this.send(f, { t: "pong", at: msg.at });
        return;
      case "bye":
        f.left = true;
        if (this.phase === "lobby") {
          f.joined = false;
          f.pick = null;
          this.broadcastLobby();
        }
        this.onChange?.();
        return;
    }
  }
}
