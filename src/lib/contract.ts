// Coffer IPC contract: the ONE interface between the UI (this folder) and the
// Rust app (src-tauri/src/commands.rs). Both sides follow this file. On the wire
// every name is camelCase (serde `rename_all = "camelCase"` on every Rust type,
// and enum variants serialise as the string literals below).
//
// Rules:
// - A command returns its value, or rejects with a CofferError.
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
  | "network";

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
  secretKey: string; // C1-AAAAAA-XXXXX-XXXXX-XXXXX-XXXXX-XXXXXX (id, 26 secret symbols, check)
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
  | "menu";

/** Kinds whose value is masked in ItemView and only leaves Rust via item_reveal. */
export const SECRET_KINDS: FieldKind[] = ["concealed", "totp", "cardNumber", "pin"];

export interface Field {
  id: string;
  label: string;
  kind: FieldKind;
  /** Plain value. For a SECRET_KINDS field in an ItemView this is "" and masked is true. */
  value: string;
  masked?: boolean;
  section?: string | null;
  /** Built-in role: "username" | "password" | "totp" | "number" | "cvv" ... */
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
  /** For a SECRET_KINDS field, value null means "keep the stored value". */
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

export interface PasswordHistoryEntry {
  id: string;
  value: string; // only returned by item_password_history after reprompt rules pass
  changedAt: string;
}

export interface TotpCode {
  code: string;
  period: number;
  remaining: number; // seconds left in this period
}

/** Field id shortcuts accepted by item_copy / item_reveal besides a real field id. */
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

export interface GeneratedHistoryEntry {
  value: string;
  createdAt: string;
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
  needsPassword: boolean; // encrypted Bitwarden JSON: call import_preview again with password
}

export interface ImportResult {
  imported: number;
  skipped: number;
  tag: string; // "Imported/Bitwarden"
}

export type ExportKind = "cofferEncrypted" | "cofferJson" | "bitwardenJson" | "csv";

// ---------- settings ----------
export interface Settings {
  autoLockMinutes: number | null; // null = never; default 10
  lockOnSystemLock: boolean; // default true
  lockOnSleep: boolean; // default true
  clipboardClearSeconds: number | null; // 10, 30, 60, 90 (default), 120, 300, null = never
  excludeFromClipboardHistory: boolean; // default true
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
  folder_info: [{ folder: string }, FolderInfo];

  vault_status: [Record<string, never>, VaultStatus];
  vault_create: [{ name: string; password: string; folder: string | null }, EmergencyKit];
  vault_open: [{ path: string }, VaultStatus];
  vault_unlock: [{ password: string; secretKey: string | null }, VaultStatus];
  vault_unlock_hello: [Record<string, never>, VaultStatus]; // tier 2
  vault_lock: [Record<string, never>, void];
  vault_change_password: [{ current: string; next: string }, void];
  vault_move: [{ folder: string }, VaultStatus];
  vault_save_again: [{ path: string | null }, VaultStatus]; // file vanished while unlocked
  secret_key_validate: [{ secretKey: string }, { valid: boolean; keyId: string | null }];
  emergency_kit: [{ password: string }, EmergencyKit];
  kdf_benchmark: [Record<string, never>, { millis: number; mKib: number; t: number; p: number }];

  items_list: [Record<string, never>, ItemSummary[]];
  item_get: [{ id: string }, ItemView];
  item_reveal: [{ id: string; field: FieldRef; password: string | null }, string];
  item_copy: [{ id: string; field: FieldRef; password: string | null }, { clearsInSeconds: number | null }];
  item_save: [{ item: ItemInput }, ItemView];
  item_patch: [{ id: string; favorite?: boolean; tags?: string[]; healthExcluded?: boolean }, ItemSummary];
  item_set_state: [{ id: string; state: ItemState }, void];
  items_bulk: [{ ids: string[]; action: "archive" | "trash" | "restore" | "addTag" | "removeTag"; tag: string | null }, number];
  item_delete_forever: [{ id: string }, void];
  trash_empty: [Record<string, never>, number];
  item_revisions: [{ id: string }, Revision[]]; // tier 2 UI
  item_restore_revision: [{ id: string; rev: number }, ItemView]; // tier 2 UI
  item_password_history: [{ id: string; password: string | null }, PasswordHistoryEntry[]];
  totp_code: [{ id: string; field: string | null }, TotpCode];
  totp_parse: [{ input: string }, { issuer: string | null; account: string | null; valid: boolean }];
  totp_from_image: [{ path: string | null }, { uri: string }]; // tier 2; path null = scan the screen
  ssh_generate: [Record<string, never>, { privateKey: string; publicKey: string; fingerprint: string }]; // tier 2

  generate: [{ options: GeneratorOptions }, Generated];
  generator_copy: [{ value: string }, { clearsInSeconds: number | null }];
  generator_history: [Record<string, never>, GeneratedHistoryEntry[]];
  generator_history_clear: [Record<string, never>, void];
  password_strength: [{ password: string; userInputs: string[] }, { score: 0 | 1 | 2 | 3 | 4; crackTime: string; warning: string | null }];

  health_report: [Record<string, never>, HealthReport];
  health_check_breaches: [Record<string, never>, HealthReport];

  import_preview: [{ path: string; password: string | null }, ImportPreview];
  import_commit: [{ previewId: string }, ImportResult];
  import_undo: [{ tag: string }, number];
  file_delete: [{ path: string }, void]; // only a path the user just imported from
  export_vault: [{ kind: ExportKind; path: string; masterPassword: string; exportPassword: string | null }, { path: string }];

  backups_list: [Record<string, never>, Array<{ path: string; savedAt: string; size: number }>];
  backup_restore: [{ path: string }, VaultStatus];

  settings_get: [Record<string, never>, Settings];
  settings_set: [{ patch: Partial<Settings> }, Settings];

  quick_context: [Record<string, never>, QuickContext];
  quick_hide: [Record<string, never>, void];
  main_show: [{ itemId: string | null; view: "item" | "settings" | "generator" | "health" | null }, void];
  autotype: [{ id: string; password: string | null }, void]; // tier 2
  open_url: [{ url: string }, void]; // http and https only
  app_quit: [Record<string, never>, void];
}

// ---------- events (Rust -> UI) ----------
export interface Events {
  "vault://locked": { reason: "manual" | "idle" | "systemLock" | "sleep" | "quit" };
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
}
