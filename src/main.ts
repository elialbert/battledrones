import Phaser from "phaser";
import { DIFFICULTY, type Difficulty } from "./sim/ai/commander";
import { MAPS } from "./sim/maps";
import { sfx } from "./game/audio";
import { music } from "./game/music";
import { mapAssetBase } from "./game/assets";
import { GameScene } from "./game/GameScene";
import { gameMode, loadSettings, saveSettings } from "./game/mode";
import { HELP_HTML } from "./ui/hud";

document.addEventListener("contextmenu", (e) => e.preventDefault());

// iOS Safari ignores user-scalable=no: pinch zooms the PAGE (scaling the
// HUD with it) and offers no way back. Kill browser zoom at the source —
// the game camera handles all zooming.
for (const type of ["gesturestart", "gesturechange", "gestureend"])
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
document.addEventListener(
  "touchmove",
  (e) => {
    if ((e as TouchEvent & { scale?: number }).scale !== 1) e.preventDefault();
  },
  { passive: false }
);
document.addEventListener("dblclick", (e) => e.preventDefault(), { passive: false });

// Safety net: if browser page-zoom happens anyway (iOS finds ways), show a
// rescue button pinned inside the VISUAL viewport (fixed-position elements
// live in the layout viewport and can be off-screen while zoomed).
function setupPageZoomRescue(): void {
  const vv = window.visualViewport;
  if (!vv) return;
  const btn = document.createElement("button");
  btn.id = "unzoom";
  btn.textContent = "⤺ Zoom back out";
  btn.hidden = true;
  document.body.appendChild(btn);

  const place = () => {
    const zoomed = vv.scale > 1.05;
    btn.hidden = !zoomed;
    if (!zoomed) return;
    const s = 1 / vv.scale;
    btn.style.left = `${vv.offsetLeft}px`;
    btn.style.top = `${vv.offsetTop + vv.height - 56 * s}px`;
    btn.style.width = `${vv.width}px`;
    btn.style.height = `${56 * s}px`;
    btn.style.fontSize = `${17 * s}px`;
  };
  vv.addEventListener("resize", place);
  vv.addEventListener("scroll", place);
  place();

  btn.addEventListener("click", () => {
    // rewriting the viewport meta forces Safari to re-clamp scale to 1
    const meta = document.querySelector<HTMLMetaElement>("meta[name=viewport]");
    if (!meta) return;
    const content = meta.content;
    meta.content = "width=device-width, initial-scale=1.0, maximum-scale=1.0";
    requestAnimationFrame(() => {
      meta.content = content;
      place();
    });
  });
}
setupPageZoomRescue();

/** Render at device resolution (capped at 2× for phone GPUs) for crisp art. */
const dpr = () => Math.min(2, Math.max(1, window.devicePixelRatio || 1));

function startGame(): void {
  const hud = document.getElementById("hud")!;
  const loading = document.createElement("div");
  loading.id = "loading";
  loading.className = "screen";
  loading.innerHTML = `<div class="loadbox"><p>Deploying to ${MAPS.find((m) => m.id === gameMode.mapId)?.name ?? "battlefield"}…</p><div class="loadtrack"><div id="loadbar"></div></div></div>`;
  hud.appendChild(loading);

  const r = dpr();
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: "game",
    backgroundColor: "#070a10",
    scale: {
      mode: Phaser.Scale.NONE,
      width: Math.round(window.innerWidth * r),
      height: Math.round(window.innerHeight * r),
      zoom: 1 / r
    },
    render: { antialias: true, pixelArt: false, mipmapFilter: "LINEAR_MIPMAP_LINEAR", powerPreference: "high-performance" },
    input: { activePointers: 4 },
    scene: [GameScene]
  });
  game.registry.set("dpr", r);
  const resize = () => game.scale.resize(Math.round(window.innerWidth * r), Math.round(window.innerHeight * r));
  window.addEventListener("resize", resize);
  window.addEventListener("orientationchange", () => setTimeout(resize, 200));
}

function showMenu(): void {
  loadSettings();
  const hud = document.getElementById("hud")!;
  const menu = document.createElement("div");
  menu.id = "splash";
  menu.className = "menu";
  const diffs = Object.keys(DIFFICULTY) as Difficulty[];
  menu.innerHTML = `
    <div class="keyart"></div>
    <button class="round menu-mute" id="menu-mute" title="Mute all">🔊</button>
    <div class="menu-inner">
      <h1 class="logo">BATTLE<br/><span>DRONES</span></h1>
      <p class="sub">Mine scrap. Build your swarm. Destroy the enemy HQ.</p>
      <div class="maps" id="maps">
        ${MAPS.map(
          (m) => `
          <button class="mapcard" data-id="${m.id}">
            <img src="${mapAssetBase(m.id)}/thumb.webp" alt="" draggable="false" />
            <span class="mn">${m.name}</span>
            <span class="mb">${m.size}×${m.size} · ${m.biome}</span>
          </button>`
        ).join("")}
      </div>
      <p class="blurb" id="blurb"></p>
      <div class="seg" id="diff">
        ${diffs.map((d) => `<button data-d="${d}">${DIFFICULTY[d].label}</button>`).join("")}
      </div>
      <button class="cta big" id="play">▶ Play</button>
      <div class="row">
        <button class="cta alt" id="play-spectate">🤖 Watch AI vs AI</button>
        <button class="cta alt" id="howto">? How to play</button>
      </div>
      <div class="help" id="helpbox" hidden>${HELP_HTML}</div>
      <p class="credits">Art generated with OpenAI gpt-image-2.5 · sound synthesised live</p>
    </div>
  `;
  hud.appendChild(menu);
  // inline, document-relative URLs keep GitHub Pages subpaths working
  const art = menu.querySelector<HTMLElement>(".keyart")!;
  const landscape = window.matchMedia("(orientation: landscape)");
  const setArt = () =>
    (art.style.backgroundImage = `url(assets/ui/keyart-${landscape.matches ? "landscape" : "portrait"}.webp)`);
  setArt();
  landscape.addEventListener("change", setArt);

  // menu music: a gentle take on the selected map's theme, from the first touch
  const biomeOf = (id: string) => MAPS.find((m) => m.id === id)?.biome ?? "temperate";
  music.play("menu", biomeOf(gameMode.mapId));
  sfx.unlockOnGesture();
  const muteBtn = menu.querySelector<HTMLButtonElement>("#menu-mute")!;
  const syncMute = () => (muteBtn.textContent = sfx.muted ? "🔇" : "🔊");
  syncMute();
  const offMute = sfx.onChange(syncMute);
  muteBtn.addEventListener("click", () => sfx.setMuted(!sfx.muted));

  const sync = () => {
    menu.querySelectorAll<HTMLElement>(".mapcard").forEach((el) => el.classList.toggle("on", el.dataset.id === gameMode.mapId));
    menu.querySelectorAll<HTMLElement>("#diff button").forEach((el) => el.classList.toggle("on", el.dataset.d === gameMode.difficulty));
    const m = MAPS.find((x) => x.id === gameMode.mapId);
    menu.querySelector("#blurb")!.textContent = m?.blurb ?? "";
  };
  sync();
  menu.querySelectorAll<HTMLElement>(".mapcard").forEach((el) =>
    el.addEventListener("click", () => {
      gameMode.mapId = el.dataset.id!;
      saveSettings();
      sync();
      music.play("menu", biomeOf(gameMode.mapId));
    })
  );
  menu.querySelectorAll<HTMLElement>("#diff button").forEach((el) =>
    el.addEventListener("click", () => {
      gameMode.difficulty = el.dataset.d as Difficulty;
      saveSettings();
      sync();
    })
  );
  menu.querySelector("#howto")!.addEventListener("click", () => {
    const h = menu.querySelector<HTMLElement>("#helpbox")!;
    h.hidden = !h.hidden;
  });

  const begin = async (spectator: boolean) => {
    gameMode.spectator = spectator;
    sfx.unlock();
    sfx.play("click");
    // Full-screen where the platform allows it (Android/desktop; iOS Safari
    // has no Fullscreen API for arbitrary elements — dvh layout covers it).
    try {
      await document.documentElement.requestFullscreen?.({ navigationUI: "hide" });
    } catch {
      /* declined or unsupported — fine */
    }
    offMute();
    menu.remove();
    startGame();
  };
  menu.querySelector("#play")!.addEventListener("click", () => begin(false));
  menu.querySelector("#play-spectate")!.addEventListener("click", () => begin(true));

  // "Rematch" from the end screen skips straight back into a game
  let rematch = false;
  try {
    rematch = sessionStorage.getItem("battledrones.rematch") === "1";
    sessionStorage.removeItem("battledrones.rematch");
  } catch {
    /* ignore */
  }
  if (rematch) {
    offMute();
    menu.remove();
    startGame();
    // audio needs a gesture: sfx.unlockOnGesture() (above) starts it on the first touch
  }
}

showMenu();
