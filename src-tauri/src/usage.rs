//! Usage data (SPEC 4): last used, use count and learned app-to-item links,
//! in `%LOCALAPPDATA%\Coffer\usage.json`, sealed whole with DPAPI (entropy
//! `coffer/v1/usage`). Not in the vault, so using an item never writes the
//! (maybe synced) vault file.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{CofferError, CofferResult};

const ENTROPY: &[u8] = b"coffer/v1/usage";

#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageEntry {
    pub last_used_at: String,
    pub use_count: u32,
    /// exe name (lower case) to the number of uses from that app.
    #[serde(default)]
    pub apps: BTreeMap<String, u32>,
}

#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageFile {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    items: BTreeMap<String, UsageEntry>,
}

pub struct UsageStore {
    /// `None` for an in-memory store (tests).
    path: Option<PathBuf>,
    data: UsageFile,
}

// `get`, `items_for_app` and `forget` are phase B API (suggestions, lastUsedAt).
#[allow(dead_code)]
impl UsageStore {
    /// Load and open usage.json; a missing or unreadable file starts empty.
    pub fn load(dir: &Path) -> Self {
        let path = dir.join("usage.json");
        let data = std::fs::read(&path)
            .ok()
            .and_then(|blob| match crate::win::dpapi::unprotect(&blob, ENTROPY) {
                Ok(plain) => serde_json::from_slice::<UsageFile>(&plain).ok(),
                Err(e) => {
                    crate::log!("usage: usage.json cannot be opened ({e}); starting empty");
                    None
                }
            })
            .unwrap_or_default();
        Self { path: Some(path), data }
    }

    #[cfg(test)]
    pub fn in_memory() -> Self {
        Self { path: None, data: UsageFile::default() }
    }

    fn save(&self) -> CofferResult<()> {
        let Some(path) = &self.path else { return Ok(()) };
        let plain = zeroize::Zeroizing::new(serde_json::to_vec(&UsageFile { version: 1, items: self.data.items.clone() }).map_err(|e| CofferError::io(e.to_string()))?);
        let sealed = crate::win::dpapi::protect(&plain, ENTROPY).map_err(CofferError::io)?;
        crate::paths::write_atomic(path, &sealed).map_err(|e| CofferError::io(format!("Coffer could not save usage.json: {e}")))
    }

    /// Record one use of `item_id` (a copy or an auto-type), from `app` (the
    /// foreground exe, if known), at `now` (ISO 8601 UTC). Saves.
    pub fn record(&mut self, item_id: &str, app: Option<&str>, now: &str) -> CofferResult<()> {
        let entry = self.data.items.entry(item_id.to_string()).or_default();
        entry.last_used_at = now.to_string();
        entry.use_count = entry.use_count.saturating_add(1);
        if let Some(app) = app.map(|a| a.trim().to_lowercase()).filter(|a| !a.is_empty()) {
            *entry.apps.entry(app).or_default() += 1;
        }
        self.save()
    }

    pub fn get(&self, item_id: &str) -> Option<&UsageEntry> {
        self.data.items.get(item_id)
    }

    /// Item ids used from `app`, most uses first, then most recent.
    pub fn items_for_app(&self, app: &str) -> Vec<String> {
        let app = app.trim().to_lowercase();
        let mut hits: Vec<(&String, u32, &str)> = self.data.items.iter().filter_map(|(id, e)| e.apps.get(&app).map(|n| (id, *n, e.last_used_at.as_str()))).collect();
        hits.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| b.2.cmp(a.2)).then_with(|| a.0.cmp(b.0)));
        hits.into_iter().map(|(id, _, _)| id.clone()).collect()
    }

    /// Drop usage of deleted items. Saves.
    pub fn forget(&mut self, item_ids: &[String]) -> CofferResult<()> {
        let before = self.data.items.len();
        for id in item_ids {
            self.data.items.remove(id);
        }
        if self.data.items.len() != before { self.save() } else { Ok(()) }
    }
}

/// Record a use through the app state (phase B calls this after a copy).
#[allow(dead_code)]
pub fn usage_record(app: &tauri::AppHandle, item_id: &str, exe: Option<&str>) -> CofferResult<()> {
    use crate::state::{AppState, LockExt};
    use tauri::Manager;
    app.state::<AppState>().usage.lck().record(item_id, exe, &crate::clock::now_iso())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_and_ranks_by_app() {
        let mut u = UsageStore::in_memory();
        u.record("a", Some("Chrome.exe"), "2026-10-16T01:00:00Z").unwrap();
        u.record("b", Some("chrome.exe"), "2026-10-16T02:00:00Z").unwrap();
        u.record("b", Some("chrome.exe"), "2026-10-16T03:00:00Z").unwrap();
        u.record("c", Some("slack.exe"), "2026-10-16T04:00:00Z").unwrap();
        u.record("d", Some("chrome.exe"), "2026-10-16T05:00:00Z").unwrap();
        u.record("e", None, "2026-10-16T06:00:00Z").unwrap();
        assert_eq!(u.items_for_app("chrome.exe"), vec!["b", "d", "a"]);
        assert_eq!(u.items_for_app("SLACK.EXE"), vec!["c"]);
        assert!(u.items_for_app("code.exe").is_empty());
        let b = u.get("b").unwrap();
        assert_eq!((b.use_count, b.last_used_at.as_str()), (2, "2026-10-16T03:00:00Z"));
        assert!(u.get("e").unwrap().apps.is_empty());
        u.forget(&["b".to_string()]).unwrap();
        assert_eq!(u.items_for_app("chrome.exe"), vec!["d", "a"]);
    }

    #[test]
    fn file_is_sealed_and_reloads() {
        let dir = std::env::temp_dir().join(format!("coffer-usage-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut u = UsageStore::load(&dir);
        u.record("item-1", Some("notepad.exe"), "2026-10-16T01:00:00Z").unwrap();
        let raw = std::fs::read(dir.join("usage.json")).unwrap();
        assert!(!raw.windows(6).any(|w| w == b"item-1"));
        let again = UsageStore::load(&dir);
        assert_eq!(again.get("item-1").unwrap().use_count, 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
