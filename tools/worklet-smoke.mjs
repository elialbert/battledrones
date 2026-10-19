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
// messages (the protocol alone, as --dist below needs).
//
// Then, on the same build, two real-time AudioContexts, host and guest,
// each hearing itself loud and the other quietly through a MediaStream (the
// air between them); once they hear each other the guest's context is
// suspended for 0.7 s, then 1.5 s, and resumed (--no-realtime skips it).
// Neither transport may post a skip while running; the guest's must post the
// stretch as one skip after (within 60 ms of the suspension, which the modem
// reports as a capture gap of that length), and the host must hear the guest
// again within a second (the skip starts a new superframe), the guest the
// host within 3 s. (The guest's own receiver gains little from the skip in
// Chromium: its MediaStream input comes back on a 10 ms grid, about 20 ms
// off what the context's clock says, so it usually waits for the host's
// next sync as it would without one.)
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
// Prints WORKLET SMOKE OK, or FAIL lines and exits non-zero.
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
  const host = new Link(ctx, { sampleRate: sr, plan: "high", tx: "host", rx: "guest" });
  const guest = new Link(ctx, { sampleRate: sr, plan: "high", tx: "guest", rx: "host" });
  const errors = [];
  host.onError = (m) => errors.push(`host: ${m}`);
  guest.onError = (m) => errors.push(`guest: ${m}`);
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
 * skip while running, and should post the stretch as one skip afterwards (a
 * capture gap of about that length); the host should hear the guest again
 * within a second (the skip starts a new superframe), and the guest the host
 * within the spec's 2.5 s and a margin.
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
  const phone = async (role) => {
    const ctx = new AudioContext({ sampleRate: sr, latencyHint: "interactive" });
    await ctx.resume();
    await loadWorklet(ctx);
    const tr = new WorkletTransport(ctx, { sampleRate: sr, plan: "high", tx: role, rx: role === "host" ? "guest" : "host" });
    tr.onError = (m) => errors.push(`${role}: ${m}`);
    // the skips it posts, and when
    const skips = [];
    const post = tr.node.port.postMessage.bind(tr.node.port);
    tr.node.port.postMessage = (m, x) => {
      if (m.t === "skip") skips.push({ at: performance.now(), ms: (m.frames / sr) * 1000 });
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
    return { ctx, tr, air, skips, got: [] };
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
  const res = {
    ready,
    skipsBefore: [host, guest].map((p) => p.skips.filter((k) => k.at < before).length),
    hostSkips: host.skips.length,
    guestSkips: guest.skips.filter((k) => k.at >= before).map((k) => Math.round(k.ms * 10) / 10),
    suspendedMs: Math.round(back - before),
    gaps: guest.tr.takeGaps().map((g) => Math.round(g.ms * 10) / 10),
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

/** Check a real-time run. */
function checkRealtime(label, r) {
  const say = (msg) => fail(`${label}: ${msg}`);
  console.log(
    `${label}: suspended ${r.suspendedMs} ms (from the suspend() call to resume() settling), skipped ${r.guestSkips.join(", ") || "nothing"}; the host heard the guest ${r.hostHears} ms after, the guest the host ${r.guestHears} ms after`
  );
  if (r.ready[0] < 4 || r.ready[1] < 4) return say(`they never heard each other (${r.ready})`);
  if (r.errors.length) say(`worklet errors: ${r.errors.join("; ")}`);
  if (r.skipsBefore.some((n) => n !== 0) || r.hostSkips !== 0) say(`a skip while running: ${r.skipsBefore}, the host ${r.hostSkips}`);
  if (r.guestSkips.length !== 1 || Math.abs(r.guestSkips[0] - r.suspendedMs) > 60) say(`the guest skipped ${JSON.stringify(r.guestSkips)}`);
  // (the modem reports a skip as a capture gap of its length)
  if (r.gaps.length !== 2 || r.gaps[0] !== 0 || Math.abs(r.gaps[1] - r.guestSkips[0]) > 0.1) say(`the guest's gaps were ${JSON.stringify(r.gaps)}`);
  if (r.hostHears === null || r.hostHears > 1000) say(`the host heard the guest ${r.hostHears} ms after it came back`);
  if (r.guestHears === null || r.guestHears > 3000) say(`the guest heard the host ${r.guestHears} ms after it came back`);
  if (!r.locked[0] || !r.locked[1]) say(`not locked at the end: ${r.locked}`);
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
    const tab = await browser.newPage();
    tab.setDefaultTimeout(120_000);
    const errors = [];
    tab.on("pageerror", (e) => errors.push(String(e)));
    tab.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await tab.goto(prod.url + "/smoke.html");
    await tab.waitForFunction(() => window.__link?.WorkletTransport);
    for (const ms of [700, 1500]) {
      const r = await tab.evaluate(realtime, { ms });
      r.errors.push(...errors.splice(0));
      checkRealtime(`real time, the guest suspended ${ms} ms`, r);
    }
    await tab.close();
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
console.log("WORKLET SMOKE OK");
