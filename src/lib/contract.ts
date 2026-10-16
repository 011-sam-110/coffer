// Coffer IPC contract: the ONE interface between the UI (this folder) and the
// Rust app (src-tauri/src/commands.rs). Both sides follow this file. On the wire
// every name is camelCase (serde `rename_all = "camelCase"` on every Rust type,
// and enum variants serialise as the string literals below).
//
// Rules:
// - A command returns its value, or rejects with a CofferError.
// - The UI never passes a file path to a command that reads or writes secrets:
//   Rust opens every file and folder dialog itself (SPEC 3.7).
// - Re-prompt is enforced in Rust (SPEC 3.6): pass the master password, or get
//   "repromptRequired" and ask for it.
// - No command returns a secret except `item_reveal` (one value) and
//   `vault_create` / `emergency_kit` (the Secret Key for the Emergency Kit).
// - Times are ISO 8601 strings in UTC.

// ---------- errors ----------
export type ErrorCode =
  | "badCredentials" // wrong master password or wrong Secret Key (never says which)
  | "needsSecretKey" // this device has no Secret Key for the vault
  | "badSecretKey" // the Secret Key text fails its check symbol (typo)
  | "vaultMissing" // the vault file is not at its path
  | "tampered" // the manifest MAC or a record failed to verify
  | "corrupt" // the file is not a readable Coffer vault
  | "kdfTooWeak" // the header asks for KDF settings under the floor
  | "locked" // the command needs an unlocked vault
  | "notFound"
  | "conflict" // base_rev is stale, or the file changed on disk
  | "repromptRequired" // the item needs the master password again
  | "weakPassword" // new master password scores under 3
  | "unsupportedFormat"
  | "io"
  | "invalid"
  | "helloUnavailable"
  | "helloFailed"
  | "network"
  | "olderFile" // the file's generation is lower than this PC has seen; vault_open_older completes the open
  | "kdfTooStrong" // the header asks for KDF settings over the ceiling
  | "exists"; // vault_create: that file already exists

export interface CofferError {
  code: ErrorCode;
  message: string; // plain sentence, safe to show to the user
}

// ---------- vault ----------
export type VaultState = "noVault" | "missing" | "locked" | "unlocked";

export interface VaultStatus {
  state: VaultState;
  vaultPath: string | null;
  vaultName: string | null;
  keyId: string | null; // the 6-symbol Secret Key id, not secret
  needsSecretKey: boolean; // locked, and this device has no Secret Key stored
  helloAvailable: boolean; // Windows Hello is set up on this PC
  helloEnabled: boolean; // the user turned on Hello unlock
  helloReady: boolean; // Hello can unlock right now (in-session key held)
  itemCount: number | null; // only when unlocked
}

export interface EmergencyKit {
  vaultName: string;
  vaultPath: string;
  vaultId: string;
  keyId: string; // the 6 id symbols, printed as "Key ID"
  secretKey: string; // C1-AAAAAA-XXXXXX-XXXXXX-XXXXX-XXXXX-XXXXK (key id, 26 secret symbols, check)
  createdAt: string;
  computerName: string;
}

// ---------- items ----------
export type ItemType =
  | "login"
  | "password"
  | "note"
  | "card"
  | "identity"
  | "bank"
  | "document"
  | "sshKey"
  | "apiCredential"
  | "wifi"
  | "license";

export type ItemState = "active" | "archived" | "trashed";

export type FieldKind =
  | "text"
  | "concealed"
  | "multiline"
  | "email"
  | "url"
  | "phone"
  | "date" // YYYY-MM-DD
  | "monthYear" // YYYY-MM
  | "totp" // otpauth:// URI or base32 secret; always masked in views
  | "boolean" // "true" | "false"
  | "cardNumber"
  | "pin"
  | "menu"
  | "concealedMultiline"; // e.g. an SSH private key

/** Kinds whose value is masked in ItemView and only leaves Rust via item_reveal. */
export const SECRET_KINDS: FieldKind[] = ["concealed", "concealedMultiline", "totp", "cardNumber", "pin"];

/** Built-in field roles per item type (SPEC section 4). Field ids are UUIDs; a role names a built-in field. */
export const BUILTIN_FIELDS: Record<ItemType, Array<{ role: string; label: string; kind: FieldKind }>> = {
  login: [
    { role: "username", label: "Username", kind: "text" },
    { role: "password", label: "Password", kind: "concealed" },
    { role: "totp", label: "One-time code", kind: "totp" },
  ],
  password: [{ role: "password", label: "Password", kind: "concealed" }],
  note: [],
  card: [
    { role: "cardholder", label: "Cardholder", kind: "text" },
    { role: "number", label: "Number", kind: "cardNumber" },
    { role: "expiry", label: "Expiry", kind: "monthYear" },
    { role: "cvv", label: "CVV", kind: "pin" },
    { role: "pin", label: "PIN", kind: "pin" },
    { role: "brand", label: "Brand", kind: "menu" },
  ],
  identity: [
    { role: "title", label: "Title", kind: "text" },
    { role: "firstName", label: "First name", kind: "text" },
    { role: "middleName", label: "Middle name", kind: "text" },
    { role: "lastName", label: "Last name", kind: "text" },
    { role: "birthDate", label: "Birth date", kind: "date" },
    { role: "email", label: "Email", kind: "email" },
    { role: "phone", label: "Phone", kind: "phone" },
    { role: "address1", label: "Address line 1", kind: "text" },
    { role: "address2", label: "Address line 2", kind: "text" },
    { role: "city", label: "City", kind: "text" },
    { role: "region", label: "Region", kind: "text" },
    { role: "postcode", label: "Postcode", kind: "text" },
    { role: "country", label: "Country", kind: "text" },
    { role: "company", label: "Company", kind: "text" },
  ],
  bank: [
    { role: "bankName", label: "Bank", kind: "text" },
    { role: "holder", label: "Account holder", kind: "text" },
    { role: "accountNumber", label: "Account number", kind: "concealed" },
    { role: "sortCode", label: "Sort code / routing", kind: "text" },
    { role: "iban", label: "IBAN", kind: "concealed" },
    { role: "swift", label: "SWIFT / BIC", kind: "text" },
    { role: "pin", label: "PIN", kind: "pin" },
  ],
  document: [
    { role: "docKind", label: "Kind", kind: "menu" },
    { role: "number", label: "Number", kind: "text" },
    { role: "fullName", label: "Full name", kind: "text" },
    { role: "issued", label: "Issued", kind: "date" },
    { role: "expires", label: "Expires", kind: "date" },
    { role: "country", label: "Country", kind: "text" },
  ],
  sshKey: [
    { role: "privateKey", label: "Private key", kind: "concealedMultiline" },
    { role: "publicKey", label: "Public key", kind: "multiline" },
    { role: "fingerprint", label: "Fingerprint", kind: "text" },
    { role: "passphrase", label: "Passphrase", kind: "concealed" },
  ],
  apiCredential: [
    { role: "username", label: "Username", kind: "text" },
    { role: "credential", label: "Credential", kind: "concealed" },
    { role: "host", label: "Host", kind: "url" },
    { role: "expires", label: "Expires", kind: "date" },
  ],
  wifi: [
    { role: "ssid", label: "Network name", kind: "text" },
    { role: "password", label: "Password", kind: "concealed" },
    { role: "security", label: "Security", kind: "menu" },
  ],
  license: [
    { role: "product", label: "Product", kind: "text" },
    { role: "version", label: "Version", kind: "text" },
    { role: "licenseKey", label: "Licence key", kind: "concealed" },
    { role: "licensedTo", label: "Licensed to", kind: "text" },
    { role: "email", label: "Email", kind: "email" },
    { role: "purchaseDate", label: "Purchase date", kind: "date" },
  ],
};

/** The role Enter copies in Quick Access; null = open the item in Coffer. A login with no password copies "totp". */
export const ENTER_COPIES: Record<ItemType, string | null> = {
  login: "password",
  password: "password",
  note: null,
  card: "number",
  identity: null,
  bank: "accountNumber",
  document: "number",
  sshKey: "publicKey",
  apiCredential: "credential",
  wifi: "password",
  license: "licenseKey",
};

/** Menu choices for built-in menu fields. */
export const MENU_OPTIONS: Record<string, string[]> = {
  brand: ["Visa", "Mastercard", "American Express", "Discover", "Diners Club", "JCB", "UnionPay", "Maestro", "Other"],
  docKind: ["Passport", "Driving licence", "ID card", "Other"],
  security: ["WPA3", "WPA2", "WPA", "WEP", "None"],
};

export interface Field {
  id: string;
  label: string;
  kind: FieldKind;
  /** Plain value. For a SECRET_KINDS field in an ItemView this is "" and masked is true. */
  value: string;
  masked?: boolean;
  section?: string | null;
  /** Built-in role from BUILTIN_FIELDS, or null for a custom field. */
  builtin?: string | null;
  /** Choices for kind "menu". */
  options?: string[];
}

export interface ItemUrl {
  url: string;
  label?: string | null;
}

export interface Attachment {
  id: string;
  name: string;
  size: number;
  mime: string;
}

export interface ItemFlags {
  weak: boolean;
  reused: boolean;
  breached: boolean;
  unsecured: boolean;
  expiring: boolean;
}

/** List row. Holds no secret. */
export interface ItemSummary {
  id: string;
  type: ItemType;
  title: string;
  subtitle: string; // username, masked card number "•••• 4242", etc.
  favorite: boolean;
  tags: string[];
  state: ItemState;
  updatedAt: string;
  lastUsedAt: string | null;
  urlHost: string | null; // "github.com"
  hasTotp: boolean;
  flags: ItemFlags;
}

/** Detail view. Secret fields are masked. */
export interface ItemView {
  id: string;
  rev: number;
  type: ItemType;
  title: string;
  subtitle: string;
  favorite: boolean;
  tags: string[];
  state: ItemState;
  createdAt: string;
  updatedAt: string;
  trashedAt: string | null;
  passwordChangedAt: string | null;
  fields: Field[];
  notes: string;
  urls: ItemUrl[];
  apps: string[]; // exe names for Quick Access suggestions, e.g. "slack.exe"
  reprompt: boolean;
  autotypeSequence: string | null;
  healthExcluded: boolean;
  attachments: Attachment[];
  passwordHistoryCount: number;
  flags: ItemFlags;
}

/** Create (no id) or update (id + baseRev). */
export interface ItemInput {
  id?: string;
  baseRev?: number;
  type: ItemType;
  title: string;
  favorite: boolean;
  tags: string[];
  /** For a SECRET_KINDS field, value null means "keep the stored value". Valid only for an
   * existing field id whose kind does not change; else the save fails with "invalid". */
  fields: Array<Omit<Field, "value" | "masked"> & { value: string | null }>;
  notes: string;
  urls: ItemUrl[];
  apps: string[];
  reprompt: boolean;
  autotypeSequence: string | null;
  healthExcluded: boolean;
}

export interface Revision {
  rev: number;
  savedAt: string;
  title: string;
}

/** Masked: reveal or copy one entry with item_reveal / item_copy, field "history:<id>". */
export interface PasswordHistoryEntry {
  id: string;
  changedAt: string;
  length: number;
}

export interface TotpCode {
  code: string;
  period: number;
  remaining: number; // seconds left in this period
}

/** Field refs accepted by item_copy / item_reveal: a real field id, a built-in role,
 * or "history:<password history entry id>". */
export type FieldRef = string | "username" | "password" | "totp";

// ---------- generator ----------
export type GeneratorMode = "random" | "passphrase" | "pin";

export interface GeneratorOptions {
  mode: GeneratorMode;
  length: number; // random 8..128 (default 20); pin 4..12 (default 6)
  upper: boolean;
  lower: boolean;
  digits: boolean;
  symbols: boolean;
  minDigits: number; // 0..9
  minSymbols: number; // 0..9
  avoidAmbiguous: boolean;
  exclude: string;
  words: number; // 3..20 (default 5)
  separator: string; // "-" default
  capitalize: boolean;
  includeNumber: boolean;
}

export interface Generated {
  value: string;
  entropyBits: number;
  label: "weak" | "fair" | "good" | "strong" | "excellent";
}

/** Masked: reveal with generator_history_reveal, copy with generator_history_copy. */
export interface GeneratedHistoryEntry {
  id: string;
  createdAt: string;
  length: number;
  mode: GeneratorMode;
}

// ---------- health ----------
export type HealthCheck = "breached" | "reused" | "weak" | "unsecured" | "old" | "expiring" | "duplicate";

export interface HealthFinding {
  itemId: string;
  check: HealthCheck;
  detail: string; // "Used in 3 items", "Found 12,345 times in breaches", "Expires 2026-11"
  groupId: string | null; // same id for items sharing one reused password
}

export interface HealthReport {
  score: number | null; // null when total < 5
  total: number;
  healthy: number;
  formula: string; // shown under the score, e.g. "18 of 20 passwords are not breached, reused or weak"
  counts: Record<HealthCheck, number>;
  findings: HealthFinding[];
  excludedCount: number;
  breachCheck: "off" | "manual" | "weekly";
  breachCheckedAt: string | null;
}

// ---------- import / export ----------
export interface ImportPreview {
  previewId: string;
  format: string; // "bitwarden-json", "1password-1pux", "dashlane-csv-zip", ...
  formatLabel: string; // "Bitwarden (JSON)"
  total: number;
  counts: Partial<Record<ItemType, number>>;
  duplicates: number; // equal to an item already in the vault; will be skipped
  skipped: Array<{ title: string; reason: string }>;
  warnings: string[];
  needsPassword: boolean; // .cofferx or .coffer: call import_preview again with source "last" and the password
  needsSecretKey: boolean; // a .coffer file whose key id has no stored Secret Key on this PC
}

export interface BackupEntry {
  index: number;
  savedAt: string;
  size: number;
  generation: number;
}

export interface ImportResult {
  batchId: string;
  imported: number;
  skipped: number;
  tag: string; // "Imported/Bitwarden"
}

export type ExportKind = "cofferEncrypted" | "cofferJson" | "bitwardenJson" | "csv";
// cofferEncrypted (.cofferx) and cofferJson formats: SPEC section 8.

// ---------- settings ----------
export interface Settings {
  autoLockMinutes: number | null; // null = never; default 10
  lockOnSystemLock: boolean; // default true
  lockOnSleep: boolean; // default true
  clipboardClearSeconds: number | null; // 10, 30, 60, 90 (default), 120, 300, null = never
  captureProtection: boolean; // default true
  helloEnabled: boolean;
  requirePasswordDays: number; // default 14
  startWithWindows: boolean; // default true
  startHidden: boolean; // default true
  trayClick: "quick" | "main"; // default "quick"
  hotkeyQuick: string; // default "Ctrl+Shift+Space"
  hotkeyLock: string | null; // default null (off); "Ctrl+Shift+L" when on
  breachCheck: "off" | "manual" | "weekly"; // default "off"
  closeNoticeShown: boolean;
  closeBehavior: "hide" | "quit"; // default "hide"
  quickHintsShown: number; // the first 3 Quick Access opens show a hint line
}

export interface AppInfo {
  version: string;
  computerName: string;
  defaultFolder: string; // %USERPROFILE%\Coffer
  hotkeyStatus: { quick: "ok" | "inUse" | "off"; lock: "ok" | "inUse" | "off" };
  helloAvailable: boolean;
  demo: boolean; // true only in the browser demo backend
}

export interface FolderInfo {
  path: string;
  exists: boolean;
  writable: boolean;
  synced: boolean;
  provider: "OneDrive" | "Dropbox" | "Google Drive" | null;
}

// ---------- quick access ----------
export interface QuickContext {
  title: string | null; // title of the window that was in front before Quick Access opened
  process: string | null; // "chrome.exe"
  suggestions: string[]; // item ids, best first
}

// ---------- commands ----------
// name: [args, result]. The UI calls invoke(name, args).
export interface Commands {
  app_info: [Record<string, never>, AppInfo];
  folder_info: [Record<string, never>, FolderInfo]; // the default folder
  folder_pick: [Record<string, never>, FolderInfo | null]; // Rust opens the folder dialog and KEEPS the pick; null = cancelled

  vault_status: [Record<string, never>, VaultStatus];
  vault_create: [{ name: string; password: string; usePickedFolder: boolean }, EmergencyKit]; // false = default folder; fails with "exists"
  secret_key_rotate: [{ password: string }, EmergencyKit]; // tier 2
  vault_open: [Record<string, never>, VaultStatus | null]; // Rust opens the file dialog; null = cancelled
  vault_unlock: [{ password: string; secretKey: string | null }, VaultStatus];
  vault_unlock_hello: [Record<string, never>, VaultStatus]; // tier 2
  vault_lock: [Record<string, never>, void];
  vault_change_password: [{ current: string; next: string; rekey: boolean }, void]; // rekey = "My old password may be known"
  vault_move: [Record<string, never>, VaultStatus | null]; // Rust opens the folder dialog
  // After the file vanished, or after diskDamaged / olderOnDisk: saveAs false rewrites the vault path at highest seen + 1,
  // taking the disk file the user was shown as the base (so the atomic re-read check passes); saveAs true opens a Rust dialog.
  vault_save_again: [{ saveAs: boolean }, VaultStatus | null];
  vault_open_older: [Record<string, never>, VaultStatus]; // after vault_unlock failed with "olderFile" (keys held 60 s)
  hello_set: [{ enabled: boolean; password: string | null }, VaultStatus]; // tier 2; enabling needs the master password
  secret_key_validate: [{ secretKey: string }, { valid: boolean; keyId: string | null }];
  emergency_kit: [{ password: string }, EmergencyKit];
  kdf_benchmark: [Record<string, never>, { millis: number; mKib: number; t: number; p: number }];

  items_list: [Record<string, never>, ItemSummary[]];
  item_get: [{ id: string }, ItemView];
  item_reveal: [{ id: string; field: FieldRef; password: string | null }, string];
  item_copy: [{ id: string; field: FieldRef; password: string | null }, { clearsInSeconds: number | null }];
  item_save: [{ item: ItemInput; password: string | null }, ItemView]; // password needed to turn reprompt off or change a secret field's kind
  item_patch: [{ id: string; favorite?: boolean; tags?: string[]; healthExcluded?: boolean }, ItemSummary];
  item_set_state: [{ id: string; state: ItemState }, void];
  items_bulk: [{ ids: string[]; action: "archive" | "trash" | "restore" | "addTag" | "removeTag"; tag: string | null }, number];
  item_delete_forever: [{ id: string }, void];
  trash_empty: [Record<string, never>, number];
  item_revisions: [{ id: string; password: string | null }, Revision[]]; // tier 2 UI
  item_restore_revision: [{ id: string; rev: number; password: string | null }, ItemView]; // tier 2 UI
  item_password_history: [{ id: string; password: string | null }, PasswordHistoryEntry[]];
  item_open_url: [{ id: string; urlIndex: number }, void]; // Rust opens only an http(s) URL stored in the item
  totp_code: [{ id: string; field: string | null; password: string | null }, TotpCode];
  totp_parse: [{ input: string }, { issuer: string | null; account: string | null; valid: boolean }];
  totp_from_image: [{ source: "file" | "screen" }, { uri: string } | null]; // tier 2; Rust opens the file dialog
  ssh_generate: [Record<string, never>, { privateKey: string; publicKey: string; fingerprint: string }]; // tier 2

  generate: [{ options: GeneratorOptions }, Generated];
  generator_options: [Record<string, never>, GeneratorOptions]; // the last options (vault meta), defaults when none; unlocked only
  generator_copy: [{ value: string }, { clearsInSeconds: number | null }];
  generator_history: [Record<string, never>, GeneratedHistoryEntry[]];
  generator_history_reveal: [{ id: string }, string];
  generator_history_copy: [{ id: string }, { clearsInSeconds: number | null }];
  generator_history_clear: [Record<string, never>, void];
  password_strength: [{ password: string; userInputs: string[] }, { score: 0 | 1 | 2 | 3 | 4; crackTime: string; warning: string | null }];

  health_report: [Record<string, never>, HealthReport];
  health_check_breaches: [Record<string, never>, HealthReport];

  // source "pick" opens the dialog, "last" re-reads the last pick (e.g. with a password), "conflict" = the last conflict file Rust wrote.
  import_preview: [{ source: "pick" | "last" | "conflict"; password: string | null; secretKey: string | null }, ImportPreview | null];
  import_commit: [{ previewId: string }, ImportResult];
  import_undo: [{ batchId: string }, number];
  import_delete_source: [{ previewId: string }, void]; // deletes the plain file the user imported from
  // Rust verifies masterPassword, then opens the save dialog; null = cancelled.
  export_vault: [{ kind: ExportKind; masterPassword: string; exportPassword: string | null }, { path: string } | null];

  backups_list: [Record<string, never>, BackupEntry[]];
  backup_restore: [{ index: number; password: string | null }, VaultStatus]; // password needed when the restore would weaken re-prompt on an item

  settings_get: [Record<string, never>, Settings];
  settings_set: [{ patch: Partial<Settings> }, Settings]; // main window only; rejects helloEnabled (use hello_set)
  quick_hint_seen: [Record<string, never>, void]; // quick window: count one hint showing
  edit_state: [{ title: string | null; dirty: boolean }, void]; // main window reports an open edit

  quick_context: [Record<string, never>, QuickContext];
  quick_hide: [Record<string, never>, void];
  quick_set_modal: [{ modal: boolean }, void]; // true while a prompt or dialog of Quick Access is up: no close on blur
  main_show: [{ itemId: string | null; view: "item" | "settings" | "generator" | "health" | null }, void];
  main_hide: [Record<string, never>, void]; // main hides itself, e.g. after the first-close notice
  autotype: [{ id: string; password: string | null; only?: "password" | null }, void]; // tier 2; only "password" types the password alone (no sequence, no Enter)
  app_quit: [Record<string, never>, void];
}

// ---------- events (Rust -> UI) ----------
export interface Events {
  "vault://locked": { reason: "manual" | "idle" | "systemLock" | "sleep" | "quit" | "keyChanged" };
  "vault://diskDamaged": { path: string }; // MAC failed on disk; saves blocked (SPEC 3.5)
  "vault://olderOnDisk": { fileGeneration: number; seenGeneration: number }; // rollback on disk; saves blocked
  "vault://unlocked": VaultStatus;
  "vault://changed": { ids: string[] };
  "vault://reloaded": Record<string, never>; // external change merged cleanly
  "vault://conflict": { conflictPath: string; since: string };
  "vault://missing": { path: string };
  "clipboard://copied": { label: string; clearsInSeconds: number | null };
  "clipboard://cleared": Record<string, never>;
  "quick://shown": QuickContext;
  "main://navigate": { itemId: string | null; view: "item" | "settings" | "generator" | "health" | null };
  "edit://discarded": { title: string }; // lock dropped an unsaved edit
  "app://quitRequested": Record<string, never>; // main asks Save / Discard / Cancel, then calls app_quit
  "main://closeNotice": Record<string, never>; // first close with closeBehavior "hide": the window stays open; the UI shows the tray notice, then calls main_hide
}
