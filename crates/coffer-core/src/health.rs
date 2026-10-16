//! Health checks and score (SPEC 7). Pure functions over item records.
//!
//! - Checks: breached (from the cache), reused, weak (zxcvbn 0 to 2 with
//!   title, username and URL host as inputs), duplicate, unsecured site,
//!   old (365 days; an empty date never counts), expiring (cards 60 days,
//!   passports 300 days, other documents and API credentials 90 days).
//! - Only active, not-excluded items are checked; every flag is false for
//!   archived, trashed and excluded items.
//! - Score = floor(100 x healthy / total) over active login and password
//!   items with a password, not excluded; healthy = not breached, not reused,
//!   not weak; shown only when total >= 5.
//! - The report holds item ids and plain-language details, never a value or
//!   a hash.

use std::collections::{BTreeMap, HashMap};

use sha2::{Digest, Sha256};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use crate::model::{
    BreachCacheEntry, BreachMode, HealthCheck, HealthCounts, HealthFinding, HealthReport, ItemFlags, ItemState, ItemType,
    StoredItem, url_host, url_scheme,
};
use crate::time_util;

/// Hex SHA-256 of a password (the breach-cache key; never leaves the meta record).
pub fn password_sha256(password: &str) -> String {
    crate::crypto::hex(&Sha256::digest(password.as_bytes()))
}

/// "Same site" (SPEC 7): the first URL's host, lower case, without a leading `www.`.
pub fn site_of(item: &StoredItem) -> Option<String> {
    let first = item.urls.first()?;
    let host = url_host(&first.url)?;
    Some(host.strip_prefix("www.").unwrap_or(&host).to_owned())
}

/// `true` for localhost and private, loopback and link-local addresses.
pub fn is_local_host(host: &str) -> bool {
    let h = host.trim_matches(|c| c == '[' || c == ']').to_ascii_lowercase();
    if h == "localhost" || h.ends_with(".localhost") || h.ends_with(".local") || h == "::1" {
        return true;
    }
    if h.starts_with("fc") || h.starts_with("fd") || h.starts_with("fe80") {
        return h.contains(':');
    }
    let parts: Vec<u8> = h.split('.').filter_map(|p| p.parse().ok()).collect();
    if parts.len() == 4 && h.split('.').count() == 4 {
        return match parts[..] {
            [10, ..] | [127, ..] => true,
            [192, 168, ..] => true,
            [169, 254, ..] => true,
            [172, b, ..] => (16..=31).contains(&b),
            _ => false,
        };
    }
    false
}

/// `true` when the URL uses plain `http://` to a non-local host.
pub fn is_unsecured_url(url: &str) -> bool {
    url_scheme(url).as_deref() == Some("http") && url_host(url).map(|h| !is_local_host(&h)).unwrap_or(false)
}

fn counted_type(t: ItemType) -> bool {
    matches!(t, ItemType::Login | ItemType::Password)
}

fn checked(item: &StoredItem) -> bool {
    item.state == ItemState::Active && !item.health_excluded
}

/// zxcvbn user inputs of an item: title, username, URL host.
pub fn weak_inputs(item: &StoredItem) -> Vec<String> {
    let mut v = vec![item.title.clone(), item.builtin_value("username").to_owned()];
    if let Some(h) = item.url_host() {
        v.push(h);
    }
    v
}

/// Result of [`analyze`].
#[derive(Debug, Clone, Default)]
pub struct Analysis {
    /// Flags per item (absent = all false).
    pub flags: HashMap<Uuid, ItemFlags>,
    /// Findings in a stable order.
    pub findings: Vec<HealthFinding>,
    /// Counts per check.
    pub counts: HealthCounts,
    /// Counted items.
    pub total: usize,
    /// Counted items not breached, reused or weak.
    pub healthy: usize,
    /// Active items excluded from health.
    pub excluded_count: usize,
}

/// Runs every check. `weak_score` returns the zxcvbn score of an item's
/// password (the session caches it).
pub fn analyze(
    items: &[&StoredItem],
    breach_cache: &[BreachCacheEntry],
    now: OffsetDateTime,
    weak_score: &mut dyn FnMut(&StoredItem) -> u8,
) -> Analysis {
    let mut a = Analysis::default();
    let mut found: Vec<(Uuid, HealthCheck, String, Option<String>)> = Vec::new();
    a.excluded_count = items.iter().filter(|i| i.state == ItemState::Active && i.health_excluded).count();
    let active: Vec<&StoredItem> = items.iter().copied().filter(|i| checked(i)).collect();
    let with_pw: Vec<&StoredItem> =
        active.iter().copied().filter(|i| counted_type(i.item_type) && !i.password().is_empty()).collect();

    // Breached.
    let mut breached: HashMap<Uuid, u64> = HashMap::new();
    for item in &with_pw {
        let id = item.id.to_string();
        let digest = password_sha256(item.password());
        if let Some(e) = breach_cache.iter().find(|e| e.item_id == id && e.password_sha256 == digest) {
            if e.count > 0 {
                breached.insert(item.id, e.count);
                found.push((item.id, HealthCheck::Breached, format!("Found {} times in breaches", group_thousands(e.count)), None));
            }
        }
    }

    // Duplicates and reuse.
    let mut by_pw: BTreeMap<&str, Vec<&StoredItem>> = BTreeMap::new();
    for item in &with_pw {
        by_pw.entry(item.password()).or_default().push(item);
    }
    let mut reused: HashMap<Uuid, ()> = HashMap::new();
    for group in by_pw.values() {
        if group.len() < 2 {
            continue;
        }
        // Distinct logins: (username, site).
        let mut keys: BTreeMap<(String, Option<String>), Vec<&StoredItem>> = BTreeMap::new();
        for item in group {
            keys.entry((item.builtin_value("username").to_owned(), site_of(item))).or_default().push(item);
        }
        for dup in keys.values().filter(|d| d.len() >= 2) {
            let gid = dup.iter().map(|i| i.id).min().expect("non-empty").to_string();
            for item in dup {
                let others = dup.len() - 1;
                found.push((
                    item.id,
                    HealthCheck::Duplicate,
                    format!("Same username, password and site as {others} other item{}", plural(others)),
                    Some(gid.clone()),
                ));
            }
        }
        if keys.len() >= 2 {
            let gid = group.iter().map(|i| i.id).min().expect("non-empty").to_string();
            for item in group {
                reused.insert(item.id, ());
                found.push((item.id, HealthCheck::Reused, format!("Used in {} items", group.len()), Some(gid.clone())));
            }
        }
    }

    // Weak.
    let mut weak: HashMap<Uuid, ()> = HashMap::new();
    for item in &with_pw {
        let s = weak_score(item);
        if s <= 2 {
            weak.insert(item.id, ());
            found.push((item.id, HealthCheck::Weak, format!("Easy to guess (strength {s} of 4)"), None));
        }
    }

    // Unsecured, old, expiring: any active item.
    for item in &active {
        if item.urls.iter().any(|u| is_unsecured_url(&u.url)) {
            found.push((item.id, HealthCheck::Unsecured, "Uses an http:// address".into(), None));
        }
        if counted_type(item.item_type) && !item.password().is_empty() {
            if let Some(changed) = item.password_changed_at.as_deref().and_then(time_util::parse) {
                if now - changed >= Duration::days(365) {
                    found.push((
                        item.id,
                        HealthCheck::Old,
                        format!("Unchanged since {}", time_util::fmt_date(changed.date())),
                        None,
                    ));
                }
            }
        }
        if let Some(detail) = expiring(item, now) {
            found.push((item.id, HealthCheck::Expiring, detail, None));
        }
    }

    // Score.
    a.total = with_pw.len();
    a.healthy = with_pw
        .iter()
        .filter(|i| !breached.contains_key(&i.id) && !reused.contains_key(&i.id) && !weak.contains_key(&i.id))
        .count();

    found.sort_by(|x, y| (x.1, x.0).cmp(&(y.1, y.0)));
    for (id, check, detail, group) in found {
        let f = a.flags.entry(id).or_default();
        match check {
            HealthCheck::Breached => {
                f.breached = true;
                a.counts.breached += 1;
            }
            HealthCheck::Reused => {
                f.reused = true;
                a.counts.reused += 1;
            }
            HealthCheck::Weak => {
                f.weak = true;
                a.counts.weak += 1;
            }
            HealthCheck::Unsecured => {
                f.unsecured = true;
                a.counts.unsecured += 1;
            }
            HealthCheck::Expiring => {
                f.expiring = true;
                a.counts.expiring += 1;
            }
            HealthCheck::Old => a.counts.old += 1,
            HealthCheck::Duplicate => a.counts.duplicate += 1,
        }
        a.findings.push(HealthFinding { item_id: id.to_string(), check, detail, group_id: group });
    }
    a
}

fn plural(n: usize) -> &'static str {
    if n == 1 { "" } else { "s" }
}

fn group_thousands(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

fn expiring(item: &StoredItem, now: OffsetDateTime) -> Option<String> {
    let today = now.date();
    let (date, window, label) = match item.item_type {
        ItemType::Card => {
            let v = item.builtin_value("expiry");
            (time_util::parse_month_year_end(v)?, 60, v.to_owned())
        }
        ItemType::Document => {
            let v = item.builtin_value("expires");
            let kind = item.builtin_value("docKind").to_ascii_lowercase();
            let window = if kind == "passport" { 300 } else { 90 };
            (time_util::parse_date(v)?, window, v.to_owned())
        }
        ItemType::ApiCredential => {
            let v = item.builtin_value("expires");
            (time_util::parse_date(v)?, 90, v.to_owned())
        }
        _ => return None,
    };
    let days = (date - today).whole_days();
    if days < 0 {
        Some(format!("Expired {label}"))
    } else if days <= window {
        Some(format!("Expires {label}"))
    } else {
        None
    }
}

/// Builds the report from an analysis.
pub fn report(a: &Analysis, breach_check: BreachMode, breach_checked_at: Option<String>) -> HealthReport {
    let score = if a.total >= 5 {
        Some(u32::try_from(100 * a.healthy / a.total).expect("<= 100"))
    } else {
        None
    };
    let formula = if a.total >= 5 {
        format!("{} of {} passwords are not breached, reused or weak", a.healthy, a.total)
    } else {
        "Add 5 or more logins to see a score.".to_owned()
    };
    HealthReport {
        score,
        total: a.total,
        healthy: a.healthy,
        formula,
        counts: a.counts,
        findings: a.findings.clone(),
        excluded_count: a.excluded_count,
        breach_check,
        breach_checked_at,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{FieldKind, ItemUrl};

    fn login(title: &str, user: &str, pw: &str, url: &str) -> StoredItem {
        let mut i = StoredItem::new(ItemType::Login, title, "2026-01-01T00:00:00Z");
        i.set_builtin("username", FieldKind::Text, user);
        i.set_builtin("password", FieldKind::Concealed, pw);
        if !url.is_empty() {
            i.urls.push(ItemUrl { url: url.into(), label: None });
        }
        i
    }

    fn now() -> OffsetDateTime {
        time_util::parse("2026-10-16T00:00:00Z").unwrap()
    }

    fn zx(i: &StoredItem) -> u8 {
        let inputs = weak_inputs(i);
        let refs: Vec<&str> = inputs.iter().map(String::as_str).collect();
        crate::strength::score(i.password(), &refs)
    }

    const STRONG: [&str; 6] = [
        "vR7#qL2!mZ9@wX4$",
        "Tk3^bN8&hJ5*pF1(",
        "Gq6)sD2_eY7+uC9=",
        "Lw4[oA8]iM3{rV6}",
        "Zx9;nB1:kH5,tE2.",
        "Pq2?jU7/fW4!cS8@",
    ];

    #[test]
    fn score_rule_and_floor() {
        let mut items: Vec<StoredItem> =
            STRONG.iter().enumerate().map(|(n, p)| login(&format!("s{n}"), "me", p, &format!("https://s{n}.example"))).collect();
        items.push(login("weak", "me", "password", "https://w.example"));
        let refs: Vec<&StoredItem> = items.iter().collect();
        let a = analyze(&refs, &[], now(), &mut zx);
        assert_eq!(a.total, 7);
        assert_eq!(a.healthy, 6);
        let r = report(&a, BreachMode::Off, None);
        assert_eq!(r.score, Some(85)); // floor(600 / 7) = 85
        assert_eq!(r.formula, "6 of 7 passwords are not breached, reused or weak");
        assert!(a.flags[&items[6].id].weak);
    }

    #[test]
    fn score_hidden_under_five() {
        let items: Vec<StoredItem> = STRONG[..4].iter().map(|p| login("x", "u", p, "")).collect();
        let refs: Vec<&StoredItem> = items.iter().collect();
        let r = report(&analyze(&refs, &[], now(), &mut zx), BreachMode::Off, None);
        assert_eq!(r.score, None);
        assert_eq!(r.formula, "Add 5 or more logins to see a score.");
    }

    #[test]
    fn duplicates_are_not_reuse() {
        let a1 = login("A", "me", STRONG[0], "https://www.site.example/login");
        let a2 = login("A copy", "me", STRONG[0], "https://site.example");
        let refs = vec![&a1, &a2];
        let a = analyze(&refs, &[], now(), &mut zx);
        assert_eq!(a.counts.duplicate, 2);
        assert_eq!(a.counts.reused, 0);
        assert!(!a.flags[&a1.id].reused);
        // A third item on another site makes the password reused.
        let b = login("B", "me", STRONG[0], "https://other.example");
        let refs = vec![&a1, &a2, &b];
        let a = analyze(&refs, &[], now(), &mut zx);
        assert_eq!(a.counts.reused, 3);
        let gids: Vec<_> = a.findings.iter().filter(|f| f.check == HealthCheck::Reused).map(|f| f.group_id.clone()).collect();
        assert!(gids.windows(2).all(|w| w[0] == w[1]));
    }

    #[test]
    fn excluded_archived_and_trashed_have_no_flags() {
        let mut ex = login("x", "u", "password", "http://plain.example");
        ex.health_excluded = true;
        let mut ar = login("y", "u", "password", "http://plain.example");
        ar.state = ItemState::Archived;
        let mut tr = login("z", "u", "password", "http://plain.example");
        tr.state = ItemState::Trashed;
        let refs = vec![&ex, &ar, &tr];
        let a = analyze(&refs, &[], now(), &mut zx);
        assert!(a.flags.is_empty());
        assert_eq!(a.total, 0);
        assert_eq!(a.excluded_count, 1);
    }

    #[test]
    fn unsecured_old_expiring() {
        let mut l = login("x", "u", STRONG[1], "http://shop.example");
        l.urls.push(ItemUrl { url: "http://192.168.1.1".into(), label: None });
        l.password_changed_at = Some("2025-01-01T00:00:00Z".into());
        let mut none_date = login("y", "u", STRONG[2], "http://localhost:8080");
        none_date.password_changed_at = None;
        let mut card = StoredItem::new(ItemType::Card, "card", "2026-01-01T00:00:00Z");
        card.set_builtin("expiry", FieldKind::MonthYear, "2026-11");
        let mut pass = StoredItem::new(ItemType::Document, "passport", "2026-01-01T00:00:00Z");
        pass.set_builtin("docKind", FieldKind::Menu, "Passport");
        pass.set_builtin("expires", FieldKind::Date, "2027-06-01");
        let mut idc = StoredItem::new(ItemType::Document, "id", "2026-01-01T00:00:00Z");
        idc.set_builtin("docKind", FieldKind::Menu, "ID card");
        idc.set_builtin("expires", FieldKind::Date, "2027-06-01");
        let refs = vec![&l, &none_date, &card, &pass, &idc];
        let a = analyze(&refs, &[], now(), &mut zx);
        assert!(a.flags[&l.id].unsecured);
        assert!(!a.flags.get(&none_date.id).map(|f| f.unsecured).unwrap_or(false));
        assert_eq!(a.counts.old, 1);
        assert!(a.flags[&card.id].expiring);
        assert!(a.flags[&pass.id].expiring);
        assert!(!a.flags.get(&idc.id).map(|f| f.expiring).unwrap_or(false));
    }

    #[test]
    fn breached_from_cache_by_password_hash() {
        let l = login("x", "u", STRONG[3], "");
        let cache = vec![BreachCacheEntry {
            item_id: l.id.to_string(),
            password_sha256: password_sha256(STRONG[3]),
            count: 12345,
        }];
        let refs = vec![&l];
        let a = analyze(&refs, &cache, now(), &mut zx);
        assert!(a.flags[&l.id].breached);
        assert_eq!(a.findings[0].detail, "Found 12,345 times in breaches");
        // A changed password has no cache entry.
        let other = vec![BreachCacheEntry { item_id: l.id.to_string(), password_sha256: password_sha256("old"), count: 3 }];
        assert!(!analyze(&refs, &other, now(), &mut zx).flags.get(&l.id).map(|f| f.breached).unwrap_or(false));
    }

    #[test]
    fn report_never_holds_a_value() {
        let l = login("x", "u", "password", "");
        let refs = vec![&l];
        let r = report(&analyze(&refs, &[], now(), &mut zx), BreachMode::Manual, None);
        let json = serde_json::to_string(&r).unwrap();
        assert!(!json.contains("\"password\"") || !json.contains(":\"password\""));
        assert!(!json.contains(&password_sha256("password")));
    }

    #[test]
    fn local_hosts() {
        for h in ["localhost", "127.0.0.1", "10.1.2.3", "192.168.0.1", "172.20.0.1", "169.254.1.1", "[::1]", "nas.local"] {
            assert!(is_local_host(h), "{h}");
        }
        for h in ["example.com", "172.32.0.1", "8.8.8.8"] {
            assert!(!is_local_host(h), "{h}");
        }
    }
}
