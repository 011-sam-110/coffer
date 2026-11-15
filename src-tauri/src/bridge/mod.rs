//! The browser bridge (docs/BRIDGE.md, SPEC 3.13, SECURITY.md section 12).
//!
//! Chrome or Edge starts coffer-bridge.exe for the Coffer extension; the
//! bridge passes each message over a named pipe that only this Windows user
//! can open (`server.rs`). The gate (`gate.rs`) answers `hello`, runs the
//! one-time Connect (`pairing.rs`: X25519, four words, Allow in Coffer) and
//! refuses every later call without the right MAC. The keys of connected
//! browsers live in browsers.json, sealed with DPAPI (`store.rs`).

mod gate;
mod pairing;
mod server;
mod store;

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager};

use crate::contract::{BridgeInfo, events};
use crate::error::{CofferError, CofferResult};
use crate::state::{AppState, RwExt};

pub use gate::Core;

/// Tauri state: the gate and the browsers.
pub struct BridgeState(pub Arc<Core>);

impl BridgeState {
    pub fn new(data_dir: &std::path::Path) -> Self {
        Self(Arc::new(Core::new(store::BrowserStore::new(data_dir))))
    }
}

/// The gate's view of the app.
pub(crate) struct AppHost<'a>(pub &'a AppHandle);

impl gate::Host for AppHost<'_> {
    fn version(&self) -> String {
        self.0.package_info().version.to_string()
    }

    fn locked(&self) -> bool {
        !self.0.state::<AppState>().is_unlocked()
    }

    fn offers(&self) -> (bool, bool) {
        let s = &self.0.state::<AppState>().settings;
        let s = s.rd();
        (s.settings.offer_save_logins, s.settings.offer_update_passwords)
    }

    fn open_unlock(&self) {
        crate::shell::show_main(self.0, None);
    }

    fn changed(&self, show: bool) {
        let _ = self.0.emit(events::BRIDGE_CHANGED, info(self.0));
        if show {
            crate::shell::show_main(self.0, None);
        }
    }

    fn now_iso(&self) -> String {
        crate::clock::now_iso()
    }
}

pub fn start(app: &AppHandle) {
    let core = app.state::<BridgeState>().0.clone();
    server::start(app, core);
}

/// `<install folder>\extension`: the folder to choose in Load unpacked.
pub fn extension_folder() -> PathBuf {
    let folder = coffer_bridge::pipe::own_folder().unwrap_or_default();
    let text = folder.to_string_lossy();
    PathBuf::from(text.strip_prefix(r"\\?\").unwrap_or(&text)).join("extension")
}

pub fn info(app: &AppHandle) -> BridgeInfo {
    let core = &app.state::<BridgeState>().0;
    let folder = extension_folder();
    BridgeInfo {
        browsers: core.store.list(),
        extension_found: folder.join("manifest.json").is_file(),
        extension_folder: folder.to_string_lossy().into_owned(),
        pending: core.pending_request(),
    }
}

pub fn answer(app: &AppHandle, pair_id: &str, allow: bool) -> CofferResult<BridgeInfo> {
    app.state::<BridgeState>().0.answer(&AppHost(app), pair_id, allow)?;
    Ok(info(app))
}

pub fn disconnect(app: &AppHandle, id: &str) -> CofferResult<BridgeInfo> {
    app.state::<BridgeState>().0.disconnect(&AppHost(app), id)?;
    Ok(info(app))
}

/// Copy the extension folder for Load unpacked. Not a secret: no clear timer.
pub fn copy_folder() -> CofferResult<()> {
    let folder = extension_folder();
    crate::win::clipboard::write_text(&folder.to_string_lossy(), false).map(|_| ()).map_err(|e| CofferError::io(format!("Coffer could not copy the folder: {e}")))
}
