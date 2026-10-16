//! Importers (SPEC 8): format detection, parsing into an import plan,
//! commit in one step with the tag `Imported/<source>` and a batch id, and
//! undo by batch id (to Trash).
//!
//! Formats: Coffer (`.cofferx`, Coffer JSON, a `.coffer` vault file),
//! 1Password (`.1pux`, CSV), Bitwarden (JSON, CSV), Dashlane (CSV ZIP and
//! single CSVs), Chrome / Edge / Brave CSV, Firefox CSV. Encrypted Bitwarden
//! JSON is tier 3 and fails with `unsupportedFormat`.
//!
//! Every imported item gets new ids. A duplicate = same type, title,
//! username, password and first URL host (SPEC 7 "same site") as an item
//! already in the vault (not in Trash); duplicates are skipped.
//!
//! Shell flow: `import_preview` -> [`Vault::import_preview`] with an
//! [`ImportRequest`]; keep the [`ImportPlan`] by its preview id;
//! `import_commit` -> [`Vault::import_commit`]; `import_undo` ->
//! [`Vault::import_undo`].

mod bitwarden;
mod coffer;
mod csv_formats;
mod dashlane;
mod onepux;

use std::collections::{BTreeMap, HashSet};
use std::io::{Cursor, Read};

use uuid::Uuid;

use crate::error::{CoreError, Result};
use crate::health::site_of;
use crate::model::{FieldKind, ImportPreview, ImportResult, ItemState, ItemType, SkippedItem, StoredField, StoredItem};
use crate::secret_key::SecretKey;
use crate::session::Vault;
use crate::time_util;

/// Largest uncompressed ZIP entry Coffer reads (guards against zip bombs).
pub const MAX_ENTRY_BYTES: u64 = 64 * 1024 * 1024;

/// What to import.
pub struct ImportRequest<'a> {
    /// File name (for detection by extension; may be empty).
    pub file_name: &'a str,
    /// File bytes.
    pub bytes: &'a [u8],
    /// Password of a `.cofferx` or `.coffer` file.
    pub password: Option<&'a str>,
    /// Secret Key of a `.coffer` file whose key id differs from the open vault's.
    pub secret_key: Option<&'a SecretKey>,
}

/// The parsed content of an import file.
pub struct ParsedImport {
    /// Format id ("bitwarden-json", ...).
    pub format: &'static str,
    /// Label ("Bitwarden (JSON)").
    pub label: &'static str,
    /// Source name for the tag `Imported/<source>`.
    pub source: &'static str,
    /// Items (ids are replaced at commit).
    pub items: Vec<StoredItem>,
    /// Entries that could not be imported.
    pub skipped: Vec<SkippedItem>,
    /// Warnings.
    pub warnings: Vec<String>,
    /// The file needs its password.
    pub needs_password: bool,
    /// The file needs its Secret Key.
    pub needs_secret_key: bool,
}

impl ParsedImport {
    pub(crate) fn new(format: &'static str, label: &'static str, source: &'static str) -> Self {
        ParsedImport {
            format,
            label,
            source,
            items: Vec::new(),
            skipped: Vec::new(),
            warnings: Vec::new(),
            needs_password: false,
            needs_secret_key: false,
        }
    }

    pub(crate) fn skip(&mut self, title: &str, reason: &str) {
        self.skipped.push(SkippedItem { title: if title.is_empty() { "(no title)".into() } else { title.to_owned() }, reason: reason.into() });
    }

    pub(crate) fn warn(&mut self, w: impl Into<String>) {
        let w = w.into();
        if !self.warnings.contains(&w) {
            self.warnings.push(w);
        }
    }
}

impl std::fmt::Debug for ParsedImport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ParsedImport").field("format", &self.format).field("items", &self.items.len()).finish_non_exhaustive()
    }
}

/// A preview and the items behind it. Holds secrets (zeroed on drop).
pub struct ImportPlan {
    preview: ImportPreview,
    source: &'static str,
    items: Vec<StoredItem>,
    duplicate: Vec<bool>,
}

impl std::fmt::Debug for ImportPlan {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ImportPlan").field("preview", &self.preview).finish_non_exhaustive()
    }
}

impl ImportPlan {
    /// The preview for the UI (contract `ImportPreview`).
    pub fn preview(&self) -> &ImportPreview {
        &self.preview
    }

    /// The preview id.
    pub fn id(&self) -> &str {
        &self.preview.preview_id
    }
}

// ------------------------------------------------------------------ helpers for parsers

/// A new item of a type with its built-in fields.
pub(crate) fn new_item(t: ItemType, title: &str) -> StoredItem {
    StoredItem::new(t, title.trim(), &time_util::fmt(time_util::now()))
}

/// Sets a built-in field (adds it when absent) when `value` is not empty.
pub(crate) fn set(item: &mut StoredItem, role: &str, value: &str) {
    let v = value.trim_end_matches(['\r', '\n']);
    if v.trim().is_empty() {
        return;
    }
    let kind = crate::templates::template(item.item_type)
        .fields
        .iter()
        .find(|f| f.role == role)
        .map(|f| f.kind)
        .unwrap_or(FieldKind::Text);
    item.set_builtin(role, kind, v);
}

/// Adds a custom field when `value` is not empty.
pub(crate) fn custom(item: &mut StoredItem, label: &str, kind: FieldKind, value: &str, section: Option<&str>) {
    if value.trim().is_empty() {
        return;
    }
    let mut f = StoredField::new(if label.trim().is_empty() { "Field" } else { label.trim() }, kind, value, None);
    f.section = section.map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned);
    item.fields.push(f);
}

/// Adds a URL when not empty.
pub(crate) fn url(item: &mut StoredItem, u: &str) {
    let u = u.trim();
    if !u.is_empty() {
        item.urls.push(crate::model::ItemUrl { url: u.to_owned(), label: None });
    }
}

/// Adds a tag when not empty and not present.
pub(crate) fn tag(item: &mut StoredItem, t: &str) {
    let t = t.trim().trim_matches('/').trim();
    if !t.is_empty() && !item.tags.iter().any(|x| x == t) {
        item.tags.push(t.to_owned());
    }
}

/// Sets created/updated from RFC 3339 text when it parses.
pub(crate) fn set_times(item: &mut StoredItem, created: Option<&str>, updated: Option<&str>) {
    if let Some(c) = created.and_then(time_util::parse) {
        item.created_at = time_util::fmt(c);
    }
    if let Some(u) = updated.and_then(time_util::parse) {
        item.updated_at = time_util::fmt(u);
    }
}

/// A Unix time (seconds) as RFC 3339.
pub(crate) fn unix_to_str(secs: i64) -> Option<String> {
    time_util::from_unix(secs).map(time_util::fmt)
}

/// A title for an item without one: the URL host, else the username, else "Untitled".
pub(crate) fn fallback_title(title: &str, url: &str, user: &str) -> String {
    if !title.trim().is_empty() {
        return title.trim().to_owned();
    }
    if let Some(h) = crate::model::url_host(url) {
        return h.strip_prefix("www.").unwrap_or(&h).to_owned();
    }
    if !user.trim().is_empty() {
        return user.trim().to_owned();
    }
    "Untitled".to_owned()
}

/// `true` when the item holds nothing worth importing.
pub(crate) fn is_empty_item(item: &StoredItem) -> bool {
    item.fields.iter().all(|f| f.value.trim().is_empty()) && item.urls.is_empty() && item.notes.trim().is_empty()
}

/// Reads the files of a ZIP archive: (name, bytes), each capped at [`MAX_ENTRY_BYTES`].
pub(crate) fn read_zip(bytes: &[u8]) -> Result<Vec<(String, Vec<u8>)>> {
    let mut z = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| CoreError::UnsupportedFormat("This ZIP file is not readable.".into()))?;
    let mut out = Vec::new();
    for i in 0..z.len() {
        let mut f = z.by_index(i).map_err(|_| CoreError::Io("A file in this ZIP is not readable.".into()))?;
        if f.is_dir() {
            continue;
        }
        let name = f.name().map_err(|_| CoreError::Io("A file in this ZIP is not readable.".into()))?.into_owned();
        let mut buf = Vec::new();
        (&mut f).take(MAX_ENTRY_BYTES + 1).read_to_end(&mut buf).map_err(|_| CoreError::Io("A file in this ZIP is not readable.".into()))?;
        if buf.len() as u64 > MAX_ENTRY_BYTES {
            return Err(CoreError::UnsupportedFormat("A file in this ZIP is too large to import.".into()));
        }
        out.push((name, buf));
    }
    Ok(out)
}

/// Strips a UTF-8 BOM.
pub(crate) fn strip_bom(b: &[u8]) -> &[u8] {
    b.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(b)
}

/// Lower-cased, trimmed CSV header names.
pub(crate) fn csv_headers(bytes: &[u8]) -> Option<Vec<String>> {
    let mut r = csv::ReaderBuilder::new().has_headers(false).flexible(true).from_reader(strip_bom(bytes));
    let rec = r.records().next()?.ok()?;
    Some(rec.iter().map(|h| h.trim().to_lowercase()).collect())
}

// ------------------------------------------------------------------ detection

/// Detects the format and parses the file. `own_key` = the open vault's
/// Secret Key (used for a `.coffer` file with the same key id).
///
/// # Errors
/// `UnsupportedFormat` with a plain sentence; `BadCredentials`,
/// `BadSecretKey`, `Tampered`, KDF errors for Coffer files.
pub fn parse_import(req: &ImportRequest<'_>, own_key: Option<&SecretKey>) -> Result<ParsedImport> {
    let bytes = strip_bom(req.bytes);
    let name = req.file_name.to_ascii_lowercase();
    if bytes.starts_with(b"PK\x03\x04") || name.ends_with(".1pux") || name.ends_with(".zip") {
        let files = read_zip(bytes)?;
        if files.iter().any(|(n, _)| n == "export.data") {
            return onepux::parse(&files);
        }
        if files.iter().any(|(n, _)| n.to_ascii_lowercase().ends_with(".csv")) {
            return dashlane::parse_zip(&files);
        }
        return Err(CoreError::UnsupportedFormat("Coffer does not know this ZIP file. Import a 1Password .1pux or a Dashlane CSV export.".into()));
    }
    let first = bytes.iter().copied().find(|b| !b.is_ascii_whitespace());
    if first == Some(b'{') {
        let v: serde_json::Value = serde_json::from_slice(bytes)
            .map_err(|_| CoreError::UnsupportedFormat("This JSON file is not readable.".into()))?;
        match v.get("format").and_then(serde_json::Value::as_str) {
            Some(crate::vault_file::FORMAT) => return coffer::parse_vault(req, own_key),
            Some(crate::export::COFFERX_FORMAT) => return coffer::parse_cofferx(req),
            Some(crate::export::COFFER_JSON_FORMAT) => return coffer::parse_json(bytes, "coffer-json", "Coffer (JSON)"),
            _ => {}
        }
        if v.get("encrypted").and_then(serde_json::Value::as_bool) == Some(true) {
            return Err(CoreError::UnsupportedFormat(
                "This Bitwarden file is encrypted. Export from Bitwarden as JSON (not encrypted), import it, then delete that file.".into(),
            ));
        }
        if v.get("items").is_some_and(serde_json::Value::is_array) {
            return bitwarden::parse_json(&v);
        }
        if v.get("AUTHENTIFIANT").is_some() {
            return Err(CoreError::UnsupportedFormat("Coffer reads Dashlane's CSV export. Export from Dashlane as CSV, then import the ZIP.".into()));
        }
        return Err(CoreError::UnsupportedFormat("Coffer does not know this JSON file.".into()));
    }
    if let Some(h) = csv_headers(bytes) {
        return csv_formats::parse(bytes, &h);
    }
    Err(CoreError::UnsupportedFormat("Coffer does not know this file. See the list of formats Coffer imports.".into()))
}

fn dup_key(i: &StoredItem) -> (ItemType, String, String, String, Option<String>) {
    (i.item_type, i.title.trim().to_owned(), i.builtin_value("username").to_owned(), i.password().to_owned(), site_of(i))
}

impl Vault {
    /// `import_preview`: parses the file and compares it with this vault.
    /// When the file needs a password or Secret Key the plan is empty and
    /// `needsPassword` / `needsSecretKey` is set: ask, then call again.
    ///
    /// # Errors
    /// As [`parse_import`].
    pub fn import_preview(&self, req: &ImportRequest<'_>) -> Result<ImportPlan> {
        let parsed = parse_import(req, Some(self.own_secret_key()))?;
        let existing: HashSet<_> = self.stored_items().filter(|i| i.state != ItemState::Trashed).map(dup_key).collect();
        let duplicate: Vec<bool> = parsed.items.iter().map(|i| existing.contains(&dup_key(i))).collect();
        let mut counts: BTreeMap<ItemType, usize> = BTreeMap::new();
        for (i, d) in parsed.items.iter().zip(&duplicate) {
            if !d {
                *counts.entry(i.item_type).or_default() += 1;
            }
        }
        let dups = duplicate.iter().filter(|d| **d).count();
        let preview = ImportPreview {
            preview_id: Uuid::new_v4().to_string(),
            format: parsed.format.into(),
            format_label: parsed.label.into(),
            total: parsed.items.len() - dups,
            counts,
            duplicates: dups,
            skipped: parsed.skipped.clone(),
            warnings: parsed.warnings.clone(),
            needs_password: parsed.needs_password,
            needs_secret_key: parsed.needs_secret_key,
        };
        Ok(ImportPlan { preview, source: parsed.source, items: parsed.items.clone(), duplicate })
    }

    /// `import_commit`: adds every non-duplicate item of the plan in one
    /// step, with new ids, the tag `Imported/<source>` and a new batch id.
    /// Save afterwards.
    pub fn import_commit(&mut self, plan: ImportPlan) -> ImportResult {
        let batch_id = Uuid::new_v4().to_string();
        let tag_name = format!("Imported/{}", plan.source);
        let mut out = Vec::new();
        for (item, dup) in plan.items.iter().zip(&plan.duplicate) {
            if *dup {
                continue;
            }
            let mut it = item.clone();
            it.id = Uuid::new_v4();
            for f in &mut it.fields {
                f.id = Uuid::new_v4().to_string();
            }
            for h in &mut it.password_history {
                h.id = Uuid::new_v4().to_string();
            }
            it.revisions.clear();
            tag(&mut it, &tag_name);
            it.import_batch = Some(batch_id.clone());
            if it.state == ItemState::Trashed && it.trashed_at.is_none() {
                it.trashed_at = Some(time_util::fmt(time_util::now()));
            }
            out.push(it);
        }
        let imported = out.len();
        self.insert_new_items(out);
        ImportResult { batch_id, imported, skipped: plan.preview.duplicates + plan.preview.skipped.len(), tag: tag_name }
    }

    /// `import_undo`: moves every item of that batch to Trash; returns the count.
    pub fn import_undo(&mut self, batch_id: &str) -> usize {
        self.trash_batch(batch_id)
    }
}

#[cfg(test)]
mod tests;
