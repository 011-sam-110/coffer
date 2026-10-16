//! The open vault and its file (SPEC 3.2 to 3.5): status, create, unlock and
//! the older-file confirm, the save path with its pre-replace check, backups,
//! the external-change watcher, move, save again, restore, password change.
//!
//! All of this is blocking (Argon2, file I/O): call it from
//! `spawn_blocking`. The session mutex is held for the whole of an operation,
//! so a lock waits for a save in progress (SPEC 9).

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use coffer_core::session::{ExternalChange, OlderFile, UnlockOutcome};
use coffer_core::{CoreError, KdfParams, SecretKey, Vault};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use tauri::{AppHandle, Emitter, Manager};

use crate::contract::*;
use crate::error::{CofferError, CofferResult, ErrorCode};
use crate::state::{AppState, LockExt, RwExt};

/// Why saves are paused (SPEC 3.5). `vault_save_again` or an unlocked
/// `backup_restore` writes again on purpose.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SaveBlock {
    /// The MAC failed on disk (`vault://diskDamaged`).
    DiskDamaged,
    /// A rollback on disk (`vault://olderOnDisk`).
    OlderOnDisk,
    /// The file is gone (`vault://missing`).
    Missing,
}

/// The base of a deliberate overwrite: the disk file the user was shown.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiskBase {
    Sha256([u8; 32]),
    Absent,
}

/// The unlocked vault. Dropping it drops the keys (lock).
pub struct Session {
    pub vault: Vault,
    pub path: PathBuf,
    pub vault_id: String,
    pub block: Option<SaveBlock>,
    /// What the user was shown when saves were blocked.
    pub shown: Option<DiskBase>,
    /// When we last loaded the disk file (for "your changes since <time>").
    pub loaded_at: String,
}

/// A verified vault held 60 s for `vault_open_older`.
pub struct OlderHold {
    pub older: OlderFile,
    pub path: PathBuf,
    /// A Secret Key the user typed; stored on this PC if they confirm.
    pub typed_key: Option<SecretKey>,
}

impl From<CoreError> for CofferError {
    fn from(e: CoreError) -> Self {
        let code = serde_json::from_value(serde_json::Value::String(e.code().to_string())).unwrap_or(ErrorCode::Invalid);
        CofferError::new(code, e.to_string())
    }
}

/// A core error from the open vault. Its Secret Key is in memory, so
/// `badCredentials` there means the master password (re-prompt, kit, export).
fn unlocked_err(e: CoreError) -> CofferError {
    match e {
        CoreError::BadCredentials => CofferError::new(ErrorCode::BadCredentials, "Wrong master password."),
        other => other.into(),
    }
}

fn blocked(b: SaveBlock) -> CofferError {
    let why = match b {
        SaveBlock::DiskDamaged => "The vault file on disk is damaged or was changed outside Coffer.",
        SaveBlock::OlderOnDisk => "The vault file on disk is older than the last version this PC saw.",
        SaveBlock::Missing => "The vault file is gone.",
    };
    CofferError::new(ErrorCode::Conflict, format!("{why} Saving is paused until you save it again or restore a backup."))
}

fn io_err(what: &str, e: impl std::fmt::Display) -> CofferError {
    crate::log!("vault io: {what}: {e}");
    CofferError::io(format!("Coffer could not {what}."))
}

// ---------- names and files ----------

/// The file stem for a vault name (SPEC 3.5): the core's rule
/// (`vault_file::stem_from_name`) on the trimmed name.
pub fn stem_for(name: &str) -> CofferResult<String> {
    Ok(coffer_core::vault_file::stem_from_name(name.trim())?)
}

fn stem_of(path: &Path) -> String {
    path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "Vault".to_string())
}

pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

/// What the file at `path` is now, as a deliberate-overwrite base.
pub fn disk_base(path: &Path) -> DiskBase {
    match std::fs::read(path) {
        Ok(bytes) => DiskBase::Sha256(sha256(&bytes)),
        Err(_) => DiskBase::Absent,
    }
}

/// What the file on disk must still be just before the replace.
enum Expect {
    /// No file there (create, conflict copy, move).
    New,
    /// The manifest MAC we last loaded or wrote.
    Mac(String),
    /// A deliberate overwrite of what the user was shown.
    Base(DiskBase),
    /// The user confirmed the overwrite in a save dialog, or a locked restore.
    Any,
}

#[derive(Debug)]
enum WriteError {
    /// The disk file is not what we expected: run the external-change rule.
    Changed,
    Exists,
    Io(String),
}

fn random_hex() -> String {
    coffer_core::crypto::random_array::<4>().iter().map(|b| format!("{b:02x}")).collect()
}

/// The atomic write of SPEC 3.5: a unique `<stem>.<random>.tmp`, `sync_all`,
/// re-read the disk file and compare, then `MoveFileExW` (retried up to 10
/// times over 2 s), then delete stale `.tmp` files of this vault.
fn write_vault_file(path: &Path, bytes: &[u8], expect: &Expect) -> Result<(), WriteError> {
    use std::io::Write;
    let dir = path.parent().ok_or_else(|| WriteError::Io("no folder".into()))?;
    std::fs::create_dir_all(dir).map_err(|e| WriteError::Io(e.to_string()))?;
    let stem = stem_of(path);
    let tmp = dir.join(format!("{stem}.{}.tmp", random_hex()));
    let written = (|| {
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(WriteError::Io(e.to_string()));
    }
    let still = match expect {
        Expect::Any => Ok(()),
        Expect::New | Expect::Base(DiskBase::Absent) => {
            if path.exists() {
                Err(if matches!(expect, Expect::New) { WriteError::Exists } else { WriteError::Changed })
            } else {
                Ok(())
            }
        }
        Expect::Mac(mac) => match std::fs::read(path) {
            Ok(disk) if coffer_core::vault_file::manifest_mac_of(&disk).ok().as_deref() == Some(mac.as_str()) => Ok(()),
            _ => Err(WriteError::Changed),
        },
        Expect::Base(DiskBase::Sha256(h)) => match std::fs::read(path) {
            Ok(disk) if sha256(&disk) == *h => Ok(()),
            _ => Err(WriteError::Changed),
        },
    };
    if let Err(e) = still {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    let replace = !matches!(expect, Expect::New | Expect::Base(DiskBase::Absent));
    let mut attempt = 0;
    loop {
        match crate::win::fs::move_file(&tmp, path, replace) {
            Ok(()) => break,
            Err(e) if attempt < 9 && crate::win::fs::is_transient(&e) => {
                attempt += 1;
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(e) => {
                let _ = std::fs::remove_file(&tmp);
                return Err(if e.kind() == std::io::ErrorKind::AlreadyExists {
                    if replace { WriteError::Io(e.to_string()) } else if matches!(expect, Expect::New) { WriteError::Exists } else { WriteError::Changed }
                } else {
                    WriteError::Io(e.to_string())
                });
            }
        }
    }
    // Stale temp files of this vault (from a crash): `<stem>.<8 hex>.tmp`.
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(mid) = name.strip_prefix(&format!("{stem}.")).and_then(|r| r.strip_suffix(".tmp")) {
                if mid.len() == 8 && mid.bytes().all(|b| b.is_ascii_hexdigit()) {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }
    Ok(())
}

fn write_error(e: WriteError, app: &AppHandle) -> CofferError {
    match e {
        WriteError::Changed => {
            app.state::<AppState>().watch.lck().force = true;
            CofferError::new(ErrorCode::Conflict, "The vault file changed on disk while Coffer saved. Coffer is checking it; your change is not saved yet.")
        }
        WriteError::Exists => CofferError::new(ErrorCode::Exists, "A file with that name already exists."),
        WriteError::Io(m) => io_err("save the vault file", m),
    }
}

// ---------- backups ----------

fn backups_dir(state: &AppState, vault_id: &str) -> PathBuf {
    state.data_dir.join("backups").join(vault_id)
}

/// Copy a vault file into the backups folder and apply the retention rule.
fn backup_bytes(state: &AppState, vault_id: &str, bytes: &[u8]) {
    let dir = backups_dir(state, vault_id);
    let now = coffer_core::time_util::now();
    let name = format!("{}.coffer", coffer_core::backups::file_time(now));
    if let Err(e) = crate::paths::write_atomic(&dir.join(name), bytes) {
        crate::log!("backup: could not write: {e}");
        return;
    }
    let files = list_backups(&dir);
    let times: Vec<_> = files.iter().map(|(_, t)| *t).collect();
    for ((path, _), keep) in files.iter().zip(coffer_core::backups::retain(&times, now)) {
        if !keep {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Backup files with their save times, newest first.
fn list_backups(dir: &Path) -> Vec<(PathBuf, OffsetDateTime)> {
    let mut out: Vec<(PathBuf, OffsetDateTime)> = std::fs::read_dir(dir)
        .map(|it| {
            it.flatten()
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().into_owned();
                    coffer_core::backups::parse_file_time(&name).map(|t| (e.path(), t))
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort_by(|a, b| b.1.cmp(&a.1));
    out
}

/// Delete the backups listed before a re-key (they open with the old vault
/// key), except a file the re-key's own save rewrote: a backup name has
/// whole seconds, so a save in the same second reuses the name.
fn delete_old_backups(paths: &[PathBuf], started: SystemTime) {
    for p in paths {
        let rewritten = std::fs::metadata(p).and_then(|m| m.modified()).is_ok_and(|t| t >= started);
        if !rewritten {
            let _ = std::fs::remove_file(p);
        }
    }
}

// ---------- device and settings ----------

/// The Secret Key stored on this PC for a vault, if any.
fn device_key(state: &AppState, vault_id: &str) -> CofferResult<Option<SecretKey>> {
    let Some(bytes) = state.device.lck().secret_key_get(vault_id)? else { return Ok(None) };
    let Ok(text) = std::str::from_utf8(&bytes) else { return Ok(None) };
    Ok(SecretKey::parse(text).ok())
}

fn store_device_key(state: &AppState, vault_id: &str, key: &SecretKey) -> CofferResult<()> {
    let text = key.to_text();
    state.device.lck().secret_key_put(vault_id, text.as_bytes())
}

fn highest_seen(state: &AppState, vault_id: &str) -> CofferResult<u64> {
    Ok(state.device.lck().generation_get(vault_id)?.unwrap_or(0))
}

fn observe(state: &AppState, vault_id: &str, generation: u64) {
    if let Err(e) = state.device.lck().generation_observe(vault_id, generation) {
        crate::log!("device: could not record the generation: {e}");
    }
}

/// Remember the vault this PC opens (settings.json: vaultPath, vaultId).
fn remember_vault(state: &AppState, path: &Path, vault_id: Option<&str>) -> CofferResult<()> {
    let file = {
        let mut s = state.settings.wr();
        s.vault_path = Some(path.to_string_lossy().into_owned());
        s.vault_id = vault_id.map(str::to_string);
        s.clone()
    };
    crate::settings::save(&state.settings_path(), &file)
}

fn vault_path(state: &AppState) -> Option<PathBuf> {
    state.settings.rd().vault_path.as_ref().map(PathBuf::from)
}

// ---------- status ----------

pub fn status(app: &AppHandle) -> CofferResult<VaultStatus> {
    let state = app.state::<AppState>();
    let hello_enabled = state.settings.rd().settings.hello_enabled;
    let mut st = VaultStatus {
        state: VaultState::NoVault,
        vault_path: None,
        vault_name: None,
        key_id: None,
        needs_secret_key: false,
        hello_available: crate::hello::available(&state),
        hello_enabled,
        hello_ready: false,
        item_count: None,
    };
    if let Some(s) = state.session.lck().as_ref() {
        st.state = VaultState::Unlocked;
        st.vault_path = Some(s.path.to_string_lossy().into_owned());
        st.vault_name = Some(stem_of(&s.path));
        st.key_id = Some(s.vault.key_id().to_string());
        st.item_count = Some(s.vault.active_item_count() as u32);
        return Ok(st);
    }
    let Some(path) = vault_path(&state) else { return Ok(st) };
    st.vault_path = Some(path.to_string_lossy().into_owned());
    st.vault_name = Some(stem_of(&path));
    match std::fs::read(&path) {
        Err(_) => st.state = VaultState::Missing,
        Ok(bytes) => {
            st.state = VaultState::Locked;
            if let Ok(h) = coffer_core::vault_file::read_header(&bytes) {
                let stored = device_key(&state, &h.vault_id)?;
                st.needs_secret_key = stored.is_none_or(|k| k.key_id() != h.key_id);
                st.hello_ready = !st.needs_secret_key && crate::hello::ready(&state, &h.vault_id, &h.key_id);
                st.key_id = Some(h.key_id);
            }
        }
    }
    Ok(st)
}

// ---------- session access ----------

/// Run `f` on the open session, or fail with `locked`.
pub fn with_session<T>(app: &AppHandle, f: impl FnOnce(&mut Session) -> CofferResult<T>) -> CofferResult<T> {
    let state = app.state::<AppState>();
    let mut guard = state.session.lck();
    let s = guard.as_mut().ok_or_else(CofferError::locked)?;
    f(s)
}

/// Run a read on the vault (it may start a re-prompt grant, hence `&mut`).
pub fn with_vault<T>(app: &AppHandle, f: impl FnOnce(&mut Vault) -> Result<T, CoreError>) -> CofferResult<T> {
    with_session(app, |s| f(&mut s.vault).map_err(unlocked_err))
}

/// Run a change on the vault, then save it if anything changed.
pub fn mutate<T>(app: &AppHandle, f: impl FnOnce(&mut Vault) -> Result<T, CoreError>) -> CofferResult<T> {
    with_session(app, |s| {
        if let Some(b) = s.block {
            return Err(blocked(b));
        }
        let out = f(&mut s.vault).map_err(unlocked_err)?;
        if s.vault.is_dirty() {
            save(app, s)?;
        }
        Ok(out)
    })
}

// ---------- save ----------

/// The save path (SPEC 3.5): `to_bytes` at max(disk, highest seen) + 1,
/// the pre-replace check against what we last loaded or wrote, the atomic
/// replace, `mark_saved`, the highest seen generation, a backup.
pub fn save(app: &AppHandle, s: &mut Session) -> CofferResult<()> {
    save_with(app, s, false)
}

/// `deliberate`: a write the user asked for after a block (`vault_save_again`,
/// an unlocked restore): the base is the disk file the user was shown.
fn save_with(app: &AppHandle, s: &mut Session, deliberate: bool) -> CofferResult<()> {
    if !deliberate {
        if let Some(b) = s.block {
            return Err(blocked(b));
        }
    }
    let state = app.state::<AppState>();
    let seen = highest_seen(&state, &s.vault_id)?;
    let bytes = s.vault.to_bytes(seen);
    let expect = match (&s.shown, s.vault.disk_mac()) {
        (Some(base), _) if deliberate => Expect::Base(base.clone()),
        (_, Some(mac)) => Expect::Mac(mac),
        (_, None) => Expect::New,
    };
    write_vault_file(&s.path, &bytes, &expect).map_err(|e| write_error(e, app))?;
    let generation = s.vault.mark_saved().unwrap_or(0);
    observe(&state, &s.vault_id, generation);
    s.block = None;
    s.shown = None;
    note_own_write(&state, &s.path);
    backup_bytes(&state, &s.vault_id, &bytes);
    Ok(())
}

// ---------- create ----------

pub fn create(app: &AppHandle, name: &str, password: &str, use_picked_folder: bool) -> CofferResult<EmergencyKit> {
    let state = app.state::<AppState>();
    let folder = if use_picked_folder {
        state.picked_folder.lck().clone().ok_or_else(|| CofferError::invalid("Choose a folder first."))?
    } else {
        crate::paths::default_vault_folder()
    };
    let stem = stem_for(name)?;
    let path = folder.join(format!("{stem}.coffer"));
    if path.exists() {
        return Err(CofferError::new(ErrorCode::Exists, format!("{} already exists. Coffer never overwrites a vault.", path.display())));
    }
    let key = SecretKey::generate();
    let mut vault = Vault::create(name.trim(), password, &key, KdfParams::DEFAULT)?;
    let vault_id = vault.vault_id();
    // Store the key first: a vault file whose key this PC lost would need a
    // kit the user has not seen yet.
    store_device_key(&state, &vault_id, &key)?;
    let bytes = vault.to_bytes(0);
    if let Err(e) = write_vault_file(&path, &bytes, &Expect::New) {
        let _ = state.device.lck().secret_key_remove(&vault_id);
        return Err(write_error(e, app));
    }
    let generation = vault.mark_saved().unwrap_or(1);
    observe(&state, &vault_id, generation);
    backup_bytes(&state, &vault_id, &bytes);
    if state.is_unlocked() {
        crate::lock::lock(app, LockReason::Manual);
    }
    remember_vault(&state, &path, Some(&vault_id))?;
    let kit = EmergencyKit {
        vault_name: stem,
        vault_path: path.to_string_lossy().into_owned(),
        vault_id,
        key_id: key.key_id().to_string(),
        secret_key: key.to_text(),
        created_at: vault.created_at().unwrap_or_else(crate::clock::now_iso),
        computer_name: crate::paths::computer_name(),
    };
    crate::hello::password_proven(&state);
    open_session(app, vault, path);
    crate::log!("vault: created (generation {generation})");
    Ok(kit)
}

/// Make `vault` the open session and tell everyone.
fn open_session(app: &AppHandle, vault: Vault, path: PathBuf) {
    let state = app.state::<AppState>();
    let vault_id = vault.vault_id();
    note_own_write(&state, &path);
    *state.session.lck() = Some(Session { vault, path, vault_id, block: None, shown: None, loaded_at: crate::clock::now_iso() });
    state.unlocked.store(true, std::sync::atomic::Ordering::SeqCst);
    crate::tray::refresh(app);
    if let Ok(st) = status(app) {
        let _ = app.emit(events::VAULT_UNLOCKED, st);
    }
}

// ---------- open and unlock ----------

/// `vault_open`: point this PC at an existing vault file (locked).
pub fn open_file(app: &AppHandle, path: PathBuf) -> CofferResult<VaultStatus> {
    let state = app.state::<AppState>();
    let bytes = std::fs::read(&path).map_err(|e| io_err("read that file", e))?;
    let header = coffer_core::vault_file::read_header(&bytes)?;
    if state.is_unlocked() {
        crate::lock::lock(app, LockReason::Manual);
    }
    remember_vault(&state, &path, Some(&header.vault_id))?;
    crate::log!("vault: opened a vault file (generation {})", header.generation);
    status(app)
}

pub fn unlock(app: &AppHandle, password: &str, typed_key: Option<&str>) -> CofferResult<VaultStatus> {
    let state = app.state::<AppState>();
    if state.is_unlocked() {
        return status(app);
    }
    let path = vault_path(&state).ok_or_else(|| CofferError::new(ErrorCode::VaultMissing, "There is no vault on this PC yet."))?;
    let bytes = std::fs::read(&path).map_err(|_| CofferError::new(ErrorCode::VaultMissing, format!("Coffer cannot find your vault at {}.", path.display())))?;
    let header = coffer_core::vault_file::read_header(&bytes)?;
    let (key, from_device) = match typed_key.map(str::trim).filter(|k| !k.is_empty()) {
        Some(text) => (SecretKey::parse(text)?, false),
        None => match device_key(&state, &header.vault_id)? {
            Some(k) if k.key_id() == header.key_id => (k, true),
            Some(_) => return Err(CofferError::new(ErrorCode::NeedsSecretKey, "This vault's Secret Key changed. Enter the new one from its Emergency Kit.")),
            None => return Err(CofferError::new(ErrorCode::NeedsSecretKey, "Enter the Secret Key from your Emergency Kit.")),
        },
    };
    let seen = highest_seen(&state, &header.vault_id)?;
    let typed = (!from_device).then(|| key.clone());
    let outcome = Vault::unlock(&bytes, password, &key, seen);
    if outcome.is_ok() {
        crate::hello::password_proven(&state);
    }
    match outcome {
        Ok(UnlockOutcome::Ready(vault)) => finish_unlock(app, vault, path, typed),
        Ok(UnlockOutcome::Older(older)) => {
            let err = older.error();
            *state.older.lck() = Some(OlderHold { older, path, typed_key: typed });
            Err(err.into())
        }
        Err(CoreError::BadCredentials) => Err(CofferError::new(
            ErrorCode::BadCredentials,
            if from_device { "Wrong master password." } else { "The master password or the Secret Key is wrong." },
        )),
        Err(e) => Err(e.into()),
    }
}

/// `vault_unlock_hello` (SPEC 3.8): the held vault key, after Windows Hello
/// says "Verified" over `hwnd` (the window that asked).
pub fn unlock_hello(app: &AppHandle, hwnd: isize) -> CofferResult<VaultStatus> {
    unlock_hello_with(app, || crate::hello::verify(hwnd))
}

/// `unlock_hello` with the prompt as a parameter (the self-test passes a
/// stand-in: an unattended run cannot answer a real Hello prompt).
pub fn unlock_hello_with(app: &AppHandle, verify: impl FnOnce() -> CofferResult<()>) -> CofferResult<VaultStatus> {
    let state = app.state::<AppState>();
    if state.is_unlocked() {
        return status(app);
    }
    let path = vault_path(&state).ok_or_else(|| CofferError::new(ErrorCode::VaultMissing, "There is no vault on this PC yet."))?;
    let bytes = std::fs::read(&path).map_err(|_| CofferError::new(ErrorCode::VaultMissing, format!("Coffer cannot find your vault at {}.", path.display())))?;
    let header = coffer_core::vault_file::read_header(&bytes)?;
    if !state.settings.rd().settings.hello_enabled {
        return Err(CofferError::new(ErrorCode::HelloUnavailable, "Windows Hello unlock is off. Turn it on in Settings > Security."));
    }
    // Fail before the prompt when no key is held (restart, keyChanged, days).
    drop(crate::hello::held_key(&state, &header.vault_id, &header.key_id)?);
    if !crate::hello::refresh_available(&state) {
        return Err(CofferError::new(ErrorCode::HelloUnavailable, "Windows Hello is not available now. Use your master password."));
    }
    let key = device_key(&state, &header.vault_id)?
        .filter(|k| k.key_id() == header.key_id)
        .ok_or_else(|| CofferError::new(ErrorCode::NeedsSecretKey, "Enter the Secret Key from your Emergency Kit."))?;
    verify()?;
    if state.is_unlocked() {
        // Unlocked with the password while the prompt was up.
        return status(app);
    }
    let vk = crate::hello::held_key(&state, &header.vault_id, &header.key_id)?;
    let seen = highest_seen(&state, &header.vault_id)?;
    match Vault::unlock_with_vault_key(&bytes, &vk, &key, seen) {
        Ok(UnlockOutcome::Ready(vault)) => {
            crate::log!("hello: unlocked");
            finish_unlock(app, vault, path, None)
        }
        Ok(UnlockOutcome::Older(older)) => {
            let err = older.error();
            *state.older.lck() = Some(OlderHold { older, path, typed_key: None });
            Err(err.into())
        }
        Err(CoreError::BadCredentials) => {
            // The file has another vault key now (a re-key here or on another PC).
            crate::hello::forget(&state);
            Err(CofferError::new(ErrorCode::HelloFailed, "The vault key changed, so Windows Hello cannot open it. Use your master password."))
        }
        Err(e) => Err(e.into()),
    }
}

/// Check the master password against the open vault (`hello_set`).
pub fn verify_master(app: &AppHandle, password: &str) -> CofferResult<()> {
    with_session(app, |s| s.vault.verify_password(password).map_err(unlocked_err))
}

/// `vault_open_older`: the user confirmed opening the older file.
pub fn open_older(app: &AppHandle) -> CofferResult<VaultStatus> {
    let state = app.state::<AppState>();
    let hold = state.older.lck().take().ok_or_else(|| CofferError::invalid("There is no older file waiting. Unlock again."))?;
    let vault = hold.older.accept()?;
    finish_unlock(app, vault, hold.path, hold.typed_key)
}

fn finish_unlock(app: &AppHandle, mut vault: Vault, path: PathBuf, typed_key: Option<SecretKey>) -> CofferResult<VaultStatus> {
    let state = app.state::<AppState>();
    let vault_id = vault.vault_id();
    if let Some(key) = typed_key {
        store_device_key(&state, &vault_id, &key)?;
    }
    observe(&state, &vault_id, vault.generation());
    if state.settings.rd().vault_id.as_deref() != Some(vault_id.as_str()) {
        remember_vault(&state, &path, Some(&vault_id))?;
    }
    let purged = vault.purge_expired_trash();
    // Nothing is held for Hello while the vault is open; the next lock takes the key again.
    crate::hello::forget(&state);
    open_session(app, vault, path);
    if purged > 0 {
        if let Err(e) = with_session(app, |s| save(app, s)) {
            crate::log!("vault: saving after the trash purge failed: {e}");
        }
    }
    crate::log!("vault: unlocked (purged {purged} from trash)");
    maybe_weekly_breach_check(app);
    status(app)
}

// ---------- the watcher ----------

/// (modified time, length) of the vault file, `None` when it is gone.
type Stamp = Option<(SystemTime, u64)>;

#[derive(Debug, Default)]
pub struct WatchState {
    seen: Option<Stamp>,
    pending: Option<Stamp>,
    /// Check now (a save found the file changed).
    pub force: bool,
}

fn stamp(path: &Path) -> Stamp {
    std::fs::metadata(path).ok().map(|m| (m.modified().unwrap_or(UNIX_EPOCH), m.len()))
}

fn note_own_write(state: &AppState, path: &Path) {
    let mut w = state.watch.lck();
    w.seen = Some(stamp(path));
    w.pending = None;
}

/// Poll the vault file every second while unlocked. A change must hold for
/// two polls (a sync tool writes in steps) before Coffer reads it.
pub fn start_watcher(app: &AppHandle) {
    let app = app.clone();
    let _ = std::thread::Builder::new().name("coffer-watch".into()).spawn(move || {
        loop {
            std::thread::sleep(Duration::from_secs(1));
            watch_tick(&app);
        }
    });
}

fn watch_tick(app: &AppHandle) {
    let state = app.state::<AppState>();
    let path = state.session.lck().as_ref().map(|s| s.path.clone());
    let Some(path) = path else {
        *state.watch.lck() = WatchState::default();
        return;
    };
    let now = stamp(&path);
    let run = {
        let mut w = state.watch.lck();
        if w.force {
            w.force = false;
            w.seen = Some(now);
            true
        } else if w.seen == Some(now) {
            w.pending = None;
            false
        } else if w.pending != Some(now) {
            w.pending = Some(now);
            false
        } else {
            w.seen = Some(now);
            w.pending = None;
            true
        }
    };
    if run {
        check_disk(app);
    }
}

/// Write our open state to `<stem> (conflict <time>).coffer` next to the vault.
fn write_conflict(state: &AppState, s: &mut Session) -> CofferResult<PathBuf> {
    let seen = highest_seen(state, &s.vault_id)?;
    let name = coffer_core::backups::conflict_file_name(&stem_of(&s.path), coffer_core::time_util::now());
    let path = s.path.with_file_name(name);
    let bytes = s.vault.conflict_bytes(seen);
    write_vault_file(&path, &bytes, &Expect::New).map_err(|e| io_err("write the conflict copy", format!("{e:?}")))?;
    *state.last_conflict.lck() = Some(path.clone());
    Ok(path)
}

/// The external-change rule (SPEC 3.5) for the file on disk now.
pub fn check_disk(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mut lock_after = false;
    {
        let mut guard = state.session.lck();
        let Some(s) = guard.as_mut() else { return };
        let bytes = match std::fs::read(&s.path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if s.block != Some(SaveBlock::Missing) {
                    s.block = Some(SaveBlock::Missing);
                    s.shown = Some(DiskBase::Absent);
                    crate::log!("watch: the vault file is gone");
                    let _ = app.emit(events::VAULT_MISSING, VaultMissingEvent { path: s.path.to_string_lossy().into_owned() });
                }
                return;
            }
            Err(e) => {
                crate::log!("watch: cannot read the vault file: {e}");
                return;
            }
        };
        let Ok(seen) = highest_seen(&state, &s.vault_id) else { return };
        let mut outcome = s.vault.check_external_change(&bytes, seen);
        // Unsaved changes would be lost by a plain reload: keep them in a conflict copy.
        if outcome == ExternalChange::Reload && s.vault.is_dirty() {
            outcome = ExternalChange::Conflict;
        }
        crate::log!("watch: disk change -> {outcome:?}");
        let since = s.loaded_at.clone();
        match outcome {
            ExternalChange::Unchanged => {
                if s.block == Some(SaveBlock::Missing) {
                    s.block = None;
                    s.shown = None;
                }
            }
            ExternalChange::Reload => match s.vault.reload(&bytes) {
                Ok(()) => {
                    observe(&state, &s.vault_id, s.vault.generation());
                    s.loaded_at = crate::clock::now_iso();
                    s.block = None;
                    s.shown = None;
                    let _ = app.emit(events::VAULT_RELOADED, Empty {});
                }
                Err(e) => crate::log!("watch: reload failed: {e}"),
            },
            ExternalChange::Conflict => match write_conflict(&state, s) {
                Ok(conflict) => match s.vault.reload(&bytes) {
                    Ok(()) => {
                        observe(&state, &s.vault_id, s.vault.generation());
                        s.loaded_at = crate::clock::now_iso();
                        s.block = None;
                        s.shown = None;
                        let _ = app.emit(events::VAULT_CONFLICT, VaultConflictEvent { conflict_path: conflict.to_string_lossy().into_owned(), since });
                    }
                    Err(e) => crate::log!("watch: reload after the conflict copy failed: {e}"),
                },
                Err(e) => crate::log!("watch: {e}"),
            },
            ExternalChange::HeaderChanged => {
                match write_conflict(&state, s) {
                    Ok(conflict) => {
                        let _ = app.emit(events::VAULT_CONFLICT, VaultConflictEvent { conflict_path: conflict.to_string_lossy().into_owned(), since });
                    }
                    Err(e) => crate::log!("watch: {e}"),
                }
                lock_after = true;
            }
            ExternalChange::OlderOnDisk => {
                s.block = Some(SaveBlock::OlderOnDisk);
                s.shown = Some(DiskBase::Sha256(sha256(&bytes)));
                let file_generation = coffer_core::vault_file::read_header(&bytes).map(|h| h.generation).unwrap_or(0);
                let _ = app.emit(events::VAULT_OLDER_ON_DISK, OlderOnDiskEvent { file_generation, seen_generation: seen.max(s.vault.generation()) });
            }
            ExternalChange::MacFailed => {
                s.block = Some(SaveBlock::DiskDamaged);
                s.shown = Some(DiskBase::Sha256(sha256(&bytes)));
                let _ = app.emit(events::VAULT_DISK_DAMAGED, DiskDamagedEvent { path: s.path.to_string_lossy().into_owned() });
            }
        }
    }
    if lock_after {
        crate::lock::lock(app, LockReason::KeyChanged);
    }
}

// ---------- save again, move ----------

/// `vault_save_again`. `None`: write the vault path again, with the disk
/// file the user was shown as the base. `Some(path)`: write there (the save
/// dialog already confirmed any overwrite).
pub fn save_again(app: &AppHandle, save_as: Option<PathBuf>) -> CofferResult<VaultStatus> {
    let state = app.state::<AppState>();
    with_session(app, |s| match save_as {
        None => {
            if s.shown.is_none() {
                s.shown = Some(disk_base(&s.path));
            }
            save_with(app, s, true)
        }
        Some(path) => {
            let seen = highest_seen(&state, &s.vault_id)?;
            let bytes = s.vault.to_bytes(seen);
            write_vault_file(&path, &bytes, &Expect::Any).map_err(|e| write_error(e, app))?;
            let generation = s.vault.mark_saved().unwrap_or(0);
            observe(&state, &s.vault_id, generation);
            s.path = path;
            s.block = None;
            s.shown = None;
            note_own_write(&state, &s.path);
            backup_bytes(&state, &s.vault_id, &bytes);
            remember_vault(&state, &s.path, Some(&s.vault_id))
        }
    })?;
    status(app)
}

/// `vault_move`: the vault file goes to `folder` (same name). Unlocked:
/// write the open state there; locked: copy the file. Then the old file goes.
pub fn move_to(app: &AppHandle, folder: PathBuf) -> CofferResult<VaultStatus> {
    let state = app.state::<AppState>();
    let old = vault_path(&state).ok_or_else(|| CofferError::new(ErrorCode::VaultMissing, "There is no vault on this PC yet."))?;
    let new = folder.join(old.file_name().unwrap_or_default());
    if new == old {
        return status(app);
    }
    if new.exists() {
        return Err(CofferError::new(ErrorCode::Exists, format!("{} already exists. Coffer never overwrites a vault.", new.display())));
    }
    if state.is_unlocked() {
        with_session(app, |s| {
            if let Some(b) = s.block {
                return Err(blocked(b));
            }
            let seen = highest_seen(&state, &s.vault_id)?;
            let bytes = s.vault.to_bytes(seen);
            write_vault_file(&new, &bytes, &Expect::New).map_err(|e| write_error(e, app))?;
            let generation = s.vault.mark_saved().unwrap_or(0);
            observe(&state, &s.vault_id, generation);
            s.path = new.clone();
            note_own_write(&state, &s.path);
            backup_bytes(&state, &s.vault_id, &bytes);
            Ok(())
        })?;
    } else {
        let bytes = std::fs::read(&old).map_err(|e| io_err("read the vault file", e))?;
        write_vault_file(&new, &bytes, &Expect::New).map_err(|e| write_error(e, app))?;
    }
    let vault_id = state.settings.rd().vault_id.clone();
    remember_vault(&state, &new, vault_id.as_deref())?;
    if let Err(e) = std::fs::remove_file(&old) {
        crate::log!("vault: the old file stays after the move: {e}");
    }
    crate::log!("vault: moved");
    status(app)
}

// ---------- backups ----------

fn current_vault_id(app: &AppHandle) -> Option<String> {
    let state = app.state::<AppState>();
    let open = state.session.lck().as_ref().map(|s| s.vault_id.clone());
    open.or_else(|| state.settings.rd().vault_id.clone())
}

/// Newest first. The listing is kept, so `backup_restore(index)` means the
/// entry the user saw.
pub fn backups_list(app: &AppHandle) -> CofferResult<Vec<BackupEntry>> {
    let state = app.state::<AppState>();
    let Some(vault_id) = current_vault_id(app) else { return Ok(Vec::new()) };
    let files = list_backups(&backups_dir(&state, &vault_id));
    let mut out = Vec::with_capacity(files.len());
    for (i, (path, t)) in files.iter().enumerate() {
        let (size, generation) = match std::fs::read(path) {
            Ok(bytes) => (bytes.len() as u64, coffer_core::vault_file::read_header(&bytes).map(|h| h.generation).unwrap_or(0)),
            Err(_) => (0, 0),
        };
        out.push(BackupEntry { index: i as u32, saved_at: coffer_core::time_util::fmt(*t).unwrap_or_default(), size, generation });
    }
    *state.backups_listed.lck() = files.into_iter().map(|(p, _)| p).collect();
    Ok(out)
}

/// Restore (SPEC 3.5). Unlocked: take the backup's records into the open
/// vault and save over the file the user was shown. Locked or missing: put
/// the backup file in place and take its generation as the highest seen.
/// `password`: the master password, when the restore would weaken re-prompt
/// on an item (the core answers `repromptRequired` without it).
pub fn backup_restore(app: &AppHandle, index: u32, password: Option<&str>) -> CofferResult<VaultStatus> {
    let state = app.state::<AppState>();
    let path = state.backups_listed.lck().get(index as usize).cloned().ok_or_else(|| CofferError::new(ErrorCode::NotFound, "List the backups again."))?;
    let bytes = std::fs::read(&path).map_err(|e| io_err("read that backup", e))?;
    let header = coffer_core::vault_file::read_header(&bytes)?;
    let vault_id = current_vault_id(app).ok_or_else(|| CofferError::invalid("There is no vault on this PC yet."))?;
    if header.vault_id != vault_id {
        return Err(CofferError::invalid("This backup is of another vault."));
    }
    let target = vault_path(&state).ok_or_else(|| CofferError::invalid("There is no vault on this PC yet."))?;
    if state.is_unlocked() {
        with_session(app, |s| {
            s.vault.restore_backup(&bytes, password).map_err(unlocked_err)?;
            if s.shown.is_none() && s.block.is_some() {
                s.shown = Some(disk_base(&s.path));
            }
            // The current file becomes a backup first.
            if let Ok(current) = std::fs::read(&s.path) {
                backup_bytes(&state, &vault_id, &current);
            }
            save_with(app, s, true)
        })?;
    } else {
        if let Ok(current) = std::fs::read(&target) {
            backup_bytes(&state, &vault_id, &current);
        }
        write_vault_file(&target, &bytes, &Expect::Any).map_err(|e| write_error(e, app))?;
        state.device.lck().generation_set(&vault_id, header.generation)?;
    }
    crate::log!("vault: restored a backup (generation {})", header.generation);
    status(app)
}

// ---------- password, key, kit ----------

/// A password change, re-key or key rotation is all or nothing. When its
/// save fails (the file changed on disk, or a write error), the open vault
/// goes back to the file on disk, opened again with the current password:
/// no conflict copy holds the changed keys, and the user is told plainly.
/// Returns the error to show and whether the vault must be locked (the
/// file could not be opened again).
fn undo_key_change(app: &AppHandle, s: &mut Session, password: &str, what: &str, e: CofferError) -> (CofferError, bool) {
    let state = app.state::<AppState>();
    let why = if e.code == ErrorCode::Conflict { "the vault file changed on another computer while Coffer saved" } else { "Coffer could not save the vault file" };
    let back = (|| -> CofferResult<Vault> {
        let bytes = std::fs::read(&s.path).map_err(|e| io_err("read the vault file", e))?;
        let key = device_key(&state, &s.vault_id)?.ok_or_else(|| CofferError::new(ErrorCode::NeedsSecretKey, "Enter the Secret Key from your Emergency Kit."))?;
        let seen = highest_seen(&state, &s.vault_id)?;
        match Vault::unlock(&bytes, password, &key, seen)? {
            UnlockOutcome::Ready(v) => Ok(v),
            UnlockOutcome::Older(o) => Err(o.error().into()),
        }
    })();
    match back {
        Ok(v) => {
            s.vault = v;
            observe(&state, &s.vault_id, s.vault.generation());
            s.block = None;
            s.shown = None;
            s.loaded_at = crate::clock::now_iso();
            note_own_write(&state, &s.path);
            let _ = app.emit(events::VAULT_RELOADED, Empty {});
            crate::log!("vault: {what} not saved ({:?}); reloaded the file on disk", e.code);
            (CofferError::new(e.code, format!("Your {what} was not saved: {why}. Nothing changed. Try again.")), false)
        }
        Err(again) => {
            crate::log!("vault: {what} not saved ({:?}) and the file did not open again ({:?}); locking", e.code, again.code);
            (CofferError::new(e.code, format!("Your {what} was not saved: {why}. Nothing changed. Coffer locked the vault: unlock it with your current password.")), true)
        }
    }
}

pub fn change_password(app: &AppHandle, current: &str, next: &str, rekey: bool) -> CofferResult<()> {
    let state = app.state::<AppState>();
    let mut lock_after = false;
    let result = with_session(app, |s| {
        if let Some(b) = s.block {
            return Err(blocked(b));
        }
        let old_backups: Vec<PathBuf> = list_backups(&backups_dir(&state, &s.vault_id)).into_iter().map(|(p, _)| p).collect();
        let started = SystemTime::now();
        s.vault.change_password(current, next, rekey, &stem_of(&s.path)).map_err(unlocked_err)?;
        if let Err(e) = save(app, s) {
            let (err, lock) = undo_key_change(app, s, current, "master password change", e);
            lock_after = lock;
            return Err(err);
        }
        crate::hello::password_proven(&state);
        if rekey {
            // They open with the old vault key (SPEC 3.3).
            delete_old_backups(&old_backups, started);
        }
        Ok(())
    });
    if lock_after {
        crate::lock::lock(app, LockReason::Manual);
    }
    result
}

/// Tier 2: a new Secret Key, a new vault key, every record re-encrypted.
/// This PC stores the new Secret Key only after the file holds the new keys.
pub fn rotate_secret_key(app: &AppHandle, password: &str) -> CofferResult<EmergencyKit> {
    let state = app.state::<AppState>();
    let mut lock_after = false;
    let result = with_session(app, |s| {
        if let Some(b) = s.block {
            return Err(blocked(b));
        }
        let old_backups: Vec<PathBuf> = list_backups(&backups_dir(&state, &s.vault_id)).into_iter().map(|(p, _)| p).collect();
        let started = SystemTime::now();
        let key = s.vault.rotate_secret_key(password).map_err(unlocked_err)?;
        if let Err(e) = save(app, s) {
            let (err, lock) = undo_key_change(app, s, password, "new Secret Key", e);
            lock_after = lock;
            return Err(err);
        }
        if let Err(e) = store_device_key(&state, &s.vault_id, &key) {
            // The kit below has the key; the next unlock asks for it.
            crate::log!("vault: the new Secret Key is saved in the vault but not on this PC: {e}");
        }
        delete_old_backups(&old_backups, started);
        Ok(kit_for(s, &key))
    });
    if lock_after {
        crate::lock::lock(app, LockReason::Manual);
    }
    result
}

fn kit_for(s: &Session, key: &SecretKey) -> EmergencyKit {
    // Vaults made before the core kept `created_at` fall back to the file's
    // creation time.
    let created = s.vault.created_at().unwrap_or_else(|| {
        std::fs::metadata(&s.path)
            .and_then(|m| m.created())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| crate::clock::iso_from_unix(d.as_secs() as i64))
            .unwrap_or_else(crate::clock::now_iso)
    });
    EmergencyKit {
        vault_name: stem_of(&s.path),
        vault_path: s.path.to_string_lossy().into_owned(),
        vault_id: s.vault_id.clone(),
        key_id: key.key_id().to_string(),
        secret_key: key.to_text(),
        created_at: created,
        computer_name: crate::paths::computer_name(),
    }
}

pub fn emergency_kit(app: &AppHandle, password: &str) -> CofferResult<EmergencyKit> {
    with_session(app, |s| {
        let key = s.vault.secret_key_for_kit(password).map_err(unlocked_err)?;
        Ok(kit_for(s, &key))
    })
}

/// Time one Argon2id run with the default settings on this PC.
pub fn kdf_benchmark() -> CofferResult<KdfBenchmark> {
    let params = KdfParams::DEFAULT;
    let salt: [u8; 16] = coffer_core::crypto::random_array();
    let started = std::time::Instant::now();
    coffer_core::crypto::argon2id_key(b"coffer kdf benchmark", &salt, &params)?;
    Ok(KdfBenchmark { millis: started.elapsed().as_millis() as u64, m_kib: params.m_kib, t: params.t, p: params.p })
}

// ---------- import and export (SPEC 8) ----------

/// The file `import_preview` read last, and the preview `import_commit` takes.
#[derive(Default)]
pub struct ImportState {
    /// The last file previewed, and whether the user picked it (source "last").
    last: Option<(PathBuf, bool)>,
    /// The one preview waiting for `import_commit`. It holds decrypted items:
    /// a new preview or a lock drops it.
    pub plan: Option<coffer_core::import::ImportPlan>,
    /// Preview id -> the plain file the user picked (`import_delete_source`).
    sources: HashMap<String, PathBuf>,
}

/// A password export is never this large.
const IMPORT_MAX_BYTES: u64 = 64 * 1024 * 1024;

/// Encrypted formats: `import_delete_source` offers to delete plain files only.
const ENCRYPTED_FORMATS: [&str; 2] = ["coffer-cofferx", "coffer-vault"];

/// The file of `import_preview` source "last".
pub fn import_last(app: &AppHandle) -> Option<(PathBuf, bool)> {
    app.state::<AppState>().import.lck().last.clone()
}

/// Read `file`, detect its format and plan the import into the open vault.
/// A `.coffer` file of a vault whose Secret Key this PC stores (a conflict
/// copy) uses that key; the UI asks for the master password.
pub fn import_preview(app: &AppHandle, file: PathBuf, picked: bool, password: Option<&str>, secret_key: Option<&str>) -> CofferResult<ImportPreview> {
    let state = app.state::<AppState>();
    if !state.is_unlocked() {
        return Err(CofferError::locked());
    }
    let len = std::fs::metadata(&file).map_err(|e| io_err("read that file", e))?.len();
    if len > IMPORT_MAX_BYTES {
        return Err(CofferError::new(ErrorCode::UnsupportedFormat, "This file is too large to be a password export (over 64 MB)."));
    }
    let bytes = zeroize::Zeroizing::new(std::fs::read(&file).map_err(|e| io_err("read that file", e))?);
    let typed = match secret_key.map(str::trim).filter(|k| !k.is_empty()) {
        Some(text) => Some(SecretKey::parse(text)?),
        None => None,
    };
    let stored = match (&typed, coffer_core::vault_file::read_header(&bytes)) {
        (None, Ok(h)) => device_key(&state, &h.vault_id)?.filter(|k| k.key_id() == h.key_id),
        _ => None,
    };
    let file_name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let request = coffer_core::import::ImportRequest { file_name: &file_name, bytes: &bytes, password, secret_key: typed.as_ref().or(stored.as_ref()) };
    let plan = with_vault(app, |v| v.import_preview(&request))?;
    let preview = plan.preview().clone();
    let mut im = state.import.lck();
    im.last = Some((file.clone(), picked));
    im.plan = (!preview.needs_password && !preview.needs_secret_key).then_some(plan);
    if picked && !ENCRYPTED_FORMATS.contains(&preview.format.as_str()) {
        im.sources.insert(preview.preview_id.clone(), file);
    }
    crate::log!("import: preview {} ({} to import, {} duplicates, {} skipped)", preview.format, preview.total, preview.duplicates, preview.skipped.len());
    Ok(preview)
}

/// Import the previewed items in one save.
pub fn import_commit(app: &AppHandle, preview_id: &str) -> CofferResult<ImportResult> {
    let state = app.state::<AppState>();
    let plan = {
        let mut im = state.import.lck();
        match im.plan.take() {
            Some(plan) if plan.id() == preview_id => plan,
            other => {
                im.plan = other;
                return Err(CofferError::new(ErrorCode::NotFound, "This import preview has expired. Choose the file again."));
            }
        }
    };
    let result = mutate(app, |v| Ok(v.import_commit(plan)))?;
    crate::log!("import: {} items imported, {} skipped, tag {}", result.imported, result.skipped, result.tag);
    Ok(result)
}

/// Move an import batch to Trash; returns how many items moved.
pub fn import_undo(app: &AppHandle, batch_id: &str) -> CofferResult<u32> {
    let n = mutate(app, |v| Ok(v.import_undo(batch_id)))?;
    crate::log!("import: undo moved {n} items to Trash");
    Ok(n as u32)
}

/// Delete the plain file the user picked for this preview.
pub fn import_delete_source(app: &AppHandle, preview_id: &str) -> CofferResult<()> {
    let state = app.state::<AppState>();
    let path = state.import.lck().sources.get(preview_id).cloned().ok_or_else(|| CofferError::new(ErrorCode::NotFound, "Coffer no longer knows which file this was."))?;
    if vault_path(&state).as_deref() == Some(path.as_path()) {
        return Err(CofferError::invalid("This is your vault file. Coffer does not delete it."));
    }
    match std::fs::remove_file(&path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(io_err("delete that file", e)),
    }
    state.import.lck().sources.remove(preview_id);
    crate::log!("import: deleted the plain source file");
    Ok(())
}

/// The export bytes and a file name to suggest (`<stem>-export.<ext>`),
/// after the master password is checked again.
pub fn export_bytes(app: &AppHandle, kind: ExportKind, master_password: &str, export_password: Option<&str>) -> CofferResult<(zeroize::Zeroizing<Vec<u8>>, String)> {
    with_session(app, |s| {
        s.vault.verify_password(master_password).map_err(unlocked_err)?;
        if kind == ExportKind::CofferEncrypted && export_password.is_none_or(|p| p.is_empty()) {
            return Err(CofferError::invalid("Choose a password for the export file."));
        }
        let bytes = s.vault.export(kind, export_password)?;
        let ext = match kind {
            ExportKind::CofferEncrypted => "cofferx",
            ExportKind::CofferJson | ExportKind::BitwardenJson => "json",
            ExportKind::Csv => "csv",
        };
        Ok((bytes, format!("{}-export.{ext}", stem_of(&s.path))))
    })
}

/// Write an export file where the save dialog said.
pub fn export_write(path: &Path, bytes: &[u8]) -> CofferResult<()> {
    crate::paths::write_atomic(path, bytes).map_err(|e| io_err("write the export file", e))?;
    crate::log!("export: wrote {} bytes", bytes.len());
    Ok(())
}

// ---------- breach check ----------

/// Check every password against Pwned Passwords (SPEC 3.10), then save the
/// results into the vault's cache. No lock is held during the network calls.
pub fn breach_check(app: &AppHandle) -> CofferResult<HealthReport> {
    let queries = with_session(app, |s| Ok(s.vault.breach_queries()))?;
    let prefixes: BTreeSet<String> = queries.iter().map(|q| q.prefix.clone()).collect();
    let mut responses: HashMap<String, HashMap<String, u64>> = HashMap::new();
    for prefix in prefixes {
        let rows = crate::hibp::hibp_range(&prefix)?;
        responses.insert(prefix, rows.into_iter().collect());
    }
    let results = coffer_core::breach::match_queries(&queries, &responses);
    let checked_at = crate::clock::now_iso();
    crate::log!("breach check: {} passwords, {} prefixes", queries.len(), responses.len());
    let mode = app.state::<AppState>().settings.rd().settings.breach_check;
    mutate(app, |v| {
        v.apply_breach_results(&results, &checked_at);
        Ok(v.health_report(mode))
    })
}

/// With "weekly" on, check after unlock when the last check is 7 days old.
fn maybe_weekly_breach_check(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mode = state.settings.rd().settings.breach_check;
    if mode != BreachMode::Weekly {
        return;
    }
    let last = with_session(app, |s| Ok(s.vault.health_report(mode).breach_checked_at)).ok().flatten();
    let due = last.and_then(|t| coffer_core::time_util::parse(&t)).is_none_or(|t| coffer_core::time_util::now() - t >= time::Duration::days(7));
    if due {
        let app = app.clone();
        let _ = std::thread::Builder::new().name("coffer-breach".into()).spawn(move || {
            if let Err(e) = breach_check(&app) {
                crate::log!("breach check (weekly): {e}");
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stems() {
        assert_eq!(stem_for("Personal").unwrap(), "Personal");
        assert_eq!(stem_for("  Work: \"Acme\" <2026>/x?*|  ").unwrap(), "Work_ _Acme_ _2026__x___");
        assert_eq!(stem_for("trailing dots...").unwrap(), "trailing dots");
        assert_eq!(stem_for("tab\there").unwrap(), "tab_here");
        assert_eq!(stem_for("CON").unwrap(), "CON_");
        assert_eq!(stem_for("con.backup").unwrap(), "con_.backup");
        assert_eq!(stem_for("LPT9").unwrap(), "LPT9_");
        assert_eq!(stem_for("COM0").unwrap(), "COM0");
        assert_eq!(stem_for("Console").unwrap(), "Console");
        assert_eq!(stem_for(&"x".repeat(80)).unwrap().len(), 64);
        assert!(stem_for("  . . ").is_err());
        assert!(stem_for("").is_err());
    }

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("coffer-vault-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn atomic_write_rules() {
        let dir = temp("write");
        let path = dir.join("Personal.coffer");
        write_vault_file(&path, b"first", &Expect::New).unwrap();
        assert!(matches!(write_vault_file(&path, b"again", &Expect::New), Err(WriteError::Exists)));
        // A base that matches the disk file: replaced.
        write_vault_file(&path, b"second", &Expect::Base(DiskBase::Sha256(sha256(b"first")))).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"second");
        // The disk changed after the user saw it: not replaced.
        assert!(matches!(write_vault_file(&path, b"third", &Expect::Base(DiskBase::Sha256(sha256(b"first")))), Err(WriteError::Changed)));
        assert!(matches!(write_vault_file(&path, b"third", &Expect::Base(DiskBase::Absent)), Err(WriteError::Changed)));
        // A MAC check on a file that is not a vault: changed.
        assert!(matches!(write_vault_file(&path, b"third", &Expect::Mac("x".into())), Err(WriteError::Changed)));
        assert_eq!(std::fs::read(&path).unwrap(), b"second");
        write_vault_file(&path, b"fourth", &Expect::Any).unwrap();
        // A stale temp file from a crash goes; other files stay.
        std::fs::write(dir.join("Personal.0badf00d.tmp"), b"x").unwrap();
        std::fs::write(dir.join("Other.0badf00d.tmp"), b"x").unwrap();
        write_vault_file(&path, b"fifth", &Expect::Any).unwrap();
        let names: Vec<String> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert!(names.contains(&"Personal.coffer".to_string()));
        assert!(names.contains(&"Other.0badf00d.tmp".to_string()));
        assert!(!names.iter().any(|n| n.starts_with("Personal.") && n.ends_with(".tmp")));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn disk_base_of_a_missing_file_is_absent() {
        let dir = temp("base");
        assert_eq!(disk_base(&dir.join("nope.coffer")), DiskBase::Absent);
        std::fs::write(dir.join("a.coffer"), b"abc").unwrap();
        assert_eq!(disk_base(&dir.join("a.coffer")), DiskBase::Sha256(sha256(b"abc")));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
