//! CSV importers: Bitwarden, 1Password, Chrome / Edge / Brave, Firefox, and
//! routing of single Dashlane CSVs. Headers match without case.

use std::collections::HashMap;

use super::{ParsedImport, custom, fallback_title, is_empty_item, new_item, set, strip_bom, tag, unix_to_str, url};
use crate::error::{CoreError, Result};
use crate::model::{FieldKind, ItemState, ItemType};

/// A CSV row by lower-case header name.
pub(crate) struct Row {
    map: HashMap<String, String>,
}

impl Row {
    pub(crate) fn get(&self, k: &str) -> &str {
        self.map.get(k).map(String::as_str).unwrap_or("")
    }

    /// The first non-empty value among several header names.
    pub(crate) fn any(&self, ks: &[&str]) -> &str {
        ks.iter().map(|k| self.get(k)).find(|v| !v.is_empty()).unwrap_or("")
    }
}

impl Drop for Row {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        for v in self.map.values_mut() {
            v.zeroize();
        }
    }
}

/// Reads every row of a CSV with a header line.
pub(crate) fn rows(bytes: &[u8]) -> Result<Vec<Row>> {
    let mut r = csv::ReaderBuilder::new().has_headers(true).flexible(true).from_reader(strip_bom(bytes));
    let headers: Vec<String> = r
        .headers()
        .map_err(|_| CoreError::UnsupportedFormat("This CSV file is not readable.".into()))?
        .iter()
        .map(|h| h.trim().to_lowercase())
        .collect();
    let mut out = Vec::new();
    for rec in r.records() {
        let rec = rec.map_err(|_| CoreError::UnsupportedFormat("A line of this CSV file is not readable.".into()))?;
        let mut map = HashMap::new();
        for (h, v) in headers.iter().zip(rec.iter()) {
            map.insert(h.clone(), v.to_owned());
        }
        out.push(Row { map });
    }
    Ok(out)
}

fn has(h: &[String], k: &str) -> bool {
    h.iter().any(|x| x == k)
}

/// Routes a CSV by its header line.
pub(crate) fn parse(bytes: &[u8], h: &[String]) -> Result<ParsedImport> {
    if has(h, "login_password") && has(h, "login_uri") && has(h, "type") && has(h, "name") {
        return bitwarden_csv(bytes);
    }
    if h.len() >= 4 && h[..4] == ["name", "url", "username", "password"] {
        return chrome(bytes);
    }
    if has(h, "url") && has(h, "username") && has(h, "password") && has(h, "httprealm") {
        return firefox(bytes);
    }
    if h.first().map(String::as_str) == Some("username") && has(h, "title") && has(h, "password") {
        return super::dashlane::parse_single(bytes);
    }
    if h.len() >= 2 {
        let two = (h[0].as_str(), h[1].as_str());
        if matches!(two, ("type", "account_name") | ("type", "number") | ("type", "title") | ("title", "note")) {
            return super::dashlane::parse_single(bytes);
        }
    }
    if has(h, "title") && has(h, "password") && (has(h, "username") || has(h, "website") || has(h, "url") || has(h, "urls")) {
        return onepassword_csv(bytes);
    }
    Err(CoreError::UnsupportedFormat("Coffer does not know the columns of this CSV file.".into()))
}

fn bitwarden_csv(bytes: &[u8]) -> Result<ParsedImport> {
    let mut p = ParsedImport::new("bitwarden-csv", "Bitwarden (CSV)", "Bitwarden");
    for r in rows(bytes)? {
        let kind = r.get("type").to_ascii_lowercase();
        let name = r.get("name");
        let mut item = match kind.as_str() {
            "login" => {
                let mut i = new_item(ItemType::Login, &fallback_title(name, r.get("login_uri"), r.get("login_username")));
                set(&mut i, "username", r.get("login_username"));
                set(&mut i, "password", r.get("login_password"));
                set(&mut i, "totp", r.get("login_totp"));
                for u in r.get("login_uri").split([',', '\n']) {
                    url(&mut i, u);
                }
                i
            }
            "note" => new_item(ItemType::Note, &fallback_title(name, "", "")),
            other => {
                p.skip(name, &format!("Coffer does not know the Bitwarden type \"{other}\"."));
                continue;
            }
        };
        item.notes = r.get("notes").to_owned();
        item.favorite = r.get("favorite") == "1" || r.get("favorite").eq_ignore_ascii_case("true");
        item.reprompt = r.get("reprompt") == "1";
        tag(&mut item, r.get("folder"));
        for c in r.get("collections").split(',') {
            tag(&mut item, c);
        }
        for line in r.get("fields").lines() {
            if let Some((k, v)) = line.split_once(':') {
                custom(&mut item, k, FieldKind::Text, v.trim(), None);
            } else {
                custom(&mut item, "Field", FieldKind::Text, line, None);
            }
        }
        if !r.get("archiveddate").is_empty() {
            item.state = ItemState::Archived;
        }
        if is_empty_item(&item) && name.is_empty() {
            p.skip(name, "The entry is empty.");
            continue;
        }
        p.items.push(item);
    }
    Ok(p)
}

fn chrome(bytes: &[u8]) -> Result<ParsedImport> {
    let mut p = ParsedImport::new("browser-csv", "Chrome, Edge or Brave (CSV)", "Browser");
    for r in rows(bytes)? {
        let mut i = new_item(ItemType::Login, &fallback_title(r.get("name"), r.get("url"), r.get("username")));
        set(&mut i, "username", r.get("username"));
        set(&mut i, "password", r.get("password"));
        url(&mut i, r.get("url"));
        i.notes = r.any(&["note", "notes"]).to_owned();
        if is_empty_item(&i) {
            p.skip(r.get("name"), "The entry is empty.");
            continue;
        }
        p.items.push(i);
    }
    Ok(p)
}

fn ms_to_str(v: &str) -> Option<String> {
    v.trim().parse::<i64>().ok().and_then(|ms| unix_to_str(ms / 1000))
}

fn firefox(bytes: &[u8]) -> Result<ParsedImport> {
    let mut p = ParsedImport::new("firefox-csv", "Firefox (CSV)", "Firefox");
    for r in rows(bytes)? {
        let u = r.get("url");
        if u.starts_with("chrome://") {
            p.skip(u, "Firefox's own saved account, not a website login.");
            continue;
        }
        let mut i = new_item(ItemType::Login, &fallback_title("", u, r.get("username")));
        set(&mut i, "username", r.get("username"));
        set(&mut i, "password", r.get("password"));
        url(&mut i, u);
        if let Some(c) = ms_to_str(r.get("timecreated")) {
            i.created_at = c.clone();
            i.updated_at = c;
        }
        if !i.password().is_empty() {
            i.password_changed_at = ms_to_str(r.get("timepasswordchanged"));
        }
        if is_empty_item(&i) {
            p.skip(u, "The entry is empty.");
            continue;
        }
        p.items.push(i);
    }
    Ok(p)
}

fn truthy(v: &str) -> bool {
    matches!(v.trim().to_ascii_lowercase().as_str(), "true" | "1" | "yes")
}

fn onepassword_csv(bytes: &[u8]) -> Result<ParsedImport> {
    let mut p = ParsedImport::new("1password-csv", "1Password (CSV)", "1Password");
    for r in rows(bytes)? {
        let site = r.any(&["website", "url", "urls"]);
        let mut i = new_item(ItemType::Login, &fallback_title(r.get("title"), site, r.get("username")));
        set(&mut i, "username", r.get("username"));
        set(&mut i, "password", r.get("password"));
        set(&mut i, "totp", r.any(&["one-time password", "otpauth", "otp"]));
        for u in site.split(['\n', ',']) {
            url(&mut i, u);
        }
        i.notes = r.any(&["notes", "notesplain"]).to_owned();
        i.favorite = truthy(r.get("favorite"));
        if truthy(r.get("archived")) {
            i.state = ItemState::Archived;
        }
        for t in r.get("tags").split([';', ',']) {
            tag(&mut i, t);
        }
        if is_empty_item(&i) {
            p.skip(r.get("title"), "The entry is empty.");
            continue;
        }
        p.items.push(i);
    }
    Ok(p)
}
