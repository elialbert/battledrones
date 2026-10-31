import { BUILDINGS, GOLIATH, TICK_RATE, UNITS } from "../sim/balance";
import { weaponReady } from "../sim/goliath";
import { isTransport, squadAlive, squadSize } from "../sim/infantry";
import { liftedBy } from "../sim/lift";
import { goliathBase } from "../sim/rules";
import type { Faction, GoliathWeapon, QueueItem, Unit, UnitKind, World } from "../sim/types";
import { sfx } from "../game/audio";
import { PLAYER, isProducer, type Controller } from "../game/controller";
import { NAMED_RANK, heroLine, killsLabel, stars } from "../game/heroes";
import { iconUrl as icon } from "../game/side-style";
import { GOLIATH_STRIP, goliathMode } from "./goliath-display";

/** One weapon system's state: firing, held (grounded to its machine guns on a lift), rebooting or offline. */
function weaponState(u: Unit, k: GoliathWeapon): "on" | "held" | "boot" | "off" {
  const ws = u.goliath!.weapons[k];
  if (ws.online) return weaponReady(u, k) ? "on" : "held";
  return ws.reboot >= 0 ? "boot" : "off";
}

/** A Condor's seats for the selection panel: a portrait (and robots standing) per squad aboard, dashed empty seats. */
function cargoHtml(c: Unit): string {
  const seats = (c.passengers ?? []).map(
    (p) => `<span class="seat" title="${UNITS[p.kind].name}"><img src="${icon(p.kind, c.faction)}" alt=""/><b>${squadAlive(p)}</b></span>`
  );
  for (let i = seats.length; i < (UNITS[c.kind].capacity ?? 0); i++) seats.push(`<span class="seat empty"></span>`);
  return `<div class="cargo">${seats.join("")}</div>`;
}

/** Cache panel structure separately from HP/progress so queue taps survive frame updates. */
export function createSelectionPanel(selEl: HTMLElement, api: { world: World; ctrl: Controller }) {
  const w = api.world;
  const mine = (k: string) => [...w.buildings.values()].some((b) => b.faction === PLAYER && b.kind === k);
  let lastSelKey = "";
  /**
   * What ticks between rebuilds, updated in place: a building's or a
   * Goliath's HP, its head queue item's progress bar, a Goliath digging in
   * or packing up.
   */
  let selHpEl: HTMLElement | null = null;
  let selHeadEl: HTMLElement | null = null;
  let selModeEl: HTMLElement | null = null;
  type Live = { hp: string; head: string; mode?: string };

  /** A producer's queue as cancel buttons (`p`: the building's or anchored Goliath's id, on side `f`). */
  const queueHtml = (p: number, q: readonly QueueItem[], f: Faction) =>
    `<div class="queue">${q
      .map((it) => `<button class="qi" data-p="${p}" data-kind="${it.kind}"><img src="${icon(it.kind, f)}" alt=""/><span class="qp" style="height:0%"></span></button>`)
      .join("")}</div>`;
  /** How far the head of a queue is (a CSS height). */
  const headShare = (q: readonly QueueItem[]) => {
    const head = q[0];
    return `${Math.round((head ? 1 - head.remaining / (UNITS[head.kind].buildTime * TICK_RATE) : 0) * 100)}%`;
  };

  /**
   * One Goliath's panel: its mode (and progress), its weapon systems (firing,
   * held on a lift, rebooting or offline), HP and, ours and anchored, its
   * training queue with cancel buttons. Rebuilt only when that structure
   * changes (HP and progress tick in place), so a tap on the queue isn't lost.
   * The enemy's, or any to a spectator: information only.
   */
  function goliathPanel(u: Unit): { key: string; html: string; live: Live } {
    const g = u.goliath!;
    const st = UNITS[u.kind];
    const own = u.faction === PLAYER && !api.ctrl.spectator;
    const states = GOLIATH_STRIP.map(({ k }) => weaponState(u, k));
    const mode = g.lift ? g.lift.phase : g.mode;
    const key = `g${u.id}:${mode}:${states.join(",")}:${g.queue.map((q) => q.kind).join(",")}:${u.rank}:${u.kills}:${own}`;
    const title = `${st.name}${u.rank ? ` <span class="rank">${stars(u.rank)}</span>` : ""}${u.kills ? ` · ${killsLabel(u.kills)}` : ""}`;
    const said = { on: "firing", held: "held on the lift", boot: "rebooting", off: "offline" };
    const strip = GOLIATH_STRIP.map(
      ({ k, short }, i) => `<span class="gw ${states[i]}" title="${GOLIATH.weapons[k].name}: ${said[states[i]!]}">${short}</span>`
    ).join("");
    // ours, anchored: it trains squads, and under Nomads or Goliath Armada Harvesters too (a queue that
    // stopped when it packed up stays cancellable)
    const train = !own
      ? ""
      : g.queue.length > 0
        ? queueHtml(u.id, g.queue, u.faction)
        : g.mode === "anchored" && !g.lift
          ? `<span class="hint">${goliathBase(w) ? "Trains Harvesters and squads" : "Trains squads"} · tap the map to rally</span>`
          : "";
    const live: Live = { hp: `${Math.ceil(u.hp)} / ${st.hp}`, head: headShare(g.queue), mode: goliathMode(u) };
    // (short landscape screens put the name and the HP line side by side: style.css)
    const html = `<img class="pi" src="${icon(u.kind, u.faction)}" alt=""/><div class="pt"><div class="ghead"><b>${title}</b>
      <span class="gline"><span class="hp">${live.hp}</span><span class="gmode">${live.mode}</span></span></div>
      <span class="gweap">${strip}</span>${train}</div>`;
    return { key, html, live };
  }

  function renderSelection(): void {
    const ctrl = api.ctrl;
    let html = "";
    let key = "";
    let live: Live | null = null;
    if (ctrl.selectedBuilding !== null) {
      const b = w.buildings.get(ctrl.selectedBuilding);
      if (b) {
        const st = BUILDINGS[b.kind];
        // rebuilt only when the queue itself changes: HP and progress tick in
        // place below, so a tap on a queue button (cancel) isn't lost to a rebuild
        key = `b${b.id}:${b.queue.map((x) => x.kind).join(",")}`;
        live = { hp: `${Math.ceil(b.hp)} / ${st.hp}`, head: headShare(b.queue) };
        // producers say how to set a rally point here (it used to be a chip; the row needs the room);
        // an outpost (built in a Goliath's ring) that it doesn't count as base
        const rally = isProducer(b.kind);
        const note = b.outpost
          ? "Outpost: doesn't extend build range"
          : rally && !ctrl.spectator ? "Tap the map to set a rally point" : st.role;
        html = `<img class="pi" src="${icon(b.kind, b.faction)}" alt=""/><div class="pt"><b>${st.name}${b.outpost ? ' <span class="outpost">· Outpost</span>' : ""}</b>
          <span class="hp">${Math.ceil(b.hp)} / ${st.hp}</span>
          ${b.queue.length ? queueHtml(b.id, b.queue, b.faction) : `<span class="hint">${note}</span>`}</div>`;
      }
    } else if (ctrl.selectedUnits.size > 0) {
      const counts = new Map<UnitKind, number>();
      /** Squads riding in the selected Condors, by kind. */
      const aboard = new Map<UnitKind, number>();
      /** Whose they are (a selection is one side's). */
      let side: Faction = PLAYER;
      for (const id of ctrl.selectedUnits) {
        const u = w.units.get(id);
        if (!u) continue;
        side = u.faction;
        counts.set(u.kind, (counts.get(u.kind) ?? 0) + 1);
        for (const p of u.passengers ?? []) aboard.set(p.kind, (aboard.get(p.kind) ?? 0) + 1);
      }
      key = `u:${side}:${[...counts].map(([k, n]) => k + n).join(",")}|${[...aboard].map(([k, n]) => k + n).join(",")}`;
      if (ctrl.selectedUnits.size === 1) {
        const u = w.units.get([...ctrl.selectedUnits][0]!);
        if (u?.goliath) ({ key, html, live } = goliathPanel(u));
        else if (u) {
          // a Condor on a lift shows the Goliath it carries
          const lifting = liftedBy(w, u);
          key += `:${Math.round(u.hp)}:${u.rank}:${u.kills}:${(u.passengers ?? []).map((p) => `${p.id}/${squadAlive(p)}`).join(",")}:${lifting?.goliath!.lift!.phase ?? ""}`;
          const st = UNITS[u.kind];
          // veterans earn a callsign: "★★ Viper · Lancer · 9 kills"
          const title =
            u.rank >= NAMED_RANK
              ? heroLine(w, u).replace(/^(★+)/, '<span class="rank">$1</span>')
              : `${st.name}${u.rank ? ` <span class="rank">${stars(u.rank)}</span>` : ""}${u.kills ? ` · ${killsLabel(u.kills)}` : ""}`;
          // a squad counts its robots still standing ("4/5 robots")
          const n = squadSize(u.kind);
          const robots = n > 1 ? `<span class="robots"> · ${squadAlive(u)}/${n} robots</span>` : "";
          // a Condor shows who is aboard, seat by seat, instead of its role line (or the Goliath it lifts)
          const transport = isTransport(u.kind);
          const empty =
            mine("gantry") || [...w.units.values()].some((o) => o.goliath && o.faction === PLAYER)
              ? `<span class="hint">Empty: tap a squad to load it</span><span class="hint">Select two and tap a Goliath to lift it</span>`
              : `<span class="hint">Empty: tap a squad to load it</span>`;
          const how = u.faction === PLAYER && !ctrl.spectator;
          const hint = lifting
            ? lifting.goliath!.lift!.phase === "hooking"
              ? `<span class="hint">Hooking onto a Goliath</span>`
              : `<span class="hint">Carrying a Goliath</span>${how ? `<span class="hint">Long-press the map to set it down</span>` : ""}`
            : transport
              ? (u.passengers?.length ?? 0) > 0 || ctrl.spectator ? "" : empty
              : `<span class="hint">${st.role}</span>`;
          const hold = lifting
            ? `<div class="cargo"><span class="seat lift" title="Goliath"><img src="${icon("goliath", u.faction)}" alt=""/></span></div>`
            : transport ? cargoHtml(u) : "";
          html = `<img class="pi" src="${icon(u.kind, u.faction)}" alt=""/><div class="pt"><b class="${u.rank >= NAMED_RANK ? "hero" : ""}">${title}</b>
            <span class="hp">${Math.ceil(u.hp)} / ${st.hp}${robots}</span>${hint}</div>${hold}`;
        }
      } else {
        html = `<div class="group">${[...counts]
          .map(([k, n]) => `<span class="gi"><img src="${icon(k, side)}" alt=""/><b>${n}</b></span>`)
          .join("")}${[...aboard]
          .map(([k, n]) => `<span class="gi aboard" title="Aboard a Condor"><img src="${icon(k, side)}" alt=""/><b>${n}</b></span>`)
          .join("")}</div>`;
      }
    }
    if (key !== lastSelKey) {
      lastSelKey = key;
      selEl.hidden = html === "";
      selEl.innerHTML = html;
      selHpEl = live ? selEl.querySelector<HTMLElement>(".hp") : null;
      selHeadEl = live ? selEl.querySelector<HTMLElement>(".qi .qp") : null;
      selModeEl = live?.mode !== undefined ? selEl.querySelector<HTMLElement>(".gmode") : null;
      // (each button names its producer: a building, or an anchored Goliath)
      selEl.querySelectorAll<HTMLButtonElement>(".qi").forEach((el) =>
        el.addEventListener("click", () => {
          if (ctrl.spectator) return;
          ctrl.enqueue({
            type: "cancelProduce", faction: PLAYER, buildingId: Number(el.dataset.p), unit: el.dataset.kind as UnitKind
          });
          sfx.play("sell", 0.5);
        })
      );
    }
    if (live) {
      if (selHpEl && selHpEl.textContent !== live.hp) selHpEl.textContent = live.hp;
      if (selHeadEl && selHeadEl.style.height !== live.head) selHeadEl.style.height = live.head;
      if (selModeEl && live.mode !== undefined && selModeEl.textContent !== live.mode) selModeEl.textContent = live.mode;
    }
  }

  return { update: renderSelection };
}
