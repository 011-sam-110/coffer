//! Exporters (SPEC 8). Trashed items are left out of every export.
//!
//! # Coffer JSON
//! `{ "format": "coffer-json", "version": 1, "exported_at": "<ISO>", "items": [...] }`:
//! items as in SPEC 4 in snake_case ([`StoredItem`]), password history
//! values included, no revisions. Import gives new ids.
//!
//! # `.cofferx` (Coffer encrypted export)
//! ```json
//! { "format": "coffer-export", "version": 1, "export_id": "uuid",
//!   "kdf": { "alg": "argon2id", "m_kib": 131072, "t": 3, "p": 4, "salt": "b64" },
//!   "nonce": "b64", "ct": "b64" }
//! ```
//! - key = Argon2id(NFKD-normalised, trimmed export password, kdf.salt,
//!   m_kib, t, p, len 32). No Secret Key, so the file opens on any PC with
//!   its own password.
//! - aad = fields(`"coffer/v1/export"`, export_id (16 raw bytes),
//!   `"argon2id"`, m_kib, t, p, salt), each field `u32 BE length || bytes`.
//! - ct = XChaCha20-Poly1305(key, nonce (24 random bytes), aad, plaintext =
//!   Coffer JSON padded with spaces to a multiple of 256 bytes).
//! - The same KDF floor and ceiling as the vault apply, checked before
//!   Argon2 runs; the parser rejects unknown fields and repeated keys.
//! - The export password must score 3 or more with zxcvbn.
//!
//! # Bitwarden JSON (plain) and CSV
//! The unencrypted Bitwarden personal-vault shapes of
//! `docs/research/import-formats.md`, so a user can leave. Types Bitwarden
//! lacks become logins (password, API credential, Wi-Fi) or secure notes
//! with custom fields (bank account, ID document, software licence). The CSV
//! has the Bitwarden personal headers; items that are not logins become
//! `note` rows with their fields in the `fields` cell.

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::crypto::{self, KdfParams};
use crate::encoding::{self, Fields};
use crate::error::{CoreError, Result};
use crate::model::{ExportKind, FieldKind, ItemState, ItemType, StoredItem};
use crate::session::Vault;

/// Format string of Coffer JSON.
pub const COFFER_JSON_FORMAT: &str = "coffer-json";
/// Format string of `.cofferx`.
pub const COFFERX_FORMAT: &str = "coffer-export";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CofferJson {
    pub(crate) format: String,
    pub(crate) version: u32,
    pub(crate) exported_at: String,
    pub(crate) items: Vec<StoredItem>,
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
struct CofferX {
    format: String,
    version: u32,
    export_id: String,
    kdf: RawKdf,
    nonce: String,
    ct: String,
}

/// Coffer JSON of some items (revisions and import batch ids dropped).
pub fn coffer_json(items: &[&StoredItem], exported_at: &str) -> Zeroizing<Vec<u8>> {
    let items: Vec<StoredItem> = items
        .iter()
        .map(|i| {
            let mut c = (*i).clone();
            c.revisions.clear();
            c.import_batch = None;
            c
        })
        .collect();
    let doc = CofferJson { format: COFFER_JSON_FORMAT.into(), version: 1, exported_at: exported_at.into(), items };
    Zeroizing::new(serde_json::to_vec_pretty(&doc).expect("JSON serialisation cannot fail"))
}

fn export_aad(export_id: &Uuid, kdf: &KdfParams, salt: &[u8]) -> Vec<u8> {
    Fields::new("coffer/v1/export")
        .id(export_id)
        .bytes(b"argon2id")
        .u32(kdf.m_kib)
        .u32(kdf.t)
        .u32(kdf.p)
        .bytes(salt)
        .finish()
}

/// Seals Coffer JSON bytes into a `.cofferx` file.
///
/// # Errors
/// `WeakPassword` when the export password scores under 3; KDF errors.
pub fn cofferx_seal(coffer_json: &[u8], export_password: &str, kdf: KdfParams) -> Result<Vec<u8>> {
    let pw = crypto::normalize_password(export_password);
    if !crate::strength::is_strong_enough(&pw, &[]) {
        return Err(CoreError::WeakPassword("Choose a stronger export password: add more words or characters.".into()));
    }
    let salt: [u8; 16] = crypto::random_array();
    let key = crypto::argon2id_key(pw.as_bytes(), &salt, &kdf)?;
    let export_id = Uuid::new_v4();
    let mut pt = Zeroizing::new(coffer_json.to_vec());
    encoding::pad_256(&mut pt);
    let (nonce, ct) = crypto::seal(&key, &export_aad(&export_id, &kdf, &salt), &pt);
    let doc = CofferX {
        format: COFFERX_FORMAT.into(),
        version: 1,
        export_id: export_id.hyphenated().to_string(),
        kdf: RawKdf { alg: "argon2id".into(), m_kib: kdf.m_kib, t: kdf.t, p: kdf.p, salt: B64.encode(salt) },
        nonce: B64.encode(nonce),
        ct: B64.encode(ct),
    };
    Ok(serde_json::to_vec_pretty(&doc).expect("JSON serialisation cannot fail"))
}

/// `true` when the bytes look like a `.cofferx` file (format field only).
pub fn is_cofferx(bytes: &[u8]) -> bool {
    serde_json::from_slice::<Value>(bytes).ok().and_then(|v| v.get("format").and_then(Value::as_str).map(|s| s == COFFERX_FORMAT)).unwrap_or(false)
}

/// Opens a `.cofferx` file; returns the Coffer JSON bytes (padding trimmed).
///
/// # Errors
/// `Corrupt` for a malformed file, KDF errors before Argon2 runs,
/// `BadCredentials` for a wrong password or a changed file.
pub fn cofferx_open(bytes: &[u8], export_password: &str) -> Result<Zeroizing<Vec<u8>>> {
    let bad = |m: &str| CoreError::corrupt(format!("This is not a readable Coffer export: {m}."));
    let doc: CofferX = serde_json::from_slice(bytes).map_err(|_| bad("the JSON does not match the format"))?;
    if doc.format != COFFERX_FORMAT || doc.version != 1 || doc.kdf.alg != "argon2id" {
        return Err(bad("wrong format or version"));
    }
    let export_id = Uuid::parse_str(&doc.export_id).map_err(|_| bad("bad export id"))?;
    let salt: [u8; 16] = B64.decode(&doc.kdf.salt).ok().and_then(|v| v.try_into().ok()).ok_or_else(|| bad("bad salt"))?;
    let nonce = B64.decode(&doc.nonce).map_err(|_| bad("bad nonce"))?;
    let ct = B64.decode(&doc.ct).map_err(|_| bad("bad ciphertext"))?;
    let kdf = KdfParams { m_kib: doc.kdf.m_kib, t: doc.kdf.t, p: doc.kdf.p };
    let pw = crypto::normalize_password(export_password);
    let key = crypto::argon2id_key(pw.as_bytes(), &salt, &kdf)?;
    let mut pt = crypto::open(&key, &nonce, &export_aad(&export_id, &kdf, &salt), &ct).ok_or(CoreError::BadCredentials)?;
    while pt.last() == Some(&b' ') {
        pt.pop();
    }
    Ok(pt)
}

fn secret_type(kind: FieldKind) -> u8 {
    if kind.is_secret() {
        1
    } else if kind == FieldKind::Boolean {
        2
    } else {
        0
    }
}

/// Roles each Bitwarden type takes into its own object.
fn bw_consumed(t: ItemType) -> &'static [&'static str] {
    match t {
        ItemType::Login => &["username", "password", "totp"],
        ItemType::Password => &["password"],
        ItemType::ApiCredential => &["username", "credential"],
        ItemType::Wifi => &["ssid", "password"],
        ItemType::Card => &["cardholder", "brand", "number", "expiry", "cvv"],
        ItemType::Identity => &[
            "title", "firstName", "middleName", "lastName", "address1", "address2", "city", "region", "postcode", "country",
            "company", "email", "phone",
        ],
        ItemType::SshKey => &["privateKey", "publicKey", "fingerprint"],
        _ => &[],
    }
}

fn opt(v: &str) -> Value {
    if v.is_empty() { Value::Null } else { Value::String(v.to_owned()) }
}

fn bitwarden_item(i: &StoredItem) -> Value {
    let consumed = bw_consumed(i.item_type);
    let fields: Vec<Value> = i
        .fields
        .iter()
        .filter(|f| !f.builtin.as_deref().is_some_and(|b| consumed.contains(&b)))
        .filter(|f| !f.value.is_empty())
        .map(|f| json!({ "name": f.label, "value": f.value, "type": secret_type(f.kind), "linkedId": null }))
        .collect();
    let history: Vec<Value> =
        i.password_history.iter().map(|h| json!({ "lastUsedDate": h.changed_at, "password": h.value })).collect();
    let history = if history.is_empty() { Value::Null } else { Value::Array(history) };
    let reprompt: u8 = if i.reprompt { 1 } else { 0 };
    let mut o = json!({
        "id": i.id.to_string(),
        "organizationId": null,
        "folderId": null,
        "reprompt": reprompt,
        "name": i.title,
        "notes": opt(&i.notes),
        "favorite": i.favorite,
        "fields": fields,
        "collectionIds": null,
        "passwordHistory": history,
        "creationDate": i.created_at,
        "revisionDate": i.updated_at,
    });
    let b = |r: &str| i.builtin_value(r).to_owned();
    let mut uris: Vec<Value> = i.urls.iter().map(|u| json!({ "match": null, "uri": u.url })).collect();
    match i.item_type {
        ItemType::Login | ItemType::Password | ItemType::ApiCredential | ItemType::Wifi => {
            let (user, pass) = match i.item_type {
                ItemType::Login => (b("username"), b("password")),
                ItemType::Password => (String::new(), b("password")),
                ItemType::ApiCredential => {
                    if uris.is_empty() && !b("host").is_empty() {
                        uris.push(json!({ "match": null, "uri": b("host") }));
                    }
                    (b("username"), b("credential"))
                }
                _ => (b("ssid"), b("password")),
            };
            o["type"] = 1.into();
            o["login"] = json!({
                "uris": uris,
                "username": opt(&user),
                "password": opt(&pass),
                "totp": opt(&b("totp")),
            });
        }
        ItemType::Card => {
            let exp = b("expiry");
            let (y, m) = exp.split_once('-').map(|(y, m)| (y.to_owned(), m.trim_start_matches('0').to_owned())).unwrap_or_default();
            o["type"] = 3.into();
            o["card"] = json!({
                "cardholderName": opt(&b("cardholder")),
                "brand": opt(&b("brand")),
                "number": opt(&b("number")),
                "expMonth": opt(&m),
                "expYear": opt(&y),
                "code": opt(&b("cvv")),
            });
        }
        ItemType::Identity => {
            o["type"] = 4.into();
            o["identity"] = json!({
                "title": opt(&b("title")), "firstName": opt(&b("firstName")), "middleName": opt(&b("middleName")),
                "lastName": opt(&b("lastName")), "address1": opt(&b("address1")), "address2": opt(&b("address2")),
                "address3": null, "city": opt(&b("city")), "state": opt(&b("region")), "postalCode": opt(&b("postcode")),
                "country": opt(&b("country")), "company": opt(&b("company")), "email": opt(&b("email")),
                "phone": opt(&b("phone")), "ssn": null, "username": null, "passportNumber": null, "licenseNumber": null,
            });
        }
        ItemType::SshKey => {
            o["type"] = 5.into();
            o["sshKey"] = json!({
                "privateKey": opt(&b("privateKey")),
                "publicKey": opt(&b("publicKey")),
                "keyFingerprint": opt(&b("fingerprint")),
            });
        }
        _ => {
            o["type"] = 2.into();
            o["secureNote"] = json!({ "type": 0 });
        }
    }
    o
}

/// Bitwarden unencrypted JSON of some items.
pub fn bitwarden_json(items: &[&StoredItem]) -> Zeroizing<Vec<u8>> {
    let doc = json!({
        "encrypted": false,
        "folders": [],
        "items": items.iter().map(|i| bitwarden_item(i)).collect::<Vec<_>>(),
    });
    Zeroizing::new(serde_json::to_vec_pretty(&doc).expect("JSON serialisation cannot fail"))
}

/// CSV with the Bitwarden personal headers.
///
/// # Errors
/// `Io` when the CSV writer fails.
pub fn bitwarden_csv(items: &[&StoredItem]) -> Result<Zeroizing<Vec<u8>>> {
    let mut w = csv::Writer::from_writer(Vec::new());
    let io = |e: csv::Error| CoreError::Io(format!("CSV export failed: {e}"));
    w.write_record(["folder", "favorite", "type", "name", "notes", "fields", "reprompt", "login_uri", "login_username", "login_password", "login_totp"])
        .map_err(io)?;
    for i in items {
        let login_like = matches!(i.item_type, ItemType::Login | ItemType::Password | ItemType::ApiCredential | ItemType::Wifi);
        let consumed: &[&str] = if login_like { bw_consumed(i.item_type) } else { &[] };
        let fields: Vec<String> = i
            .fields
            .iter()
            .filter(|f| !f.builtin.as_deref().is_some_and(|b| consumed.contains(&b)))
            .filter(|f| !f.value.is_empty())
            .map(|f| format!("{}: {}", f.label, f.value))
            .collect();
        let b = |r: &str| i.builtin_value(r).to_owned();
        let (user, pass, totp) = match i.item_type {
            ItemType::Login => (b("username"), b("password"), b("totp")),
            ItemType::Password => (String::new(), b("password"), String::new()),
            ItemType::ApiCredential => (b("username"), b("credential"), String::new()),
            ItemType::Wifi => (b("ssid"), b("password"), String::new()),
            _ => Default::default(),
        };
        let uris: Vec<&str> = i.urls.iter().map(|u| u.url.as_str()).collect();
        let row = Zeroizing::new(vec![
            i.tags.first().cloned().unwrap_or_default(),
            if i.favorite { "1".into() } else { String::new() },
            if login_like { "login".into() } else { "note".into() },
            i.title.clone(),
            i.notes.clone(),
            fields.join("\n"),
            if i.reprompt { "1".into() } else { "0".into() },
            if login_like { uris.join(",") } else { String::new() },
            user,
            pass,
            totp,
        ]);
        w.write_record(row.iter()).map_err(io)?;
    }
    let bytes = w.into_inner().map_err(|e| CoreError::Io(format!("CSV export failed: {e}")))?;
    Ok(Zeroizing::new(bytes))
}

impl Vault {
    /// `export_vault` (after the shell verified the master password with
    /// [`Vault::verify_password`]): the file bytes of an export of every
    /// item that is not in Trash. `export_password` is needed for
    /// `CofferEncrypted` only; the `.cofferx` uses this vault's KDF settings.
    ///
    /// # Errors
    /// `Invalid` without an export password for `CofferEncrypted`;
    /// `WeakPassword`; `Io`.
    pub fn export(&self, kind: ExportKind, export_password: Option<&str>) -> Result<Zeroizing<Vec<u8>>> {
        let mut items: Vec<&StoredItem> = self.stored_items().filter(|i| i.state != ItemState::Trashed).collect();
        items.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
        let now = crate::time_util::fmt(crate::time_util::now());
        match kind {
            ExportKind::CofferJson => Ok(coffer_json(&items, &now)),
            ExportKind::CofferEncrypted => {
                let pw = export_password.ok_or_else(|| CoreError::invalid("An encrypted export needs its own password."))?;
                let json = coffer_json(&items, &now);
                Ok(Zeroizing::new(cofferx_seal(&json, pw, self.kdf())?))
            }
            ExportKind::BitwardenJson => Ok(bitwarden_json(&items)),
            ExportKind::Csv => bitwarden_csv(&items),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const XPW: &str = "export horse battery staple glimmer";

    #[test]
    fn cofferx_round_trip_and_wrong_password() {
        let json = br#"{"format":"coffer-json","version":1,"exported_at":"x","items":[]}"#;
        let sealed = cofferx_seal(json, XPW, KdfParams::TEST).unwrap();
        assert!(is_cofferx(&sealed));
        assert_eq!(&cofferx_open(&sealed, XPW).unwrap()[..], &json[..]);
        assert_eq!(cofferx_open(&sealed, "export horse battery staple glimmeR").unwrap_err(), CoreError::BadCredentials);
        assert_eq!(cofferx_seal(json, "abc", KdfParams::TEST).unwrap_err().code(), "weakPassword");
    }

    #[test]
    fn cofferx_header_is_bound() {
        let sealed = cofferx_seal(b"{}", XPW, KdfParams::TEST).unwrap();
        let mut v: Value = serde_json::from_slice(&sealed).unwrap();
        v["export_id"] = Uuid::new_v4().to_string().into();
        assert_eq!(cofferx_open(&serde_json::to_vec(&v).unwrap(), XPW).unwrap_err(), CoreError::BadCredentials);
        let mut v: Value = serde_json::from_slice(&sealed).unwrap();
        v["kdf"]["m_kib"] = 2_000_000.into();
        assert_eq!(cofferx_open(&serde_json::to_vec(&v).unwrap(), XPW).unwrap_err(), CoreError::KdfTooStrong);
        let mut v: Value = serde_json::from_slice(&sealed).unwrap();
        v["extra"] = 1.into();
        assert_eq!(cofferx_open(&serde_json::to_vec(&v).unwrap(), XPW).unwrap_err().code(), "corrupt");
    }

    #[test]
    fn cofferx_holds_no_plaintext() {
        let json = br#"{"secret":"Cofferx-Plain-Probe-99"}"#;
        let sealed = cofferx_seal(json, XPW, KdfParams::TEST).unwrap();
        assert!(!String::from_utf8_lossy(&sealed).contains("Cofferx-Plain-Probe-99"));
    }
}
