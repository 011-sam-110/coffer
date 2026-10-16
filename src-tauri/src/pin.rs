//! PIN unlock (tier 2): a PIN of 6 to 12 digits opens the vault on this PC,
//! also after a restart. The master password stays: it sets the PIN, and
//! Coffer asks for it again after `requirePasswordDays` without it.
//!
//! The PIN record holds the vault key (VK) sealed with XChaCha20-Poly1305
//! under Argon2id(PIN, salt) with the vault's default cost (128 MiB, 3
//! passes, 4 lanes); `device.rs` seals the whole record again with DPAPI for
//! the current Windows user. 5 wrong PINs delete the record. A change of the
//! vault key or of the Secret Key makes the record useless; Coffer then
//! deletes it at the next PIN unlock.
//!
//! A PIN is a convenience gate, as Windows Hello is: a program that runs as
//! the same Windows user can copy the record and try every PIN offline. The
//! vault file does not change: away from this PC it still needs the master
//! password and the Secret Key (docs/SECURITY.md).

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use coffer_core::KdfParams;
use coffer_core::crypto::{self, Key32};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::error::{CofferError, CofferResult, ErrorCode};
use crate::state::{AppState, LockExt, RwExt};

pub const MIN_DIGITS: usize = 6;
pub const MAX_DIGITS: usize = 12;
/// Wrong PINs in a row before the record is deleted.
pub const MAX_FAILURES: u8 = 5;

const AAD_LABEL: &[u8] = b"coffer/v1/pin";

/// What device.json keeps (inside its DPAPI blob) for a vault with a PIN.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinRecord {
    pub v: u32,
    /// The Secret Key id the vault had when the PIN was set.
    pub key_id: String,
    /// Argon2id memory (KiB), passes, lanes.
    pub kdf: [u32; 3],
    /// How many digits: the lock screen draws that many boxes and unlocks at the last one.
    pub len: u8,
    salt: String,
    nonce: String,
    ct: String,
    /// Wrong PINs since the last right one.
    pub failures: u8,
    /// Unix seconds of the last master-password unlock (or PIN set) on this PC.
    pub password_at: u64,
}

pub fn now_secs() -> u64 {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    // Debug builds only: e2e/pin.mjs runs Coffer some days ahead to test the master-password days.
    #[cfg(debug_assertions)]
    if let Some(days) = std::env::var("COFFER_TEST_DAYS_AHEAD").ok().and_then(|v| v.parse::<u64>().ok()) {
        return now + days * 24 * 3600;
    }
    now
}

/// Digits only, 6 to 12 of them.
pub fn check_format(pin: &str) -> CofferResult<()> {
    if pin.len() < MIN_DIGITS || pin.len() > MAX_DIGITS || !pin.bytes().all(|b| b.is_ascii_digit()) {
        return Err(CofferError::invalid(format!("A PIN is {MIN_DIGITS} to {MAX_DIGITS} digits, with no letters or spaces.")));
    }
    Ok(())
}

fn aad(vault_id: &str, key_id: &str) -> Vec<u8> {
    let mut a = AAD_LABEL.to_vec();
    a.extend_from_slice(vault_id.as_bytes());
    a.push(0);
    a.extend_from_slice(key_id.as_bytes());
    a
}

fn pin_key(pin: &str, salt: &[u8], params: &KdfParams) -> CofferResult<Key32> {
    crypto::argon2id_key(pin.as_bytes(), salt, params).map_err(CofferError::from)
}

/// A new record that opens `vk` with `pin`.
pub fn seal(pin: &str, vk: &[u8; 32], vault_id: &str, key_id: &str, params: &KdfParams, now: u64) -> CofferResult<PinRecord> {
    check_format(pin)?;
    let salt: [u8; 16] = crypto::random_array();
    let key = pin_key(pin, &salt, params)?;
    let (nonce, ct) = crypto::seal(&key, &aad(vault_id, key_id), vk);
    Ok(PinRecord {
        v: 1,
        key_id: key_id.to_string(),
        kdf: [params.m_kib, params.t, params.p],
        len: pin.len() as u8,
        salt: STANDARD.encode(salt),
        nonce: STANDARD.encode(nonce),
        ct: STANDARD.encode(ct),
        failures: 0,
        password_at: now,
    })
}

/// The vault key, or `None` for a wrong PIN (or a damaged record).
pub fn open(record: &PinRecord, pin: &str, vault_id: &str) -> CofferResult<Option<Zeroizing<[u8; 32]>>> {
    if check_format(pin).is_err() {
        return Ok(None);
    }
    let params = KdfParams { m_kib: record.kdf[0], t: record.kdf[1], p: record.kdf[2] };
    let (Ok(salt), Ok(nonce), Ok(ct)) = (STANDARD.decode(&record.salt), STANDARD.decode(&record.nonce), STANDARD.decode(&record.ct)) else {
        return Ok(None);
    };
    let key = pin_key(pin, &salt, &params)?;
    let Some(plain) = crypto::open(&key, &nonce, &aad(vault_id, &record.key_id), &ct) else { return Ok(None) };
    let vk: [u8; 32] = plain.as_slice().try_into().map_err(|_| CofferError::invalid("The PIN record is damaged."))?;
    Ok(Some(Zeroizing::new(vk)))
}

/// The master password was typed within `days` days.
pub fn fresh(password_at: u64, now: u64, days: u32) -> bool {
    now.saturating_sub(password_at) < Duration::from_secs(u64::from(days) * 24 * 3600).as_secs()
}

// ---------- the record in device.json ----------

pub fn load(state: &AppState, vault_id: &str) -> CofferResult<Option<PinRecord>> {
    let Some(bytes) = state.device.lck().pin_get(vault_id)? else { return Ok(None) };
    match serde_json::from_slice::<PinRecord>(&bytes) {
        Ok(r) if r.v == 1 => Ok(Some(r)),
        _ => {
            crate::log!("pin: the stored record is not readable; removing it");
            let _ = state.device.lck().pin_remove(vault_id);
            Ok(None)
        }
    }
}

pub fn store(state: &AppState, vault_id: &str, record: &PinRecord) -> CofferResult<()> {
    let bytes = Zeroizing::new(serde_json::to_vec(record).map_err(|e| CofferError::io(e.to_string()))?);
    state.device.lck().pin_put(vault_id, &bytes)
}

pub fn remove(state: &AppState, vault_id: &str, why: &str) {
    match state.device.lck().pin_remove(vault_id) {
        Ok(true) => crate::log!("pin: removed ({why})"),
        Ok(false) => {}
        Err(e) => crate::log!("pin: could not remove the record: {e}"),
    }
}

/// For the status: whether a PIN is set for this vault, whether it can unlock
/// now (same Secret Key id, master password typed within the days), and its length.
pub struct PinStatus {
    pub set: bool,
    pub ready: bool,
    pub len: Option<u8>,
}

pub fn status(state: &AppState, vault_id: &str, key_id: &str) -> PinStatus {
    let days = state.settings.rd().settings.require_password_days;
    match load(state, vault_id) {
        Ok(Some(r)) => PinStatus { set: true, ready: r.key_id == key_id && fresh(r.password_at, now_secs(), days), len: Some(r.len) },
        _ => PinStatus { set: false, ready: false, len: None },
    }
}

/// The master password was proven for this vault: the PIN's days start again.
pub fn password_proven(state: &AppState, vault_id: &str) {
    match load(state, vault_id) {
        Ok(Some(mut r)) => {
            r.password_at = now_secs();
            r.failures = 0;
            if let Err(e) = store(state, vault_id, &r) {
                crate::log!("pin: could not record the password unlock: {e}");
            }
        }
        Ok(None) => {}
        Err(e) => crate::log!("pin: {e}"),
    }
}

/// Turn the PIN on (with the master password and the open vault) or off.
pub fn set(app: &tauri::AppHandle, pin: Option<&str>, password: Option<&str>) -> CofferResult<crate::contract::VaultStatus> {
    use tauri::Manager;
    let state = app.state::<AppState>();
    match pin {
        Some(pin) => {
            check_format(pin)?;
            let password = password.filter(|p| !p.is_empty()).ok_or_else(|| CofferError::invalid("Type your master password to set a PIN."))?;
            crate::vault::verify_master(app, password)?;
            let (vault_id, key_id, vk) = crate::vault::with_session(app, |s| Ok((s.vault_id.clone(), s.vault.key_id().to_string(), s.vault.hello_key())))?;
            let record = seal(pin, &vk, &vault_id, &key_id, &KdfParams::DEFAULT, now_secs())?;
            store(&state, &vault_id, &record)?;
            crate::log!("pin: set");
        }
        None => {
            let vault_id = crate::vault::with_session(app, |s| Ok(s.vault_id.clone()))
                .ok()
                .or_else(|| state.settings.rd().vault_id.clone())
                .ok_or_else(|| CofferError::invalid("There is no vault on this PC yet."))?;
            remove(&state, &vault_id, "turned off");
        }
    }
    crate::vault::status(app)
}

/// What a wrong PIN does to the record: count it, or delete the record at the limit.
pub enum Miss {
    TriesLeft(u8),
    Removed,
}

pub fn record_miss(state: &AppState, vault_id: &str, mut record: PinRecord) -> Miss {
    record.failures = record.failures.saturating_add(1);
    if record.failures >= MAX_FAILURES {
        remove(state, vault_id, "too many wrong PINs");
        return Miss::Removed;
    }
    if let Err(e) = store(state, vault_id, &record) {
        crate::log!("pin: could not count a wrong PIN ({e}); removing the record");
        remove(state, vault_id, "the count could not be saved");
        return Miss::Removed;
    }
    Miss::TriesLeft(MAX_FAILURES - record.failures)
}

pub fn unavailable(message: impl Into<String>) -> CofferError {
    CofferError::new(ErrorCode::PinUnavailable, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    const VAULT: &str = "12345678-9abc-def0-0123-456789abcdef";
    /// The floor of the vault KDF, so the tests run in well under a second each.
    const FAST: KdfParams = KdfParams::FLOOR;

    #[test]
    fn format_is_6_to_12_digits() {
        assert!(check_format("123456").is_ok());
        assert!(check_format("123456789012").is_ok());
        for bad in ["12345", "1234567890123", "12345a", "123 456", "", "１２３４５６"] {
            assert!(check_format(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn the_right_pin_opens_the_vault_key_and_a_wrong_one_does_not() {
        let vk = [7u8; 32];
        let r = seal("482917", &vk, VAULT, "ABC123", &FAST, 1000).unwrap();
        assert_eq!(*open(&r, "482917", VAULT).unwrap().unwrap(), vk);
        assert!(open(&r, "482918", VAULT).unwrap().is_none());
        assert!(open(&r, "48291", VAULT).unwrap().is_none());
        // Bound to the vault id and the Secret Key id.
        assert!(open(&r, "482917", "07070707-0707-0707-0707-070707070707").unwrap().is_none());
        let mut moved = r.clone();
        moved.key_id = "ZZZ999".into();
        assert!(open(&moved, "482917", VAULT).unwrap().is_none());
        // The record never holds the key or the PIN in clear.
        let json = serde_json::to_string(&r).unwrap();
        assert!(!json.contains("482917"));
        assert_eq!(r.kdf, [FAST.m_kib, FAST.t, FAST.p]);
        assert_eq!((r.failures, r.password_at, r.len), (0, 1000, 6));
    }

    #[test]
    fn a_record_under_the_kdf_floor_is_refused() {
        let vk = [1u8; 32];
        let mut r = seal("111111", &vk, VAULT, "K", &FAST, 0).unwrap();
        r.kdf = [8, 1, 1];
        assert!(open(&r, "111111", VAULT).is_err());
    }

    #[test]
    fn the_password_days_run_out() {
        let day = 24 * 3600;
        assert!(fresh(1000, 1000, 14));
        assert!(fresh(1000, 1000 + 14 * day - 1, 14));
        assert!(!fresh(1000, 1000 + 14 * day, 14));
        assert!(!fresh(0, 2 * day, 1));
    }
}
