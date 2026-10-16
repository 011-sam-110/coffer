//! Breach check helpers (SPEC 3.10), pure functions. The shell makes the
//! network call: `GET https://api.pwnedpasswords.com/range/<prefix>` with
//! `Add-Padding: true` and `User-Agent: Coffer`.
//!
//! Flow: [`crate::session::Vault::breach_queries`] -> one request per distinct
//! prefix -> [`parse_range_response`] -> [`match_queries`] ->
//! [`crate::session::Vault::apply_breach_results`].

use std::collections::HashMap;

use sha1::{Digest, Sha1};

/// One password to check: the SHA-1 prefix goes over the network, the
/// suffix stays here. `Debug` hides the suffix.
#[derive(Clone, PartialEq, Eq)]
pub struct BreachQuery {
    /// Item id.
    pub item_id: String,
    /// First 5 hex characters (upper case) of SHA-1(password).
    pub prefix: String,
    /// Remaining 35 hex characters (upper case).
    pub suffix: String,
}

impl std::fmt::Debug for BreachQuery {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "BreachQuery {{ item_id: {}, prefix: {}, suffix: <redacted> }}", self.item_id, self.prefix)
    }
}

/// Splits SHA-1(password) into (prefix of 5, suffix of 35), upper-case hex.
pub fn sha1_prefix_suffix(password: &str) -> (String, String) {
    let hex = crate::crypto::hex(&Sha1::digest(password.as_bytes())).to_ascii_uppercase();
    (hex[..5].to_owned(), hex[5..].to_owned())
}

/// Parses a range response (`SUFFIX:COUNT` lines). Drops padding lines
/// (count 0) and malformed lines. Suffixes are upper-cased.
pub fn parse_range_response(body: &str) -> HashMap<String, u64> {
    let mut out = HashMap::new();
    for line in body.lines() {
        let Some((suffix, count)) = line.trim().split_once(':') else { continue };
        let suffix = suffix.trim().to_ascii_uppercase();
        let Ok(count) = count.trim().parse::<u64>() else { continue };
        if count == 0 || suffix.len() != 35 || !suffix.chars().all(|c| c.is_ascii_hexdigit()) {
            continue;
        }
        out.insert(suffix, count);
    }
    out
}

/// Matches queries against parsed responses keyed by prefix. Returns
/// (item id, count) for every query whose prefix has a response; a query
/// whose prefix has no response is left out (not checked).
pub fn match_queries(queries: &[BreachQuery], responses: &HashMap<String, HashMap<String, u64>>) -> Vec<(String, u64)> {
    queries
        .iter()
        .filter_map(|q| {
            let r = responses.get(&q.prefix)?;
            Some((q.item_id.clone(), r.get(&q.suffix).copied().unwrap_or(0)))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefix_suffix_of_password() {
        // SHA-1("password") = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8.
        let (p, s) = sha1_prefix_suffix("password");
        assert_eq!(p, "5BAA6");
        assert_eq!(s, "1E4C9B93F3F0682250B6CF8331B7EE68FD8");
    }

    #[test]
    fn parse_drops_padding_and_junk() {
        let body = "1E4C9B93F3F0682250B6CF8331B7EE68FD8:9545824\r\n\
                    0018A45C4D1DEF81644B54AB7F969B88D65:0\r\n\
                    not a line\r\n\
                    00D4F6E8FA6EECAD2A3AA415EEC418D38EC:2\n";
        let m = parse_range_response(body);
        assert_eq!(m.len(), 2);
        assert_eq!(m["1E4C9B93F3F0682250B6CF8331B7EE68FD8"], 9_545_824);
        assert!(!m.contains_key("0018A45C4D1DEF81644B54AB7F969B88D65"));
    }

    #[test]
    fn matching() {
        let (p, s) = sha1_prefix_suffix("password");
        let q = vec![
            BreachQuery { item_id: "a".into(), prefix: p.clone(), suffix: s.clone() },
            BreachQuery { item_id: "b".into(), prefix: p.clone(), suffix: "0".repeat(35) },
            BreachQuery { item_id: "c".into(), prefix: "FFFFF".into(), suffix: s },
        ];
        let mut responses = HashMap::new();
        responses.insert(p, parse_range_response("1E4C9B93F3F0682250B6CF8331B7EE68FD8:7"));
        let r = match_queries(&q, &responses);
        assert_eq!(r, vec![("a".to_owned(), 7), ("b".to_owned(), 0)]);
        assert!(!format!("{:?}", q[0]).contains("1E4C9"));
    }
}
