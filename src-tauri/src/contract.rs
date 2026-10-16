//! Rust side of `src/lib/contract.ts`: argument, result and event types.
//!
//! On the wire every name is camelCase and enum variants are the string
//! literals of the contract. `Settings` lives in `settings.rs` (it has the
//! defaults). Secret values in arguments are `Zeroizing<String>`.
//!
//! Some types are used only from phase B (vault commands); they are here now so
//! every command has its final signature.
#![allow(dead_code)]

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

// ---------- vault ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VaultState {
    NoVault,
    Missing,
    Locked,
    Unlocked,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub state: VaultState,
    pub vault_path: Option<String>,
    pub vault_name: Option<String>,
    pub key_id: Option<String>,
    pub needs_secret_key: bool,
    pub hello_available: bool,
    pub hello_enabled: bool,
    pub hello_ready: bool,
    pub item_count: Option<u32>,
}

/// Holds the Secret Key: never logged, zeroized on drop.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmergencyKit {
    pub vault_name: String,
    pub vault_path: String,
    pub vault_id: String,
    pub key_id: String,
    pub secret_key: Zeroizing<String>,
    pub created_at: String,
    pub computer_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretKeyCheck {
    pub valid: bool,
    pub key_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KdfBenchmark {
    pub millis: u64,
    pub m_kib: u32,
    pub t: u32,
    pub p: u32,
}

// ---------- items ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ItemType {
    Login,
    Password,
    Note,
    Card,
    Identity,
    Bank,
    Document,
    SshKey,
    ApiCredential,
    Wifi,
    License,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ItemState {
    Active,
    Archived,
    Trashed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FieldKind {
    Text,
    Concealed,
    Multiline,
    Email,
    Url,
    Phone,
    Date,
    MonthYear,
    Totp,
    Boolean,
    CardNumber,
    Pin,
    Menu,
    ConcealedMultiline,
}

/// `SECRET_KINDS` of the contract.
pub const SECRET_KINDS: &[FieldKind] = &[FieldKind::Concealed, FieldKind::ConcealedMultiline, FieldKind::Totp, FieldKind::CardNumber, FieldKind::Pin];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Field {
    pub id: String,
    pub label: String,
    pub kind: FieldKind,
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub masked: Option<bool>,
    #[serde(default)]
    pub section: Option<String>,
    #[serde(default)]
    pub builtin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<String>>,
}

/// A field in an `ItemInput`: `value: None` keeps the stored secret value.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldInput {
    pub id: String,
    pub label: String,
    pub kind: FieldKind,
    pub value: Option<Zeroizing<String>>,
    #[serde(default)]
    pub section: Option<String>,
    #[serde(default)]
    pub builtin: Option<String>,
    #[serde(default)]
    pub options: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemUrl {
    pub url: String,
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub name: String,
    pub size: u64,
    pub mime: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemFlags {
    pub weak: bool,
    pub reused: bool,
    pub breached: bool,
    pub unsecured: bool,
    pub expiring: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemSummary {
    pub id: String,
    #[serde(rename = "type")]
    pub item_type: ItemType,
    pub title: String,
    pub subtitle: String,
    pub favorite: bool,
    pub tags: Vec<String>,
    pub state: ItemState,
    pub updated_at: String,
    pub last_used_at: Option<String>,
    pub url_host: Option<String>,
    pub has_totp: bool,
    pub flags: ItemFlags,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemView {
    pub id: String,
    pub rev: u64,
    #[serde(rename = "type")]
    pub item_type: ItemType,
    pub title: String,
    pub subtitle: String,
    pub favorite: bool,
    pub tags: Vec<String>,
    pub state: ItemState,
    pub created_at: String,
    pub updated_at: String,
    pub trashed_at: Option<String>,
    pub password_changed_at: Option<String>,
    pub fields: Vec<Field>,
    pub notes: String,
    pub urls: Vec<ItemUrl>,
    pub apps: Vec<String>,
    pub reprompt: bool,
    pub autotype_sequence: Option<String>,
    pub health_excluded: bool,
    pub attachments: Vec<Attachment>,
    pub password_history_count: u32,
    pub flags: ItemFlags,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemInput {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub base_rev: Option<u64>,
    #[serde(rename = "type")]
    pub item_type: ItemType,
    pub title: String,
    pub favorite: bool,
    pub tags: Vec<String>,
    pub fields: Vec<FieldInput>,
    pub notes: String,
    pub urls: Vec<ItemUrl>,
    pub apps: Vec<String>,
    pub reprompt: bool,
    pub autotype_sequence: Option<String>,
    pub health_excluded: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    pub rev: u64,
    pub saved_at: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordHistoryEntry {
    pub id: String,
    pub changed_at: String,
    pub length: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TotpCode {
    pub code: String,
    pub period: u32,
    pub remaining: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BulkAction {
    Archive,
    Trash,
    Restore,
    AddTag,
    RemoveTag,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TotpParse {
    pub issuer: Option<String>,
    pub account: Option<String>,
    pub valid: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TotpImage {
    pub uri: String,
}

/// `totp_from_image` source: a file (Rust opens the dialog) or the screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TotpSource {
    File,
    Screen,
}

/// Holds a private key: never logged.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshKeyPair {
    pub private_key: Zeroizing<String>,
    pub public_key: String,
    pub fingerprint: String,
}

/// Result of every copy command.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyResult {
    pub clears_in_seconds: Option<u32>,
}

// ---------- generator ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GeneratorMode {
    Random,
    Passphrase,
    Pin,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratorOptions {
    pub mode: GeneratorMode,
    pub length: u32,
    pub upper: bool,
    pub lower: bool,
    pub digits: bool,
    pub symbols: bool,
    pub min_digits: u32,
    pub min_symbols: u32,
    pub avoid_ambiguous: bool,
    pub exclude: String,
    pub words: u32,
    pub separator: String,
    pub capitalize: bool,
    pub include_number: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StrengthLabel {
    Weak,
    Fair,
    Good,
    Strong,
    Excellent,
}

/// A generated password (a secret).
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Generated {
    pub value: Zeroizing<String>,
    pub entropy_bits: f64,
    pub label: StrengthLabel,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedHistoryEntry {
    pub id: String,
    pub created_at: String,
    pub length: u32,
    pub mode: GeneratorMode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordStrength {
    /// 0 to 4.
    pub score: u8,
    pub crack_time: String,
    pub warning: Option<String>,
}

// ---------- health ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HealthCheck {
    Breached,
    Reused,
    Weak,
    Unsecured,
    Old,
    Expiring,
    Duplicate,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthFinding {
    pub item_id: String,
    pub check: HealthCheck,
    pub detail: String,
    pub group_id: Option<String>,
}

/// `Record<HealthCheck, number>`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthCounts {
    pub breached: u32,
    pub reused: u32,
    pub weak: u32,
    pub unsecured: u32,
    pub old: u32,
    pub expiring: u32,
    pub duplicate: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BreachCheck {
    #[default]
    Off,
    Manual,
    Weekly,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthReport {
    pub score: Option<u32>,
    pub total: u32,
    pub healthy: u32,
    pub formula: String,
    pub counts: HealthCounts,
    pub findings: Vec<HealthFinding>,
    pub excluded_count: u32,
    pub breach_check: BreachCheck,
    pub breach_checked_at: Option<String>,
}

// ---------- import / export ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedImport {
    pub title: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub preview_id: String,
    pub format: String,
    pub format_label: String,
    pub total: u32,
    pub counts: BTreeMap<ItemType, u32>,
    pub duplicates: u32,
    pub skipped: Vec<SkippedImport>,
    pub warnings: Vec<String>,
    pub needs_password: bool,
    pub needs_secret_key: bool,
}

/// `import_preview` source: open the dialog, re-read the last pick, or the
/// last conflict file Rust wrote.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ImportSource {
    Pick,
    Last,
    Conflict,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub batch_id: String,
    pub imported: u32,
    pub skipped: u32,
    pub tag: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExportKind {
    CofferEncrypted,
    CofferJson,
    BitwardenJson,
    Csv,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupEntry {
    pub index: u32,
    pub saved_at: String,
    pub size: u64,
    pub generation: u64,
}

// ---------- app ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HotkeyState {
    Ok,
    InUse,
    Off,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyStatus {
    pub quick: HotkeyState,
    pub lock: HotkeyState,
}

impl Default for HotkeyStatus {
    fn default() -> Self {
        Self { quick: HotkeyState::Off, lock: HotkeyState::Off }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub computer_name: String,
    pub default_folder: String,
    pub hotkey_status: HotkeyStatus,
    pub hello_available: bool,
    pub demo: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SyncProvider {
    OneDrive,
    Dropbox,
    #[serde(rename = "Google Drive")]
    GoogleDrive,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderInfo {
    pub path: String,
    pub exists: bool,
    pub writable: bool,
    pub synced: bool,
    pub provider: Option<SyncProvider>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickContext {
    pub title: Option<String>,
    pub process: Option<String>,
    pub suggestions: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MainView {
    Item,
    Settings,
    Generator,
    Health,
}

// ---------- events (Rust -> UI) ----------

pub mod events {
    pub const VAULT_LOCKED: &str = "vault://locked";
    pub const VAULT_DISK_DAMAGED: &str = "vault://diskDamaged";
    pub const VAULT_OLDER_ON_DISK: &str = "vault://olderOnDisk";
    pub const VAULT_UNLOCKED: &str = "vault://unlocked";
    pub const VAULT_CHANGED: &str = "vault://changed";
    pub const VAULT_RELOADED: &str = "vault://reloaded";
    pub const VAULT_CONFLICT: &str = "vault://conflict";
    pub const VAULT_MISSING: &str = "vault://missing";
    pub const CLIPBOARD_COPIED: &str = "clipboard://copied";
    pub const CLIPBOARD_CLEARED: &str = "clipboard://cleared";
    pub const QUICK_SHOWN: &str = "quick://shown";
    pub const MAIN_NAVIGATE: &str = "main://navigate";
    pub const EDIT_DISCARDED: &str = "edit://discarded";
    pub const APP_QUIT_REQUESTED: &str = "app://quitRequested";
    /// Shell addition, proposed for the contract.
    pub const MAIN_CLOSE_NOTICE: &str = "main://closeNotice";
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LockReason {
    Manual,
    Idle,
    SystemLock,
    Sleep,
    Quit,
    /// The header changed on disk (password or Secret Key changed elsewhere).
    KeyChanged,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockedEvent {
    pub reason: LockReason,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardCopiedEvent {
    pub label: String,
    pub clears_in_seconds: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigateEvent {
    pub item_id: Option<String>,
    pub view: Option<MainView>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditDiscardedEvent {
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultChangedEvent {
    pub ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultConflictEvent {
    pub conflict_path: String,
    pub since: String,
}

/// `vault://diskDamaged`: the MAC failed on disk; saves are blocked.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskDamagedEvent {
    pub path: String,
}

/// `vault://olderOnDisk`: a rollback on disk; saves are blocked.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OlderOnDiskEvent {
    pub file_generation: u64,
    pub seen_generation: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultMissingEvent {
    pub path: String,
}

/// Payload of the events typed `Record<string, never>`: `{}`.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct Empty {}
