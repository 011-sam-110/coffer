//! Time helpers. Every time in Coffer is an RFC 3339 string in UTC with
//! whole seconds, e.g. `2026-10-16T01:19:00Z`.

use time::format_description::well_known::Rfc3339;
use time::{Date, Month, OffsetDateTime, UtcOffset};

/// Now, in UTC, whole seconds.
pub fn now() -> OffsetDateTime {
    OffsetDateTime::now_utc().replace_nanosecond(0).expect("0 ns is valid")
}

/// The time in UTC when its year is in 0..=9999 (what RFC 3339 can hold),
/// else `None`. Never panics, also for extreme offsets.
fn in_range(t: OffsetDateTime) -> Option<OffsetDateTime> {
    let u = t.checked_to_offset(UtcOffset::UTC)?;
    (0..=9999).contains(&u.year()).then_some(u)
}

/// `YYYY-MM-DDTHH:MM:SSZ` of a UTC time (infallible; the caller keeps the
/// year in range).
fn format_utc(u: OffsetDateTime) -> String {
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", u.year(), u8::from(u.month()), u.day(), u.hour(), u.minute(), u.second())
}

/// Formats a time as `YYYY-MM-DDTHH:MM:SSZ` (UTC, whole seconds). `None`
/// when the UTC year is outside 0..=9999: RFC 3339 cannot hold it, so an
/// importer drops that value.
pub fn fmt(t: OffsetDateTime) -> Option<String> {
    in_range(t).map(format_utc)
}

/// Now as `YYYY-MM-DDTHH:MM:SSZ`.
pub fn now_string() -> String {
    format_utc(now())
}

/// Parses an RFC 3339 time, as UTC. `None` when it does not parse or its
/// UTC year is outside 0..=9999.
pub fn parse(s: &str) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(s, &Rfc3339).ok().and_then(in_range)
}

/// A Unix time in seconds as a UTC time. `None` outside years 0..=9999.
pub fn from_unix(secs: i64) -> Option<OffsetDateTime> {
    OffsetDateTime::from_unix_timestamp(secs).ok().and_then(in_range)
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Review item 3b: years outside 0..=9999 used to panic in `fmt`.
    #[test]
    fn out_of_range_years_are_none_not_panics() {
        // Firefox timeCreated=-62167219201000 ms is year -1.
        assert!(from_unix(-62_167_219_201).is_none());
        assert_eq!(from_unix(0).and_then(fmt).as_deref(), Some("1970-01-01T00:00:00Z"));
        // Year 0 at +00:01 is year -1 in UTC.
        assert!(parse("0000-01-01T00:00:00+00:01").is_none());
        assert_eq!(parse("0000-01-01T00:01:00+00:01").and_then(fmt).as_deref(), Some("0000-01-01T00:00:00Z"));
        assert_eq!(parse("9999-12-31T23:59:59Z").and_then(fmt).as_deref(), Some("9999-12-31T23:59:59Z"));
        assert!(parse("9999-12-31T23:59:59-00:01").is_none());
        assert!(from_unix(i64::MAX).is_none() && from_unix(i64::MIN).is_none());
        // fmt drops an out-of-range value it is given directly.
        let t = time::macros::datetime!(-0001-06-01 0:00 UTC);
        assert!(fmt(t).is_none());
        assert_eq!(parse("2026-10-16T01:19:00.5+02:00").and_then(fmt).as_deref(), Some("2026-10-15T23:19:00Z"));
        assert_eq!(now_string().len(), 20);
    }
}
