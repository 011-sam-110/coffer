//! WebView2 hardening per webview (SPEC 3.7), through `with_webview`:
//! browser accelerator keys off (Ctrl+P, Ctrl+R, F5, Ctrl+F, zoom keys, F12),
//! general autofill and password autosave off, default context menu off,
//! status bar off, page zoom (Ctrl + wheel) and touchpad pinch zoom off, and
//! no devtools in release builds.
//!
//! WebView2 applies `AreBrowserAcceleratorKeysEnabled` "after the next
//! navigation" (Microsoft's own sample says so), and Tauri does not pass
//! wry's builder option through. So each webview reloads once, after both the
//! settings are set and its first page has loaded, whichever comes last.

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::WebviewWindow;
use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2Controller, ICoreWebView2Settings3, ICoreWebView2Settings4, ICoreWebView2Settings5};
use windows::core::{BOOL, Interface};

#[derive(Default, Debug, Clone, Copy, PartialEq, Eq)]
pub struct Progress {
    pub applied: bool,
    pub loaded: bool,
    pub reloaded: bool,
}

impl Progress {
    /// Record a step; true when this step is the one that must trigger the reload.
    pub fn step(&mut self, applied: bool, loaded: bool) -> bool {
        self.applied |= applied;
        self.loaded |= loaded;
        if self.applied && self.loaded && !self.reloaded {
            self.reloaded = true;
            return true;
        }
        false
    }
}

static PROGRESS: Mutex<Option<HashMap<String, Progress>>> = Mutex::new(None);

fn step(label: &str, applied: bool, loaded: bool) -> bool {
    let mut guard = PROGRESS.lock().unwrap_or_else(|e| e.into_inner());
    guard.get_or_insert_with(HashMap::new).entry(label.to_string()).or_default().step(applied, loaded)
}

/// Apply the settings to `window`'s webview (runs on the main thread).
pub fn harden(window: &WebviewWindow) {
    let label = window.label().to_string();
    let result = window.with_webview(move |platform| {
        let controller = platform.controller();
        match unsafe { apply(&controller) } {
            Ok(keys_on) => crate::log!("webview {label}: hardened (browser accelerator keys enabled={keys_on})"),
            Err(e) => crate::log!("webview {label}: hardening failed: {e}"),
        }
        if step(&label, true, false) {
            crate::log!("webview {label}: reloading so the settings take effect");
            unsafe {
                if let Ok(core) = controller.CoreWebView2() {
                    let _ = core.Reload();
                }
            }
        }
    });
    if let Err(e) = result {
        crate::log!("webview: with_webview failed: {e}");
    }
}

/// Put the page zoom of `window` back to 100 % (Quick Access, on each open).
/// Zoom gestures are off, so this only undoes a zoom that came in some other way.
pub fn reset_zoom(window: &WebviewWindow) {
    let _ = window.with_webview(|platform| unsafe {
        let _ = platform.controller().SetZoomFactor(1.0);
    });
}

/// Call when a page of `window` has finished loading.
pub fn on_page_loaded(window: &WebviewWindow) {
    if step(window.label(), false, true) {
        crate::log!("webview {}: reloading so the settings take effect", window.label());
        let _ = window.reload();
    }
}

/// Returns the read-back value of `AreBrowserAcceleratorKeysEnabled`.
unsafe fn apply(controller: &ICoreWebView2Controller) -> windows::core::Result<bool> {
    unsafe {
        let core = controller.CoreWebView2()?;
        let settings = core.Settings()?;
        settings.SetAreDefaultContextMenusEnabled(false)?;
        settings.SetIsStatusBarEnabled(false)?;
        // A zoomed Quick Access cuts the item names, and a zoom lasts until Coffer restarts.
        settings.SetIsZoomControlEnabled(false)?;
        if !cfg!(debug_assertions) {
            settings.SetAreDevToolsEnabled(false)?;
        }
        let s3: ICoreWebView2Settings3 = settings.cast()?;
        s3.SetAreBrowserAcceleratorKeysEnabled(false)?;
        let s4: ICoreWebView2Settings4 = settings.cast()?;
        s4.SetIsGeneralAutofillEnabled(false)?;
        s4.SetIsPasswordAutosaveEnabled(false)?;
        let s5: ICoreWebView2Settings5 = settings.cast()?;
        s5.SetIsPinchZoomEnabled(false)?;
        let mut keys = BOOL::default();
        s3.AreBrowserAcceleratorKeysEnabled(&mut keys)?;
        Ok(keys.as_bool())
    }
}

#[cfg(test)]
mod tests {
    use super::Progress;

    #[test]
    fn reload_happens_once_after_both_steps_in_either_order() {
        let mut p = Progress::default();
        assert!(!p.step(true, false));
        assert!(p.step(false, true));
        assert!(!p.step(false, true));

        let mut p = Progress::default();
        assert!(!p.step(false, true));
        assert!(!p.step(false, true));
        assert!(p.step(true, false));
        assert!(!p.step(true, true));
    }
}
