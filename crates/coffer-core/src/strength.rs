//! Password strength with zxcvbn (SPEC 3.2, 7): score 0 to 4, crack time
//! text, warning. zxcvbn reads at most 100 characters (SPEC 7).

use crate::model::Strength;

/// zxcvbn reads at most this many characters.
pub const MAX_CHARS: usize = 100;

fn clip(s: &str) -> &str {
    match s.char_indices().nth(MAX_CHARS) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}

/// zxcvbn score (0 to 4) of a password with user inputs (vault name, title,
/// username, URL host, ...).
pub fn score(password: &str, user_inputs: &[&str]) -> u8 {
    let inputs: Vec<&str> = user_inputs.iter().map(|s| clip(s)).filter(|s| !s.is_empty()).collect();
    u8::from(zxcvbn::zxcvbn(clip(password), &inputs).score())
}

/// Full strength report for the `password_strength` command. The crack time
/// assumes an offline attack on a slow hash (10^4 guesses a second).
pub fn password_strength(password: &str, user_inputs: &[&str]) -> Strength {
    let inputs: Vec<&str> = user_inputs.iter().map(|s| clip(s)).filter(|s| !s.is_empty()).collect();
    let e = zxcvbn::zxcvbn(clip(password), &inputs);
    let warning = e.feedback().and_then(|f| f.warning()).map(|w| w.to_string());
    Strength {
        score: u8::from(e.score()),
        crack_time: e.crack_times().offline_slow_hashing_1e4_per_second().to_string(),
        warning,
    }
}

/// `true` when a new master password is strong enough (score 3 or more).
pub fn is_strong_enough(password: &str, user_inputs: &[&str]) -> bool {
    score(password, user_inputs) >= 3
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weak_and_strong() {
        assert!(score("password", &[]) <= 1);
        assert!(score("correct horse battery staple glimmer quarry", &[]) >= 3);
        let s = password_strength("password", &[]);
        assert!(s.warning.is_some());
        assert!(!s.crack_time.is_empty());
    }

    #[test]
    fn user_inputs_lower_the_score() {
        let with = score("Personalvault2026", &["Personalvault2026"]);
        assert!(with <= 1);
    }

    #[test]
    fn long_input_is_clipped() {
        let long = "a".repeat(10_000);
        let t0 = std::time::Instant::now();
        let _ = score(&long, &[]);
        assert!(t0.elapsed() < std::time::Duration::from_secs(2));
        assert_eq!(clip(&long).len(), 100);
    }
}
