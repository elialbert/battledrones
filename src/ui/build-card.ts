import { BUILDINGS, GOLIATH, UNITS } from "../sim/balance";
import { queuesOf, unitBlocker } from "../sim/economy";
import { unitCost } from "../sim/goliath";
import type { BuildingKind, UnitKind, World } from "../sim/types";
import { hasBuilding } from "../sim/world";
import { sfx } from "../game/audio";
import { PLAYER, type Controller } from "../game/controller";
import { iconUrl } from "../game/side-style";
import { GOLIATH_STRIP } from "./goliath-display";

interface BuildCardApi {
  world: World;
  ctrl: Controller;
  cardNote?(kind: UnitKind | BuildingKind): string | null;
}

/** Counter hints for the info card, distilled from the duel matrix (tools/balance.ts). */
const MATCHUPS: Partial<Record<UnitKind | BuildingKind, { strong: string; weak: string }>> = {
  harvester: { strong: "—", weak: "Everything. Guard it." },
  scout: { strong: "Spotting through the fog", weak: "Flak, Raptors, SAMs" },
  stinger: { strong: "Flak, Mortars, Lancers, Harvesters", weak: "Wasps, Mastodons, Hornets" },
  "flak-crawler": { strong: "All aircraft", weak: "Any ground unit" },
  mortar: { strong: "Buildings, clumped armies", weak: "Stingers up close, aircraft" },
  mastodon: { strong: "Stingers, Flak, Mortars", weak: "Rocket Squads, Lancers, Wasps" },
  lancer: { strong: "Mastodons, Goliaths, Flak, Raptors; crosses water", weak: "Stinger swarms, Hornets" },
  goliath: { strong: "Ground armies and bases; a walking base itself", weak: "Rocket Squads, Wasps, Lancers, Hornets" },
  wasp: { strong: "Stingers, Mastodons, Goliaths, Mortars", weak: "Flak, Raptors, Lancers" },
  raptor: { strong: "Wasps, Hornets, Scouts", weak: "Flak, Lancers, SAMs" },
  hornet: { strong: "Bases, Mastodons, Goliaths, clumps", weak: "Flak, Raptors, SAMs" },
  mender: { strong: "Keeps your army alive; the only repair a Goliath takes", weak: "Anything that shoots air" },
  trooper: { strong: "Rocket Squads, light raids; shoots air too", weak: "Snipers, Mortars, Hornets, Turrets" },
  "rocket-squad": { strong: "Mastodons, Goliaths, Hornets, heavy armour", weak: "Troopers, Snipers, Mortars" },
  sniper: { strong: "Infantry at long range; hides in woods", weak: "Stingers, Wasps, anything armoured" },
  condor: { strong: "Drops 2 squads anywhere, over water and rock", weak: "Flak, Raptors, SAMs" },
  turret: { strong: "Raids by ground or air, infantry", weak: "Mortars, Hornets" },
  "sam-site": { strong: "Aircraft at long range", weak: "Any ground unit" },
  "assembly-bay": { strong: "Cheap squads that hold woods and Uplinks", weak: "Splash: Mortars, Hornets" },
  gantry: { strong: "Builds Goliaths, the base that walks", weak: "Always in the enemy's sight; Mortars, Hornets" }
};

/** The build option's details and actions; the HUD owns placement and outside-click dismissal. */
export function createBuildCard(cardEl: HTMLElement, api: BuildCardApi, ui: { refresh(): void; toast(msg: string): void }) {
  const w = api.world;
  const icon = (kind: string) => iconUrl(kind, PLAYER);
  function showCard(kind: UnitKind | BuildingKind): void {
    const isUnit = kind in UNITS;
    const s = isUnit ? UNITS[kind as UnitKind] : BUILDINGS[kind as BuildingKind];
    const m = MATCHUPS[kind];
    const rows: string[] = [];
    // (a Goliath's price climbs with every one you have: the card shows today's)
    const cost = isUnit ? unitCost(w, PLAYER, kind as UnitKind) : s.cost;
    rows.push(`<tr><td>Cost</td><td>${cost}</td><td>HP</td><td>${s.hp}</td></tr>`);
    /** A Goliath's four weapon systems, in a table of their own after the cost. */
    let weapons = "";
    if (kind === "goliath") {
      rows.push(`<tr><td>Price</td><td colspan="3">+${Math.round(GOLIATH.costStep * 100)}% for each Goliath you have</td></tr>`);
      // four weapon systems instead of one: the longest reach goes first as it is hurt
      weapons = `<table class="gwt"><tr class="gw-head"><td>Weapon</td><td>Range</td><td></td></tr>${GOLIATH_STRIP.map(({ k }) => {
        const ws = GOLIATH.weapons[k];
        const off = ws.lostBelow > 0 ? `offline below ${Math.round(ws.lostBelow * 100)}%` : "always on";
        return `<tr><td>${ws.name}</td><td>${ws.range}</td><td>${off}${ws.targets === "both" ? " · air too" : ""}</td></tr>`;
      }).join("")}</table>`;
    } else if (s.dps > 0) {
      const tgt = s.targets === "both" ? "Air + Ground" : s.targets === "air" ? "Air" : "Ground";
      rows.push(`<tr><td>DPS</td><td>${s.dps}</td><td>Range</td><td>${s.range}</td></tr>`);
      rows.push(`<tr><td>Hits</td><td colspan="3">${tgt}${s.splash ? " · splash" : ""}${s.minRange ? ` · min range ${s.minRange}` : ""}</td></tr>`);
    }
    if (isUnit) {
      const u = UNITS[kind as UnitKind];
      rows.push(`<tr><td>Speed</td><td>${u.speed}</td><td>Armor</td><td>${u.armor}</td></tr>`);
      if (u.heal) rows.push(`<tr><td>Repair</td><td colspan="3">${u.heal} HP/s</td></tr>`);
      // a squad is one unit drawn as several robots; the Condor is a flying bus
      if (u.squad) rows.push(`<tr><td>Squad</td><td colspan="3">${u.squad} robots · firepower drops as they fall</td></tr>`);
      if (u.capacity) rows.push(`<tr><td>Cargo</td><td colspan="3">Carries ${u.capacity} squads · unarmed</td></tr>`);
      if (kind === "goliath") rows.push(`<tr><td>Repair</td><td colspan="3">Menders only</td></tr>`);
      rows.push(`<tr><td>Built at</td><td colspan="3">${BUILDINGS[u.builtAt].name}${u.requires ? ` + ${BUILDINGS[u.requires].name}` : ""}</td></tr>`);
    } else {
      const b = BUILDINGS[kind as BuildingKind];
      // every prerequisite, ticked off as it stands (the Gantry needs all four)
      if (b.requiresAll)
        rows.push(`<tr><td>Needs</td><td colspan="3" class="needs">${b.requiresAll
          .map((k) => (hasBuilding(w, PLAYER, k) ? `<span class="have">✓ ${BUILDINGS[k].name}</span>` : `<span>${BUILDINGS[k].name}</span>`))
          .join(" ")}</td></tr>`);
      if (b.unique) rows.push(`<tr><td>Limit</td><td colspan="3">One per side</td></tr>`);
    }
    const note = api.cardNote?.(kind) ?? null;
    const view = api.ctrl.view();
    const queuedHere = isUnit
      ? queuesOf(w, PLAYER, kind as UnitKind).reduce((n, p) => n + p.queue.filter((q) => q.kind === kind).length + view.extra(p.id, kind as UnitKind), 0)
      : 0;
    cardEl.innerHTML = `
      <div class="ch"><img src="${icon(kind)}" alt="" /><div><b>${s.name}</b><p>${s.role}</p></div>
      <button class="x" id="card-x">✕</button></div>
      ${weapons ? `<table>${rows.slice(0, 2).join("")}</table>${weapons}<table>${rows.slice(2).join("")}</table>` : `<table>${rows.join("")}</table>`}
      ${m ? `<p class="good">▲ ${m.strong}</p><p class="bad">▼ ${m.weak}</p>` : ""}
      ${note ? `<p class="ctr">⚔ ${note}</p>` : ""}
      ${isUnit && !api.ctrl.spectator ? `<button class="cta small" id="card-auto" aria-pressed="${api.ctrl.isAutoBuilding(kind as UnitKind)}">Autobuild: ${api.ctrl.isAutoBuilding(kind as UnitKind) ? "ON" : "OFF"}</button><p>Queues another when this type finishes, behind existing orders. Waits for scrap and queue space.</p>` : ""}
      ${queuedHere > 0 ? `<button class="cta small" id="card-cancel">Cancel one (${queuedHere} queued)</button>` : ""}
      ${!isUnit && view.pending?.kind === kind ? `<button class="cta small warn" id="card-cancel-b">Cancel construction</button>` : ""}`;
    cardEl.hidden = false;
    ui.refresh(); // (portrait: kept under the band at its real height)
    cardEl.querySelector("#card-x")!.addEventListener("click", () => (cardEl.hidden = true));
    cardEl.querySelector("#card-auto")?.addEventListener("click", () => {
      if (api.ctrl.locked) return;
      const unit = kind as UnitKind;
      if (!api.ctrl.isAutoBuilding(unit)) {
        const why = unitBlocker(w, PLAYER, unit);
        if (why) return ui.toast(why);
      }
      api.ctrl.toggleAutoBuild(unit);
      sfx.play("click");
      showCard(kind);
    });
    cardEl.querySelector("#card-cancel")?.addEventListener("click", () => {
      const now = api.ctrl.view();
      const p = queuesOf(w, PLAYER, kind as UnitKind).find((p) => p.queue.some((q) => q.kind === kind) || now.extra(p.id, kind as UnitKind) > 0);
      if (p) api.ctrl.enqueue({ type: "cancelProduce", faction: PLAYER, buildingId: p.id, unit: kind as UnitKind });
      cardEl.hidden = true;
    });
    cardEl.querySelector("#card-cancel-b")?.addEventListener("click", () => {
      api.ctrl.enqueue({ type: "cancelBuilding", faction: PLAYER });
      api.ctrl.placing = null;
      cardEl.hidden = true;
    });
  }

  return { show: showCard };
}
