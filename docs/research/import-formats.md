# Import and export formats of 1Password, Bitwarden and Dashlane

Research agents collected these on 2026-10-16. Most field names come from the open-source Bitwarden importer and exporter code (github.com/bitwarden/clients, `libs/importer` and `libs/tools/export`), read raw. "UNVERIFIED" marks a point the agents could not confirm. The importer code must treat each UNVERIFIED point as a guess: accept both spellings where a doubt exists, and fail with a clear message on an unknown shape.

## 1Password

### 1PUX (1Password 8 export)
Source: https://support.1password.com/1pux-format/ and `onepassword-1pux-importer-types.ts` in bitwarden/clients.

- A ZIP file named `<account UUID>.1pux`. It holds `export.attributes`, `export.data` and a `files/` folder. File names in `files/` start with the document ID.
- `export.attributes`: `{ version (int, e.g. 3), description ("1Password Unencrypted Export"), createdAt (Unix seconds) }`.
- `export.data`: `{ accounts: [ { attrs, vaults: [ { attrs, items: [ ... ] } ] } ] }`.
  - Account `attrs`: accountName, name, avatar, email, uuid, domain.
  - Vault `attrs`: uuid, desc, avatar, name, type (`P` personal, `E` everyone, `U` user-created).
- Item: `uuid` (unique per vault only), `favIndex` (0 = not a favourite), `createdAt`, `updatedAt` (Unix seconds), `state` (`"active"` or `"archived"`), `categoryUuid`, `overview`, `details`, optional `file { attrs, path }`.
  - `overview`: title, subtitle, url, urls `[{label, url}]`, tags `[string]`, plus undocumented ps, pbe, pgrng.
  - `details`: `loginFields[]`, `notesPlain`, `sections[]`, `passwordHistory [{value, time}]`, `password` (Password category only), `documentAttributes`.
  - `loginFields[]`: value, id, name, fieldType, designation (`"username"` or `"password"`).
  - `sections[]`: `{ title, name, fields: [ { title, id, value } ] }`. `value` is an object keyed by its type, e.g. `{ "concealed": "..." }`, `{ "totp": "otpauth://..." }`, `{ "string": "..." }`, `{ "date": <unix seconds> }`, `{ "monthYear": 202612 }`, `{ "email": { "email_address": "...", "provider": "..." } }`, `{ "url": "..." }`, `{ "phone": "..." }`, `{ "creditCardNumber": "..." }`, `{ "creditCardType": "..." }`, `{ "menu": "..." }`, `{ "address": { street, city, country, zip, state } }`. Key names beyond concealed, totp, date and email are UNVERIFIED: take the first key of the object as the type and its value as text when the key is unknown.
- `categoryUuid` codes: 001 Login, 002 CreditCard, 003 SecureNote, 004 Identity, 005 Password, 006 Document, 100 SoftwareLicense, 101 BankAccount, 102 Database, 103 DriversLicense, 104 OutdoorLicense, 105 Membership, 106 Passport, 107 RewardsProgram, 108 SocialSecurityNumber, 109 WirelessRouter, 110 Server, 111 EmailAccount, 112 API_Credential, 113 MedicalRecord, 114 SSH_Key. Crypto Wallet has no known code (UNVERIFIED).
- `LoginFieldType` (fieldType): T text, E email, U URL, N number, P password, A textarea, TEL phone, C checkbox.
- The Bitwarden importer reads only `accounts[0]`. Coffer reads every account and every vault, and keeps the vault name as a tag.

### 1Password CSV
Source: https://support.1password.com/export/ and https://1password.community/discussion/comment/688729.
- Login and Password items only.
- Fields: Title, Website (or Url), Username, Password, One-time password (or OTPAuth), Favorite, Archived, Tags, Notes. The exact header spelling is UNVERIFIED: match headers without case, and accept `website|url|urls` and `one-time password|otpauth|otp`.

## Bitwarden

### Unencrypted JSON
Source: https://bitwarden.com/help/condition-bitwarden-import/ and `cipher.export.ts`.
- Top level (personal vault): `{ "encrypted": false, "folders": [ {id, name} ], "items": [ ... ] }`. Organisation export: `collections [{id, organizationId, name, externalId}]` and `items`.
- Item: id, organizationId, folderId, type, reprompt (0 none, 1 password), name, notes, favorite, fields, collectionIds, passwordHistory, creationDate, revisionDate, deletedDate, archivedDate, and one of login, secureNote, card, identity, sshKey.
- `type`: 1 Login, 2 SecureNote, 3 Card, 4 Identity, 5 SshKey, 6 BankAccount (newest code; fields UNVERIFIED).
- `login`: `{ uris: [ { match, uri } ], username, password, totp, fido2Credentials: [...] }`.
- `card`: cardholderName, brand, number, expMonth, expYear, code.
- `identity`: title, firstName, middleName, lastName, address1, address2, address3, city, state, postalCode, country, company, email, phone, ssn, username, passportNumber, licenseNumber.
- `secureNote`: `{ type: 0 }`.
- `sshKey`: privateKey, publicKey, keyFingerprint.
- `fields[]`: `{ name, value, type, linkedId }`. type: 0 Text, 1 Hidden, 2 Boolean, 3 Linked. Linked ids: login Username 100, Password 101.
- `passwordHistory[]`: `{ lastUsedDate, password }`.
- `fido2Credentials[]`: credentialId, keyType, keyAlgorithm, keyCurve, keyValue, rpId, userHandle, userName, counter, rpName, userDisplayName, discoverable, creationDate.

### Password-protected encrypted JSON
Source: `base-vault-export.service.ts`.
- `{ "encrypted": true, "passwordProtected": true, "salt": <16 bytes base64>, "kdfType": 0|1, "kdfIterations": n, "kdfMemory": MiB (Argon2id only), "kdfParallelism": n (Argon2id only), "encKeyValidation_DO_NOT_EDIT": <EncString>, "data": <EncString of the clear JSON> }`.
- KdfType: 0 PBKDF2-SHA256, 1 Argon2id.
- EncString type 2 = AES-256-CBC + HMAC-SHA256, three parts: iv, ciphertext, mac. The text form `2.<iv b64>|<ct b64>|<mac b64>` is UNVERIFIED: read `enc-string.ts` in bitwarden/clients before relying on it.
- Key derivation for this export (UNVERIFIED in detail): the password and the salt go through the KDF to a 32-byte key, then HKDF-Expand (SHA-256) with info "enc" and "mac" gives the two 32-byte keys. Check against the Bitwarden code before building it.
- The account-restricted encrypted JSON (no `passwordProtected`) can only be opened by the same Bitwarden account. Coffer does not import it: tell the user to export the password-protected kind.

### Bitwarden CSV
Source: https://bitwarden.com/help/condition-bitwarden-import/.
- Personal: `folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp`
- Organisation: `collections,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp`
- `type` is `login` or `note`. Custom fields are `name: value` lines in the `fields` cell. Newest code adds an `archivedDate` column.

## Dashlane

### CSV export (a ZIP of CSV files)
Source: `dashlane-csv-types.ts` and `dashlane-csv-importer.ts` in bitwarden/clients; https://www.zetetic.net/codebook/switch/import/dashlane/.
- File names: credentials.csv, securenotes.csv, payments.csv, ids.csv, personalInfo.csv (the case of the last one is UNVERIFIED: match without case).
- Headers in column order:
  - credentials: `username, username2, username3, title, password, note, url, category, otpSecret, otpUrl` (otpSecret and otpUrl optional)
  - payments: `type, account_name, account_holder, cc_number, code, expiration_month, expiration_year, routing_number, account_number, country, issuing_bank` (type: credit_card, bank)
  - ids: `type, number, name, issue_date, expiration_date, place_of_issue, state` (type: card, passport, license, social_security, tax_number)
  - personalInfo: `type, title, first_name, middle_name, last_name, login, date_of_birth, place_of_birth, email, email_type, item_name, phone_number, address, country, state, city, zip, address_recipient, address_building, address_apartment, address_floor, address_door_code, job_title, url` (type: name, email, number, address)
  - securenotes: `title, note`
- Detect the file kind from the first two header columns: `username` = login; `type, account_name` = payment; `type, number` = ID; `type, title` = personal info; `title, note` = note.
- Attachments and passkeys are never in the export.

### Older Dashlane JSON export
- Top-level keys: ADDRESS, AUTHENTIFIANT, BANKSTATEMENT, IDCARD, IDENTITY, PAYMENTMEANS_CREDITCARD, PAYMENTMEAN_PAYPAL, EMAIL.
- AUTHENTIFIANT: title, login, secondaryLogin, email, password, domain, note. IDENTITY: fullName, pseudo. ADDRESS: addressName, addressFull, city, state, zipcode, country. PAYMENTMEANS_CREDITCARD: bank, cardNumber, owner. BANKSTATEMENT: BankAccountName. IDCARD: Fullname.
- Unknown keys become secure notes.

### Secure .dash export
Password-protected, internal format UNVERIFIED. Coffer does not import it: tell the user to export CSV.

## Browsers
- Chrome, Edge, Brave CSV: `name,url,username,password,note` (note column may be absent). Not from the research agents: check against a real export before calling it verified.
- Firefox CSV: `"url","username","password","httpRealm","formActionOrigin","guid","timeCreated","timeLastUsed","timePasswordChanged"`. Not from the research agents: check against a real export.
