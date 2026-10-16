//! Windows Hello in-session unlock (SPEC 3.8, tier 2).
//!
//! Hello is a convenience gate, not encryption. With it on, a lock keeps the
//! vault key (VK) encrypted with `CryptProtectMemory(SAME_PROCESS)`, and a
//! Hello "Verified" opens the vault with it. The master password is needed
//! again after a restart (the key lives only in this process), after a
//! `keyChanged` lock, after `requirePasswordDays` without a password unlock,
//! and after Hello is turned off.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime};

use tauri::{AppHandle, Manager};
use zeroize::Zeroizing;

use crate::contract::{LockReason, VaultStatus};
use crate::error::{CofferError, CofferResult, ErrorCode};
use crate::state::{AppState, LockExt, RwExt};
use crate::vault::Session;
use crate::win::hello::ProtectedKey;

/// The held vault key and the vault it opens.
struct Held {
    vault_id: String,
    key_id: String,
    key: ProtectedKey,
}

#[derive(Default)]
pub struct HelloState {
    held: Option<Held>,
    /// The last time the master password was proven in this run.
    last_password: Option<SystemTime>,
    /// Hello is set up on this PC (`None` until the first check).
    available: Option<bool>,
}

/// A Hello prompt is up: Quick Access does not close on blur.
pub static PROMPTING: AtomicBool = AtomicBool::new(false);

pub const NOT_READY: &str = "Windows Hello works after one master-password unlock.";

/// The master password was just proven (unlock, create, password change,
/// turning Hello on).
pub fn password_proven(state: &AppState) {
    state.hello.lck().last_password = Some(SystemTime::now());
}

fn fresh(last: Option<SystemTime>, days: u32) -> bool {
    let limit = Duration::from_secs(u64::from(days) * 24 * 3600);
    last.and_then(|t| SystemTime::now().duration_since(t).ok()).is_some_and(|age| age < limit)
}

/// Ask Windows again whether Hello is set up (a WinRT call, about 0.1 s).
pub fn refresh_available(state: &AppState) -> bool {
    let r = crate::win::hello::availability();
    if let Err(why) = &r {
        crate::log!("hello: not available ({why})");
    }
    let ok = r.is_ok();
    state.hello.lck().available = Some(ok);
    ok
}

/// The cached answer (false until the first check).
pub fn available(state: &AppState) -> bool {
    state.hello.lck().available.unwrap_or(false)
}

/// Check availability in the background at start.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    let _ = std::thread::Builder::new().name("coffer-hello-check".into()).spawn(move || {
        let ok = refresh_available(&app.state::<AppState>());
        crate::log!("hello: available={ok}");
    });
}

/// Drop the held key.
pub fn forget(state: &AppState) {
    if state.hello.lck().held.take().is_some() {
        crate::log!("hello: dropped the held key");
    }
}

/// Lock: keep the vault key for Hello when Hello is on, the password proof
/// is fresh, and the reason allows it. Called before the session drops.
pub fn on_lock(state: &AppState, session: Option<&Session>, reason: LockReason) {
    let (enabled, days) = {
        let s = state.settings.rd();
        (s.settings.hello_enabled, s.settings.require_password_days)
    };
    let mut h = state.hello.lck();
    h.held = None;
    let Some(s) = session else { return };
    if !enabled || matches!(reason, LockReason::KeyChanged | LockReason::Quit) || !fresh(h.last_password, days) {
        return;
    }
    let vk = s.vault.hello_key();
    match ProtectedKey::protect(&vk) {
        Ok(key) => h.held = Some(Held { vault_id: s.vault_id.clone(), key_id: s.vault.key_id().to_string(), key }),
        Err(e) => crate::log!("hello: could not protect the key: {e}"),
    }
}

/// Hello can open this vault file now (`helloReady`).
pub fn ready(state: &AppState, vault_id: &str, key_id: &str) -> bool {
    let (enabled, days) = {
        let s = state.settings.rd();
        (s.settings.hello_enabled, s.settings.require_password_days)
    };
    let h = state.hello.lck();
    enabled && h.available == Some(true) && fresh(h.last_password, days) && h.held.as_ref().is_some_and(|k| k.vault_id == vault_id && k.key_id == key_id)
}

/// A plain copy of the held key, if it is for this vault and still fresh.
pub fn held_key(state: &AppState, vault_id: &str, key_id: &str) -> CofferResult<Zeroizing<[u8; 32]>> {
    let days = state.settings.rd().settings.require_password_days;
    let mut h = state.hello.lck();
    if !fresh(h.last_password, days) {
        h.held = None;
        return Err(CofferError::new(ErrorCode::HelloUnavailable, NOT_READY));
    }
    let k = h.held.as_ref().filter(|k| k.vault_id == vault_id && k.key_id == key_id).ok_or_else(|| CofferError::new(ErrorCode::HelloUnavailable, NOT_READY))?;
    k.key.reveal().map_err(|e| {
        crate::log!("hello: could not read the held key: {e}");
        CofferError::new(ErrorCode::HelloFailed, NOT_READY)
    })
}

/// The Hello prompt over `hwnd`. `Ok(())` only for "Verified".
pub fn verify(hwnd: isize) -> CofferResult<()> {
    use crate::win::hello::Verification;
    PROMPTING.store(true, Ordering::SeqCst);
    let r = crate::win::hello::verify(hwnd, "Unlock Coffer");
    PROMPTING.store(false, Ordering::SeqCst);
    match r {
        Ok(Verification::Verified) => Ok(()),
        Ok(Verification::Canceled) => Err(CofferError::new(ErrorCode::HelloFailed, "Windows Hello was cancelled. Use your master password.")),
        Ok(Verification::Failed(why)) => {
            crate::log!("hello: verification failed ({why})");
            Err(CofferError::new(ErrorCode::HelloFailed, format!("Windows Hello did not confirm it is you ({why}). Use your master password.")))
        }
        Err(e) => {
            crate::log!("hello: the prompt failed: {e}");
            Err(CofferError::new(ErrorCode::HelloUnavailable, "Windows Hello could not start. Use your master password."))
        }
    }
}

/// `hello_set`: turning Hello on needs the master password (and the vault
/// open); turning it off drops the held key.
pub fn set(app: &AppHandle, enabled: bool, password: Option<&str>) -> CofferResult<VaultStatus> {
    let state = app.state::<AppState>();
    if enabled {
        let password = password.filter(|p| !p.is_empty()).ok_or_else(|| CofferError::invalid("Type your master password to turn on Windows Hello."))?;
        crate::vault::verify_master(app, password)?;
        if !refresh_available(&state) {
            return Err(CofferError::new(
                ErrorCode::HelloUnavailable,
                "Windows Hello is not set up on this PC. Set it up in Windows Settings > Accounts > Sign-in options.",
            ));
        }
        password_proven(&state);
    } else {
        forget(&state);
    }
    let file = {
        let mut s = state.settings.wr();
        s.settings.hello_enabled = enabled;
        s.clone()
    };
    crate::settings::save(&state.settings_path(), &file)?;
    crate::log!("hello: enabled={enabled}");
    crate::vault::status(app)
}

/// Debug self-test only: make the last password proof `by` older.
#[cfg(debug_assertions)]
pub fn age_password_proof(state: &AppState, by: Duration) {
    let mut h = state.hello.lck();
    h.last_password = h.last_password.and_then(|t| t.checked_sub(by));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_proof_expires_after_the_days() {
        assert!(!fresh(None, 14));
        assert!(fresh(Some(SystemTime::now()), 14));
        assert!(fresh(Some(SystemTime::now() - Duration::from_secs(13 * 24 * 3600)), 14));
        assert!(!fresh(Some(SystemTime::now() - Duration::from_secs(14 * 24 * 3600 + 1)), 14));
        assert!(!fresh(Some(SystemTime::now() - Duration::from_secs(2 * 24 * 3600)), 1));
    }
}
