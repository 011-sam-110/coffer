//! Usage data (SPEC 4): last used, use count and learned app-to-item links,
//! in `%LOCALAPPDATA%\Coffer\usage.json`, sealed whole with DPAPI (entropy
//! `coffer/v1/usage`). Not in the vault, so using an item never writes the
//! (maybe synced) vault file.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{CofferError, CofferResult};

const ENTROPY: &[u8] = b"coffer/v1/usage";
/// Learned app-to-item links kept per app (SPEC 9).
pub const LINKS_PER_APP: usize = 10;

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
            *entry.apps.entry(app.clone()).or_default() += 1;
            self.cap_links(&app, item_id);
        }
        self.save()
    }

    /// Keep at most `LINKS_PER_APP` items linked to `app`: drop the link with
    /// the fewest uses (then the oldest), never the one just used.
    fn cap_links(&mut self, app: &str, keep: &str) {
        loop {
            let linked: Vec<(String, u32, String)> =
                self.data.items.iter().filter_map(|(id, e)| e.apps.get(app).map(|n| (id.clone(), *n, e.last_used_at.clone()))).collect();
            if linked.len() <= LINKS_PER_APP {
                return;
            }
            let victim = linked.iter().filter(|(id, _, _)| id != keep).min_by(|a, b| a.1.cmp(&b.1).then_with(|| a.2.cmp(&b.2))).map(|(id, _, _)| id.clone());
            let Some(victim) = victim else { return };
            if let Some(e) = self.data.items.get_mut(&victim) {
                e.apps.remove(app);
            }
        }
    }

    /// item id -> last use time, for `lastUsedAt` and suggestion ties.
    pub fn last_used_map(&self) -> std::collections::HashMap<String, String> {
        self.data.items.iter().filter(|(_, e)| !e.last_used_at.is_empty()).map(|(id, e)| (id.clone(), e.last_used_at.clone())).collect()
    }

    #[cfg(test)]
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

/// Record a use through the app state.
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
    fn at_most_ten_items_per_app() {
        let mut u = UsageStore::in_memory();
        for i in 0..12 {
            u.record(&format!("item-{i:02}"), Some("slack.exe"), &format!("2026-10-16T01:00:{i:02}Z")).unwrap();
        }
        let linked = u.items_for_app("slack.exe");
        assert_eq!(linked.len(), LINKS_PER_APP);
        assert!(linked.contains(&"item-11".to_string()), "the newest stays");
        assert!(!linked.contains(&"item-00".to_string()) && !linked.contains(&"item-01".to_string()), "the oldest single uses go");
        assert_eq!(u.get("item-00").unwrap().use_count, 1, "the use itself is kept");
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
