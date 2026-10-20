/**
 * The game's Vite config over HTTPS, for testing the sound duel on phones
 * across the LAN (SOUND-DUEL.md "Dev and test modes"). The duel needs a secure
 * context (getUserMedia and AudioWorklet; main.ts hides the Duel button
 * without one), and a phone reaches the dev machine by its LAN address, which
 * plain http:// is not.
 *
 *   npx vite --config tools/vite-https.config.ts             (dev server)
 *   npx vite build && npx vite preview --config tools/vite-https.config.ts
 *
 * The certificate is self-signed, made once with the system's openssl (no
 * package to install) and kept in node_modules/.cache, out of git. Each phone
 * says the connection is not private the first time: proceed anyway (Android
 * Chrome: Advanced, then Proceed; iPhone Safari: Show Details, then visit this
 * website), and the page is a secure context from then on. Browsers do not
 * register a service worker under a certificate they don't trust, so the
 * offline check needs a real one (the Pages build).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeConfig } from "vite";
import base from "../vite.config";

const dir = fileURLToPath(new URL("../node_modules/.cache/battledrones-https", import.meta.url));
const key = join(dir, "key.pem");
const cert = join(dir, "cert.pem");
if (!existsSync(key) || !existsSync(cert)) {
  mkdirSync(dir, { recursive: true });
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "825", "-subj", "/CN=battledrones-dev", "-keyout", key, "-out", cert],
    { stdio: "ignore" }
  );
}
const https = { key: readFileSync(key), cert: readFileSync(cert) };

// (host: every address, so the phones can reach it; preview takes server.https too, but say so)
export default mergeConfig(base, { server: { https, host: true }, preview: { https, host: true } });
