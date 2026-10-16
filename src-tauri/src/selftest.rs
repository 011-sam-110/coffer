//! Debug builds only: `COFFER_SELFTEST=1` drives the running app through its
//! Windows paths and writes the results to the log, then quits through the
//! same function as `app_quit`. It overwrites and then empties the clipboard.

use std::time::Duration;

use tauri::{AppHandle, Manager};
use zeroize::Zeroizing;

use crate::contract::LockReason;
use crate::shell::{self, QuickOrigin};
use crate::state::{AppState, LockExt};

pub fn maybe_start(app: &AppHandle) {
    if std::env::var_os("COFFER_SELFTEST").is_none() {
        return;
    }
    let app = app.clone();
    let _ = std::thread::Builder::new().name("coffer-selftest".into()).spawn(move || run(&app));
}

fn quick_report(app: &AppHandle, what: &str) {
    let Some(w) = app.get_webview_window(shell::QUICK) else { return };
    let outer = w.outer_position().map(|p| (p.x, p.y)).ok();
    let outer_size = w.outer_size().map(|s| (s.width, s.height)).ok();
    let inner = w.inner_position().map(|p| (p.x, p.y)).ok();
    let inner_size = w.inner_size().map(|s| (s.width, s.height)).ok();
    crate::log!(
        "selftest: quick {what}: visible={:?} focused={:?} outer={outer:?} {outer_size:?} client={inner:?} {inner_size:?}",
        w.is_visible().ok(),
        w.is_focused().ok()
    );
}

fn quick_visible(app: &AppHandle) -> Option<bool> {
    app.get_webview_window(shell::QUICK).and_then(|w| w.is_visible().ok())
}

/// Press and release Ctrl+Shift+Space with SendInput (the registered hotkey
/// takes it; no other app sees it).
fn press_quick_hotkey() -> u32 {
    use windows::Win32::UI::Input::KeyboardAndMouse::{INPUT, INPUT_0, INPUT_KEYBOARD, KEYBD_EVENT_FLAGS, KEYBDINPUT, KEYEVENTF_KEYUP, SendInput, VIRTUAL_KEY, VK_CONTROL, VK_SHIFT, VK_SPACE};
    let key = |vk: VIRTUAL_KEY, up: bool| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: vk, wScan: 0, dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) }, time: 0, dwExtraInfo: 0 } },
    };
    let inputs = [key(VK_CONTROL, false), key(VK_SHIFT, false), key(VK_SPACE, false), key(VK_SPACE, true), key(VK_SHIFT, true), key(VK_CONTROL, true)];
    unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) }
}

fn run(app: &AppHandle) {
    std::thread::sleep(Duration::from_secs(4));
    crate::log!("selftest: start");
    let state = app.state::<AppState>();
    quick_report(app, "hidden at start (frame refreshed at creation)");

    let fg = state.foreground.lck().clone();
    crate::log!("selftest: foreground stored={} process={:?}", fg.is_some(), fg.as_ref().and_then(|f| f.process.clone()));
    crate::log!("selftest: hotkeys {:?}", *state.hotkeys.lck());

    match crate::clipboard::copy(app, Zeroizing::new("coffer-selftest-value".to_string()), "Selftest") {
        Ok(r) => crate::log!("selftest: copy ok, clearsInSeconds={:?}", r.clears_in_seconds),
        Err(e) => crate::log!("selftest: copy failed: {e}"),
    }
    crate::log!("selftest: formats after copy [text, excludeMonitor, historyFlag, cloudFlag] = {:?}", crate::win::clipboard::formats_present());
    let cleared = crate::clipboard::clear_if_ours(app);
    crate::log!("selftest: clear_if_ours={cleared}; formats now {:?}", crate::win::clipboard::formats_present());

    shell::show_quick(app, QuickOrigin::Hotkey);
    std::thread::sleep(Duration::from_millis(1500));
    quick_report(app, "after hotkey show (centred)");
    shell::hide_quick(app);
    std::thread::sleep(Duration::from_millis(300));

    let work = crate::win::monitor::from_point(0, 0).map(|a| a.work);
    if let Some(w) = work {
        crate::log!("selftest: primary work area {w:?}");
        shell::show_quick(app, QuickOrigin::Tray(Some((w.right - 40, w.bottom + 20))));
        std::thread::sleep(Duration::from_millis(1500));
        quick_report(app, "after tray show (bottom-right)");
        shell::hide_quick(app);
    }

    // The real hotkey path: RegisterHotKey -> plugin -> toggle_quick.
    let ok = matches!(*state.hotkeys.lck(), crate::contract::HotkeyStatus { quick: crate::contract::HotkeyState::Ok, .. });
    if ok {
        std::thread::sleep(Duration::from_millis(500));
        let sent = press_quick_hotkey();
        std::thread::sleep(Duration::from_millis(1500));
        crate::log!("selftest: hotkey press sent={sent}; quick visible={:?}", quick_visible(app));
        quick_report(app, "after the hotkey");
        let sent = press_quick_hotkey();
        std::thread::sleep(Duration::from_millis(1000));
        crate::log!("selftest: hotkey press again sent={sent}; quick visible={:?} (expect false: toggled off)", quick_visible(app));
        shell::hide_quick(app);
    }

    crate::lock::lock(app, LockReason::Manual);
    std::thread::sleep(Duration::from_millis(300));
    crate::log!("selftest: done; quitting through app_quit's path");
    shell::quit(app);
}
