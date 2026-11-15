#!/usr/bin/env node
// Fill in the browser end to end (SPEC 3.13, docs/BRIDGE.md section 6): a QA
// Coffer with four logins, the real coffer-bridge.exe under a QA host name,
// and the unpacked extension in Playwright's Chromium on local https pages.
//
//   https://northwind-shop.test, https://accounts.northwind-shop.test, the
//   look-alike https://northwind-sh0p.test and https://evil.test all come from
//   one local https server (--host-resolver-rules, a self-signed certificate,
//   --ignore-certificate-errors). Checks: the menu lists the matching logins and
//   only those; a pick fills both fields and the page's own script sees the
//   values; the one-time code note; Ctrl+Shift+L; the look-alike gets no logins;
//   a cross-site frame gets nothing, a same-site frame works; locked shows
//   Unlock Coffer; a re-prompt login waits for the master password in Coffer
//   (Cancel, then the right password, over CDP); a login named
//   "northwind-shop.test" with no Website matches; identifier-first and
//   password-only pages; a search box gets nothing.
//
// Build first (a QA identity keeps your own Coffer out of it):
//   pnpm exec vite build
//   TAURI_CONFIG='{"identifier":"dev.sampo.coffer.qa4","productName":"CofferQA4"}' cargo build -p coffer --features tauri/custom-protocol
//   cargo build -p coffer-bridge
// Run: node e2e/browser-fill.mjs
// Env: COFFER_E2E_DIR (default %TEMP%\coffer-browser-fill, emptied first), COFFER_CDP_PORT (9344),
//      COFFER_QA_HOST (dev.sampo.coffer.qa4), COFFER_HTTPS_PORT (9445), COFFER_SHOTS, COFFER_PLAYWRIGHT.
//
// The QA host goes into HKCU\Software\Chromium\NativeMessagingHosts only (Chrome
// and Edge never read it) and is deleted at the end. The QA Coffer runs with
// COFFER_TEST_NO_CLIPBOARD (debug builds only), so the one-time code never
// reaches this PC's clipboard. No key is pressed on the desktop: keys and
// clicks go to the headless browser and to Coffer over CDP.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
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
  console.error("browser-fill: playwright-core not found. Set COFFER_PLAYWRIGHT to its path.");
  process.exit(2);
}
const { chromium } = loadPlaywright();

const target = JSON.parse(execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], { cwd: root, encoding: "utf8" })).target_directory;
const EXE = join(target, "debug", "coffer.exe");
const BRIDGE = join(target, "debug", "coffer-bridge.exe");
const SCRATCH = process.env.COFFER_E2E_DIR ?? join(tmpdir(), "coffer-browser-fill");
const DATA = join(SCRATCH, "data");
const VAULTS = join(SCRATCH, "vaults");
const SHOTS = process.env.COFFER_SHOTS ?? join(SCRATCH, "shots");
const EXT = join(SCRATCH, "extension");
const PORT = Number(process.env.COFFER_CDP_PORT ?? 9344);
const HTTPS_PORT = Number(process.env.COFFER_HTTPS_PORT ?? 9445);
const HOST = process.env.COFFER_QA_HOST ?? "dev.sampo.coffer.qa4";
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
  console.error(`browser-fill: refused: the QA host name must not be Coffer's own (${HOST}).`);
  process.exit(2);
}
for (const f of [EXE, BRIDGE]) {
  if (!existsSync(f)) {
    console.error(`browser-fill: ${f} is not there. Build it first (see the header).`);
    process.exit(2);
  }
}
if (!readFileSync(EXE).includes(Buffer.from(HOST))) {
  console.error(`browser-fill: refused: ${EXE} is not a QA build with the identifier ${HOST}.`);
  process.exit(2);
}

rmSync(SCRATCH, { recursive: true, force: true });
for (const d of [DATA, VAULTS, SHOTS]) mkdirSync(d, { recursive: true });
writeFileSync(join(DATA, "settings.json"), JSON.stringify({ version: 1, captureProtection: false, startWithWindows: false, startHidden: false, closeNoticeShown: true }, null, 2));

execFileSync(process.execPath, [join(root, "extension", "build.mjs")], { cwd: root, env: { ...process.env, COFFER_EXTENSION_OUT: EXT, COFFER_HOST: HOST }, stdio: "inherit" });
const MANIFEST = join(SCRATCH, `${HOST}.json`);
writeFileSync(MANIFEST, JSON.stringify({ name: HOST, description: "Coffer bridge (QA)", path: BRIDGE, type: "stdio", allowed_origins: [`chrome-extension://${EXT_ID}/`] }, null, 2));

// ---------- the local sites ----------
const keyFile = join(SCRATCH, "site-key.pem");
const certFile = join(SCRATCH, "site-cert.pem");
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", certFile, "-days", "2", "-subj", "/CN=northwind-shop.test", "-addext", "subjectAltName=DNS:northwind-shop.test,DNS:*.northwind-shop.test,DNS:northwind-sh0p.test,DNS:evil.test"], { stdio: "ignore" });

const SITE_CSS = `
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#e9ecf1;font:15px/1.4 "Segoe UI",system-ui,sans-serif;color:#1d2433}
  .card{width:380px;background:#fff;border-radius:10px;box-shadow:0 2px 14px rgba(20,30,50,.12);padding:28px;display:grid;gap:14px}
  h1{margin:0;font:600 22px Georgia,serif;color:#1d3b2f} label{font-size:13px;color:#4b5363;display:grid;gap:5px}
  input{height:40px;border:1px solid #b9c0cc;border-radius:6px;padding:0 40px 0 12px;font-size:15px}
  input:focus{outline:none;border-color:#2f6f57;box-shadow:0 0 0 3px rgba(47,111,87,.18)}
  button{height:42px;border:0;border-radius:6px;background:#2f6f57;color:#fff;font-weight:600;font-size:15px}
  .echo{font-size:12px;color:#4b5363;min-height:1em} .top{position:fixed;top:12px;left:16px;right:16px;display:flex;gap:8px}
  .top input{flex:1;max-width:420px;height:32px} iframe{width:440px;height:420px;border:2px dashed #b9c0cc;border-radius:10px;background:#fff}
  .sh0p h1{color:#7a2a2a}`;
const ECHO = `<script>
  window.seen = []; window.submitted = 0;
  for (const el of document.querySelectorAll("input")) el.addEventListener("input", (e) => {
    window.seen.push(e.target.id + "=" + e.target.value);
    const echo = document.getElementById("echo");
    if (echo) echo.textContent = "The page's script sees: " + [...document.querySelectorAll("form input")].map((i) => i.id + " " + (i.type === "password" ? "•".repeat(i.value.length) : i.value)).join(", ");
  });
  for (const f of document.forms) f.addEventListener("submit", (e) => { e.preventDefault(); window.submitted++; });
</script>`;
const signIn = (title, cls = "") => `<!doctype html><html><head><title>${title}</title><style>${SITE_CSS}</style></head><body class="${cls}">
  <div class="top"><input id="search" type="search" name="q" placeholder="Search the shop"></div>
  <form class="card" action="/session" method="post">
    <h1>${title}</h1>
    <label>Email<input id="email" type="email" name="email" autocomplete="username" placeholder="you@example.com"></label>
    <label>Password<input id="password" type="password" name="password" autocomplete="current-password"></label>
    <input id="decoy" type="password" name="pw2" style="position:absolute;left:-9999px" tabindex="-1">
    <button>Sign in</button>
    <div class="echo" id="echo"></div>
  </form>${ECHO}</body></html>`;
const PAGES = {
  "northwind-shop.test": {
    "/sign-in": signIn("Northwind Shop"),
    "/identifier": `<!doctype html><html><head><style>${SITE_CSS}</style></head><body><form class="card"><h1>Northwind Shop</h1><label>Email<input id="email" type="email" autocomplete="username"></label><button>Next</button><div class="echo" id="echo"></div></form>${ECHO}</body></html>`,
    "/password-only": `<!doctype html><html><head><style>${SITE_CSS}</style></head><body><form class="card"><h1>Northwind Shop</h1><p>alex@example.com</p><label>Password<input id="password" type="password"></label><button>Sign in</button><div class="echo" id="echo"></div></form>${ECHO}</body></html>`,
  },
  "www.northwind-shop.test": {
    "/account": `<!doctype html><html><head><style>${SITE_CSS}</style></head><body><div><h1 style="font:600 20px Georgia,serif">Northwind Shop: your account</h1><iframe src="https://accounts.northwind-shop.test/sign-in"></iframe></div></body></html>`,
  },
  "accounts.northwind-shop.test": { "/sign-in": signIn("Northwind Accounts") },
  "northwind-sh0p.test": { "/sign-in": signIn("Northwind Shop", "sh0p") },
  "evil.test": {
    "/": `<!doctype html><html><head><style>${SITE_CSS}</style></head><body><div><h1 style="font:600 20px Georgia,serif">Win a prize! Sign in below</h1><iframe src="https://northwind-shop.test/sign-in"></iframe></div></body></html>`,
  },
};
const server = createServer({ key: readFileSync(keyFile), cert: readFileSync(certFile) }, (req, res) => {
  const host = (req.headers.host ?? "").replace(/:\d+$/, "");
  const path = (req.url ?? "/").split("?")[0];
  const body = PAGES[host]?.[path];
  res.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
  res.end(body ?? "not found");
});
await new Promise((r) => server.listen(HTTPS_PORT, "127.0.0.1", r));
const MAPS = Object.keys(PAGES)
  .map((h) => `MAP ${h} 127.0.0.1:${HTTPS_PORT}`)
  .join(", ");

const QA_ENV = { COFFER_DATA_DIR: DATA, COFFER_VAULT_DIR: VAULTS, COFFER_TEST_NO_CLIPBOARD: "1", WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` };
let app = null;
let cdp = null;
let ctx = null;
let regAdded = false;
const started = [];

function regAdd() {
  try {
    execFileSync("reg", ["query", REG], { stdio: "ignore" });
    console.error(`browser-fill: refused: ${REG} exists already. Delete it first.`);
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
function qaPids() {
  const out = execFileSync("powershell", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "Name='coffer.exe'" | Where-Object { $_.ExecutablePath -eq '${EXE.replace(/'/g, "''")}' } | ForEach-Object { $_.ProcessId }`], { encoding: "utf8" });
  return out.split(/\s+/).filter(Boolean).map(Number);
}

async function startCoffer() {
  app = spawn(EXE, [], { env: { ...process.env, ...QA_ENV }, stdio: "ignore" });
  started.push(app.pid);
  cdp = await poll(() => chromium.connectOverCDP(`http://127.0.0.1:${PORT}`), 30000, 500);
  const pages = () => cdp.contexts().flatMap((c) => c.pages());
  const main = await poll(() => pages().find((p) => new URL(p.url()).pathname === "/"), 15000);
  await poll(() => main.evaluate(() => window.__TAURI_INTERNALS__.invoke("app_info")), 15000);
  // The window reloads once after a new vault: try a call again when its page went away under it.
  const invoke = async (cmd, args = {}) => {
    for (let i = 0; ; i++) {
      try {
        return await main.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
      } catch (e) {
        if (i >= 20 || !/context was destroyed|navigation|Target closed|__TAURI_INTERNALS__/.test(String(e))) throw e;
        await sleep(250);
      }
    }
  };
  return { main, invoke };
}

// ---------- the overlay, read over CDP (its shadow root is closed: the page cannot read it) ----------
const sessions = new WeakMap();
async function cdpOf(page) {
  if (!sessions.has(page)) sessions.set(page, await page.context().newCDPSession(page));
  return sessions.get(page);
}
/** The Coffer overlay of a page (top document, or a same-process frame): button, menu rows, note. */
async function overlay(page) {
  const s = await cdpOf(page);
  const { root: doc } = await s.send("DOM.getDocument", { depth: -1, pierce: true });
  const shadows = [];
  (function walk(n, inFrame) {
    if (n.nodeName === "COFFER-FILL" && n.shadowRoots?.length) shadows.push({ root: n.shadowRoots[0], inFrame });
    for (const c of n.children ?? []) walk(c, inFrame);
    for (const c of n.shadowRoots ?? []) walk(c, inFrame);
    if (n.contentDocument) walk(n.contentDocument, true);
  })(doc, false);
  if (!shadows.length) return null;
  const { root, inFrame } = shadows[0];
  const info = async (sel) => {
    const { nodeIds } = await s.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: sel });
    const out = [];
    for (const nodeId of nodeIds) {
      const { object } = await s.send("DOM.resolveNode", { nodeId });
      const { result } = await s.send("Runtime.callFunctionOn", {
        objectId: object.objectId,
        returnByValue: true,
        functionDeclaration: `function () {
          const r = this.getBoundingClientRect();
          return { text: this.textContent, shown: !this.hidden && !this.closest("[hidden]") && r.width > 0, x: r.x + r.width / 2, y: r.y + r.height / 2, selected: this.getAttribute("aria-selected"), state: this.getAttribute("data-state") };
        }`,
      });
      out.push(result.value);
    }
    return out;
  };
  const [button] = await info(".cf-btn");
  const [menu] = await info(".cf-menu");
  const [note] = await info(".cf-note");
  return { mode: root.shadowRootType, inFrame, button, menu, note, rows: menu?.shown ? await info(".cf-item") : [], act: (await info(".cf-act"))[0] };
}
const rowTitles = (o) => (o?.rows ?? []).map((r) => r.text.replace(/^[A-Z?]{1,2}/, "").replace(/Enter$/, ""));

async function open(page, url) {
  await page.goto(url);
  await page.waitForLoadState("load");
}
/** Click a field like a person, then wait for the overlay. */
async function focusField(page, sel, want = (o) => o?.button?.shown) {
  await page.click(sel);
  return poll(async () => {
    const o = await overlay(page);
    return want(o) ? o : false;
  }, 8000, 150);
}
async function values(page) {
  return page.evaluate(() => ({ email: document.getElementById("email")?.value ?? null, password: document.getElementById("password")?.value ?? null, decoy: document.getElementById("decoy")?.value ?? null, seen: window.seen ?? [], submitted: window.submitted }));
}

const cleanup = async () => {
  await ctx?.close().catch(() => undefined);
  await cdp?.close().catch(() => undefined);
  server.close();
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

const login = (title, user, pass, { urls = [], totp = false, reprompt = false } = {}) => ({
  type: "login",
  title,
  favorite: false,
  tags: [],
  fields: [
    { id: "u", label: "Username", kind: "text", value: user, section: null, builtin: "username" },
    { id: "p", label: "Password", kind: "concealed", value: pass, section: null, builtin: "password" },
    ...(totp ? [{ id: "t", label: "One-time code", kind: "totp", value: "otpauth://totp/Northwind?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", section: null, builtin: "totp" }] : []),
  ],
  notes: "",
  urls: urls.map((url) => ({ url, label: null })),
  apps: [],
  reprompt,
  autotypeSequence: null,
  healthExcluded: false,
});

try {
  regAdd();
  // ---------- a QA Coffer with four logins ----------
  const coffer = await startCoffer();
  await coffer.invoke("vault_create", { name: "Fill Vault", password: MASTER, usePickedFolder: false });
  // Let the window's reload after a new vault pass before the saves (a save must not be sent twice).
  await sleep(2000);
  await poll(async () => (await coffer.invoke("vault_status"))?.state === "unlocked", 15000);
  const ids = {};
  ids.shop = (await coffer.invoke("item_save", { item: login("northwind-shop.test", "alex@example.com", "Shop-pass-4417", { totp: true }), password: null })).id;
  ids.work = (await coffer.invoke("item_save", { item: login("Northwind (work)", "alex.morgan@work.example", "Work-pass-8823", { urls: ["https://accounts.northwind-shop.test"], reprompt: true }), password: null })).id;
  ids.google = (await coffer.invoke("item_save", { item: login("Google", "alex@gmail.com", "Google-pass-1", { urls: ["https://google.com"] }), password: null })).id;
  ids.wrong = (await coffer.invoke("item_save", { item: login("google.com.evil.test", "x@evil.test", "Evil-pass-1"), password: null })).id;
  check("the QA Coffer holds four logins", Object.values(ids).every(Boolean));

  // ---------- Chromium with the extension, connected ----------
  ctx = await chromium.launchPersistentContext(join(SCRATCH, "profile"), {
    channel: "chromium",
    headless: true,
    viewport: { width: 1000, height: 700 },
    deviceScaleFactor: 2,
    ignoreHTTPSErrors: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, `--host-resolver-rules=${MAPS}`, "--ignore-certificate-errors"],
    env: { ...process.env, ...QA_ENV },
  });
  let [sw] = ctx.serviceWorkers();
  sw ??= await ctx.waitForEvent("serviceworker", { timeout: 20000 });
  check("the extension's service worker runs with the fixed ID", sw.url().startsWith(`chrome-extension://${EXT_ID}/`));
  const welcome = await poll(() => ctx.pages().find((p) => p.url().includes("welcome.html")), 8000);
  await welcome?.close();
  const commands = await sw.evaluate(() => new Promise((r) => chrome.commands.getAll(r)));
  const fillCommand = commands.find((c) => c.name === "fill-login");
  // Chrome assigns the suggested key only when it is not one of its own shortcuts; then the content script catches the key in the page.
  check("the extension has the fill-login command (Ctrl+Shift+L)", !!fillCommand, `shortcut Chrome assigned: "${fillCommand?.shortcut ?? ""}"`);

  const page = await ctx.newPage();
  // Not connected yet: the Coffer button says how to connect.
  await open(page, "https://northwind-shop.test/sign-in");
  let o = await focusField(page, "#email");
  check("the local https site loads under its own name", page.url() === "https://northwind-shop.test/sign-in", page.url());
  check("not connected: a Coffer button in the field, no menu by itself", o?.button?.shown && !o?.menu?.shown, JSON.stringify(o?.menu));
  await page.mouse.click(o.button.x, o.button.y);
  o = await poll(async () => ((await overlay(page))?.menu?.state === "notConnected" ? overlay(page) : false), 5000);
  check('not connected: "Connect Coffer from the toolbar button"', o?.menu?.text?.includes("Connect Coffer from the toolbar button."), o?.menu?.text);
  check("the overlay's shadow root is closed", o?.mode === "closed" && (await page.evaluate(() => document.querySelector("coffer-fill")?.shadowRoot)) === null);

  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 320, height: 240 });
  await popup.goto(`chrome-extension://${EXT_ID}/popup/popup.html`);
  await popup.getByRole("button", { name: "Connect" }).click({ timeout: 15000 });
  await poll(() => coffer.main.locator("button[data-allow]").isEnabled(), 10000);
  await sleep(300);
  await coffer.main.locator("button[data-allow]").click();
  check("Connect: Allow in Coffer", await poll(async () => (await popup.locator(".body").getAttribute("data-state")) === "connected", 10000));
  await popup.close();

  // ---------- the menu on the sign-in page ----------
  await open(page, "https://northwind-shop.test/sign-in");
  o = await focusField(page, "#email", (x) => x?.menu?.shown && x.rows.length);
  const titles = rowTitles(o);
  check("the menu opens on focus with the matching logins only", JSON.stringify(titles) === JSON.stringify(["northwind-shop.testalex@example.com", "Northwind (work)alex.morgan@work.example"]), JSON.stringify(titles));
  check('a login named "northwind-shop.test" with no Website matches, first (the same host)', titles[0]?.startsWith("northwind-shop.test"));
  check("Google and a login named google.com.evil.test are not in it", !o.menu.text.includes("Google") && !o.menu.text.includes("evil"));
  check("the menu shows names and usernames only", !/Shop-pass|Work-pass/.test(o.menu.text) && o.menu.text.includes("Coffer · 2 logins for this site"));
  check("nothing filled on focus", JSON.stringify(await values(page)).includes('"email":"","password":""'));
  await page.screenshot({ path: join(SHOTS, "01-menu.png") });

  // Keyboard: Down, Up, Esc, then a click on the first login.
  await page.keyboard.press("ArrowDown");
  o = await overlay(page);
  check("Down moves the selection", o.rows[1]?.selected === "true", o.rows.map((r) => r.selected).join());
  await page.keyboard.press("Escape");
  check("Esc closes the menu", !(await overlay(page)).menu.shown);
  await page.keyboard.press("ArrowDown");
  o = await poll(async () => ((await overlay(page)).menu.shown ? overlay(page) : false), 3000);
  await page.keyboard.press("ArrowUp");
  await sleep(600);
  o = await overlay(page);
  await page.mouse.click(o.rows[0].x, o.rows[0].y);
  let v = await poll(async () => {
    const x = await values(page);
    return x.password ? x : false;
  }, 8000);
  check("a pick fills the username and the password", v?.email === "alex@example.com" && v?.password === "Shop-pass-4417", JSON.stringify(v && { ...v, password: v.password ? "(set)" : "" }));
  check("the page's own script sees the values (input events)", v?.seen?.includes("email=alex@example.com") && v.seen.includes("password=Shop-pass-4417"));
  check("the hidden decoy password box stays empty, and the form is not sent", v?.decoy === "" && v?.submitted === 0);
  o = await poll(async () => ((await overlay(page))?.note?.shown ? overlay(page) : false), 6000);
  check('a login with a one-time code: "One-time code copied"', o?.note?.text === "One-time code copied", o?.note?.text);
  const log1 = readFileSync(join(DATA, "coffer.log"), "utf8");
  check("Coffer copied the code with its own clipboard rules (test mode: this PC's clipboard untouched)", /clipboard: copied \(One-time code\) \[test: not written\]; clears in Some\(90\) s/.test(log1));
  await page.screenshot({ path: join(SHOTS, "02-filled.png") });

  // Enter fills too, and does not send the form.
  await open(page, "https://northwind-shop.test/sign-in");
  o = await focusField(page, "#password", (x) => x?.menu?.shown && x.rows.length);
  await sleep(600);
  await page.keyboard.press("Enter");
  v = await poll(async () => {
    const x = await values(page);
    return x.password ? x : false;
  }, 8000);
  check("Enter fills the selected login and does not send the form", v?.password === "Shop-pass-4417" && v?.submitted === 0, JSON.stringify(v?.submitted));

  // ---------- Ctrl+Shift+L ----------
  await open(page, "https://northwind-shop.test/sign-in");
  await page.click("#password");
  await sleep(300);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+Shift+L");
  v = await poll(async () => {
    const x = await values(page);
    return x.password ? x : false;
  }, 6000);
  check("Ctrl+Shift+L fills the first login into the focused form", v?.email === "alex@example.com" && v?.password === "Shop-pass-4417", JSON.stringify(v?.email));

  // ---------- other page shapes ----------
  await open(page, "https://northwind-shop.test/identifier");
  o = await focusField(page, "#email", (x) => x?.menu?.shown && x.rows.length);
  check("an identifier-first page (one email box and Next) gets the menu", o?.rows?.length === 2);
  await sleep(500);
  await page.mouse.click(o.rows[0].x, o.rows[0].y);
  v = await poll(async () => ((await values(page)).email ? values(page) : false), 6000);
  check("it fills the email only", v?.email === "alex@example.com");
  await open(page, "https://northwind-shop.test/password-only");
  o = await focusField(page, "#password", (x) => x?.menu?.shown && x.rows.length);
  await sleep(500);
  await page.mouse.click(o.rows[0].x, o.rows[0].y);
  v = await poll(async () => ((await values(page)).password ? values(page) : false), 6000);
  check("a password-only page fills the password", v?.password === "Shop-pass-4417");
  await open(page, "https://northwind-shop.test/sign-in");
  await page.click("#search");
  await sleep(1200);
  check("a search box gets no button", !(await overlay(page))?.button?.shown);

  // ---------- the look-alike ----------
  await open(page, "https://northwind-sh0p.test/sign-in");
  o = await focusField(page, "#email");
  check("the look-alike northwind-sh0p.test: no menu opens by itself", o?.button?.shown && !o.menu.shown);
  await page.mouse.click(o.button.x, o.button.y);
  o = await poll(async () => ((await overlay(page))?.menu?.shown ? overlay(page) : false), 4000);
  check("the look-alike gets no logins", o?.rows?.length === 0 && o.menu.text.includes("No logins for northwind-sh0p.test."), o?.menu?.text);
  await page.screenshot({ path: join(SHOTS, "03-lookalike.png") });
  await page.keyboard.press("Control+Shift+L");
  await sleep(1500);
  check("Ctrl+Shift+L on the look-alike fills nothing", (await values(page)).password === "");

  // ---------- frames ----------
  await open(page, "https://evil.test/");
  const evilFrame = await poll(() => page.frames().find((f) => f.url().startsWith("https://northwind-shop.test/")), 8000);
  await evilFrame.click("#email");
  await sleep(2000);
  check("a cross-site frame (northwind-shop.test inside evil.test) gets no button", (await evilFrame.evaluate(() => document.querySelectorAll("coffer-fill").length)) === 0);
  await page.keyboard.press("Control+Shift+L");
  await sleep(2000);
  const fv = await evilFrame.evaluate(() => [document.getElementById("email").value, document.getElementById("password").value]);
  check("a cross-site frame gets no fill, also with Ctrl+Shift+L", fv[0] === "" && fv[1] === "", JSON.stringify(fv));
  await page.screenshot({ path: join(SHOTS, "04-cross-site-frame.png") });

  await open(page, "https://www.northwind-shop.test/account");
  const okFrame = await poll(() => page.frames().find((f) => f.url().startsWith("https://accounts.northwind-shop.test/")), 8000);
  await okFrame.click("#email");
  const inFrame = await poll(async () => (await okFrame.evaluate(() => document.querySelectorAll("coffer-fill").length)) === 1, 6000);
  check("a frame of the same site (accounts. inside www.) gets the button", inFrame);
  await page.keyboard.press("Control+Shift+L");
  v = await poll(async () => {
    const x = await okFrame.evaluate(() => document.getElementById("email").value);
    return x || false;
  }, 6000);
  // The first login on accounts.northwind-shop.test is the work login (re-prompt): Coffer asks first.
  const askedInFrame = await poll(() => coffer.main.locator("#bridge-reprompt-pw").isVisible(), 6000);
  check("in that frame, Ctrl+Shift+L picks the work login, and Coffer asks for the master password", askedInFrame && !v, String(v));
  if (askedInFrame) await coffer.main.locator("dialog[open]").getByRole("button", { name: "Cancel" }).click();
  await sleep(800);

  // ---------- re-prompt: Cancel, then the right password ----------
  await open(page, "https://accounts.northwind-shop.test/sign-in");
  o = await focusField(page, "#email", (x) => x?.menu?.shown && x.rows.length);
  check("accounts.northwind-shop.test: the work login (same host) first, then the shop login", rowTitles(o)[0]?.startsWith("Northwind (work)") && rowTitles(o)[1]?.startsWith("northwind-shop.test"), JSON.stringify(rowTitles(o)));
  await sleep(500);
  await page.mouse.click(o.rows[0].x, o.rows[0].y);
  check("a re-prompt login: Coffer asks for the master password", await poll(() => coffer.main.locator("#bridge-reprompt-pw").isVisible(), 8000));
  o = await poll(async () => ((await overlay(page))?.menu?.state === "waiting" ? overlay(page) : false), 4000);
  check("the page says to enter the master password in Coffer, and nothing is filled yet", o?.menu?.text?.includes("Enter your master password in Coffer to fill Northwind (work).") && (await values(page)).password === "", o?.menu?.text);
  await page.screenshot({ path: join(SHOTS, "05-waiting.png") });
  await coffer.main.locator("dialog[open]").getByRole("button", { name: "Cancel" }).click();
  o = await poll(async () => ((await overlay(page))?.note?.shown ? overlay(page) : false), 6000);
  check("Cancel in Coffer: not filled, a one-line note", o?.note?.text === "Not filled: you clicked Cancel in Coffer." && (await values(page)).password === "", o?.note?.text);

  await open(page, "https://accounts.northwind-shop.test/sign-in");
  o = await focusField(page, "#email", (x) => x?.menu?.shown && x.rows.length);
  await sleep(500);
  await page.mouse.click(o.rows[0].x, o.rows[0].y);
  await poll(() => coffer.main.locator("#bridge-reprompt-pw").isVisible(), 8000);
  const dialogText = await coffer.main.locator("dialog[open]").textContent();
  check("Coffer's question names the browser, the login and the site", dialogText?.includes("Chromium asks to fill Northwind (work) on northwind-shop.test."), dialogText);
  await coffer.main.locator("#bridge-reprompt-pw").fill("not the password");
  await coffer.main.locator("button[data-reprompt-continue]").click();
  check("a wrong master password: Coffer says so and keeps asking", await poll(() => coffer.main.getByText("Wrong master password.").isVisible(), 6000));
  await sleep(300);
  check("still nothing filled", (await values(page)).password === "");
  await coffer.main.locator("#bridge-reprompt-pw").fill(MASTER);
  await coffer.main.screenshot({ path: join(SHOTS, "06-coffer-asks.png") });
  await coffer.main.locator("button[data-reprompt-continue]").click();
  v = await poll(async () => {
    const x = await values(page);
    return x.password ? x : false;
  }, 8000);
  check("after the right master password in Coffer, the work login fills", v?.email === "alex.morgan@work.example" && v?.password === "Work-pass-8823");

  // ---------- locked ----------
  await coffer.invoke("vault_lock");
  await open(page, "https://northwind-shop.test/sign-in");
  o = await focusField(page, "#email", (x) => x?.menu?.state === "locked");
  check("locked: the menu says Coffer is locked, with Unlock Coffer", o?.menu?.text === "Coffer is lockedUnlock Coffer", o?.menu?.text);
  await page.screenshot({ path: join(SHOTS, "07-locked.png") });
  await sleep(300);
  await page.mouse.click(o.act.x, o.act.y);
  await sleep(800);
  const unlockAsked = await poll(() => /bridge: the browser asked for Coffer's unlock/.test(readFileSync(join(DATA, "coffer.log"), "utf8")), 5000);
  check("Unlock Coffer asks Coffer to show its own unlock; nothing fills", unlockAsked && (await values(page)).password === "");
  await coffer.invoke("vault_unlock", { password: MASTER, secretKey: null });
  o = await poll(async () => ((await overlay(page))?.rows?.length === 2 ? overlay(page) : false), 8000);
  check("after the unlock in Coffer, the menu shows the logins", o?.rows?.length === 2);

  // ---------- Coffer's log ----------
  const log = readFileSync(join(DATA, "coffer.log"), "utf8");
  check("Coffer's log names fills, never a password or a login name", /bridge: filled a login/.test(log) && !/Shop-pass|Work-pass|Northwind \(work\)|alex@example/.test(log));
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
