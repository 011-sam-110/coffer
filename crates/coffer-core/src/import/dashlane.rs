//! Dashlane CSV export: a ZIP of credentials.csv, securenotes.csv,
//! payments.csv, ids.csv and personalInfo.csv, or one of those files alone.
//! The kind of each file comes from its first two header columns:
//! `username` = logins; `type, account_name` = payments; `type, number` =
//! IDs; `type, title` = personal info; `title, note` = notes.

use super::csv_formats::{Row, rows};
use super::{ParsedImport, csv_headers, custom, fallback_title, is_empty_item, new_item, set, tag, url};
use crate::error::Result;
use crate::model::{FieldKind, ItemType};

const LABEL_ZIP: &str = "Dashlane (CSV ZIP)";
const LABEL_ONE: &str = "Dashlane (CSV)";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Credentials,
    Payments,
    Ids,
    Personal,
    Notes,
}

fn kind_of(h: &[String]) -> Option<Kind> {
    let a = h.first().map(String::as_str)?;
    let b = h.get(1).map(String::as_str).unwrap_or("");
    match (a, b) {
        ("username", _) => Some(Kind::Credentials),
        ("type", "account_name") => Some(Kind::Payments),
        ("type", "number") => Some(Kind::Ids),
        ("type", "title") => Some(Kind::Personal),
        ("title", "note") => Some(Kind::Notes),
        _ => None,
    }
}

pub(crate) fn parse_zip(files: &[(String, Vec<u8>)]) -> Result<ParsedImport> {
    let mut p = ParsedImport::new("dashlane-csv-zip", LABEL_ZIP, "Dashlane");
    let mut any = false;
    for (name, bytes) in files {
        if !name.to_ascii_lowercase().ends_with(".csv") {
            continue;
        }
        let Some(h) = csv_headers(bytes) else { continue };
        match kind_of(&h) {
            Some(k) => {
                any = true;
                add_file(&mut p, k, bytes)?;
            }
            None => p.warn(format!("Coffer skipped {name}: its columns are not a Dashlane export.")),
        }
    }
    if !any {
        return Err(crate::error::CoreError::UnsupportedFormat("This ZIP holds no Dashlane CSV file.".into()));
    }
    Ok(p)
}

pub(crate) fn parse_single(bytes: &[u8]) -> Result<ParsedImport> {
    let mut p = ParsedImport::new("dashlane-csv", LABEL_ONE, "Dashlane");
    let h = csv_headers(bytes).unwrap_or_default();
    let k = kind_of(&h).ok_or_else(|| crate::error::CoreError::UnsupportedFormat("Coffer does not know the columns of this CSV file.".into()))?;
    add_file(&mut p, k, bytes)?;
    Ok(p)
}

fn add_file(p: &mut ParsedImport, k: Kind, bytes: &[u8]) -> Result<()> {
    for r in rows(bytes)? {
        let item = match k {
            Kind::Credentials => credential(&r),
            Kind::Notes => {
                let mut i = new_item(ItemType::Note, &fallback_title(r.get("title"), "", ""));
                i.notes = r.get("note").to_owned();
                Some(i)
            }
            Kind::Payments => payment(p, &r),
            Kind::Ids => Some(id_doc(&r)),
            Kind::Personal => Some(personal(&r)),
        };
        let Some(item) = item else { continue };
        if is_empty_item(&item) {
            p.skip(&item.title, "The entry is empty.");
            continue;
        }
        p.items.push(item);
    }
    Ok(())
}

fn credential(r: &Row) -> Option<crate::model::StoredItem> {
    let mut i = new_item(ItemType::Login, &fallback_title(r.get("title"), r.get("url"), r.get("username")));
    set(&mut i, "username", r.get("username"));
    set(&mut i, "password", r.get("password"));
    set(&mut i, "totp", r.any(&["otpurl", "otpsecret"]));
    url(&mut i, r.get("url"));
    custom(&mut i, "Username 2", FieldKind::Text, r.get("username2"), None);
    custom(&mut i, "Username 3", FieldKind::Text, r.get("username3"), None);
    i.notes = r.get("note").to_owned();
    tag(&mut i, r.get("category"));
    Some(i)
}

fn payment(p: &mut ParsedImport, r: &Row) -> Option<crate::model::StoredItem> {
    match r.get("type") {
        "credit_card" => {
            let mut i = new_item(ItemType::Card, &fallback_title(r.get("account_name"), "", ""));
            set(&mut i, "cardholder", r.get("account_holder"));
            set(&mut i, "number", r.get("cc_number"));
            set(&mut i, "cvv", r.get("code"));
            let (m, y) = (r.get("expiration_month"), r.get("expiration_year"));
            if let (Ok(m), Ok(y)) = (m.trim().parse::<u32>(), y.trim().parse::<u32>()) {
                set(&mut i, "expiry", &format!("{y:04}-{m:02}"));
            }
            custom(&mut i, "Issuing bank", FieldKind::Text, r.get("issuing_bank"), None);
            custom(&mut i, "Country", FieldKind::Text, r.get("country"), None);
            Some(i)
        }
        "bank" => {
            let mut i = new_item(ItemType::Bank, &fallback_title(r.get("account_name"), "", ""));
            set(&mut i, "bankName", r.get("issuing_bank"));
            set(&mut i, "holder", r.get("account_holder"));
            set(&mut i, "accountNumber", r.get("account_number"));
            set(&mut i, "sortCode", r.get("routing_number"));
            custom(&mut i, "Country", FieldKind::Text, r.get("country"), None);
            Some(i)
        }
        other => {
            p.skip(r.get("account_name"), &format!("Coffer does not know the Dashlane payment type \"{other}\"."));
            None
        }
    }
}

fn id_doc(r: &Row) -> crate::model::StoredItem {
    let kind = match r.get("type") {
        "passport" => "Passport",
        "license" => "Driving licence",
        "card" => "ID card",
        _ => "Other",
    };
    let title = match r.get("type") {
        "passport" => "Passport",
        "license" => "Driving licence",
        "card" => "ID card",
        "social_security" => "Social security number",
        "tax_number" => "Tax number",
        _ => "ID document",
    };
    let mut i = new_item(ItemType::Document, &format!("{title} {}", r.get("name")).trim().to_owned());
    set(&mut i, "docKind", kind);
    set(&mut i, "number", r.get("number"));
    set(&mut i, "fullName", r.get("name"));
    set(&mut i, "issued", r.get("issue_date"));
    set(&mut i, "expires", r.get("expiration_date"));
    set(&mut i, "country", r.get("place_of_issue"));
    custom(&mut i, "State", FieldKind::Text, r.get("state"), None);
    i
}

fn personal(r: &Row) -> crate::model::StoredItem {
    let t = r.get("type");
    let title = match t {
        "name" => format!("{} {}", r.get("first_name"), r.get("last_name")).trim().to_owned(),
        _ => r.get("item_name").to_owned(),
    };
    let title = if title.is_empty() { format!("Personal info ({t})") } else { title };
    let mut i = new_item(ItemType::Identity, &title);
    set(&mut i, "title", r.get("title"));
    set(&mut i, "firstName", r.get("first_name"));
    set(&mut i, "middleName", r.get("middle_name"));
    set(&mut i, "lastName", r.get("last_name"));
    set(&mut i, "birthDate", r.get("date_of_birth"));
    set(&mut i, "email", r.get("email"));
    set(&mut i, "phone", r.get("phone_number"));
    set(&mut i, "address1", r.get("address"));
    set(&mut i, "city", r.get("city"));
    set(&mut i, "region", r.get("state"));
    set(&mut i, "postcode", r.get("zip"));
    set(&mut i, "country", r.get("country"));
    custom(&mut i, "Username", FieldKind::Text, r.get("login"), None);
    custom(&mut i, "Place of birth", FieldKind::Text, r.get("place_of_birth"), None);
    custom(&mut i, "Job title", FieldKind::Text, r.get("job_title"), None);
    custom(&mut i, "Website", FieldKind::Url, r.get("url"), None);
    i
}
