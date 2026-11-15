#!/usr/bin/env node
// The browser bridge end to end (SPEC 3.13, docs/BRIDGE.md): a QA Coffer, the
// real coffer-bridge.exe under a QA host name, and the unpacked extension in
// Playwright's Chromium (Chrome for Testing, its own profile).
//
//   Coffer not running -> Not connected -> Connect: the popup and Coffer's
//   prompt show the same four words -> Allow -> Connected -> a message with a
//   wrong MAC, and a replayed one, are refused (straight to the pipe) -> lock:
//   Coffer locked -> unlock -> Disconnect in Settings: Not connected -> Deny
//   stores nothing -> with Coffer quit, the bridge starts it again.
//
// Build first (a QA identity keeps your own Coffer out of it):
//   pnpm exec vite build
//   TAURI_CONFIG='{"identifier":"dev.sampo.coffer.qa3","productName":"CofferQA3"}' cargo build -p coffer --features tauri/custom-protocol
//   cargo build -p coffer-bridge
// Run: node e2e/bridge.mjs
// Env: COFFER_E2E_DIR (default %TEMP%\coffer-bridge-e2e, emptied first), COFFER_CDP_PORT (9343),
//      COFFER_QA_HOST (dev.sampo.coffer.qa3), COFFER_SHOTS (screenshots), COFFER_PLAYWRIGHT.
//
// The QA host goes into HKCU\Software\Chromium\NativeMessagingHosts only (the key
// Chrome for Testing reads; Chrome and Edge never read it) and is deleted at the
// end. Nothing touches your Chrome or Edge profiles. No key is pressed on the desktop.
import { execFileSync, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { connect as netConnect } from "node:net";
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
  console.error("bridge: playwright-core not found. Set COFFER_PLAYWRIGHT to its path.");
  process.exit(2);
}
const { chromium } = loadPlaywright();

const target = JSON.parse(execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], { cwd: root, encoding: "utf8" })).target_directory;
const EXE = join(target, "debug", "coffer.exe");
const BRIDGE = join(target, "debug", "coffer-bridge.exe");
const SCRATCH = process.env.COFFER_E2E_DIR ?? join(tmpdir(), "coffer-bridge-e2e");
const DATA = join(SCRATCH, "data");
const VAULTS = join(SCRATCH, "vaults");
const SHOTS = process.env.COFFER_SHOTS ?? join(SCRATCH, "shots");
const EXT = join(SCRATCH, "extension");
const PORT = Number(process.env.COFFER_CDP_PORT ?? 9343);
const HOST = process.env.COFFER_QA_HOST ?? "dev.sampo.coffer.qa3";
const EXT_ID = "jdnmjnanpckdfdhfclpkcbgimdjbeglj";
const REG = `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${HOST}`;
const MASTER = "Plum orbit lantern 2026 quartz!";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
}
async function poll(fn, timeout = 10000, every = 150) {
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

// ---------- refuse anything that could touch the real Coffer ----------
if (HOST === "dev.sampo.coffer" || !/^[a-z0-9_.]+$/.test(HOST)) {
  console.error(`bridge: refused: the QA host name must not be Coffer's own (${HOST}).`);
  process.exit(2);
}
for (const f of [EXE, BRIDGE]) {
  if (!existsSync(f)) {
    console.error(`bridge: ${f} is not there. Build it first (see the header).`);
    process.exit(2);
  }
}
if (!readFileSync(EXE).includes(Buffer.from(`"identifier":"${HOST}"`)) && !readFileSync(EXE).includes(Buffer.from(HOST))) {
  console.error(`bridge: refused: ${EXE} is not a QA build with the identifier ${HOST}.`);
  process.exit(2);
}

rmSync(SCRATCH, { recursive: true, force: true });
for (const d of [DATA, VAULTS, SHOTS]) mkdirSync(d, { recursive: true });
writeFileSync(join(DATA, "settings.json"), JSON.stringify({ version: 1, captureProtection: false, startWithWindows: false, startHidden: false, closeNoticeShown: true }, null, 2));

// The extension with the QA host name, and a copy next to the debug exe (Settings shows that folder).
execFileSync(process.execPath, [join(root, "extension", "build.mjs")], { cwd: root, env: { ...process.env, COFFER_EXTENSION_OUT: EXT, COFFER_HOST: HOST }, stdio: "inherit" });
rmSync(join(target, "debug", "extension"), { recursive: true, force: true });
cpSync(EXT, join(target, "debug", "extension"), { recursive: true });

// A bridge copy in a folder with no coffer.exe: "Coffer is not running".
const lonely = join(SCRATCH, "no-coffer");
mkdirSync(lonely, { recursive: true });
copyFileSync(BRIDGE, join(lonely, "coffer-bridge.exe"));
const MANIFEST = join(SCRATCH, `${HOST}.json`);
const hostManifest = (exe) =>
  writeFileSync(MANIFEST, JSON.stringify({ name: HOST, description: "Coffer bridge (QA)", path: exe, type: "stdio", allowed_origins: [`chrome-extension://${EXT_ID}/`] }, null, 2));
hostManifest(join(lonely, "coffer-bridge.exe"));

const QA_ENV = { COFFER_DATA_DIR: DATA, COFFER_VAULT_DIR: VAULTS, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` };
let app = null;
let cdp = null;
let ctx = null;
let regAdded = false;
const started = [];

function regAdd() {
  try {
    execFileSync("reg", ["query", REG], { stdio: "ignore" });
    console.error(`bridge: refused: ${REG} exists already. Delete it first.`);
    process.exit(2);
  } catch {
    /* not there: good */
  }
  execFileSync("reg", ["add", REG, "/ve", "/t", "REG_SZ", "/d", MANIFEST, "/f"], { stdio: "ignore" });
  regAdded = true;
}
function regDelete() {
  if (!regAdded) return;
  try {
    execFileSync("reg", ["delete", REG, "/f"], { stdio: "ignore" });
  } catch {
    /* gone */
  }
  regAdded = false;
}

async function connectCoffer() {
  cdp = await poll(() => chromium.connectOverCDP(`http://127.0.0.1:${PORT}`), 30000, 500);
  const pages = () => cdp.contexts().flatMap((c) => c.pages());
  const main = await poll(() => pages().find((p) => new URL(p.url()).pathname === "/"), 15000);
  await poll(() => main.evaluate(() => window.__TAURI_INTERNALS__.invoke("app_info")), 15000);
  const invoke = (cmd, args = {}) => main.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
  return { main, invoke };
}

async function startCoffer() {
  app = spawn(EXE, [], { env: { ...process.env, ...QA_ENV }, stdio: "ignore" });
  started.push(app.pid);
  return connectCoffer();
}

async function quitCoffer(invoke) {
  await invoke("app_quit").catch(() => undefined);
  await cdp?.close().catch(() => undefined);
  cdp = null;
  await sleep(1500);
}

/** PIDs of coffer.exe processes running the QA debug exe (none of them is your Coffer). */
function qaPids() {
  const out = execFileSync("powershell", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "Name='coffer.exe'" | Where-Object { $_.ExecutablePath -eq '${EXE.replace(/'/g, "''")}' } | ForEach-Object { $_.ProcessId }`], { encoding: "utf8" });
  return out.split(/\s+/).filter(Boolean).map(Number);
}

// ---------- the pipe, straight from Node ----------
function pipeClient(name) {
  const sock = netConnect(name);
  let buf = Buffer.alloc(0);
  const waiters = [];
  sock.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 4) {
      const n = buf.readUInt32LE(0);
      if (buf.length < 4 + n) break;
      const msg = JSON.parse(buf.subarray(4, 4 + n).toString("utf8"));
      buf = buf.subarray(4 + n);
      waiters.shift()?.(msg);
    }
  });
  const ready = new Promise((res, rej) => {
    sock.once("connect", res);
    sock.once("error", rej);
  });
  const send = (obj) =>
    new Promise((res) => {
      waiters.push(res);
      const body = Buffer.from(JSON.stringify(obj));
      const head = Buffer.alloc(4);
      head.writeUInt32LE(body.length);
      sock.write(Buffer.concat([head, body]));
    });
  return { ready, send, close: () => sock.destroy() };
}
const mac = (key, label, client, body) => createHmac("sha256", key).update(Buffer.concat([Buffer.from(label), Buffer.from([0]), Buffer.from(client), Buffer.from([0]), Buffer.from(body)])).digest("base64");

async function popupState(popup) {
  return popup.evaluate(() => ({ state: document.querySelector(".body")?.getAttribute("data-state"), title: document.querySelector("h1")?.textContent ?? "", message: document.querySelector('[role="alert"]')?.textContent ?? null, words: document.querySelector("[data-words]")?.textContent ?? null }));
}
async function waitPopup(popup, state, timeout = 15000) {
  return poll(async () => (await popupState(popup)).state === state, timeout, 200);
}
async function shotPopup(popup, name) {
  await popup.locator("body").screenshot({ path: join(SHOTS, `${name}.png`) });
}

const cleanup = async () => {
  await ctx?.close().catch(() => undefined);
  await cdp?.close().catch(() => undefined);
  regDelete();
  for (const pid of new Set([...started, ...qaPids()])) {
    try {
      process.kill(pid);
    } catch {
      /* gone */
    }
  }
};
process.on("SIGINT", async () => {
  await cleanup();
  process.exit(130);
});

try {
  regAdd();
  check("the QA host is registered for Chromium only", execFileSync("reg", ["query", REG, "/ve"], { encoding: "utf8" }).includes(MANIFEST));

  ctx = await chromium.launchPersistentContext(join(SCRATCH, "profile"), {
    channel: "chromium",
    headless: true,
    viewport: { width: 1000, height: 760 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    // A Coffer the bridge starts must use the QA folders too.
    env: { ...process.env, ...QA_ENV },
  });
  let [sw] = ctx.serviceWorkers();
  sw ??= await ctx.waitForEvent("serviceworker", { timeout: 20000 });
  check("the extension's service worker runs with the fixed ID", sw.url().startsWith(`chrome-extension://${EXT_ID}/`), sw.url());

  const welcome = await poll(() => ctx.pages().find((p) => p.url().includes("welcome.html")), 10000);
  check("the first-run page opens on install", !!welcome);
  if (welcome) {
    await welcome.waitForLoadState();
    await poll(async () => (await welcome.locator("#offers").textContent())?.length > 0, 5000);
    await welcome.screenshot({ path: join(SHOTS, "welcome.png") });
    const before = await welcome.locator("#offers").textContent();
    await welcome.locator("#turn-off").click().catch(() => undefined);
    const after = await poll(async () => {
      const t = await welcome.locator("#offers").textContent();
      return t?.includes("off") ? t : false;
    }, 5000);
    check("the first-run page turns off the browser's own password offers", !!after && (await sw.evaluate(async () => (await chrome.privacy.services.passwordSavingEnabled.get({})).value)) === false, `${before} -> ${after}`);
  }

  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 320, height: 240 });
  await popup.goto(`chrome-extension://${EXT_ID}/popup/popup.html`);
  check("no Coffer: the popup shows Coffer is not running", await waitPopup(popup, "notRunning", 20000), JSON.stringify(await popupState(popup)));
  await shotPopup(popup, "popup-not-running");

  // ---------- a QA Coffer with a vault ----------
  hostManifest(BRIDGE);
  let coffer = await startCoffer();
  await coffer.invoke("vault_create", { name: "Bridge Vault", password: MASTER, usePickedFolder: false });
  const pipeName = execFileSync(BRIDGE, ["--pipe-name"], { encoding: "utf8" }).trim();
  check("the pipe name carries the user SID and the install key", /^\\\\\.\\pipe\\coffer-bridge-S-1-[\d-]+-[0-9a-f]{16}$/.test(pipeName), pipeName);

  await popup.getByRole("button", { name: "Try again" }).click();
  check("Coffer running: the popup shows Not connected", await waitPopup(popup, "notConnected"), JSON.stringify(await popupState(popup)));
  await shotPopup(popup, "popup-not-connected");

  // ---------- Connect ----------
  await popup.getByRole("button", { name: "Connect" }).click();
  const popupWords = await poll(async () => (await popupState(popup)).words, 10000);
  const promptWords = await poll(() => coffer.main.locator("[data-pair-words]").textContent(), 10000);
  check("Connect: Coffer shows its prompt", !!promptWords && (await coffer.main.getByText("Connect Chromium to Coffer?").isVisible()));
  check("the popup and Coffer's prompt show the same four words", !!popupWords && popupWords === promptWords && popupWords.split(" · ").length === 4, `${popupWords} | ${promptWords}`);
  await shotPopup(popup, "popup-words");
  check("Allow is off for the first second", await coffer.main.locator("button[data-allow]").isDisabled());
  await poll(() => coffer.main.locator("button[data-allow]").isEnabled(), 3000);
  await coffer.main.screenshot({ path: join(SHOTS, "coffer-prompt.png") });
  await coffer.main.locator("button[data-allow]").click();
  check("after Allow the popup shows Connected", await waitPopup(popup, "connected"), JSON.stringify(await popupState(popup)));
  await shotPopup(popup, "popup-connected");
  const pairing = (await sw.evaluate(() => chrome.storage.local.get("pairing"))).pairing;
  check("the extension keeps its client id and key", /^[0-9a-f]{32}$/.test(pairing?.client ?? "") && Buffer.from(pairing?.key ?? "", "base64").length === 32);
  const browsersJson = readFileSync(join(DATA, "browsers.json"), "utf8");
  check("Coffer keeps the browser with its key sealed (not in clear)", browsersJson.includes(pairing.client) && !browsersJson.includes(pairing.key) && /"browser": "chromium"/.test(browsersJson));

  // ---------- straight to the pipe ----------
  {
    const key = Buffer.from(pairing.key, "base64");
    const pipe = pipeClient(pipeName);
    await pipe.ready;
    const hello = await pipe.send({ id: 1, call: "hello", args: { version: "test", browser: "other", client: pairing.client } });
    const nonce = hello.result?.nonce;
    check("hello on the pipe: version, paired, a nonce", hello.result?.paired === true && hello.result?.version && nonce, JSON.stringify(hello.result));
    const body = JSON.stringify({ call: "status", args: {}, nonce, seq: 1 });
    const wrong = await pipe.send({ id: 2, client: pairing.client, body, mac: mac(Buffer.alloc(32, 7), "coffer/v1/req", pairing.client, body) });
    check("a message with a wrong MAC is refused", wrong.error === "bad_mac" && !wrong.body, JSON.stringify(wrong));
    const tampered = await pipe.send({ id: 3, client: pairing.client, body: body.replace('"status"', '"unlock"'), mac: mac(key, "coffer/v1/req", pairing.client, body) });
    check("a body changed after signing is refused", tampered.error === "bad_mac", JSON.stringify(tampered));
    const right = { id: 4, client: pairing.client, body, mac: mac(key, "coffer/v1/req", pairing.client, body) };
    const ok = await pipe.send(right);
    const okBody = ok.body ? JSON.parse(ok.body) : {};
    check("the right MAC works, and Coffer signs its answer", okBody.ok === true && ok.mac === mac(key, "coffer/v1/res", pairing.client, ok.body), ok.body);
    const again = await pipe.send({ ...right, id: 5 });
    check("the same message again is refused as a replay", again.error === "replay", JSON.stringify(again));
    const unsigned = await pipe.send({ id: 6, call: "list_logins", args: { url: "https://example.com/" } });
    check("a vault call with no MAC is refused", unsigned.error === "bad_mac", JSON.stringify(unsigned));
    pipe.close();
  }

  // ---------- locked ----------
  await coffer.invoke("vault_lock");
  check("lock Coffer: the popup shows Coffer is locked", await waitPopup(popup, "locked"), JSON.stringify(await popupState(popup)));
  await shotPopup(popup, "popup-locked");
  await popup.getByRole("button", { name: "Unlock Coffer" }).click();
  await sleep(800);
  check("Unlock Coffer asks Coffer to show its unlock, and nothing else", (await popupState(popup)).state === "locked");
  await coffer.invoke("vault_unlock", { password: MASTER, secretKey: null });
  check("unlock in Coffer: the popup shows Connected again", await waitPopup(popup, "connected"));

  // ---------- Settings, Browsers ----------
  await coffer.invoke("main_show", { itemId: null, view: "settings" });
  await coffer.main.getByRole("tab", { name: "Browsers" }).click();
  await poll(() => coffer.main.getByRole("button", { name: "Disconnect" }).isVisible(), 8000);
  const folderShown = await coffer.main.locator("[data-extension-folder]").textContent();
  check("Settings, Browsers lists Chromium and the extension folder", (await coffer.main.getByText("Chromium", { exact: true }).isVisible()) && folderShown?.endsWith("\\extension"), folderShown);
  check("Settings, Browsers shows the two offer switches", (await coffer.main.getByRole("switch", { name: "Offer to save new logins" }).isVisible()) && (await coffer.main.getByRole("switch", { name: "Offer to update changed passwords" }).isVisible()));
  await coffer.main.screenshot({ path: join(SHOTS, "settings-browsers.png") });
  await coffer.main.getByRole("button", { name: "Disconnect" }).click();
  check("Disconnect in Settings: the popup shows Not connected", await waitPopup(popup, "notConnected"), JSON.stringify(await popupState(popup)));
  await shotPopup(popup, "popup-disconnected");
  check("Disconnect deleted the key on both sides", !readFileSync(join(DATA, "browsers.json"), "utf8").includes(pairing.client) && !(await sw.evaluate(() => chrome.storage.local.get("pairing"))).pairing);

  // ---------- Deny stores nothing ----------
  await popup.getByRole("button", { name: "Connect" }).click();
  await poll(() => coffer.main.locator("[data-pair-words]").isVisible(), 10000);
  await coffer.main.getByRole("button", { name: "Deny" }).click();
  check("Deny: the popup says so and shows Not connected", await poll(async () => (await popupState(popup)).message?.includes("Deny"), 8000), JSON.stringify(await popupState(popup)));
  const afterDeny = JSON.parse(readFileSync(join(DATA, "browsers.json"), "utf8"));
  check("Deny stores nothing", afterDeny.browsers.length === 0 && !(await sw.evaluate(() => chrome.storage.local.get("pairing"))).pairing);

  // ---------- Coffer quit: the bridge starts it ----------
  await quitCoffer(coffer.invoke);
  app = null;
  check("Coffer quit", qaPids().length === 0);
  await popup.reload();
  check("with Coffer quit, the bridge starts it and the popup reaches it", await waitPopup(popup, "notConnected", 25000), JSON.stringify(await popupState(popup)));
  const restarted = qaPids();
  check("the started Coffer is the QA copy, in the tray", restarted.length === 1, String(restarted));
  started.push(...restarted);
  if (restarted.length) {
    coffer = await connectCoffer().catch(() => null);
    if (coffer) await quitCoffer(coffer.invoke);
  }

  const log = readFileSync(join(DATA, "coffer.log"), "utf8");
  check("Coffer's log names the refused calls, never a key", /refused a call with a wrong MAC/.test(log) && /refused a replayed call/.test(log) && !log.includes(pairing.key));
} catch (e) {
  check("no exception", false, e?.stack ?? String(e));
} finally {
  await cleanup();
  check("the QA host key is deleted", (() => {
    try {
      execFileSync("reg", ["query", REG], { stdio: "ignore" });
      return false;
    } catch {
      return true;
    }
  })());
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed. Screenshots: ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
