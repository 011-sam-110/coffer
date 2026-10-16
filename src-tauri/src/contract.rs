//! Rust side of `src/lib/contract.ts`.
//!
//! The item, generator, health and import types are coffer-core's
//! (`coffer_core::model`, camelCase serde, the exact contract shapes) and are
//! re-exported here. This file holds the types the shell owns: vault status,
//! the kit, app and window types, and the events.

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

#[allow(unused_imports)]
pub use coffer_core::model::{
    Attachment, BreachMode, ExportKind, Field, FieldInput, FieldKind, Generated, GeneratedHistoryEntry, GeneratorMode, GeneratorOptions, HealthCheck, HealthCounts,
    HealthFinding, HealthReport, ImportPreview, ImportResult, ItemFlags, ItemInput, ItemState, ItemSummary, ItemType, ItemUrl, ItemView, PasswordHistoryEntry, Revision,
    SkippedItem, Strength, StrengthLabel, TotpCode, TotpParse,
};
pub use coffer_core::session::BulkAction;

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
