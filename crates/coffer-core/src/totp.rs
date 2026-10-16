//! TOTP (SPEC 6): RFC 6238 with SHA-1, SHA-256 or SHA-512, 6 to 8 digits,
//! period 30 or 60. Input: `otpauth://totp/...` URIs, bare base32 secrets
//! (spaces and lower case allowed), and `steam://<secret>` (5 symbols from
//! Steam's alphabet).

use hmac::{Hmac, KeyInit, Mac};
use zeroize::Zeroizing;

use crate::error::{CoreError, Result};
use crate::model::{TotpCode, TotpParse};

/// Hash of the HMAC.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TotpAlgorithm {
    /// HMAC-SHA1 (default).
    Sha1,
    /// HMAC-SHA256.
    Sha256,
    /// HMAC-SHA512.
    Sha512,
}

/// A parsed TOTP secret. `Debug` hides the key.
#[derive(Clone)]
pub struct Totp {
    secret: Zeroizing<Vec<u8>>,
    /// Hash.
    pub algorithm: TotpAlgorithm,
    /// Digits (6 to 8; 5 for Steam).
    pub digits: u32,
    /// Period in seconds (30 or 60).
    pub period: u64,
    /// Steam Guard codes.
    pub steam: bool,
    /// Issuer from the URI.
    pub issuer: Option<String>,
    /// Account from the URI label.
    pub account: Option<String>,
}

impl std::fmt::Debug for Totp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Totp")
            .field("algorithm", &self.algorithm)
            .field("digits", &self.digits)
            .field("period", &self.period)
            .field("steam", &self.steam)
            .finish_non_exhaustive()
    }
}

const STEAM_ALPHABET: &[u8] = b"23456789BCDFGHJKMNPQRTVWXY";

fn invalid(msg: &str) -> CoreError {
    CoreError::invalid(msg)
}

/// Decodes RFC 4648 base32 (case-insensitive; spaces, dashes and `=`
/// padding ignored).
pub fn base32_decode(input: &str) -> Option<Zeroizing<Vec<u8>>> {
    let mut out = Zeroizing::new(Vec::with_capacity(input.len() * 5 / 8));
    let mut buf: u64 = 0;
    let mut bits = 0u32;
    let mut any = false;
    for c in input.chars() {
        if c.is_whitespace() || c == '-' || c == '=' {
            continue;
        }
        let v = match c.to_ascii_uppercase() {
            ch @ 'A'..='Z' => ch as u64 - 'A' as u64,
            ch @ '2'..='7' => ch as u64 - '2' as u64 + 26,
            _ => return None,
        };
        any = true;
        buf = (buf << 5) | v;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }
    if !any { None } else { Some(out) }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() + 0 && i + 2 <= bytes.len() - 1 {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(if bytes[i] == b'+' { b' ' } else { bytes[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

impl Totp {
    /// Parses an `otpauth://totp/` URI, a `steam://` URI or a bare base32
    /// secret.
    ///
    /// # Errors
    /// `Invalid` with a plain sentence.
    pub fn parse(input: &str) -> Result<Totp> {
        let t = input.trim();
        let lower = t.to_ascii_lowercase();
        if lower.starts_with("otpauth://") {
            return Self::parse_uri(t);
        }
        if lower.starts_with("steam://") {
            let secret = base32_decode(&t[8..]).ok_or_else(|| invalid("This Steam secret is not base32."))?;
            return Ok(Totp {
                secret,
                algorithm: TotpAlgorithm::Sha1,
                digits: 5,
                period: 30,
                steam: true,
                issuer: Some("Steam".into()),
                account: None,
            });
        }
        let secret = base32_decode(t).ok_or_else(|| invalid("This is not a one-time code secret or otpauth:// link."))?;
        if secret.len() < 10 {
            return Err(invalid("This one-time code secret is too short."));
        }
        Ok(Totp { secret, algorithm: TotpAlgorithm::Sha1, digits: 6, period: 30, steam: false, issuer: None, account: None })
    }

    fn parse_uri(t: &str) -> Result<Totp> {
        let rest = &t["otpauth://".len()..];
        let (kind, rest) = rest.split_once('/').ok_or_else(|| invalid("This otpauth:// link has no type."))?;
        if !kind.eq_ignore_ascii_case("totp") {
            return Err(invalid("Coffer supports time-based codes (otpauth://totp) only."));
        }
        let (label, query) = rest.split_once('?').unwrap_or((rest, ""));
        let label = percent_decode(label);
        let (mut issuer, account) = match label.split_once(':') {
            Some((i, a)) => (Some(i.trim().to_owned()), Some(a.trim().to_owned())),
            None if label.trim().is_empty() => (None, None),
            None => (None, Some(label.trim().to_owned())),
        };
        let mut secret = None;
        let mut algorithm = TotpAlgorithm::Sha1;
        let mut digits = 6;
        let mut period = 30;
        for pair in query.split('&') {
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            let v = percent_decode(v);
            match k.to_ascii_lowercase().as_str() {
                "secret" => secret = Some(base32_decode(&v).ok_or_else(|| invalid("The secret in this link is not base32."))?),
                "issuer" if !v.is_empty() => issuer = Some(v),
                "algorithm" => {
                    algorithm = match v.to_ascii_uppercase().as_str() {
                        "SHA1" => TotpAlgorithm::Sha1,
                        "SHA256" => TotpAlgorithm::Sha256,
                        "SHA512" => TotpAlgorithm::Sha512,
                        _ => return Err(invalid("Coffer supports SHA1, SHA256 and SHA512 codes.")),
                    }
                }
                "digits" => digits = v.parse().map_err(|_| invalid("The digits in this link are not a number."))?,
                "period" => period = v.parse().map_err(|_| invalid("The period in this link is not a number."))?,
                _ => {}
            }
        }
        let secret = secret.ok_or_else(|| invalid("This otpauth:// link has no secret."))?;
        if !(6..=8).contains(&digits) {
            return Err(invalid("Coffer supports codes of 6 to 8 digits."));
        }
        if period != 30 && period != 60 {
            return Err(invalid("Coffer supports a period of 30 or 60 seconds."));
        }
        let issuer = issuer.filter(|s| !s.is_empty());
        let account = account.filter(|s| !s.is_empty());
        Ok(Totp { secret, algorithm, digits, period, steam: false, issuer, account })
    }

    fn hotp(&self, counter: u64) -> u32 {
        let msg = counter.to_be_bytes();
        let mac: Zeroizing<Vec<u8>> = Zeroizing::new(match self.algorithm {
            TotpAlgorithm::Sha1 => {
                let mut m = <Hmac<sha1::Sha1> as KeyInit>::new_from_slice(&self.secret).expect("any key length");
                m.update(&msg);
                m.finalize().into_bytes().to_vec()
            }
            TotpAlgorithm::Sha256 => {
                let mut m = <Hmac<sha2::Sha256> as KeyInit>::new_from_slice(&self.secret).expect("any key length");
                m.update(&msg);
                m.finalize().into_bytes().to_vec()
            }
            TotpAlgorithm::Sha512 => {
                let mut m = <Hmac<sha2::Sha512> as KeyInit>::new_from_slice(&self.secret).expect("any key length");
                m.update(&msg);
                m.finalize().into_bytes().to_vec()
            }
        });
        let off = (mac[mac.len() - 1] & 0x0f) as usize;
        u32::from_be_bytes([mac[off] & 0x7f, mac[off + 1], mac[off + 2], mac[off + 3]])
    }

    /// The code at a Unix time.
    pub fn code_at(&self, unix_secs: u64) -> TotpCode {
        let counter = unix_secs / self.period;
        let bin = self.hotp(counter);
        let code = if self.steam {
            let mut v = bin;
            let mut s = String::with_capacity(5);
            for _ in 0..5 {
                s.push(STEAM_ALPHABET[(v % 26) as usize] as char);
                v /= 26;
            }
            s
        } else {
            let m = 10u32.pow(self.digits);
            format!("{:0width$}", bin % m, width = self.digits as usize)
        };
        TotpCode { code, period: self.period, remaining: self.period - unix_secs % self.period }
    }

    /// The code now.
    pub fn code_now(&self) -> TotpCode {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        self.code_at(now)
    }
}

/// The `totp_parse` command: issuer, account, valid. Never returns the secret.
pub fn totp_parse(input: &str) -> TotpParse {
    match Totp::parse(input) {
        Ok(t) => TotpParse { issuer: t.issuer.clone(), account: t.account.clone(), valid: true },
        Err(_) => TotpParse { issuer: None, account: None, valid: false },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with(secret: &[u8], alg: TotpAlgorithm) -> Totp {
        Totp {
            secret: Zeroizing::new(secret.to_vec()),
            algorithm: alg,
            digits: 8,
            period: 30,
            steam: false,
            issuer: None,
            account: None,
        }
    }

    // RFC 6238 Appendix B, Table 1 (copied from rfc6238.txt). Seeds from the
    // reference code in Appendix A: 20, 32 and 64 bytes of "1234567890...".
    #[test]
    fn kat_rfc6238_appendix_b() {
        let seed20 = b"12345678901234567890";
        let seed32 = b"12345678901234567890123456789012";
        let seed64 = b"1234567890123456789012345678901234567890123456789012345678901234";
        let rows: [(u64, &str, &str, &str); 6] = [
            (59, "94287082", "46119246", "90693936"),
            (1111111109, "07081804", "68084774", "25091201"),
            (1111111111, "14050471", "67062674", "99943326"),
            (1234567890, "89005924", "91819424", "93441116"),
            (2000000000, "69279037", "90698825", "38618901"),
            (20000000000, "65353130", "77737706", "47863826"),
        ];
        let s1 = with(seed20, TotpAlgorithm::Sha1);
        let s256 = with(seed32, TotpAlgorithm::Sha256);
        let s512 = with(seed64, TotpAlgorithm::Sha512);
        for (t, a, b, c) in rows {
            assert_eq!(s1.code_at(t).code, a, "SHA1 at {t}");
            assert_eq!(s256.code_at(t).code, b, "SHA256 at {t}");
            assert_eq!(s512.code_at(t).code, c, "SHA512 at {t}");
        }
    }

    #[test]
    fn parse_uri() {
        // Base32 of "12345678901234567890" is GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ.
        let t = Totp::parse("otpauth://totp/ACME%20Co:alice@example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=ACME%20Co&algorithm=SHA1&digits=8&period=30").unwrap();
        assert_eq!(t.issuer.as_deref(), Some("ACME Co"));
        assert_eq!(t.account.as_deref(), Some("alice@example.com"));
        assert_eq!(t.code_at(59).code, "94287082");
        assert_eq!(t.code_at(59).remaining, 1);
        assert!(Totp::parse("otpauth://hotp/x?secret=GEZDGNBV").is_err());
        assert!(Totp::parse("otpauth://totp/x?secret=GEZDGNBVGY3TQOJQ&digits=9").is_err());
        assert!(Totp::parse("otpauth://totp/x?secret=GEZDGNBVGY3TQOJQ&period=45").is_err());
        assert!(Totp::parse("otpauth://totp/x?secret=GEZDGNBVGY3TQOJQ&algorithm=MD5").is_err());
    }

    #[test]
    fn bare_base32_with_spaces_and_lower_case() {
        let t = Totp::parse("gezd gnbv gy3t qojq gezd gnbv gy3t qojq").unwrap();
        assert_eq!(t.digits, 6);
        assert_eq!(t.code_at(59).code, "287082");
        assert!(Totp::parse("not base32!").is_err());
    }

    #[test]
    fn steam_codes_use_steam_alphabet() {
        let t = Totp::parse("steam://GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ").unwrap();
        let c = t.code_at(1_700_000_000).code;
        assert_eq!(c.len(), 5);
        assert!(c.bytes().all(|b| STEAM_ALPHABET.contains(&b)));
    }

    #[test]
    fn parse_command_never_leaks() {
        let p = totp_parse("otpauth://totp/GitHub:me?secret=GEZDGNBVGY3TQOJQ");
        assert!(p.valid);
        assert_eq!(p.issuer.as_deref(), Some("GitHub"));
        assert!(!totp_parse("nope!").valid);
        let dbg = format!("{:?}", Totp::parse("GEZDGNBVGY3TQOJQ").unwrap());
        assert!(!dbg.contains("secret:"));
    }
}
