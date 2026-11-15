//! Guards that the Rust side matches `src/lib/contract.ts`, the capability
//! files and the hardening settings of SPEC 3.7.

use std::collections::BTreeSet;

use crate::command_names::*;
use crate::contract::*;
use crate::error::ErrorCode;

const CONTRACT: &str = include_str!("../../src/lib/contract.ts");
const MAIN_CAP: &str = include_str!("../capabilities/main.json");
const QUICK_CAP: &str = include_str!("../capabilities/quick.json");
const TAURI_CONF: &str = include_str!("../tauri.conf.json");

/// The text between `start` and the next `end`.
fn block(start: &str, end: &str) -> &'static str {
    let from = CONTRACT.find(start).unwrap_or_else(|| panic!("{start} not in contract"));
    let rest = &CONTRACT[from + start.len()..];
    let to = rest.find(end).unwrap_or_else(|| panic!("end of {start} not found"));
    &rest[..to]
}

/// The string literals `"x"` in a TypeScript union body.
fn literals(body: &str) -> BTreeSet<String> {
    body.lines()
        .map(|l| l.split("//").next().unwrap_or(""))
        .flat_map(|l| l.split('"').skip(1).step_by(2).map(str::to_string).collect::<Vec<_>>())
        .collect()
}

fn ser<T: serde::Serialize>(v: T) -> String {
    serde_json::to_value(v).unwrap().as_str().unwrap().to_string()
}

#[test]
fn commands_match_the_contract() {
    let body = block("export interface Commands {", "\n}");
    let contract: BTreeSet<String> =
        body.lines().filter_map(|l| l.trim().split(':').next()).map(str::trim).filter(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_lowercase() || c == '_')).map(str::to_string).collect();
    let ours: BTreeSet<String> = COMMAND_NAMES.iter().filter(|n| !SHELL_ADDED_COMMANDS.contains(n)).map(|s| s.to_string()).collect();
    assert_eq!(ours, contract);
    let unique: BTreeSet<&str> = COMMAND_NAMES.iter().copied().collect();
    assert_eq!(unique.len(), COMMAND_NAMES.len(), "duplicate command name");
}

#[test]
fn registered_handlers_are_the_command_list() {
    assert_eq!(crate::REGISTERED_COMMANDS, COMMAND_NAMES);
}

fn permissions(cap: &str) -> (Vec<String>, Vec<String>) {
    let v: serde_json::Value = serde_json::from_str(cap).unwrap();
    assert!(v.get("remote").is_none(), "no remote key");
    let windows = v["windows"].as_array().unwrap().iter().map(|w| w.as_str().unwrap().to_string()).collect();
    let perms = v["permissions"].as_array().unwrap().iter().map(|p| p.as_str().expect("plain permission ids").to_string()).collect();
    (windows, perms)
}

fn allow(cmds: &[&str]) -> BTreeSet<String> {
    let mut set: BTreeSet<String> = cmds.iter().map(|c| format!("allow-{}", c.replace('_', "-"))).collect();
    set.insert("core:event:allow-listen".into());
    set.insert("core:event:allow-unlisten".into());
    set
}

#[test]
fn capabilities_are_per_window_and_minimal() {
    let (windows, quick) = permissions(QUICK_CAP);
    assert_eq!(windows, vec!["quick"]);
    // SPEC 3.7, plus generator_options (contract c5f1f96: the Quick Access
    // generator reads the last options too).
    let spec_quick = [
        "app_info", "settings_get", "quick_hint_seen", "vault_status", "vault_unlock", "vault_unlock_hello", "vault_unlock_pin", "vault_lock", "items_list", "item_get", "item_copy", "item_open_url",
        "totp_code", "autotype", "quick_context", "quick_hide", "quick_set_modal", "main_show", "generate", "generator_options", "generator_copy",
    ];
    assert_eq!(quick.iter().cloned().collect::<BTreeSet<_>>(), allow(&spec_quick));
    assert_eq!(allow(QUICK_COMMANDS), allow(&spec_quick));

    let (windows, main) = permissions(MAIN_CAP);
    assert_eq!(windows, vec!["main"]);
    let expected: Vec<&str> = COMMAND_NAMES.iter().copied().filter(|c| !QUICK_ONLY_COMMANDS.contains(c)).collect();
    assert_eq!(main.iter().cloned().collect::<BTreeSet<_>>(), allow(&expected));
    assert!(main.iter().all(|p| !p.contains("settings-set") || !quick.contains(p)));
    assert!(!quick.contains(&"allow-settings-set".to_string()), "quick may not change settings");
    for p in main.iter().chain(quick.iter()) {
        assert!(!p.starts_with("opener:") && !p.starts_with("dialog:") && !p.starts_with("fs:") && !p.starts_with("shell:"), "{p}");
        assert!(!p.starts_with("core:") || p == "core:event:allow-listen" || p == "core:event:allow-unlisten", "{p}");
    }
}

#[test]
fn error_codes_match() {
    let ours: BTreeSet<String> = [
        ErrorCode::BadCredentials,
        ErrorCode::NeedsSecretKey,
        ErrorCode::BadSecretKey,
        ErrorCode::VaultMissing,
        ErrorCode::Tampered,
        ErrorCode::Corrupt,
        ErrorCode::KdfTooWeak,
        ErrorCode::Locked,
        ErrorCode::NotFound,
        ErrorCode::Conflict,
        ErrorCode::RepromptRequired,
        ErrorCode::WeakPassword,
        ErrorCode::UnsupportedFormat,
        ErrorCode::Io,
        ErrorCode::Invalid,
        ErrorCode::HelloUnavailable,
        ErrorCode::HelloFailed,
        ErrorCode::Network,
        ErrorCode::OlderFile,
        ErrorCode::KdfTooStrong,
        ErrorCode::Exists,
        ErrorCode::PinUnavailable,
    ]
    .into_iter()
    .map(ser)
    .collect();
    assert_eq!(ours, literals(block("export type ErrorCode =", "\n\n")));
}

#[test]
fn enums_match() {
    let kinds: BTreeSet<String> = [
        FieldKind::Text,
        FieldKind::Concealed,
        FieldKind::Multiline,
        FieldKind::Email,
        FieldKind::Url,
        FieldKind::Phone,
        FieldKind::Date,
        FieldKind::MonthYear,
        FieldKind::Totp,
        FieldKind::Boolean,
        FieldKind::CardNumber,
        FieldKind::Pin,
        FieldKind::Menu,
        FieldKind::ConcealedMultiline,
    ]
    .into_iter()
    .map(ser)
    .collect();
    assert_eq!(kinds, literals(block("export type FieldKind =", "\n\n")));
    let all_kinds = [
        FieldKind::Text,
        FieldKind::Concealed,
        FieldKind::Multiline,
        FieldKind::Email,
        FieldKind::Url,
        FieldKind::Phone,
        FieldKind::Date,
        FieldKind::MonthYear,
        FieldKind::Totp,
        FieldKind::Boolean,
        FieldKind::CardNumber,
        FieldKind::Pin,
        FieldKind::Menu,
        FieldKind::ConcealedMultiline,
    ];
    let secret: BTreeSet<String> = all_kinds.iter().filter(|k| k.is_secret()).map(|k| ser(*k)).collect();
    assert_eq!(secret, literals(block("export const SECRET_KINDS: FieldKind[] =", "\n")));

    let types: BTreeSet<String> = [
        ItemType::Login,
        ItemType::Password,
        ItemType::Note,
        ItemType::Card,
        ItemType::Identity,
        ItemType::Bank,
        ItemType::Document,
        ItemType::SshKey,
        ItemType::ApiCredential,
        ItemType::Wifi,
        ItemType::License,
    ]
    .into_iter()
    .map(ser)
    .collect();
    assert_eq!(types, literals(block("export type ItemType =", "\n\n")));

    let reasons: BTreeSet<String> =
        [LockReason::Manual, LockReason::Idle, LockReason::SystemLock, LockReason::Sleep, LockReason::Quit, LockReason::KeyChanged].into_iter().map(ser).collect();
    let line = CONTRACT.lines().find(|l| l.contains("\"vault://locked\":")).unwrap();
    let union = &line[line.find("reason:").unwrap()..];
    assert_eq!(reasons, literals(union));

    assert_eq!(ser(SyncProvider::GoogleDrive), "Google Drive");
    assert_eq!(ser(ExportKind::CofferEncrypted), "cofferEncrypted");
    assert_eq!(serde_json::from_str::<BulkAction>("\"removeTag\"").unwrap(), BulkAction::RemoveTag);
    assert_eq!(ser(ImportSource::Conflict), "conflict");
    assert_eq!(ser(TotpSource::Screen), "screen");
    assert_eq!(ser(HotkeyState::InUse), "inUse");

    let phases: BTreeSet<String> =
        [UpdatePhase::Off, UpdatePhase::Idle, UpdatePhase::Checking, UpdatePhase::Downloading, UpdatePhase::Ready, UpdatePhase::Installing].into_iter().map(ser).collect();
    assert_eq!(phases, literals(block("export type UpdatePhase =", ";")));

    let browsers: BTreeSet<String> = [BrowserKind::Chrome, BrowserKind::Edge, BrowserKind::Chromium, BrowserKind::Other].into_iter().map(ser).collect();
    assert_eq!(browsers, literals(block("export type BrowserKind =", ";")));
}

/// The quoted value after `key: "` in a line, e.g. `role: "host"`.
fn quoted_after<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let from = line.find(&format!("{key}: \""))? + key.len() + 3;
    line[from..].split('"').next()
}

#[test]
fn builtin_fields_match_the_templates() {
    let body = block("export const BUILTIN_FIELDS", "\n};");
    let mut ts: Vec<(String, String, String, String)> = Vec::new();
    let mut current = String::new();
    for line in body.lines() {
        let t = line.trim();
        if let Some((name, rest)) = t.split_once(':')
            && rest.trim_start().starts_with('[')
            && name.chars().all(|c| c.is_ascii_alphanumeric())
        {
            current = name.to_string();
        }
        for part in t.split('{').skip(1) {
            if let (Some(role), Some(label), Some(kind)) = (quoted_after(part, "role"), quoted_after(part, "label"), quoted_after(part, "kind")) {
                ts.push((current.clone(), role.into(), label.into(), kind.into()));
            }
        }
    }
    let ours: Vec<(String, String, String, String)> = coffer_core::templates::all_templates()
        .iter()
        .flat_map(|t| t.fields.iter().map(move |f| (ser(t.item_type), f.role.to_string(), f.label.to_string(), ser(f.kind))))
        .collect();
    let sorted = |mut v: Vec<(String, String, String, String)>| {
        v.sort_by(|a, b| a.0.cmp(&b.0));
        v
    };
    // Same fields, same labels, same order within each type.
    assert_eq!(sorted(ts), sorted(ours));
}

#[test]
fn renamed_labels_match() {
    let body = block("export const RENAMED_LABELS", "\n];");
    let ts: Vec<Vec<String>> = body
        .lines()
        .filter(|l| l.trim_start().starts_with('['))
        .map(|l| l.split('"').skip(1).step_by(2).map(str::to_string).collect())
        .collect();
    let ours: Vec<Vec<String>> =
        coffer_core::templates::RENAMED_LABELS.iter().map(|(t, role, old)| vec![ser(*t), role.to_string(), old.to_string()]).collect();
    assert_eq!(ts, ours);
}

#[test]
fn core_errors_keep_their_codes() {
    use coffer_core::CoreError;
    let cases = [
        (CoreError::BadCredentials, ErrorCode::BadCredentials),
        (CoreError::Tampered, ErrorCode::Tampered),
        (CoreError::KdfTooWeak, ErrorCode::KdfTooWeak),
        (CoreError::KdfTooStrong, ErrorCode::KdfTooStrong),
        (CoreError::OlderFile { seen: 9, file: 3 }, ErrorCode::OlderFile),
        (CoreError::Exists, ErrorCode::Exists),
        (CoreError::NotFound, ErrorCode::NotFound),
        (CoreError::RepromptRequired, ErrorCode::RepromptRequired),
        (CoreError::Conflict("x".into()), ErrorCode::Conflict),
        (CoreError::WeakPassword("x".into()), ErrorCode::WeakPassword),
        (CoreError::UnsupportedFormat("x".into()), ErrorCode::UnsupportedFormat),
        (CoreError::Invalid("x".into()), ErrorCode::Invalid),
        (CoreError::Io("x".into()), ErrorCode::Io),
        (CoreError::Corrupt("x".into()), ErrorCode::Corrupt),
        (CoreError::BadSecretKey("x".into()), ErrorCode::BadSecretKey),
    ];
    for (core, code) in cases {
        let message = core.to_string();
        let ours: crate::error::CofferError = core.into();
        assert_eq!(ours.code, code);
        assert_eq!(ours.message, message);
    }
}

#[test]
fn events_match() {
    let body = block("export interface Events {", "\n}");
    let contract: BTreeSet<String> = body.lines().filter_map(|l| l.trim().strip_prefix('"')?.split('"').next().map(str::to_string)).collect();
    let ours: BTreeSet<String> = [
        events::VAULT_LOCKED,
        events::VAULT_DISK_DAMAGED,
        events::VAULT_OLDER_ON_DISK,
        events::VAULT_UNLOCKED,
        events::VAULT_CHANGED,
        events::VAULT_RELOADED,
        events::VAULT_CONFLICT,
        events::VAULT_MISSING,
        events::CLIPBOARD_COPIED,
        events::CLIPBOARD_CLEARED,
        events::QUICK_SHOWN,
        events::MAIN_NAVIGATE,
        events::EDIT_DISCARDED,
        events::APP_QUIT_REQUESTED,
        events::MAIN_CLOSE_NOTICE,
        events::UPDATE_STATE,
        events::BRIDGE_CHANGED,
    ]
    .into_iter()
    .map(str::to_string)
    .collect();
    assert_eq!(ours, contract);
}

#[test]
fn payload_shapes() {
    let v = serde_json::to_value(OlderOnDiskEvent { file_generation: 3, seen_generation: 9 }).unwrap();
    assert_eq!(v, serde_json::json!({ "fileGeneration": 3, "seenGeneration": 9 }));
    let v = serde_json::to_value(ClipboardCopiedEvent { label: "Password".into(), clears_in_seconds: Some(90) }).unwrap();
    assert_eq!(v, serde_json::json!({ "label": "Password", "clearsInSeconds": 90 }));
    let v = serde_json::to_value(NavigateEvent { item_id: None, view: Some(MainView::Settings) }).unwrap();
    assert_eq!(v, serde_json::json!({ "itemId": null, "view": "settings" }));
    let v = serde_json::to_value(Empty {}).unwrap();
    assert_eq!(v, serde_json::json!({}));
    let v = serde_json::to_value(KdfBenchmark { millis: 1, m_kib: 2, t: 3, p: 4 }).unwrap();
    assert_eq!(v, serde_json::json!({ "millis": 1, "mKib": 2, "t": 3, "p": 4 }));
    let input: ItemInput = serde_json::from_value(serde_json::json!({
        "type": "login", "title": "GitHub", "favorite": false, "tags": [],
        "fields": [{ "id": "f1", "label": "Password", "kind": "concealed", "value": null, "builtin": "password" }],
        "notes": "", "urls": [], "apps": [], "reprompt": false, "autotypeSequence": null, "healthExcluded": false
    }))
    .unwrap();
    assert!(input.id.is_none() && input.fields[0].value.is_none());
}

#[test]
fn bridge_shapes() {
    let info = BridgeInfo {
        browsers: vec![BrowserLink { id: "ab".into(), browser: BrowserKind::Edge, name: "Microsoft Edge".into(), paired_at: "t".into(), last_used_at: None }],
        extension_folder: r"C:\x\extension".into(),
        extension_found: true,
        pending: Some(PairRequest { pair_id: "p".into(), browser: BrowserKind::Chrome, name: "Chrome".into(), words: vec!["a".into()], expires_at: "t".into() }),
        reprompt: Some(BridgeReprompt { request_id: "r".into(), browser: BrowserKind::Chrome, name: "Chrome".into(), title: "Northwind (work)".into(), site: "northwind-shop.test".into(), expires_at: "t".into() }),
        never_sites: vec!["northwind-shop.test".into()],
    };
    assert_eq!(
        serde_json::to_value(info).unwrap(),
        serde_json::json!({
            "browsers": [{ "id": "ab", "browser": "edge", "name": "Microsoft Edge", "pairedAt": "t", "lastUsedAt": null }],
            "extensionFolder": r"C:\x\extension",
            "extensionFound": true,
            "pending": { "pairId": "p", "browser": "chrome", "name": "Chrome", "words": ["a"], "expiresAt": "t" },
            "reprompt": { "requestId": "r", "browser": "chrome", "name": "Chrome", "title": "Northwind (work)", "site": "northwind-shop.test", "expiresAt": "t" },
            "neverSites": ["northwind-shop.test"]
        })
    );
    // The bridge commands are for the main window only.
    for c in ["bridge_info", "bridge_pair_answer", "bridge_disconnect", "bridge_copy_folder", "bridge_reprompt_answer", "bridge_never_remove"] {
        assert!(MAIN_CAP.contains(&format!("allow-{}", c.replace('_', "-"))), "{c}");
        assert!(!QUICK_CAP.contains(&format!("allow-{}", c.replace('_', "-"))), "{c}");
    }
}

/// The extension ID Chrome gives the public key in extension/manifest.json:
/// the first 16 bytes of SHA-256 of the key, each hex digit as a letter a-p.
fn extension_id() -> String {
    use base64::Engine;
    use sha2::Digest;
    let manifest: serde_json::Value = serde_json::from_str(include_str!("../../extension/manifest.json")).unwrap();
    let der = base64::engine::general_purpose::STANDARD.decode(manifest["key"].as_str().unwrap()).unwrap();
    sha2::Sha256::digest(&der)[..16].iter().flat_map(|b| [b >> 4, b & 15]).map(|n| (b'a' + n) as char).collect()
}

#[test]
fn installer_registers_the_bridge() {
    let hooks = include_str!("../windows/hooks.nsh");
    let conf: serde_json::Value = serde_json::from_str(TAURI_CONF).unwrap();
    assert_eq!(conf["bundle"]["windows"]["nsis"]["installerHooks"], "./windows/hooks.nsh");
    assert!(conf["build"]["beforeBuildCommand"].as_str().unwrap().contains("scripts/stage-bridge.mjs"));
    // The fixed ID in the host manifest is the one the manifest's key gives.
    let id = extension_id();
    assert_eq!(id, "jdnmjnanpckdfdhfclpkcbgimdjbeglj");
    assert!(hooks.contains(&format!("!define COFFER_EXTENSION_ID \"{id}\"")));
    assert!(include_str!("../../docs/BRIDGE.md").contains(&id));
    // Both browsers, keyed by the identifier: a QA build never writes Coffer's own host name.
    for key in [r"Software\Google\Chrome\NativeMessagingHosts", r"Software\Microsoft\Edge\NativeMessagingHosts"] {
        assert!(hooks.contains(key), "{key}");
    }
    assert_eq!(hooks.matches(r#"WriteRegStr HKCU "${COFFER_CHROME_HOSTS}\${BUNDLEID}""#).count(), 1);
    assert_eq!(hooks.matches(r#"WriteRegStr HKCU "${COFFER_EDGE_HOSTS}\${BUNDLEID}""#).count(), 1);
    assert_eq!(hooks.matches(r#"DeleteRegKey HKCU "${COFFER_CHROME_HOSTS}\${BUNDLEID}""#).count(), 1);
    assert_eq!(hooks.matches(r#"DeleteRegKey HKCU "${COFFER_EDGE_HOSTS}\${BUNDLEID}""#).count(), 1);
    assert!(!hooks.lines().filter(|l| !l.trim_start().starts_with(';')).any(|l| l.contains("dev.sampo.coffer")), "no fixed host name outside comments");
    // The extension asks only for what it uses: the bridge (M3), and for fill (M4) a content
    // script on https pages and on http://localhost and 127.0.0.1, and the Ctrl+Shift+L command.
    let manifest: serde_json::Value = serde_json::from_str(include_str!("../../extension/manifest.json")).unwrap();
    assert_eq!(manifest["permissions"], serde_json::json!(["nativeMessaging", "storage", "privacy"]));
    assert!(manifest.get("host_permissions").is_none() && manifest.get("externally_connectable").is_none());
    assert!(manifest.get("web_accessible_resources").is_none(), "no extension file is open to web pages");
    assert_eq!(
        manifest["content_scripts"],
        serde_json::json!([{ "matches": ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"], "js": ["content.js"], "all_frames": true, "run_at": "document_idle" }])
    );
    assert_eq!(manifest["commands"].as_object().map(|c| c.len()), Some(1));
    assert_eq!(manifest["commands"]["fill-login"]["suggested_key"]["default"], "Ctrl+Shift+L");
}

#[test]
fn updater_config() {
    let v: serde_json::Value = serde_json::from_str(TAURI_CONF).unwrap();
    let u = &v["plugins"]["updater"];
    assert_eq!(u["endpoints"], serde_json::json!(["https://github.com/011-sam-110/coffer/releases/latest/download/latest.json"]));
    // The signature must name the version latest.json announces (no pairing of a new number with an old installer).
    assert_eq!(u["requireSignedVersion"], true);
    assert!(u.get("dangerousInsecureTransportProtocol").is_none() && u.get("allowDowngrades").is_none());
    assert_eq!(u["windows"]["installMode"], "passive");
    let key = u["pubkey"].as_str().unwrap();
    assert!(key == crate::updates::PUBKEY_PLACEHOLDER || crate::updates::is_real_pubkey(key), "pubkey is the placeholder or a real key");
    // Signing is a separate step (scripts/release.mjs publish): the build needs no private key.
    assert!(v["bundle"].get("createUpdaterArtifacts").is_none_or(|c| c == false));
    // The webview gets no updater permission: Rust checks and installs.
    assert!(!MAIN_CAP.contains("updater:") && !QUICK_CAP.contains("updater:"));
}

#[test]
fn webview_hardening_config() {
    let v: serde_json::Value = serde_json::from_str(TAURI_CONF).unwrap();
    let app = &v["app"];
    assert_eq!(app["withGlobalTauri"], false);
    let sec = &app["security"];
    assert_eq!(
        sec["csp"],
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src ipc: http://ipc.localhost; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'"
    );
    assert_eq!(sec["freezePrototype"], true);
    assert_eq!(sec["assetProtocol"]["enable"], false);
    assert_eq!(sec["dangerousDisableAssetCspModification"], serde_json::json!(["style-src"]));
    assert!(sec.get("devCsp").is_none());
    let windows = app["windows"].as_array().unwrap();
    let main = windows.iter().find(|w| w["label"] == "main").unwrap();
    let quick = windows.iter().find(|w| w["label"] == "quick").unwrap();
    assert_eq!((main["width"].as_u64(), main["height"].as_u64(), main["minWidth"].as_u64(), main["minHeight"].as_u64()), (Some(1100), Some(720), Some(900), Some(600)));
    assert_eq!((quick["width"].as_u64(), quick["height"].as_u64()), (Some(400), Some(560)));
    for (k, want) in [("decorations", false), ("shadow", true), ("skipTaskbar", true), ("alwaysOnTop", true), ("resizable", false), ("visible", false)] {
        assert_eq!(quick[k], want, "quick.{k}");
    }
    assert_eq!(main["visible"], false);
}
