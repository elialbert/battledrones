/**
 * The feed of a four-player online battle (FFA.md "In the battle"): the
 * MatchFeed GameScene plays it through, on the host's page and on each
 * friend's. Every page steps the same turn log (match.ts); the host seals it
 * (host.ts), a friend's page plays it as it arrives (guest.ts).
 *
 *   host:  feed = new FfaFeed({ host, local: "blue" })        (host.start() first)
 *   guest: feed = new FfaFeed({ guest, local: guest.side })   (once guest.onStart)
 *   main.ts: begin(false, () => ffaSetup(feed), feed)
 *
 * Each tick it drains this page's orders (the host's own land HOST_DELAY
 * ticks on, a friend's go to the host and come back sealed into a tick) and
 * hands the scene that tick's orders, every side's, or null to hold: a
 * friend's page while the log hasn't reached the tick, the host's while it
 * waits for a friend falling behind. After each step the host's page puts
 * its world hash into the log now and then; a friend's page compares its own,
 * and the first that differs ends the battle for everyone (no contest).
 *
 * Where the spec is silent:
 *  - the pause menu doesn't stop the battle (live): three other people are
 *    still playing it. Its ways out are Resign (your side is knocked out, the
 *    others play on) and Leave: a friend's seat goes to an AI stand-in, the
 *    host's page leaving ends the battle for everyone (it holds the battle);
 *  - a friend's page catches up on a log it holds but hasn't played (a
 *    rejoin, or back from the background) at up to CATCH_UP_MAX× speed, and
 *    trims its pace around 1× to keep a couple of ticks in hand;
 *  - a friend's page whose log runs dry after the host's page went ends with
 *    "Host left"; one that already holds the rest plays it out to the result;
 *  - every order this page drains is in flight (Controller.inFlight) until a
 *    step applies it, or for SETTLE_TICKS at most (the host drops a seat's
 *    late orders once a stand-in plays it).
 */
import type { BattleRecord } from "../arena/record";
import type { Controller } from "../game/controller";
import type { AbortReason, MatchFeed } from "../game/GameScene";
import { STRATEGIES } from "../sim/ai/commander";
import type { Command, Faction, PerSide, World } from "../sim/types";
import type { DuelHud } from "../ui/hud";
import { SIDE_NAME } from "../game/side-style";
import { fullscreen } from "../ui/fullscreen";
import { HOST_DELAY, type FfaHost } from "./host";
import type { FfaGuest } from "./guest";
import type { FfaMatch } from "./match";
import { splitOrder, type FfaSetup } from "./protocol";

/** An order drained this many ticks ago and not stepped yet never will be: it stops counting as on its way. */
const SETTLE_TICKS = 150;
/** "Waiting for…" shows after this long with nothing to step. */
const WAIT_SHOW_MS = 600;
/** A friend's page far behind the log plays it this much faster at most (8 ticks a frame caps it anyway). */
const CATCH_UP_MAX = 60;

/** What the feed needs of the scene: GameScene, or a stand-in in tests. */
export interface FfaScene {
  readonly ctrl: Controller;
  abort(reason: AbortReason, info?: string): void;
  /** A line in the alert ticker. */
  alert(msg: string): void;
}

/** The browser around the feed (tests pass their own pieces). */
export interface FfaFeedEnv {
  document: Document | null;
  /** sessionStorage, or null where blocked (the rematch). */
  session: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  /** Back to the menu (or into the rematch). */
  reload(): void;
  /** Forget the invite link in the address bar (a friend leaving for the menu). */
  forgetInvite(): void;
  setTimeout(fn: () => void, ms: number): unknown;
  now(): number;
}

export interface FfaFeedOptions {
  host?: FfaHost;
  guest?: FfaGuest;
  /** The side this page plays. */
  local: Faction;
  env?: Partial<FfaFeedEnv>;
}

/** What the rematch stores (sessionStorage): the host opens a new lobby with the same code, the friends' links still lead there. */
export const FFA_REMATCH_KEY = "battledrones.ffa";
export interface FfaRematch {
  code: string;
  map: string;
  mutators: string[];
  difficulty: string;
}

function browserEnv(): FfaFeedEnv {
  const session = (() => {
    try {
      return window.sessionStorage;
    } catch {
      return null;
    }
  })();
  return {
    document: typeof document === "undefined" ? null : document,
    session,
    reload: () => fullscreen.reload(),
    forgetInvite: () => history.replaceState(history.state, "", location.pathname + location.search),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    now: () => performance.now()
  };
}

/** Who plays a seat, for the labels: a person's name, or the commander's personality. */
export const seatLabel = (s: FfaSetup["seats"][number]): string => (s.kind === "human" ? s.name : `${STRATEGIES[s.strategy].label} AI`);

export class FfaFeed implements MatchFeed {
  readonly world: World;
  readonly local: Faction;
  readonly labels: PerSide<string>;
  readonly opponent = "your friends";
  readonly live = true;
  readonly duel: DuelHud;
  readonly match: FfaMatch;
  readonly host: FfaHost | null;
  readonly guest: FfaGuest | null;
  private readonly env: FfaFeedEnv;
  private scene: FfaScene | null = null;
  private stepping: Command[] = [];
  private aborted: AbortReason | null = null;
  private resigned = false;
  private leaving = false;
  /** Since when there has been nothing to step (null: there is). */
  private stalledSince: number | null = null;
  /** Who played each seat at the last step (people or commanders), to say when a seat changes hands. */
  private standIns = new Set<Faction>();
  private status: HTMLElement | null = null;
  private statusText = "";

  constructor(o: FfaFeedOptions) {
    const match = o.host?.match ?? o.guest?.match;
    if (!match) throw new Error("FfaFeed: no match yet");
    this.match = match;
    this.world = match.world;
    this.local = o.local;
    this.host = o.host ?? null;
    this.guest = o.guest ?? null;
    this.env = { ...browserEnv(), ...o.env };
    this.labels = Object.fromEntries(match.setup.seats.map((s) => [s.side, seatLabel(s)])) as PerSide<string>;
    if (this.host) this.host.onDesync = () => this.abort("split");
    const hosting = !!this.host;
    this.duel = {
      opponent: this.opponent,
      delayMs: () => (this.host ? HOST_DELAY * 100 : Math.round(this.guest?.rtt ?? 0)),
      resign: () => this.resign(),
      leave: () => this.leave(),
      exits: () => ({ resignAndLeave: false, leave: true }),
      resigning: () => this.resigned || this.isOut(),
      rematch: () => this.exit(true),
      menu: () => this.exit(false),
      actions: () => [],
      practice: false,
      online: true,
      names: this.labels,
      asks: {
        resign: "Resign? Your side is knocked out and the others play on.",
        leave: hosting
          ? "Leave? The battle runs on this page: it ends for everyone, with no result."
          : "Leave the battle? An AI takes over your side.",
        leaveButton: hosting ? "End the battle and leave" : "Leave (an AI takes over)"
      }
    };
  }

  /** The host's knock-out note: its page holds the battle, so it should stay. */
  get outNote(): string | undefined {
    return this.host ? "You're out. Keep this page open: the battle runs on it. Watch the rest from here" : undefined;
  }

  // ------------------------------------------------------- MatchFeed ---

  attach(scene: FfaScene): void {
    this.scene = scene;
    const feed = this;
    // debug/testing handle (tools/ffa-smoke.mjs; harmless in production)
    if (this.env.document)
      (globalThis as Record<string, unknown>).__ffa = {
        feed: this,
        get tick() {
          return feed.world.tick;
        },
        trail: () => feed.match.trail(),
        desync: () => feed.match.desyncAt,
        sealed: () => feed.match.sealed()
      };
    const root = this.env.document?.getElementById("hud");
    if (root) {
      const el = this.env.document!.createElement("div");
      el.className = "ffa-status";
      el.hidden = true;
      el.setAttribute("role", "status");
      root.appendChild(el);
      this.status = el;
    }
  }

  commands(tick: number): Command[] | null {
    const scene = this.scene;
    if (!scene || this.aborted || this.leaving) return null;
    const drained = this.prepare(scene.ctrl.drainCommands());
    if (this.host) {
      if (drained.length) this.host.orders(drained, tick);
      if (!this.host.seal(tick)) return this.stall();
    } else if (drained.length) this.guest!.orders(drained);
    const cmds = this.match.commandsFor(tick);
    if (!cmds) {
      // (the host's page has gone, and the log with it: nothing more will come)
      if (this.guest?.phase === "ended") this.guestEnded();
      return this.stall();
    }
    this.stalledSince = null;
    this.stepping = cmds;
    return cmds;
  }

  afterTick(w: World): void {
    const hash = this.match.afterStep(w);
    this.host?.stepped(hash, w.tick);
    const ctrl = this.scene?.ctrl;
    ctrl?.landed(this.stepping.filter((c) => c.faction === this.local));
    ctrl?.settled(w.tick - 1 - SETTLE_TICKS);
    this.stepping = [];
    this.noteStandIns();
    if (this.guest && this.match.desyncAt !== null) {
      this.guest.desync(this.match.desyncAt);
      this.abort("split");
    }
  }

  frame(): void {
    this.host?.flush();
    const g = this.guest;
    if (g?.phase === "ended" && g.ended?.why === "desync") this.abort("split");
    this.showStatus();
  }

  keyframe(): World | null {
    return null;
  }

  /** A friend's page: catch up on log it holds, keep a couple of ticks in hand. The host's sets the pace. */
  speed(): number {
    if (!this.guest) return 1;
    const ahead = this.match.sealed() - this.world.tick;
    if (ahead > 30) return Math.min(CATCH_UP_MAX, ahead / 5);
    if (ahead > 8) return 1.5;
    if (ahead > 4) return 1.1;
    return ahead <= 1 ? 0.95 : 1;
  }

  battleRecord(): BattleRecord {
    return this.match.record();
  }

  /** How it ended with no result (null: it didn't). */
  get abortReason(): AbortReason | null {
    return this.aborted;
  }

  // ------------------------------------------------------------ inside ---

  /** Long unit lists split for the wire, a lifted Goliath kept with its Condors (sim/lift.ts). */
  private prepare(cmds: readonly Command[]): Command[] {
    const out: Command[] = [];
    for (const c of cmds) {
      const first = new Set<number>();
      if ("unitIds" in c)
        for (const id of c.unitIds) {
          const lift = this.world.units.get(id)?.goliath?.lift;
          if (lift) for (const x of [id, ...lift.carriers]) first.add(x);
        }
      out.push(...splitOrder(c, first));
    }
    return out;
  }

  private stall(): null {
    this.stalledSince ??= this.env.now();
    return null;
  }

  private isOut(): boolean {
    return !!this.world.out?.some((o) => o.faction === this.local);
  }

  /** A seat changed hands this tick: say so (a person dropped and an AI stands in, or they're back). */
  private noteStandIns(): void {
    for (const s of this.match.setup.seats) {
      if (s.kind !== "human") continue;
      const now = this.match.aiPlays(s.side);
      if (now === this.standIns.has(s.side)) continue;
      if (now) this.standIns.add(s.side);
      else this.standIns.delete(s.side);
      if (this.world.out?.some((o) => o.faction === s.side)) continue; // (nothing left to play)
      const who = s.side === this.local ? "You" : `${s.name} (${SIDE_NAME[s.side]})`;
      this.scene?.alert(
        now
          ? s.side === this.local
            ? "Your link dropped: an AI plays your side until you're back"
            : `${who} dropped: an AI plays for them until they're back`
          : s.side === this.local
            ? "You're back in command"
            : `${who} is back`
      );
    }
  }

  /** The host's page is gone (or the relay ended this seat) with log still to come: no result. */
  private guestEnded(): void {
    if (this.world.winner) return;
    this.abort(this.guest?.ended?.why === "desync" ? "split" : "host");
  }

  private abort(reason: AbortReason): void {
    if (this.aborted || this.world.winner) {
      // (decided already: the result stands, only the host's rooms go)
      if (reason === "split" && !this.aborted) this.host?.close("desync");
      return;
    }
    this.aborted = reason;
    this.host?.close(reason === "split" ? "desync" : "left");
    this.scene?.ctrl.dropInFlight();
    this.scene?.abort(reason);
  }

  private resign(): void {
    const scene = this.scene;
    if (!scene || this.resigned || this.aborted || this.world.winner || this.isOut()) return;
    scene.ctrl.enqueue({ type: "resign", faction: this.local });
    scene.ctrl.locked = true;
    scene.ctrl.placing = null;
    scene.ctrl.clearSelection();
    this.resigned = true;
  }

  /** Leave mid-battle: a friend's seat goes to a stand-in; the host's page ends it for everyone. */
  private leave(): void {
    this.exit(false);
  }

  /** Menu or Rematch: let the rooms go (the friends hear it), then reload. */
  private exit(rematch: boolean): void {
    if (this.leaving) return;
    this.leaving = true;
    const env = this.env;
    if (this.host) {
      const s = this.match.setup;
      if (rematch && env.session) {
        const plan: FfaRematch = { code: this.host.code, map: s.map, mutators: s.mutators.slice(), difficulty: s.standIn.difficulty };
        try {
          env.session.setItem(FFA_REMATCH_KEY, JSON.stringify(plan));
          env.session.setItem("battledrones.rematch", "ffa");
        } catch {
          /* storage blocked: the menu, then */
        }
      }
      this.host.close("left");
    } else {
      if (this.world.winner || this.aborted) this.guest!.close();
      else this.guest!.leave();
      // (a rematch keeps the invite link: the reload is its join screen again)
      if (!rematch) env.forgetInvite();
    }
    env.setTimeout(() => env.reload(), 400);
  }

  private showStatus(): void {
    const el = this.status;
    if (!el) return;
    const text = this.statusLine();
    if (text === this.statusText) return;
    this.statusText = text;
    el.textContent = text;
    el.hidden = text === "";
  }

  private statusLine(): string {
    if (this.aborted || this.leaving || this.world.winner) return "";
    const g = this.guest;
    if (g) {
      if (g.hostQuiet()) return "The host's page has gone quiet…";
      if (this.match.aiPlays(this.local) && !this.isOut()) return "Reconnecting: an AI plays your side meanwhile";
      if (this.match.sealed() - this.world.tick > 30) return "Catching up…";
    } else {
      const f = this.host!.waitingFor();
      if (f) return `Waiting for ${f.name} (${SIDE_NAME[f.side]})…`;
    }
    const s = this.stalledSince;
    if (s !== null && this.env.now() - s > WAIT_SHOW_MS) return g ? "Waiting for the host…" : "Waiting…";
    return "";
  }
}
