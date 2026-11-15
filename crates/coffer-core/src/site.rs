//! Which logins belong to a web page (docs/BRIDGE.md section 6, SPEC 3.13).
//!
//! A page's site is its registered domain (eTLD+1) from the Public Suffix
//! List (the `psl` crate carries the list): `accounts.google.com` is
//! `google.com`, `alex.github.io` is `alex.github.io`. A login fits a page
//! when one of its Website URLs has the same site; a login whose Websites do
//! not fit is tried by its name, when the name reads as a web address (the
//! rule of `siteFromName` in `src/lib/url.ts`, on the same TLD list). Both
//! rules run the table in `src/lib/siteCases.json`.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

/// `src/lib/tlds.ts`: the IANA root zone and the special-use names.
const TLDS_TS: &str = include_str!("../../../src/lib/tlds.ts");

fn tlds() -> &'static HashSet<&'static str> {
    static SET: OnceLock<HashSet<&'static str>> = OnceLock::new();
    SET.get_or_init(|| {
        TLDS_TS
            .lines()
            .filter_map(|l| l.trim().strip_prefix('"')?.strip_suffix("\","))
            .flat_map(str::split_whitespace)
            .collect()
    })
}

/// One DNS label of a name: a-z, 0-9 and inner hyphens, 1 to 63 characters.
fn is_label(l: &str) -> bool {
    let b = l.as_bytes();
    (1..=63).contains(&b.len())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
        && b[0] != b'-'
        && b[b.len() - 1] != b'-'
}

fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    (s.len() >= prefix.len() && s.is_char_boundary(prefix.len()) && s[..prefix.len()].eq_ignore_ascii_case(prefix)).then(|| &s[prefix.len()..])
}

/// The host a login name reads as ("github.com", "https://github.com/login"
/// give "github.com"), or `None`. The name must be one word of host labels
/// whose last label is a top-level domain, so "GitHub", "Node.js" and "v1.2"
/// give `None`. Same rule as `siteFromName` in `src/lib/url.ts`.
pub fn name_host(name: &str) -> Option<String> {
    let s = name.trim();
    if s.is_empty() || s.chars().any(char::is_whitespace) || s.contains('@') {
        return None;
    }
    let s = strip_prefix_ci(s, "https://").or_else(|| strip_prefix_ci(s, "http://")).unwrap_or(s);
    let host = s.split(['/', '?', '#']).next().unwrap_or("");
    let host = host.strip_suffix('.').unwrap_or(host).to_lowercase();
    let labels: Vec<&str> = host.split('.').collect();
    if labels.len() < 2 || !labels.iter().all(|l| is_label(l)) || !tlds().contains(labels[labels.len() - 1]) {
        return None;
    }
    Some(host)
}

/// The website a login name reads as: `https://<host>`.
pub fn site_from_name(name: &str) -> Option<String> {
    name_host(name).map(|h| format!("https://{h}"))
}

fn is_ip(host: &str) -> bool {
    host.starts_with('[') || host.parse::<std::net::Ipv4Addr>().is_ok()
}

/// The registered domain of a host (lower case, no trailing dot). An IP
/// address, `localhost` or a host that is a public suffix itself (`co.uk`,
/// `github.io`) is its own site.
pub fn site_of(host: &str) -> String {
    let host = host.strip_suffix('.').unwrap_or(host);
    if is_ip(host) {
        return host.to_owned();
    }
    psl::domain_str(host).map(str::to_owned).unwrap_or_else(|| host.to_owned())
}

/// A page Coffer fills on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Page {
    /// `https` (or `http` on localhost and 127.0.0.1).
    pub scheme: String,
    /// The host, lower case, punycode, no port, no trailing dot.
    pub host: String,
    /// The registered domain of the host.
    pub site: String,
}

/// Why Coffer does not fill on a page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PageError {
    /// Not a URL with a host.
    NotUrl,
    /// Not `https:`, and not `http:` on localhost or 127.0.0.1.
    NotSecure,
}

/// Read a page URL: `https:` only, or `http:` on `localhost` and `127.0.0.1`.
///
/// # Errors
/// [`PageError`].
pub fn page(url: &str) -> Result<Page, PageError> {
    let u = url::Url::parse(url.trim()).map_err(|_| PageError::NotUrl)?;
    let raw = u.host_str().filter(|h| !h.is_empty()).ok_or(PageError::NotUrl)?;
    let host = raw.strip_suffix('.').unwrap_or(raw).to_ascii_lowercase();
    match u.scheme() {
        "https" => {}
        "http" if host == "localhost" || host == "127.0.0.1" => {}
        _ => return Err(PageError::NotSecure),
    }
    Ok(Page { scheme: u.scheme().to_owned(), site: site_of(&host), host })
}

/// Two pages of the same site: the same scheme and the same registered domain.
pub fn same_site(a: &Page, b: &Page) -> bool {
    a.scheme == b.scheme && a.site == b.site
}

/// The host of a login's Website URL ("https://user@Shop.example.com:8443/x"
/// gives "shop.example.com"). A URL with a scheme other than http or https
/// (`androidapp://`, `ftp://`) has none.
pub fn login_url_host(url: &str) -> Option<String> {
    let u = url.trim();
    if let Some(i) = u.find("://") {
        let scheme = u[..i].to_ascii_lowercase();
        if scheme != "http" && scheme != "https" {
            return None;
        }
    }
    let host = crate::model::url_host(u)?;
    let host = host.strip_suffix('.').unwrap_or(&host).to_owned();
    if host.is_ascii() {
        return Some(host);
    }
    // A Unicode name ("bücher.de"): the punycode form the browser reports.
    let parsed = url::Url::parse(&format!("https://{host}/")).ok()?;
    parsed.host_str().map(str::to_owned)
}

/// How well a login fits a page.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Fit {
    /// The same host as the page.
    Host,
    /// The same registered domain.
    Site,
}

fn fit_hosts(page: &Page, hosts: impl Iterator<Item = String>) -> Option<Fit> {
    hosts
        .filter_map(|h| {
            if h == page.host {
                Some(Fit::Host)
            } else if site_of(&h) == page.site {
                Some(Fit::Site)
            } else {
                None
            }
        })
        .min()
}

/// How a login with these Website URLs and this name fits the page: by its
/// Websites first; when none fits, by its name if the name reads as a web
/// address.
pub fn fit(page: &Page, urls: &[String], title: &str) -> Option<Fit> {
    fit_hosts(page, urls.iter().filter_map(|u| login_url_host(u))).or_else(|| fit_hosts(page, name_host(title).into_iter()))
}

/// A login as the bridge sees it: no password.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoginRef {
    /// Item id.
    pub id: String,
    /// The login's name.
    pub title: String,
    /// The username (not a secret field).
    pub username: String,
    /// The Website URLs.
    pub urls: Vec<String>,
    /// The login has a one-time code.
    pub has_totp: bool,
    /// "Ask for master password" is on.
    pub reprompt: bool,
}

/// The logins that fit the page, best first: the same host first, then the
/// last used (`last_used`: item id to an ISO time), then by name.
pub fn rank<'a>(page: &Page, logins: &'a [LoginRef], last_used: &HashMap<String, String>) -> Vec<&'a LoginRef> {
    let mut fits: Vec<(Fit, &LoginRef)> = logins.iter().filter_map(|l| fit(page, &l.urls, &l.title).map(|f| (f, l))).collect();
    fits.sort_by(|(fa, a), (fb, b)| {
        let used = |l: &LoginRef| last_used.get(&l.id).cloned().unwrap_or_default();
        fa.cmp(fb)
            .then_with(|| used(b).cmp(&used(a)))
            .then_with(|| a.title.to_lowercase().cmp(&b.title.to_lowercase()))
            .then_with(|| a.id.cmp(&b.id))
    });
    fits.into_iter().map(|(_, l)| l).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn table() -> Value {
        serde_json::from_str(include_str!("../../../src/lib/siteCases.json")).unwrap()
    }

    #[test]
    fn the_tld_list_reads_from_tlds_ts() {
        let t = tlds();
        assert!(t.len() > 1200, "{}", t.len());
        for tld in ["com", "uk", "dev", "zw", "aaa", "test", "local", "localhost", "example", "internal"] {
            assert!(t.contains(tld), "{tld}");
        }
        for not in ["js", "invalid", "corp", "\"com\","] {
            assert!(!t.contains(not), "{not}");
        }
    }

    #[test]
    fn names_follow_the_shared_table() {
        for row in table()["names"].as_array().unwrap() {
            let (name, want) = (row[0].as_str().unwrap(), row[1].as_str());
            assert_eq!(site_from_name(name).as_deref(), want, "{name:?}");
        }
    }

    #[test]
    fn pages_follow_the_shared_table() {
        for row in table()["pages"].as_array().unwrap() {
            let (url, want) = (row[0].as_str().unwrap(), row[1].as_str().unwrap());
            match page(url) {
                Ok(p) => assert_eq!(p.site, want, "{url}"),
                Err(e) => assert_eq!("error", want, "{url}: {e:?}"),
            }
        }
    }

    #[test]
    fn matches_follow_the_shared_table() {
        for row in table()["matches"].as_array().unwrap() {
            let p = page(row[0].as_str().unwrap()).unwrap();
            let urls: Vec<String> = row[1]["urls"].as_array().map(|a| a.iter().map(|u| u.as_str().unwrap().to_owned()).collect()).unwrap_or_default();
            let title = row[1]["title"].as_str().unwrap_or("Login");
            let want = match row[2].as_str() {
                Some("host") => Some(Fit::Host),
                Some("site") => Some(Fit::Site),
                _ => None,
            };
            assert_eq!(fit(&p, &urls, title), want, "{row}");
        }
    }

    #[test]
    fn same_site_follows_the_shared_table() {
        for row in table()["sameSite"].as_array().unwrap() {
            let (a, b) = (page(row[0].as_str().unwrap()), page(row[1].as_str().unwrap()));
            let got = matches!((&a, &b), (Ok(a), Ok(b)) if same_site(a, b));
            assert_eq!(got, row[2].as_bool().unwrap(), "{row}");
        }
    }

    fn login(id: &str, title: &str, urls: &[&str]) -> LoginRef {
        LoginRef { id: id.into(), title: title.into(), username: format!("{id}@example.com"), urls: urls.iter().map(|u| u.to_string()).collect(), has_totp: false, reprompt: false }
    }

    #[test]
    fn rank_puts_the_same_host_first_then_the_last_used() {
        let logins = vec![
            login("a", "Northwind (work)", &["https://northwind-shop.test"]),
            login("b", "northwind-shop.test", &[]),
            login("c", "Accounts", &["https://accounts.northwind-shop.test/login"]),
            login("d", "Look-alike", &["https://northwind-sh0p.test"]),
            login("e", "Other", &["https://example.com"]),
        ];
        let p = page("https://accounts.northwind-shop.test/sign-in").unwrap();
        let used = HashMap::from([("a".to_string(), "2026-11-14T10:00:00Z".to_string()), ("b".to_string(), "2026-11-15T10:00:00Z".to_string())]);
        let ids: Vec<&str> = rank(&p, &logins, &used).iter().map(|l| l.id.as_str()).collect();
        assert_eq!(ids, ["c", "b", "a"]);
        // Never used: by name ("northwind (work)" sorts before "northwind-shop.test").
        let ids: Vec<&str> = rank(&p, &logins, &HashMap::new()).iter().map(|l| l.id.as_str()).collect();
        assert_eq!(ids, ["c", "a", "b"]);
        // The look-alike page gets only its own login.
        let p = page("https://northwind-sh0p.test/").unwrap();
        assert_eq!(rank(&p, &logins, &used).iter().map(|l| l.id.as_str()).collect::<Vec<_>>(), ["d"]);
    }
}
