//! The IPC commands of `src/lib/contract.ts`.
//!
//! Every command is `async`, so it never runs on the main thread (which runs
//! the tray and the windows). Work that can block (Argon2, vault file I/O, a
//! dialog, the session lock while a save runs) goes into `spawn_blocking`
//! (SPEC 9, "Threads"). Secret arguments are `Zeroizing<String>`.

use std::collections::HashMap;
use std::path::PathBuf;

use tauri::{AppHandle, Emitter, Manager, State, Window};
use zeroize::Zeroizing;

use crate::contract::*;
use crate::error::{CofferError, CofferResult, ErrorCode};
use crate::settings::Settings;
use crate::shell;
use crate::state::{AppState, EditState, LockExt, RwExt};
use crate::vault;

type Secret = Zeroizing<String>;

/// Run blocking work off the async pool.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> CofferResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| CofferError::io(format!("Coffer could not finish that: {e}")))
}



fn pw(p: &Option<Secret>) -> Option<&str> {
    p.as_deref().map(String::as_str)
}

fn changed(app: &AppHandle, ids: Vec<String>) {
    let _ = app.emit(events::VAULT_CHANGED, VaultChangedEvent { ids });
}

/// The app a use from Quick Access links to (SPEC 9): the window that was in
/// front, never a browser. Uses from the main window link to nothing.
fn link_app(app: &AppHandle, window: &Window) -> Option<String> {
    if window.label() != shell::QUICK {
        return None;
    }
    let process = app.state::<AppState>().foreground.lck().as_ref()?.process.clone()?;
    (!coffer_core::suggest::is_browser(&process)).then_some(process)
}

/// A use (copy, reveal, auto-type, open site) for lastUsedAt and suggestions.
fn record_use(app: &AppHandle, item_id: &str, link: Option<String>) {
    if let Err(e) = crate::usage::usage_record(app, item_id, link.as_deref()) {
        crate::log!("usage: {e}");
    }
}

/// The label `clipboard://copied` shows for a field ref.
fn copy_label(app: &AppHandle, item_id: &str, field: &str) -> String {
    if field.starts_with("history:") {
        return "Previous password".to_string();
    }
    vault::with_vault(app, |v| v.item_get(item_id))
        .ok()
        .and_then(|view| view.fields.into_iter().find(|f| f.id == field || f.builtin.as_deref() == Some(field)).map(|f| f.label))
        .unwrap_or_else(|| "Value".to_string())
}

fn main_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window(shell::MAIN)
}

// ---------- app ----------

#[tauri::command]
pub async fn app_info(app: AppHandle, state: State<'_, AppState>) -> CofferResult<AppInfo> {
    Ok(AppInfo {
        version: app.package_info().version.to_string(),
        computer_name: crate::paths::computer_name(),
        default_folder: crate::paths::default_vault_folder().to_string_lossy().into_owned(),
        hotkey_status: *state.hotkeys.lck(),
        hello_available: crate::hello::available(&state),
        demo: false,
    })
}

#[tauri::command]
pub async fn folder_info() -> CofferResult<FolderInfo> {
    blocking(|| crate::folders::folder_info(&crate::paths::default_vault_folder(), &crate::folders::SyncRoots::from_env())).await
}

/// Rust opens the folder dialog and keeps the pick for `vault_create`.
#[tauri::command]
pub async fn folder_pick(app: AppHandle) -> CofferResult<Option<FolderInfo>> {
    let parent = main_window(&app);
    let picked: Option<PathBuf> = blocking(move || {
        let mut dialog = rfd::FileDialog::new().set_title("Choose a folder for your vault").set_directory(crate::paths::home_dir());
        if let Some(window) = parent.as_ref() {
            dialog = dialog.set_parent(window);
        }
        dialog.pick_folder()
    })
    .await?;
    let Some(folder) = picked else { return Ok(None) };
    *app.state::<AppState>().picked_folder.lck() = Some(folder.clone());
    let info = blocking(move || crate::folders::folder_info(&folder, &crate::folders::SyncRoots::from_env())).await?;
    Ok(Some(info))
}

// ---------- vault ----------

#[tauri::command]
pub async fn vault_status(app: AppHandle) -> CofferResult<VaultStatus> {
    blocking(move || vault::status(&app)).await?
}

#[tauri::command]
pub async fn vault_create(app: AppHandle, name: String, password: Secret, use_picked_folder: bool) -> CofferResult<EmergencyKit> {
    blocking(move || vault::create(&app, &name, &password, use_picked_folder)).await?
}

#[tauri::command]
pub async fn secret_key_rotate(app: AppHandle, password: Secret) -> CofferResult<EmergencyKit> {
    blocking(move || vault::rotate_secret_key(&app, &password)).await?
}

/// Rust opens the file dialog; `null` when cancelled.
#[tauri::command]
pub async fn vault_open(app: AppHandle) -> CofferResult<Option<VaultStatus>> {
    let parent = main_window(&app);
    blocking(move || {
        let mut dialog = rfd::FileDialog::new().set_title("Open a Coffer vault").add_filter("Coffer vault", &["coffer"]).set_directory(crate::paths::default_vault_folder());
        if let Some(window) = parent.as_ref() {
            dialog = dialog.set_parent(window);
        }
        match dialog.pick_file() {
            Some(path) => vault::open_file(&app, path).map(Some),
            None => Ok(None),
        }
    })
    .await?
}

#[tauri::command]
pub async fn vault_unlock(app: AppHandle, password: Secret, secret_key: Option<Secret>) -> CofferResult<VaultStatus> {
    blocking(move || vault::unlock(&app, &password, pw(&secret_key))).await?
}

/// The Hello prompt shows over the window that asked (main or Quick Access).
#[tauri::command]
pub async fn vault_unlock_hello(app: AppHandle, window: Window) -> CofferResult<VaultStatus> {
    let hwnd = window.hwnd().map(|h| h.0 as isize).map_err(|e| CofferError::new(ErrorCode::HelloUnavailable, format!("Windows Hello could not start: {e}")))?;
    blocking(move || vault::unlock_hello(&app, hwnd)).await?
}

#[tauri::command]
pub async fn vault_lock(app: AppHandle) -> CofferResult<()> {
    blocking(move || crate::lock::lock(&app, LockReason::Manual)).await
}

#[tauri::command]
pub async fn vault_change_password(app: AppHandle, current: Secret, next: Secret, rekey: bool) -> CofferResult<()> {
    blocking(move || vault::change_password(&app, &current, &next, rekey)).await?
}

/// Rust opens the folder dialog; `null` when cancelled.
#[tauri::command]
pub async fn vault_move(app: AppHandle) -> CofferResult<Option<VaultStatus>> {
    let parent = main_window(&app);
    blocking(move || {
        let mut dialog = rfd::FileDialog::new().set_title("Move your vault to");
        if let Some(window) = parent.as_ref() {
            dialog = dialog.set_parent(window);
        }
        match dialog.pick_folder() {
            Some(folder) => vault::move_to(&app, folder).map(Some),
            None => Ok(None),
        }
    })
    .await?
}

/// After the file vanished, or after diskDamaged / olderOnDisk.
#[tauri::command]
pub async fn vault_save_again(app: AppHandle, save_as: bool) -> CofferResult<Option<VaultStatus>> {
    let parent = main_window(&app);
    blocking(move || {
        if !save_as {
            return vault::save_again(&app, None).map(Some);
        }
        let name = app.state::<AppState>().session.lck().as_ref().and_then(|s| s.path.file_name().map(|n| n.to_string_lossy().into_owned())).unwrap_or_else(|| "Vault.coffer".into());
        let mut dialog = rfd::FileDialog::new().set_title("Save your vault as").add_filter("Coffer vault", &["coffer"]).set_file_name(name);
        if let Some(window) = parent.as_ref() {
            dialog = dialog.set_parent(window);
        }
        match dialog.save_file() {
            Some(path) => vault::save_again(&app, Some(path)).map(Some),
            None => Ok(None),
        }
    })
    .await?
}

#[tauri::command]
pub async fn vault_open_older(app: AppHandle) -> CofferResult<VaultStatus> {
    blocking(move || vault::open_older(&app)).await?
}

/// Turning Hello on needs the master password; off drops the held key.
#[tauri::command]
pub async fn hello_set(app: AppHandle, enabled: bool, password: Option<Secret>) -> CofferResult<VaultStatus> {
    blocking(move || crate::hello::set(&app, enabled, pw(&password))).await?
}

#[tauri::command]
pub async fn secret_key_validate(secret_key: Secret) -> CofferResult<SecretKeyCheck> {
    Ok(match coffer_core::SecretKey::parse(&secret_key) {
        Ok(key) => SecretKeyCheck { valid: true, key_id: Some(key.key_id().to_string()) },
        Err(_) => SecretKeyCheck { valid: false, key_id: None },
    })
}

#[tauri::command]
pub async fn emergency_kit(app: AppHandle, password: Secret) -> CofferResult<EmergencyKit> {
    blocking(move || vault::emergency_kit(&app, &password)).await?
}

#[tauri::command]
pub async fn kdf_benchmark() -> CofferResult<KdfBenchmark> {
    blocking(vault::kdf_benchmark).await?
}

// ---------- items ----------

#[tauri::command]
pub async fn items_list(app: AppHandle) -> CofferResult<Vec<ItemSummary>> {
    blocking(move || {
        let mut items = vault::with_vault(&app, |v| Ok(v.items_list()))?;
        let usage = app.state::<AppState>().usage.lck().last_used_map();
        for item in &mut items {
            item.last_used_at = usage.get(&item.id).cloned();
        }
        Ok(items)
    })
    .await?
}

#[tauri::command]
pub async fn item_get(app: AppHandle, id: String) -> CofferResult<ItemView> {
    blocking(move || vault::with_vault(&app, |v| v.item_get(&id))).await?
}

#[tauri::command]
pub async fn item_reveal(app: AppHandle, id: String, field: String, password: Option<Secret>) -> CofferResult<Secret> {
    blocking(move || {
        let value = vault::with_vault(&app, |v| v.item_reveal(&id, &field, pw(&password)))?;
        record_use(&app, &id, None);
        Ok(value)
    })
    .await?
}

/// The value goes from Rust to the clipboard; the UI never sees it.
#[tauri::command]
pub async fn item_copy(app: AppHandle, window: Window, id: String, field: String, password: Option<Secret>) -> CofferResult<CopyResult> {
    let link = link_app(&app, &window);
    blocking(move || {
        let value = vault::with_vault(&app, |v| v.item_copy_value(&id, &field, pw(&password)))?;
        let label = copy_label(&app, &id, &field);
        let result = crate::clipboard::copy(&app, value, &label)?;
        record_use(&app, &id, link);
        Ok(result)
    })
    .await?
}

#[tauri::command]
pub async fn item_save(app: AppHandle, item: ItemInput, password: Option<Secret>) -> CofferResult<ItemView> {
    blocking(move || {
        let view = vault::mutate(&app, |v| v.item_save(&item, pw(&password)))?;
        changed(&app, vec![view.id.clone()]);
        Ok(view)
    })
    .await?
}

#[tauri::command]
pub async fn item_patch(app: AppHandle, id: String, favorite: Option<bool>, tags: Option<Vec<String>>, health_excluded: Option<bool>) -> CofferResult<ItemSummary> {
    blocking(move || {
        let summary = vault::mutate(&app, |v| v.item_patch(&id, favorite, tags.as_deref(), health_excluded))?;
        changed(&app, vec![id]);
        Ok(summary)
    })
    .await?
}

#[tauri::command]
pub async fn item_set_state(app: AppHandle, id: String, state: ItemState) -> CofferResult<()> {
    blocking(move || {
        vault::mutate(&app, |v| v.item_set_state(&id, state))?;
        changed(&app, vec![id]);
        Ok(())
    })
    .await?
}

#[tauri::command]
pub async fn items_bulk(app: AppHandle, ids: Vec<String>, action: BulkAction, tag: Option<String>) -> CofferResult<u32> {
    blocking(move || {
        let n = vault::mutate(&app, |v| v.items_bulk(&ids, action, tag.as_deref()))?;
        changed(&app, ids);
        Ok(n as u32)
    })
    .await?
}

#[tauri::command]
pub async fn item_delete_forever(app: AppHandle, id: String) -> CofferResult<()> {
    blocking(move || {
        vault::mutate(&app, |v| v.item_delete_forever(&id))?;
        let _ = app.state::<AppState>().usage.lck().forget(std::slice::from_ref(&id));
        changed(&app, vec![id]);
        Ok(())
    })
    .await?
}

#[tauri::command]
pub async fn trash_empty(app: AppHandle) -> CofferResult<u32> {
    blocking(move || {
        let n = vault::mutate(&app, |v| Ok(v.trash_empty()))?;
        changed(&app, Vec::new());
        Ok(n as u32)
    })
    .await?
}

#[tauri::command]
pub async fn item_revisions(app: AppHandle, id: String, password: Option<Secret>) -> CofferResult<Vec<Revision>> {
    blocking(move || vault::with_vault(&app, |v| v.item_revisions(&id, pw(&password)))).await?
}

#[tauri::command]
pub async fn item_restore_revision(app: AppHandle, id: String, rev: u64, password: Option<Secret>) -> CofferResult<ItemView> {
    blocking(move || {
        let view = vault::mutate(&app, |v| v.item_restore_revision(&id, rev, pw(&password)))?;
        changed(&app, vec![id]);
        Ok(view)
    })
    .await?
}

#[tauri::command]
pub async fn item_password_history(app: AppHandle, id: String, password: Option<Secret>) -> CofferResult<Vec<PasswordHistoryEntry>> {
    blocking(move || vault::with_vault(&app, |v| v.item_password_history(&id, pw(&password)))).await?
}

/// Rust opens only an http(s) URL stored in the item (SPEC 3.7).
#[tauri::command]
pub async fn item_open_url(app: AppHandle, id: String, url_index: u32) -> CofferResult<()> {
    blocking(move || {
        let url = vault::with_vault(&app, |v| v.item_url_for_open(&id, url_index as usize))?;
        crate::win::open::open_url(&url).map_err(CofferError::invalid)?;
        record_use(&app, &id, None);
        Ok(())
    })
    .await?
}

#[tauri::command]
pub async fn totp_code(app: AppHandle, id: String, field: Option<String>, password: Option<Secret>) -> CofferResult<TotpCode> {
    blocking(move || vault::with_vault(&app, |v| v.totp_code(&id, field.as_deref(), pw(&password)))).await?
}

#[tauri::command]
pub async fn totp_parse(input: Secret) -> CofferResult<TotpParse> {
    Ok(coffer_core::totp::totp_parse(&input))
}

/// A one-time-code setup QR code from an image file (Rust opens the
/// dialog) or from the screen (the calling window steps aside meanwhile).
#[tauri::command]
pub async fn totp_from_image(app: AppHandle, window: Window, source: TotpSource) -> CofferResult<Option<TotpImage>> {
    let label = window.label().to_string();
    blocking(move || {
        let caller = app.get_webview_window(&label);
        let uri = match source {
            TotpSource::File => {
                let mut dialog = rfd::FileDialog::new()
                    .set_title("Choose the QR code image")
                    .add_filter("Images", &["png", "jpg", "jpeg", "bmp"])
                    .set_directory(crate::paths::home_dir());
                if let Some(w) = caller.as_ref() {
                    dialog = dialog.set_parent(w);
                }
                let Some(path) = dialog.pick_file() else { return Ok(None) };
                crate::totp_image::from_file(&path)?
            }
            TotpSource::Screen => {
                if let Some(w) = caller.as_ref() {
                    let _ = w.hide();
                }
                std::thread::sleep(std::time::Duration::from_millis(300));
                let read = crate::totp_image::from_screen();
                if let Some(w) = caller.as_ref() {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
                read?
            }
        };
        Ok(Some(TotpImage { uri }))
    })
    .await?
}

#[tauri::command]
pub async fn ssh_generate() -> CofferResult<SshKeyPair> {
    blocking(crate::ssh::generate).await?
}

// ---------- generator ----------

/// Unlocked: the vault's generator (it keeps the last options). Locked: the
/// plain generator (nothing is kept).
#[tauri::command]
pub async fn generate(app: AppHandle, options: GeneratorOptions) -> CofferResult<Generated> {
    blocking(move || {
        if app.state::<AppState>().is_unlocked() {
            vault::with_vault(&app, |v| v.generate(&options))
        } else {
            coffer_core::generator::generate(&options).map_err(CofferError::from)
        }
    })
    .await?
}

/// The vault's last generator options (defaults when none); unlocked only.
#[tauri::command]
pub async fn generator_options(app: AppHandle) -> CofferResult<GeneratorOptions> {
    blocking(move || vault::with_vault(&app, |v| Ok(v.generator_options()))).await?
}

/// Copy a generated value; unlocked, it also goes into generator history.
#[tauri::command]
pub async fn generator_copy(app: AppHandle, value: Secret) -> CofferResult<CopyResult> {
    if value.is_empty() {
        return Err(CofferError::invalid("There is nothing to copy."));
    }
    blocking(move || {
        if app.state::<AppState>().is_unlocked() {
            if let Err(e) = vault::mutate(&app, |v| {
                v.generator_copied(&value);
                Ok(())
            }) {
                crate::log!("generator history: {e}");
            }
        }
        crate::clipboard::copy(&app, value, "Password")
    })
    .await?
}

#[tauri::command]
pub async fn generator_history(app: AppHandle) -> CofferResult<Vec<GeneratedHistoryEntry>> {
    blocking(move || vault::with_vault(&app, |v| Ok(v.generator_history()))).await?
}

#[tauri::command]
pub async fn generator_history_reveal(app: AppHandle, id: String) -> CofferResult<Secret> {
    blocking(move || vault::with_vault(&app, |v| v.generator_history_value(&id))).await?
}

#[tauri::command]
pub async fn generator_history_copy(app: AppHandle, id: String) -> CofferResult<CopyResult> {
    blocking(move || {
        let value = vault::with_vault(&app, |v| v.generator_history_value(&id))?;
        crate::clipboard::copy(&app, value, "Password")
    })
    .await?
}

#[tauri::command]
pub async fn generator_history_clear(app: AppHandle) -> CofferResult<()> {
    blocking(move || {
        vault::mutate(&app, |v| {
            v.generator_history_clear();
            Ok(())
        })
    })
    .await?
}

#[tauri::command]
pub async fn password_strength(password: Secret, user_inputs: Vec<String>) -> CofferResult<Strength> {
    blocking(move || {
        let inputs: Vec<&str> = user_inputs.iter().map(String::as_str).collect();
        coffer_core::strength::password_strength(&password, &inputs)
    })
    .await
}

// ---------- health ----------

#[tauri::command]
pub async fn health_report(app: AppHandle) -> CofferResult<HealthReport> {
    blocking(move || {
        let mode = app.state::<AppState>().settings.rd().settings.breach_check;
        vault::with_vault(&app, |v| Ok(v.health_report(mode)))
    })
    .await?
}

/// "Check now": the k-anonymity range calls (SPEC 3.10).
#[tauri::command]
pub async fn health_check_breaches(app: AppHandle) -> CofferResult<HealthReport> {
    // The setting is the consent to send hash prefixes (SPEC 3.10): Rust checks it too.
    if app.state::<AppState>().settings.rd().settings.breach_check == BreachMode::Off {
        return Err(CofferError::invalid("Breach checks are off. Turn them on in Settings > Security first."));
    }
    blocking(move || vault::breach_check(&app)).await?
}

// ---------- import / export (SPEC 8) ----------

#[tauri::command]
pub async fn import_preview(app: AppHandle, source: ImportSource, password: Option<Secret>, secret_key: Option<Secret>) -> CofferResult<Option<ImportPreview>> {
    let parent = main_window(&app);
    blocking(move || {
        let state = app.state::<AppState>();
        if !state.is_unlocked() {
            return Err(CofferError::locked());
        }
        let (file, picked) = match source {
            ImportSource::Pick => {
                let mut dialog = rfd::FileDialog::new()
                    .set_title("Import passwords")
                    .add_filter("Password exports", &["json", "csv", "zip", "1pux", "cofferx", "coffer"])
                    .add_filter("All files", &["*"])
                    .set_directory(crate::paths::home_dir());
                if let Some(window) = parent.as_ref() {
                    dialog = dialog.set_parent(window);
                }
                match dialog.pick_file() {
                    Some(path) => (path, true),
                    None => return Ok(None),
                }
            }
            ImportSource::Last => vault::import_last(&app).ok_or_else(|| CofferError::invalid("Choose the file again."))?,
            ImportSource::Conflict => {
                let path = state.last_conflict.lck().clone();
                (path.ok_or_else(|| CofferError::new(ErrorCode::NotFound, "Coffer has not written a conflict copy since it started."))?, false)
            }
        };
        vault::import_preview(&app, file, picked, pw(&password), pw(&secret_key)).map(Some)
    })
    .await?
}

#[tauri::command]
pub async fn import_commit(app: AppHandle, preview_id: String) -> CofferResult<ImportResult> {
    let result = blocking({
        let app = app.clone();
        move || vault::import_commit(&app, &preview_id)
    })
    .await??;
    changed(&app, Vec::new());
    Ok(result)
}

#[tauri::command]
pub async fn import_undo(app: AppHandle, batch_id: String) -> CofferResult<u32> {
    let n = blocking({
        let app = app.clone();
        move || vault::import_undo(&app, &batch_id)
    })
    .await??;
    changed(&app, Vec::new());
    Ok(n)
}

#[tauri::command]
pub async fn import_delete_source(app: AppHandle, preview_id: String) -> CofferResult<()> {
    blocking(move || vault::import_delete_source(&app, &preview_id)).await?
}

/// The master password first, then the export is built, then the save dialog.
#[tauri::command]
pub async fn export_vault(app: AppHandle, kind: ExportKind, master_password: Secret, export_password: Option<Secret>) -> CofferResult<Option<ExportResult>> {
    let parent = main_window(&app);
    blocking(move || {
        let (bytes, name) = vault::export_bytes(&app, kind, &master_password, pw(&export_password))?;
        let (label, ext): (&str, &[&str]) = match kind {
            ExportKind::CofferEncrypted => ("Coffer export (encrypted)", &["cofferx"]),
            ExportKind::CofferJson => ("Coffer JSON", &["json"]),
            ExportKind::BitwardenJson => ("Bitwarden JSON", &["json"]),
            ExportKind::Csv => ("CSV", &["csv"]),
        };
        let mut dialog = rfd::FileDialog::new().set_title("Export your vault").add_filter(label, ext).set_file_name(name).set_directory(crate::paths::home_dir());
        if let Some(window) = parent.as_ref() {
            dialog = dialog.set_parent(window);
        }
        let Some(path) = dialog.save_file() else { return Ok(None) };
        vault::export_write(&path, &bytes)?;
        Ok(Some(ExportResult { path: path.to_string_lossy().into_owned() }))
    })
    .await?
}

// ---------- backups ----------

#[tauri::command]
pub async fn backups_list(app: AppHandle) -> CofferResult<Vec<BackupEntry>> {
    blocking(move || vault::backups_list(&app)).await?
}

#[tauri::command]
/// `password`: the master password, needed when the restore would weaken
/// re-prompt on an item (`repromptRequired` without it).
pub async fn backup_restore(app: AppHandle, index: u32, password: Option<Secret>) -> CofferResult<VaultStatus> {
    blocking(move || vault::backup_restore(&app, index, pw(&password))).await?
}

// ---------- settings ----------

#[tauri::command]
pub async fn settings_get(state: State<'_, AppState>) -> CofferResult<Settings> {
    Ok(state.settings.rd().settings.clone())
}

/// Merge, validate, save, then apply what changed (hotkeys, capture
/// protection, start with Windows). Rejects `helloEnabled` (use `hello_set`).
#[tauri::command]
pub async fn settings_set(app: AppHandle, patch: serde_json::Value) -> CofferResult<Settings> {
    let state = app.state::<AppState>();
    let (before, file) = {
        let mut guard = state.settings.wr();
        let before = guard.settings.clone();
        let next = crate::settings::apply_patch(&before, &patch)?;
        let mut file = guard.clone();
        file.settings = next;
        crate::settings::save(&state.settings_path(), &file)?;
        *guard = file.clone();
        (before, file)
    };
    let after = file.settings.clone();
    if before.hotkey_quick != after.hotkey_quick || before.hotkey_lock != after.hotkey_lock {
        let app2 = app.clone();
        blocking(move || crate::hotkeys::apply(&app2)).await?;
    }
    if before.capture_protection != after.capture_protection {
        shell::apply_capture_protection(&app);
    }
    if patch.get("startWithWindows").is_some() {
        crate::autostart::apply(&app, after.start_with_windows);
    }
    Ok(after)
}

/// Quick Access counts one showing of its hint line.
#[tauri::command]
pub async fn quick_hint_seen(state: State<'_, AppState>) -> CofferResult<()> {
    let file = {
        let mut guard = state.settings.wr();
        guard.settings.quick_hints_shown = guard.settings.quick_hints_shown.saturating_add(1);
        guard.clone()
    };
    crate::settings::save(&state.settings_path(), &file)
}

/// The main window reports its open edit; `title: null` means none.
#[tauri::command]
pub async fn edit_state(state: State<'_, AppState>, title: Option<String>, dirty: bool) -> CofferResult<()> {
    *state.edit.lck() = title.map(|title| EditState { title, dirty });
    Ok(())
}

// ---------- windows ----------

#[tauri::command]
pub async fn quick_context(app: AppHandle) -> CofferResult<QuickContext> {
    blocking(move || shell::quick_context(&app)).await
}

#[tauri::command]
pub async fn quick_hide(app: AppHandle) -> CofferResult<()> {
    shell::hide_quick(&app);
    Ok(())
}

/// While `modal` is true, focus loss does not hide Quick Access.
#[tauri::command]
pub async fn quick_set_modal(state: State<'_, AppState>, modal: bool) -> CofferResult<()> {
    state.quick.lck().modal = modal;
    Ok(())
}

#[tauri::command]
pub async fn main_show(app: AppHandle, item_id: Option<String>, view: Option<MainView>) -> CofferResult<()> {
    shell::show_main(&app, Some(NavigateEvent { item_id, view }));
    Ok(())
}

/// The main window hides itself after the first-close notice.
#[tauri::command]
pub async fn main_hide(app: AppHandle) -> CofferResult<()> {
    shell::hide_main(&app);
    Ok(())
}

/// Ctrl+Enter in Quick Access (SPEC 10): type the item into the window that
/// was in front before Quick Access opened. `only: "password"` types the
/// password alone; callers without `only` get the sequence.
#[tauri::command]
pub async fn autotype(app: AppHandle, window: Window, id: String, password: Option<Secret>, only: Option<AutotypeOnly>) -> CofferResult<()> {
    let link = link_app(&app, &window);
    blocking(move || {
        crate::autotype::run(&app, &id, pw(&password), only)?;
        record_use(&app, &id, link);
        Ok(())
    })
    .await?
}

/// Lock (drops keys, clears Coffer's clipboard copy) and exit. The UI asks
/// about an unsaved edit before it calls this.
#[tauri::command]
pub async fn app_quit(app: AppHandle) -> CofferResult<()> {
    blocking(move || shell::quit(&app)).await
}

/// Suggestions for Quick Access (SPEC 9), without waiting: when a save or a
/// KDF run holds the vault, there are none this time.
pub fn suggestions(app: &AppHandle, title: Option<&str>, process: Option<&str>) -> Vec<String> {
    let state = app.state::<AppState>();
    let (learned, last_used): (Vec<String>, HashMap<String, String>) = {
        let usage = state.usage.lck();
        (process.map(|p| usage.items_for_app(p).into_iter().take(crate::usage::LINKS_PER_APP).collect()).unwrap_or_default(), usage.last_used_map())
    };
    match state.session.try_lock() {
        Ok(guard) => guard.as_ref().map(|s| s.vault.suggestions(title, process, &learned, &last_used)).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}
