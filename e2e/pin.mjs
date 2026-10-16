#!/usr/bin/env node
// PIN unlock in the REAL app (debug build), over the WebView2 DevTools protocol:
// set a PIN, lock, unlock with it in the main window (typed into the boxes)
// and from Quick Access, count wrong PINs, keep working after a restart,
// remove itself at the fifth wrong PIN, and ask for the master password
// again when the days run out (COFFER_TEST_DAYS_AHEAD, debug builds only).
// The vault file must not change when a PIN is set.
//
// Build first (see e2e/quick-dpi.mjs: a QA identifier keeps your own Coffer out of it).
// Run: node e2e/pin.mjs
// Env: COFFER_EXE, COFFER_E2E_DIR (default %TEMP%\coffer-pin, emptied first),
//      COFFER_CDP_PORT (default 9335), COFFER_PLAYWRIGHT.
// No keys are pressed on the desktop: the PIN goes into the page over CDP.
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
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
  console.error("pin: playwright-core not found. Set COFFER_PLAYWRIGHT to its path.");
  process.exit(2);
}
const { chromium } = loadPlaywright();
function findExe() {
  if (process.env.COFFER_EXE) return process.env.COFFER_EXE;
  try {
    const meta = JSON.parse(execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], { cwd: root, encoding: "utf8" }));
    return join(meta.target_directory, "debug", "coffer.exe");
  } catch {
    return join(root, "target", "debug", "coffer.exe");
  }
}

const EXE = findExe();
const DATA = process.env.COFFER_E2E_DIR ?? join(tmpdir(), "coffer-pin");
const VAULTS = join(DATA, "vaults");
const PORT = Number(process.env.COFFER_CDP_PORT ?? 9335);
const MASTER = "Plum orbit lantern 2026 quartz!";
const PIN = "482917";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
}
async function poll(fn, timeout = 8000, every = 150) {
  const end = Date.now() + timeout;
  for (;;) {
    let v;
    try {
      v = await fn();
    } catch {
      v = false;
    }
    if (v || Date.now() > end) return v;
    await sleep(every);
  }
}
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

if (!existsSync(EXE)) {
  console.error(`pin: ${EXE} is not there. Build it first.`);
  process.exit(2);
}
rmSync(DATA, { recursive: true, force: true });
mkdirSync(VAULTS, { recursive: true });
writeFileSync(join(DATA, "settings.json"), JSON.stringify({ version: 1, captureProtection: false }, null, 2));

let app = null;
let browser = null;
async function start(extraEnv = {}) {
  app = spawn(EXE, [], {
    env: { ...process.env, COFFER_DATA_DIR: DATA, COFFER_VAULT_DIR: VAULTS, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`, ...extraEnv },
    stdio: "ignore",
  });
  browser = await poll(() => chromium.connectOverCDP(`http://127.0.0.1:${PORT}`), 30000, 500);
  const pages = () => browser.contexts().flatMap((c) => c.pages());
  const main = await poll(() => pages().find((p) => new URL(p.url()).pathname === "/"), 15000);
  const quick = await poll(() => pages().find((p) => p.url().includes("quick.html")), 15000);
  await poll(() => main.evaluate(() => window.__TAURI_INTERNALS__.invoke("app_info")), 15000);
  const on = (page) => (cmd, args = {}) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
  return { main, quick, invoke: on(main), quickInvoke: on(quick) };
}
async function stop(invoke) {
  await invoke("app_quit").catch(() => undefined);
  await poll(() => app.exitCode !== null, 10000);
  await browser.close().catch(() => undefined);
  if (app.exitCode === null) app.kill();
  await sleep(800);
}

// Errors cross CDP as text; read the code and the message out of it.
async function errOf(page, cmd, args) {
  return page.evaluate(
    ([c, a]) =>
      window.__TAURI_INTERNALS__.invoke(c, a).then(
        () => null,
        (e) => ({ code: e?.code ?? null, message: e?.message ?? String(e) }),
      ),
    [cmd, args],
  );
}

try {
  let s = await start();
  await s.invoke("vault_create", { name: "PIN Vault", password: MASTER, usePickedFolder: false });
  const vaultFile = join(VAULTS, "PIN Vault.coffer");
  const before = sha(vaultFile);

  const bad = await errOf(s.main, "pin_set", { pin: "12345", password: MASTER });
  check("pin_set refuses 5 digits", bad?.code === "invalid", bad?.message);
  const wrongPw = await errOf(s.main, "pin_set", { pin: PIN, password: "not it" });
  check("pin_set needs the right master password", wrongPw?.code === "badCredentials", wrongPw?.code);
  const set = await s.invoke("pin_set", { pin: PIN, password: MASTER });
  check("pin_set sets the PIN", set.pinSet && set.pinLength === 6);
  check("the vault file is byte-for-byte the same after the PIN is set", sha(vaultFile) === before);
  const device = readFileSync(join(DATA, "device.json"), "utf8");
  check("device.json holds a sealed PIN record, not the PIN", /"pin":/.test(device) && !device.includes(PIN));

  await s.invoke("vault_lock");
  let st = await s.invoke("vault_status");
  check("locked: the PIN can unlock", st.state === "locked" && st.pinReady && st.pinLength === 6, JSON.stringify({ pinSet: st.pinSet, pinReady: st.pinReady }));

  // The main window shows the PIN boxes; type the PIN into the page.
  const pinField = s.main.getByLabel("PIN", { exact: true });
  const shown = await poll(() => pinField.isVisible(), 8000);
  check("the main window shows the PIN entry", shown);
  await pinField.focus();
  await s.main.keyboard.type(PIN, { delay: 40 });
  const unlockedByUi = await poll(async () => (await s.invoke("vault_status")).state === "unlocked", 15000);
  check("typing the PIN in the main window unlocks", unlockedByUi);

  await s.invoke("vault_lock");
  const msgs = [];
  for (let i = 0; i < 4; i++) msgs.push((await errOf(s.main, "vault_unlock_pin", { pin: "000000" }))?.message);
  check("wrong PINs count down", msgs.join(" | ") === "Wrong PIN. 4 tries left. | Wrong PIN. 3 tries left. | Wrong PIN. 2 tries left. | Wrong PIN. 1 try left.", msgs.join(" | "));
  const viaQuick = await s.quickInvoke("vault_unlock_pin", { pin: PIN }).then((v) => v.state, (e) => String(e.message));
  check("Quick Access may unlock with the PIN, and the right PIN resets the count", viaQuick === "unlocked", viaQuick);
  await s.invoke("vault_lock");
  const afterReset = await errOf(s.main, "vault_unlock_pin", { pin: "000000" });
  check("the count started again after the right PIN", afterReset?.message === "Wrong PIN. 4 tries left.", afterReset?.message);
  await s.invoke("vault_unlock_pin", { pin: PIN });
  await s.invoke("vault_lock");
  await stop(s.invoke);

  // A restart keeps the PIN.
  s = await start();
  st = await s.invoke("vault_status");
  check("after a restart the PIN can unlock", st.state === "locked" && st.pinReady, JSON.stringify({ pinReady: st.pinReady }));
  const afterRestart = await s.invoke("vault_unlock_pin", { pin: PIN }).then((v) => v.state, (e) => String(e.message));
  check("after a restart the PIN unlocks", afterRestart === "unlocked", afterRestart);
  await s.invoke("vault_lock");

  // The fifth wrong PIN removes it.
  let last = null;
  for (let i = 0; i < 5; i++) last = await errOf(s.main, "vault_unlock_pin", { pin: "999999" });
  check("the fifth wrong PIN removes the PIN", last?.code === "pinUnavailable", last?.message);
  st = await s.invoke("vault_status");
  check("after that the status has no PIN", !st.pinSet && !st.pinReady);
  const gone = await errOf(s.main, "vault_unlock_pin", { pin: PIN });
  check("the right PIN no longer opens it", gone?.code === "pinUnavailable", gone?.message);
  await s.invoke("vault_unlock", { password: MASTER, secretKey: null });
  await s.invoke("pin_set", { pin: PIN, password: MASTER });
  await s.invoke("vault_lock");
  await stop(s.invoke);

  // 15 days later (over the 14-day default) the master password comes first.
  s = await start({ COFFER_TEST_DAYS_AHEAD: "15" });
  st = await s.invoke("vault_status");
  check("15 days later the PIN is set but cannot unlock", st.pinSet && !st.pinReady, JSON.stringify({ pinSet: st.pinSet, pinReady: st.pinReady }));
  const stale = await errOf(s.main, "vault_unlock_pin", { pin: PIN });
  check("15 days later the PIN asks for the master password", stale?.code === "pinUnavailable" && /every 14 days/.test(stale.message), stale?.message);
  const passwordShown = await poll(() => s.main.getByLabel("Master password", { exact: true }).isVisible(), 8000);
  check("15 days later the main window shows the master password", passwordShown);
  await s.invoke("vault_unlock", { password: MASTER, secretKey: null });
  await s.invoke("vault_lock");
  st = await s.invoke("vault_status");
  check("one master-password unlock makes the PIN work again", st.pinReady);
  const offStatus = await s.invoke("vault_unlock_pin", { pin: PIN }).then(() => s.invoke("pin_set", { pin: null, password: null }));
  check("pin_set null turns the PIN off", !offStatus.pinSet);
  await stop(s.invoke);
} catch (e) {
  check("run finished", false, e.message);
  if (app && app.exitCode === null) app.kill();
}
const failed = results.filter((r) => !r.ok);
console.log(`pin: ${results.length - failed.length} of ${results.length} passed.`);
process.exit(failed.length ? 1 : 0);
