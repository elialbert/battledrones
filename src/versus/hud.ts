/**
 * A sound duel's in-match overlays and its report section (SOUND-DUEL.md
 * "Pause, resign, leave, background", "Rig > Lifecycle", "MatchFeed and
 * GameScene"). The feed decides what shows (src/versus/feed.ts); this only
 * draws it, mounted into the HUD root next to the game's own widgets.
 *
 * - One pill for a stall: "Waiting for your friend…", "…to load", "Friend
 *   paused", "Signal lost: bring the phones closer", with "Leave (no
 *   result)" once the feed offers it (two taps: a stray one doesn't end the
 *   match). Small pills for "Orders queued", "Resigning…" and "Leaving…".
 *   The battlefield stays in view: a stalled match is still worth looking
 *   at.
 * - The full-screen "Tap to reconnect the sound link" cover when the rig
 *   lost its audio: the whole cover is the button (the tap must be a
 *   gesture: it resumes the audio and may ask for the microphone), with
 *   Leave after LEAVE_AFTER_FAILURES failed taps. After a failed tap it says
 *   why when the feed knows (the rig's reason and what to do about it).
 * - The report's "Sound duel" block: the record, the link's quality, and the
 *   end check ("Checking sync…" until the friend's end report arrives);
 *   "Your friend is back in the lobby: tap Rematch" (SOUND-DUEL.md "Rematch
 *   > Waiting"); and the reconnect, as a button, when the rig loses its
 *   audio once the match is over: the cover would hide the report's buttons.
 *
 * Text is set as text (nothing here is markup from the air). Styles live in
 * ./hud.css, which ships with the duel chunk.
 *
 * Where the spec is silent:
 *  - "Friend paused" also covers a friend that switched apps: a frame has one
 *    paused bit, and a hidden page pauses (session.ts), so the pill says
 *    "or switched away" under it;
 *  - the stall pill sits under the banner's slot (--banner-top), centred on
 *    the battlefield, and on a phone between the zoom stack and the
 *    calldowns: in short landscape under a 53px banner, and in the banner's
 *    slot itself once Leave shows (hud.css); the cover dims the screen like
 *    the pause menu.
 */
import "./hud.css";
import type { ReportSection } from "../ui/report";

/** A stall the player sees: the friend is loading, paused, or simply not heard ("lost" past 5 s). */
export type StallKind = "wait" | "load" | "paused" | "lost";

/** The rig's audio is gone: waiting for the tap, the tap's reconnect running, it failed, or capture settling after it. */
export type ReconnectPhase = "lost" | "trying" | "failed" | "settling";

export interface OverlayState {
  stall: { kind: StallKind; leave: boolean } | null;
  /** The pending queue holds more than 2 s of orders. */
  queued: boolean;
  /** A resign is on its way (it lands D ticks after the tap). */
  resigning: boolean;
  /** `why`: after a failed tap, the rig's reason and what to do about it (null: the cover's own words). */
  reconnect: { phase: ReconnectPhase; leave: boolean; why: string | null } | null;
  /** Menu or Rematch was tapped: the end goes out for up to 2 s first. */
  leaving: boolean;
}

export interface OverlayHooks {
  /** The cover's tap (inside the gesture: rig.reconnect()). */
  reconnect(): void;
  /** "Leave (no result)", from the stall pill or the cover. */
  leave(): void;
}

export interface DuelOverlay {
  update(s: OverlayState): void;
  destroy(): void;
}

const STALL_TEXT: Record<StallKind, { text: string; sub: string | null }> = {
  wait: { text: "Waiting for your friend…", sub: null },
  load: { text: "Waiting for your friend to load…", sub: null },
  paused: { text: "Friend paused", sub: "or switched away" },
  lost: { text: "Signal lost: bring the phones closer", sub: null }
};

const COVER_TEXT: Record<ReconnectPhase, { text: string; sub: string }> = {
  lost: { text: "Tap to reconnect the sound link", sub: "The phone stopped its microphone or sound" },
  trying: { text: "Reconnecting…", sub: "Allow the microphone if asked" },
  failed: { text: "That didn't work: tap to try again", sub: "Allow the microphone if asked" },
  settling: { text: "Listening…", sub: "The match goes on in a moment" }
};

/** The cover's words for a phase: after a failed tap, `why` in place of the generic line when there is one. */
function coverWords(phase: ReconnectPhase, why: string | null): { text: string; sub: string } {
  const t = COVER_TEXT[phase];
  return phase === "failed" && why ? { text: t.text, sub: why } : t;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);

export function mountDuelOverlay(root: HTMLElement, hooks: OverlayHooks): DuelOverlay {
  const stack = document.createElement("div");
  stack.className = "duel-ov";
  // (the edge arrows steer around it: ui/awareness.ts)
  stack.dataset.edgeAvoid = "";
  stack.innerHTML = `
    <div class="duel-pill duel-stall" hidden><b></b><small hidden></small><button class="duel-leave" hidden></button></div>
    <div class="duel-pill duel-small duel-queued" hidden>Orders queued</div>
    <div class="duel-pill duel-small duel-resigning" hidden>Resigning…</div>
    <div class="duel-pill duel-small duel-leaving" hidden>Leaving…</div>`;
  root.appendChild(stack);
  const cover = document.createElement("div");
  cover.className = "duel-cover";
  cover.hidden = true;
  cover.innerHTML = `
    <div class="duel-cover-box" role="button" tabindex="0">
      <span class="duel-cover-icon">🔊</span><b></b><small></small>
    </div>
    <button class="cta alt warn duel-cover-leave" hidden>Leave (no result)</button>`;
  root.appendChild(cover);

  const q = <T extends HTMLElement>(el: HTMLElement, sel: string) => el.querySelector<T>(sel)!;
  const stall = q(stack, ".duel-stall");
  const stallText = q(stall, "b");
  const stallSub = q(stall, "small");
  const stallLeave = q<HTMLButtonElement>(stall, ".duel-leave");
  const queued = q(stack, ".duel-queued");
  const resigning = q(stack, ".duel-resigning");
  const leaving = q(stack, ".duel-leaving");
  const coverText = q(cover, "b");
  const coverSub = q(cover, "small");
  const coverLeave = q<HTMLButtonElement>(cover, ".duel-cover-leave");

  // keep these touches off the battlefield
  for (const el of [stack, cover]) el.addEventListener("pointerdown", (e) => e.stopPropagation());
  /** Leave asks twice: the first tap arms it for 3 s. */
  let armedUntil = 0;
  const leaveTap = (btn: HTMLButtonElement) => {
    const now = performance.now();
    if (now < armedUntil) {
      armedUntil = 0;
      hooks.leave();
      return;
    }
    armedUntil = now + 3000;
    btn.textContent = "Tap again to leave";
  };
  stallLeave.addEventListener("click", () => leaveTap(stallLeave));
  coverLeave.addEventListener("click", (e) => {
    e.stopPropagation();
    leaveTap(coverLeave);
  });
  q(cover, ".duel-cover-box").addEventListener("click", () => hooks.reconnect());

  let last = "";
  return {
    update(s) {
      const armed = performance.now() < armedUntil;
      const key = JSON.stringify(s) + armed;
      if (key === last) return;
      last = key;
      // (the end screen covers a stall: only the leaving pill is worth showing over it)
      stall.hidden = !s.stall || s.leaving;
      if (s.stall) {
        const t = STALL_TEXT[s.stall.kind];
        stallText.textContent = t.text;
        stallSub.hidden = !t.sub;
        stallSub.textContent = t.sub ?? "";
        stall.classList.toggle("bad", s.stall.kind === "lost");
      }
      stallLeave.hidden = !s.stall?.leave;
      if (!armed) stallLeave.textContent = "Leave (no result)";
      queued.hidden = !s.queued || s.leaving;
      resigning.hidden = !s.resigning || s.leaving;
      leaving.hidden = !s.leaving;
      cover.hidden = !s.reconnect || s.leaving;
      if (s.reconnect) {
        const t = coverWords(s.reconnect.phase, s.reconnect.why);
        coverText.textContent = t.text;
        coverSub.textContent = t.sub;
        cover.classList.toggle("busy", s.reconnect.phase === "trying" || s.reconnect.phase === "settling");
      }
      coverLeave.hidden = !s.reconnect?.leave;
      if (!armed) coverLeave.textContent = "Leave (no result)";
    },
    destroy() {
      stack.remove();
      cover.remove();
    }
  };
}

// --------------------------------------------------------------- report ---

/** What the report's Sound duel block shows, read afresh while the report is up. */
export interface DuelReportView {
  /** The record line ("3 wins · 1 loss · 0 draws"), or null on a practice link. */
  record: string | null;
  /** The end check: "pending" shows "Checking sync…". */
  sync: "pending" | "ok" | "unverified" | "desync" | "left" | "lost";
  /** The rig lost its audio after the match (the cover gives way to the end screen): the report's reconnect, `why` as the cover's. */
  relink: { phase: ReconnectPhase; why: string | null } | null;
  /** The friend's reloaded page is in the lobby: "tap Rematch". */
  friendInLobby: boolean;
  /**
   * The link's quality: packets heard, stall time, and the order delay as a
   * player feels it (Lockstep.orderWait: from the drain to this phone stepping
   * the order, mean and worst; null before any order). Not D × 100 ms, which
   * every order would read and the pause menu already shows. Both leave this
   * phone's own pause out, and both count a friend's (it stalls this phone).
   */
  link: { good: number; bad: number; stallMs: number; orders: { meanMs: number; worstMs: number } | null };
}

const SYNC_TEXT: Record<DuelReportView["sync"], { text: string; cls: string }> = {
  pending: { text: "Checking sync…", cls: "pending" },
  ok: { text: "In sync ✓", cls: "ok" },
  unverified: { text: "Not verified", cls: "pending" },
  desync: { text: "Out of sync: no contest", cls: "bad" },
  left: { text: "Friend left: no result", cls: "bad" },
  lost: { text: "You left: no result", cls: "bad" }
};

const secs = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`);
/** Under a second in ms, then in seconds. */
const span = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : secs(ms));

/** The order delay's rows: "Order delay" "620 ms average" and "Slowest order" "1.4 s" ("–" before any order). */
export function orderRows(o: DuelReportView["link"]["orders"]): [string, string][] {
  return [
    ["Order delay", o ? `${span(o.meanMs)} average` : "–"],
    ["Slowest order", o ? span(o.worstMs) : "–"]
  ];
}

function syncLine(v: DuelReportView): string {
  const t = SYNC_TEXT[v.sync];
  return `<p class="duel-sync ${t.cls}">${t.text}</p>`;
}

/** What changes while the report is up: the end check, the friend back in the lobby, the reconnect. */
function liveLines(v: DuelReportView): string {
  const back = v.friendInLobby ? `<p class="duel-back">Your friend is back in the lobby: tap Rematch</p>` : "";
  return syncLine(v) + back + relinkLine(v);
}

/** The reconnect cover's tap, as a button in the report (its words are the cover's). */
function relinkLine(v: DuelReportView): string {
  if (!v.relink) return "";
  const { phase, why } = v.relink;
  const t = coverWords(phase, why);
  const busy = phase === "trying" || phase === "settling";
  return busy
    ? `<p class="duel-relink busy">🔊 ${t.text}</p>`
    : `<button class="cta alt duel-relink">🔊 ${t.text}<small>${esc(t.sub)}</small></button>`;
}

function recordLine(v: DuelReportView): string {
  // (a practice link keeps no record)
  return v.record === null
    ? `<p class="duel-rec">Practice link (no sound): no record kept</p>`
    : `<p class="duel-rec">Your record: <b>${v.record}</b></p>`;
}

/**
 * The report's Sound duel block (addReportSection): the end check first (it
 * changes while the report is up), "Your friend is back in the lobby" and
 * the reconnect button when they apply, the record, then the link. `view` is
 * read when the report renders and every 250 ms after, until the report goes.
 * The reconnect button calls `hooks.reconnect` inside the tap.
 */
export function duelReportSection(view: () => DuelReportView, hooks: Pick<OverlayHooks, "reconnect">): ReportSection {
  return {
    id: "duel",
    // (first in the left column: right under the result, where "Checking sync…" is seen)
    order: 5,
    col: "left",
    render: () => {
      const v = view();
      const l = v.link;
      return `<h3 class="duel-h">🔊 Sound duel</h3>
        <div class="duel-live">${liveLines(v)}${recordLine(v)}</div>
        <table class="duel-link">
          <tr><td>Packets heard</td><td>${l.good} good · ${l.bad} bad</td></tr>
          <tr><td>Waiting on the link</td><td>${secs(l.stallMs)}</td></tr>
          ${orderRows(l.orders).map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("")}
        </table>`;
    },
    mount: (el) => {
      const live = el.querySelector<HTMLElement>(".duel-live");
      if (!live) return;
      let shown = live.innerHTML;
      live.addEventListener("click", (e) => {
        if (e.target instanceof Element && e.target.closest("button.duel-relink")) hooks.reconnect();
      });
      const timer = window.setInterval(() => {
        if (!el.isConnected) return window.clearInterval(timer);
        const v = view();
        const html = liveLines(v) + recordLine(v);
        if (html !== shown) live.innerHTML = shown = html;
      }, 250);
    }
  };
}
