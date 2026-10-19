/**
 * The rig (SOUND-DUEL.md "Rig"): opening, watching, recovering and closing
 * the audio a sound duel runs on — the link's own AudioContext, the
 * microphone, the modem's worklet node, the wake lock and iOS's audio
 * session. The game's audio (and its band guard) is the lobby's business:
 * nothing here imports src/game.
 *
 * Open. openRig({ micMode }) runs inside the tap (the Duel button, or the
 * rematch's reconnect button), because only a gesture may start sound and
 * the microphone on a phone. Synchronously it sets the audio session to
 * "play-and-record", creates the context (latency "interactive", the
 * device's rate), resumes it and plays a 1-sample silent buffer, requests
 * the wake lock and calls getUserMedia. `ready` settles once the microphone
 * is in: the context is resumed again, and if it still isn't running the
 * rig waits in "tap-to-start" for reconnect() from the next tap.
 *
 * The link. createLink(cfg) loads the worklet (once per context), makes a
 * WorkletTransport and connects the microphone to its node. What it returns
 * is a RigLink: the same members as the WorkletTransport, held by the rig so
 * that a context rebuilt by reconnect() swaps a new transport in underneath
 * (the same t0, so now() runs on; the frames, mode, session key and config
 * replayed) without the session noticing.
 *
 * Capture. captureOkMs() is how long the microphone has been delivering
 * without a gap: since the later of the source's connection, the end of the
 * last capture gap the worklet reported, and the context last starting to
 * run; 0 while a gap is open, the context isn't running or there is no live
 * link. The lobby starts lockstep after 1.5 s of it (iOS leaves a hole of up
 * to 1.4 s right after the microphone opens), and the reconnect overlay
 * closes after the same.
 *
 * Lifecycle. While running, onLost(reason) fires once per loss: the track
 * ending, the track muted for more than 1 s, the context not running for
 * more than 0.5 s, or the audio devices changing. The rig never suspends its
 * own context. On visible it re-requests the wake lock and checks at once.
 * reconnect() is the "Tap to reconnect the sound link" overlay's tap: it
 * resumes the context and re-requests the microphone into the existing node
 * if the track ended, is muted or the devices changed, so the modem's state
 * and now() survive; a closed context, or one that failed to resume on the
 * previous tap, is rebuilt. Failures count up (failures), so the overlay can
 * offer Leave after 2.
 *
 * Errors are RigErrors with a reason the lobby can show: the microphone
 * refused (the rig then closes the context and puts the session back to
 * "auto") or missing, a sample rate the modem can't use, no Web Audio or
 * AudioWorklet, or the worklet failing to load (a stale build: "A new
 * version is ready").
 *
 * Testing. Everything the rig touches in the browser comes through a
 * RigEnv: the navigator's pieces, the document's visibility, the context and
 * transport factories, the clock and the timers. tests/link-rig.test.ts
 * drives the whole state machine with fakes.
 *
 * Where the spec is silent:
 *  - `ready` resolves "running" or "tap-to-start"; it waits at most 300 ms
 *    for the second resume() (outside a gesture, iOS leaves it pending);
 *  - devicechange counts only when the set of audio inputs and outputs
 *    really changed (Chrome fires it when microphone permission is granted,
 *    as labels appear, and Safari from getUserMedia itself), compared with a
 *    snapshot taken after each microphone request. An event from before the
 *    latest request resolved doesn't count (the new stream is on the route
 *    as it is now), nor does the first look when no snapshot has come back
 *    yet (it becomes the snapshot), and a new stream clears an earlier
 *    change. Without enumerateDevices every event counts;
 *  - setMicMode requests the new stream before letting the old one go, and
 *    keeps the old one if the request fails;
 *  - a reconnect after a resume that did not take rebuilds the context
 *    (the context may be stuck "interrupted" for good after a call on iOS),
 *    and so does one whose context is closed; a reconnect counts as failed
 *    when the context isn't running 1 s after the tap or the microphone
 *    request fails, and success resets the count;
 *  - a rebuilt context gets a new modem: packets not yet polled carry over,
 *    but the stats' counters start again and both phones re-acquire (about
 *    2 s). A Join whose detection has locked is rebuilt on the plan it found,
 *    receiving "host", not detecting again: while it detects a modem carries
 *    only the smaller plan's 186 bits, so the replayed frames (sized to the
 *    plan found, up to 188) would be refused and the reconnect would fail;
 *  - what a tap makes and the rig doesn't keep is let go: a rebuilt context
 *    that can't be used (a rate the modem can't use, a worklet that won't
 *    load, or the rig closed meanwhile) is closed, and a microphone it asked
 *    for is stopped; close() closes a rebuild still under way at once;
 *  - a capture gap still open on a transport ends with it: a new link or a
 *    rebuilt transport counts capture from its own connection;
 *  - "tap-to-start" moves to "running" by itself when the context starts
 *    running without the tap (iOS finishing a slow resume);
 *  - only one link at a time: createLink closes the previous one.
 */
import type { ModemConfig, ModemStats } from "./modem/core";
import { rateProblem } from "./modem/params";
import type { BandPlan, LinkPacket, LinkStats, LinkTransport, ModemMode, OutFrame } from "./transport";
import { loadWorklet, WorkletTransport, type WorkletTransportOptions } from "./worklet-transport";

/** "raw": no echo cancellation, noise suppression or gain control (the default); "ec": echo cancellation on. */
export type MicMode = "raw" | "ec";

export type RigErrorReason = "no-audio" | "no-worklet" | "mic-refused" | "no-mic" | "rate" | "update";

/** What the lobby says for each reason ("rate" carries the modem's own sentence). */
export const RIG_MESSAGES: Readonly<Record<Exclude<RigErrorReason, "rate">, string>> = {
  "no-audio": "This browser can't play the sound link",
  "no-worklet": "This browser can't run the sound link",
  "mic-refused": "Microphone refused",
  "no-mic": "No microphone available: close other apps using it and try again",
  update: "A new version is ready: reload this phone (and your friend's)"
};

export class RigError extends Error {
  constructor(
    readonly reason: RigErrorReason,
    message: string = reason === "rate" ? "This phone's audio can't carry the sound link" : RIG_MESSAGES[reason]
  ) {
    super(message);
    this.name = "RigError";
  }
}

/** Why the link's audio was lost. */
export type LostReason = "track-ended" | "track-muted" | "context" | "devicechange";

export type RigState = "opening" | "tap-to-start" | "running" | "lost" | "failed" | "closed";

/** The getUserMedia audio constraints for a mic mode. */
export function micConstraints(mode: MicMode): MediaTrackConstraints {
  return { echoCancellation: mode === "ec", noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 1 } };
}

/** The ways out of the overlay: Leave is offered after this many failed reconnects. */
export const LEAVE_AFTER_FAILURES = 2;
/** The lobby starts lockstep, and the overlay closes, after this much gap-free capture (ms). */
export const CAPTURE_OK_MS = 1500;
/** onLost thresholds (ms). */
const MUTED_MS = 1000;
const NOT_RUNNING_MS = 500;
/** How long to wait on a resume() after the gesture (ms), and before calling a reconnect failed. */
const RESUME_WAIT_MS = 300;
const RECONNECT_WAIT_MS = 1000;
/** The watch's poll (ms). */
const TICK_MS = 100;

/** The transport members the rig and RigLink use: WorkletTransport's. */
export type RigTransport = Pick<
  WorkletTransport,
  | "node" | "t0" | "onError" | "capacity" | "send" | "poll" | "slots" | "now" | "setMode" | "setSessionKey"
  | "stats" | "close" | "reconfigure" | "setGain" | "modemStats" | "takeGaps" | "detectedPlan"
>;

interface WakeLockLike {
  readonly released: boolean;
  release(): Promise<void>;
  addEventListener(type: "release", fn: () => void): void;
}

/** What the rig takes from the browser. */
export interface RigEnv {
  navigator: {
    mediaDevices?: {
      getUserMedia(c: MediaStreamConstraints): Promise<MediaStream>;
      enumerateDevices?(): Promise<MediaDeviceInfo[]>;
      addEventListener(type: "devicechange", fn: () => void): void;
      removeEventListener(type: "devicechange", fn: () => void): void;
    };
    wakeLock?: { request(type: "screen"): Promise<WakeLockLike> };
    audioSession?: { type: string };
  };
  document: {
    readonly visibilityState: DocumentVisibilityState;
    addEventListener(type: "visibilitychange", fn: () => void): void;
    removeEventListener(type: "visibilitychange", fn: () => void): void;
  } | null;
  /** A new link context (null: no Web Audio). */
  createContext(): AudioContext | null;
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
  loadWorklet(ctx: AudioContext): Promise<void>;
  createTransport(ctx: AudioContext, cfg: ModemConfig, opts: WorkletTransportOptions): RigTransport;
}

/** The browser's RigEnv. */
export function browserEnv(): RigEnv {
  const nav = navigator as Navigator & { audioSession?: { type: string } };
  return {
    navigator: { mediaDevices: nav.mediaDevices, wakeLock: "wakeLock" in nav ? nav.wakeLock : undefined, audioSession: nav.audioSession },
    document,
    createContext: () => {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      return AC ? new AC({ latencyHint: "interactive" }) : null;
    },
    now: () => performance.now(),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (h) => window.clearTimeout(h as number),
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (h) => window.clearInterval(h as number),
    loadWorklet,
    createTransport: (ctx, cfg, opts) => new WorkletTransport(ctx, cfg, opts)
  };
}

export interface RigOptions {
  micMode: MicMode;
  /** Stand-ins for the browser's pieces (tests). */
  env?: Partial<RigEnv>;
}

/** Open the rig: call synchronously inside the tap. */
export function openRig(opts: RigOptions): Rig {
  return new Rig(opts);
}

/** A config for createLink: the rate is the context's. */
export type LinkConfig = Omit<ModemConfig, "sampleRate"> & { sampleRate?: number };

/**
 * The link the session holds: WorkletTransport's members, over whichever
 * transport the rig has now (one per context; reconnect may rebuild it).
 */
export class RigLink implements LinkTransport {
  private cur: RigTransport;
  private cfg: ModemConfig;
  private frames: OutFrame[] | null = null;
  private mode: ModemMode | null = null;
  private keys: [number, number] | null = null;
  private carry: LinkPacket[] = [];
  private carrySlots: number[] = [];
  private err: ((message: string) => void) | null = null;
  private closed = false;
  /** (rig) The link closed itself: the rig stops counting capture. */
  onClose: (() => void) | null = null;

  constructor(t: RigTransport, cfg: ModemConfig) {
    this.cur = t;
    this.cfg = { ...cfg };
  }

  /** The modem's node now (a rebuild replaces it). */
  get node(): AudioWorkletNode {
    return this.cur.node;
  }

  /** now()'s zero, the same across rebuilds. */
  get t0(): number {
    return this.cur.t0;
  }

  /**
   * The config as last set, and the rig rebuilds from it. A Join's "detect"
   * becomes the plan the detection found, receiving "host", once the modem
   * has moved itself there: a transport rebuilt on "detect" would offer the
   * smaller plan's 186 bits until it locked again, and the match's frames,
   * sized to the plan found, wouldn't fit it.
   */
  get config(): Readonly<ModemConfig> {
    const found = this.cfg.rx === "detect" ? this.cur.detectedPlan() : null;
    if (found) {
      this.cfg.plan = found;
      this.cfg.rx = "host";
    }
    return this.cfg;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** The worklet's errors (WorkletTransport.onError), kept across rebuilds. */
  get onError(): ((message: string) => void) | null {
    return this.err;
  }

  set onError(fn: ((message: string) => void) | null) {
    this.err = fn;
    this.cur.onError = fn;
  }

  capacity(): number {
    return this.cur.capacity();
  }

  send(frames: readonly OutFrame[]): void {
    if (this.closed) return;
    this.cur.send(frames);
    this.frames = frames.map((f) => ({ bits: f.bits.slice(0, (f.nbits + 7) >> 3), nbits: f.nbits, key: f.key }));
  }

  poll(): LinkPacket[] {
    const p = this.cur.poll();
    if (!this.carry.length) return p;
    const all = this.carry.concat(p);
    this.carry = [];
    return all;
  }

  slots(): number[] {
    const s = this.cur.slots();
    if (!this.carrySlots.length) return s;
    const all = this.carrySlots.concat(s);
    this.carrySlots = [];
    return all;
  }

  now(): number {
    return this.cur.now();
  }

  setMode(mode: ModemMode): void {
    if (this.closed) return;
    this.cur.setMode(mode);
    this.mode = mode;
  }

  setSessionKey(hostNonce: number, guestNonce: number): void {
    if (this.closed) return;
    this.cur.setSessionKey(hostNonce, guestNonce);
    this.keys = [hostNonce, guestNonce];
  }

  stats(): LinkStats {
    return this.cur.stats();
  }

  reconfigure(cfg: Partial<ModemConfig>): void {
    if (this.closed) return;
    this.cur.reconfigure(cfg);
    const c = this.cfg;
    c.plan = cfg.plan ?? c.plan;
    c.tx = cfg.tx ?? c.tx;
    c.rx = cfg.rx ?? c.rx;
    if (cfg.gain !== undefined) c.gain = cfg.gain;
  }

  setGain(gain: number): void {
    if (this.closed) return;
    this.cur.setGain(gain);
    this.cfg.gain = gain;
  }

  modemStats(): ModemStats | null {
    return this.cur.modemStats();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cur.close();
    this.carry = [];
    this.carrySlots = [];
    this.onClose?.();
  }

  /** (rig) Capture gaps since the last call, on this link's clock. */
  takeGaps(): { at: number; ms: number }[] {
    return this.closed ? [] : this.cur.takeGaps();
  }

  /** (rig) Swap in the transport of a rebuilt context: unread packets carry over, the old one closes, the new one gets the frames, mode and session key. */
  replace(next: RigTransport): void {
    const old = this.cur;
    this.carry.push(...old.poll());
    this.carrySlots.push(...old.slots());
    old.onError = null;
    old.close();
    this.cur = next;
    next.onError = this.err;
    if (this.closed) {
      next.close();
      return;
    }
    if (this.frames) next.send(this.frames);
    if (this.mode) next.setMode(this.mode);
    if (this.keys) next.setSessionKey(this.keys[0], this.keys[1]);
  }
}

export class Rig {
  private readonly env: RigEnv;
  private context: AudioContext | null = null;
  private mode: MicMode;
  private st: RigState = "opening";
  private stream: MediaStream | null = null;
  private track: MediaStreamTrack | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private link: RigLink | null = null;
  private mic: Promise<void>;
  private wake: WakeLockLike | null = null;
  private wakeAsked = false;
  private lostFns = new Set<(reason: LostReason) => void>();
  private lostReason: LostReason | null = null;
  private fails = 0;
  private lastErr: RigError | null = null;
  /** A resume that did not take: the next reconnect rebuilds the context. */
  private rebuildNext = false;
  private reconnecting: Promise<boolean> | null = null;
  private deviceSnapshot: string | null = null;
  private devicesChanged = false;
  /** Counts the microphone requests that resolved: a devicechange from before the latest one is old news. */
  private micEpoch = 0;
  /** The context a reconnect is rebuilding, until it is adopted or let go (close() closes it). */
  private rebuilding: AudioContext | null = null;
  private tick: unknown = null;
  /** Capture: the earliest time (rig clock) gap-free capture counts from, or null (no capture). */
  private okSince: number | null = null;
  private inGap = false;
  private runningSince: number | null = null;
  private mutedSince: number | null = null;
  private notRunningSince: number | null = null;
  private readonly onTrackEvent = () => this.check();
  private readonly onVisibility = () => this.visibility();
  private readonly onDeviceChange = () => this.deviceChange();
  /** Settles once the microphone is in: "running", or "tap-to-start" when the context still isn't running. */
  readonly ready: Promise<"running" | "tap-to-start">;

  constructor(opts: RigOptions) {
    const env = { ...browserEnvLazy(opts.env), ...opts.env } as RigEnv;
    this.env = env;
    this.mode = opts.micMode;
    const session = env.navigator.audioSession;
    if (session) session.type = "play-and-record";
    // the gesture's part, in the gesture: context, resume, a silent sample, wake lock, microphone
    let problem: RigError | null = null;
    try {
      this.context = env.createContext();
    } catch {
      this.context = null;
    }
    if (!this.context) problem = new RigError("no-audio");
    else if (!this.context.audioWorklet) problem = new RigError("no-worklet");
    if (this.context) {
      this.wakeUp(this.context);
      // its state from the start: "tap-to-start" moves on by itself when the context runs
      this.watchContext(null, this.context);
    }
    this.requestWakeLock();
    const req = problem ? null : this.requestMic(this.mode);
    env.document?.addEventListener("visibilitychange", this.onVisibility);
    env.navigator.mediaDevices?.addEventListener("devicechange", this.onDeviceChange);
    this.mic = problem
      ? Promise.reject(problem)
      : req!.then((s) => {
          if (this.st === "closed") {
            for (const t of s.getTracks()) t.stop();
            throw new RigError("no-audio", "The rig was closed");
          }
          this.useStream(s);
        });
    this.ready = this.mic.then(
      async () => {
        const running = await this.settleResume(this.ctx);
        if (this.shut()) return "tap-to-start";
        this.setRunning(running);
        this.tick = env.setInterval(() => this.check(), TICK_MS);
        return running ? "running" : "tap-to-start";
      },
      (e: unknown) => {
        const err = asRigError(e);
        this.fail(err);
        throw err;
      }
    );
    // nobody may be listening yet: the rejections reach whoever awaits these
    this.mic.catch(() => undefined);
    this.ready.catch(() => undefined);
  }

  /** The link's AudioContext (a reconnect may replace it). */
  get ctx(): AudioContext {
    if (!this.context) throw new RigError("no-audio");
    return this.context;
  }

  get state(): RigState {
    return this.st;
  }

  get micMode(): MicMode {
    return this.mode;
  }

  /** The screen is held awake. */
  get hasWakeLock(): boolean {
    return !!this.wake && !this.wake.released;
  }

  /** The browser has the wake lock API (installed iOS apps before 18.4 don't: the lobby says to set Auto-Lock to Never). */
  get wakeLockSupported(): boolean {
    return !!this.env.navigator.wakeLock;
  }

  /** The current loss, while lost. */
  get lost(): LostReason | null {
    return this.lostReason;
  }

  /** Reconnects that failed in a row (the overlay offers Leave from LEAVE_AFTER_FAILURES on). */
  get failures(): number {
    return this.fails;
  }

  /** Why the last open or reconnect failed. */
  get lastError(): RigError | null {
    return this.lastErr;
  }

  /** The modem's sentence when this context's rate can't carry `plan`, else null. */
  rateProblem(plan: BandPlan): string | null {
    return this.context ? rateProblem(this.context.sampleRate, plan) : RIG_MESSAGES["no-audio"];
  }

  /**
   * The modem's link, with the microphone connected (after the microphone is
   * in, and the worklet loaded). Rejects with a RigError: "rate", "update"
   * (the worklet failed to load), "no-worklet", or the microphone's.
   */
  async createLink(cfg: LinkConfig): Promise<RigLink> {
    await this.mic;
    if (this.shut()) throw new RigError("no-audio", "The rig was closed");
    const ctx = this.ctx;
    const full: ModemConfig = { ...cfg, sampleRate: ctx.sampleRate };
    const problem = rateProblem(ctx.sampleRate, full.plan);
    if (problem) throw new RigError("rate", problem);
    if (!ctx.audioWorklet) throw new RigError("no-worklet");
    try {
      await this.env.loadWorklet(ctx);
    } catch {
      throw new RigError("update");
    }
    if (this.shut()) throw new RigError("no-audio", "The rig was closed");
    if (this.context !== ctx) return this.createLink(cfg);
    this.link?.close();
    const t = this.env.createTransport(ctx, full, { clock: this.env.now });
    const link = new RigLink(t, full);
    link.onClose = () => {
      if (this.link === link) {
        this.source?.disconnect();
        this.okSince = null;
      }
    };
    this.link = link;
    // a gap the old link left open was its worklet's: this one counts from its connection
    this.inGap = false;
    this.connectSource();
    return link;
  }

  /** Switch the microphone's processing: re-request it and reconnect the source into the same node. */
  async setMicMode(mode: MicMode): Promise<void> {
    await this.mic;
    if (mode === this.mode && this.track?.readyState === "live") return;
    const s = await this.requestMic(mode);
    if (this.st === "closed") {
      for (const t of s.getTracks()) t.stop();
      return;
    }
    this.mode = mode;
    this.useStream(s);
  }

  /** Milliseconds of gap-free capture into the live link so far (0: none). */
  captureOkMs(): number {
    this.pullGaps();
    const ctx = this.context;
    if (this.okSince === null || this.inGap || !ctx || ctx.state !== "running" || this.runningSince === null) return 0;
    if (!this.track || this.track.readyState !== "live" || this.track.muted) return 0;
    const now = this.env.now();
    return Math.max(0, now - Math.max(this.okSince, this.runningSince));
  }

  /** Call `fn` when the link's audio is lost (once per loss). Returns the unsubscribe. */
  onLost(fn: (reason: LostReason) => void): () => void {
    this.lostFns.add(fn);
    return () => this.lostFns.delete(fn);
  }

  /**
   * The reconnect overlay's tap (and "Tap to start sound"): call inside the
   * gesture. Resumes the context (rebuilding it when it is closed or the last
   * resume did not take), re-requests the microphone when it is gone, muted
   * or the devices changed, and keeps the modem's node when it can. Resolves
   * true when the link's audio runs again; false counts a failure (see
   * lastError for the microphone's).
   */
  reconnect(): Promise<boolean> {
    if (this.st === "closed" || this.st === "failed" || this.st === "opening") return Promise.resolve(false);
    if (this.reconnecting) return this.reconnecting;
    const env = this.env;
    // the gesture's part, synchronously
    let ctx = this.ctx;
    const rebuild = ctx.state === "closed" || this.rebuildNext;
    let fresh: AudioContext | null = null;
    if (rebuild) {
      try {
        fresh = env.createContext();
      } catch {
        fresh = null;
      }
      if (fresh) ctx = fresh;
    }
    this.rebuilding = fresh;
    this.wakeUp(ctx);
    const needMic = !this.track || this.track.readyState !== "live" || this.track.muted || this.devicesChanged;
    const req = needMic ? this.requestMic(this.mode) : null;
    if (!this.hasWakeLock) this.requestWakeLock();
    const run = async (): Promise<boolean> => {
      let asked: MediaStream | null = null;
      try {
        if (req) asked = await req;
        if (this.shut()) return false;
        if (fresh) {
          await this.swapContext(fresh, asked);
          if (this.shut()) return false;
        } else if (asked) this.useStream(asked);
        const running = await this.settleResume(this.ctx, RECONNECT_WAIT_MS);
        if (this.shut()) return false;
        if (!running) {
          this.rebuildNext = true;
          this.lastErr = null;
          this.fails++;
          this.setRunning(false);
          return false;
        }
        this.rebuildNext = false;
        this.fails = 0;
        this.lastErr = null;
        this.lostReason = null;
        this.mutedSince = null;
        this.notRunningSince = null;
        this.setRunning(true);
        return true;
      } catch (e) {
        this.lastErr = asRigError(e);
        this.fails++;
        return false;
      } finally {
        // what this tap made and the rig didn't take: the rebuilt context, the new microphone
        if (this.rebuilding === fresh) this.rebuilding = null;
        if (fresh && this.context !== fresh) closeContext(fresh);
        if (asked && asked !== this.stream) for (const t of asked.getTracks()) t.stop();
        this.reconnecting = null;
      }
    };
    this.reconnecting = run();
    return this.reconnecting;
  }

  /** Stop the microphone, close the link and the context, and put the audio session back to "auto". */
  close(): void {
    if (this.st === "closed") return;
    this.st = "closed";
    this.teardown();
  }

  // ------------------------------------------------------------- inside ---

  /** Closed meanwhile (read across an await, where the compiler's narrowing doesn't hold). */
  private shut(): boolean {
    return this.st === "closed";
  }

  /** resume() and a 1-sample silent buffer: what a gesture must do for sound to start on a phone. */
  private wakeUp(ctx: AudioContext): void {
    try {
      void ctx.resume().catch(() => undefined);
      const b = ctx.createBuffer(1, 1, ctx.sampleRate);
      const s = ctx.createBufferSource();
      s.buffer = b;
      s.connect(ctx.destination);
      s.start();
    } catch {
      /* a closed context: the caller sees its state */
    }
  }

  /** Resume again and wait (at most `ms`) for it to take. */
  private async settleResume(ctx: AudioContext, ms = RESUME_WAIT_MS): Promise<boolean> {
    if (ctx.state === "running") return true;
    let timer: unknown = null;
    await Promise.race([
      ctx.resume().then(
        () => undefined,
        () => undefined
      ),
      new Promise<void>((r) => (timer = this.env.setTimeout(r, ms)))
    ]);
    this.env.clearTimeout(timer);
    return (ctx.state as string) === "running";
  }

  private requestMic(mode: MicMode): Promise<MediaStream> {
    const md = this.env.navigator.mediaDevices;
    if (!md?.getUserMedia) return Promise.reject(new RigError("no-mic"));
    try {
      return md.getUserMedia({ audio: micConstraints(mode), video: false }).then(
        (s) => {
          this.micEpoch++;
          void this.snapshotDevices();
          return s;
        },
        (e: unknown) => {
          throw micError(e);
        }
      );
    } catch (e) {
      return Promise.reject(micError(e));
    }
  }

  /** Take a new stream: the source moves to it, the old tracks stop. */
  private useStream(s: MediaStream): void {
    const old = this.stream;
    const oldTrack = this.track;
    if (oldTrack) {
      oldTrack.removeEventListener("ended", this.onTrackEvent);
      oldTrack.removeEventListener("mute", this.onTrackEvent);
      oldTrack.removeEventListener("unmute", this.onTrackEvent);
    }
    this.source?.disconnect();
    this.stream = s;
    // a new stream is on the route as it is now
    if (s !== old) this.devicesChanged = false;
    this.track = s.getAudioTracks()[0] ?? null;
    this.track?.addEventListener("ended", this.onTrackEvent);
    this.track?.addEventListener("mute", this.onTrackEvent);
    this.track?.addEventListener("unmute", this.onTrackEvent);
    this.source = this.ctx.createMediaStreamSource(s);
    this.connectSource();
    if (old && old !== s) for (const t of old.getTracks()) t.stop();
  }

  /**
   * Connect the microphone to the live link's node: capture counts from now,
   * unless a gap the worklet reported is still open (the node has had no
   * input until now, and iOS may send zeros for a while yet), in which case
   * from that gap's end.
   */
  private connectSource(): void {
    const link = this.link;
    if (!this.source || !link || link.isClosed) return;
    this.pullGaps();
    this.source.connect(link.node);
    this.okSince = this.env.now();
  }

  /**
   * Move everything onto a rebuilt context: a new node (the same t0), the
   * microphone's new source (`asked`, the stream this tap requested, or the
   * one the rig has). Throws a RigError before touching anything when the
   * context can't carry the link; returns without touching anything when the
   * rig closed while the worklet loaded (the caller lets `fresh` go).
   */
  private async swapContext(fresh: AudioContext, asked: MediaStream | null): Promise<void> {
    const link = this.link;
    let t: RigTransport | null = null;
    if (link && !link.isClosed) {
      const problem = rateProblem(fresh.sampleRate, link.config.plan);
      if (problem) throw new RigError("rate", problem);
      try {
        await this.env.loadWorklet(fresh);
      } catch {
        throw new RigError("update");
      }
      if (this.shut()) return;
      // (a link closed meanwhile needs no transport: the context still moves)
      if (!link.isClosed) t = this.env.createTransport(fresh, { ...link.config, sampleRate: fresh.sampleRate }, { clock: this.env.now, t0: link.t0 });
    }
    const old = this.context;
    this.source?.disconnect();
    this.source = null;
    this.context = fresh;
    this.watchContext(old, fresh);
    if (link && t) {
      link.replace(t);
      // the old worklet's open gap went with it: the new one counts from its connection
      this.inGap = false;
    }
    const s = asked ?? this.stream;
    if (s) this.useStream(s);
    if (old && old !== fresh) closeContext(old);
  }

  private watchContext(old: AudioContext | null, fresh: AudioContext): void {
    old?.removeEventListener("statechange", this.onTrackEvent);
    fresh.addEventListener("statechange", this.onTrackEvent);
  }

  private setRunning(running: boolean): void {
    if (this.st === "closed") return;
    if (running) {
      if (this.st !== "running") this.runningSince = this.env.now();
      this.st = "running";
    } else if (this.st === "opening") this.st = "tap-to-start";
  }

  /** The watch: track ended or muted, the context not running, a device change; and the context's running time for capture. */
  private check(): void {
    if (this.st === "closed" || this.st === "failed") return;
    const now = this.env.now();
    const ctx = this.context;
    const running = !!ctx && ctx.state === "running";
    if (!running) this.runningSince = null;
    else if (this.runningSince === null && this.st === "running") this.runningSince = now;
    if (running && this.st === "tap-to-start" && !this.reconnecting) {
      // the context started without the tap (iOS finishing a slow resume): it isn't stuck after all, so no rebuild
      this.rebuildNext = false;
      this.fails = 0;
      this.setRunning(true);
    }
    if (this.st !== "running" || this.reconnecting) return;
    this.pullGaps();
    const track = this.track;
    if (!track || track.readyState === "ended") return this.lose("track-ended");
    if (track.muted) {
      this.mutedSince ??= now;
      if (now - this.mutedSince > MUTED_MS) return this.lose("track-muted");
    } else this.mutedSince = null;
    if (!running) {
      this.notRunningSince ??= now;
      if (now - this.notRunningSince > NOT_RUNNING_MS) return this.lose("context");
    } else this.notRunningSince = null;
    if (this.devicesChanged) this.lose("devicechange");
  }

  private lose(reason: LostReason): void {
    this.st = "lost";
    this.lostReason = reason;
    for (const fn of [...this.lostFns]) fn(reason);
  }

  private pullGaps(): void {
    const link = this.link;
    if (!link || link.isClosed) return;
    const t0 = link.t0;
    for (const g of link.takeGaps()) {
      if (g.ms === 0) this.inGap = true;
      else {
        this.inGap = false;
        // when the gap ended, on the rig's clock
        const end = t0 + g.at + g.ms;
        this.okSince = this.okSince === null ? end : Math.max(this.okSince, end);
      }
    }
  }

  private visibility(): void {
    if (this.env.document?.visibilityState !== "visible" || this.st === "closed") return;
    if (!this.hasWakeLock) this.requestWakeLock();
    if (this.st !== "running") return;
    // back from the background: a context that isn't running or a dead track needs the overlay now
    const ctx = this.context;
    if (!this.track || this.track.readyState === "ended") this.lose("track-ended");
    else if (!ctx || ctx.state !== "running") this.lose("context");
  }

  private requestWakeLock(): void {
    const wl = this.env.navigator.wakeLock;
    if (!wl || this.wakeAsked) return;
    this.wakeAsked = true;
    try {
      void wl.request("screen").then(
        (s) => {
          this.wakeAsked = false;
          if (this.st === "closed" || this.st === "failed") {
            void s.release().catch(() => undefined);
            return;
          }
          this.wake = s;
        },
        () => {
          this.wakeAsked = false;
        }
      );
    } catch {
      this.wakeAsked = false;
    }
  }

  private async snapshotDevices(): Promise<void> {
    this.deviceSnapshot = await this.deviceKey();
  }

  /** The audio inputs and outputs, as one string (null: can't tell). */
  private async deviceKey(): Promise<string | null> {
    const md = this.env.navigator.mediaDevices;
    if (!md?.enumerateDevices) return null;
    try {
      const list = await md.enumerateDevices();
      return list
        .filter((d) => d.kind === "audioinput" || d.kind === "audiooutput")
        .map((d) => `${d.kind}:${d.deviceId}`)
        .sort()
        .join("|");
    } catch {
      return null;
    }
  }

  private deviceChange(): void {
    if (this.st === "closed") return;
    const epoch = this.micEpoch;
    void this.deviceKey().then((key) => {
      // a microphone request resolved since: its stream is on the route as it is now
      if (this.st === "closed" || epoch !== this.micEpoch) return;
      if (key !== null) {
        // no snapshot back yet (or none possible then): this is the first look, not a change
        if (this.deviceSnapshot === null) {
          this.deviceSnapshot = key;
          return;
        }
        if (key === this.deviceSnapshot) return;
        this.deviceSnapshot = key;
      }
      this.devicesChanged = true;
      this.check();
    });
  }

  /** The open failed: close everything, put the session back, and keep the reason. */
  private fail(err: RigError): void {
    this.lastErr = err;
    if (this.st === "closed") return;
    this.st = "failed";
    this.teardown();
  }

  private teardown(): void {
    const env = this.env;
    if (this.tick !== null) env.clearInterval(this.tick);
    this.tick = null;
    env.document?.removeEventListener("visibilitychange", this.onVisibility);
    env.navigator.mediaDevices?.removeEventListener("devicechange", this.onDeviceChange);
    if (this.track) {
      this.track.removeEventListener("ended", this.onTrackEvent);
      this.track.removeEventListener("mute", this.onTrackEvent);
      this.track.removeEventListener("unmute", this.onTrackEvent);
    }
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    this.track = null;
    this.link?.close();
    this.link = null;
    this.source = null;
    this.okSince = null;
    const ctx = this.context;
    if (ctx) {
      ctx.removeEventListener("statechange", this.onTrackEvent);
      closeContext(ctx);
    }
    // a reconnect's rebuilt context, still waiting on the microphone or the worklet
    const fresh = this.rebuilding;
    this.rebuilding = null;
    if (fresh) closeContext(fresh);
    const w = this.wake;
    this.wake = null;
    if (w && !w.released) void w.release().catch(() => undefined);
    const session = env.navigator.audioSession;
    if (session) session.type = "auto";
  }
}

/** The browser env, but only for the pieces the caller didn't stub (so tests never touch window). */
function browserEnvLazy(stub: Partial<RigEnv> | undefined): Partial<RigEnv> {
  const all: (keyof RigEnv)[] = ["navigator", "document", "createContext", "now", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "loadWorklet", "createTransport"];
  if (stub && all.every((k) => k in stub)) return {};
  return browserEnv();
}

/** Close a context unless it already is (closing a closed one rejects). */
function closeContext(ctx: AudioContext): void {
  if (ctx.state !== "closed") void ctx.close().catch(() => undefined);
}

function asRigError(e: unknown): RigError {
  return e instanceof RigError ? e : new RigError("no-mic");
}

/** getUserMedia's errors, as the lobby tells them. */
function micError(e: unknown): RigError {
  const name = (e as { name?: unknown } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return new RigError("mic-refused");
  return new RigError("no-mic");
}
