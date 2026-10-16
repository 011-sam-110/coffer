//! Debug builds only: `COFFER_SELFTEST=1` drives the running app through its
//! Windows paths and a vault round trip, writes the results to the log, then
//! quits through the same function as `app_quit`. `COFFER_SELFTEST=vault`
//! runs only the vault part. It overwrites and then empties the clipboard.
//! Run it with `COFFER_DATA_DIR` set to an empty folder: the vault goes there.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};
use zeroize::Zeroizing;

use crate::contract::LockReason;
use crate::shell::{self, QuickOrigin};
use crate::state::{AppState, LockExt};

pub fn maybe_start(app: &AppHandle) {
    if std::env::var_os("COFFER_SELFTEST").is_none() {
        return;
    }
    let app = app.clone();
    let _ = std::thread::Builder::new().name("coffer-selftest".into()).spawn(move || run(&app));
}

fn quick_report(app: &AppHandle, what: &str) {
    let Some(w) = app.get_webview_window(shell::QUICK) else { return };
    let outer = w.outer_position().map(|p| (p.x, p.y)).ok();
    let outer_size = w.outer_size().map(|s| (s.width, s.height)).ok();
    let inner = w.inner_position().map(|p| (p.x, p.y)).ok();
    let inner_size = w.inner_size().map(|s| (s.width, s.height)).ok();
    crate::log!(
        "selftest: quick {what}: visible={:?} focused={:?} outer={outer:?} {outer_size:?} client={inner:?} {inner_size:?}",
        w.is_visible().ok(),
        w.is_focused().ok()
    );
}

fn quick_visible(app: &AppHandle) -> Option<bool> {
    app.get_webview_window(shell::QUICK).and_then(|w| w.is_visible().ok())
}

/// Press and release Ctrl+Shift+Space with SendInput (the registered hotkey
/// takes it; no other app sees it).
fn press_quick_hotkey() -> u32 {
    use windows::Win32::UI::Input::KeyboardAndMouse::{INPUT, INPUT_0, INPUT_KEYBOARD, KEYBD_EVENT_FLAGS, KEYBDINPUT, KEYEVENTF_KEYUP, SendInput, VIRTUAL_KEY, VK_CONTROL, VK_SHIFT, VK_SPACE};
    let key = |vk: VIRTUAL_KEY, up: bool| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: vk, wScan: 0, dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) }, time: 0, dwExtraInfo: 0 } },
    };
    let inputs = [key(VK_CONTROL, false), key(VK_SHIFT, false), key(VK_SPACE, false), key(VK_SPACE, true), key(VK_SHIFT, true), key(VK_CONTROL, true)];
    unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) }
}

fn run(app: &AppHandle) {
    std::thread::sleep(Duration::from_secs(4));
    crate::log!("selftest: start");
    if std::env::var("COFFER_SELFTEST").as_deref() != Ok("vault") {
        windows_checks(app);
    }
    vault_round_trip(app);
    crate::lock::lock(app, LockReason::Manual);
    std::thread::sleep(Duration::from_millis(300));
    crate::log!("selftest: done; quitting through app_quit's path");
    shell::quit(app);
}

fn windows_checks(app: &AppHandle) {
    let state = app.state::<AppState>();
    quick_report(app, "hidden at start (frame refreshed at creation)");

    let fg = state.foreground.lck().clone();
    crate::log!("selftest: foreground stored={} process={:?}", fg.is_some(), fg.as_ref().and_then(|f| f.process.clone()));
    crate::log!("selftest: hotkeys {:?}", *state.hotkeys.lck());

    match crate::clipboard::copy(app, Zeroizing::new("coffer-selftest-value".to_string()), "Selftest") {
        Ok(r) => crate::log!("selftest: copy ok, clearsInSeconds={:?}", r.clears_in_seconds),
        Err(e) => crate::log!("selftest: copy failed: {e}"),
    }
    crate::log!("selftest: formats after copy [text, excludeMonitor, historyFlag, cloudFlag] = {:?}", crate::win::clipboard::formats_present());
    let cleared = crate::clipboard::clear_if_ours(app);
    crate::log!("selftest: clear_if_ours={cleared}; formats now {:?}", crate::win::clipboard::formats_present());

    shell::show_quick(app, QuickOrigin::Hotkey);
    std::thread::sleep(Duration::from_millis(1500));
    quick_report(app, "after hotkey show (centred)");
    shell::hide_quick(app);
    std::thread::sleep(Duration::from_millis(300));

    let work = crate::win::monitor::from_point(0, 0).map(|a| a.work);
    if let Some(w) = work {
        crate::log!("selftest: primary work area {w:?}");
        shell::show_quick(app, QuickOrigin::Tray(Some((w.right - 40, w.bottom + 20))));
        std::thread::sleep(Duration::from_millis(1500));
        quick_report(app, "after tray show (bottom-right)");
        shell::hide_quick(app);
    }

    // The real hotkey path: RegisterHotKey -> plugin -> toggle_quick.
    let ok = matches!(*state.hotkeys.lck(), crate::contract::HotkeyStatus { quick: crate::contract::HotkeyState::Ok, .. });
    if ok {
        std::thread::sleep(Duration::from_millis(500));
        let sent = press_quick_hotkey();
        std::thread::sleep(Duration::from_millis(1500));
        crate::log!("selftest: hotkey press sent={sent}; quick visible={:?}", quick_visible(app));
        quick_report(app, "after the hotkey");
        let sent = press_quick_hotkey();
        std::thread::sleep(Duration::from_millis(1000));
        crate::log!("selftest: hotkey press again sent={sent}; quick visible={:?} (expect false: toggled off)", quick_visible(app));
        shell::hide_quick(app);
    }
}

// ---------- the vault round trip ----------

#[derive(Default)]
struct Checks {
    total: u32,
    failed: u32,
}

impl Checks {
    fn check(&mut self, what: &str, ok: bool, detail: impl std::fmt::Display) {
        self.total += 1;
        if !ok {
            self.failed += 1;
        }
        crate::log!("selftest vault: {} {what} [{detail}]", if ok { "OK  " } else { "FAIL" });
    }
}

fn wait_until(timeout: Duration, mut done: impl FnMut() -> bool) -> bool {
    let end = Instant::now() + timeout;
    while Instant::now() < end {
        if done() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    done()
}

fn login(title: &str, user: &str, password: &str) -> coffer_core::model::ItemInput {
    serde_json::from_value(serde_json::json!({
        "type": "login",
        "title": title,
        "fields": [
            {"label": "Username", "kind": "text", "value": user, "builtin": "username"},
            {"label": "Password", "kind": "concealed", "value": password, "builtin": "password"}
        ],
        "urls": [{"url": "https://example.com/login"}]
    }))
    .expect("a login ItemInput")
}

fn disk_generation(path: &Path) -> Option<u64> {
    let bytes = std::fs::read(path).ok()?;
    coffer_core::vault_file::read_header(&bytes).ok().map(|h| h.generation)
}

/// Items not in Trash.
fn item_count(app: &AppHandle) -> Option<u32> {
    crate::vault::with_vault(app, |v| Ok(v.items_list())).ok().map(|l| l.iter().filter(|i| i.state != coffer_core::model::ItemState::Trashed).count() as u32)
}

fn titles(app: &AppHandle) -> Vec<String> {
    crate::vault::with_vault(app, |v| Ok(v.items_list()))
        .map(|l| l.into_iter().filter(|i| i.state != coffer_core::model::ItemState::Trashed).map(|i| i.title).collect())
        .unwrap_or_default()
}

fn code_of<T>(r: &crate::error::CofferResult<T>) -> String {
    match r {
        Ok(_) => "ok".into(),
        Err(e) => format!("{:?}: {}", e.code, e.message),
    }
}

/// Another PC: open the file on disk, change it, write it back in place
/// (as a sync tool would).
fn other_pc_save(path: &Path, password: &str, key: &coffer_core::SecretKey, title: &str) -> Result<(), String> {
    use coffer_core::session::UnlockOutcome;
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let seen = coffer_core::vault_file::read_header(&bytes).map_err(|e| e.to_string())?.generation;
    let mut v = match coffer_core::Vault::unlock(&bytes, password, key, seen) {
        Ok(UnlockOutcome::Ready(v)) => v,
        Ok(UnlockOutcome::Older(_)) => return Err("older".into()),
        Err(e) => return Err(e.to_string()),
    };
    v.item_save(&login(title, "other@example.com", "Other-PC-pass-41"), None).map_err(|e| e.to_string())?;
    let out = v.to_bytes(seen);
    std::fs::write(path, out).map_err(|e| e.to_string())
}

fn vault_round_trip(app: &AppHandle) {
    use crate::contract::{events, ExportKind, VaultState};
    use crate::error::ErrorCode;
    use tauri::Listener;

    const PW: &str = "Selftest!Vault#2026-Plum-Orbit-77";
    const PW2: &str = "Second!Selftest#Kiwi-Lantern-58";
    let wait = Duration::from_secs(8);

    let mut c = Checks::default();
    let state = app.state::<AppState>();
    let got: Arc<Mutex<Vec<&'static str>>> = Arc::default();
    for name in [
        events::VAULT_UNLOCKED,
        events::VAULT_LOCKED,
        events::VAULT_RELOADED,
        events::VAULT_CONFLICT,
        events::VAULT_DISK_DAMAGED,
        events::VAULT_OLDER_ON_DISK,
        events::VAULT_MISSING,
    ] {
        let got = got.clone();
        app.listen_any(name, move |_| got.lock().unwrap().push(name));
    }
    let count = |name: &str| got.lock().unwrap().iter().filter(|n| **n == name).count();
    crate::log!("selftest vault: start");

    let before = crate::vault::status(app);
    c.check("status before create is noVault", matches!(&before, Ok(s) if s.state == VaultState::NoVault), code_of(&before));

    // Create in the data folder, never in the user's home folder.
    let folder = state.data_dir.join("vaults");
    let _ = std::fs::create_dir_all(&folder);
    *state.picked_folder.lck() = Some(folder.clone());
    let t = Instant::now();
    let kit = match crate::vault::create(app, "Selftest: Vault?", PW, true) {
        Ok(k) => k,
        Err(e) => {
            c.check("create", false, format!("{:?}: {}", e.code, e.message));
            crate::log!("selftest vault: {} checks, {} failed", c.total, c.failed);
            return;
        }
    };
    let path = PathBuf::from(&kit.vault_path);
    c.check(
        "create writes <stem>.coffer and unlocks",
        path.exists() && path.file_name().map(|n| n == "Selftest_ Vault_.coffer").unwrap_or(false) && state.is_unlocked() && count(events::VAULT_UNLOCKED) == 1,
        format!("{} ms, {}", t.elapsed().as_millis(), path.display()),
    );
    let again = crate::vault::create(app, "Selftest: Vault?", PW, true);
    c.check("create never overwrites a vault file", matches!(&again, Err(e) if e.code == ErrorCode::Exists), code_of(&again));
    c.check("the kit has a Secret Key (value not logged)", kit.secret_key.len() > 20 && !kit.key_id.is_empty(), format!("keyId {}", kit.key_id));
    let first_bytes = std::fs::read(&path).unwrap_or_default();
    let gen1 = disk_generation(&path);
    let backups = crate::vault::backups_list(app).map(|l| l.len()).unwrap_or(0);
    c.check("a backup after create", backups == 1, format!("generation {gen1:?}, backups {backups}"));
    let key = coffer_core::SecretKey::parse(kit.secret_key.as_str()).expect("the kit key parses");

    // Save an item.
    let added = crate::vault::mutate(app, |v| v.item_save(&login("Example", "sam@example.com", "Selftest-pass-one-1"), None));
    let gen2 = disk_generation(&path);
    c.check("item_save saves the file", added.is_ok() && gen2 > gen1, format!("{} generation {gen1:?} -> {gen2:?}", code_of(&added)));

    // Lock and unlock with the key stored on this PC.
    crate::lock::lock(app, LockReason::Manual);
    let locked = crate::vault::status(app);
    c.check(
        "lock -> locked, key stored on this PC",
        matches!(&locked, Ok(s) if s.state == VaultState::Locked && !s.needs_secret_key) && !state.is_unlocked() && count(events::VAULT_LOCKED) >= 1,
        code_of(&locked),
    );
    let wrong = crate::vault::unlock(app, "not the password", None);
    c.check("a wrong password -> badCredentials, still locked", matches!(&wrong, Err(e) if e.code == ErrorCode::BadCredentials) && !state.is_unlocked(), code_of(&wrong));
    let t = Instant::now();
    let unlocked = crate::vault::unlock(app, PW, None);
    c.check("unlock with the master password", unlocked.is_ok() && item_count(app) == Some(1), format!("{} in {} ms, items {:?}", code_of(&unlocked), t.elapsed().as_millis(), item_count(app)));

    // Another PC saves the file: Coffer reloads it.
    let wrote = other_pc_save(&path, PW, &key, "From the other PC");
    let reloaded = wait_until(wait, || count(events::VAULT_RELOADED) >= 1);
    c.check("an outside save reloads (vault://reloaded)", wrote.is_ok() && reloaded && item_count(app) == Some(2), format!("{wrote:?}, items {:?}", item_count(app)));

    // An unsaved change here plus an outside save: a conflict copy.
    let local = crate::vault::with_vault(app, |v| v.item_save(&login("Unsaved here", "here@example.com", "Selftest-pass-two-2"), None));
    let dirty = crate::vault::with_session(app, |s| Ok(s.vault.is_dirty())).unwrap_or(false);
    let wrote = other_pc_save(&path, PW, &key, "Second from the other PC");
    let conflicted = wait_until(wait, || count(events::VAULT_CONFLICT) >= 1);
    let conflict_path = state.last_conflict.lck().clone();
    c.check(
        "unsaved change + outside save -> conflict copy (vault://conflict)",
        local.is_ok() && dirty && wrote.is_ok() && conflicted && conflict_path.as_ref().is_some_and(|p| p.exists()),
        format!("{:?}", conflict_path.as_ref().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().into_owned())),
    );
    let now_titles = titles(app);
    c.check("after the conflict the open vault is the disk's", now_titles.len() == 3 && !now_titles.iter().any(|t| t == "Unsaved here"), format!("{now_titles:?}"));

    // "Import my changes": the conflict copy, with the master password.
    let first = crate::vault::import_preview(app, conflict_path.clone().unwrap_or_default(), false, None, None);
    c.check("import the conflict copy: asks for its password only", matches!(&first, Ok(p) if p.needs_password && !p.needs_secret_key), code_of(&first));
    let (last, picked) = crate::vault::import_last(app).unwrap_or_default();
    let preview = crate::vault::import_preview(app, last, picked, Some(PW), None);
    let committed = match &preview {
        Ok(p) => crate::vault::import_commit(app, &p.preview_id),
        Err(e) => Err(e.clone()),
    };
    c.check(
        "import my changes: 1 new item, 2 duplicates skipped",
        matches!(&preview, Ok(p) if p.total == 1 && p.duplicates == 2) && matches!(&committed, Ok(r) if r.imported == 1) && titles(app).iter().any(|t| t == "Unsaved here"),
        format!("{} / {}", code_of(&preview), code_of(&committed)),
    );
    let deleted = match &preview {
        Ok(p) => crate::vault::import_delete_source(app, &p.preview_id),
        Err(e) => Err(e.clone()),
    };
    c.check("a conflict copy is never deleted as an import source", deleted.is_err() && conflict_path.as_ref().is_some_and(|p| p.exists()), code_of(&deleted));

    // A plain Bitwarden CSV: preview, import, undo, delete the file.
    let csv = state.data_dir.join("bitwarden_export.csv");
    let _ = std::fs::write(
        &csv,
        "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n,,login,Imported One,,,,https://one.example,user1,Csv-pass-One-111,\n,,login,Imported Two,,,,https://two.example,user2,Csv-pass-Two-222,\n",
    );
    let n0 = item_count(app).unwrap_or(0);
    let preview = crate::vault::import_preview(app, csv.clone(), true, None, None);
    let stale = crate::vault::import_commit(app, "not-a-preview-id");
    let committed = match &preview {
        Ok(p) => crate::vault::import_commit(app, &p.preview_id),
        Err(e) => Err(e.clone()),
    };
    let n1 = item_count(app).unwrap_or(0);
    c.check(
        "Bitwarden CSV import: 2 items, one save, tag Imported/Bitwarden",
        matches!(&preview, Ok(p) if p.format == "bitwarden-csv" && p.total == 2) && matches!(&committed, Ok(r) if r.imported == 2 && r.tag == "Imported/Bitwarden") && n1 == n0 + 2 && stale.is_err(),
        format!("{} / {} / items {n0} -> {n1} / stale id {}", code_of(&preview), code_of(&committed), code_of(&stale)),
    );
    let undone = match &committed {
        Ok(r) => crate::vault::import_undo(app, &r.batch_id),
        Err(e) => Err(e.clone()),
    };
    let status_count = crate::vault::status(app).ok().and_then(|s| s.item_count);
    c.check(
        "import_undo moves the batch to Trash (status counts active items)",
        matches!(undone, Ok(2)) && item_count(app) == Some(n0) && status_count == Some(n0),
        format!("{} items {:?}, status itemCount {status_count:?}", code_of(&undone), item_count(app)),
    );
    let deleted = match &preview {
        Ok(p) => crate::vault::import_delete_source(app, &p.preview_id),
        Err(e) => Err(e.clone()),
    };
    c.check("import_delete_source deletes the plain file", deleted.is_ok() && !csv.exists(), code_of(&deleted));

    // Export: the master password first; .cofferx needs a strong password; it imports back.
    let bad = crate::vault::export_bytes(app, ExportKind::CofferJson, "not the password", None);
    c.check("export asks for the master password", matches!(&bad, Err(e) if e.code == ErrorCode::BadCredentials), code_of(&bad));
    let weak = crate::vault::export_bytes(app, ExportKind::CofferEncrypted, PW, Some("abc"));
    c.check("a weak export password is refused", matches!(&weak, Err(e) if e.code == ErrorCode::WeakPassword), code_of(&weak));
    let mut kinds_ok = Vec::new();
    for kind in [ExportKind::CofferJson, ExportKind::BitwardenJson, ExportKind::Csv] {
        let out = crate::vault::export_bytes(app, kind, PW, None);
        kinds_ok.push(format!("{kind:?}={}", out.as_ref().map(|(b, n)| format!("{} bytes as {n}", b.len())).unwrap_or_else(|e| e.message.clone())));
    }
    c.check("plain exports build", kinds_ok.iter().all(|k| k.contains("bytes")), kinds_ok.join(", "));
    const EXPORT_PW: &str = "Export!Selftest#Maple-Quartz-93";
    let sealed = crate::vault::export_bytes(app, ExportKind::CofferEncrypted, PW, Some(EXPORT_PW));
    let file = state.data_dir.join("selftest-export.cofferx");
    let written = match &sealed {
        Ok((bytes, _)) => crate::vault::export_write(&file, bytes),
        Err(e) => Err(e.clone()),
    };
    let ask = crate::vault::import_preview(app, file.clone(), true, None, None);
    let back = crate::vault::import_preview(app, file.clone(), true, Some(EXPORT_PW), None);
    let n = item_count(app).unwrap_or(0) as usize;
    c.check(
        ".cofferx export imports back (all duplicates)",
        written.is_ok() && matches!(&ask, Ok(p) if p.needs_password) && matches!(&back, Ok(p) if p.format == "coffer-cofferx" && p.total == 0 && p.duplicates == n),
        format!("{} / {} / {} (items {n})", code_of(&written), code_of(&ask), code_of(&back)),
    );
    let deleted = match &back {
        Ok(p) => crate::vault::import_delete_source(app, &p.preview_id),
        Err(e) => Err(e.clone()),
    };
    c.check("import_delete_source deletes a picked .cofferx too", deleted.is_ok() && !file.exists(), code_of(&deleted));

    // A damaged file: saves pause until "save again".
    let count_before = item_count(app);
    let mut bytes = std::fs::read(&path).unwrap_or_default();
    if bytes.len() > 40 {
        let i = bytes.len() - 20;
        bytes[i] ^= 0x55;
    }
    let _ = std::fs::write(&path, &bytes);
    let damaged = wait_until(wait, || count(events::VAULT_DISK_DAMAGED) >= 1);
    let blocked = crate::vault::mutate(app, |v| v.item_save(&login("Blocked", "x@example.com", "Selftest-pass-three-3"), None));
    c.check("a damaged file pauses saves (vault://diskDamaged)", damaged && matches!(&blocked, Err(e) if e.code == ErrorCode::Conflict), code_of(&blocked));
    let again = crate::vault::save_again(app, None);
    let good = std::fs::read(&path).ok().map(|b| coffer_core::Vault::unlock(&b, PW, &key, 0).is_ok()).unwrap_or(false);
    c.check("vault_save_again writes a good file over it", again.is_ok() && good && item_count(app) == count_before, code_of(&again));

    // Our own write must not look like an outside change.
    let events_before = got.lock().unwrap().len();
    std::thread::sleep(Duration::from_millis(3000));
    let events_after = got.lock().unwrap().len();
    c.check("our own save raises no event", events_before == events_after, format!("{:?}", got.lock().unwrap()));

    // An older file on disk (a rollback): saves pause; restore the newest backup.
    let gen_now = disk_generation(&path);
    let _ = std::fs::write(&path, &first_bytes);
    let older = wait_until(wait, || count(events::VAULT_OLDER_ON_DISK) >= 1);
    let blocked = crate::vault::mutate(app, |v| v.item_save(&login("Blocked", "x@example.com", "Selftest-pass-three-3"), None));
    c.check("an older file pauses saves (vault://olderOnDisk)", older && blocked.is_err(), code_of(&blocked));
    let listed = crate::vault::backups_list(app).unwrap_or_default();
    let restored = crate::vault::backup_restore(app, 0, None);
    let unblocked = crate::vault::with_session(app, |s| Ok(s.block.is_none())).unwrap_or(false);
    c.check(
        "restoring the newest backup (unlocked) saves and unpauses",
        restored.is_ok() && unblocked && disk_generation(&path) > gen_now && item_count(app) == count_before,
        format!("{} of {} backups, disk generation {gen_now:?} -> {:?}, items {:?}", code_of(&restored), listed.len(), disk_generation(&path), item_count(app)),
    );

    // The file goes away: saves pause; "save again" writes it back.
    std::thread::sleep(Duration::from_millis(1500));
    let _ = std::fs::remove_file(&path);
    let missing = wait_until(wait, || count(events::VAULT_MISSING) >= 1);
    let blocked = crate::vault::mutate(app, |v| v.item_save(&login("Blocked", "x@example.com", "Selftest-pass-three-3"), None));
    let again = crate::vault::save_again(app, None);
    c.check("a missing file pauses saves; save again writes it back (vault://missing)", missing && blocked.is_err() && again.is_ok() && path.exists(), format!("blocked {}, again {}", code_of(&blocked), code_of(&again)));

    // The generator path of the tray's "Copy a new password".
    let generated = crate::vault::with_vault(app, |v| {
        let options = v.generator_options();
        v.generate(&options)
    });
    let history = match &generated {
        Ok(g) => crate::vault::mutate(app, |v| {
            v.generator_copied(&g.value);
            Ok(v.generator_history().len())
        }),
        Err(e) => Err(e.clone()),
    };
    c.check("generate + history (saved)", matches!(history, Ok(1)), code_of(&history));

    // Quick Access suggestions for a browser window on example.com (count only).
    let suggestions = crate::commands::suggestions(app, Some("Sign in - example.com - Google Chrome"), Some("chrome.exe"));
    crate::log!("selftest vault: info suggestions for example.com in Chrome: {}", suggestions.len());

    // Change the master password, then re-key back to the first one.
    let count_now = item_count(app);
    let changed = crate::vault::change_password(app, PW, PW2, false);
    crate::lock::lock(app, LockReason::Manual);
    let old_pw = crate::vault::unlock(app, PW, None);
    let new_pw = crate::vault::unlock(app, PW2, None);
    c.check("change password: the old one fails, the new one opens", changed.is_ok() && old_pw.is_err() && new_pw.is_ok(), format!("{} / {} / {}", code_of(&changed), code_of(&old_pw), code_of(&new_pw)));
    let rekeyed = crate::vault::change_password(app, PW2, PW, true);
    let backups = crate::vault::backups_list(app).map(|l| l.len()).unwrap_or(0);
    crate::lock::lock(app, LockReason::Manual);
    let reopened = crate::vault::unlock(app, PW, None);
    c.check(
        "re-key: old backups deleted, the vault opens",
        rekeyed.is_ok() && backups == 1 && reopened.is_ok() && item_count(app) == count_now,
        format!("{}, backups {backups}, {}", code_of(&rekeyed), code_of(&reopened)),
    );

    // Move the vault to another folder.
    let folder2 = state.data_dir.join("vaults-moved");
    let moved = crate::vault::move_to(app, folder2.clone());
    let new_path = folder2.join(path.file_name().unwrap_or_default());
    c.check("vault_move writes the new place and removes the old file", moved.is_ok() && new_path.exists() && !path.exists(), code_of(&moved));
    let n = item_count(app).unwrap_or(0);
    let saved_there = crate::vault::mutate(app, |v| v.item_save(&login("After the move", "m@example.com", "Selftest-pass-four-4"), None));
    c.check("saves go to the new place", saved_there.is_ok() && disk_generation(&new_path).is_some() && item_count(app) == Some(n + 1), code_of(&saved_there));

    // The kit needs the master password.
    let bad_kit = crate::vault::emergency_kit(app, "not the password");
    let kit2 = crate::vault::emergency_kit(app, PW);
    c.check(
        "emergency kit: wrong password refused, right one gives the same key",
        matches!(&bad_kit, Err(e) if e.message == "Wrong master password.") && kit2.as_ref().map(|k| k.key_id == kit.key_id && k.secret_key == kit.secret_key).unwrap_or(false),
        format!("{} / {}", code_of(&bad_kit), code_of(&kit2)),
    );

    // ---------- Windows Hello gating (SPEC 3.8) ----------
    // An unattended run cannot answer a Hello prompt: `unlock_hello_with`
    // gets a stand-in for it. Everything around the prompt is real.
    hello_checks(app, &mut c, PW, &key);

    // ---------- auto-type (SPEC 10) ----------
    autotype_checks(app, &mut c);

    // ---------- totp_from_image from the screen ----------
    qr_screen_checks(&mut c);

    std::thread::sleep(Duration::from_millis(2500));
    crate::log!("selftest vault: events {:?}", got.lock().unwrap());
    crate::log!("selftest vault: {} checks, {} failed", c.total, c.failed);
}

fn hello_checks(app: &AppHandle, c: &mut Checks, pw: &str, key: &coffer_core::SecretKey) {
    use crate::error::ErrorCode;
    let state = app.state::<AppState>();
    let status = || crate::vault::status(app).ok();
    let ready = || status().map(|s| s.hello_ready).unwrap_or(false);
    let verified = || -> crate::error::CofferResult<()> { Ok(()) };
    let cancelled = || -> crate::error::CofferResult<()> { Err(crate::error::CofferError::new(ErrorCode::HelloFailed, "Windows Hello was cancelled. Use your master password.")) };

    let st = status();
    let available = st.as_ref().is_some_and(|s| s.hello_available);
    c.check("hello: available on this PC, off by default", available && st.as_ref().is_some_and(|s| !s.hello_enabled && !s.hello_ready), format!("{st:?}"));

    let wrong = crate::hello::set(app, true, Some("not the password"));
    let none = crate::hello::set(app, true, None);
    c.check("hello_set(true) needs the master password", matches!(&wrong, Err(e) if e.code == ErrorCode::BadCredentials) && none.is_err(), format!("{} / {}", code_of(&wrong), code_of(&none)));
    let on = crate::hello::set(app, true, Some(pw));
    let saved = std::fs::read_to_string(state.settings_path()).unwrap_or_default().contains("\"helloEnabled\": true");
    c.check("hello_set(true) with the password: on and saved", matches!(&on, Ok(s) if s.hello_enabled) && saved, code_of(&on));

    let items = item_count(app);
    crate::lock::lock(app, LockReason::Manual);
    c.check("a manual lock keeps the key: helloReady", ready(), format!("{:?}", status()));
    let r = crate::vault::unlock_hello_with(app, cancelled);
    c.check("a cancelled prompt does not unlock and keeps the key", matches!(&r, Err(e) if e.code == ErrorCode::HelloFailed) && !state.is_unlocked() && ready(), code_of(&r));
    let r = crate::vault::unlock_hello_with(app, verified);
    c.check("Verified opens the vault with the held key", r.is_ok() && state.is_unlocked() && item_count(app) == items, format!("{} items {:?}", code_of(&r), item_count(app)));

    // keyChanged drops the key, and no prompt is shown then.
    crate::lock::lock(app, LockReason::KeyChanged);
    let mut asked = false;
    let r = crate::vault::unlock_hello_with(app, || {
        asked = true;
        Ok(())
    });
    c.check(
        "a keyChanged lock drops the key; no prompt",
        !ready() && matches!(&r, Err(e) if e.code == ErrorCode::HelloUnavailable && e.message == crate::hello::NOT_READY) && !asked,
        code_of(&r),
    );

    // Turning Hello off drops the key.
    let _ = crate::vault::unlock(app, pw, None);
    crate::lock::lock(app, LockReason::Manual);
    let was_ready = ready();
    let off = crate::hello::set(app, false, None);
    c.check("hello_set(false) drops the key", was_ready && off.is_ok() && !ready(), code_of(&off));

    // After requirePasswordDays without a password unlock, the key is not kept.
    let _ = crate::vault::unlock(app, pw, None);
    let _ = crate::hello::set(app, true, Some(pw));
    crate::hello::age_password_proof(&state, std::time::Duration::from_secs(15 * 24 * 3600));
    crate::lock::lock(app, LockReason::Idle);
    let r = crate::vault::unlock_hello_with(app, verified);
    c.check("after 14 days without the password: no key, the password is needed", !ready() && matches!(&r, Err(e) if e.code == ErrorCode::HelloUnavailable), code_of(&r));

    // A re-key on another PC: the held key no longer opens the file.
    let _ = crate::vault::unlock(app, pw, None);
    crate::lock::lock(app, LockReason::Manual);
    let path = status().and_then(|s| s.vault_path).map(PathBuf::from).unwrap_or_default();
    let rekeyed = (|| -> Result<(), String> {
        use coffer_core::session::UnlockOutcome;
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        let seen = coffer_core::vault_file::read_header(&bytes).map_err(|e| e.to_string())?.generation;
        let Ok(UnlockOutcome::Ready(mut v)) = coffer_core::Vault::unlock(&bytes, pw, key, seen) else { return Err("open".into()) };
        v.change_password(pw, pw, true, "Selftest").map_err(|e| e.to_string())?;
        std::fs::write(&path, v.to_bytes(seen)).map_err(|e| e.to_string())
    })();
    let was_ready = ready();
    let r = crate::vault::unlock_hello_with(app, verified);
    c.check(
        "a re-key elsewhere: Hello says the key changed and drops it",
        rekeyed.is_ok() && was_ready && matches!(&r, Err(e) if e.code == ErrorCode::HelloFailed) && !ready() && !state.is_unlocked(),
        format!("{rekeyed:?} / {}", code_of(&r)),
    );
    let r = crate::vault::unlock(app, pw, None);
    c.check("then the master password opens it", r.is_ok(), code_of(&r));

    // The real prompt, started and cancelled by the test. Only on request,
    // with a person at the PC: the dialog stays until someone presses Cancel.
    if std::env::var_os("COFFER_SELFTEST_HELLO_PROMPT").is_some() {
        let hwnd = app.get_webview_window(shell::MAIN).and_then(|w| w.hwnd().ok()).map(|h| h.0 as isize).unwrap_or(0);
        if let Some(w) = app.get_webview_window(shell::MAIN) {
            let _ = w.show();
            let _ = w.set_focus();
        }
        std::thread::sleep(Duration::from_millis(800));
        let outcome = crate::win::hello::prompt_then_cancel(hwnd, Duration::from_secs(3));
        crate::log!("selftest vault: info real Hello prompt: {outcome}");
    }
    let _ = crate::hello::set(app, false, None);
}

// ---------- auto-type against a window this test starts ----------

/// A WinForms window with one multi-line text box, in its own powershell.exe
/// (a real separate process; this test owns its PID and closes it).
const TARGET_SCRIPT: &str = "Add-Type -AssemblyName System.Windows.Forms; \
$f = New-Object System.Windows.Forms.Form; $f.Text = 'Coffer autotype target'; $f.Width = 520; $f.Height = 260; $f.TopMost = $true; $f.StartPosition = 'CenterScreen'; \
$t = New-Object System.Windows.Forms.TextBox; $t.Multiline = $true; $t.AcceptsTab = $true; $t.AcceptsReturn = $true; $t.Dock = 'Fill'; \
$f.Controls.Add($t); $f.Add_Shown({ $f.Activate(); [void]$t.Focus() }); [System.Windows.Forms.Application]::Run($f)";

fn find_target(pid: u32) -> Option<(isize, isize)> {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{EnumChildWindows, EnumWindows, GetClassNameW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible};
    struct Found {
        pid: u32,
        form: isize,
        edit: isize,
    }
    unsafe extern "system" fn top(h: HWND, l: LPARAM) -> BOOL {
        let f = unsafe { &mut *(l.0 as *mut Found) };
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(h, Some(&mut pid)) };
        let mut buf = [0u16; 128];
        let n = unsafe { GetWindowTextW(h, &mut buf) } as usize;
        if pid == f.pid && unsafe { IsWindowVisible(h) }.as_bool() && String::from_utf16_lossy(&buf[..n]) == "Coffer autotype target" {
            f.form = h.0 as isize;
            return BOOL(0);
        }
        BOOL(1)
    }
    unsafe extern "system" fn child(h: HWND, l: LPARAM) -> BOOL {
        let f = unsafe { &mut *(l.0 as *mut Found) };
        let mut buf = [0u16; 128];
        let n = unsafe { GetClassNameW(h, &mut buf) } as usize;
        if String::from_utf16_lossy(&buf[..n]).to_ascii_uppercase().contains(".EDIT.") {
            f.edit = h.0 as isize;
            return BOOL(0);
        }
        BOOL(1)
    }
    let mut found = Found { pid, form: 0, edit: 0 };
    unsafe {
        let _ = EnumWindows(Some(top), LPARAM(&mut found as *mut Found as isize));
        if found.form != 0 {
            let _ = EnumChildWindows(Some(HWND(found.form as *mut _)), Some(child), LPARAM(&mut found as *mut Found as isize));
        }
    }
    (found.form != 0 && found.edit != 0).then_some((found.form, found.edit))
}

fn window_text(h: isize) -> String {
    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{SendMessageW, WM_GETTEXT, WM_GETTEXTLENGTH};
    unsafe {
        let len = SendMessageW(HWND(h as *mut _), WM_GETTEXTLENGTH, None, None).0 as usize;
        let mut buf = vec![0u16; len + 1];
        let got = SendMessageW(HWND(h as *mut _), WM_GETTEXT, Some(WPARAM(buf.len())), Some(LPARAM(buf.as_mut_ptr() as isize))).0 as usize;
        String::from_utf16_lossy(&buf[..got.min(len)])
    }
}

fn set_window_text(h: isize, text: &str) {
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{SendMessageW, WM_SETTEXT};
    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe { SendMessageW(HWND(h as *mut _), WM_SETTEXT, None, Some(LPARAM(wide.as_ptr() as isize))) };
}

fn close_window(h: isize) {
    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{PostMessageW, WM_CLOSE};
    unsafe {
        let _ = PostMessageW(Some(HWND(h as *mut _)), WM_CLOSE, WPARAM(0), LPARAM(0));
    }
}

/// Click the middle of `edit` like a user (that input gives its window the
/// foreground). Only when `edit` is the window at that point.
fn click_into(edit: isize) -> bool {
    use windows::Win32::Foundation::{HWND, POINT, RECT};
    use windows::Win32::UI::Input::KeyboardAndMouse::{SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEINPUT};
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowRect, SetCursorPos, WindowFromPoint};
    unsafe {
        let mut r = RECT::default();
        if GetWindowRect(HWND(edit as *mut _), &mut r).is_err() {
            return false;
        }
        let p = POINT { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
        if WindowFromPoint(p).0 as isize != edit || SetCursorPos(p.x, p.y).is_err() {
            return false;
        }
        let click = |flags| INPUT { r#type: INPUT_MOUSE, Anonymous: INPUT_0 { mi: MOUSEINPUT { dx: 0, dy: 0, mouseData: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } } };
        SendInput(&[click(MOUSEEVENTF_LEFTDOWN), click(MOUSEEVENTF_LEFTUP)], std::mem::size_of::<INPUT>() as i32) == 2
    }
}

/// Make `hwnd` the window auto-type types into, as if the user had been in it.
#[allow(dead_code)]
fn set_target(app: &AppHandle, hwnd: isize) {
    *app.state::<AppState>().foreground.lck() = Some(crate::state::ForegroundInfo { hwnd, title: "Coffer autotype target".into(), process: Some("powershell.exe".into()) });
}

fn autotype_checks(app: &AppHandle, c: &mut Checks) {
    use crate::error::ErrorCode;
    let user = "type@example.com";
    let pass = "Typed-pass-Ünï-€-42";
    let item = crate::vault::mutate(app, |v| v.item_save(&login("Typed login", user, pass), None));
    let Ok(item) = item else {
        c.check("autotype: item for the test", false, code_of(&item));
        return;
    };
    let custom: coffer_core::model::ItemInput = serde_json::from_value(serde_json::json!({
        "type": "login",
        "title": "Typed custom",
        "fields": [
            {"label": "Username", "kind": "text", "value": user, "builtin": "username"},
            {"label": "Password", "kind": "concealed", "value": pass, "builtin": "password"},
            {"label": "Door code", "kind": "text", "value": "4711"}
        ],
        "autotypeSequence": "{USERNAME}{TAB}{DELAY 150}{FIELD:door code}:x{ENTER}"
    }))
    .expect("custom item");
    let custom = crate::vault::mutate(app, |v| v.item_save(&custom, None));

    let mut child = match std::process::Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", TARGET_SCRIPT]).spawn() {
        Ok(ch) => ch,
        Err(e) => {
            c.check("autotype: start the target window", false, e);
            return;
        }
    };
    let pid = child.id();
    let found = wait_until(Duration::from_secs(20), || find_target(pid).is_some());
    let Some((form, edit)) = found.then(|| find_target(pid)).flatten() else {
        c.check("autotype: the target window opened", false, format!("pid {pid}"));
        let _ = child.kill();
        return;
    };
    crate::log!("selftest vault: info autotype target pid {pid}");
    let level = crate::win::autotype::integrity_of(pid);
    c.check("autotype: the target runs at our level (not elevated)", level.is_some() && !crate::win::autotype::runs_higher(pid), format!("{level:?} vs ours {:?}", crate::win::autotype::own_integrity()));

    // Quick Access opens from the real hotkey (that input lets Coffer move
    // the foreground), as in use; the user had been in the target window.
    let hotkey_ok = matches!(*app.state::<AppState>().hotkeys.lck(), crate::contract::HotkeyStatus { quick: crate::contract::HotkeyState::Ok, .. });
    let mut run = |id: &str, label: &str, expect: String| {
        set_window_text(edit, "");
        // The user clicks into the target, then presses the hotkey: the
        // foreground tracker stores the target, as in use.
        let clicked = click_into(edit);
        std::thread::sleep(Duration::from_millis(400));
        if hotkey_ok {
            press_quick_hotkey();
            std::thread::sleep(Duration::from_millis(900));
        }
        let stored = app.state::<AppState>().foreground.lck().as_ref().map(|f| f.hwnd);
        crate::log!("selftest vault: info clicked={clicked}; stored target is the form: {}", stored == Some(form));
        let fg_before = crate::win::autotype::foreground();
        let r = crate::autotype::run(app, id, None);
        std::thread::sleep(Duration::from_millis(400));
        let text = window_text(edit);
        match &r {
            Err(e) if e.message.contains("could not bring that window to the front") => {
                crate::log!("selftest vault: NOT RUN {label}: Windows did not let Coffer bring the target to the front (foreground was {fg_before:#x})");
            }
            _ => c.check(label, r.is_ok() && text == expect, format!("{}; typed {} chars, expected {}", code_of(&r), text.chars().count(), expect.chars().count())),
        }
        if r.is_ok() && text != expect {
            crate::log!("selftest vault: info typed text matches={}", text == expect);
        }
    };
    run(&item.id, "autotype: default sequence typed into the window (WM_GETTEXT)", format!("{user}\t{pass}\r\n"));
    if let Ok(custom) = &custom {
        run(&custom.id, "autotype: custom sequence with DELAY, FIELD and text", format!("{user}\t4711:x\r\n"));
    }

    // Close the target without saving anything, then type at nothing.
    set_window_text(edit, "");
    close_window(form);
    let closed = wait_until(Duration::from_secs(5), || matches!(child.try_wait(), Ok(Some(_))));
    if !closed {
        let _ = child.kill();
        let _ = child.wait();
    }
    c.check("autotype: target closed (own PID only)", closed, format!("pid {pid}"));
    set_target(app, form);
    let gone = crate::autotype::run(app, &item.id, None);
    c.check("autotype: a closed target is refused", matches!(&gone, Err(e) if e.code == ErrorCode::Invalid && e.message.contains("gone")), code_of(&gone));
    crate::shell::hide_quick(app);
}

// ---------- totp_from_image, screen source ----------

/// Shows `png` in a topmost WinForms window titled "Coffer QR target".
fn qr_window_script(png: &std::path::Path) -> String {
    format!(
        "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; \
$f = New-Object System.Windows.Forms.Form; $f.Text = 'Coffer QR target'; $f.TopMost = $true; $f.Width = 420; $f.Height = 460; $f.BackColor = 'White'; \
$p = New-Object System.Windows.Forms.PictureBox; $p.Dock = 'Fill'; $p.SizeMode = 'CenterImage'; $p.Image = [System.Drawing.Image]::FromFile('{}'); \
$f.Controls.Add($p); [System.Windows.Forms.Application]::Run($f)",
        png.display()
    )
}

fn find_titled(pid: u32, title: &str) -> Option<isize> {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible};
    struct Find<'a> {
        pid: u32,
        title: &'a str,
        hwnd: isize,
    }
    unsafe extern "system" fn each(h: HWND, l: LPARAM) -> BOOL {
        let f = unsafe { &mut *(l.0 as *mut Find) };
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(h, Some(&mut pid)) };
        let mut buf = [0u16; 128];
        let n = unsafe { GetWindowTextW(h, &mut buf) } as usize;
        if pid == f.pid && unsafe { IsWindowVisible(h) }.as_bool() && String::from_utf16_lossy(&buf[..n]) == f.title {
            f.hwnd = h.0 as isize;
            return BOOL(0);
        }
        BOOL(1)
    }
    let mut find = Find { pid, title, hwnd: 0 };
    unsafe {
        let _ = EnumWindows(Some(each), LPARAM(&mut find as *mut Find as isize));
    }
    (find.hwnd != 0).then_some(find.hwnd)
}

fn qr_screen_checks(c: &mut Checks) {
    let png = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join("totp-qr.png");
    let mut child = match std::process::Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", &qr_window_script(&png)]).spawn() {
        Ok(ch) => ch,
        Err(e) => {
            c.check("totp screen: start the QR window", false, e);
            return;
        }
    };
    let pid = child.id();
    let shown = wait_until(Duration::from_secs(20), || find_titled(pid, "Coffer QR target").is_some());
    std::thread::sleep(Duration::from_millis(800));
    let read = crate::totp_image::from_screen();
    let expected = "otpauth://totp/Example:sam@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example";
    c.check(
        "totp_from_image(screen): reads a QR code shown by another app",
        shown && matches!(&read, Ok(uri) if uri.as_str() == expected),
        match &read {
            Ok(uri) => format!("read {} chars, matches={}", uri.len(), uri.as_str() == expected),
            Err(e) => format!("{:?}: {}", e.code, e.message),
        },
    );
    if let Some(h) = find_titled(pid, "Coffer QR target") {
        close_window(h);
    }
    let closed = wait_until(Duration::from_secs(5), || matches!(child.try_wait(), Ok(Some(_))));
    if !closed {
        let _ = child.kill();
        let _ = child.wait();
    }
    let none = {
        std::thread::sleep(Duration::from_millis(500));
        crate::totp_image::from_screen()
    };
    c.check(
        "totp_from_image(screen): no QR code -> notFound",
        matches!(&none, Err(e) if e.code == crate::error::ErrorCode::NotFound),
        match &none {
            Ok(_) => "found one".to_string(),
            Err(e) => format!("{:?}", e.code),
        },
    );
}
