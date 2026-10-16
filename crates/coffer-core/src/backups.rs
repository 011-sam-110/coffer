//! Backup retention (SPEC 3.5) and file-name times, pure functions.
//!
//! Keep the last 20 saves and one per day (the newest of that UTC day) for
//! the last 30 days. Backup files are named `<YYYYMMDDTHHMMSSZ>.coffer`.

use std::collections::BTreeSet;

use time::{Duration, OffsetDateTime};

/// Saves always kept.
pub const KEEP_LAST: usize = 20;
/// Days with one kept backup each.
pub const KEEP_DAYS: i64 = 30;

/// `YYYYMMDDTHHMMSSZ` (NTFS does not allow `:`).
pub fn file_time(t: OffsetDateTime) -> String {
    let t = t.to_offset(time::UtcOffset::UTC);
    format!(
        "{:04}{:02}{:02}T{:02}{:02}{:02}Z",
        t.year(),
        u8::from(t.month()),
        t.day(),
        t.hour(),
        t.minute(),
        t.second()
    )
}

/// Parses `YYYYMMDDTHHMMSSZ` (with or without a `.coffer` suffix).
pub fn parse_file_time(name: &str) -> Option<OffsetDateTime> {
    let s = name.strip_suffix(".coffer").unwrap_or(name);
    if s.len() != 16 || s.as_bytes()[8] != b'T' || !s.ends_with('Z') {
        return None;
    }
    let n = |a: usize, b: usize| s.get(a..b)?.parse::<u32>().ok();
    let date = time::Date::from_calendar_date(
        i32::try_from(n(0, 4)?).ok()?,
        time::Month::try_from(u8::try_from(n(4, 6)?).ok()?).ok()?,
        u8::try_from(n(6, 8)?).ok()?,
    )
    .ok()?;
    let t = time::Time::from_hms(
        u8::try_from(n(9, 11)?).ok()?,
        u8::try_from(n(11, 13)?).ok()?,
        u8::try_from(n(13, 15)?).ok()?,
    )
    .ok()?;
    Some(date.with_time(t).assume_utc())
}

/// The conflict copy name: `<stem> (conflict <YYYYMMDDTHHMMSSZ>).coffer`.
pub fn conflict_file_name(stem: &str, now: OffsetDateTime) -> String {
    format!("{stem} (conflict {}).coffer", file_time(now))
}

/// Which backups to keep. `saved` = save times of every backup (any order).
/// Returns one bool per input: `true` = keep, `false` = delete.
pub fn retain(saved: &[OffsetDateTime], now: OffsetDateTime) -> Vec<bool> {
    let mut order: Vec<usize> = (0..saved.len()).collect();
    order.sort_by(|a, b| saved[*b].cmp(&saved[*a])); // newest first
    let mut keep = vec![false; saved.len()];
    for &i in order.iter().take(KEEP_LAST) {
        keep[i] = true;
    }
    let mut days = BTreeSet::new();
    for &i in &order {
        let t = saved[i];
        if now - t > Duration::days(KEEP_DAYS) {
            continue;
        }
        if days.insert(t.date()) {
            keep[i] = true;
        }
    }
    keep
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(s: &str) -> OffsetDateTime {
        crate::time_util::parse(s).unwrap()
    }

    #[test]
    fn file_time_round_trip() {
        let x = t("2026-10-16T01:02:03Z");
        assert_eq!(file_time(x), "20261016T010203Z");
        assert_eq!(parse_file_time("20261016T010203Z.coffer"), Some(x));
        assert_eq!(parse_file_time("2026-10-16"), None);
        assert_eq!(conflict_file_name("Personal", x), "Personal (conflict 20261016T010203Z).coffer");
    }

    #[test]
    fn last_20_plus_one_per_day_for_30_days() {
        let now = t("2026-10-16T12:00:00Z");
        let mut saved = Vec::new();
        // 30 saves today (newest 20 kept).
        for m in 0..30 {
            saved.push(now - Duration::minutes(m));
        }
        // Two saves on each of the 40 previous days.
        for d in 1..=40 {
            saved.push(now - Duration::days(d));
            saved.push(now - Duration::days(d) - Duration::hours(1));
        }
        let keep = retain(&saved, now);
        let kept: Vec<OffsetDateTime> = saved.iter().zip(&keep).filter(|(_, k)| **k).map(|(t, _)| *t).collect();
        // 20 newest today + 30 days back (days 1..=30) one each.
        assert_eq!(kept.len(), 20 + 30);
        // The newest of each kept day is the one kept.
        assert!(kept.contains(&(now - Duration::days(5))));
        assert!(!kept.contains(&(now - Duration::days(5) - Duration::hours(1))));
        // Older than 30 days: gone.
        assert!(!kept.contains(&(now - Duration::days(31))));
    }

    #[test]
    fn few_backups_all_kept() {
        let now = t("2026-10-16T12:00:00Z");
        let saved = vec![now - Duration::days(400), now];
        assert_eq!(retain(&saved, now), vec![true, true]);
    }
}
