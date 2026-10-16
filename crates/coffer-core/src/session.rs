//! An unlocked vault in memory (SPEC 3.3 to 3.6).
//!
//! [`Vault`] holds VK, the derived keys, the Secret Key and every decrypted
//! record in zeroize-on-drop types. Drop it to lock.
//!
//! # Life cycle for the shell
//! 1. New vault: [`Vault::create`], then [`Vault::to_bytes`], write the file,
//!    then [`Vault::mark_saved`].
//! 2. Open: [`crate::vault_file::read_header`] (no KDF) for the key id and
//!    generation, then [`Vault::unlock`]. It returns
//!    [`UnlockOutcome::Older`] when the file's generation is under the
//!    highest this PC has seen: keep it up to 60 s and call
//!    [`OlderFile::accept`] on the user's confirm.
//! 3. After unlock: [`Vault::purge_expired_trash`]; save if it returned > 0.
//! 4. Every change marks records dirty. Save: `to_bytes(highest_seen)` ->
//!    write `<stem>.<random>.tmp`, `sync_all`, compare the disk file's
//!    `manifest_mac` (see [`crate::vault_file::manifest_mac_of`]) with
//!    [`Vault::disk_mac`]; equal -> replace and call [`Vault::mark_saved`];
//!    else call [`Vault::check_external_change`].
//! 5. A file watcher event: [`Vault::check_external_change`] and act on the
//!    [`ExternalChange`].
//!
//! # Re-prompt
//! For an item with `reprompt`, reveal, copy of a secret field, TOTP,
//! password history and revisions need the master password in the call or
//! a 60 s grant this vault holds for that item; a call with the right
//! password starts the grant. A save or revision restore that turns
//! `reprompt` off, or changes a secret field's kind, needs it too.

use std::collections::{BTreeMap, HashMap};
use std::time::{Duration as StdDuration, Instant};

use sha2::{Digest, Sha256};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use crate::breach::{BreachQuery, sha1_prefix_suffix};
use crate::crypto::{self, Key32, KdfParams, VaultKeys};
use crate::encoding::{self, KIND_ITEM, KIND_META, ManifestEntry};
use crate::error::{CoreError, Result};
use crate::health::{self, Analysis};
use crate::model::*;
use crate::secret_key::SecretKey;
use crate::time_util;
use crate::totp::Totp;
use crate::vault_file::{RecordBlob, VaultFile};

/// How long a re-prompt grant lasts.
pub const GRANT_SECONDS: u64 = 60;
/// How long an older-file open waits for the user's confirm.
pub const OLDER_HOLD_SECONDS: u64 = 60;
/// Days an item stays in Trash.
pub const TRASH_DAYS: i64 = 30;
/// Password history entries kept per item.
pub const PASSWORD_HISTORY_MAX: usize = 20;
/// Revision snapshots kept per item.
pub const REVISIONS_MAX: usize = 10;
/// Generator history entries kept.
pub const GENERATOR_HISTORY_MAX: usize = 50;

/// What the shell must do after a change on disk (SPEC 3.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExternalChange {
    /// The disk file is the one we last loaded or wrote.
    Unchanged,
    /// The header changed (password changed or key rotated elsewhere): write
    /// our state to a conflict file, then lock with reason `keyChanged`.
    HeaderChanged,
    /// Clean: call [`Vault::reload`] and emit `vault://reloaded`. Never
    /// returned by [`Vault::check_external_change`] while the open vault has
    /// unsaved changes (that is `Conflict`).
    Reload,
    /// The disk generation is under the highest seen (a rollback): keep the
    /// open state, block saves, emit `vault://olderOnDisk`.
    OlderOnDisk,
    /// Generation equal, or higher with records of ours missing, or higher
    /// while the open vault has unsaved changes: write our state to a
    /// conflict file ([`Vault::conflict_bytes`]), then [`Vault::reload`]
    /// the disk file.
    Conflict,
    /// The MAC fails (or the file is unreadable): block saves, emit
    /// `vault://diskDamaged`.
    MacFailed,
}

/// The state of the file Coffer last loaded or wrote.
#[derive(Clone, PartialEq, Eq)]
pub struct DiskState {
    /// Generation.
    pub generation: u64,
    /// Manifest MAC.
    pub manifest_mac: [u8; 32],
    /// (id, rev) of every record.
    pub revs: BTreeMap<Uuid, u64>,
    header: HeaderFacts,
}

impl std::fmt::Debug for DiskState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DiskState").field("generation", &self.generation).field("records", &self.revs.len()).finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
struct HeaderFacts {
    vault_id: Uuid,
    key_id: String,
    kdf: KdfParams,
    salt: [u8; 16],
    wrap_nonce: [u8; 24],
    wrap_ct: Vec<u8>,
}

/// Facts about a disk file for [`decide_external_change`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiskFacts {
    /// The header equals ours.
    pub header_same: bool,
    /// The manifest MAC verifies with our key.
    pub mac_ok: bool,
    /// Its generation.
    pub generation: u64,
    /// Its manifest MAC.
    pub manifest_mac: [u8; 32],
    /// (id, rev) of its records.
    pub revs: BTreeMap<Uuid, u64>,
}

/// The external-change rule of SPEC 3.5 as a pure function.
///
/// - `known`: generation and MAC of what we last loaded or wrote.
/// - `written`: records we wrote since our last load, with their revs.
/// - `highest_seen`: the highest generation this PC has seen (device.json).
pub fn decide_external_change(
    known_generation: u64,
    known_mac: &[u8; 32],
    written: &BTreeMap<Uuid, u64>,
    highest_seen: u64,
    disk: Option<&DiskFacts>,
) -> ExternalChange {
    let Some(d) = disk else { return ExternalChange::MacFailed };
    if !d.header_same {
        return ExternalChange::HeaderChanged;
    }
    if !d.mac_ok {
        return ExternalChange::MacFailed;
    }
    if &d.manifest_mac == known_mac && d.generation == known_generation {
        return ExternalChange::Unchanged;
    }
    let seen = highest_seen.max(known_generation);
    if d.generation < seen {
        return ExternalChange::OlderOnDisk;
    }
    if d.generation == known_generation {
        return ExternalChange::Conflict;
    }
    let ours_present = written.iter().all(|(id, rev)| d.revs.get(id).is_some_and(|r| r >= rev));
    if ours_present { ExternalChange::Reload } else { ExternalChange::Conflict }
}

/// Bulk actions of `items_bulk`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BulkAction {
    /// Archive.
    Archive,
    /// Move to Trash.
    Trash,
    /// Make active again.
    Restore,
    /// Add a tag.
    AddTag,
    /// Remove a tag.
    RemoveTag,
}

/// Result of [`Vault::unlock`].
pub enum UnlockOutcome {
    /// Open.
    Ready(Vault),
    /// The file is older than the highest generation this PC has seen.
    Older(OlderFile),
}

impl std::fmt::Debug for UnlockOutcome {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            UnlockOutcome::Ready(_) => f.write_str("Ready(<vault>)"),
            UnlockOutcome::Older(o) => write!(f, "Older(file {}, seen {})", o.file_generation, o.seen_generation),
        }
    }
}

/// A verified vault held until the user confirms opening an older file
/// (`vault_open_older`). It expires after 60 s.
pub struct OlderFile {
    vault: Vault,
    made: Instant,
    /// The file's generation.
    pub file_generation: u64,
    /// The highest generation this PC has seen.
    pub seen_generation: u64,
}

impl OlderFile {
    /// The `olderFile` error to return to the UI.
    pub fn error(&self) -> CoreError {
        CoreError::OlderFile { seen: self.seen_generation, file: self.file_generation }
    }

    /// `true` after 60 s; drop it then.
    pub fn expired(&self) -> bool {
        self.made.elapsed() >= StdDuration::from_secs(OLDER_HOLD_SECONDS)
    }

    /// Completes the open.
    ///
    /// # Errors
    /// `Invalid` when the 60 s passed.
    pub fn accept(self) -> Result<Vault> {
        if self.expired() {
            return Err(CoreError::invalid("The confirm came too late. Unlock again."));
        }
        Ok(self.vault)
    }
}

#[derive(Clone)]
struct Enc {
    nonce: [u8; 24],
    ct: Vec<u8>,
}

struct ItemSlot {
    rev: u64,
    item: StoredItem,
    enc: Option<Enc>,
}

/// A generated value not yet copied or saved (memory only).
#[derive(Zeroize, ZeroizeOnDrop)]
struct PendingGenerated {
    value: String,
    #[zeroize(skip)]
    mode: GeneratorMode,
}

/// An unlocked vault. Holds keys and plaintext; zeroed on drop. `Debug`
/// prints no secret.
pub struct Vault {
    vault_id: Uuid,
    key_id: String,
    kdf: KdfParams,
    salt: [u8; 16],
    wrap_nonce: [u8; 24],
    wrap_ct: Vec<u8>,
    keys: VaultKeys,
    secret_key: SecretKey,
    items: BTreeMap<Uuid, ItemSlot>,
    meta_id: Uuid,
    meta_rev: u64,
    meta: MetaRecord,
    meta_enc: Option<Enc>,
    disk: Option<DiskState>,
    /// Keys and Secret Key of the file on disk while they differ from the
    /// open ones (a rekey or key rotation not yet saved). MAC checks of the
    /// disk file use these until [`Vault::mark_saved`].
    disk_keys: Option<(VaultKeys, SecretKey)>,
    pending: Option<DiskState>,
    load_revs: BTreeMap<Uuid, u64>,
    written: BTreeMap<Uuid, u64>,
    grants: HashMap<Uuid, Instant>,
    generated: Vec<PendingGenerated>,
    weak_cache: HashMap<Uuid, ([u8; 32], u8)>,
    analysis: Analysis,
}

impl std::fmt::Debug for Vault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Vault")
            .field("vault_id", &self.vault_id)
            .field("key_id", &self.key_id)
            .field("items", &self.items.len())
            .finish_non_exhaustive()
    }
}

fn now_str() -> String {
    time_util::now_string()
}

fn derive_kek(password: &str, sk: &SecretKey, vault_id: &Uuid, salt: &[u8; 16], kdf: &KdfParams) -> Result<Key32> {
    let pw = crypto::normalize_password(password);
    let pw_key = crypto::argon2id_key(pw.as_bytes(), salt, kdf)?;
    Ok(crypto::derive_kek(&pw_key, sk.bytes(), vault_id, salt))
}

fn encrypt_record<T: serde::Serialize>(keys: &VaultKeys, vault_id: &Uuid, id: &Uuid, kind: u8, rev: u64, value: &T) -> Enc {
    // Written and padded through SecretBuf: no growth frees an unwiped copy.
    let mut pt = encoding::json_secret(value, false);
    pt.pad_256();
    let aad = encoding::record_aad(vault_id, id, kind, rev);
    let (nonce, ct) = crypto::seal(&keys.item_key, &aad, pt.as_slice());
    Enc { nonce, ct }
}

fn decrypt_record(keys: &VaultKeys, vault_id: &Uuid, r: &RecordBlob) -> Result<Zeroizing<Vec<u8>>> {
    let aad = encoding::record_aad(vault_id, &r.id, r.kind, r.rev);
    crypto::open(&keys.item_key, &r.nonce, &aad, &r.ct).ok_or(CoreError::Tampered)
}

/// Records of a verified file, decrypted.
struct Decrypted {
    items: BTreeMap<Uuid, ItemSlot>,
    meta_id: Uuid,
    meta_rev: u64,
    meta: MetaRecord,
    meta_enc: Enc,
}

fn verify_mac(keys: &VaultKeys, f: &VaultFile) -> bool {
    let entries: Vec<ManifestEntry<'_>> = f
        .records
        .iter()
        .map(|r| ManifestEntry { id: r.id, kind: r.kind, rev: r.rev, nonce: &r.nonce, ct: &r.ct })
        .collect();
    let input = encoding::manifest_input(&f.vault_id, f.generation, &entries);
    crypto::hmac_sha256_verify(keys.mac_key.as_bytes(), &input, &f.manifest_mac)
}

fn decrypt_all(keys: &VaultKeys, f: &VaultFile) -> Result<Decrypted> {
    let mut items = BTreeMap::new();
    let mut meta: Option<(Uuid, u64, MetaRecord, Enc)> = None;
    for r in &f.records {
        let pt = decrypt_record(keys, &f.vault_id, r)?;
        let enc = Enc { nonce: r.nonce, ct: r.ct.clone() };
        if r.kind == KIND_META {
            if meta.is_some() {
                return Err(CoreError::corrupt("This vault has more than one meta record."));
            }
            let m: MetaRecord = serde_json::from_slice(&pt).map_err(|_| CoreError::corrupt("A vault record is not readable."))?;
            meta = Some((r.id, r.rev, m, enc));
        } else {
            let item: StoredItem =
                serde_json::from_slice(&pt).map_err(|_| CoreError::corrupt("A vault record is not readable."))?;
            if item.id != r.id {
                return Err(CoreError::Tampered);
            }
            items.insert(r.id, ItemSlot { rev: r.rev, item, enc: Some(enc) });
        }
    }
    let (meta_id, meta_rev, meta, meta_enc) =
        meta.ok_or_else(|| CoreError::corrupt("This vault has no meta record."))?;
    Ok(Decrypted { items, meta_id, meta_rev, meta, meta_enc })
}

/// The item records of a verified file (for the `.coffer` importer).
pub(crate) fn decrypt_items(keys: &VaultKeys, f: &VaultFile) -> Result<Vec<StoredItem>> {
    let d = decrypt_all(keys, f)?;
    Ok(d.items.into_values().map(|s| s.item).collect())
}

fn header_of(f: &VaultFile) -> HeaderFacts {
    HeaderFacts {
        vault_id: f.vault_id,
        key_id: f.key_id.clone(),
        kdf: f.kdf,
        salt: f.salt,
        wrap_nonce: f.wrap_nonce,
        wrap_ct: f.wrap_ct.clone(),
    }
}

fn disk_state_of(f: &VaultFile) -> DiskState {
    DiskState { generation: f.generation, manifest_mac: f.manifest_mac, revs: f.revs(), header: header_of(f) }
}

/// Opens a vault file with a password and a Secret Key: parse, KDF floor and
/// ceiling (before Argon2), unwrap, MAC, records. Used by unlock and by the
/// `.coffer` importer.
pub(crate) fn open_file(bytes: &[u8], password: &str, sk: &SecretKey) -> Result<(VaultFile, VaultKeys)> {
    let f = VaultFile::parse(bytes)?;
    if sk.key_id() != f.key_id {
        return Err(CoreError::BadSecretKey("This Secret Key is for another vault.".into()));
    }
    f.kdf.check()?;
    let kek = derive_kek(password, sk, &f.vault_id, &f.salt, &f.kdf)?;
    let aad = encoding::header_aad(&f.vault_id, &f.kdf, &f.salt, &f.key_id);
    let vk = crypto::open(&kek, &f.wrap_nonce, &aad, &f.wrap_ct).ok_or(CoreError::BadCredentials)?;
    let vk = Key32::from_slice(&vk).ok_or(CoreError::BadCredentials)?;
    let keys = VaultKeys::from_vk(vk, &f.vault_id);
    if !verify_mac(&keys, &f) {
        return Err(CoreError::Tampered);
    }
    Ok((f, keys))
}

/// Normalised tags: trimmed, no empty, no repeats, in order.
fn clean_tags(tags: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in tags {
        let t = t.trim().trim_matches('/').trim();
        if !t.is_empty() && !out.iter().any(|o| o == t) {
            out.push(t.to_owned());
        }
    }
    out
}

impl Vault {
    // ------------------------------------------------------------ create / open

    /// Creates a new, empty vault in memory (generation 0; the first save
    /// writes generation 1). Refuses a master password with a zxcvbn score
    /// under 3 (the vault name is a user input).
    ///
    /// # Errors
    /// `WeakPassword`; `KdfTooWeak` / `KdfTooStrong` for bad settings.
    pub fn create(vault_name: &str, password: &str, secret_key: &SecretKey, kdf: KdfParams) -> Result<Vault> {
        let pw = crypto::normalize_password(password);
        if !crate::strength::is_strong_enough(&pw, &[vault_name]) {
            return Err(CoreError::WeakPassword(
                "Choose a stronger master password: add more words or characters.".into(),
            ));
        }
        kdf.check()?;
        let vault_id = Uuid::new_v4();
        let salt: [u8; 16] = crypto::random_array();
        let kek = derive_kek(password, secret_key, &vault_id, &salt, &kdf)?;
        let vk = Key32::random();
        let aad = encoding::header_aad(&vault_id, &kdf, &salt, secret_key.key_id());
        let (wrap_nonce, wrap_ct) = crypto::seal(&kek, &aad, vk.as_bytes());
        let keys = VaultKeys::from_vk(vk, &vault_id);
        let mut meta = MetaRecord::default();
        meta.created_at = now_str();
        let mut v = Vault {
            vault_id,
            key_id: secret_key.key_id().to_owned(),
            kdf,
            salt,
            wrap_nonce,
            wrap_ct,
            keys,
            secret_key: secret_key.clone(),
            items: BTreeMap::new(),
            meta_id: Uuid::new_v4(),
            meta_rev: 1,
            meta,
            meta_enc: None,
            disk: None,
            disk_keys: None,
            pending: None,
            load_revs: BTreeMap::new(),
            written: BTreeMap::new(),
            grants: HashMap::new(),
            generated: Vec::new(),
            weak_cache: HashMap::new(),
            analysis: Analysis::default(),
        };
        v.refresh_health();
        Ok(v)
    }

    /// Unlocks a vault file. Checks, in order: structure, the Secret Key's
    /// key id against the header (`badSecretKey` "This Secret Key is for
    /// another vault."), the KDF floor and ceiling (before Argon2), the
    /// unwrap (`badCredentials`), the manifest MAC and every record
    /// (`tampered`). Then compares the generation with `highest_seen`.
    ///
    /// # Errors
    /// `Corrupt`, `BadSecretKey`, `KdfTooWeak`, `KdfTooStrong`,
    /// `BadCredentials`, `Tampered`.
    pub fn unlock(bytes: &[u8], password: &str, secret_key: &SecretKey, highest_seen: u64) -> Result<UnlockOutcome> {
        let (f, keys) = open_file(bytes, password, secret_key)?;
        Self::from_verified(f, keys, secret_key, highest_seen)
    }

    /// Windows Hello unlock (SPEC 3.8): opens the file with a vault key the
    /// shell held from [`Vault::hello_key`], without Argon2 and without the
    /// unwrap. Checks, in order: structure, the key id (`badSecretKey`), the
    /// KDF floor and ceiling (later password checks run Argon2 with them),
    /// the manifest MAC with this VK, every record. Same generation rule as
    /// [`Vault::unlock`].
    ///
    /// A MAC that fails with this VK returns `badCredentials`, not
    /// `tampered`: the usual cause is a rekey (password change with "My old
    /// password may be known", or a key rotation) on another PC. Drop the
    /// held key and ask for the master password; a damaged file then shows
    /// as `tampered` on that unlock.
    ///
    /// # Errors
    /// `Corrupt`, `BadSecretKey`, `KdfTooWeak`, `KdfTooStrong`,
    /// `BadCredentials`, `Tampered` (a record fails after the MAC passed).
    pub fn unlock_with_vault_key(bytes: &[u8], vk: &[u8; 32], secret_key: &SecretKey, highest_seen: u64) -> Result<UnlockOutcome> {
        let f = VaultFile::parse(bytes)?;
        if secret_key.key_id() != f.key_id {
            return Err(CoreError::BadSecretKey("This Secret Key is for another vault.".into()));
        }
        f.kdf.check()?;
        let key = Key32::from_slice(vk).ok_or(CoreError::BadCredentials)?;
        let keys = VaultKeys::from_vk(key, &f.vault_id);
        if !verify_mac(&keys, &f) {
            return Err(CoreError::BadCredentials);
        }
        Self::from_verified(f, keys, secret_key, highest_seen)
    }

    /// The open vault of a file whose MAC verified with `keys`.
    fn from_verified(f: VaultFile, keys: VaultKeys, secret_key: &SecretKey, highest_seen: u64) -> Result<UnlockOutcome> {
        let d = decrypt_all(&keys, &f)?;
        let disk = disk_state_of(&f);
        let mut v = Vault {
            vault_id: f.vault_id,
            key_id: f.key_id.clone(),
            kdf: f.kdf,
            salt: f.salt,
            wrap_nonce: f.wrap_nonce,
            wrap_ct: f.wrap_ct.clone(),
            keys,
            secret_key: secret_key.clone(),
            items: d.items,
            meta_id: d.meta_id,
            meta_rev: d.meta_rev,
            meta: d.meta,
            meta_enc: Some(d.meta_enc),
            load_revs: disk.revs.clone(),
            disk: Some(disk),
            disk_keys: None,
            pending: None,
            written: BTreeMap::new(),
            grants: HashMap::new(),
            generated: Vec::new(),
            weak_cache: HashMap::new(),
            analysis: Analysis::default(),
        };
        v.refresh_health();
        if f.generation < highest_seen {
            return Ok(UnlockOutcome::Older(OlderFile {
                vault: v,
                made: Instant::now(),
                file_generation: f.generation,
                seen_generation: highest_seen,
            }));
        }
        Ok(UnlockOutcome::Ready(v))
    }

    /// Checks the master password: derives the KEK again and unwraps VK
    /// (runs Argon2).
    ///
    /// # Errors
    /// `BadCredentials`.
    pub fn verify_password(&self, password: &str) -> Result<()> {
        let kek = derive_kek(password, &self.secret_key, &self.vault_id, &self.salt, &self.kdf)?;
        let aad = encoding::header_aad(&self.vault_id, &self.kdf, &self.salt, &self.key_id);
        let vk = crypto::open(&kek, &self.wrap_nonce, &aad, &self.wrap_ct).ok_or(CoreError::BadCredentials)?;
        let vk = Key32::from_slice(&vk).ok_or(CoreError::BadCredentials)?;
        if vk.ct_eq(&self.keys.vk) { Ok(()) } else { Err(CoreError::BadCredentials) }
    }

    // ------------------------------------------------------------ facts

    /// Vault id.
    pub fn vault_id(&self) -> String {
        self.vault_id.hyphenated().to_string()
    }

    /// Secret Key id (6 symbols).
    pub fn key_id(&self) -> &str {
        &self.key_id
    }

    /// Generation of the file last loaded or confirmed written (0 for a new vault).
    pub fn generation(&self) -> u64 {
        self.disk.as_ref().map(|d| d.generation).unwrap_or(0)
    }

    /// Base64 manifest MAC of the file last loaded or confirmed written
    /// (`None` for a vault never saved). Compare with the file on disk
    /// before replacing it.
    pub fn disk_mac(&self) -> Option<String> {
        use base64::Engine;
        self.disk.as_ref().map(|d| base64::engine::general_purpose::STANDARD.encode(d.manifest_mac))
    }

    /// KDF settings of the header.
    pub fn kdf(&self) -> KdfParams {
        self.kdf
    }

    /// Number of items in every state (active, archived and trashed).
    pub fn item_count(&self) -> usize {
        self.items.len()
    }

    /// Number of active items (not archived, not in Trash): the count to
    /// show the user, e.g. on the lock screen or in the Emergency Kit.
    pub fn active_item_count(&self) -> usize {
        self.items.values().filter(|s| s.item.state == ItemState::Active).count()
    }

    /// When the vault was created (`YYYY-MM-DDTHH:MM:SSZ`, kept in the meta
    /// record), for the Emergency Kit. `None` for a file that does not
    /// hold it.
    pub fn created_at(&self) -> Option<String> {
        time_util::parse(&self.meta.created_at).and_then(time_util::fmt)
    }

    /// The vault key (VK) bytes, for Windows Hello (SPEC 3.8).
    ///
    /// This exposes the key that decrypts every record: anyone who holds
    /// these 32 bytes and the file can read the vault without the master
    /// password or the Secret Key. It exists so the shell can unlock with
    /// Hello without keeping the master password: call it at lock time only
    /// when Hello is on, protect the bytes at once with
    /// `CryptProtectMemory(CRYPTPROTECTMEMORY_SAME_PROCESS)`, zero this copy
    /// (it is zeroed on drop), and give the bytes back to
    /// [`Vault::unlock_with_vault_key`]. Never log, store on disk or send it.
    pub fn hello_key(&self) -> Zeroizing<[u8; 32]> {
        Zeroizing::new(self.keys.vk.0)
    }

    /// The Secret Key for the Emergency Kit, after checking the master
    /// password (`emergency_kit`).
    ///
    /// # Errors
    /// `BadCredentials`.
    pub fn secret_key_for_kit(&self, password: &str) -> Result<SecretKey> {
        self.verify_password(password)?;
        Ok(self.secret_key.clone())
    }

    /// `true` when the open state differs from the file last loaded or
    /// confirmed written ([`Vault::mark_saved`]): any record (meta
    /// included) added, removed or at another rev, or another header (a
    /// password change or key rotation not yet saved). A vault never saved
    /// is dirty. A [`Vault::to_bytes`] whose write did not land leaves it
    /// dirty.
    pub fn is_dirty(&self) -> bool {
        let Some(d) = &self.disk else { return true };
        self.meta_enc.is_none()
            || self.items.values().any(|s| s.enc.is_none())
            || d.header != self.header_facts()
            || d.revs.len() != self.items.len() + 1
            || d.revs.get(&self.meta_id) != Some(&self.meta_rev)
            || self.items.iter().any(|(id, s)| d.revs.get(id) != Some(&s.rev))
    }

    /// The header facts of the open state.
    fn header_facts(&self) -> HeaderFacts {
        HeaderFacts {
            vault_id: self.vault_id,
            key_id: self.key_id.clone(),
            kdf: self.kdf,
            salt: self.salt,
            wrap_nonce: self.wrap_nonce,
            wrap_ct: self.wrap_ct.clone(),
        }
    }

    // ------------------------------------------------------------ save

    fn build_file(&mut self, generation: u64) -> VaultFile {
        let vault_id = self.vault_id;
        let mut records = Vec::with_capacity(self.items.len() + 1);
        if self.meta_enc.is_none() {
            self.meta_enc = Some(encrypt_record(&self.keys, &vault_id, &self.meta_id, KIND_META, self.meta_rev, &self.meta));
        }
        let me = self.meta_enc.as_ref().expect("set above");
        records.push(RecordBlob { id: self.meta_id, kind: KIND_META, rev: self.meta_rev, nonce: me.nonce, ct: me.ct.clone() });
        for (id, slot) in self.items.iter_mut() {
            if slot.enc.is_none() {
                slot.enc = Some(encrypt_record(&self.keys, &vault_id, id, KIND_ITEM, slot.rev, &slot.item));
            }
            let e = slot.enc.as_ref().expect("set above");
            records.push(RecordBlob { id: *id, kind: KIND_ITEM, rev: slot.rev, nonce: e.nonce, ct: e.ct.clone() });
        }
        let entries: Vec<ManifestEntry<'_>> = records
            .iter()
            .map(|r| ManifestEntry { id: r.id, kind: r.kind, rev: r.rev, nonce: &r.nonce, ct: &r.ct })
            .collect();
        let input = encoding::manifest_input(&vault_id, generation, &entries);
        let manifest_mac = crypto::hmac_sha256(self.keys.mac_key.as_bytes(), &input);
        VaultFile {
            vault_id,
            key_id: self.key_id.clone(),
            generation,
            kdf: self.kdf,
            salt: self.salt,
            wrap_nonce: self.wrap_nonce,
            wrap_ct: self.wrap_ct.clone(),
            records,
            manifest_mac,
        }
    }

    /// Serialises the vault for a save with generation =
    /// max(disk generation, `highest_seen`) + 1. Changed records are
    /// encrypted with fresh nonces. The state "on disk" changes only when
    /// you call [`Vault::mark_saved`] after the replace succeeded.
    pub fn to_bytes(&mut self, highest_seen: u64) -> Vec<u8> {
        let generation = self.generation().max(highest_seen) + 1;
        let f = self.build_file(generation);
        self.pending = Some(disk_state_of(&f));
        f.to_bytes()
    }

    /// Serialises our open state for a conflict copy
    /// (`<stem> (conflict <time>).coffer`); does not change any save state.
    pub fn conflict_bytes(&mut self, highest_seen: u64) -> Vec<u8> {
        let generation = self.generation().max(highest_seen) + 1;
        self.build_file(generation).to_bytes()
    }

    /// Records that the bytes of the last [`Vault::to_bytes`] are now the
    /// file on disk. Returns the new generation (store it as highest seen).
    pub fn mark_saved(&mut self) -> Option<u64> {
        let p = self.pending.take()?;
        // The written file has the open header: the disk now uses the open keys.
        if p.header == self.header_facts() {
            self.disk_keys = None;
        }
        for (id, rev) in &p.revs {
            if self.load_revs.get(id) != Some(rev) {
                self.written.insert(*id, *rev);
            }
        }
        let g = p.generation;
        self.disk = Some(p);
        Some(g)
    }

    // ------------------------------------------------------------ external change

    /// The keys of the file last loaded or written.
    fn disk_side_keys(&self) -> &VaultKeys {
        self.disk_keys.as_ref().map(|(k, _)| k).unwrap_or(&self.keys)
    }

    /// Facts of a disk file, compared with the file last loaded or written
    /// (its header and keys), not with the open header: a password change
    /// not yet saved must not make an unchanged disk look changed.
    fn disk_facts(&self, bytes: &[u8]) -> Option<DiskFacts> {
        let f = VaultFile::parse(bytes).ok()?;
        let base = self.disk.as_ref().map(|d| d.header.clone()).unwrap_or_else(|| self.header_facts());
        let header_same = header_of(&f) == base;
        let mac_ok = header_same && verify_mac(self.disk_side_keys(), &f);
        Some(DiskFacts { header_same, mac_ok, generation: f.generation, manifest_mac: f.manifest_mac, revs: f.revs() })
    }

    /// Applies the external-change rule of SPEC 3.5 to the bytes on disk.
    /// While the open state has changes not on disk ([`Vault::is_dirty`],
    /// also after a `to_bytes` whose write did not land), a clean `Reload`
    /// becomes `Conflict`, so those changes go to a conflict file instead
    /// of being dropped.
    pub fn check_external_change(&self, disk_bytes: &[u8], highest_seen: u64) -> ExternalChange {
        let facts = self.disk_facts(disk_bytes);
        let (g, mac) = match &self.disk {
            Some(d) => (d.generation, d.manifest_mac),
            None => (0, [0u8; 32]),
        };
        match decide_external_change(g, &mac, &self.written, highest_seen, facts.as_ref()) {
            ExternalChange::Reload if self.is_dirty() => ExternalChange::Conflict,
            other => other,
        }
    }

    /// Loads the disk file into this open vault (after `Reload`, or after
    /// writing a conflict copy on `Conflict`). The header must equal the
    /// header of the file last loaded or written and the MAC must verify.
    /// The open state, header and keys included, becomes the disk file's.
    ///
    /// # Errors
    /// `Tampered` when the MAC or a record fails; `Conflict` when the header
    /// changed.
    pub fn reload(&mut self, disk_bytes: &[u8]) -> Result<()> {
        let facts = self.disk_facts(disk_bytes).ok_or_else(|| CoreError::corrupt("The vault file on disk is not readable."))?;
        if !facts.header_same {
            return Err(CoreError::Conflict("The master password or Secret Key changed on another computer.".into()));
        }
        if !facts.mac_ok {
            return Err(CoreError::Tampered);
        }
        let f = VaultFile::parse(disk_bytes)?;
        let d = decrypt_all(self.disk_side_keys(), &f)?;
        // The open state becomes the disk's, header and keys included (an
        // unsaved password change or rotation went to the conflict copy).
        if let Some((keys, sk)) = self.disk_keys.take() {
            self.keys = keys;
            self.secret_key = sk;
        }
        self.key_id = f.key_id.clone();
        self.kdf = f.kdf;
        self.salt = f.salt;
        self.wrap_nonce = f.wrap_nonce;
        self.wrap_ct = f.wrap_ct.clone();
        self.items = d.items;
        self.meta_id = d.meta_id;
        self.meta_rev = d.meta_rev;
        self.meta = d.meta;
        self.meta_enc = Some(d.meta_enc);
        let disk = disk_state_of(&f);
        self.load_revs = disk.revs.clone();
        self.disk = Some(disk);
        self.pending = None;
        self.written.clear();
        self.refresh_health();
        Ok(())
    }

    /// Restore while unlocked (SPEC 3.5, `backup_restore({ index, password })`):
    /// decrypts a backup of this vault with the current VK and takes its
    /// records as the open state. Every restored record gets a rev above
    /// both its backup rev and our current rev. Save next:
    /// [`Vault::to_bytes`] writes generation = highest seen + 1.
    ///
    /// Re-prompt: when an item has re-prompt now and its backup version
    /// would weaken it (re-prompt off, or a secret field's kind changed),
    /// the restore needs the master password (or a live grant for every
    /// such item). Without it: `RepromptRequired`; ask and call again.
    ///
    /// # Errors
    /// `Invalid` for a backup of another vault or another vault key;
    /// `Tampered` when it fails to verify; `RepromptRequired`,
    /// `BadCredentials`.
    pub fn restore_backup(&mut self, backup_bytes: &[u8], password: Option<&str>) -> Result<()> {
        let f = VaultFile::parse(backup_bytes)?;
        if f.vault_id != self.vault_id {
            return Err(CoreError::invalid("This backup is of another vault."));
        }
        if !verify_mac(&self.keys, &f) {
            return Err(CoreError::invalid(
                "This backup was made under another vault key (before a password change or key rotation).",
            ));
        }
        let d = decrypt_all(&self.keys, &f)?;
        let needs_password = d.items.iter().any(|(id, restored)| {
            self.items.get(id).is_some_and(|cur| {
                Self::weakens(&cur.item, restored.item.reprompt, restored.item.fields.iter().map(|f| (f.id.as_str(), f.kind)))
                    && !self.has_grant(id)
            })
        });
        if needs_password {
            match password {
                Some(p) => self.verify_password(p)?,
                None => return Err(CoreError::RepromptRequired),
            }
        }
        let mut items = BTreeMap::new();
        for (id, slot) in d.items {
            let cur = self.items.get(&id).map(|s| s.rev).unwrap_or(0);
            items.insert(id, ItemSlot { rev: cur.max(slot.rev) + 1, item: slot.item.clone(), enc: None });
        }
        self.items = items;
        self.meta_rev = self.meta_rev.max(d.meta_rev) + 1;
        self.meta = d.meta.clone();
        self.meta_enc = None;
        self.grants.clear();
        self.refresh_health();
        Ok(())
    }

    // ------------------------------------------------------------ password and key

    /// Changes the master password (SPEC 3.3). `rekey` = "My old password
    /// may be known": a new VK and every record re-encrypted. Either way a
    /// new salt and wrap. Save afterwards; when `rekey`, delete this PC's
    /// backups made under the old VK.
    ///
    /// # Errors
    /// `BadCredentials` for a wrong current password; `WeakPassword` when
    /// the new one scores under 3 (`vault_name` is a user input).
    pub fn change_password(&mut self, current: &str, next: &str, rekey: bool, vault_name: &str) -> Result<()> {
        self.verify_password(current)?;
        let pw = crypto::normalize_password(next);
        if !crate::strength::is_strong_enough(&pw, &[vault_name]) {
            return Err(CoreError::WeakPassword("Choose a stronger master password: add more words or characters.".into()));
        }
        let sk = self.secret_key.clone();
        self.rewrap(next, &sk, rekey)
    }

    /// Rotates the Secret Key (tier 2): a new Secret Key, a new VK, every
    /// record re-encrypted, new salt and wrap. Returns the new key for the
    /// device store and the new Emergency Kit. Save afterwards and delete
    /// backups made under the old VK.
    ///
    /// # Errors
    /// `BadCredentials`.
    pub fn rotate_secret_key(&mut self, password: &str) -> Result<SecretKey> {
        self.verify_password(password)?;
        let sk = SecretKey::generate();
        self.rewrap(password, &sk, true)?;
        Ok(sk)
    }

    fn rewrap(&mut self, password: &str, sk: &SecretKey, rekey: bool) -> Result<()> {
        let salt: [u8; 16] = crypto::random_array();
        let kek = derive_kek(password, sk, &self.vault_id, &salt, &self.kdf)?;
        if rekey {
            let old = std::mem::replace(&mut self.keys, VaultKeys::from_vk(Key32::random(), &self.vault_id));
            // Keep the disk file's keys for MAC checks until the save lands
            // (the first rekey since the last save holds them).
            if self.disk.is_some() && self.disk_keys.is_none() {
                self.disk_keys = Some((old, self.secret_key.clone()));
            }
            for slot in self.items.values_mut() {
                slot.enc = None;
            }
            self.meta_enc = None;
        }
        let aad = encoding::header_aad(&self.vault_id, &self.kdf, &salt, sk.key_id());
        let (n, ct) = crypto::seal(&kek, &aad, self.keys.vk.as_bytes());
        self.salt = salt;
        self.wrap_nonce = n;
        self.wrap_ct = ct;
        self.key_id = sk.key_id().to_owned();
        self.secret_key = sk.clone();
        Ok(())
    }

    // ------------------------------------------------------------ re-prompt

    /// `true` when the item asks for the master password again.
    ///
    /// # Errors
    /// `NotFound`.
    pub fn is_reprompt(&self, id: &str) -> Result<bool> {
        Ok(self.slot(id)?.item.reprompt)
    }

    fn has_grant(&self, id: &Uuid) -> bool {
        self.grants.get(id).is_some_and(|t| t.elapsed() < StdDuration::from_secs(GRANT_SECONDS))
    }

    /// Passes when the item has no re-prompt, a live grant, or the right
    /// password (which starts a 60 s grant).
    fn check_reprompt(&mut self, id: &Uuid, password: Option<&str>) -> Result<()> {
        let reprompt = self.items.get(id).ok_or(CoreError::NotFound)?.item.reprompt;
        if !reprompt || self.has_grant(id) {
            return Ok(());
        }
        self.require_password_or_grant(id, password)
    }

    fn require_password_or_grant(&mut self, id: &Uuid, password: Option<&str>) -> Result<()> {
        if self.has_grant(id) {
            return Ok(());
        }
        match password {
            Some(p) => {
                self.verify_password(p)?;
                self.grants.insert(*id, Instant::now());
                Ok(())
            }
            None => Err(CoreError::RepromptRequired),
        }
    }

    // ------------------------------------------------------------ items: read

    fn parse_id(id: &str) -> Result<Uuid> {
        Uuid::parse_str(id).map_err(|_| CoreError::NotFound)
    }

    fn slot(&self, id: &str) -> Result<&ItemSlot> {
        self.items.get(&Self::parse_id(id)?).ok_or(CoreError::NotFound)
    }

    fn flags(&self, id: &Uuid) -> ItemFlags {
        self.analysis.flags.get(id).copied().unwrap_or_default()
    }

    /// The list subtitle. Built only from built-in fields whose kind is not
    /// secret (a user can make any field concealed), so it never shows a
    /// value that reveal or re-prompt guards. The one intended exception:
    /// the last 4 digits of a card number.
    fn subtitle(item: &StoredItem) -> String {
        let plain = |role: &str| item.builtin(role).filter(|f| !f.kind.is_secret()).map(|f| f.value.as_str()).unwrap_or("");
        let last4 = |v: &str| {
            let digits: Zeroizing<String> = Zeroizing::new(v.chars().filter(char::is_ascii_digit).collect());
            if digits.len() >= 4 { format!("\u{2022}\u{2022}\u{2022}\u{2022} {}", &digits[digits.len() - 4..]) } else { String::new() }
        };
        match item.item_type {
            ItemType::Login | ItemType::ApiCredential => {
                let u = plain("username");
                if u.is_empty() && item.item_type == ItemType::ApiCredential { plain("host").to_owned() } else { u.to_owned() }
            }
            ItemType::Card => last4(item.builtin_value("number")),
            ItemType::Bank => plain("bankName").to_owned(),
            ItemType::Identity => format!("{} {}", plain("firstName"), plain("lastName")).trim().to_owned(),
            ItemType::Document => plain("docKind").to_owned(),
            ItemType::SshKey => plain("fingerprint").to_owned(),
            ItemType::Wifi => plain("ssid").to_owned(),
            ItemType::License => plain("product").to_owned(),
            ItemType::Password | ItemType::Note => String::new(),
        }
    }

    fn summary(&self, slot: &ItemSlot) -> ItemSummary {
        let item = &slot.item;
        ItemSummary {
            id: item.id.to_string(),
            item_type: item.item_type,
            title: item.title.clone(),
            subtitle: Self::subtitle(item),
            favorite: item.favorite,
            tags: item.tags.clone(),
            state: item.state,
            updated_at: item.updated_at.clone(),
            last_used_at: None,
            url_host: item.url_host(),
            has_totp: item.fields.iter().any(|f| f.kind == FieldKind::Totp && !f.value.trim().is_empty()),
            flags: self.flags(&item.id),
        }
    }

    /// Every item in every state, as list rows (no secrets). `lastUsedAt` is
    /// `None`: the shell fills it from usage.json.
    pub fn items_list(&self) -> Vec<ItemSummary> {
        self.items.values().map(|s| self.summary(s)).collect()
    }

    /// One item with secret fields masked.
    ///
    /// # Errors
    /// `NotFound`.
    pub fn item_get(&self, id: &str) -> Result<ItemView> {
        let slot = self.slot(id)?;
        let item = &slot.item;
        Ok(ItemView {
            id: item.id.to_string(),
            rev: slot.rev,
            item_type: item.item_type,
            title: item.title.clone(),
            subtitle: Self::subtitle(item),
            favorite: item.favorite,
            tags: item.tags.clone(),
            state: item.state,
            created_at: item.created_at.clone(),
            updated_at: item.updated_at.clone(),
            trashed_at: item.trashed_at.clone(),
            password_changed_at: item.password_changed_at.clone(),
            fields: item
                .fields
                .iter()
                .map(|f| {
                    let secret = f.kind.is_secret();
                    Field {
                        id: f.id.clone(),
                        label: f.label.clone(),
                        kind: f.kind,
                        value: if secret { String::new() } else { f.value.clone() },
                        masked: if secret { Some(true) } else { None },
                        section: f.section.clone(),
                        builtin: f.builtin.clone(),
                        options: f.options.clone(),
                    }
                })
                .collect(),
            notes: item.notes.clone(),
            urls: item.urls.clone(),
            apps: item.apps.clone(),
            reprompt: item.reprompt,
            autotype_sequence: item.autotype_sequence.clone(),
            health_excluded: item.health_excluded,
            attachments: Vec::new(),
            password_history_count: item.password_history.len(),
            flags: self.flags(&item.id),
        })
    }

    /// Resolves a field ref: `history:<id>` (the value), else a built-in
    /// role, else a field id. Returns (value, kind, is a history entry).
    fn resolve<'a>(item: &'a StoredItem, field_ref: &str) -> Result<(&'a str, FieldKind, bool)> {
        if let Some(hid) = field_ref.strip_prefix("history:") {
            let h = item.password_history.iter().find(|h| h.id == hid).ok_or(CoreError::NotFound)?;
            return Ok((&h.value, FieldKind::Concealed, true));
        }
        if let Some(f) = item.builtin(field_ref) {
            return Ok((&f.value, f.kind, false));
        }
        let f = item.fields.iter().find(|f| f.id == field_ref).ok_or(CoreError::NotFound)?;
        Ok((&f.value, f.kind, false))
    }

    /// `item_reveal`: one value. Re-prompt applies. A totp field returns
    /// its URI or secret (for editing).
    ///
    /// # Errors
    /// `NotFound`, `RepromptRequired`, `BadCredentials`.
    pub fn item_reveal(&mut self, id: &str, field_ref: &str, password: Option<&str>) -> Result<Zeroizing<String>> {
        let uid = Self::parse_id(id)?;
        self.check_reprompt(&uid, password)?;
        let item = &self.items.get(&uid).ok_or(CoreError::NotFound)?.item;
        let (v, _, _) = Self::resolve(item, field_ref)?;
        Ok(Zeroizing::new(v.to_owned()))
    }

    /// `item_copy`: the text to put on the clipboard. Re-prompt applies to
    /// secret kinds and history entries. A totp field copies the current
    /// code.
    ///
    /// # Errors
    /// `NotFound` (also for an empty value: "This item has no <field>"),
    /// `RepromptRequired`, `BadCredentials`, `Invalid` for a bad TOTP secret.
    pub fn item_copy_value(&mut self, id: &str, field_ref: &str, password: Option<&str>) -> Result<Zeroizing<String>> {
        let uid = Self::parse_id(id)?;
        let (kind, history) = {
            let item = &self.items.get(&uid).ok_or(CoreError::NotFound)?.item;
            let (_, k, h) = Self::resolve(item, field_ref)?;
            (k, h)
        };
        if kind.is_secret() || history {
            self.check_reprompt(&uid, password)?;
        }
        let item = &self.items.get(&uid).ok_or(CoreError::NotFound)?.item;
        let (v, _, _) = Self::resolve(item, field_ref)?;
        if v.is_empty() {
            return Err(CoreError::NotFound);
        }
        if kind == FieldKind::Totp && !history {
            return Ok(Zeroizing::new(Totp::parse(v)?.code_now().code));
        }
        Ok(Zeroizing::new(v.to_owned()))
    }

    /// The role Enter copies for this item (`None` = open it).
    ///
    /// # Errors
    /// `NotFound`.
    pub fn enter_role(&self, id: &str) -> Result<Option<&'static str>> {
        Ok(crate::templates::enter_role(&self.slot(id)?.item))
    }

    /// `totp_code`: the code now. `field` = a field id or role (default the
    /// first totp field). Re-prompt applies.
    ///
    /// # Errors
    /// `NotFound`, `RepromptRequired`, `BadCredentials`, `Invalid`.
    pub fn totp_code(&mut self, id: &str, field: Option<&str>, password: Option<&str>) -> Result<TotpCode> {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        self.totp_code_at(id, field, password, now)
    }

    /// [`Vault::totp_code`] at a Unix time.
    ///
    /// # Errors
    /// As [`Vault::totp_code`].
    pub fn totp_code_at(&mut self, id: &str, field: Option<&str>, password: Option<&str>, unix: u64) -> Result<TotpCode> {
        let uid = Self::parse_id(id)?;
        self.check_reprompt(&uid, password)?;
        let item = &self.items.get(&uid).ok_or(CoreError::NotFound)?.item;
        let value = match field {
            Some(r) => Self::resolve(item, r)?.0,
            None => item.fields.iter().find(|f| f.kind == FieldKind::Totp && !f.value.is_empty()).map(|f| f.value.as_str()).ok_or(CoreError::NotFound)?,
        };
        Ok(Totp::parse(value)?.code_at(unix))
    }

    /// `item_password_history`, masked. Re-prompt applies.
    ///
    /// # Errors
    /// `NotFound`, `RepromptRequired`, `BadCredentials`.
    pub fn item_password_history(&mut self, id: &str, password: Option<&str>) -> Result<Vec<PasswordHistoryEntry>> {
        let uid = Self::parse_id(id)?;
        self.check_reprompt(&uid, password)?;
        let item = &self.items[&uid].item;
        Ok(item
            .password_history
            .iter()
            .map(|h| PasswordHistoryEntry { id: h.id.clone(), changed_at: h.changed_at.clone(), length: h.value.chars().count() })
            .collect())
    }

    /// `item_revisions`, newest first. Re-prompt applies.
    ///
    /// # Errors
    /// `NotFound`, `RepromptRequired`, `BadCredentials`.
    pub fn item_revisions(&mut self, id: &str, password: Option<&str>) -> Result<Vec<Revision>> {
        let uid = Self::parse_id(id)?;
        self.check_reprompt(&uid, password)?;
        Ok(self.items[&uid]
            .item
            .revisions
            .iter()
            .map(|r| Revision { rev: r.rev, saved_at: r.saved_at.clone(), title: r.snapshot.title.clone() })
            .collect())
    }

    /// `item_open_url`: the stored URL at `url_index`, only when it is
    /// `http://` or `https://`.
    ///
    /// # Errors
    /// `NotFound`; `Invalid` for any other scheme.
    pub fn item_url_for_open(&self, id: &str, url_index: usize) -> Result<String> {
        let item = &self.slot(id)?.item;
        let u = item.urls.get(url_index).ok_or(CoreError::NotFound)?;
        match crate::model::url_scheme(&u.url).as_deref() {
            Some("http") | Some("https") => Ok(u.url.trim().to_owned()),
            _ => Err(CoreError::invalid("Coffer opens only http:// and https:// links.")),
        }
    }

    // ------------------------------------------------------------ items: write

    fn bump(&mut self, id: &Uuid) {
        let now = now_str();
        if let Some(s) = self.items.get_mut(id) {
            s.rev += 1;
            s.enc = None;
            s.item.updated_at = now;
        }
    }

    fn touch_meta(&mut self) {
        self.meta_rev += 1;
        self.meta_enc = None;
    }

    /// `true` when saving `input` would weaken re-prompt (turn it off, or
    /// change the kind of a secret field) and so needs the password or a
    /// grant. `false` for a new item.
    ///
    /// # Errors
    /// `NotFound` for an unknown id.
    pub fn save_needs_password(&self, input: &ItemInput) -> Result<bool> {
        let Some(id) = input.id.as_deref() else { return Ok(false) };
        let old = &self.slot(id)?.item;
        Ok(Self::weakens(old, input.reprompt, input.fields.iter().map(|f| (f.id.as_str(), f.kind))))
    }

    fn weakens<'a>(old: &StoredItem, new_reprompt: bool, new_fields: impl Iterator<Item = (&'a str, FieldKind)>) -> bool {
        if !old.reprompt {
            return false;
        }
        if !new_reprompt {
            return true;
        }
        let kinds: HashMap<&str, FieldKind> = new_fields.collect();
        old.fields
            .iter()
            .filter(|f| f.kind.is_secret())
            .any(|f| kinds.get(f.id.as_str()).is_some_and(|k| *k != f.kind))
    }

    /// `item_save`: create (no id) or update (id + base_rev). Keeps password
    /// history (last 20), revisions (last 10) and `password_changed_at`.
    /// A field with `value: None` keeps the stored value; that is valid only
    /// for an existing field id whose kind is unchanged.
    ///
    /// # Errors
    /// `NotFound`; `Conflict` for a stale base rev; `Invalid` for a bad
    /// field; `RepromptRequired` / `BadCredentials` when the save weakens
    /// re-prompt.
    pub fn item_save(&mut self, input: &ItemInput, password: Option<&str>) -> Result<ItemView> {
        let now = now_str();
        let existing_id = match input.id.as_deref() {
            Some(s) if !s.is_empty() => Some(Self::parse_id(s)?),
            _ => None,
        };
        if let Some(uid) = existing_id {
            let slot = self.items.get(&uid).ok_or(CoreError::NotFound)?;
            if let Some(base) = input.base_rev
                && base != slot.rev
            {
                return Err(CoreError::Conflict("This item changed on disk.".into()));
            }
            if self.save_needs_password(input)? {
                self.require_password_or_grant(&uid, password)?;
            }
        }
        let title = input.title.trim();
        if title.is_empty() {
            return Err(CoreError::invalid("An item needs a title."));
        }
        let old: Option<StoredItem> = existing_id.map(|u| self.items[&u].item.clone());
        // Fields.
        let mut fields: Vec<StoredField> = Vec::with_capacity(input.fields.len());
        for fi in &input.fields {
            let prev = old.as_ref().and_then(|o| o.fields.iter().find(|f| !fi.id.is_empty() && f.id == fi.id));
            let value = match &fi.value {
                Some(v) => v.clone(),
                None => match prev {
                    Some(p) if p.kind == fi.kind => p.value.clone(),
                    _ => {
                        return Err(CoreError::invalid(
                            "A field with no value must be an existing field whose kind does not change.",
                        ));
                    }
                },
            };
            let id = if !fi.id.is_empty() && !fields.iter().any(|f| f.id == fi.id) { fi.id.clone() } else { Uuid::new_v4().to_string() };
            let options = if fi.kind == FieldKind::Menu {
                fi.options.clone().or_else(|| fi.builtin.as_deref().and_then(crate::templates::menu_options).map(|o| o.iter().map(|s| (*s).to_owned()).collect()))
            } else {
                None
            };
            fields.push(StoredField {
                id,
                label: fi.label.clone(),
                kind: fi.kind,
                value,
                section: fi.section.clone().filter(|s| !s.trim().is_empty()),
                builtin: fi.builtin.clone().filter(|s| !s.is_empty()),
                options,
            });
        }
        let mut item = match &old {
            Some(o) => o.clone(),
            None => {
                let mut n = StoredItem::new(input.item_type, title, &now);
                n.fields.clear();
                n
            }
        };
        let old_pw: Zeroizing<String> = Zeroizing::new(old.as_ref().map(|o| o.password().to_owned()).unwrap_or_default());
        if let Some(o) = &old {
            item.revisions.insert(0, RevisionRecord { rev: self.items[&o.id].rev, saved_at: o.updated_at.clone(), snapshot: o.snapshot() });
            item.revisions.truncate(REVISIONS_MAX);
        }
        item.item_type = input.item_type;
        item.title = title.to_owned();
        item.favorite = input.favorite;
        item.tags = clean_tags(&input.tags);
        item.fields = fields;
        item.notes = input.notes.clone();
        item.urls = input.urls.iter().filter(|u| !u.url.trim().is_empty()).map(|u| ItemUrl { url: u.url.trim().to_owned(), label: u.label.clone() }).collect();
        item.apps = input.apps.iter().map(|a| a.trim().to_ascii_lowercase()).filter(|a| !a.is_empty()).collect();
        item.reprompt = input.reprompt;
        item.autotype_sequence = input.autotype_sequence.clone().filter(|s| !s.trim().is_empty());
        item.health_excluded = input.health_excluded;
        item.updated_at = now.clone();
        let new_pw: Zeroizing<String> = Zeroizing::new(item.password().to_owned());
        if *new_pw != *old_pw {
            if !old_pw.is_empty() {
                item.password_history.insert(0, HistoryValue { id: Uuid::new_v4().to_string(), value: (*old_pw).clone(), changed_at: now.clone() });
                item.password_history.truncate(PASSWORD_HISTORY_MAX);
            }
            if !new_pw.is_empty() {
                item.password_changed_at = Some(now.clone());
            }
        }
        // Generated values saved into the item enter generator history.
        let secret_values: Zeroizing<Vec<String>> = Zeroizing::new(item.fields.iter().filter(|f| f.kind.is_secret()).map(|f| f.value.clone()).collect());
        for v in secret_values.iter() {
            if let Some(pos) = self.generated.iter().position(|g| &g.value == v) {
                let g = self.generated.remove(pos);
                self.push_history(&g.value, g.mode);
            }
        }
        let uid = item.id;
        let rev = existing_id.map(|u| self.items[&u].rev + 1).unwrap_or(1);
        self.items.insert(uid, ItemSlot { rev, item, enc: None });
        self.refresh_health();
        self.item_get(&uid.to_string())
    }

    /// `item_patch`: favourite, tags, health exclusion. No revision snapshot.
    ///
    /// # Errors
    /// `NotFound`.
    pub fn item_patch(&mut self, id: &str, favorite: Option<bool>, tags: Option<&[String]>, health_excluded: Option<bool>) -> Result<ItemSummary> {
        let uid = Self::parse_id(id)?;
        let slot = self.items.get_mut(&uid).ok_or(CoreError::NotFound)?;
        if let Some(f) = favorite {
            slot.item.favorite = f;
        }
        if let Some(t) = tags {
            slot.item.tags = clean_tags(t);
        }
        if let Some(h) = health_excluded {
            slot.item.health_excluded = h;
        }
        self.bump(&uid);
        self.refresh_health();
        Ok(self.summary(&self.items[&uid]))
    }

    fn set_state_inner(&mut self, uid: &Uuid, state: ItemState) -> bool {
        let now = now_str();
        let Some(slot) = self.items.get_mut(uid) else { return false };
        if slot.item.state == state {
            return false;
        }
        slot.item.state = state;
        slot.item.trashed_at = if state == ItemState::Trashed { Some(now) } else { None };
        self.bump(uid);
        true
    }

    /// `item_set_state`: active, archived or trashed (sets `trashed_at`).
    ///
    /// # Errors
    /// `NotFound`.
    pub fn item_set_state(&mut self, id: &str, state: ItemState) -> Result<()> {
        let uid = Self::parse_id(id)?;
        if !self.items.contains_key(&uid) {
            return Err(CoreError::NotFound);
        }
        self.set_state_inner(&uid, state);
        self.refresh_health();
        Ok(())
    }

    /// `items_bulk`: returns how many items changed. Unknown ids are skipped.
    ///
    /// # Errors
    /// `Invalid` when a tag action has no tag.
    pub fn items_bulk(&mut self, ids: &[String], action: BulkAction, tag: Option<&str>) -> Result<usize> {
        let tag = tag.map(str::trim).filter(|t| !t.is_empty());
        if matches!(action, BulkAction::AddTag | BulkAction::RemoveTag) && tag.is_none() {
            return Err(CoreError::invalid("Choose a tag."));
        }
        let mut n = 0;
        for id in ids {
            let Ok(uid) = Self::parse_id(id) else { continue };
            if !self.items.contains_key(&uid) {
                continue;
            }
            let changed = match action {
                BulkAction::Archive => self.set_state_inner(&uid, ItemState::Archived),
                BulkAction::Trash => self.set_state_inner(&uid, ItemState::Trashed),
                BulkAction::Restore => self.set_state_inner(&uid, ItemState::Active),
                BulkAction::AddTag | BulkAction::RemoveTag => {
                    let t = tag.expect("checked").to_owned();
                    let item = &mut self.items.get_mut(&uid).expect("checked").item;
                    let had = item.tags.contains(&t);
                    let change = if action == BulkAction::AddTag {
                        if !had {
                            item.tags.push(t);
                        }
                        !had
                    } else {
                        item.tags.retain(|x| *x != t);
                        had
                    };
                    if change {
                        self.bump(&uid);
                    }
                    change
                }
            };
            if changed {
                n += 1;
            }
        }
        self.refresh_health();
        Ok(n)
    }

    fn remove_item(&mut self, uid: &Uuid) -> bool {
        if self.items.remove(uid).is_some() {
            self.grants.remove(uid);
            self.weak_cache.remove(uid);
            let s = uid.to_string();
            let before = self.meta.breach_cache.len();
            self.meta.breach_cache.retain(|e| e.item_id != s);
            if self.meta.breach_cache.len() != before {
                self.touch_meta();
            }
            true
        } else {
            false
        }
    }

    /// `item_delete_forever`.
    ///
    /// # Errors
    /// `NotFound`.
    pub fn item_delete_forever(&mut self, id: &str) -> Result<()> {
        let uid = Self::parse_id(id)?;
        if !self.remove_item(&uid) {
            return Err(CoreError::NotFound);
        }
        self.refresh_health();
        Ok(())
    }

    /// `trash_empty`: deletes every trashed item; returns the count.
    pub fn trash_empty(&mut self) -> usize {
        let ids: Vec<Uuid> = self.items.iter().filter(|(_, s)| s.item.state == ItemState::Trashed).map(|(k, _)| *k).collect();
        for id in &ids {
            self.remove_item(id);
        }
        self.refresh_health();
        ids.len()
    }

    /// Deletes items trashed 30 days ago or more; returns the count. Call
    /// after unlock and save when it is not 0.
    pub fn purge_expired_trash(&mut self) -> usize {
        self.purge_expired_trash_at(time_util::now())
    }

    /// [`Vault::purge_expired_trash`] at a given time.
    pub fn purge_expired_trash_at(&mut self, now: OffsetDateTime) -> usize {
        let ids: Vec<Uuid> = self
            .items
            .iter()
            .filter(|(_, s)| {
                s.item.state == ItemState::Trashed
                    && s.item.trashed_at.as_deref().and_then(time_util::parse).is_some_and(|t| now - t >= Duration::days(TRASH_DAYS))
            })
            .map(|(k, _)| *k)
            .collect();
        for id in &ids {
            self.remove_item(id);
        }
        if !ids.is_empty() {
            self.refresh_health();
        }
        ids.len()
    }

    /// `item_restore_revision`: makes a snapshot the current content (the
    /// current content becomes a revision). Needs the password or a grant
    /// when it would weaken re-prompt.
    ///
    /// # Errors
    /// `NotFound`, `RepromptRequired`, `BadCredentials`.
    pub fn item_restore_revision(&mut self, id: &str, rev: u64, password: Option<&str>) -> Result<ItemView> {
        let uid = Self::parse_id(id)?;
        let slot = self.items.get(&uid).ok_or(CoreError::NotFound)?;
        let snap = slot.item.revisions.iter().find(|r| r.rev == rev).ok_or(CoreError::NotFound)?.snapshot.clone();
        let current_rev = slot.rev;
        let weakens = Self::weakens(&slot.item, snap.reprompt, snap.fields.iter().map(|f| (f.id.as_str(), f.kind)));
        if weakens {
            self.require_password_or_grant(&uid, password)?;
        }
        let input = ItemInput {
            id: Some(id.to_owned()),
            base_rev: Some(current_rev),
            item_type: snap.item_type,
            title: snap.title.clone(),
            favorite: snap.favorite,
            tags: snap.tags.clone(),
            fields: snap
                .fields
                .iter()
                .map(|f| FieldInput {
                    id: f.id.clone(),
                    label: f.label.clone(),
                    kind: f.kind,
                    value: Some(f.value.clone()),
                    section: f.section.clone(),
                    builtin: f.builtin.clone(),
                    options: f.options.clone(),
                })
                .collect(),
            notes: snap.notes.clone(),
            urls: snap.urls.clone(),
            apps: snap.apps.clone(),
            reprompt: snap.reprompt,
            autotype_sequence: snap.autotype_sequence.clone(),
            health_excluded: snap.health_excluded,
        };
        // The inner save repeats the same weakening check; a grant made
        // above covers it.
        self.item_save(&input, None)
    }

    // ------------------------------------------------------------ generator

    fn push_history(&mut self, value: &str, mode: GeneratorMode) {
        if self.meta.generator_history.first().is_some_and(|h| h.value == value) {
            return;
        }
        self.meta.generator_history.insert(
            0,
            GeneratedValue { id: Uuid::new_v4().to_string(), value: value.to_owned(), created_at: now_str(), mode },
        );
        self.meta.generator_history.truncate(GENERATOR_HISTORY_MAX);
        self.touch_meta();
    }

    /// `generate` while unlocked: makes a value, remembers it in memory (it
    /// enters history only when copied or saved into an item) and keeps the
    /// options as the last options.
    ///
    /// # Errors
    /// `Invalid` for bad options.
    pub fn generate(&mut self, opts: &GeneratorOptions) -> Result<Generated> {
        let g = crate::generator::generate(opts)?;
        self.generated.insert(0, PendingGenerated { value: g.value.clone(), mode: opts.mode });
        self.generated.truncate(GENERATOR_HISTORY_MAX);
        if self.meta.generator_options.as_ref() != Some(opts) {
            self.meta.generator_options = Some(opts.clone());
            self.touch_meta();
        }
        Ok(g)
    }

    /// The last generator options (the tray's "Copy a new password").
    pub fn generator_options(&self) -> GeneratorOptions {
        self.meta.generator_options.clone().unwrap_or_default()
    }

    /// `generator_copy`: the value was copied, so it enters history.
    pub fn generator_copied(&mut self, value: &str) {
        let mode = match self.generated.iter().position(|g| g.value == value) {
            Some(pos) => self.generated.remove(pos).mode,
            None => GeneratorMode::Random,
        };
        self.push_history(value, mode);
    }

    /// `generator_history`, masked, newest first.
    pub fn generator_history(&self) -> Vec<GeneratedHistoryEntry> {
        self.meta
            .generator_history
            .iter()
            .map(|h| GeneratedHistoryEntry { id: h.id.clone(), created_at: h.created_at.clone(), length: h.value.chars().count(), mode: h.mode })
            .collect()
    }

    /// `generator_history_reveal` / `generator_history_copy`.
    ///
    /// # Errors
    /// `NotFound`.
    pub fn generator_history_value(&self, id: &str) -> Result<Zeroizing<String>> {
        self.meta.generator_history.iter().find(|h| h.id == id).map(|h| Zeroizing::new(h.value.clone())).ok_or(CoreError::NotFound)
    }

    /// `generator_history_clear`.
    pub fn generator_history_clear(&mut self) {
        if !self.meta.generator_history.is_empty() {
            self.meta.generator_history.clear();
            self.touch_meta();
        }
        self.generated.clear();
    }

    // ------------------------------------------------------------ health

    fn refresh_health(&mut self) {
        let refs: Vec<&StoredItem> = self.items.values().map(|s| &s.item).collect();
        let cache = &mut self.weak_cache;
        let mut weak = |item: &StoredItem| -> u8 {
            let inputs = health::weak_inputs(item);
            let mut h = Sha256::new();
            h.update(item.password().as_bytes());
            for i in &inputs {
                h.update([0u8]);
                h.update(i.as_bytes());
            }
            let key: [u8; 32] = h.finalize().into();
            if let Some((k, s)) = cache.get(&item.id)
                && *k == key
            {
                return *s;
            }
            let refs: Vec<&str> = inputs.iter().map(String::as_str).collect();
            let s = crate::strength::score(item.password(), &refs);
            cache.insert(item.id, (key, s));
            s
        };
        self.analysis = health::analyze(&refs, &self.meta.breach_cache, time_util::now(), &mut weak);
    }

    /// `health_report` (and `health_check_breaches` after
    /// [`Vault::apply_breach_results`]). `breach_check` is the setting.
    pub fn health_report(&self, breach_check: BreachMode) -> HealthReport {
        health::report(&self.analysis, breach_check, self.meta.breach_checked_at.clone())
    }

    /// The SHA-1 prefixes to send (one request per distinct prefix) for
    /// every active, not-excluded login and password item with a password.
    pub fn breach_queries(&self) -> Vec<BreachQuery> {
        self.items
            .values()
            .map(|s| &s.item)
            .filter(|i| i.state == ItemState::Active && !i.health_excluded && matches!(i.item_type, ItemType::Login | ItemType::Password))
            .filter(|i| !i.password().is_empty())
            .map(|i| {
                let (prefix, suffix) = sha1_prefix_suffix(i.password());
                BreachQuery { item_id: i.id.to_string(), prefix, suffix }
            })
            .collect()
    }

    /// Stores breach results (item id, count) keyed by item id + SHA-256 of
    /// the item's current password, and the check time.
    pub fn apply_breach_results(&mut self, results: &[(String, u64)], checked_at: &str) {
        for (id, count) in results {
            let Ok(uid) = Self::parse_id(id) else { continue };
            let Some(slot) = self.items.get(&uid) else { continue };
            let digest = health::password_sha256(slot.item.password());
            self.meta.breach_cache.retain(|e| e.item_id != *id);
            self.meta.breach_cache.push(BreachCacheEntry { item_id: id.clone(), password_sha256: digest, count: *count });
        }
        let live: Vec<String> = self.items.keys().map(Uuid::to_string).collect();
        self.meta.breach_cache.retain(|e| live.contains(&e.item_id));
        self.meta.breach_checked_at = Some(checked_at.to_owned());
        self.touch_meta();
        self.refresh_health();
    }

    // ------------------------------------------------------------ suggestions

    /// Quick Access suggestions (SPEC 9) for the window that was in front.
    /// `learned` = item ids usage.json links to the process; `last_used` =
    /// item id -> last use time.
    pub fn suggestions(&self, window_title: Option<&str>, process: Option<&str>, learned: &[String], last_used: &HashMap<String, String>) -> Vec<String> {
        let refs: Vec<&StoredItem> = self.items.values().map(|s| &s.item).collect();
        crate::suggest::suggest(&refs, window_title, process, learned, last_used)
    }

    // ------------------------------------------------------------ crate-internal access

    pub(crate) fn own_secret_key(&self) -> &SecretKey {
        &self.secret_key
    }

    pub(crate) fn stored_items(&self) -> impl Iterator<Item = &StoredItem> {
        self.items.values().map(|s| &s.item)
    }

    pub(crate) fn insert_new_items(&mut self, items: Vec<StoredItem>) {
        for it in items {
            self.items.insert(it.id, ItemSlot { rev: 1, item: it, enc: None });
        }
        self.refresh_health();
    }

    pub(crate) fn trash_batch(&mut self, batch_id: &str) -> usize {
        let ids: Vec<Uuid> = self
            .items
            .iter()
            .filter(|(_, s)| s.item.import_batch.as_deref() == Some(batch_id) && s.item.state != ItemState::Trashed)
            .map(|(k, _)| *k)
            .collect();
        for id in &ids {
            self.set_state_inner(id, ItemState::Trashed);
        }
        self.refresh_health();
        ids.len()
    }

    #[cfg(test)]
    pub(crate) fn grant_count(&self) -> usize {
        self.grants.len()
    }
}

#[cfg(test)]
mod tests;
