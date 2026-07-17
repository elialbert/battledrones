import Phaser from "phaser";
import { BootScene } from "./game/BootScene";

document.addEventListener("contextmenu", (e) => e.preventDefault());

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
  scene: [BootScene]
});
