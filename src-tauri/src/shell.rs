//! Windows of the app: creation (with the navigation guards of SPEC 3.7),
//! Quick Access show/hide/placement, the main window, close and quit.

use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use tauri::webview::{NewWindowResponse, PageLoadEvent, PermissionResponse};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, Url, WebviewWindow, WebviewWindowBuilder, Window, WindowEvent};

use crate::contract::{Empty, LockReason, MainView, NavigateEvent, QuickContext, events};
use crate::placement;
use crate::settings::CloseBehavior;
use crate::state::{AppState, LockExt, RwExt};

pub const MAIN: &str = "main";
pub const QUICK: &str = "quick";

/// A tray click within this long after focus loss hid Quick Access does not
/// reopen it (the click that took the focus away is the same click).
pub const TRAY_REOPEN_GUARD: Duration = Duration::from_millis(300);

#[derive(Debug, Clone, Copy)]
pub enum QuickOrigin {
    /// Tray icon click or tray menu; the icon centre in physical pixels if known.
    Tray(Option<(i32, i32)>),
    /// The global hotkey: centre on the monitor of the stored foreground window.
    Hotkey,
}

/// The app origins a webview may navigate to: `http(s)://tauri.localhost`
/// and, in dev builds, the dev server.
pub fn navigation_allowed(url: &Url, dev_origin: Option<&str>) -> bool {
    let origin = url.origin().ascii_serialization();
    origin == "http://tauri.localhost" || origin == "https://tauri.localhost" || dev_origin == Some(origin.as_str())
}

/// Whether a tray click may open Quick Access now.
pub fn tray_click_allowed(last_blur_hide: Option<Instant>, now: Instant) -> bool {
    last_blur_hide.is_none_or(|t| now.saturating_duration_since(t) >= TRAY_REOPEN_GUARD)
}

/// Whether the main window shows at start: always on first run or without a
/// vault, and on a manual launch; hidden when Windows started Coffer
/// (`--hidden`) and "start hidden" is on.
pub fn show_main_at_start(hidden_arg: bool, start_hidden: bool, has_vault: bool) -> bool {
    !(hidden_arg && start_hidden && has_vault)
}

/// Build the windows of tauri.conf.json (they have `"create": false`) with
/// the navigation and new-window guards, and harden their webviews.
pub fn create_windows(app: &AppHandle) -> tauri::Result<()> {
    let dev_origin = if tauri::is_dev() { app.config().build.dev_url.as_ref().map(|u| u.origin().ascii_serialization()) } else { None };
    for config in app.config().app.windows.clone() {
        let dev_origin = dev_origin.clone();
        let label = config.label.clone();
        let window = WebviewWindowBuilder::from_config(app, &config)?
            .on_navigation(move |url| {
                let ok = navigation_allowed(url, dev_origin.as_deref());
                if !ok {
                    crate::log!("navigation blocked in {label}: {}", url.scheme());
                }
                ok
            })
            .on_new_window(|_url, _features| NewWindowResponse::Deny)
            // Camera, microphone, location, notifications, clipboard read...: always no.
            .on_permission_request(|_webview, kind| {
                crate::log!("webview permission denied: {kind:?}");
                PermissionResponse::Deny
            })
            .on_page_load(|window, payload| {
                if payload.event() == PageLoadEvent::Finished {
                    crate::win::webview::on_page_loaded(&window);
                }
            })
            .build()?;
        crate::win::webview::harden(&window);
        // A window that was never shown reports a stale frame (a caption that
        // is not there), so Quick Access would land off by its height on the
        // first show. Recompute the frame now (create_windows runs on the main
        // thread, in setup).
        if let Ok(hwnd) = window.hwnd() {
            crate::win::capture::refresh_frame(hwnd.0 as isize);
        }
    }
    apply_capture_protection(app);
    Ok(())
}

/// Set or clear screen-capture exclusion on both windows from the setting.
pub fn apply_capture_protection(app: &AppHandle) {
    let on = app.state::<AppState>().settings.rd().settings.capture_protection;
    for label in [MAIN, QUICK] {
        let Some(window) = app.get_webview_window(label) else { continue };
        let Ok(hwnd) = window.hwnd() else { continue };
        let raw = hwnd.0 as isize;
        let label = label.to_string();
        let _ = app.run_on_main_thread(move || match crate::win::capture::set(raw, on) {
            Ok(()) => crate::log!("capture protection {label}: {on}"),
            Err(e) => crate::log!("capture protection {label}: {e}"),
        });
    }
}

// ---------- Quick Access ----------

pub fn quick_context(app: &AppHandle) -> QuickContext {
    let state = app.state::<AppState>();
    let fg = state.foreground.lck().clone();
    // Phase B: suggestions from the core (item apps + learned usage for fg.process).
    QuickContext { title: fg.as_ref().map(|f| f.title.clone()), process: fg.and_then(|f| f.process), suggestions: Vec::new() }
}

/// Place Quick Access; returns where its client area should be.
fn place_quick(window: &WebviewWindow, app: &AppHandle, origin: QuickOrigin) -> Option<(i32, i32)> {
    use crate::win::monitor;
    let (area, anchor) = match origin {
        QuickOrigin::Tray(Some(p)) => (monitor::from_point(p.0, p.1), Some(p)),
        QuickOrigin::Tray(None) => {
            let c = monitor::cursor();
            (c.and_then(|p| monitor::from_point(p.0, p.1)), c)
        }
        QuickOrigin::Hotkey => {
            let fg = app.state::<AppState>().foreground.lck().as_ref().map(|f| f.hwnd).filter(|h| crate::win::foreground::still_exists(*h));
            (fg.and_then(monitor::from_window).or_else(monitor::from_cursor), None)
        }
    };
    let Some(area) = area else {
        let _ = window.center();
        return None;
    };
    let (size, margin) = placement::scaled(area.scale);
    let at = |size: (i32, i32)| match anchor {
        Some(a) => placement::near_tray(area.work, a, size, margin),
        None => placement::centered(area.work, size),
    };
    // First move: onto the target monitor (the window takes that monitor's
    // scale, so its size can change).
    let first = at(size);
    let _ = window.set_position(PhysicalPosition::new(first.0, first.1));
    // Then place the client area, which is what the user sees: an undecorated
    // window with a shadow has invisible borders outside it.
    let Ok(inner_size) = window.inner_size() else { return None };
    let client = at((inner_size.width as i32, inner_size.height as i32));
    move_client_to(window, client);
    Some(client)
}

/// Move the window so its client area's top-left is at `client`.
fn move_client_to(window: &WebviewWindow, client: (i32, i32)) {
    let (Ok(outer), Ok(inner)) = (window.outer_position(), window.inner_position()) else { return };
    let target = placement::window_for_client(client, (outer.x, outer.y), (inner.x, inner.y));
    if target != (outer.x, outer.y) {
        let _ = window.set_position(PhysicalPosition::new(target.0, target.1));
    }
}

pub fn show_quick(app: &AppHandle, origin: QuickOrigin) {
    let Some(window) = app.get_webview_window(QUICK) else { return };
    place_quick(&window, app, origin);
    app.state::<AppState>().quick.lck().modal = false;
    let _ = window.show();
    let _ = window.set_focus();
    let _ = app.emit_to(QUICK, events::QUICK_SHOWN, quick_context(app));
}

pub fn hide_quick(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(QUICK) {
        app.state::<AppState>().quick.lck().modal = false;
        let _ = window.hide();
    }
}

pub fn toggle_quick(app: &AppHandle, origin: QuickOrigin) {
    let Some(window) = app.get_webview_window(QUICK) else { return };
    let visible = window.is_visible().unwrap_or(false);
    match origin {
        QuickOrigin::Tray(_) => {
            if visible {
                hide_quick(app);
            } else if tray_click_allowed(app.state::<AppState>().quick.lck().last_blur_hide, Instant::now()) {
                show_quick(app, origin);
            }
        }
        QuickOrigin::Hotkey => {
            if visible && window.is_focused().unwrap_or(false) {
                hide_quick(app);
            } else {
                show_quick(app, origin);
            }
        }
    }
}

fn on_quick_blur(app: &AppHandle) {
    let Some(window) = app.get_webview_window(QUICK) else { return };
    let visible = window.is_visible().unwrap_or(false);
    let state = app.state::<AppState>();
    let mut quick = state.quick.lck();
    if quick.modal || !visible {
        return;
    }
    quick.last_blur_hide = Some(Instant::now());
    drop(quick);
    let _ = window.hide();
}

/// Left click on the tray icon: Quick Access or the main window, per setting.
pub fn on_tray_left_click(app: &AppHandle, icon_center: Option<(i32, i32)>) {
    let to_main = app.state::<AppState>().settings.rd().settings.tray_click == crate::settings::TrayClick::Main;
    if to_main {
        toggle_main(app);
    } else {
        toggle_quick(app, QuickOrigin::Tray(icon_center));
    }
}

// ---------- main window ----------

/// Show and focus the main window; with `nav`, tell it where to go.
pub fn show_main(app: &AppHandle, nav: Option<NavigateEvent>) {
    hide_quick(app);
    let Some(window) = app.get_webview_window(MAIN) else { return };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    if let Some(nav) = nav {
        let _ = app.emit_to(MAIN, events::MAIN_NAVIGATE, nav);
    }
}

pub fn show_main_view(app: &AppHandle, view: MainView) {
    show_main(app, Some(NavigateEvent { item_id: None, view: Some(view) }));
}

pub fn hide_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.hide();
    }
}

fn toggle_main(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN) else { return };
    if window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false) && !window.is_minimized().unwrap_or(false) {
        hide_main(app);
    } else {
        show_main(app, None);
    }
}

/// The close button of the main window (SPEC 9): hide to the tray, or quit.
/// The first hide keeps the window open and asks the UI for the tray notice
/// (`main://closeNotice`); the UI hides the window with `main_hide`.
fn on_main_close(app: &AppHandle) {
    let state = app.state::<AppState>();
    let (behavior, notice_shown) = {
        let s = state.settings.rd();
        (s.settings.close_behavior, s.settings.close_notice_shown)
    };
    match behavior {
        CloseBehavior::Quit => request_quit(app),
        CloseBehavior::Hide if notice_shown => hide_main(app),
        CloseBehavior::Hide => {
            let file = {
                let mut s = state.settings.wr();
                s.settings.close_notice_shown = true;
                s.clone()
            };
            if let Err(e) = crate::settings::save(&state.settings_path(), &file) {
                crate::log!("settings: {e}");
            }
            let _ = app.emit_to(MAIN, events::MAIN_CLOSE_NOTICE, Empty {});
        }
    }
}

pub fn on_window_event(window: &Window, event: &WindowEvent) {
    let app = window.app_handle();
    match (window.label(), event) {
        (QUICK, WindowEvent::Focused(false)) => on_quick_blur(app),
        (QUICK, WindowEvent::CloseRequested { api, .. }) => {
            api.prevent_close();
            hide_quick(app);
        }
        (MAIN, WindowEvent::CloseRequested { api, .. }) => {
            if !app.state::<AppState>().quitting.load(Ordering::SeqCst) {
                api.prevent_close();
                on_main_close(app);
            }
        }
        _ => {}
    }
}

// ---------- quit ----------

/// Quit from the tray or the close button: with an unsaved edit, show the main
/// window and let the UI ask Save / Discard / Cancel (`app://quitRequested`;
/// the UI then calls `app_quit`). Otherwise quit now.
pub fn request_quit(app: &AppHandle) {
    if app.state::<AppState>().has_dirty_edit() {
        show_main(app, None);
        let _ = app.emit_to(MAIN, events::APP_QUIT_REQUESTED, Empty {});
    } else {
        quit(app);
    }
}

/// Lock (drops keys, clears Coffer's clipboard copy), then exit.
pub fn quit(app: &AppHandle) {
    app.state::<AppState>().quitting.store(true, Ordering::SeqCst);
    crate::lock::lock(app, LockReason::Quit);
    crate::log!("quit");
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_stays_on_the_app_origin() {
        let ok = |u: &str, dev: Option<&str>| navigation_allowed(&Url::parse(u).unwrap(), dev);
        assert!(ok("http://tauri.localhost/index.html", None));
        assert!(ok("https://tauri.localhost/quick.html#x", None));
        assert!(!ok("http://localhost:1420/", None));
        assert!(ok("http://localhost:1420/quick.html", Some("http://localhost:1420")));
        assert!(!ok("https://example.com/", Some("http://localhost:1420")));
        assert!(!ok("http://tauri.localhost.evil.com/", None));
        assert!(!ok("file:///C:/Windows/win.ini", None));
        assert!(!ok("about:blank", None));
    }

    #[test]
    fn tray_click_guard_is_300_ms() {
        let t0 = Instant::now();
        assert!(tray_click_allowed(None, t0));
        assert!(!tray_click_allowed(Some(t0), t0 + Duration::from_millis(120)));
        assert!(!tray_click_allowed(Some(t0), t0 + Duration::from_millis(299)));
        assert!(tray_click_allowed(Some(t0), t0 + Duration::from_millis(300)));
    }

    #[test]
    fn start_visibility() {
        assert!(show_main_at_start(false, true, true), "manual launch shows the window");
        assert!(show_main_at_start(true, true, false), "no vault yet: show setup");
        assert!(show_main_at_start(true, false, true), "start hidden is off");
        assert!(!show_main_at_start(true, true, true), "autostart with a vault stays in the tray");
    }
}
