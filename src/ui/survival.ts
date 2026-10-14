import { survivalStatus, type SurvivalStatus } from "../sim/modes/survival";
import type { Faction, World } from "../sim/types";
import { PLAYER, type Controller } from "../game/controller";
import { THEME_ICONS, finishRun, fmtSecs, loadBest } from "../game/survival";
import { mapById } from "../sim/maps";
import { chronicleOf } from "../game/chronicle";
import { mvpCard } from "./report";
import { careerBlockHtml, mountCareerBlock } from "./career";
import { settlementOf } from "../game/career";

/**
 * Last Stand HUD pieces, wired into hud.ts by a few hook lines: the wave
 * pill in the top bar, the "call next wave" chip, the minimap spawn arrow
 * and the end-of-run screen.
 */

export interface SurvivalChip {
  id: string;
  label: string;
  cls?: string;
  on: () => void;
}

export interface SurvivalHud {
  update(): void;
  /** The call-wave-early chip, when it's available. */
  chip(): SurvivalChip | null;
  drawMinimap(ctx: CanvasRenderingContext2D, k: number, now: number): void;
  showEnd(endEl: HTMLElement, winner: Faction, secs: number, onAgain: () => void, onMenu: () => void): void;
  pauseLine(): string;
}

const DIFF_LABEL: Record<string, string> = { easy: "Easy", normal: "Normal", hard: "Hard" };

export function createSurvivalHud(
  pill: HTMLElement,
  w: World,
  opts: { ctrl: Controller; spectator: boolean; centerCamera(x: number, y: number): void }
): SurvivalHud {
  const s = w.survival!;
  const best = opts.spectator ? null : loadBest(w.mapId, s.difficulty);
  pill.hidden = false;
  pill.innerHTML = `<b class="wv"></b><span class="wt"></span><span class="wc"></span>`;
  const wv = pill.querySelector<HTMLElement>(".wv")!;
  const wt = pill.querySelector<HTMLElement>(".wt")!;
  const wc = pill.querySelector<HTMLElement>(".wc")!;
  pill.addEventListener("pointerdown", (e) => e.stopPropagation());
  pill.addEventListener("click", () => {
    const st = survivalStatus(w);
    if (st?.site) opts.centerCamera(st.site.x, st.site.y);
  });

  let lastKey = "";
  let status: SurvivalStatus | null = null;

  function update(): void {
    status = survivalStatus(w);
    if (!status) return;
    const st = status;
    // during a wave: how many are left; otherwise what's coming next
    const active = st.left > 0 && !st.warned;
    const label = active ? `Wave ${st.wave}` : `Wave ${st.next}`;
    const what = active ? `${st.left} left` : `${THEME_ICONS[st.nextTheme]} ${st.nextName}`;
    const clock = st.warned ? `${Math.ceil(st.nextIn)}s` : active ? `next ${fmtSecs(st.nextIn)}` : fmtSecs(st.nextIn);
    const cls = `wavepill${st.warned ? " hot" : active ? " active" : ""}${st.warned && st.nextTheme === "boss" ? " boss" : ""}`;
    const key = `${cls}|${label}|${what}|${clock}`;
    if (key === lastKey) return;
    lastKey = key;
    pill.className = cls;
    wv.textContent = label;
    wt.textContent = what;
    wc.textContent = clock;
  }

  function chip(): SurvivalChip | null {
    if (opts.spectator || !status || status.callBonus <= 0) return null;
    return {
      id: "callwave",
      label: `⏩ Call wave ${status.next} +${status.callBonus}`,
      cls: "callwave",
      on: () => opts.ctrl.enqueue({ type: "callWave", faction: PLAYER })
    };
  }

  function drawMinimap(ctx: CanvasRenderingContext2D, k: number, now: number): void {
    const st = status;
    if (!st?.site) return;
    const boss = (st.warned ? st.nextTheme : s.theme) === "boss";
    const col = boss ? "255,214,110" : "255,90,74";
    const x = st.site.ax * k;
    const y = st.site.ay * k;
    // arrow from the map edge pointing into the map, pulsing
    const cx = (w.width / 2) * k;
    const cy = (w.height / 2) * k;
    const ang = Math.atan2(cy - y, cx - x);
    const pulse = 0.55 + 0.45 * Math.sin(now / 400);
    const tipX = x + Math.cos(ang) * 30;
    const tipY = y + Math.sin(ang) * 30;
    ctx.save();
    ctx.fillStyle = `rgba(${col},${0.35 + 0.5 * pulse})`;
    ctx.strokeStyle = `rgba(${col},1)`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(x + Math.cos(ang + 2.5) * 14 + Math.cos(ang) * 8, y + Math.sin(ang + 2.5) * 14 + Math.sin(ang) * 8);
    ctx.lineTo(x + Math.cos(ang) * 10, y + Math.sin(ang) * 10);
    ctx.lineTo(x + Math.cos(ang - 2.5) * 14 + Math.cos(ang) * 8, y + Math.sin(ang - 2.5) * 14 + Math.sin(ang) * 8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(st.site.x * k, st.site.y * k, 10 + 14 * (1 - pulse), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function showEnd(endEl: HTMLElement, _winner: Faction, secs: number, onAgain: () => void, onMenu: () => void): void {
    const def = mapById(w.mapId); // (falls back to the first map for an unknown id: keep the id then)
    const mapName = def.id === w.mapId ? def.name : w.mapId;
    const diff = DIFF_LABEL[s.difficulty] ?? s.difficulty;
    const r = finishRun(w, w.mapId, s.difficulty, !opts.spectator);
    const st = w.factions[s.defender].stats;
    const title = opts.spectator ? "OVERRUN" : r.isNew ? "NEW RECORD!" : "OVERRUN";
    const bestLine = opts.spectator
      ? `<p class="ls-best">The AI held for ${r.waves} wave${r.waves === 1 ? "" : "s"}</p>`
      : r.isNew
        ? `<p class="ls-best new">🏆 New best${r.prevBest > 0 ? ` — beat ${r.prevBest}` : ""}</p>`
        : `<p class="ls-best">Best ${r.best} · ${r.best - r.waves > 0 ? `${r.best - r.waves} short` : "tied your best"}</p>`;
    // the defender's hero of the run, fallen or standing
    const hero = chronicleOf(w).mvp()[s.defender];
    const mvp = hero ? `<div class="aar-mvps">${mvpCard(w, hero, opts.spectator ? "AI's MVP" : "Your MVP", "main")}</div>` : "";
    // career: XP for the waves held, Last Stand medals (ui/career.ts)
    const settled = opts.spectator ? null : settlementOf(w);
    const career = settled ? `<div class="ls-career">${careerBlockHtml(settled, "")}</div>` : "";
    endEl.hidden = false;
    endEl.innerHTML = `
      <div class="panel laststand-end${r.isNew ? " record" : ""}">
        <h1 class="${r.isNew ? "record" : "lose"}">${title}</h1>
        <p class="time">Last Stand · ${mapName} · ${diff} · ${fmtSecs(secs)}</p>
        <div class="ls-score"><b>${r.waves}</b><span>wave${r.waves === 1 ? "" : "s"} survived</span></div>
        ${bestLine}
        ${mvp}
        ${career}
        <table>
          <tr><td>Enemies destroyed</td><td>${st.unitsKilled}</td></tr>
          <tr><td>Units lost</td><td>${st.unitsLost}</td></tr>
          <tr><td>Buildings lost</td><td>${st.buildingsLost}</td></tr>
          <tr><td>Scrap harvested</td><td>${Math.floor(st.scrapHarvested)}</td></tr>
          <tr><td>Wave bonuses</td><td>${Math.floor(s.bonusEarned)}</td></tr>
        </table>
        <button id="again" class="cta">${opts.spectator ? "▶ Your turn" : "↻ Try again"}</button>
        <button id="menu" class="cta alt">Main menu</button>
      </div>`;
    endEl.querySelector("#again")!.addEventListener("click", onAgain);
    endEl.querySelector("#menu")!.addEventListener("click", onMenu);
    const careerEl = endEl.querySelector<HTMLElement>(".ls-career");
    if (careerEl && settled) mountCareerBlock(careerEl, settled, 700);
  }

  function pauseLine(): string {
    const diff = DIFF_LABEL[s.difficulty] ?? s.difficulty;
    return `Last Stand · ${diff}${best ? ` · best ${best.best} waves` : ""}`;
  }

  update();
  return { update, chip, drawMinimap, showEnd, pauseLine };
}
