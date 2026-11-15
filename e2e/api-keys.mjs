#!/usr/bin/env node
// API keys and URL names on the browser demo (no app, no keys pressed on the
// desktop): the "API Key" words, API URL and Key first, the days left in the
// list and on the key, an expired key in red, and a new login named
// github.com that gets https://github.com as its Website ("GitHub" does not).
//
// Run: pnpm dev (or `pnpm exec vite --port <port>`), then
//   COFFER_UI_URL=http://localhost:<port> node e2e/api-keys.mjs
// Env: COFFER_UI_URL (default http://localhost:1420), COFFER_SHOTS (default
// .shots/api-keys), COFFER_PLAYWRIGHT (path to playwright-core).
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
function loadPlaywright() {
  for (const t of [process.env.COFFER_PLAYWRIGHT, "playwright-core", join(homedir(), ".claude/qa-runtime/node_modules/playwright-core")].filter(Boolean)) {
    try {
      return require(t);
    } catch {
      /* next */
    }
  }
  console.error("api-keys: playwright-core not found. Set COFFER_PLAYWRIGHT to its path.");
  process.exit(2);
}
const { chromium } = loadPlaywright();

const BASE = process.env.COFFER_UI_URL ?? "http://localhost:1420";
const SHOTS = process.env.COFFER_SHOTS ?? join(root, ".shots", "api-keys");
mkdirSync(SHOTS, { recursive: true });

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
}
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));

try {
  // ----- an API key -----
  await page.goto(`${BASE}/?item=${encodeURIComponent("Stripe API key (test mode)")}`);
  const article = page.locator("article");
  await article.getByRole("heading", { name: "Stripe API key (test mode)" }).waitFor({ timeout: 15000 });
  // Show the API Keys list, as in the mockup.
  const types = page.locator("button[aria-controls=sidebar-types]");
  if ((await types.getAttribute("aria-expanded")) === "false") await types.click();
  await page.locator("#sidebar-types").getByText("API Keys", { exact: true }).click();
  await page.waitForTimeout(300);

  const subtitle = (await article.locator("header p").first().innerText()).trim();
  check('the key says "API Key" under its name', subtitle.startsWith("API Key"), subtitle);
  const labels = await article.locator("section").first().locator("div.group > span:first-child").allInnerTexts();
  check("API URL, then Key, then Username, then Expires", labels.slice(0, 4).join(",") === "API URL,Key,Username,Expires", labels.join(","));
  const banner = (await article.getByText(/^This key expires in \d+ days?, on \d{1,2} \w{3} \d{4}\.$/).first().innerText().catch(() => "")).trim();
  check("the banner says the days left and the date", /^This key expires in 45 days, on /.test(banner), banner);
  const row = page.locator("[role=listbox] [role=option]", { hasText: "Stripe API key (test mode)" });
  const badge = (await row.locator("span[aria-label]").last().innerText().catch(() => "")).trim();
  check('the list badge says "45 days"', badge === "45 days", badge);
  const sidebarWord = await page.locator("#sidebar-types").getByText("API Keys", { exact: true }).count();
  check('the sidebar says "API Keys"', sidebarWord === 1);
  await page.screenshot({ path: join(SHOTS, "01-api-key.png") });

  // The New item menu names the type too.
  await page.getByRole("button", { name: "New item" }).first().click();
  const menuItem = await page.getByRole("menuitem", { name: "API Key", exact: true }).count();
  check('the New item menu lists "API Key"', menuItem === 1);
  await page.keyboard.press("Escape");

  // ----- an expired key: red badge and banner -----
  await page.goto(`${BASE}/?item=${encodeURIComponent("Met Office DataHub")}&edit=1`);
  const expires = page.getByLabel("Expires", { exact: true });
  await expires.waitFor({ timeout: 15000 });
  const fieldOrder = await page.locator("form label[for]").allInnerTexts();
  check("the editor shows API URL first and Key second", fieldOrder[0] === "API URL" && fieldOrder[1] === "Key", fieldOrder.slice(0, 4).join(","));
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  await expires.fill(ymd(yesterday));
  await page.getByRole("button", { name: /^Save/ }).click();
  await page.locator("article").getByText(/^This key expired 1 day ago, on /).waitFor({ timeout: 10000 });
  const types2 = page.locator("button[aria-controls=sidebar-types]");
  if ((await types2.getAttribute("aria-expanded")) === "false") await types2.click();
  await page.locator("#sidebar-types").getByText("API Keys", { exact: true }).click();
  await page.waitForTimeout(300);
  const metRow = page.locator("[role=listbox] [role=option]", { hasText: "Met Office DataHub" });
  await metRow.getByText("Met Office DataHub", { exact: true }).click();
  await page.locator("article").getByText(/^This key expired 1 day ago, on /).waitFor({ timeout: 10000 });
  const expiredBadge = metRow.locator("span[aria-label]").last();
  const expiredWord = (await expiredBadge.innerText()).trim();
  const expiredClass = (await expiredBadge.getAttribute("class")) ?? "";
  check('an expired key shows "Expired" in red', expiredWord === "Expired" && expiredClass.includes("text-danger-text"), `${expiredWord} | ${expiredClass}`);
  const dangerBanner = await page.locator("article div.border-l-danger-text", { hasText: "This key expired 1 day ago" }).count();
  check("the banner of an expired key uses the danger style", dangerBanner === 1);
  await page.screenshot({ path: join(SHOTS, "02-api-key-expired.png") });

  // ----- a login named with its URL -----
  await page.goto(`${BASE}/?new=login`);
  const name = page.getByLabel("Item name");
  await name.waitFor({ timeout: 15000 });
  await name.pressSequentially("github.com", { delay: 20 });
  const website = page.getByLabel("Website", { exact: true });
  check("a login named github.com gets https://github.com as its Website", (await website.inputValue()) === "https://github.com", await website.inputValue());
  check('the hint "Taken from the name. Chrome fills this login on this website." shows', await page.getByText("Taken from the name. Chrome fills this login on this website.", { exact: true }).isVisible());
  await page.screenshot({ path: join(SHOTS, "03-login-named-with-url.png") });
  await name.fill("");
  await name.pressSequentially("GitHub", { delay: 20 });
  check('a login named "GitHub" gets no Website', (await website.inputValue()) === "", await website.inputValue());
  check("the hint is gone for a plain name", (await page.getByText("Taken from the name. Chrome fills this login on this website.", { exact: true }).count()) === 0);
  // Once the user edits Website, it stops following the name.
  await name.fill("");
  await name.pressSequentially("github.com", { delay: 20 });
  await website.fill("https://gitlab.com");
  await name.fill("");
  await name.pressSequentially("bitbucket.org", { delay: 20 });
  check("an edited Website stays as the user wrote it", (await website.inputValue()) === "https://gitlab.com", await website.inputValue());

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  check("no horizontal overflow", !overflow);
  check("no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (e) {
  check("run finished", false, e.message);
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`api-keys: ${results.length - failed.length} of ${results.length} passed. Pictures: ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
