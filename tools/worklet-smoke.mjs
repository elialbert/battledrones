// Worklet smoke (SOUND-DUEL.md "Worklet" > Tests): the modem's AudioWorklet,
// built the way production builds it, decoding both ways in Chromium.
//
// It builds a scratch entry that imports src/link/worklet-transport.ts (which
// imports the worklet as ./worklet.ts?worker&url) with Vite's build API and
// the project's own vite.config.ts, into a directory under the system temp
// dir (dist/ is left alone: other tools serve it, and until the lobby imports
// the rig it holds no worklet). It checks the emitted worklet is one
// self-contained IIFE (no import, export or import.meta: what addModule
// accepts) and that the service worker precaches it, then serves the build
// and, in Chromium, renders an OfflineAudioContext at 48 kHz with two modem
// nodes, host and guest, made by the real WorkletTransport:
//
//   host ──gain 0.3, 75 ms──▶ host's microphone     (own path, loud)
//   host ──gain 0.01, 3 ms──▶ guest's microphone    (peer path, 30 dB quieter)
//   guest ──gain 0.3, 75 ms─▶ guest's microphone
//   guest ──gain 0.01, 3 ms─▶ host's microphone
//   noise at −80 dBFS into both microphones
//
// (the cycles run through DelayNodes, which Web Audio requires). The guest's
// microphone arrives on its node's second input channel only, so the
// worklet's channel choice is exercised too. The host sends a list of three
// frames in key rotation, the guest one frame; 6 s in, the rendering
// suspends and the host's list is replaced, and the rotation must go on by
// key. Both must lock, decode 30 packets or more with no bad ones, and post
// no errors. The same build runs again with the bare worklet driven by its raw
// messages (the protocol alone, as --dist below needs). The transports run on
// the offline context's own clock (options.clock): an offline render has no
// wall clock to keep up with, and on performance.now() one slower than real
// time (a busy host) reads as a context that stopped, which the transport
// rightly posts as a skip; the modem then jumps at the next suspension and
// the rotation breaks (a render held to 0.44× for 2 s of audio posted 1.8
// and 2.3 s skips both ways and cut the packet in flight at the swap). So no
// skip may be posted here.
//
// Then, on the same build, two real-time AudioContexts, host and guest,
// each hearing itself loud and the other quietly through a MediaStream (the
// air between them); once they hear each other the guest's context is
// suspended for 0.7 s, then 1.5 s, and resumed (--no-realtime skips it).
// Neither transport may post a skip while running; the guest's must post the
// stretch as one skip after, within SUSPEND_AGREE_MS (60) of how far its
// context's clock fell behind across it (the modem reports the skip as a
// capture gap of that length), which must lie between the time it was
// suspended and the time from suspend() to resume() settling (a busy main
// thread stretches the latter: 856 ms around a 684 ms step, the main thread
// held 150 ms as resume() settled). The host
// must hear the guest again within a second (the skip starts a new
// superframe), the guest the host within 3 s. (The guest's own receiver
// gains little from the skip in Chromium: its MediaStream input comes back on
// a 10 ms grid, about 20 ms off what the context's clock says, so it usually
// waits for the host's next sync as it would without one.)
//
// Real time runs on a host that may be busy, and some of what happens in it
// is the browser's, not the modem's. The page reads each context's clock
// against performance.now() every 25 ms from the moment it runs, as the
// transport does, and holds every skip posted while running against it
// (running()). A stall of the browser's audio stops both contexts at once
// and each transport rightly posts it (both posted a 104 ms skip together
// under load on 4 CPUs, 1 run in 5; stopping the browser's audio service for
// 200 ms leaves each context's clock 188–193 ms behind for good): a skip in
// each context within STALL_WINDOW_MS, each matched within STALL_AGREE_MS by
// how far its own clock fell behind and stayed, is let through and logged
// (the two lengths needn't agree: 193.8 and 173.8 ms once). A render thread
// held up alone renders what it owes as soon as it runs again (a 300 ms hold
// caught up within 20 ms), so a lasting step in one context only is rarer,
// but seen under load; and a transport can leave part of a stall unreported
// (127.1 ms skipped of one its clock put at 224.1, after a 200 ms stop of the
// audio service: 4 such stops in 8) or post one its context then caught up
// (a 346.6 ms skip whose clock settled 91 ms behind, under load). None of
// these is let through, but a busy host makes them all; the last two are
// printed as a NOTE for the transport's owner. And Chromium sometimes hands
// the resumed guest one to three render quanta of digital silence (2.7 to
// 10.7 ms seen, 4 resumes in 52), which the modem rightly reports as a
// capture gap: a gap of at most RESUME_SILENCE_MS within RESUME_EDGE_MS of
// resume() is let through, and logged; the skip's own gap must still be there
// at its length. Last, one that may be either's: now and then a receiver
// misses the first sync after the skip and hears its friend a superframe
// later (the host the guest 2457 and 2648 ms after a 0.7 s suspension, where
// it is usually 190–700 ms; the guest the host 3448 ms after one): a NOTE for
// the receiver's owner, pass or fail.
//
// So a problem is hard or not (checkRealtime): hard when a busy host can't
// make it (worklet errors, a skip whose context's clock never fell behind by
// it, a suspension skipped wrong, a capture gap the skips and the resume
// don't account for), and then the smoke fails at once; otherwise (a hearing
// too slow, any of the skips above but a shared stall, missing clock
// readings) the whole real-time section runs once more in a fresh tab, both
// attempts printed, with every threshold as it is, and it passes only if the
// second attempt passes whole. The OK line says when it took two.
//
// Then the same offline scenario through Vite's dev server, where the
// worklet is an ES module with imports (--no-dev skips it). With --dist it also runs
// against the worklet in an existing dist/ (after `npm run build`, once the
// lobby imports the rig), driving the node with raw messages since the
// transport is inside the lobby's chunk there.
//
// (Offline rendering runs flat out, and Chromium hands the worklet the main
// thread's messages only while it is suspended, so the scenario suspends one
// quantum after each message it posts. A real-time context delivers them
// between quanta.)
//
// Usage: node tools/worklet-smoke.mjs [--no-dev] [--no-realtime] [--dist] [--keep]
// Prints WORKLET SMOKE OK (with "real time on its second attempt" when it
// took two, and "see the NOTE above" after a NOTE), or FAIL lines and exits
// non-zero.
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, createServer as createViteServer } from "vite";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const MIME = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".webmanifest": "application/manifest+json" };
// the processor's registered name, from the module both sides import
const PROCESSOR = /export const MODEM_PROCESSOR = "([^"]+)"/.exec(readFileSync(join(ROOT, "src/link/worklet-protocol.ts"), "utf8"))[1];

let failed = false;
/** The real-time section passed on its second attempt; what it noted for the modem's owner. */
let retried = false;
const notes = [];
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  failed = true;
};

/** The page the scenario runs in (an icon, so no 404 shows up as a console error). */
const PAGE = (script = "") => `<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>worklet smoke</title>${script}`;

/** A static server for `dir`, with `page` at /smoke.html. */
async function serve(dir, page) {
  const server = createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p === "/smoke.html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(page);
      return;
    }
    const file = join(dir, p);
    if (!file.startsWith(dir) || !existsSync(file)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

/**
 * The scenario, run in the page. `kind` is "transport" (window.__link holds
 * loadWorklet and WorkletTransport) or "raw" (the worklet at `url`, driven
 * by its messages directly).
 */
async function scenario({ kind, url, name }) {
  /** The same surface as WorkletTransport, over the raw messages. */
  class RawLink {
    constructor(ctx, cfg) {
      this.node = new AudioWorkletNode(ctx, name, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 2,
        channelCountMode: "explicit",
        channelInterpretation: "discrete",
        processorOptions: cfg
      });
      this.node.connect(ctx.destination);
      this.inbox = [];
      this.report = null;
      this.onError = null;
      this.node.port.onmessage = ({ data: m }) => {
        if (m.t === "rx") this.inbox.push({ bits: m.bits, nbits: m.nbits });
        else if (m.t === "stats") this.report = m;
        else if (m.t === "error") this.onError?.(m.message);
      };
    }
    send(frames) {
      this.node.port.postMessage({ t: "payload", frames });
    }
    poll() {
      return this.inbox.splice(0);
    }
    stats() {
      return this.report ?? { locked: false, rxOk: 0, rxBad: 0 };
    }
  }
  const load = kind === "raw" ? (ctx) => ctx.audioWorklet.addModule(url) : window.__link.loadWorklet;
  const Link = kind === "raw" ? RawLink : window.__link.WorkletTransport;

  /** A lobby-type frame naming its key, 184 bits. */
  const keyed = (key) => {
    const bits = new Uint8Array(23);
    bits[0] = 0x80;
    bits[1] = key >> 8;
    bits[2] = key & 255;
    for (let i = 3; i < 23; i++) bits[i] = (key * 37 + i * 101) & 255;
    return { bits, nbits: 184, key };
  };
  const keyOf = (p) => {
    const key = (p.bits[1] << 8) | p.bits[2];
    const ref = keyed(key).bits;
    return p.nbits === 188 && ref.every((v, i) => p.bits[i] === v) ? key : -1;
  };

  const sr = 48000;
  const seconds = 12;
  const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: sr * seconds, sampleRate: sr });
  await Promise.all([load(ctx), load(ctx)]);
  // (the transports on the offline context's own clock: see the header)
  const clock = { clock: () => ctx.currentTime * 1000 };
  const host = new Link(ctx, { sampleRate: sr, plan: "high", tx: "host", rx: "guest" }, clock);
  const guest = new Link(ctx, { sampleRate: sr, plan: "high", tx: "guest", rx: "host" }, clock);
  const errors = [];
  host.onError = (m) => errors.push(`host: ${m}`);
  guest.onError = (m) => errors.push(`guest: ${m}`);
  // the skips a transport posts (none: on this clock the context can't fall behind)
  const skips = [];
  for (const [role, link] of [["host", host], ["guest", guest]]) {
    const post = link.node.port.postMessage.bind(link.node.port);
    link.node.port.postMessage = (m, x) => {
      if (m.t === "skip") skips.push(`${role} ${Math.round((m.frames / sr) * 1000)} ms at ${ctx.currentTime.toFixed(2)} s`);
      return post(m, x);
    };
  }
  // the guest's microphone on its second channel only (the first is silent)
  const guestMic = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
  guestMic.connect(guest.node);
  const mic = [
    [host.node, 0],
    [guestMic, 1]
  ];
  const path = (from, [to, input], gain, delayTime) => {
    const g = new GainNode(ctx, { gain });
    const d = new DelayNode(ctx, { delayTime, maxDelayTime: 1 });
    from.connect(g).connect(d).connect(to, 0, input);
  };
  path(host.node, mic[0], 0.3, 0.075);
  path(host.node, mic[1], 0.01, 0.003);
  path(guest.node, mic[1], 0.3, 0.075);
  path(guest.node, mic[0], 0.01, 0.003);
  const noise = ctx.createBuffer(1, sr, sr);
  const nd = noise.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = 1e-4 * (Math.random() * 2 - 1) * Math.sqrt(3);
  const src = new AudioBufferSourceNode(ctx, { buffer: noise, loop: true });
  src.connect(host.node, 0, 0);
  src.connect(guestMic, 0, 1);
  src.start();

  // a suspension one quantum after each message lets it through (see the header)
  const pause = (t, fn) => ctx.suspend(t).then(() => (fn?.(), ctx.resume()));
  const q = 128 / sr;
  host.send([keyed(10), keyed(20), keyed(30)]);
  guest.send([keyed(77)]);
  pause(q);
  const swapAt = 6;
  pause(swapAt, () => host.send([keyed(15), keyed(25)]));
  pause(swapAt + q);
  const t0 = performance.now();
  await ctx.startRendering();
  const renderMs = performance.now() - t0;
  // the last messages from the audio thread
  await new Promise((r) => setTimeout(r, 500));
  return {
    renderMs,
    errors,
    skips,
    toGuest: guest.poll().map(keyOf),
    toHost: host.poll().map(keyOf),
    host: host.stats(),
    guest: guest.stats()
  };
}

/**
 * Real time, one phone suspended: two AudioContexts, host and guest, each
 * hearing itself loud (75 ms) and the other quietly through a MediaStream
 * (the air between them). Once both hear each other, the guest's context is
 * suspended for `ms` and resumed. Its WorkletTransport should have posted no
 * skip while running (a stall of the browser's audio aside: see the header,
 * and running()), and should post the stretch as one skip afterwards (a
 * capture gap of that length); the host should hear the guest again within a
 * second (the skip starts a new superframe), and the guest the host within
 * the spec's 2.5 s and a margin.
 */
async function realtime({ ms }) {
  const { loadWorklet, WorkletTransport } = window.__link;
  const sr = 48000;
  const sleep = (t) => new Promise((r) => setTimeout(r, t));
  const errors = [];
  const keyed = (key) => {
    const bits = new Uint8Array(23);
    bits[0] = 0x80;
    bits[1] = key >> 8;
    bits[2] = key & 255;
    for (let i = 3; i < 23; i++) bits[i] = (key * 37 + i * 101) & 255;
    return { bits, nbits: 184, key };
  };
  // each context's clock against performance.now(), every 25 ms from the moment it runs (a stall while the other is
  // being made shows too), as the transport reads it: what each skip is checked against; and how late the main thread
  // ran the readings (the host's load)
  const phones = [];
  let lastRead = performance.now();
  let lateMs = 0;
  const reader = setInterval(() => {
    const t = performance.now();
    lateMs = Math.max(lateMs, t - lastRead - 25);
    lastRead = t;
    for (const p of phones) if (p.ctx.state === "running") p.clock.push([t, t - p.ctx.currentTime * 1000]);
  }, 25);
  const phone = async (role) => {
    const ctx = new AudioContext({ sampleRate: sr, latencyHint: "interactive" });
    await ctx.resume();
    /** clock: [performance.now(), how far the context's clock lies behind it], while it runs; skips: what the transport posted, and when. */
    const p = { ctx, clock: [], skips: [], got: [] };
    phones.push(p);
    await loadWorklet(ctx);
    const tr = new WorkletTransport(ctx, { sampleRate: sr, plan: "high", tx: role, rx: role === "host" ? "guest" : "host" });
    tr.onError = (m) => errors.push(`${role}: ${m}`);
    const post = tr.node.port.postMessage.bind(tr.node.port);
    tr.node.port.postMessage = (m, x) => {
      if (m.t === "skip") p.skips.push({ at: performance.now(), ms: (m.frames / sr) * 1000 });
      return post(m, x);
    };
    tr.node.connect(new GainNode(ctx, { gain: 0.3 })).connect(new DelayNode(ctx, { delayTime: 0.075, maxDelayTime: 1 })).connect(tr.node);
    const air = new MediaStreamAudioDestinationNode(ctx, { channelCount: 1 });
    tr.node.connect(new GainNode(ctx, { gain: 0.01 })).connect(air);
    const noise = ctx.createBuffer(1, sr, sr);
    const nd = noise.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = 1e-4 * (Math.random() * 2 - 1) * Math.sqrt(3);
    const src = new AudioBufferSourceNode(ctx, { buffer: noise, loop: true });
    src.connect(tr.node);
    src.start();
    return Object.assign(p, { tr, air });
  };
  const host = await phone("host");
  const guest = await phone("guest");
  host.ctx.createMediaStreamSource(guest.air.stream).connect(host.tr.node);
  guest.ctx.createMediaStreamSource(host.air.stream).connect(guest.tr.node);
  host.tr.send([keyed(10), keyed(20), keyed(30)]);
  guest.tr.send([keyed(77)]);
  // packets on the clock both share (performance.now())
  const poll = () => {
    for (const p of [host, guest]) for (const k of p.tr.poll()) p.got.push(p.tr.t0 + k.at);
  };
  for (let t = 0; t < 12000 && (host.got.length < 4 || guest.got.length < 4); t += 50) {
    await sleep(50);
    poll();
  }
  const ready = [host.got.length, guest.got.length];
  // a second more, running: still no skip
  await sleep(1000);
  poll();
  const before = performance.now();
  guest.tr.takeGaps();
  await guest.ctx.suspend();
  await sleep(ms);
  const resuming = performance.now();
  await guest.ctx.resume();
  const back = performance.now();
  for (let t = 0; t < 4000; t += 50) {
    await sleep(50);
    poll();
  }
  const first = (p) => {
    const t = p.got.find((x) => x >= back);
    return t === undefined ? null : Math.round(t - back);
  };
  clearInterval(reader);
  const res = {
    ms,
    ready,
    before,
    back,
    skips: { host: host.skips, guest: guest.skips },
    clocks: { host: host.clock, guest: guest.clock },
    lateMs: Math.round(lateMs),
    suspendedMs: Math.round(back - before),
    resuming,
    // (on performance.now(), as the skips are)
    gaps: guest.tr.takeGaps().map((g) => ({ at: guest.tr.t0 + g.at, ms: Math.round(g.ms * 10) / 10 })),
    hostHears: first(host),
    guestHears: first(guest),
    locked: [host.tr.stats().locked, guest.tr.stats().locked],
    errors
  };
  for (const p of [host, guest]) {
    p.tr.close();
    await p.ctx.close();
  }
  return res;
}

/**
 * Digital silence on the guest's input at the resume, as long as this (ms) at
 * most, within RESUME_EDGE_MS of resume() (see the header).
 */
const RESUME_SILENCE_MS = 20;
const RESUME_EDGE_MS = 50;
/** A stall in each context this close together (ms) is one stall of the browser's audio (see the header). */
const STALL_WINDOW_MS = 500;
/** A skip is a stall of its context when the context's clock fell behind by the skip, and stayed, within this (ms). */
const STALL_AGREE_MS = 30;
/** The guest's skip for its suspension: within this (ms) of how far its clock fell behind across it. */
const SUSPEND_AGREE_MS = 60;
/** How long after its suspension the host must hear the guest, and the guest the host (ms). */
const HEARS_MS = { host: 1000, guest: 3000 };
/** The modem's superframe (ms): a sync symbol and DATA_SYMBOLS data symbols of TU + TCP (params.ts). */
const SUPERFRAME_MS = (() => {
  const params = readFileSync(join(ROOT, "src/link/modem/params.ts"), "utf8");
  const param = (name) => Number(new RegExp(`export const ${name} = ([\\d.]+);`).exec(params)[1]);
  return Math.round((param("DATA_SYMBOLS") + 1) * (param("TU") + param("TCP")) * 1000);
})();

/** The lowest and highest of a context's clock readings from `from` to `to` (±Infinity: none). Readings run late, never early, so the lowest is the truest. */
function readings(clock, from, to) {
  const d = clock.filter(([t]) => t >= from && t <= to).map(([, d]) => d);
  return { low: Math.min(...d), high: Math.max(...d) };
}

/** When `side`'s clock last stepped before `at`, as far as the page can say: its newest skip before (−Infinity: none). */
const sinceOf = (r, side, at) => Math.max(-Infinity, ...r.skips[side].filter((k) => k.at < at).map((k) => k.at));

/**
 * A skip `k` that `side`'s transport posted, against its context's clock as
 * the page read it. step: how far the clock fell behind and stayed, the
 * lowest reading in the second after the skip against the lowest in the 2.5 s
 * before the stall could have ended (the transport posts a skip
 * SKIP_CONFIRM_MS, 200 ms, after the first reading past the step), none from
 * before the side's previous skip (the clock stepped there too). peak: how far
 * it was behind at most while the transport confirmed it (its readings come
 * with the worklet's messages, at least every 250 ms). NaN without readings.
 */
function against(r, side, k) {
  const clock = r.clocks[side];
  const base = readings(clock, Math.max(k.at - k.ms - 2700, sinceOf(r, side, k.at)), k.at - k.ms - 200).low;
  const finite = (x) => (Number.isFinite(x) ? x : NaN);
  return { step: finite(readings(clock, k.at, k.at + 1000).low - base), peak: finite(readings(clock, k.at - 450, k.at + 25).high - base) };
}

/**
 * The skips posted while running (all but the guest's for its suspension),
 * each as its context's clock shows it: "stall" (the clock fell behind by the
 * skip and stayed: the context really stopped, and the transport did its
 * job), "deeper" (it stayed further behind than the skip: the transport left
 * part of the stall, under SKIP_MIN_MS, unreported), "caught up" (it
 * fell behind by the skip, as the transport saw, then caught up: a render
 * thread starved of the CPU renders what it owes late, which the transport
 * can't tell from a stall within SKIP_CONFIRM_MS), "unread" (no readings to
 * tell by) or "unshown" (with readings all along, the clock never fell
 * behind by the skip: the transport's fault). A stall in each context within
 * STALL_WINDOW_MS is one stall of the browser's audio: `shared` (the other).
 */
function running(r, sus) {
  const out = [];
  for (const side of ["host", "guest"])
    for (const k of r.skips[side]) {
      if (k === sus) continue;
      const { step, peak } = against(r, side, k);
      const kind = Number.isNaN(step)
        ? "unread"
        : Math.abs(step - k.ms) <= STALL_AGREE_MS
          ? "stall"
          : step > k.ms
            ? "deeper"
            : peak >= k.ms - STALL_AGREE_MS
              ? "caught up"
              : Number.isNaN(peak)
                ? "unread"
                : "unshown";
      out.push({ side, k, step, peak, kind, shared: null });
    }
  for (const a of out) {
    if (a.side !== "host" || a.kind !== "stall") continue;
    const b = out.find((b) => b.side === "guest" && b.kind === "stall" && !b.shared && Math.abs(b.k.at - a.k.at) <= STALL_WINDOW_MS);
    if (b) [a.shared, b.shared] = [b, a];
  }
  return out;
}

/**
 * Check a real-time run: what failed (nothing: it passed), each problem
 * `hard` when a busy host can't make it (worklet errors, a skip its clock never
 * showed, a suspension skipped wrong, a capture gap the skips and the resume
 * don't account for), or not when it can (a hearing too slow, a stall in one
 * context, a skip for a stall the context caught up, readings missing): only
 * those earn the second attempt (see the header). `notes` are for the modem's
 * owner whatever the outcome.
 */
function checkRealtime(label, r) {
  const problems = [];
  const notes = [];
  const say = (msg, hard) => problems.push({ msg: `${label}: ${msg}`, hard });
  const tenth = (x) => Math.round(x * 10) / 10;
  const at = (k) => `${Math.round(k.at - r.back)} ms from the resume`;
  // the guest's skip for its suspension: the first it posted after the suspension began (none while suspended)
  const sus = r.skips.guest.find((k) => k.at >= r.before) ?? null;
  const skips = running(r, sus);
  // how far the guest's clock fell behind across the suspension: from the resume on, and as it stood when the skip
  // was posted (a stall just after the resume shows in the latter only)
  const g = r.clocks.guest;
  const base = readings(g, Math.max(r.before - 2500, sinceOf(r, "guest", r.before)), r.before).low;
  const across = readings(g, r.back, r.back + 1000).low - base;
  const posted = sus && readings(g, sus.at, sus.at + 1000).low - base;
  console.log(
    `${label}: suspended ${r.suspendedMs} ms (from the suspend() call to resume() settling), skipped ${sus ? tenth(sus.ms) : "nothing"} (its clock fell behind ${tenth(across)}); the host heard the guest ${r.hostHears} ms after, the guest the host ${r.guestHears} ms after (the main thread ran up to ${r.lateMs} ms late)`
  );
  for (const s of skips.filter((s) => s.shared && s.side === "host")) {
    const g = s.shared;
    console.log(
      `${label}: a stall of the browser's audio ${at(s.k)}: both contexts skipped it (host ${tenth(s.k.ms)} ms, guest ${tenth(g.k.ms)} ms; their clocks fell behind ${tenth(s.step)} and ${tenth(g.step)} ms)`
    );
  }
  if (r.ready[0] < 4 || r.ready[1] < 4) {
    say(`they never heard each other (${r.ready})`, false);
    return { problems, notes };
  }
  if (r.errors.length) say(`worklet errors: ${r.errors.join("; ")}`, true);
  // skips while running
  const told = (s) => `the ${s.side} ${tenth(s.k.ms)} ms ${at(s.k)} (its clock: ${tenth(s.step)} ms behind after, ${tenth(s.peak)} at most)`;
  const which = (kind) => skips.filter((s) => s.kind === kind && !s.shared);
  if (which("unshown").length) say(`a skip its context's clock never showed: ${which("unshown").map(told).join("; ")}`, true);
  if (which("stall").length) say(`a stall of one context's audio: ${which("stall").map(told).join("; ")}`, false);
  if (which("deeper").length) say(`a skip short of the stall its clock shows: ${which("deeper").map(told).join("; ")}`, false);
  if (which("caught up").length) say(`a skip for a stall its context then caught up: ${which("caught up").map(told).join("; ")}`, false);
  if (which("unread").length) say(`a skip while running, with no clock readings to tell it by: ${which("unread").map(told).join("; ")}`, false);
  // (a skip that misses its stall leaves the modem's frame counter off by the difference: the transport's to answer)
  for (const s of skips.filter((s) => s.kind === "deeper"))
    notes.push(`${label}: the ${s.side}'s transport skipped ${tenth(s.k.ms)} ms ${at(s.k)} for a stall its context's clock puts at ${tenth(s.step)} ms`);
  for (const s of skips.filter((s) => s.kind === "caught up"))
    notes.push(`${label}: the ${s.side}'s transport skipped ${tenth(s.k.ms)} ms ${at(s.k)} for a stall its context then caught up (its clock settled ${tenth(s.step)} ms behind)`);
  // the suspension: one skip, as long as the guest's clock fell behind across it (which lies between the time it
  // was suspended and the time from suspend() to resume() settling)
  if (!sus) say(`the guest posted no skip for its suspension`, true);
  else {
    const what = `the guest skipped ${tenth(sus.ms)} ms; its clock fell behind ${tenth(across)} ms across the suspension`;
    if (!Number.isFinite(across)) say(`${what} (no clock readings to tell it by)`, false);
    else if (Math.abs(sus.ms - across) > SUSPEND_AGREE_MS) {
      // (the skip measured as the clock stood when it was posted: a stall right after the resume taken in)
      if (Math.abs(sus.ms - posted) <= SUSPEND_AGREE_MS) say(`${what}, and ${tenth(posted)} ms by the time the skip was posted: a stall just after the resume`, false);
      else say(what, true);
    } else if (sus.ms < r.ms - SUSPEND_AGREE_MS || sus.ms > r.suspendedMs + SUSPEND_AGREE_MS)
      say(`${what}, outside the ${r.ms} ms it was suspended at least and the ${r.suspendedMs} ms at most`, true);
  }
  // (the modem reports each skip as a capture gap of its length, a stall's too; the gaps come in pairs, its start
  // with length 0 and then its length, and the browser's silence at the resume is let through)
  const want = r.skips.guest.filter((k) => k.at >= r.before).flatMap((k) => [0, tenth(k.ms)]);
  const edge = (i) =>
    i % 2 === 0 && r.gaps[i].ms === 0 && r.gaps[i + 1] && r.gaps[i + 1].ms <= RESUME_SILENCE_MS &&
    r.gaps[i].at >= r.resuming - RESUME_EDGE_MS && r.gaps[i].at <= r.back + RESUME_EDGE_MS;
  const silences = [];
  const gaps = [];
  for (let i = 0; i < r.gaps.length; i++) {
    if (edge(i)) {
      silences.push(r.gaps[++i]);
      continue;
    }
    gaps.push(r.gaps[i].ms);
  }
  for (const g of silences) console.log(`${label}: the guest's input was digital silence for ${g.ms} ms at the resume (${Math.round(g.at - r.resuming)} ms from the resume() call)`);
  if (gaps.length !== want.length || gaps.some((g, i) => Math.abs(g - want[i]) > 0.1))
    say(`the guest's gaps were ${JSON.stringify(r.gaps.map((g) => g.ms))}, not ${JSON.stringify(want)}`, true);
  for (const side of ["host", "guest"]) {
    const heard = side === "host" ? r.hostHears : r.guestHears;
    const other = side === "host" ? "guest" : "host";
    if (heard !== null && heard <= HEARS_MS[side]) continue;
    say(`the ${side} heard the ${other} ${heard} ms after it came back`, false);
    // (one superframe late: it missed the first sync it should have heard)
    if (heard !== null && heard - SUPERFRAME_MS <= HEARS_MS[side])
      notes.push(`${label}: the ${side} heard the ${other} a superframe late, ${heard} ms after the resume (${heard - SUPERFRAME_MS} + ${SUPERFRAME_MS}): its receiver missed the first sync it should have heard`);
  }
  if (!r.locked[0] || !r.locked[1]) say(`not locked at the end: ${r.locked}`, false);
  return { problems, notes };
}

/** The keys a list rotates through after a packet carrying `last`, n packets' worth. */
function rotation(keys, last, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    last = keys.find((k) => last === null || k > last) ?? keys[0];
    out.push(last);
  }
  return out;
}

/** Check one run's result. */
function check(label, r) {
  const say = (msg) => fail(`${label}: ${msg}`);
  const swapped = r.toGuest.findIndex((x) => x === 15 || x === 25);
  console.log(`${label}: rendered 12 s in ${Math.round(r.renderMs)} ms; the guest heard ${r.toGuest.length} packets (the new list from packet ${swapped + 1}), the host ${r.toHost.length}`);
  if (r.errors.length) say(`worklet errors: ${r.errors.join("; ")}`);
  if (r.skips.length) say(`a transport posted a skip: ${r.skips.join("; ")}`);
  for (const side of ["host", "guest"]) {
    const s = r[side];
    if (!s.locked) say(`${side} not locked`);
    if (s.rxBad !== 0) say(`${side} rxBad ${s.rxBad}`);
  }
  if (r.toHost.length < 30) say(`the host heard only ${r.toHost.length} packets`);
  if (r.toHost.some((k) => k !== 77)) say(`the host heard keys ${JSON.stringify(r.toHost)}`);
  const k = r.toGuest;
  if (k.length < 30) say(`the guest heard only ${k.length} packets`);
  const swap = k.findIndex((x) => x === 15 || x === 25);
  if (swap <= 0) {
    say(`the replaced list never arrived: ${JSON.stringify(k)}`);
    return;
  }
  const want = [...rotation([10, 20, 30], k[0] === 10 ? null : k[0] - 10, swap), ...rotation([15, 25], k[swap - 1], k.length - swap)];
  if (JSON.stringify(k) !== JSON.stringify(want)) say(`the guest heard ${JSON.stringify(k)}, not the rotation ${JSON.stringify(want)}`);
}

async function run(browser, base, page, kind, url) {
  const tab = await browser.newPage();
  tab.setDefaultTimeout(120_000);
  const errors = [];
  tab.on("pageerror", (e) => errors.push(String(e)));
  tab.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await tab.goto(base + page);
  if (kind === "transport") await tab.waitForFunction(() => window.__link?.WorkletTransport);
  const r = await tab.evaluate(scenario, { kind, url, name: PROCESSOR });
  r.errors.push(...errors);
  await tab.close();
  return r;
}

const browser = await chromium.launch({ executablePath: ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find((p) => existsSync(p)) });
const scratch = mkdtempSync(join(tmpdir(), "worklet-smoke-"));
try {
  // 1. production: the project's config, a scratch entry, a scratch outDir
  const entry = join(scratch, "entry.js");
  const out = join(scratch, "dist");
  writeFileSync(
    entry,
    `import { loadWorklet, WorkletTransport } from ${JSON.stringify(join(ROOT, "src/link/worklet-transport.ts"))};\nglobalThis.__link = { loadWorklet, WorkletTransport };\n`
  );
  await build({
    configFile: join(ROOT, "vite.config.ts"),
    root: ROOT,
    logLevel: "warn",
    publicDir: false,
    build: {
      outDir: out,
      emptyOutDir: true,
      rollupOptions: { input: entry, output: { entryFileNames: "assets/smoke-entry.js", manualChunks: () => undefined } }
    }
  });
  const worklet = readdirSync(join(out, "assets")).find((f) => /^worklet-[\w-]+\.js$/.test(f));
  if (!worklet) throw new Error("the build emitted no worklet asset");
  const code = readFileSync(join(out, "assets", worklet), "utf8");
  if (!/^\(function\(\)\{/.test(code) || !/\}\)\(\);?\s*$/.test(code)) fail(`${worklet} is not one IIFE`);
  if (/^\s*(import|export)\b/m.test(code) || /import\.meta|\bimport\(/.test(code)) fail(`${worklet} imports or exports`);
  if (!readFileSync(join(out, "sw.js"), "utf8").includes(worklet)) fail(`the service worker does not precache ${worklet}`);
  console.log(`production build: ${worklet} (${code.length} bytes), one IIFE, precached`);
  const prod = await serve(out, PAGE(`<script type="module" src="./assets/smoke-entry.js"></script>`));
  check("production", await run(browser, prod.url, "/smoke.html", "transport"));
  // the bare worklet, driven by its messages (as --dist does)
  check("production, raw messages", await run(browser, prod.url, "/smoke.html", "raw", `${prod.url}/assets/${worklet}`));
  if (!args.has("--no-realtime")) {
    // (once more when the first attempt failed only as a busy host can make it fail, in a fresh tab, every
    // threshold as it was: see the header)
    for (let attempt = 1; attempt <= 2; attempt++) {
      const tab = await browser.newPage();
      tab.setDefaultTimeout(120_000);
      const errors = [];
      tab.on("pageerror", (e) => errors.push(String(e)));
      tab.on("console", (m) => m.type() === "error" && errors.push(m.text()));
      await tab.goto(prod.url + "/smoke.html");
      await tab.waitForFunction(() => window.__link?.WorkletTransport);
      const problems = [];
      for (const ms of [700, 1500]) {
        const r = await tab.evaluate(realtime, { ms });
        r.errors.push(...errors.splice(0));
        const c = checkRealtime(`real time (attempt ${attempt}), the guest suspended ${ms} ms`, r);
        problems.push(...c.problems);
        for (const n of c.notes) console.log(`NOTE: ${n}`);
        notes.push(...c.notes);
      }
      await tab.close();
      if (!problems.length) {
        retried = attempt > 1;
        break;
      }
      if (attempt === 1 && !problems.some((p) => p.hard)) {
        for (const p of problems) console.log(`not yet: ${p.msg}`);
        console.log("real time: the first attempt failed only as a busy host can make it fail; once more");
        continue;
      }
      for (const p of problems) fail(p.hard || attempt > 1 ? p.msg : `${p.msg} (a busy host can do this one)`);
      if (attempt === 1) console.log("real time: no second attempt: a busy host doesn't do what failed");
      break;
    }
  }
  prod.server.close();

  // 2. the dev server: the worklet as an ES module with its imports
  if (!args.has("--no-dev")) {
    const vite = await createViteServer({
      configFile: join(ROOT, "vite.config.ts"),
      root: ROOT,
      logLevel: "warn",
      appType: "custom",
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { host: "127.0.0.1", port: 5190, hmr: false },
      // a page of our own to import from (the dev server's 404 page forbids scripts)
      plugins: [
        {
          name: "worklet-smoke-page",
          configureServer(server) {
            server.middlewares.use((req, res, next) => {
              if (req.url !== "/smoke.html") return next();
              res.setHeader("content-type", "text/html");
              res.end(PAGE());
            });
          }
        }
      ]
    });
    await vite.listen();
    const base = vite.resolvedUrls.local[0].replace(/\/$/, "");
    const page = await browser.newPage();
    page.setDefaultTimeout(120_000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.goto(`${base}/smoke.html`);
    const url = await page.evaluate(async () => {
      window.__link = await import("/src/link/worklet-transport.ts");
      return (await import("/src/link/worklet.ts?worker&url")).default;
    });
    console.log(`dev server: the worklet is ${url}`);
    const r = await page.evaluate(scenario, { kind: "transport", name: PROCESSOR });
    r.errors.push(...errors);
    check("dev", r);
    await page.close();
    await vite.close();
  }

  // 3. an existing dist/, when asked
  if (args.has("--dist")) {
    const dist = join(ROOT, "dist");
    const w = existsSync(join(dist, "assets")) && readdirSync(join(dist, "assets")).find((f) => /^worklet-[\w-]+\.js$/.test(f));
    if (!w) fail("dist/ holds no worklet (nothing imports the rig yet, or it isn't built)");
    else {
      const d = await serve(dist, PAGE());
      check(`dist (${w})`, await run(browser, d.url, "/smoke.html", "raw", `${d.url}/assets/${w}`));
      d.server.close();
    }
  }
} catch (e) {
  fail(e?.stack ?? String(e));
} finally {
  await browser.close();
  if (!args.has("--keep")) rmSync(scratch, { recursive: true, force: true });
  else console.log(`kept ${scratch}`);
}

if (failed) process.exit(1);
const also = [retried && "real time on its second attempt", notes.length && "see the NOTE above"].filter(Boolean);
console.log(`WORKLET SMOKE OK${also.length ? ` (${also.join("; ")})` : ""}`);
