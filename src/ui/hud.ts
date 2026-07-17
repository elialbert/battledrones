import type Phaser from "phaser";
import { BUILDINGS, TICK_RATE, UNITS } from "../sim/balance";
import { Vis } from "../sim/fog";
import { Terrain, type BuildingKind, type Faction, type UnitKind, type World } from "../sim/types";
import type { Controller } from "../game/controller";
import { PLAYER } from "../game/controller";

export interface HudApi {
  world: World;
  ctrl: Controller;
  camera: Phaser.Cameras.Scene2D.Camera;
  centerCamera(wx: number, wy: number): void;
  zoomBy(factor: number): void;
  matchSeconds(): number;
  /** Spectator mode: the two AI strategy names, else null. */
  strategies: { blue: string; red: string } | null;
}

export interface Hud {
  update(): void;
  showEnd(winner: Faction): void;
  destroy(): void;
}

const BUILDABLE: { kind: BuildingKind; label: string }[] = [
  { kind: "fab-plant", label: "Fab" },
  { kind: "airpad", label: "Airpad" },
  { kind: "turret", label: "Turret" }
];

const TRAINABLE: { kind: UnitKind; label: string }[] = [
  { kind: "harvester", label: "Harv" },
  { kind: "stinger", label: "Sting" },
  { kind: "flak-crawler", label: "Flak" },
  { kind: "scout", label: "Scout" },
  { kind: "wasp", label: "Wasp" },
  { kind: "raptor", label: "Raptor" }
];

const MINIMAP_TILE = 3;

export function createHud(api: HudApi): Hud {
  const root = document.getElementById("hud")!;
  root.innerHTML = `
    <div class="topbar">
      <div id="scrap" class="scrap">⚙ 0</div>
    </div>
    <div id="versus" class="versus" hidden></div>
    <button id="fog-toggle" class="dbg" title="Debug: toggle fog of war">FOG ON</button>
    <canvas id="minimap"></canvas>
    <div class="chips">
      <button id="chip-stop" class="chip" hidden>■ Stop</button>
      <button id="chip-cancel" class="chip warn" hidden>✕ Cancel</button>
    </div>
    <div class="zoombtns">
      <button id="zoom-in" class="zb" title="Zoom in (+)">＋</button>
      <button id="zoom-out" class="zb" title="Zoom out (−)">−</button>
    </div>
    <div class="buildbar">
      <div class="group" id="grp-buildings"></div>
      <div class="sep"></div>
      <div class="group" id="grp-units"></div>
    </div>
    <div id="endscreen" class="screen" hidden></div>
  `;

  const scrapEl = root.querySelector<HTMLElement>("#scrap")!;
  const stopChip = root.querySelector<HTMLButtonElement>("#chip-stop")!;
  const cancelChip = root.querySelector<HTMLButtonElement>("#chip-cancel")!;
  const grpBuildings = root.querySelector<HTMLElement>("#grp-buildings")!;
  const grpUnits = root.querySelector<HTMLElement>("#grp-units")!;
  const endEl = root.querySelector<HTMLElement>("#endscreen")!;
  const minimap = root.querySelector<HTMLCanvasElement>("#minimap")!;
  minimap.width = api.world.width * MINIMAP_TILE;
  minimap.height = api.world.height * MINIMAP_TILE;

  const btnEls = new Map<string, HTMLButtonElement>();
  const makeButton = (
    parent: HTMLElement,
    key: string,
    label: string,
    cost: number,
    onTap: () => void
  ) => {
    const b = document.createElement("button");
    b.className = "bb";
    b.innerHTML = `<span class="lbl">${label}</span><span class="cost">${cost}</span><span class="badge" hidden></span><span class="prog" hidden></span>`;
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    b.addEventListener("click", onTap);
    parent.appendChild(b);
    btnEls.set(key, b);
    return b;
  };

  for (const { kind, label } of BUILDABLE)
    makeButton(grpBuildings, `b:${kind}`, label, BUILDINGS[kind].cost, () => {
      const f = api.world.factions[PLAYER];
      if (f.pending?.kind === kind && f.pending.ready) {
        api.ctrl.placing = kind;
      } else if (!f.pending) {
        api.ctrl.enqueue({ type: "startBuilding", faction: PLAYER, building: kind });
      }
    });

  for (const { kind, label } of TRAINABLE)
    makeButton(grpUnits, `u:${kind}`, label, UNITS[kind].cost, () => {
      const at = UNITS[kind].builtAt;
      const candidates = [...api.world.buildings.values()].filter(
        (b) => b.faction === PLAYER && b.kind === at
      );
      candidates.sort((a, b) => a.queue.length - b.queue.length);
      const target = candidates[0];
      if (target)
        api.ctrl.enqueue({ type: "produce", faction: PLAYER, buildingId: target.id, unit: kind });
    });

  if (api.ctrl.spectator) {
    root.classList.add("spectator");
    const versus = root.querySelector<HTMLElement>("#versus")!;
    versus.hidden = false;
    versus.innerHTML = `<span class="vs-blue">${api.strategies?.blue}</span> vs <span class="vs-red">${api.strategies?.red}</span>`;
  }

  const fogToggle = root.querySelector<HTMLButtonElement>("#fog-toggle")!;
  if (!api.ctrl.showFog) {
    fogToggle.textContent = "FOG OFF";
    fogToggle.classList.add("off");
  }
  fogToggle.addEventListener("pointerdown", (e) => e.stopPropagation());
  fogToggle.addEventListener("click", () => {
    api.ctrl.showFog = !api.ctrl.showFog;
    fogToggle.textContent = api.ctrl.showFog ? "FOG ON" : "FOG OFF";
    fogToggle.classList.toggle("off", !api.ctrl.showFog);
    lastMinimapAt = 0; // redraw the minimap immediately
  });

  for (const [id, factor] of [
    ["zoom-in", 1.45],
    ["zoom-out", 1 / 1.45]
  ] as const) {
    const b = root.querySelector<HTMLButtonElement>(`#${id}`)!;
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    b.addEventListener("click", () => api.zoomBy(factor));
  }

  stopChip.addEventListener("click", () => api.ctrl.stopSelected());
  cancelChip.addEventListener("click", () => {
    if (api.ctrl.placing) api.ctrl.placing = null;
    else api.ctrl.enqueue({ type: "cancelBuilding", faction: PLAYER });
  });

  // minimap interaction: tap or drag to move the camera
  let miniDown = false;
  const miniMove = (e: PointerEvent) => {
    const r = minimap.getBoundingClientRect();
    const wx = ((e.clientX - r.left) / r.width) * api.world.width;
    const wy = ((e.clientY - r.top) / r.height) * api.world.height;
    api.centerCamera(wx, wy);
  };
  minimap.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    miniDown = true;
    minimap.setPointerCapture(e.pointerId);
    miniMove(e);
  });
  minimap.addEventListener("pointermove", (e) => miniDown && miniMove(e));
  minimap.addEventListener("pointerup", () => (miniDown = false));

  let lastMinimapAt = 0;
  let lastScrap = -1;

  function update(): void {
    const w = api.world;
    const f = w.factions[PLAYER];
    const scrap = Math.floor(f.scrap);
    if (scrap !== lastScrap) {
      lastScrap = scrap;
      scrapEl.textContent = `⚙ ${scrap}`;
    }

    stopChip.hidden = api.ctrl.selectedUnits.size === 0;
    cancelChip.hidden = !api.ctrl.placing && !f.pending;

    // building buttons
    for (const { kind } of BUILDABLE) {
      const el = btnEls.get(`b:${kind}`)!;
      const prog = el.querySelector<HTMLElement>(".prog")!;
      const pendingThis = f.pending?.kind === kind;
      const affordable = f.scrap >= BUILDINGS[kind].cost;
      el.disabled = !pendingThis && (!!f.pending || !affordable);
      el.classList.toggle("ready", !!(pendingThis && f.pending!.ready));
      el.classList.toggle("placing", api.ctrl.placing === kind);
      if (pendingThis && !f.pending!.ready) {
        prog.hidden = false;
        const total = BUILDINGS[kind].buildTime * TICK_RATE;
        prog.style.height = `${(1 - f.pending!.remaining / total) * 100}%`;
      } else {
        prog.hidden = true;
      }
    }

    // unit buttons
    for (const { kind } of TRAINABLE) {
      const el = btnEls.get(`u:${kind}`)!;
      const at = UNITS[kind].builtAt;
      const producers = [...w.buildings.values()].filter(
        (b) => b.faction === PLAYER && b.kind === at
      );
      const queued = producers.reduce(
        (n, b) => n + b.queue.filter((q) => q.kind === kind).length,
        0
      );
      el.disabled = producers.length === 0 || f.scrap < UNITS[kind].cost;
      const badge = el.querySelector<HTMLElement>(".badge")!;
      badge.hidden = queued === 0;
      badge.textContent = String(queued);
    }

    const now = performance.now();
    if (now - lastMinimapAt > 400) {
      lastMinimapAt = now;
      drawMinimap();
    }
  }

  function drawMinimap(): void {
    const w = api.world;
    const ctx = minimap.getContext("2d")!;
    const s = MINIMAP_TILE;
    const vis = w.fog[PLAYER].vis;
    const fogOn = api.ctrl.showFog;
    for (let ty = 0; ty < w.height; ty++)
      for (let tx = 0; tx < w.width; tx++) {
        const i = ty * w.width + tx;
        const v = fogOn ? vis[i] : Vis.Visible;
        if (v === Vis.Unexplored) ctx.fillStyle = "#05070c";
        else {
          const t = w.terrain[i];
          const dim = v === Vis.Explored;
          if (t === Terrain.Rock) ctx.fillStyle = dim ? "#2c2e36" : "#4a4c58";
          else if (t === Terrain.Scrap && w.scrap[i]! > 0)
            ctx.fillStyle = dim ? "#1e4a40" : "#2f8a70";
          else ctx.fillStyle = dim ? "#242019" : "#463c2c";
        }
        ctx.fillRect(tx * s, ty * s, s, s);
      }
    // known enemy buildings (all of them with fog off) + own buildings
    const enemyBuildings = fogOn
      ? [...w.fog[PLAYER].known.values()]
      : [...w.buildings.values()].filter((b) => b.faction !== PLAYER);
    for (const kb of enemyBuildings) {
      ctx.fillStyle = "#e25555";
      const size = BUILDINGS[kb.kind].size;
      ctx.fillRect(kb.tx * s, kb.ty * s, size * s, size * s);
    }
    for (const b of w.buildings.values()) {
      if (b.faction !== PLAYER) continue;
      ctx.fillStyle = "#4894ff";
      const size = BUILDINGS[b.kind].size;
      ctx.fillRect(b.tx * s, b.ty * s, size * s, size * s);
    }
    for (const u of w.units.values()) {
      const tx = Math.floor(u.x);
      const ty = Math.floor(u.y);
      if (u.faction === PLAYER) ctx.fillStyle = "#7ec1ff";
      else {
        if (fogOn && vis[ty * w.width + tx] !== Vis.Visible) continue;
        ctx.fillStyle = "#ff8a7a";
      }
      ctx.fillRect(u.x * s - 1, u.y * s - 1, 2.5, 2.5);
    }
    // camera viewport
    const cam = api.camera;
    ctx.strokeStyle = "rgba(255,255,255,0.7)";
    ctx.lineWidth = 1;
    ctx.strokeRect(
      (cam.worldView.x / 32) * s,
      (cam.worldView.y / 32) * s,
      (cam.worldView.width / 32) * s,
      (cam.worldView.height / 32) * s
    );
  }

  function showEnd(winner: Faction): void {
    const w = api.world;
    const spec = api.ctrl.spectator;
    const won = winner === PLAYER;
    const title = spec ? `${winner.toUpperCase()} WINS` : won ? "VICTORY" : "DEFEAT";
    const titleClass = spec ? (winner === "blue" ? "win" : "lose") : won ? "win" : "lose";
    const secs = Math.round(api.matchSeconds());
    const mm = Math.floor(secs / 60);
    const ss = String(secs % 60).padStart(2, "0");
    const st = (f: Faction) => w.factions[f].stats;
    endEl.hidden = false;
    endEl.innerHTML = `
      <div class="panel">
        <h1 class="${titleClass}">${title}</h1>
        ${spec ? `<p class="time">${api.strategies?.blue} vs ${api.strategies?.red}</p>` : ""}
        <p class="time">Match time ${mm}:${ss}</p>
        <table>
          <tr><th></th><th>${spec ? "Blue" : "You"}</th><th>${spec ? "Red" : "Enemy"}</th></tr>
          <tr><td>Units built</td><td>${st("blue").unitsBuilt}</td><td>${st("red").unitsBuilt}</td></tr>
          <tr><td>Units lost</td><td>${st("blue").unitsLost}</td><td>${st("red").unitsLost}</td></tr>
          <tr><td>Scrap harvested</td><td>${Math.floor(st("blue").scrapHarvested)}</td><td>${Math.floor(st("red").scrapHarvested)}</td></tr>
        </table>
        <button id="again" class="cta">Play again</button>
      </div>
    `;
    endEl.querySelector("#again")!.addEventListener("click", () => window.location.reload());
  }

  return {
    update,
    showEnd,
    destroy() {
      root.innerHTML = "";
    }
  };
}
