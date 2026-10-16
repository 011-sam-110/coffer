//! 1Password `.1pux` (1Password 8 unencrypted export): a ZIP with
//! `export.attributes`, `export.data` and `files/`. Coffer reads every
//! account and every vault and keeps the vault name as a tag.
//!
//! Section field ids beyond a few are UNVERIFIED (import-formats.md): known
//! ids fill built-in fields; every other field becomes a custom field in its
//! section; an unknown value type is read as text.

use serde_json::Value;

use super::{ParsedImport, custom, fallback_title, new_item, set, tag, unix_to_str, url};
use crate::error::{CoreError, Result};
use crate::model::{FieldKind, HistoryValue, ItemState, ItemType, StoredItem};

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

fn category(code: &str) -> (ItemType, Option<&'static str>) {
    match code {
        "001" | "102" | "110" | "111" => (ItemType::Login, None),
        "002" => (ItemType::Card, None),
        "003" | "006" | "105" | "107" | "113" => (ItemType::Note, None),
        "004" => (ItemType::Identity, None),
        "005" => (ItemType::Password, None),
        "100" => (ItemType::License, None),
        "101" => (ItemType::Bank, None),
        "103" => (ItemType::Document, Some("Driving licence")),
        "106" => (ItemType::Document, Some("Passport")),
        "104" | "108" => (ItemType::Document, Some("Other")),
        "109" => (ItemType::Wifi, None),
        "112" => (ItemType::ApiCredential, None),
        "114" => (ItemType::SshKey, None),
        _ => (ItemType::Note, None),
    }
}

/// Known section field ids -> built-in role, per type.
fn role_for(t: ItemType, id: &str) -> Option<&'static str> {
    let id = id.to_ascii_lowercase();
    Some(match (t, id.as_str()) {
        (ItemType::Card, "cardholder") => "cardholder",
        (ItemType::Card, "ccnum") => "number",
        (ItemType::Card, "cvv") => "cvv",
        (ItemType::Card, "expiry") => "expiry",
        (ItemType::Card, "type") => "brand",
        (ItemType::Card, "pin") => "pin",
        (ItemType::Identity, "firstname") => "firstName",
        (ItemType::Identity, "initial") => "middleName",
        (ItemType::Identity, "lastname") => "lastName",
        (ItemType::Identity, "birthdate") => "birthDate",
        (ItemType::Identity, "email") => "email",
        (ItemType::Identity, "defphone" | "cellphone" | "homephone") => "phone",
        (ItemType::Identity, "company") => "company",
        (ItemType::Bank, "bankname") => "bankName",
        (ItemType::Bank, "owner") => "holder",
        (ItemType::Bank, "accountno") => "accountNumber",
        (ItemType::Bank, "routingno") => "sortCode",
        (ItemType::Bank, "swift") => "swift",
        (ItemType::Bank, "iban") => "iban",
        (ItemType::Bank, "telephonepin") => "pin",
        (ItemType::Document, "number") => "number",
        (ItemType::Document, "fullname") => "fullName",
        (ItemType::Document, "issue_date") => "issued",
        (ItemType::Document, "expiry_date") => "expires",
        (ItemType::Document, "issuing_country" | "country") => "country",
        (ItemType::Wifi, "network_name") => "ssid",
        (ItemType::Wifi, "wireless_password" | "password") => "password",
        (ItemType::Wifi, "wireless_security") => "security",
        (ItemType::ApiCredential, "username") => "username",
        (ItemType::ApiCredential, "credential") => "credential",
        (ItemType::ApiCredential, "hostname") => "host",
        (ItemType::ApiCredential, "expires") => "expires",
        (ItemType::License, "product_version") => "version",
        (ItemType::License, "reg_code") => "licenseKey",
        (ItemType::License, "reg_name") => "licensedTo",
        (ItemType::License, "reg_email") => "email",
        (ItemType::License, "order_date") => "purchaseDate",
        (ItemType::SshKey, "private_key") => "privateKey",
        (ItemType::SshKey, "public_key") => "publicKey",
        (ItemType::SshKey, "fingerprint") => "fingerprint",
        (ItemType::Login | ItemType::Password, "password") => "password",
        (ItemType::Login, "username") => "username",
        _ => return None,
    })
}

/// (kind, text) of a 1PUX field value object.
fn value_of(v: &Value) -> (FieldKind, String) {
    let Some((k, inner)) = v.as_object().and_then(|o| o.iter().next()) else {
        return (FieldKind::Text, String::new());
    };
    let text = |x: &Value| match x {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        _ => String::new(),
    };
    match k.as_str() {
        "concealed" => (FieldKind::Concealed, text(inner)),
        "totp" => (FieldKind::Totp, text(inner)),
        "date" => {
            let d = inner.as_i64().and_then(unix_to_str).map(|t| t[..10].to_owned()).unwrap_or_default();
            (FieldKind::Date, d)
        }
        "monthYear" => {
            let n = inner.as_i64().unwrap_or(0);
            let s = if n > 0 { format!("{:04}-{:02}", n / 100, n % 100) } else { String::new() };
            (FieldKind::MonthYear, s)
        }
        "email" => (FieldKind::Email, inner.get("email_address").map(text).unwrap_or_else(|| text(inner))),
        "url" => (FieldKind::Url, text(inner)),
        "phone" => (FieldKind::Phone, text(inner)),
        "creditCardNumber" => (FieldKind::CardNumber, text(inner)),
        "address" => {
            let parts: Vec<String> = ["street", "city", "state", "zip", "country"]
                .iter()
                .map(|k| inner.get(*k).map(text).unwrap_or_default())
                .filter(|s| !s.is_empty())
                .collect();
            (FieldKind::Multiline, parts.join("\n"))
        }
        _ => (FieldKind::Text, text(inner)),
    }
}

fn parse_item(p: &mut ParsedImport, it: &Value, vault_name: &str) -> Option<StoredItem> {
    let ov = it.get("overview").cloned().unwrap_or(Value::Null);
    let det = it.get("details").cloned().unwrap_or(Value::Null);
    let (t, doc_kind) = category(s(it, "categoryUuid"));
    let first_url = s(&ov, "url");
    let mut i = new_item(t, &fallback_title(s(&ov, "title"), first_url, ""));
    if let Some(k) = doc_kind {
        set(&mut i, "docKind", k);
    }
    for lf in det.get("loginFields").and_then(Value::as_array).into_iter().flatten() {
        match s(lf, "designation") {
            "username" => set(&mut i, "username", s(lf, "value")),
            "password" => set(&mut i, "password", s(lf, "value")),
            _ => {
                let kind = if s(lf, "fieldType") == "P" { FieldKind::Concealed } else { FieldKind::Text };
                custom(&mut i, s(lf, "name"), kind, s(lf, "value"), None);
            }
        }
    }
    if !s(&det, "password").is_empty() {
        set(&mut i, "password", s(&det, "password"));
    }
    i.notes = s(&det, "notesPlain").to_owned();
    let mut urls: Vec<String> = ov.get("urls").and_then(Value::as_array).into_iter().flatten().map(|u| s(u, "url").to_owned()).collect();
    if urls.is_empty() && !first_url.is_empty() {
        urls.push(first_url.to_owned());
    }
    for u in &urls {
        url(&mut i, u);
    }
    for sec in det.get("sections").and_then(Value::as_array).into_iter().flatten() {
        let section = s(sec, "title");
        for f in sec.get("fields").and_then(Value::as_array).into_iter().flatten() {
            let (kind, value) = value_of(f.get("value").unwrap_or(&Value::Null));
            if value.is_empty() {
                continue;
            }
            let role = if kind == FieldKind::Totp && i.item_type == ItemType::Login { Some("totp") } else { role_for(t, s(f, "id")) };
            match role {
                Some(r) if i.builtin_value(r).is_empty() => set(&mut i, r, &value),
                _ => custom(&mut i, s(f, "title"), kind, &value, Some(section)),
            }
        }
    }
    for h in det.get("passwordHistory").and_then(Value::as_array).into_iter().flatten() {
        let v = s(h, "value");
        if !v.is_empty() {
            let when = h.get("time").and_then(Value::as_i64).and_then(unix_to_str).unwrap_or_default();
            i.password_history.push(HistoryValue { id: uuid::Uuid::new_v4().to_string(), value: v.to_owned(), changed_at: when });
        }
    }
    i.password_history.truncate(crate::session::PASSWORD_HISTORY_MAX);
    i.favorite = it.get("favIndex").and_then(Value::as_i64).unwrap_or(0) > 0;
    if s(it, "state") == "archived" {
        i.state = ItemState::Archived;
    }
    if let Some(c) = it.get("createdAt").and_then(Value::as_i64).and_then(unix_to_str) {
        i.created_at = c;
    }
    if let Some(u) = it.get("updatedAt").and_then(Value::as_i64).and_then(unix_to_str) {
        i.updated_at = u;
    }
    for t in ov.get("tags").and_then(Value::as_array).into_iter().flatten() {
        if let Some(t) = t.as_str() {
            tag(&mut i, t);
        }
    }
    tag(&mut i, vault_name);
    if it.get("file").is_some() || det.get("documentAttributes").is_some() {
        p.warn("Files and documents attached in 1Password are not imported (Coffer has no attachments yet).");
    }
    Some(i)
}

pub(crate) fn parse(files: &[(String, Vec<u8>)]) -> Result<ParsedImport> {
    let mut p = ParsedImport::new("1password-1pux", "1Password (1PUX)", "1Password");
    let data = files
        .iter()
        .find(|(n, _)| n == "export.data")
        .map(|(_, b)| b)
        .ok_or_else(|| CoreError::UnsupportedFormat("This .1pux file has no export.data.".into()))?;
    let doc: Value = serde_json::from_slice(data).map_err(|_| CoreError::UnsupportedFormat("The export.data of this .1pux is not readable.".into()))?;
    let accounts = doc
        .get("accounts")
        .and_then(Value::as_array)
        .ok_or_else(|| CoreError::UnsupportedFormat("This .1pux file has no accounts.".into()))?;
    for acc in accounts {
        for vault in acc.get("vaults").and_then(Value::as_array).into_iter().flatten() {
            let vname = vault.get("attrs").map(|a| s(a, "name")).unwrap_or("");
            for it in vault.get("items").and_then(Value::as_array).into_iter().flatten() {
                let title = it.get("overview").map(|o| s(o, "title")).unwrap_or("").to_owned();
                match parse_item(&mut p, it, vname) {
                    Some(i) => p.items.push(i),
                    None => p.skip(&title, "This item is not readable."),
                }
            }
        }
    }
    Ok(p)
}
