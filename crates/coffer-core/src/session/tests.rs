//! Unit tests of the session API. They use the test-only KDF profile
//! (`KdfParams::TEST`), except the KDF tamper tests that need the floor.

use super::*;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;

const PW: &str = "correct horse battery staple glimmer";

fn sk() -> SecretKey {
    SecretKey::generate()
}

fn new_vault(sk: &SecretKey) -> Vault {
    Vault::create("Personal", PW, sk, KdfParams::TEST).unwrap()
}

fn open(bytes: &[u8], pw: &str, sk: &SecretKey) -> Result<Vault> {
    match Vault::unlock(bytes, pw, sk, 0)? {
        UnlockOutcome::Ready(v) => Ok(v),
        UnlockOutcome::Older(_) => panic!("older"),
    }
}

fn field(role: &str, kind: FieldKind, value: &str) -> FieldInput {
    FieldInput {
        id: String::new(),
        label: role.to_owned(),
        kind,
        value: Some(value.to_owned()),
        section: None,
        builtin: Some(role.to_owned()),
        options: None,
    }
}

fn login(title: &str, user: &str, pw: &str) -> ItemInput {
    ItemInput {
        id: None,
        base_rev: None,
        item_type: ItemType::Login,
        title: title.into(),
        favorite: false,
        tags: vec![],
        fields: vec![
            field("username", FieldKind::Text, user),
            field("password", FieldKind::Concealed, pw),
        ],
        notes: String::new(),
        urls: vec![ItemUrl { url: "https://example.com/login".into(), label: None }],
        apps: vec![],
        reprompt: false,
        autotype_sequence: None,
        health_excluded: false,
    }
}

fn as_input(v: &ItemView) -> ItemInput {
    ItemInput {
        id: Some(v.id.clone()),
        base_rev: Some(v.rev),
        item_type: v.item_type,
        title: v.title.clone(),
        favorite: v.favorite,
        tags: v.tags.clone(),
        fields: v
            .fields
            .iter()
            .map(|f| FieldInput {
                id: f.id.clone(),
                label: f.label.clone(),
                kind: f.kind,
                value: if f.masked == Some(true) { None } else { Some(f.value.clone()) },
                section: f.section.clone(),
                builtin: f.builtin.clone(),
                options: f.options.clone(),
            })
            .collect(),
        notes: v.notes.clone(),
        urls: v.urls.clone(),
        apps: v.apps.clone(),
        reprompt: v.reprompt,
        autotype_sequence: v.autotype_sequence.clone(),
        health_excluded: v.health_excluded,
    }
}

fn saved(v: &mut Vault) -> Vec<u8> {
    let b = v.to_bytes(0);
    v.mark_saved();
    b
}

fn json(bytes: &[u8]) -> serde_json::Value {
    serde_json::from_slice(bytes).unwrap()
}

fn bytes_of(v: &serde_json::Value) -> Vec<u8> {
    serde_json::to_vec(v).unwrap()
}

// ---------------------------------------------------------------- round trip

#[test]
fn round_trip_create_save_unlock() {
    let k = sk();
    let mut v = new_vault(&k);
    let view = v.item_save(&login("GitHub", "me@example.com", "s3cret-Pa55-word!"), None).unwrap();
    let bytes = saved(&mut v);
    assert_eq!(v.generation(), 1);
    let mut back = open(&bytes, PW, &k).unwrap();
    assert_eq!(back.items_list().len(), 1);
    let got = back.item_get(&view.id).unwrap();
    assert_eq!(got.title, "GitHub");
    assert_eq!(got.rev, 1);
    assert_eq!(&*back.item_reveal(&view.id, "password", None).unwrap(), "s3cret-Pa55-word!");
    // The header is readable without the KDF.
    let h = crate::vault_file::read_header(&bytes).unwrap();
    assert_eq!(h.key_id, k.key_id());
    assert_eq!(h.generation, 1);
    assert_eq!(h.record_count, 2);
}

#[test]
fn password_is_normalised() {
    let k = sk();
    let mut v = Vault::create("Personal", "  caf\u{e9} correct horse battery staple ", &k, KdfParams::TEST).unwrap();
    let b = saved(&mut v);
    assert!(open(&b, "cafe\u{301} correct horse battery staple", &k).is_ok());
}

#[test]
fn weak_master_password_refused() {
    let e = Vault::create("Personal", "Personal1", &sk(), KdfParams::TEST).unwrap_err();
    assert_eq!(e.code(), "weakPassword");
}

#[test]
fn every_save_bumps_generation_past_highest_seen() {
    let k = sk();
    let mut v = new_vault(&k);
    let b1 = v.to_bytes(0);
    assert_eq!(v.mark_saved(), Some(1));
    let b2 = v.to_bytes(7);
    assert_eq!(v.mark_saved(), Some(8));
    assert_eq!(crate::vault_file::read_header(&b1).unwrap().generation, 1);
    assert_eq!(crate::vault_file::read_header(&b2).unwrap().generation, 8);
}

// ---------------------------------------------------------------- credentials

#[test]
fn wrong_password_is_bad_credentials() {
    let k = sk();
    let mut v = new_vault(&k);
    let b = saved(&mut v);
    assert_eq!(open(&b, "correct horse battery staplf glimmer", &k).unwrap_err(), CoreError::BadCredentials);
}

#[test]
fn wrong_secret_key_is_bad_credentials() {
    let k = sk();
    let mut v = new_vault(&k);
    let b = saved(&mut v);
    // Same key id, other bytes: the unwrap fails.
    let other = SecretKey::from_parts(k.key_id(), [9u8; 16]).unwrap();
    assert_eq!(open(&b, PW, &other).unwrap_err(), CoreError::BadCredentials);
}

#[test]
fn secret_key_of_another_vault_is_bad_secret_key() {
    let k = sk();
    let mut v = new_vault(&k);
    let b = saved(&mut v);
    let mut other = SecretKey::generate();
    while other.key_id() == k.key_id() {
        other = SecretKey::generate();
    }
    let e = open(&b, PW, &other).unwrap_err();
    assert_eq!(e.code(), "badSecretKey");
    assert_eq!(e.to_string(), "This Secret Key is for another vault.");
}

#[test]
fn secret_key_typo_is_caught_before_unlock() {
    let k = sk();
    let mut text: Vec<char> = k.to_text().chars().collect();
    let last = text.len() - 1;
    text[last] = if text[last] == '2' { '3' } else { '2' };
    let typo: String = text.iter().collect();
    assert_eq!(SecretKey::parse(&typo).unwrap_err().code(), "badSecretKey");
}

#[test]
fn verify_password_for_reprompt() {
    let k = sk();
    let v = new_vault(&k);
    assert!(v.verify_password(PW).is_ok());
    assert_eq!(v.verify_password("nope").unwrap_err(), CoreError::BadCredentials);
}

// ---------------------------------------------------------------- no plaintext

#[test]
fn file_holds_no_plaintext() {
    let k = sk();
    let mut v = new_vault(&k);
    let secret = "Zebra-Plaintext-Probe-7731";
    let title = "Probe Title Unique Qx";
    let mut input = login(title, "probe-user@example.com", secret);
    input.notes = "probe notes text".into();
    v.item_save(&input, None).unwrap();
    v.generate(&GeneratorOptions::default()).unwrap();
    let bytes = saved(&mut v);
    let hay = String::from_utf8_lossy(&bytes);
    for needle in [secret, title, "probe-user@example.com", "probe notes text", "Personal"] {
        assert!(!hay.contains(needle), "file holds {needle}");
    }
    // Not even as UTF-16 or base64 of the clear text.
    let b64 = B64.encode(secret.as_bytes());
    assert!(!hay.contains(&b64[..20]));
    let utf16: Vec<u8> = secret.encode_utf16().flat_map(u16::to_le_bytes).collect();
    assert!(!bytes.windows(utf16.len()).any(|w| w == utf16.as_slice()));
}

#[test]
fn records_are_padded_to_256() {
    let k = sk();
    let mut v = new_vault(&k);
    v.item_save(&login("a", "b", "c"), None).unwrap();
    let b = saved(&mut v);
    let f = VaultFile::parse(&b).unwrap();
    for r in &f.records {
        assert_eq!((r.ct.len() - 16) % 256, 0);
    }
}

// ---------------------------------------------------------------- tamper

fn two_item_file() -> (SecretKey, Vec<u8>, Vec<u8>) {
    let k = sk();
    let mut v = new_vault(&k);
    let a = v.item_save(&login("A", "a", "pa"), None).unwrap();
    v.item_save(&login("B", "b", "pb"), None).unwrap();
    let old = saved(&mut v);
    let mut input = as_input(&v.item_get(&a.id).unwrap());
    input.title = "A2".into();
    v.item_save(&input, None).unwrap();
    let new = saved(&mut v);
    (k, old, new)
}

#[test]
fn tamper_changed_record() {
    let (k, _, new) = two_item_file();
    let mut j = json(&new);
    let ct = j["records"][1]["ct"].as_str().unwrap().to_owned();
    let mut raw = B64.decode(ct).unwrap();
    raw[5] ^= 1;
    j["records"][1]["ct"] = B64.encode(raw).into();
    assert_eq!(open(&bytes_of(&j), PW, &k).unwrap_err(), CoreError::Tampered);
}

#[test]
fn tamper_changed_rev() {
    let (k, _, new) = two_item_file();
    let mut j = json(&new);
    let rev = j["records"][1]["rev"].as_u64().unwrap();
    j["records"][1]["rev"] = (rev + 1).into();
    assert_eq!(open(&bytes_of(&j), PW, &k).unwrap_err(), CoreError::Tampered);
}

#[test]
fn tamper_deleted_record() {
    let (k, _, new) = two_item_file();
    let mut j = json(&new);
    j["records"].as_array_mut().unwrap().remove(2);
    assert_eq!(open(&bytes_of(&j), PW, &k).unwrap_err(), CoreError::Tampered);
}

#[test]
fn tamper_added_record() {
    let (k, _, new) = two_item_file();
    let mut j = json(&new);
    let mut extra = j["records"][1].clone();
    extra["id"] = Uuid::new_v4().to_string().into();
    j["records"].as_array_mut().unwrap().push(extra);
    assert_eq!(open(&bytes_of(&j), PW, &k).unwrap_err(), CoreError::Tampered);
}

#[test]
fn tamper_rolled_back_record() {
    let (k, old, new) = two_item_file();
    let jo = json(&old);
    let mut jn = json(&new);
    // Put the older version of each changed record into the new file.
    let mut swapped = 0;
    for r in jn["records"].as_array_mut().unwrap() {
        let id = r["id"].clone();
        let o = jo["records"].as_array().unwrap().iter().find(|x| x["id"] == id).unwrap();
        if o["rev"] != r["rev"] {
            *r = o.clone();
            swapped += 1;
        }
    }
    assert!(swapped >= 1);
    assert_eq!(open(&bytes_of(&jn), PW, &k).unwrap_err(), CoreError::Tampered);
}

#[test]
fn tamper_changed_generation() {
    let (k, _, new) = two_item_file();
    let mut j = json(&new);
    j["generation"] = 99.into();
    assert_eq!(open(&bytes_of(&j), PW, &k).unwrap_err(), CoreError::Tampered);
}

#[test]
fn tamper_swapped_records_fail() {
    let (k, _, new) = two_item_file();
    let mut j = json(&new);
    let a = j["records"][1]["ct"].clone();
    let an = j["records"][1]["nonce"].clone();
    j["records"][1]["ct"] = j["records"][2]["ct"].clone();
    j["records"][1]["nonce"] = j["records"][2]["nonce"].clone();
    j["records"][2]["ct"] = a;
    j["records"][2]["nonce"] = an;
    assert_eq!(open(&bytes_of(&j), PW, &k).unwrap_err(), CoreError::Tampered);
}

#[test]
fn tamper_kdf_outside_limits_refused_without_argon2() {
    let (k, _, new) = two_item_file();
    for (field, value, code) in [
        ("m_kib", 65_535u64, "kdfTooWeak"),
        ("t", 1, "kdfTooWeak"),
        ("m_kib", 2_000_000, "kdfTooStrong"),
        ("t", 11, "kdfTooStrong"),
        ("p", 17, "kdfTooStrong"),
    ] {
        let mut j = json(&new);
        j["kdf"]["m_kib"] = 131_072.into();
        j["kdf"]["t"] = 3.into();
        j["kdf"]["p"] = 4.into();
        j["kdf"][field] = value.into();
        let t0 = Instant::now();
        let e = open(&bytes_of(&j), PW, &k).unwrap_err();
        assert_eq!(e.code(), code, "{field}={value}");
        assert!(t0.elapsed() < StdDuration::from_millis(500), "Argon2 ran for {field}={value}");
    }
}

#[test]
fn tamper_kdf_inside_limits_is_bad_credentials() {
    // A vault at the floor (64 MiB, t 3, p 1), then the header lowered and raised.
    let k = sk();
    let mut v = Vault::create("Personal", PW, &k, KdfParams { m_kib: 65_536, t: 3, p: 1 }).unwrap();
    let b = saved(&mut v);
    for (field, value) in [("t", 2u64), ("t", 4), ("m_kib", 65_544)] {
        let mut j = json(&b);
        j["kdf"][field] = value.into();
        assert_eq!(open(&bytes_of(&j), PW, &k).unwrap_err(), CoreError::BadCredentials, "{field}={value}");
    }
    // The salt and key id are bound too.
    let mut j = json(&b);
    j["kdf"]["salt"] = B64.encode([7u8; 16]).into();
    assert_eq!(open(&bytes_of(&j), PW, &k).unwrap_err(), CoreError::BadCredentials);
    assert!(open(&b, PW, &k).is_ok());
}

#[test]
fn older_file_needs_confirm() {
    let k = sk();
    let mut v = new_vault(&k);
    let b = saved(&mut v);
    match Vault::unlock(&b, PW, &k, 5).unwrap() {
        UnlockOutcome::Older(o) => {
            assert_eq!(o.error(), CoreError::OlderFile { seen: 5, file: 1 });
            assert_eq!(o.error().code(), "olderFile");
            let v = o.accept().unwrap();
            assert_eq!(v.generation(), 1);
        }
        UnlockOutcome::Ready(_) => panic!("not detected"),
    }
    assert!(matches!(Vault::unlock(&b, PW, &k, 1).unwrap(), UnlockOutcome::Ready(_)));
}

// ---------------------------------------------------------------- external change

fn facts(generation: u64, mac: u8, revs: &[(Uuid, u64)]) -> DiskFacts {
    DiskFacts { header_same: true, mac_ok: true, generation, manifest_mac: [mac; 32], revs: revs.iter().copied().collect() }
}

#[test]
fn decision_function_outcomes() {
    let a = Uuid::from_bytes([1; 16]);
    let b = Uuid::from_bytes([2; 16]);
    let mut written = BTreeMap::new();
    written.insert(a, 3u64);
    let known = [9u8; 32];
    // Unchanged.
    assert_eq!(decide_external_change(5, &known, &written, 5, Some(&facts(5, 9, &[]))), ExternalChange::Unchanged);
    // Header changed.
    let mut h = facts(6, 1, &[]);
    h.header_same = false;
    assert_eq!(decide_external_change(5, &known, &written, 5, Some(&h)), ExternalChange::HeaderChanged);
    // MAC fails / unreadable.
    let mut m = facts(6, 1, &[]);
    m.mac_ok = false;
    assert_eq!(decide_external_change(5, &known, &written, 5, Some(&m)), ExternalChange::MacFailed);
    assert_eq!(decide_external_change(5, &known, &written, 5, None), ExternalChange::MacFailed);
    // Generation decrease: older on disk.
    assert_eq!(decide_external_change(5, &known, &written, 5, Some(&facts(4, 1, &[(a, 3)]))), ExternalChange::OlderOnDisk);
    assert_eq!(decide_external_change(5, &known, &written, 9, Some(&facts(7, 1, &[(a, 3)]))), ExternalChange::OlderOnDisk);
    // Equal generation, other content: conflict.
    assert_eq!(decide_external_change(5, &known, &written, 5, Some(&facts(5, 1, &[(a, 3)]))), ExternalChange::Conflict);
    // Higher, ours present at same or higher rev: reload.
    assert_eq!(decide_external_change(5, &known, &written, 5, Some(&facts(6, 1, &[(a, 4), (b, 1)]))), ExternalChange::Reload);
    // Higher, ours missing or older: conflict.
    assert_eq!(decide_external_change(5, &known, &written, 5, Some(&facts(6, 1, &[(b, 1)]))), ExternalChange::Conflict);
    assert_eq!(decide_external_change(5, &known, &written, 5, Some(&facts(6, 1, &[(a, 2)]))), ExternalChange::Conflict);
}

#[test]
fn external_change_with_real_files() {
    let k = sk();
    let mut pc1 = new_vault(&k);
    let base = saved(&mut pc1);
    let mut pc2 = open(&base, PW, &k).unwrap();
    assert_eq!(pc1.check_external_change(&base, 1), ExternalChange::Unchanged);

    // PC2 adds an item and saves: PC1 (no local writes) reloads.
    pc2.item_save(&login("from pc2", "u", "p"), None).unwrap();
    let f2 = saved(&mut pc2);
    assert_eq!(pc1.check_external_change(&f2, 1), ExternalChange::Reload);
    pc1.reload(&f2).unwrap();
    assert_eq!(pc1.items_list().len(), 1);
    assert_eq!(pc1.generation(), 2);

    // Both write: PC1 saves gen 3, PC2 (still at gen 2) saves gen 3 too.
    pc1.item_save(&login("from pc1", "u", "p"), None).unwrap();
    let _f1 = saved(&mut pc1);
    pc2.item_save(&login("pc2 again", "u", "p"), None).unwrap();
    let f2b = pc2.to_bytes(2);
    assert_eq!(pc1.check_external_change(&f2b, 3), ExternalChange::Conflict);

    // A rollback to the base file.
    assert_eq!(pc1.check_external_change(&base, 3), ExternalChange::OlderOnDisk);

    // Damaged file.
    let mut j = json(&f2);
    j["manifest_mac"] = B64.encode([0u8; 32]).into();
    assert_eq!(pc1.check_external_change(&bytes_of(&j), 3), ExternalChange::MacFailed);
    assert_eq!(pc1.check_external_change(b"not json", 3), ExternalChange::MacFailed);

    // Password changed on PC2: the header changed.
    pc2.change_password(PW, "another correct horse battery staple", false, "Personal").unwrap();
    let f2c = pc2.to_bytes(3);
    assert_eq!(pc1.check_external_change(&f2c, 3), ExternalChange::HeaderChanged);
    assert!(pc1.reload(&f2c).is_err());
}

#[test]
fn restore_backup_while_unlocked() {
    let k = sk();
    let mut v = new_vault(&k);
    let a = v.item_save(&login("keep me", "u", "p1"), None).unwrap();
    let backup = saved(&mut v);
    v.item_delete_forever(&a.id).unwrap();
    v.item_save(&login("later", "u", "p2"), None).unwrap();
    saved(&mut v);
    v.restore_backup(&backup, None).unwrap();
    let titles: Vec<String> = v.items_list().into_iter().map(|s| s.title).collect();
    assert_eq!(titles, vec!["keep me".to_owned()]);
    let b = v.to_bytes(10);
    assert_eq!(crate::vault_file::read_header(&b).unwrap().generation, 11);
    // A backup of another vault is refused.
    let mut other = new_vault(&k);
    let ob = saved(&mut other);
    assert!(v.restore_backup(&ob, None).is_err());
}

// ---------------------------------------------------------------- password and key

#[test]
fn change_password_without_and_with_rekey() {
    let k = sk();
    let mut v = new_vault(&k);
    let a = v.item_save(&login("A", "u", "pw-a"), None).unwrap();
    let before = saved(&mut v);
    let rec_before = json(&before)["records"].clone();
    let p2 = "second correct horse battery staple";
    v.change_password(PW, p2, false, "Personal").unwrap();
    let after = saved(&mut v);
    // Same VK: records unchanged, old password fails, new works.
    assert_eq!(json(&after)["records"], rec_before);
    assert_eq!(open(&after, PW, &k).unwrap_err(), CoreError::BadCredentials);
    assert!(open(&after, p2, &k).is_ok());

    let p3 = "third correct horse battery staple";
    v.change_password(p2, p3, true, "Personal").unwrap();
    let rekeyed = saved(&mut v);
    assert_ne!(json(&rekeyed)["records"], rec_before);
    let mut back = open(&rekeyed, p3, &k).unwrap();
    assert_eq!(&*back.item_reveal(&a.id, "password", None).unwrap(), "pw-a");
    // Wrong current password and weak new one.
    assert_eq!(v.change_password("x", "fourth correct horse battery", false, "P").unwrap_err(), CoreError::BadCredentials);
    assert_eq!(v.change_password(p3, "abc", false, "P").unwrap_err().code(), "weakPassword");
}

#[test]
fn rotate_secret_key_rekeys() {
    let k = sk();
    let mut v = new_vault(&k);
    let a = v.item_save(&login("A", "u", "pw-a"), None).unwrap();
    saved(&mut v);
    let k2 = v.rotate_secret_key(PW).unwrap();
    assert_ne!(k2, k);
    let b = saved(&mut v);
    assert_eq!(crate::vault_file::read_header(&b).unwrap().key_id, k2.key_id());
    let mut back = open(&b, PW, &k2).unwrap();
    assert_eq!(&*back.item_reveal(&a.id, "password", None).unwrap(), "pw-a");
    assert!(open(&b, PW, &k).is_err());
    assert_eq!(v.secret_key_for_kit(PW).unwrap(), k2);
}

// ---------------------------------------------------------------- items

#[test]
fn view_masks_secrets_and_summary_has_none() {
    let k = sk();
    let mut v = new_vault(&k);
    let mut input = login("Bank", "me", "hunter2-is-secret");
    input.fields.push(field("totp", FieldKind::Totp, "otpauth://totp/x?secret=GEZDGNBVGY3TQOJQ"));
    let view = v.item_save(&input, None).unwrap();
    let pw = view.fields.iter().find(|f| f.builtin.as_deref() == Some("password")).unwrap();
    assert_eq!(pw.value, "");
    assert_eq!(pw.masked, Some(true));
    let u = view.fields.iter().find(|f| f.builtin.as_deref() == Some("username")).unwrap();
    assert_eq!(u.value, "me");
    let all = serde_json::to_string(&v.items_list()).unwrap() + &serde_json::to_string(&view).unwrap();
    assert!(!all.contains("hunter2-is-secret"));
    assert!(!all.contains("GEZDGNBV"));
    assert!(v.items_list()[0].has_totp);
}

#[test]
fn field_refs_history_role_and_id() {
    let k = sk();
    let mut v = new_vault(&k);
    let view = v.item_save(&login("A", "user1", "old-pass"), None).unwrap();
    let mut input = as_input(&view);
    input.fields[1].value = Some("new-pass".into());
    let view2 = v.item_save(&input, None).unwrap();
    assert_eq!(view2.password_history_count, 1);
    let hist = v.item_password_history(&view.id, None).unwrap();
    assert_eq!(hist[0].length, 8);
    let h = format!("history:{}", hist[0].id);
    assert_eq!(&*v.item_reveal(&view.id, &h, None).unwrap(), "old-pass");
    assert_eq!(&*v.item_reveal(&view.id, "password", None).unwrap(), "new-pass");
    let fid = &view2.fields[0].id;
    assert_eq!(&*v.item_reveal(&view.id, fid, None).unwrap(), "user1");
    assert_eq!(v.item_reveal(&view.id, "nothing", None).unwrap_err(), CoreError::NotFound);
    assert!(view2.password_changed_at.is_some());
}

#[test]
fn null_value_keeps_secret_and_rejects_kind_change() {
    let k = sk();
    let mut v = new_vault(&k);
    let view = v.item_save(&login("A", "u", "keep-this"), None).unwrap();
    let mut input = as_input(&view);
    input.title = "A renamed".into();
    assert!(input.fields[1].value.is_none());
    let view2 = v.item_save(&input, None).unwrap();
    assert_eq!(&*v.item_reveal(&view2.id, "password", None).unwrap(), "keep-this");
    assert_eq!(view2.password_history_count, 0);
    // Kind change with value null: invalid.
    let mut bad = as_input(&view2);
    bad.fields[1].kind = FieldKind::Text;
    assert_eq!(v.item_save(&bad, None).unwrap_err().code(), "invalid");
    // Unknown field id with value null: invalid.
    let mut bad2 = as_input(&view2);
    bad2.fields[1].id = Uuid::new_v4().to_string();
    assert_eq!(v.item_save(&bad2, None).unwrap_err().code(), "invalid");
}

#[test]
fn stale_base_rev_is_conflict() {
    let k = sk();
    let mut v = new_vault(&k);
    let view = v.item_save(&login("A", "u", "p"), None).unwrap();
    let input = as_input(&view);
    v.item_patch(&view.id, Some(true), None, None).unwrap();
    assert_eq!(v.item_save(&input, None).unwrap_err().code(), "conflict");
}

#[test]
fn reprompt_is_enforced() {
    let k = sk();
    let mut v = new_vault(&k);
    let mut input = login("Guarded", "u", "guarded-pass");
    input.reprompt = true;
    input.fields.push(field("totp", FieldKind::Totp, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"));
    let view = v.item_save(&input, None).unwrap();
    let id = view.id.clone();
    assert!(v.is_reprompt(&id).unwrap());
    assert_eq!(v.item_reveal(&id, "password", None).unwrap_err(), CoreError::RepromptRequired);
    assert_eq!(v.item_copy_value(&id, "password", None).unwrap_err(), CoreError::RepromptRequired);
    assert_eq!(v.totp_code(&id, None, None).unwrap_err(), CoreError::RepromptRequired);
    assert_eq!(v.item_password_history(&id, None).unwrap_err(), CoreError::RepromptRequired);
    assert_eq!(v.item_revisions(&id, None).unwrap_err(), CoreError::RepromptRequired);
    // Username is not secret: copy works without the password.
    assert_eq!(&*v.item_copy_value(&id, "username", None).unwrap(), "u");
    assert_eq!(v.item_reveal(&id, "password", Some("wrong")).unwrap_err(), CoreError::BadCredentials);
    assert_eq!(v.grant_count(), 0);
    assert_eq!(&*v.item_reveal(&id, "password", Some(PW)).unwrap(), "guarded-pass");
    // The grant now covers the next calls.
    assert_eq!(v.grant_count(), 1);
    assert!(v.item_copy_value(&id, "password", None).is_ok());
    // Copying the totp field gives the code; reveal gives the secret.
    let code = v.item_copy_value(&id, "totp", None).unwrap();
    assert_eq!(code.len(), 6);
    assert!(v.item_reveal(&id, "totp", None).unwrap().starts_with("GEZDGNBV"));
    assert_eq!(v.totp_code_at(&id, None, None, 59).unwrap().code, "287082");
}

#[test]
fn saves_cannot_weaken_reprompt() {
    let k = sk();
    let mut v = new_vault(&k);
    let mut input = login("Guarded", "u", "p");
    input.reprompt = true;
    let view = v.item_save(&input, None).unwrap();
    // Turning re-prompt off needs the password.
    let mut off = as_input(&view);
    off.reprompt = false;
    assert!(v.save_needs_password(&off).unwrap());
    assert_eq!(v.item_save(&off, None).unwrap_err(), CoreError::RepromptRequired);
    // Changing a secret field's kind (with a value) needs it too.
    let mut kind = as_input(&view);
    kind.fields[1].kind = FieldKind::Text;
    kind.fields[1].value = Some("p".into());
    assert!(v.save_needs_password(&kind).unwrap());
    assert_eq!(v.item_save(&kind, None).unwrap_err(), CoreError::RepromptRequired);
    // A plain edit does not.
    let mut plain = as_input(&view);
    plain.title = "Renamed".into();
    assert!(!v.save_needs_password(&plain).unwrap());
    let view2 = v.item_save(&plain, None).unwrap();
    // With the password it works.
    let mut off2 = as_input(&view2);
    off2.reprompt = false;
    assert!(!v.item_save(&off2, Some(PW)).unwrap().reprompt);
}

#[test]
fn restore_revision_cannot_weaken_reprompt() {
    let k = sk();
    let mut v = new_vault(&k);
    let view = v.item_save(&login("Open", "u", "p"), None).unwrap();
    let mut guarded = as_input(&view);
    guarded.reprompt = true;
    let view2 = v.item_save(&guarded, None).unwrap();
    // Rev 1 had no re-prompt: restoring it needs the password.
    assert_eq!(v.item_revisions(&view.id, Some(PW)).unwrap()[0].rev, 1);
    let mut fresh = open(&{ v.to_bytes(0) }, PW, &k).unwrap();
    assert_eq!(fresh.item_restore_revision(&view2.id, 1, None).unwrap_err(), CoreError::RepromptRequired);
    let restored = fresh.item_restore_revision(&view2.id, 1, Some(PW)).unwrap();
    assert!(!restored.reprompt);
    assert_eq!(restored.title, "Open");
}

#[test]
fn revisions_keep_last_10_and_history_last_20() {
    let k = sk();
    let mut v = new_vault(&k);
    let mut view = v.item_save(&login("A", "u", "p0"), None).unwrap();
    for n in 1..=25 {
        let mut input = as_input(&view);
        input.fields[1].value = Some(format!("p{n}"));
        view = v.item_save(&input, None).unwrap();
    }
    assert_eq!(v.item_revisions(&view.id, None).unwrap().len(), REVISIONS_MAX);
    let h = v.item_password_history(&view.id, None).unwrap();
    assert_eq!(h.len(), PASSWORD_HISTORY_MAX);
    let newest = format!("history:{}", h[0].id);
    assert_eq!(&*v.item_reveal(&view.id, &newest, None).unwrap(), "p24");
    assert_eq!(view.rev, 26);
}

#[test]
fn states_trash_and_purge() {
    let k = sk();
    let mut v = new_vault(&k);
    let a = v.item_save(&login("A", "u", "p"), None).unwrap();
    let b = v.item_save(&login("B", "u", "p"), None).unwrap();
    v.item_set_state(&a.id, ItemState::Trashed).unwrap();
    assert!(v.item_get(&a.id).unwrap().trashed_at.is_some());
    v.item_set_state(&a.id, ItemState::Active).unwrap();
    assert!(v.item_get(&a.id).unwrap().trashed_at.is_none());
    let n = v.items_bulk(&[a.id.clone(), b.id.clone(), "junk".into()], BulkAction::Trash, None).unwrap();
    assert_eq!(n, 2);
    let now = time_util::now();
    assert_eq!(v.purge_expired_trash_at(now + Duration::days(29)), 0);
    assert_eq!(v.purge_expired_trash_at(now + Duration::days(30)), 2);
    assert!(v.items_list().is_empty());
    let c = v.item_save(&login("C", "u", "p"), None).unwrap();
    v.item_set_state(&c.id, ItemState::Trashed).unwrap();
    assert_eq!(v.trash_empty(), 1);
}

#[test]
fn bulk_tags_and_patch() {
    let k = sk();
    let mut v = new_vault(&k);
    let a = v.item_save(&login("A", "u", "p"), None).unwrap();
    assert_eq!(v.items_bulk(&[a.id.clone()], BulkAction::AddTag, Some("Work/Clients")).unwrap(), 1);
    assert_eq!(v.items_bulk(&[a.id.clone()], BulkAction::AddTag, Some("Work/Clients")).unwrap(), 0);
    let s = v.item_patch(&a.id, Some(true), Some(&[" x ".into(), "x".into(), "".into()]), Some(true)).unwrap();
    assert!(s.favorite);
    assert_eq!(s.tags, vec!["x".to_owned()]);
    assert!(v.item_get(&a.id).unwrap().health_excluded);
    assert!(v.items_bulk(&[a.id.clone()], BulkAction::AddTag, None).is_err());
}

#[test]
fn open_url_only_http_and_https() {
    let k = sk();
    let mut v = new_vault(&k);
    let mut input = login("A", "u", "p");
    input.urls = vec![
        ItemUrl { url: "https://ok.example".into(), label: None },
        ItemUrl { url: "file:///C:/Windows/System32/calc.exe".into(), label: None },
        ItemUrl { url: "ms-settings:privacy".into(), label: None },
        ItemUrl { url: "http://plain.example".into(), label: None },
    ];
    let view = v.item_save(&input, None).unwrap();
    assert_eq!(v.item_url_for_open(&view.id, 0).unwrap(), "https://ok.example");
    assert_eq!(v.item_url_for_open(&view.id, 1).unwrap_err().code(), "invalid");
    assert_eq!(v.item_url_for_open(&view.id, 2).unwrap_err().code(), "invalid");
    assert!(v.item_url_for_open(&view.id, 3).is_ok());
    assert_eq!(v.item_url_for_open(&view.id, 9).unwrap_err(), CoreError::NotFound);
    assert!(v.item_get(&view.id).unwrap().flags.unsecured);
}

#[test]
fn generator_history_only_on_copy_or_save() {
    let k = sk();
    let mut v = new_vault(&k);
    let g1 = v.generate(&GeneratorOptions::default()).unwrap();
    assert!(v.generator_history().is_empty());
    v.generator_copied(&g1.value);
    assert_eq!(v.generator_history().len(), 1);
    let g2 = v.generate(&GeneratorOptions::default()).unwrap();
    v.item_save(&login("A", "u", &g2.value), None).unwrap();
    let h = v.generator_history();
    assert_eq!(h.len(), 2);
    assert_eq!(&*v.generator_history_value(&h[0].id).unwrap(), g2.value.as_str());
    let mut opts = GeneratorOptions::default();
    opts.length = 33;
    v.generate(&opts).unwrap();
    // Last options survive a save and unlock.
    let b = saved(&mut v);
    let back = open(&b, PW, &k).unwrap();
    assert_eq!(back.generator_options().length, 33);
    assert_eq!(back.generator_history().len(), 2);
    let mut back = back;
    back.generator_history_clear();
    assert!(back.generator_history().is_empty());
}

#[test]
fn flags_after_save_and_breach_cache() {
    let k = sk();
    let mut v = new_vault(&k);
    let a = v.item_save(&login("A", "u", "password"), None).unwrap();
    assert!(v.item_get(&a.id).unwrap().flags.weak);
    let q = v.breach_queries();
    assert_eq!(q.len(), 1);
    assert_eq!(q[0].prefix, "5BAA6");
    v.apply_breach_results(&[(a.id.clone(), 42)], "2026-10-16T00:00:00Z");
    assert!(v.item_get(&a.id).unwrap().flags.breached);
    let r = v.health_report(BreachMode::Manual);
    assert_eq!(r.breach_checked_at.as_deref(), Some("2026-10-16T00:00:00Z"));
    assert_eq!(r.counts.breached, 1);
    // Archived: every flag false.
    v.item_set_state(&a.id, ItemState::Archived).unwrap();
    assert_eq!(v.item_get(&a.id).unwrap().flags, ItemFlags::default());
    // A new password has no cache entry.
    v.item_set_state(&a.id, ItemState::Active).unwrap();
    let mut input = as_input(&v.item_get(&a.id).unwrap());
    input.fields[1].value = Some("Another-L0ng-Unbreached-Pass!".into());
    v.item_save(&input, None).unwrap();
    assert!(!v.item_get(&a.id).unwrap().flags.breached);
}

#[test]
fn debug_prints_no_secret() {
    let k = sk();
    let mut v = new_vault(&k);
    v.item_save(&login("Visible", "u", "debug-secret-xyz"), None).unwrap();
    let d = format!("{v:?} {:?}", v.items.values().next().unwrap().item);
    assert!(!d.contains("debug-secret-xyz"));
}

// ---------------------------------------------------------------- review fixes (e62fd60)

/// Review item 1: a save whose write did not land must not be dropped by
/// a reload. Before: `to_bytes` filled the record caches, `is_dirty` was
/// false and the decision was `Reload`, so the shell reloaded over the edit.
#[test]
fn failed_write_keeps_edit_and_turns_reload_into_conflict() {
    let k = sk();
    let mut v0 = new_vault(&k);
    assert!(v0.is_dirty(), "a vault never saved is dirty");
    let it = v0.item_save(&login("Mail", "u", "old-pw"), None).unwrap();
    let b1 = saved(&mut v0);
    assert!(!v0.is_dirty());
    let mut a = open(&b1, PW, &k).unwrap();
    let mut b = open(&b1, PW, &k).unwrap();
    let clean = open(&b1, PW, &k).unwrap();
    // PC B edits the notes and saves (generation 2).
    let mut ib = as_input(&b.item_get(&it.id).unwrap());
    ib.notes = "note from B".into();
    b.item_save(&ib, None).unwrap();
    let disk_b = b.to_bytes(1);
    b.mark_saved();
    // PC A changes the password; its write fails (the disk is B's file).
    let mut ia = as_input(&a.item_get(&it.id).unwrap());
    ia.fields.iter_mut().find(|f| f.builtin.as_deref() == Some("password")).unwrap().value = Some("NEW-pw-from-A".into());
    a.item_save(&ia, None).unwrap();
    assert!(a.is_dirty());
    let _attempt = a.to_bytes(1);
    assert!(a.is_dirty(), "a to_bytes whose write did not land leaves the vault dirty");
    assert_eq!(a.check_external_change(&disk_b, 1), ExternalChange::Conflict);
    assert_eq!(&*a.item_reveal(&it.id, "password", None).unwrap(), "NEW-pw-from-A");
    // A vault with no open change still reloads.
    assert!(!clean.is_dirty());
    assert_eq!(clean.check_external_change(&disk_b, 1), ExternalChange::Reload);
    // A change of the meta record alone counts too.
    let mut m = open(&b1, PW, &k).unwrap();
    m.generate(&GeneratorOptions::default()).unwrap();
    let _attempt = m.to_bytes(1);
    assert!(m.is_dirty());
    assert_eq!(m.check_external_change(&disk_b, 1), ExternalChange::Conflict);
}

/// Review item 2: restoring a backup made before re-prompt was switched
/// on must not switch it off without the master password.
#[test]
fn restore_backup_cannot_weaken_reprompt() {
    let k = sk();
    let mut v = new_vault(&k);
    let it = v.item_save(&login("Bank", "u", "S3cret-bank-pw"), None).unwrap();
    let backup = saved(&mut v);
    let mut inp = as_input(&v.item_get(&it.id).unwrap());
    inp.reprompt = true; // turning re-prompt on needs nothing
    v.item_save(&inp, None).unwrap();
    let guarded = saved(&mut v);
    assert_eq!(v.item_reveal(&it.id, "password", None).unwrap_err(), CoreError::RepromptRequired);
    assert_eq!(v.restore_backup(&backup, None).unwrap_err(), CoreError::RepromptRequired);
    assert!(v.is_reprompt(&it.id).unwrap(), "a refused restore changes nothing");
    assert!(!v.is_dirty());
    assert_eq!(v.restore_backup(&backup, Some("not the master password ok")).unwrap_err(), CoreError::BadCredentials);
    v.restore_backup(&backup, Some(PW)).unwrap();
    assert!(!v.is_reprompt(&it.id).unwrap());
    // A restore that does not weaken re-prompt needs nothing.
    v.restore_backup(&guarded, None).unwrap();
    assert!(v.is_reprompt(&it.id).unwrap());
    v.restore_backup(&guarded, None).unwrap();
    // A live grant for the item covers it.
    v.item_reveal(&it.id, "password", Some(PW)).unwrap();
    v.restore_backup(&backup, None).unwrap();
    assert!(!v.is_reprompt(&it.id).unwrap());
}

/// Review item 5: a concealed username (of a re-prompt item) leaked
/// through `ItemSummary.subtitle` and `ItemView.subtitle`.
#[test]
fn subtitle_never_shows_secret_fields() {
    let k = sk();
    let mut v = new_vault(&k);
    let mut inp = login("Corp VPN", "acct-77421-SECRET", "pw");
    inp.fields[0].kind = FieldKind::Concealed;
    inp.reprompt = true;
    let it = v.item_save(&inp, None).unwrap();
    assert_eq!(it.subtitle, "");
    assert_eq!(v.item_get(&it.id).unwrap().subtitle, "");
    assert_eq!(v.items_list()[0].subtitle, "");
    assert_eq!(v.item_reveal(&it.id, "username", None).unwrap_err(), CoreError::RepromptRequired);
    // A plain username still shows; a card keeps its last 4 digits.
    assert_eq!(v.item_save(&login("Plain", "visible-user", "pw"), None).unwrap().subtitle, "visible-user");
    let card = ItemInput {
        item_type: ItemType::Card,
        title: "Card".into(),
        fields: vec![field("number", FieldKind::CardNumber, "4111 1111 1111 1234")],
        urls: vec![],
        ..login("unused", "", "")
    };
    assert_eq!(v.item_save(&card, None).unwrap().subtitle, "\u{2022}\u{2022}\u{2022}\u{2022} 1234");
}

/// Review item 6: after a password change (or rotation) not yet saved,
/// an unchanged disk file read as `HeaderChanged` (and, with rekey, its
/// MAC failed under the new key).
#[test]
fn unsaved_password_change_keeps_disk_unchanged() {
    let p2 = "a much longer new passphrase quartz falcon";
    for rekey in [false, true] {
        let k = sk();
        let mut v = new_vault(&k);
        v.item_save(&login("A", "u", "pw-a"), None).unwrap();
        let disk = saved(&mut v);
        assert_eq!(v.check_external_change(&disk, 1), ExternalChange::Unchanged);
        v.change_password(PW, p2, rekey, "Personal").unwrap();
        assert_eq!(v.check_external_change(&disk, 1), ExternalChange::Unchanged, "rekey={rekey}");
        assert!(v.is_dirty(), "an unsaved password change is a change");
        // Another PC saves meanwhile: our open change makes it a conflict;
        // the reload returns to the disk's header and keys.
        let mut other = open(&disk, PW, &k).unwrap();
        other.item_save(&login("B", "u", "pw-b"), None).unwrap();
        let disk2 = saved(&mut other);
        assert_eq!(v.check_external_change(&disk2, 1), ExternalChange::Conflict, "rekey={rekey}");
        v.reload(&disk2).unwrap();
        assert_eq!(v.items_list().len(), 2);
        assert!(v.verify_password(PW).is_ok());
        assert!(!v.is_dirty());
        // Once the save lands, the new file is the base.
        v.change_password(PW, p2, rekey, "Personal").unwrap();
        let disk3 = saved(&mut v);
        assert_eq!(v.check_external_change(&disk3, 2), ExternalChange::Unchanged);
        assert!(!v.is_dirty());
        assert!(open(&disk3, p2, &k).is_ok());
    }
    // Secret Key rotation (always a rekey).
    let k = sk();
    let mut v = new_vault(&k);
    let disk = saved(&mut v);
    let k2 = v.rotate_secret_key(PW).unwrap();
    assert_eq!(v.check_external_change(&disk, 1), ExternalChange::Unchanged);
    let disk2 = saved(&mut v);
    assert_eq!(v.check_external_change(&disk2, 2), ExternalChange::Unchanged);
    assert!(open(&disk2, PW, &k2).is_ok());
}

/// Review item 7: `ItemInput` / `FieldInput` printed new passwords and
/// `BreachCacheEntry` printed the password SHA-256.
#[test]
fn inputs_and_breach_cache_debug_print_no_secret() {
    let mut inp = login("Visible", "u", "debug-new-pw-123");
    inp.notes = "secret note text".into();
    let d = format!("{inp:?} {:?}", inp.fields[1]);
    assert!(!d.contains("debug-new-pw-123") && !d.contains("secret note text"), "{d}");
    assert!(d.contains("Visible") && d.contains("<redacted>"));
    let e = BreachCacheEntry { item_id: "i".into(), password_sha256: "abcdef0123456789".into(), count: 3 };
    assert!(!format!("{e:?}").contains("abcdef0123456789"));
}
