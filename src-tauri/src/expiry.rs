//! Expiry notices for API keys: one Windows notice 14 days before a key's
//! Expires date, and one on the day (or at the first unlock after it).
//!
//! - Coffer reads dates only while the vault is unlocked: it checks at each
//!   unlock and once a day while unlocked. A notice due while Coffer is locked
//!   comes at the next unlock.
//! - `notices.json` in the data folder keeps only the item id and the notice
//!   sent ("soon" or "day"). No names, no dates.
//! - A key whose date moves out of the 14 days loses its entry, so a new date
//!   gets its own two notices.
//! - Archived, trashed and "left out of health checks" keys get no notice.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use time::{Date, Month};

use crate::contract::{MainView, NavigateEvent};
use crate::state::{AppState, LockExt};

/// Days before the Expires date of the first notice.
pub const SOON_DAYS: i64 = 14;
/// More notices than this at once become one notice that opens Health.
pub const MAX_SINGLE: usize = 3;
/// How often the notices thread looks at the date while unlocked.
const TICK: Duration = Duration::from_secs(15 * 60);

/// The notice sent for a key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Stage {
    /// 14 days (or fewer) before the date.
    Soon,
    /// On the day, or after it.
    Day,
}

/// `notices.json`: item id -> the last notice sent.
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
pub struct NoticeLog {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub sent: BTreeMap<String, Stage>,
}

impl NoticeLog {
    /// Read `notices.json`; a missing or unreadable file starts empty.
    pub fn load(path: &Path) -> Self {
        std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let mut out = self.clone();
        out.version = 1;
        let bytes = serde_json::to_vec_pretty(&out).map_err(std::io::Error::other)?;
        crate::paths::write_atomic(path, &bytes)
    }
}

/// For a key `days` before its date with `sent` already sent: the notice to
/// send now, and the stage to keep in the log (`None` = forget the key).
pub fn decide(days: i64, sent: Option<Stage>) -> (Option<Stage>, Option<Stage>) {
    if days > SOON_DAYS {
        return (None, None);
    }
    if days <= 0 {
        return if sent == Some(Stage::Day) { (None, sent) } else { (Some(Stage::Day), Some(Stage::Day)) };
    }
    // 1 to 14 days. A "day" entry means the date moved later: warn again.
    if sent == Some(Stage::Soon) { (None, sent) } else { (Some(Stage::Soon), Some(Stage::Soon)) }
}

/// One notice to show.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notice {
    pub item_id: String,
    pub title: String,
    pub days: i64,
    pub date: Date,
    pub stage: Stage,
}

/// The notices due for `keys` (id, title, Expires date) on `today`. Updates
/// `log`; entries of ids not in `keys` stay as they are (another vault, or a
/// key that is archived for now).
pub fn plan(keys: &[(String, String, Date)], today: Date, log: &mut NoticeLog) -> Vec<Notice> {
    let mut out = Vec::new();
    for (id, title, date) in keys {
        let days = (*date - today).whole_days();
        let (send, keep) = decide(days, log.sent.get(id).copied());
        match keep {
            Some(stage) => log.sent.insert(id.clone(), stage),
            None => log.sent.remove(id),
        };
        if let Some(stage) = send {
            out.push(Notice { item_id: id.clone(), title: title.clone(), days, date: *date, stage });
        }
    }
    out.sort_by(|a, b| a.days.cmp(&b.days).then_with(|| a.title.cmp(&b.title)));
    out
}

const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/// "29 Nov 2026".
pub fn fmt_day(d: Date) -> String {
    format!("{} {} {}", d.day(), MONTHS[usize::from(u8::from(d.month())) - 1], d.year())
}

fn days_word(n: i64) -> String {
    if n == 1 { "1 day".to_string() } else { format!("{n} days") }
}

/// The two lines of a notice.
pub fn words(n: &Notice) -> (String, String) {
    let title = match n.days {
        d if d > 0 => format!("{} expires in {}", n.title, days_word(d)),
        0 => format!("{} expires today", n.title),
        d => format!("{} expired {} ago", n.title, days_word(-d)),
    };
    let when = if n.days < 0 { "Expired" } else { "Expires" };
    (title, format!("API key. {when} on {}. Click to open it in Coffer.", fmt_day(n.date)))
}

/// The two lines of the one notice that stands for many.
pub fn summary_words(notices: &[Notice]) -> (String, String) {
    let expired = notices.iter().filter(|n| n.days <= 0).count();
    let title = format!("{} API keys expire soon or have expired", notices.len());
    let body = if expired > 0 {
        format!("{expired} of them on or after their date. Click to see them in Coffer.")
    } else {
        "Each one within 14 days. Click to see them in Coffer.".to_string()
    };
    (title, body)
}

// ---------- the notices thread ----------

static WAKE: OnceLock<Mutex<Sender<()>>> = OnceLock::new();

fn log_path(app: &AppHandle) -> PathBuf {
    app.state::<AppState>().data_dir.join("notices.json")
}

fn today() -> Option<Date> {
    let (y, m, d) = crate::win::toast::local_today();
    Date::from_calendar_date(y, Month::try_from(m).ok()?, d).ok()
}

/// Start the thread that checks once a day while unlocked, and at each
/// unlock ([`on_unlock`]).
pub fn start(app: &AppHandle) {
    let (tx, rx) = mpsc::channel::<()>();
    let _ = WAKE.set(Mutex::new(tx));
    let app = app.clone();
    let spawned = std::thread::Builder::new().name("coffer-expiry".into()).spawn(move || {
        crate::win::toast::init_thread();
        // Windows calls a notice's click handler only while the notice object lives.
        let mut alive: Vec<windows::UI::Notifications::ToastNotification> = Vec::new();
        let mut checked_on: Option<Date> = None;
        loop {
            let unlocked_now = match rx.recv_timeout(TICK) {
                Ok(()) => true,
                Err(RecvTimeoutError::Timeout) => false,
                Err(RecvTimeoutError::Disconnected) => return,
            };
            let Some(day) = today() else { continue };
            if !app.state::<AppState>().is_unlocked() || (!unlocked_now && checked_on == Some(day)) {
                continue;
            }
            checked_on = Some(day);
            check(&app, day, &mut alive);
        }
    });
    if let Err(e) = spawned {
        crate::log!("expiry: the notices thread did not start ({e})");
    }
}

/// The vault was unlocked: check now.
pub fn on_unlock() {
    if let Some(tx) = WAKE.get() {
        let _ = tx.lck().send(());
    }
}

fn open_in_coffer(app: &AppHandle, item_id: Option<String>) {
    let view = if item_id.is_some() { MainView::Item } else { MainView::Health };
    crate::shell::show_main(app, Some(NavigateEvent { item_id, view: Some(view) }));
}

fn check(app: &AppHandle, day: Date, alive: &mut Vec<windows::UI::Notifications::ToastNotification>) {
    let Ok(keys) = crate::vault::with_vault(app, |v| Ok(v.api_key_expiries())) else { return };
    let path = log_path(app);
    let mut log = NoticeLog::load(&path);
    let before = log.clone();
    let notices = plan(&keys, day, &mut log);
    if log != before
        && let Err(e) = log.save(&path)
    {
        // Without the log the same notice would come again: show nothing.
        crate::log!("expiry: notices.json not written ({e}); no notice shown");
        return;
    }
    if notices.is_empty() {
        return;
    }
    let app_id = app.config().identifier.clone();
    let mut show = |title: String, body: String, item: Option<String>| -> bool {
        let handle = app.clone();
        match crate::win::toast::show(&app_id, &title, &body, move || open_in_coffer(&handle, item.clone())) {
            Ok(t) => {
                alive.push(t);
                true
            }
            Err(e) => {
                crate::log!("expiry: Windows did not show the notice ({})", e.message());
                false
            }
        }
    };
    let failed: Vec<&Notice> = if notices.len() > MAX_SINGLE {
        let (t, b) = summary_words(&notices);
        if show(t, b, None) { Vec::new() } else { notices.iter().collect() }
    } else {
        notices
            .iter()
            .filter(|n| {
                let (t, b) = words(n);
                !show(t, b, Some(n.item_id.clone()))
            })
            .collect()
    };
    crate::log!("expiry: {} notice(s) shown", notices.len() - failed.len());
    if !failed.is_empty() {
        // Not shown: try again at the next unlock or day.
        for n in &failed {
            match before.sent.get(&n.item_id) {
                Some(s) => log.sent.insert(n.item_id.clone(), *s),
                None => log.sent.remove(&n.item_id),
            };
        }
        if let Err(e) = log.save(&path) {
            crate::log!("expiry: notices.json not written ({e})");
        }
    }
    // Keep the newest notices' click handlers; Windows drops old ones from view anyway.
    if alive.len() > 50 {
        alive.drain(..alive.len() - 50);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::date;

    fn key(id: &str, date: Date) -> (String, String, Date) {
        (id.to_string(), format!("Key {id}"), date)
    }

    #[test]
    fn stages_at_14_days_and_on_the_day() {
        assert_eq!(decide(15, None), (None, None));
        assert_eq!(decide(14, None), (Some(Stage::Soon), Some(Stage::Soon)));
        assert_eq!(decide(3, None), (Some(Stage::Soon), Some(Stage::Soon)));
        assert_eq!(decide(3, Some(Stage::Soon)), (None, Some(Stage::Soon)));
        assert_eq!(decide(0, Some(Stage::Soon)), (Some(Stage::Day), Some(Stage::Day)));
        assert_eq!(decide(0, Some(Stage::Day)), (None, Some(Stage::Day)));
        // A date moved out of the window forgets the key; moved into it from "day" warns again.
        assert_eq!(decide(200, Some(Stage::Day)), (None, None));
        assert_eq!(decide(10, Some(Stage::Day)), (Some(Stage::Soon), Some(Stage::Soon)));
    }

    #[test]
    fn never_the_same_notice_twice() {
        let today = date!(2026 - 11 - 15);
        let keys = vec![key("a", date!(2026 - 11 - 29))];
        let mut log = NoticeLog::default();
        let first = plan(&keys, today, &mut log);
        assert_eq!(first.len(), 1);
        assert_eq!((first[0].days, first[0].stage), (14, Stage::Soon));
        // A second unlock the same day, and the next days, send nothing.
        assert!(plan(&keys, today, &mut log).is_empty());
        assert!(plan(&keys, date!(2026 - 11 - 20), &mut log).is_empty());
        // On the day: the second notice, once.
        let on_day = plan(&keys, date!(2026 - 11 - 29), &mut log);
        assert_eq!((on_day[0].days, on_day[0].stage), (0, Stage::Day));
        assert!(plan(&keys, date!(2026 - 11 - 29), &mut log).is_empty());
        assert!(plan(&keys, date!(2026 - 12 - 05), &mut log).is_empty());
    }

    #[test]
    fn a_past_date_at_the_first_unlock_sends_the_day_notice() {
        let mut log = NoticeLog::default();
        let n = plan(&[key("a", date!(2026 - 11 - 12))], date!(2026 - 11 - 15), &mut log);
        assert_eq!((n[0].days, n[0].stage), (-3, Stage::Day));
        assert_eq!(words(&n[0]).0, "Key a expired 3 days ago");
        assert_eq!(log.sent.get("a"), Some(&Stage::Day));
    }

    #[test]
    fn a_key_out_of_the_window_gets_no_notice_and_a_new_date_starts_again() {
        let mut log = NoticeLog::default();
        assert!(plan(&[key("a", date!(2027 - 01 - 01))], date!(2026 - 11 - 15), &mut log).is_empty());
        assert!(log.sent.is_empty());
        plan(&[key("a", date!(2026 - 11 - 20))], date!(2026 - 11 - 15), &mut log);
        // The key was rotated: a date a year later clears its entry.
        plan(&[key("a", date!(2027 - 11 - 20))], date!(2026 - 11 - 16), &mut log);
        assert!(log.sent.is_empty());
        // Unknown ids stay (another vault, an archived key).
        log.sent.insert("other".into(), Stage::Soon);
        plan(&[], date!(2026 - 11 - 16), &mut log);
        assert_eq!(log.sent.len(), 1);
    }

    #[test]
    fn notice_words() {
        let n = Notice { item_id: "x".into(), title: "Stripe API key".into(), days: 14, date: date!(2026 - 11 - 29), stage: Stage::Soon };
        assert_eq!(words(&n), ("Stripe API key expires in 14 days".into(), "API key. Expires on 29 Nov 2026. Click to open it in Coffer.".into()));
        let n = Notice { days: 1, ..n };
        assert_eq!(words(&n).0, "Stripe API key expires in 1 day");
        let n = Notice { days: 0, stage: Stage::Day, ..n };
        assert_eq!(words(&n).0, "Stripe API key expires today");
        let many: Vec<Notice> = (0..4).map(|i| Notice { days: i, ..n.clone() }).collect();
        assert_eq!(summary_words(&many).0, "4 API keys expire soon or have expired");
    }

    #[test]
    fn the_log_holds_ids_and_stages_only() {
        let mut log = NoticeLog::default();
        plan(&[key("4f1c", date!(2026 - 11 - 20))], date!(2026 - 11 - 15), &mut log);
        let dir = std::env::temp_dir().join(format!("coffer-expiry-test-{}", std::process::id()));
        let path = dir.join("notices.json");
        log.save(&path).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"4f1c\": \"soon\""), "{text}");
        assert!(!text.contains("Key") && !text.contains("2026"), "{text}");
        assert_eq!(NoticeLog::load(&path).sent, log.sent);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
