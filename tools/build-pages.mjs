// Build the current checkout at the site root, and each version tag beneath it.
// Run after npm ci and git fetch --tags (CI checks out main with full history).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "_site");
const base = "/battledrones/";
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const tags = git("tag", "--list", "--sort=version:refname", "v[0-9]*")
  .split("\n").filter(Boolean);

// Each tag is one URL segment, including future semver/prerelease tags.
for (const tag of tags) {
  if (!/^v[0-9][A-Za-z0-9.+-]*$/.test(tag)) throw new Error(`Unsupported version tag: ${tag}`);
}

function build(cwd, destination, publicBase) {
  execFileSync("npm", ["run", "build", "--", "--base", publicBase,
    "--outDir", destination, "--emptyOutDir"], { cwd, stdio: "inherit" });
  if (!existsSync(join(destination, "index.html"))) throw new Error(`Missing build: ${destination}`);
}

console.log("Building the current game");
build(root, output, base);
const versions = [{ tag: null, commit: git("rev-parse", "HEAD"), path: base }];

for (const tag of tags) {
  console.log(`\nBuilding ${tag}`);
  const temporary = mkdtempSync(join(tmpdir(), "battledrones-pages-"));
  try {
    const archive = join(temporary, "source.tar");
    const source = join(temporary, "source");
    mkdirSync(source);
    // Use each tag's own source, lockfile and Vite config, never its docs/ build.
    execFileSync("git", ["archive", "--format=tar", "--output", archive, `refs/tags/${tag}`], { cwd: root });
    execFileSync("tar", ["-xf", archive, "-C", source]);
    execFileSync("npm", ["ci", "--no-audit", "--no-fund"], { cwd: source, stdio: "inherit" });
    const path = `${base}${tag}/`;
    build(source, join(output, tag), path);
    versions.push({ tag, commit: git("rev-parse", `${tag}^{commit}`), path });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

writeFileSync(join(output, "versions.json"), `${JSON.stringify(versions, null, 2)}\n`);
writeFileSync(join(output, ".nojekyll"), "");
console.log(`\nBuilt the current game and ${tags.length} version(s) in ${output}`);
