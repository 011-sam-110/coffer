#!/usr/bin/env node
// End-to-end run of the REAL Coffer app: the debug build of src-tauri with
// the built UI inside, driven over the WebView2 DevTools protocol.
//
// It starts Coffer on an empty data folder and walks the main paths: create a
// vault through Welcome / Create / Kit / Confirm / Prefs / Try it, add a
// login, lock, unlock (wrong password first), change a setting (clipboard
// clear time), copy the password (the Windows clipboard holds it, then is
// cleared), Quick Access with Ctrl+Shift+Space (search, Enter copies), the
// generator, an import of a synthetic Bitwarden CSV through the real file
// dialog, Health, and quit with app_quit. A screenshot of each step goes to
// .shots-real/ (git-ignored), plus one contact sheet.
//
// Build first (the frontend must be inside the exe):
//   pnpm exec vite build
//   cargo build -p coffer --features tauri/custom-protocol
// Run:
//   node e2e/real-app.mjs
// Env: COFFER_EXE (default <cargo target dir>/debug/coffer.exe),
//      COFFER_E2E_DIR (default %TEMP%\coffer-e2e, emptied first),
//      COFFER_CDP_PORT (default 9333), COFFER_PLAYWRIGHT (playwright-core path).
// Side effects on this PC: it overwrites the clipboard and presses
// Ctrl+Shift+Space (only after app_info says Coffer holds that hotkey). The
// vault, settings and backups stay in COFFER_E2E_DIR.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
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
  console.error("real-app: playwright-core not found. Set COFFER_PLAYWRIGHT to its path.");
  process.exit(2);
}
const { chromium } = loadPlaywright();

function findExe() {
  if (process.env.COFFER_EXE) return process.env.COFFER_EXE;
  try {
    const meta = JSON.parse(execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], { cwd: root, encoding: "utf8" }));
    return join(meta.target_directory, "debug", "coffer.exe");
  } catch {
    // No cargo on PATH: read target-dir from a .cargo/config.toml here or above.
    for (const dir of [root, dirname(root)]) {
      try {
        const m = readFileSync(join(dir, ".cargo", "config.toml"), "utf8").match(/target-dir\s*=\s*"([^"]+)"/);
        if (m) return join(m[1], "debug", "coffer.exe");
      } catch {
        /* next */
      }
    }
    return join(root, "target", "debug", "coffer.exe");
  }
}

const EXE = findExe();
const DATA = process.env.COFFER_E2E_DIR ?? join(tmpdir(), "coffer-e2e");
const VAULTS = join(DATA, "vaults");
const PORT = Number(process.env.COFFER_CDP_PORT ?? 9333);
const SHOTS = join(root, ".shots-real");
const PY = process.env.PYTHON ?? "python";

const MASTER = "Plum orbit lantern 2026 quartz!";
const ITEM_PW = "Example-item-pass-7731";

const results = [];
const shots = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
}

function win(...args) {
  const out = execFileSync(PY, [join(root, "e2e", "win.py"), ...args], { encoding: "utf8" });
  return JSON.parse(out.trim().split("\n").pop());
}
const clip = () => win("clipboard").text ?? null;

async function poll(fn, timeout = 8000, every = 150) {
  const end = Date.now() + timeout;
  for (;;) {
    let v;
    try {
      v = await fn();
    } catch {
      v = false;
    }
    if (v) return v;
    if (Date.now() > end) return v;
    await sleep(every);
  }
}

async function shot(page, name) {
  const path = join(SHOTS, `${name}.png`);
  await page.screenshot({ path, scale: "css" }).then(
    () => shots.push(path),
    (e) => console.log(`(screenshot ${name} failed: ${e.message})`),
  );
}

function settingsFile() {
  try {
    return JSON.parse(readFileSync(join(DATA, "settings.json"), "utf8"));
  } catch {
    return {};
  }
}

// ---------- start ----------

if (!existsSync(EXE)) {
  console.error(`real-app: ${EXE} is not there. Build it first (see the top of this file).`);
  process.exit(2);
}
rmSync(DATA, { recursive: true, force: true });
mkdirSync(VAULTS, { recursive: true });
mkdirSync(SHOTS, { recursive: true });
writeFileSync(join(SHOTS, ".gitignore"), "*\n");
for (const f of readdirSync(SHOTS)) if (f.endsWith(".png")) rmSync(join(SHOTS, f));
// Screenshots must not come out black: capture protection off for this run.
writeFileSync(join(DATA, "settings.json"), JSON.stringify({ version: 1, captureProtection: false }, null, 2));

const app = spawn(EXE, [], {
  env: {
    ...process.env,
    COFFER_DATA_DIR: DATA,
    COFFER_VAULT_DIR: VAULTS,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
  },
  stdio: ["ignore", "ignore", "ignore"],
});
let exitCode = null;
app.on("exit", (c) => (exitCode = c));
console.log(`real-app: ${EXE} pid ${app.pid}, data ${DATA}`);

let browser;
try {
  browser = await poll(() => chromium.connectOverCDP(`http://127.0.0.1:${PORT}`), 30000, 500);
  if (!browser) throw new Error(`no DevTools endpoint on port ${PORT}`);
  const pages = () => browser.contexts().flatMap((c) => c.pages());
  const main = await poll(() => pages().find((p) => new URL(p.url()).pathname === "/"), 15000);
  const quick = await poll(() => pages().find((p) => p.url().includes("quick.html")), 15000);
  check("both webviews load (main, quick)", main && quick, pages().map((p) => p.url()).join(", "));
  const errors = [];
  for (const [name, p] of [
    ["main", main],
    ["quick", quick],
  ]) {
    p.on("console", (m) => m.type() === "error" && errors.push(`${name}: ${m.text()}`));
    p.on("pageerror", (e) => errors.push(`${name}: ${e}`));
  }
  const invoke = (cmd, args = {}) => main.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
  const side = (name) => main.getByRole("navigation", { name: "Vault" }).getByRole("button", { name: new RegExp(`^${name}`) });

  // ---------- onboarding ----------
  await main.getByRole("button", { name: "Create a new vault" }).waitFor({ timeout: 15000 });
  await shot(main, "01-welcome");
  await main.getByRole("button", { name: "Create a new vault" }).click();
  await main.getByLabel("Vault name").fill("E2E Vault");
  await main.getByLabel("Master password", { exact: true }).fill(MASTER);
  await main.getByLabel("Type it again").fill(MASTER);
  const create = main.getByRole("button", { name: "Create vault" });
  const enabled = await poll(() => create.isEnabled(), 8000);
  await shot(main, "02-create");
  check("Create: the form accepts a strong password", enabled);
  await create.click();

  await main.getByText("Coffer Emergency Kit").waitFor({ timeout: 20000 });
  const keyLabel = await main.locator('[aria-label^="Secret Key "]').first().getAttribute("aria-label");
  const secretKey = keyLabel.slice("Secret Key ".length);
  const vaultFile = join(VAULTS, "E2E Vault.coffer");
  check("Create: vault file written in the chosen folder, kit shown", existsSync(vaultFile) && secretKey.length > 20, vaultFile);
  await shot(main, "03-kit");
  await main.getByRole("button", { name: "I saved it" }).click();
  await main.getByLabel("Last 4 symbols").fill(secretKey.replace(/[-\s]/g, "").slice(-4));
  await shot(main, "04-confirm");
  await main.getByRole("button", { name: "Confirm" }).click();
  await main.getByRole("button", { name: "Continue" }).waitFor({ timeout: 8000 });
  await shot(main, "05-prefs");
  await main.getByRole("button", { name: "Continue" }).click();

  const info = await invoke("app_info");
  const hotkeyOk = info?.hotkeyStatus?.quick === "ok";
  check("app_info: Coffer holds the Quick Access hotkey", hotkeyOk, JSON.stringify(info?.hotkeyStatus));
  if (hotkeyOk) {
    await main.getByText("Try it now").waitFor({ timeout: 8000 });
    win("hotkey");
    const seen = await poll(() => main.getByText("It works").isVisible(), 6000);
    check("Try it: the real hotkey opens Quick Access (quick://shown)", seen);
    await shot(main, "06-try-hotkey");
    await main.getByRole("button", { name: "Open my vault" }).click();
  } else {
    await main.getByRole("button", { name: "Skip this step" }).click();
  }
  await side("All items").waitFor({ timeout: 8000 });
  await shot(main, "07-vault-empty");

  // ---------- add a login ----------
  await main.getByRole("button", { name: "New", exact: true }).first().click();
  await main.getByRole("menuitem", { name: "Login" }).click();
  await main.locator('input[aria-label="Title"]').fill("Example Login");
  await main.getByLabel("Username", { exact: true }).fill("sam@example.com");
  await main.getByLabel("Password", { exact: true }).fill(ITEM_PW);
  if ((await main.locator('input[aria-label="Website 1"]').count()) === 0) await main.getByRole("button", { name: /Add a website/ }).click();
  await main.locator('input[aria-label="Website 1"]').fill("https://example.com/login");
  await shot(main, "08-editor");
  await main.getByRole("button", { name: "Save", exact: true }).click();
  const saved = await poll(() => main.locator('article[aria-label="Example Login"]').isVisible(), 8000);
  const status1 = await invoke("vault_status");
  check("Add a login: saved and shown", saved && status1.itemCount === 1, `itemCount ${status1.itemCount}`);
  await shot(main, "09-item");

  // ---------- lock, unlock ----------
  await side("Lock").click();
  const pw = main.locator("input[type=password]").first();
  await pw.waitFor({ timeout: 8000 });
  check("Lock: the unlock screen shows", (await invoke("vault_status")).state === "locked");
  await shot(main, "10-locked");
  await pw.fill("not the password");
  await pw.press("Enter");
  const wrong = await poll(() => main.getByRole("alert").first().isVisible(), 8000);
  check("Unlock: a wrong password shows an error", wrong, wrong ? await main.getByRole("alert").first().innerText() : "");
  await shot(main, "11-unlock-wrong");
  await pw.fill(MASTER);
  await pw.press("Enter");
  const back = await poll(() => side("All items").isVisible(), 10000);
  check("Unlock: the right password opens the vault", back && (await invoke("vault_status")).state === "unlocked");

  // ---------- a setting ----------
  await side("Settings").click();
  await main.getByRole("navigation", { name: "Settings" }).getByText("Security", { exact: true }).click();
  await main.getByLabel("Clear the clipboard after").selectOption("10");
  const stored = await poll(() => settingsFile().clipboardClearSeconds === 10, 5000);
  check("Settings: clipboard clear time saved to settings.json", stored, `clipboardClearSeconds ${settingsFile().clipboardClearSeconds}`);
  await shot(main, "12-settings-security");

  // ---------- copy from the main window ----------
  await side("All items").click();
  await main.getByRole("option", { name: /Example Login/ }).first().click();
  await main.getByRole("button", { name: "Copy password" }).click();
  const copied = await poll(() => clip() === ITEM_PW, 5000);
  check("Copy password: the Windows clipboard holds it", copied);
  await shot(main, "13-copied");
  const t0 = Date.now();
  const cleared = await poll(() => clip() !== ITEM_PW, 16000, 500);
  check("Copy password: the clipboard is cleared after 10 s", cleared, `after ${((Date.now() - t0) / 1000).toFixed(1)} s more`);

  // ---------- Quick Access ----------
  if (hotkeyOk) {
    win("hotkey");
    const search = quick.locator("input[role=combobox]");
    const shown = await poll(() => search.isVisible(), 5000);
    await search.fill("Exam");
    await sleep(400);
    await shot(quick, "14-quick-search");
    await search.press("Enter");
    const quickCopy = await poll(() => clip() === ITEM_PW, 5000);
    check("Quick Access: hotkey, search, Enter copies the password", shown && quickCopy);
  }

  // ---------- generator ----------
  await side("Generator").click();
  const gen = main.locator('[aria-label="Generated password"]').first();
  await gen.waitFor({ timeout: 8000 });
  // "..." shows until the first value arrives.
  const genValue = await poll(async () => {
    const t = (await gen.textContent()).trim();
    return t !== "..." && t.length >= 12 ? t : "";
  }, 8000);
  await main.getByRole("button", { name: "Copy", exact: true }).first().click();
  const genCopied = await poll(() => clip() === genValue, 5000);
  const history = await poll(async () => (await invoke("generator_history")).length, 5000);
  await sleep(300);
  await shot(main, "15-generator");
  check("Generator: makes a password, copies it, keeps it in history", genValue && genCopied && history === 1, `${genValue.length} characters, history ${history}`);

  // ---------- import ----------
  const csv = join(DATA, "bitwarden-export.csv");
  writeFileSync(
    csv,
    [
      "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp",
      ",,login,Mail,,,,https://mail.example.org,ann@example.org,password123,",
      ",,login,Forum,,,,https://forum.example.org,ann,password123,",
      ",1,login,Bank,,,,https://bank.example.org,ann.b,Vr7#kq-Lm2!xz-Pw9,",
      ",,login,Shop,,,,http://shop.example.org,ann,Shop-pass-2019-x,",
      ",,note,Wifi notes,The guest network is coffer-guest.,,,,,,",
    ].join("\n") + "\n",
  );
  await side("Import").click();
  await main.getByRole("button", { name: "Choose file" }).click();
  const filled = win("fill-dialog", String(app.pid), "Import passwords", csv);
  check("Import: the real file dialog takes the file", filled.ok, filled.error ?? "");
  const importBtn = main.getByRole("button", { name: /^Import \d+ items?$/ });
  await importBtn.waitFor({ timeout: 10000 });
  const label = await importBtn.innerText();
  await shot(main, "16-import-preview");
  await importBtn.click();
  await main.getByRole("button", { name: /Undo this import/ }).waitFor({ timeout: 10000 });
  const status2 = await invoke("vault_status");
  check("Import: Bitwarden CSV, 5 items in one step", label.trim() === "Import 5 items" && status2.itemCount === 6, `${label.trim()}, itemCount ${status2.itemCount}`);
  await shot(main, "17-import-result");
  await main.getByRole("button", { name: "Delete it" }).click();
  const gone = await poll(() => !existsSync(csv), 5000);
  check("Import: Delete it removes the plain CSV", gone);

  // ---------- health ----------
  await side("Health").click();
  await main.getByRole("heading", { name: "Health" }).waitFor({ timeout: 8000 });
  await sleep(600);
  const report = await invoke("health_report");
  const healthText = await main.locator("main, [role=main], body").first().innerText();
  check(
    "Health: a score and the reused password show",
    report.score !== null && report.counts.reused >= 2 && /reused/i.test(healthText),
    `score ${report.score}, counts ${JSON.stringify(report.counts)}`,
  );
  await shot(main, "18-health");

  check("no console errors in either window", errors.length === 0, errors.slice(0, 5).join(" | "));

  // ---------- quit ----------
  await main.evaluate(() => window.__TAURI_INTERNALS__.invoke("app_quit")).catch(() => undefined);
  await poll(() => exitCode !== null, 10000);
  check("app_quit: the app exits with code 0", exitCode === 0, `exit ${exitCode}`);
  const leftovers = readdirSync(VAULTS).filter((f) => f.endsWith(".tmp"));
  check("no temporary vault files left", leftovers.length === 0, leftovers.join(", "));
} catch (e) {
  check("the run finished without an exception", false, e.stack?.split("\n").slice(0, 3).join(" / "));
  try {
    const p = browser?.contexts().flatMap((c) => c.pages()).find((x) => new URL(x.url()).pathname === "/");
    if (p) await shot(p, "99-failure");
  } catch {
    /* ignore */
  }
} finally {
  await browser?.close().catch(() => undefined);
  if (exitCode === null) {
    console.log(`real-app: stopping pid ${app.pid}`);
    app.kill();
  }
}

if (shots.length) {
  const sheet = join(SHOTS, "contact-sheet.png");
  try {
    win("contact-sheet", sheet, ...shots);
    console.log(`real-app: contact sheet ${sheet}`);
  } catch (e) {
    console.log(`real-app: no contact sheet (${e.message.split("\n")[0]})`);
  }
}
const failed = results.filter((r) => !r.ok);
console.log(`real-app: ${results.length - failed.length} of ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
