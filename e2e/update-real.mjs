#!/usr/bin/env node
// Real-app run of the auto update (SPEC 3.12) on QA copies, never on Coffer:
// install QA 0.3.0 (per-user NSIS, its own folder), start it, let its timer
// find QA 0.3.1 on a server on this PC, lock it over CDP, and prove it comes
// back as 0.3.1. Then offer a 0.3.2 signed with another key and prove it is
// refused and logged. Last, quit and uninstall the QA copy.
//
// Before: two QA builds with the same productName, identifier and test public
// key, made with scripts/release.mjs (see docs/SPEC.md 3.12), and the test key
// pairs. The folder QA_DIR holds:
//   builds/<old>/<Product>_<old>_x64-setup.exe     the version to install
//   serve/latest.json + serve/<Product>_<new>_x64-setup.exe   what the server offers
//   keys/wrong.key (+ .pub)                         a second key, for the refused update
// Env: QA_DIR (required), QA_PRODUCT (default CofferQA2), QA_OLD (0.3.0),
//      QA_NEW (0.3.1), QA_PORT (static server, 5302), COFFER_CDP_PORT (9342),
//      QA_WRONG_KEY_PASSWORD (the wrong key's password).
// Side effects: it installs and uninstalls %LOCALAPPDATA%\<Product>, shows
// the NSIS progress bar and the QA window for a moment. It sends no keys to
// Windows and does not touch the clipboard.
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { tauriCli } from "../scripts/release-lib.mjs";

const require = createRequire(import.meta.url);
const { chromium } = (() => {
  for (const t of [process.env.COFFER_PLAYWRIGHT, "playwright-core", join(homedir(), ".claude/qa-runtime/node_modules/playwright-core")].filter(Boolean)) {
    try {
      return require(t);
    } catch {
      /* next */
    }
  }
  console.error("update-real: playwright-core not found.");
  process.exit(2);
})();

const QA = process.env.QA_DIR;
if (!QA || !existsSync(QA)) {
  console.error("update-real: set QA_DIR (see the top of this file).");
  process.exit(2);
}
const PRODUCT = process.env.QA_PRODUCT ?? "CofferQA2";
if (!/QA/.test(PRODUCT)) {
  console.error("update-real: QA_PRODUCT must name a QA copy, never Coffer.");
  process.exit(2);
}
const OLD = process.env.QA_OLD ?? "0.3.0";
const NEW = process.env.QA_NEW ?? "0.3.1";
const BAD = process.env.QA_BAD ?? "0.3.2";
const PORT = Number(process.env.QA_PORT ?? 5302);
const CDP = Number(process.env.COFFER_CDP_PORT ?? 9342);
const INSTALL_DIR = join(process.env.LOCALAPPDATA, PRODUCT);
const DATA = join(QA, "data");
const VAULTS = join(QA, "vaults");
const SERVE = join(QA, "serve");
const SHOTS = join(QA, "shots");
const MASTER = "Copper kettle 4471 ribbon";

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
}
async function poll(fn, timeout = 10_000, every = 300) {
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
const ps = (cmd) => execFileSync("powershell", ["-NoProfile", "-Command", cmd], { encoding: "utf8" }).trim();
const log = () => (existsSync(join(DATA, "coffer.log")) ? readFileSync(join(DATA, "coffer.log"), "utf8") : "");
const appExe = () => readdirSync(INSTALL_DIR).filter((f) => f.endsWith(".exe") && !/^uninstall/i.test(f)).map((f) => join(INSTALL_DIR, f))[0];
/** PIDs of processes that run the QA exe (by full path: never Sam's Coffer). */
const qaPids = () => {
  const exe = appExe();
  if (!exe) return [];
  const out = ps(`Get-Process | Where-Object { $_.Path -eq '${exe.replace(/'/g, "''")}' } | ForEach-Object { $_.Id }`);
  return out ? out.split(/\s+/).map(Number) : [];
};

// ---------- the update server on this PC ----------
const requests = [];
const server = createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, "http://x").pathname.slice(1));
  requests.push(`${new Date().toISOString()} ${req.method} /${name}`);
  const file = join(SERVE, basename(name));
  if (!name || !existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "Content-Type": name.endsWith(".json") ? "application/json" : "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

let browser = null;
async function connect() {
  browser = await poll(() => chromium.connectOverCDP(`http://127.0.0.1:${CDP}`), 60_000, 1000);
  if (!browser) throw new Error(`no DevTools endpoint on ${CDP}`);
  const main = await poll(() => browser.contexts().flatMap((c) => c.pages()).find((p) => new URL(p.url()).pathname === "/"), 20_000);
  if (!main) throw new Error("no main webview");
  await main.waitForFunction(() => "__TAURI_INTERNALS__" in window, null, { timeout: 20_000 });
  return main;
}
const invoke = (page, cmd, args = {}) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);

try {
  // ---------- install QA <old> ----------
  if (existsSync(INSTALL_DIR)) throw new Error(`${INSTALL_DIR} exists already: uninstall the old QA copy first.`);
  const oldInstaller = join(QA, "builds", OLD, `${PRODUCT}_${OLD}_x64-setup.exe`);
  execFileSync(oldInstaller, ["/S"], { stdio: "ignore" });
  const exe = await poll(() => existsSync(INSTALL_DIR) && appExe(), 60_000, 1000);
  check(`QA ${OLD} installs per user into its own folder`, exe && exe.startsWith(INSTALL_DIR), exe || "no exe");
  const fileVersion = () => ps(`(Get-Item '${appExe()}').VersionInfo.ProductVersion`);
  check(`the installed exe is ${OLD}`, fileVersion().startsWith(OLD), fileVersion());

  // ---------- start it, on its own data ----------
  rmSync(DATA, { recursive: true, force: true });
  rmSync(VAULTS, { recursive: true, force: true });
  mkdirSync(DATA, { recursive: true });
  mkdirSync(VAULTS, { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  // No hotkey, no auto-lock and no lock signals: the run locks over CDP only. Screenshots need capture protection off.
  writeFileSync(
    join(DATA, "settings.json"),
    JSON.stringify({ version: 1, captureProtection: false, hotkeyQuick: "", autoLockMinutes: null, lockOnSystemLock: false, lockOnSleep: false, startWithWindows: false }, null, 2),
  );
  const env = { ...process.env, COFFER_DATA_DIR: DATA, COFFER_VAULT_DIR: VAULTS, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP}` };
  const child = spawn(exe, [], { env, detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  const startedAt = Date.now();
  let main = await connect();
  const info0 = await invoke(main, "app_info");
  check(`app_info says ${OLD}`, info0.version === OLD, info0.version);
  const st0 = await invoke(main, "update_status");
  check("the updater is on (test server on this PC)", st0.phase !== "off", JSON.stringify(st0));

  await invoke(main, "vault_create", { name: "QA Update", password: MASTER, usePickedFolder: false });
  let status = await invoke(main, "vault_status");
  if (status.state !== "unlocked") status = await invoke(main, "vault_unlock", { password: MASTER, secretKey: null });
  check("a QA vault is open (unlocked)", status.state === "unlocked", status.state);

  // ---------- the timer finds <new> by itself ----------
  const ready = await poll(async () => {
    const s = await invoke(main, "update_status");
    return s.phase === "ready" ? s : false;
  }, 150_000, 2000);
  const secs = Math.round((Date.now() - startedAt) / 1000);
  check(`the timer finds ${NEW}, downloads it and checks its signature (no click)`, ready && ready.version === NEW, `${secs} s after start; ${JSON.stringify(ready)}`);
  check("the server saw latest.json, then the installer", requests.some((r) => r.endsWith("/latest.json")) && requests.some((r) => r.endsWith(`_${NEW}_x64-setup.exe`)), requests.join(" | "));
  check("the log says downloaded, signature checked", log().includes(`update: ${NEW} downloaded, signature checked`));

  // Show Settings for the review page, with the banner.
  await invoke(main, "main_show", { itemId: null, view: "settings" });
  await main.getByText(`Coffer ${NEW} is ready.`).waitFor({ timeout: 10_000 }).catch(() => undefined);
  await sleep(600);
  await main.screenshot({ path: join(SHOTS, "r1-real-ready.png") }).catch((e) => console.log(`(screenshot: ${e.message})`));
  check("the real Settings shows the ready banner", (await main.getByText(`Coffer ${NEW} is ready.`).count()) === 1);

  // ---------- unlocked: it waits ----------
  await sleep(40_000); // more than one 30 s tick
  const stillOld = (await invoke(main, "update_status")).phase === "ready" && qaPids().length === 1;
  check("unlocked: nothing installs (one tick later the update still waits)", stillOld);

  // ---------- lock: it installs and comes back as <new> ----------
  const oldPids = qaPids();
  const lockedAt = Date.now();
  await invoke(main, "vault_lock").catch(() => undefined);
  try {
    await browser.close();
  } catch {
    /* the process is going away */
  }
  const gone = await poll(() => qaPids().every((p) => !oldPids.includes(p)) || qaPids().length === 0, 60_000, 500);
  check("the lock starts the installer and the old process exits", gone);
  const back = await poll(() => {
    const pids = qaPids();
    return pids.length && pids.every((p) => !oldPids.includes(p)) ? pids : false;
  }, 180_000, 1000);
  check("the installer starts the QA copy again", back, `pid ${back} after ${Math.round((Date.now() - lockedAt) / 1000)} s`);
  check(`the installed exe is now ${NEW}`, fileVersion().startsWith(NEW), fileVersion());
  main = await connect();
  const info1 = await invoke(main, "app_info");
  check(`app_info says ${NEW}`, info1.version === NEW, info1.version);
  const vs1 = await invoke(main, "vault_status");
  check("it comes back locked, with the same vault", vs1.state === "locked" && vs1.vaultName === "QA Update", `${vs1.state} ${vs1.vaultName}`);
  const st1 = await invoke(main, "update_status");
  check("its updater is idle on the new version", st1.currentVersion === NEW && st1.version === null, JSON.stringify(st1));
  check("the log has the install and the restart", log().includes(`update: installing ${NEW} (from ${OLD}`) && log().includes(`start: updated from ${OLD} to ${NEW}`));

  // ---------- a wrong signature is refused ----------
  const wrongKey = join(QA, "keys", "wrong.key");
  const badName = `${PRODUCT}_${BAD}_x64-setup.exe`;
  copyFileSync(join(SERVE, `${PRODUCT}_${NEW}_x64-setup.exe`), join(SERVE, badName));
  const signed = tauriCli(["signer", "sign", "--private-key-path", wrongKey, "--app-version", BAD, join(SERVE, badName)], { TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.QA_WRONG_KEY_PASSWORD ?? "" });
  if (signed.status !== 0) throw new Error("could not sign the bad update with the wrong key");
  const latest = JSON.parse(readFileSync(join(SERVE, "latest.json"), "utf8"));
  const goodLatest = JSON.stringify(latest, null, 2);
  latest.version = BAD;
  latest.platforms["windows-x86_64"] = { url: `http://127.0.0.1:${PORT}/${badName}`, signature: readFileSync(join(SERVE, `${badName}.sig`), "utf8").trim() };
  writeFileSync(join(SERVE, "latest.json"), JSON.stringify(latest, null, 2));
  await invoke(main, "vault_unlock", { password: MASTER, secretKey: null });
  const refused = await invoke(main, "update_check");
  check(`${BAD} with a wrong signature is refused`, refused.phase === "idle" && refused.version === null && /failed its signature check/.test(refused.error ?? ""), JSON.stringify(refused));
  check("the log says REFUSED", log().includes(`update: REFUSED ${BAD}`), (log().match(/update: REFUSED.*$/m) ?? [""])[0].slice(0, 160));
  await invoke(main, "main_show", { itemId: null, view: "settings" });
  await main.getByRole("button", { name: "Check now" }).scrollIntoViewIfNeeded().catch(() => undefined);
  await sleep(800);
  await main.screenshot({ path: join(SHOTS, "r2-real-refused.png") }).catch((e) => console.log(`(screenshot: ${e.message})`));
  await invoke(main, "vault_lock");
  await sleep(3000);
  check("after a refused update nothing installs at the lock", qaPids().join() === String(back), `pids ${qaPids()}`);
  writeFileSync(join(SERVE, "latest.json"), goodLatest);

  // ---------- quit and uninstall ----------
  await invoke(main, "app_quit").catch(() => undefined);
  await browser.close().catch(() => undefined);
} catch (e) {
  check("run finished", false, e instanceof Error ? e.message : String(e));
} finally {
  server.close();
  for (const pid of qaPids()) {
    try {
      process.kill(pid);
    } catch {
      /* gone */
    }
  }
  await sleep(1500);
  const uninstaller = join(INSTALL_DIR, "uninstall.exe");
  if (existsSync(uninstaller)) {
    try {
      execFileSync(uninstaller, ["/S"], { stdio: "ignore" });
    } catch {
      /* reported below */
    }
    await poll(() => !existsSync(join(INSTALL_DIR, "uninstall.exe")), 60_000, 1000);
  }
  check("the QA copy is uninstalled", !existsSync(join(INSTALL_DIR, "uninstall.exe")), INSTALL_DIR);
  writeFileSync(join(QA, "update-real-report.json"), JSON.stringify({ results, requests, log: log().split(/\r?\n/).filter((l) => /update|start:/.test(l)) }, null, 2));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed. Report: ${join(QA, "update-real-report.json")}`);
  process.exit(failed ? 1 : 0);
}
