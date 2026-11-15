//! Auto update (SPEC 3.12).
//!
//! Every 6 hours (the first time 45 s after start) Coffer reads `latest.json`
//! from the newest GitHub release, downloads the installer and checks its
//! signature with the public key built into Coffer (`plugins.updater.pubkey`
//! in tauri.conf.json). The checked bytes wait in memory. They install when the
//! user locks Coffer (Lock, auto-lock, Windows lock, sleep), when Coffer is
//! locked with no window open, or at once on "Restart now". Never while the
//! vault is unlocked. The NSIS installer replaces Coffer and starts it again,
//! locked.
//!
//! The plugin does the HTTP, the minisign check and the installer start; this
//! module decides when. The webview gets no updater permission: it calls only
//! `update_status`, `update_check` and `update_install`.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Url};
use tauri_plugin_updater::UpdaterExt;

use crate::contract::{LockReason, UpdatePhase, UpdateState, events};
use crate::error::{CofferError, CofferResult};
use crate::state::{AppState, LockExt, RwExt};

/// Coffer's own identifier. A copy with another identifier (a QA copy) updates
/// only from a server on this PC, so it can never install the real Coffer.
pub const PRODUCT_ID: &str = "dev.sampo.coffer";
/// The `pubkey` in tauri.conf.json until Sam makes the signing key. With it,
/// Coffer does not update and `scripts/release.mjs build` refuses to run.
pub const PUBKEY_PLACEHOLDER: &str = "NOT-SET-run-scripts-make-update-key-mjs-then-paste-coffer-updater-key-pub-here";
pub const FIRST_CHECK_AFTER: Duration = Duration::from_secs(45);
pub const CHECK_EVERY: Duration = Duration::from_secs(6 * 3600);
pub const RETRY_AFTER_ERROR: Duration = Duration::from_secs(30 * 60);
/// How often the update thread wakes. It compares wall-clock times, so a PC
/// that slept past a check time checks soon after it wakes.
const TICK: Duration = Duration::from_secs(30);
/// One request (check or download) may take this long.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);
/// Written just before the installer starts; read once at the next start.
const MARKER: &str = "update-restart.json";
/// A marker older than this is stale (the installer did not restart Coffer).
const MARKER_MAX_AGE: Duration = Duration::from_secs(30 * 60);

// ---------- pure rules (tested) ----------

/// Whether this build may update, from its config. `Err` holds the line the
/// Settings page shows.
pub fn gate(identifier: &str, pubkey: &str, endpoints: &[String], debug: bool) -> Result<(), &'static str> {
    if !is_real_pubkey(pubkey) {
        return Err("This build does not update: it has no update signing key.");
    }
    let urls: Vec<Url> = endpoints.iter().filter_map(|e| Url::parse(e).ok()).collect();
    if urls.is_empty() || urls.len() != endpoints.len() {
        return Err("This build does not update: it has no valid update address.");
    }
    // A test server on this PC: QA copies and debug builds may use it.
    if urls.iter().all(is_loopback) {
        return Ok(());
    }
    if identifier != PRODUCT_ID {
        return Err("This test copy of Coffer updates only from this PC.");
    }
    if debug {
        return Err("A debug build of Coffer does not update from GitHub.");
    }
    if urls.iter().any(|u| u.scheme() != "https") {
        return Err("This build does not update: its update address is not https.");
    }
    Ok(())
}

/// A minisign public key as `tauri signer generate` writes it: base64 of
/// "untrusted comment: ...\n<base64 of "Ed", an 8-byte key id, a 32-byte Ed25519 key>".
/// `scripts/release-lib.mjs` `parsePublicKey` checks the same.
pub fn is_real_pubkey(pubkey: &str) -> bool {
    use base64::engine::general_purpose::STANDARD;
    let key = pubkey.trim();
    if key.is_empty() || key == PUBKEY_PLACEHOLDER {
        return false;
    }
    let Some(text) = STANDARD.decode(key).ok().and_then(|b| String::from_utf8(b).ok()) else { return false };
    let mut lines = text.lines();
    if !lines.next().is_some_and(|l| l.starts_with("untrusted comment:")) {
        return false;
    }
    lines.next().and_then(|l| STANDARD.decode(l.trim()).ok()).is_some_and(|raw| raw.len() == 42 && raw.starts_with(b"Ed"))
}

fn is_loopback(url: &Url) -> bool {
    let Some(host) = url.host_str() else { return false };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    host.eq_ignore_ascii_case("localhost") || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

/// When an install may start.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Moment {
    /// The user locked Coffer, or a lock signal did (auto-lock, Windows lock, sleep).
    Lock(LockReason),
    /// The update thread's timer, with whether a Coffer window is open.
    Tick { window_open: bool },
    /// The user clicked "Restart now" (Coffer locks first).
    RestartNow,
}

/// The one install rule. Never while the vault is unlocked. "Restart now"
/// always installs a ready update. With "Install updates automatically" off
/// nothing else does. A lock installs, except quit and sign-out (Coffer is
/// going away) and a key change (a lock the user did not cause). A locked
/// Coffer with no window open installs on the timer.
pub fn should_install(moment: Moment, unlocked: bool, auto_install: bool, ready: bool) -> bool {
    if !ready || unlocked {
        return false;
    }
    match moment {
        Moment::RestartNow => true,
        _ if !auto_install => false,
        Moment::Lock(reason) => matches!(reason, LockReason::Manual | LockReason::Idle | LockReason::SystemLock | LockReason::Sleep),
        Moment::Tick { window_open } => !window_open,
    }
}

/// Whether the timer runs a check now.
pub fn check_due(now: SystemTime, started: SystemTime, last_attempt: Option<SystemTime>, last_failed: bool) -> bool {
    let (from, wait) = match last_attempt {
        None => (started, FIRST_CHECK_AFTER),
        Some(t) => (t, if last_failed { RETRY_AFTER_ERROR } else { CHECK_EVERY }),
    };
    match now.duration_since(from) {
        Ok(elapsed) => elapsed >= wait,
        // The clock went back: check, and start counting again from now.
        Err(_) => last_attempt.is_some(),
    }
}

/// What went wrong, for the one line in Settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    /// The signature did not verify, or it was made for another version: refused.
    Signature,
    Network,
    /// latest.json is missing or has no Windows entry.
    Manifest,
    Other,
}

pub fn failure_of(e: &tauri_plugin_updater::Error) -> Failure {
    use tauri_plugin_updater::Error as E;
    match e {
        E::Minisign(_) | E::Base64(_) | E::SignatureUtf8(_) | E::SignedVersionMismatch { .. } | E::MissingSignedVersion => Failure::Signature,
        E::Reqwest(_) | E::Network(_) => Failure::Network,
        E::ReleaseNotFound | E::Serialization(_) | E::TargetNotFound(_) | E::TargetsNotFound(_) | E::Semver(_) | E::UrlParse(_) => Failure::Manifest,
        _ => Failure::Other,
    }
}

pub fn failure_line(failure: Failure, version: Option<&str>) -> String {
    let named = version.map(|v| format!("Coffer {v}")).unwrap_or_else(|| "The update".to_string());
    match failure {
        Failure::Signature => format!("{named} failed its signature check, so Coffer refused it."),
        Failure::Network => "Coffer could not reach GitHub to check for updates.".to_string(),
        Failure::Manifest => "Coffer could not read the update information on GitHub.".to_string(),
        Failure::Other => "The update check failed. The log has the details.".to_string(),
    }
}

// ---------- state ----------

struct Held {
    update: tauri_plugin_updater::Update,
    bytes: Vec<u8>,
}

struct Inner {
    state: UpdateState,
    held: Option<Held>,
    started: SystemTime,
    last_attempt: Option<SystemTime>,
    last_failed: bool,
    checking: bool,
    /// An automatic install of this version could not start: only "Restart now" tries again.
    failed_install: Option<String>,
}

/// Managed by Tauri (`app.manage`).
pub struct Updates {
    inner: Mutex<Inner>,
}

impl Default for Updates {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner {
                state: UpdateState { phase: UpdatePhase::Off, current_version: String::new(), version: None, checked_at: None, error: None },
                held: None,
                started: SystemTime::now(),
                last_attempt: None,
                last_failed: false,
                checking: false,
                failed_install: None,
            }),
        }
    }
}

fn emit(app: &AppHandle, state: &UpdateState) {
    let _ = app.emit(events::UPDATE_STATE, state.clone());
}

/// The updater part of tauri.conf.json (after `TAURI_CONFIG`).
fn updater_config(app: &AppHandle) -> (String, Vec<String>) {
    let conf = app.config().plugins.0.get("updater").cloned().unwrap_or_default();
    let pubkey = conf.get("pubkey").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let endpoints = conf.get("endpoints").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|e| e.as_str().map(str::to_string)).collect()).unwrap_or_default();
    (pubkey, endpoints)
}

/// At start: decide whether this build updates, then run the timer thread.
pub fn start(app: &AppHandle) {
    let (pubkey, endpoints) = updater_config(app);
    let allowed = gate(&app.config().identifier, &pubkey, &endpoints, cfg!(debug_assertions));
    {
        let updates = app.state::<Updates>();
        let mut inner = updates.inner.lck();
        inner.state.current_version = app.package_info().version.to_string();
        inner.started = SystemTime::now();
        match allowed {
            Ok(()) => inner.state.phase = UpdatePhase::Idle,
            Err(why) => {
                inner.state.phase = UpdatePhase::Off;
                inner.state.error = Some(why.to_string());
            }
        }
    }
    match allowed {
        Ok(()) => crate::log!("update: on, {} address(es)", endpoints.len()),
        Err(why) => {
            crate::log!("update: off ({why})");
            return;
        }
    }
    let app = app.clone();
    let _ = std::thread::Builder::new().name("coffer-updates".into()).spawn(move || {
        loop {
            std::thread::sleep(TICK);
            let due = {
                let updates = app.state::<Updates>();
                let inner = updates.inner.lck();
                !inner.checking && inner.state.phase != UpdatePhase::Installing && check_due(SystemTime::now(), inner.started, inner.last_attempt, inner.last_failed)
            };
            if due {
                tauri::async_runtime::block_on(check(&app));
            }
            try_install(&app, None);
        }
    });
}

pub fn status(app: &AppHandle) -> UpdateState {
    app.state::<Updates>().inner.lck().state.clone()
}

/// Check now: read latest.json, and download and verify a newer version.
/// Returns the state after the check. One check runs at a time.
pub async fn check(app: &AppHandle) -> UpdateState {
    let held_version = {
        let updates = app.state::<Updates>();
        let mut inner = updates.inner.lck();
        if inner.checking || matches!(inner.state.phase, UpdatePhase::Off | UpdatePhase::Installing) {
            return inner.state.clone();
        }
        inner.checking = true;
        inner.last_attempt = Some(SystemTime::now());
        inner.state.error = None;
        if inner.held.is_none() {
            inner.state.phase = UpdatePhase::Checking;
        }
        emit(app, &inner.state);
        inner.held.as_ref().map(|h| h.update.version.clone())
    };
    let outcome = run_check(app, held_version.as_deref()).await;
    let updates = app.state::<Updates>();
    let mut inner = updates.inner.lck();
    inner.checking = false;
    match outcome {
        Ok(found) => {
            inner.last_failed = false;
            inner.state.checked_at = Some(crate::clock::now_iso());
            if let Some(held) = found {
                crate::log!("update: {} downloaded, signature checked", held.update.version);
                inner.held = Some(held);
            }
        }
        Err((failure, version, detail)) => {
            inner.last_failed = true;
            inner.state.error = Some(failure_line(failure, version.as_deref()));
            match failure {
                Failure::Signature => crate::log!("update: REFUSED {}: the signature check failed: {detail}", version.as_deref().unwrap_or("?")),
                _ => crate::log!("update: check failed ({failure:?}): {detail}"),
            }
        }
    }
    match inner.held.as_ref().map(|h| h.update.version.clone()) {
        Some(v) => {
            inner.state.phase = UpdatePhase::Ready;
            inner.state.version = Some(v);
        }
        None => {
            inner.state.phase = UpdatePhase::Idle;
            inner.state.version = None;
        }
    }
    emit(app, &inner.state);
    inner.state.clone()
}

type CheckError = (Failure, Option<String>, String);

/// `Ok(None)`: no newer version, or the newest is the one already held.
async fn run_check(app: &AppHandle, held_version: Option<&str>) -> Result<Option<Held>, CheckError> {
    let fail = |e: tauri_plugin_updater::Error, v: Option<String>| (failure_of(&e), v, e.to_string());
    let updater = app.updater_builder().timeout(REQUEST_TIMEOUT).build().map_err(|e| fail(e, None))?;
    let Some(update) = updater.check().await.map_err(|e| fail(e, None))? else {
        return Ok(None);
    };
    if held_version == Some(update.version.as_str()) {
        return Ok(None);
    }
    {
        let updates = app.state::<Updates>();
        let mut inner = updates.inner.lck();
        inner.state.phase = UpdatePhase::Downloading;
        inner.state.version = Some(update.version.clone());
        emit(app, &inner.state);
    }
    crate::log!("update: {} found, downloading", update.version);
    // `download` checks the signature against the built-in key before it returns.
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| fail(e, Some(update.version.clone())))?;
    Ok(Some(Held { update, bytes }))
}

/// After a lock the user caused (see `lock::lock_by_user`).
pub fn after_lock(app: &AppHandle, reason: LockReason) {
    let ready = app.state::<Updates>().inner.lck().held.is_some();
    if !ready {
        return;
    }
    // Off this thread: the lock may run on the main thread, and the install
    // asks the main thread about the windows.
    let app = app.clone();
    let _ = std::thread::Builder::new().name("coffer-update-install".into()).spawn(move || try_install(&app, Some(Moment::Lock(reason))));
}

/// "Restart now": lock, then install the ready update.
pub fn restart_now(app: &AppHandle) -> CofferResult<()> {
    if app.state::<Updates>().inner.lck().held.is_none() {
        return Err(CofferError::invalid("No update is ready to install."));
    }
    crate::lock::lock(app, LockReason::Manual);
    if try_install(app, Some(Moment::RestartNow)) { Ok(()) } else { Err(CofferError::io("Coffer could not start the installer. The log has the details.")) }
}

fn window_open(app: &AppHandle) -> bool {
    [crate::shell::MAIN, crate::shell::QUICK].iter().any(|label| app.get_webview_window(label).and_then(|w| w.is_visible().ok()).unwrap_or(false))
}

/// Install the held update when `should_install` says so. `None` is the
/// timer. Returns whether the installer started (on Windows the process then
/// exits, so `true` is seen only when the install failed to exit).
fn try_install(app: &AppHandle, moment: Option<Moment>) -> bool {
    let state = app.state::<AppState>();
    let updates = app.state::<Updates>();
    let auto = state.settings.rd().settings.auto_update;
    {
        let inner = updates.inner.lck();
        let Some(held) = inner.held.as_ref() else { return false };
        let restart_now = moment == Some(Moment::RestartNow);
        if !restart_now && (!auto || state.is_unlocked() || inner.failed_install.as_deref() == Some(held.update.version.as_str())) {
            return false;
        }
    }
    // Ask the main thread about the windows with no lock held.
    let main_open = app.get_webview_window(crate::shell::MAIN).and_then(|w| w.is_visible().ok()).unwrap_or(false);
    let moment = moment.unwrap_or_else(|| Moment::Tick { window_open: window_open(app) });
    let held = {
        let mut inner = updates.inner.lck();
        if !should_install(moment, state.is_unlocked(), auto, inner.held.is_some()) {
            return false;
        }
        let held = inner.held.take().expect("held checked above");
        inner.state.phase = UpdatePhase::Installing;
        inner.state.version = Some(held.update.version.clone());
        emit(app, &inner.state);
        held
    };
    let from = app.package_info().version.to_string();
    let to = held.update.version.clone();
    let marker = state.data_dir.join(MARKER);
    let _ = write_marker(&marker, &Marker { from: from.clone(), to: to.clone(), show_main: main_open, at: unix_now() });
    crate::log!("update: installing {to} (from {from}, {moment:?}, mainOpen={main_open})");
    // Take the icon out of the tray now: an exit does not remove it, and
    // Windows would keep a dead icon until the pointer passes over it.
    let tray = state.tray.lck().clone();
    if let Some(t) = tray.as_ref() {
        let _ = t.tray.set_visible(false);
    }
    // Checks the signature again, writes the installer to %TEMP%, starts it
    // (passive: a progress bar, then it starts Coffer again) and exits.
    let result = held.update.install(&held.bytes);
    // Only reached when the installer did not start.
    if let Some(t) = tray.as_ref() {
        let _ = t.tray.set_visible(true);
    }
    let _ = std::fs::remove_file(&marker);
    let detail = result.err().map(|e| e.to_string()).unwrap_or_else(|| "install returned".into());
    crate::log!("update: the installer for {to} did not start: {detail}");
    let mut inner = updates.inner.lck();
    inner.failed_install = Some(to.clone());
    inner.state.phase = UpdatePhase::Ready;
    inner.state.version = Some(to);
    inner.state.error = Some("Coffer could not start the installer. Click Restart now to try again.".into());
    inner.held = Some(held);
    emit(app, &inner.state);
    false
}

// ---------- the restart marker ----------

/// What the old Coffer tells the new one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Marker {
    pub from: String,
    pub to: String,
    /// The main window was open: show it again (locked) after the restart.
    pub show_main: bool,
    /// Unix seconds.
    pub at: u64,
}

fn unix_now() -> u64 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn write_marker(path: &Path, marker: &Marker) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(marker).map_err(std::io::Error::other)?;
    crate::paths::write_atomic(path, &bytes)
}

/// Read and delete the marker. `Some` when this start follows an update the
/// old Coffer started in the last 30 minutes.
pub fn marker_at_start(data_dir: &Path, now_unix: u64) -> Option<Marker> {
    let path: PathBuf = data_dir.join(MARKER);
    let bytes = std::fs::read(&path).ok()?;
    let _ = std::fs::remove_file(&path);
    let marker: Marker = serde_json::from_slice(&bytes).ok()?;
    (now_unix.saturating_sub(marker.at) <= MARKER_MAX_AGE.as_secs()).then_some(marker)
}

/// At start, before the windows show: whether to show the main window when
/// this start follows an update (`None`: a normal start).
pub fn show_main_after_update(data_dir: &Path, current_version: &str) -> Option<bool> {
    let marker = marker_at_start(data_dir, unix_now())?;
    if marker.to == current_version {
        crate::log!("start: updated from {} to {}", marker.from, marker.to);
    } else {
        crate::log!("start: the update to {} did not install; this is {current_version}", marker.to);
    }
    Some(marker.show_main)
}

#[cfg(test)]
mod tests {
    use super::*;

    const GH: &str = "https://github.com/011-sam-110/coffer/releases/latest/download/latest.json";

    /// The shape of a real key (`tauri signer generate`), made up.
    fn fake_pubkey() -> String {
        use base64::engine::general_purpose::STANDARD;
        let mut raw = b"Ed".to_vec();
        raw.extend([7u8; 40]);
        STANDARD.encode(format!("untrusted comment: minisign public key: 0707070707070707\n{}\n", STANDARD.encode(raw)))
    }

    #[test]
    fn unlocked_waits_locked_installs_off_never() {
        let lock = Moment::Lock(LockReason::Manual);
        // Unlocked: wait, whatever the moment.
        for m in [lock, Moment::Tick { window_open: false }, Moment::RestartNow] {
            assert!(!should_install(m, true, true, true), "{m:?}");
        }
        // Locked: install.
        assert!(should_install(lock, false, true, true));
        // Setting off: never by itself; Restart now still installs.
        assert!(!should_install(lock, false, false, true));
        assert!(!should_install(Moment::Tick { window_open: false }, false, false, true));
        assert!(should_install(Moment::RestartNow, false, false, true));
        // Nothing ready: nothing to do.
        assert!(!should_install(Moment::RestartNow, false, true, false));
        assert!(!should_install(lock, false, true, false));
    }

    #[test]
    fn which_locks_install() {
        for (reason, want) in [
            (LockReason::Manual, true),
            (LockReason::Idle, true),
            (LockReason::SystemLock, true),
            (LockReason::Sleep, true),
            (LockReason::Quit, false),
            (LockReason::KeyChanged, false),
        ] {
            assert_eq!(should_install(Moment::Lock(reason), false, true, true), want, "{reason:?}");
        }
        // The timer installs only with no Coffer window open.
        assert!(should_install(Moment::Tick { window_open: false }, false, true, true));
        assert!(!should_install(Moment::Tick { window_open: true }, false, true, true));
    }

    #[test]
    fn check_times() {
        let t0 = SystemTime::UNIX_EPOCH + Duration::from_secs(1_800_000_000);
        let at = |s: u64| t0 + Duration::from_secs(s);
        assert!(!check_due(at(44), t0, None, false));
        assert!(check_due(at(45), t0, None, false));
        assert!(!check_due(at(100 + 6 * 3600 - 1), t0, Some(at(100)), false));
        assert!(check_due(at(100 + 6 * 3600), t0, Some(at(100)), false));
        assert!(!check_due(at(100 + 30 * 60 - 1), t0, Some(at(100)), true));
        assert!(check_due(at(100 + 30 * 60), t0, Some(at(100)), true));
        // A clock that went back checks again.
        assert!(check_due(at(50), t0, Some(at(100)), false));
    }

    #[test]
    fn gate_rules() {
        let key = fake_pubkey();
        let gh = vec![GH.to_string()];
        let local = vec!["http://127.0.0.1:5302/latest.json".to_string()];
        assert_eq!(gate(PRODUCT_ID, &key, &gh, false), Ok(()));
        // No real key: off, also for a test server.
        assert!(gate(PRODUCT_ID, PUBKEY_PLACEHOLDER, &gh, false).is_err());
        assert!(gate(PRODUCT_ID, "", &local, true).is_err());
        assert!(gate(PRODUCT_ID, "bm90IGEga2V5", &gh, false).is_err());
        // Two lines, but the key line is not a 42-byte "Ed" key.
        let short = base64::engine::general_purpose::STANDARD.encode("untrusted comment: x\nRWQ=\n");
        assert!(!is_real_pubkey(&short));
        assert!(is_real_pubkey(&key));
        // A QA copy or a debug build never reaches GitHub; a test server on this PC is fine.
        assert!(gate("dev.sampo.coffer.qa2", &key, &gh, false).is_err());
        assert!(gate(PRODUCT_ID, &key, &gh, true).is_err());
        assert_eq!(gate("dev.sampo.coffer.qa2", &key, &local, true), Ok(()));
        assert_eq!(gate("dev.sampo.coffer.qa2", &key, &["http://localhost:5302/latest.json".to_string()], true), Ok(()));
        // A mixed list is not "this PC only".
        assert!(gate("dev.sampo.coffer.qa2", &key, &[local[0].clone(), GH.to_string()], true).is_err());
        // The release build needs https and a valid address.
        assert!(gate(PRODUCT_ID, &key, &["http://example.com/latest.json".to_string()], false).is_err());
        assert!(gate(PRODUCT_ID, &key, &[], false).is_err());
        assert!(gate(PRODUCT_ID, &key, &["not a url".to_string()], false).is_err());
    }

    #[test]
    fn signature_failures_are_refusals() {
        use tauri_plugin_updater::Error as E;
        assert_eq!(failure_of(&E::SignedVersionMismatch { signed: "0.3.1".into(), announced: "0.3.2".into() }), Failure::Signature);
        assert_eq!(failure_of(&E::MissingSignedVersion), Failure::Signature);
        assert_eq!(failure_of(&E::SignatureUtf8("x".into())), Failure::Signature);
        assert_eq!(failure_of(&E::Network("404".into())), Failure::Network);
        assert_eq!(failure_of(&E::ReleaseNotFound), Failure::Manifest);
        assert_eq!(failure_of(&E::EmptyEndpoints), Failure::Other);
        assert_eq!(failure_line(Failure::Signature, Some("0.3.2")), "Coffer 0.3.2 failed its signature check, so Coffer refused it.");
        assert_eq!(failure_line(Failure::Network, None), "Coffer could not reach GitHub to check for updates.");
    }

    #[test]
    fn state_shape_on_the_wire() {
        let s = UpdateState { phase: UpdatePhase::Ready, current_version: "0.3.0".into(), version: Some("0.3.1".into()), checked_at: Some("2026-11-15T12:00:00Z".into()), error: None };
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            serde_json::json!({ "phase": "ready", "currentVersion": "0.3.0", "version": "0.3.1", "checkedAt": "2026-11-15T12:00:00Z", "error": null })
        );
    }

    #[test]
    fn marker_is_read_once_and_expires() {
        let dir = std::env::temp_dir().join(format!("coffer-update-marker-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let m = Marker { from: "0.3.0".into(), to: "0.3.1".into(), show_main: true, at: 1_800_000_000 };
        write_marker(&dir.join(MARKER), &m).unwrap();
        assert_eq!(marker_at_start(&dir, 1_800_000_000 + 60), Some(m.clone()));
        assert_eq!(marker_at_start(&dir, 1_800_000_000 + 60), None, "deleted after the first read");
        write_marker(&dir.join(MARKER), &m).unwrap();
        assert_eq!(marker_at_start(&dir, 1_800_000_000 + 31 * 60), None, "stale");
        assert!(!dir.join(MARKER).exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
