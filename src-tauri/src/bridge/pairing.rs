//! Pairing (docs/BRIDGE.md, "Pairing"; docs/SECURITY.md section 12).
//!
//! The extension sends an X25519 public key. Coffer makes its own X25519 key
//! for this one pairing and a random 16-byte client id, then both sides
//! compute:
//!
//! - transcript = SHA-256(`coffer/v1/pair` || 0x00 || extension key ||
//!   Coffer key || client id)
//! - the four words: big-endian u32 number i (i = 0..3) of the transcript,
//!   modulo 7776, into the EFF large word list
//! - the bridge key = HKDF-SHA256(salt = transcript, input = the X25519
//!   shared secret, info = `coffer/v1/bridge-key`), 32 bytes
//! - confirm = HMAC-SHA256(bridge key, `coffer/v1/pair-confirm` || 0x00 ||
//!   transcript), sent after Allow so the extension knows both sides hold the
//!   same key.
//!
//! The words show in Coffer's Connect prompt and in the extension; a program
//! that sends its own key at the same time gets other words.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use ring::{agreement, digest, hkdf, hmac};
use zeroize::Zeroizing;

const TRANSCRIPT_LABEL: &[u8] = b"coffer/v1/pair";
const KEY_INFO: &[u8] = b"coffer/v1/bridge-key";
const CONFIRM_LABEL: &[u8] = b"coffer/v1/pair-confirm";

pub type Key = Zeroizing<[u8; 32]>;

pub fn transcript(ext_pub: &[u8; 32], coffer_pub: &[u8; 32], client: &[u8; 16]) -> [u8; 32] {
    let mut d = digest::Context::new(&digest::SHA256);
    d.update(TRANSCRIPT_LABEL);
    d.update(&[0]);
    d.update(ext_pub);
    d.update(coffer_pub);
    d.update(client);
    let mut out = [0u8; 32];
    out.copy_from_slice(d.finish().as_ref());
    out
}

/// The four words of a transcript.
pub fn words(transcript: &[u8; 32]) -> [String; 4] {
    let list = coffer_core::generator::eff_words();
    std::array::from_fn(|i| {
        let n = u32::from_be_bytes([transcript[4 * i], transcript[4 * i + 1], transcript[4 * i + 2], transcript[4 * i + 3]]);
        list[(n % list.len() as u32) as usize].to_string()
    })
}

pub fn bridge_key(shared: &[u8], transcript: &[u8; 32]) -> Key {
    let prk = hkdf::Salt::new(hkdf::HKDF_SHA256, transcript).extract(shared);
    let mut key = Zeroizing::new([0u8; 32]);
    prk.expand(&[KEY_INFO], hkdf::HKDF_SHA256).and_then(|okm| okm.fill(&mut key[..])).expect("HKDF-SHA256 gives 32 bytes");
    key
}

/// base64 of HMAC-SHA256(key, `coffer/v1/pair-confirm` || 0x00 || transcript).
pub fn confirm(key: &[u8; 32], transcript: &[u8; 32]) -> String {
    let mut data = CONFIRM_LABEL.to_vec();
    data.push(0);
    data.extend_from_slice(transcript);
    STANDARD.encode(hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, key), &data))
}

/// Coffer's half: a new X25519 key, and the shared secret with `ext_pub`.
/// Err for a key that gives no usable secret.
pub fn agree(ext_pub: &[u8; 32]) -> Result<([u8; 32], Key), ()> {
    let rng = ring::rand::SystemRandom::new();
    let private = agreement::EphemeralPrivateKey::generate(&agreement::X25519, &rng).map_err(|_| ())?;
    let public = private.compute_public_key().map_err(|_| ())?;
    let mut ours = [0u8; 32];
    ours.copy_from_slice(public.as_ref());
    let peer = agreement::UnparsedPublicKey::new(&agreement::X25519, ext_pub);
    let shared = agreement::agree_ephemeral(private, &peer, |s| {
        let mut k = Zeroizing::new([0u8; 32]);
        k.copy_from_slice(s);
        k
    })
    .map_err(|_| ())?;
    Ok((ours, shared))
}

/// Lower-case hex.
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// The known-answer vector that `extension/src/lib/protocol.test.ts` checks too.
    pub fn vector() -> ([u8; 32], [u8; 32], [u8; 16], [u8; 32]) {
        let ext: [u8; 32] = std::array::from_fn(|i| i as u8 + 1);
        let coffer: [u8; 32] = std::array::from_fn(|i| i as u8 + 33);
        let client: [u8; 16] = std::array::from_fn(|i| i as u8 + 0xa0);
        (ext, coffer, client, [0x55; 32])
    }

    #[test]
    fn known_answers_match_the_extension() {
        let (ext, coffer, client, shared) = vector();
        let t = transcript(&ext, &coffer, &client);
        assert_eq!(hex(&t), "403f25b566c39a84e4c3854b9350fbafba43c0d561c2bb00c5889edfa26471bc");
        assert_eq!(words(&t), ["encroach", "avenging", "grinning", "handmade"].map(String::from));
        let key = bridge_key(&shared, &t);
        assert_eq!(hex(&key[..]), "4e38f02533065b48ddcf1b2b370d7ba7e41ef03ae5d4054ad797f0b6f1fbb04f");
        assert_eq!(confirm(&key, &t), "368XgU0cfrNmG0yZBWDV1pR6ThLa9tNy2R/O6BzIlO0=");
    }

    #[test]
    fn both_sides_get_the_same_words_and_key() {
        // The extension's side, played with ring's X25519 too.
        let rng = ring::rand::SystemRandom::new();
        let ext_private = agreement::EphemeralPrivateKey::generate(&agreement::X25519, &rng).unwrap();
        let ext_pub: [u8; 32] = ext_private.compute_public_key().unwrap().as_ref().try_into().unwrap();
        let (coffer_pub, coffer_shared) = agree(&ext_pub).unwrap();
        let client = [7u8; 16];
        let ext_shared = agreement::agree_ephemeral(ext_private, &agreement::UnparsedPublicKey::new(&agreement::X25519, coffer_pub), |s| s.to_vec()).unwrap();
        assert_eq!(&ext_shared[..], &coffer_shared[..]);

        let t_coffer = transcript(&ext_pub, &coffer_pub, &client);
        let t_ext = transcript(&ext_pub, &coffer_pub, &client);
        assert_eq!(words(&t_coffer), words(&t_ext));
        assert_eq!(*bridge_key(&coffer_shared[..], &t_coffer), *bridge_key(&ext_shared, &t_ext));

        // Another extension key (a second program at the same time): other words.
        let other_private = agreement::EphemeralPrivateKey::generate(&agreement::X25519, &rng).unwrap();
        let other_pub: [u8; 32] = other_private.compute_public_key().unwrap().as_ref().try_into().unwrap();
        assert_ne!(words(&transcript(&other_pub, &coffer_pub, &client)), words(&t_coffer));
        // Four words, each from the list.
        let list = coffer_core::generator::eff_words();
        assert!(words(&t_coffer).iter().all(|w| list.contains(&w.as_str())));
    }

    #[test]
    fn a_zero_key_is_refused() {
        // The all-zero point gives an all-zero secret; ring refuses it.
        assert!(agree(&[0u8; 32]).is_err());
    }
}
