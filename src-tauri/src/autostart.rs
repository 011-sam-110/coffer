//! Start with Windows (SPEC 9): the autostart plugin's Run-key entry, started
//! with `--hidden` so Coffer comes up in the tray only.

use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt;

/// Turn the Run-key entry on or off. Debug builds do not write it (a dev or QA
/// run would leave a Run entry that points at a build folder) unless
/// `COFFER_DEV_AUTOSTART=1`.
pub fn apply(app: &AppHandle, on: bool) {
    if cfg!(debug_assertions) && std::env::var_os("COFFER_DEV_AUTOSTART").is_none() {
        crate::log!("autostart: debug build, Run key left alone (wanted {on}; set COFFER_DEV_AUTOSTART=1 to write it)");
        return;
    }
    let manager = app.autolaunch();
    let result = if on { manager.enable() } else { manager.disable() };
    match result {
        Ok(()) => crate::log!("autostart: {}", if on { "on" } else { "off" }),
        Err(e) => crate::log!("autostart: could not turn {}: {e}", if on { "on" } else { "off" }),
    }
}
