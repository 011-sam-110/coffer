#!/usr/bin/env node
// Render the brand SVGs in design/brand/ to PNG and ICO, and draw a check sheet.
//
// Chromium (playwright-core) draws each SVG at the exact target size, so a PNG is
// the vector drawn at that size, not a scaled-down bitmap. No cairo or resvg needed.
//
// Output, next to the SVGs:
//   app-icon-1024.png                         input for `pnpm tauri icon`
//   tray-{locked,unlocked}-{16,20,24,32,40,48}.png
//   tray-{locked,unlocked}.ico                 the six sizes, PNG-compressed entries
// Check sheet: .shots/brand-sheet.png (git-ignored): both tray states at every size
// on a dark (#202020) and a light (#f3f3f3) taskbar strip, 1:1 and enlarged.
//
// Usage: node scripts/render-brand.mjs   (no dev server needed)
// Needs playwright-core and a Chromium: COFFER_PLAYWRIGHT, the project's
// node_modules, or ~/.claude/qa-runtime/node_modules/playwright-core.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BRAND = join(root, "design", "brand");
const SHOTS = join(root, ".shots");
const TRAY_SIZES = [16, 20, 24, 32, 40, 48];

const require = createRequire(import.meta.url);
function loadPlaywright() {
  const tries = [process.env.COFFER_PLAYWRIGHT, "playwright-core", join(homedir(), ".claude/qa-runtime/node_modules/playwright-core")].filter(Boolean);
  for (const t of tries) {
    try {
      return require(t);
    } catch {
      /* next */
    }
  }
  console.error("render-brand: playwright-core not found. Set COFFER_PLAYWRIGHT to its path.");
  process.exit(2);
}
const { chromium } = loadPlaywright();

const svgUrl = (name) => `data:image/svg+xml;base64,${readFileSync(join(BRAND, name)).toString("base64")}`;
const pngUrl = (buf) => `data:image/png;base64,${buf.toString("base64")}`;

/** One ICO file from PNG buffers (PNG entries: Windows Vista and later, and the image crate, read them). */
function ico(entries) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2); // 1 = icon
  head.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach(({ size, png }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2); // no palette
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4); // planes
    dir.writeUInt16LE(32, o + 6); // bits per pixel
    dir.writeUInt32LE(png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([head, dir, ...entries.map((e) => e.png)]);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 1100 }, deviceScaleFactor: 1 });

/** Draw one SVG at size x size on a transparent page and return the PNG. */
async function render(name, size) {
  await page.setContent(
    `<!doctype html><html><body style="margin:0;background:transparent">` +
      `<img id="i" src="${svgUrl(name)}" width="${size}" height="${size}" style="display:block">` +
      `</body></html>`,
  );
  await page.waitForFunction(() => document.getElementById("i").complete);
  return page.locator("#i").screenshot({ omitBackground: true });
}

const written = [];
const out = (file, buf) => {
  writeFileSync(join(BRAND, file), buf);
  written.push(file);
};

const app = await render("app-icon.svg", 1024);
out("app-icon-1024.png", app);

const tray = {};
for (const state of ["locked", "unlocked"]) {
  tray[state] = {};
  for (const size of TRAY_SIZES) {
    const png = await render(`tray-${state}.svg`, size);
    tray[state][size] = png;
    out(`tray-${state}-${size}.png`, png);
  }
  out(`tray-${state}.ico`, ico(TRAY_SIZES.map((size) => ({ size, png: tray[state][size] }))));
}

// ---------- check sheet ----------
const appSmall = {};
for (const s of [16, 24, 32, 48, 64]) appSmall[s] = await render("app-icon.svg", s);
const mark = { 24: await render("coffer-mark.svg", 24), 48: await render("coffer-mark.svg", 48) };

const img = (buf, size, zoom = 1) =>
  `<img src="${pngUrl(buf)}" width="${size * zoom}" height="${size * zoom}" style="image-rendering:pixelated;display:block">`;
const cell = (label, inner) => `<div class="c">${inner}<span>${label}</span></div>`;
const strip = (bg, fg, title) => `
  <section style="background:${bg};color:${fg}">
    <h2>${title}</h2>
    <div class="row">${["locked", "unlocked"].map((st) => TRAY_SIZES.map((s) => cell(`${st} ${s}`, img(tray[st][s], s))).join("")).join('<div class="sep"></div>')}</div>
    <div class="row">${["locked", "unlocked"].map((st) => [16, 24].map((s) => cell(`${st} ${s} x4`, img(tray[st][s], s, 4))).join("")).join('<div class="sep"></div>')}</div>
    <div class="row">${[16, 24, 32, 48, 64].map((s) => cell(`app ${s}`, img(appSmall[s], s))).join("")}<div class="sep"></div>${cell("app 16 x4", img(appSmall[16], 16, 4))}${cell("app 32 x4", img(appSmall[32], 32, 4))}<div class="sep"></div>${cell("mark 24", img(mark[24], 24))}${cell("mark 48", img(mark[48], 48))}</div>
  </section>`;
await page.setViewportSize({ width: 1180, height: 900 });
await page.setContent(`<!doctype html><html><head><style>
  body{margin:0;font:11px "Segoe UI",system-ui,sans-serif;background:#777}
  section{padding:10px 14px 14px}
  h2{margin:0 0 8px;font-size:12px;font-weight:600}
  .row{display:flex;align-items:flex-end;gap:14px;margin-bottom:12px;flex-wrap:wrap}
  .c{display:flex;flex-direction:column;align-items:center;gap:4px}
  .c span{opacity:.7}
  .sep{width:1px;align-self:stretch;background:currentColor;opacity:.2}
</style></head><body>
  ${strip("#202020", "#fafafa", "Dark taskbar #202020")}
  ${strip("#f3f3f3", "#1a1a1a", "Light taskbar #f3f3f3")}
</body></html>`);
mkdirSync(SHOTS, { recursive: true });
const sheet = join(SHOTS, "brand-sheet.png");
await page.screenshot({ path: sheet, fullPage: true });
await browser.close();

console.log(`render-brand: wrote ${written.length} files in design/brand/`);
for (const f of written) console.log(`  ${f}`);
console.log(`check sheet: ${sheet}`);
