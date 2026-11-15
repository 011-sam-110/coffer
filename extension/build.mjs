#!/usr/bin/env node
// Build the Coffer extension (Manifest V3, plain TypeScript) into
// extension/dist, or into COFFER_EXTENSION_OUT. The installer ships that
// folder as <install folder>\extension (scripts/stage-bridge.mjs).
//
// The output: manifest.json (version from package.json, the fixed ID's
// public key), background.js (the service worker), popup/ and welcome/
// pages, content.js (the content script, one IIFE), words.txt (the EFF large
// word list, for the four words), host.json
// (the native host name: Coffer's own here; the installer writes its own
// identifier, so a QA copy talks to its own host), icons and fonts.
// COFFER_HOST sets host.json (e2e runs).
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, createLogger } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const src = join(here, "src");
const out = resolve(process.env.COFFER_EXTENSION_OUT ?? join(here, "dist"));
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const host = process.env.COFFER_HOST ?? "dev.sampo.coffer";
if (!/^[a-z0-9_]+(\.[a-z0-9_]+)*$/.test(host)) throw new Error(`COFFER_HOST is not a native host name: ${host}`);

// Vite warns that /fonts/... is not in publicDir: the fonts are copied in below, after the build.
const logger = createLogger("warn");
const warn = logger.warn;
logger.warn = (msg, options) => (msg.includes("didn't resolve at build time") ? undefined : warn(msg, options));

await build({
  configFile: false,
  customLogger: logger,
  root: src,
  base: "./",
  publicDir: join(here, "public"),
  logLevel: "warn",
  build: {
    outDir: out,
    emptyOutDir: true,
    target: "es2022",
    // Readable code: Sam loads this folder unpacked and can read what runs.
    minify: false,
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        background: join(src, "background.ts"),
        popup: join(src, "popup", "popup.html"),
        welcome: join(src, "welcome", "welcome.html"),
      },
      output: { entryFileNames: "[name].js", chunkFileNames: "chunks/[name].js", assetFileNames: "assets/[name][extname]" },
    },
  },
});

// The content script: one IIFE file (a content script cannot be an ES module),
// with no imports left at run time.
await build({
  configFile: false,
  customLogger: logger,
  root: src,
  publicDir: false,
  logLevel: "warn",
  build: {
    outDir: out,
    emptyOutDir: false,
    target: "es2022",
    minify: false,
    lib: { entry: join(src, "content", "main.ts"), formats: ["iife"], name: "cofferContent", fileName: () => "content.js" },
  },
});

const manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
manifest.version = version;
writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(join(out, "host.json"), `${JSON.stringify({ host })}\n`);

const words = readFileSync(join(root, "crates", "coffer-core", "data", "eff_large_wordlist.txt"), "utf8")
  .split(/\r?\n/)
  .map((l) => l.split("\t")[1]?.trim())
  .filter(Boolean);
if (words.length !== 7776) throw new Error(`the word list has ${words.length} words, not 7776`);
writeFileSync(join(out, "words.txt"), `${words.join("\n")}\n`);

// Switzer (ITF licence) is fetched into public/fonts/itf by scripts/fetch-fonts.mjs and never committed.
for (const f of [join("fonts", "ofl", "jetbrains-mono"), join("fonts", "itf", "switzer")]) {
  const from = join(root, "public", f);
  if (existsSync(from)) cpSync(from, join(out, f), { recursive: true });
  else console.warn(`extension: ${f} is missing; the extension falls back to system fonts. Run pnpm fonts.`);
}
console.log(`extension: Coffer ${version} (host ${host}) built into ${out}`);
