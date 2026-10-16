#!/usr/bin/env node
// Scripted UI check on the browser demo (SPEC 15: every screen passes a
// scripted check: no console errors, no horizontal overflow, focus visible).
//
// Loads each screen state at 1100 x 720 (main window) and 400 x 560 (Quick
// Access), reports console errors, horizontal overflow and keyboard-focused
// elements without a visible focus ring, and saves a screenshot per state to
// .shots/ (git-ignored).
//
// Usage: pnpm dev (port 1420), then `node scripts/check-ui.mjs [filter]`.
// Needs playwright-core and a Chromium. It looks for COFFER_PLAYWRIGHT (a path
// to playwright-core), then the project's node_modules, then
// ~/.claude/qa-runtime/node_modules/playwright-core.
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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
  console.error("check-ui: playwright-core not found. Set COFFER_PLAYWRIGHT to its path.");
  process.exit(2);
}
const { chromium } = loadPlaywright();

const BASE = process.env.COFFER_UI_URL ?? "http://localhost:1420";
const SHOTS = join(root, ".shots");
mkdirSync(SHOTS, { recursive: true });

// CHECK_UI_MAIN=900x600 / CHECK_UI_QUICK=400x560 try other window sizes (the main window's minimum is 900 x 600).
const size = (v, w, h) => {
  const m = /^(\d+)x(\d+)$/.exec(v ?? "");
  return m ? { width: +m[1], height: +m[2] } : { width: w, height: h };
};
const MAIN = size(process.env.CHECK_UI_MAIN, 1100, 720);
const QUICK = size(process.env.CHECK_UI_QUICK, 400, 560);

/** name, path, viewport, optional steps (run before the checks). */
const STATES = [
  ["m01-welcome", "/?state=noVault", MAIN],
  ["m02-create", "/?state=noVault&screen=create", MAIN],
  ["m03-kit", "/?state=noVault&screen=kit", MAIN],
  ["m04-kit-confirm", "/?state=noVault&screen=confirm", MAIN],
  ["m05-prefs", "/?state=noVault&screen=prefs", MAIN],
  ["m06-try-hotkey", "/?state=noVault&screen=hotkey", MAIN],
  ["m07-open-vault", "/?state=noVault&screen=open", MAIN],
  ["m08-unlock", "/?state=locked", MAIN],
  ["m09-unlock-wrong", "/?state=locked", MAIN, [{ fill: "input[type=password]", text: "nope" }, { press: "Enter" }, { wait: 1100 }]],
  ["m10-unlock-secret-key", "/?state=locked&needsKey=1", MAIN],
  ["m11-missing", "/?state=missing", MAIN],
  ["m12-tampered", "/?state=locked&screen=tampered", MAIN],
  ["m13-older-file", "/?state=locked&screen=older", MAIN],
  ["m14-vault", "/", MAIN],
  ["m15-item-login", "/?item=GitHub", MAIN],
  ["m16-item-card", "/?item=first&filter=all", MAIN, [{ click: "button[aria-controls=sidebar-types]" }, { click: "text=Credit Cards" }, { wait: 300 }, { press: "ArrowDown", target: "[role=listbox] [role=option]" }]],
  ["m17-edit-login", "/?item=GitHub&edit=1", MAIN],
  ["m18-change-password", "/?item=GitHub&edit=generator", MAIN],
  ["m19-new-identity", "/?new=identity", MAIN],
  ["m20-empty-vault", "/?empty=1", MAIN],
  ["m21-no-results", "/", MAIN, [{ fill: "input[type=search]", text: "zebra crossing" }]],
  ["m22-trash", "/?filter=trash", MAIN],
  ["m23-archive", "/?filter=archive", MAIN],
  ["m24-generator", "/?view=generator", MAIN],
  ["m25-health", "/?view=health", MAIN],
  ["m26-import", "/?view=import", MAIN],
  ["m27-import-preview", "/?view=import", MAIN, [{ click: "text=Choose file" }, { wait: 600 }]],
  ["m28-settings-general", "/?view=settings&tab=general", MAIN],
  ["m29-settings-security", "/?view=settings&tab=security", MAIN],
  ["m30-settings-vault", "/?view=settings&tab=vault", MAIN],
  ["m31-settings-shortcuts", "/?view=settings&tab=shortcuts", MAIN],
  ["m32-settings-about", "/?view=settings&tab=about", MAIN],
  ["m33-shortcuts-f1", "/?dialog=shortcuts", MAIN],
  ["m34-export", "/?dialog=export", MAIN],
  ["m35-close-notice", "/?dialog=closeNotice", MAIN],
  ["m36-lost-edit", "/?dialog=lostEdit", MAIN],
  ["m37-banner-damaged", "/?diskDamaged=1", MAIN],
  ["m38-banner-older", "/?olderOnDisk=1", MAIN],
  ["m39-banner-conflict", "/?conflict=1", MAIN],
  ["m40-banner-missing", "/?missingOpen=1", MAIN],
  ["m41-bulk-select", "/", MAIN, [{ click: "[role=listbox] li:nth-child(2) input[type=checkbox]", force: true }, { click: "[role=listbox] li:nth-child(3) input[type=checkbox]", force: true }]],
  ["m42-copy-toast", "/?item=GitHub", MAIN, [{ press: "Control+p", target: "body" }, { wait: 500 }]],
  // Tier 2: Windows Hello (SPEC 3.8).
  ["t01-unlock-hello", "/?state=locked&hello=ready", MAIN],
  ["t02-unlock-hello-wait", "/?state=locked&hello=ready", MAIN, [{ click: "text=Unlock with Windows Hello" }, { wait: 400 }]],
  ["t03-unlock-hello-cancel", "/?state=locked&hello=ready&helloResult=cancel", MAIN, [{ click: "text=Unlock with Windows Hello" }, { wait: 2200 }]],
  ["t04-unlock-hello-not-ready", "/?state=locked&hello=on", MAIN],
  // Tier 2: auto-type (SPEC 10).
  ["t08-detail-menu-autotype", "/?item=GitHub", MAIN, [{ click: "header [aria-label='More actions']" }, { wait: 300 }]],
  ["t09-detail-typed", "/?item=GitHub", MAIN, [{ click: "header [aria-label='More actions']" }, { click: "text=Type password" }, { wait: 700 }]],
  ["t10-detail-autotype-admin", "/?item=GitHub&autotype=admin", MAIN, [{ click: "header [aria-label='More actions']" }, { click: "text=Type username and password" }, { wait: 700 }]],
  ["t11-edit-autotype", "/?item=GitHub&edit=1", MAIN, [{ click: "text=Advanced" }, { fill: "input[placeholder='{USERNAME}{TAB}{PASSWORD}{ENTER}']", text: "{USERNAME}{TAB}{PASS}" }]],
  // Tier 2: revisions.
  ["t12-revisions", "/?item=GitHub", MAIN, [{ click: "text=/^Revisions/" }, { wait: 400 }]],
  ["t13-revision-confirm", "/?item=GitHub", MAIN, [{ click: "text=/^Revisions/" }, { wait: 400 }, { click: "main button:has-text('Restore') >> nth=0" }, { wait: 300 }]],
  ["t14-revision-restored", "/?item=GitHub", MAIN, [{ click: "text=/^Revisions/" }, { wait: 400 }, { click: "button:has-text('Restore') >> nth=0" }, { wait: 300 }, { click: "dialog button:has-text('Restore')" }, { wait: 700 }]],
  ["t07-unlock-hello-ok", "/?state=locked&hello=ready", MAIN, [{ click: "text=Unlock with Windows Hello" }, { wait: 2600 }]],
  ["t05-settings-hello-none", "/?view=settings&tab=security&hello=none", MAIN],
  ["t06-settings-hello-on", "/?view=settings&tab=security&hello=ready", MAIN],
  ["q01-quick", "/quick.html", QUICK],
  ["q02-quick-search", "/quick.html", QUICK, [{ fill: "input[role=combobox]", text: "git" }]],
  ["q03-quick-actions", "/quick.html", QUICK, [{ fill: "input[role=combobox]", text: "git" }, { press: "ArrowRight", target: "input[role=combobox]" }, { wait: 400 }]],
  ["q04-quick-no-results", "/quick.html", QUICK, [{ fill: "input[role=combobox]", text: "zebra" }]],
  ["q05-quick-generator", "/quick.html", QUICK, [{ click: "text=Generator" }, { wait: 400 }]],
  ["q06-quick-locked", "/quick.html?state=locked", QUICK],
  ["q07-quick-needs-key", "/quick.html?state=locked&needsKey=1", QUICK],
  ["q08-quick-no-vault", "/quick.html?state=noVault", QUICK],
  ["q10-quick-hello", "/quick.html?state=locked&hello=ready", QUICK],
  ["q11-quick-hello-wait", "/quick.html?state=locked&hello=ready", QUICK, [{ click: "text=Unlock with Windows Hello" }, { wait: 400 }]],
  ["q12-quick-hello-failed", "/quick.html?state=locked&hello=ready&helloResult=failed", QUICK, [{ click: "text=Unlock with Windows Hello" }, { wait: 2200 }]],
  ["q13-quick-actions-autotype", "/quick.html", QUICK, [{ fill: "input[role=combobox]", text: "github" }, { press: "ArrowRight", target: "input[role=combobox]" }, { wait: 400 }, { press: "ArrowDown" }, { press: "ArrowDown" }, { press: "ArrowDown" }, { press: "ArrowDown" }, { press: "ArrowDown" }]],
  ["q14-quick-autotype-admin", "/quick.html?autotype=admin", QUICK, [{ fill: "input[role=combobox]", text: "github" }, { press: "Control+Enter", target: "input[role=combobox]" }, { wait: 600 }]],
  ["q15-quick-autotype-gone", "/quick.html?autotype=gone", QUICK, [{ fill: "input[role=combobox]", text: "github" }, { press: "Control+Shift+Enter", target: "input[role=combobox]" }, { wait: 600 }]],
  ["q09-quick-copied", "/quick.html", QUICK, [{ fill: "input[role=combobox]", text: "git" }, { press: "Enter", target: "input[role=combobox]" }, { wait: 700 }]],
];

const filter = process.argv[2];
const browser = await chromium.launch();
const results = [];

for (const [name, path, viewport, steps = []] of STATES) {
  if (filter && !name.includes(filter)) continue;
  const context = await browser.newContext({ viewport, reducedMotion: "reduce", deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  const r = { name, errors, overflow: false, unfocused: [], focusChecked: 0, stepErrors: [], clipped: [], truncated: [] };
  try {
    await page.goto(BASE + path, { waitUntil: "networkidle" });
    await page.waitForTimeout(900);
    for (const s of steps) {
      try {
        if (s.fill) await page.fill(s.fill, s.text);
        else if (s.click) await page.click(s.click, { force: !!s.force, timeout: 3000 });
        else if (s.press) {
          if (s.target) await page.focus(s.target).catch(() => undefined);
          await page.keyboard.press(s.press);
        }
        if (s.wait) await page.waitForTimeout(s.wait);
        else await page.waitForTimeout(250);
      } catch (e) {
        r.stepErrors.push(`${JSON.stringify(s)}: ${String(e).split("\n")[0]}`);
      }
    }
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, `${name}.png`) });

    r.overflow = await page.evaluate(() => {
      const w = window.innerWidth;
      if (document.documentElement.scrollWidth > w + 1) return `page ${document.documentElement.scrollWidth}px`;
      // Any visible element sticking out to the right of the viewport.
      for (const el of document.querySelectorAll("body *")) {
        const b = el.getBoundingClientRect();
        if (b.width > 0 && b.height > 0 && b.right > w + 1) {
          const st = getComputedStyle(el);
          if (st.visibility === "hidden" || st.position === "fixed") continue;
          return `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)} right=${Math.round(b.right)}`;
        }
      }
      return false;
    });

    // Text that does not fit: clipped without an ellipsis is a fault; an ellipsis is listed for review.
    const fit = await page.evaluate(() => {
      const clipped = [];
      const truncated = [];
      const ownText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      for (const el of document.querySelectorAll("body *")) {
        const b = el.getBoundingClientRect();
        // Skip screen-reader-only text (1 x 1 px by design).
        if (b.width < 3 || b.height < 3 || !ownText(el)) continue;
        const st = getComputedStyle(el);
        if (st.visibility === "hidden") continue;
        const text = el.textContent.trim().slice(0, 40);
        const clipsX = st.overflowX === "hidden" || st.overflowX === "clip";
        const clipsY = st.overflowY === "hidden" || st.overflowY === "clip";
        if (clipsX && el.scrollWidth > el.clientWidth + 1) {
          if (st.textOverflow === "ellipsis") truncated.push(text);
          else clipped.push(`"${text}" (${el.scrollWidth}>${el.clientWidth} wide)`);
        }
        if (clipsY && el.scrollHeight > el.clientHeight + 2 && st.overflowY !== "auto") clipped.push(`"${text}" (${el.scrollHeight}>${el.clientHeight} high)`);
      }
      // A placeholder is text too: it must fit its empty field.
      const ctx = document.createElement("canvas").getContext("2d");
      for (const el of document.querySelectorAll("input[placeholder], textarea[placeholder]")) {
        if (el.value || !el.placeholder || el.offsetParent === null) continue;
        const st = getComputedStyle(el, "::placeholder");
        ctx.font = `${st.fontWeight} ${st.fontSize} ${st.fontFamily}`;
        const cs = getComputedStyle(el);
        const room = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        const need = ctx.measureText(el.placeholder).width;
        if (el.tagName === "INPUT" && need > room + 1) clipped.push(`placeholder "${el.placeholder.slice(0, 30)}" (${Math.ceil(need)}>${Math.floor(room)} wide)`);
      }
      return { clipped: clipped.slice(0, 6), truncated };
    });
    r.clipped = fit.clipped;
    r.truncated = fit.truncated;

    // Tab through the first focusable elements; each must show a ring (outline on it or a near ancestor).
    if (!name.includes("copied")) {
      await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
      for (let i = 0; i < 14; i++) {
        await page.keyboard.press("Tab");
        const f = await page.evaluate(() => {
          const el = document.activeElement;
          if (!el || el === document.body) return null;
          let node = el;
          for (let d = 0; d < 4 && node; d++) {
            const st = getComputedStyle(node);
            if (st.outlineStyle !== "none" && parseFloat(st.outlineWidth) >= 1) return { ok: true };
            // A 2 px ring-coloured underline (Windows text-box style), marked data-focus-ring.
            if (node.hasAttribute("data-focus-ring") && st.boxShadow !== "none") return { ok: true };
            node = node.parentElement;
          }
          const label = el.getAttribute("aria-label") || el.textContent?.trim().slice(0, 40) || el.tagName;
          return { ok: false, label: `${el.tagName.toLowerCase()} "${label}"` };
        });
        if (!f) continue;
        r.focusChecked++;
        if (!f.ok && !r.unfocused.includes(f.label)) r.unfocused.push(f.label);
      }
    }
  } catch (e) {
    r.errors.push(`load: ${String(e).split("\n")[0]}`);
  }
  results.push(r);
  await context.close();
}
await browser.close();

let bad = 0;
for (const r of results) {
  const issues = [];
  if (r.errors.length) issues.push(`${r.errors.length} console error(s): ${r.errors.slice(0, 2).join(" | ").slice(0, 200)}`);
  if (r.overflow) issues.push(`overflow: ${r.overflow}`);
  if (r.unfocused.length) issues.push(`no focus ring: ${r.unfocused.join(", ")}`);
  if (r.stepErrors.length) issues.push(`step failed: ${r.stepErrors.join(" | ").slice(0, 200)}`);
  if (r.clipped.length) issues.push(`clipped text: ${r.clipped.join(", ")}`);
  if (issues.length) bad++;
  console.log(`${issues.length ? "FAIL" : "ok  "} ${r.name.padEnd(26)} focus checked ${String(r.focusChecked).padStart(2)}${issues.length ? "  " + issues.join("; ") : ""}`);
}
// Ellipsis truncation is allowed (long titles), but list it so a person can check it hides nothing that matters.
if (process.env.CHECK_UI_TRUNCATED) {
  for (const r of results) if (r.truncated.length) console.log(`truncated ${r.name}: ${r.truncated.slice(0, 12).join(" | ")}`);
}
console.log(`\ncheck-ui: ${results.length} states, ${results.length - bad} clean, ${bad} with issues. Screenshots in .shots/`);
process.exit(bad ? 1 : 0);
