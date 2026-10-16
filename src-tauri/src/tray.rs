//! Tray icon and menu (SPEC 9).

use tauri::image::Image;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Rect, Wry};

use crate::contract::{LockReason, MainView};
use crate::shell;
use crate::state::{AppState, LockExt};

#[derive(Clone)]
pub struct TrayHandles {
    pub tray: TrayIcon,
    pub copy_new: MenuItem<Wry>,
    pub lock: MenuItem<Wry>,
}

const LOCKED: [&[u8]; 4] = [
    include_bytes!("../icons/tray/locked-16.png"),
    include_bytes!("../icons/tray/locked-20.png"),
    include_bytes!("../icons/tray/locked-24.png"),
    include_bytes!("../icons/tray/locked-32.png"),
];
const UNLOCKED: [&[u8]; 4] = [
    include_bytes!("../icons/tray/unlocked-16.png"),
    include_bytes!("../icons/tray/unlocked-20.png"),
    include_bytes!("../icons/tray/unlocked-24.png"),
    include_bytes!("../icons/tray/unlocked-32.png"),
];

/// Index into the 16/20/24/32 px icons for a DPI (96 = 100 %).
pub fn icon_index(dpi: u32) -> usize {
    let px = (16 * dpi).div_ceil(96);
    match px {
        0..=16 => 0,
        17..=20 => 1,
        21..=24 => 2,
        _ => 3,
    }
}

fn icon(unlocked: bool) -> tauri::Result<Image<'static>> {
    let set = if unlocked { &UNLOCKED } else { &LOCKED };
    Image::from_bytes(set[icon_index(crate::win::monitor::system_dpi())])
}

pub fn tooltip(unlocked: bool) -> &'static str {
    if unlocked { "Coffer: unlocked" } else { "Coffer: locked" }
}

pub fn lock_label(unlocked: bool) -> &'static str {
    if unlocked { "Lock" } else { "Unlock..." }
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let unlocked = app.state::<AppState>().is_unlocked();
    let open = MenuItem::with_id(app, "open", "Open Coffer", true, None::<&str>)?;
    let quick = MenuItem::with_id(app, "quick", "Quick Access", true, None::<&str>)?;
    let copy_new = MenuItem::with_id(app, "copy_new", "Copy a new password", unlocked, None::<&str>)?;
    let lock = MenuItem::with_id(app, "lock", lock_label(unlocked), true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Coffer", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&open, &quick, &PredefinedMenuItem::separator(app)?, &copy_new, &lock, &PredefinedMenuItem::separator(app)?, &settings, &quit],
    )?;
    let tray = TrayIconBuilder::with_id("coffer")
        .icon(icon(unlocked)?)
        .tooltip(tooltip(unlocked))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(on_menu)
        .on_tray_icon_event(on_tray_event)
        .build(app)?;
    *app.state::<AppState>().tray.lck() = Some(TrayHandles { tray, copy_new, lock });
    Ok(())
}

/// Bring icon, tooltip and menu in line with the lock state.
pub fn refresh(app: &AppHandle) {
    let state = app.state::<AppState>();
    let unlocked = state.is_unlocked();
    // Clone out: the setters wait for the main thread, so no lock is held.
    let Some(handles) = state.tray.lck().clone() else { return };
    if let Ok(image) = icon(unlocked) {
        let _ = handles.tray.set_icon(Some(image));
    }
    let _ = handles.tray.set_tooltip(Some(tooltip(unlocked)));
    let _ = handles.copy_new.set_enabled(unlocked);
    let _ = handles.lock.set_text(lock_label(unlocked));
}

/// The tray icon's centre in physical pixels.
fn center(rect: &Rect) -> (i32, i32) {
    let p = rect.position.to_physical::<f64>(1.0);
    let s = rect.size.to_physical::<f64>(1.0);
    ((p.x + s.width / 2.0).round() as i32, (p.y + s.height / 2.0).round() as i32)
}

fn tray_center(app: &AppHandle) -> Option<(i32, i32)> {
    let tray = app.state::<AppState>().tray.lck().as_ref()?.tray.clone();
    tray.rect().ok().flatten().map(|r| center(&r))
}

fn on_tray_event(tray: &TrayIcon, event: TrayIconEvent) {
    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, rect, .. } = event {
        shell::on_tray_left_click(tray.app_handle(), Some(center(&rect)));
    }
}

fn on_menu(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        "open" => shell::show_main(app, None),
        "quick" => {
            let anchor = tray_center(app);
            shell::show_quick(app, shell::QuickOrigin::Tray(anchor));
        }
        "copy_new" => {
            // The last generator options of the vault; the value goes into
            // generator history and to the clipboard (SPEC 5, 3.9).
            let app = app.clone();
            let _ = std::thread::Builder::new().name("coffer-tray-copy".into()).spawn(move || {
                let generated = crate::vault::with_vault(&app, |v| {
                    let options = v.generator_options();
                    v.generate(&options)
                });
                match generated {
                    Ok(g) => {
                        let value = zeroize::Zeroizing::new(g.value.clone());
                        if let Err(e) = crate::vault::mutate(&app, |v| {
                            v.generator_copied(&value);
                            Ok(())
                        }) {
                            crate::log!("tray: generator history: {e}");
                        }
                        if let Err(e) = crate::clipboard::copy(&app, value, "New password") {
                            crate::log!("tray: copy failed: {e}");
                        }
                    }
                    Err(e) => crate::log!("tray: generate failed: {e}"),
                }
            });
        }
        "lock" => {
            if app.state::<AppState>().is_unlocked() {
                // Off the main thread: the lock waits for a save in progress.
                let app = app.clone();
                let _ = std::thread::Builder::new().name("coffer-tray-lock".into()).spawn(move || crate::lock::lock(&app, LockReason::Manual));
            } else {
                shell::show_main(app, None);
            }
        }
        "settings" => shell::show_main_view(app, MainView::Settings),
        "quit" => shell::request_quit(app),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn icon_size_follows_dpi() {
        assert_eq!(icon_index(96), 0);
        assert_eq!(icon_index(120), 1);
        assert_eq!(icon_index(144), 2);
        assert_eq!(icon_index(168), 3);
        assert_eq!(icon_index(192), 3);
        assert_eq!(icon_index(288), 3);
    }

    #[test]
    fn labels() {
        assert_eq!(tooltip(false), "Coffer: locked");
        assert_eq!(tooltip(true), "Coffer: unlocked");
        assert_eq!(lock_label(false), "Unlock...");
        assert_eq!(lock_label(true), "Lock");
    }
}
