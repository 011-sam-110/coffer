//! The one `AppState`, managed by Tauri.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard};
use std::time::Instant;

use crate::clipboard::ClipState;
use crate::contract::HotkeyStatus;
use crate::device::DeviceStore;
use crate::settings::SettingsFile;
use crate::tray::TrayHandles;
use crate::usage::UsageStore;
use crate::vault::{ImportState, OlderHold, Session, WatchState};

/// The main window's open edit, reported with `edit_state` (SPEC 9).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditState {
    pub title: String,
    pub dirty: bool,
}

/// The last foreground window that was not Coffer's (SPEC 9).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForegroundInfo {
    pub hwnd: isize,
    /// Never logged.
    pub title: String,
    pub process: Option<String>,
}

#[derive(Debug, Default)]
pub struct QuickState {
    /// Set by `quick_set_modal`: a prompt or dialog of Quick Access is up, so
    /// focus loss does not hide it. Reset whenever Quick Access shows or hides.
    pub modal: bool,
    /// When focus loss last hid Quick Access (for the 300 ms tray-click rule).
    pub last_blur_hide: Option<Instant>,
}

pub struct AppState {
    pub data_dir: PathBuf,
    pub settings: RwLock<SettingsFile>,
    /// `true` when there was no settings.json at start.
    #[allow(dead_code)]
    pub first_run: bool,
    /// The unlocked vault; `lock` drops it (and with it every key).
    pub session: Mutex<Option<Session>>,
    /// Mirrors `session.is_some()` for readers that must not wait on a save
    /// or a KDF run (tray, idle check).
    pub unlocked: AtomicBool,
    /// A verified older file waiting for `vault_open_older` (60 s).
    pub older: Mutex<Option<OlderHold>>,
    /// The vault file watcher's state.
    pub watch: Mutex<WatchState>,
    /// The backup files of the last `backups_list`, by index.
    pub backups_listed: Mutex<Vec<PathBuf>>,
    /// The last conflict copy Rust wrote (`import_preview` source "conflict").
    pub last_conflict: Mutex<Option<PathBuf>>,
    /// The import file and the preview waiting for `import_commit`.
    pub import: Mutex<ImportState>,
    pub clipboard: Mutex<ClipState>,
    pub foreground: Mutex<Option<ForegroundInfo>>,
    pub quick: Mutex<QuickState>,
    pub hotkeys: Mutex<HotkeyStatus>,
    pub tray: Mutex<Option<TrayHandles>>,
    /// The open edit, if any, reported by the main window with `edit_state`.
    pub edit: Mutex<Option<EditState>>,
    /// The folder `folder_pick` returned; `vault_create` with
    /// `usePickedFolder` uses it (the UI never sends a path).
    pub picked_folder: Mutex<Option<PathBuf>>,
    pub usage: Mutex<UsageStore>,
    pub device: Mutex<DeviceStore>,
    pub quitting: AtomicBool,
}

impl AppState {
    pub fn new(data_dir: PathBuf, settings: SettingsFile, first_run: bool) -> Self {
        Self {
            usage: Mutex::new(UsageStore::load(&data_dir)),
            device: Mutex::new(DeviceStore::new(&data_dir)),
            data_dir,
            settings: RwLock::new(settings),
            first_run,
            session: Mutex::new(None),
            unlocked: AtomicBool::new(false),
            older: Mutex::new(None),
            watch: Mutex::new(WatchState::default()),
            backups_listed: Mutex::new(Vec::new()),
            last_conflict: Mutex::new(None),
            import: Mutex::new(ImportState::default()),
            clipboard: Mutex::new(ClipState::default()),
            foreground: Mutex::new(None),
            quick: Mutex::new(QuickState::default()),
            hotkeys: Mutex::new(HotkeyStatus::default()),
            tray: Mutex::new(None),
            edit: Mutex::new(None),
            picked_folder: Mutex::new(None),
            quitting: AtomicBool::new(false),
        }
    }

    pub fn settings_path(&self) -> PathBuf {
        self.data_dir.join("settings.json")
    }

    pub fn is_unlocked(&self) -> bool {
        self.unlocked.load(Ordering::SeqCst)
    }

    /// Whether the main window has unsaved changes.
    pub fn has_dirty_edit(&self) -> bool {
        self.edit.lck().as_ref().is_some_and(|e| e.dirty)
    }
}

/// Lock a mutex or RwLock and carry on past poisoning (a panicked holder must
/// not take the lock path down with it).
pub trait LockExt<T> {
    fn lck(&self) -> MutexGuard<'_, T>;
}

impl<T> LockExt<T> for Mutex<T> {
    fn lck(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|e| e.into_inner())
    }
}

pub trait RwExt<T> {
    fn rd(&self) -> RwLockReadGuard<'_, T>;
    fn wr(&self) -> RwLockWriteGuard<'_, T>;
}

impl<T> RwExt<T> for RwLock<T> {
    fn rd(&self) -> RwLockReadGuard<'_, T> {
        self.read().unwrap_or_else(|e| e.into_inner())
    }
    fn wr(&self) -> RwLockWriteGuard<'_, T> {
        self.write().unwrap_or_else(|e| e.into_inner())
    }
}
