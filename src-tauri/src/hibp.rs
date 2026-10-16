//! The one network call Coffer's code makes: the opt-in breach check
//! (SPEC 3.10). k-anonymity: only the first 5 hex characters of the SHA-1 of a
//! password leave the PC. The caller (phase B, the core) hashes and compares.

use std::time::Duration;

use crate::error::{CofferError, CofferResult};

/// Upper-case 5-hex-digit prefix, or `None`.
pub fn valid_prefix(prefix: &str) -> Option<String> {
    (prefix.len() == 5 && prefix.bytes().all(|b| b.is_ascii_hexdigit())).then(|| prefix.to_ascii_uppercase())
}

/// Parse a range body: `SUFFIX:COUNT` lines (35 hex suffix). Drops the padding
/// lines (count 0) and anything malformed.
pub fn parse_range_body(body: &str) -> Vec<(String, u64)> {
    body.lines()
        .filter_map(|line| {
            let (suffix, count) = line.trim().split_once(':')?;
            let count: u64 = count.trim().parse().ok()?;
            (count > 0 && suffix.len() == 35 && suffix.bytes().all(|b| b.is_ascii_hexdigit())).then(|| (suffix.to_ascii_uppercase(), count))
        })
        .collect()
}

/// `GET https://api.pwnedpasswords.com/range/<prefix>` with `Add-Padding: true`
/// and `User-Agent: Coffer`. Blocking: call it from `spawn_blocking`.
/// Returns (suffix, count) pairs without the padding lines.
pub fn hibp_range(prefix: &str) -> CofferResult<Vec<(String, u64)>> {
    let prefix = valid_prefix(prefix).ok_or_else(|| CofferError::invalid("A range prefix is 5 hex characters."))?;
    let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(20))).https_only(true).user_agent("Coffer").build().into();
    let url = format!("https://api.pwnedpasswords.com/range/{prefix}");
    let mut response = agent.get(&url).header("Add-Padding", "true").call().map_err(|e| {
        crate::log!("hibp: request failed: {e}");
        CofferError::network("Coffer could not reach the breach check service. Check your internet connection.")
    })?;
    let body = response.body_mut().with_config().limit(8 * 1024 * 1024).read_to_string().map_err(|e| {
        crate::log!("hibp: reading the answer failed: {e}");
        CofferError::network("The breach check service sent an answer Coffer could not read.")
    })?;
    Ok(parse_range_body(&body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefixes() {
        assert_eq!(valid_prefix("21bd1").as_deref(), Some("21BD1"));
        assert_eq!(valid_prefix("21BD"), None);
        assert_eq!(valid_prefix("21BD12"), None);
        assert_eq!(valid_prefix("21BDG"), None);
    }

    #[test]
    fn body_drops_padding_and_junk() {
        let body = "0018A45C4D1DEF81644B54AB7F969B88D65:10\r\n00D4F6E8FA6EECAD2A3AA415EEC418D38EC:0\r\nnot a line\r\n011053FD0102E94D6AE2F8B83D76FAF94F6:3\r\n";
        assert_eq!(parse_range_body(body), vec![("0018A45C4D1DEF81644B54AB7F969B88D65".to_string(), 10), ("011053FD0102E94D6AE2F8B83D76FAF94F6".to_string(), 3)]);
    }

    /// Real network call; run on request: `cargo test -p coffer -- --ignored hibp`.
    #[test]
    #[ignore]
    fn live_range_has_the_sha1_of_password() {
        // SHA-1("password") = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8
        let rows = hibp_range("5BAA6").unwrap();
        let hit = rows.iter().find(|(s, _)| s == "1E4C9B93F3F0682250B6CF8331B7EE68FD8").expect("the suffix is in the range");
        assert!(hit.1 > 1000);
        assert!(rows.iter().all(|(_, c)| *c > 0));
    }
}
