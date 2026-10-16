//! Built-in field roles per item type, mirrored exactly from
//! `BUILTIN_FIELDS`, `ENTER_COPIES` and `MENU_OPTIONS` in
//! `src/lib/contract.ts` (SPEC 4). The shell can serialise these as data.

use serde::Serialize;

use crate::model::{FieldKind, ItemType, StoredItem};

/// One built-in field of a type (contract `BUILTIN_FIELDS` entry).
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldTemplate {
    /// Built-in role, the `builtin` value of the field.
    pub role: &'static str,
    /// Default label.
    pub label: &'static str,
    /// Kind.
    pub kind: FieldKind,
}

/// Template of one type.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeTemplate {
    /// The type.
    #[serde(rename = "type")]
    pub item_type: ItemType,
    /// Built-in fields in display order.
    pub fields: &'static [FieldTemplate],
    /// The role Enter copies in Quick Access; `None` = open the item
    /// (contract `ENTER_COPIES`). A login with no password copies "totp":
    /// use [`enter_role`].
    pub enter_copies: Option<&'static str>,
}

const fn f(role: &'static str, label: &'static str, kind: FieldKind) -> FieldTemplate {
    FieldTemplate { role, label, kind }
}

use FieldKind as K;

static LOGIN: &[FieldTemplate] = &[
    f("username", "Username", K::Text),
    f("password", "Password", K::Concealed),
    f("totp", "One-time code", K::Totp),
];
static PASSWORD: &[FieldTemplate] = &[f("password", "Password", K::Concealed)];
static NOTE: &[FieldTemplate] = &[];
static CARD: &[FieldTemplate] = &[
    f("cardholder", "Cardholder", K::Text),
    f("number", "Number", K::CardNumber),
    f("expiry", "Expiry", K::MonthYear),
    f("cvv", "CVV", K::Pin),
    f("pin", "PIN", K::Pin),
    f("brand", "Brand", K::Menu),
];
static IDENTITY: &[FieldTemplate] = &[
    f("title", "Title", K::Text),
    f("firstName", "First name", K::Text),
    f("middleName", "Middle name", K::Text),
    f("lastName", "Last name", K::Text),
    f("birthDate", "Birth date", K::Date),
    f("email", "Email", K::Email),
    f("phone", "Phone", K::Phone),
    f("address1", "Address line 1", K::Text),
    f("address2", "Address line 2", K::Text),
    f("city", "City", K::Text),
    f("region", "Region", K::Text),
    f("postcode", "Postcode", K::Text),
    f("country", "Country", K::Text),
    f("company", "Company", K::Text),
];
static BANK: &[FieldTemplate] = &[
    f("bankName", "Bank", K::Text),
    f("holder", "Account holder", K::Text),
    f("accountNumber", "Account number", K::Concealed),
    f("sortCode", "Sort code / routing", K::Text),
    f("iban", "IBAN", K::Concealed),
    f("swift", "SWIFT / BIC", K::Text),
    f("pin", "PIN", K::Pin),
];
static DOCUMENT: &[FieldTemplate] = &[
    f("docKind", "Kind", K::Menu),
    f("number", "Number", K::Text),
    f("fullName", "Full name", K::Text),
    f("issued", "Issued", K::Date),
    f("expires", "Expires", K::Date),
    f("country", "Country", K::Text),
];
static SSH_KEY: &[FieldTemplate] = &[
    f("privateKey", "Private key", K::ConcealedMultiline),
    f("publicKey", "Public key", K::Multiline),
    f("fingerprint", "Fingerprint", K::Text),
    f("passphrase", "Passphrase", K::Concealed),
];
static API: &[FieldTemplate] = &[
    f("username", "Username", K::Text),
    f("credential", "Credential", K::Concealed),
    f("host", "Host", K::Url),
    f("expires", "Expires", K::Date),
];
static WIFI: &[FieldTemplate] = &[
    f("ssid", "Network name", K::Text),
    f("password", "Password", K::Concealed),
    f("security", "Security", K::Menu),
];
static LICENSE: &[FieldTemplate] = &[
    f("product", "Product", K::Text),
    f("version", "Version", K::Text),
    f("licenseKey", "Licence key", K::Concealed),
    f("licensedTo", "Licensed to", K::Text),
    f("email", "Email", K::Email),
    f("purchaseDate", "Purchase date", K::Date),
];

static TEMPLATES: [TypeTemplate; 11] = [
    TypeTemplate { item_type: ItemType::Login, fields: LOGIN, enter_copies: Some("password") },
    TypeTemplate { item_type: ItemType::Password, fields: PASSWORD, enter_copies: Some("password") },
    TypeTemplate { item_type: ItemType::Note, fields: NOTE, enter_copies: None },
    TypeTemplate { item_type: ItemType::Card, fields: CARD, enter_copies: Some("number") },
    TypeTemplate { item_type: ItemType::Identity, fields: IDENTITY, enter_copies: None },
    TypeTemplate { item_type: ItemType::Bank, fields: BANK, enter_copies: Some("accountNumber") },
    TypeTemplate { item_type: ItemType::Document, fields: DOCUMENT, enter_copies: Some("number") },
    TypeTemplate { item_type: ItemType::SshKey, fields: SSH_KEY, enter_copies: Some("publicKey") },
    TypeTemplate { item_type: ItemType::ApiCredential, fields: API, enter_copies: Some("credential") },
    TypeTemplate { item_type: ItemType::Wifi, fields: WIFI, enter_copies: Some("password") },
    TypeTemplate { item_type: ItemType::License, fields: LICENSE, enter_copies: Some("licenseKey") },
];

/// Menu choices for built-in menu fields (contract `MENU_OPTIONS`).
pub static MENU_OPTIONS: &[(&str, &[&str])] = &[
    ("brand", &["Visa", "Mastercard", "American Express", "Discover", "Diners Club", "JCB", "UnionPay", "Maestro", "Other"]),
    ("docKind", &["Passport", "Driving licence", "ID card", "Other"]),
    ("security", &["WPA3", "WPA2", "WPA", "WEP", "None"]),
];

/// The menu choices of a built-in menu role.
pub fn menu_options(role: &str) -> Option<&'static [&'static str]> {
    MENU_OPTIONS.iter().find(|(r, _)| *r == role).map(|(_, o)| *o)
}

/// The template of a type.
pub fn template(t: ItemType) -> &'static TypeTemplate {
    TEMPLATES.iter().find(|x| x.item_type == t).expect("every type has a template")
}

/// Every template, in sidebar order.
pub fn all_templates() -> &'static [TypeTemplate] {
    &TEMPLATES
}

/// `true` when `role` is a built-in role of any type.
pub fn is_role(role: &str) -> bool {
    TEMPLATES.iter().any(|t| t.fields.iter().any(|f| f.role == role))
}

/// The role Enter copies for this item: `ENTER_COPIES`, except that a login
/// with an empty password copies "totp". `None` = open the item in Coffer.
pub fn enter_role(item: &StoredItem) -> Option<&'static str> {
    let role = template(item.item_type).enter_copies?;
    if item.item_type == ItemType::Login && item.password().is_empty() {
        return Some("totp");
    }
    Some(role)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_type_has_one_template() {
        for t in ItemType::ALL {
            assert_eq!(template(t).item_type, t);
        }
        assert_eq!(all_templates().len(), ItemType::ALL.len());
    }

    #[test]
    fn ssh_enter_never_copies_the_private_key() {
        assert_eq!(template(ItemType::SshKey).enter_copies, Some("publicKey"));
        assert_eq!(template(ItemType::SshKey).fields[0].kind, FieldKind::ConcealedMultiline);
    }

    #[test]
    fn login_without_password_copies_totp() {
        let mut item = StoredItem::new(ItemType::Login, "x", "2026-01-01T00:00:00Z");
        assert_eq!(enter_role(&item), Some("totp"));
        item.set_builtin("password", FieldKind::Concealed, "pw");
        assert_eq!(enter_role(&item), Some("password"));
        let note = StoredItem::new(ItemType::Note, "n", "2026-01-01T00:00:00Z");
        assert_eq!(enter_role(&note), None);
    }

    #[test]
    fn every_menu_role_has_options() {
        for t in all_templates() {
            for f in t.fields {
                if f.kind == FieldKind::Menu {
                    assert!(menu_options(f.role).is_some(), "{}", f.role);
                }
            }
        }
    }
}
