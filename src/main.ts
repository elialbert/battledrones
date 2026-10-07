import Phaser from "phaser";
import { DIFFICULTY, type Difficulty } from "./sim/ai/commander";
import { MAPS } from "./sim/maps";
import { sfx } from "./game/audio";
import { mapAssetBase } from "./game/assets";
import { GameScene } from "./game/GameScene";
import { gameMode, loadSettings, saveSettings, type GameType } from "./game/mode";
import { loadBest } from "./game/survival";
import { HELP_HTML } from "./ui/hud";
import { mountMenuCareer, starsText } from "./ui/career";
import { dailyOp, today, type DailyOp } from "./game/daily";
import { opById, type OpDef } from "./sim/ops";
import { mountMenuOps } from "./ui/ops";

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
    <div class="menu-inner">
      <h1 class="logo">BATTLE<br/><span>DRONES</span></h1>
      <div class="menu-side" id="menuside">
        <button class="rankbadge" id="rankbadge"></button>
        <div class="dailyop" id="dailyop"></div>
        <button class="mutbtn side"></button>
      </div>
      <p class="sub" id="sub"></p>
      <div class="seg modes" id="gmode">
        <button data-m="skirmish">⚔ Skirmish</button>
        <button data-m="survival">🛡 Last Stand</button>
        <button data-m="ops">🎖 Ops</button>
      </div>
      <p class="lsbest" id="lsbest" hidden></p>
      <p class="lsbest opsum" id="opsum" hidden></p>
      <div class="maps opcards" id="opcards" hidden></div>
      <p class="blurb opblurb" id="opblurb" hidden></p>
      <div class="maps" id="maps">
        ${MAPS.map(
          (m) => `
          <button class="mapcard" data-id="${m.id}">
            <img src="${mapAssetBase(m.id)}/thumb.webp" alt="" draggable="false" />
            <span class="mn">${m.name}</span>
            <span class="mb">${m.size}×${m.size} · ${m.biome}</span>
            <span class="mbest" hidden></span>
            <span class="mstars" hidden></span>
          </button>`
        ).join("")}
      </div>
      <p class="blurb" id="blurb"></p>
      <div class="seg" id="diff">
        ${diffs.map((d) => `<button data-d="${d}">${DIFFICULTY[d].label}</button>`).join("")}
      </div>
      <button class="mutbtn main"></button>
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

  // career: rank badge, Daily Op card, mutator picker, map stars (ui/career.ts)
  const career = mountMenuCareer(menu, {
    playDaily: (op) => {
      startDaily(op);
      void begin(false);
    },
    changed: () => saveSettings()
  });
  // Ops: op cards, progress line and the briefing sheet (ui/ops.ts)
  const ops = mountMenuOps(menu, {
    start: (op) => {
      startOp(op);
      void begin(false);
    },
    selectedId: () => gameMode.opId,
    select: (id) => {
      gameMode.opId = id;
      saveSettings();
      sync(); // the Play button names the picked op
    }
  });
  const sync = () => {
    const survival = gameMode.mode === "survival";
    const opsMode = gameMode.mode === "ops";
    career.sync();
    for (const id of ["#opsum", "#opcards", "#opblurb"]) menu.querySelector<HTMLElement>(id)!.hidden = !opsMode;
    for (const id of ["#maps", "#blurb", "#diff"]) menu.querySelector<HTMLElement>(id)!.hidden = opsMode;
    ops.sync();
    menu.querySelector<HTMLElement>("#play-spectate")!.hidden = opsMode;
    menu.classList.toggle("ops-mode", opsMode);
    menu.querySelectorAll<HTMLElement>("#maps .mapcard").forEach((el) => {
      el.classList.toggle("on", el.dataset.id === gameMode.mapId);
      // Last Stand: each map card shows its best for the chosen difficulty
      const badge = el.querySelector<HTMLElement>(".mbest")!;
      const rec = survival ? loadBest(el.dataset.id!, gameMode.difficulty) : null;
      badge.hidden = !rec;
      badge.textContent = rec ? `🛡 ${rec.best}` : "";
      const stars = el.querySelector<HTMLElement>(".mstars")!;
      const mask = survival ? 0 : career.starsFor(el.dataset.id!);
      stars.hidden = survival;
      stars.textContent = starsText(mask);
      stars.classList.toggle("got", mask > 0);
    });
    menu.querySelectorAll<HTMLElement>("#diff button").forEach((el) => el.classList.toggle("on", el.dataset.d === gameMode.difficulty));
    menu.querySelectorAll<HTMLElement>("#gmode button").forEach((el) => el.classList.toggle("on", el.dataset.m === gameMode.mode));
    const m = MAPS.find((x) => x.id === gameMode.mapId);
    menu.querySelector("#blurb")!.textContent = m?.blurb ?? "";
    menu.querySelector("#sub")!.textContent = opsMode
      ? "Short missions with a twist. Three stars each — can you take them all?"
      : survival
        ? "Hold your base against endless, themed waves. How long can you last?"
        : "Mine scrap. Build your swarm. Destroy the enemy HQ.";
    const best = menu.querySelector<HTMLElement>("#lsbest")!;
    best.hidden = !survival;
    if (survival) {
      const rec = loadBest(gameMode.mapId, gameMode.difficulty);
      const where = `${m?.name ?? "this map"} · ${DIFFICULTY[gameMode.difficulty].label}`;
      best.innerHTML = rec
        ? `🏆 Best on ${where}: <b>${rec.best} wave${rec.best === 1 ? "" : "s"}</b>`
        : `No record yet on ${where} — set one!`;
    }
    const sel = ops.selected();
    menu.querySelector("#play")!.textContent = opsMode
      ? ops.locked(sel) ? "🔒 Locked" : `▶ Op: ${sel.title}`
      : survival ? "▶ Start Last Stand" : "▶ Play";
    menu.querySelector("#play")!.classList.toggle("locked", opsMode && ops.locked(sel));
    menu.querySelector("#play-spectate")!.textContent = survival ? "🤖 Watch AI defend" : "🤖 Watch AI vs AI";
  };
  sync();
  menu.querySelectorAll<HTMLElement>("#maps .mapcard").forEach((el) =>
    el.addEventListener("click", () => {
      gameMode.mapId = el.dataset.id!;
      saveSettings();
      sync();
    })
  );
  menu.querySelectorAll<HTMLElement>("#diff button").forEach((el) =>
    el.addEventListener("click", () => {
      gameMode.difficulty = el.dataset.d as Difficulty;
      saveSettings();
      sync();
    })
  );
  menu.querySelectorAll<HTMLElement>("#gmode button").forEach((el) =>
    el.addEventListener("click", () => {
      gameMode.mode = el.dataset.m as GameType;
      sfx.play("click", 0.5);
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
    menu.remove();
    startGame();
  };
  menu.querySelector("#play")!.addEventListener("click", () => {
    if (gameMode.mode !== "ops") return void begin(false);
    const op = ops.selected();
    sfx.play("click", 0.5);
    if (!ops.locked(op)) ops.openBrief(op);
  });
  menu.querySelector("#play-spectate")!.addEventListener("click", () => begin(true));

  // "Rematch" from the end screen skips straight back into a game
  let rematch = false;
  try {
    const token = sessionStorage.getItem("battledrones.rematch");
    const op = token?.startsWith("op:") ? opById(token.slice(3)) : null;
    rematch = token === "1" || token === "daily" || !!op;
    if (token === "daily") startDaily(dailyOp(today()));
    if (op) startOp(op);
    sessionStorage.removeItem("battledrones.rematch");
  } catch {
    /* ignore */
  }
  if (rematch) {
    menu.remove();
    startGame();
    // audio needs a gesture: unlock on the first touch
    window.addEventListener("pointerdown", () => sfx.unlock(), { once: true });
  }
}

/** Point the next match at an op (not saved: the op fixes map, enemy and rules). */
function startOp(op: OpDef): void {
  // remember the pick (and the Ops tab) before the op's own map and difficulty take over
  gameMode.opId = op.id;
  gameMode.mode = "ops";
  saveSettings();
  gameMode.op = op;
  gameMode.mapId = op.map;
  gameMode.difficulty = op.ai && op.ai !== "survival" ? op.ai.difficulty : op.survival?.difficulty ?? "normal";
}

/** Point the next match at the Daily Op (not saved: the player's own picks stay). */
function startDaily(op: DailyOp): void {
  gameMode.daily = op;
  gameMode.mapId = op.mapId;
  gameMode.difficulty = op.difficulty;
  gameMode.mode = "skirmish";
}

showMenu();
