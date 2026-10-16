//! A small append-only log in `%LOCALAPPDATA%\Coffer\coffer.log`.
//!
//! Never log a secret value, a window title or a file's contents: only events
//! and states ("tray ready", "lock reason=idle").

use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

static LOG_PATH: OnceLock<Option<PathBuf>> = OnceLock::new();
static LOG_LOCK: Mutex<()> = Mutex::new(());
const MAX_BYTES: u64 = 1024 * 1024;

/// Set the log folder once at start. Rotates a log over 1 MiB to `coffer.log.1`.
pub fn init(dir: &std::path::Path) {
    let path = dir.join("coffer.log");
    if std::fs::metadata(&path).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
        let _ = std::fs::rename(&path, dir.join("coffer.log.1"));
    }
    let _ = LOG_PATH.set(std::fs::create_dir_all(dir).ok().map(|_| path));
}

pub fn line(message: &str) {
    let text = format!("{} [{}] {}\n", crate::clock::now_iso(), std::process::id(), message);
    if cfg!(debug_assertions) {
        eprint!("coffer: {text}");
    }
    let Some(Some(path)) = LOG_PATH.get() else { return };
    let _guard = LOG_LOCK.lock();
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = file.write_all(text.as_bytes());
    }
}

/// `log!("tray ready: {}", x)`: format and write one log line.
#[macro_export]
macro_rules! log {
    ($($arg:tt)*) => { $crate::logging::line(&format!($($arg)*)) };
}
