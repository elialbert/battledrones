import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  // Relative base + committed docs/ output so GitHub Pages can serve the
  // built game from the repo with no build step.
  base: "./",
  server: { host: true },
  build: { target: "es2022", outDir: "docs" },
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["assets/**/*"],
      manifest: {
        name: "Battle Drones",
        short_name: "BattleDrones",
        description:
          "A mobile RTS: two armies of flying and ground drones battle for territory and resources.",
        display: "fullscreen",
        orientation: "any",
        background_color: "#10141c",
        theme_color: "#10141c",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "icons/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable"
          }
        ]
      }
    })
  ]
});
