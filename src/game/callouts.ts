/**
 * Battle callouts: the engine-free rules behind the radio announcer and the
 * kill-streak banners. BattleCallouts watches the sim's fx stream (plus a
 * little world state) and decides *what* is worth saying; RadioQueue decides
 * *when* (priority, a minimum gap, stale lines dropped). announcer.ts does
 * the talking. Everything here is unit-tested (tests/voices.test.ts).
 *
 * Times are sim seconds for detection windows and cooldowns (so a faster
 * game speed needs no change) and render seconds for the delivery queue.
 */
import { BUILDINGS, UNITS } from "../sim/balance";
import { isVisible } from "../sim/fog";
import type { Faction, FxEvent, UnitKind, World } from "../sim/types";
import type { Announcement, AnnounceTone } from "./announce";

/** A line for the radio announcer. */
export interface RadioLine {
  /** Kind of line (dedupe, cooldown and debug key), e.g. "hq-attack". */
  key: string;
  /** What is said (and captioned). */
  text: string;
  /** 0 = critical … 3 = flavour. */
  priority: number;
  tone: AnnounceTone;
  /** Where it happened (tiles): tapping the caption jumps there. */
  x?: number;
  y?: number;
  /**
   * Show a small radio caption when it is delivered. False when a toast or
   * banner already shows the same news (no text spam), true when the radio
   * is the only place it appears.
   */
  caption: boolean;
}

export const CALLOUTS = {
  /** Per-line cooldowns, sim seconds. */
  cooldownS: {
    "hq-attack": 30,
    /** The HQ is being hit where the player can already see it: say it less often. */
    "hq-attack-seen": 60,
    "base-attack": 30,
    "units-attack": 60,
    "squad-lost": 20,
    "harvester-lost": 20,
    "unit-lost": 15,
    "structure-lost": 15,
    "structure-killed": 15,
    promoted: 25,
    "no-scrap": 8
  } as Record<string, number>,
  /** "Squad lost": this many own unit deaths within the window. */
  squadDeaths: 3,
  squadWindowS: 3,
  /** Enemy combat aircraft out of sight this long re-arm "Enemy aircraft detected". */
  airRearmS: 120,
  /** Scan for newly visible aircraft every this many seconds. */
  airScanS: 0.5,
  /** Kill streaks: kills inside this sliding window… */
  streakWindowS: 4,
  /** …announced after this settle time, so a fast third kill upgrades the line. */
  streakHoldS: 0.6,
  /** Streak tiers (kills in the window) and each tier's own cooldown. */
  tiers: [
    { n: 5, key: "streak-5", text: "Rampage", tone: "epic", priority: 2, cooldownS: 45 },
    { n: 3, key: "streak-3", text: "Triple kill", tone: "good", priority: 2, cooldownS: 30 },
    { n: 2, key: "streak-2", text: "Double kill", tone: "good", priority: 3, cooldownS: 30 }
  ] as { n: number; key: string; text: string; tone: AnnounceTone; priority: number; cooldownS: number }[],
  /** Kills of units worth at least this much scrap get their own banner. */
  bigKillValue: 350,
  bigKillCooldownS: 15,
  /** At least this long between any two kill banners (sparing)… */
  killBannerGapS: 6,
  /** …except a streak climbing to a higher tier, which only needs this. */
  escalateGapS: 2,
  /** Losing a unit worth this much (or a rank-2 veteran) gets a radio line. */
  bigLossValue: 350
} as const;

export interface CalloutHooks {
  world: World;
  player: Faction;
  spectator: boolean;
  /** Is the tile point inside the camera view? */
  onScreen(x: number, y: number): boolean;
  /** Hand a line to the radio announcer. */
  radio(line: RadioLine): void;
  /** Raise a banner (the HUD shows it; the announcer reads it out). */
  announce(a: Announcement): void;
}

const SIDE: Record<Faction, string> = { blue: "Blue", red: "Red" };
/** Shorter names where a banner must fit a phone ("ELITE FLAK DOWN"). */
const SHORT: Partial<Record<UnitKind, string>> = { "flak-crawler": "Flak" };
const enemyOf = (f: Faction): Faction => (f === "blue" ? "red" : "blue");

interface Streak {
  /** Sim times of kills inside the window. */
  kills: number[];
  /** Highest tier already called in this streak. */
  tier: number;
  /** Tier waiting for its hold to expire (0 = none) and when it was reached. */
  pending: number;
  pendingAt: number;
  /** A big kill to mention under the streak banner. */
  big: string | null;
  x: number;
  y: number;
}

/**
 * Turns the fx stream into announcer lines and kill banners. Feed it each
 * tick's events with events(); it also polls a little world state there
 * (construction ready, visible aircraft, the winner).
 */
export class BattleCallouts {
  private last = new Map<string, number>();
  private ownDeaths: number[] = [];
  private streaks: Record<Faction, Streak> = {
    blue: { kills: [], tier: 0, pending: 0, pendingAt: 0, big: null, x: 0, y: 0 },
    red: { kills: [], tier: 0, pending: 0, pendingAt: 0, big: null, x: 0, y: 0 }
  };
  private firstBlood = false;
  private lastKillBanner = -Infinity;
  private lastBigKill = -Infinity;
  private wasReady = false;
  private airSeen: Record<Faction, number> = { blue: -Infinity, red: -Infinity };
  private airArmed: Record<Faction, boolean> = { blue: true, red: true };
  private lastAirScan = -Infinity;
  private ended = false;
  /** Lines and banners raised, by key (debug/measurement). */
  readonly counts = new Map<string, number>();

  constructor(private h: CalloutHooks) {}

  /** Feed one tick's events at sim time `t` (seconds). */
  events(fx: readonly FxEvent[], t: number): void {
    if (this.ended) return;
    for (const ev of fx) {
      if (ev.type === "hit") this.hit(ev, t);
      else if (ev.type === "death") this.death(ev, t);
      else if (ev.type === "rankUp") this.rankUp(ev.id, t);
    }
    this.poll(t);
  }

  /**
   * The awareness layer just warned of an inbound raid (awareness.ts): an
   * aircraft raid makes "Enemy aircraft detected" redundant for a while.
   */
  inbound(domain: "air" | "ground" | "mixed", t: number): void {
    if (domain === "ground" || this.h.spectator) return;
    const f = enemyOf(this.h.player);
    this.airArmed[f] = false;
    this.airSeen[f] = t;
  }

  /** An outside cue (HUD): "no-scrap". */
  cue(key: "no-scrap", t: number): void {
    if (this.h.spectator || this.ended) return;
    if (key === "no-scrap" && this.ready("no-scrap", t))
      this.say({ key, text: "Insufficient scrap", priority: 3, tone: "info", caption: false }, t);
  }

  // ------------------------------------------------------------- helpers --

  /** Is the cooldown for `key` over? (Doesn't start it.) */
  private ready(key: string, t: number, cd = CALLOUTS.cooldownS[key] ?? 0): boolean {
    return t - (this.last.get(key) ?? -Infinity) >= cd;
  }

  private say(line: RadioLine, t: number, cdKey = line.key): void {
    this.last.set(cdKey, t);
    this.counts.set(line.key, (this.counts.get(line.key) ?? 0) + 1);
    this.h.radio(line);
  }

  private banner(a: Announcement, t: number): void {
    this.lastKillBanner = t;
    this.counts.set(a.key, (this.counts.get(a.key) ?? 0) + 1);
    this.h.announce(a);
  }

  // -------------------------------------------------------------- events --

  private hit(ev: Extract<FxEvent, { type: "hit" }>, t: number): void {
    const h = this.h;
    if (ev.building) {
      const b = h.world.buildings.get(ev.id);
      if (!b) return;
      if (b.kind === "hq") {
        if (h.spectator) {
          const key = `hq-attack-${b.faction}`;
          if (this.ready(key, t, 40))
            this.say({ key, text: `${SIDE[b.faction]} HQ under attack`, priority: 1, tone: "bad", x: ev.x, y: ev.y, caption: true }, t);
          return;
        }
        if (b.faction !== h.player) return;
        // in view, the player already knows: remind less often
        const seen = h.onScreen(ev.x, ev.y);
        if (this.ready("hq-attack", t, seen ? CALLOUTS.cooldownS["hq-attack-seen"] : CALLOUTS.cooldownS["hq-attack"])) {
          this.say({ key: "hq-attack", text: "Warning: our HQ is under attack", priority: 0, tone: "bad", x: ev.x, y: ev.y, caption: false }, t);
          this.last.set("base-attack", t);
        }
        return;
      }
      if (h.spectator || b.faction !== h.player) return;
      if (!h.onScreen(ev.x, ev.y) && this.ready("base-attack", t) && this.ready("hq-attack", t, 8))
        this.say({ key: "base-attack", text: "Our base is under attack", priority: 1, tone: "bad", x: ev.x, y: ev.y, caption: false }, t);
      return;
    }
    if (h.spectator || ev.faction !== h.player || h.onScreen(ev.x, ev.y)) return;
    if (this.ready("units-attack", t) && this.ready("squad-lost", t, 10))
      this.say({ key: "units-attack", text: "Our units are under fire", priority: 2, tone: "bad", x: ev.x, y: ev.y, caption: false }, t);
  }

  private death(ev: Extract<FxEvent, { type: "death" }>, t: number): void {
    const h = this.h;
    const victim = ev.faction;
    const killer = enemyOf(victim);
    if (ev.buildingKind) {
      if (ev.buildingKind === "hq") return; // the winner line covers it
      const name = BUILDINGS[ev.buildingKind].name;
      if (h.spectator) {
        const key = `structure-killed-${victim}`;
        if (this.ready(key, t, 20))
          this.say({ key, text: `${SIDE[victim]} ${name} destroyed`, priority: 2, tone: "info", x: ev.x, y: ev.y, caption: true }, t);
      } else if (victim === h.player) {
        if (this.ready("structure-lost", t))
          this.say({ key: "structure-lost", text: `Structure lost: ${name}`, priority: 1, tone: "bad", x: ev.x, y: ev.y, caption: true }, t);
      } else if (this.ready("structure-killed", t)) {
        this.say({ key: "structure-killed", text: `Enemy ${name} destroyed`, priority: 2, tone: "good", x: ev.x, y: ev.y, caption: true }, t);
      }
      return;
    }
    const kind = ev.unitKind;
    if (!kind) return;
    if (h.spectator || killer === h.player) this.kill(ev, killer, t);
    if (!h.spectator && victim === h.player) this.loss(ev, t);
  }

  /** One of ours died: squad losses, harvesters and expensive hulls. */
  private loss(ev: Extract<FxEvent, { type: "death" }>, t: number): void {
    const h = this.h;
    const d = this.ownDeaths;
    d.push(t);
    while (d.length && t - d[0]! > CALLOUTS.squadWindowS) d.shift();
    if (d.length >= CALLOUTS.squadDeaths && this.ready("squad-lost", t)) {
      d.length = 0;
      this.say({ key: "squad-lost", text: "Squad lost", priority: 1, tone: "bad", x: ev.x, y: ev.y, caption: true }, t);
      return;
    }
    if (h.onScreen(ev.x, ev.y) || !this.ready("squad-lost", t, 4)) return;
    const kind = ev.unitKind!;
    if (kind === "harvester") {
      if (this.ready("harvester-lost", t))
        this.say({ key: "harvester-lost", text: "Harvester lost", priority: 2, tone: "bad", x: ev.x, y: ev.y, caption: true }, t);
    } else if ((ev.value >= CALLOUTS.bigLossValue || ev.rank >= 2) && this.ready("unit-lost", t)) {
      const vet = ev.rank >= 2 ? "Veteran " : "";
      this.say({ key: "unit-lost", text: `${vet}${UNITS[kind].name} lost`, priority: 2, tone: "bad", x: ev.x, y: ev.y, caption: true }, t);
    }
  }

  /** A kill credited to `killer`: first blood, streaks, big game. */
  private kill(ev: Extract<FxEvent, { type: "death" }>, killer: Faction, t: number): void {
    const h = this.h;
    const name = UNITS[ev.unitKind!].name;
    const s = this.streaks[killer];
    if (!this.firstBlood) {
      this.firstBlood = true;
      this.banner(
        {
          key: "first-blood", text: "First blood", tone: "epic", priority: 2, x: ev.x, y: ev.y,
          sub: h.spectator ? `${SIDE[killer]} strikes first` : `Enemy ${name} destroyed`,
          ...(h.spectator ? { say: `First blood to ${SIDE[killer]}` } : {})
        },
        t
      );
    }
    // streak bookkeeping (a gap longer than the window starts a new streak)
    while (s.kills.length && t - s.kills[0]! > CALLOUTS.streakWindowS) s.kills.shift();
    if (s.kills.length === 0) s.tier = 0;
    s.kills.push(t);
    s.x = ev.x;
    s.y = ev.y;
    const tier = CALLOUTS.tiers.find((x) => s.kills.length >= x.n)?.n ?? 0;
    if (tier > s.tier && tier > s.pending) {
      if (!s.pending) s.pendingAt = t;
      s.pending = tier;
    }
    const big = ev.value >= CALLOUTS.bigKillValue || ev.rank >= 3;
    if (big) {
      const label = `${ev.rank >= 3 ? "Elite " : ""}${SHORT[ev.unitKind!] ?? name}`;
      if (s.pending) s.big = `${label} destroyed`; // rides along under the streak banner
      else if (t - this.lastBigKill >= CALLOUTS.bigKillCooldownS && t - this.lastKillBanner >= CALLOUTS.killBannerGapS) {
        this.lastBigKill = t;
        // short on the banner ("TITAN DOWN" fits a phone), complete on the radio
        this.banner(
          h.spectator
            ? { key: `kill-${ev.unitKind}`, text: `${SIDE[ev.faction]} ${label} down`, sub: `${SIDE[killer]} scores`, tone: "good", priority: 3, x: ev.x, y: ev.y }
            : { key: `kill-${ev.unitKind}`, text: `${label} down`, say: `Enemy ${label} destroyed`, tone: "good", priority: 3, x: ev.x, y: ev.y },
          t
        );
      }
    }
  }

  private rankUp(id: number, t: number): void {
    const h = this.h;
    if (h.spectator) return;
    const u = h.world.units.get(id);
    if (!u || u.faction !== h.player || u.rank < 2 || !this.ready("promoted", t)) return;
    const text = u.rank >= 3 ? `${UNITS[u.kind].name} promoted to elite` : `${UNITS[u.kind].name} promoted`;
    this.say({ key: "promoted", text, priority: 3, tone: "good", x: u.x, y: u.y, caption: true }, t);
  }

  // ---------------------------------------------------------------- poll --

  private poll(t: number): void {
    const h = this.h;
    const w = h.world;
    if (w.winner) {
      this.ended = true;
      const text = h.spectator
        ? `${SIDE[w.winner]} wins the battle`
        : w.winner === h.player
          ? "Enemy HQ destroyed. Victory!"
          : "Our HQ has fallen. Mission failed."
      this.say({ key: w.winner === h.player || h.spectator ? "victory" : "defeat", text, priority: 0, tone: w.winner === h.player || h.spectator ? "epic" : "bad", caption: false }, t);
      return;
    }
    // streak banners whose hold has run out
    for (const f of ["blue", "red"] as Faction[]) this.flushStreak(f, t);
    if (!h.spectator) {
      const ready = !!w.factions[h.player].pending?.ready;
      if (ready && !this.wasReady)
        this.say({ key: "construction", text: "Construction complete", priority: 3, tone: "good", caption: false }, t);
      this.wasReady = ready;
    }
    if (t - this.lastAirScan >= CALLOUTS.airScanS) {
      this.lastAirScan = t;
      this.scanAir(t);
    }
  }

  private flushStreak(f: Faction, t: number): void {
    const s = this.streaks[f];
    if (!s.pending || t - s.pendingAt < CALLOUTS.streakHoldS) return;
    const tier = CALLOUTS.tiers.find((x) => x.n === s.pending)!;
    const escalation = s.tier > 0;
    s.tier = s.pending;
    s.pending = 0;
    const big = s.big;
    s.big = null;
    const cdKey = this.h.spectator ? tier.key : `${tier.key}-${f}`;
    if (t - this.lastKillBanner < (escalation ? CALLOUTS.escalateGapS : CALLOUTS.killBannerGapS)) return;
    if (!this.ready(cdKey, t, tier.cooldownS)) {
      // the streak was called recently: a big kill inside it still gets its own line
      if (big && t - this.lastBigKill >= CALLOUTS.bigKillCooldownS) {
        this.lastBigKill = t;
        const down = big.replace(/ destroyed$/, " down");
        this.banner(
          this.h.spectator
            ? { key: "kill-big", text: down, sub: `${SIDE[f]} scores`, tone: "good", priority: 3, x: s.x, y: s.y }
            : { key: "kill-big", text: down, say: `Enemy ${big}`, tone: "good", priority: 3, x: s.x, y: s.y },
          t
        );
      }
      return;
    }
    this.last.set(cdKey, t);
    if (big) this.lastBigKill = t;
    const sub = this.h.spectator ? (big ? `${SIDE[f]} · ${big}` : SIDE[f]) : big ?? undefined;
    this.banner(
      {
        key: tier.key, text: tier.text, tone: tier.tone, priority: tier.priority, x: s.x, y: s.y,
        ...(sub ? { sub } : {}),
        // the caster says whose streak it is
        ...(this.h.spectator ? { say: `${tier.text} for ${SIDE[f]}` } : {})
      },
      t
    );
  }

  /** "Enemy aircraft detected": the first visible enemy combat aircraft (re-armed after a long absence). */
  private scanAir(t: number): void {
    const h = this.h;
    const w = h.world;
    const sides: Faction[] = h.spectator ? ["blue", "red"] : [enemyOf(h.player)];
    for (const f of sides) {
      let spotted: { x: number; y: number } | null = null;
      for (const u of w.units.values()) {
        if (u.faction !== f) continue;
        const st = UNITS[u.kind];
        if (st.domain !== "air" || st.targets === "none") continue;
        if (!h.spectator && !isVisible(w, h.player, Math.floor(u.x), Math.floor(u.y))) continue;
        spotted = { x: u.x, y: u.y };
        break;
      }
      if (spotted) {
        if (this.airArmed[f]) {
          this.airArmed[f] = false;
          const key = h.spectator ? `air-${f}` : "enemy-air";
          const text = h.spectator ? `${SIDE[f]} aircraft inbound` : "Enemy aircraft detected";
          this.say({ key, text, priority: h.spectator ? 2 : 1, tone: "bad", x: spotted.x, y: spotted.y, caption: true }, t);
        }
        this.airSeen[f] = t;
      } else if (t - this.airSeen[f] > CALLOUTS.airRearmS) this.airArmed[f] = true;
    }
  }
}

// ---------------------------------------------------------------- queue --

export const RADIO = {
  /** Minimum time between the starts of two lines (render seconds). */
  gapS: 2.5,
  /** Lines waiting longer than this are dropped (critical ones get longer). */
  staleS: 3,
  staleCriticalS: 6,
  /** Waiting lines kept at most. */
  cap: 2,
  /**
   * Chatter budget: routine lines (priority ≥ 2) are dropped once this many
   * lines went out inside the window; warnings (0–1) always get through.
   */
  budget: { windowS: 30, max: 3 }
} as const;

/**
 * The announcer's waiting list: most important first, at least RADIO.gapS
 * between lines, stale lines dropped, a line already waiting is refreshed
 * rather than repeated.
 */
export class RadioQueue {
  private items: { line: RadioLine; at: number }[] = [];
  private lastStart = -Infinity;
  private starts: number[] = [];

  get size(): number {
    return this.items.length;
  }

  push(line: RadioLine, now: number): void {
    const same = this.items.find((i) => i.line.key === line.key);
    if (same) {
      same.line = line;
      same.at = now;
      return;
    }
    this.items.push({ line, at: now });
    while (this.items.length > RADIO.cap) {
      // overflow: lose the least important line, the oldest of those first
      let worst = 0;
      for (let i = 1; i < this.items.length; i++) {
        const a = this.items[i]!;
        const b = this.items[worst]!;
        if (a.line.priority > b.line.priority || (a.line.priority === b.line.priority && a.at < b.at)) worst = i;
      }
      this.items.splice(worst, 1);
    }
  }

  /** The line to deliver now, if any: none while `busy` or inside the gap (unless `ignoreGap`). */
  next(now: number, busy = false, ignoreGap = false): RadioLine | null {
    this.items = this.items.filter(
      (i) => now - i.at <= (i.line.priority === 0 ? RADIO.staleCriticalS : RADIO.staleS)
    );
    if (busy || this.items.length === 0 || (!ignoreGap && now - this.lastStart < RADIO.gapS)) return null;
    while (this.starts.length && now - this.starts[0]! > RADIO.budget.windowS) this.starts.shift();
    const spent = this.starts.length >= RADIO.budget.max;
    if (spent) this.items = this.items.filter((i) => i.line.priority < 2);
    let best = -1;
    for (let i = 0; i < this.items.length; i++) {
      const a = this.items[i]!;
      const b = best >= 0 ? this.items[best]! : null;
      if (!b || a.line.priority < b.line.priority || (a.line.priority === b.line.priority && a.at < b.at)) best = i;
    }
    if (best < 0) return null;
    this.lastStart = now;
    this.starts.push(now);
    return this.items.splice(best, 1)[0]!.line;
  }

  /** Forget everything waiting (the match ended). */
  clear(): void {
    this.items = [];
  }
}

/**
 * Make banner text speakable: drop emoji and symbols, turn SHOUTED banner
 * text into a sentence (keeping acronyms like HQ), end with punctuation.
 */
export function speakable(text: string): string {
  let s = text
    .replace(/[^\p{L}\p{N}\s.,!?'’:-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const letters = s.replace(/[^\p{L}]/gu, "");
  if (letters.length >= 4 && letters === letters.toUpperCase()) {
    s = s.toLowerCase().replace(/^\p{L}/u, (c) => c.toUpperCase());
    s = s.replace(/\b(hq|sam|emp|ai|mvp)\b/g, (m) => m.toUpperCase());
  }
  return s;
}
