#!/usr/bin/env node
// Smart fill in the REAL app, typed by Windows into a real Chrome and Edge:
// three local sign-in pages, filled from Quick Access with Enter.
//
//   one page   an email box and a password box: Enter fills both and signs in
//   steps      email, then password, then a 6-digit code, one page at a time:
//              Enter types the email; the next open's Enter ("Type password")
//              the password; the next ("Type code") the code
//   code       a page that opens on its code box: Enter types the code
//
// The values are read back from each page. Build first (see e2e/quick-dpi.mjs).
// Run: node e2e/fill.mjs [chrome] [msedge]   (default: both)
// Env: COFFER_EXE, COFFER_E2E_DIR (default %TEMP%\coffer-fill), COFFER_CDP_PORT
//      (default 9336), COFFER_PLAYWRIGHT.
// Side effects on this PC: a browser window and Quick Access take the
// keyboard focus, and Windows types into the browser for about a minute per
// browser. Do not type meanwhile. Ctrl+Shift+Space is pressed only while this
// Coffer holds it.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
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
  console.error("fill: playwright-core not found. Set COFFER_PLAYWRIGHT to its path.");
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
const DATA = process.env.COFFER_E2E_DIR ?? join(tmpdir(), "coffer-fill");
const VAULTS = join(DATA, "vaults");
const PORT = Number(process.env.COFFER_CDP_PORT ?? 9336);
const PY = process.env.PYTHON ?? "python";
const WIN = join(root, "e2e", "win.py");
const MASTER = "Plum orbit lantern 2026 quartz!";
const EMAIL = "sam.fill@example.com";
const PASS = "Fill-pass-Ünï-4711";
const SECRET = "JBSWY3DPEHPK3PXP";
const browsers = process.argv.slice(2).length ? process.argv.slice(2) : ["chrome", "msedge"];

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

// ---------- the sign-in pages ----------
const page = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px system-ui;margin:40px}label{display:block;margin:12px 0}input{font:inherit;padding:6px;width:280px}</style>
<body>${body}<pre id="out"></pre><script>
window.result = {};
const out = (k, v) => { window.result[k] = v; document.getElementById("out").textContent = JSON.stringify(window.result); };
</script>`;
const PAGES = {
  "/one": page(
    "Fill test one page",
    `<form id="f"><label>Email <input type="email" id="email" name="email" autocomplete="username"></label>
<label>Password <input type="password" id="pw" name="password" autocomplete="current-password"></label><button>Sign in</button></form>
<script>document.getElementById("f").onsubmit = (e) => { e.preventDefault(); out("email", email.value); out("password", pw.value); out("submitted", true); };</script>`,
  ),
  "/steps": page(
    "Fill test steps",
    `<form id="s1"><label>Email or phone <input type="email" id="email" autocomplete="username"></label><button>Next</button></form>
<form id="s2" hidden><label>Enter your password <input type="password" id="pw" autocomplete="current-password"></label><button>Next</button></form>
<form id="s3" hidden><label for="code">Enter the 6-digit code from your authenticator app</label><input id="code" inputmode="numeric" autocomplete="one-time-code"><button>Verify</button></form>
<script>
s1.onsubmit = (e) => { e.preventDefault(); out("email", email.value); s1.remove(); s2.hidden = false; pw.focus(); };
s2.onsubmit = (e) => { e.preventDefault(); out("password", pw.value); s2.remove(); s3.hidden = false; code.focus(); };
s3.onsubmit = (e) => { e.preventDefault(); out("code", code.value); };
</script>`,
  ),
  "/code": page(
    "Fill test code",
    `<form id="f"><label for="code">Verification code</label><input id="code" inputmode="numeric" autocomplete="one-time-code"><button>Verify</button></form>
<script>f.onsubmit = (e) => { e.preventDefault(); out("code", code.value); };</script>`,
  ),
};
const server = createServer((req, res) => {
  const html = PAGES[req.url];
  res.writeHead(html ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
  res.end(html ?? "not found");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const SITE = `http://127.0.0.1:${server.address().port}`;

// ---------- Coffer ----------
if (!existsSync(EXE)) {
  console.error(`fill: ${EXE} is not there. Build it first.`);
  process.exit(2);
}
rmSync(DATA, { recursive: true, force: true });
mkdirSync(VAULTS, { recursive: true });
writeFileSync(join(DATA, "settings.json"), JSON.stringify({ version: 1, captureProtection: false }, null, 2));
const app = spawn(EXE, [], {
  env: { ...process.env, COFFER_DATA_DIR: DATA, COFFER_VAULT_DIR: VAULTS, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: "ignore",
});
let coffer;
let browser;
try {
  coffer = await poll(() => chromium.connectOverCDP(`http://127.0.0.1:${PORT}`), 30000, 500);
  const pages = () => coffer.contexts().flatMap((c) => c.pages());
  const main = await poll(() => pages().find((p) => new URL(p.url()).pathname === "/"), 15000);
  const quick = await poll(() => pages().find((p) => p.url().includes("quick.html")), 15000);
  const invoke = (cmd, args = {}) => main.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
  await poll(() => invoke("app_info"), 15000);
  await invoke("vault_create", { name: "Fill Vault", password: MASTER, usePickedFolder: false });
  await invoke("main_hide").catch(() => undefined);
  const login = (title, totp) => ({
    type: "login",
    title,
    favorite: false,
    tags: [],
    fields: [
      { id: "u", label: "Username", kind: "text", value: EMAIL, section: null, builtin: "username" },
      { id: "p", label: "Password", kind: "concealed", value: PASS, section: null, builtin: "password" },
      ...(totp ? [{ id: "t", label: "One-time code", kind: "totp", value: `otpauth://totp/Fill?secret=${SECRET}`, section: null, builtin: "totp" }] : []),
    ],
    notes: "",
    urls: [],
    apps: [],
    reprompt: false,
    autotypeSequence: null,
    healthExcluded: false,
  });
  const items = {};
  for (const [key, title, totp] of [
    ["one", "Onepage Login", false],
    ["steps", "Stepped Login", true],
    ["code", "Codebox Login", true],
  ])
    items[key] = (await invoke("item_save", { item: login(title, totp), password: null })).id;
  const hotkey = (await invoke("app_info"))?.hotkeyStatus?.quick;
  check("this Coffer holds Ctrl+Shift+Space", hotkey === "ok", hotkey);
  if (hotkey !== "ok") throw new Error("the hotkey is not this Coffer's: the test would press keys into another app");

  /** Open Quick Access over the browser page, search the item, press Enter (all in Quick Access). */
  async function enterFrom(title, search) {
    const r = JSON.parse(execFileSync(PY, [WIN, "front-hotkey", title], { encoding: "utf8" }).trim().split("\n").pop());
    if (!r.front) return `browser not in front (${r.error ?? "?"})`;
    if (!(await poll(() => quick.evaluate(() => document.hasFocus()), 5000))) return "Quick Access did not open";
    await sleep(400);
    // Type only into the test browser: another window in front (you, using the PC) stops the run.
    const ctx = await quick.evaluate(() => window.__TAURI_INTERNALS__.invoke("quick_context"));
    if (!/^(chrome|msedge)\.exe$/.test(ctx?.process ?? "")) {
      await quick.evaluate(() => window.__TAURI_INTERNALS__.invoke("quick_hide")).catch(() => undefined);
      throw new Error(`the window in front is ${ctx?.process ?? "unknown"}, not the test browser; nothing typed`);
    }
    const firstRow = await quick.evaluate(() => document.querySelector('[role="option"][aria-selected="true"]')?.textContent ?? "");
    await quick.keyboard.type(search, { delay: 20 });
    await poll(() => quick.evaluate((t) => (document.querySelector('[role="option"][aria-selected="true"]')?.textContent ?? "").includes(t), search), 3000);
    await quick.keyboard.press("Enter");
    return firstRow;
  }
  const code = async () => (await invoke("totp_code", { id: items.code, field: null, password: null })).code;

  for (const channel of browsers) {
    const name = channel === "msedge" ? "Edge" : "Chrome";
    try {
      browser = await chromium.launch({ channel, headless: false, args: ["--window-position=80,80", "--window-size=900,640"] });
    } catch (e) {
      check(`${name}: starts`, false, e.message.split("\n")[0]);
      continue;
    }
    const tab = await browser.newPage();
    const value = (k) => tab.evaluate((key) => window.result?.[key] ?? null, k);

    // One page: email and password, then sign in.
    await tab.goto(`${SITE}/one`);
    await tab.focus("#email");
    await enterFrom("Fill test one page", "Onepage");
    await poll(async () => (await value("submitted")) === true, 8000);
    check(`${name}, one page: email and password filled, form sent`, (await value("email")) === EMAIL && (await value("password")) === PASS && (await value("submitted")) === true, JSON.stringify(await tab.evaluate(() => ({ ...window.result, password: window.result.password ? "(set)" : null }))));

    // Steps: email, password, code, one open each.
    await tab.goto(`${SITE}/steps`);
    await tab.focus("#email");
    await enterFrom("Fill test steps", "Stepped");
    const gotEmail = await poll(async () => (await value("email")) === EMAIL, 8000);
    check(`${name}, steps 1: Enter types the email and goes on`, gotEmail);
    await poll(() => tab.evaluate(() => document.activeElement?.id === "pw"), 3000);
    const row2 = await enterFrom("Fill test steps", "Stepped");
    const gotPw = await poll(async () => (await value("password")) === PASS, 8000);
    check(`${name}, steps 2: the next open offers "Type password" and Enter types it`, gotPw && row2.includes("Type password"), `top row: ${row2}`);
    await poll(() => tab.evaluate(() => document.activeElement?.id === "code"), 3000);
    const row3 = await enterFrom("Fill test steps", "Stepped");
    const typed = await poll(async () => (await value("code")) || null, 8000);
    const now = await code();
    check(`${name}, steps 3: then "Type code" types the one-time code`, typeof typed === "string" && /^\d{6}$/.test(typed) && row3.includes("Type code"), `typed ${typed ? "6 digits" : typed}, current ${now === typed ? "same" : "differs"}; top row: ${row3}`);

    // A page that opens on a code box.
    await tab.goto(`${SITE}/code`);
    await tab.focus("#code");
    await enterFrom("Fill test code", "Codebox");
    const typed2 = await poll(async () => (await value("code")) || null, 8000);
    check(`${name}, code box: Enter types the one-time code, not the email`, typeof typed2 === "string" && /^\d{6}$/.test(typed2), String(typed2 === EMAIL ? "typed the email" : typed2 ? "6 digits" : typed2));

    await browser.close();
    browser = null;
  }
} catch (e) {
  check("run finished", false, e.message);
} finally {
  await browser?.close().catch(() => undefined);
  await coffer
    ?.contexts()
    .flatMap((c) => c.pages())
    .find((p) => new URL(p.url()).pathname === "/")
    ?.evaluate(() => window.__TAURI_INTERNALS__.invoke("app_quit"))
    .catch(() => undefined);
  await sleep(1500);
  if (app.exitCode === null) app.kill();
  server.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`fill: ${results.length - failed.length} of ${results.length} passed.`);
process.exit(failed.length ? 1 : 0);
