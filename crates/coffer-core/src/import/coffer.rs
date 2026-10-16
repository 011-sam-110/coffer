//! Coffer's own formats: Coffer JSON, `.cofferx` and a `.coffer` vault file.

use super::{ImportRequest, ParsedImport};
use crate::error::{CoreError, Result};
use crate::export::CofferJson;
use crate::model::ItemState;
use crate::secret_key::SecretKey;

/// Coffer JSON bytes.
pub(crate) fn parse_json(bytes: &[u8], format: &'static str, label: &'static str) -> Result<ParsedImport> {
    let doc: CofferJson = serde_json::from_slice(bytes)
        .map_err(|_| CoreError::UnsupportedFormat("This Coffer JSON file does not match the format.".into()))?;
    if doc.format != crate::export::COFFER_JSON_FORMAT || doc.version != 1 {
        return Err(CoreError::UnsupportedFormat("This Coffer JSON file has an unknown format or version.".into()));
    }
    let mut p = ParsedImport::new(format, label, "Coffer");
    for item in &doc.items {
        let mut i = item.clone();
        i.revisions.clear();
        i.import_batch = None;
        if i.state == ItemState::Trashed {
            p.skip(&i.title, "It is in Trash in the source.");
            continue;
        }
        p.items.push(i);
    }
    Ok(p)
}

/// A `.cofferx` file: needs its own password.
pub(crate) fn parse_cofferx(req: &ImportRequest<'_>) -> Result<ParsedImport> {
    let Some(pw) = req.password else {
        let mut p = ParsedImport::new("coffer-cofferx", "Coffer (encrypted)", "Coffer");
        p.needs_password = true;
        return Ok(p);
    };
    let json = crate::export::cofferx_open(req.bytes, pw)?;
    parse_json(&json, "coffer-cofferx", "Coffer (encrypted)")
}

/// A `.coffer` vault file: its master password, plus its Secret Key when its
/// key id differs from the open vault's.
pub(crate) fn parse_vault(req: &ImportRequest<'_>, own_key: Option<&SecretKey>) -> Result<ParsedImport> {
    let header = crate::vault_file::read_header(req.bytes)?;
    let key = match (req.secret_key, own_key) {
        (Some(k), _) if k.key_id() == header.key_id => Some(k),
        (_, Some(k)) if k.key_id() == header.key_id => Some(k),
        (Some(_), _) => return Err(CoreError::BadSecretKey("This Secret Key is for another vault.".into())),
        _ => None,
    };
    let mut p = ParsedImport::new("coffer-vault", "Coffer vault file", "Coffer");
    let (Some(pw), Some(key)) = (req.password, key) else {
        p.needs_password = req.password.is_none();
        p.needs_secret_key = key.is_none();
        return Ok(p);
    };
    let (file, keys) = crate::session::open_file(req.bytes, pw, key)?;
    for item in crate::session::decrypt_items(&keys, &file)? {
        let mut i = item;
        i.revisions.clear();
        i.import_batch = None;
        if i.state == ItemState::Trashed {
            p.skip(&i.title, "It is in Trash in the source.");
            continue;
        }
        p.items.push(i);
    }
    Ok(p)
}
