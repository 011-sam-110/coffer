#!/usr/bin/env node
// Save in the browser end to end (SPEC 3.13, docs/BRIDGE.md section 6): a QA
// Coffer, the real coffer-bridge.exe under a QA host name, and the unpacked
// extension in Playwright's Chromium on local sites.
//
//   https://northwind-shop.test (a sign-in that posts and goes to /account,
//   an identifier-first sign-in on two pages, a one-page app that never
//   navigates) and https://evil.test (northwind-shop.test's sign-in in a
//   frame) come from one local https server (--host-resolver-rules, a
//   self-signed certificate). http://localhost and http://plain-shop.test come
//   from a local http server. Checks: a new username gives the Save bar, and
//   Save puts a login named "northwind-shop.test" with Website
//   https://northwind-shop.test into the QA vault; the same password gives
//   nothing; a changed password gives "Update password?", and Update keeps the
//   old password in the login's history and revisions; Never for this site;
//   locked gives "Unlock Coffer to save", and the unlock saves with no second
//   click; the two switches in Settings, Browsers turn the bars off;
//   identifier-first gives one Save with both values; a one-page app; a
//   cross-site frame and an http page give nothing; http://localhost does.
//
// Build first (a QA identity keeps your own Coffer out of it):
//   pnpm exec vite build
//   TAURI_CONFIG='{"identifier":"dev.sampo.coffer.qa5","productName":"CofferQA5"}' cargo build -p coffer --features tauri/custom-protocol
//   cargo build -p coffer-bridge
// Run: node e2e/browser-save.mjs
// Env: COFFER_E2E_DIR (default %TEMP%\coffer-browser-save, emptied first), COFFER_CDP_PORT (9345),
//      COFFER_QA_HOST (dev.sampo.coffer.qa5), COFFER_HTTPS_PORT (9446), COFFER_HTTP_PORT (9447),
//      COFFER_SHOTS, COFFER_PLAYWRIGHT.
//
// The QA host goes into HKCU\Software\Chromium\NativeMessagingHosts only (Chrome
// and Edge never read it) and is deleted at the end. The QA Coffer runs with
// COFFER_TEST_NO_CLIPBOARD. No key is pressed on the desktop: keys and clicks
// go to the headless browser and to Coffer over CDP.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
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
  console.error("browser-save: playwright-core not found. Set COFFER_PLAYWRIGHT to its path.");
  process.exit(2);
}
const { chromium } = loadPlaywright();

const target = JSON.parse(execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], { cwd: root, encoding: "utf8" })).target_directory;
const EXE = join(target, "debug", "coffer.exe");
const BRIDGE = join(target, "debug", "coffer-bridge.exe");
const SCRATCH = process.env.COFFER_E2E_DIR ?? join(tmpdir(), "coffer-browser-save");
const DATA = join(SCRATCH, "data");
const VAULTS = join(SCRATCH, "vaults");
const SHOTS = process.env.COFFER_SHOTS ?? join(SCRATCH, "shots");
const EXT = join(SCRATCH, "extension");
const PORT = Number(process.env.COFFER_CDP_PORT ?? 9345);
const HTTPS_PORT = Number(process.env.COFFER_HTTPS_PORT ?? 9446);
const HTTP_PORT = Number(process.env.COFFER_HTTP_PORT ?? 9447);
const HOST = process.env.COFFER_QA_HOST ?? "dev.sampo.coffer.qa5";
const EXT_ID = "jdnmjnanpckdfdhfclpkcbgimdjbeglj";
const REG = `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${HOST}`;
const MASTER = "Plum orbit lantern 2026 quartz!";
const SHOP = "https://northwind-shop.test";
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
  console.error(`browser-save: refused: the QA host name must not be Coffer's own (${HOST}).`);
  process.exit(2);
}
for (const f of [EXE, BRIDGE]) {
  if (!existsSync(f)) {
    console.error(`browser-save: ${f} is not there. Build it first (see the header).`);
    process.exit(2);
  }
}
if (!readFileSync(EXE).includes(Buffer.from(HOST))) {
  console.error(`browser-save: refused: ${EXE} is not a QA build with the identifier ${HOST}.`);
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
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", certFile, "-days", "2", "-subj", "/CN=northwind-shop.test", "-addext", "subjectAltName=DNS:northwind-shop.test,DNS:*.northwind-shop.test,DNS:evil.test"], { stdio: "ignore" });

const SITE_CSS = `
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#e9ecf1;font:15px/1.4 "Segoe UI",system-ui,sans-serif;color:#1d2433}
  .card{width:380px;background:#fff;border-radius:10px;box-shadow:0 2px 14px rgba(20,30,50,.12);padding:28px;display:grid;gap:14px}
  h1{margin:0;font:600 22px Georgia,serif;color:#1d3b2f} label{font-size:13px;color:#4b5363;display:grid;gap:5px} p{margin:0;color:#4b5363}
  input{height:40px;border:1px solid #b9c0cc;border-radius:6px;padding:0 40px 0 12px;font-size:15px}
  input:focus{outline:none;border-color:#2f6f57;box-shadow:0 0 0 3px rgba(47,111,87,.18)}
  button,.btn{height:42px;border:0;border-radius:6px;background:#2f6f57;color:#fff;font-weight:600;font-size:15px;display:grid;place-items:center}
  .soft{background:#e5ebe8;color:#2f6f57} iframe{width:440px;height:420px;border:2px dashed #b9c0cc;border-radius:10px;background:#fff}`;
const doc = (title, body) => `<!doctype html><html><head><title>${title}</title><style>${SITE_CSS}</style></head><body>${body}</body></html>`;
const signIn = (action = "/session") =>
  doc(
    "Northwind Shop: sign in",
    `<form class="card" action="${action}" method="post">
      <h1>Northwind Shop</h1>
      <label>Email<input id="email" type="email" name="email" autocomplete="username" placeholder="you@example.com"></label>
      <label>Password<input id="password" type="password" name="password" autocomplete="current-password"></label>
      <button id="go">Sign in</button>
    </form>`,
  );
const ACCOUNT = doc("Northwind Shop: your account", `<div class="card"><h1>Welcome back, Alex</h1><p>Your orders and saved addresses.</p><div class="btn soft">View orders</div></div>`);
const PAGES = {
  "/sign-in": signIn(),
  // A sign-in whose next page is on another site.
  "/sign-in-away": signIn("/session-away"),
  "/account": ACCOUNT,
  "/identifier": doc("Northwind Shop: sign in", `<form class="card" action="/identifier" method="post"><h1>Northwind Shop</h1><label>Email<input id="email" type="email" name="email" autocomplete="username"></label><button id="go">Next</button></form>`),
  "/password": doc("Northwind Shop: password", `<form class="card" action="/session" method="post"><h1>Northwind Shop</h1><p>Enter your password.</p><label>Password<input id="password" type="password" name="password" autocomplete="current-password"></label><button id="go">Sign in</button></form>`),
  // A one-page app: the sign-in never navigates; the form goes and the account shows.
  "/app": doc(
    "Northwind app",
    `<div id="root"><div class="card" id="login"><h1>Northwind app</h1><label>Email<input id="email" type="email" autocomplete="username"></label><label>Password<input id="password" type="password"></label><div role="button" class="btn" id="go" tabindex="0">Sign in</div></div></div>
     <script>document.getElementById("go").addEventListener("click", () => setTimeout(() => {
       document.getElementById("login").remove();
       history.pushState({}, "", "/app/account");
       document.getElementById("root").innerHTML = '<div class="card"><h1>Welcome back</h1><p>Signed in.</p></div>';
     }, 300));</script>`,
  ),
};
const LANDING = doc("Another site", `<div class="card"><h1>Another site</h1><p>The sign-in sent you here.</p></div>`);
const EVIL = doc("Win a prize", `<div><h1 style="font:600 20px Georgia,serif">Win a prize! Sign in below</h1><iframe src="${SHOP}/sign-in"></iframe></div>`);
function handler(req, res) {
  const host = (req.headers.host ?? "").replace(/:\d+$/, "");
  const path = (req.url ?? "/").split("?")[0];
  if (req.method === "POST") {
    // Read and drop the form: this test server keeps nothing.
    req.resume();
    req.on("end", () => {
      res.writeHead(303, { location: path === "/identifier" ? "/password" : path === "/session-away" ? "https://evil.test/landing" : "/account" });
      res.end();
    });
    return;
  }
  const body = host === "evil.test" ? { "/": EVIL, "/landing": LANDING }[path] : PAGES[path];
  res.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
  res.end(body ?? "not found");
}
const server = createServer({ key: readFileSync(keyFile), cert: readFileSync(certFile) }, handler);
await new Promise((r) => server.listen(HTTPS_PORT, "127.0.0.1", r));
const plain = createHttpServer(handler);
await new Promise((r) => plain.listen(HTTP_PORT, "127.0.0.1", r));
const MAPS = [`MAP northwind-shop.test 127.0.0.1:${HTTPS_PORT}`, `MAP evil.test 127.0.0.1:${HTTPS_PORT}`, `MAP plain-shop.test 127.0.0.1:${HTTP_PORT}`].join(", ");

const QA_ENV = { COFFER_DATA_DIR: DATA, COFFER_VAULT_DIR: VAULTS, COFFER_TEST_NO_CLIPBOARD: "1", WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` };
let cdp = null;
let ctx = null;
let regAdded = false;
const started = [];

function regAdd() {
  try {
    execFileSync("reg", ["query", REG], { stdio: "ignore" });
    console.error(`browser-save: refused: ${REG} exists already. Delete it first.`);
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
  const app = spawn(EXE, [], { env: { ...process.env, ...QA_ENV }, stdio: "ignore" });
  started.push(app.pid);
  cdp = await poll(() => chromium.connectOverCDP(`http://127.0.0.1:${PORT}`), 30000, 500);
  const pages = () => cdp.contexts().flatMap((c) => c.pages());
  const main = await poll(() => pages().find((p) => new URL(p.url()).pathname === "/"), 15000);
  await poll(() => main.evaluate(() => window.__TAURI_INTERNALS__.invoke("app_info")), 15000);
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

// ---------- the bar, read over CDP (its shadow root is closed: the page cannot read it) ----------
const sessions = new WeakMap();
async function cdpOf(page) {
  if (!sessions.has(page)) sessions.set(page, await page.context().newCDPSession(page));
  return sessions.get(page);
}
/** The Save bar of the top page: its state, its text and where its buttons are. */
async function bar(page) {
  const s = await cdpOf(page);
  const { root: d } = await s.send("DOM.getDocument", { depth: -1, pierce: true });
  let shadow = null;
  (function walk(n) {
    if (shadow) return;
    if (n.nodeName === "COFFER-FILL" && n.shadowRoots?.length) shadow = n.shadowRoots[0];
    for (const c of n.children ?? []) walk(c);
    for (const c of n.shadowRoots ?? []) walk(c);
  })(d);
  if (!shadow) return null;
  const info = async (sel) => {
    const { nodeIds } = await s.send("DOM.querySelectorAll", { nodeId: shadow.nodeId, selector: sel });
    const out = [];
    for (const nodeId of nodeIds) {
      const { object } = await s.send("DOM.resolveNode", { nodeId });
      const { result } = await s.send("Runtime.callFunctionOn", {
        objectId: object.objectId,
        returnByValue: true,
        functionDeclaration: `function () {
          const r = this.getBoundingClientRect();
          return { text: this.textContent, shown: !this.hidden && !this.closest("[hidden]") && r.width > 0, x: r.x + r.width / 2, y: r.y + r.height / 2, state: this.getAttribute("data-state"), action: this.getAttribute("data-action") };
        }`,
      });
      out.push(result.value);
    }
    return out;
  };
  const [b] = await info(".cf-bar");
  if (!b?.shown) return { shown: false, mode: shadow.shadowRootType };
  const buttons = Object.fromEntries((await info(".cf-bar [data-action]")).map((x) => [x.action, x]));
  return { ...b, mode: shadow.shadowRootType, buttons };
}
const barIn = (page, state, timeout = 8000) => poll(async () => {
  const b = await bar(page);
  return b?.shown && (!state || b.state === state) ? b : false;
}, timeout, 150);
/** No bar for this long. */
async function noBar(page, ms = 2500) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if ((await bar(page))?.shown) return false;
    await sleep(200);
  }
  return true;
}
async function clickBar(page, action) {
  // The bar counts a click only after 400 ms on screen.
  await sleep(500);
  const b = await bar(page);
  const btn = b?.buttons?.[action];
  if (!btn) throw new Error(`no ${action} button in the bar: ${JSON.stringify(b)}`);
  await page.mouse.click(btn.x, btn.y);
}

async function open(page, url) {
  await page.goto(url);
  await page.waitForLoadState("load");
}
/** Sign in like a person: type, then click the button (the form posts and the next page loads). */
async function signInOn(page, url, email, password, frame = null) {
  await open(page, url);
  const f = frame ? await poll(() => page.frames().find((x) => x.url().startsWith(frame)), 8000) : page;
  await f.fill("#email", email);
  await f.fill("#password", password);
  // The fill menu (M4) opens on the focus, after Playwright's fill is done (a person's typing closes it): close it.
  await sleep(400);
  await page.keyboard.press("Escape");
  await f.click("#go");
  if (!frame) await page.waitForURL((u) => u.pathname.endsWith("/account"), { timeout: 8000 }).catch(() => undefined);
  await page.waitForLoadState("load");
}

const cleanup = async () => {
  await ctx?.close().catch(() => undefined);
  await cdp?.close().catch(() => undefined);
  server.close();
  plain.close();
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

const login = (title, user, pass, urls = []) => ({
  type: "login",
  title,
  favorite: false,
  tags: [],
  fields: [
    { id: "u", label: "Username", kind: "text", value: user, section: null, builtin: "username" },
    { id: "p", label: "Password", kind: "concealed", value: pass, section: null, builtin: "password" },
  ],
  notes: "",
  urls: urls.map((url) => ({ url, label: null })),
  apps: [],
  reprompt: false,
  autotypeSequence: null,
  healthExcluded: false,
});

try {
  regAdd();
  // ---------- a QA Coffer with one login (work) ----------
  const coffer = await startCoffer();
  await coffer.invoke("vault_create", { name: "Save Vault", password: MASTER, usePickedFolder: false });
  await sleep(2000);
  await poll(async () => (await coffer.invoke("vault_status"))?.state === "unlocked", 15000);
  await coffer.invoke("item_save", { item: login("Northwind (work)", "alex.morgan@work.example", "Work-pass-8823", [`${SHOP}/sign-in`]), password: null });
  /** The QA vault's logins: title, website, username and password (revealed in the QA vault only). */
  const loginsOf = async () => {
    const rows = (await coffer.invoke("items_list")).filter((r) => r.type === "login" && r.state === "active");
    const out = [];
    for (const r of rows) {
      const v = await coffer.invoke("item_get", { id: r.id });
      out.push({ id: r.id, title: v.title, urls: v.urls.map((u) => u.url), username: v.fields.find((f) => f.builtin === "username")?.value ?? "", password: await coffer.invoke("item_reveal", { id: r.id, field: "password", password: null }) });
    }
    return out;
  };
  const byUser = async (u) => (await loginsOf()).filter((l) => l.username === u);

  // ---------- Chromium with the extension, connected ----------
  ctx = await chromium.launchPersistentContext(join(SCRATCH, "profile"), {
    channel: "chromium",
    headless: true,
    viewport: { width: 1000, height: 640 },
    deviceScaleFactor: 2,
    ignoreHTTPSErrors: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, `--host-resolver-rules=${MAPS}`, "--ignore-certificate-errors"],
    env: { ...process.env, ...QA_ENV },
  });
  let [sw] = ctx.serviceWorkers();
  sw ??= await ctx.waitForEvent("serviceworker", { timeout: 20000 });
  check("the extension's service worker runs with the fixed ID", sw.url().startsWith(`chrome-extension://${EXT_ID}/`));
  const version = await sw.evaluate(() => chrome.runtime.getManifest().version);
  check("the extension is 0.4.0", version === "0.4.0", version);
  const welcome = await poll(() => ctx.pages().find((p) => p.url().includes("welcome.html")), 8000);
  await welcome?.close();
  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 320, height: 240 });
  await popup.goto(`chrome-extension://${EXT_ID}/popup/popup.html`);
  await popup.getByRole("button", { name: "Connect" }).click({ timeout: 15000 });
  await poll(() => coffer.main.locator("button[data-allow]").isEnabled(), 10000);
  await sleep(300);
  await coffer.main.locator("button[data-allow]").click();
  check("Connect: Allow in Coffer", await poll(async () => (await popup.locator(".body").getAttribute("data-state")) === "connected", 10000));
  await popup.close();
  const page = await ctx.newPage();

  // ---------- 1. a new username: Save ----------
  await signInOn(page, `${SHOP}/sign-in`, "alex@example.com", "Shop-pass-4417");
  let b = await barIn(page, "save");
  check("a sign-in with a new username: the Save bar on the next page", !!b && page.url() === `${SHOP}/account`, page.url());
  check("the bar shows the name, the username and dots", b?.text === "Save this login in Coffer?×Namenorthwind-shop.testUsernamealex@example.comPassword••••••••••••Never for this siteSave", b?.text);
  check("the bar is in a closed shadow root; the page sees no password and no name", b?.mode === "closed" && !(await page.content()).includes("Shop-pass-4417") && (await page.evaluate(() => document.querySelector("coffer-fill")?.shadowRoot)) === null);
  const storage = await sw.evaluate(() => chrome.storage.local.get(null));
  const session = await sw.evaluate(() => chrome.storage.session.get(null));
  check("the held password is not in chrome.storage (local or session)", !JSON.stringify(storage).includes("Shop-pass-4417") && !JSON.stringify(session).includes("Shop-pass-4417"), Object.keys(storage).join(","));
  await page.screenshot({ path: join(SHOTS, "01-save-bar.png") });
  check("nothing is saved before the click", (await byUser("alex@example.com")).length === 0);
  await clickBar(page, "save");
  b = await barIn(page, "done");
  check('Save: "Saved in Coffer as northwind-shop.test."', b?.text?.startsWith("Saved in Coffer as northwind-shop.test."), b?.text);
  await page.screenshot({ path: join(SHOTS, "02-saved.png") });
  let saved = await poll(async () => (await byUser("alex@example.com"))[0], 5000);
  check("the QA vault has the login: name northwind-shop.test, Website https://northwind-shop.test", saved?.title === "northwind-shop.test" && JSON.stringify(saved?.urls) === JSON.stringify([SHOP]), JSON.stringify(saved && { ...saved, password: "(hidden)" }));
  check("with the username and password that were typed", saved?.username === "alex@example.com" && saved?.password === "Shop-pass-4417");
  const health = await coffer.invoke("health_report");
  check("Health sees the new login", health.total >= 2, String(health.total));

  // ---------- 2. the same password: nothing ----------
  await signInOn(page, `${SHOP}/sign-in`, "alex@example.com", "Shop-pass-4417");
  check("the same username and password again: no bar", await noBar(page));

  // ---------- 3. a changed password: Update ----------
  await signInOn(page, `${SHOP}/sign-in`, "Alex@Example.com", "Shop-pass-NEW-5520");
  b = await barIn(page, "update");
  check('a changed password (the username typed in another case): "Update password?" naming the login', b?.text === "Update password?×Loginnorthwind-shop.testUsernameAlex@Example.comPassword••••••••••••The old password stays in the login's history.Update", b?.text);
  await page.screenshot({ path: join(SHOTS, "03-update-bar.png") });
  await clickBar(page, "update");
  b = await barIn(page, "done");
  check('Update: "Password updated in northwind-shop.test."', b?.text?.startsWith("Password updated in northwind-shop.test."), b?.text);
  saved = await poll(async () => {
    const l = (await byUser("alex@example.com"))[0];
    return l?.password === "Shop-pass-NEW-5520" ? l : false;
  }, 5000);
  check("the login has the new password, and there is still one login for alex@example.com", !!saved && (await byUser("alex@example.com")).length === 1);
  const history = await coffer.invoke("item_password_history", { id: saved.id, password: null });
  const old = history[0] && (await coffer.invoke("item_reveal", { id: saved.id, field: `history:${history[0].id}`, password: null }));
  const revisions = await coffer.invoke("item_revisions", { id: saved.id, password: null });
  check("the old password is in its history, and the item before the change is a revision", old === "Shop-pass-4417" && revisions.length >= 1, `history ${history.length}, revisions ${revisions.length}`);

  // ---------- 4. Never for this site ----------
  await signInOn(page, `${SHOP}/sign-in`, "sam@example.com", "Sam-pass-3311");
  b = await barIn(page, "save");
  await clickBar(page, "never");
  b = await barIn(page, "done");
  check('Never for this site: "Coffer will not offer to save on this site."', b?.text?.startsWith("Coffer will not offer to save on this site."), b?.text);
  const info = await coffer.invoke("bridge_info");
  check("Coffer keeps the site in its never list (the vault)", JSON.stringify(info.neverSites) === JSON.stringify(["northwind-shop.test"]), JSON.stringify(info.neverSites));
  await signInOn(page, `${SHOP}/sign-in`, "kim@example.com", "Kim-pass-7788");
  check("the next sign-in on that site: no bar, nothing saved", (await noBar(page)) && (await byUser("kim@example.com")).length === 0 && (await byUser("sam@example.com")).length === 0);
  // Settings, Browsers lists the site with Remove.
  await coffer.main.getByRole("button", { name: /^Settings/ }).first().click();
  await coffer.main.getByRole("tab", { name: "Browsers" }).click();
  await poll(() => coffer.main.getByText("Never offered on").isVisible(), 5000);
  await coffer.main.getByText("Never offered on").scrollIntoViewIfNeeded();
  await coffer.main.screenshot({ path: join(SHOTS, "04-settings-never.png") });
  check("Settings, Browsers lists it under Never offered on", await coffer.main.getByText("northwind-shop.test", { exact: true }).isVisible());
  await coffer.main.getByRole("button", { name: "Remove" }).click();
  check("Remove takes it off the list", await poll(async () => (await coffer.invoke("bridge_info")).neverSites.length === 0, 5000));

  // ---------- 5. locked: Unlock Coffer to save ----------
  await coffer.invoke("vault_lock");
  await signInOn(page, `${SHOP}/sign-in`, "lee@example.com", "Lee-pass-6402");
  b = await barIn(page, "locked");
  check('locked: "Unlock Coffer to save" with Unlock Coffer', b?.text === "Unlock Coffer to save×Coffer is locked. Unlock it, and Coffer saves this login.Unlock Coffer", b?.text);
  await page.screenshot({ path: join(SHOTS, "05-locked.png") });
  await clickBar(page, "unlock");
  const unlockAsked = await poll(() => /bridge: the browser asked for Coffer's unlock/.test(readFileSync(join(DATA, "coffer.log"), "utf8")), 5000);
  check("Unlock Coffer shows Coffer's own unlock", unlockAsked);
  await coffer.invoke("vault_unlock", { password: MASTER, secretKey: null });
  b = await barIn(page, "saved", 10000);
  check("after the unlock in Coffer: saved, with no second click", b?.text?.startsWith("Saved in Coffer as northwind-shop.test."), b?.text);
  await page.screenshot({ path: join(SHOTS, "06-saved-after-unlock.png") });
  check("the QA vault has lee@example.com", (await poll(async () => (await byUser("lee@example.com"))[0]?.password === "Lee-pass-6402", 5000)) === true);

  // ---------- 6. the switches in Settings, Browsers ----------
  await coffer.main.getByRole("button", { name: /^Settings/ }).first().click();
  await coffer.main.getByRole("tab", { name: "Browsers" }).click();
  await coffer.main.getByRole("switch", { name: "Offer to save new logins" }).click();
  await coffer.main.getByRole("switch", { name: "Offer to update changed passwords" }).click();
  const s = await poll(async () => {
    const x = await coffer.invoke("settings_get");
    return !x.offerSaveLogins && !x.offerUpdatePasswords ? x : false;
  }, 5000);
  check("both switches off in Settings, Browsers", !!s);
  await signInOn(page, `${SHOP}/sign-in`, "max@example.com", "Max-pass-1200");
  check("Offer to save off: a new login gives no bar", (await noBar(page)) && (await byUser("max@example.com")).length === 0);
  await signInOn(page, `${SHOP}/sign-in`, "alex@example.com", "Shop-pass-OTHER-9");
  check("Offer to update off: a changed password gives no bar", (await noBar(page)) && (await byUser("alex@example.com"))[0]?.password === "Shop-pass-NEW-5520");
  await coffer.main.getByRole("switch", { name: "Offer to save new logins" }).click();
  await coffer.main.getByRole("switch", { name: "Offer to update changed passwords" }).click();
  await poll(async () => (await coffer.invoke("settings_get")).offerSaveLogins, 5000);

  // ---------- 7. identifier-first: one Save with both values ----------
  await open(page, `${SHOP}/identifier`);
  await page.fill("#email", "ida@example.com");
  await sleep(400);
  await page.keyboard.press("Escape");
  await page.click("#go");
  await page.waitForURL((u) => u.pathname === "/password", { timeout: 8000 });
  check("identifier-first page 1 (the email alone): no bar on page 2", await noBar(page, 1500));
  await page.fill("#password", "Ida-pass-2580");
  await sleep(400);
  await page.keyboard.press("Escape");
  await page.click("#go");
  await page.waitForURL((u) => u.pathname === "/account", { timeout: 8000 });
  b = await barIn(page, "save");
  check("page 2 sent: one Save bar with the email of page 1", b?.text?.includes("Usernameida@example.com"), b?.text);
  await page.screenshot({ path: join(SHOTS, "07-identifier-first.png") });
  await clickBar(page, "save");
  await barIn(page, "done");
  const ida = await poll(async () => (await byUser("ida@example.com"))[0], 5000);
  check("the saved login has both: ida@example.com and the password of page 2", ida?.password === "Ida-pass-2580" && ida?.title === "northwind-shop.test");

  // ---------- 8. a one-page app ----------
  await open(page, `${SHOP}/app`);
  await page.fill("#email", "spa@example.com");
  await page.fill("#password", "Spa-pass-9090");
  await sleep(400);
  await page.keyboard.press("Escape");
  await page.click("#go");
  b = await barIn(page, "save");
  check("a one-page app (no navigation): the bar comes when the form goes", !!b && page.url().endsWith("/app/account"), page.url());
  await clickBar(page, "dismiss");
  check("× closes it, and nothing is saved", (await poll(async () => !(await bar(page))?.shown, 3000)) && (await byUser("spa@example.com")).length === 0);
  await open(page, `${SHOP}/account`);
  check("× drops the held login: no bar on the next page", await noBar(page, 1500));

  // ---------- 9. a cross-site frame, an http page, localhost ----------
  await signInOn(page, "https://evil.test/", "evil@example.com", "Evil-pass-1", `${SHOP}/sign-in`);
  await sleep(1500);
  const inFrame = page.frames().find((f) => f.url().startsWith(SHOP));
  check("the cross-site frame's form was sent (it shows /account)", !!inFrame?.url().endsWith("/account"), inFrame?.url());
  check("a cross-site frame (northwind-shop.test inside evil.test) gives no bar, and nothing saved", (await noBar(page)) && (await byUser("evil@example.com")).length === 0);
  await open(page, `${SHOP}/account`);
  check("nor on the frame's own site afterwards", await noBar(page, 1500));
  await page.screenshot({ path: join(SHOTS, "08-cross-site-frame.png") });

  // The bar shows only on the site of the form: a sign-in that lands on another site gets none there.
  await signInOn(page, `${SHOP}/sign-in-away`, "away@example.com", "Away-pass-1");
  await page.waitForURL("https://evil.test/landing", { timeout: 8000 }).catch(() => undefined);
  check("a sign-in whose next page is another site (evil.test): no bar there", page.url() === "https://evil.test/landing" && (await noBar(page)), page.url());
  await open(page, `${SHOP}/account`);
  b = await barIn(page, "save");
  check("back on the form's site within 2 minutes: the Save bar", b?.text?.includes("Usernameaway@example.com"), b?.text);
  await clickBar(page, "dismiss");

  await signInOn(page, "http://plain-shop.test/sign-in", "http@example.com", "Http-pass-1");
  check("an http page gives nothing", (await noBar(page)) && (await byUser("http@example.com")).length === 0, page.url());
  await signInOn(page, `http://localhost:${HTTP_PORT}/sign-in`, "local@example.com", "Local-pass-1");
  b = await barIn(page, "save");
  check("http://localhost does: the Save bar, named localhost", b?.text?.includes("Namelocalhost"), b?.text);
  await clickBar(page, "save");
  await barIn(page, "done");
  const local = await poll(async () => (await byUser("local@example.com"))[0], 5000);
  check("saved with Website http://localhost", JSON.stringify(local?.urls) === JSON.stringify(["http://localhost"]), JSON.stringify(local?.urls));

  // ---------- Coffer's log ----------
  const log = readFileSync(join(DATA, "coffer.log"), "utf8");
  check("Coffer's log names saves and updates, never a password or a username", /bridge: saved a new login from the browser/.test(log) && /bridge: updated a login's password/.test(log) && !/Shop-pass|Ida-pass|Lee-pass|alex@example|ida@example/.test(log));
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
