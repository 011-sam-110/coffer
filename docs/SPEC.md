# Coffer: product and technical spec

Status: **v2**, 2026-10-16. v1 had two independent reviews (security, product); v2 takes in the product review in full. The security review changes are in section 3 (marked "v2 security"). Research: [research/findings.md](research/findings.md), [research/import-formats.md](research/import-formats.md). The IPC contract is code: [`src/lib/contract.ts`](../src/lib/contract.ts).

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
| Windows Hello in-session unlock | 1Password, Bitwarden | 2 |
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

### 3.1 Threat model
| Attacker has | Coffer must |
|---|---|
| A copy of the vault file (cloud folder, backup, stolen USB) | Keep every item secret. The file alone is not enough even with a weak password, because the Secret Key is not in it. |
| The vault file and the Secret Key (Emergency Kit stolen) | Hold against guessing for a strong password: Argon2id with high memory cost. |
| The ability to change the vault file | Detect a changed, deleted, added or rolled-back record and a changed KDF header, and refuse to open. A whole-file rollback to an older valid copy cannot be detected: the docs say so. |
| Code running as the same Windows user while Coffer is locked | Best effort only. Such code can read the DPAPI-protected Secret Key and log keys. The docs say so; the UI claims no more. |
| Code running as the same user while Coffer is unlocked | Out of scope. No password manager can stop it. |
| Shoulder-surfing, screen sharing, clipboard history | Mask by default; hide windows from most screen capture (setting, on by default); keep copies out of Windows clipboard history and cloud clipboard; clear the clipboard. |

### 3.2 Secrets and keys
- **Master password**: normalise with Unicode NFKD and trim leading and trailing white space before use. Create and change refuse a zxcvbn score below 3 (zxcvbn gets the vault name as a user input).
- **Secret Key**: 16 random bytes from the OS CSPRNG, once per vault. Text form `C1-AAAAAA-XXXXX-XXXXX-XXXXX-XXXXX-XXXXXX` with alphabet `23456789ABCDEFGHJKLMNPQRSTVWXYZ` (31 symbols, no 0 1 I O U): `C1` is the format version; `AAAAAA` is the **key id**, 6 random symbols that are NOT part of the secret; then 26 secret symbols (31^26 > 2^128) and 1 check symbol. The check symbol is `sum(value_i * (i+1)) mod 31` over the 32 symbols of id and secret, so a typo is caught before the KDF runs.
- The vault header stores only the key id. The device stores the Secret Key in `%LOCALAPPDATA%\Coffer\device.json`, DPAPI-encrypted (`CryptProtectData`, current user, with the vault id as optional entropy), keyed by vault id.
- Settings > Security > "Show Secret Key" (needs the master password) shows it and opens the Emergency Kit again.

### 3.3 Key derivation and wrapping
```
pw_key   = Argon2id(password, salt = kdf.salt (16 B), m = kdf.m_kib, t = kdf.t, p = kdf.p, len = 32)
sk_key   = HKDF-SHA256(ikm = secret_key (16 B), salt = vault_id (16 B), info = "coffer/v1/secret-key", len = 32)
kek      = HKDF-SHA256(ikm = pw_key || sk_key, salt = kdf.salt, info = "coffer/v1/kek", len = 32)
VK       = 32 random bytes per vault (the vault key)
wrapped  = XChaCha20-Poly1305(key = kek, nonce = 24 random bytes, aad = header_aad, plaintext = VK)
item_key = HKDF-SHA256(ikm = VK, salt = vault_id, info = "coffer/v1/records")
mac_key  = HKDF-SHA256(ikm = VK, salt = vault_id, info = "coffer/v1/manifest")
```
- **Default KDF**: Argon2id, m = 131072 KiB (128 MiB), t = 3, p = 4. Vault creation measures the time on this PC and shows it.
- **Floor** (refuse to open below): m < 65536 KiB, t < 2, p < 1. **Ceiling** (refuse above, so a crafted header cannot freeze the app): m > 1048576 KiB, t > 10, p > 16.
- **header_aad** = UTF-8 `coffer-vault/1` then vault_id bytes, then `alg`, `m_kib`, `t`, `p` as 4-byte big-endian numbers, then the salt, then the key id. A change to any of them breaks the unwrap.
- Wrong password and wrong Secret Key give one error code (`badCredentials`). When the Secret Key came from this device, the UI says "Wrong master password." When the user typed it, the UI says "The master password or the Secret Key is wrong."
- **Change master password**: new salt, same or new KDF settings, new wrap of VK. Items are not re-encrypted. The dialog says "Backups and old copies of the vault still open with the old password."
- **Rotate Secret Key**: same, with a new Secret Key and a new Emergency Kit (tier 2).
- Tests use a test-only KDF profile under the floor, allowed only by `#[cfg(test)]` code.

### 3.4 Vault file format (`.coffer`)
One UTF-8 JSON file. Binary values are base64 (standard, padded).
```json
{
  "format": "coffer-vault",
  "version": 1,
  "vault_id": "uuid",
  "key_id": "AAAAAA",
  "kdf": { "alg": "argon2id", "m_kib": 131072, "t": 3, "p": 4, "salt": "b64" },
  "wrapped_vault_key": { "nonce": "b64", "ct": "b64" },
  "records": [ { "id": "uuid", "kind": "item|meta", "rev": 7, "nonce": "b64", "ct": "b64" } ],
  "manifest_mac": "b64"
}
```
- Each record: `ct = XChaCha20-Poly1305(item_key, nonce, aad = "coffer/v1/record" || vault_id || id || kind || rev(8-byte BE), plaintext = JSON)`.
- `manifest_mac = HMAC-SHA256(mac_key, header_aad || for each record sorted by id: id || kind || rev || SHA-256(nonce || ct))`. Checked on open, before any record is used. A mismatch stops the open: "This vault file was changed outside Coffer. [Open the newest backup] [Choose a backup]".
- The `meta` record holds vault-level data that must be secret: vault name, generator history, health exclusions, the breach-check cache, tag colours, trash purge log.
- Item revisions (last 10 snapshots) are inside the item's own record.
- **Atomic write**: write `<file>.tmp` in the same folder, flush to disk, then replace (`MoveFileExW` with `MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH`). Retry the replace up to 10 times over 2 s when a sync tool holds the file. Then delete stale `.tmp` files.
- **Backups**: after each save, copy the file to `%LOCALAPPDATA%\Coffer\backups\<vault_id>\<UTC time>.coffer`. Keep the last 20 saves and one per day for 30 days. Backups are as encrypted as the vault. Settings > Vault lists them with [Restore] (restore = make the current file a backup, then copy the chosen one in).
- **Default location**: `%USERPROFILE%\Coffer\<vault name>.coffer` (not Documents, which OneDrive Known Folder Move often syncs). If the chosen folder is under `%OneDrive%`, `%OneDriveCommercial%`, a Dropbox or a Google Drive folder, the create screen says: "This folder syncs to the cloud. The file is encrypted and useless without your Secret Key, but every copy that sync keeps can be attacked offline with it."
- **External change** (Coffer saves at once, so the rule works on revs): Coffer keeps the (id, rev) list of what it last loaded or wrote. On a change on disk that passes the MAC, Coffer reloads if every record it wrote since then is in the new file at the same or a higher rev. If not, Coffer writes its own state to `<name> (conflict <date>).coffer`, loads the disk file, and shows: "This vault changed on another computer. Your changes since <time> are in <file>." An open edit whose base rev is stale shows "This item changed on disk. [Keep mine] [Keep theirs]".
- **Missing file**: at start, `vault_status.state = "missing"`: "Coffer cannot find your vault at <path>. [Find vault file] [Restore from backup] [Create a new vault]". If the file goes while unlocked: "The vault file is gone from <path>. Your items are still open. [Save it here again] [Save as...]". Coffer never re-creates the file without asking.

### 3.5 Memory and the UI boundary
- Rust holds VK, the derived keys and the decrypted items in `zeroize`-on-drop types. Lock drops them all.
- The UI gets `ItemSummary` (no secrets) and `ItemView` (secret fields masked). `item_reveal` returns one value. `item_copy` and `autotype` never send the value to the UI.
- In an `ItemInput`, a secret field with `value: null` keeps the stored value. So an edit that does not touch the password never needs it in the UI.
- **Re-prompt**: for an item with `reprompt = true`, Rust refuses `item_reveal`, `item_copy` of a secret field, `item_password_history` and `autotype` unless the call carries the correct master password. Rust checks it with a fresh KDF run (a constant-time compare of the unwrap result); a correct check is remembered for that item for 60 s.
- The UI clears its item store on `vault://locked`.
- **WebView hardening**: CSP `default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src ipc: http://ipc.localhost`; no remote URLs in any window; Tauri capabilities allow only Coffer's commands plus the dialog plugin's open and save; WebView2 `AreBrowserAcceleratorKeysEnabled = false` (Ctrl+P, Ctrl+R, F5 and the find bar do nothing); right-click shows no browser menu.

### 3.6 Windows Hello (tier 2)
- In-session quick unlock (Bitwarden's first path): with Hello on, when Coffer locks it keeps VK encrypted with `CryptProtectMemory` (same process) in memory. Unlock asks `UserConsentVerifier` through `IUserConsentVerifierInterop::RequestVerificationForWindowAsync` with Coffer's window handle, so the prompt is in front. A pass decrypts VK.
- The master password is still needed after an app restart, Windows sign-out, and after "Require master password every" N days (default 14). Then the UI hides the Hello button and says "Windows Hello works after one master-password unlock."
- When `helloReady` is true, the unlock screen starts Hello at once. Cancel falls back to the password field.

### 3.7 Clipboard
- Copy writes `CF_UNICODETEXT` plus the registered formats `ExcludeClipboardContentFromMonitorProcessing`, `CanIncludeInClipboardHistory` (DWORD 0) and `CanUploadToCloudClipboard` (DWORD 0). UI wording: "Not kept in Windows clipboard history" (third-party clipboard tools can ignore the flag).
- Clear after the set time (default 90 s) only if `GetClipboardSequenceNumber` still matches the value after our write.
- Lock, quit and Windows sign-out clear the clipboard if it still holds Coffer's copy.
- The generator's Copy and the tray's "Copy a new password" use the same path.

### 3.8 Breach check (opt-in)
- Coffer sends the first 5 characters of each password's SHA-1 hash, never the password: `GET https://api.pwnedpasswords.com/range/<prefix>` with `Add-Padding: true`, then compares the suffixes locally. The result is cached per item revision in the meta record. Runs on "Check now", or weekly when that is on.

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
- Actions per finding: "Change password" (edit mode with the generator open), "Open site", "Use HTTPS", "Exclude from health".
- With no issue: "No weak, reused or breached passwords found." Never "You are safe."

## 8. Import and export
- **Import**: Coffer (`.cofferx`, Coffer JSON), 1Password (`.1pux`, CSV), Bitwarden (JSON, CSV), Dashlane (CSV ZIP, single CSV), Chrome / Edge / Brave CSV, Firefox CSV. Exact formats: [research/import-formats.md](research/import-formats.md). Encrypted Bitwarden JSON is tier 3: show "Export from Bitwarden as JSON (not encrypted), import it, then delete that file."
- Flow: pick file; Coffer detects the format; preview (counts by type, duplicates to skip, skipped items with reasons, warnings); import in ONE write; every item gets the tag `Imported/<source>`; result screen with [Undo this import] (moves that batch to Trash) and "This file holds your passwords in plain text. [Delete it] [Keep it]".
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
2. **Create vault**: name (default "Personal"); master password with strength meter and confirm; location (default, or choose; synced-folder note); KDF time shown. Then **Emergency Kit** (no skip): vault name, created date, computer name, file path, the Secret Key large in grouped monospace, an empty "Master password" box, and "If you lose this kit and this computer, nobody can open this vault, not even Coffer." [Save as PDF] (print with a print stylesheet) and a confirm step: type the last 4 symbols of the Secret Key. Then preferences (start with Windows, hotkey). Last: "Press Ctrl+Shift+Space now" (detected live).
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
