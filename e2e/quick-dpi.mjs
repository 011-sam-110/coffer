#!/usr/bin/env node
// Quick Access on every monitor of this PC: opens it on each monitor in turn
// (from a small test window there, with the hotkey) and measures, inside the
// page, the device pixel ratio and the page size. On a monitor at 175 % the
// page must report devicePixelRatio 1.75; at 100 % it must report 1. The page
// must be 400 x 560 CSS px everywhere, and no item name may be cut.
//
// Build first, with an identifier of its own so a Coffer you use stays out of it:
//   pnpm exec vite build
//   TAURI_CONFIG='{"identifier":"dev.sampo.coffer.qa"}' cargo build -p coffer --features tauri/custom-protocol
// Run:
//   node e2e/quick-dpi.mjs
// Env: COFFER_EXE, COFFER_E2E_DIR (default %TEMP%\coffer-dpi, emptied first),
//      COFFER_CDP_PORT (default 9334), COFFER_PLAYWRIGHT.
//      COFFER_DPI_HIDDEN=1: start as Windows starts it (--hidden, "start hidden",
//      capture protection on, the main window never shown), on a fresh vault.
// Side effects: a test window opens on each monitor for a few seconds and
// takes the keyboard focus; Ctrl+Shift+Space is pressed while this Coffer
// holds that hotkey. Screenshots go to .shots-dpi/ (git-ignored).
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  console.error("quick-dpi: playwright-core not found. Set COFFER_PLAYWRIGHT to its path.");
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
const DATA = process.env.COFFER_E2E_DIR ?? join(tmpdir(), "coffer-dpi");
const VAULTS = join(DATA, "vaults");
const PORT = Number(process.env.COFFER_CDP_PORT ?? 9334);
const SHOTS = join(root, ".shots-dpi");
const PY = process.env.PYTHON ?? "python";
const WIN = join(root, "e2e", "win.py");
const MASTER = "Plum orbit lantern 2026 quartz!";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail });
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

if (!existsSync(EXE)) {
  console.error(`quick-dpi: ${EXE} is not there. Build it first (see the top of this file).`);
  process.exit(2);
}
const monitors = JSON.parse(execFileSync(PY, [WIN, "monitors"], { encoding: "utf8" }));
console.log(`quick-dpi: ${monitors.length} monitors: ${monitors.map((m) => `${m.device} ${m.scale * 100}%`).join(", ")}`);

rmSync(DATA, { recursive: true, force: true });
mkdirSync(VAULTS, { recursive: true });
mkdirSync(SHOTS, { recursive: true });
writeFileSync(join(SHOTS, ".gitignore"), "*\n");
for (const f of readdirSync(SHOTS)) if (f.endsWith(".png")) rmSync(join(SHOTS, f));
const HIDDEN = process.env.COFFER_DPI_HIDDEN === "1";
// The first, visible run makes the vault; a hidden run needs a vault to stay hidden.
writeFileSync(join(DATA, "settings.json"), JSON.stringify({ version: 1, captureProtection: HIDDEN, startHidden: true }, null, 2));

async function makeVault() {
  const first = spawn(EXE, [], { env: appEnv(), stdio: "ignore" });
  const b = await poll(() => chromium.connectOverCDP(`http://127.0.0.1:${PORT}`), 30000, 500);
  const m = await poll(() => b.contexts().flatMap((c) => c.pages()).find((p) => new URL(p.url()).pathname === "/"), 15000);
  await poll(() => m.evaluate(() => window.__TAURI_INTERNALS__.invoke("app_info")), 15000);
  await m.evaluate(([n, pw]) => window.__TAURI_INTERNALS__.invoke("vault_create", { name: n, password: pw, usePickedFolder: false }), ["DPI Vault", MASTER]);
  await m.evaluate(() => window.__TAURI_INTERNALS__.invoke("app_quit")).catch(() => undefined);
  await b.close().catch(() => undefined);
  await poll(() => first.exitCode !== null, 10000);
}
function appEnv() {
  return { ...process.env, COFFER_DATA_DIR: DATA, COFFER_VAULT_DIR: VAULTS, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` };
}
if (HIDDEN) await makeVault();

const app = spawn(EXE, HIDDEN ? ["--hidden"] : [], {
  env: appEnv(),
  stdio: ["ignore", "ignore", "ignore"],
});
console.log(`quick-dpi: ${EXE} pid ${app.pid}, data ${DATA}`);
/** Wait for a test window to close; one that hangs is closed after 15 s. */
const probeDone = (probe) =>
  Promise.race([new Promise((res) => probe.on("exit", res)), sleep(15000).then(() => probe.kill())]);
/** Windows says the Quick Access window is shown (it waits up to 4 s). */
const quickShown = () => JSON.parse(execFileSync(PY, [WIN, "quick-visible", String(app.pid), "4"], { encoding: "utf8" }).trim().split("\n").pop()).visible;

let browser;
try {
  browser = await poll(() => chromium.connectOverCDP(`http://127.0.0.1:${PORT}`), 30000, 500);
  if (!browser) throw new Error(`no DevTools endpoint on port ${PORT}`);
  const pages = () => browser.contexts().flatMap((c) => c.pages());
  const main = await poll(() => pages().find((p) => new URL(p.url()).pathname === "/"), 15000);
  const quick = await poll(() => pages().find((p) => p.url().includes("quick.html")), 15000);
  const invoke = (cmd, args = {}) => main.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
  await poll(() => invoke("app_info"), 15000);

  // A vault with items whose names are long enough to be cut in a narrow page.
  if (HIDDEN) await invoke("vault_unlock", { password: MASTER, secretKey: null });
  else await invoke("vault_create", { name: "DPI Vault", password: MASTER, usePickedFolder: false });
  const login = (title, user, fav) => ({
    type: "login",
    title,
    favorite: fav,
    tags: [],
    fields: [
      { id: "u", label: "Username", kind: "text", value: user, section: null, builtin: "username" },
      { id: "p", label: "Password", kind: "concealed", value: "Example-pass-1234", section: null, builtin: "password" },
      { id: "t", label: "One-time code", kind: "totp", value: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP", section: null, builtin: "totp" },
    ],
    notes: "",
    urls: [],
    apps: [],
    reprompt: false,
    autotypeSequence: null,
    healthExcluded: false,
  });
  const names = ["GitHub personal account", "Google workspace admin", "Amazon Web Services root"];
  for (const n of names) await invoke("item_save", { item: login(n, "sam@example.com", true), password: null });
  const hotkey = (await invoke("app_info"))?.hotkeyStatus?.quick;
  check("this Coffer holds Ctrl+Shift+Space", hotkey === "ok", hotkey);
  if (hotkey !== "ok") throw new Error("the hotkey is not this Coffer's: the test would press keys into another app");

  // A 100 % monitor first (the window was made on the primary), then every
  // monitor, then the first one again.
  const order = [...monitors.filter((m) => !m.primary), ...monitors.filter((m) => m.primary)];
  if (order.length > 1) order.push(order[0]);
  for (const [n, m] of order.entries()) {
    const [l, t, r, b] = m.work;
    const x = Math.round((l + r) / 2 - 210);
    const y = Math.round(t + (b - t) * 0.15);
    const probe = spawn(PY, [WIN, "focus-at", String(x), String(y), "6"], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    probe.stdout.on("data", (d) => (out += d));
    // The hotkey is pressed once the test window is in front; then Quick Access must take the focus.
    const front = await poll(() => out.includes('"front": true'), 8000, 100);
    const visible = front && quickShown();
    await sleep(700);
    const metrics = await quick.evaluate(() => {
      const titles = [...document.querySelectorAll('[role="option"] .truncate.font-medium')].map((e) => ({ text: e.textContent, shown: e.clientWidth, needs: e.scrollWidth }));
      return { dpr: window.devicePixelRatio, w: window.innerWidth, h: window.innerHeight, x: window.screenX, y: window.screenY, titles };
    });
    const tag = `${n + 1}-${m.device.replace(/\W/g, "")}-${Math.round(m.scale * 100)}`;
    await quick.screenshot({ path: join(SHOTS, `${tag}.png`), scale: "device" }).catch((e) => console.log(`(screenshot ${tag}: ${e.message})`));
    const cut = metrics.titles.filter((t) => t.needs > t.shown + 1);
    console.log(`  ${tag}: ${JSON.stringify({ ...metrics, titles: metrics.titles.map((t) => `${t.text} ${t.shown}/${t.needs}`) })} probe=${out.trim().replace(/\n/g, " ")}`);
    check(`${m.device} (${m.scale * 100}%): Quick Access opened`, visible, front ? "" : "the test window did not come to the front");
    check(`${m.device}: page scale = monitor scale`, Math.abs(metrics.dpr - m.scale) < 0.01, `devicePixelRatio ${metrics.dpr}, monitor ${m.scale}`);
    // At 175 % the window is 700 x 980 px; Chromium may round the page up by one.
    check(`${m.device}: page is 400 x 560`, Math.abs(metrics.w - 400) <= 1 && Math.abs(metrics.h - 560) <= 1, `${metrics.w} x ${metrics.h}`);
    check(`${m.device}: no item name is cut`, metrics.titles.length > 0 && cut.length === 0, cut.map((t) => `${t.text}: ${t.shown} of ${t.needs} px`).join("; "));
    await invoke("quick_hide").catch(() => undefined);
    await probeDone(probe);
  }

  // A zoom gesture (Ctrl + wheel; a touchpad pinch also zooms) must not
  // zoom Quick Access, and the next open must be at 100 % zoom.
  {
    const m = order[0];
    const [l, t, r] = m.work;
    const probe = spawn(PY, [WIN, "focus-at", String(Math.round((l + r) / 2 - 210)), String(t + 40), "8"], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    probe.stdout.on("data", (d) => (out += d));
    await poll(() => out.includes('"front": true'), 8000, 100);
    // The wheel goes to the visible Quick Access window: wait until Windows shows it.
    const up = quickShown();
    await sleep(500);
    const before = await quick.evaluate(() => ({ dpr: window.devicePixelRatio, w: window.innerWidth, pinch: window.visualViewport?.scale ?? 1 }));
    const wheel = JSON.parse(execFileSync(PY, [WIN, "ctrl-wheel", String(app.pid), "3"], { encoding: "utf8" }).trim().split("\n").pop());
    await sleep(700);
    const after = await quick.evaluate(() => ({ dpr: window.devicePixelRatio, w: window.innerWidth, pinch: window.visualViewport?.scale ?? 1 }));
    await quick.screenshot({ path: join(SHOTS, "9-after-ctrl-wheel.png"), scale: "device" }).catch(() => undefined);
    console.log(`  zoom gesture: before ${JSON.stringify(before)} after ${JSON.stringify(after)} wheel=${JSON.stringify(wheel)}`);
    check("Ctrl + wheel does not zoom Quick Access", up && wheel.ok && after.dpr === before.dpr && after.w === before.w, `${wheel.ok ? "" : `wheel not sent: ${wheel.error}; `}devicePixelRatio ${before.dpr} -> ${after.dpr}, width ${before.w} -> ${after.w}`);
    // A touchpad pinch, as DevTools sends it.
    const cdp = await quick.context().newCDPSession(quick);
    await cdp.send("Input.synthesizePinchGesture", { x: 200, y: 150, scaleFactor: 2.5, gestureSourceType: "mouse" }).catch((e) => console.log(`(pinch: ${e.message})`));
    await sleep(500);
    const pinched = await quick.evaluate(() => window.visualViewport?.scale ?? 1);
    await quick.screenshot({ path: join(SHOTS, "9-after-pinch.png"), scale: "device" }).catch(() => undefined);
    check("A pinch does not zoom Quick Access", pinched === 1, `visual zoom ${pinched}`);
    await invoke("quick_hide").catch(() => undefined);
    await probeDone(probe);

    // The next open: no zoom left over from before.
    const again = spawn(PY, [WIN, "focus-at", String(Math.round((l + r) / 2 - 210)), String(t + 40), "5"], { stdio: ["ignore", "pipe", "inherit"] });
    let out2 = "";
    again.stdout.on("data", (d) => (out2 += d));
    await poll(() => out2.includes('"front": true'), 8000, 100);
    await poll(() => quick.evaluate(() => document.hasFocus()), 4000);
    await sleep(600);
    const reopened = await quick.evaluate(() => ({ dpr: window.devicePixelRatio, w: window.innerWidth, pinch: window.visualViewport?.scale ?? 1 }));
    await quick.screenshot({ path: join(SHOTS, "9-reopened.png"), scale: "device" }).catch(() => undefined);
    console.log(`  reopened: ${JSON.stringify(reopened)}`);
    check("The next open has no zoom", reopened.pinch === 1 && reopened.dpr === before.dpr, JSON.stringify(reopened));
    await invoke("quick_hide").catch(() => undefined);
    await new Promise((res) => again.on("exit", res));
  }
} catch (e) {
  check("run finished", false, e.message);
} finally {
  await browser
    ?.contexts()
    .flatMap((c) => c.pages())
    .find((p) => new URL(p.url()).pathname === "/")
    ?.evaluate(() => window.__TAURI_INTERNALS__.invoke("app_quit"))
    .catch(() => undefined);
  await sleep(1500);
  if (app.exitCode === null) app.kill();
}
const failed = results.filter((r) => !r.ok);
console.log(`quick-dpi: ${results.length - failed.length} of ${results.length} passed. Screenshots: ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
