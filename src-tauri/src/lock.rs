//! The one lock path. Every lock signal (manual, idle, Windows lock, sleep,
//! display off, sign-out, quit) ends in `lock(app, reason)`.

use tauri::{AppHandle, Emitter, Manager};

use crate::contract::{EditDiscardedEvent, LockReason, LockedEvent, events};
use crate::settings::Settings;
use crate::state::{AppState, LockExt, RwExt};

/// A Windows signal that may lock Coffer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Signal {
    /// `WTS_SESSION_LOCK`.
    SessionLock,
    /// `PBT_APMSUSPEND`.
    Suspend,
    /// `GUID_CONSOLE_DISPLAY_STATE` = off.
    DisplayOff,
    /// `WM_QUERYENDSESSION`: sign-out or shutdown.
    EndSession,
}

/// The lock reason for a signal under these settings, or `None` to ignore it.
pub fn reason_for(signal: Signal, settings: &Settings) -> Option<LockReason> {
    match signal {
        Signal::SessionLock => settings.lock_on_system_lock.then_some(LockReason::SystemLock),
        Signal::Suspend | Signal::DisplayOff => settings.lock_on_sleep.then_some(LockReason::Sleep),
        Signal::EndSession => Some(LockReason::Quit),
    }
}

/// Whether the idle check locks now.
pub fn idle_should_lock(unlocked: bool, auto_lock_minutes: Option<u32>, idle_millis: u64) -> bool {
    match auto_lock_minutes {
        Some(m) if unlocked => idle_millis >= u64::from(m) * 60_000,
        _ => false,
    }
}

pub fn on_signal(app: &AppHandle, signal: Signal) {
    let reason = {
        let state = app.state::<AppState>();
        let settings = state.settings.rd();
        reason_for(signal, &settings.settings)
    };
    crate::log!("signal: {signal:?} -> {reason:?}");
    if let Some(reason) = reason {
        lock(app, reason);
    }
}

pub fn check_idle(app: &AppHandle, idle_millis: u64) {
    let state = app.state::<AppState>();
    let minutes = state.settings.rd().settings.auto_lock_minutes;
    if idle_should_lock(state.is_unlocked(), minutes, idle_millis) {
        lock(app, LockReason::Idle);
    }
}

/// Lock: drop the vault keys (phase B: the core session; a write in progress
/// holds the session lock, so this waits for it), clear the clipboard if it
/// still holds Coffer's copy, tell the UI, update the tray.
///
/// Emits `vault://locked` on every call, also when Coffer was already locked,
/// so the UI always ends on its locked screen.
pub fn lock(app: &AppHandle, reason: LockReason) {
    let state = app.state::<AppState>();
    let was_unlocked = state.session.lck().take().is_some();
    crate::clipboard::clear_if_ours(app);
    let discarded = state.edit.lck().take();
    if let Some(edit) = discarded.filter(|e| e.dirty) {
        let _ = app.emit(events::EDIT_DISCARDED, EditDiscardedEvent { title: edit.title });
    }
    crate::tray::refresh(app);
    let _ = app.emit(events::VAULT_LOCKED, LockedEvent { reason });
    crate::log!("lock: reason={reason:?} wasUnlocked={was_unlocked}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signals_follow_the_settings() {
        let mut s = Settings::default();
        assert_eq!(reason_for(Signal::SessionLock, &s), Some(LockReason::SystemLock));
        assert_eq!(reason_for(Signal::Suspend, &s), Some(LockReason::Sleep));
        assert_eq!(reason_for(Signal::DisplayOff, &s), Some(LockReason::Sleep));
        assert_eq!(reason_for(Signal::EndSession, &s), Some(LockReason::Quit));
        s.lock_on_system_lock = false;
        s.lock_on_sleep = false;
        assert_eq!(reason_for(Signal::SessionLock, &s), None);
        assert_eq!(reason_for(Signal::Suspend, &s), None);
        assert_eq!(reason_for(Signal::DisplayOff, &s), None);
        assert_eq!(reason_for(Signal::EndSession, &s), Some(LockReason::Quit));
    }

    #[test]
    fn idle_rule() {
        assert!(!idle_should_lock(false, Some(1), 10 * 60_000));
        assert!(!idle_should_lock(true, None, u64::MAX));
        assert!(!idle_should_lock(true, Some(10), 10 * 60_000 - 1));
        assert!(idle_should_lock(true, Some(10), 10 * 60_000));
        assert!(idle_should_lock(true, Some(1), 61_000));
    }
}
