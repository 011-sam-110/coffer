//! The Secret Key of SPEC 3.2 (v3).
//!
//! Text form: `C1-AAAAAA-XXXXXX-XXXXXX-XXXXX-XXXXX-XXXXK`
//! - `C1`: format version, a literal prefix (not alphabet symbols).
//! - `AAAAAA`: the key id, 6 random symbols made with the key (not derived
//!   from it, not secret).
//! - Then 26 secret symbols: one big-endian base-31 integer; the key bytes
//!   are that value as a big-endian u128 (decoding rejects 2^128 or more).
//! - Then 1 check symbol `K`: `c = (sum of w_i * v_i for i = 1..32) mod 31`
//!   over the 32 symbols of key id and secret, with weight
//!   `w_i = ((i - 1) mod 30) + 1` (no weight is 0 mod 31). It catches every
//!   single-symbol error and every swap except positions 1/31 and 2/32.
//!
//! The alphabet is `23456789ABCDEFGHJKLMNPQRSTVWXYZ` (31 symbols, values 0
//! to 30). Parse drops spaces and dashes, upper-cases, requires the `C1`
//! prefix, then exactly 33 alphabet symbols.

use zeroize::{Zeroize, Zeroizing};

use crate::crypto::{random_array, uniform};
use crate::error::{CoreError, Result};

/// The 31-symbol alphabet, value = index.
pub const ALPHABET: &[u8; 31] = b"23456789ABCDEFGHJKLMNPQRSTVWXYZ";
/// Format version prefix.
pub const PREFIX: &str = "C1";
const ID_LEN: usize = 6;
const SECRET_LEN: usize = 26;

/// The value of one alphabet symbol (case-insensitive), or `None`.
pub fn symbol_value(c: char) -> Option<u8> {
    let up = c.to_ascii_uppercase();
    if !up.is_ascii() {
        return None;
    }
    ALPHABET.iter().position(|&a| a as char == up).map(|p| p as u8)
}

/// The first character of `input` that cannot be in a Secret Key (spaces,
/// dashes and the leading `C1` are allowed). The UI shows "This character is
/// not in a Secret Key" for it at once.
pub fn first_invalid_char(input: &str) -> Option<char> {
    let cleaned: Vec<char> = input.chars().filter(|c| !c.is_whitespace() && *c != '-').collect();
    let start = if cleaned.len() >= 2 && cleaned[0].eq_ignore_ascii_case(&'c') && cleaned[1] == '1' {
        2
    } else if cleaned.len() == 1 && cleaned[0].eq_ignore_ascii_case(&'c') {
        1
    } else {
        0
    };
    cleaned[start..].iter().copied().find(|&c| symbol_value(c).is_none())
}

/// A Secret Key: 16 secret bytes and the public 6-symbol key id.
/// The bytes are zeroed on drop; `Debug` shows only the key id.
#[derive(Clone)]
pub struct SecretKey {
    key_id: String,
    bytes: Zeroizing<[u8; 16]>,
}

impl std::fmt::Debug for SecretKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SecretKey {{ key_id: {}, bytes: <redacted> }}", self.key_id)
    }
}

impl PartialEq for SecretKey {
    fn eq(&self, other: &Self) -> bool {
        use subtle::ConstantTimeEq;
        self.key_id == other.key_id && bool::from(self.bytes.ct_eq(&*other.bytes))
    }
}

impl SecretKey {
    /// A new Secret Key: 16 bytes and a 6-symbol key id from the OS CSPRNG.
    pub fn generate() -> SecretKey {
        let key_id: String = (0..ID_LEN).map(|_| ALPHABET[uniform(31) as usize] as char).collect();
        SecretKey { key_id, bytes: Zeroizing::new(random_array()) }
    }

    /// Rebuilds a key from its stored parts (the shell keeps the 16 bytes and
    /// the key id in `device.json`).
    ///
    /// # Errors
    /// `BadSecretKey` when the key id is not 6 alphabet symbols.
    pub fn from_parts(key_id: &str, bytes: [u8; 16]) -> Result<SecretKey> {
        let mut b = bytes;
        let id = normalize_key_id(key_id)?;
        let sk = SecretKey { key_id: id, bytes: Zeroizing::new(b) };
        b.zeroize();
        Ok(sk)
    }

    /// Parses the text form: drops spaces and dashes, upper-cases, requires
    /// the `C1` prefix, then exactly 33 alphabet symbols.
    ///
    /// # Errors
    /// `BadSecretKey` with a plain sentence: a character outside the
    /// alphabet, a missing prefix, a wrong length, a value of 2^128 or more,
    /// or a failed check symbol (a typo).
    pub fn parse(input: &str) -> Result<SecretKey> {
        if let Some(c) = first_invalid_char(input) {
            return Err(CoreError::BadSecretKey(format!("This character is not in a Secret Key: \"{c}\".")));
        }
        let mut cleaned: Zeroizing<Vec<char>> = Zeroizing::new(
            input.chars().filter(|c| !c.is_whitespace() && *c != '-').map(|c| c.to_ascii_uppercase()).collect(),
        );
        if !(cleaned.len() >= 2 && cleaned[0] == 'C' && cleaned[1] == '1') {
            return Err(CoreError::BadSecretKey("A Secret Key starts with \"C1\".".into()));
        }
        cleaned.drain(..2);
        let want = ID_LEN + SECRET_LEN + 1;
        if cleaned.len() != want {
            return Err(CoreError::BadSecretKey(format!(
                "A Secret Key has {want} symbols after \"C1\"; this one has {}.",
                cleaned.len()
            )));
        }
        let values: Zeroizing<Vec<u8>> =
            Zeroizing::new(cleaned.iter().map(|&c| symbol_value(c).expect("checked above")).collect());
        if check_symbol(&values[..ID_LEN + SECRET_LEN]) != values[ID_LEN + SECRET_LEN] {
            return Err(CoreError::BadSecretKey(
                "This Secret Key has a typo. Check each symbol against your Emergency Kit.".into(),
            ));
        }
        let key_id: String = cleaned[..ID_LEN].iter().collect();
        let mut acc: u128 = 0;
        for &v in &values[ID_LEN..ID_LEN + SECRET_LEN] {
            acc = acc
                .checked_mul(31)
                .and_then(|a| a.checked_add(u128::from(v)))
                .ok_or_else(|| CoreError::BadSecretKey("This is not a valid Secret Key.".into()))?;
        }
        let sk = SecretKey { key_id, bytes: Zeroizing::new(acc.to_be_bytes()) };
        acc.zeroize();
        Ok(sk)
    }

    /// `true` when `input` parses as a Secret Key.
    pub fn is_valid(input: &str) -> bool {
        Self::parse(input).is_ok()
    }

    /// The 6-symbol key id (not secret).
    pub fn key_id(&self) -> &str {
        &self.key_id
    }

    /// The 16 secret bytes.
    pub fn bytes(&self) -> &[u8; 16] {
        &self.bytes
    }

    /// The text form `C1-AAAAAA-XXXXXX-XXXXXX-XXXXX-XXXXX-XXXXK`.
    pub fn to_text(&self) -> Zeroizing<String> {
        let mut n = u128::from_be_bytes(*self.bytes);
        // 32 values: key id, then the 26 secret digits.
        let mut values = Zeroizing::new([0u8; ID_LEN + SECRET_LEN]);
        for (i, c) in self.key_id.chars().enumerate() {
            values[i] = symbol_value(c).expect("key id is valid");
        }
        for i in (0..SECRET_LEN).rev() {
            values[ID_LEN + i] = (n % 31) as u8;
            n /= 31;
        }
        n.zeroize();
        let check = check_symbol(&values[..]);
        let mut syms: Zeroizing<Vec<char>> = Zeroizing::new(values.iter().map(|&d| ALPHABET[d as usize] as char).collect());
        syms.push(ALPHABET[check as usize] as char);
        let mut out = Zeroizing::new(String::with_capacity(48));
        out.push_str(PREFIX);
        let mut pos = 0;
        for g in [6usize, 6, 6, 5, 5, 5] {
            out.push('-');
            for c in &syms[pos..pos + g] {
                out.push(*c);
            }
            pos += g;
        }
        out
    }
}

fn normalize_key_id(key_id: &str) -> Result<String> {
    let id: String = key_id.chars().map(|c| c.to_ascii_uppercase()).collect();
    if id.chars().count() != ID_LEN || id.chars().any(|c| symbol_value(c).is_none()) {
        return Err(CoreError::BadSecretKey("A key id has 6 Secret Key symbols.".into()));
    }
    Ok(id)
}

/// `c = (sum of w_i * v_i for i = 1..32) mod 31`, `w_i = ((i - 1) mod 30) + 1`.
fn check_symbol(values: &[u8]) -> u8 {
    let sum: u32 = values
        .iter()
        .enumerate()
        .map(|(idx, &v)| ((idx as u32) % 30 + 1) * u32::from(v))
        .sum();
    (sum % 31) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_text() {
        for _ in 0..50 {
            let sk = SecretKey::generate();
            let text = sk.to_text();
            assert_eq!(text.len(), "C1-AAAAAA-XXXXXX-XXXXXX-XXXXX-XXXXX-XXXXK".len(), "{}", &*text);
            assert!(text.starts_with(&format!("C1-{}-", sk.key_id())));
            let back = SecretKey::parse(&text).unwrap();
            assert_eq!(back, sk);
            // Forgiving input: lower case, spaces for dashes.
            let loose: String = text.to_lowercase().replace('-', " ");
            assert_eq!(SecretKey::parse(&loose).unwrap(), sk);
        }
    }

    #[test]
    fn prefix_is_required() {
        let sk = SecretKey::generate();
        let text = sk.to_text();
        assert!(SecretKey::parse(&text[3..]).is_err());
    }

    #[test]
    fn extremes_round_trip() {
        for bytes in [[0u8; 16], [0xff; 16]] {
            let sk = SecretKey::from_parts("ABCDEF", bytes).unwrap();
            assert_eq!(SecretKey::parse(&sk.to_text()).unwrap().bytes(), &bytes);
        }
    }

    #[test]
    fn rejects_2_pow_128_and_more() {
        // 26 symbols of value 30 (the largest base-31 number) is > 2^128.
        let mut vals = vec![10u8; 6];
        vals.extend([30u8; 26]);
        let check = check_symbol(&vals);
        let mut s = String::from("C1");
        for v in &vals {
            s.push(ALPHABET[*v as usize] as char);
        }
        s.push(ALPHABET[check as usize] as char);
        assert!(matches!(SecretKey::parse(&s), Err(CoreError::BadSecretKey(m)) if m.contains("not a valid")));
    }

    #[test]
    fn every_single_symbol_typo_is_caught() {
        let sk = SecretKey::generate();
        let text: Vec<char> = sk.to_text().chars().filter(|&c| c != '-').collect();
        // Positions 2.. are key id, secret and check.
        for pos in 2..text.len() {
            for &alt in ALPHABET.iter() {
                let alt = alt as char;
                if alt == text[pos] {
                    continue;
                }
                let mut t = text.clone();
                t[pos] = alt;
                let s: String = t.iter().collect();
                assert!(SecretKey::parse(&s).is_err(), "typo at {pos} not caught");
            }
        }
    }

    #[test]
    fn every_swap_except_1_31_and_2_32_is_caught() {
        let sk = SecretKey::generate();
        let text: Vec<char> = sk.to_text().chars().filter(|&c| c != '-').collect();
        // Symbol i (1-based, i = 1..32) is at text index i + 1.
        for i in 1..=32usize {
            for j in i + 1..=32usize {
                if (i, j) == (1, 31) || (i, j) == (2, 32) || text[i + 1] == text[j + 1] {
                    continue;
                }
                let mut t = text.clone();
                t.swap(i + 1, j + 1);
                let s: String = t.iter().collect();
                assert!(SecretKey::parse(&s).is_err(), "swap {i}<->{j} not caught");
            }
        }
    }

    #[test]
    fn weights_are_never_zero_mod_31() {
        for idx in 0..32u32 {
            assert_ne!((idx % 30 + 1) % 31, 0);
        }
        // Position 31 (the 25th secret symbol) is checked.
        let sk = SecretKey::from_parts("ABCDEF", [0x5a; 16]).unwrap();
        let mut t: Vec<char> = sk.to_text().chars().filter(|&c| c != '-').collect();
        t[32] = if t[32] == '2' { '3' } else { '2' };
        assert!(SecretKey::parse(&t.iter().collect::<String>()).is_err());
    }

    #[test]
    fn invalid_character_is_named() {
        assert_eq!(first_invalid_char("C1-ABCDEF-0"), Some('0'));
        assert_eq!(first_invalid_char("c1 abcdef"), None);
        assert_eq!(first_invalid_char("C1-abcdeU"), Some('U'));
        let e = SecretKey::parse("C1-ABCDEF-IIIII").unwrap_err();
        assert_eq!(e.code(), "badSecretKey");
        assert!(e.to_string().contains("\"I\""));
    }

    #[test]
    fn debug_hides_bytes() {
        let sk = SecretKey::from_parts("ABCDEF", [7u8; 16]).unwrap();
        let d = format!("{sk:?}");
        assert!(d.contains("ABCDEF") && d.contains("redacted") && !d.contains('7'));
    }
}
