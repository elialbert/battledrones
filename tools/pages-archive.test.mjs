import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { createVersionArchive, restoreVersionArchive } from "./pages-archive.mjs";

const version = { tag: "v3", commit: "abc123", path: "/battledrones/v3/" };
const temporary = mkdtempSync(join(tmpdir(), "pages-archive-test-"));
const source = join(temporary, "source");
const destination = join(temporary, "restored");
let body;
let status;
let url;
const server = createServer((_request, response) => {
  response.writeHead(status).end(body);
});

before(async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}/v3/v3.zip`;
});

beforeEach(() => {
  rmSync(source, { recursive: true, force: true });
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(source);
  writeFileSync(join(source, "index.html"), "<h1>Version 3</h1>");
  createVersionArchive(source, version);
  body = readFileSync(join(source, "v3.zip"));
  status = 200;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  rmSync(temporary, { recursive: true, force: true });
});

test("restores the game and republishes a reusable ZIP without nesting ZIPs", async () => {
  assert.equal(await restoreVersionArchive(url, destination, version), true);
  assert.equal(readFileSync(join(destination, "index.html"), "utf8"), "<h1>Version 3</h1>");
  assert.deepEqual(readFileSync(join(destination, "v3.zip")), body);
  createVersionArchive(destination, version);
  const entries = execFileSync("unzip", ["-Z1", join(destination, "v3.zip")], { encoding: "utf8" });
  assert.ok(!entries.includes("v3.zip"));
});

test("moved tags and changed URL paths fall back to building", async () => {
  for (const changed of [{ commit: "def456" }, { path: "/another/v3/" }, { tag: "v4" }]) {
    assert.equal(await restoreVersionArchive(url, destination, { ...version, ...changed }), false);
    assert.equal(existsSync(destination), false);
  }
});

test("missing, corrupt, incomplete, and old-format archives fall back to building", async () => {
  status = 404;
  assert.equal(await restoreVersionArchive(url, destination, version), false);
  status = 200;
  body = Buffer.from("not a zip");
  assert.equal(await restoreVersionArchive(url, destination, version), false);
  rmSync(join(source, "index.html"));
  createVersionArchive(source, version);
  body = readFileSync(join(source, "v3.zip"));
  assert.equal(await restoreVersionArchive(url, destination, version), false);
  writeFileSync(join(source, "build-info.json"), JSON.stringify({ format: 0, ...version }));
  execFileSync("zip", ["-q", "v3.zip", "build-info.json"], { cwd: source });
  body = readFileSync(join(source, "v3.zip"));
  assert.equal(await restoreVersionArchive(url, destination, version), false);
  assert.equal(existsSync(destination), false);
});

test("rejects paths outside the build and symlinks before extraction", async () => {
  writeFileSync(join(temporary, "outside.txt"), "outside");
  execFileSync("zip", ["-q", "unsafe.zip", "../outside.txt"], { cwd: source });
  body = readFileSync(join(source, "unsafe.zip"));
  assert.equal(await restoreVersionArchive(url, destination, version), false);
  symlinkSync("../outside.txt", join(source, "link"));
  execFileSync("zip", ["-qy", "symlink.zip", "link"], { cwd: source });
  body = readFileSync(join(source, "symlink.zip"));
  assert.equal(await restoreVersionArchive(url, destination, version), false);
  assert.equal(existsSync(destination), false);
});
