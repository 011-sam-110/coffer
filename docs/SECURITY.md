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
| Code that runs as the same Windows user while Coffer is locked | Partial protection only. Such code can read the Secret Key that DPAPI protects. It can also record keystrokes. With Windows Hello on, it can open the vault. |
| Code that runs as the same Windows user while Coffer is unlocked | Out of scope. Such code can read the memory of the Coffer process. |
| Script injected into the UI (for example, from imported data) | The UI cannot load remote code, cannot navigate away, and can call only the commands of its window. It cannot open a file or a URL of its choice. |
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

## 8. Breach check

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

## 9. Backups

- After each save, the shell copies the encrypted vault file to `%LOCALAPPDATA%\Coffer\backups\<vault id>\<YYYYMMDDTHHMMSSZ>.coffer`.
- The shell keeps the last 20 backups and the newest backup of each day for the last 30 days. It deletes the others.
- A backup has the same protection as the vault file. It needs the master password and the Secret Key that were current when Coffer wrote it.
- After a re-key, the shell deletes the old backups, because they open with the old vault key.
- A restore while unlocked takes only a backup of the same vault and vault key. It needs the master password when it would weaken re-prompt on an item.

## 10. Known limits

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
- **Unsigned installer.** The installer has no code signature. Windows SmartScreen warns on the first run. A user cannot check the publisher of the file through Windows.

## 11. Test vectors

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
