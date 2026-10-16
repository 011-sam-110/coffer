//! The IPC commands of `src/lib/contract.ts`.
//!
//! Every command is `async`, so it runs on Tauri's worker pool and never on
//! the main thread (which runs the tray and the windows). Blocking work (a
//! dialog, Argon2, vault file I/O) goes into `spawn_blocking` (SPEC 9,
//! "Threads").
//!
//! Phase A implements the commands that need no vault. The vault commands are
//! registered with their final signatures and fail with `locked` until phase B
//! wires them to coffer-core. Secret arguments are `Zeroizing<String>`.
#![allow(unused_variables)]

use std::path::PathBuf;

use tauri::{AppHandle, Manager, State};
use zeroize::Zeroizing;

use crate::contract::*;
use crate::error::{CofferError, CofferResult};
use crate::settings::Settings;
use crate::shell;
use crate::state::{AppState, EditState, LockExt, RwExt};

type Secret = Zeroizing<String>;

fn not_yet<T>() -> CofferResult<T> {
    Err(CofferError::locked())
}

/// Run blocking work off the async pool.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> CofferResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| CofferError::io(format!("Coffer could not finish that: {e}")))
}

// ---------- app ----------

#[tauri::command]
pub async fn app_info(app: AppHandle, state: State<'_, AppState>) -> CofferResult<AppInfo> {
    Ok(AppInfo {
        version: app.package_info().version.to_string(),
        computer_name: crate::paths::computer_name(),
        default_folder: crate::paths::default_vault_folder().to_string_lossy().into_owned(),
        hotkey_status: *state.hotkeys.lck(),
        // Windows Hello is tier 2.
        hello_available: false,
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
    let parent = app.get_webview_window(shell::MAIN);
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

/// Phase A: from settings.json only (no vault core yet). `vaultName` while
/// locked is the file stem (SPEC 3.5).
#[tauri::command]
pub async fn vault_status(state: State<'_, AppState>) -> CofferResult<VaultStatus> {
    let (path, hello_enabled) = {
        let s = state.settings.rd();
        (s.vault_path.clone(), s.settings.hello_enabled)
    };
    let unlocked = state.is_unlocked();
    let (vault_state, name) = match &path {
        None => (VaultState::NoVault, None),
        Some(p) => {
            let stem = std::path::Path::new(p).file_stem().map(|s| s.to_string_lossy().into_owned());
            let exists = std::path::Path::new(p).is_file();
            (if unlocked { VaultState::Unlocked } else if exists { VaultState::Locked } else { VaultState::Missing }, stem)
        }
    };
    Ok(VaultStatus {
        state: vault_state,
        vault_path: path,
        vault_name: name,
        key_id: None,
        needs_secret_key: false,
        hello_available: false,
        hello_enabled,
        hello_ready: false,
        item_count: None,
    })
}

#[tauri::command]
pub async fn vault_create(name: String, password: Secret, use_picked_folder: bool) -> CofferResult<EmergencyKit> {
    not_yet()
}

#[tauri::command]
pub async fn secret_key_rotate(password: Secret) -> CofferResult<EmergencyKit> {
    not_yet()
}

#[tauri::command]
pub async fn vault_open() -> CofferResult<Option<VaultStatus>> {
    not_yet()
}

#[tauri::command]
pub async fn vault_unlock(password: Secret, secret_key: Option<Secret>) -> CofferResult<VaultStatus> {
    not_yet()
}

#[tauri::command]
pub async fn vault_unlock_hello() -> CofferResult<VaultStatus> {
    Err(CofferError::new(crate::error::ErrorCode::HelloUnavailable, "Windows Hello unlock is not in this version yet."))
}

/// Works in phase A: lock needs no vault core.
#[tauri::command]
pub async fn vault_lock(app: AppHandle) -> CofferResult<()> {
    crate::lock::lock(&app, LockReason::Manual);
    Ok(())
}

#[tauri::command]
pub async fn vault_change_password(current: Secret, next: Secret, rekey: bool) -> CofferResult<()> {
    not_yet()
}

#[tauri::command]
pub async fn vault_move() -> CofferResult<Option<VaultStatus>> {
    not_yet()
}

#[tauri::command]
pub async fn vault_save_again(save_as: bool) -> CofferResult<Option<VaultStatus>> {
    not_yet()
}

#[tauri::command]
pub async fn vault_open_older() -> CofferResult<VaultStatus> {
    not_yet()
}

#[tauri::command]
pub async fn hello_set(enabled: bool, password: Option<Secret>) -> CofferResult<VaultStatus> {
    Err(CofferError::new(crate::error::ErrorCode::HelloUnavailable, "Windows Hello unlock is not in this version yet."))
}

#[tauri::command]
pub async fn secret_key_validate(secret_key: Secret) -> CofferResult<SecretKeyCheck> {
    not_yet()
}

#[tauri::command]
pub async fn emergency_kit(password: Secret) -> CofferResult<EmergencyKit> {
    not_yet()
}

#[tauri::command]
pub async fn kdf_benchmark() -> CofferResult<KdfBenchmark> {
    not_yet()
}

// ---------- items ----------

#[tauri::command]
pub async fn items_list() -> CofferResult<Vec<ItemSummary>> {
    not_yet()
}

#[tauri::command]
pub async fn item_get(id: String) -> CofferResult<ItemView> {
    not_yet()
}

#[tauri::command]
pub async fn item_reveal(id: String, field: String, password: Option<Secret>) -> CofferResult<Secret> {
    not_yet()
}

#[tauri::command]
pub async fn item_copy(id: String, field: String, password: Option<Secret>) -> CofferResult<CopyResult> {
    not_yet()
}

#[tauri::command]
pub async fn item_save(item: ItemInput, password: Option<Secret>) -> CofferResult<ItemView> {
    not_yet()
}

#[tauri::command]
pub async fn item_patch(id: String, favorite: Option<bool>, tags: Option<Vec<String>>, health_excluded: Option<bool>) -> CofferResult<ItemSummary> {
    not_yet()
}

#[tauri::command]
pub async fn item_set_state(id: String, state: ItemState) -> CofferResult<()> {
    not_yet()
}

#[tauri::command]
pub async fn items_bulk(ids: Vec<String>, action: BulkAction, tag: Option<String>) -> CofferResult<u32> {
    not_yet()
}

#[tauri::command]
pub async fn item_delete_forever(id: String) -> CofferResult<()> {
    not_yet()
}

#[tauri::command]
pub async fn trash_empty() -> CofferResult<u32> {
    not_yet()
}

#[tauri::command]
pub async fn item_revisions(id: String, password: Option<Secret>) -> CofferResult<Vec<Revision>> {
    not_yet()
}

#[tauri::command]
pub async fn item_restore_revision(id: String, rev: u64, password: Option<Secret>) -> CofferResult<ItemView> {
    not_yet()
}

#[tauri::command]
pub async fn item_password_history(id: String, password: Option<Secret>) -> CofferResult<Vec<PasswordHistoryEntry>> {
    not_yet()
}

/// Phase B: look up `urls[url_index]` of the item, then `win::open::open_url`.
#[tauri::command]
pub async fn item_open_url(id: String, url_index: u32) -> CofferResult<()> {
    not_yet()
}

#[tauri::command]
pub async fn totp_code(id: String, field: Option<String>, password: Option<Secret>) -> CofferResult<TotpCode> {
    not_yet()
}

#[tauri::command]
pub async fn totp_parse(input: Secret) -> CofferResult<TotpParse> {
    not_yet()
}

#[tauri::command]
pub async fn totp_from_image(source: TotpSource) -> CofferResult<Option<TotpImage>> {
    not_yet()
}

#[tauri::command]
pub async fn ssh_generate() -> CofferResult<SshKeyPair> {
    not_yet()
}

// ---------- generator ----------

#[tauri::command]
pub async fn generate(options: GeneratorOptions) -> CofferResult<Generated> {
    not_yet()
}

/// Works in phase A: the clipboard path needs no vault. Phase B also adds the
/// value to generator history when the vault is unlocked (SPEC 5).
#[tauri::command]
pub async fn generator_copy(app: AppHandle, value: Secret) -> CofferResult<CopyResult> {
    if value.is_empty() {
        return Err(CofferError::invalid("There is nothing to copy."));
    }
    crate::clipboard::copy(&app, value, "Password")
}

#[tauri::command]
pub async fn generator_history() -> CofferResult<Vec<GeneratedHistoryEntry>> {
    not_yet()
}

#[tauri::command]
pub async fn generator_history_reveal(id: String) -> CofferResult<Secret> {
    not_yet()
}

#[tauri::command]
pub async fn generator_history_copy(id: String) -> CofferResult<CopyResult> {
    not_yet()
}

#[tauri::command]
pub async fn generator_history_clear() -> CofferResult<()> {
    not_yet()
}

#[tauri::command]
pub async fn password_strength(password: Secret, user_inputs: Vec<String>) -> CofferResult<PasswordStrength> {
    not_yet()
}

// ---------- health ----------

#[tauri::command]
pub async fn health_report() -> CofferResult<HealthReport> {
    not_yet()
}

#[tauri::command]
pub async fn health_check_breaches() -> CofferResult<HealthReport> {
    not_yet()
}

// ---------- import / export ----------

#[tauri::command]
pub async fn import_preview(source: ImportSource, password: Option<Secret>, secret_key: Option<Secret>) -> CofferResult<Option<ImportPreview>> {
    not_yet()
}

#[tauri::command]
pub async fn import_commit(preview_id: String) -> CofferResult<ImportResult> {
    not_yet()
}

#[tauri::command]
pub async fn import_undo(batch_id: String) -> CofferResult<u32> {
    not_yet()
}

#[tauri::command]
pub async fn import_delete_source(preview_id: String) -> CofferResult<()> {
    not_yet()
}

#[tauri::command]
pub async fn export_vault(kind: ExportKind, master_password: Secret, export_password: Option<Secret>) -> CofferResult<Option<ExportResult>> {
    not_yet()
}

#[tauri::command]
pub async fn backups_list() -> CofferResult<Vec<BackupEntry>> {
    not_yet()
}

#[tauri::command]
pub async fn backup_restore(index: u32) -> CofferResult<VaultStatus> {
    not_yet()
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

/// The main window reports its open edit (title, unsaved or not); `title:
/// null` means no edit is open.
#[tauri::command]
pub async fn edit_state(state: State<'_, AppState>, title: Option<String>, dirty: bool) -> CofferResult<()> {
    *state.edit.lck() = title.map(|title| EditState { title, dirty });
    Ok(())
}

// ---------- windows ----------

#[tauri::command]
pub async fn quick_context(app: AppHandle) -> CofferResult<QuickContext> {
    Ok(shell::quick_context(&app))
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

/// Shell addition: the main window hides itself after the first-close notice.
#[tauri::command]
pub async fn main_hide(app: AppHandle) -> CofferResult<()> {
    shell::hide_main(&app);
    Ok(())
}

#[tauri::command]
pub async fn autotype(id: String, password: Option<Secret>) -> CofferResult<()> {
    not_yet()
}

/// Lock (drops keys, clears Coffer's clipboard copy) and exit. The UI asks
/// about an unsaved edit before it calls this.
#[tauri::command]
pub async fn app_quit(app: AppHandle) -> CofferResult<()> {
    shell::quit(&app);
    Ok(())
}
