//! Where Coffer keeps its device files.

use std::path::PathBuf;

/// `%LOCALAPPDATA%\Coffer`: settings.json, usage.json, device.json, the log.
/// `COFFER_DATA_DIR` overrides it (tests and dev runs; a same-user attacker is
/// out of scope, SPEC 3.1).
pub fn data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("COFFER_DATA_DIR").filter(|v| !v.is_empty()) {
        return PathBuf::from(dir);
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA").filter(|v| !v.is_empty()) {
        return PathBuf::from(local).join("Coffer");
    }
    home_dir().join("AppData").join("Local").join("Coffer")
}

/// `%USERPROFILE%`.
pub fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE").filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("C:\\"))
}

/// The default vault folder, `%USERPROFILE%\Coffer` (SPEC 3.5).
pub fn default_vault_folder() -> PathBuf {
    home_dir().join("Coffer")
}

/// The computer name for the Emergency Kit and `app_info`.
pub fn computer_name() -> String {
    std::env::var("COMPUTERNAME").ok().filter(|v| !v.is_empty()).unwrap_or_else(|| "This PC".to_string())
}

/// Write `bytes` to `path` atomically: a unique temp file in the same folder,
/// `sync_all`, then rename over the target (`MoveFileExW` with
/// `MOVEFILE_REPLACE_EXISTING` under the hood).
pub fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let dir = path.parent().ok_or_else(|| std::io::Error::other("path has no parent folder"))?;
    std::fs::create_dir_all(dir)?;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    let tmp = dir.join(format!("{name}.{}.{nanos}.tmp", std::process::id()));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_atomic_replaces_and_leaves_no_tmp() {
        let dir = std::env::temp_dir().join(format!("coffer-paths-test-{}", std::process::id()));
        let file = dir.join("a.json");
        write_atomic(&file, b"one").unwrap();
        write_atomic(&file, b"two").unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"two");
        let leftovers: Vec<_> = std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().ends_with(".tmp")).collect();
        assert!(leftovers.is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
