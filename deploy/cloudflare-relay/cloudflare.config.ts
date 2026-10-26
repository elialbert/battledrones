// The online relay for this fork's pages (src/index.ts): a Worker with one
// Durable Object per room, at wss://battledrones-relay.elialbert.com.
// Deploy from the repo root: npm run deploy:relay
import { defineConfig, exports } from "cf/config";

export default defineConfig({
  worker: {
    name: "battledrones-relay",
    compatibilityDate: "2026-09-25",
    entrypoint: "./src/index.ts",
    observability: { enabled: true },
    domains: ["battledrones-relay.elialbert.com"],
    exports: {
      Room: exports.durableObject({ storage: "sqlite" })
    }
  }
});
