//! `FolderInfo` for the vault folder: exists, writable, and whether a cloud
//! sync tool syncs it (SPEC 3.5: `%OneDrive%`, `%OneDriveCommercial%`, a
//! Dropbox or a Google Drive folder).

use std::path::{Path, PathBuf};

use crate::contract::{FolderInfo, SyncProvider};

/// Known sync roots, normalised (see `normalize`).
#[derive(Debug, Default, Clone)]
pub struct SyncRoots {
    pub onedrive: Vec<String>,
    pub dropbox: Vec<String>,
    pub google: Vec<String>,
}

impl SyncRoots {
    /// From the environment and Dropbox's `info.json`.
    pub fn from_env() -> Self {
        let env = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        let onedrive = ["OneDrive", "OneDriveCommercial", "OneDriveConsumer"].iter().filter_map(|k| env(k)).map(|p| normalize(&p)).collect();
        let mut dropbox = Vec::new();
        for base in [env("APPDATA"), env("LOCALAPPDATA")].into_iter().flatten() {
            if let Ok(text) = std::fs::read_to_string(Path::new(&base).join("Dropbox").join("info.json")) {
                dropbox.extend(dropbox_paths(&text).iter().map(|p| normalize(p)));
            }
        }
        Self { onedrive, dropbox, google: Vec::new() }
    }
}

/// The `path` values of Dropbox's info.json (`{"personal": {"path": ...}, "business": {...}}`).
pub fn dropbox_paths(info_json: &str) -> Vec<String> {
    let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(info_json) else { return Vec::new() };
    map.values().filter_map(|v| v.get("path")?.as_str().map(str::to_string)).collect()
}

/// Lower case, backslashes, no `\\?\` prefix, no trailing separator.
pub fn normalize(path: &str) -> String {
    let mut p = path.trim().replace('/', "\\").to_lowercase();
    if let Some(rest) = p.strip_prefix("\\\\?\\") {
        p = rest.to_string();
    }
    while p.len() > 3 && p.ends_with('\\') {
        p.pop();
    }
    p
}

fn under(path: &str, root: &str) -> bool {
    !root.is_empty() && (path == root || path.strip_prefix(root).is_some_and(|rest| rest.starts_with('\\') || root.ends_with('\\')))
}

/// The sync provider of a folder, if any.
pub fn provider_for(path: &Path, roots: &SyncRoots) -> Option<SyncProvider> {
    let p = normalize(&path.to_string_lossy());
    if roots.onedrive.iter().any(|r| under(&p, r)) {
        return Some(SyncProvider::OneDrive);
    }
    if roots.dropbox.iter().any(|r| under(&p, r)) {
        return Some(SyncProvider::Dropbox);
    }
    if roots.google.iter().any(|r| under(&p, r)) {
        return Some(SyncProvider::GoogleDrive);
    }
    let parts: Vec<&str> = p.split('\\').filter(|s| !s.is_empty()).collect();
    for (i, part) in parts.iter().enumerate() {
        if *part == "onedrive" || part.starts_with("onedrive - ") {
            return Some(SyncProvider::OneDrive);
        }
        if *part == "dropbox" || part.starts_with("dropbox (") {
            return Some(SyncProvider::Dropbox);
        }
        if *part == "google drive" {
            return Some(SyncProvider::GoogleDrive);
        }
        // Google Drive for desktop mounts a drive letter with "My Drive" and "Shared drives".
        if i == 1 && parts[0].ends_with(':') && (*part == "my drive" || *part == "shared drives") {
            return Some(SyncProvider::GoogleDrive);
        }
    }
    None
}

/// Whether a file can be made in `dir` (made and removed again).
fn probe_writable(dir: &Path) -> bool {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    let probe = dir.join(format!(".coffer-write-test-{}-{nanos}", std::process::id()));
    match std::fs::OpenOptions::new().write(true).create_new(true).open(&probe) {
        Ok(file) => {
            drop(file);
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// `FolderInfo` for `dir`. A folder that does not exist yet is writable when
/// its nearest existing parent is (Coffer makes the folder on create).
pub fn folder_info(dir: &Path, roots: &SyncRoots) -> FolderInfo {
    let exists = dir.is_dir();
    let writable = if exists {
        probe_writable(dir)
    } else {
        let mut parent: Option<PathBuf> = dir.parent().map(Path::to_path_buf);
        while let Some(p) = &parent {
            if p.is_dir() {
                break;
            }
            parent = p.parent().map(Path::to_path_buf);
        }
        parent.is_some_and(|p| probe_writable(&p))
    };
    let provider = provider_for(dir, roots);
    FolderInfo { path: dir.to_string_lossy().into_owned(), exists, writable, synced: provider.is_some(), provider }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roots() -> SyncRoots {
        SyncRoots {
            onedrive: vec![normalize(r"C:\Users\sam\OneDrive"), normalize(r"C:\Users\sam\OneDrive - Contoso\")],
            dropbox: vec![normalize(r"D:\Sync\DB")],
            google: vec![],
        }
    }

    fn at(p: &str) -> Option<SyncProvider> {
        provider_for(Path::new(p), &roots())
    }

    #[test]
    fn detects_providers() {
        assert_eq!(at(r"C:\Users\sam\OneDrive"), Some(SyncProvider::OneDrive));
        assert_eq!(at(r"c:\users\SAM\onedrive\Documents\Coffer"), Some(SyncProvider::OneDrive));
        assert_eq!(at(r"C:\Users\sam\OneDrive - Contoso\Vault"), Some(SyncProvider::OneDrive));
        assert_eq!(at(r"D:\Sync\DB\keys"), Some(SyncProvider::Dropbox), "Dropbox moved, found via info.json");
        assert_eq!(at(r"C:\Users\sam\Dropbox\Coffer"), Some(SyncProvider::Dropbox));
        assert_eq!(at(r"C:\Users\sam\Dropbox (Acme)\x"), Some(SyncProvider::Dropbox));
        assert_eq!(at(r"G:\My Drive\Coffer"), Some(SyncProvider::GoogleDrive));
        assert_eq!(at(r"C:\Users\sam\Google Drive\Coffer"), Some(SyncProvider::GoogleDrive));
        assert_eq!(at(r"\\?\C:\Users\sam\OneDrive\x"), Some(SyncProvider::OneDrive));
    }

    #[test]
    fn plain_folders_are_not_synced() {
        assert_eq!(at(r"C:\Users\sam\Coffer"), None);
        assert_eq!(at(r"C:\Users\sam\OneDriveBackup"), None, "a prefix is not a parent");
        assert_eq!(at(r"D:\Sync\DBX"), None);
        assert_eq!(at(r"C:\Data\My Drive\x"), None, "My Drive only at a drive root");
    }

    #[test]
    fn reads_dropbox_info_json() {
        let text = r#"{"personal":{"path":"C:\\Users\\sam\\Dropbox","host":1},"business":{"path":"D:\\Work\\Dropbox (Acme)"}}"#;
        let mut paths = dropbox_paths(text);
        paths.sort();
        assert_eq!(paths, vec![r"C:\Users\sam\Dropbox".to_string(), r"D:\Work\Dropbox (Acme)".to_string()]);
        assert!(dropbox_paths("not json").is_empty());
    }

    #[test]
    fn folder_info_for_a_missing_folder_checks_the_parent() {
        let base = std::env::temp_dir().join(format!("coffer-folders-{}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();
        let info = folder_info(&base.join("not-yet").join("Coffer"), &SyncRoots::default());
        assert!(!info.exists);
        assert!(info.writable);
        assert!(!info.synced);
        let info = folder_info(&base, &SyncRoots::default());
        assert!(info.exists && info.writable);
        assert_eq!(std::fs::read_dir(&base).unwrap().count(), 0, "the write probe is removed");
        std::fs::remove_dir_all(&base).unwrap();
    }
}
