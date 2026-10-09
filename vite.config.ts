import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  // Relative base + committed docs/ output so GitHub Pages can serve the
  // built game from the repo with no build step.
  base: "./",
  server: { host: true },
  build: {
    target: "es2022",
    outDir: "docs",
    chunkSizeWarningLimit: 1600,
    // the engine in its own chunk: game updates don't re-download three.js
    rollupOptions: { output: { manualChunks: { three: ["three"] } } }
  },
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      // precache the shell, icons and menu art; painted map terrain
      // (a few MB per map) and each biome's rock material are cached on
      // first play instead
      includeAssets: ["assets/icons/*", "assets/ui/*", "assets/maps/*/thumb.webp", "icons/*"],
      workbox: {
        globPatterns: ["**/*.{js,css,html}"],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: /\/assets\/maps\/.*\.webp$/,
            handler: "CacheFirst",
            options: { cacheName: "battledrones-maps", expiration: { maxEntries: 120 } }
          },
          {
            // (served from the cache, refreshed behind it: a re-tuned texture reaches players next game)
            urlPattern: /\/assets\/textures\/.*\.webp$/,
            handler: "StaleWhileRevalidate",
            options: { cacheName: "battledrones-textures", expiration: { maxEntries: 16 } }
          }
        ]
      },
      manifest: {
        name: "Battle Drones",
        short_name: "BattleDrones",
        description:
          "A mobile RTS: two armies of flying and ground drones battle for territory and resources.",
        display: "fullscreen",
        orientation: "any",
        background_color: "#070a10",
        theme_color: "#070a10",
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
