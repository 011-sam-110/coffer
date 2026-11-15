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

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use coffer_core::CoreError;
use coffer_core::site::LoginRef;
use tauri::{AppHandle, Emitter, Manager};
use zeroize::Zeroizing;

use crate::contract::{BridgeInfo, events};
use crate::error::{CofferError, CofferResult, ErrorCode};
use crate::state::{AppState, LockExt, RwExt};

pub use gate::Core;
use gate::{LoginFill, VaultErr};

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

    fn logins(&self) -> Option<Vec<LoginRef>> {
        let state = self.0.state::<AppState>();
        let guard = state.session.lck();
        guard.as_ref().map(|s| s.vault.login_refs())
    }

    fn last_used(&self) -> HashMap<String, String> {
        self.0.state::<AppState>().usage.lck().last_used_map()
    }

    fn login_fill(&self, id: &str) -> Result<LoginFill, VaultErr> {
        let state = self.0.state::<AppState>();
        let mut guard = state.session.lck();
        let s = guard.as_mut().ok_or(VaultErr::Locked)?;
        s.vault.login_fill(id).map_err(vault_err)
    }

    fn copy_totp(&self, id: &str) -> Result<Option<u32>, VaultErr> {
        let code = {
            let state = self.0.state::<AppState>();
            let mut guard = state.session.lck();
            let s = guard.as_mut().ok_or(VaultErr::Locked)?;
            Zeroizing::new(s.vault.totp_code(id, None, None).map_err(vault_err)?.code)
        };
        // Coffer's own clipboard rules: kept out of clipboard history, cleared after the set time.
        crate::clipboard::copy(self.0, code, "One-time code").map(|r| r.clears_in_seconds).map_err(|e| VaultErr::Failed(e.message))
    }

    fn used(&self, id: &str) {
        if let Err(e) = crate::usage::usage_record(self.0, id, None) {
            crate::log!("usage: {e}");
        }
    }
}

fn vault_err(e: CoreError) -> VaultErr {
    match e {
        CoreError::RepromptRequired => VaultErr::Reprompt,
        CoreError::NotFound => VaultErr::NotFound,
        other => VaultErr::Failed(CofferError::from(other).message),
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
        reprompt: core.pending_reprompt(),
    }
}

/// The master-password question of a fill: the password (the item's grant
/// starts, and the browser gets the login), or `None` for Cancel.
pub fn reprompt_answer(app: &AppHandle, request_id: &str, password: Option<&str>) -> CofferResult<BridgeInfo> {
    let core = &app.state::<BridgeState>().0;
    match password {
        None => core.reprompt_answer(&AppHost(app), request_id, false)?,
        Some(pw) => {
            let item = core.reprompt_item(request_id).ok_or_else(|| CofferError::new(ErrorCode::NotFound, "This request from the browser is no longer open."))?;
            // A wrong password answers badCredentials and keeps the question open.
            crate::vault::with_vault(app, |v| v.grant(&item, pw))?;
            core.reprompt_answer(&AppHost(app), request_id, true)?;
        }
    }
    Ok(info(app))
}

/// Coffer locked: a waiting fill gets `locked`, and the question closes.
pub fn on_lock(app: &AppHandle) {
    if let Some(b) = app.try_state::<BridgeState>() {
        b.0.reprompt_gone(&AppHost(app));
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
