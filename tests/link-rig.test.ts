// The rig (SOUND-DUEL.md "Rig"): opening inside the tap, the microphone's
// errors, the link it makes, capture tracking, the lifecycle watch and the
// reconnect overlay's tap, mic modes, the wake lock and closing, all against
// fakes of the browser's pieces (a context, a microphone, a wake lock, the
// page's visibility, timers on a manual clock) and of the WorkletTransport.
import { describe, expect, it } from "vitest";
import type { ModemConfig, ModemStats } from "../src/link/modem/core";
import { LEAVE_AFTER_FAILURES, openRig, RigError, RIG_MESSAGES, type MicMode, type RigEnv, type RigTransport } from "../src/link/rig";
import { PAYLOAD_BITS, type BandPlan, type LinkPacket, type LinkStats, type ModemMode, type OutFrame } from "../src/link/transport";
import type { WorkletTransportOptions } from "../src/link/worklet-transport";

/** Let promise callbacks run (the rig's async steps between fake-timer ticks). */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setTimeout(r, 0));
}

class Clock {
  t = 1000;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void; every: number | null }>();
  now = () => this.t;
  setTimeout = (fn: () => void, ms: number) => this.add(fn, ms, null);
  setInterval = (fn: () => void, ms: number) => this.add(fn, ms, ms);
  clearTimeout = (h: unknown) => void this.timers.delete(h as number);
  clearInterval = (h: unknown) => void this.timers.delete(h as number);
  private add(fn: () => void, ms: number, every: number | null): number {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + ms, fn, every });
    return id;
  }
  /** Move time on, running due timers in order, with promise callbacks between. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    // what is already under way may set timers first
    await settle();
    for (;;) {
      let next: [number, { at: number; fn: () => void; every: number | null }] | null = null;
      for (const e of this.timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      const [id, tm] = next;
      this.t = Math.max(this.t, tm.at);
      if (tm.every !== null) tm.at += tm.every;
      else this.timers.delete(id);
      tm.fn();
      await settle();
    }
    this.t = end;
    await settle();
  }
}

class Emitter {
  private fns = new Map<string, Set<() => void>>();
  addEventListener(type: string, fn: () => void): void {
    if (!this.fns.has(type)) this.fns.set(type, new Set());
    this.fns.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: () => void): void {
    this.fns.get(type)?.delete(fn);
  }
  emit(type: string): void {
    for (const fn of [...(this.fns.get(type) ?? [])]) fn();
  }
  listeners(type: string): number {
    return this.fns.get(type)?.size ?? 0;
  }
}

class FakeNode {
  readonly id: number;
  constructor(id: number) {
    this.id = id;
  }
}

class FakeSource {
  to: unknown = null;
  constructor(readonly stream: FakeStream) {}
  connect(n: unknown): void {
    this.to = n;
  }
  disconnect(): void {
    this.to = null;
  }
}

class FakeCtx extends Emitter {
  state: AudioContextState = "suspended";
  sampleRate = 48000;
  audioWorklet: object | undefined = {};
  destination = {};
  /** What resume() does: start running, never settle (iOS outside a gesture), or reject. */
  resumeMode: "run" | "hang" | "reject" = "run";
  resumes = 0;
  silentStarts = 0;
  readonly sources: FakeSource[] = [];
  resume(): Promise<void> {
    this.resumes++;
    if (this.state === "closed") return Promise.reject(new Error("closed"));
    if (this.resumeMode === "hang") return new Promise<void>(() => undefined);
    if (this.resumeMode === "reject") return Promise.reject(new Error("no"));
    this.set("running");
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.set("closed");
    return Promise.resolve();
  }
  set(s: AudioContextState): void {
    if (s === this.state) return;
    this.state = s;
    this.emit("statechange");
  }
  createBuffer(): object {
    return {};
  }
  createBufferSource(): object {
    return { buffer: null, connect: () => undefined, start: () => this.silentStarts++ };
  }
  createMediaStreamSource(s: FakeStream): FakeSource {
    const src = new FakeSource(s);
    this.sources.push(src);
    return src;
  }
}

class FakeTrack extends Emitter {
  readyState: MediaStreamTrackState = "live";
  muted = false;
  stopped = false;
  /** The rate getSettings() reports (undefined: none, as some browsers). */
  rate: number | undefined = undefined;
  getSettings(): MediaTrackSettings {
    return this.rate === undefined ? {} : { sampleRate: this.rate };
  }
  stop(): void {
    // stop() ends the track without an "ended" event
    this.readyState = "ended";
    this.stopped = true;
  }
  end(): void {
    this.readyState = "ended";
    this.emit("ended");
  }
  setMuted(m: boolean): void {
    this.muted = m;
    this.emit(m ? "mute" : "unmute");
  }
}

class FakeStream {
  readonly track = new FakeTrack();
  constructor(readonly constraints: MediaStreamConstraints) {}
  getAudioTracks(): FakeTrack[] {
    return [this.track];
  }
  getTracks(): FakeTrack[] {
    return [this.track];
  }
}

class FakeDevices extends Emitter {
  /** The next getUserMedia's answer ("hold": it waits in `held` until granted). */
  answer: "grant" | "deny" | "missing" | "hang" | "hold" = "grant";
  /** The rate the next streams' tracks report: one from `micRates` per grant while it lasts, then `micRate`. */
  micRate: number | undefined = undefined;
  micRates: number[] = [];
  readonly streams: FakeStream[] = [];
  /** Requests answered "hold": call one to grant it. */
  readonly held: (() => void)[] = [];
  devices = [
    { kind: "audioinput", deviceId: "mic" },
    { kind: "audiooutput", deviceId: "speaker" }
  ];
  getUserMedia(c: MediaStreamConstraints): Promise<MediaStream> {
    if (this.answer === "deny") return Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
    if (this.answer === "missing") return Promise.reject(Object.assign(new Error("none"), { name: "NotFoundError" }));
    if (this.answer === "hang") return new Promise<MediaStream>(() => undefined);
    if (this.answer === "hold") return new Promise<MediaStream>((r) => this.held.push(() => r(this.grant(c))));
    return Promise.resolve(this.grant(c));
  }
  private grant(c: MediaStreamConstraints): MediaStream {
    const s = new FakeStream(c);
    s.track.rate = this.micRates.length ? this.micRates.shift() : this.micRate;
    this.streams.push(s);
    return s as unknown as MediaStream;
  }
  enumerateDevices(): Promise<MediaDeviceInfo[]> {
    return Promise.resolve(this.devices.map((d) => ({ ...d })) as unknown as MediaDeviceInfo[]);
  }
}

class FakeWakeLock {
  requests = 0;
  sentinels: { released: boolean; release(): Promise<void>; addEventListener(): void }[] = [];
  request(): Promise<{ released: boolean; release(): Promise<void>; addEventListener(): void }> {
    this.requests++;
    const s = {
      released: false,
      release() {
        s.released = true;
        return Promise.resolve();
      },
      addEventListener() {}
    };
    this.sentinels.push(s);
    return Promise.resolve(s);
  }
}

class FakeTransport {
  static made: FakeTransport[] = [];
  readonly node: FakeNode;
  readonly t0: number;
  onError: ((message: string) => void) | null = null;
  closed = false;
  readonly sent: OutFrame[][] = [];
  readonly modes: ModemMode[] = [];
  readonly keys: [number, number][] = [];
  readonly configs: Partial<ModemConfig>[] = [];
  readonly gains: number[] = [];
  readonly gaps: { at: number; ms: number }[] = [];
  readonly inbox: LinkPacket[] = [];
  private readonly clock: () => number;
  constructor(
    readonly ctx: FakeCtx,
    readonly cfg: ModemConfig,
    opts: WorkletTransportOptions
  ) {
    this.clock = opts.clock!;
    this.t0 = opts.t0 ?? this.clock();
    this.node = new FakeNode(FakeTransport.made.length);
    FakeTransport.made.push(this);
  }
  /** The plan a Join's detection found (tests set it); null while it searches, as WorkletTransport's. */
  found: BandPlan | null = null;
  /** As WorkletTransport's: 186 while a Join detects, the plan's payload once it has locked. */
  capacity(): number {
    if (this.cfg.rx === "detect" && !this.found) return 186;
    return PAYLOAD_BITS[this.found ?? this.cfg.plan];
  }
  /** Refuses a frame over capacity(), as WorkletTransport does. */
  send(frames: readonly OutFrame[]): void {
    for (const f of frames) if (f.nbits > this.capacity()) throw new RangeError(`a frame of ${f.nbits} bits; the band carries ${this.capacity()}`);
    this.sent.push([...frames]);
  }
  detectedPlan(): BandPlan | null {
    return this.cfg.rx === "detect" ? this.found : null;
  }
  poll(): LinkPacket[] {
    return this.inbox.splice(0);
  }
  slots(): number[] {
    return [];
  }
  now(): number {
    return this.clock() - this.t0;
  }
  setMode(m: ModemMode): void {
    this.modes.push(m);
  }
  setSessionKey(h: number, g: number): void {
    this.keys.push([h, g]);
  }
  stats(): LinkStats {
    return { locked: false, snrDb: null, rxOk: 0, rxBad: 0, txMode: "robust", rxMode: null, sinceRx: Infinity, ownSnrDb: null, loopbackMs: null, plan: this.cfg.plan };
  }
  close(): void {
    this.closed = true;
  }
  reconfigure(c: Partial<ModemConfig>): void {
    this.configs.push(c);
  }
  setGain(g: number): void {
    this.gains.push(g);
  }
  modemStats(): ModemStats | null {
    return null;
  }
  takeGaps(): { at: number; ms: number }[] {
    return this.gaps.splice(0);
  }
}

interface World {
  clock: Clock;
  devices: FakeDevices;
  wake: FakeWakeLock;
  session: { type: string };
  doc: Emitter & { visibilityState: DocumentVisibilityState };
  contexts: FakeCtx[];
  /** The next context's settings. */
  nextCtx: Partial<Pick<FakeCtx, "sampleRate" | "resumeMode" | "audioWorklet">>;
  /** The rate of contexts made once a microphone request has been granted (Safari reads the session's rate afresh when capture activates it); undefined: nextCtx's. */
  rateAfterMic: number | undefined;
  /** The audio session's type when each context was made. */
  sessionAtContext: string[];
  noAudio: boolean;
  /** How loadWorklet answers ("hold": it waits in `heldWorklets` until loaded). */
  worklet: "ok" | "fail" | "hold";
  readonly heldWorklets: (() => void)[];
  env: RigEnv;
}

function world(): World {
  FakeTransport.made = [];
  const clock = new Clock();
  const devices = new FakeDevices();
  const wake = new FakeWakeLock();
  const session = { type: "auto" };
  const doc = Object.assign(new Emitter(), { visibilityState: "visible" as DocumentVisibilityState });
  const w: World = {
    clock, devices, wake, session, doc, contexts: [], nextCtx: {}, rateAfterMic: undefined, sessionAtContext: [], noAudio: false, worklet: "ok", heldWorklets: [],
    env: null as unknown as RigEnv
  };
  w.env = {
    navigator: { mediaDevices: devices, wakeLock: wake, audioSession: session },
    document: doc,
    createContext: () => {
      if (w.noAudio) return null;
      const after = w.devices.streams.length > 0 && w.rateAfterMic !== undefined ? { sampleRate: w.rateAfterMic } : {};
      const c = Object.assign(new FakeCtx(), w.nextCtx, after);
      w.contexts.push(c);
      w.sessionAtContext.push(session.type);
      return c as unknown as AudioContext;
    },
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    loadWorklet: () =>
      w.worklet === "hold"
        ? new Promise<void>((r) => w.heldWorklets.push(r))
        : w.worklet === "ok"
          ? Promise.resolve()
          : Promise.reject(new Error("404")),
    createTransport: (ctx, cfg, opts) => new FakeTransport(ctx as unknown as FakeCtx, cfg, opts) as unknown as RigTransport
  };
  return w;
}

const open = (w: World, micMode: MicMode = "raw") => openRig({ micMode, env: w.env });
const HOST = { plan: "high", tx: "host", rx: "guest" } as const;
const frame = (key: number): OutFrame => ({ bits: new Uint8Array([0x80 | key, 1, 2]), nbits: 24, key });

describe("opening the rig", () => {
  it("does the gesture's part synchronously: session, context, resume, a silent sample, wake lock, microphone", () => {
    const w = world();
    const rig = open(w);
    // all of this before any await
    expect(w.session.type).toBe("play-and-record");
    expect(w.contexts).toHaveLength(1);
    expect(w.contexts[0]!.resumes).toBe(1);
    expect(w.contexts[0]!.silentStarts).toBe(1);
    expect(w.wake.requests).toBe(1);
    expect(w.devices.streams).toHaveLength(1);
    expect(w.devices.streams[0]!.constraints).toEqual({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 1 } },
      video: false
    });
    expect(rig.state).toBe("opening");
    rig.close();
  });

  it("is ready, running, once the microphone is in; the wake lock is held", async () => {
    const w = world();
    const rig = open(w, "ec");
    expect(await rig.ready).toBe("running");
    expect(rig.state).toBe("running");
    expect(rig.hasWakeLock).toBe(true);
    expect(rig.wakeLockSupported).toBe(true);
    expect((w.devices.streams[0]!.constraints.audio as MediaTrackConstraints).echoCancellation).toBe(true);
    // a 1-sample buffer per resume in a gesture, the second resume after the microphone
    expect(w.contexts[0]!.resumes).toBe(1);
    rig.close();
  });

  it("waits in tap-to-start when the context won't run, and the next tap starts it", async () => {
    const w = world();
    w.nextCtx = { resumeMode: "hang" };
    const rig = open(w);
    const ready = rig.ready;
    await w.clock.advance(299);
    expect(rig.state).toBe("opening");
    await w.clock.advance(1);
    expect(await ready).toBe("tap-to-start");
    expect(rig.state).toBe("tap-to-start");
    const ctx = w.contexts[0]!;
    expect(ctx.resumes).toBe(2);
    // the tap: this time resume works
    ctx.resumeMode = "run";
    const ok = rig.reconnect();
    expect(ctx.resumes).toBe(3);
    expect(ctx.silentStarts).toBe(2);
    expect(await ok).toBe(true);
    expect(rig.state).toBe("running");
    expect(w.contexts).toHaveLength(1);
    rig.close();
  });

  it("a refused microphone closes the context and puts the session back", async () => {
    const w = world();
    w.devices.answer = "deny";
    const rig = open(w);
    const err = await rig.ready.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RigError);
    expect((err as RigError).reason).toBe("mic-refused");
    expect((err as RigError).message).toBe("Microphone refused");
    expect(rig.state).toBe("failed");
    expect(w.contexts[0]!.state).toBe("closed");
    expect(w.session.type).toBe("auto");
    expect(w.wake.sentinels.every((s) => s.released)).toBe(true);
    expect(rig.lastError?.reason).toBe("mic-refused");
    // createLink reports the same
    await expect(rig.createLink(HOST)).rejects.toMatchObject({ reason: "mic-refused" });
  });

  it("names a missing microphone, a missing Web Audio and a missing AudioWorklet", async () => {
    let w = world();
    w.devices.answer = "missing";
    await expect(open(w).ready).rejects.toMatchObject({ reason: "no-mic", message: RIG_MESSAGES["no-mic"] });
    w = world();
    w.noAudio = true;
    const r = open(w);
    await expect(r.ready).rejects.toMatchObject({ reason: "no-audio" });
    expect(w.devices.streams).toHaveLength(0);
    expect(w.session.type).toBe("auto");
    w = world();
    w.nextCtx = { audioWorklet: undefined };
    await expect(open(w).ready).rejects.toMatchObject({ reason: "no-worklet" });
    expect(w.contexts[0]!.state).toBe("closed");
  });
});

describe("the link", () => {
  it("is made on the context's rate, with the microphone connected to its node", async () => {
    const w = world();
    const rig = open(w);
    const link = await rig.createLink({ ...HOST, gain: 1 });
    const t = FakeTransport.made[0]!;
    expect(t.cfg).toEqual({ ...HOST, gain: 1, sampleRate: 48000 });
    const src = w.contexts[0]!.sources[0]!;
    expect(src.to).toBe(t.node);
    expect(link.node).toBe(t.node as unknown);
    // LinkTransport calls reach the transport
    link.send([frame(1), frame(2)]);
    link.setMode("fast");
    link.setSessionKey(11, 22);
    link.reconfigure({ plan: "low" });
    link.setGain(1.1);
    expect(t.sent).toHaveLength(1);
    expect(t.modes).toEqual(["fast"]);
    expect(t.keys).toEqual([[11, 22]]);
    expect(t.configs).toEqual([{ plan: "low" }]);
    expect(t.gains).toEqual([1.1]);
    expect(link.config).toMatchObject({ plan: "low", gain: 1.1 });
    rig.close();
    expect(t.closed).toBe(true);
  });

  it("reports a rate the modem can't use with the modem's sentence, and a failed worklet as a new version", async () => {
    let w = world();
    w.nextCtx = { sampleRate: 22050 };
    let rig = open(w);
    expect(rig.rateProblem("high")).toBe("This phone's audio runs at 22050 Hz, which the sound link can't use");
    const err = await rig.createLink({ ...HOST, plan: "low" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ reason: "rate", message: "This phone's audio runs at 22050 Hz, which the sound link can't use" });
    w = world();
    w.nextCtx = { sampleRate: 32000 };
    rig = open(w);
    expect(rig.rateProblem("high")).not.toBeNull();
    expect(rig.rateProblem("low")).toBeNull();
    rig.close();
    w = world();
    w.worklet = "fail";
    rig = open(w);
    await expect(rig.createLink(HOST)).rejects.toMatchObject({ reason: "update", message: "A new version is ready: reload this phone (and your friend's)" });
    rig.close();
  });

  it("makes its context before switching the session to play-and-record, and only one when the rate is fine", async () => {
    const w = world();
    const rig = open(w);
    expect(w.sessionAtContext).toEqual(["auto"]);
    expect(w.session.type).toBe("play-and-record");
    await rig.ready;
    expect(w.contexts.map((c) => c.sampleRate)).toEqual([48000]);
    rig.close();
  });

  it("replaces a context made at a rate the high plan can't use with one made once the microphone is in, without a tap", async () => {
    // Safari snapshots the session's rate into each new context; capture activates the session and reads it afresh
    const w = world();
    w.nextCtx = { sampleRate: 16000 };
    w.rateAfterMic = 48000;
    const rig = open(w);
    expect(rig.rateProblem("high")).not.toBeNull();
    expect(await rig.ready).toBe("running");
    expect(w.contexts.map((c) => c.sampleRate)).toEqual([16000, 48000]);
    expect(w.contexts[0]!.state).toBe("closed");
    // woken at once (a capturing page may start a context), and it is the one the link and the microphone use
    expect(w.contexts[1]!.silentStarts).toBe(1);
    expect(w.contexts[1]!.state).toBe("running");
    expect(rig.rateProblem("high")).toBeNull();
    const link = await rig.createLink(HOST);
    expect(FakeTransport.made[0]!.cfg).toMatchObject({ sampleRate: 48000 });
    expect(w.contexts[1]!.sources[0]!.to).toBe(link.node);
    expect(w.contexts[0]!.sources).toEqual([]);
    // the old context's state changes no longer count
    w.contexts[0]!.set("suspended");
    expect(rig.state).toBe("running");
    rig.close();
  });

  it("asks for the microphone again when its own format was fixed at the low rate, and keeps the old one if that fails", async () => {
    let w = world();
    w.nextCtx = { sampleRate: 16000 };
    w.rateAfterMic = 48000;
    w.devices.micRates = [16000, 48000];
    let rig = open(w);
    await rig.ready;
    expect(w.devices.streams.length).toBe(2);
    expect(w.devices.streams[0]!.track.stopped).toBe(true);
    await rig.createLink(HOST);
    expect(w.contexts[1]!.sources[0]!.stream).toBe(w.devices.streams[1]);
    rig.close();
    // the second request refused: the first stream stays, and its rate is reported
    w = world();
    w.nextCtx = { sampleRate: 16000 };
    w.rateAfterMic = 48000;
    w.devices.micRates = [16000];
    const gum = w.devices.getUserMedia.bind(w.devices);
    let n = 0;
    w.devices.getUserMedia = (c) => (n++ === 0 ? gum(c) : Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" })));
    rig = open(w);
    expect(await rig.ready).toBe("running");
    await expect(rig.createLink(HOST)).rejects.toMatchObject({ reason: "rate", message: "This phone's microphone runs at 16000 Hz, which the sound link can't use" });
    rig.close();
  });

  it("keeps the first context, and the rate error, when the rate read afresh is no higher", async () => {
    const w = world();
    w.nextCtx = { sampleRate: 16000 };
    const rig = open(w);
    await rig.ready;
    expect(w.contexts.map((c) => [c.sampleRate, c.state])).toEqual([[16000, "running"], [16000, "closed"]]);
    await expect(rig.createLink(HOST)).rejects.toMatchObject({ reason: "rate", message: "This phone's audio runs at 16000 Hz, which the sound link can't use" });
    rig.close();
  });

  it("refuses a microphone whose own rate can't carry the plan (a Bluetooth headset holds an iPhone at 16 kHz), whatever the context's", async () => {
    let w = world();
    w.devices.micRate = 16000;
    let rig = open(w);
    await expect(rig.createLink(HOST)).rejects.toMatchObject({ reason: "rate", message: "This phone's microphone runs at 16000 Hz, which the sound link can't use" });
    rig.close();
    // 32 kHz carries the low plan, not the high one; a reported 48 kHz (or none) is fine
    w = world();
    w.devices.micRate = 32000;
    rig = open(w);
    await expect(rig.createLink(HOST)).rejects.toMatchObject({ reason: "rate" });
    await rig.createLink({ ...HOST, plan: "low" });
    rig.close();
    w = world();
    w.devices.micRate = 48000;
    rig = open(w);
    await rig.createLink(HOST);
    rig.close();
  });

  it("counts gap-free capture from the connection, from each gap's end, and not while the context stops", async () => {
    const w = world();
    const rig = open(w);
    await rig.ready;
    expect(rig.captureOkMs()).toBe(0);
    const link = await rig.createLink(HOST);
    const t = FakeTransport.made[0]!;
    await w.clock.advance(400);
    expect(rig.captureOkMs()).toBe(400);
    // iOS's hole after the microphone opens: a gap starts, then ends 700 ms later
    t.gaps.push({ at: link.now(), ms: 0 });
    await w.clock.advance(700);
    expect(rig.captureOkMs()).toBe(0);
    t.gaps.push({ at: link.now() - 700, ms: 700 });
    expect(rig.captureOkMs()).toBe(0);
    await w.clock.advance(1499);
    expect(rig.captureOkMs()).toBe(1499);
    await w.clock.advance(1);
    expect(rig.captureOkMs()).toBe(1500);
    // the context stops: nothing counts, and it starts again from when it runs
    w.contexts[0]!.set("suspended");
    expect(rig.captureOkMs()).toBe(0);
    await w.clock.advance(200);
    w.contexts[0]!.set("running");
    await w.clock.advance(300);
    expect(rig.captureOkMs()).toBe(300);
    // a closed link captures nothing
    link.close();
    expect(rig.captureOkMs()).toBe(0);
    rig.close();
  });
});

describe("the lifecycle", () => {
  async function running(w: World) {
    const rig = open(w);
    await rig.ready;
    const link = await rig.createLink(HOST);
    const lost: string[] = [];
    rig.onLost((r) => lost.push(r));
    return { rig, link, lost, ctx: w.contexts[0]!, track: w.devices.streams[0]!.track };
  }

  it("fires onLost once for a track muted more than 1 s", async () => {
    const w = world();
    const { rig, lost, track } = await running(w);
    track.setMuted(true);
    await w.clock.advance(900);
    track.setMuted(false);
    await w.clock.advance(2000);
    expect(lost).toEqual([]);
    track.setMuted(true);
    await w.clock.advance(1200);
    expect(lost).toEqual(["track-muted"]);
    await w.clock.advance(3000);
    expect(lost).toEqual(["track-muted"]);
    expect(rig.state).toBe("lost");
    expect(rig.lost).toBe("track-muted");
    rig.close();
  });

  it("fires for the context not running more than 0.5 s, and for a track that ends", async () => {
    let w = world();
    let r = await running(w);
    r.ctx.set("interrupted" as AudioContextState);
    await w.clock.advance(400);
    expect(r.lost).toEqual([]);
    await w.clock.advance(200);
    expect(r.lost).toEqual(["context"]);
    r.rig.close();
    w = world();
    r = await running(w);
    r.track.end();
    expect(r.lost).toEqual(["track-ended"]);
    r.rig.close();
  });

  it("fires for a real device change, not for a devicechange that changed nothing", async () => {
    const w = world();
    const { rig, lost } = await running(w);
    w.devices.emit("devicechange");
    await w.clock.advance(300);
    expect(lost).toEqual([]);
    w.devices.devices.push({ kind: "audiooutput", deviceId: "airpods" });
    w.devices.emit("devicechange");
    await w.clock.advance(300);
    expect(lost).toEqual(["devicechange"]);
    // the tap re-requests the microphone (the route moved), into the same node
    const ok = rig.reconnect();
    expect(w.devices.streams).toHaveLength(2);
    expect(await ok).toBe(true);
    expect(FakeTransport.made).toHaveLength(1);
    expect(w.contexts[0]!.sources[1]!.to).toBe(FakeTransport.made[0]!.node);
    expect(w.devices.streams[0]!.track.stopped).toBe(true);
    rig.close();
  });

  it("reconnects into the existing node after the context stopped, keeping the modem and now()", async () => {
    const w = world();
    const { rig, link, lost, ctx } = await running(w);
    link.send([frame(3)]);
    ctx.set("suspended");
    ctx.resumeMode = "hang";
    await w.clock.advance(600);
    expect(lost).toEqual(["context"]);
    const before = link.now();
    ctx.resumeMode = "run";
    const ok = rig.reconnect();
    // no new microphone request: the track is fine
    expect(w.devices.streams).toHaveLength(1);
    expect(await ok).toBe(true);
    expect(rig.state).toBe("running");
    expect(rig.lost).toBeNull();
    expect(FakeTransport.made).toHaveLength(1);
    expect(link.now()).toBeGreaterThanOrEqual(before);
    // the overlay closes after 1.5 s of capture from the reconnect
    expect(rig.captureOkMs()).toBe(0);
    await w.clock.advance(1500);
    expect(rig.captureOkMs()).toBe(1500);
    // it can be lost again
    ctx.set("suspended");
    await w.clock.advance(700);
    expect(lost).toEqual(["context", "context"]);
    rig.close();
  });

  it("re-requests the microphone into the same node when the track ended", async () => {
    const w = world();
    const { rig, lost, track } = await running(w);
    track.end();
    expect(lost).toEqual(["track-ended"]);
    const ok = rig.reconnect();
    expect(w.devices.streams).toHaveLength(2);
    expect(await ok).toBe(true);
    expect(FakeTransport.made).toHaveLength(1);
    expect(w.contexts[0]!.sources[1]!.to).toBe(FakeTransport.made[0]!.node);
    expect(w.contexts[0]!.sources[0]!.to).toBeNull();
    rig.close();
  });

  it("counts failed reconnects, then rebuilds a stuck context with the modem's state replayed and the clock kept", async () => {
    const w = world();
    const { rig, link, lost, ctx } = await running(w);
    link.send([frame(1), frame(5)]);
    link.setMode("fast");
    link.setSessionKey(7, 9);
    link.reconfigure({ gain: 1.1 });
    ctx.resumeMode = "hang";
    ctx.set("interrupted" as AudioContextState);
    await w.clock.advance(600);
    expect(lost).toEqual(["context"]);
    // first tap: the resume doesn't take
    let ok = rig.reconnect();
    await w.clock.advance(1000);
    expect(await ok).toBe(false);
    expect(rig.failures).toBe(1);
    expect(w.contexts).toHaveLength(1);
    // an unread packet waits in the old transport
    const old = FakeTransport.made[0]!;
    old.inbox.push({ bits: new Uint8Array([0x40]), nbits: 8, snrDb: 20, at: 5, session: true });
    // second tap: a new context, a new node on the old clock
    ok = rig.reconnect();
    expect(w.contexts).toHaveLength(2);
    expect(w.contexts[1]!.silentStarts).toBe(1);
    expect(await ok).toBe(true);
    expect(rig.failures).toBe(0);
    expect(rig.ctx).toBe(w.contexts[1] as unknown);
    expect(ctx.state).toBe("closed");
    const fresh = FakeTransport.made[1]!;
    expect(fresh.t0).toBe(old.t0);
    expect(old.closed).toBe(true);
    expect(fresh.cfg).toEqual({ ...HOST, gain: 1.1, sampleRate: 48000 });
    expect(fresh.sent).toHaveLength(1);
    expect(fresh.sent[0]!.map((f) => f.key)).toEqual([1, 5]);
    expect(fresh.modes).toEqual(["fast"]);
    expect(fresh.keys).toEqual([[7, 9]]);
    expect(link.node).toBe(fresh.node as unknown);
    expect(link.poll()).toHaveLength(1);
    // the microphone's stream moved to the new context's source, connected to the new node
    expect(w.contexts[1]!.sources[0]!.to).toBe(fresh.node);
    rig.close();
  });

  it("rebuilds a Join's link on the plan its detection found, so the match's frames replay whole", async () => {
    for (const plan of ["high", "low"] as const) {
      const w = world();
      const rig = open(w);
      await rig.ready;
      const link = await rig.createLink({ plan: "high", tx: "guest", rx: "detect" });
      // detecting, the link offers what either plan carries
      expect(link.capacity()).toBe(186);
      FakeTransport.made[0]!.found = plan;
      const bits = PAYLOAD_BITS[plan];
      expect(link.capacity()).toBe(bits);
      link.send([frame(1), { bits: new Uint8Array(24), nbits: bits, key: 4 }]);
      link.setSessionKey(7, 9);
      // the context closes mid-match, twice: each tap rebuilds it
      for (let k = 1; k <= 2; k++) {
        w.contexts[k - 1]!.set("closed");
        expect(await rig.reconnect(), `${plan}, rebuild ${k}`).toBe(true);
        const fresh = FakeTransport.made[k]!;
        expect(fresh.cfg).toEqual({ plan, tx: "guest", rx: "host", sampleRate: 48000 });
        expect(fresh.sent).toHaveLength(1);
        expect(fresh.sent[0]!.map((f) => f.nbits)).toEqual([24, bits]);
        expect(fresh.keys).toEqual([[7, 9]]);
        expect(link.capacity()).toBe(bits);
      }
      rig.close();
    }
  });

  it("counts failures in a row, so the overlay can offer Leave after 2", async () => {
    const w = world();
    const { rig, ctx } = await running(w);
    ctx.resumeMode = "hang";
    ctx.set("suspended");
    await w.clock.advance(600);
    // every context made from now on is stuck too
    w.nextCtx = { resumeMode: "hang" };
    for (let i = 1; i <= 3; i++) {
      const ok = rig.reconnect();
      await w.clock.advance(1000);
      expect(await ok).toBe(false);
      expect(rig.failures).toBe(i);
    }
    expect(rig.failures).toBeGreaterThanOrEqual(LEAVE_AFTER_FAILURES);
    rig.close();
  });

  it("re-requests the wake lock when the page is visible again, and shows the overlay at once if the context stopped", async () => {
    const w = world();
    const { rig, lost, ctx } = await running(w);
    expect(w.wake.requests).toBe(1);
    // hidden: the browser releases the lock
    w.doc.visibilityState = "hidden";
    w.doc.emit("visibilitychange");
    await w.wake.sentinels[0]!.release();
    expect(rig.hasWakeLock).toBe(false);
    ctx.state = "suspended";
    w.doc.visibilityState = "visible";
    w.doc.emit("visibilitychange");
    expect(w.wake.requests).toBe(2);
    expect(lost).toEqual(["context"]);
    await settle();
    expect(rig.hasWakeLock).toBe(true);
    rig.close();
  });

  it("switches mic mode into the same node", async () => {
    const w = world();
    const { rig } = await running(w);
    await rig.setMicMode("ec");
    expect(rig.micMode).toBe("ec");
    expect(w.devices.streams).toHaveLength(2);
    expect((w.devices.streams[1]!.constraints.audio as MediaTrackConstraints).echoCancellation).toBe(true);
    expect(w.devices.streams[0]!.track.stopped).toBe(true);
    expect(w.contexts[0]!.sources[1]!.to).toBe(FakeTransport.made[0]!.node);
    expect(w.contexts[0]!.sources[0]!.to).toBeNull();
    // a refused request keeps the old stream
    w.devices.answer = "deny";
    await expect(rig.setMicMode("raw")).rejects.toMatchObject({ reason: "mic-refused" });
    expect(rig.micMode).toBe("ec");
    expect(w.devices.streams[1]!.track.stopped).toBe(false);
    rig.close();
  });

  it("closes everything and puts the session back", async () => {
    const w = world();
    const { rig, ctx, track } = await running(w);
    rig.close();
    rig.close();
    expect(rig.state).toBe("closed");
    expect(track.stopped).toBe(true);
    expect(ctx.state).toBe("closed");
    expect(FakeTransport.made[0]!.closed).toBe(true);
    expect(w.session.type).toBe("auto");
    expect(w.wake.sentinels[0]!.released).toBe(true);
    expect(w.doc.listeners("visibilitychange")).toBe(0);
    expect(w.devices.listeners("devicechange")).toBe(0);
    expect(rig.captureOkMs()).toBe(0);
    expect(await rig.reconnect()).toBe(false);
  });

  it("stops the microphone a failed rebuild asked for, and closes the context it made", async () => {
    for (const bad of ["rate", "update"] as const) {
      const w = world();
      const { rig, ctx, track } = await running(w);
      // the track ended and the context closed: the tap rebuilds and asks for the microphone again
      track.end();
      ctx.set("closed");
      if (bad === "rate") w.nextCtx = { sampleRate: 16000 };
      else w.worklet = "fail";
      expect(await rig.reconnect()).toBe(false);
      expect(rig.lastError?.reason).toBe(bad);
      expect(rig.failures).toBe(1);
      const asked = w.devices.streams[1]!;
      expect(asked.track.stopped, bad).toBe(true);
      expect(w.contexts[1]!.state).toBe("closed");
      rig.close();
      expect(asked.track.readyState).toBe("ended");
    }
  });

  it("leaves nothing running when closed while a rebuild waits for the microphone or the worklet", async () => {
    // (a) the microphone request is still out when the rig closes
    let w = world();
    let r = await running(w);
    r.track.end();
    r.ctx.set("closed");
    w.devices.answer = "hold";
    let ok = r.rig.reconnect();
    r.rig.close();
    // the rebuilt context goes with the rig, before the request is even answered
    expect(w.contexts[1]!.state).toBe("closed");
    w.devices.held[0]!();
    expect(await ok).toBe(false);
    expect(w.devices.streams[1]!.track.stopped).toBe(true);
    expect(w.session.type).toBe("auto");

    // (b) the new context's worklet is still loading, with a new microphone
    w = world();
    r = await running(w);
    r.track.end();
    r.ctx.set("closed");
    w.worklet = "hold";
    ok = r.rig.reconnect();
    await settle();
    expect(w.heldWorklets).toHaveLength(1);
    r.rig.close();
    w.heldWorklets[0]!();
    expect(await ok).toBe(false);
    expect(w.contexts[1]!.state).toBe("closed");
    expect(w.devices.streams[1]!.track.stopped).toBe(true);
    expect(FakeTransport.made.every((t) => t.closed)).toBe(true);
    expect(r.rig.ctx).toBe(w.contexts[0] as unknown);

    // (c) the same with the old microphone kept (a rebuild after a resume that did not take)
    w = world();
    r = await running(w);
    r.ctx.resumeMode = "hang";
    r.ctx.set("interrupted" as AudioContextState);
    await w.clock.advance(600);
    ok = r.rig.reconnect();
    await w.clock.advance(1000);
    expect(await ok).toBe(false);
    w.worklet = "hold";
    ok = r.rig.reconnect();
    await settle();
    r.rig.close();
    w.heldWorklets[0]!();
    expect(await ok).toBe(false);
    expect(w.contexts[1]!.state).toBe("closed");
    expect(r.track.stopped).toBe(true);
    expect(w.contexts[1]!.sources).toHaveLength(0);
  });

  it("takes no devicechange from before the microphone opened for a loss", async () => {
    const w = world();
    w.devices.answer = "hold";
    const rig = open(w);
    const lost: string[] = [];
    rig.onLost((r) => lost.push(r));
    // Safari fires devicechange from getUserMedia itself (labels appear), before the request resolves
    w.devices.emit("devicechange");
    await settle();
    w.devices.held[0]!();
    expect(await rig.ready).toBe("running");
    await rig.createLink(HOST);
    await w.clock.advance(300);
    expect(lost).toEqual([]);
    expect(rig.state).toBe("running");
    // a real change after it still counts
    w.devices.devices.push({ kind: "audioinput", deviceId: "headset" });
    w.devices.emit("devicechange");
    await w.clock.advance(300);
    expect(lost).toEqual(["devicechange"]);
    rig.close();
  });

  it("starts capture afresh on a new link or a rebuilt transport, whatever gap the old one left open", async () => {
    // a new link after the old one's last word was a gap starting
    let w = world();
    let r = await running(w);
    FakeTransport.made[0]!.gaps.push({ at: r.link.now(), ms: 0 });
    expect(r.rig.captureOkMs()).toBe(0);
    await r.rig.createLink({ ...HOST, plan: "low" });
    await w.clock.advance(3000);
    expect(r.rig.captureOkMs()).toBe(3000);
    r.rig.close();

    // a rebuilt context: the old transport's gap never ends
    w = world();
    r = await running(w);
    FakeTransport.made[0]!.gaps.push({ at: r.link.now(), ms: 0 });
    r.ctx.resumeMode = "hang";
    r.ctx.set("interrupted" as AudioContextState);
    await w.clock.advance(600);
    let ok = r.rig.reconnect();
    await w.clock.advance(1000);
    expect(await ok).toBe(false);
    ok = r.rig.reconnect();
    expect(await ok).toBe(true);
    expect(FakeTransport.made).toHaveLength(2);
    await w.clock.advance(5000);
    expect(r.rig.captureOkMs()).toBe(5000);
    r.rig.close();
  });

  it("runs without the extra tap when a context waiting in tap-to-start starts by itself", async () => {
    const w = world();
    w.nextCtx = { resumeMode: "hang" };
    const rig = open(w);
    await w.clock.advance(300);
    expect(await rig.ready).toBe("tap-to-start");
    await rig.createLink(HOST);
    expect(rig.captureOkMs()).toBe(0);
    // iOS finishes the slow resume on its own
    w.contexts[0]!.set("running");
    expect(rig.state).toBe("running");
    await w.clock.advance(3000);
    expect(rig.captureOkMs()).toBe(3000);
    rig.close();
  });
});
