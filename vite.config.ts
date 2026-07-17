import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  server: { host: true },
  build: { target: "es2022" },
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
