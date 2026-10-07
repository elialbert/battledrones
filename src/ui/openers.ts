import { BUILDINGS, UNITS } from "../sim/balance";
import { OPENERS, OPENER_IDS, type OpenerId } from "../sim/openers";
import type { UnitKind } from "../sim/types";
import { sfx } from "../game/audio";

/**
 * The pre-match opener choice: three big cards over the (frozen) battlefield.
 * The sim does not tick until a card is picked, so the clock starts with
 * the decision. Tap a card, or press 1 / 2 / 3.
 */
export interface OpenerPickerOptions {
  /** Small context line under the title, e.g. "Riverlands · vs Rush AI (Normal)". */
  context: string;
  onPick(id: OpenerId): void;
  /** Why an opener is unavailable this match (e.g. a mutator bans its factory), or null. */
  blocked?(id: OpenerId): string | null;
}

const ICON = (kind: string) => `assets/icons/${kind}.webp`;

/** What each card promises, as icon pills. */
function pills(id: OpenerId): string {
  const o = OPENERS[id];
  const items: { icon?: string; label: string; cls?: string }[] = [{ icon: o.building, label: BUILDINGS[o.building].name }];
  const counts = new Map<UnitKind, number>();
  for (const k of o.units) counts.set(k, (counts.get(k) ?? 0) + 1);
  for (const [k, n] of counts) items.push({ icon: k, label: `${n} ${UNITS[k].name}s` });
  items.push({ icon: "harvester", label: `${o.harvesters} Harvesters` });
  if (o.scrap > 0) items.push({ label: `+${o.scrap} scrap` });
  if (o.scrap < 0) items.push({ label: `−${-o.scrap} scrap`, cls: "neg" });
  return items
    .map(
      (it) =>
        `<span class="op-pill ${it.cls ?? ""}">${it.icon ? `<img src="${ICON(it.icon)}" alt="" draggable="false"/>` : `<i>⚙</i>`}${it.label}</span>`
    )
    .join("");
}

/** The hero image cluster: the building with its units stacked in front. */
function art(id: OpenerId): string {
  const o = OPENERS[id];
  const unit = o.units[0] ?? "harvester";
  const n = o.units.length || o.harvesters;
  return `<div class="op-art">
      <img class="op-b" src="${ICON(o.building)}" alt="" draggable="false"/>
      <img class="op-u" src="${ICON(unit)}" alt="" draggable="false"/>
      <span class="op-n">×${n}</span>
    </div>`;
}

export function showOpenerPicker(opts: OpenerPickerOptions): { destroy(): void } {
  const root = document.getElementById("hud")!;
  const el = document.createElement("div");
  el.className = "openers";
  el.innerHTML = `
    <button class="op-back" title="Back to the menu">‹ Menu</button>
    <div class="op-head">
      <h2>Choose your opener</h2>
      <p class="op-ctx"></p>
    </div>
    <div class="op-cards">
      ${OPENER_IDS.map(
        (id, i) => `
        <button class="op-card op-${id}" data-id="${id}">
          ${art(id)}
          <div class="op-text">
            <b class="op-name">${OPENERS[id].name}</b>
            <span class="op-tag">${OPENERS[id].tagline}</span>
            <div class="op-pills">${pills(id)}</div>
          </div>
          <span class="op-key">${i + 1}</span>
        </button>`
      ).join("")}
    </div>
    <p class="op-foot">The clock starts when you choose. The enemy picks too.</p>`;
  el.querySelector(".op-ctx")!.textContent = opts.context;
  // keep touches on the overlay away from the game canvas underneath
  el.addEventListener("pointerdown", (e) => e.stopPropagation());
  root.appendChild(el);

  let picked = false;
  let timer = 0;
  const pick = (id: OpenerId) => {
    if (picked) return;
    picked = true;
    sfx.unlock();
    sfx.play("ready");
    el.classList.add("chosen");
    el.querySelectorAll<HTMLElement>(".op-card").forEach((c) => c.classList.toggle("picked", c.dataset.id === id));
    // let the pick register visually, then start the match as the cards fade
    timer = window.setTimeout(() => {
      opts.onPick(id);
      el.classList.add("out");
      timer = window.setTimeout(destroy, 320);
    }, 380);
  };
  el.querySelector(".op-back")!.addEventListener("click", () => window.location.reload());
  el.querySelectorAll<HTMLButtonElement>(".op-card").forEach((b) => {
    const why = opts.blocked?.(b.dataset.id as OpenerId);
    if (why) {
      b.disabled = true;
      b.classList.add("blocked");
      b.querySelector(".op-tag")!.textContent = why;
      return;
    }
    b.addEventListener("click", () => pick(b.dataset.id as OpenerId));
  });
  const onKey = (e: KeyboardEvent) => {
    const i = Number(e.key) - 1;
    if (i >= 0 && i < OPENER_IDS.length && !opts.blocked?.(OPENER_IDS[i]!)) pick(OPENER_IDS[i]!);
  };
  window.addEventListener("keydown", onKey);

  function destroy(): void {
    window.clearTimeout(timer);
    window.removeEventListener("keydown", onKey);
    el.remove();
  }
  return { destroy };
}
