# Coffer: product and technical spec

Status: v1 draft, 2026-10-16. Built from the research in [research/findings.md](research/findings.md) and [research/import-formats.md](research/import-formats.md).

## 1. What Coffer is

Coffer is a password manager for Windows that lives in the system tray, next to the clock (in the overflow under the "^" arrow, like a VPN app). It keeps your passwords in one encrypted file on your own disk. It has no account, no server and no subscription. You open it from the tray icon or with Ctrl+Shift+Space from any app.

### Why it exists (from the research)
- Dashlane removed its Windows app in 2022. 1Password and Bitwarden ship heavy Electron apps, and 1Password raised its price in 2026 and has no local-only vault for most users.
- Coffer is local-first, fast, and keeps secrets out of the UI layer: the Rust core holds them, and the UI gets a secret only when you ask to see it.

### Principles
1. **Local-first.** The vault file never leaves the machine unless you export it or keep it in a synced folder.
2. **No network by default.** The only network call is the breach check, and it is off until you turn it on. Coffer fetches no favicons: a favicon request tells a server which sites you use.
3. **Keyboard first.** Every action has a key. Quick Access is the daily path.
4. **Honest security UI.** Every score shows its formula. Every claim on screen is true of the code.
5. **Secrets stay in Rust.** Copy goes from Rust straight to the Windows clipboard. The WebView gets a secret value only for "Reveal".

## 2. Feature set: what we take from each product

| Feature | Taken from | In Coffer |
|---|---|---|
| Master password + Secret Key (two-secret key derivation) and an Emergency Kit | 1Password | Yes (M2, M5) |
| Argon2id with stored parameters and a floor check | Bitwarden (Argon2id), Dashlane (Argon2) | Yes (M2) |
| Random vault key wrapped by the derived key, so a password change re-wraps one key | Bitwarden | Yes (M2) |
| Quick Access popup with global hotkey and app-based suggestions | 1Password | Yes (M3) |
| Tray icon, close-to-tray, start with Windows, tray menu | all three | Yes (M3) |
| Auto-lock on idle, Windows lock, sleep; global lock key | 1Password, Bitwarden | Yes (M3) |
| Windows Hello unlock, "require master password every N days" | 1Password, Bitwarden | Yes, in-session (M5) |
| Clipboard auto-clear (90 s) and no clipboard history | 1Password | Yes, plus Windows clipboard-history exclusion (M3) |
| Typed fields, sections, tags, favourites, archive, trash 30 days, item history, password history | 1Password, Bitwarden | Yes (M4) |
| Per-item "ask for master password to reveal" | Bitwarden | Yes (M4) |
| Generator: random, passphrase (EFF), PIN, history | all three | Yes (M2, M4) |
| Built-in TOTP (otpauth://, steam://) | all three | Yes (M2, M4) |
| Health dashboard with fix actions | 1Password Watchtower | Yes (M5) |
| Health score with excluded items, formula shown | Dashlane | Yes (M5) |
| Breach check by k-anonymity (HIBP range API), opt-in | Bitwarden | Yes (M5) |
| Import from 1Password, Bitwarden, Dashlane, browsers | Bitwarden's importer set | Yes (M6) |
| Encrypted export and open plain export | Bitwarden | Yes (M6) |
| Auto-type into the previous window | Bitwarden (autotype preview), KeePass | Yes (M7) |
| Screen-capture protection toggle | Bitwarden "Allow screenshots" | Yes (M3) |
| SSH key items with key generation | 1Password, Bitwarden | Store and generate (M4); agent is later |

### Not doing in v1
- No account, sync service, sharing, family plans, organisations, emergency access, Send or sharing links: each needs a server.
- No browser extension and no in-page autofill. Auto-type and copy cover desktop use.
- No email breach monitoring (it needs a paid HIBP key) and no VPN.
- No Travel Mode (it needs a server copy to restore from).
- No passkey use. Imported passkeys are kept as data and shown as "stored, not usable in Coffer".
- No SSH agent, no CLI, no macOS or Linux build.
- No light theme in v1: Sam picked the "Red Dark" theme.

### Later (after v1, in this order)
1. SSH agent on `\\.\pipe\openssh-ssh-agent` with a per-use approval prompt.
2. "2FA available" health check from a bundled 2fa.directory snapshot.
3. Windows Hello across restarts (signed-challenge key, the Bitwarden approach).
4. Item-level merge when a synced vault file changes on two machines.
5. Browser extension over native messaging.

## 3. Security design

### 3.1 Threat model
| Attacker has | Coffer must |
|---|---|
| A copy of the vault file (cloud folder, backup, stolen USB) | Keep every item secret. The file alone is not enough even with a weak password, because the Secret Key is not in it. |
| The vault file and the Secret Key (Emergency Kit stolen) | Hold against guessing for a strong password: Argon2id with a high memory cost. |
| The ability to change the vault file | Detect every change to an item, a deletion, an item rollback or a KDF-parameter downgrade, and refuse to open. A whole-file rollback to an older valid copy cannot be detected; say so. |
| Code running as the same Windows user while Coffer is locked | Best effort only. A process with the user's rights can read the DPAPI-protected Secret Key and can log keys. State this in the docs; do not claim more. |
| Code running as the same user while Coffer is unlocked | Out of scope. No password manager can stop it. |
| Shoulder-surfing, screen sharing, clipboard history | Mask by default, exclude windows from capture (setting, on by default), exclude copies from Windows clipboard history and cloud clipboard, clear the clipboard. |

### 3.2 Secrets and keys
- **Master password**: chosen by the user. Normalise with Unicode NFKD and trim leading and trailing white space (as 1Password does) before use. The create screen refuses a password with a zxcvbn score below 3.
- **Secret Key**: 16 random bytes from the OS CSPRNG, made once per vault. Shown as `C1-XXXXXXX-XXXXX-XXXXX-XXXXX-XXXXX`: 26 base-31 symbols plus 1 check symbol, alphabet `23456789ABCDEFGHJKLMNPQRSTVWXYZ` (no 0, 1, I, O, U). The check symbol is the sum of symbol values weighted by position, mod 31, so a typo is caught before the KDF runs.
- The device stores the Secret Key in `%LOCALAPPDATA%\Coffer\device.json`, encrypted with DPAPI (`CryptProtectData`, current user), under the vault id. A new machine asks for it once, from the Emergency Kit.

### 3.3 Key derivation
```
pw_key   = Argon2id(password, salt = kdf.salt (16 B), m = kdf.m_kib, t = kdf.t, p = kdf.p, len = 32)
sk_key   = HKDF-SHA256(ikm = secret_key (16 B), salt = vault_id (16 B), info = "coffer/v1/secret-key", len = 32)
kek      = HKDF-SHA256(ikm = pw_key || sk_key, salt = kdf.salt, info = "coffer/v1/kek", len = 32)
VK       = 32 random bytes, made once per vault (the vault key)
wrapped  = XChaCha20-Poly1305(key = kek, nonce = 24 random bytes, aad = header_aad, plaintext = VK)
item_key = HKDF-SHA256(ikm = VK, info = "coffer/v1/items")
mac_key  = HKDF-SHA256(ikm = VK, info = "coffer/v1/manifest")
blob_key = HKDF-SHA256(ikm = VK, info = "coffer/v1/attachments")
```
- **Default KDF**: Argon2id, m = 131072 KiB (128 MiB), t = 3, p = 4. Target: 0.5 to 1.5 s on Sam's laptop (Intel Ultra 7 155H). The create step measures it and states the time.
- **Floor**: refuse to open a vault whose header asks for m < 65536 KiB or t < 2 or p < 1. This stops a downgrade attack (Bitwarden does the same).
- **header_aad** = UTF-8 of `coffer-vault/1` + vault_id bytes + the KDF fields in fixed order + the Secret Key id. A change to any KDF field breaks the unwrap, so the header cannot be lowered in place.
- A wrong password and a wrong Secret Key give the same error: "The master password or the Secret Key is wrong."
- **Change master password**: new salt, same or new KDF parameters, new wrap of VK. Items are not re-encrypted.
- **Rotate Secret Key**: same as above with a new Secret Key and a new Emergency Kit.

### 3.4 Vault file format (`.coffer`)
One UTF-8 JSON file. Binary values are base64 (standard, padded).
```json
{
  "format": "coffer-vault",
  "version": 1,
  "vault_id": "uuid",
  "secret_key_id": "C1-XXXXXXX",
  "kdf": { "alg": "argon2id", "m_kib": 131072, "t": 3, "p": 4, "salt": "b64" },
  "wrapped_vault_key": { "nonce": "b64", "ct": "b64" },
  "records": [ { "id": "uuid", "kind": "item|meta|history", "rev": 7, "nonce": "b64", "ct": "b64" } ],
  "manifest_mac": "b64"
}
```
- `secret_key_id` is the first 7 symbols of the Secret Key. It tells the user which key a vault needs. It does not weaken the key in a material way: 7 of 26 symbols leave about 93 bits unknown. Note: the reviewer should check this; dropping it is fine.
- Each record: `ct = XChaCha20-Poly1305(item_key, nonce, aad = "coffer/v1/record" || vault_id || id || kind || rev, plaintext = JSON)`.
- `manifest_mac = HMAC-SHA256(mac_key, canonical list of (id, kind, rev, SHA-256(ct)) sorted by id)`. Coffer checks it on open. A mismatch stops the open and offers the newest backup.
- One `meta` record holds vault settings that must be secret: vault name, generator history, health exclusions, breach-check cache, tag colours.
- **Writes are atomic**: write `vault.coffer.tmp`, flush, then rename over `vault.coffer` (retry the rename up to 5 times over 1 s if a sync tool holds the file).
- **Backups**: after each save, copy the new file to `%LOCALAPPDATA%\Coffer\backups\<vault_id>\`. Keep the last 10 saves plus one per day for 30 days. Backups are as encrypted as the vault.
- **Attachments**: each file is encrypted with `blob_key` and its own nonce (aad = vault_id || attachment id), stored as `<vault folder>\<vault name>.attachments\<id>.bin`. Limit 10 MB per file.
- **External change**: Coffer watches the file. If it changes on disk and Coffer has no unsaved change, it reloads. If both changed, Coffer keeps its own copy as `<name> (conflict <date>).coffer` and tells the user. Item-level merge is "Later".

### 3.5 Memory and the UI boundary
- Rust holds VK, the derived keys and the decrypted items in `zeroize`-on-drop types. Lock drops them all.
- The UI gets `ItemSummary` (no secrets) and `ItemView` (secret fields masked). `item_reveal` returns one secret value. `item_copy` never sends the value to the UI.
- The UI clears its item store on the `vault://locked` event.

### 3.6 Windows Hello (M5)
- In-session quick unlock, as Bitwarden's first path: when Hello is on and Coffer locks, it keeps VK encrypted with `CryptProtectMemory` (same process). Unlock asks `UserConsentVerifier` (with the window handle, so the prompt is in front). A pass decrypts VK.
- The master password is still needed after an app restart, after Windows sign-out, and after "Require master password every" N days (default 14).

### 3.7 Clipboard
- Copy writes `CF_UNICODETEXT` plus the formats `ExcludeClipboardContentFromMonitorProcessing`, `CanIncludeInClipboardHistory` (DWORD 0) and `CanUploadToCloudClipboard` (DWORD 0). Then Win+V history and cloud clipboard do not keep it.
- Clear after the set time (default 90 s) only if `GetClipboardSequenceNumber` still matches our write, so Coffer never clears something the user copied later.

### 3.8 Breach check (M5, opt-in)
- SHA-1 of each password, send the first 5 hex characters to `https://api.pwnedpasswords.com/range/<prefix>` with the header `Add-Padding: true`, compare the suffixes locally. Cache the result per item revision in the meta record. Run only when the user presses "Check now" or turns on "check weekly".

## 4. Item model

```
Item {
  id: uuid, type: ItemType, title: string, subtitle (derived),
  favorite: bool, tags: [string], state: "active" | "archived" | "trashed", trashed_at?: time,
  created_at, updated_at, password_changed_at?: time,
  fields: [Field], notes: string, urls: [{ url, label? }], apps: [exe name],
  reprompt: bool, autotype_sequence?: string, health_excluded: bool,
  attachments: [{ id, name, size, mime }],
  password_history: [{ value, changed_at }]  (last 20),
  revisions: [{ rev, saved_at, snapshot }]    (last 10, in a separate "history" record)
}
Field { id, label, kind, value, section?: string, builtin?: string }
kind = text | concealed | multiline | email | url | phone | date | month_year | totp | boolean | card_number | pin | menu
```

Item types and their built-in fields:
| Type | Built-in fields |
|---|---|
| Login | username (text), password (concealed), one-time code (totp); urls |
| Secure Note | notes only (Markdown subset: headings, lists, bold, code) |
| Credit Card | cardholder, number (card_number), expiry (month_year), CVV (pin), PIN (pin), brand (menu) |
| Identity | title, first, middle, last, birth date, email, phone, address lines, city, region, postcode, country, company |
| Bank Account | bank, holder, account number (concealed), sort code / routing, IBAN (concealed), SWIFT/BIC, PIN (pin) |
| ID Document | kind (passport, driving licence, ID card, other), number, full name, issued (date), expires (date), country |
| SSH Key | private key (concealed multiline), public key, fingerprint, passphrase (concealed). Coffer can generate Ed25519. |
| API Credential | username, credential (concealed), host, expires (date) |
| Wi-Fi | network name, password (concealed), security (menu) |
| Software Licence | product, version, licence key (concealed), licensed to, email, purchase date |
| Password | password (concealed) only |

- Custom fields of any kind can be added to any item, grouped by optional section names.
- Tags can nest with "/" ("Work/Clients"). Tags do the job of folders.
- Trash keeps items 30 days, then purges them on the next unlock.
- Archive hides an item from lists and Quick Access and from health checks, and keeps it.

## 5. Generator
- **Random**: length 8 to 128 (default 20). Sets: A-Z, a-z, 0-9, symbols `!@#$%^&*()-_=+[]{};:,.?/`. Minimum digits and symbols (0 to 9). "Avoid look-alike characters" (`0O1lI|`). Exclude list. Uniform choice by rejection sampling. Every chosen set appears at least once.
- **Passphrase**: EFF large word list (7,776 words, CC BY 3.0, credit in About). 3 to 20 words (default 5), separator (`-` default, space, `.`, `_`, digit, symbol), capitalise, add a digit.
- **PIN**: 4 to 12 digits (default 6).
- Shows entropy in bits (from the generator's own space, not zxcvbn) and a strength label.
- History: last 50 values, kept in the meta record, clearable.

## 6. TOTP
- RFC 6238: SHA-1, SHA-256, SHA-512; 6 to 8 digits; period 30 or 60. Accept `otpauth://totp/...` URIs and bare base32 secrets. Accept `steam://<secret>` (5 symbols from Steam's alphabet).
- Add by pasting a URI or secret, by dropping a QR image, or (M7) by "Scan QR on screen".
- The detail view shows the code and a countdown ring. Ctrl+T copies it.

## 7. Health (M5)
| Check | Rule | Counts in score |
|---|---|---|
| Breached | password found in Pwned Passwords (opt-in) | yes |
| Reused | the same password in 2 or more active items | yes |
| Weak | zxcvbn score 0, 1 or 2 | yes |
| Unsecured site | a URL with `http://` (not localhost or a private address) | no |
| Old | password unchanged for 365 days or more | no |
| Expiring | card expiry within 60 days; document expiry within 90 days | no |
| Duplicate | same username and same site in two items | no |
- **Score** = round(100 x healthy / total). total = active login and password items with a password, not excluded. healthy = not breached, not reused, not weak. Coffer shows the score only when total is 5 or more, and prints the formula under it.
- Each finding has actions: "Change password" (opens the item in edit mode with the generator), "Open site", "Use HTTPS", "Exclude from health".

## 8. Import and export (M6)
- **Import** formats: 1Password `.1pux` and CSV; Bitwarden JSON, password-protected encrypted JSON, CSV; Dashlane CSV ZIP and single CSVs; Chrome, Edge, Brave CSV; Firefox CSV. Exact formats: [research/import-formats.md](research/import-formats.md).
- Flow: pick file, Coffer detects the format, shows a preview (counts by type, warnings, items it skips and why), then imports. Each imported item gets the tag `Imported/<source>`. An item that is equal in type, title, username, password and URL to an existing item is skipped.
- **Export**: Coffer encrypted export (`.cofferx`, own password, Argon2id + XChaCha20-Poly1305), Coffer JSON (plain), Bitwarden JSON (plain, so a user can leave), CSV (logins and notes, Bitwarden headers). A plain export needs the master password again and shows a warning.

## 9. Desktop shell (M3)
- **Tray icon**: a coffer glyph. Locked and unlocked states look different. Tooltip "Coffer: locked" or "Coffer: unlocked".
  - Left click: show or hide Quick Access, anchored above the tray icon.
  - Right click menu: Open Coffer, Quick Access (Ctrl+Shift+Space), Copy a new password, Lock or Unlock, Settings, Quit Coffer.
- **Quick Access**: frameless popup, 400 x 560, rounded corners, above the tray (or centred on the screen when opened by hotkey). Closes on Esc or when it loses focus.
  - Locked: password field, "Unlock with Windows Hello" button.
  - Unlocked: search field focused. Before search: "Suggested for <app>" (matches the window that was in front: browser title words against item URL hosts, process name against item apps), then Favourites, then Recently used.
  - Keys: Up/Down move, Enter copies the password (card: number; note: opens it), Ctrl+U username, Ctrl+P password, Ctrl+T one-time code, Ctrl+Enter auto-type (M7), Right arrow all actions, Ctrl+O open in Coffer, Esc clear or close.
- **Main window**: three panes (sidebar, list, detail), min 900 x 600. The close button hides it to the tray. A first close shows a one-time notice "Coffer is still running in the tray".
- **Global hotkeys** (changeable): Ctrl+Shift+Space Quick Access, Ctrl+Shift+L lock.
- **Start with Windows**: on by default (asked at setup), starts hidden in the tray.
- **One instance**: a second launch shows the running one.
- **Auto-lock**: after N minutes of system idle (`GetLastInputInfo`; 1, 2, 5, 10 default, 15, 30, 60, never), on Windows lock (default on), on sleep (default on), and by Ctrl+Shift+L.
- **Screen capture**: `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` on all Coffer windows while the setting is on (default on).
- **Main-window shortcuts**: Ctrl+F search, Ctrl+N new item, Ctrl+E edit, Ctrl+S save, Esc cancel, Ctrl+U/P/T copy, Ctrl+R reveal, Ctrl+G generator, Ctrl+L lock, Delete move to trash, Ctrl+, settings, F1 shortcut list.

## 10. Auto-type (M7)
- Quick Access records the window that was in front when it opened (HWND, title, process).
- Ctrl+Enter: Coffer hides Quick Access, brings that window back, checks that it is in front, then sends the sequence with `SendInput` (`KEYEVENTF_UNICODE`). Default sequence `{USERNAME}{TAB}{PASSWORD}{ENTER}`. Tokens: `{USERNAME} {PASSWORD} {TOTP} {TAB} {ENTER} {DELAY ms}` and any custom field label `{FIELD:label}`.
- If the target window is gone or not in front, Coffer types nothing and says why.

## 11. Screens
1. **Welcome**: "Create a new vault" or "Open an existing vault".
2. **Create vault**: master password (+ strength), confirm; location (default or a chosen folder, with a note on synced folders); Secret Key and Emergency Kit (save as PDF or print; confirm by typing the last 4 symbols); preferences (start with Windows, Windows Hello).
3. **Unlock** (main window and Quick Access forms).
4. **Quick Access** popup.
5. **Main window**: sidebar (All items, Favourites, the item types, Tags, Health, Archive, Trash; footer: Generator, Import, Settings, Lock), list (search, sort, type filter), detail (view, edit inline).
6. **Generator** panel.
7. **Health** dashboard.
8. **Import** wizard and **Export** dialog.
9. **Settings**: General, Security, Vault, Shortcuts, About.
10. **Emergency Kit** printable page.

## 12. Architecture
- **Tauri 2** desktop app. Rust backend, React + TypeScript UI in WebView2. Vite. pnpm.
- `crates/coffer-core`: pure Rust library with no Tauri or Windows dependency: crypto, vault format, items, generator, TOTP, health, importers, exporters. All unit tests live here.
- `src-tauri`: the app. Commands (the IPC contract below), tray, windows, hotkeys, autostart, single instance, Windows-only code (DPAPI, Hello, clipboard, idle, session events, SendInput) behind `cfg(windows)`.
- `src/`: the UI. One Vite build with two entry pages: `index.html` (main window) and `quick.html` (Quick Access).
- **Demo backend**: when the UI runs in a plain browser (no Tauri), `src/lib/ipc.ts` uses an in-memory demo backend. Every screen then shows a "DEMO DATA" badge. This lets the UI be built and screenshot-tested without a Rust build.

### 12.1 IPC contract (Tauri commands)
All commands return `Result<T, CofferError>` where `CofferError = { code, message }`.
```
vault_status() -> { state: "no_vault"|"locked"|"unlocked", vault_path?, needs_secret_key, hello_available, hello_enabled }
vault_create({ password, folder? }) -> { secret_key, kit: EmergencyKit }
vault_open({ path }) -> VaultStatus
vault_unlock({ password, secret_key? }) -> VaultStatus
vault_unlock_hello() -> VaultStatus
vault_lock() -> ()
vault_change_password({ current, next }) -> ()
emergency_kit({ password }) -> EmergencyKit
items_list() -> [ItemSummary]
item_get({ id }) -> ItemView
item_reveal({ id, field_id, password? }) -> string
item_copy({ id, field_id }) -> { clears_in_s }
item_save({ item: ItemInput, base_rev? }) -> ItemView
item_set_state({ id, state }) -> ()
item_delete_forever({ id }) -> ()
trash_empty() -> ()
item_revisions({ id }) -> [Revision]
item_restore_revision({ id, rev }) -> ItemView
totp_code({ id, field_id? }) -> { code, period, remaining }
generate({ options }) -> { value, entropy_bits, label }
generator_history() -> [{ value, created_at }]
health_report() -> HealthReport
health_check_breaches() -> HealthReport
import_preview({ path }) -> ImportPreview
import_commit({ preview_id }) -> { imported, skipped }
export_vault({ kind, path, password }) -> { path }
settings_get() -> Settings
settings_set({ patch }) -> Settings
quick_context() -> { title, process }
autotype({ id }) -> ()
```
Events: `vault://locked`, `vault://unlocked`, `vault://changed`, `clipboard://cleared`, `quick://shown`.

## 13. Design
- Theme: "Red Dark" by kartman.sms on 21st.dev (Sam's choice), dark mode tokens. Fonts: chosen with the Fontshare tool (Sam's ask).
- Design work follows Sam's design skills (impeccable, taste, ui-ux-pro-max, frontend-design) and at least two critique-and-fix rounds.

## 14. Roadmap
| Stage | Delivers | Runs with |
|---|---|---|
| M0 | Research, this spec, two review rounds | - |
| M1 | Design system, screen designs, two critique rounds | M2 |
| M2 | `coffer-core`: crypto, vault file, items, generator, TOTP, tests | M1 |
| M3 | App shell: tray, Quick Access, main window, lock and unlock, auto-lock, hotkeys, clipboard, autostart | M4 |
| M4 | Vault UI: list, detail, edit for all types, search, tags, archive, trash, history, generator, TOTP | M3 |
| M5 | Health, breach check, Emergency Kit, Windows Hello | M6 |
| M6 | Import, export, backups | M5 |
| M7 | Auto-type, QR scan | - |
| M8 | Installer, icons, README, screenshots | - |
| M9 | QA pass, design review, fixes, PR | - |

## 15. Done means
- `cargo test --workspace` passes, including known-answer tests (RFC 6238 appendix B, RFC 5869 HKDF, Argon2id RFC 9106, XChaCha20-Poly1305 test vector), vault round trip, wrong password, wrong Secret Key, each tamper case (edited record, deleted record, rolled-back record, lowered KDF), and each importer on a fixture.
- `pnpm test` passes. `pnpm build` passes. `pnpm tauri build` makes an NSIS installer.
- A test proves the vault file holds no plaintext: create a vault with a known password value, then search the file bytes for it.
- The installed app shows a tray icon. Ctrl+Shift+Space and a tray click open Quick Access. Create vault, add a login, lock, unlock, copy the password: the clipboard clears after 90 s and the value is not in Win+V history.
- Every screen passes a scripted check in the browser demo (no console errors, no horizontal overflow, focus visible) and a design review.
