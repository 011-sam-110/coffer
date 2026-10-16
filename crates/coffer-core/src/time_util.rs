//! Time helpers. Every time in Coffer is an RFC 3339 string in UTC with
//! whole seconds, e.g. `2026-10-16T01:19:00Z`.

use time::format_description::well_known::Rfc3339;
use time::{Date, Month, OffsetDateTime, UtcOffset};

/// Now, in UTC, whole seconds.
pub fn now() -> OffsetDateTime {
    OffsetDateTime::now_utc().replace_nanosecond(0).expect("0 ns is valid")
}

/// Formats a time as `YYYY-MM-DDTHH:MM:SSZ`.
pub fn fmt(t: OffsetDateTime) -> String {
    t.to_offset(UtcOffset::UTC)
        .replace_nanosecond(0)
        .expect("0 ns is valid")
        .format(&Rfc3339)
        .expect("RFC 3339 formatting of a UTC time cannot fail")
}

/// Parses an RFC 3339 time.
pub fn parse(s: &str) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(s, &Rfc3339).ok()
}

/// A Unix time in seconds as a UTC time.
pub fn from_unix(secs: i64) -> Option<OffsetDateTime> {
    OffsetDateTime::from_unix_timestamp(secs).ok()
}

/// Parses `YYYY-MM-DD`.
pub fn parse_date(s: &str) -> Option<Date> {
    let mut it = s.trim().splitn(3, '-');
    let y: i32 = it.next()?.parse().ok()?;
    let m: u8 = it.next()?.parse().ok()?;
    let d_str: String = it.next()?.chars().take_while(char::is_ascii_digit).collect();
    let d: u8 = d_str.parse().ok()?;
    Date::from_calendar_date(y, Month::try_from(m).ok()?, d).ok()
}

/// Parses `YYYY-MM` (or `MM/YYYY`, `MM/YY`) to the LAST day of that month.
pub fn parse_month_year_end(s: &str) -> Option<Date> {
    let s = s.trim();
    let (y, m): (i32, u8) = if let Some((a, b)) = s.split_once('-') {
        let m: String = b.chars().take_while(char::is_ascii_digit).collect();
        (a.parse().ok()?, m.parse().ok()?)
    } else if let Some((a, b)) = s.split_once('/') {
        let y: i32 = b.parse().ok()?;
        (if y < 100 { 2000 + y } else { y }, a.parse().ok()?)
    } else if s.len() == 6 && s.chars().all(|c| c.is_ascii_digit()) {
        (s[..4].parse().ok()?, s[4..].parse().ok()?)
    } else {
        return None;
    };
    let month = Month::try_from(m).ok()?;
    let days = time::util::days_in_month(month, y);
    Date::from_calendar_date(y, month, days).ok()
}

/// `YYYY-MM-DD` of a date.
pub fn fmt_date(d: Date) -> String {
    format!("{:04}-{:02}-{:02}", d.year(), u8::from(d.month()), d.day())
}
