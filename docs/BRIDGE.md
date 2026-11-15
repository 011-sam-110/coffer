# Coffer browser bridge: protocol

The Coffer extension in Chrome or Edge talks to the Coffer app on the same PC. This file is the contract between the two sides. SPEC.md section 3.13 says what the feature does; SECURITY.md section 12 has the threat model.

```
extension (service worker) --native messaging--> coffer-bridge.exe --named pipe--> Coffer
```

- **Extension**: `extension/` (Manifest V3, plain TypeScript). The service worker (`src/background.ts`) owns the one connection.
- **coffer-bridge.exe**: `crates/coffer-bridge`. Chrome starts it for the extension. It passes each message unchanged and keeps nothing.
- **Coffer**: `src-tauri/src/bridge/`. The gate (`gate.rs`) answers every message.

## 1. Names and places

| What | Value |
|---|---|
| Extension ID | `jdnmjnanpckdfdhfclpkcbgimdjbeglj` (fixed by the public key in `extension/manifest.json`; no private key exists) |
| Native host name | the app identifier: `dev.sampo.coffer`. A QA copy uses its own identifier (for example `dev.sampo.coffer.qa3`). |
| Host manifest | `<install folder>\<host name>.json`, `"path": "coffer-bridge.exe"` (relative), `"allowed_origins": ["chrome-extension://jdnmjnanpckdfdhfclpkcbgimdjbeglj/"]` |
| Registry (installer) | `HKCU\Software\Google\Chrome\NativeMessagingHosts\<host name>` and `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\<host name>`, default value = the host manifest path. Uninstall deletes both; an update keeps them. |
| Extension folder | `<install folder>\extension` (Settings, Browsers shows it). `host.json` in it names the host; the installer writes it from the identifier. |
| Pipe | `\\.\pipe\coffer-bridge-<user SID>-<16 hex of SHA-256 of the install folder, lower case>`. ACL `D:P(A;;GA;;;<user SID>)`, remote clients refused. `coffer-bridge.exe --pipe-name` prints it. |
| Browser keys | `%LOCALAPPDATA%\Coffer\browsers.json`, each key sealed with DPAPI (entropy `coffer/v1/bridge-key` + client id). |

The bridge connects only to a pipe whose server process runs an exe from the bridge's own folder. If no Coffer answers, the bridge starts `coffer.exe --hidden` from its folder and waits up to 6 seconds.

## 2. Framing

Each message is a 4-byte little-endian length, then that many bytes of UTF-8 JSON (Chrome's native messaging format). The pipe uses the same framing. A message is at most 1 MB in both directions; a bigger one gets `too_large`.

## 3. Envelopes

Every request has a number `id`. The answer carries the same `id`. Answers can come out of order (`pair_result` waits for the user).

**Unsigned request** (only `hello`, `pair`, `pair_result`):

```json
{ "id": 1, "call": "hello", "args": { "version": "0.3.0", "browser": "chrome", "client": null } }
```

**Signed request** (every other call):

```json
{ "id": 5, "client": "<32 hex>", "body": "<JSON text>", "mac": "<base64>" }
```

- `body` is the JSON text of `{ "call": "status", "args": {}, "nonce": "<this connection's nonce>", "seq": 3 }`.
- `seq` starts at 1 on each connection and goes up by one for each signed call.
- `mac` = base64 HMAC-SHA256(bridge key, `coffer/v1/req` || 0x00 || client || 0x00 || body), over the exact bytes of `body`.

**Answers**:

- Unsigned success: `{ "id": 1, "ok": true, "result": { ... } }`
- Unsigned error: `{ "id": 1, "error": "<code>", "message": "<one plain sentence>" }`
- Signed answer to a signed request: `{ "id": 5, "body": "<JSON text>", "mac": "<base64>" }`. `body` is `{ "seq": 3, "nonce": "...", "ok": true, "result": { ... } }` or `{ "seq": 3, "nonce": "...", "error": "<code>", "message": "..." }`. `mac` = HMAC-SHA256(bridge key, `coffer/v1/res` || 0x00 || client || 0x00 || body). The extension checks the MAC, `seq` and `nonce` before it uses the answer.

A signed request that fails the gate (`not_paired`, `bad_mac`, `replay`, `bad_request`) gets an unsigned error, and nothing runs.

## 4. Pairing (the Connect prompt)

1. The extension makes an X25519 key pair (WebCrypto, private key not extractable) and calls `pair` with the public key.
2. Coffer makes its own X25519 key and a random 16-byte client id, and shows "Connect Chrome to Coffer?" with four words. It answers at once with its public key, the pair id and the client id.
3. Both sides compute:
   - transcript = SHA-256(`coffer/v1/pair` || 0x00 || extension key (32) || Coffer key (32) || client id (16 bytes))
   - words: for i = 0..3, big-endian u32 at bytes 4i..4i+4 of the transcript, modulo 7776, into the EFF large word list (`crates/coffer-core/data/eff_large_wordlist.txt`; `words.txt` in the extension)
   - bridge key = HKDF-SHA256(salt = transcript, input = the X25519 secret, info = `coffer/v1/bridge-key`), 32 bytes
   - confirm = base64 HMAC-SHA256(bridge key, `coffer/v1/pair-confirm` || 0x00 || transcript)
4. The extension shows the four words and calls `pair_result`, which waits.
5. Allow: Coffer stores the key (DPAPI) and answers `{ "paired": true, "confirm": "..." }`. The extension checks `confirm`, then keeps `{ client, key, browser, pairedAt }` in `chrome.storage.local` under `pairing`.
6. Deny, 2 minutes with no answer, or the connection closing: Coffer stores nothing and closes the prompt.

One prompt at a time: a second `pair` while one is open gets `busy`. Allow is off for the first second after the prompt opens.

Known-answer vector (both test suites check it): extension key = bytes 1..32, Coffer key = bytes 33..64, client id = bytes 0xa0..0xaf, shared secret = 32 x 0x55 gives transcript `403f25b5...26471bc`, words `encroach avenging grinning handmade`, key `4e38f025...f1fbb04f`, confirm `368XgU0c...BzIlO0=` (full values in `src-tauri/src/bridge/pairing.rs` and `extension/src/lib/protocol.test.ts`).

## 5. Connect and status calls (M3)

| Call | Signed | Args | Result | Errors |
|---|---|---|---|---|
| `hello` | no | `version` (extension), `browser` (`chrome`, `edge`, `chromium`, `other`), `client` (stored id or null) | `protocol` (1), `version` (Coffer), `paired` (Coffer has this client), `locked`, `nonce` (base64, 16 bytes, this connection) | `bad_request` |
| `pair` | no | `pub` (base64 X25519, 32 bytes), `browser`, `version` | `pairId`, `pub` (Coffer's key), `client` (32 hex) | `busy`, `bad_request` |
| `pair_result` | no | `pairId` | `paired: true`, `confirm` | `denied`, `timeout`, `not_found` |
| `status` | yes | none | `version`, `locked`, `offerSave`, `offerUpdate` (Settings, Browsers switches) | gate errors |
| `unlock` | yes | none | as `status`. Coffer shows its unlock window (PIN, Hello or master password). No password crosses the pipe. | gate errors |
| `disconnect` | yes | none | `disconnected: true`. Coffer deletes this browser's key. | gate errors |

When Coffer reports a version newer than the extension's manifest version, the extension calls `chrome.runtime.reload()` once for that version (`reloadedFor` in `chrome.storage.local`): the installer replaced the files.

## 6. Fill calls (M4) and save calls (M5)

Each needs the vault. `url` is the full URL of the frame that asks: the service worker takes it from Chrome (`sender.url`), never from the page. `top` is the top page's URL, sent only when the frame is not the top page; the worker gets it from the top page's own content script (`coffer:where`, frame 0). Coffer checks both before it looks at the lock:

- `https:` only, or `http:` on `localhost` / `127.0.0.1`. Anything else gets `bad_request`.
- `top` must be the same site as `url`: the same scheme and the same registered domain. Else `cross_site`, so a frame of another site inside a page gets nothing.
- Then a locked Coffer answers `locked` (the extension offers Unlock Coffer, which calls `unlock`).

**Matching** (`crates/coffer-core/src/site.rs`): the page's registered domain (eTLD+1 from the Public Suffix List, built into the `psl` crate) against the host of each active login's Website URLs. `accounts.google.com` fits a `google.com` login; `g00gle.com`, `google.com.evil.test` and `evil-google.com` fit nothing; `alex.github.io` and `bob.github.io` are two sites (a private suffix). An IP address and `localhost` are their own site. A login whose Websites do not fit is tried by its name, when the name reads as a web address: the rule of `siteFromName` in `src/lib/url.ts`, on the same TLD file (`src/lib/tlds.ts`, the IANA root zone and the special-use names `test`, `example`, `localhost`, `local`, `internal`). Both rules run the table `src/lib/siteCases.json`. **Order**: the same host first, then the last used (a fill counts as a use), then by name.

| Call | Stage | Args | Result | Errors |
|---|---|---|---|---|
| `list_logins` | M4 | `url`, `top` (frames) | `site` (the registered domain), `logins`: `[{ id, title, username, hasTotp }]`, best first. Names and usernames only: no password, no other field. | `bad_request`, `cross_site`, `locked` |
| `get_login` | M4 | `id`, `url`, `top` (frames) | `username`, `password`, `hasTotp`. Only for a login that fits `url`. A login with "Ask for master password" and no live grant: the answer waits while Coffer asks for the master password in its own window (the same question as for its own re-prompt items, up to 2 minutes). The right password starts the item's 60 s grant and the answer comes; the extension waits up to 135 s. | `bad_request`, `cross_site`, `locked`, `not_found`, `no_match`, `busy` (Coffer asks for another fill already), `cancelled` (Cancel in Coffer, or the connection closed), `timeout` (no answer in 2 minutes) |
| `copy_totp` | M4 | `id`, `url`, `top` (frames) | `clearsInSeconds`: Coffer copies the current code with its own clipboard rules (kept out of clipboard history, cleared after the set time, 90 s by default). | `bad_request`, `cross_site`, `locked`, `not_found`, `no_match`, `no_totp`, `reprompt` (a re-prompt login with no grant: fill it first) |
| `find_login` | M5 | `url`, `username`, `password` | `match` (`none`, `same`, `changed`, `never`), `id` and `title` when there is a login, `offer` (`save`, `update` or null: Coffer applies the two switches and the never list) | `locked`, `bad_request` |
| `save_login` | M5 | `url`, `username`, `password` | `id`, `title`. A new login named after the registered domain, Website `https://<domain>`. Only after the user clicks Save. | `locked`, `bad_request` |
| `update_password` | M5 | `id`, `url`, `password` | `id`. The old password goes to the login's password history. Only after the user clicks Update. | `locked`, `not_found`, `no_match` |
| `never_for_site` | M5 | `url` | `site`. Coffer keeps the registered domain and offers nothing there again. | `locked`, `bad_request` |

M4 changed three things in this table as M3 wrote it: `top` (frames), `cross_site`, and `get_login` on a re-prompt login waits for the user instead of answering `reprompt` at once. M5 may add fields. Write each change into this table in the same PR.

The main window shows the master-password question from `bridge_info().reprompt` (`{ requestId, browser, name, title, site, expiresAt }`) and answers with `bridge_reprompt_answer({ requestId, password })` (`null` is Cancel; a wrong password answers `badCredentials` and the question stays). Coffer locking ends the question: the browser gets `locked`.

## 7. Error codes

| Code | From | Meaning |
|---|---|---|
| `not_running` | bridge | No Coffer answers on the pipe, also after the bridge started one. |
| `wrong_server` | bridge | Another program holds the pipe name. |
| `too_large` | bridge, Coffer | A message over 1 MB. |
| `bad_request` | Coffer | Not JSON, no call, or a bad argument. |
| `bad_mac` | Coffer, extension | No MAC, or a wrong one. The extension also uses it when Coffer's answer does not check out. |
| `not_paired` | Coffer | Coffer has no key for this client (Disconnect in Settings). The extension deletes its own key. |
| `replay` | Coffer, extension | A `seq` that does not go up, or a nonce of another connection. |
| `busy` | Coffer | A Connect prompt, or a fill's master-password question, is open already. |
| `denied`, `timeout` | Coffer | The Connect prompt: Deny, or no answer in 2 minutes. `timeout` also ends a `get_login` that waited 2 minutes for the master password. |
| `locked` | Coffer | The call needs the vault. |
| `cross_site` | Coffer | A frame of another site than its top page (section 6). The extension shows no button there. |
| `not_found`, `no_match`, `no_totp`, `reprompt` | Coffer | M4 and M5 calls (section 6). |
| `cancelled` | Coffer | `get_login`: Cancel in Coffer's master-password question. |
| `unknown_call` | Coffer | Coffer does not know the call (or does not answer it yet). |
| `not_installed` | extension | Chrome cannot find the native host (`chrome.runtime.lastError` says "not found"). |

## 8. The extension

```
extension/
  manifest.json          the manifest; build.mjs sets "version" from package.json
  build.mjs              Vite build into extension/dist (COFFER_EXTENSION_OUT, COFFER_HOST)
  public/icons/
  src/background.ts      service worker: one Session, answers the popup and the content scripts, Ctrl+Shift+L
  src/chrome.d.ts        the chrome.* types in use (add what you use)
  src/lib/protocol.ts    crypto and envelopes (pure, tested in Vitest)
  src/lib/client.ts      NativeLink (port + ids, messages leave in call order), Session: connect(), pair(), call(name, args, timeoutMs)
  src/lib/state.ts       popup states and messages
  src/lib/fill.ts        fill messages, the worker's half of the rules (sender.url, frames, https), menu states
  src/content/main.ts    the content script (one IIFE, content.js): wiring, coffer:where, the font
  src/content/filler.ts  focus -> menu -> pick -> fill; Ctrl+Shift+L; the only path to get_login
  src/content/fields.ts  which inputs are sign-in fields (visible, not search, not sign-up)
  src/content/fill.ts    the native value setter, then input and change events
  src/content/menu.ts    the button, menu and note in a closed shadow root in the top layer
  src/content/styles.ts  the menu's CSS (a copy of Coffer's tokens)
  src/popup/             toolbar popup (view.ts draws from a state)
  src/welcome/           first-run page (turns off the browser's own password offers)
  src/styles/coffer.css  Coffer's tokens
```

- From the service worker: `await session.call<Result>("list_logins", { url })`. It throws `BridgeError` with `code` from section 7.
- The popup and the welcome page talk to the worker with `chrome.runtime.sendMessage({ type: "coffer:..." })`; the worker answers them only from its own extension pages.
- **Content script to worker** (`sender.tab` set, a web page's `sender.url`): `coffer:list` (the menu: `MenuState`), `coffer:fill` `{ id }` (`get_login`), `coffer:totp` `{ id }` (`copy_totp`), `coffer:unlock`, `coffer:font` (Switzer as base64: no extension file is web accessible). A message carries no address; the worker reads `sender.url` and `sender.frameId`.
- **Worker to content script**: `coffer:where` (frame 0 only: the top page answers its `location.href`), `coffer:command` `fill-login` (Ctrl+Shift+L, to every frame of the tab; only the frame with the focus acts).
- The content script is a separate IIFE bundle (`content.js`, the second `build()` in build.mjs). The menu, the button and the note live in a closed shadow root in the top layer (a manual popover), with a copy of the tokens.
- **Fill**: on the focus of a sign-in field, `coffer:list`; the menu opens by itself when there are logins or Coffer is locked. Nothing fills until a pick: a real click or Enter (`isTrusted`) on a menu that has been on screen 400 ms, fully visible (IntersectionObserver v2), or Ctrl+Shift+L. Then `coffer:fill`, the native value setter and input + change events on the fields that are visible at that moment, and, for a login with a code, `coffer:totp` and "One-time code copied".
- Permissions: `nativeMessaging`, `storage`, `privacy`; the content script on `https://*/*`, `http://localhost/*` and `http://127.0.0.1/*` (all frames); the command `fill-login` (Ctrl+Shift+L). No `host_permissions`, no `web_accessible_resources`. Each one is in the guard in `src-tauri/src/contract_tests.rs` (`installer_registers_the_bridge`).

## 9. Tests

- Rust: `cargo test -p coffer-bridge` (framing, 1 MB cap, pipe name, ACL), `cargo test -p coffer bridge` (pairing vector, MAC, replay, locked, Deny and timeout, `list_logins` names only, `get_login` only for the site, the re-prompt wait, Cancel, lock), `cargo test -p coffer-core site` (the shared matching table).
- Vitest: `extension/src/**/*.test.ts` (signing, the vector, the Session against a fake Coffer, popup states, sign-in field detection on fixture pages, the fill's events, the worker's frame and https rules, the controller: nothing fills without a pick), `src/lib/url.test.ts` (the shared name table).
- e2e: `node e2e/bridge.mjs` (Connect; see its header) and `node e2e/browser-fill.mjs` (fill on local https sites: northwind-shop.test, accounts.northwind-shop.test, the look-alike northwind-sh0p.test, a cross-site frame in evil.test). They build nothing: build first. Each runs a QA Coffer, registers a QA host for Playwright's Chromium under `HKCU\Software\Chromium\NativeMessagingHosts` (the key Chrome for Testing reads; Chrome and Edge never read it), loads the unpacked extension and removes the key at the end.
