//! The `.coffer` file (SPEC 3.5): one UTF-8 JSON object, binary values in
//! standard padded base64.
//!
//! ```json
//! {
//!   "format": "coffer-vault", "version": 1, "vault_id": "uuid", "key_id": "AAAAAA",
//!   "generation": 42,
//!   "kdf": { "alg": "argon2id", "m_kib": 131072, "t": 3, "p": 4, "salt": "b64" },
//!   "wrapped_vault_key": { "nonce": "b64", "ct": "b64" },
//!   "records": [ { "id": "uuid", "kind": "item", "rev": 7, "nonce": "b64", "ct": "b64" } ],
//!   "manifest_mac": "b64"
//! }
//! ```
//!
//! The parser rejects unknown fields, duplicate keys (serde's derived
//! visitors fail on a repeated field), a wrong `format` or `version`, a
//! repeated record id, bad base64 and wrong binary lengths. It does not
//! check any MAC: that needs keys (see `session`).

use std::collections::BTreeMap;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::crypto::KdfParams;
use crate::encoding::{KIND_ITEM, KIND_META};
use crate::error::{CoreError, Result};

/// Format string of a vault file.
pub const FORMAT: &str = "coffer-vault";
/// Format version.
pub const VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawFile {
    format: String,
    version: u32,
    vault_id: String,
    key_id: String,
    generation: u64,
    kdf: RawKdf,
    wrapped_vault_key: RawWrapped,
    records: Vec<RawRecord>,
    manifest_mac: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawKdf {
    alg: String,
    m_kib: u32,
    t: u32,
    p: u32,
    salt: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawWrapped {
    nonce: String,
    ct: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRecord {
    id: String,
    kind: String,
    rev: u64,
    nonce: String,
    ct: String,
}

/// One encrypted record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordBlob {
    /// Record id.
    pub id: Uuid,
    /// Kind byte (1 item, 2 meta).
    pub kind: u8,
    /// Revision.
    pub rev: u64,
    /// 24-byte nonce.
    pub nonce: [u8; 24],
    /// Ciphertext with tag.
    pub ct: Vec<u8>,
}

/// A parsed vault file. Nothing in it is secret in the clear.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultFile {
    /// Vault id.
    pub vault_id: Uuid,
    /// Secret Key id (6 symbols).
    pub key_id: String,
    /// Save counter.
    pub generation: u64,
    /// Argon2id settings.
    pub kdf: KdfParams,
    /// 16-byte salt.
    pub salt: [u8; 16],
    /// Nonce of the wrapped VK.
    pub wrap_nonce: [u8; 24],
    /// Wrapped VK (32 + 16 bytes).
    pub wrap_ct: Vec<u8>,
    /// Records in file order.
    pub records: Vec<RecordBlob>,
    /// HMAC-SHA256 of the manifest input.
    pub manifest_mac: [u8; 32],
}

/// Public header facts, read without any KDF (`read_header`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultHeader {
    /// Vault id.
    pub vault_id: String,
    /// Secret Key id.
    pub key_id: String,
    /// Save counter.
    pub generation: u64,
    /// Argon2 memory in KiB.
    pub m_kib: u32,
    /// Argon2 passes.
    pub t: u32,
    /// Argon2 lanes.
    pub p: u32,
    /// Number of records (items + 1 meta).
    pub record_count: usize,
    /// Base64 of the manifest MAC (identifies this exact file state).
    pub manifest_mac: String,
}

fn bad(msg: &str) -> CoreError {
    CoreError::corrupt(format!("This is not a readable Coffer vault: {msg}."))
}

fn b64_fixed<const N: usize>(s: &str, what: &str) -> Result<[u8; N]> {
    let v = B64.decode(s).map_err(|_| bad(&format!("{what} is not base64")))?;
    v.try_into().map_err(|_| bad(&format!("{what} has the wrong length")))
}

fn parse_uuid(s: &str, what: &str) -> Result<Uuid> {
    // Hyphenated lower- or upper-case form only.
    if s.len() != 36 {
        return Err(bad(&format!("{what} is not a UUID")));
    }
    Uuid::parse_str(s).map_err(|_| bad(&format!("{what} is not a UUID")))
}

impl VaultFile {
    /// Parses and checks the structure of a vault file.
    ///
    /// # Errors
    /// `Corrupt` with a short reason.
    pub fn parse(bytes: &[u8]) -> Result<VaultFile> {
        let raw: RawFile = serde_json::from_slice(bytes).map_err(|e| {
            let m = e.to_string();
            if m.contains("duplicate field") {
                bad("a key appears twice")
            } else if m.contains("unknown field") {
                bad("it has an unknown field")
            } else {
                bad("the JSON does not match the vault format")
            }
        })?;
        if raw.format != FORMAT {
            return Err(bad("wrong format"));
        }
        if raw.version != VERSION {
            return Err(CoreError::corrupt(format!(
                "This vault uses format version {}; this Coffer reads version {VERSION}.",
                raw.version
            )));
        }
        if raw.kdf.alg != "argon2id" {
            return Err(bad("unknown key-derivation algorithm"));
        }
        if raw.key_id.len() != 6 || raw.key_id.chars().any(|c| crate::secret_key::symbol_value(c).is_none() || c.is_ascii_lowercase()) {
            return Err(bad("bad key id"));
        }
        let vault_id = parse_uuid(&raw.vault_id, "vault_id")?;
        let salt = b64_fixed::<16>(&raw.kdf.salt, "salt")?;
        let wrap_nonce = b64_fixed::<24>(&raw.wrapped_vault_key.nonce, "wrapped key nonce")?;
        let wrap_ct = B64.decode(&raw.wrapped_vault_key.ct).map_err(|_| bad("wrapped key is not base64"))?;
        if wrap_ct.len() != 48 {
            return Err(bad("wrapped key has the wrong length"));
        }
        let manifest_mac = b64_fixed::<32>(&raw.manifest_mac, "manifest_mac")?;
        let mut seen = BTreeMap::new();
        let mut records = Vec::with_capacity(raw.records.len());
        for r in &raw.records {
            let id = parse_uuid(&r.id, "record id")?;
            if seen.insert(id, ()).is_some() {
                return Err(bad("a record id appears twice"));
            }
            let kind = match r.kind.as_str() {
                "item" => KIND_ITEM,
                "meta" => KIND_META,
                _ => return Err(bad("unknown record kind")),
            };
            let nonce = b64_fixed::<24>(&r.nonce, "record nonce")?;
            let ct = B64.decode(&r.ct).map_err(|_| bad("record is not base64"))?;
            if ct.len() < 16 {
                return Err(bad("record too short"));
            }
            records.push(RecordBlob { id, kind, rev: r.rev, nonce, ct });
        }
        Ok(VaultFile {
            vault_id,
            key_id: raw.key_id,
            generation: raw.generation,
            kdf: KdfParams { m_kib: raw.kdf.m_kib, t: raw.kdf.t, p: raw.kdf.p },
            salt,
            wrap_nonce,
            wrap_ct,
            records,
            manifest_mac,
        })
    }

    /// Serialises to the JSON file bytes.
    pub fn to_bytes(&self) -> Vec<u8> {
        let raw = RawFile {
            format: FORMAT.into(),
            version: VERSION,
            vault_id: self.vault_id.hyphenated().to_string(),
            key_id: self.key_id.clone(),
            generation: self.generation,
            kdf: RawKdf {
                alg: "argon2id".into(),
                m_kib: self.kdf.m_kib,
                t: self.kdf.t,
                p: self.kdf.p,
                salt: B64.encode(self.salt),
            },
            wrapped_vault_key: RawWrapped { nonce: B64.encode(self.wrap_nonce), ct: B64.encode(&self.wrap_ct) },
            records: self
                .records
                .iter()
                .map(|r| RawRecord {
                    id: r.id.hyphenated().to_string(),
                    kind: if r.kind == KIND_META { "meta".into() } else { "item".into() },
                    rev: r.rev,
                    nonce: B64.encode(r.nonce),
                    ct: B64.encode(&r.ct),
                })
                .collect(),
            manifest_mac: B64.encode(self.manifest_mac),
        };
        let mut out = serde_json::to_vec_pretty(&raw).expect("vault JSON serialisation cannot fail");
        out.push(b'\n');
        out
    }

    /// The public header facts.
    pub fn header(&self) -> VaultHeader {
        VaultHeader {
            vault_id: self.vault_id.hyphenated().to_string(),
            key_id: self.key_id.clone(),
            generation: self.generation,
            m_kib: self.kdf.m_kib,
            t: self.kdf.t,
            p: self.kdf.p,
            record_count: self.records.len(),
            manifest_mac: B64.encode(self.manifest_mac),
        }
    }

    /// (id, rev) of every record.
    pub fn revs(&self) -> BTreeMap<Uuid, u64> {
        self.records.iter().map(|r| (r.id, r.rev)).collect()
    }
}

/// Reads the public header of a vault file without running the KDF
/// (vault id, key id, generation, KDF settings).
///
/// # Errors
/// `Corrupt` when the file is not a readable vault.
pub fn read_header(bytes: &[u8]) -> Result<VaultHeader> {
    Ok(VaultFile::parse(bytes)?.header())
}

/// Base64 of the `manifest_mac` of a vault file (for the atomic-write check
/// of SPEC 3.5: compare with `Vault::disk_mac()` before replacing).
///
/// # Errors
/// `Corrupt` when the file is not a readable vault.
pub fn manifest_mac_of(bytes: &[u8]) -> Result<String> {
    Ok(VaultFile::parse(bytes)?.header().manifest_mac)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> VaultFile {
        VaultFile {
            vault_id: Uuid::new_v4(),
            key_id: "ABCDEF".into(),
            generation: 3,
            kdf: KdfParams::DEFAULT,
            salt: [1; 16],
            wrap_nonce: [2; 24],
            wrap_ct: vec![3; 48],
            records: vec![RecordBlob { id: Uuid::new_v4(), kind: KIND_META, rev: 1, nonce: [4; 24], ct: vec![5; 300] }],
            manifest_mac: [6; 32],
        }
    }

    #[test]
    fn round_trip() {
        let f = sample();
        assert_eq!(VaultFile::parse(&f.to_bytes()).unwrap(), f);
    }

    fn mutate(f: impl FnOnce(&mut serde_json::Value)) -> Vec<u8> {
        let mut v: serde_json::Value = serde_json::from_slice(&sample().to_bytes()).unwrap();
        f(&mut v);
        serde_json::to_vec(&v).unwrap()
    }

    #[test]
    fn rejects_unknown_top_level_field() {
        let b = mutate(|v| {
            v["extra"] = 1.into();
        });
        assert!(matches!(VaultFile::parse(&b), Err(CoreError::Corrupt(m)) if m.contains("unknown field")));
    }

    #[test]
    fn rejects_unknown_nested_field() {
        let b = mutate(|v| {
            v["kdf"]["x"] = 1.into();
        });
        assert!(VaultFile::parse(&b).is_err());
    }

    #[test]
    fn rejects_duplicate_keys() {
        let text = String::from_utf8(sample().to_bytes()).unwrap();
        let dup = text.replacen("\"generation\": 3,", "\"generation\": 3,\n  \"generation\": 9,", 1);
        assert_ne!(dup, text);
        assert!(matches!(VaultFile::parse(dup.as_bytes()), Err(CoreError::Corrupt(m)) if m.contains("twice")));
    }

    #[test]
    fn rejects_wrong_format_and_version() {
        assert!(VaultFile::parse(&mutate(|v| v["format"] = "x".into())).is_err());
        assert!(VaultFile::parse(&mutate(|v| v["version"] = 2.into())).is_err());
        assert!(VaultFile::parse(&mutate(|v| v["kdf"]["alg"] = "scrypt".into())).is_err());
    }

    #[test]
    fn rejects_repeated_record_id() {
        let b = mutate(|v| {
            let r = v["records"][0].clone();
            v["records"].as_array_mut().unwrap().push(r);
        });
        assert!(matches!(VaultFile::parse(&b), Err(CoreError::Corrupt(m)) if m.contains("record id appears twice")));
    }

    #[test]
    fn rejects_bad_lengths() {
        assert!(VaultFile::parse(&mutate(|v| v["kdf"]["salt"] = B64.encode([0u8; 15]).into())).is_err());
        assert!(VaultFile::parse(&mutate(|v| v["manifest_mac"] = "!!".into())).is_err());
    }

    #[test]
    fn header_without_kdf() {
        let f = sample();
        let h = read_header(&f.to_bytes()).unwrap();
        assert_eq!(h.generation, 3);
        assert_eq!(h.key_id, "ABCDEF");
        assert_eq!(h.m_kib, 131_072);
    }
}
