import Phaser from "phaser";
import { GameScene } from "./game/GameScene";

document.addEventListener("contextmenu", (e) => e.preventDefault());

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
    </div>
  `;
  hud.appendChild(splash);
  splash.querySelector("#play")!.addEventListener("click", async () => {
    // Full-screen where the platform allows it (Android/desktop; iOS Safari
    // has no Fullscreen API for arbitrary elements — dvh layout covers it).
    try {
      await document.documentElement.requestFullscreen?.({ navigationUI: "hide" });
    } catch {
      /* declined or unsupported — fine */
    }
    splash.remove();
    startGame();
  });
}

showSplash();
