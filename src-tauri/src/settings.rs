//! Device settings: `%LOCALAPPDATA%\Coffer\settings.json` (no secrets).
//!
//! The file holds the contract's `Settings` (flat) plus device-only fields the
//! UI does not edit through `settings_set` (`vaultPath`).

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::contract::BreachCheck;
use crate::error::{CofferError, CofferResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TrayClick {
    #[default]
    Quick,
    Main,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CloseBehavior {
    #[default]
    Hide,
    Quit,
}

/// `Settings` of the contract. A key missing from the file takes its default.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub auto_lock_minutes: Option<u32>,
    pub lock_on_system_lock: bool,
    pub lock_on_sleep: bool,
    pub clipboard_clear_seconds: Option<u32>,
    pub capture_protection: bool,
    pub hello_enabled: bool,
    pub require_password_days: u32,
    pub start_with_windows: bool,
    pub start_hidden: bool,
    pub tray_click: TrayClick,
    pub hotkey_quick: String,
    pub hotkey_lock: Option<String>,
    pub breach_check: BreachCheck,
    pub close_notice_shown: bool,
    pub close_behavior: CloseBehavior,
    pub quick_hints_shown: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            auto_lock_minutes: Some(10),
            lock_on_system_lock: true,
            lock_on_sleep: true,
            clipboard_clear_seconds: Some(90),
            capture_protection: true,
            hello_enabled: false,
            require_password_days: 14,
            start_with_windows: true,
            start_hidden: true,
            tray_click: TrayClick::Quick,
            hotkey_quick: "Ctrl+Shift+Space".to_string(),
            hotkey_lock: None,
            breach_check: BreachCheck::Off,
            close_notice_shown: false,
            close_behavior: CloseBehavior::Hide,
            quick_hints_shown: 0,
        }
    }
}

/// Allowed `autoLockMinutes` values (SPEC 9); `null` is "never".
pub const AUTO_LOCK_CHOICES: &[u32] = &[1, 2, 5, 10, 15, 30, 60];
/// Allowed `clipboardClearSeconds` values (SPEC 9); `null` is "never".
pub const CLIPBOARD_CHOICES: &[u32] = &[10, 30, 60, 90, 120, 300];

/// What is on disk.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsFile {
    #[serde(default = "file_version")]
    pub version: u32,
    #[serde(flatten)]
    pub settings: Settings,
    /// The vault this device opens (set by vault create/open/move in phase B).
    #[serde(default)]
    pub vault_path: Option<String>,
    /// That vault's id (lower-case UUID text), so backups work in every state.
    #[serde(default)]
    pub vault_id: Option<String>,
}

fn file_version() -> u32 {
    1
}

impl Default for SettingsFile {
    fn default() -> Self {
        Self { version: file_version(), settings: Settings::default(), vault_path: None, vault_id: None }
    }
}

/// Load `settings.json`. Returns the settings and `true` when there was no file
/// (first run). A file that does not parse is kept as `settings.json.bad-<time>` and
/// the defaults are used.
pub fn load(path: &Path) -> (SettingsFile, bool) {
    match std::fs::read(path) {
        Ok(bytes) => match serde_json::from_slice::<SettingsFile>(&bytes) {
            Ok(mut file) => {
                if validate(&file.settings).is_err() {
                    crate::log!("settings: a stored value is out of range; using defaults for the settings");
                    file.settings = Settings::default();
                }
                (file, false)
            }
            Err(err) => {
                let bad = path.with_extension(format!("json.bad-{}", crate::clock::file_stamp()));
                crate::log!("settings: settings.json does not parse ({err}); keeping it as {}", bad.display());
                let _ = std::fs::rename(path, bad);
                (SettingsFile::default(), false)
            }
        },
        Err(_) => (SettingsFile::default(), true),
    }
}

pub fn save(path: &Path, file: &SettingsFile) -> CofferResult<()> {
    let bytes = serde_json::to_vec_pretty(file).map_err(|e| CofferError::io(format!("Coffer could not write its settings: {e}")))?;
    crate::paths::write_atomic(path, &bytes).map_err(|e| CofferError::io(format!("Coffer could not save its settings: {e}")))
}

/// The camelCase keys of `Settings`.
pub fn setting_keys() -> Vec<String> {
    match serde_json::to_value(Settings::default()) {
        Ok(serde_json::Value::Object(map)) => map.keys().cloned().collect(),
        _ => Vec::new(),
    }
}

/// Keys `settings_set` refuses: `helloEnabled` changes only through
/// `hello_set`, which checks the master password (SPEC 3.6).
pub const PATCH_REFUSED: &[&str] = &["helloEnabled"];

/// Merge a `Partial<Settings>` into `current` and validate the result.
pub fn apply_patch(current: &Settings, patch: &serde_json::Value) -> CofferResult<Settings> {
    let serde_json::Value::Object(patch) = patch else {
        return Err(CofferError::invalid("Settings patch must be an object."));
    };
    let keys = setting_keys();
    let mut merged = serde_json::to_value(current).map_err(|e| CofferError::invalid(e.to_string()))?;
    let serde_json::Value::Object(target) = &mut merged else {
        return Err(CofferError::invalid("Settings are not an object."));
    };
    for (key, value) in patch {
        if !keys.iter().any(|k| k == key) {
            return Err(CofferError::invalid(format!("Unknown setting \"{key}\".")));
        }
        if PATCH_REFUSED.contains(&key.as_str()) {
            return Err(CofferError::invalid(format!("\"{key}\" changes only with hello_set.")));
        }
        target.insert(key.clone(), value.clone());
    }
    let next: Settings = serde_json::from_value(merged).map_err(|e| CofferError::invalid(format!("A setting has the wrong type: {e}")))?;
    validate(&next)?;
    Ok(next)
}

pub fn validate(s: &Settings) -> CofferResult<()> {
    if let Some(m) = s.auto_lock_minutes {
        if !AUTO_LOCK_CHOICES.contains(&m) {
            return Err(CofferError::invalid(format!("Auto-lock must be one of {AUTO_LOCK_CHOICES:?} minutes or never.")));
        }
    }
    if let Some(sec) = s.clipboard_clear_seconds {
        if !CLIPBOARD_CHOICES.contains(&sec) {
            return Err(CofferError::invalid(format!("Clipboard clear must be one of {CLIPBOARD_CHOICES:?} seconds or never.")));
        }
    }
    if !(1..=365).contains(&s.require_password_days) {
        return Err(CofferError::invalid("Require master password every 1 to 365 days."));
    }
    if !s.hotkey_quick.is_empty() {
        crate::hotkeys::parse(&s.hotkey_quick).map_err(|e| CofferError::invalid(format!("Quick Access shortcut: {e}")))?;
    }
    if let Some(lock) = &s.hotkey_lock {
        crate::hotkeys::parse(lock).map_err(|e| CofferError::invalid(format!("Lock shortcut: {e}")))?;
        if !s.hotkey_quick.is_empty() && crate::hotkeys::same(lock, &s.hotkey_quick) {
            return Err(CofferError::invalid("The Lock shortcut and the Quick Access shortcut must differ."));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The keys of `interface Settings` in `src/lib/contract.ts`.
    fn contract_settings_keys() -> Vec<String> {
        let ts = include_str!("../../src/lib/contract.ts");
        let start = ts.find("export interface Settings {").expect("Settings in contract");
        let body = &ts[start..];
        let body = &body[..body.find('}').unwrap()];
        body.lines()
            .skip(1)
            .filter_map(|l| {
                let l = l.trim();
                let key = l.split(':').next()?.trim().trim_end_matches('?');
                (!key.is_empty() && !key.starts_with("//")).then(|| key.to_string())
            })
            .collect()
    }

    #[test]
    fn defaults_match_the_contract_comments() {
        let v = serde_json::to_value(Settings::default()).unwrap();
        assert_eq!(
            v,
            json!({
                "autoLockMinutes": 10,
                "lockOnSystemLock": true,
                "lockOnSleep": true,
                "clipboardClearSeconds": 90,
                "captureProtection": true,
                "helloEnabled": false,
                "requirePasswordDays": 14,
                "startWithWindows": true,
                "startHidden": true,
                "trayClick": "quick",
                "hotkeyQuick": "Ctrl+Shift+Space",
                "hotkeyLock": null,
                "breachCheck": "off",
                "closeNoticeShown": false,
                "closeBehavior": "hide",
                "quickHintsShown": 0
            })
        );
    }

    #[test]
    fn keys_are_exactly_the_contract_keys() {
        let mut ours = setting_keys();
        let mut theirs = contract_settings_keys();
        ours.sort();
        theirs.sort();
        assert_eq!(ours, theirs);
    }

    #[test]
    fn file_round_trip_and_missing_keys_take_defaults() {
        let mut file = SettingsFile::default();
        file.settings.tray_click = TrayClick::Main;
        file.settings.auto_lock_minutes = None;
        file.vault_id = Some("12345678-9abc-def0-0123-456789abcdef".into());
        file.vault_path = Some("C:\\Users\\x\\Coffer\\Personal.coffer".into());
        let text = serde_json::to_string(&file).unwrap();
        assert!(text.contains("\"vaultPath\""));
        assert!(text.contains("\"trayClick\":\"main\""));
        assert!(text.contains("\"autoLockMinutes\":null"));
        let back: SettingsFile = serde_json::from_str(&text).unwrap();
        assert_eq!(back, file);

        // A v2 file with the removed key still loads.
        let partial: SettingsFile = serde_json::from_str(r#"{"version":1,"lockOnSleep":false,"excludeFromClipboardHistory":true}"#).unwrap();
        assert!(!partial.settings.lock_on_sleep);
        assert_eq!(partial.settings.clipboard_clear_seconds, Some(90));
        assert_eq!(partial.vault_path, None);
    }

    #[test]
    fn patch_merges_validates_and_rejects_unknown_keys() {
        let base = Settings::default();
        let next = apply_patch(&base, &json!({ "autoLockMinutes": null, "trayClick": "main", "hotkeyLock": "Ctrl+Shift+L" })).unwrap();
        assert_eq!(next.auto_lock_minutes, None);
        assert_eq!(next.tray_click, TrayClick::Main);
        assert_eq!(next.hotkey_lock.as_deref(), Some("Ctrl+Shift+L"));
        assert_eq!(next.clipboard_clear_seconds, Some(90));

        assert!(apply_patch(&base, &json!({ "vaultPath": "x" })).is_err());
        assert!(apply_patch(&base, &json!({ "vaultId": "x" })).is_err());
        assert!(apply_patch(&base, &json!({ "helloEnabled": true })).is_err());
        assert!(apply_patch(&base, &json!({ "excludeFromClipboardHistory": false })).is_err(), "removed in spec v3");
        assert!(apply_patch(&base, &json!({ "autoLockMinutes": 7 })).is_err());
        assert!(apply_patch(&base, &json!({ "clipboardClearSeconds": 45 })).is_err());
        assert!(apply_patch(&base, &json!({ "trayClick": "both" })).is_err());
        assert!(apply_patch(&base, &json!({ "hotkeyQuick": "Space" })).is_err());
        assert!(apply_patch(&base, &json!({ "hotkeyLock": "ctrl+shift+space" })).is_err());
        assert!(apply_patch(&base, &json!([1])).is_err());
        // An empty Quick Access shortcut turns it off.
        assert_eq!(apply_patch(&base, &json!({ "hotkeyQuick": "" })).unwrap().hotkey_quick, "");
    }

    #[test]
    fn a_bad_file_falls_back_to_defaults() {
        let dir = std::env::temp_dir().join(format!("coffer-settings-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        let (_, first) = load(&path);
        assert!(first);
        std::fs::write(&path, b"{ not json").unwrap();
        let (file, first) = load(&path);
        assert!(!first);
        assert_eq!(file, SettingsFile::default());
        let kept = std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).any(|e| e.file_name().to_string_lossy().starts_with("settings.json.bad-"));
        assert!(kept);
        save(&path, &file).unwrap();
        assert_eq!(load(&path).0, file);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
