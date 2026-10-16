# Coffer: product and technical spec

Status: **v2**, 2026-10-16. v1 had two independent reviews (security, product); v2 takes in both in full. Research: [research/findings.md](research/findings.md), [research/import-formats.md](research/import-formats.md). The IPC contract is code: [`src/lib/contract.ts`](../src/lib/contract.ts).

## 1. What Coffer is

Coffer is a password manager for Windows that lives in the system tray, next to the clock (in the overflow under the "^" arrow, like a VPN app). It keeps your passwords in one encrypted file on your own disk. It has no account, no server and no subscription. You open it from the tray icon or with a hotkey from any app.

### Why it exists (from the research)
- Dashlane removed its Windows app in 2022. 1Password and Bitwarden ship heavy Electron apps. 1Password raised its price in 2026 and has no local-only vault for most users.
- Coffer is local-first and fast. The Rust core holds the secrets; the UI gets a secret only when you reveal one.

### Principles
1. **Local-first.** The vault file never leaves the machine unless you export it or keep it in a synced folder.
2. **One network call, off by default.** Coffer's own code makes one network call: the opt-in breach check. No favicons (a favicon request tells a server which sites you use). Fonts and theme files are bundled. (WebView2 itself can contact Microsoft; Coffer does not control that.)
3. **Keyboard first.** Every action has a key. Quick Access is the daily path.
4. **Honest security UI.** Every score shows its formula. Every claim on screen is true of the code.
5. **Secrets stay in Rust.** Copy and auto-type go from Rust straight to Windows. The WebView gets a secret value only for "Reveal" and for editing a secret field.

## 2. Feature set: what we take from each product

| Feature | Taken from | Tier |
|---|---|---|
| Master password + Secret Key (two-secret key derivation), Emergency Kit at creation | 1Password | 1 |
| Argon2id with stored parameters, a floor and a ceiling | Bitwarden, Dashlane | 1 |
| Random vault key wrapped by the derived key | Bitwarden | 1 |
| Quick Access popup from the tray and a hotkey, app-based suggestions | 1Password | 1 |
| Tray icon, close-to-tray, start with Windows, tray menu | all three | 1 |
| Auto-lock on idle, Windows lock, sleep | 1Password, Bitwarden | 1 |
| Clipboard auto-clear and Windows clipboard-history exclusion | 1Password + Windows formats | 1 |
| Typed fields, sections, tags, favourites, archive, trash 30 days, password history | 1Password, Bitwarden | 1 |
| Per-item "ask for master password" re-prompt | Bitwarden | 1 |
| Generator: random, passphrase (EFF), PIN, history | all three | 1 |
| Built-in TOTP (otpauth://, steam://, paste) | all three | 1 |
| Health dashboard with fix actions, score with formula, Excluded tab | 1Password Watchtower + Dashlane | 1 |
| Breach check by k-anonymity, opt-in | Bitwarden | 1 |
| Import: 1Password (1PUX, CSV), Bitwarden (JSON, CSV), Dashlane (CSV ZIP), browsers, Coffer | Bitwarden's importer set | 1 |
| Export: Coffer encrypted, Bitwarden JSON, CSV | Bitwarden | 1 |
| Automatic encrypted backups and restore | KeePass-style | 1 |
| Screen-capture protection | Bitwarden | 1 |
| Windows Hello in-session unlock (a convenience gate, off by default) | 1Password, Bitwarden | 2 |
| Auto-type into the previous window | Bitwarden autotype, KeePass | 2 |
| Item revision history UI | 1Password | 2 |
| SSH key items with Ed25519 generation | 1Password, Bitwarden | 2 |
| TOTP from a QR image (file or screen) | 1Password | 2 |
| Attachments | all three | 3 |
| Encrypted Bitwarden JSON import | Bitwarden | 3 |

Tier 1 is v1. Tier 2 is built tonight only after tier 1 passes QA, in the order listed. Tier 3 is "Later".

### Not doing in v1
- No account, sync service, sharing, family plans, organisations, emergency access, Send or sharing links: each needs a server.
- No browser extension and no in-page autofill. Copy (and tier-2 auto-type) cover desktop use.
- No email breach monitoring (it needs a paid HIBP key) and no VPN.
- No Travel Mode (it needs a server copy to restore from).
- No passkey use. Imported passkeys stay as data, shown as "Stored passkey (Coffer cannot sign in with it)".
- No SSH agent, no CLI, no macOS or Linux build. No light theme (Sam picked "Red Dark").

### Later (after v1, in order)
1. Attachments. 2. Encrypted Bitwarden JSON import. 3. SSH agent on `\\.\pipe\openssh-ssh-agent` with per-use approval. 4. "2FA available" check from a 2fa.directory snapshot. 5. Windows Hello across restarts (signed challenge). 6. Item-level merge for synced vaults. 7. Browser extension.

## 3. Security design

v2 security: this section takes in the security review in full (verdict "sound with fixes").

### 3.1 Threat model
| Attacker has | Coffer must |
|---|---|
| A copy of the vault file (cloud folder, backup, stolen USB) | Keep every item secret. The file alone is not enough even with a weak password, because the Secret Key is not in it. |
| The vault file and the Secret Key (Emergency Kit stolen) | Hold against guessing for a strong password: Argon2id with high memory cost. |
| The ability to change the vault file | Detect a changed, deleted, added or rolled-back record and a changed KDF header, and refuse to open. A whole-file rollback is detected on any PC that saw the newer file (generation counter); a PC that never saw it cannot detect it. |
| Old copies of the file plus old secrets, after the user changed them | "Change master password" with "My old password may be known" and "Rotate Secret Key" make a new vault key and re-encrypt everything, so old secrets do not open new versions. |
| Code running as the same Windows user while Coffer is locked | Best effort only. Such code can read the DPAPI-protected Secret Key and log keys; with Hello on it can open the vault. The docs say so; the UI claims no more. |
| Code running as the same user while Coffer is unlocked | Out of scope. No password manager can stop it. |
| Script injected into the UI (for example from imported data) | Cannot reach more than its window's capability allows, cannot load remote code (CSP), cannot navigate away, cannot open arbitrary URLs or files. |
| Shoulder-surfing, screen sharing, clipboard history | Mask by default; hide windows from most screen capture (setting, on by default); keep copies out of Windows clipboard history and cloud clipboard; clear the clipboard. |

### 3.2 Secrets and keys
- **Master password**: normalise with Unicode NFKD and trim leading and trailing white space before use. Create and change refuse a zxcvbn score below 3 (zxcvbn gets the vault name as a user input).
- **Secret Key**: 16 random bytes (128 bits) from the OS CSPRNG, once per vault (and again on rotation). Text form `C1-AAAAAA-XXXXX-XXXXX-XXXXX-XXXXX-XXXXXX`. Alphabet `23456789ABCDEFGHJKLMNPQRSTVWXYZ` (31 symbols, values 0 to 30 in that order; no 0, 1, I, O or U).
  - `C1` = format version.
  - `AAAAAA` = **key id**: 6 random symbols made with the key, NOT derived from it, not secret. The kit prints it as "Key ID"; the vault header stores it; `header_aad` binds it.
  - Then 26 secret symbols: one big-endian base-31 integer (31^26 > 2^128). Decoding rejects a value of 2^128 or more.
  - Then 1 check symbol: c = (sum of i * v_i for i = 1..26) mod 31 over the secret symbols. Because 31 is prime, this catches every single-symbol error and every swap of two symbols.
  - Input ignores case, spaces and dashes. A character outside the alphabet shows "This character is not in a Secret Key" at once.
- The device stores the Secret Key in `%LOCALAPPDATA%\Coffer\device.json` with `CryptProtectData` (current user, `CRYPTPROTECT_UI_FORBIDDEN`, optional entropy `coffer/v1/device-sk` + vault_id), keyed by vault id. The docs say an administrator password reset of the Windows account loses it (then the kit is needed).
- Settings > Security > "Show Secret Key" (needs the master password) shows it and opens the Emergency Kit again.

### 3.3 Key derivation and wrapping
```
pw_key   = Argon2id(password, salt = kdf.salt (16 B), m = kdf.m_kib, t = kdf.t, p = kdf.p, len = 32)
sk_key   = HKDF-SHA256(ikm = secret_key (16 B), salt = vault_id (16 B), info = "coffer/v1/secret-key", len = 32)
kek      = HKDF-SHA256(ikm = pw_key || sk_key, salt = kdf.salt, info = "coffer/v1/kek", len = 32)
VK       = 32 random bytes (the vault key)
wrapped  = XChaCha20-Poly1305(key = kek, nonce = 24 random bytes, aad = header_aad, plaintext = VK)
item_key = HKDF-SHA256(ikm = VK, salt = vault_id, info = "coffer/v1/records", len = 32)
mac_key  = HKDF-SHA256(ikm = VK, salt = vault_id, info = "coffer/v1/manifest", len = 32)
blob_key = HKDF-SHA256(ikm = VK, salt = vault_id, info = "coffer/v1/attachments", len = 32)
```
- Every encryption draws a new 24-byte nonce from the OS RNG (`getrandom`).
- **Default KDF**: Argon2id with the `parallel` feature (so the 4 lanes use 4 threads), m = 131072 KiB (128 MiB), t = 3, p = 4. Vault creation measures the time on this PC and shows it.
- **Floor** (refuse to open below): m < 65536 KiB, t < 2, p < 1. **Ceiling** (refuse BEFORE running Argon2, so a crafted header cannot freeze the app): m > 1048576 KiB, t > 10, p > 16.
- Wrong password and wrong Secret Key give one error code (`badCredentials`). When the Secret Key came from this device, the UI says "Wrong master password." When the user typed it, the UI says "The master password or the Secret Key is wrong."
- **Change master password**: a check box "My old password may be known" (on by default). On: make a new VK, re-encrypt every record (and attachment), new salt, new wrap, delete this PC's backups made under the old VK. Off: new salt and new wrap of the same VK. Either way the dialog says "Copies made before now (sync history, other backups) still open with the old password and Secret Key."
- **Rotate Secret Key** (tier 2): always a new VK and full re-encryption, a new kit, backups under the old VK deleted.
- Tests use a test-only KDF profile under the floor, reachable only from `#[cfg(test)]` code.
- Not done (noted): key commitment (`HMAC(kek, "coffer/v1/kek-commit" || header_aad)`). An attack on its absence needs the Secret Key plus many unlocks of crafted files; revisit later.

### 3.4 Byte encodings (exact, for known-answer tests)
- Every AAD and MAC input is a sequence of fields; each field is `u32 big-endian length || bytes`. The first field is a label.
- Ids are the 16 raw UUID bytes. `kind` is 1 byte (1 = item, 2 = meta). `rev`, `generation` and counts are u64 big-endian. `m_kib`, `t`, `p` are u32 big-endian. `alg` is the UTF-8 text `argon2id`.
- `header_aad` = fields: `"coffer/v1/header"`, vault_id, `"argon2id"`, m_kib, t, p, salt, key_id (UTF-8).
- Record AAD = fields: `"coffer/v1/record"`, vault_id, id, kind, rev.
- Manifest input = fields: `"coffer/v1/manifest"`, vault_id, generation, record count, then for each record sorted by id bytes: id, kind, rev, SHA-256(nonce || ct).
- Attachment AAD (tier 3) = fields: `"coffer/v1/attachment"`, vault_id, item_id, attachment_id.
- Record plaintext is UTF-8 JSON padded with spaces to a multiple of 256 bytes before encryption (hides exact lengths).
- The parser rejects unknown top-level fields, duplicate keys, a wrong `format` or `version`, and a repeated record id.

### 3.5 Vault file format (`.coffer`)
One UTF-8 JSON file. Binary values are base64 (standard, padded).
```json
{
  "format": "coffer-vault",
  "version": 1,
  "vault_id": "uuid",
  "key_id": "AAAAAA",
  "generation": 42,
  "kdf": { "alg": "argon2id", "m_kib": 131072, "t": 3, "p": 4, "salt": "b64" },
  "wrapped_vault_key": { "nonce": "b64", "ct": "b64" },
  "records": [ { "id": "uuid", "kind": "item", "rev": 7, "nonce": "b64", "ct": "b64" } ],
  "manifest_mac": "b64"
}
```
- Record `ct = XChaCha20-Poly1305(item_key, nonce, aad = record AAD, plaintext = padded JSON)`.
- `manifest_mac = HMAC-SHA256(mac_key, manifest input)`. Checked on open, right after the unwrap and before any record is used. A mismatch stops the open: "This vault file was changed outside Coffer. [Open the newest backup] [Choose a backup]".
- **Generation**: +1 on every save, covered by the MAC. `device.json` keeps the highest generation this PC has seen per vault id. A lower generation on open shows "This file is older than the last version this PC saw (generation n, this file m)." and opens only on confirm.
- The `meta` record holds vault-level data that must be secret: vault name, generator history, health exclusions, the breach-check cache, tag colours.
- Item revisions (last 10 snapshots) are inside the item's own record.
- **Atomic write**: write a uniquely named `<stem>.<random>.tmp` in the same folder, `sync_all`, then re-read the `manifest_mac` of the file on disk: if it differs from what Coffer last loaded or wrote, do not replace it (go to the external-change rule). Else replace with `MoveFileExW(MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)`, retrying up to 10 times over 2 s while a sync tool holds the file. Delete stale `.tmp` files of this vault.
- **Backups**: after each save, copy the file to `%LOCALAPPDATA%\Coffer\backups\<vault_id>\<UTC time>.coffer`. Keep the last 20 saves and one per day for 30 days. Settings > Vault lists them by index with [Restore] (restore = make the current file a backup, then copy the chosen one in).
- **Default location**: `%USERPROFILE%\Coffer\<vault name>.coffer` (not Documents, which OneDrive Known Folder Move often syncs). If the chosen folder is under `%OneDrive%`, `%OneDriveCommercial%`, a Dropbox or a Google Drive folder, the create screen says: "This folder syncs to the cloud. The file is encrypted and useless without your Secret Key, but every copy that sync keeps can be attacked offline with it."
- **External change**: Coffer keeps the (id, rev) list and generation of what it last loaded or wrote. On a change on disk, reload only if the MAC verifies, the generation is higher, and every record Coffer wrote since its last load is in the new file at the same or a higher rev. If the MAC fails or the generation is not higher: keep the open state and show "The vault file on disk changed in a way Coffer did not expect. Coffer kept your open vault." If records of ours are missing: write our state to `<stem> (conflict <date>).coffer`, load the disk file, and show "This vault changed on another computer. Your changes since <time> are in <file>." An open edit whose base rev is stale shows "This item changed on disk. [Keep mine] [Keep theirs]".
- **Missing file**: at start, `vault_status.state = "missing"`: "Coffer cannot find your vault at <path>. [Find vault file] [Restore from backup] [Create a new vault]". If the file goes while unlocked: "The vault file is gone from <path>. Your items are still open. [Save it here again] [Save as...]". Coffer never re-creates the file without asking.
- **Attachments** (tier 3): each in `<vault file stem>.attachments\<id>.bin` (the folder name never shows the secret vault name), encrypted with `blob_key`; the item entry stores `sha256` (of nonce || ct) and `size`, checked on read.

### 3.6 Memory, the UI boundary and re-prompt
- Rust holds VK, the derived keys and the decrypted items in `zeroize`-on-drop types. Lock drops them all.
- The UI gets `ItemSummary` (no secrets) and `ItemView` (secret fields masked). `item_reveal` returns one value. `item_copy` and `autotype` never send a secret to the UI.
- Password history, revisions and generator history reach the UI masked. Each value has its own reveal and copy (`item_reveal` / `item_copy` with a `history:<entry id>` field ref; `generator_history_copy` / `generator_history_reveal` by id).
- In an `ItemInput`, a secret field with `value: null` keeps the stored value. An edit that does not touch the password never needs it in the UI.
- `health_report` returns item ids and plain-language details, never values or hashes.
- **Re-prompt is enforced in Rust; the UI never decides.** For an item with `reprompt = true`, `item_reveal`, `item_copy` of a secret field, `totp_code`, `autotype`, `item_password_history` and `item_revisions` need either the master password in the call or a grant Rust holds for that item id. Rust checks the password by deriving the KEK again and unwrapping VK. A grant ends after 60 s or on lock. Without it the command fails with `repromptRequired`.

### 3.7 WebView hardening
- `build.rs`: `tauri_build::try_build(Attributes::new().app_manifest(AppManifest::new().commands(&[...every Coffer command...])))`, so only listed commands exist for permissions.
- Capabilities per window: `capabilities/quick.json` (`"windows": ["quick"]`) allows only `app_info`, `settings_get`, `settings_set`, `vault_status`, `vault_unlock`, `vault_unlock_hello`, `vault_lock`, `items_list`, `item_copy`, `totp_code`, `autotype`, `quick_context`, `quick_hide`, `quick_set_modal`, `main_show`, `generate`, `generator_copy`. `capabilities/main.json` (`"windows": ["main"]`) allows the rest. No `remote` key. No shell plugin. No JS permissions for opener, dialog or fs: every file and folder dialog opens from Rust.
- `tauri.conf.json`: `app.withGlobalTauri: false`; `app.security.freezePrototype: true`; `app.security.assetProtocol.enable: false`; `app.security.csp`: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src ipc: http://ipc.localhost; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'` ('unsafe-inline' for styles only, for the motion library; it does not enable script).
- `on_navigation` allows only the app origin; `on_new_window` denies all; release builds have no devtools.
- WebView2 per webview (via `with_webview`): `AreBrowserAcceleratorKeysEnabled = false` (Ctrl+P, Ctrl+R, F5 and the find bar do nothing), `IsGeneralAutofillEnabled = false` and `IsPasswordAutosaveEnabled = false` (so a typed Secret Key is never saved in the WebView2 profile), default context menus off.
- Every input has `autocomplete="off"` and `spellcheck={false}`.
- Markdown in notes renders with no raw HTML (no `dangerouslySetInnerHTML`, no raw-HTML plugin).
- "Open site" is `item_open_url({ id, urlIndex })`: Rust opens only an `http://` or `https://` URL stored in that item. The UI never sends a URL to open. This blocks imported `file:` and `ms-*:` URLs.
- Import, export, open-vault, choose-folder and restore-backup use Rust-side dialogs. The UI never passes a file path to a command that reads or writes secrets.

### 3.8 Windows Hello (tier 2)
- In-session quick unlock (Bitwarden's first path): with Hello on, when Coffer locks it keeps VK encrypted with `CryptProtectMemory(CRYPTPROTECTMEMORY_SAME_PROCESS)` (buffer a multiple of 16 bytes). Unlock calls `UserConsentVerifier::CheckAvailabilityAsync`, then `IUserConsentVerifierInterop::RequestVerificationForWindowAsync(hwnd, "Unlock Coffer")` with Coffer's own window; only `Verified` passes. Quick Access does not close on blur while the prompt is up.
- **Hello is a convenience gate, not encryption.** With it on, a program running as you can open the vault without your master password. It is off by default; turning it on needs the master password; the setting says this in one sentence.
- The master password is still needed after an app restart, Windows sign-out, and after "Require master password every" N days (default 14). Then the UI hides the Hello button and says "Windows Hello works after one master-password unlock."
- When `helloReady` is true, the unlock screen starts Hello at once. Cancel falls back to the password field. Hello needs Windows 11 (build 22000) and does not work over Remote Desktop.

### 3.9 Clipboard
- One `OpenClipboard` / `EmptyClipboard` / `SetClipboardData` (x4) / `CloseClipboard`: `CF_UNICODETEXT` plus the registered formats `ExcludeClipboardContentFromMonitorProcessing` (any data), `CanIncludeInClipboardHistory` (DWORD 0) and `CanUploadToCloudClipboard` (DWORD 0). Read `GetClipboardSequenceNumber` after `CloseClipboard`.
- Clear: `OpenClipboard`, read the number again, `EmptyClipboard` only if unchanged, `CloseClipboard`. After the set time (default 90 s), and on lock, quit and Windows sign-out.
- UI wording: "Not kept in Windows clipboard history." The docs add that Remote Desktop clipboard sharing and third-party clipboard tools can still copy the value.

### 3.10 Breach check (opt-in)
- Coffer sends the first 5 characters of each password's SHA-1 hash, never the password: `GET https://api.pwnedpasswords.com/range/<prefix>` with `Add-Padding: true` and `User-Agent: Coffer`. It drops the padding lines (count 0) and compares the suffixes locally. The result is cached per item revision in the meta record. Runs on "Check now", or weekly when that is on.

### 3.11 Lock signals
- Idle: `GetLastInputInfo`, polled every 15 s.
- Windows lock: `WTSRegisterSessionNotification`, `WTS_SESSION_LOCK`.
- Sleep: `RegisterSuspendResumeNotification` (needed on Modern Standby PCs, where a desktop app gets suspend messages only after it opts in); lock on `PBT_APMSUSPEND`; also lock when `GUID_CONSOLE_DISPLAY_STATE` reports the display off while "lock on sleep" is on. Drop keys first (the budget is about 2 s).
- Sign-out and shutdown: `WM_QUERYENDSESSION` / `WM_ENDSESSION`: lock, clear the clipboard, exit.

## 4. Item model

```
Item {
  id, type, title, favorite, tags, state ("active"|"archived"|"trashed"), trashed_at?,
  created_at, updated_at, password_changed_at?,
  fields: [Field], notes, urls: [{ url, label? }], apps: [exe name],
  reprompt, autotype_sequence?, health_excluded,
  password_history: [{ id, value, changed_at }] (last 20),
  revisions: [{ rev, saved_at, snapshot }] (last 10)
}
Field { id, label, kind, value, section?, builtin?, options? }
```
Field kinds and the secret kinds are listed in `src/lib/contract.ts`.

| Type | Built-in fields | Enter in Quick Access copies |
|---|---|---|
| Login | username, password, one-time code; urls | password (one-time code if no password) |
| Password | password | password |
| Secure Note | notes (Markdown subset: headings, lists, bold, italic, code, links) | opens in Coffer |
| Credit Card | cardholder, number, expiry, CVV, PIN, brand | number |
| Identity | title, first, middle, last, birth date, email, phone, address lines, city, region, postcode, country, company | opens in Coffer |
| Bank Account | bank, holder, account number, sort code / routing, IBAN, SWIFT/BIC, PIN | account number |
| ID Document | kind (passport, driving licence, ID card, other), number, full name, issued, expires, country | number |
| SSH Key | private key, public key, fingerprint, passphrase | public key (never the private key) |
| API Credential | username, credential, host, expires | credential |
| Wi-Fi | network name, password, security | password |
| Software Licence | product, version, licence key, licensed to, email, purchase date | licence key |

- After a copy, Quick Access closes. A key with no target field shows "This item has no <field>".
- Custom fields of any kind on any item, grouped by optional section names.
- Tags nest with "/" ("Work/Clients"). Tags do the job of folders.
- Trash keeps items 30 days, then purges them at the next unlock. Archive hides an item from lists, Quick Access and health, and keeps it.
- `password_changed_at` is set when a built-in password changes. Imported items take it from the source or leave it empty. An empty date is never "Old".
- **Usage data** (last used, use count, learned app-to-item links) lives in `%LOCALAPPDATA%\Coffer\usage.json`, DPAPI-encrypted, NOT in the vault, so a copy never makes a sync write.

## 5. Generator
- **Random**: length 8 to 128 (default 20). Sets A-Z, a-z, 0-9, symbols `!@#$%^&*()-_=+[]{};:,.?/`. Minimum digits and symbols (0 to 9). "Avoid look-alike characters" (`0O1lI|`). Exclude list. Uniform choice by rejection sampling. Each chosen set appears at least once.
- **Passphrase**: EFF large word list (7,776 words, CC BY 3.0 US, credited in About). 3 to 20 words (default 5), separator (`-` default, space, `.`, `_`), capitalise, add a digit.
- **PIN**: 4 to 12 digits (default 6).
- Shows entropy in bits from the generator's own space and a label (weak < 40, fair < 60, good < 80, strong < 100, excellent).
- History: last 50, in the meta record, clearable. The vault must be unlocked to keep history; a password made while locked (tray menu) is not kept.

## 6. TOTP
- RFC 6238: SHA-1, SHA-256, SHA-512; 6 to 8 digits; period 30 or 60. `otpauth://totp/...` URIs and bare base32 secrets (spaces and lower case allowed). `steam://<secret>` gives 5 symbols from Steam's alphabet.
- Add by paste. Tier 2: from a QR image file or "Scan QR on screen".
- The detail view shows the code and a countdown ring. Ctrl+T copies it.

## 7. Health
| Check | Rule | In score |
|---|---|---|
| Breached | password found in Pwned Passwords (opt-in) | yes |
| Reused | the same password in 2 or more active items that are not duplicates | yes |
| Weak | zxcvbn score 0 to 2, with title, username and URL host as user inputs | yes |
| Duplicate | same username, same password and same site in two items | no |
| Unsecured site | a URL with `http://` (not localhost or a private address) | no |
| Old | password unchanged for 365 days or more (empty date never counts) | no |
| Expiring | cards 60 days ahead; passports 300 days; other documents and API credentials 90 days | no |
- **Score** = floor(100 x healthy / total). total = active login and password items with a password, not excluded. healthy = not breached, not reused, not weak. 100 means no counted finding. Shown only when total is 5 or more; else "Add 5 or more logins to see a score."
- Under the score: the formula in words ("18 of 20 passwords are not breached, reused or weak") and "Breached: not checked" or "Breached: checked <date>".
- Tabs: Breached, Reused (grouped), Weak, Other (unsecured, old, expiring, duplicate), Excluded (n) with "Include again".
- Actions per finding: "Change password" (edit mode with the generator open), "Open site" (`item_open_url`), "Use HTTPS", "Exclude from health".
- With no issue: "No weak, reused or breached passwords found." Never "You are safe."

## 8. Import and export
- **Import**: Coffer (`.cofferx`, Coffer JSON), 1Password (`.1pux`, CSV), Bitwarden (JSON, CSV), Dashlane (CSV ZIP, single CSV), Chrome / Edge / Brave CSV, Firefox CSV. Exact formats: [research/import-formats.md](research/import-formats.md). Encrypted Bitwarden JSON is tier 3: show "Export from Bitwarden as JSON (not encrypted), import it, then delete that file."
- Flow: pick file (a Rust-side dialog); Coffer detects the format; preview (counts by type, duplicates to skip, skipped items with reasons, warnings); import in ONE write; every item gets the tag `Imported/<source>`; result screen with [Undo this import] (moves that batch to Trash) and "This file holds your passwords in plain text. [Delete it] [Keep it]".
- **Export**: Coffer encrypted (`.cofferx`: own password, Argon2id + XChaCha20-Poly1305, same header rules as the vault), Bitwarden JSON (plain, so a user can leave), CSV (logins and notes, Bitwarden headers). Any export needs the master password again. A plain export shows: "This file will hold your passwords in plain text. Anyone who opens it can read them."

## 9. Desktop shell
- **Tray icon**: a coffer glyph, different for locked and unlocked. Tooltip "Coffer: locked" or "Coffer: unlocked".
  - Left click: show or hide Quick Access (or the main window, per setting).
  - Right click menu: Open Coffer, Quick Access, Copy a new password (off while locked), Lock (or Unlock...), Settings, Quit Coffer.
- **Foreground tracking**: Rust tracks the last foreground window with `SetWinEventHook(EVENT_SYSTEM_FOREGROUND)`. It ignores Coffer windows, `Shell_TrayWnd`, `NotifyIconOverflowWindow`, `TopLevelWindowForOverflowXamlIsland` and the desktop. `quick_context` returns that stored window; it never reads the foreground window itself.
- **Quick Access**: frameless popup, 400 x 560, created hidden at start. Target: 150 ms or less from hotkey to a focused search field.
  - From a tray click: bottom-right of the work area on the taskbar's monitor, 12 px in. From the hotkey: centred on the monitor of the stored foreground window.
  - Closes on Esc, after a copy, or on focus loss, except while a Hello prompt, a re-prompt or a dialog it opened is up. A tray click within 300 ms after a focus-loss hide does not reopen it.
  - Locked: password field (Caps Lock warning, show toggle, "Unlocking..." during the KDF) and the Hello button. Locked with `needsSecretKey`: "Open Coffer to finish setup".
  - Unlocked: search field focused. Before typing: "Suggested for <app>" (hidden when empty), Favourites, Recently used. Search covers title, username, URL host and tags; rank: title prefix, word prefix, substring, then recent use. Archived and trashed matches show as one row "n more in Archive or Trash".
  - Keys: Up/Down move; Enter copies (table in section 4); Ctrl+U username; Ctrl+P password; Ctrl+T one-time code; Right arrow (caret at end of text) opens the action list; Ctrl+Enter auto-type (tier 2); Ctrl+O open in Coffer; Esc clears the text, a second Esc closes.
  - First 3 opens show a hint line: "Enter copies the password · Ctrl+U username · → more".
- **Main window**: three panes (sidebar, list, detail), minimum 900 x 600. Close hides it to the tray; the first time, a notice says "Coffer is still running in the tray. Drag its icon from ^ to the taskbar to keep it in view." Setting "Close button: hide to tray / quit".
- **Global hotkeys** (changeable in Settings > Shortcuts): Quick Access `Ctrl+Shift+Space` (on). Lock `Ctrl+Shift+L` (off by default: Windows lock already locks Coffer). If `RegisterHotKey` fails, Settings shows "In use by another app".
- **Start with Windows**: asked at setup (default on), starts hidden in the tray. **One instance**: a second launch shows the running one.
- **Auto-lock**: after N minutes of system idle (`GetLastInputInfo`; 1, 2, 5, 10 default, 15, 30, 60, never), on Windows lock (default on), on sleep (default on). Lock waits for a write in progress, then drops keys.
- **Lock or quit during an edit**: lock discards an unsaved edit; after unlock: "Unsaved changes to <title> were lost when Coffer locked. Generated passwords are in Generator history." Quit with an unsaved edit asks Save / Discard / Cancel. Quit and Windows sign-out lock, clear the clipboard if it holds Coffer's copy, then exit.
- **Screen capture**: `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` on all Coffer windows while the setting is on (default on). UI wording: "Hidden from most screenshots and screen sharing."
- **Main-window keys**: Ctrl+F search; Ctrl+N new item; Ctrl+E edit; Ctrl+S save; Esc cancel (asks "Discard changes?" when edited); Ctrl+U/P/T copy (not in edit mode); Ctrl+R reveal; Ctrl+G generator; Ctrl+L lock; Delete moves to Trash only when focus is not in a text field (Undo toast for 6 s); Ctrl+, settings; F1 shortcut list.
- **Settings storage**: device settings in `%LOCALAPPDATA%\Coffer\settings.json` (no secrets): vault path, hotkeys, auto-lock, lock on Windows lock and sleep, clipboard clear (10, 30, 60, 90, 120, 300 s, never), capture protection, start with Windows, start hidden, tray click, close behaviour, Hello, require-password days, breach-check mode. `settings_get` works in every state. Vault settings are in the meta record.

## 10. Auto-type (tier 2)
- Ctrl+Enter in Quick Access: Coffer hides Quick Access, brings back the stored foreground window, checks it is in front, waits until Ctrl, Shift, Alt and Win are released (2 s at most), then sends the sequence with `SendInput` (`KEYEVENTF_UNICODE`). Default `{USERNAME}{TAB}{PASSWORD}{ENTER}`. Tokens: `{USERNAME} {PASSWORD} {TOTP} {TAB} {ENTER} {DELAY ms} {FIELD:label}`.
- If the target is gone, not in front, or runs elevated (higher integrity level), Coffer types nothing and says why ("Coffer cannot type into an app running as administrator.").

## 11. Screens and states
1. **Welcome**: "Create a new vault" / "Open an existing vault".
2. **Create vault**: name (default "Personal"); master password with strength meter and confirm; location (default, or choose; synced-folder note); KDF time shown. Then **Emergency Kit** (no skip): vault name, created date, computer name, file path, the Secret Key large in grouped monospace, an empty "Master password" box, and "If you lose this kit and this computer, nobody can open this vault, not even Coffer." [Save as PDF] (print with a print stylesheet; the screen says "Keep the kit off the cloud folder that holds your vault: together they leave only your password between an attacker and your data.") and a confirm step: type the last 4 symbols of the Secret Key. Then preferences (start with Windows, hotkey). Last: "Press Ctrl+Shift+Space now" (detected live).
3. **Open existing vault** (new PC): pick file, enter master password and Secret Key. Help under the field: "No kit? On a computer where this vault opens: Settings > Security > Show Secret Key."
4. **Unlock** (main window and Quick Access). After 3 failures: "Coffer cannot reset a master password. Check Caps Lock and your keyboard layout."
5. **Missing vault** and **tampered vault** screens (section 3.4).
6. **Quick Access** popup.
7. **Main window**: sidebar (All items, Favourites, each item type with a count, Tags, Health, Archive, Trash; footer: Generator, Import, Settings, Lock), list (search, sort by title / updated / last used, type filter, bulk select: tag, archive, trash), detail (view; edit inline; tabs or sections for password history and, tier 2, revisions).
8. **Generator** panel (main window and a compact form in Quick Access).
9. **Health** dashboard.
10. **Import** wizard; **Export** dialog; **Backups** list.
11. **Settings**: General, Security (auto-lock, clipboard, capture, Hello, Show Secret Key, Change master password), Vault (location, backups, import, export), Shortcuts, About (version, licences, EFF word list credit, "how Coffer protects your data").
12. **Empty states**: no items ("Your vault is empty" [New item] [Import]); no search result ("No items match '<q>'" [Create login "<q>"]); no health issues (section 7); no suggestion (section hidden); empty trash; empty archive.

## 12. Architecture
- **Tauri 2** desktop app. Rust backend; React + TypeScript UI in WebView2; Vite; pnpm.
- `crates/coffer-core`: pure Rust, no Tauri or Windows dependency: crypto, Secret Key, vault file, records, items, generator, TOTP, health, search ranking, suggestion matching, importers, exporters, backups policy. All unit tests live here.
- `src-tauri`: the app. Commands implementing `src/lib/contract.ts`, tray, windows, hotkeys, autostart, single instance, settings and usage files, and Windows-only code (DPAPI, Hello, clipboard, idle, session and power events, foreground tracking, capture affinity, SendInput, HIBP HTTP call) behind `cfg(windows)`.
- `src/`: one Vite build with two pages: `index.html` (window label `main`) and `quick.html` (window label `quick`).
- **Demo backend**: in a plain browser (no Tauri), `src/lib/ipc.ts` uses an in-memory demo backend that follows the contract. Every screen then shows a "DEMO DATA" badge. The UI is built and screenshot-tested this way, without a Rust build.
- **Build**: `[profile.dev.package.argon2] opt-level = 3` (a debug Argon2 at 128 MiB takes tens of seconds). One shared Cargo target dir for all worktrees (disk is tight).
- The installer is unsigned: Windows SmartScreen warns on first run. The README says so.

## 13. Design
- Theme: "Red Dark" by kartman.sms on 21st.dev (Sam's choice), dark-mode tokens, bundled. Fonts: chosen with the Fontshare tool (Sam's ask), bundled; ITF-licensed files are fetched by a script into a git-ignored folder (never committed, since the repo may become public).
- Process: Sam's design skills (impeccable, taste, ui-ux-pro-max, frontend-design) and at least two critique-and-fix rounds by a reviewer who did not build it.

## 14. Roadmap
| Stage | Delivers | Runs with |
|---|---|---|
| M0 | Research, spec v1, two reviews, spec v2, second review | - |
| M1 | Design system and every screen in the React UI on the demo backend | M2, M3 |
| M2 | `coffer-core`: crypto, Secret Key, vault file, backups, items, generator, TOTP, health, search, import, export, with tests | M1, M3 |
| M3 | App shell: tray, Quick Access window, main window, lock and unlock, auto-lock, hotkeys, clipboard, autostart, settings, commands wired to the core | M1, M2 |
| M4 | Integration: UI on the real backend, Emergency Kit, health, import and export end to end | - |
| M5 | Design review round 1 and fixes; QA round 1 and fixes | - |
| M6 | Design review round 2 and fixes; installer, icons, README, screenshots | - |
| M7 | Tier 2 in order: Hello, auto-type, revisions UI, SSH keys, QR | - |
| M8 | Final QA, PR | - |

## 15. Done means
- `cargo test --workspace` passes, including known-answer tests (RFC 6238 appendix B, RFC 5869 HKDF, an Argon2id RFC 9106 vector, an XChaCha20-Poly1305 vector), vault round trip, wrong password, wrong Secret Key, Secret Key typo, each tamper case (changed, deleted, added and rolled-back record; lowered and raised KDF), and each importer on a fixture.
- A test proves the vault file holds no plaintext: create a vault with a known password value, then search the file bytes for it.
- `pnpm test` and `pnpm build` pass. `pnpm tauri build` makes an NSIS installer.
- The installed app shows a tray icon. Ctrl+Shift+Space and a tray click open Quick Access. Create vault, add a login, lock, unlock, copy the password: the clipboard clears after 90 s.
- Every screen passes a scripted check in the browser demo (no console errors, no horizontal overflow, focus visible) and two design reviews.
