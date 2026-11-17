// Run the evaluator without loading the application's Vite/PWA plugins or file watchers.
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "economy-cli-"));
try {
  const outfile = join(scratch, "economy.mjs");
  await build({ entryPoints: [join(root, "tools/ai/economy.ts")], outfile, bundle: true,
    platform: "node", format: "esm", target: "node18",
    plugins: [{ name: "runtime-packages", setup(b) {
      b.onResolve({ filter: /^[^./]/ }, args => ({ path: import.meta.resolve(args.path), external: true }));
    } }]
  });
  process.env.ECONOMY_SOURCE_ROOT = root;
  await import(pathToFileURL(outfile).href);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
