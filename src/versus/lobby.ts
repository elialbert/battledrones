/**
 * The sound duel's lobby (SOUND-DUEL.md "The lobby", "Getting into a duel",
 * "Rematch", "Dev and test modes"): the sheet between the menu's Duel tap and
 * the match. It places the phones, takes Host or Join, shows the link both
 * ways while the two phones pair, offers the opener cards, and once both said
 * GO and the microphone has had its 1.5 s of gap-free capture, builds the
 * VersusFeed and hands it to main.ts's start(). The lazily loaded duel chunk
 * starts here: main.ts reaches src/versus and src/link only through
 * `import("./versus/lobby")`.
 *
 *   the Duel tap (main.ts, synchronously):  const t = duel.tapPlan(); sfx.unlock()
 *     const rig = t.practice ? null : duel.openRig({ micMode: t.micMode })
 *     t.practice || sfx.setLinkGuard("high"); music.stop()
 *     duel.showLobby({ host: menu, rig, shownMap, mutators, start, onClose })
 *   the rematch's reconnect tap: the same with tapPlan(true), then duel.reconnect({ … })
 *
 * The lobby's logic is LobbyMachine in lobby-machine.ts (no DOM: a clock,
 * a link factory and the rig come in through LobbyEnv, so tests drive it
 * over PacketAir); the sheet renders its state() every frame and sends it
 * the taps.
 *
 * Online duels (every build; relay/README.md): main.ts's "Duel a friend
 * online" opens the lobby as host, which makes a room code and shows its
 * invite link (`#vs=<code>`: a QR code, Share and Copy) while it waits; the link's
 * "Join the battle" opens it as guest in that room. Each pairs at once in
 * its seat over a NetTransport (net-transport.ts), as a relay seat does,
 * with no rig, no guard and no sound copy; its rematch meets in the same
 * room (the stored rematch's `room`). It keeps the win/loss record, keeps
 * the screen awake itself (keepScreenOn: there is no rig to).
 *
 * Practice links (every build): `?duel=loop` pairs with an in-page friend
 * over PacketAir (loop-peer.ts), `?duel=relay&seat=host|guest` through the
 * page functions __duelOut / __duelIn (relay-transport.ts). Neither opens the
 * rig or the guard, and both expose window.__duel = { state, tick, delay,
 * trail(), trails(from), hash(), result } for test harnesses (delay and
 * trails beyond the spec: the smoke's checks follow D, and compare the trail
 * at every tick).
 *
 * Where the spec is silent:
 *  - the lobby keeps its own settings (localStorage battledrones.duelprefs):
 *    the host's band plan and the mic mode. The Duel tap needs the mic mode
 *    before the sheet exists (openRig comes first), so tapPlan() reads it;
 *  - Advanced is offered before Host or Join only, and Back (before GO)
 *    returns there: the route check's advice ("switch the host to band Low")
 *    is one Back away. A rematch keeps its band and has no Advanced, so its
 *    route warning leaves that advice out, as it does where this phone hosts
 *    on band Low already. Self-test is a host session whose receiver listens
 *    to its own band; it is not offered on practice links;
 *  - a Join's link starts in the high plan's guest band (rx "detect"), or the
 *    low plan's when the context's rate can't carry the high one; the guard
 *    follows the plan the link locks on. A host's guard follows its plan;
 *  - the route check counts ownSnrDb below 10 dB for 3 s, where no reading
 *    (the self-monitor hasn't locked) counts from one superframe (2.05 s)
 *    after the link started, the time it needs to hear its own first sync.
 *    Practice links have no own signal and skip it;
 *  - loud own signal: it is this phone's own signal that matters, so a stats
 *    report counts as loud only when its microphone peak is above −6 dBFS
 *    while the self-monitor hears the own signal (ownSnrDb ≥ 10 dB, where the
 *    route check says it does), and only an unbroken run of them for 2 s acts
 *    (a clap, a knock or a word is over by then). Not "heard well": an own
 *    signal that clips the microphone reads lower the harder it clips (own
 *    output looped back and hard-clipped at ±1: 34–42 dB at 2× full scale,
 *    21–24 dB at 3×, 15–18 dB at 4×, 11–16 dB at 5–6×), while a loud sound
 *    of another kind either leaves it as it was or buries it (a full-scale
 *    burst read −4 to 6 dB, steady noise 0 dB) and doesn't last 2 s in a row
 *    above 10. (Past about 8× the clipped own signal dips under 10 dB, 6–10
 *    at 15–40×: there neither rule acts for sure, and the route check may
 *    speak instead.) Then the transmit gain drops by 3 dB, at most once a
 *    second, down to 0.5 (−6 dB: what brings a peak just over −6 dBFS well
 *    under it, while the friend still hears this phone within 6 dB of its
 *    usual).
 *    Once 5 s pass with no loud report it climbs back by 1 dB every 2 s to
 *    the gain the lobby chose, 1 (the modem is offered up to 1.1). The note
 *    shows while the gain is below 1, never with the route warning, which
 *    says the opposite. The gain the lobby leaves at GO goes into the match;
 *  - "nothing heard": the pairing's own 8 s hint offers the one-tap role
 *    switch (not in a rematch or on a relay seat: roles are fixed there);
 *    after 30 s since the role was tapped with still nothing of the other
 *    role heard, tips;
 *  - a rematch pairs at once in its stored role and plan (the guest receives
 *    the stored plan's host band, no detection) and falls back to the menu
 *    (onClose("fallback")) after 60 s from the tap with nothing heard;
 *  - Cancel, Back and a closed error say the end to a friend that may have
 *    started (Session.leave), keep the link on until the session is
 *    closable, then close the rig, turn the guard off and call onClose
 *    (main.ts resumes the menu music). A RigError releases the audio at once
 *    and leaves its message up until it is closed;
 *  - a friend that left once this phone said GO ("Your friend left",
 *    status().peerEnded: it started on this phone's GO, which this phone
 *    never heard it answer, or this phone waits for its capture) stops the
 *    lobby there: no match is loaded;
 *  - a friend heard and then silent for 8 s (QUIET_MS) gets a line under the
 *    status ("Your friend's phone has gone quiet"), from pairing to GO: the
 *    pairing has no timeout of its own after GO, and a friend that went Back
 *    before it heard this phone's pick has nothing to say. Its next tap of
 *    Host or Join finds this phone again (the pairing lets the friend's next
 *    incarnation take over), so the lobby waits on; Cancel is the way out;
 *  - the meter shows only what is current: this phone's SNR of the friend
 *    while packets arrive (RX_SILENT_MS, as the session's rxq), and the
 *    friend's rxq of this phone while its frames do (PEER_HEARD_MS);
 *  - a retry ("Pairing failed: tap to retry") starts the tips' 30 s and a
 *    rematch's 60 s again, as the pairing starts its 8 s hint again;
 *  - the tips leave band Low (Advanced) out of a rematch, which keeps its
 *    band and has no Advanced, and on a practice link speak of the page and
 *    the relay instead of the volume, the silent switch and Bluetooth;
 *  - on the loop the meter's round trip would be the friend's hold, which
 *    forces &delay (seconds, at a long one): its line names the input delay
 *    the pairing agreed instead. The relay's round trip is the relay's own;
 *  - the opener cards say what each opener gives, as the single-player
 *    picker's pills do, from the same data (openerGives);
 *  - the guard is put on this machine's plan whenever a link starts, not
 *    trusted to be as the tap left it (main.ts takes no Duel or Rematch tap
 *    while a lobby is open or still saying the end, so two lobbies never
 *    share it);
 *  - a version error names the older phone when the protocols differ;
 *  - the page going away while the lobby holds the rig (its Reload, the
 *    player's own reload, a navigation) closes the rig at once, with no end
 *    said (closeRigOnPageGone): the rig puts iOS's audio session back to
 *    "auto", which Safari would otherwise keep as play-and-record for the
 *    next page in the tab. From the match on, VersusFeed's pagehide does it;
 *  - window.__duel.state is the lobby's step (LobbyStep) until the feed is
 *    built, then the session's phase; result is null until the match begins,
 *    then the lockstep's end, decision and end check;
 *  - the modem's errors (the link's onError) are all logged. One after which
 *    the modem no longer reports (it stopped, or never started: its stats go
 *    stale at once) ends the lobby as a RigError does, "The sound link
 *    stopped working" over the modem's own words, the audio let go at once:
 *    Close and a new Duel tap build a new modem. Without this the route
 *    check would read the silent modem as a phone that can't hear itself,
 *    and give the wrong advice. A message the modem refused (it runs on) is
 *    only logged, as is anything from a link the lobby let go or, once the
 *    match began, from the match's: there the rig, which hears a stopped
 *    modem after the lobby has (RigLink.onStopped), takes it as a lost link,
 *    and the match's reconnect cover rebuilds the modem.
 */
import "./lobby.css";
import qrcode from "qrcode-generator";
import { sfx } from "../game/audio";
import { gameMode } from "../game/mode";
import { RIG_ADVICE, RigError, type MicMode, type Rig } from "../link/rig";
import type { BandRole } from "../link/transport";
import { BUILDINGS, UNITS } from "../sim/balance";
import { worldHash } from "../sim/checksum";
import { mapById } from "../sim/maps";
import { OPENERS, type OpenerId } from "../sim/openers";
import { MUTATORS, type MutatorId } from "../sim/rules";
import type { Faction, UnitKind } from "../sim/types";
import { fullscreen } from "../ui/fullscreen";
import { VersusFeed } from "./feed";
import { LobbyMachine, type LobbyEnd, type LobbyEnv, type LobbyPrefs, type LobbyView, type OnlineRoom, type PracticeMode } from "./lobby-machine";
import { LoopLink, type LoopParams } from "./loop-peer";
import { NOTHING_HEARD_MESSAGE } from "./pairing";
import { NetTransport, inviteUrl, roomCode } from "./net-transport";
import { DUEL_KEY, parseRematch, type RematchPlan } from "./records";
import { RelayTransport } from "./relay-transport";

export { openRig } from "../link/rig";

declare const __DUEL_HASH__: string | undefined;

// ------------------------------------------------------------ settings ---

/** The duel build hash's first 16 bits (SOUND-DUEL.md "Build check"); 0 where the build defines none (tests). */
export const duelBuild = (): number => (typeof __DUEL_HASH__ === "string" ? parseInt(__DUEL_HASH__.slice(0, 4), 16) || 0 : 0);

export interface DuelParams {
  /** "sound": the real thing (no ?duel, or another value). */
  mode: "sound" | PracticeMode;
  /** ?duel=relay&seat=: the role this page pairs in at once (null: Host / Join as usual). */
  seat: BandRole | null;
  /** ?duel=loop's link: &delay (3–8, rounded), &loss (0–0.9), &latency (0–2000 ms). */
  loop: LoopParams;
  /** &side=red: the side a practice page plays when it hosts (the loop's friend hosts with the other). */
  side: Faction;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** The dev modes' URL parameters, clamped (SOUND-DUEL.md "Dev and test modes"). */
export function parseDuelParams(search: string): DuelParams {
  const q = new URLSearchParams(search);
  const d = q.get("duel");
  const mode = d === "loop" || d === "relay" ? d : "sound";
  const num = (k: string): number | null => {
    const v = q.get(k);
    if (v === null || v.trim() === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const delay = num("delay");
  const loss = num("loss");
  const latency = num("latency");
  const seat = q.get("seat");
  return {
    mode,
    seat: mode === "relay" && (seat === "host" || seat === "guest") ? seat : null,
    loop: {
      delay: delay === null ? null : clamp(Math.round(delay), 3, 8),
      loss: loss === null ? 0 : clamp(loss, 0, 0.9),
      latencyMs: latency === null ? 250 : clamp(latency, 0, 2000)
    },
    side: q.get("side") === "red" ? "red" : "blue"
  };
}

const PREFS_KEY = "battledrones.duelprefs";

export function parsePrefs(raw: string | null): LobbyPrefs {
  const p: LobbyPrefs = { plan: "high", micMode: "raw" };
  try {
    const o = raw ? (JSON.parse(raw) as Partial<Record<keyof LobbyPrefs, unknown>> | null) : null;
    if (o?.plan === "low") p.plan = "low";
    if (o?.micMode === "ec") p.micMode = "ec";
  } catch {
    /* corrupt: defaults */
  }
  return p;
}

function loadPrefs(): LobbyPrefs {
  try {
    return parsePrefs(localStorage.getItem(PREFS_KEY));
  } catch {
    return parsePrefs(null);
  }
}

function savePrefs(p: LobbyPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

/**
 * The rematch's storage (SOUND-DUEL.md "Rematch"): sessionStorage REMATCH_KEY
 * = REMATCH_DUEL makes the next boot a duel rematch (main.ts takes it, its
 * literals tied to these by type), and DUEL_KEY holds the rematch, written
 * by records.ts writeRematch and read here with its parseRematch.
 */
export { DUEL_KEY, REMATCH_DUEL, REMATCH_KEY, parseRematch } from "./records";

/** The stored rematch (`take`: and forget it, so a reload after it is a plain boot). */
function readRematch(take: boolean): RematchPlan | null {
  try {
    const r = parseRematch(sessionStorage.getItem(DUEL_KEY));
    if (take) sessionStorage.removeItem(DUEL_KEY);
    return r;
  } catch {
    return null;
  }
}

/** What the Duel tap needs before the lobby exists. */
export interface DuelTap {
  /** The microphone mode to open the rig with: the lobby's setting, or the rematch's. */
  micMode: MicMode;
  /** A practice link: no rig, no guard. */
  practice: PracticeMode | null;
  /** An online duel's rematch (its room code is stored): no rig, no guard either. */
  online: boolean;
}

/** For main.ts's Duel tap (`rematch`: the rematch's reconnect tap). */
export function tapPlan(rematch = false): DuelTap {
  const p = parseDuelParams(location.search);
  const stored = rematch ? readRematch(false) : null;
  const micMode = stored?.micMode ?? loadPrefs().micMode;
  return { micMode, practice: p.mode === "sound" ? null : p.mode, online: !!stored?.room };
}

/** Uniform in [0, 1) from the platform's CSPRNG: the pairing's nonces. */
export const cryptoRandom = (): number => crypto.getRandomValues(new Uint32Array(1))[0]! / 4294967296;

// ------------------------------------------------------------ the sheet ---

export interface LobbyOptions {
  /** Where the sheet goes (the menu). */
  host: HTMLElement;
  /** The rig the Duel tap opened; null on a practice link. */
  rig: Rig | null;
  /** The menu's shownMap() and activeMutators() at the tap: what a host offers. */
  shownMap: string;
  mutators: MutatorId[];
  /** main.ts: begin(false, () => duelSetup(feed.config), feed). */
  start: (feed: VersusFeed) => void;
  /** The duel's audio was let go with no match (Cancel, an error, the rematch's fallback): the menu's music comes back. */
  onClose: (why: LobbyEnd) => void;
  /**
   * An online duel through the relay (rig null): the host's (a new room code
   * is made here) or the guest's, who came by the invite link with `code`.
   * A rematch of one needs none: the stored rematch has the room.
   */
  online?: { seat: "host" } | { seat: "guest"; code: string } | null;
}

/**
 * Until the match takes the rig over (VersusFeed has its own pagehide) or the
 * lobby lets it go: the page going away, not into the back-forward cache,
 * closes the rig, putting iOS's audio session back to "auto" (the
 * microphone and the context would go with the page anyway; the session
 * type would not). Returns the listener's removal.
 */
export function closeRigOnPageGone(win: Pick<Window, "addEventListener" | "removeEventListener">, rig: Pick<Rig, "close">): () => void {
  const gone = (e: Event) => {
    if (!(e as PageTransitionEvent).persisted) rig.close();
  };
  win.addEventListener("pagehide", gone);
  return () => win.removeEventListener("pagehide", gone);
}

/** The lobby, after the Duel tap. */
export function showLobby(o: LobbyOptions): void {
  run(o, null);
}

/** The rematch's "Tap to reconnect": the lobby, pairing at once with the stored role and plan. */
export function reconnect(o: LobbyOptions): void {
  run(o, readRematch(true));
}

/** The relay and online smokes' window into the duel (practice links and online duels only). */
export interface DuelProbe {
  readonly state: string;
  readonly tick: number;
  /** The input delay D the pairing agreed (null before the match). */
  readonly delay: number | null;
  trail(): number | null;
  /** The hash trail after every tick stepped from `from` on: [tick, trail] (VersusFeed.trails). */
  trails(from: number): [number, number][];
  hash(): string | null;
  readonly result: { end: string; winner: Faction | "draw" | null; resigned: Faction | null; tick: number | null; endCheck: string; desync: boolean } | null;
}

declare global {
  interface Window {
    __duel?: DuelProbe;
    __duelOut?: (base64: string, nbits: number) => void;
    __duelIn?: (base64: string, nbits: number) => void;
  }
}

class RelayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayError";
  }
}

const esc = (s: string): string => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);

/**
 * The 30 s tips: the sound's, with band Low (Advanced) only where Advanced
 * is offered (not in a rematch, which keeps its band); a practice link has
 * no sound to turn up, only the other page (the relay) or the page itself.
 */
export function tipsText(v: Pick<LobbyView, "practice" | "rematch"> & Partial<Pick<LobbyView, "online" | "role">>): string {
  if (v.online)
    return v.rematch
      ? "Still nothing? Your friend may have gone back to the menu: tap Cancel and send a new link."
      : v.role === "host"
        ? "Still nothing? Check that your friend got the link and opened it. Leave this page open meanwhile."
        : "Still nothing? Ask your friend to keep the game open on their screen, or to send a new link.";
  if (v.practice === "loop") return "Still nothing? Reload the page and tap Duel again.";
  if (v.practice === "relay") return "Still nothing? Check that the other page is in the lobby and the relay connects the two.";
  const sound = "Still nothing? Turn the volume up and the silent switch off. Unplug headphones and turn Bluetooth off. Keep the phones 10–30 cm apart.";
  return v.rematch ? sound : `${sound} Or try band Low on the host (Advanced).`;
}
/**
 * The route warning. Band Low is advice only where it can be taken: not in a
 * rematch (it keeps its band, and has no Advanced), and not where this phone
 * hosts on band Low already.
 */
export function routeText(v: Pick<LobbyView, "rematch" | "role" | "prefs">): string {
  const head = "This phone can't hear its own signal: sound may be going to the earpiece or Bluetooth, or it can't play this band.";
  return v.rematch || (v.role === "host" && v.prefs.plan === "low")
    ? `${head} Unplug headphones or turn the volume up.`
    : `${head} Unplug headphones, turn the volume up, or switch the host to band Low.`;
}
const QUIET_TEXT = "Your friend's phone has gone quiet. Bring the phones closer, or tap Cancel if your friend left.";
const QUIET_ONLINE = "Your friend's connection has gone quiet. Wait a moment, or tap Cancel if your friend left.";
const PLACEMENT =
  "Lay both phones flat, 10–30 cm apart. Turn the volume to about 75%, silent switch off. On an iPhone the sound may come from the earpiece at the top: turn the phones until both bars below are full.";

/** Above every step of a sound link (not a practice link, which plays none), before any of it is heard. */
const NOISE_WARNING =
  "⚠️ <b>Warning: unpleasant noise.</b> The sound link plays a constant high-pitched noise for the whole match. Many people find it unpleasant, and it may even cause headaches. Stop if it bothers you.";

const iconUrl = (kind: string, side: Faction): string => `assets/icons/${side === "red" ? "red/" : ""}${kind}.webp`;

/** The map as the paired view names it: a built-in map's name, a generated one's name and code. */
function mapLine(mapId: string, mutators: readonly MutatorId[]): string {
  const def = mapById(mapId);
  const name = def.random ? `${esc(def.name)} <span class="duel-code">#${esc(def.random.code)}</span>` : esc(def.name);
  const muts = mutators.length
    ? mutators.map((id) => `<span class="duel-mut" title="${esc(MUTATORS[id].desc)}">${MUTATORS[id].icon} ${esc(MUTATORS[id].name)}</span>`).join("")
    : `<span class="duel-mut none">No mutators</span>`;
  return `<p class="duel-map"><b>🗺 ${name}</b></p><p class="duel-muts">${muts}</p>`;
}

/**
 * What an opener gives, as the single-player picker's pills say it
 * (src/ui/openers.ts), from the same data (OPENERS, and the building and unit
 * names): "Fab Plant · 3 Stingers · 2 Harvesters · −100 scrap".
 */
export function openerGives(id: OpenerId): string {
  const o = OPENERS[id];
  const parts = [BUILDINGS[o.building].name];
  const counts = new Map<UnitKind, number>();
  for (const k of o.units) counts.set(k, (counts.get(k) ?? 0) + 1);
  for (const [k, n] of counts) parts.push(`${n} ${UNITS[k].name}s`);
  parts.push(`${o.harvesters} Harvesters`);
  if (o.scrap > 0) parts.push(`+${o.scrap} scrap`);
  if (o.scrap < 0) parts.push(`−${-o.scrap} scrap`);
  return parts.join(" · ");
}

function openerCard(id: OpenerId, side: Faction, picked: boolean): string {
  const o = OPENERS[id];
  const unit = o.units[0] ?? "harvester";
  const n = o.units.length || o.harvesters;
  return `<button class="op-card op-${id}${picked ? " picked" : ""}" data-act="pick" data-id="${id}">
      <div class="op-art"><img class="op-b" src="${iconUrl(o.building, side)}" alt="" draggable="false"/><img class="op-u" src="${iconUrl(unit, side)}" alt="" draggable="false"/><span class="op-n">×${n}</span></div>
      <div class="op-text"><b class="op-name">${esc(o.name)}</b><span class="op-tag">${esc(o.tagline)}</span><span class="op-gives">${openerGives(id)
        .split(" · ")
        .map((part) => `<span>${esc(part)}</span>`)
        .join(" · ")}</span></div>
    </button>`;
}

const bar = (q: number | null): string => {
  const cls = q === null ? "" : q >= 5 ? "good" : q >= 2 ? "fair" : "poor";
  return `<span class="dm-bar ${cls}"><i style="width:${q === null ? 0 : Math.round((q / 7) * 100)}%"></i></span>`;
};

function meterHtml(v: LobbyView): string {
  const m = v.meter;
  if (!m) return "";
  // (online the bars would say nothing: the relay delivers or it doesn't)
  if (v.online) return `<div class="duel-meter"><p class="dm-rtt" data-m="rtt"></p></div>`;
  if (v.step === "self-test")
    return `<div class="duel-meter"><div class="dm-row"><span class="dm-l">This phone hears itself</span>${bar(m.rxq)}<span class="dm-v" data-m="rx"></span></div></div>`;
  return `<div class="duel-meter">
      <div class="dm-row"><span class="dm-l">You hear your friend</span>${bar(m.rxq)}<span class="dm-v" data-m="rx"></span></div>
      <div class="dm-row"><span class="dm-l">Your friend hears you</span>${bar(m.peerRxq)}<span class="dm-v" data-m="tx"></span></div>
      <p class="dm-rtt" data-m="rtt"></p>
    </div>`;
}

/**
 * The meter's last line: the round trip, except on the loop, whose friend
 * holds the lobby's packets to force &delay (loop-peer.ts), so its round trip
 * can read seconds and says nothing of the match: it names the input delay
 * the pairing agreed instead.
 */
export function rttLine(v: Pick<LobbyView, "practice" | "pairing" | "meter">): string {
  if (v.practice === "loop") {
    const d = v.pairing?.config?.delay;
    return d === undefined ? "Practice link" : `Practice link · input delay ${d * 100} ms`;
  }
  const rtt = v.meter?.rttMs ?? null;
  return rtt === null ? "Round trip: measuring…" : `Round trip ${Math.round(rtt)} ms`;
}

/** The meter's numbers and bars, every frame. */
function fillMeter(root: HTMLElement, v: LobbyView): void {
  const m = v.meter;
  if (!m) return;
  const set = (k: string, text: string) => {
    const el = root.querySelector<HTMLElement>(`[data-m="${k}"]`);
    if (el && el.textContent !== text) el.textContent = text;
  };
  set("rx", `${m.snrDb === null ? "–" : `${Math.round(m.snrDb)} dB`} · ${m.good} good`);
  set("tx", m.peerRxq === null ? "–" : `${m.peerRxq * 3}+ dB`);
  set("rtt", rttLine(v));
  const bars = root.querySelectorAll<HTMLElement>(".dm-bar");
  const qs = v.step === "self-test" ? [m.rxq] : [m.rxq, m.peerRxq];
  bars.forEach((b, i) => {
    const q = qs[i] ?? null;
    const w = `${q === null ? 0 : Math.round((q / 7) * 100)}%`;
    const fill = b.querySelector<HTMLElement>("i");
    if (fill && fill.style.width !== w) fill.style.width = w;
    b.classList.toggle("good", q !== null && q >= 5);
    b.classList.toggle("fair", q !== null && q >= 2 && q < 5);
    b.classList.toggle("poor", q !== null && q < 2);
  });
}

/** What the sheet shows for a state: rebuilt only when this changes. */
function layoutKey(v: LobbyView): string {
  const p = v.pairing;
  return [
    v.step, v.role, v.error?.kind, v.lost, v.switchRole, v.tips, v.quiet, v.route, v.loud, v.canBack, v.prefs.plan, v.prefs.micMode,
    p?.phase, p?.pick, p?.picked, p?.offered.join(","), p?.config?.mapId, p?.side
  ].join("|");
}

function bodyHtml(v: LobbyView, advOpen: boolean): { body: string; actions: string } {
  const cancel = `<button class="cta alt" data-act="cancel">Cancel</button>`;
  const back = v.canBack ? `<button class="cta alt" data-act="back">Back</button>` : "";
  const notes: string[] = [];
  if (v.noWakeLock && (v.step === "choose" || v.step === "pairing")) notes.push(`<p class="sh-note">Set Auto-Lock to Never: this phone can't keep its screen on by itself.</p>`);
  if (v.lost && v.step !== "error")
    notes.push(`<div class="duel-warn"><p>The sound link stopped.</p><button class="cta" data-act="tap">Tap to reconnect the sound link</button></div>`);
  if (v.route) notes.push(`<p class="duel-warn">${routeText(v)}</p>`);
  if (v.loud) notes.push(`<p class="sh-note">Your own signal is loud here: this phone now sends a little quieter.</p>`);
  const quiet = v.quiet ? `<p class="duel-hint">${v.online ? QUIET_ONLINE : QUIET_TEXT}</p>` : "";
  const p = v.pairing;
  if (v.online && (v.step === "connecting" || v.step === "pairing")) return onlinePairingHtml(v, quiet, notes, back + cancel);
  switch (v.step) {
    case "opening":
      return { body: `<p class="duel-status">Starting the microphone… Allow it if asked.</p>`, actions: cancel };
    case "tap-to-start":
      return { body: `<button class="cta big duel-tap" data-act="tap">Tap to start sound</button>`, actions: cancel };
    case "choose": {
      const plan = v.prefs.plan;
      const mic = v.prefs.micMode;
      const adv = `<details class="duel-adv"${advOpen ? " open" : ""}><summary>Advanced</summary>
          <p class="duel-lbl">Band <small>(host only)</small></p>
          <div class="seg"><button data-act="plan" data-v="high" class="${plan === "high" ? "on" : ""}">High · quiet</button><button data-act="plan" data-v="low" class="${plan === "low" ? "on" : ""}">Low · audible</button></div>
          ${v.practice ? "" : `<p class="duel-lbl">Microphone</p>
          <div class="seg"><button data-act="mic" data-v="raw" class="${mic === "raw" ? "on" : ""}">Raw</button><button data-act="mic" data-v="ec" class="${mic === "ec" ? "on" : ""}">Echo cancel</button></div>
          <button class="cta alt" data-act="selftest">Self-test: this phone hears itself</button>`}
        </details>`;
      return {
        body: `<p class="sh-sub duel-place">${PLACEMENT}</p>
          <div class="duel-roles">
            <button class="duel-role" data-act="host"><b>📡 Host</b><small>Your map and mutators</small></button>
            <button class="duel-role" data-act="join"><b>📲 Join</b><small>Your friend hosts</small></button>
          </div>
          ${notes.join("")}${adv}`,
        actions: cancel
      };
    }
    case "connecting":
      return { body: `<p class="duel-status">Starting the sound link…</p>`, actions: cancel };
    case "self-test":
      return {
        body: `<p class="duel-status">Self-test: this phone listens to its own signal. Good packets mean the whole link works here.</p>${meterHtml(v)}${notes.join("")}`,
        actions: back + cancel
      };
    case "pairing": {
      const heard = p?.phase === "linking";
      const status = heard
        ? "Your friend's phone is there. Linking…"
        : v.rematch
          ? "Waiting for your friend to tap Rematch…"
          : v.role === "host"
            ? "Hosting. Waiting for your friend to tap Join…"
            : "Listening for your friend's phone (the host)…";
      const hint = v.switchRole
        ? `<div class="duel-hint"><p>${NOTHING_HEARD_MESSAGE}.</p><button class="cta alt" data-act="switch">Switch to ${v.role === "host" ? "Join" : "Host"}</button></div>`
        : "";
      const tips = v.tips ? `<p class="duel-hint">${tipsText(v)}</p>` : "";
      return {
        body: `<p class="sh-sub duel-place">${PLACEMENT}</p><p class="duel-status">${status}</p>${quiet}${meterHtml(v)}${hint}${tips}${notes.join("")}`,
        actions: back + cancel
      };
    }
    case "picking":
    case "waiting": {
      const side = p?.side ?? "blue";
      const offered = p?.offered ?? [];
      const picked = v.step === "waiting";
      const cards = offered.length
        ? `<div class="duel-cards${picked ? " chosen" : ""}">${offered.map((id) => openerCard(id, side, picked && p?.pick === id)).join("")}</div>`
        : `<p class="duel-status">No opener is allowed under these rules.</p>`;
      const head = picked ? `<p class="duel-status">Waiting for your friend to pick…</p>` : `<h3>Pick your opener <small data-m="pickleft"></small></h3>`;
      return {
        body: `<p class="duel-paired">✓ Paired · you play <b class="duel-side ${side}">${side}</b></p>${p?.config ? mapLine(p.config.mapId, p.config.mutators) : ""}${head}${quiet}${cards}${meterHtml(v)}${notes.join("")}`,
        actions: back + cancel
      };
    }
    case "go":
      return { body: `<p class="duel-go">GO!</p><p class="duel-status">Waiting for your friend…</p>${quiet}${meterHtml(v)}${notes.join("")}`, actions: cancel };
    case "loading":
      return { body: `<p class="duel-go">GO!</p><p class="duel-status">Starting the match…</p>${meterHtml(v)}${notes.join("")}`, actions: cancel };
    case "error":
      return errorHtml(v);
    default:
      return { body: "", actions: "" };
  }
}

/**
 * Online, before the opener cards: the host's invite link (Share where the
 * browser has a share sheet, and Copy), the guest's "Joining…", and the
 * relay's round trip once the pairing measures it.
 */
function onlinePairingHtml(v: LobbyView, quiet: string, notes: string[], actions: string): { body: string; actions: string } {
  const room = v.online!;
  const heard = v.pairing?.phase === "linking";
  if (v.step === "connecting")
    return { body: `<p class="duel-status">Connecting to the relay…</p>`, actions: `<button class="cta alt" data-act="cancel">Cancel</button>` };
  const status = heard
    ? "Your friend is here. Linking…"
    : v.rematch
      ? "Waiting for your friend to tap Rematch…"
      : v.role === "host"
        ? "Waiting for your friend to open the link…"
        : "Joining your friend's battle…";
  const invite =
    v.role === "host" && !v.rematch && !heard
      ? `<p class="sh-sub">Your friend scans this with their phone's camera, or opens the link you send them. Keep this page open: the battle starts when they do.</p>
        <div class="duel-qr" aria-label="QR code of the invite link">${qrSvg(room.invite)}</div>
        <div class="duel-invite"><input class="duel-invite-url" readonly value="${esc(room.invite)}" aria-label="Invite link" /></div>
        <div class="duel-invite-acts">${canShare() ? `<button class="cta" data-act="share">📤 Share link</button>` : ""}<button class="cta${canShare() ? " alt" : ""}" data-act="copy">📋 Copy link</button></div>`
      : "";
  const tips = v.tips ? `<p class="duel-hint">${tipsText(v)}</p>` : "";
  return { body: `${invite}<p class="duel-status">${status}</p>${quiet}${meterHtml(v)}${tips}${notes.join("")}`, actions };
}

/** A QR code of `text`, as an SVG that scales to its box (the Wi-Fi duel's way: origin/webrtc-duel's wifi-sheet.ts). */
export function qrSvg(text: string): string {
  const qr = qrcode(0, "M");
  qr.addData(text, "Byte");
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
}

const canShare = (): boolean => typeof navigator !== "undefined" && typeof navigator.share === "function";

/** The share sheet with the invite (a dismissed sheet is no error). */
async function shareInvite(url: string, btn: HTMLElement): Promise<void> {
  try {
    await navigator.share({ title: "Battle Drones", text: "Duel me in Battle Drones!", url });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") return;
    await copyInvite(url, btn);
  }
}

/** The invite on the clipboard; the button says so for a moment. Where the clipboard is refused, the link is selected to copy by hand. */
async function copyInvite(url: string, btn: HTMLElement): Promise<void> {
  const label = btn.textContent;
  try {
    await navigator.clipboard.writeText(url);
    btn.textContent = "✓ Copied";
  } catch {
    const input = btn.closest(".duel-body")?.querySelector<HTMLInputElement>(".duel-invite-url");
    input?.focus();
    input?.select();
    btn.textContent = "Select and copy the link";
  }
  setTimeout(() => {
    if (btn.isConnected) btn.textContent = label;
  }, 2000);
}

/**
 * Online there is no rig to hold a screen wake lock: keep one while the duel
 * is on, asking again whenever the page comes back (the browser lets it go
 * while hidden). Returns its release. Quietly nothing where unsupported.
 */
export function keepScreenOn(
  doc: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">,
  nav: { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } }
): () => void {
  const wl = nav.wakeLock;
  if (!wl) return () => undefined;
  let lock: { release(): Promise<void> } | null = null;
  let done = false;
  const ask = () => {
    if (done || doc.visibilityState !== "visible") return;
    wl.request("screen").then(
      (l) => {
        if (done) void l.release().catch(() => undefined);
        else lock = l;
      },
      () => undefined
    );
  };
  doc.addEventListener("visibilitychange", ask);
  ask();
  return () => {
    if (done) return;
    done = true;
    doc.removeEventListener("visibilitychange", ask);
    void lock?.release().catch(() => undefined);
    lock = null;
  };
}

function errorHtml(v: LobbyView): { body: string; actions: string } {
  const e = v.error;
  const close = `<button class="cta alt" data-act="cancel">Close</button>`;
  if (!e) return { body: "", actions: close };
  const reload = `<button class="cta" data-act="reload">Reload</button>`;
  switch (e.kind) {
    case "failed":
      return { body: `<button class="cta big duel-tap" data-act="retry">${esc(e.message)}</button>`, actions: `<button class="cta alt" data-act="cancel">Cancel</button>` };
    case "version": {
      const who = e.older === "this" ? "This phone has the older version." : e.older === "friend" ? "Your friend's phone has the older version." : "";
      return { body: `<p class="duel-err">${esc(e.message)}</p>${who ? `<p class="sh-note">${who}</p>` : ""}`, actions: close + reload };
    }
    case "rig": {
      const advice = e.reason ? RIG_ADVICE[e.reason] ?? "" : "";
      return {
        body: `<p class="duel-err">${esc(e.message)}</p>${advice ? `<p class="sh-note">${advice}</p>` : ""}`,
        actions: e.reason === "update" ? close + reload : close
      };
    }
    case "relay":
      return { body: `<p class="duel-err">${esc(e.message)}</p><p class="sh-note">The page has no window.__duelOut: connect it with the relay harness.</p>`, actions: close };
    case "left":
      return { body: `<p class="duel-err">${esc(e.message)}.</p>`, actions: close };
    case "online":
      return { body: `<p class="duel-err">${esc(e.message)}.</p><p class="sh-note">Close, then start the online duel again.</p>`, actions: close };
    case "modem":
      return {
        body: `<p class="duel-err">The sound link stopped working.</p><p class="sh-note">Close, then tap Duel to start it again. (${esc(e.message)})</p>`,
        actions: close + reload
      };
    default:
      return { body: `<p class="duel-err">Something went wrong: ${esc(e.message)}</p>`, actions: close };
  }
}

/** The sheet: the machine, its env in the browser, the frame loop, the taps. */
function run(o: LobbyOptions, rematch: RematchPlan | null): void {
  const params = parseDuelParams(location.search);
  // an online duel: a new one (its seat from the tap, the host's code made now), or its rematch (the stored room)
  const code = rematch ? rematch.room ?? null : o.online ? (o.online.seat === "guest" ? o.online.code : roomCode()) : null;
  const online: OnlineRoom | null = code ? { code, invite: inviteUrl(location, code) } : null;
  const practice = online || params.mode === "sound" ? null : params.mode;
  const build = duelBuild();
  let loop: LoopLink | null = null;
  let relay: RelayTransport | null = null;
  let net: NetTransport | null = null;
  const offWake = online ? keepScreenOn(document, navigator) : () => undefined;
  let feed: VersusFeed | null = null;
  let machine: LobbyMachine | null = null;
  let timer = 0;
  let raf = 0;
  let stopped = false;

  o.host.querySelector(".duel-wrap")?.remove();
  const wrap = document.createElement("div");
  wrap.className = "sheet-wrap duel-wrap";
  wrap.innerHTML = `<div class="sheet duelsheet" role="dialog" aria-label="Duel a friend">
      <h2>${online ? "🌐" : "🔊"} ${rematch ? "Rematch" : online ? "Duel a friend online" : "Duel a friend"}</h2>
      ${
        online
          ? ""
          : practice
            ? `<p class="duel-practice">Practice link (no sound): ${practice === "loop" ? "an in-page friend" : "the relay"}</p>`
            : `<p class="duel-noise" role="note">${NOISE_WARNING}</p>`
      }
      <div class="duel-body"></div>
      <div class="sh-actions duel-actions"></div>
    </div>`;
  o.host.appendChild(wrap);
  const offPageGone = o.rig ? closeRigOnPageGone(window, o.rig) : () => undefined;
  const body = wrap.querySelector<HTMLElement>(".duel-body")!;
  const actions = wrap.querySelector<HTMLElement>(".duel-actions")!;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    cancelAnimationFrame(raf);
  };
  const closeSheet = () => {
    stop();
    wrap.remove();
  };
  const dropPractice = () => {
    loop?.close();
    relay?.close();
    net?.close();
    loop = null;
    relay = null;
    net = null;
  };

  const prefs = loadPrefs();
  const env: LobbyEnv = {
    now: () => performance.now(),
    build,
    random: cryptoRandom,
    rig: o.rig,
    practice,
    rematch,
    seat: online ? (o.online?.seat ?? null) : practice === "relay" ? params.seat : null,
    online,
    prefs,
    savePrefs,
    offer: { map: o.shownMap, mutators: o.mutators, hostSide: practice ? params.side : "blue" },
    link: async (cfg, offer) => {
      if (practice === "loop") {
        dropPractice();
        const friendOffer = rematch ? offer : { ...offer, hostSide: cfg.tx === "host" ? params.side : params.side === "blue" ? "red" : "blue" };
        loop = new LoopLink({ params: params.loop, role: cfg.tx, offer: friendOffer, build, seed: (cryptoRandom() * 4294967296) >>> 0 });
        return loop.page;
      }
      if (online) {
        dropPractice();
        const t = (net = new NetTransport({ code: online.code, role: cfg.tx }));
        await t.opened;
        return t;
      }
      if (practice === "relay") {
        dropPractice();
        const r = new RelayTransport({ role: cfg.tx, win: window });
        if (!r.connected()) {
          r.close();
          throw new RelayError("Relay not connected");
        }
        relay = r;
        return r;
      }
      if (!o.rig) throw new RigError("no-audio");
      return o.rig.createLink(cfg);
    },
    guard: (plan) => {
      if (practice || online) return;
      try {
        sfx.setLinkGuard(plan);
      } catch (e) {
        console.warn("link guard:", e);
      }
    },
    begin: (session) => {
      const onFrame = loop ? () => loop?.pump() : relay ? () => relay?.tick() : net ? () => net?.tick() : undefined;
      let exited = false;
      const f = new VersusFeed({
        session,
        rig: o.rig,
        practice: practice !== null,
        room: online?.code ?? null,
        onExit: () => {
          if (exited) return;
          exited = true;
          dropPractice();
          offWake();
          o.rig?.close();
          if (!practice && !online) sfx.setLinkGuard(null);
        },
        ...(onFrame ? { onFrame } : {})
      });
      feed = f;
      offPageGone();
      closeSheet();
      o.start(f);
      if (f.world.mapId !== gameMode.mapId) console.error(`sound duel: the feed's map ${f.world.mapId} isn't the game's ${gameMode.mapId}`);
    },
    released: (why) => {
      offPageGone();
      dropPractice();
      offWake();
      o.onClose(why);
    }
  };

  // (online too: tools/online-smoke.mjs reads it)
  if (practice || online) exposeProbe(() => machine, () => feed);
  const m = (machine = new LobbyMachine(env));

  let key = "";
  let advOpen = false;
  const render = () => {
    const v = m.state();
    if (v.step === "closed" || v.step === "started") return;
    const k = layoutKey(v);
    if (k !== key) {
      key = k;
      const html = bodyHtml(v, advOpen);
      body.innerHTML = html.body;
      actions.innerHTML = html.actions;
      body.querySelector<HTMLDetailsElement>(".duel-adv")?.addEventListener("toggle", (e) => (advOpen = (e.target as HTMLDetailsElement).open));
    }
    fillMeter(body, v);
    const left = body.querySelector<HTMLElement>(`[data-m="pickleft"]`);
    const ms = v.pairing?.pickLeftMs;
    if (left) left.textContent = ms === null || ms === undefined ? "" : `${Math.ceil(ms / 1000)} s`;
  };
  const frame = () => {
    if (stopped) return;
    loop?.pump();
    m.update();
    const v = m.state();
    if (m.done) {
      // (an error stays up until it's closed; otherwise the sheet goes)
      if (v.step === "error") render();
      else closeSheet();
      stop();
      return;
    }
    // (cancelled: the sheet is gone, and the link says the end until the session may close)
    if (v.step === "closed") return void wrap.remove();
    render();
  };
  const loopFrame = () => {
    frame();
    if (!stopped) raf = requestAnimationFrame(loopFrame);
  };
  raf = requestAnimationFrame(loopFrame);
  // (a hidden page gets no frames, and the link must go on)
  timer = window.setInterval(frame, 50);

  wrap.addEventListener("click", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (!el || !wrap.contains(el)) return;
    switch (el.dataset.act) {
      case "host":
        return m.host();
      case "join":
        return m.join();
      case "selftest":
        return m.startSelfTest();
      case "switch":
        return m.switchRole();
      case "back":
        return m.back();
      case "retry":
        return m.retry();
      case "tap":
        return m.tapToStart();
      case "plan":
        m.setPlan(el.dataset.v === "low" ? "low" : "high");
        return render();
      case "mic":
        m.setMicMode(el.dataset.v === "ec" ? "ec" : "raw");
        return render();
      case "pick":
        if (el.dataset.id && m.pick(el.dataset.id as OpenerId)) sfx.play("click", 0.5);
        return;
      case "reload":
        return fullscreen.reload();
      case "share":
        if (online) void shareInvite(online.invite, el);
        return;
      case "copy":
        if (online) void copyInvite(online.invite, el);
        return;
      case "cancel":
        m.cancel();
        // (the frame loop goes on until the session may close, if it must say the end first)
        if (m.done) closeSheet();
        else wrap.remove();
        return;
    }
  });
}

/** window.__duel for the relay and loop harnesses. */
function exposeProbe(machine: () => LobbyMachine | null, feed: () => VersusFeed | null): void {
  const probe: DuelProbe = {
    get state() {
      const f = feed();
      return f ? f.session.phase : machine()?.state().step ?? "opening";
    },
    get tick() {
      return feed()?.world.tick ?? -1;
    },
    get delay() {
      return feed()?.result.delay ?? null;
    },
    trail: () => feed()?.session.lockstep?.trail() ?? null,
    trails: (from) => feed()?.trails(from) ?? [],
    hash: () => {
      const f = feed();
      return f ? worldHash(f.world) : null;
    },
    get result() {
      const ls = feed()?.session.lockstep;
      if (!ls) return null;
      const st = ls.status();
      return {
        end: st.end,
        winner: st.decided?.winner ?? null,
        resigned: st.decided?.resigned ?? null,
        tick: st.decided?.tick ?? null,
        endCheck: st.endCheck,
        desync: st.desync
      };
    }
  };
  window.__duel = probe;
}
