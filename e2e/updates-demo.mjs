#!/usr/bin/env node
// Playwright run on the browser demo: Settings > General > Updates and the
// "ready" banner (SPEC 3.12), against the demo backend's fake updater
// (?update=ready|found|badsig|offline|off).
//
// Start the demo first (any port): pnpm exec vite --port 5202 --strictPort
// Run: COFFER_UI_URL=http://localhost:5202 node e2e/updates-demo.mjs [shots folder]
// It needs playwright-core (COFFER_PLAYWRIGHT, the project's node_modules, or
// ~/.claude/qa-runtime/node_modules/playwright-core) and its Chromium. It makes
// no network call beyond the demo URL and touches no clipboard.
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
function loadPlaywright() {
  for (const t of [process.env.COFFER_PLAYWRIGHT, "playwright-core", join(homedir(), ".claude/qa-runtime/node_modules/playwright-core")].filter(Boolean)) {
    try {
      return require(t);
    } catch {
      /* next */
    }
  }
  console.error("updates-demo: playwright-core not found. Set COFFER_PLAYWRIGHT to its path.");
  process.exit(2);
}
const { chromium } = loadPlaywright();
const BASE = process.env.COFFER_UI_URL ?? "http://localhost:1420";
const SHOTS = resolve(process.argv[2] ?? ".shots-updates");
mkdirSync(SHOTS, { recursive: true });

let passed = 0;
const failures = [];
async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`FAIL ${name}: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
  }
}
const expectEq = (got, want, what) => {
  if (got !== want) throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1100, height: 720 }, deviceScaleFactor: 1 });

async function open(flags) {
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${BASE}/?view=settings&tab=general&${flags}`);
  await page.getByRole("heading", { name: "Updates" }).waitFor();
  return { page, errors };
}

const banner = (page) => page.locator("[role=status]").filter({ hasText: "is ready." });
const line = (page) => page.locator("[data-update-line]");
/** The status line once it holds `text` (update_status answers after the first paint). */
async function lineIs(page, text) {
  await page.locator("[data-update-line]", { hasText: text }).waitFor({ timeout: 10_000 });
  expectEq(await line(page).innerText(), text, "status line");
}
const autoSwitch = (page) => page.getByRole("switch", { name: "Install updates automatically" });
const checkNow = (page) => page.getByRole("button", { name: "Check now" });

async function layoutOk(page, errors) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  if (overflow) throw new Error("horizontal overflow");
  if (errors.length) throw new Error(`console errors: ${errors.join(" | ")}`);
}

await step("a ready update: banner, switch on, version line (the mockup)", async () => {
  const { page, errors } = await open("update=ready");
  await banner(page).waitFor();
  expectEq((await banner(page).innerText()).replace(/\s+/g, " ").trim(), "Coffer 0.3.1 is ready. It installs the next time Coffer locks. Restart now", "banner");
  expectEq(await autoSwitch(page).getAttribute("aria-checked"), "true", "switch");
  await lineIs(page, "Version 0.3.1 is downloaded and its signature checked. Checked 5 minutes ago.");
  expectEq(await page.getByText("Coffer 0.3.0", { exact: true }).count(), 1, "version row title");
  await layoutOk(page, errors);
  await page.screenshot({ path: join(SHOTS, "u1-ready.png") });
  // The section on its own, for the review page.
  await page.setViewportSize({ width: 1100, height: 920 });
  await checkNow(page).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(SHOTS, "u1b-ready-section.png") });
  await page.close();
});

await step("switch off: the banner says only Restart now installs; the setting holds", async () => {
  const { page, errors } = await open("update=ready");
  await autoSwitch(page).click();
  await page.waitForFunction(() => document.querySelector("[role=switch][aria-label='Install updates automatically']")?.getAttribute("aria-checked") === "false");
  await banner(page).getByText("It installs when you click Restart now.").waitFor();
  await page.getByText("It installs only when you click Restart now.").waitFor();
  // Another tab and back: the store kept the setting.
  await page.getByRole("tab", { name: "Security" }).click();
  await page.getByRole("tab", { name: "General" }).click();
  expectEq(await autoSwitch(page).getAttribute("aria-checked"), "false", "switch after tabs");
  await layoutOk(page, errors);
  await page.screenshot({ path: join(SHOTS, "u2-switch-off.png") });
  await page.close();
});

await step("Check now finds 0.3.1, downloads it, and the banner appears", async () => {
  const { page, errors } = await open("update=found");
  expectEq(await banner(page).count(), 0, "no banner before");
  await lineIs(page, "Coffer is up to date. Checked 5 minutes ago.");
  await checkNow(page).click();
  await page.getByText("Checking GitHub for a new version...").waitFor();
  await page.getByText("Downloading Coffer 0.3.1 and checking its signature...").waitFor();
  await banner(page).waitFor({ timeout: 10_000 });
  await lineIs(page, "Version 0.3.1 is downloaded and its signature checked. Checked just now.");
  await layoutOk(page, errors);
  await page.screenshot({ path: join(SHOTS, "u3-found.png") });
  await page.close();
});

await step("a wrong signature is refused: one line, no banner", async () => {
  const { page, errors } = await open("update=badsig");
  await checkNow(page).click();
  await page.getByText("Coffer 0.3.1 failed its signature check, so Coffer refused it.").waitFor({ timeout: 10_000 });
  expectEq(await banner(page).count(), 0, "no banner");
  await layoutOk(page, errors);
  await page.screenshot({ path: join(SHOTS, "u4-bad-signature.png") });
  await page.close();
});

await step("offline: one plain line", async () => {
  const { page, errors } = await open("update=offline");
  await checkNow(page).click();
  await page.getByText("Coffer could not reach GitHub to check for updates.", { exact: false }).waitFor({ timeout: 10_000 });
  await layoutOk(page, errors);
  await page.screenshot({ path: join(SHOTS, "u5-offline.png") });
  await page.close();
});

await step("a build with no key: switch and Check now are off, and it says why", async () => {
  const { page, errors } = await open("update=off");
  await lineIs(page, "This build does not update: it has no update signing key.");
  expectEq(await autoSwitch(page).isDisabled(), true, "switch disabled");
  expectEq(await checkNow(page).isDisabled(), true, "Check now disabled");
  await layoutOk(page, errors);
  await page.close();
});

await step("Restart now locks Coffer; after the restart it is 0.3.1 and up to date", async () => {
  const { page, errors } = await open("update=ready");
  await banner(page).getByRole("button", { name: "Restart now" }).click();
  // The lock screen: the demo vault locks before the install.
  const pw = page.locator("input[type=password]").first();
  await pw.waitFor({ timeout: 10_000 });
  await page.screenshot({ path: join(SHOTS, "u6-locked-for-install.png") });
  await page.waitForTimeout(1800); // the demo's installer runs, then "Coffer" is 0.3.1
  await pw.fill("demo");
  await pw.press("Enter");
  await page.waitForFunction(() => !document.querySelector("input[type=password]"), null, { timeout: 10_000 });
  if ((await page.getByRole("heading", { name: "Updates" }).count()) === 0) await page.keyboard.press("Control+,");
  await page.getByRole("heading", { name: "Updates" }).waitFor();
  await page.getByText("Coffer 0.3.1", { exact: true }).waitFor();
  await lineIs(page, "Coffer is up to date. Checked just now.");
  expectEq(await banner(page).count(), 0, "no banner after the restart");
  await layoutOk(page, errors);
  await page.screenshot({ path: join(SHOTS, "u7-after-restart.png") });
  await page.close();
});

await browser.close();
console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? `: ${failures.join("; ")}` : ""}`);
console.log(`Screenshots: ${SHOTS}`);
process.exit(failures.length ? 1 : 0);
