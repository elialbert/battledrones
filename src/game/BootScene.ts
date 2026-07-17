import Phaser from "phaser";

export class BootScene extends Phaser.Scene {
  constructor() {
    super("boot");
  }

  create(): void {
    const label = this.add
      .text(0, 0, "BATTLE DRONES", {
        fontFamily: "monospace",
        fontSize: "32px",
        color: "#6ec1ff"
      })
      .setOrigin(0.5);
    const center = () =>
      label.setPosition(this.scale.width / 2, this.scale.height / 2);
    center();
    this.scale.on("resize", center);
  }
}
