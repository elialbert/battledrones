// Hosts this fork at battledrones.elialbert.com: a static-assets Worker serving
// the game's own build (../../dist). Deploy from the repo root: npm run deploy:cf
import { defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    name: "battledrones",
    compatibilityDate: "2026-09-25",
    observability: { enabled: true },
    domains: ["battledrones.elialbert.com"]
  }
});
