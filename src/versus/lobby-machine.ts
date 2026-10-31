/**
 * The duel lobby's state machine: pairing, capture readiness, audio checks,
 * and session teardown. No sheet or game audio is imported here; the clock,
 * links, rig, guard and lifecycle callbacks come through LobbyEnv.
 * See lobby.ts's header for the lobby's behavior and SOUND-DUEL.md references.
 */
import type { ModemStats } from "../link/modem/core";
import { CAPTURE_OK_MS, RigError, type MicMode, type Rig, type RigErrorReason } from "../link/rig";
import type { BandPlan, BandRole, LinkTransport } from "../link/transport";
import type { OpenerId } from "../sim/openers";
import type { MutatorId } from "../sim/rules";
import type { Faction } from "../sim/types";
import { NetError } from "./net-transport";
import { NOTHING_HEARD_MS, VERSION_MESSAGE, type HostOffer, type PairingState } from "./pairing";
import type { RematchPlan } from "./records";
import { PEER_HEARD_MS, RX_SILENT_MS, Session } from "./session";

/** ?duel=loop and ?duel=relay: a practice link, no sound. */
export type PracticeMode = "loop" | "relay";

/** What the lobby remembers between duels. */
export interface LobbyPrefs {
  /** The band plan a host transmits in. */
  plan: BandPlan;
  micMode: MicMode;
}

// ------------------------------------------------------------ the logic ---

/** Where the lobby is. */
export type LobbyStep =
  /** The rig is opening: the microphone prompt. */
  | "opening"
  /** The link's context isn't running: "Tap to start sound". */
  | "tap-to-start"
  /** Placement, Host / Join, Advanced. */
  | "choose"
  /** The link is being made (the worklet loading). */
  | "connecting"
  /** One phone listening to itself. */
  | "self-test"
  /** Listening, or linking: the meter and the hints. */
  | "pairing"
  /** Paired: the opener cards. */
  | "picking"
  /** Picked: waiting for the friend's pick. */
  | "waiting"
  /** This phone said GO: waiting for the friend's. */
  | "go"
  /** Both said GO: waiting for steady capture before the match loads. */
  | "loading"
  /** The feed is built and the match starting: the lobby is done. */
  | "started"
  | "error"
  /** Cancelled or failed: the sheet is gone (the link may still be saying the end). */
  | "closed";

export interface LobbyError {
  /** "modem": the link's modem stopped (its words are the message). "online": the relay couldn't be reached, or ended the link. */
  kind: "rig" | "version" | "failed" | "relay" | "left" | "modem" | "online" | "other";
  message: string;
  /** A rig error's reason. */
  reason?: RigErrorReason;
  /** A version error: which phone runs the older protocol (null: can't tell). */
  older?: "this" | "friend" | null;
}

/** The link the lobby holds: a LinkTransport, with the modem's extras where it has them (RigLink). */
export interface LobbyLink extends LinkTransport {
  setGain?(gain: number): void;
  modemStats?(): ModemStats | null;
  /** The modem's errors (RigLink: the worklet's, kept across rebuilds). */
  onError?: ((message: string) => void) | null;
  /** The modem stopped (RigLink.stopped): its error was fatal, not a refused message. */
  readonly stopped?: boolean;
}

/** What the lobby uses of the rig. */
export type LobbyRig = Pick<Rig, "state" | "ready" | "wakeLockSupported" | "captureOkMs" | "reconnect" | "setMicMode" | "close" | "rateProblem">;

/** Why the lobby let the duel's audio go without a match. */
export type LobbyEnd = "cancel" | "error" | "fallback";

export interface LobbyEnv {
  /** Monotonic milliseconds (performance.now). */
  now(): number;
  build: number;
  /** The nonce draw. */
  random(): number;
  /** The rig the tap opened; null on a practice link. */
  rig: LobbyRig | null;
  practice: PracticeMode | null;
  /** A link in these bands; `offer` is the host's, whoever hosts (the loop's friend may). Rejects with a RigError, or an Error named "RelayError". */
  link(cfg: { plan: BandPlan; tx: BandRole; rx: BandRole | "detect" }, offer: HostOffer): Promise<LobbyLink>;
  /** The game audio's band guard (null: off), at its full cut whatever the microphone mode (audio.ts GUARD_CUT_DB). Practice links have none. */
  guard(plan: BandPlan | null): void;
  /** The menu's shownMap() and activeMutators() at the tap, and the side the host plays. */
  offer: { map: string; mutators: MutatorId[]; hostSide: Faction };
  /** Pair at once: a rematch (its role, plan, and the host's map, mutators and side), or a relay seat. */
  rematch: RematchPlan | null;
  seat: BandRole | null;
  /** An online duel (relay/README.md): the room and its invite link. Its seat is `seat`; no rig and no guard, as on a practice link. */
  online?: OnlineRoom | null;
  prefs: LobbyPrefs;
  savePrefs(p: LobbyPrefs): void;
  /** The match is agreed and capture is steady: build the feed and start it (throws: the lobby shows the error). */
  begin(session: Session, link: LobbyLink): void;
  /** The audio is let go with no match (the session closed, the rig closed, the guard off). */
  released(why: LobbyEnd): void;
}

/** An online duel's room: its code, and the link the host sends. */
export interface OnlineRoom {
  code: string;
  invite: string;
}

/** The link meter, both ways. */
export interface LobbyMeter {
  /** This phone's receive SNR of the friend (dB), good and bad packets, and its quality 0–7. */
  snrDb: number | null;
  good: number;
  bad: number;
  rxq: number;
  /** The friend's receive quality of this phone (0–7), from its newest frame. */
  peerRxq: number | null;
  rttMs: number | null;
}

export interface LobbyView {
  step: LobbyStep;
  role: BandRole | null;
  practice: PracticeMode | null;
  online: OnlineRoom | null;
  rematch: boolean;
  /** Pairing in a role it can't switch (a rematch, a relay seat). */
  fixedRole: boolean;
  prefs: LobbyPrefs;
  error: LobbyError | null;
  /** The rig lost its audio: "Tap to reconnect the sound link". */
  lost: boolean;
  /** The screen can't be kept on: set Auto-Lock to Never. */
  noWakeLock: boolean;
  /** Nothing heard for 8 s: one phone Host, the other Join (with the switch). */
  switchRole: boolean;
  /** Nothing heard for 30 s. */
  tips: boolean;
  /** The friend was heard, and nothing since for QUIET_MS (pairing to GO). */
  quiet: boolean;
  /** The route check failed. */
  route: boolean;
  /** The transmit gain was lowered (loud own signal). */
  loud: boolean;
  meter: LobbyMeter | null;
  pairing: PairingState | null;
  /** Back to Host / Join is still possible (before GO). */
  canBack: boolean;
}

/** The route check (SOUND-DUEL.md "The lobby"): own signal under this … */
export const ROUTE_SNR_DB = 10;
/** … for this long. */
export const ROUTE_MS = 3000;
/** No own-signal reading counts only from this long after the link started: the self-monitor's first sync. */
export const ROUTE_GRACE_MS = 2050;
/** Loud own signal: a stats report whose microphone peak is above −6 dBFS … */
export const LOUD_PEAK = 10 ** (-6 / 20);
/**
 * … while the self-monitor hears this phone's own signal at all (the route
 * check's threshold: an own signal clipping the microphone reads 11–24 dB at
 * 3–6× full scale, see lobby.ts's header) …
 */
export const LOUD_OWN_SNR_DB = ROUTE_SNR_DB;
/** … in every report for this long (a clap, a knock or a word has gone by then) … */
export const LOUD_MS = 2000;
/** … drops the gain by 3 dB, at most once per GAIN_STEP_MS, down to GAIN_MIN (−6 dB: the friend still hears this phone within 6 dB of its usual). */
export const GAIN_STEP = 10 ** (-3 / 20);
export const GAIN_STEP_MS = 1000;
export const GAIN_MIN = 0.5;
/** The gain the lobby chooses (the modem's default; the modem is offered up to 1.1) … */
export const GAIN_START = 1;
/** … and climbs back to, by 1 dB at most once per GAIN_RISE_MS, once no loud report has come for GAIN_QUIET_MS. */
export const GAIN_RISE = 10 ** (1 / 20);
export const GAIN_RISE_MS = 2000;
export const GAIN_QUIET_MS = 5000;
/** Nothing heard this long after the role was tapped: tips. */
export const TIPS_MS = 30_000;
/** A rematch with nothing heard this long falls back to the menu. */
export const REMATCH_FALLBACK_MS = 60_000;
/** A friend heard and then silent this long: "Your friend's phone has gone quiet". */
export const QUIET_MS = NOTHING_HEARD_MS;

const otherRole = (r: BandRole): BandRole => (r === "host" ? "guest" : "host");

/** The link's modem stopped, or never started: an error after which it no longer reports. */
class ModemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModemError";
  }
}

/** The lobby's logic, DOM-free: call update() every frame, read state(), and send it the taps. */
export class LobbyMachine {
  private step: LobbyStep;
  private role: BandRole | null = null;
  private selfTest = false;
  private session: Session | null = null;
  private link: LobbyLink | null = null;
  /** Bumped by every role start and every close: a link that resolves for an older one is let go. */
  private gen = 0;
  private fatal: LobbyError | null = null;
  private released = false;
  /** Sessions saying the end (left) until they may close. */
  private ending: Session[] = [];
  /** Cancelled or failed: the audio goes once nothing is left to say. */
  private closing: LobbyEnd | null = null;
  private sessionAt = 0;
  private linkAt = 0;
  private guardPlan: BandPlan | null;
  private routeSince: number | null = null;
  private route = false;
  private gain = GAIN_START;
  /** When the gain last changed, the unbroken run of loud reports started (null: none now), and the last loud report came. */
  private gainAt = -Infinity;
  private loudSince: number | null = null;
  private loudAt = -Infinity;
  private peakSample = -1;

  constructor(private readonly env: LobbyEnv) {
    // (the tap turned the guard on in the high plan: practice links and online duels have none)
    this.guardPlan = env.practice || env.online ? null : "high";
    const rig = env.rig;
    if (!rig) {
      this.step = "choose";
      this.ready();
      return;
    }
    this.step = "opening";
    rig.ready.then(
      (r) => {
        if (this.step !== "opening") return;
        if (r === "running" || rig.state === "running") this.ready();
        else this.step = "tap-to-start";
      },
      (e: unknown) => this.fail(e)
    );
  }

  /** The lobby is finished with: the match started, or the audio let go. */
  get done(): boolean {
    return this.step === "started" || this.released;
  }

  // --------------------------------------------------------------- taps ---

  host(): void {
    if (this.step === "choose") void this.begin("host", false);
  }

  join(): void {
    if (this.step === "choose") void this.begin("guest", false);
  }

  startSelfTest(): void {
    if (this.step === "choose" && !this.env.practice && !this.env.online) void this.begin("host", true);
  }

  /** The 8 s hint's one-tap switch: the other role, at once. */
  switchRole(): void {
    if (this.step !== "pairing" || !this.role || this.state().fixedRole) return;
    const next = otherRole(this.role);
    this.dropSession();
    void this.begin(next, false);
  }

  /** Back to Host / Join (before GO). */
  back(): void {
    if (!this.state().canBack) return;
    this.dropSession();
    this.role = null;
    this.selfTest = false;
    this.step = "choose";
  }

  /** "Pairing failed: tap to retry". The tips' and a rematch's clocks start again, as the pairing's hint does. */
  retry(): void {
    if (!this.session) return;
    this.session.retry();
    this.sessionAt = this.env.now();
  }

  pick(id: OpenerId): boolean {
    return this.session?.pick(id) ?? false;
  }

  /** "Tap to start sound", and "Tap to reconnect the sound link": inside the tap. */
  tapToStart(): void {
    void this.env.rig?.reconnect();
  }

  setPlan(plan: BandPlan): void {
    this.env.prefs.plan = plan;
    this.env.savePrefs(this.env.prefs);
  }

  setMicMode(mode: MicMode): void {
    if (mode === this.env.prefs.micMode) return;
    this.env.prefs.micMode = mode;
    this.env.savePrefs(this.env.prefs);
    // (the rig asks for the old mode again if the new request fails)
    this.env.rig?.setMicMode(mode).catch((e: unknown) => console.warn("microphone mode:", e));
  }

  /** Cancel, or Close on an error: say the end to a friend that may have started, then let the audio go. */
  cancel(): void {
    if (this.step === "started" || this.step === "closed") return;
    this.close("cancel");
  }

  // ------------------------------------------------------------ driving ---

  /** Every frame (and from a fallback timer): the rig, the session, the meter, the checks. */
  update(): void {
    if (this.released || this.step === "started") return;
    const now = this.env.now();
    // (the end on the air until the friend can have it)
    this.ending = this.ending.filter((s) => {
      s.pump();
      if (!s.status().closable) return true;
      s.close();
      return false;
    });
    if (this.closing) {
      if (!this.ending.length) this.release(this.closing);
      return;
    }
    if (this.step === "closed" || this.fatal) return;
    const rig = this.env.rig;
    if (rig && this.step === "tap-to-start" && rig.state === "running") this.ready();
    const s = this.session;
    if (!s) return;
    s.pump();
    const st = s.status();
    const link = this.link!;
    this.watchLink(link, now);
    if (this.selfTest) return;
    if (st.phase === "pairing") {
      const p = st.pairing;
      this.step = p.phase === "picking" ? "picking" : p.phase === "waiting" ? "waiting" : p.phase === "go" ? "go" : "pairing";
      if (this.env.rematch && !p.heard && now - this.sessionAt >= REMATCH_FALLBACK_MS) this.close("fallback");
    } else if (st.phase === "starting") {
      this.step = "loading";
      if (st.peerEnded) return;
      if (rig && rig.captureOkMs() < CAPTURE_OK_MS) return;
      this.step = "started";
      try {
        this.env.begin(s, link);
      } catch (e) {
        console.error(e);
        this.step = "error";
        this.fatal = { kind: "other", message: e instanceof Error ? e.message : String(e) };
        this.close("error");
      }
    }
  }

  state(): LobbyView {
    const env = this.env;
    const now = env.now();
    const st = this.session && !this.released ? this.session.status() : null;
    const p = st?.pairing ?? null;
    const fixedRole = env.rematch !== null || env.seat !== null;
    const live = st !== null && this.step !== "closed";
    const link = st?.link;
    const error = this.fatal ?? (live ? this.pairingError(st.pairing, st.peerEnded) : null);
    const before = this.step === "pairing" || this.step === "picking" || this.step === "waiting";
    // (the friend's numbers only while they are current: its frames, and packets at all)
    const peerFresh = st !== null && (st.pairing.sinceHeardMs <= PEER_HEARD_MS || (st.phase === "starting" && st.link.sinceRx <= PEER_HEARD_MS));
    return {
      step: error && this.step !== "closed" ? "error" : this.step,
      role: this.role,
      practice: env.practice,
      online: env.online ?? null,
      rematch: env.rematch !== null,
      fixedRole,
      prefs: { ...env.prefs },
      error,
      lost: env.rig?.state === "lost",
      noWakeLock: env.rig !== null && !env.rig.wakeLockSupported,
      switchRole: live && !this.selfTest && !fixedRole && !!p?.hint && !p.heard,
      tips: live && !this.selfTest && p !== null && !p.heard && now - this.sessionAt >= TIPS_MS,
      quiet: live && !this.selfTest && !error && (before || this.step === "go") && p !== null && p.heard && p.sinceHeardMs >= QUIET_MS,
      route: this.route,
      // (the route warning says the phone can't hear itself: a note that it hears itself loudly would contradict it)
      loud: this.gain < GAIN_START && !this.route,
      meter: link
        ? {
            snrDb: link.sinceRx <= RX_SILENT_MS ? link.snrDb : null,
            good: link.rxOk,
            bad: link.rxBad,
            rxq: st.rxq,
            peerRxq: this.selfTest || !peerFresh ? null : st.peerRxq,
            rttMs: st.rttMs
          }
        : null,
      pairing: p,
      canBack: !fixedRole && !error && (this.step === "self-test" || (before && p !== null && !p.go))
    };
  }

  // ------------------------------------------------------------- inside ---

  private pairingError(p: PairingState, peerEnded: "left" | "desync" | null): LobbyError | null {
    if (p.error?.kind === "version") {
      const older = p.error.older;
      return { kind: "version", message: VERSION_MESSAGE, older };
    }
    if (p.phase === "failed") return { kind: "failed", message: p.error?.message ?? "Pairing failed: tap to retry" };
    // (from this phone's GO on: the friend may have started on it, and the session says it has gone)
    if (peerEnded && (p.go || this.step === "loading")) return { kind: "left", message: "Your friend left" };
    return null;
  }

  /** The rig is in and running: pair at once (a rematch, a relay seat), or offer Host / Join. */
  private ready(): void {
    this.step = "choose";
    const role = this.env.rematch?.role ?? this.env.seat;
    if (role) void this.begin(role, false);
  }

  /** The host's offer, whoever hosts. */
  private offer(): HostOffer {
    const r = this.env.rematch;
    if (r) return { map: r.mapId, mutators: r.mutators, hostSide: r.hostSide };
    return { map: this.env.offer.map, mutators: this.env.offer.mutators, hostSide: this.env.offer.hostSide };
  }

  private async begin(role: BandRole, selfTest: boolean): Promise<void> {
    const env = this.env;
    const gen = ++this.gen;
    this.role = role;
    this.selfTest = selfTest;
    this.step = "connecting";
    this.route = false;
    this.routeSince = null;
    const stored = env.rematch?.plan;
    let cfg: { plan: BandPlan; tx: BandRole; rx: BandRole | "detect" };
    if (selfTest) cfg = { plan: env.prefs.plan, tx: "host", rx: "host" };
    else if (role === "host") cfg = { plan: stored ?? env.prefs.plan, tx: "host", rx: "guest" };
    else if (stored) cfg = { plan: stored, tx: "guest", rx: "host" };
    // (a Join detects the host's plan; it transmits in the high plan's guest band where the rate allows)
    else cfg = { plan: env.rig?.rateProblem("high") ? "low" : "high", tx: "guest", rx: "detect" };
    let link: LobbyLink;
    try {
      link = await env.link(cfg, this.offer());
    } catch (e) {
      if (gen === this.gen) this.fail(e);
      return;
    }
    if (gen !== this.gen || this.released || this.step !== "connecting") {
      link.close();
      return;
    }
    const now = env.now();
    this.link = link;
    link.onError = (message) => this.linkError(link, message);
    this.linkAt = now;
    this.sessionAt = now;
    this.gain = GAIN_START;
    this.gainAt = -Infinity;
    this.loudSince = null;
    this.loudAt = -Infinity;
    this.peakSample = -1;
    this.session = new Session({ transport: link, role, build: env.build, random: env.random, ...(role === "host" ? { host: this.offer() } : {}) });
    this.step = selfTest ? "self-test" : "pairing";
    // (a Join that detects keeps the guard it has until its link locks on a plan)
    this.setGuard(cfg.rx === "detect" ? this.guardPlan ?? cfg.plan : cfg.plan, true);
  }

  /** The route check, the loud-signal gain, and a Join's guard following the plan its link found. */
  private watchLink(link: LobbyLink, now: number): void {
    const stats = link.stats();
    if (this.role === "guest" && stats.locked && !this.selfTest) this.setGuard(stats.plan);
    if (!this.env.rig) return;
    const own = stats.ownSnrDb;
    const bad = own === null ? now - this.linkAt >= ROUTE_GRACE_MS : own < ROUTE_SNR_DB;
    if (bad) this.routeSince ??= now;
    else this.routeSince = null;
    this.route = this.routeSince !== null && now - this.routeSince >= ROUTE_MS;
    // the loud own signal, once per stats report (the worklet's, every 250 ms; none while they're stale)
    const ms = link.modemStats?.();
    if (!ms || ms.sample === this.peakSample) return;
    this.peakSample = ms.sample;
    if (ms.inputPeak > LOUD_PEAK && own !== null && own >= LOUD_OWN_SNR_DB) {
      this.loudSince ??= now;
      this.loudAt = now;
    } else this.loudSince = null;
    let gain = this.gain;
    if (this.loudSince !== null && now - this.loudSince >= LOUD_MS) {
      if (now - this.gainAt >= GAIN_STEP_MS) gain = Math.max(GAIN_MIN, gain * GAIN_STEP);
    } else if (gain < GAIN_START && now - this.loudAt >= GAIN_QUIET_MS && now - this.gainAt >= GAIN_RISE_MS) {
      gain = Math.min(GAIN_START, gain * GAIN_RISE);
    }
    if (gain === this.gain) return;
    this.gain = gain;
    this.gainAt = now;
    link.setGain?.(gain);
  }

  /** The guard on `plan` (`force`: even if it should be on it already). */
  private setGuard(plan: BandPlan, force = false): void {
    if (this.env.practice || this.env.online || (plan === this.guardPlan && !force)) return;
    this.guardPlan = plan;
    this.env.guard(plan);
  }

  /**
   * The modem's error (see lobby.ts's header). A link that says whether its modem
   * stopped (RigLink.stopped, set before onError) is taken at its word: a
   * refused message that came before the first stats report, or while they
   * were stale, isn't fatal. One that doesn't say falls back to its stats,
   * which WorkletTransport makes stale at once for a modem that stopped.
   */
  private linkError(link: LobbyLink, message: string): void {
    const ours = link === this.link && !this.released && this.step !== "started";
    const dead = link.stopped ?? !link.modemStats?.();
    if (ours && dead) this.fail(this.env.online ? new NetError(message) : new ModemError(message));
    else console.warn("sound link:", message);
  }

  private fail(e: unknown): void {
    if (this.released) return;
    console.warn("sound duel:", e);
    if (e instanceof RigError) this.fatal = { kind: "rig", reason: e.reason, message: e.message };
    else if (e instanceof Error && e.name === "RelayError") this.fatal = { kind: "relay", message: e.message };
    else if (e instanceof NetError) this.fatal = { kind: "online", message: e.message };
    else if (e instanceof ModemError) this.fatal = { kind: "modem", message: e.message };
    else this.fatal = { kind: "other", message: e instanceof Error ? e.message : String(e) };
    this.step = "error";
    this.dropSession();
    this.release("error");
  }

  /**
   * Let this role's session and link go (Back, a role switch, Cancel, an
   * error). Before GO there is nothing to tell and it closes at once; from GO
   * on it says the end (a stand-in, or the match's frames) until it may close.
   */
  private dropSession(): void {
    this.gen++;
    const s = this.session;
    const link = this.link;
    this.session = null;
    this.link = null;
    if (!s) return void link?.close();
    s.leave("left");
    if (s.status().closable) s.close();
    else this.ending.push(s);
  }

  private close(why: LobbyEnd): void {
    if (this.step !== "error") this.step = "closed";
    this.closing = why;
    this.dropSession();
    if (!this.ending.length) this.release(why);
  }

  private release(why: LobbyEnd): void {
    if (this.released) return;
    this.released = true;
    for (const s of this.ending) s.close();
    this.ending = [];
    this.session?.close();
    this.link?.close();
    this.env.rig?.close();
    if (this.guardPlan) this.env.guard(null);
    this.guardPlan = null;
    this.env.released(why);
  }
}
