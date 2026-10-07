import Phaser from "phaser";
import { UNITS } from "../sim/balance";
import type { Faction, FxEvent, PowerKind, World } from "../sim/types";
import { announce } from "./announce";
import { TILE } from "./assets";
import { CalldownCredit, powerName } from "./calldown-credit";
import { NAMED_RANK, RANK_TITLES, callsignOf, heroShort, killsLabel, stars } from "./heroes";

/**
 * Veteran-hero presentation: floating promotion titles over the unit, and
 * the toasts / announcements that make named units matter — "★★ Viper is
 * now Hardened", "Viper (Lancer, 9 kills) destroyed". GameScene feeds it
 * every FxEvent and calls flush() once per tick so simultaneous losses in a
 * big fight become one toast instead of a stack.
 */

export type NoticeTone = "good" | "bad" | "info";

export interface HeroPresenterOpts {
  dpr: number;
  player: Faction;
  spectator: boolean;
  /** May the local player see this tile position? */
  seesPoint(x: number, y: number): boolean;
  /** Rendered body position (world px) of a unit, if drawn. */
  unitPos(id: number): { x: number; y: number } | null;
  /** Show a small HUD notice; tapping it jumps the camera to (x, y). */
  notify(msg: string, tone: NoticeTone, x: number, y: number): void;
}

interface Fallen {
  name: string;
  line: string;
  kills: number;
  x: number;
  y: number;
  /** Killed by a commander calldown (whose, and which power). */
  strike: { by: Faction; power: PowerKind } | null;
}

const TITLE_STYLE: Record<number, { color: string; size: number }> = {
  1: { color: "#ffe7a6", size: 15 },
  2: { color: "#ffd66e", size: 17 },
  3: { color: "#ffc23a", size: 21 }
};

export class HeroPresenter {
  private lost: Fallen[] = [];
  private aces: Fallen[] = [];
  /** Live promotion titles, one per unit (a new one replaces the old). */
  private titles = new Map<number, Phaser.GameObjects.Text>();
  /** Names the Barrage / Sky Hammer that got a hero (calldown-credit.ts). */
  private credit: CalldownCredit;

  constructor(
    private scene: Phaser.Scene,
    private w: World,
    private opts: HeroPresenterOpts
  ) {
    this.credit = new CalldownCredit(w);
  }

  handleFx(ev: FxEvent): void {
    const by = this.credit.see(ev);
    if (ev.type === "rankUp") this.promoted(ev.id);
    else if (ev.type === "death" && ev.unitKind && ev.rank >= NAMED_RANK) {
      const rec: Fallen = {
        name: callsignOf(this.w, { id: ev.id, faction: ev.faction }),
        line: heroShort(this.w, { id: ev.id, faction: ev.faction, kind: ev.unitKind, kills: ev.kills }),
        kills: ev.kills,
        x: ev.x,
        y: ev.y,
        strike: by ? { by: by.faction, power: by.power } : null
      };
      if (this.opts.spectator) {
        // both sides' real heroes, not every rank-2 grunt
        if (ev.rank >= 3 || ev.kills >= 6) this.lost.push({ ...rec, line: `${ev.faction === "blue" ? "Blue" : "Red"}'s ${rec.line}` });
      } else if (ev.faction === this.opts.player) this.lost.push(rec);
      // an enemy veteran that actually hurt you, seen going down
      else if ((ev.rank >= 3 || ev.kills >= 3) && this.opts.seesPoint(ev.x, ev.y)) this.aces.push(rec);
    }
  }

  /** "by the enemy Sky Hammer" / "to your Barrage" when one strike got them all, else "". */
  private strikeNote(list: Fallen[], prep: "by" | "to"): string {
    const s = list[0]!.strike;
    if (!s || list.some((x) => x.strike?.power !== s.power || x.strike.by !== s.by)) return "";
    const whose = this.opts.spectator
      ? `${s.by === "blue" ? "Blue" : "Red"}'s`
      : s.by === this.opts.player
        ? "your"
        : s.power === "hammer"
          ? "the enemy"
          : "an enemy";
    return ` ${prep} ${whose} ${powerName(s.power)}`;
  }

  /** Emit this tick's batched notices. */
  flush(): void {
    if (this.lost.length > 0) {
      const l = this.lost;
      const by = this.strikeNote(l, "by");
      const msg =
        l.length === 1
          ? `${l[0]!.line} destroyed${by}`
          : `${listNames(l.map((x) => x.name))} destroyed${by} (${killsLabel(l.reduce((s, x) => s + x.kills, 0))} between them)`;
      this.opts.notify(`✝ ${msg}`, this.opts.spectator ? "info" : "bad", l[0]!.x, l[0]!.y);
    }
    if (this.aces.length > 0) {
      const a = this.aces;
      const to = this.strikeNote(a, "to");
      const msg = a.length === 1 ? `Enemy ace ${a[0]!.line} down${to}` : `Enemy aces ${listNames(a.map((x) => x.name))} down${to}`;
      this.opts.notify(`🎯 ${msg}`, "good", a[0]!.x, a[0]!.y);
    }
    this.lost = [];
    this.aces = [];
  }

  private promoted(id: number): void {
    const u = this.w.units.get(id);
    if (!u) return;
    const mine = u.faction === this.opts.player || this.opts.spectator;
    // titles over your own units; an enemy's only once it's dangerous
    const p = this.opts.unitPos(id) ?? { x: u.x * TILE, y: u.y * TILE };
    const onScreen = this.scene.cameras.main.worldView.contains(p.x, p.y);
    if (onScreen && this.opts.seesPoint(u.x, u.y) && (mine || u.rank >= NAMED_RANK))
      this.floatTitle(id, p.x, p.y - UNITS[u.kind].radius * TILE - 18, u.rank, mine);
    if (u.rank < NAMED_RANK || this.opts.spectator || u.faction !== this.opts.player) return;
    const name = callsignOf(this.w, u);
    const kind = UNITS[u.kind].name;
    if (u.rank >= 3)
      announce({
        key: "unit-elite",
        text: `${name} is Elite`,
        sub: `${stars(3)} ${kind} · ${killsLabel(u.kills)} · self-repairing`,
        tone: "epic",
        x: u.x,
        y: u.y,
        priority: 3
      });
    else this.opts.notify(`${stars(u.rank)} Your ${kind} earned a callsign: ${name}`, "good", u.x, u.y);
  }

  /** "VETERAN" / "HARDENED" / "ELITE" rising over the unit. */
  private floatTitle(id: number, x: number, y: number, rank: number, friendly: boolean): void {
    const prev = this.titles.get(id);
    if (prev) {
      this.scene.tweens.killTweensOf(prev);
      prev.destroy();
      this.titles.delete(id);
    }
    if (this.titles.size >= 8) return; // a huge brawl: the chevrons will do
    const st = TITLE_STYLE[Math.min(3, Math.max(1, rank))]!;
    const cam = this.scene.cameras.main;
    // a hi-res texture shown at a fixed on-screen size whatever the zoom
    const base = 44;
    const k = (st.size * this.opts.dpr) / cam.zoom / base;
    const t = this.scene.add
      .text(x, y, RANK_TITLES[Math.min(3, rank)] ?? "", {
        fontFamily: '"Rajdhani", "Segoe UI", system-ui, sans-serif',
        fontStyle: "bold",
        fontSize: `${base}px`,
        color: friendly ? st.color : "#ff9a8a",
        stroke: "#1a1205",
        strokeThickness: 9
      })
      .setOrigin(0.5, 1)
      .setDepth(10.6)
      .setScale(k * 1.5)
      .setAlpha(0);
    t.setShadow(0, 3, "rgba(0,0,0,0.55)", 6, true, true);
    const rise = (30 * this.opts.dpr) / cam.zoom;
    this.scene.tweens.add({ targets: t, scale: k, alpha: 1, duration: 260, ease: "Back.easeOut" });
    this.scene.tweens.add({ targets: t, y: y - rise, duration: 1200, ease: "Sine.easeOut" });
    this.titles.set(id, t);
    this.scene.tweens.add({
      targets: t, alpha: 0, delay: 850, duration: 350,
      onComplete: () => {
        t.destroy();
        if (this.titles.get(id) === t) this.titles.delete(id);
      }
    });
  }
}

function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  const shown = names.slice(0, 3);
  const extra = names.length - shown.length;
  if (extra > 0) return `${shown.join(", ")} +${extra}`;
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}
