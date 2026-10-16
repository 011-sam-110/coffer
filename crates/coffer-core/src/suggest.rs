//! Quick Access suggestions (SPEC 9). Active items only, at most 5.
//! - Score 3: the item's `apps` holds the process name.
//! - Score 2: `usage.json` links the process and the item (never for browsers).
//! - Score 1, browsers only (chrome, msedge, firefox, brave, opera, vivaldi):
//!   a URL host label of 4 or more characters other than `www`, or the item
//!   title, is a whole word of the window title.
//! - Ties: `lastUsedAt` (newest first), then title.

use std::collections::HashMap;

use crate::model::{ItemState, StoredItem, url_host};

/// Browser process names (without `.exe`).
pub const BROWSERS: [&str; 6] = ["chrome", "msedge", "firefox", "brave", "opera", "vivaldi"];

/// Most suggestions returned.
pub const MAX_SUGGESTIONS: usize = 5;

fn exe_stem(process: &str) -> String {
    let p = process.trim().to_ascii_lowercase();
    let p = p.rsplit(['\\', '/']).next().unwrap_or(&p).to_owned();
    p.strip_suffix(".exe").map(str::to_owned).unwrap_or(p)
}

/// `true` when the process is one of the listed browsers.
pub fn is_browser(process: &str) -> bool {
    BROWSERS.contains(&exe_stem(process).as_str())
}

fn words(s: &str) -> Vec<String> {
    s.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_owned)
        .collect()
}

fn contains_phrase(hay: &[String], needle: &[String]) -> bool {
    !needle.is_empty() && hay.windows(needle.len()).any(|w| w == needle)
}

/// Ranks item ids for the window that was in front.
///
/// - `learned`: item ids `usage.json` links to this process.
/// - `last_used`: item id -> RFC 3339 time of last use.
pub fn suggest(
    items: &[&StoredItem],
    window_title: Option<&str>,
    process: Option<&str>,
    learned: &[String],
    last_used: &HashMap<String, String>,
) -> Vec<String> {
    let Some(process) = process.filter(|p| !p.trim().is_empty()) else {
        return Vec::new();
    };
    let stem = exe_stem(process);
    let browser = is_browser(process);
    let title_words = window_title.map(words).unwrap_or_default();
    let mut scored: Vec<(u8, Option<&str>, &str, String)> = Vec::new();
    for item in items.iter().filter(|i| i.state == ItemState::Active) {
        let id = item.id.to_string();
        let mut score = 0u8;
        if item.apps.iter().any(|a| exe_stem(a) == stem) {
            score = 3;
        } else if !browser && learned.iter().any(|l| *l == id) {
            score = 2;
        } else if browser && !title_words.is_empty() {
            let host_hit = item.urls.iter().filter_map(|u| url_host(&u.url)).any(|h| {
                h.split('.').any(|label| label.len() >= 4 && label != "www" && title_words.iter().any(|w| w == label))
            });
            let title_hit = contains_phrase(&title_words, &words(&item.title));
            if host_hit || title_hit {
                score = 1;
            }
        }
        if score > 0 {
            scored.push((score, last_used.get(&id).map(String::as_str), item.title.as_str(), id));
        }
    }
    scored.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| b.1.cmp(&a.1)) // newer RFC 3339 strings sort later; None sorts first, so reversed puts it last
            .then_with(|| a.2.to_lowercase().cmp(&b.2.to_lowercase()))
    });
    scored.into_iter().take(MAX_SUGGESTIONS).map(|s| s.3).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ItemType, ItemUrl};

    fn item(title: &str, url: &str, apps: &[&str]) -> StoredItem {
        let mut i = StoredItem::new(ItemType::Login, title, "2026-01-01T00:00:00Z");
        if !url.is_empty() {
            i.urls.push(ItemUrl { url: url.into(), label: None });
        }
        i.apps = apps.iter().map(|s| (*s).to_owned()).collect();
        i
    }

    #[test]
    fn scores_and_order() {
        let slack = item("Slack", "https://slack.com", &["slack.exe"]);
        let gh = item("GitHub", "https://github.com", &[]);
        let gh2 = item("GitHub work", "https://www.github.com", &[]);
        let bank = item("My Bank", "https://bank.example", &[]);
        let mut archived = item("GitHub old", "https://github.com", &[]);
        archived.state = ItemState::Archived;
        let items = vec![&slack, &gh, &gh2, &bank, &archived];
        let none = HashMap::new();

        assert_eq!(suggest(&items, Some("Slack | general"), Some("slack.exe"), &[], &none), vec![slack.id.to_string()]);
        // Browser: host label "github" is a word of the title.
        let r = suggest(&items, Some("Pull requests · GitHub - Google Chrome"), Some("chrome.exe"), &[], &none);
        assert_eq!(r, vec![gh.id.to_string(), gh2.id.to_string()]);
        // Ties: last used first.
        let mut lu = HashMap::new();
        lu.insert(gh2.id.to_string(), "2026-10-01T00:00:00Z".to_owned());
        let r = suggest(&items, Some("GitHub - Google Chrome"), Some("CHROME"), &[], &lu);
        assert_eq!(r[0], gh2.id.to_string());
        // Title as a whole phrase.
        let r = suggest(&items, Some("Welcome to My Bank online - Mozilla Firefox"), Some("firefox.exe"), &[], &none);
        assert_eq!(r, vec![bank.id.to_string()]);
        // Not a browser: no title matching; learned links count.
        assert!(suggest(&items, Some("GitHub"), Some("notepad.exe"), &[], &none).is_empty());
        let learned = vec![bank.id.to_string()];
        assert_eq!(suggest(&items, None, Some("notepad.exe"), &learned, &none), vec![bank.id.to_string()]);
        // Learned links never apply to browsers.
        assert!(suggest(&items, Some("x"), Some("msedge.exe"), &learned, &none).is_empty());
    }
}
