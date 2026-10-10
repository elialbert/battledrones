import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Bump this when changing how historical builds are produced.
const format = 1;
const metadataFile = "build-info.json";
const unzip = (...args) => execFileSync("unzip", args, { encoding: "utf8" });

export function createVersionArchive(destination, version) {
  const temporary = mkdtempSync(join(tmpdir(), "battledrones-zip-"));
  try {
    writeFileSync(join(destination, metadataFile), `${JSON.stringify({ format, ...version }, null, 2)}\n`);
    // Create outside the build directory so the ZIP never includes itself.
    const archive = join(temporary, `${version.tag}.zip`);
    rmSync(join(destination, `${version.tag}.zip`), { force: true });
    execFileSync("zip", ["-qr", archive, "."], { cwd: destination });
    copyFileSync(archive, join(destination, `${version.tag}.zip`));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export async function restoreVersionArchive(url, destination, version) {
  const temporary = mkdtempSync(join(tmpdir(), "battledrones-zip-"));
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const archive = join(temporary, "build.zip");
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
    // Check integrity and paths before extracting a downloaded archive.
    unzip("-tq", archive);
    const entries = unzip("-Z1", archive).trim().split("\n");
    if (entries.some(name => name.startsWith("/") || name.includes("\\") || name.split("/").includes(".."))) {
      throw new Error("Unsafe archive path");
    }
    if (/^l/m.test(unzip("-Z", "-l", archive))) throw new Error("Archive contains symlinks");
    const extracted = join(temporary, "build");
    mkdirSync(extracted);
    unzip("-q", archive, "-d", extracted);
    const metadata = JSON.parse(readFileSync(join(extracted, metadataFile), "utf8"));
    if (metadata.format !== format || ["tag", "commit", "path"].some(key => metadata[key] !== version[key])) {
      throw new Error("Archive does not match this tag, commit, or URL path");
    }
    if (!existsSync(join(extracted, "index.html"))) throw new Error("Archive has no index.html");
    rmSync(destination, { recursive: true, force: true });
    cpSync(extracted, destination, { recursive: true });
    // Republish the ZIP along with its contents for the next deployment.
    copyFileSync(archive, join(destination, `${version.tag}.zip`));
    console.log(`Reused ${url}`);
    return true;
  } catch (error) {
    console.log(`No reusable archive for ${version.tag}: ${error.message}`);
    return false;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
