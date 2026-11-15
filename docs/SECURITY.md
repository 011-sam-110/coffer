# Coffer security design

This document tells a technical reader how Coffer protects a vault. It describes the code in `crates/coffer-core` (the vault core) and `src-tauri` (the Windows shell). The product spec is [SPEC.md](SPEC.md), section 3.

Coffer is a local-first password manager. It keeps the vault in one encrypted file. It has no server and no account.

## 1. Threat model

| The attacker has | What Coffer does |
|---|---|
| A copy of the vault file (a cloud folder, a backup, a lost USB drive) | Every item stays encrypted. The file does not hold the Secret Key, so the file and a guessed weak password are not enough. |
| The vault file and the Secret Key (for example, a stolen Emergency Kit) | Each password guess runs Argon2id with 128 MiB of memory. A strong master password holds against guessing. |
| Write access to the vault file | Coffer detects a changed, deleted, added or older record and refuses to open the file. A changed KDF header makes the unwrap fail. |
| An old copy of the file and the old secrets, after the user changed them | A password change with the re-key option, or a Secret Key rotation, makes a new vault key. Old secrets then do not open new copies. |
| Code that runs as the same Windows user while Coffer is locked | Partial protection only. Such code can read the Secret Key that DPAPI protects. It can also record keystrokes. With Windows Hello on, it can open the vault. With a PIN set, it can try every PIN offline (section 8). |
| Code that runs as the same Windows user while Coffer is unlocked | Out of scope. Such code can read the memory of the Coffer process. |
| Script injected into the UI (for example, from imported data) | The UI cannot load remote code, cannot navigate away, and can call only the commands of its window. It cannot open a file or a URL of its choice. |
| A program on this PC that asks Coffer for passwords through the browser bridge | It must first be connected: Coffer shows a Connect prompt with four words and stores a key only after the user clicks Allow. Every later call needs a MAC with that key (section 12). |
| Control of the network path, or of a GitHub release (a changed latest.json or installer) | Coffer installs only an installer whose minisign signature checks against the public key built into Coffer, and whose signed comment names the version that latest.json announces. A wrong or missing signature is refused and logged (section 10). |
| A view of the screen, a screen capture, or clipboard history | Secret fields are masked by default. Windows are excluded from most screen capture (a setting, on by default). Copied values stay out of clipboard history and are cleared. |

A whole-file rollback (an older but valid vault file put back in place) is detected only on a PC that saw the newer file. Section 3 tells how.

## 2. Keys and key derivation

### Master password

- Coffer normalises the password with Unicode NFKD. Then it removes leading and trailing white space.
- Vault creation and a password change refuse a password with a zxcvbn score below 3. The vault name is a zxcvbn user input.

### Secret Key

- The Secret Key is 16 random bytes (128 bits) from the operating system's random number generator (`getrandom`).
- Coffer makes one Secret Key for each vault. A rotation makes a new one.
- The text form is `C1-AAAAAA-XXXXXX-XXXXXX-XXXXX-XXXXX-XXXXK`. The alphabet is `23456789ABCDEFGHJKLMNPQRSTVWXYZ` (31 symbols).
- `AAAAAA` is the key id. It is 6 random symbols. It is not secret and it is not derived from the key. The vault header stores it.
- The 26 secret symbols are one big-endian base-31 number. Decoding refuses a value of 2^128 or more.
- The last symbol is a check symbol. It catches every single-symbol error. It catches every swap of two symbols, except the swaps of positions 1 and 31 and of positions 2 and 32.
- The shell stores the Secret Key in `%LOCALAPPDATA%\Coffer\device.json`. It seals the key with `CryptProtectData` for the current user, with `CRYPTPROTECT_UI_FORBIDDEN`. The DPAPI entropy is `coffer/v1/device-sk` followed by the 16 bytes of the vault id.

### Derivation

```
pw_key   = Argon2id(password, salt = kdf.salt (16 bytes), m = kdf.m_kib, t = kdf.t, p = kdf.p, length 32)
sk_key   = HKDF-SHA256(ikm = Secret Key (16 bytes), salt = vault id (16 bytes), info = "coffer/v1/secret-key", length 32)
kek      = HKDF-SHA256(ikm = pw_key || sk_key, salt = kdf.salt, info = "coffer/v1/kek", length 32)
VK       = 32 random bytes (the vault key)
wrapped  = XChaCha20-Poly1305(key = kek, nonce = 24 random bytes, aad = header AAD, plaintext = VK)
item_key = HKDF-SHA256(ikm = VK, salt = vault id, info = "coffer/v1/records", length 32)
mac_key  = HKDF-SHA256(ikm = VK, salt = vault id, info = "coffer/v1/manifest", length 32)
blob_key = HKDF-SHA256(ikm = VK, salt = vault id, info = "coffer/v1/attachments", length 32)
```

- The default KDF settings are m = 131072 KiB (128 MiB), t = 3, p = 4. The shell uses them for every new vault. The `argon2` crate computes the lanes in parallel (its `parallel` feature).
- The floor is m = 65536 KiB, t = 2, p = 1. Coffer refuses to open a file with lower settings.
- The ceiling is m = 1048576 KiB, t = 10, p = 16. Coffer checks the ceiling before Argon2 runs. This limits how long a crafted header can make Argon2 run.
- The salt is 16 random bytes. A password change makes a new salt.
- Every encryption uses a new 24-byte nonce from `getrandom`.
- A Secret Key with another key id fails with `badSecretKey`. A wrong password fails the unwrap with `badCredentials`.

### Password change and key rotation

- A password change makes a new salt and a new wrap of the vault key.
- With the re-key option ("My old password may be known"), it also makes a new vault key and encrypts every record again.
- A Secret Key rotation always makes a new vault key, encrypts every record again and makes a new Emergency Kit.
- After a re-key, the shell deletes the backups that it made under the old vault key.

## 3. The vault file and what it detects

The vault is one UTF-8 JSON file (`<vault name>.coffer`). Binary values are standard base64. The file holds a header, the records and a manifest MAC.

### Records

- Each item is one record. One more record (`meta`) holds the creation time, the generator history, the last generator options and the breach-check cache.
- A record is XChaCha20-Poly1305 with `item_key`. Its AAD binds the vault id, the record id, the kind and the revision number.
- Coffer pads the record plaintext with spaces to a multiple of 256 bytes. This hides the exact length of an item.

### Manifest MAC

- `manifest_mac` is HMAC-SHA256 with `mac_key`.
- Its input is the vault id, the generation and the record count.
- Then, for each record in id order, the input has the id, the kind, the revision and SHA-256 of the nonce and ciphertext.
- Coffer checks the MAC right after the unwrap, before it uses any record.

### What Coffer detects

| Change to the file | Result |
|---|---|
| A record changed, deleted or added | The MAC fails: `tampered`. |
| A record replaced by an older version of the same record | The MAC fails: `tampered`. |
| A changed revision number or generation | The MAC fails: `tampered`. |
| Two records swapped | The MAC or the record AAD fails: `tampered`. |
| KDF settings outside the floor or ceiling | Refused before Argon2 runs: `kdfTooWeak` or `kdfTooStrong`. |
| KDF settings, salt or key id changed inside the limits | The header AAD binds them, so the unwrap fails: `badCredentials`. |
| Unknown fields, duplicate keys, a wrong format or version, a repeated record id | The parser refuses the file. |

### Generation and whole-file rollback

- Every save adds 1 to the generation. The MAC covers the generation.
- The shell keeps, in `device.json`, the highest generation that this PC saw for each vault.
- A file with a lower generation opens only after the user confirms it. While a vault is open, an older file on disk blocks saves.
- A PC that never saw the newer file cannot detect a rollback. The older file is valid in every other way.

### What the file shows without the keys

The file shows the vault id, the key id, the generation, the KDF settings and salt, and the record count. For each record, it shows the id, the kind, the revision and the ciphertext length (the padded plaintext plus a 16-byte tag). The vault name is the file name and shows on the lock screen. It is not secret.

### Changes on disk while a vault is open

- Before Coffer replaces the file, it compares the MAC of the file on disk with the MAC of the file it loaded or wrote. A different MAC stops the write.
- When the disk file changed and the open vault has changes that are not on disk, Coffer writes the open state to a conflict file. Then it loads the disk file.
- After a password change that is not saved yet, Coffer compares the disk file with the header and keys of the file it loaded.

### Exports

- A `.cofferx` export uses its own export password with Argon2id and the vault's KDF settings. It does not use the Secret Key.
- The export password must have a zxcvbn score of 3 or more.
- The AAD of a `.cofferx` binds the export id, the KDF settings and the salt. The plaintext is padded to a multiple of 256 bytes.
- Coffer JSON, Bitwarden JSON and CSV exports are plain text. They hold every password.

## 4. Re-prompt

Re-prompt asks for the master password again before Coffer reveals or copies a secret of a marked item. The core enforces it. The UI does not decide.

- For an item with re-prompt on, these calls need the master password or a grant:
  - reveal a value
  - copy a secret field or a password history entry
  - get a TOTP code
  - list the password history
  - list the revisions
- Coffer checks the password with Argon2id: it derives the KEK again, unwraps the vault key and compares it with the open vault key.
- A correct password starts a grant for that item. The grant ends after 60 seconds or on lock.
- A save or a revision restore that turns re-prompt off, or changes the kind of a secret field, needs the password or a grant.
- A backup restore needs the password when the backup would weaken re-prompt on an item that has it now.

## 5. The UI boundary

The UI is a WebView. Rust keeps the secrets and sends the UI only the data below.

### What crosses to the UI

- The item list (`ItemSummary`) holds no secret field. The subtitle comes from fields that are not secret. The one exception is the last 4 digits of a card number.
- An item (`ItemView`) shows every secret field masked, with an empty value.
- `item_reveal` returns one value. `item_copy` puts the value on the clipboard in Rust and returns only the clear time.
- Password history and generator history reach the UI masked. Each entry has its own reveal and copy.
- The revision list shows only the revision number, the save time and the title.
- In a save, a secret field with no value keeps the stored value. An edit that does not touch a password never needs it in the UI.
- The health report holds item ids and plain-language details. It holds no values and no hashes. Items that share a password get a group id, which is the id of one of those items.

### WebView hardening

- The content security policy is `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src ipc: http://ipc.localhost; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'`.
- `withGlobalTauri` is off. `freezePrototype` is on.
- Each window has its own capability file. The Quick Access window can call 19 commands. It cannot reveal a value, save an item, import or export.
- Navigation is allowed only to the app origin. New windows are denied. Permission requests (camera, microphone, location and others) are denied.
- WebView2 autofill and password autosave are off. Browser accelerator keys and the default context menu are off. Release builds have no developer tools.
- "Open site" sends an item id and a URL index. Rust opens only an `http://` or `https://` URL stored in that item.
- Import, export, open and move use file and folder dialogs that Rust opens. These commands take no file path from the UI.
- With the screen-capture setting on (the default), the windows use `WDA_EXCLUDEFROMCAPTURE`.

## 6. Clipboard

- A copy writes the value as `CF_UNICODETEXT` in one clipboard transaction.
- The same transaction writes three registered formats:
  - `ExcludeClipboardContentFromMonitorProcessing`
  - `CanIncludeInClipboardHistory` with the value 0
  - `CanUploadToCloudClipboard` with the value 0
- These formats keep the value out of Windows clipboard history and cloud clipboard.
- Coffer records the clipboard sequence number after the copy.
- Coffer clears the clipboard after the set time (90 seconds by default), on every lock and on exit. Sign-out and shutdown lock Coffer.
- Coffer clears the clipboard only if it still holds Coffer's copy (the sequence number did not change).

Limits:

- Remote Desktop clipboard sharing can copy the value to the other computer.
- A third-party clipboard tool can ignore the three formats and keep the value.
- Any program can read the clipboard while it holds the value.

## 7. Windows Hello

Windows Hello unlock is tier 2. It is off by default.

- To turn it on, the user types the master password. Windows Hello must also be set up in Windows.
- When Coffer locks with Hello on, the shell keeps the vault key in memory. It encrypts the key with `CryptProtectMemory` and `CRYPTPROTECTMEMORY_SAME_PROCESS`.
- To unlock, the shell asks Windows for user verification for Coffer's own window. Only the result `Verified` unlocks.
- The shell then opens the file with `unlock_with_vault_key`. This call does not run Argon2. It checks the key id, the KDF limits and the manifest MAC.

The master password is necessary again in these cases:

- after Coffer restarts (the key lives only in the process)
- after a quit lock or a `keyChanged` lock
- after the set number of days (14 by default) without a master-password unlock
- after the user turns Hello off
- after a re-key or a rotation: the MAC fails with the held key, the call returns `badCredentials`, and the shell drops the key

Hello is a convenience gate, not encryption. The Hello prompt only decides whether Coffer uses the key that it holds. A program that runs as the same Windows user can read or control the Coffer process. With Hello on, such a program can open the vault without the master password.

## 8. PIN unlock

PIN unlock is off by default. A PIN has 6 to 12 digits. It unlocks the vault on one PC, also after a restart.

- To set a PIN, the user types the master password while the vault is open.
- The shell derives a key from the PIN with Argon2id and the vault's default cost (128 MiB, 3 passes, 4 lanes) and a random 16-byte salt. It encrypts the vault key with XChaCha20-Poly1305 under that key. The associated data binds the record to the vault id and the Secret Key id.
- The record (salt, nonce, ciphertext, KDF settings, PIN length, wrong-PIN count, time of the last master-password unlock) goes into `device.json`, sealed with DPAPI for the current Windows user (entropy `coffer/v1/device-pin` and the vault id).
- To unlock, the shell derives the key from the typed PIN and opens the vault key. Then it opens the file with `unlock_with_vault_key`, as Hello does.
- The vault file does not change. Away from this PC, the file needs the master password and the Secret Key.

The master password is necessary again in these cases:

- after 5 wrong PINs in a row: the shell deletes the record
- after the set number of days (14 by default) without a master-password unlock on this PC
- after a re-key or a Secret Key rotation: the shell deletes the record
- after the user turns the PIN off

A PIN is a convenience gate, like Hello. The wrong-PIN count lives in `device.json`. A program that runs as the same Windows user can open the DPAPI seal, copy the record and try all PINs offline. Each try costs one Argon2id run, so 1,000,000 six-digit PINs take hours to days on one PC, not years. The UI says this in one sentence next to the setting.

## 9. Breach check

The breach check is off by default. The user can run it with "Check now", or turn on a weekly check after unlock.

What leaves the PC:

- Coffer computes the SHA-1 hash of each password on the PC. It sends only the first 5 hex characters (upper case) of each hash.
- It sends one HTTPS request for each distinct prefix: `GET https://api.pwnedpasswords.com/range/<prefix>`.
- Each request has the headers `Add-Padding: true` and `User-Agent: Coffer`. The client refuses plain HTTP.
- The service sees the prefixes, the number of requests, the time and the IP address of the PC.

What stays on the PC:

- The passwords, the full hashes and the matches.
- Coffer drops the padding rows (count 0) and compares the hash suffixes on the PC.
- Coffer checks active login and password items that have a password and are not excluded from health.
- Coffer stores the results in the encrypted meta record. The key of each result is the item id and the SHA-256 of the password.

## 10. Auto update

Coffer updates itself from GitHub releases (SPEC 3.12). An update runs code on the PC, so the update path is the strongest attack on Coffer that needs no access to the PC. The signature is the guard; HTTPS alone is not.

What Coffer checks:

- Coffer reads `latest.json` from the newest full release of `011-sam-110/coffer`, over HTTPS. The file names a version, the installer address and a minisign signature.
- Coffer downloads a newer version only. The updater plugin checks the installer bytes against the public key built into Coffer at build time (`plugins.updater.pubkey`). It checks them again just before the install.
- `requireSignedVersion` is on: the version is in the signed comment, and it must equal the version in `latest.json`. A changed `latest.json` cannot pair a new version number with an older signed installer.
- A failed check refuses the file. Coffer writes "update: REFUSED" to its log and shows one line in Settings. Nothing installs.
- An install starts only when the vault is locked. "Restart now" locks first.

The signing key:

- Sam makes the key pair once with `node scripts/make-update-key.mjs`. The private key stays in `%USERPROFILE%\.tauri\coffer-updater.key`, encrypted with a password that Sam types in a hidden prompt. It is never in the repo, and no agent sees it or the password.
- `release.mjs build` needs no private key. `release.mjs publish` asks for the password in a hidden prompt, signs, checks the new signature against the built-in public key, and only then creates the release.
- The scripts give the password to the Tauri CLI child process (an argument for `signer generate`, an environment variable for `signer sign`) for the second it runs. A program that runs as Sam could read it then. That attacker is out of scope (section 1).

What the signature does not cover:

- A person with the private key and its password can send any code to every Coffer. Keep both safe. If the key is lost, installed copies accept no further update: Sam then installs a build with a new key by hand.
- A person who controls the network or the release can hold back an update (Coffer then stays on its version), and can see that this PC checks GitHub.
- The installer has no Windows code signature (section 13). The minisign signature is what Coffer trusts.
- A copy with another identifier (a QA copy) and a debug build update only from a server on this PC, so a test copy cannot install over the real Coffer.

## 11. Backups

- After each save, the shell copies the encrypted vault file to `%LOCALAPPDATA%\Coffer\backups\<vault id>\<YYYYMMDDTHHMMSSZ>.coffer`.
- The shell keeps the last 20 backups and the newest backup of each day for the last 30 days. It deletes the others.
- A backup has the same protection as the vault file. It needs the master password and the Secret Key that were current when Coffer wrote it.
- After a re-key, the shell deletes the old backups, because they open with the old vault key.
- A restore while unlocked takes only a backup of the same vault and vault key. It needs the master password when it would weaken re-prompt on an item.

## 12. Browser bridge

The Coffer extension in Chrome or Edge reaches Coffer through `coffer-bridge.exe` (native messaging) and a named pipe. [BRIDGE.md](BRIDGE.md) has the protocol. The bridge answers `hello`, the Connect calls, `status`, `unlock` and `disconnect` (M3), the fill calls `list_logins`, `get_login` and `copy_totp` (M4), and the save calls `find_login`, `save_login`, `update_password` and `never_for_site` (M5, BRIDGE.md section 6).

**Who can reach Coffer.**

- Chrome starts `coffer-bridge.exe` only for the extension ID in the host manifest (`allowed_origins`). The ID is fixed by a public key in the extension's manifest. The private key was never kept, so nobody can sign another extension with that ID.
- The pipe's ACL (`D:P(A;;GA;;;<user SID>)`) lets only the current Windows user open it, and the pipe refuses remote clients. Coffer creates the first instance with `FILE_FLAG_FIRST_PIPE_INSTANCE`, so a program that took the name first makes Coffer's server fail (logged) instead of sharing it.
- The bridge connects only when the pipe's server process runs an exe from the bridge's own folder (`GetNamedPipeServerProcessId`), so a program that took the name gets no message.
- Any program of the same user can still open the pipe. That is why every call that does more than `hello` needs the Connect and a MAC.

**The Connect (pairing).** The extension and Coffer each make an X25519 key for this one Connect (WebCrypto with a key that cannot be exported; ring). Both derive a transcript hash from the two public keys and a random client id, show four words from it (about 51 bits), and derive the 32-byte bridge key with HKDF-SHA256. The user compares the words and clicks Allow. A second program that asks at the same time gets other words. A program in the middle cannot choose its keys so that both sides show the same words within the 2 minutes: Coffer makes its key after it gets the extension's, so a match needs about 2^51 tries. After Allow, Coffer sends an HMAC confirm of the transcript, so the extension knows both sides hold the same key.

- One prompt at a time; a second request gets `busy`.
- Allow is off for the first second after the prompt opens, so a click meant for another window cannot allow.
- Deny, 2 minutes, or a closed connection stores nothing on either side.
- Coffer shows its own name for the browser (Chrome, Microsoft Edge, Chromium), never text from the extension.

**Calls.** A signed call carries HMAC-SHA256 over the exact body with the bridge key. The body names a nonce that Coffer made for this connection and a number that only goes up. Coffer refuses a missing or wrong MAC (`bad_mac`), an old number or a nonce of another connection (`replay`), and an unknown client (`not_paired`), and runs nothing. Coffer signs its answers too; the extension checks the MAC, the number and the nonce. The MACs are checked in constant time (ring, WebCrypto). The log names a refused call, never a key or a body.

**Keys.** Coffer keeps each browser's key in `browsers.json`, sealed with DPAPI for the current user (entropy `coffer/v1/bridge-key` and the client id), as the PIN record is. Disconnect in Settings, Browsers deletes the record; that browser must connect again. The extension keeps its copy in `chrome.storage.local`.

**Unlock.** `unlock` only shows Coffer's own unlock window (PIN, Hello or master password). No password or PIN crosses the pipe.

**What the bridge does not protect against.** A program that runs as the same Windows user can read the extension's key from the browser profile, then call Coffer as that browser. From M4 on, such a program could then ask for logins while Coffer is unlocked. This is the same limit as the rest of section 1: code running as the user while Coffer is unlocked is out of scope.

### Fill in the browser (M4)

The threat here is the web page: a hostile site, a hacked page on a site you use, or a page that frames another site. The content script runs inside the page, so the rules below keep the page from getting a password without your pick, and keep one site from getting another site's password.

- **No fill without your pick.** A focus on a sign-in field only asks Coffer for the menu (`list_logins`: names and usernames, no password). `get_login` runs only after a pick in the menu or Ctrl+Shift+L. Nothing fills when a page loads, so a hidden form on a hacked page cannot collect a password while you do nothing.
- **A pick is a person's pick.** The content script counts a click or Enter only when the browser marks it as a real input event (`isTrusted`; a page script cannot make one), and only when the menu has been on screen for 400 ms. Where Chrome can tell (IntersectionObserver v2, `trackVisibility`), the menu must also have been fully visible for those 400 ms: not covered by another element, not faded, not moved by a transform. A page that hides the menu under a fake button, or puts a transparent layer over it, gets no fill from the click.
- **The menu is out of the page's reach.** The button, the menu and the note live in a closed shadow root: page scripts get `null` for its `shadowRoot` and cannot read the names in it or restyle it. The host element is in the top layer (a manual popover) with inline `!important` styles. A page can still see that the host element exists and how big it is, so it can tell that Coffer is installed and guess how many logins the site has. It can remove the host; then there is nothing to pick.
- **Only visible fields.** The extension fills a field only when it is visible at the moment of the fill: not `display: none`, `visibility: hidden`, `opacity: 0`, `hidden`, `aria-hidden`, smaller than 8 px, or pushed off the page. A decoy password box beside the real one gets nothing. A sign-up form (two new-password boxes) is not a sign-in form, and a search box never gets the button.
- **The page's own address, from Chrome.** The content script sends no address. The service worker reads the frame's URL from Chrome (`sender.url`), and the top page's URL from the top page's own content script, which runs in an isolated world that the page's scripts cannot change. Text in the page (a form's `action`, a title, a URL in the DOM) is never used to choose logins.
- **https only.** Fill works on `https:` pages, and on `http:` only for `localhost` and `127.0.0.1`. The extension and Coffer both check.
- **Frames.** A frame gets the button and a fill only when it is the same site as its top page (the same scheme and registered domain); Coffer checks this (`cross_site`) before it looks at the vault. A sign-in frame of your bank inside another site's page gets nothing, so that site cannot make you fill it.
- **Look-alike sites.** Matching is by the registered domain from the Public Suffix List (BRIDGE.md section 6): `g00gle.com`, `google.com.evil.test` and `evil-google.com` get none of a `google.com` login's data. Private suffixes keep sites apart (`alex.github.io` is not `bob.github.io`).
- **Coffer checks the login against the address.** `get_login` and `copy_totp` refuse a login that does not fit the page (`no_match`), so an id from another site gets nothing, also from a content script that was made to ask for it.
- **Re-prompt.** A login with "Ask for master password" fills only after the master password in Coffer's own window (the same check and the same 60 s grant as in the app). The password never goes through the browser. Cancel, 2 minutes or a lock ends the question with no fill.
- **The one-time code** goes to the clipboard with the rules of section 6 (out of clipboard history, cleared after the set time), only after a fill of that login.

Limits:

- A page's own scripts can read a field's value once Coffer fills it. That is how sign-in forms work, so a hacked page on the right site (an XSS) gets the login after you pick it.
- The password crosses from Coffer through the pipe, the bridge and Chrome to the content script in clear text inside the signed answer (a MAC, not encryption). Only the current Windows user can open the pipe (section 12). Coffer wipes its copy of the answer after it sends it; JavaScript strings in the extension cannot be wiped.
- A renderer that an attacker took over (a browser exploit) could send fill messages without a pick. Chrome still reports that renderer's real site in `sender.url`, so it gets only that site's logins.
- Another extension with access to the page can read filled values too, as it can read anything you type.

### Save in the browser (M5)

The threats are the same web pages, now trying to write into the vault or to learn what is in it: a page that saves a login you did not type, changes a password you did not change, or finds out a stored password by guessing.

- **No save without your click.** The extension writes nothing on its own. `save_login`, `update_password` and `never_for_site` run only after a real click (`isTrusted`) on the bar, and only when the bar has been on screen and visible for 400 ms (the menu's rule, section 12 above). A page cannot click into the closed shadow root, and a click on a layer over the bar does not count. The one exception is the bar's own "Unlock Coffer to save": that click is the Save, so the save runs after the unlock with no second click.
- **Only what a person typed.** The content script hands a password to the worker only when a real `input` event (typing or pasting) set the value the box has now. A value a page script puts into a box (also with an `input` event of its own) gives nothing, so a page cannot make Coffer offer to save a password it chose. A `submit` counts only within 3 s of a real key press or click; a page that changes a password box and sends nothing gives nothing.
- **Held in memory, briefly.** The service worker keeps the username and password in its own memory, for that tab only: never in `chrome.storage` (local or session), never in the page. It drops them after 2 minutes, when the tab closes, after a click in the bar, or when the next sign-in replaces them. Chrome stopping the idle service worker drops them too. The page and the bar never get the password back: the bar shows the same 12 dots for every password.
- **Coffer only compares.** `find_login` answers `none`, `same`, `changed` or `never`; it never sends a stored password. The comparison runs in constant time inside the vault, and only on the values a person typed and sent, so a page cannot use it to test guesses.
- **Only the offered action, only on the form's site.** The worker runs Save only after Coffer offered `save`, and Update only on the login id Coffer named in `find_login`, with the values it holds; an id or a password in a content script's message is never used. Each save call carries the form's address (from Chrome) and the bar's page; Coffer refuses them unless both are https (or http on localhost) and one site (`cross_site`), so the bar never shows, and nothing is saved, on another site than the form's. `update_password` also refuses a login that does not fit the page (`no_match`).
- **Frames.** Only the top page and frames of the top page's origin keep a sign-in. A sign-in form of another site inside a page (a frame of your bank inside an attacker's page) gives nothing; the bar shows in the top page only.
- **The never list** is in the vault's encrypted meta record, not in the browser, so it goes where the vault goes and a page cannot read it. Settings, Browsers lists it and takes a site off.
- **A save is a normal save.** A login from the browser goes through the same path as a save in the app: the atomic write, a backup, Health. An update keeps the old password in the login's password history and the login before the change as a revision, so a wrong Update can be undone.

Limits:

- A hacked page on the right site (an XSS) sees what you type into its form, as with any sign-in, and can choose the username box's value. The bar shows that username before you click Save.
- A page can tell that the bar is there (the host element exists), so it can learn that Coffer offered to save or update after a sign-in. It cannot read the bar.
- A password change form (current and new password differ) gives no bar yet. A frame of the same site but another origin (`accounts.` inside `www.`) keeps no sign-in.
- The password crosses to Coffer in the signed message, in clear text inside the MAC (as a fill's answer does, section 12).

## 13. Known limits

- **Third-party buffers.** The `csv` crate and the `serde_json` parser keep internal copies of plain text that Coffer cannot wipe:
  - the CSV writer buffer when Coffer writes a CSV export
  - the CSV record buffers when Coffer reads a CSV import
  - the `serde_json` trees for Bitwarden JSON, a 1PUX `export.data` and import format detection
- **Import memory.** Coffer refuses an import file over 64 MiB and a JSON document over 16 MiB before it parses them. A JSON document near 16 MiB can still use several hundred MiB of memory while Coffer parses it.
- **A running, unlocked process.** While a vault is unlocked, the Coffer process holds the decrypted items. Coffer zeroes them on lock.
  - A value that the user reveals also lives in the WebView's memory. Rust cannot wipe that copy.
  - Coffer does not lock its memory pages. Windows can write them to the page file or to a crash dump.
- **DPAPI.** An administrator who resets the Windows password of the account makes the DPAPI-sealed Secret Key unreadable. The user then needs the Emergency Kit.
- **Password change without re-key.** The vault key stays the same. A person with an old copy of the file, the old password and the Secret Key can unwrap the vault key from the old copy. That key also decrypts newer copies of the file.
- **Whole-file rollback.** A PC that never saw the newer file cannot detect an older valid file (section 3).
- **No key commitment.** The header has no commitment to the KEK. An attack on this needs the Secret Key and many unlocks of crafted files.
- **Expiry notices.** A notice shows the title of an API key on the screen. Windows keeps the notice in its notification list until the next restart. `notices.json` keeps only item ids and which notice went out.
- **Browser keys.** The extension keeps its bridge key in `chrome.storage.local`, which the browser stores in the profile folder without encryption of its own. A program that runs as the same Windows user can read it and then call Coffer as that browser (section 12).
- **Unsigned installer.** The installer has no code signature. Windows SmartScreen warns on the first run. A user cannot check the publisher of the file through Windows.

## 14. Test vectors

The tests copy each vector from the source document, not from memory.

| Primitive | Source | Test |
|---|---|---|
| HKDF-SHA256 | RFC 5869, appendix A.1, test case 1 | `crypto::tests::kat_rfc5869_test_case_1` |
| Argon2id | RFC 9106, section 5.3 | `crypto::tests::kat_rfc9106_argon2id` |
| XChaCha20-Poly1305 | draft-irtf-cfrg-xchacha-03, appendix A.3.1 | `crypto::tests::kat_xchacha20poly1305_draft_a3_1` |
| TOTP (SHA-1, SHA-256, SHA-512) | RFC 6238, appendix B, table 1 | `totp::tests::kat_rfc6238_appendix_b` |

Other security tests in `crates/coffer-core`:

- `session::tests::file_holds_no_plaintext`: the file bytes do not hold a known password or its item title.
- `session::tests::tamper_*`: a changed, deleted, added, older or swapped record, and a changed revision, generation or KDF header.
- `secret_key::tests::every_swap_except_1_31_and_2_32_is_caught`: the check symbol.
- `tests/import_memory.rs`: the peak memory of hostile ZIP, JSON and CSV imports.

Run them with `cargo test -p coffer-core`.
