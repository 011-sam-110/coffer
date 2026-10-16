//! Windows-only code (SPEC 12): DPAPI, clipboard, foreground tracking, lock
//! signals, monitors, capture affinity and WebView2 settings.

pub mod capture;
pub mod clipboard;
pub mod dpapi;
pub mod foreground;
pub mod fs;
pub mod hello;
pub mod monitor;
pub mod open;
pub mod signals;
pub mod webview;

use std::sync::OnceLock;

use tauri::AppHandle;

/// The app handle for Win32 callbacks (window procedures, WinEvent hooks),
/// which get no user data from Tauri.
static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn set_app(app: &AppHandle) {
    let _ = APP.set(app.clone());
}

pub fn app() -> Option<&'static AppHandle> {
    APP.get()
}

/// A Rust string as a NUL-terminated UTF-16 buffer.
pub fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}
