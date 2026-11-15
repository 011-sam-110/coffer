//! `%LOCALAPPDATA%\Coffer\browsers.json`: the connected browsers.
//!
//! One record per Connect (one browser profile): the client id, the browser
//! kind, when it connected and was last used (not secret), and the 32-byte
//! bridge key sealed with DPAPI for the current Windows user, with the
//! entropy `coffer/v1/bridge-key` || the client id (as the PIN record in
//! device.json). Disconnect deletes the record.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use super::pairing::Key;
use crate::contract::{BrowserKind, BrowserLink};
use crate::error::{CofferError, CofferResult};
use crate::state::LockExt;

const ENTROPY_LABEL: &[u8] = b"coffer/v1/bridge-key";
/// `lastUsedAt` is written at most this often per browser.
const TOUCH_EVERY: Duration = Duration::from_secs(60);

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowsersFile {
    #[serde(default = "one")]
    version: u32,
    #[serde(default)]
    browsers: Vec<Record>,
}

fn one() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    id: String,
    browser: BrowserKind,
    paired_at: String,
    #[serde(default)]
    last_used_at: Option<String>,
    /// base64 of the DPAPI blob of the bridge key.
    key: String,
}

/// A client id: 32 lower-case hex digits (16 random bytes).
pub fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn entropy(id: &str) -> Vec<u8> {
    let mut e = ENTROPY_LABEL.to_vec();
    e.extend_from_slice(id.as_bytes());
    e
}

pub struct BrowserStore {
    path: PathBuf,
    /// One read-modify-write at a time.
    io: Mutex<()>,
    touched: Mutex<HashMap<String, Instant>>,
}

impl BrowserStore {
    pub fn new(dir: &Path) -> Self {
        Self { path: dir.join("browsers.json"), io: Mutex::new(()), touched: Mutex::new(HashMap::new()) }
    }

    fn read(&self) -> CofferResult<BrowsersFile> {
        match std::fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| CofferError::io(format!("browsers.json is damaged: {e}"))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BrowsersFile { version: 1, browsers: Vec::new() }),
            Err(e) => Err(CofferError::io(format!("Coffer could not read browsers.json: {e}"))),
        }
    }

    fn write(&self, file: &BrowsersFile) -> CofferResult<()> {
        let bytes = serde_json::to_vec_pretty(file).map_err(|e| CofferError::io(e.to_string()))?;
        crate::paths::write_atomic(&self.path, &bytes).map_err(|e| CofferError::io(format!("Coffer could not save browsers.json: {e}")))
    }

    /// The connected browsers, oldest first.
    pub fn list(&self) -> Vec<BrowserLink> {
        let _io = self.io.lck();
        match self.read() {
            Ok(file) => file
                .browsers
                .into_iter()
                .map(|r| BrowserLink { id: r.id, name: r.browser.name().to_string(), browser: r.browser, paired_at: r.paired_at, last_used_at: r.last_used_at })
                .collect(),
            Err(e) => {
                crate::log!("bridge: {e}");
                Vec::new()
            }
        }
    }

    pub fn has(&self, id: &str) -> bool {
        valid_id(id) && self.list().iter().any(|b| b.id == id)
    }

    /// The bridge key of a connected browser, or `None` (not connected, or
    /// DPAPI cannot open it any more).
    pub fn key(&self, id: &str) -> Option<Key> {
        if !valid_id(id) {
            return None;
        }
        let sealed = {
            let _io = self.io.lck();
            self.read().ok()?.browsers.into_iter().find(|r| r.id == id)?.key
        };
        let blob = STANDARD.decode(sealed).ok()?;
        match crate::win::dpapi::unprotect(&blob, &entropy(id)) {
            Ok(plain) if plain.len() == 32 => {
                let mut key = Zeroizing::new([0u8; 32]);
                key.copy_from_slice(&plain);
                Some(key)
            }
            Ok(_) => None,
            Err(e) => {
                crate::log!("bridge: a stored key cannot be opened ({e})");
                None
            }
        }
    }

    /// Store a new browser (after Allow).
    pub fn add(&self, id: &str, browser: BrowserKind, key: &[u8; 32], now: &str) -> CofferResult<()> {
        if !valid_id(id) {
            return Err(CofferError::invalid("A browser id is 32 hex digits."));
        }
        let sealed = crate::win::dpapi::protect(key, &entropy(id)).map_err(CofferError::io)?;
        let _io = self.io.lck();
        let mut file = self.read()?;
        file.browsers.retain(|r| r.id != id);
        file.browsers.push(Record { id: id.to_string(), browser, paired_at: now.to_string(), last_used_at: None, key: STANDARD.encode(sealed) });
        self.write(&file)
    }

    /// Delete a browser's record (its key with it). True when there was one.
    pub fn remove(&self, id: &str) -> CofferResult<bool> {
        let _io = self.io.lck();
        let mut file = self.read()?;
        let before = file.browsers.len();
        file.browsers.retain(|r| r.id != id);
        if file.browsers.len() == before {
            return Ok(false);
        }
        self.touched.lck().remove(id);
        self.write(&file)?;
        Ok(true)
    }

    /// Record a use (a call with a right MAC). Writes at most once a minute per browser.
    pub fn touch(&self, id: &str, now: &str) {
        {
            let mut touched = self.touched.lck();
            if touched.get(id).is_some_and(|t| t.elapsed() < TOUCH_EVERY) {
                return;
            }
            touched.insert(id.to_string(), Instant::now());
        }
        let _io = self.io.lck();
        let Ok(mut file) = self.read() else { return };
        let Some(r) = file.browsers.iter_mut().find(|r| r.id == id) else { return };
        r.last_used_at = Some(now.to_string());
        if let Err(e) = self.write(&file) {
            crate::log!("bridge: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("coffer-browsers-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    const A: &str = "0123456789abcdef0123456789abcdef";
    const B: &str = "fedcba9876543210fedcba9876543210";

    #[test]
    fn add_key_touch_remove() {
        let dir = temp("store");
        let store = BrowserStore::new(&dir);
        assert!(store.list().is_empty());
        assert!(store.key(A).is_none());
        store.add(A, BrowserKind::Chrome, &[9u8; 32], "2026-11-15T10:00:00Z").unwrap();
        store.add(B, BrowserKind::Edge, &[8u8; 32], "2026-11-15T10:01:00Z").unwrap();
        assert_eq!(*store.key(A).unwrap(), [9u8; 32]);
        assert_eq!(*store.key(B).unwrap(), [8u8; 32]);
        let list = store.list();
        assert_eq!(list.len(), 2);
        assert_eq!((list[0].name.as_str(), list[1].name.as_str()), ("Chrome", "Microsoft Edge"));
        assert_eq!(list[0].last_used_at, None);
        store.touch(A, "2026-11-15T10:05:00Z");
        store.touch(A, "2026-11-15T10:05:30Z"); // within a minute: not written
        assert_eq!(store.list()[0].last_used_at.as_deref(), Some("2026-11-15T10:05:00Z"));

        // The file never holds a key in clear, and a blob moved to another id does not open.
        let text = std::fs::read_to_string(dir.join("browsers.json")).unwrap();
        assert!(!text.contains(&STANDARD.encode([9u8; 32])));
        let mut file: BrowsersFile = serde_json::from_str(&text).unwrap();
        let a_key = file.browsers[0].key.clone();
        file.browsers[1].key = a_key;
        std::fs::write(dir.join("browsers.json"), serde_json::to_vec(&file).unwrap()).unwrap();
        assert!(store.key(B).is_none());

        assert!(store.remove(A).unwrap());
        assert!(!store.remove(A).unwrap());
        assert!(store.key(A).is_none());
        assert!(!store.has(A) && store.has(B));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn ids_are_32_hex_digits() {
        assert!(valid_id(A));
        assert!(!valid_id("0123456789ABCDEF0123456789ABCDEF"));
        assert!(!valid_id("../../x"));
        assert!(!valid_id(""));
        let store = BrowserStore::new(&temp("ids"));
        assert!(store.add("nope", BrowserKind::Chrome, &[1u8; 32], "t").is_err());
    }
}
