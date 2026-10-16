//! `%LOCALAPPDATA%\Coffer\device.json`: per vault id, the Secret Key sealed with
//! DPAPI (SPEC 3.2) and the highest vault generation this PC has seen (SPEC 3.5).
//!
//! The Secret Key entry is `CryptProtectData` (current user,
//! `CRYPTPROTECT_UI_FORBIDDEN`, optional entropy `coffer/v1/device-sk` || the
//! 16 vault id bytes), base64 in the JSON. The generation is not secret.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::error::{CofferError, CofferResult};

const ENTROPY_LABEL: &[u8] = b"coffer/v1/device-sk";

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceFile {
    #[serde(default = "one")]
    version: u32,
    #[serde(default)]
    vaults: BTreeMap<String, DeviceVault>,
}

fn one() -> u32 {
    1
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceVault {
    /// base64 of the DPAPI blob of the Secret Key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    secret_key: Option<String>,
    /// Highest `generation` seen for this vault id.
    #[serde(default)]
    generation: u64,
}

/// The DPAPI entropy for a vault: `coffer/v1/device-sk` || vault id bytes.
pub fn entropy(vault_id: &[u8; 16]) -> Vec<u8> {
    let mut e = ENTROPY_LABEL.to_vec();
    e.extend_from_slice(vault_id);
    e
}

/// The 16 bytes of a hyphenated UUID text (any case).
pub fn uuid_bytes(text: &str) -> Option<[u8; 16]> {
    let hex: String = text.chars().filter(|c| *c != '-').collect();
    if hex.len() != 32 || text.len() != 36 {
        return None;
    }
    let mut out = [0u8; 16];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(hex.get(2 * i..2 * i + 2)?, 16).ok()?;
    }
    Some(out)
}

fn id_of(vault_id: &str) -> CofferResult<[u8; 16]> {
    uuid_bytes(vault_id).ok_or_else(|| CofferError::invalid("A vault id is not a UUID."))
}

/// Lower-case hyphenated UUID text, the key in device.json.
pub fn uuid_text(id: &[u8; 16]) -> String {
    let h: String = id.iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

pub struct DeviceStore {
    path: PathBuf,
}

impl DeviceStore {
    pub fn new(dir: &Path) -> Self {
        Self { path: dir.join("device.json") }
    }

    fn read(&self) -> CofferResult<DeviceFile> {
        match std::fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| CofferError::io(format!("device.json is damaged: {e}"))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(DeviceFile { version: 1, ..Default::default() }),
            Err(e) => Err(CofferError::io(format!("Coffer could not read device.json: {e}"))),
        }
    }

    fn write(&self, file: &DeviceFile) -> CofferResult<()> {
        let bytes = serde_json::to_vec_pretty(file).map_err(|e| CofferError::io(e.to_string()))?;
        crate::paths::write_atomic(&self.path, &bytes).map_err(|e| CofferError::io(format!("Coffer could not save device.json: {e}")))
    }

    /// The Secret Key stored for this vault on this PC, or `None` (not stored,
    /// or DPAPI cannot open it any more, e.g. after an admin password reset).
    pub fn secret_key_get(&self, vault_id: &str) -> CofferResult<Option<Zeroizing<Vec<u8>>>> {
        let vault_id = &id_of(vault_id)?;
        let file = self.read()?;
        let Some(sealed) = file.vaults.get(&uuid_text(vault_id)).and_then(|v| v.secret_key.as_ref()) else { return Ok(None) };
        let Ok(blob) = STANDARD.decode(sealed) else {
            crate::log!("device: a stored Secret Key is not valid base64");
            return Ok(None);
        };
        match crate::win::dpapi::unprotect(&blob, &entropy(vault_id)) {
            Ok(secret) => Ok(Some(secret)),
            Err(e) => {
                crate::log!("device: the stored Secret Key cannot be opened ({e})");
                Ok(None)
            }
        }
    }

    /// Store (or replace) the Secret Key for this vault.
    pub fn secret_key_put(&self, vault_id: &str, secret_key: &[u8]) -> CofferResult<()> {
        let vault_id = &id_of(vault_id)?;
        let sealed = crate::win::dpapi::protect(secret_key, &entropy(vault_id)).map_err(CofferError::io)?;
        let mut file = self.read()?;
        file.vaults.entry(uuid_text(vault_id)).or_default().secret_key = Some(STANDARD.encode(sealed));
        self.write(&file)
    }

    pub fn secret_key_remove(&self, vault_id: &str) -> CofferResult<()> {
        let vault_id = &id_of(vault_id)?;
        let mut file = self.read()?;
        if let Some(v) = file.vaults.get_mut(&uuid_text(vault_id)) {
            v.secret_key = None;
        }
        self.write(&file)
    }

    /// The highest generation this PC has seen for the vault.
    pub fn generation_get(&self, vault_id: &str) -> CofferResult<Option<u64>> {
        let vault_id = &id_of(vault_id)?;
        Ok(self.read()?.vaults.get(&uuid_text(vault_id)).map(|v| v.generation))
    }

    /// Record a generation seen (on open and after each save); keeps the
    /// highest. Returns the stored (highest) value.
    pub fn generation_observe(&self, vault_id: &str, generation: u64) -> CofferResult<u64> {
        let vault_id = &id_of(vault_id)?;
        let mut file = self.read()?;
        let entry = file.vaults.entry(uuid_text(vault_id)).or_default();
        if generation > entry.generation {
            entry.generation = generation;
            let stored = entry.generation;
            self.write(&file)?;
            return Ok(stored);
        }
        Ok(entry.generation)
    }

    /// Set the highest seen generation (a restore while locked takes the
    /// backup's generation, SPEC 3.5, even when it is lower).
    pub fn generation_set(&self, vault_id: &str, generation: u64) -> CofferResult<()> {
        let vault_id = &id_of(vault_id)?;
        let mut file = self.read()?;
        file.vaults.entry(uuid_text(vault_id)).or_default().generation = generation;
        self.write(&file)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VAULT_BYTES: [u8; 16] = [0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef];
    const VAULT: &str = "12345678-9abc-def0-0123-456789abcdef";
    const OTHER: &str = "07070707-0707-0707-0707-070707070707";

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("coffer-device-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn uuid_and_entropy() {
        assert_eq!(uuid_text(&VAULT_BYTES), VAULT);
        assert_eq!(uuid_bytes(VAULT), Some(VAULT_BYTES));
        assert_eq!(uuid_bytes("12345678-9ABC-DEF0-0123-456789ABCDEF"), Some(VAULT_BYTES));
        assert_eq!(uuid_bytes("123456789abcdef00123456789abcdef"), None);
        assert_eq!(uuid_bytes("not-a-uuid"), None);
        let e = entropy(&VAULT_BYTES);
        assert!(e.starts_with(b"coffer/v1/device-sk"));
        assert_eq!(&e[19..], &VAULT_BYTES);
    }

    #[test]
    fn secret_key_round_trip_per_vault() {
        let dir = temp("sk");
        let store = DeviceStore::new(&dir);
        assert!(store.secret_key_get(VAULT).unwrap().is_none());
        store.secret_key_put(VAULT, b"sixteen byte key").unwrap();
        assert_eq!(&**store.secret_key_get(VAULT).unwrap().unwrap(), b"sixteen byte key");
        assert!(store.secret_key_get(OTHER).unwrap().is_none());
        // The file never holds the key in clear.
        let text = std::fs::read_to_string(dir.join("device.json")).unwrap();
        assert!(!text.contains("sixteen byte key"));
        // A blob moved to another vault id does not open (entropy binds it).
        let mut file: DeviceFile = serde_json::from_str(&text).unwrap();
        let moved = file.vaults[VAULT].clone();
        file.vaults.insert(OTHER.to_string(), moved);
        std::fs::write(dir.join("device.json"), serde_json::to_vec(&file).unwrap()).unwrap();
        assert!(store.secret_key_get(OTHER).unwrap().is_none());
        store.secret_key_remove(VAULT).unwrap();
        assert!(store.secret_key_get(VAULT).unwrap().is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn generation_keeps_the_highest() {
        let dir = temp("gen");
        let store = DeviceStore::new(&dir);
        assert_eq!(store.generation_get(VAULT).unwrap(), None);
        assert_eq!(store.generation_observe(VAULT, 5).unwrap(), 5);
        assert_eq!(store.generation_observe(VAULT, 3).unwrap(), 5);
        assert_eq!(store.generation_observe(VAULT, 9).unwrap(), 9);
        assert_eq!(store.generation_get(VAULT).unwrap(), Some(9));
        store.generation_set(VAULT, 4).unwrap();
        assert_eq!(store.generation_get(VAULT).unwrap(), Some(4));
        store.generation_set(VAULT, 9).unwrap();
        // The Secret Key and the generation live side by side.
        store.secret_key_put(VAULT, b"k").unwrap();
        assert_eq!(store.generation_get(VAULT).unwrap(), Some(9));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
