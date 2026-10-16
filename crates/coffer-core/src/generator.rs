//! Password generator (SPEC 5): random characters, EFF passphrase, PIN.
//!
//! - Every random choice is uniform: [`crate::crypto::uniform`] draws from
//!   the OS CSPRNG with rejection sampling (no modulo bias).
//! - Random mode: each chosen set appears at least once (and at least the
//!   minimum digits and symbols). When a uniform draw of the whole password
//!   meets the rules with probability 1/1000 or more, Coffer redraws until it
//!   does, so the output is uniform over every password that meets the rules
//!   and the entropy is exactly log2 of their count (counted by dynamic
//!   programming). Otherwise (large minimums on short passwords) it places
//!   the required characters, fills the rest from the whole alphabet and
//!   shuffles; the entropy shown is then a lower bound that counts only the
//!   independent draws.
//! - Passphrase: EFF large word list (7,776 words, CC BY 3.0 US).

use zeroize::Zeroizing;

use crate::crypto::uniform;
use crate::error::{CoreError, Result};
use crate::model::{Generated, GeneratorMode, GeneratorOptions, StrengthLabel};

/// Upper-case letters.
pub const UPPER: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/// Lower-case letters.
pub const LOWER: &str = "abcdefghijklmnopqrstuvwxyz";
/// Digits.
pub const DIGITS: &str = "0123456789";
/// Symbols of SPEC 5.
pub const SYMBOLS: &str = "!@#$%^&*()-_=+[]{};:,.?/";
/// Look-alike characters dropped by "Avoid look-alike characters".
pub const AMBIGUOUS: &str = "0O1lI|";

static EFF_RAW: &str = include_str!("../data/eff_large_wordlist.txt");

/// The EFF large word list, 7,776 words in dice order.
pub fn eff_words() -> &'static [&'static str] {
    use std::sync::OnceLock;
    static WORDS: OnceLock<Vec<&'static str>> = OnceLock::new();
    WORDS.get_or_init(|| {
        EFF_RAW
            .lines()
            .filter_map(|l| l.split('\t').nth(1))
            .map(str::trim)
            .filter(|w| !w.is_empty())
            .collect()
    })
}

/// The label for a number of bits: weak < 40, fair < 60, good < 80,
/// strong < 100, else excellent.
pub fn label_for_bits(bits: f64) -> StrengthLabel {
    if bits < 40.0 {
        StrengthLabel::Weak
    } else if bits < 60.0 {
        StrengthLabel::Fair
    } else if bits < 80.0 {
        StrengthLabel::Good
    } else if bits < 100.0 {
        StrengthLabel::Strong
    } else {
        StrengthLabel::Excellent
    }
}

fn round1(x: f64) -> f64 {
    (x * 10.0).floor() / 10.0
}

fn finish(value: Zeroizing<String>, bits: f64) -> Generated {
    let entropy_bits = round1(bits);
    Generated { value: (*value).clone(), entropy_bits, label: label_for_bits(entropy_bits) }
}

/// Generates one value from the options.
///
/// # Errors
/// `Invalid` when an option is out of range or no character is left to use.
pub fn generate(opts: &GeneratorOptions) -> Result<Generated> {
    match opts.mode {
        GeneratorMode::Random => random(opts),
        GeneratorMode::Passphrase => passphrase(opts),
        GeneratorMode::Pin => pin(opts),
    }
}

struct CharSet {
    chars: Vec<char>,
    min: u32,
}

fn filtered(set: &str, opts: &GeneratorOptions) -> Vec<char> {
    set.chars()
        .filter(|c| !(opts.avoid_ambiguous && AMBIGUOUS.contains(*c)))
        .filter(|c| !opts.exclude.contains(*c))
        .collect()
}

fn random(opts: &GeneratorOptions) -> Result<Generated> {
    if !(8..=128).contains(&opts.length) {
        return Err(CoreError::invalid("A random password has 8 to 128 characters."));
    }
    if opts.min_digits > 9 || opts.min_symbols > 9 {
        return Err(CoreError::invalid("Minimum digits and symbols are 0 to 9."));
    }
    let mut sets = Vec::new();
    for (on, chars, min, name) in [
        (opts.upper, UPPER, 1, "upper-case letter"),
        (opts.lower, LOWER, 1, "lower-case letter"),
        (opts.digits, DIGITS, opts.min_digits.max(1), "digit"),
        (opts.symbols, SYMBOLS, opts.min_symbols.max(1), "symbol"),
    ] {
        if on {
            let c = filtered(chars, opts);
            if c.is_empty() {
                return Err(CoreError::invalid(format!("Every {name} is excluded.")));
            }
            sets.push(CharSet { chars: c, min });
        }
    }
    if sets.is_empty() {
        return Err(CoreError::invalid("Choose at least one set of characters."));
    }
    let len = opts.length as usize;
    let min_total: u32 = sets.iter().map(|s| s.min).sum();
    if min_total as usize > len {
        return Err(CoreError::invalid("The minimums need more characters than the length."));
    }
    let alphabet: Vec<char> = sets.iter().flat_map(|s| s.chars.iter().copied()).collect();
    let n = alphabet.len() as u32;
    let sizes: Vec<f64> = sets.iter().map(|s| s.chars.len() as f64).collect();
    let mins: Vec<u32> = sets.iter().map(|s| s.min).collect();
    let log2_valid = log2_count_valid(len, &sizes, &mins);
    let log2_all = len as f64 * f64::from(n).log2();
    let p_accept = (log2_valid - log2_all).exp2();

    if p_accept >= 1e-3 {
        // Uniform over every password that meets the rules.
        loop {
            let mut out = Zeroizing::new(String::with_capacity(len));
            let mut counts = vec![0u32; sets.len()];
            for _ in 0..len {
                let i = uniform(n) as usize;
                let c = alphabet[i];
                // Which set: sets are disjoint and laid out in order.
                let mut acc = 0;
                for (k, s) in sets.iter().enumerate() {
                    if i < acc + s.chars.len() {
                        counts[k] += 1;
                        break;
                    }
                    acc += s.chars.len();
                }
                out.push(c);
            }
            if counts.iter().zip(&mins).all(|(c, m)| c >= m) {
                return Ok(finish(out, log2_valid));
            }
        }
    }
    // Place the required characters, fill, shuffle (Fisher-Yates).
    let mut chars: Zeroizing<Vec<char>> = Zeroizing::new(Vec::with_capacity(len));
    let mut bits = 0.0;
    for s in &sets {
        for _ in 0..s.min {
            chars.push(s.chars[uniform(s.chars.len() as u32) as usize]);
            bits += (s.chars.len() as f64).log2();
        }
    }
    while chars.len() < len {
        chars.push(alphabet[uniform(n) as usize]);
        bits += f64::from(n).log2();
    }
    for i in (1..chars.len()).rev() {
        let j = uniform(i as u32 + 1) as usize;
        chars.swap(i, j);
    }
    let out = Zeroizing::new(chars.iter().collect::<String>());
    Ok(finish(out, bits))
}

/// log2 of the number of strings of length `len` over disjoint sets of the
/// given sizes where set k appears at least `mins[k]` times. Dynamic
/// programming over capped counts, in f64 (exact enough: < 2^1024).
fn log2_count_valid(len: usize, sizes: &[f64], mins: &[u32]) -> f64 {
    // State: capped count per set. Encode as mixed-radix index.
    let radix: Vec<usize> = mins.iter().map(|&m| m as usize + 1).collect();
    let states: usize = radix.iter().product();
    // Scale to avoid overflow: keep values divided by a running power of 2.
    let mut dp = vec![0f64; states];
    dp[0] = 1.0;
    let mut log2_scale = 0.0;
    for _ in 0..len {
        let mut next = vec![0f64; states];
        for (idx, &v) in dp.iter().enumerate() {
            if v == 0.0 {
                continue;
            }
            // Decode idx.
            let mut rem = idx;
            let mut digits = Vec::with_capacity(radix.len());
            for &r in &radix {
                digits.push(rem % r);
                rem /= r;
            }
            for (k, &size) in sizes.iter().enumerate() {
                let mut d = digits.clone();
                if d[k] + 1 < radix[k] {
                    d[k] += 1;
                }
                let mut j = 0;
                let mut mul = 1;
                for (t, &r) in radix.iter().enumerate() {
                    j += d[t] * mul;
                    mul *= r;
                }
                next[j] += v * size;
            }
        }
        let max = next.iter().cloned().fold(0.0, f64::max);
        if max > 0.0 {
            let e = max.log2().floor();
            let s = e.exp2();
            for x in &mut next {
                *x /= s;
            }
            log2_scale += e;
        }
        dp = next;
    }
    dp[states - 1].log2() + log2_scale
}

fn passphrase(opts: &GeneratorOptions) -> Result<Generated> {
    if !(3..=20).contains(&opts.words) {
        return Err(CoreError::invalid("A passphrase has 3 to 20 words."));
    }
    if opts.separator.chars().count() > 3 {
        return Err(CoreError::invalid("A separator has at most 3 characters."));
    }
    let words = eff_words();
    let n = words.len() as u32;
    let count = opts.words as usize;
    let mut chosen: Vec<Zeroizing<String>> = (0..count)
        .map(|_| {
            let w = words[uniform(n) as usize];
            let mut s = Zeroizing::new(String::new());
            if opts.capitalize {
                let mut it = w.chars();
                if let Some(first) = it.next() {
                    s.extend(first.to_uppercase());
                    s.push_str(it.as_str());
                }
            } else {
                s.push_str(w);
            }
            s
        })
        .collect();
    let mut bits = count as f64 * f64::from(n).log2();
    if opts.include_number {
        let which = uniform(count as u32) as usize;
        let digit = char::from(b'0' + uniform(10) as u8);
        chosen[which].push(digit);
        bits += 10f64.log2() + (count as f64).log2();
    }
    let mut out = Zeroizing::new(String::new());
    for (i, w) in chosen.iter().enumerate() {
        if i > 0 {
            out.push_str(&opts.separator);
        }
        out.push_str(w);
    }
    Ok(finish(out, bits))
}

fn pin(opts: &GeneratorOptions) -> Result<Generated> {
    if !(4..=12).contains(&opts.length) {
        return Err(CoreError::invalid("A PIN has 4 to 12 digits."));
    }
    let out = Zeroizing::new((0..opts.length).map(|_| char::from(b'0' + uniform(10) as u8)).collect::<String>());
    Ok(finish(out, f64::from(opts.length) * 10f64.log2()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eff_list_has_7776_words() {
        let w = eff_words();
        assert_eq!(w.len(), 7776);
        assert_eq!(w[0], "abacus");
        assert_eq!(w[7775], "zoom");
        let mut sorted = w.to_vec();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), 7776, "words are unique");
    }

    fn opts() -> GeneratorOptions {
        GeneratorOptions::default()
    }

    #[test]
    fn random_has_each_chosen_set_and_minimums() {
        let mut o = opts();
        o.length = 12;
        o.min_digits = 3;
        o.min_symbols = 2;
        for _ in 0..200 {
            let g = generate(&o).unwrap();
            let v = &g.value;
            assert_eq!(v.chars().count(), 12);
            assert!(v.chars().any(|c| c.is_ascii_uppercase()));
            assert!(v.chars().any(|c| c.is_ascii_lowercase()));
            assert!(v.chars().filter(char::is_ascii_digit).count() >= 3);
            assert!(v.chars().filter(|c| SYMBOLS.contains(*c)).count() >= 2);
        }
    }

    #[test]
    fn random_forced_path_meets_large_minimums() {
        let mut o = opts();
        o.length = 20;
        o.min_digits = 9;
        o.min_symbols = 9;
        for _ in 0..50 {
            let g = generate(&o).unwrap();
            assert!(g.value.chars().filter(char::is_ascii_digit).count() >= 9);
            assert!(g.value.chars().filter(|c| SYMBOLS.contains(*c)).count() >= 9);
        }
    }

    #[test]
    fn avoid_ambiguous_and_exclude() {
        let mut o = opts();
        o.avoid_ambiguous = true;
        o.exclude = "abc".into();
        for _ in 0..200 {
            let g = generate(&o).unwrap();
            assert!(!g.value.chars().any(|c| AMBIGUOUS.contains(c) || "abc".contains(c)));
        }
        let mut o = opts();
        o.upper = false;
        o.lower = false;
        o.symbols = false;
        o.exclude = DIGITS.into();
        assert!(generate(&o).is_err());
    }

    #[test]
    fn entropy_matches_counting() {
        // Lower only, length 10: exactly 10 * log2(26).
        let mut o = opts();
        o.upper = false;
        o.digits = false;
        o.symbols = false;
        o.length = 10;
        let g = generate(&o).unwrap();
        assert_eq!(g.entropy_bits, round1(10.0 * 26f64.log2()));
        // Two sets, each at least once, length 8: 52^8 - 2 * 26^8.
        let want = ((52f64).powi(8) - 2.0 * (26f64).powi(8)).log2();
        assert!((log2_count_valid(8, &[26.0, 26.0], &[1, 1]) - want).abs() < 1e-9);
        // Default options: 20 characters is "excellent" (> 100 bits).
        assert_eq!(generate(&opts()).unwrap().label, StrengthLabel::Excellent);
    }

    #[test]
    fn passphrase_shape() {
        let mut o = opts();
        o.mode = GeneratorMode::Passphrase;
        o.words = 6;
        o.separator = ".".into();
        o.capitalize = true;
        o.include_number = true;
        let g = generate(&o).unwrap();
        let parts: Vec<&str> = g.value.split('.').collect();
        assert_eq!(parts.len(), 6);
        assert!(parts.iter().all(|p| p.chars().next().unwrap().is_uppercase()));
        assert_eq!(g.value.chars().filter(char::is_ascii_digit).count(), 1);
        let want = 6.0 * 7776f64.log2() + 10f64.log2() + 6f64.log2();
        assert_eq!(g.entropy_bits, round1(want));
        o.words = 2;
        assert!(generate(&o).is_err());
    }

    #[test]
    fn pin_shape() {
        let mut o = opts();
        o.mode = GeneratorMode::Pin;
        o.length = 6;
        let g = generate(&o).unwrap();
        assert_eq!(g.value.len(), 6);
        assert!(g.value.chars().all(|c| c.is_ascii_digit()));
        assert_eq!(g.label, StrengthLabel::Weak);
        o.length = 3;
        assert!(generate(&o).is_err());
    }

    #[test]
    fn labels() {
        assert_eq!(label_for_bits(39.9), StrengthLabel::Weak);
        assert_eq!(label_for_bits(40.0), StrengthLabel::Fair);
        assert_eq!(label_for_bits(60.0), StrengthLabel::Good);
        assert_eq!(label_for_bits(80.0), StrengthLabel::Strong);
        assert_eq!(label_for_bits(100.0), StrengthLabel::Excellent);
    }
}
