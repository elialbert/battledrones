import Phaser from "phaser";
import { GameScene } from "./game/GameScene";
import { gameMode } from "./game/mode";

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
    // pin across the bottom of the visible area, in layout coordinates
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

function startGame(): void {
  new Phaser.Game({
    type: Phaser.AUTO,
    parent: "game",
    backgroundColor: "#10141c",
    scale: {
      mode: Phaser.Scale.RESIZE,
      width: window.innerWidth,
      height: window.innerHeight
    },
    render: { pixelArt: true, antialias: false },
    input: { activePointers: 4 },
    scene: [GameScene]
  });
}

function showSplash(): void {
  const hud = document.getElementById("hud")!;
  const splash = document.createElement("div");
  splash.id = "splash";
  splash.className = "screen";
  splash.innerHTML = `
    <div class="panel">
      <h1>BATTLE DRONES</h1>
      <p class="sub">Mine scrap. Build your swarm.<br/>Destroy the enemy HQ.</p>
      <button class="cta" id="play">▶ Play</button>
      <button class="cta alt" id="play-spectate">🤖 Watch AI vs AI</button>
    </div>
  `;
  hud.appendChild(splash);
  const begin = async (spectator: boolean) => {
    gameMode.spectator = spectator;
    // Full-screen where the platform allows it (Android/desktop; iOS Safari
    // has no Fullscreen API for arbitrary elements — dvh layout covers it).
    try {
      await document.documentElement.requestFullscreen?.({ navigationUI: "hide" });
    } catch {
      /* declined or unsupported — fine */
    }
    splash.remove();
    startGame();
  };
  splash.querySelector("#play")!.addEventListener("click", () => begin(false));
  splash
    .querySelector("#play-spectate")!
    .addEventListener("click", () => begin(true));
}

showSplash();
