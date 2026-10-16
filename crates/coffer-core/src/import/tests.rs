//! Importer tests on the hand-made synthetic fixtures in `tests/fixtures/`,
//! and export -> import round trips.

use super::*;
use crate::crypto::KdfParams;
use crate::model::{ExportKind, FieldInput, ItemInput, ItemUrl};
use crate::session::UnlockOutcome;

const PW: &str = "correct horse battery staple glimmer";
const XPW: &str = "export horse battery staple glimmer";

macro_rules! fixture {
    ($name:literal) => {
        include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/", $name)).as_slice()
    };
}

fn req<'a>(name: &'a str, bytes: &'a [u8]) -> ImportRequest<'a> {
    ImportRequest { file_name: name, bytes, password: None, secret_key: None }
}

fn parse(name: &str, bytes: &[u8]) -> ParsedImport {
    parse_import(&req(name, bytes), None).unwrap()
}

fn find<'a>(p: &'a ParsedImport, title: &str) -> &'a StoredItem {
    p.items.iter().find(|i| i.title == title).unwrap_or_else(|| panic!("no item {title}"))
}

fn vault() -> (SecretKey, Vault) {
    let k = SecretKey::generate();
    let v = Vault::create("Personal", PW, &k, KdfParams::TEST).unwrap();
    (k, v)
}

#[test]
fn chrome_csv() {
    let p = parse("synthetic-chrome.csv", fixture!("synthetic-chrome.csv"));
    assert_eq!(p.format, "browser-csv");
    assert_eq!(p.items.len(), 3);
    let shop = find(&p, "shop.example.net");
    assert_eq!(shop.builtin_value("username"), "bob");
    assert_eq!(shop.password(), "Chrome-Synthetic-2!");
    assert_eq!(shop.notes, "Gift card PIN is in the notes app");
    assert_eq!(find(&p, "Example Mail").urls[0].url, "https://mail.example.com/login");
}

#[test]
fn firefox_csv() {
    let p = parse("synthetic-firefox.csv", fixture!("synthetic-firefox.csv"));
    assert_eq!(p.format, "firefox-csv");
    assert_eq!(p.items.len(), 2);
    let f = find(&p, "forum.example.org");
    assert_eq!(f.password(), "Firefox-Synthetic-1!");
    assert_eq!(f.created_at, "2023-11-14T22:13:20Z");
    assert_eq!(f.password_changed_at.as_deref(), Some("2023-11-14T22:13:20Z"));
}

#[test]
fn bitwarden_csv() {
    let p = parse("synthetic-bitwarden.csv", fixture!("synthetic-bitwarden.csv"));
    assert_eq!(p.format, "bitwarden-csv");
    assert_eq!(p.items.len(), 3);
    let vpn = find(&p, "Work VPN");
    assert!(vpn.favorite);
    assert_eq!(vpn.tags, vec!["Work".to_owned()]);
    assert_eq!(vpn.builtin_value("totp"), "otpauth://totp/VPN:erin?secret=GEZDGNBVGY3TQOJQ");
    assert!(vpn.fields.iter().any(|f| f.label == "Employee ID" && f.value == "4242"));
    assert_eq!(find(&p, "Wifi notes").item_type, ItemType::Note);
    let two = find(&p, "Two Sites");
    assert_eq!(two.urls.len(), 2);
    assert!(two.reprompt);
}

#[test]
fn onepassword_csv() {
    let p = parse("synthetic-1password.csv", fixture!("synthetic-1password.csv"));
    assert_eq!(p.format, "1password-csv");
    let bank = find(&p, "Synthetic Bank");
    assert!(bank.favorite);
    assert_eq!(bank.tags, vec!["Finance".to_owned(), "Home".to_owned()]);
    let old = find(&p, "Old Forum");
    assert_eq!(old.state, ItemState::Archived);
    assert!(old.builtin_value("totp").starts_with("otpauth://"));
}

#[test]
fn dashlane_single_csv() {
    let p = parse("synthetic-dashlane-credentials.csv", fixture!("synthetic-dashlane-credentials.csv"));
    assert_eq!(p.format, "dashlane-csv");
    assert_eq!(p.items.len(), 2);
    assert_eq!(find(&p, "Example Cloud").tags, vec!["Work".to_owned()]);
    assert_eq!(find(&p, "Game Portal").builtin_value("totp"), "GEZDGNBVGY3TQOJQ");
}

#[test]
fn dashlane_zip() {
    let p = parse("synthetic-dashlane.zip", fixture!("synthetic-dashlane.zip"));
    assert_eq!(p.format, "dashlane-csv-zip");
    let types: Vec<ItemType> = p.items.iter().map(|i| i.item_type).collect();
    assert_eq!(types.iter().filter(|t| **t == ItemType::Login).count(), 2);
    assert_eq!(types.iter().filter(|t| **t == ItemType::Note).count(), 1);
    assert_eq!(types.iter().filter(|t| **t == ItemType::Card).count(), 1);
    assert_eq!(types.iter().filter(|t| **t == ItemType::Bank).count(), 1);
    assert_eq!(types.iter().filter(|t| **t == ItemType::Document).count(), 2);
    assert_eq!(types.iter().filter(|t| **t == ItemType::Identity).count(), 2);
    let card = find(&p, "Synthetic Visa");
    assert_eq!(card.builtin_value("expiry"), "2030-03");
    assert_eq!(card.builtin_value("number"), "4000000000000002");
    assert_eq!(find(&p, "Synthetic Dashlane Note").notes, "Two lines,\nwith a comma");
    let pass = find(&p, "Passport Mia Example");
    assert_eq!(pass.builtin_value("docKind"), "Passport");
    assert_eq!(pass.builtin_value("expires"), "2030-01-01");
    assert_eq!(find(&p, "Synthetic Current").builtin_value("accountNumber"), "00000000");
}

#[test]
fn onepassword_1pux() {
    let p = parse("synthetic-1password.1pux", fixture!("synthetic-1password.1pux"));
    assert_eq!(p.format, "1password-1pux");
    assert_eq!(p.items.len(), 7);
    let login = find(&p, "Synthetic 1P Login");
    assert_eq!(login.builtin_value("username"), "liam");
    assert_eq!(login.password(), "OnePux-Login-1!");
    assert!(login.builtin_value("totp").starts_with("otpauth://"));
    assert!(login.favorite);
    assert_eq!(login.password_history[0].value, "OnePux-Old-1!");
    assert!(login.tags.contains(&"Travel".to_owned()) && login.tags.contains(&"Private".to_owned()));
    assert!(login.fields.iter().any(|f| f.label == "recovery code" && f.kind == FieldKind::Concealed && f.section.as_deref() == Some("Extra")));
    assert!(login.fields.iter().any(|f| f.kind == FieldKind::Date && f.value == "2020-09-13"));
    let card = find(&p, "Synthetic 1P Card");
    assert_eq!(card.state, ItemState::Archived);
    assert_eq!(card.builtin_value("number"), "5555555555554444");
    assert_eq!(card.builtin_value("expiry"), "2028-12");
    assert_eq!(card.builtin_value("cvv"), "321");
    assert_eq!(find(&p, "Synthetic 1P Password").password(), "OnePux-Password-1!");
    let wifi = find(&p, "Synthetic Home Wi-Fi");
    assert_eq!(wifi.builtin_value("ssid"), "SyntheticNet");
    assert_eq!(wifi.password(), "OnePux-Wifi-1!");
    let pass = find(&p, "Synthetic Passport");
    assert_eq!(pass.builtin_value("docKind"), "Passport");
    assert_eq!(pass.builtin_value("expires"), "2030-01-01");
    assert_eq!(find(&p, "Synthetic Shared Note").tags, vec!["Shared".to_owned()]);
    assert!(!p.warnings.is_empty(), "documents warning");
}

#[test]
fn bitwarden_json() {
    let p = parse("synthetic-bitwarden.json", fixture!("synthetic-bitwarden.json"));
    assert_eq!(p.format, "bitwarden-json");
    assert_eq!(p.items.len(), 5);
    assert_eq!(p.skipped.len(), 1);
    let l = find(&p, "Synthetic Login");
    assert!(l.reprompt && l.favorite);
    assert_eq!(l.urls.len(), 2);
    assert_eq!(l.tags, vec!["Personal".to_owned()]);
    assert_eq!(l.password_history[0].value, "Bitwarden-Old-1!");
    assert_eq!(l.created_at, "2024-01-01T10:00:00Z");
    assert!(l.fields.iter().any(|f| f.label == "Security answer" && f.kind == FieldKind::Concealed));
    assert!(l.fields.iter().any(|f| f.label == "Passkey"));
    assert!(!l.fields.iter().any(|f| f.label == "Linked user"));
    let c = find(&p, "Synthetic Card");
    assert_eq!(c.builtin_value("expiry"), "2029-07");
    assert_eq!(c.builtin_value("cvv"), "123");
    let id = find(&p, "Synthetic Identity");
    assert_eq!(id.builtin_value("postcode"), "TE1 1ST");
    assert!(id.fields.iter().any(|f| f.label == "Passport number" && f.kind == FieldKind::Concealed));
    let ssh = find(&p, "Synthetic SSH");
    assert!(ssh.builtin_value("privateKey").contains("OPENSSH"));
    assert!(p.warnings.iter().any(|w| w.contains("passkey")));
}

#[test]
fn bitwarden_encrypted_is_unsupported() {
    let e = parse_import(&req("x.json", fixture!("synthetic-bitwarden-encrypted.json")), None).unwrap_err();
    assert_eq!(e.code(), "unsupportedFormat");
    assert!(e.to_string().contains("Export from Bitwarden as JSON (not encrypted)"));
}

#[test]
fn coffer_json_fixture() {
    let p = parse("synthetic-coffer.json", fixture!("synthetic-coffer.json"));
    assert_eq!(p.format, "coffer-json");
    assert_eq!(p.items.len(), 2);
    let l = find(&p, "Synthetic Coffer Login");
    assert!(l.reprompt);
    assert_eq!(l.password_history.len(), 1);
    assert_eq!(find(&p, "Synthetic Coffer Wi-Fi").state, ItemState::Archived);
}

#[test]
fn unknown_files_are_refused() {
    assert_eq!(parse_import(&req("a.txt", b"hello world"), None).unwrap_err().code(), "unsupportedFormat");
    assert_eq!(parse_import(&req("a.json", b"{\"x\":1}"), None).unwrap_err().code(), "unsupportedFormat");
    assert_eq!(parse_import(&req("a.csv", b"a,b,c\n1,2,3\n"), None).unwrap_err().code(), "unsupportedFormat");
}

#[test]
fn preview_commit_duplicates_and_undo() {
    let (_, mut v) = vault();
    let r = req("synthetic-chrome.csv", fixture!("synthetic-chrome.csv"));
    let plan = v.import_preview(&r).unwrap();
    assert_eq!(plan.preview().total, 3);
    assert_eq!(plan.preview().duplicates, 0);
    assert_eq!(plan.preview().counts.get(&ItemType::Login), Some(&3));
    let res = v.import_commit(plan);
    assert_eq!(res.imported, 3);
    assert_eq!(res.tag, "Imported/Browser");
    let list = v.items_list();
    assert!(list.iter().all(|s| s.tags.contains(&"Imported/Browser".to_owned())));
    // Importing again: every row is a duplicate.
    let again = v.import_preview(&r).unwrap();
    assert_eq!(again.preview().duplicates, 3);
    assert_eq!(again.preview().total, 0);
    let res2 = v.import_commit(again);
    assert_eq!(res2.imported, 0);
    assert_eq!(res2.skipped, 3);
    // Undo by batch id.
    assert_eq!(v.import_undo(&res.batch_id), 3);
    assert!(v.items_list().iter().all(|s| s.state == ItemState::Trashed));
    assert_eq!(v.import_undo("no-such-batch"), 0);
}

#[test]
fn imported_ids_are_new() {
    let (_, mut v) = vault();
    let plan = v.import_preview(&req("c.json", fixture!("synthetic-coffer.json"))).unwrap();
    v.import_commit(plan);
    assert!(v.items_list().iter().all(|s| !s.id.starts_with("c0000000")));
}

fn sample_vault() -> (SecretKey, Vault) {
    let (k, mut v) = vault();
    let f = |role: &str, kind: FieldKind, value: &str| FieldInput {
        id: String::new(),
        label: role.into(),
        kind,
        value: Some(value.into()),
        section: None,
        builtin: Some(role.into()),
        options: None,
    };
    let base = |t: ItemType, title: &str, fields: Vec<FieldInput>| ItemInput {
        id: None,
        base_rev: None,
        item_type: t,
        title: title.into(),
        favorite: true,
        tags: vec!["Work/Clients".into()],
        fields,
        notes: "round trip note".into(),
        urls: vec![ItemUrl { url: "https://rt.example.com".into(), label: None }],
        apps: vec![],
        reprompt: false,
        autotype_sequence: None,
        health_excluded: false,
    };
    let l = v
        .item_save(
            &base(ItemType::Login, "RT Login", vec![f("username", FieldKind::Text, "rt-user"), f("password", FieldKind::Concealed, "RT-Pass-1!")]),
            None,
        )
        .unwrap();
    let mut input = base(ItemType::Login, "RT Login", vec![]);
    input.id = Some(l.id.clone());
    input.base_rev = Some(l.rev);
    input.fields = vec![f("username", FieldKind::Text, "rt-user"), f("password", FieldKind::Concealed, "RT-Pass-2!")];
    v.item_save(&input, None).unwrap();
    v.item_save(
        &base(
            ItemType::Card,
            "RT Card",
            vec![f("number", FieldKind::CardNumber, "4242424242424242"), f("expiry", FieldKind::MonthYear, "2031-04"), f("cvv", FieldKind::Pin, "999")],
        ),
        None,
    )
    .unwrap();
    v.item_save(&base(ItemType::Note, "RT Note", vec![]), None).unwrap();
    let t = v.item_save(&base(ItemType::Login, "RT Trashed", vec![f("password", FieldKind::Concealed, "gone")]), None).unwrap();
    v.item_set_state(&t.id, ItemState::Trashed).unwrap();
    (k, v)
}

fn titles(v: &Vault) -> Vec<String> {
    let mut t: Vec<String> = v.items_list().into_iter().filter(|s| s.state != ItemState::Trashed).map(|s| s.title).collect();
    t.sort();
    t
}

fn reveal(v: &mut Vault, title: &str, field: &str) -> String {
    let id = v.items_list().into_iter().find(|s| s.title == title).unwrap().id;
    v.item_reveal(&id, field, None).unwrap().to_string()
}

#[test]
fn round_trip_coffer_json() {
    let (_, src) = sample_vault();
    let bytes = src.export(ExportKind::CofferJson, None).unwrap();
    let (_, mut dst) = vault();
    let plan = dst.import_preview(&req("export.json", &bytes)).unwrap();
    assert_eq!(plan.preview().format, "coffer-json");
    dst.import_commit(plan);
    assert_eq!(titles(&dst), vec!["RT Card", "RT Login", "RT Note"]);
    assert_eq!(reveal(&mut dst, "RT Login", "password"), "RT-Pass-2!");
    assert_eq!(reveal(&mut dst, "RT Card", "cvv"), "999");
    let id = dst.items_list().into_iter().find(|s| s.title == "RT Login").unwrap().id;
    assert_eq!(dst.item_password_history(&id, None).unwrap().len(), 1);
    // No revisions travel in Coffer JSON.
    assert!(!String::from_utf8_lossy(&bytes).contains("\"revisions\""));
}

#[test]
fn round_trip_cofferx() {
    let (_, src) = sample_vault();
    let bytes = src.export(ExportKind::CofferEncrypted, Some(XPW)).unwrap();
    assert!(!String::from_utf8_lossy(&bytes).contains("RT-Pass-2!"));
    let (_, mut dst) = vault();
    let first = dst.import_preview(&req("x.cofferx", &bytes)).unwrap();
    assert!(first.preview().needs_password);
    assert_eq!(first.preview().total, 0);
    let mut r = req("x.cofferx", &bytes);
    r.password = Some("wrong export password words here");
    assert_eq!(dst.import_preview(&r).unwrap_err(), CoreError::BadCredentials);
    r.password = Some(XPW);
    let plan = dst.import_preview(&r).unwrap();
    assert_eq!(plan.preview().format, "coffer-cofferx");
    dst.import_commit(plan);
    assert_eq!(titles(&dst), vec!["RT Card", "RT Login", "RT Note"]);
    assert_eq!(reveal(&mut dst, "RT Login", "password"), "RT-Pass-2!");
    assert!(src.export(ExportKind::CofferEncrypted, None).is_err());
}

#[test]
fn round_trip_bitwarden_json_and_csv() {
    let (_, src) = sample_vault();
    let bw = src.export(ExportKind::BitwardenJson, None).unwrap();
    let p = parse("bw.json", &bw);
    assert_eq!(p.format, "bitwarden-json");
    let l = find(&p, "RT Login");
    assert_eq!(l.password(), "RT-Pass-2!");
    assert_eq!(l.password_history.len(), 1);
    assert_eq!(find(&p, "RT Card").builtin_value("expiry"), "2031-04");
    let csv = src.export(ExportKind::Csv, None).unwrap();
    let text = String::from_utf8_lossy(&csv);
    assert!(text.starts_with("folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp"));
    let p = parse("bw.csv", &csv);
    assert_eq!(p.format, "bitwarden-csv");
    assert_eq!(find(&p, "RT Login").password(), "RT-Pass-2!");
    assert_eq!(find(&p, "RT Card").item_type, ItemType::Note);
    assert!(find(&p, "RT Card").fields.iter().any(|f| f.value == "4242424242424242"));
}

#[test]
fn import_coffer_vault_file() {
    let (k, mut src) = sample_vault();
    let file = src.to_bytes(0);
    // Same key id as the open vault: only the password is needed.
    let same = match Vault::unlock(&file, PW, &k, 0).unwrap() {
        UnlockOutcome::Ready(v) => v,
        UnlockOutcome::Older(_) => unreachable!(),
    };
    let first = same.import_preview(&req("other.coffer", &file)).unwrap();
    assert!(first.preview().needs_password && !first.preview().needs_secret_key);
    // Another vault (other key id): needs the Secret Key too.
    let (_, mut dst) = vault();
    let mut r = req("other.coffer", &file);
    r.password = Some(PW);
    let p = dst.import_preview(&r).unwrap();
    assert!(p.preview().needs_secret_key && !p.preview().needs_password);
    r.secret_key = Some(&k);
    let plan = dst.import_preview(&r).unwrap();
    assert_eq!(plan.preview().format, "coffer-vault");
    assert_eq!(plan.preview().total, 3);
    dst.import_commit(plan);
    assert_eq!(reveal(&mut dst, "RT Login", "password"), "RT-Pass-2!");
    // A wrong password is badCredentials; a key of another vault is badSecretKey.
    r.password = Some("not the password at all ok");
    assert_eq!(dst.import_preview(&r).unwrap_err(), CoreError::BadCredentials);
    let other = SecretKey::generate();
    r.secret_key = Some(&other);
    r.password = Some(PW);
    if other.key_id() != k.key_id() {
        assert_eq!(dst.import_preview(&r).unwrap_err().code(), "badSecretKey");
    }
    let _ = same.import_preview(&req("other.coffer", &file));
}
