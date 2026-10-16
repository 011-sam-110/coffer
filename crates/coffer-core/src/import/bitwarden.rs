//! Bitwarden unencrypted JSON (personal and organisation exports).

use std::collections::HashMap;

use serde_json::Value;

use super::{ParsedImport, custom, fallback_title, new_item, set, set_times, tag, url};
use crate::error::Result;
use crate::model::{FieldKind, HistoryValue, ItemState, ItemType, StoredItem};

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

fn sv(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        _ => String::new(),
    }
}

pub(crate) fn parse_json(doc: &Value) -> Result<ParsedImport> {
    let mut p = ParsedImport::new("bitwarden-json", "Bitwarden (JSON)", "Bitwarden");
    let mut groups: HashMap<String, String> = HashMap::new();
    for key in ["folders", "collections"] {
        for f in doc.get(key).and_then(Value::as_array).into_iter().flatten() {
            groups.insert(s(f, "id").to_owned(), s(f, "name").to_owned());
        }
    }
    let mut passkeys = 0;
    for it in doc.get("items").and_then(Value::as_array).into_iter().flatten() {
        let name = s(it, "name");
        let t = it.get("type").and_then(Value::as_u64).unwrap_or(0);
        let mut item: StoredItem = match t {
            1 => {
                let login = it.get("login").cloned().unwrap_or(Value::Null);
                let first_uri = login.get("uris").and_then(Value::as_array).and_then(|a| a.first()).map(|u| s(u, "uri")).unwrap_or("");
                let mut i = new_item(ItemType::Login, &fallback_title(name, first_uri, s(&login, "username")));
                set(&mut i, "username", s(&login, "username"));
                set(&mut i, "password", s(&login, "password"));
                set(&mut i, "totp", s(&login, "totp"));
                for u in login.get("uris").and_then(Value::as_array).into_iter().flatten() {
                    url(&mut i, s(u, "uri"));
                }
                for pk in login.get("fido2Credentials").and_then(Value::as_array).into_iter().flatten() {
                    passkeys += 1;
                    let rp = s(pk, "rpId");
                    custom(&mut i, "Passkey", FieldKind::Text, &format!("Stored passkey for {rp} (Coffer cannot sign in with it)"), None);
                }
                i
            }
            2 => new_item(ItemType::Note, &fallback_title(name, "", "")),
            3 => {
                let c = it.get("card").cloned().unwrap_or(Value::Null);
                let mut i = new_item(ItemType::Card, &fallback_title(name, "", ""));
                set(&mut i, "cardholder", s(&c, "cardholderName"));
                set(&mut i, "number", s(&c, "number"));
                set(&mut i, "cvv", s(&c, "code"));
                set(&mut i, "brand", s(&c, "brand"));
                let m = c.get("expMonth").map(sv).unwrap_or_default();
                let y = c.get("expYear").map(sv).unwrap_or_default();
                if let (Ok(m), Ok(y)) = (m.trim().parse::<u32>(), y.trim().parse::<u32>()) {
                    let y = if y < 100 { 2000 + y } else { y };
                    set(&mut i, "expiry", &format!("{y:04}-{m:02}"));
                }
                i
            }
            4 => {
                let d = it.get("identity").cloned().unwrap_or(Value::Null);
                let mut i = new_item(ItemType::Identity, &fallback_title(name, "", ""));
                for (role, key) in [
                    ("title", "title"),
                    ("firstName", "firstName"),
                    ("middleName", "middleName"),
                    ("lastName", "lastName"),
                    ("address1", "address1"),
                    ("address2", "address2"),
                    ("city", "city"),
                    ("region", "state"),
                    ("postcode", "postalCode"),
                    ("country", "country"),
                    ("company", "company"),
                    ("email", "email"),
                    ("phone", "phone"),
                ] {
                    set(&mut i, role, s(&d, key));
                }
                custom(&mut i, "Address line 3", FieldKind::Text, s(&d, "address3"), None);
                custom(&mut i, "Username", FieldKind::Text, s(&d, "username"), None);
                custom(&mut i, "Social security number", FieldKind::Concealed, s(&d, "ssn"), None);
                custom(&mut i, "Passport number", FieldKind::Concealed, s(&d, "passportNumber"), None);
                custom(&mut i, "Licence number", FieldKind::Concealed, s(&d, "licenseNumber"), None);
                i
            }
            5 => {
                let k = it.get("sshKey").cloned().unwrap_or(Value::Null);
                let mut i = new_item(ItemType::SshKey, &fallback_title(name, "", ""));
                set(&mut i, "privateKey", s(&k, "privateKey"));
                set(&mut i, "publicKey", s(&k, "publicKey"));
                set(&mut i, "fingerprint", s(&k, "keyFingerprint"));
                i
            }
            6 => {
                // Bank account (newest Bitwarden; field names unverified):
                // keep every value as a custom field.
                let mut i = new_item(ItemType::Bank, &fallback_title(name, "", ""));
                if let Some(o) = it.get("bankAccount").and_then(Value::as_object) {
                    for (k, v) in o {
                        custom(&mut i, k, FieldKind::Text, &sv(v), None);
                    }
                }
                p.warn("Bitwarden bank accounts came in with their fields as custom fields. Check them.");
                i
            }
            other => {
                p.skip(name, &format!("Coffer does not know the Bitwarden item type {other}."));
                continue;
            }
        };
        item.notes = s(it, "notes").to_owned();
        item.favorite = it.get("favorite").and_then(Value::as_bool).unwrap_or(false);
        item.reprompt = it.get("reprompt").and_then(Value::as_u64).unwrap_or(0) == 1;
        for f in it.get("fields").and_then(Value::as_array).into_iter().flatten() {
            let ft = f.get("type").and_then(Value::as_u64).unwrap_or(0);
            let value = f.get("value").map(sv).unwrap_or_default();
            let kind = match ft {
                1 => FieldKind::Concealed,
                2 => FieldKind::Boolean,
                3 => continue, // linked field: no value of its own
                _ => FieldKind::Text,
            };
            custom(&mut item, s(f, "name"), kind, &value, None);
        }
        for h in it.get("passwordHistory").and_then(Value::as_array).into_iter().flatten() {
            let pw = s(h, "password");
            if !pw.is_empty() {
                let when = crate::time_util::parse(s(h, "lastUsedDate")).and_then(crate::time_util::fmt).unwrap_or_default();
                item.password_history.push(HistoryValue { id: uuid::Uuid::new_v4().to_string(), value: pw.to_owned(), changed_at: when });
            }
        }
        item.password_history.truncate(crate::session::PASSWORD_HISTORY_MAX);
        if let Some(g) = groups.get(s(it, "folderId")) {
            tag(&mut item, g);
        }
        for c in it.get("collectionIds").and_then(Value::as_array).into_iter().flatten() {
            if let Some(g) = c.as_str().and_then(|c| groups.get(c)) {
                tag(&mut item, g);
            }
        }
        set_times(&mut item, it.get("creationDate").and_then(Value::as_str), it.get("revisionDate").and_then(Value::as_str));
        if it.get("archivedDate").and_then(Value::as_str).is_some() {
            item.state = ItemState::Archived;
        }
        if it.get("deletedDate").and_then(Value::as_str).is_some() {
            item.state = ItemState::Trashed;
        }
        p.items.push(item);
    }
    if passkeys > 0 {
        p.warn(format!("{passkeys} passkey(s) came in as data only: Coffer cannot sign in with a passkey."));
    }
    Ok(p)
}
