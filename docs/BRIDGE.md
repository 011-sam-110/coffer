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

## 5. Calls that work now (M3)

| Call | Signed | Args | Result | Errors |
|---|---|---|---|---|
| `hello` | no | `version` (extension), `browser` (`chrome`, `edge`, `chromium`, `other`), `client` (stored id or null) | `protocol` (1), `version` (Coffer), `paired` (Coffer has this client), `locked`, `nonce` (base64, 16 bytes, this connection) | `bad_request` |
| `pair` | no | `pub` (base64 X25519, 32 bytes), `browser`, `version` | `pairId`, `pub` (Coffer's key), `client` (32 hex) | `busy`, `bad_request` |
| `pair_result` | no | `pairId` | `paired: true`, `confirm` | `denied`, `timeout`, `not_found` |
| `status` | yes | none | `version`, `locked`, `offerSave`, `offerUpdate` (Settings, Browsers switches) | gate errors |
| `unlock` | yes | none | as `status`. Coffer shows its unlock window (PIN, Hello or master password). No password crosses the pipe. | gate errors |
| `disconnect` | yes | none | `disconnected: true`. Coffer deletes this browser's key. | gate errors |

When Coffer reports a version newer than the extension's manifest version, the extension calls `chrome.runtime.reload()` once for that version (`reloadedFor` in `chrome.storage.local`): the installer replaced the files.

## 6. Calls for M4 and M5 (defined here, not built yet)

Each needs the vault: a locked Coffer answers `locked` (the extension then offers Unlock Coffer, which calls `unlock`). In M3 an unlocked Coffer answers `unknown_call`. `url` is the full URL of the page (top frame, or a frame of the same site). Coffer checks it again: `https:` only, or `http:` on `localhost` / `127.0.0.1`; anything else gets `bad_request`. Matching is by registered domain (eTLD+1: `accounts.google.com` matches a `google.com` login; `g00gle.com` matches nothing), on the login's Website first and its name second (a name that reads as an address, as `src/lib/url.ts` reads it).

| Call | Stage | Args | Result | Errors |
|---|---|---|---|---|
| `list_logins` | M4 | `url` | `site` (the registered domain), `logins`: `[{ id, title, username, hasTotp }]`, best first. No passwords. | `locked`, `bad_request` |
| `get_login` | M4 | `id`, `url` | `username`, `password`, `hasTotp`. Coffer refuses a login that does not match `url`. | `locked`, `not_found`, `no_match`, `reprompt` (the login asks for the master password: Coffer shows its prompt; call again after) |
| `copy_totp` | M4 | `id`, `url` | `clearsInSeconds` (Coffer copies the current code with its own clipboard rules and clear timer) | `locked`, `not_found`, `no_match`, `no_totp` |
| `find_login` | M5 | `url`, `username`, `password` | `match` (`none`, `same`, `changed`, `never`), `id` and `title` when there is a login, `offer` (`save`, `update` or null: Coffer applies the two switches and the never list) | `locked`, `bad_request` |
| `save_login` | M5 | `url`, `username`, `password` | `id`, `title`. A new login named after the registered domain, Website `https://<domain>`. Only after the user clicks Save. | `locked`, `bad_request` |
| `update_password` | M5 | `id`, `url`, `password` | `id`. The old password goes to the login's password history. Only after the user clicks Update. | `locked`, `not_found`, `no_match` |
| `never_for_site` | M5 | `url` | `site`. Coffer keeps the registered domain and offers nothing there again. | `locked`, `bad_request` |

M4 and M5 may add fields. Write each change into this table in the same PR.

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
| `busy` | Coffer | A Connect prompt is open already. |
| `denied`, `timeout` | Coffer | The Connect prompt: Deny, or no answer in 2 minutes. |
| `locked` | Coffer | The call needs the vault. |
| `not_found`, `no_match`, `no_totp`, `reprompt` | Coffer | M4 and M5 calls (section 6). |
| `unknown_call` | Coffer | Coffer does not know the call (or does not answer it yet). |
| `not_installed` | extension | Chrome cannot find the native host (`chrome.runtime.lastError` says "not found"). |

## 8. The extension, for M4 and M5

```
extension/
  manifest.json          the manifest; build.mjs sets "version" from package.json
  build.mjs              Vite build into extension/dist (COFFER_EXTENSION_OUT, COFFER_HOST)
  public/icons/
  src/background.ts      service worker: one Session, answers the popup
  src/chrome.d.ts        the chrome.* types in use (add what you use)
  src/lib/protocol.ts    crypto and envelopes (pure, tested in Vitest)
  src/lib/client.ts      NativeLink (port + ids), Session: connect(), pair(), call(name, args)
  src/lib/state.ts       popup states and messages
  src/popup/             toolbar popup (view.ts draws from a state)
  src/welcome/           first-run page (turns off the browser's own password offers)
  src/styles/coffer.css  Coffer's tokens
```

- From the service worker: `await session.call<Result>("list_logins", { url })`. It throws `BridgeError` with `code` from section 7.
- The popup and the welcome page talk to the worker with `chrome.runtime.sendMessage({ type: "coffer:..." })`; the worker answers only its own extension pages. Content scripts get their own message types; check `sender.tab` and the frame URL there.
- A content script cannot be an ES module: build it as a separate IIFE bundle (a second `build()` in build.mjs with `build.lib` and `formats: ["iife"]`), and put the menu and the Save bar in a closed shadow root with a copy of the tokens.
- Permissions now: `nativeMessaging`, `storage`, `privacy`. M4 adds what fill needs (content scripts on `https://*/*` and `http://localhost/*`, the Ctrl+Shift+L command); add each one to the guard in `src-tauri/src/contract_tests.rs` (`installer_registers_the_bridge`).

## 9. Tests

- Rust: `cargo test -p coffer-bridge` (framing, 1 MB cap, pipe name, ACL), `cargo test -p coffer bridge` (pairing vector, MAC, replay, locked, Deny and timeout).
- Vitest: `extension/src/**/*.test.ts` (signing, the vector, the Session against a fake Coffer, popup states).
- e2e: `node e2e/bridge.mjs` (see its header). It builds nothing: build first. It runs a QA Coffer, registers a QA host for Playwright's Chromium under `HKCU\Software\Chromium\NativeMessagingHosts` (the key Chrome for Testing reads; Chrome and Edge never read it), loads the unpacked extension and removes the key at the end.
