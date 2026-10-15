# What 1Password, Bitwarden and Dashlane do, and what Coffer takes

Three research agents read the official docs, the security white papers, the open-source Bitwarden code and reviews on 2026-10-16. This page keeps the facts that shaped the spec. Each fact has its source. The full exact formats are in [import-formats.md](import-formats.md).

## Why a local tray app has room

- Dashlane ended its Windows and Mac desktop apps on 10 January 2022 and moved to a browser extension and web app. Reviewers still list "no native Windows app" as a con. https://www.dashlane.com/blog/dashlane-web-first , https://adblock-tester.com/ad-blockers/dashlane/
- Dashlane ended its free plan on 16 September 2025. https://www.techradar.com/pro/security/dashlane-password-manager-to-remove-free-plan-in-september-what-we-know-and-what-to-do-next
- 1Password raised renewals from 27 March 2026 (Individual $35.88 to $47.88) and has no local-only vault for most users. https://tidbits.com/2026/02/25/should-1passwords-price-hike-push-you-to-apples-passwords/ , https://www.iphoneincanada.ca/news/1password-local-vault/
- 1Password 8 and Bitwarden desktop are Electron apps. Users report high memory and slow start (one report of ~700 MB, one of a 45 s unlock). These are single reports, not benchmarks. https://community.bitwarden.com/t/excessive-memory-usage-bitwarden-1-31-3-2320-on-macos-12-3/39641

## Security models

| | 1Password | Bitwarden | Dashlane |
|---|---|---|---|
| KDF | PBKDF2-HMAC-SHA256, 650,000 rounds | PBKDF2-SHA256 600,000 (default) or Argon2id 32 MiB, 6 iterations, 4 lanes | Argon2d, 3 iterations, 32 MB, 2 threads |
| Second secret | Secret Key (device-made, 31-symbol alphabet), combined by HKDF + XOR | none | device key (40 bytes) for device auth |
| Cipher | AES-256-GCM | AES-256-CBC + HMAC-SHA256 | AES-256-CBC + HMAC |
| Key hierarchy | AUK unwraps private key, vault keys, item keys | master key, HKDF stretch to 512 bits, random user key wraps the vault | not published |
| Recovery | Emergency Kit PDF (sign-in address, email, Secret Key, blank for password, setup QR) | emergency access (view or takeover after a wait) | recovery key (28 characters) |

Sources: https://agilebits.github.io/security-design/deepKeys.html , https://support.1password.com/emergency-kit/ , https://bitwarden.com/help/kdf-algorithms/ , https://bitwarden.com/help/bitwarden-security-white-paper/ , https://www.dashlane.com/security

Also learned:
- 1Password normalises the password (trim ends, NFKD) before the KDF. https://agilebits.github.io/security-design/deepKeys.html
- Bitwarden rejects KDF settings below a floor, to stop a downgrade attack. `kdf-config.ts` in bitwarden/clients.
- Bitwarden Windows Hello: after the first unlock the key stays in DPAPI-protected memory, and Hello (UserConsentVerifier) releases it. A second path signs a fixed challenge with a Hello key (KeyCredentialManager) and derives a key from the signature to survive a restart. `apps/desktop/desktop_native/biometric/src/windows.rs`

## Lock and unlock

- 1Password Windows options: "Unlock using Windows Hello", "Require account password" (interval), "Lock when device locks or sleeps", "Lock after the device is idle for". Global lock Ctrl+Shift+L. https://support.1password.com/unlock-auto-lock/ , https://support.1password.com/keyboard-shortcuts/
- Bitwarden timeouts: time passed, on system idle, on system sleep, on system lock, on restart, never, custom. Setting "Require master password or PIN on app restart". https://bitwarden.com/help/vault-timeout/ , https://bitwarden.com/help/biometrics/

## Tray and quick access

- 1Password: Ctrl+Shift+Space opens Quick Access from anywhere. It suggests items for the open app and the most used items. Right arrow shows all actions. Closing the window hides it to the tray. Clipboard clears after 90 s by default. https://support.1password.com/quick-access/
- Bitwarden: one setting "Keep Bitwarden running in the background" (tray), tray menu Show / Exit, "Start automatically on login", "Minimize when copying to clipboard", "Allow screenshots", an autotype shortcut (preview) that types into the focused window. `apps/desktop/src/locales/en/messages.json`
- Shortcuts. 1Password: Ctrl+C / Ctrl+Shift+C / Ctrl+Alt+C copy username / password / one-time code. Bitwarden: Ctrl+U / Ctrl+P / Ctrl+T, Ctrl+G generator, Ctrl+L lock.

## Items

- 1Password has 22 categories, sections with typed custom fields (concealed, date, email, URL, phone, OTP, menu ...), tags, favourites, Archive, Recently Deleted and full item history (every edit is a version). https://support.1password.com/item-categories/ , https://support.1password.com/item-history/
- Bitwarden: Login, Secure Note, Card, Identity, SSH Key (Bank Account new), custom fields (text, hidden, boolean, linked), folders, favourites, Trash for 30 days, password history, per-item master password re-prompt. https://bitwarden.com/help/managing-items/
- Dashlane: logins, secure notes (10,000 characters, attachments up to 15 MB each), payments, IDs, personal info, passkeys.

## Generator

- Bitwarden: length 5 to 128 (default 14), sets, minimum numbers and symbols, avoid ambiguous; passphrase 3 to 20 words (default 6), EFF word list; generator history. `libs/tools/generator/core`
- 1Password: Random, Memorable (words, separator, capitalise), PIN.
- Dashlane: length 4 to 40, exclude lookalike characters.

## Health checks

- 1Password Watchtower: compromised sites, vulnerable (breached) passwords, reused, weak, unsecured (http) sites, 2FA available (2fa.directory), passkeys available, expiring items (cards 2 months ahead, passports 10 months), duplicates. Each finding has a fix action. No numeric score. https://support.1password.com/watchtower/
- Bitwarden reports: exposed passwords (k-anonymity, 5-character hash prefix), reused, weak (zxcvbn), unsecured websites, inactive 2FA (2fa.directory). https://bitwarden.com/help/reports/
- Dashlane Password Health: a score from compromised, reused and weak passwords (zxcvbn), needs 5 logins, tabs Compromised / Reused / Weak / Excluded, excluded items do not count. The formula is not published. https://www.dashlane.com/blog/start-using-password-health-dark-web-monitoring

## TOTP

- All three store a TOTP secret on the login. 1Password and Bitwarden autofill or copy it. Dashlane retired its stand-alone Authenticator app on 13 May 2024 and kept codes in the main app. https://support.1password.com/one-time-passwords/ , https://support.dashlane.com/hc/articles/4583048536082

## Sharing and safety features Coffer leaves out

- 1Password Travel Mode, sharing links, family recovery. Bitwarden Send, organisations, emergency access. Dashlane VPN, Dark Web Monitoring of email addresses, sharing. All need a server or an account. Coffer has neither (see the spec, "Not doing").

## What reviewers praise and dislike

- Praise: ease of use and polish (1Password), open source and price (Bitwarden), password health score (Dashlane).
- Dislikes: price rises (1Password, Dashlane), Electron memory and slowness (1Password 8, Bitwarden desktop), dated UI (Bitwarden), loss of the desktop app (Dashlane).
