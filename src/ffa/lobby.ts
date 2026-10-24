/**
 * The four-player online battle's lobby (FFA.md "Getting in"): the host's
 * sheet (a battle code, an invite link and QR code for each friend's seat,
 * who has joined, the opener picks, Start), and a friend's join screen for
 * an invite link (`#ffa=<code>-<seat>`): their name, Join, the lobby as the
 * host shows it, their own opener pick. When the battle starts, each page
 * hands its feed to `start` (main.ts begins the match with it). Loaded with
 * the four-player chunk.
 */
import qrcode from "qrcode-generator";
import { DIFFICULTY, type Difficulty, type StrategyName } from "../sim/ai/commander";
import { mapById } from "../sim/maps";
import { OPENERS, OPENER_IDS, type OpenerId } from "../sim/openers";
import { MUTATORS, type MutatorId } from "../sim/rules";
import { SIDE_CSS, SIDE_NAME } from "../game/side-style";
import { roomCode } from "../net/relay-socket";
import { FfaFeed, FFA_REMATCH_KEY, type FfaRematch } from "./feed";
import { FfaGuest } from "./guest";
import { FfaHost } from "./host";
import { SEATS, SEAT_SIDE, ffaInviteUrl, type SeatView } from "./protocol";
import "./lobby.css";

declare const __FFA_HASH__: string | undefined;
/** The build a friend's page must match (vite.config.ts): the sim and this code. */
export const ffaBuild = (): string => (typeof __FFA_HASH__ === "string" ? __FFA_HASH__.slice(0, 12) : "dev");

const NAME_KEY = "battledrones.name";
/** `?relay=ws://localhost:<port>`: a relay on this machine instead of the deployed one (tools/ffa-smoke.mjs). Nothing else. */
const relayUrl = (): string | undefined => {
  const u = new URLSearchParams(location.search).get("relay");
  return u && /^ws:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(u) ? u : undefined;
};

export { FFA_REMATCH_KEY };

export interface LobbyHooks {
  /** Where the sheet goes (the menu). */
  host: HTMLElement;
  /** The battle starts on this page: begin the match with its feed. */
  start(feed: FfaFeed): void;
  /** The lobby closed with no battle (Cancel, Menu, an error closed): the menu again. */
  onClose(): void;
}

export interface HostLobbyOptions extends LobbyHooks {
  map: string;
  mutators: MutatorId[];
  difficulty: Difficulty;
  /** A commander's personality for an open seat (the menu's rules decide which fit). */
  strategy(): StrategyName | undefined;
  /** A rematch: the same battle code, so the friends' links still lead here. */
  code?: string;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);

function loadName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* storage blocked */
  }
}

/** A QR code of `text`, as an SVG that scales to its box. */
function qrSvg(text: string): string {
  const qr = qrcode(0, "M");
  qr.addData(text, "Byte");
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
}

const canShare = (): boolean => typeof navigator.share === "function";

async function copyText(text: string, btn: HTMLElement): Promise<void> {
  const label = btn.textContent;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = "✓ Copied";
  } catch {
    btn.textContent = "Copy failed: use the QR";
  }
  setTimeout(() => {
    if (btn.isConnected) btn.textContent = label;
  }, 1800);
}

async function shareText(url: string, btn: HTMLElement): Promise<void> {
  try {
    await navigator.share({ title: "Battle Drones", text: "Join my four-player Battle Drones battle!", url });
  } catch (e) {
    if (!(e instanceof Error && e.name === "AbortError")) await copyText(url, btn);
  }
}

/** The sheet over the menu: one at a time. */
function openLobbySheet(host: HTMLElement): HTMLElement {
  host.querySelector(".ffa-wrap")?.remove();
  const wrap = document.createElement("div");
  wrap.className = "sheet-wrap ffa-wrap";
  wrap.innerHTML = `<div class="sheet ffa-sheet" role="dialog"></div>`;
  host.appendChild(wrap);
  return wrap.querySelector<HTMLElement>(".ffa-sheet")!;
}

const ruleLine = (map: string, mutators: readonly MutatorId[], difficulty: Difficulty): string => {
  const muts = mutators.map((id) => `${MUTATORS[id].icon} ${MUTATORS[id].name}`).join(" · ");
  return `${esc(mapById(map).name)} · AI seats: ${DIFFICULTY[difficulty].label}${muts ? ` · ${esc(muts)}` : ""}`;
};

const pickChips = (pick: OpenerId | null): string =>
  OPENER_IDS.map((id) => `<button data-pick="${id}" class="${pick === id ? "on" : ""}" aria-pressed="${pick === id}">${OPENERS[id].name}</button>`).join("");

/** One seat row: its colour, who sits there, their pick and link. */
function seatRow(v: SeatView, me: number, extra = ""): string {
  const side = `<b style="color:${SIDE_CSS[v.side]}">${SIDE_NAME[v.side]}</b>`;
  const who =
    v.kind === "open"
      ? `<span class="ffa-open">Open · an AI plays if nobody joins</span>`
      : `<span>${esc(v.name)}${v.seat === me ? " (you)" : v.kind === "host" ? " (host)" : ""}${
          v.kind === "friend" ? (v.online ? ` <em class="on">● here</em>` : ` <em class="off">● away</em>`) : ""
        }${v.pick ? ` · ${OPENERS[v.pick].name}` : ""}</span>`;
  return `<div class="ffa-seat ${v.side}" data-seat="${v.seat}"><i class="ffa-dot" style="background:${SIDE_CSS[v.side]}"></i><div class="ffa-who">${side}${who}</div>${extra}</div>`;
}

// ------------------------------------------------------------------ host ---

/** The host's lobby: make (or reuse) the battle code, open the three friend rooms, and wait for Start. */
export function showHostLobby(o: HostLobbyOptions): void {
  const code = o.code ?? roomCode();
  const host = new FfaHost({
    code,
    build: ffaBuild(),
    map: o.map,
    mutators: o.mutators,
    difficulty: o.difficulty,
    strategy: () => {
      const pool = DIFFICULTY[o.difficulty].pool;
      return o.strategy() ?? pool[Math.floor(Math.random() * pool.length)] ?? "balanced";
    },
    random: Math.random,
    ...(relayUrl() ? { url: relayUrl()! } : {})
  });
  const name = loadName();
  if (name) host.setName(name);
  const sheet = openLobbySheet(o.host);
  let qrSeat: number | null = null;
  let error: string | null = null;
  let done = false;
  const invite = (seat: number) => ffaInviteUrl(location, code, seat);

  const close = () => {
    if (done) return;
    done = true;
    clearInterval(timer);
    host.close("left");
    sheet.closest(".ffa-wrap")?.remove();
    o.onClose();
  };

  const seatsHtml = () =>
    host
      .views()
      .map((v) => {
        if (v.kind === "host") return seatRow(v, 0);
        const acts =
          v.kind === "open"
            ? `<div class="ffa-acts">${canShare() ? `<button class="cta" data-share="${v.seat}">📤</button>` : ""}<button class="cta alt" data-copy="${v.seat}">📋 Link</button><button class="cta alt${qrSeat === v.seat ? " on" : ""}" data-qr="${v.seat}">QR</button></div>`
            : "";
        const qr = qrSeat === v.seat && v.kind === "open" ? `<div class="ffa-qr" aria-label="QR code of ${SIDE_NAME[v.side]}'s invite link">${qrSvg(invite(v.seat))}</div>` : "";
        return seatRow(v, 0, acts) + qr;
      })
      .join("");

  const startLabel = () => {
    const friends = host.views().filter((v) => v.kind === "friend").length;
    const ais = SEATS - 1 - friends;
    return `▶ Start · ${friends} friend${friends === 1 ? "" : "s"}${ais ? `, ${ais} AI` : ""}`;
  };

  sheet.innerHTML = `
    <h2>🌐 Four-player battle</h2>
    <p class="sh-sub">${ruleLine(o.map, o.mutators, o.difficulty)}</p>
    <label class="ffa-name">Your name <input id="ffa-name" maxlength="16" autocomplete="nickname" value="${esc(name)}" placeholder="Host" /></label>
    <p class="ffa-lbl">Send each friend the link for a seat (or let them scan its QR code). Code <b>${code}</b></p>
    <div class="ffa-seats" id="ffa-seats"></div>
    <p class="ffa-lbl">Your opener</p>
    <div class="seg ffa-picks" id="ffa-picks"></div>
    <p class="sh-note">Seats nobody has joined when you start go to AI commanders. The battle runs on this page: keep it open and in front until it's over.</p>
    <p class="duel-err ffa-err" id="ffa-err" hidden></p>
    <div class="sh-actions"><button class="cta alt" id="ffa-cancel">Cancel</button><button class="cta" id="ffa-start">${startLabel()}</button></div>`;
  const seatsEl = sheet.querySelector<HTMLElement>("#ffa-seats")!;
  const picksEl = sheet.querySelector<HTMLElement>("#ffa-picks")!;
  const errEl = sheet.querySelector<HTMLElement>("#ffa-err")!;
  const startBtn = sheet.querySelector<HTMLButtonElement>("#ffa-start")!;
  let shown = "";
  const render = () => {
    if (done) return;
    const html = seatsHtml();
    if (html !== shown) {
      shown = html;
      seatsEl.innerHTML = html;
    }
    const picks = pickChips(host.pick);
    if (picksEl.innerHTML !== picks) picksEl.innerHTML = picks;
    startBtn.textContent = startLabel();
    errEl.hidden = !error;
    errEl.textContent = error ?? "";
  };
  host.onChange = render;
  host.onError = (seat, message) => {
    error = `${SIDE_NAME[SEAT_SIDE[seat]!]}'s seat: ${message}`;
    render();
  };
  // (who is "here" changes with time, not only with messages)
  const timer = setInterval(render, 1000);
  render();

  sheet.querySelector<HTMLInputElement>("#ffa-name")!.addEventListener("change", (e) => {
    const v = (e.target as HTMLInputElement).value.trim();
    saveName(v);
    host.setName(v);
  });
  picksEl.addEventListener("click", (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>("[data-pick]")?.dataset.pick as OpenerId | undefined;
    if (id) host.setPick(id);
  });
  seatsEl.addEventListener("click", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("button");
    if (!el) return;
    const seat = Number(el.dataset.share ?? el.dataset.copy ?? el.dataset.qr);
    if (el.dataset.share) void shareText(invite(seat), el);
    else if (el.dataset.copy) void copyText(invite(seat), el);
    else if (el.dataset.qr) {
      qrSeat = qrSeat === seat ? null : seat;
      render();
    }
  });
  sheet.querySelector("#ffa-cancel")!.addEventListener("click", close);
  startBtn.addEventListener("click", () => {
    if (done) return;
    done = true;
    clearInterval(timer);
    host.onChange = null;
    host.start();
    sheet.closest(".ffa-wrap")?.remove();
    o.start(new FfaFeed({ host, local: SEAT_SIDE[0]! }));
  });
}

// ------------------------------------------------------------------ guest ---

const GUEST_END: Record<string, string> = {
  left: "The host closed the battle.",
  desync: "The battle went out of sync.",
  version: "Your page and the host's run different versions: reload both pages, then try again.",
  started: "That battle started without this seat.",
  error: "The connection to the battle was lost."
};

/** A friend's join screen for an invite link: their name and Join, then the lobby as the host shows it. */
export function showJoin(o: LobbyHooks & { code: string; seat: number }): void {
  const sheet = openLobbySheet(o.host);
  const side = SEAT_SIDE[o.seat]!;
  let guest: FfaGuest | null = null;
  let done = false;
  let timer = 0;
  const finish = () => {
    done = true;
    clearInterval(timer);
    sheet.closest(".ffa-wrap")?.remove();
  };
  const close = () => {
    if (done) return;
    guest?.leave();
    guest?.close();
    finish();
    history.replaceState(history.state, "", location.pathname + location.search);
    o.onClose();
  };
  const you = `<b style="color:${SIDE_CSS[side]}">${SIDE_NAME[side]}</b>`;
  const name = loadName();
  sheet.innerHTML = `
    <h2>🌐 Four-player battle</h2>
    <p class="sh-sub">You're invited to play ${you}.</p>
    <div id="ffa-body">
      <label class="ffa-name">Your name <input id="ffa-name" maxlength="16" autocomplete="nickname" value="${esc(name)}" placeholder="${SIDE_NAME[side]}" /></label>
      <button class="cta big" id="ffa-join">⚔️ Join the battle</button>
    </div>
    <div class="sh-actions"><button class="cta alt" id="ffa-menu">Menu</button></div>`;
  const body = sheet.querySelector<HTMLElement>("#ffa-body")!;
  sheet.querySelector("#ffa-menu")!.addEventListener("click", close);

  /** The body as last drawn: redrawn only when it changes (a tap in progress keeps its button). */
  let shown = "";
  const draw = (html: string) => {
    if (html === shown) return;
    shown = html;
    body.innerHTML = html;
  };
  const render = () => {
    const g = guest;
    if (!g || done) return;
    if (g.phase === "ended") {
      draw(`<p class="duel-err">${esc(GUEST_END[g.ended?.why ?? "error"]!)}</p>${g.ended?.message ? `<p class="sh-note">${esc(g.ended.message)}</p>` : ""}`);
      sheet.querySelector("#ffa-menu")!.textContent = "Close";
      return;
    }
    if (g.phase === "joining") {
      draw(`<p class="duel-status">${
        g.hostFinishing ? "The host is still on the last battle's report: waiting for their Rematch…" : g.socket.state === "open" ? "Waiting for the host…" : "Connecting…"
      }</p>`);
      return;
    }
    const lobby = g.lobby!;
    const mine = lobby.seats.find((v) => v.seat === o.seat);
    draw(`
      <p class="ffa-lbl">${ruleLine(lobby.map, lobby.mutators, lobby.difficulty)}</p>
      <div class="ffa-seats">${lobby.seats.map((v) => seatRow(v, o.seat)).join("")}</div>
      <p class="ffa-lbl">Your opener</p>
      <div class="seg ffa-picks">${pickChips(mine?.pick ?? null)}</div>
      <p class="duel-status">Waiting for the host to start…</p>`);
  };
  body.addEventListener("click", (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>("[data-pick]")?.dataset.pick as OpenerId | undefined;
    if (id && guest) guest.setPick(id);
  });

  sheet.querySelector("#ffa-join")!.addEventListener("click", () => {
    const n = sheet.querySelector<HTMLInputElement>("#ffa-name")!.value.trim();
    saveName(n);
    try {
      guest = new FfaGuest({ code: o.code, seat: o.seat, build: ffaBuild(), name: n || SIDE_NAME[side], ...(relayUrl() ? { url: relayUrl()! } : {}) });
    } catch (e) {
      body.innerHTML = `<p class="duel-err">${esc(e instanceof Error ? e.message : String(e))}</p>`;
      return;
    }
    const g = guest;
    g.onChange = render;
    g.onStart = () => {
      if (done) return;
      finish();
      g.onChange = null;
      o.start(new FfaFeed({ guest: g, local: side }));
    };
    timer = window.setInterval(render, 1000);
    render();
  });
}

/** A rematch the host's report stored (sessionStorage): the lobby to open again, or null. */
export function takeRematch(): FfaRematch | null {
  try {
    const raw = sessionStorage.getItem(FFA_REMATCH_KEY);
    sessionStorage.removeItem(FFA_REMATCH_KEY);
    const p = JSON.parse(raw ?? "null") as FfaRematch | null;
    return p && typeof p.code === "string" && typeof p.map === "string" && Array.isArray(p.mutators) ? p : null;
  } catch {
    return null;
  }
}
