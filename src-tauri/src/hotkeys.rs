//! Global hotkeys (SPEC 9): Quick Access (default Ctrl+Shift+Space) and Lock
//! (default off). `apply` re-registers both from the settings.

use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::contract::{HotkeyState, HotkeyStatus, LockReason};
use crate::state::{AppState, LockExt, RwExt};

/// Parse "Ctrl+Shift+Space". A global hotkey needs Ctrl, Alt or Win, so it
/// cannot swallow plain typing.
pub fn parse(text: &str) -> Result<Shortcut, String> {
    let shortcut: Shortcut = text.trim().parse().map_err(|e| format!("\"{text}\" is not a key combination ({e})."))?;
    if !shortcut.mods.intersects(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SUPER) {
        return Err(format!("\"{text}\" needs Ctrl, Alt or Win."));
    }
    Ok(shortcut)
}

/// Whether two texts name the same key combination.
pub fn same(a: &str, b: &str) -> bool {
    matches!((parse(a), parse(b)), (Ok(x), Ok(y)) if x.id() == y.id())
}

#[derive(Clone, Copy, Debug)]
enum Action {
    Quick,
    Lock,
}

/// Unregister all, then register the hotkeys in the settings. Stores and
/// returns the status for `app_info().hotkeyStatus`. Do not call on the main
/// thread while it waits for something (the plugin runs on the main thread).
pub fn apply(app: &AppHandle) -> HotkeyStatus {
    let (quick, lock) = {
        let state = app.state::<AppState>();
        let s = state.settings.rd();
        (s.settings.hotkey_quick.clone(), s.settings.hotkey_lock.clone())
    };
    let gs = app.global_shortcut();
    if let Err(e) = gs.unregister_all() {
        crate::log!("hotkeys: unregister_all failed: {e}");
    }
    let status = HotkeyStatus { quick: register(app, &quick, Action::Quick), lock: lock.as_deref().map_or(HotkeyState::Off, |l| register(app, l, Action::Lock)) };
    *app.state::<AppState>().hotkeys.lck() = status;
    crate::log!("hotkeys: quick={:?} lock={:?}", status.quick, status.lock);
    status
}

fn register(app: &AppHandle, text: &str, action: Action) -> HotkeyState {
    if text.trim().is_empty() {
        return HotkeyState::Off;
    }
    let shortcut = match parse(text) {
        Ok(s) => s,
        Err(e) => {
            crate::log!("hotkeys: {action:?}: {e}");
            return HotkeyState::Off;
        }
    };
    let result = app.global_shortcut().on_shortcut(shortcut, move |app, _shortcut, event| {
        if event.state != ShortcutState::Pressed {
            return;
        }
        match action {
            Action::Quick => crate::shell::toggle_quick(app, crate::shell::QuickOrigin::Hotkey),
            Action::Lock => crate::lock::lock(app, LockReason::Manual),
        }
    });
    match result {
        Ok(()) => HotkeyState::Ok,
        Err(e) => {
            crate::log!("hotkeys: {action:?} \"{text}\" could not be registered (in use?): {e}");
            HotkeyState::InUse
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_defaults_and_rejects_bare_keys() {
        assert!(parse("Ctrl+Shift+Space").is_ok());
        assert!(parse("ctrl+shift+space").is_ok());
        assert!(parse("Ctrl+Shift+L").is_ok());
        assert!(parse("Alt+F9").is_ok());
        assert!(parse("Space").is_err());
        assert!(parse("Shift+A").is_err());
        assert!(parse("Ctrl+Shift+").is_err());
        assert!(parse("Ctrl+Banana").is_err());
        assert!(same("Ctrl+Shift+Space", "shift+ctrl+space"));
        assert!(!same("Ctrl+Shift+Space", "Ctrl+Shift+L"));
    }
}
