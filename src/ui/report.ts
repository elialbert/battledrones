import { UNITS } from "../sim/balance";
import { mapById } from "../sim/maps";
import { POWER_KINDS, POWER_NAMES } from "../sim/powers";
import type { Faction, FactionStats, PerSide, World } from "../sim/types";
import {
  chronicleOf,
  commanderStory,
  fmtTime,
  moments as storyBeats,
  peakArmy,
  pickTip,
  type Chronicle,
  type HeroRec,
  type Moment,
  type Sample
} from "../game/chronicle";
import { callsignOf, killsLabel, stars } from "../game/heroes";
import { SIDE_NAME, iconUrl } from "../game/side-style";
import { DUO, isMulti, perSide, rivalsOf, sidesOf } from "../sim/sides";

/**
 * The after-action report: the end screen of a skirmish. It tells the
 * match's story from the chronicle — an army-strength timeline with the key
 * moments marked on it, the MVP unit, the stats (correct kill counts), and
 * one tip for next time; in spectator mode, both commanders' stories.
 *
 * Extension point: addReportSection() lets later features (career medals…)
 * add a block without touching this file's layout code.
 *
 * A sound duel's report (`opponent` set) names the sides You and Friend,
 * heads its line "vs your friend · <map> · <time> · over sound", and its tip
 * says nothing of difficulty or the AI; its own section (the record, the
 * link, the sync check) comes from src/versus through addReportSection. A
 * duel that ended with no result has no winner (null) and a head override.
 */

export interface ReportOpts {
  world: World;
  /** Who won, or "draw" (Robot Love: two enemy Goliaths fell in love, World.love); null: no result (a sound duel cut short, with `head`). */
  winner: Faction | "draw" | null;
  /** The local player's side (the report's point of view unless spectating). */
  pov: Faction;
  spectator: boolean;
  /** Match length in seconds. */
  secs: number;
  /** Spectator: every side's strategy name. */
  strategies: Partial<Record<Faction, string>> | null;
  enemy: { strategy: string; difficulty: string };
  onRematch(): void;
  onMenu(): void;
  /** Replace the VICTORY / DEFEAT headline (Ops: "OP COMPLETE", the op and its time). */
  head?: { title: string; cls: "win" | "lose"; sub: string };
  /** Extra buttons before Rematch (Ops: "Next op"), and Rematch's own label. */
  actions?: { id: string; label: string; cls?: string; on(): void }[];
  rematchLabel?: string;
  /** Extra buttons between Rematch and the menu (a sound duel: Save battle, Copy debug info). */
  after?: { id: string; label: string; cls?: string; on(): void }[];
  /** A sound duel: who the other side is ("your friend"), and how the phones were linked ("over sound"). */
  opponent?: string;
  via?: string;
  /** A four-player online battle: who played each side (a person's name, or the commander). */
  names?: Partial<Record<Faction, string>>;
}

export interface ReportContext extends ReportOpts {
  chronicle: Chronicle;
  won: boolean;
  mvp: Record<Faction, HeroRec | null>;
  moments: Moment[];
}

export interface ReportSection {
  id: string;
  /** Sort key: built-ins use head 0, chart 10, moments 20, MVP 30, stats 40, tip 50. */
  order: number;
  /** Which column in the two-column (landscape) layout. Default "right". */
  col?: "left" | "right";
  /** HTML for the section body, or null to skip it this match. */
  render(ctx: ReportContext): string | null;
  /** Wire up listeners after the section is in the DOM. */
  mount?(el: HTMLElement, ctx: ReportContext): void;
}

const extraSections: ReportSection[] = [];

/** Register an extra report block (e.g. a medal row). Returns an unregister function. */
export function addReportSection(s: ReportSection): () => void {
  extraSections.push(s);
  return () => {
    const i = extraSections.indexOf(s);
    if (i >= 0) extraSections.splice(i, 1);
  };
}

/** A portrait in its side's paint (the red, green and purple ones are shot from those models). */
const icon = iconUrl;
const short = (n: number) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
const sideName = (f: Faction, ctx: ReportOpts) =>
  ctx.spectator ? SIDE_NAME[f] : f === ctx.pov ? "You" : isMulti(ctx.world) ? SIDE_NAME[f] : ctx.opponent ? "Friend" : "Enemy";

/**
 * A free-for-all's finishing order: the winner first, then the sides knocked
 * out, last out first (World.out); sides still in at an undecided end share
 * the places after the winner's.
 */
export function placings(w: World): { faction: Faction; place: number }[] {
  const out = [...(w.out ?? [])].reverse().map((o) => o.faction);
  const left = sidesOf(w).filter((f) => !out.includes(f));
  const won = w.winner && w.winner !== "draw" ? [w.winner] : [];
  const rest = left.filter((f) => !won.includes(f));
  const rows: { faction: Faction; place: number }[] = [];
  for (const f of won) rows.push({ faction: f, place: 1 });
  for (const f of rest) rows.push({ faction: f, place: won.length + 1 });
  out.forEach((f, i) => rows.push({ faction: f, place: won.length + rest.length + i + 1 }));
  return rows;
}

const ordinal = (n: number) => `${n}${n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th"}`;

// ---------------------------------------------------------------- chart ---

const VB_W = 320;
const VB_H = 104;
const PLOT = { x0: 6, x1: 314, y0: 10, y1: 94 };

function valueAt(samples: Sample[], t: number, f: Faction): number {
  let best = samples[0]!;
  for (const s of samples) if (Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
  return best.army[f] ?? 0;
}

function chartHtml(ctx: ReportContext): string | null {
  const samples = ctx.chronicle.samples;
  if (samples.length < 3) return null;
  const T = Math.max(1, samples[samples.length - 1]!.t);
  const sides = sidesOf(ctx.world);
  const maxV = Math.max(1, ...samples.map((s) => Math.max(...sides.map((f) => s.army[f] ?? 0))));
  const x = (t: number) => PLOT.x0 + (t / T) * (PLOT.x1 - PLOT.x0);
  const y = (v: number) => PLOT.y1 - (v / maxV) * (PLOT.y1 - PLOT.y0);
  const pts = (f: Faction) => samples.map((s) => `${x(s.t).toFixed(1)},${y(s.army[f] ?? 0).toFixed(1)}`).join(" ");
  const area = (f: Faction) => `M${x(0).toFixed(1)},${PLOT.y1} L${pts(f).replace(/ /g, " L")} L${x(T).toFixed(1)},${PLOT.y1} Z`;
  // the reader's side draws on top
  const order: Faction[] = isMulti(ctx.world)
    ? [...sides.filter((f) => ctx.spectator || f !== ctx.pov), ...(ctx.spectator ? [] : [ctx.pov])]
    : !ctx.spectator && ctx.pov === "red" ? ["blue", "red"] : ["red", "blue"];
  const marks = ctx.moments
    .map((m, i) => {
      const mx = x(m.t);
      const top = Math.max(...sides.map((f) => valueAt(samples, m.t, f)));
      const my = Math.max(PLOT.y0 + 2, y(top) - 9);
      return `<g class="mk ${m.tone}" data-i="${i}">
        <line x1="${mx.toFixed(1)}" y1="${(my + 7).toFixed(1)}" x2="${mx.toFixed(1)}" y2="${PLOT.y1}" class="mk-stem"/>
        <circle cx="${mx.toFixed(1)}" cy="${my.toFixed(1)}" r="7.5" class="mk-dot"/>
        <text x="${mx.toFixed(1)}" y="${(my + 3.4).toFixed(1)}" class="mk-n">${i + 1}</text>
      </g>`;
    })
    .join("");
  const mid = fmtTime(T / 2);
  // (a replay's labels are its players' names, from a record that may have come from anywhere: escaped)
  const label = (f: Faction) => (ctx.spectator ? `${sideName(f, ctx)} · ${escapeHtml(ctx.strategies?.[f] ?? "")}` : sideName(f, ctx));
  // (four sides' areas would muddy each other: a free-for-all draws lines only)
  const areas = isMulti(ctx.world) ? "" : order.map((f) => `<path d="${area(f)}" fill="url(#aar-g${f === "blue" ? "b" : "r"})" class="area"/>`).join("");
  return `
    <div class="aar-legend">
      ${sides.map((f) => `<span class="lk ${f}"><i></i>${label(f)}</span>`).join("\n      ")}
      <span class="cap">Army strength</span>
    </div>
    <svg class="aar-svg" viewBox="0 0 ${VB_W} ${VB_H}" role="img"
      aria-label="Army strength over time for ${sides.length === 2 ? "both" : "every"} side${sides.length === 2 ? "s" : ""}, with ${ctx.moments.length} key moments marked">
      <defs>
        <linearGradient id="aar-gb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4c9dff" stop-opacity="0.32"/><stop offset="1" stop-color="#4c9dff" stop-opacity="0"/></linearGradient>
        <linearGradient id="aar-gr" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff7a6a" stop-opacity="0.28"/><stop offset="1" stop-color="#ff7a6a" stop-opacity="0"/></linearGradient>
      </defs>
      <line x1="${PLOT.x0}" y1="${PLOT.y1}" x2="${PLOT.x1}" y2="${PLOT.y1}" class="base"/>
      <line x1="${x(T / 2).toFixed(1)}" y1="${PLOT.y0}" x2="${x(T / 2).toFixed(1)}" y2="${PLOT.y1}" class="grid"/>
      ${areas}
      ${order.map((f) => `<polyline points="${pts(f)}" class="ln ${f}" pathLength="1"/>`).join("")}
      <line class="xh" x1="0" y1="${PLOT.y0 - 4}" x2="0" y2="${PLOT.y1}" visibility="hidden"/>
      ${sides.map((f) => `<circle class="xd ${f}" r="3.5" visibility="hidden"/>`).join("")}
      ${marks}
    </svg>
    <div class="aar-axis"><span>0:00</span><span>${mid}</span><span>${fmtTime(T)}</span></div>
    <p class="aar-readout">Tap or drag across the chart</p>`;
}

function mountChart(el: HTMLElement, ctx: ReportContext, select: (i: number | null) => void): void {
  const svg = el.querySelector<SVGSVGElement>(".aar-svg");
  const readout = el.querySelector<HTMLElement>(".aar-readout");
  if (!svg || !readout) return;
  const samples = ctx.chronicle.samples;
  const T = Math.max(1, samples[samples.length - 1]!.t);
  const sides = sidesOf(ctx.world);
  const maxV = Math.max(1, ...samples.map((s) => Math.max(...sides.map((f) => s.army[f] ?? 0))));
  const xh = svg.querySelector<SVGLineElement>(".xh")!;
  const dots = new Map(sides.map((f) => [f, svg.querySelector<SVGCircleElement>(`.xd.${f}`)!]));
  const toVb = (clientX: number) => {
    const r = svg.getBoundingClientRect();
    return ((clientX - r.left) / Math.max(1, r.width)) * VB_W;
  };
  const showSample = (vx: number) => {
    const t = ((vx - PLOT.x0) / (PLOT.x1 - PLOT.x0)) * T;
    let s = samples[0]!;
    for (const c of samples) if (Math.abs(c.t - t) < Math.abs(s.t - t)) s = c;
    const sx = PLOT.x0 + (s.t / T) * (PLOT.x1 - PLOT.x0);
    xh.setAttribute("x1", String(sx));
    xh.setAttribute("x2", String(sx));
    xh.setAttribute("visibility", "visible");
    for (const f of sides) {
      const dot = dots.get(f)!;
      dot.setAttribute("cx", String(sx));
      dot.setAttribute("cy", String(PLOT.y1 - ((s.army[f] ?? 0) / maxV) * (PLOT.y1 - PLOT.y0)));
      dot.setAttribute("visibility", "visible");
    }
    readout.innerHTML = `<b>${fmtTime(s.t)}</b>${sides
      .map((f) => `<span class="rk ${f}"><i></i><em>${short(s.army[f] ?? 0)}</em> ${sideName(f, ctx)}</span>`)
      .join("")}`;
    select(null);
  };
  const handle = (e: PointerEvent) => {
    const vx = toVb(e.clientX);
    // a moment marker within reach wins over the crosshair (≈ 40 px target)
    let hit: number | null = null;
    let bestD = 18;
    ctx.moments.forEach((m, i) => {
      const d = Math.abs(PLOT.x0 + (m.t / T) * (PLOT.x1 - PLOT.x0) - vx);
      if (d < bestD) {
        bestD = d;
        hit = i;
      }
    });
    if (hit !== null && e.type === "pointerdown") {
      xh.setAttribute("visibility", "hidden");
      for (const dot of dots.values()) dot.setAttribute("visibility", "hidden");
      const m = ctx.moments[hit]!;
      readout.innerHTML = `<b>${fmtTime(m.t)}</b> `;
      readout.append(`${m.title}: ${m.text}`);
      select(hit);
      return;
    }
    showSample(vx);
  };
  let down = false;
  svg.addEventListener("pointerdown", (e) => {
    down = true;
    handle(e);
  });
  svg.addEventListener("pointermove", (e) => {
    if (down || e.pointerType === "mouse") handle(e);
  });
  const up = () => (down = false);
  svg.addEventListener("pointerup", up);
  svg.addEventListener("pointercancel", up);
  svg.addEventListener("pointerleave", up);
}

// ------------------------------------------------------------- sections ---

/**
 * The report's headline: VICTORY / DEFEAT (a spectator: who won), or DRAW
 * when nobody did — Robot Love, whose lovers get a 💘 note — styled neither
 * as a win nor as a loss.
 */
export function headline(o: { winner: Faction | "draw" | null; pov: Faction; spectator: boolean; love: boolean }): {
  title: string;
  cls: "win" | "lose" | "draw";
  note: string | null;
} {
  if (o.winner === null) return { title: "NO RESULT", cls: "draw", note: null };
  if (o.winner === "draw") return { title: "DRAW", cls: "draw", note: o.love ? "💘 They fell in love" : null };
  if (o.spectator) return { title: `${SIDE_NAME[o.winner].toUpperCase()} WINS`, cls: o.winner === "blue" ? "win" : "lose", note: null };
  const won = o.winner === o.pov;
  return { title: won ? "VICTORY" : "DEFEAT", cls: won ? "win" : "lose", note: null };
}

function headHtml(ctx: ReportContext): string {
  if (ctx.head) return `<h1 class="${ctx.head.cls}">${escapeHtml(ctx.head.title)}</h1><p class="time">${escapeHtml(ctx.head.sub)}</p>`;
  const spec = ctx.spectator;
  const h = headline({ winner: ctx.winner, pov: ctx.pov, spectator: spec, love: !!ctx.world.love });
  // (a free-for-all first: an online one has an opponent too, its head is the placings)
  if (isMulti(ctx.world)) return headMultiHtml(ctx, h);
  if (ctx.opponent && !spec) {
    // (a sound duel: "vs your friend · Riverlands · 7:42 · over sound")
    const line = `vs ${ctx.opponent} · ${mapById(ctx.world.mapId).name} · ${fmtTime(ctx.secs)} · ${ctx.via ?? "over sound"}`;
    return `<h1 class="${h.cls}">${h.title}</h1><p class="time">${h.note ? `${h.note} · ` : ""}${escapeHtml(line)}</p>`;
  }
  const vs = spec
    ? escapeHtml(`${ctx.strategies?.blue ?? "Blue"} vs ${ctx.strategies?.red ?? "Red"}`)
    : `vs ${ctx.enemy.strategy} AI (${ctx.enemy.difficulty})`;
  return `<h1 class="${h.cls}">${h.title}</h1><p class="time">${h.note ? `${h.note} · ` : ""}${vs} · ${fmtTime(ctx.secs)}</p>`;
}

/** A free-for-all's head: the result, where you finished, the map and time, and every side's place. */
function headMultiHtml(ctx: ReportContext, h: { title: string; cls: string; note: string | null }): string {
  const rows = placings(ctx.world);
  const mine = rows.find((r) => r.faction === ctx.pov);
  const place = !ctx.spectator && mine && ctx.winner !== null ? `${ordinal(mine.place)} of ${rows.length}` : null;
  const line = [h.note, place, `${mapById(ctx.world.mapId).name} free\u2011for\u2011all`, fmtTime(ctx.secs), ctx.via].filter(Boolean).join(" · ");
  const named = (f: Faction) => (f !== ctx.pov || ctx.spectator ? ctx.names?.[f] : undefined);
  const who = (f: Faction) =>
    escapeHtml(
      ctx.spectator && ctx.strategies?.[f] ? `${SIDE_NAME[f]} · ${ctx.strategies[f]}` : named(f) ? `${SIDE_NAME[f]} · ${named(f)}` : sideName(f, ctx)
    );
  const list = rows
    .map((r) => `<li class="${r.faction === ctx.pov && !ctx.spectator ? "me" : ""}"><i class="${r.faction}"></i>${ordinal(r.place)} ${who(r.faction)}</li>`)
    .join("");
  return `<h1 class="${h.cls}">${h.title}</h1><p class="time">${escapeHtml(line)}</p><ol class="aar-placings">${list}</ol>`;
}

function momentsHtml(ctx: ReportContext): string | null {
  if (ctx.moments.length === 0) return null;
  return `<ol class="aar-moments">${ctx.moments
    .map(
      (m, i) => `<li class="${m.tone}" data-i="${i}"><b class="n">${i + 1}</b><div><span class="mt">${m.title} · ${fmtTime(m.t)}</span><span class="mx"></span></div></li>`
    )
    .join("")}</ol>`;
}

/** One unit card: icon, callsign, rank, kills, fate. */
export function mvpCard(w: World, h: HeroRec, tag: string, cls: string): string {
  const name = callsignOf(w, h);
  const fate = h.alive ? `<span class="fate alive">Survived</span>` : `<span class="fate fell">✝ Fell at ${fmtTime(h.diedAt ?? 0)}</span>`;
  return `<div class="mvp ${h.faction} ${cls}">
    <span class="mvp-tag">${tag}</span>
    <img src="${icon(h.kind, h.faction)}" alt="" draggable="false"/>
    <div class="mvp-t"><b>${h.rank > 0 ? `<span class="rank">${stars(h.rank)}</span> ` : ""}${name}</b>
      <span>${UNITS[h.kind].name} · ${killsLabel(h.kills)}</span>${fate}</div>
  </div>`;
}

/** The MVP row (also used by the Last Stand end screen). */
export function mvpRowHtml(w: World, mvp: Record<Faction, HeroRec | null>, pov: Faction, spectator: boolean): string | null {
  if (isMulti(w)) {
    // a free-for-all: yours (a spectator: the winner's) and the best of everyone else's
    const me: Faction = spectator ? (w.winner && w.winner !== "draw" ? w.winner : "blue") : pov;
    const best = rivalsOf(w, me)
      .map((f) => mvp[f])
      .filter((h): h is HeroRec => !!h)
      .sort((a, b) => b.kills - a.kills || b.rank - a.rank)[0];
    const cards: string[] = [];
    const mine = mvp[me];
    if (mine) cards.push(mvpCard(w, mine, spectator ? `${SIDE_NAME[me]} MVP` : "Your MVP", "main"));
    if (best) cards.push(mvpCard(w, best, `${SIDE_NAME[best.faction]}'s ace`, spectator ? "main" : "minor"));
    return cards.length ? `<div class="aar-mvps">${cards.join("")}</div>` : null;
  }
  const me = spectator ? "blue" : pov;
  const them: Faction = me === "blue" ? "red" : "blue";
  const cards: string[] = [];
  const mine = mvp[me];
  const theirs = mvp[them];
  if (mine) cards.push(mvpCard(w, mine, spectator ? "Blue MVP" : "Your MVP", "main"));
  if (theirs) cards.push(mvpCard(w, theirs, spectator ? "Red MVP" : "Their ace", spectator ? "main" : "minor"));
  return cards.length ? `<div class="aar-mvps">${cards.join("")}</div>` : null;
}

const KNOWN_STATS = new Set(["unitsBuilt", "unitsLost", "unitsKilled", "buildingsLost", "buildingsKilled", "scrapHarvested", "scrapSalvaged"]);
/** Friendly labels for stats other features may add to FactionStats. */
const EXTRA_LABELS: Record<string, string> = {
  scrapSalvaged: "Scrap salvaged",
  salvaged: "Scrap salvaged",
  salvage: "Salvage",
  bounty: "Bounty earned",
  bountyEarned: "Bounty earned",
  calldowns: "Calldowns used",
  calldownsUsed: "Calldowns used",
  drops: "Supply drops taken",
  dropsCaptured: "Supply drops taken",
  uplinkSeconds: "Uplink time (s)",
  aircraftKilled: "Aircraft downed",
  mastodonsKilled: "Mastodons destroyed",
  killsByBuildings: "Kills by defences"
};
const humanize = (k: string) => {
  const s = k.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** Numeric FactionStats fields beyond the core set, read defensively. */
export function extraStatRows(blue: FactionStats, red: FactionStats, max = 4): { label: string; a: number; b: number }[] {
  const A = blue as unknown as Record<string, unknown>;
  const B = red as unknown as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(A), ...Object.keys(B)])].filter((k) => !KNOWN_STATS.has(k));
  const rows: { label: string; a: number; b: number }[] = [];
  const seen = new Set<string>();
  for (const k of keys) {
    const a = typeof A[k] === "number" ? (A[k] as number) : 0;
    const b = typeof B[k] === "number" ? (B[k] as number) : 0;
    if (typeof A[k] !== "number" && typeof B[k] !== "number") continue;
    if (!Number.isFinite(a) || !Number.isFinite(b) || (a === 0 && b === 0)) continue;
    const label = EXTRA_LABELS[k] ?? humanize(k);
    if (seen.has(label)) continue;
    seen.add(label);
    rows.push({ label, a, b });
  }
  // known extras first, in the table's preferred order
  const rank = (l: string) => {
    const i = Object.values(EXTRA_LABELS).indexOf(l);
    return i < 0 ? 99 : i;
  };
  rows.sort((p, q) => rank(p.label) - rank(q.label));
  return rows.slice(0, max);
}

function statsHtml(ctx: ReportContext): string {
  if (isMulti(ctx.world)) return statsMultiHtml(ctx);
  const st = (f: Faction) => ctx.world.factions[f].stats;
  const p: Faction = ctx.spectator ? "blue" : ctx.pov;
  const q: Faction = p === "blue" ? "red" : "blue";
  const row = (label: string, a: number, b: number) => {
    const A = Math.floor(a);
    const B = Math.floor(b);
    return `<tr><td>${label}</td><td>${A}</td><td>${B}</td></tr>`;
  };
  const rows = [
    row("Units destroyed", st(p).unitsKilled, st(q).unitsKilled),
    row("Buildings destroyed", st(p).buildingsKilled ?? 0, st(q).buildingsKilled ?? 0),
    row("Units built", st(p).unitsBuilt, st(q).unitsBuilt),
    row("Units lost", st(p).unitsLost, st(q).unitsLost),
    row("Scrap harvested", st(p).scrapHarvested, st(q).scrapHarvested)
  ];
  // Goliaths (only when someone fielded one: most matches never get that far)
  const gol = goliathsFielded(ctx.chronicle);
  if (gol.blue + gol.red > 0) rows.splice(3, 0, row("Goliaths fielded", gol[p] ?? 0, gol[q] ?? 0));
  // battlefield salvage and calldowns (not every mode has them: rows only when something happened)
  const salv = (f: Faction) => st(f).scrapSalvaged ?? 0;
  if (salv(p) + salv(q) > 0) rows.push(row("Scrap salvaged", salv(p), salv(q)));
  const calls = calldownCounts(ctx.world);
  if (calls.blue.total + calls.red.total > 0)
    rows.push(
      `<tr title="${escapeHtml(`${calldownBreakdown(calls[p].by)} · ${calldownBreakdown(calls[q].by)}`)}"><td>Calldowns</td><td>${calls[p].total}</td><td>${calls[q].total}</td></tr>`
    );
  // map objectives (skirmish only): Uplinks captured, crates claimed, scrap they paid
  const obj = ctx.world.objectives;
  if (obj && obj.uplinks.length > 0) {
    const os = (f: Faction) => obj.stats[f];
    rows.push(row("Uplinks captured", os(p).captures, os(q).captures));
    rows.push(row("Crates claimed", os(p).crates, os(q).crates));
    rows.push(row("Objective scrap", os(p).uplinkScrap + os(p).crateScrap, os(q).uplinkScrap + os(q).crateScrap));
  }
  rows.push(row("Peak army", peakArmy(ctx.chronicle.samples, p), peakArmy(ctx.chronicle.samples, q)));
  const ex = extraStatRows(st("blue"), st("red"));
  for (const r of ex) rows.push(row(r.label, p === "blue" ? r.a : r.b, p === "blue" ? r.b : r.a));
  return `<table class="aar-stats">
    <tr><th></th><th class="hb"><i class="${p}"></i>${sideName(p, ctx)}</th><th class="hb"><i class="${q}"></i>${sideName(q, ctx)}</th></tr>
    ${rows.join("")}</table>`;
}

/** A free-for-all's stats: a column per side, yours first (a spectator's in side order). */
function statsMultiHtml(ctx: ReportContext): string {
  const w = ctx.world;
  const sides = ctx.spectator ? [...sidesOf(w)] : [ctx.pov, ...rivalsOf(w, ctx.pov)];
  const st = (f: Faction) => w.factions[f].stats;
  const row = (label: string, v: (f: Faction) => number) => `<tr><td>${label}</td>${sides.map((f) => `<td>${Math.floor(v(f))}</td>`).join("")}</tr>`;
  const rows = [
    row("Units destroyed", (f) => st(f).unitsKilled),
    row("Buildings destroyed", (f) => st(f).buildingsKilled ?? 0),
    row("Units built", (f) => st(f).unitsBuilt),
    row("Units lost", (f) => st(f).unitsLost),
    row("Scrap harvested", (f) => st(f).scrapHarvested)
  ];
  const gol = goliathsFielded(ctx.chronicle);
  if (sides.some((f) => (gol[f] ?? 0) > 0)) rows.splice(3, 0, row("Goliaths fielded", (f) => gol[f] ?? 0));
  if (sides.some((f) => (st(f).scrapSalvaged ?? 0) > 0)) rows.push(row("Scrap salvaged", (f) => st(f).scrapSalvaged ?? 0));
  const calls = calldownCounts(w);
  if (sides.some((f) => calls[f].total > 0)) rows.push(row("Calldowns", (f) => calls[f].total));
  if (w.objectives?.uplinks.length) {
    const os = (f: Faction) => w.objectives.stats[f];
    rows.push(row("Uplinks captured", (f) => os(f).captures));
    rows.push(row("Crates claimed", (f) => os(f).crates));
  }
  rows.push(row("Peak army", (f) => peakArmy(ctx.chronicle.samples, f)));
  const head = sides.map((f) => `<th class="hb"><i class="${f}"></i>${sideName(f, ctx)}</th>`).join("");
  return `<table class="aar-stats multi"><tr><th></th>${head}</tr>${rows.join("")}</table>`;
}

/** Goliaths each side playing fielded this match: those it started with (Nomads) and those that walked off a Gantry. */
export function goliathsFielded(c: Pick<Chronicle, "built"> & Partial<Pick<Chronicle, "startGoliaths" | "sides">>): PerSide<number> {
  const start = c.startGoliaths;
  return Object.fromEntries((c.sides ?? DUO).map((f) => [f, (start?.[f] ?? 0) + (c.built[f]?.["goliath"] ?? 0)])) as PerSide<number>;
}

/** Calldowns fired per side (World.powers.fired), with the per-power counts. */
export function calldownCounts(w: World): Record<Faction, { total: number; by: [string, number][] }> {
  const one = (f: Faction) => {
    const fired = w.powers?.fired?.[f];
    const by = POWER_KINDS.map((k) => [POWER_NAMES[k], fired?.[k] ?? 0] as [string, number]).filter(([, n]) => n > 0);
    return { total: by.reduce((s, [, n]) => s + n, 0), by };
  };
  return perSide(one);
}

const calldownBreakdown = (by: [string, number][]) => (by.length ? by.map(([k, n]) => `${n} ${k}`).join(", ") : "none");

function tipHtml(ctx: ReportContext): string | null {
  if (ctx.spectator) {
    // both commanders' story instead of a tip
    const line = (f: Faction) =>
      `<p><i class="${f}"></i><span>${escapeHtml(
        commanderStory(ctx.chronicle, ctx.world, f, `${SIDE_NAME[f]} · ${ctx.strategies?.[f] ?? ""}`)
      )}</span></p>`;
    return `<div class="aar-story">${sidesOf(ctx.world).map(line).join("")}</div>`;
  }
  if (ctx.world.ops) return null; // an op's section shows its own tip and the stars still to earn
  if (ctx.winner === null) return null; // (no result: nothing was decided to learn from)
  const c = ctx.chronicle;
  const duel = !!ctx.opponent;
  let tip = pickTip({
    pov: ctx.pov, won: ctx.won, duration: ctx.secs, difficulty: duel ? "" : ctx.enemy.difficulty.toLowerCase(),
    built: c.built, firstBuilt: c.firstBuilt, deaths: c.deaths, samples: c.samples, factories: c.factories,
    startGoliaths: c.startGoliaths, rivals: rivalsOf(ctx.world, ctx.pov)
  });
  // (a duel's congratulations: there is no harder AI to try)
  if (duel && /\bAI\b/.test(tip))
    tip = ctx.won ? "A clean win. Swap sides and see if you can do it again." : "Scout early and build counters: long-press any build button to see what beats what.";
  return `<p class="aar-tip"><b>Next time</b><span>${escapeHtml(tip)}</span></p>`;
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);

// ----------------------------------------------------------------- show ---

export function showReport(endEl: HTMLElement, o: ReportOpts): void {
  const chronicle = chronicleOf(o.world);
  chronicle.finish();
  const ctx: ReportContext = {
    ...o,
    chronicle,
    won: !o.spectator && o.winner === o.pov,
    mvp: chronicle.mvp(),
    moments: storyBeats(chronicle, o.spectator ? null : o.pov)
  };
  const builtIn: ReportSection[] = [
    { id: "chart", order: 10, col: "left", render: chartHtml },
    { id: "moments", order: 20, col: "left", render: momentsHtml },
    { id: "mvp", order: 30, render: (c: ReportContext) => mvpRowHtml(c.world, c.mvp, c.pov, c.spectator) },
    { id: "stats", order: 40, render: statsHtml },
    { id: "tip", order: 50, render: tipHtml }
  ];
  const sections = [...builtIn, ...extraSections].sort((a, b) => a.order - b.order);

  const rendered: { s: ReportSection; html: string }[] = [];
  for (const s of sections) {
    let html: string | null = null;
    try {
      html = s.render(ctx);
    } catch (e) {
      console.warn("report section failed:", s.id, e);
    }
    if (html) rendered.push({ s, html });
  }
  let delay = 120;
  const block = (r: { s: ReportSection; html: string }) => {
    delay += 110;
    return `<section class="aar-sec sec-${r.s.id}" data-id="${r.s.id}" style="--d:${delay}ms">${r.html}</section>`;
  };
  const left = rendered.filter((r) => r.s.col === "left").map(block).join("");
  const right = rendered.filter((r) => r.s.col !== "left").map(block).join("");
  endEl.hidden = false;
  const button = (a: { id: string; label: string; cls?: string }) => `<button id="${a.id}" class="cta ${a.cls ?? ""}">${escapeHtml(a.label)}</button>`;
  endEl.innerHTML = `
    <div class="panel aar ${ctx.spectator ? "spec" : ctx.winner === "draw" || ctx.winner === null ? "draw" : ctx.won ? "won" : "lost"}">
      <header class="aar-sec aar-head" style="--d:0ms">${headHtml(ctx)}</header>
      <div class="aar-cols"><div class="aar-col l">${left}</div><div class="aar-col r">${right}</div></div>
      <div class="aar-actions${o.actions?.length || o.after?.length ? " more" : ""}">
        ${(o.actions ?? []).map(button).join("")}
        <button id="again" class="cta${o.actions?.length ? " alt" : ""}">${escapeHtml(o.rematchLabel ?? "↻ Rematch")}</button>
        ${(o.after ?? []).map(button).join("")}
        <button id="menu" class="cta alt">Main menu</button>
      </div>
    </div>`;
  // moment texts may carry callsigns or names: set as text, not markup
  endEl.querySelectorAll<HTMLElement>(".aar-moments li").forEach((li) => {
    const m = ctx.moments[Number(li.dataset.i)];
    const mx = li.querySelector<HTMLElement>(".mx");
    if (m && mx) mx.textContent = m.text;
  });
  const select = (i: number | null) => {
    endEl.querySelectorAll<HTMLElement>(".aar-moments li").forEach((li) => li.classList.toggle("on", Number(li.dataset.i) === i));
    endEl.querySelectorAll<SVGGElement>(".aar-svg .mk").forEach((g) => g.classList.toggle("on", Number(g.dataset.i) === i));
  };
  const chartEl = endEl.querySelector<HTMLElement>(".sec-chart");
  if (chartEl) mountChart(chartEl, ctx, select);
  endEl.querySelectorAll<HTMLElement>(".aar-moments li").forEach((li) =>
    li.addEventListener("click", () => {
      const i = Number(li.dataset.i);
      select(li.classList.contains("on") ? null : i);
    })
  );
  for (const r of rendered) {
    const el = endEl.querySelector<HTMLElement>(`.aar-sec[data-id="${r.s.id}"]`);
    if (el && r.s.mount) r.s.mount(el, ctx);
  }
  for (const a of [...(o.actions ?? []), ...(o.after ?? [])]) endEl.querySelector(`#${a.id}`)?.addEventListener("click", a.on);
  endEl.querySelector("#again")!.addEventListener("click", o.onRematch);
  endEl.querySelector("#menu")!.addEventListener("click", o.onMenu);
}
