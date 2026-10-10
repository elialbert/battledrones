// Exercise the assembled Pages site, including navigation from the root PWA
// into historical versions in the same browser session.
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const site = resolve(dirname(fileURLToPath(import.meta.url)), "../_site");
const versions = JSON.parse(readFileSync(join(site, "versions.json"), "utf8"));
const base = versions[0].path;
const mime = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".webp": "image/webp", ".json": "application/json",
  ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml"
};

const server = createServer((req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    if (!path.startsWith(base)) throw new Error("Outside site");
    let file = resolve(site, path.slice(base.length));
    if (file !== site && !file.startsWith(site + sep)) throw new Error("Outside site");
    if (statSync(file).isDirectory()) {
      if (!path.endsWith("/")) {
        res.writeHead(301, { location: `${path}/` }).end();
        return;
      }
      file = join(file, "index.html");
    }
    res.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  } catch {
    res.writeHead(404).end("Not found");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || undefined,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
  });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  // Isolate this check from incompatible saved preferences across game versions.
  await context.addInitScript(() => localStorage.clear());
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("response", (response) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });

  for (const version of versions) {
    const directory = join(site, version.tag ?? "");
    const expectedHTML = readFileSync(join(directory, "index.html"), "utf8");
    const manifest = JSON.parse(readFileSync(join(directory, "manifest.webmanifest"), "utf8"));
    assert.equal(manifest.scope, version.path, `${version.tag}: manifest scope`);
    assert.equal(manifest.start_url, version.path, `${version.tag}: manifest start URL`);

    const response = await page.goto(origin + version.path);
    assert.equal(response.status(), 200);
    // This also catches the root service worker returning its own index for /v1/.
    assert.equal(await response.text(), expectedHTML, `${version.tag}: wrong game HTML`);
    await page.locator("#play").tap();
    await page.waitForFunction(() => window.__bd?.world?.tick > 2 || document.querySelector(".op-card"));
    const opener = page.locator(".op-card").first();
    if (await opener.isVisible()) await opener.tap();
    await page.waitForFunction(() => window.__bd?.world?.tick > 2);
    await page.waitForFunction(
      (url) => navigator.serviceWorker.controller?.scriptURL === url,
      `${origin}${version.path}sw.js`
    );
    assert.deepEqual(errors, [], `${version.tag ?? "current"}: browser errors`);
    console.log(`PASS ${version.path}: correct HTML, game running, own service worker`);
  }

  // Version workers must not take over the root, and disabling the root's broad
  // navigation fallback must preserve its exact precached index while offline.
  await context.setOffline(true);
  const response = await page.goto(origin + base);
  assert.equal(await response.text(), readFileSync(join(site, "index.html"), "utf8"));
  await page.locator("#play").waitFor();
  assert.deepEqual(errors, [], "Offline root: browser errors");
  console.log(`PASS ${base}: offline root navigation after visiting every version`);
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
