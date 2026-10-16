//! Primitives of SPEC 3.3: password normalisation, Argon2id with a floor and
//! a ceiling, HKDF-SHA256, XChaCha20-Poly1305 and HMAC-SHA256.
//!
//! Every key lives in a [`Key32`], which zeroes its bytes on drop and never
//! prints them.

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use unicode_normalization::UnicodeNormalization;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use crate::error::{CoreError, Result};

/// Fills `buf` from the OS CSPRNG (`getrandom`).
///
/// # Panics
/// Panics when the OS random source fails. Coffer must not go on without it.
pub fn random_bytes(buf: &mut [u8]) {
    getrandom::fill(buf).expect("the OS random number generator failed");
}

/// `N` random bytes from the OS CSPRNG.
pub fn random_array<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    random_bytes(&mut b);
    b
}

/// A uniform random integer in `0..n` by rejection sampling (no modulo bias).
///
/// # Panics
/// Panics when `n == 0`.
pub fn uniform(n: u32) -> u32 {
    assert!(n > 0, "uniform(0)");
    // Largest multiple of n that fits; reject draws at or above it.
    let limit = u32::MAX - (u32::MAX % n);
    loop {
        let mut b = [0u8; 4];
        random_bytes(&mut b);
        let x = u32::from_le_bytes(b);
        if x < limit {
            return x % n;
        }
    }
}

/// A 32-byte key. Zeroed on drop; `Debug` prints no bytes.
#[derive(Clone, Zeroize, ZeroizeOnDrop, PartialEq, Eq)]
pub struct Key32(pub(crate) [u8; 32]);

impl Key32 {
    /// 32 random bytes.
    pub fn random() -> Self {
        Key32(random_array())
    }

    /// The raw bytes.
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    /// Constant-time equality.
    pub fn ct_eq(&self, other: &Key32) -> bool {
        use subtle::ConstantTimeEq;
        self.0.ct_eq(&other.0).into()
    }
}

impl std::fmt::Debug for Key32 {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Key32(<redacted>)")
    }
}

/// Argon2id cost settings stored in the vault header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KdfParams {
    /// Memory in KiB.
    pub m_kib: u32,
    /// Passes.
    pub t: u32,
    /// Lanes.
    pub p: u32,
}

impl KdfParams {
    /// SPEC default: 128 MiB, 3 passes, 4 lanes.
    pub const DEFAULT: KdfParams = KdfParams { m_kib: 131_072, t: 3, p: 4 };
    /// The floor: the smallest settings Coffer opens (64 MiB, t 2, p 1).
    pub const FLOOR: KdfParams = KdfParams { m_kib: 65_536, t: 2, p: 1 };
    /// The ceiling: the largest settings Coffer runs (1 GiB, t 10, p 16).
    pub const CEILING: KdfParams = KdfParams { m_kib: 1_048_576, t: 10, p: 16 };

    /// Test-only profile under the floor, so unit tests run fast. Reachable
    /// only from `#[cfg(test)]` code.
    #[cfg(test)]
    pub(crate) const TEST: KdfParams = KdfParams { m_kib: 64, t: 1, p: 1 };

    /// Checks the ceiling first (a crafted header must not freeze the app),
    /// then the floor. Runs before Argon2.
    ///
    /// # Errors
    /// `KdfTooStrong` above the ceiling, `KdfTooWeak` under the floor.
    pub fn check(&self) -> Result<()> {
        if self.m_kib > Self::CEILING.m_kib || self.t > Self::CEILING.t || self.p > Self::CEILING.p {
            return Err(CoreError::KdfTooStrong);
        }
        #[cfg(test)]
        if *self == Self::TEST {
            return Ok(());
        }
        if self.m_kib < Self::FLOOR.m_kib || self.t < Self::FLOOR.t || self.p < Self::FLOOR.p {
            return Err(CoreError::KdfTooWeak);
        }
        Ok(())
    }
}

/// Normalises a master password: Unicode NFKD, then trim leading and trailing
/// white space (SPEC 3.2).
pub fn normalize_password(password: &str) -> Zeroizing<String> {
    let nfkd: Zeroizing<String> = Zeroizing::new(password.nfkd().collect());
    Zeroizing::new(nfkd.trim().to_owned())
}

/// Raw Argon2id (version 0x13) with optional secret and associated data.
/// Does NOT check the floor or the ceiling: callers call [`KdfParams::check`].
///
/// # Errors
/// `Invalid` when the argon2 crate refuses the parameters.
pub fn argon2id_raw(
    password: &[u8],
    salt: &[u8],
    params: &KdfParams,
    secret: Option<&[u8]>,
    associated_data: Option<&[u8]>,
    out: &mut [u8],
) -> Result<()> {
    let mut builder = argon2::ParamsBuilder::new();
    builder.m_cost(params.m_kib).t_cost(params.t).p_cost(params.p).output_len(out.len());
    if let Some(ad) = associated_data {
        builder.data(argon2::AssociatedData::new(ad).map_err(|_| CoreError::invalid("Argon2 associated data too long."))?);
    }
    let p: Params = builder.build().map_err(|e| CoreError::invalid(format!("Argon2 parameters: {e}")))?;
    let ctx = match secret {
        Some(s) => Argon2::new_with_secret(s, Algorithm::Argon2id, Version::V0x13, p)
            .map_err(|e| CoreError::invalid(format!("Argon2 secret: {e}")))?,
        None => Argon2::new(Algorithm::Argon2id, Version::V0x13, p),
    };
    ctx.hash_password_into(password, salt, out)
        .map_err(|e| CoreError::invalid(format!("Argon2: {e}")))
}

/// `pw_key = Argon2id(password, salt, m, t, p, len 32)` after the floor and
/// ceiling check. `password` must already be normalised.
///
/// # Errors
/// `Corrupt` / `KdfTooWeak` from [`KdfParams::check`].
pub fn argon2id_key(password: &[u8], salt: &[u8], params: &KdfParams) -> Result<Key32> {
    params.check()?;
    let mut out = Key32([0u8; 32]);
    argon2id_raw(password, salt, params, None, None, &mut out.0)?;
    Ok(out)
}

/// HKDF-SHA256 (extract and expand) into `out`.
pub fn hkdf_sha256(ikm: &[u8], salt: &[u8], info: &[u8], out: &mut [u8]) {
    let hk = Hkdf::<Sha256>::new(Some(salt), ikm);
    hk.expand(info, out).expect("HKDF output length is within limits");
}

/// HKDF-SHA256 to a 32-byte key.
pub fn hkdf_key(ikm: &[u8], salt: &[u8], info: &str) -> Key32 {
    let mut k = Key32([0u8; 32]);
    hkdf_sha256(ikm, salt, info.as_bytes(), &mut k.0);
    k
}

/// `kek = HKDF(pw_key || sk_key, salt = kdf.salt, "coffer/v1/kek")` with
/// `sk_key = HKDF(secret_key, salt = vault_id, "coffer/v1/secret-key")`.
pub fn derive_kek(pw_key: &Key32, secret_key: &[u8; 16], vault_id: &uuid::Uuid, salt: &[u8]) -> Key32 {
    let sk_key = hkdf_key(secret_key, vault_id.as_bytes(), "coffer/v1/secret-key");
    let mut ikm = Zeroizing::new([0u8; 64]);
    ikm[..32].copy_from_slice(&pw_key.0);
    ikm[32..].copy_from_slice(&sk_key.0);
    hkdf_key(&ikm[..], salt, "coffer/v1/kek")
}

/// XChaCha20-Poly1305 encryption with a fresh 24-byte nonce from the OS RNG.
/// Returns `(nonce, ciphertext || tag)`.
pub fn seal(key: &Key32, aad: &[u8], plaintext: &[u8]) -> ([u8; 24], Vec<u8>) {
    let nonce: [u8; 24] = random_array();
    let ct = seal_with_nonce(key, &nonce, aad, plaintext);
    (nonce, ct)
}

/// XChaCha20-Poly1305 encryption with a given nonce (for known-answer tests).
pub fn seal_with_nonce(key: &Key32, nonce: &[u8; 24], aad: &[u8], plaintext: &[u8]) -> Vec<u8> {
    let cipher = XChaCha20Poly1305::new((&key.0).into());
    let n = XNonce::from(*nonce);
    cipher
        .encrypt(&n, Payload { msg: plaintext, aad })
        .expect("XChaCha20-Poly1305 encryption cannot fail for these sizes")
}

/// XChaCha20-Poly1305 decryption. `None` when the tag does not verify.
pub fn open(key: &Key32, nonce: &[u8], aad: &[u8], ct: &[u8]) -> Option<Zeroizing<Vec<u8>>> {
    let n: [u8; 24] = nonce.try_into().ok()?;
    let cipher = XChaCha20Poly1305::new((&key.0).into());
    cipher
        .decrypt(&XNonce::from(n), Payload { msg: ct, aad })
        .ok()
        .map(Zeroizing::new)
}

/// HMAC-SHA256.
pub fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut m = <Hmac<Sha256> as KeyInit>::new_from_slice(key).expect("HMAC takes any key length");
    m.update(data);
    m.finalize().into_bytes().into()
}

/// Constant-time HMAC-SHA256 check.
pub fn hmac_sha256_verify(key: &[u8], data: &[u8], tag: &[u8]) -> bool {
    let mut m = <Hmac<Sha256> as KeyInit>::new_from_slice(key).expect("HMAC takes any key length");
    m.update(data);
    m.verify_slice(tag).is_ok()
}

/// The keys an unlocked vault holds, all derived from VK (SPEC 3.3).
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct VaultKeys {
    pub(crate) vk: Key32,
    pub(crate) item_key: Key32,
    pub(crate) mac_key: Key32,
    pub(crate) blob_key: Key32,
}

impl VaultKeys {
    /// Derives item, manifest and attachment keys from VK.
    pub fn from_vk(vk: Key32, vault_id: &uuid::Uuid) -> Self {
        let salt = vault_id.as_bytes();
        let item_key = hkdf_key(&vk.0, salt, "coffer/v1/records");
        let mac_key = hkdf_key(&vk.0, salt, "coffer/v1/manifest");
        let blob_key = hkdf_key(&vk.0, salt, "coffer/v1/attachments");
        VaultKeys { vk, item_key, mac_key, blob_key }
    }
}

impl std::fmt::Debug for VaultKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("VaultKeys(<redacted>)")
    }
}

/// Hex of bytes, lower case.
pub fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

#[cfg(test)]
pub(crate) fn unhex(s: &str) -> Vec<u8> {
    let s: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // RFC 5869, Appendix A.1, Test Case 1 (copied from rfc5869.txt).
    #[test]
    fn kat_rfc5869_test_case_1() {
        let ikm = unhex("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b");
        let salt = unhex("000102030405060708090a0b0c");
        let info = unhex("f0f1f2f3f4f5f6f7f8f9");
        let mut okm = [0u8; 42];
        hkdf_sha256(&ikm, &salt, &info, &mut okm);
        let want = unhex(
            "3cb25f25faacd57a90434f64d0362f2a
             2d2d0a90cf1a5a4c5db02d56ecc4c5bf
             34007208d5b887185865",
        );
        assert_eq!(okm.to_vec(), want);
        // PRK check through the extract step.
        let (prk, _) = Hkdf::<Sha256>::extract(Some(&salt), &ikm);
        assert_eq!(
            prk.to_vec(),
            unhex("077709362c2e32df0ddc3f0dc47bba63 90b6c73bb50f9c3122ec844ad7c2b3e5")
        );
    }

    // RFC 9106, section 5.3, Argon2id test vector (copied from rfc9106.txt).
    #[test]
    fn kat_rfc9106_argon2id() {
        let password = [0x01u8; 32];
        let salt = [0x02u8; 16];
        let secret = [0x03u8; 8];
        let ad = [0x04u8; 12];
        let mut tag = [0u8; 32];
        argon2id_raw(&password, &salt, &KdfParams { m_kib: 32, t: 3, p: 4 }, Some(&secret), Some(&ad), &mut tag).unwrap();
        let want = unhex(
            "0d 64 0d f5 8d 78 76 6c 08 c0 37 a3 4a 8b 53 c9 d0
             1e f0 45 2d 75 b6 5e b5 25 20 e9 6b 01 e6 59",
        );
        assert_eq!(tag.to_vec(), want);
    }

    // draft-irtf-cfrg-xchacha-03, Appendix A.3.1 (copied from the draft text).
    #[test]
    fn kat_xchacha20poly1305_draft_a3_1() {
        let pt = unhex(
            "4c616469657320616e642047656e746c656d656e206f662074686520636c6173
             73206f66202739393a204966204920636f756c64206f6666657220796f75206f
             6e6c79206f6e652074697020666f7220746865206675747572652c2073756e73
             637265656e20776f756c642062652069742e",
        );
        let aad = unhex("50515253c0c1c2c3c4c5c6c7");
        let key: [u8; 32] = unhex("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f").try_into().unwrap();
        let iv: [u8; 24] = unhex("404142434445464748494a4b4c4d4e4f5051525354555657").try_into().unwrap();
        let ct = unhex(
            "bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb
             731c7f1b0b4aa6440bf3a82f4eda7e39ae64c6708c54c216cb96b72e1213b452
             2f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff9
             21f9664c97637da9768812f615c68b13b52e",
        );
        let tag = unhex("c0875924c1c7987947deafd8780acf49");
        let k = Key32(key);
        let out = seal_with_nonce(&k, &iv, &aad, &pt);
        let mut want = ct.clone();
        want.extend_from_slice(&tag);
        assert_eq!(out, want);
        let back = open(&k, &iv, &aad, &out).unwrap();
        assert_eq!(&back[..], &pt[..]);
        let mut bad = out.clone();
        bad[0] ^= 1;
        assert!(open(&k, &iv, &aad, &bad).is_none());
        assert!(open(&k, &iv, b"other", &out).is_none());
    }

    #[test]
    fn nfkd_and_trim() {
        // U+FB01 LATIN SMALL LIGATURE FI decomposes to "fi" under NFKD.
        assert_eq!(&*normalize_password("  \u{FB01}sh\t"), "fish");
        // A precomposed e-acute and e + combining acute normalise the same.
        assert_eq!(normalize_password("caf\u{e9}"), normalize_password("cafe\u{301}"));
    }

    #[test]
    fn kdf_floor_and_ceiling() {
        assert!(KdfParams::DEFAULT.check().is_ok());
        assert!(KdfParams::FLOOR.check().is_ok());
        assert!(KdfParams::CEILING.check().is_ok());
        assert_eq!(KdfParams { m_kib: 65_535, t: 2, p: 1 }.check(), Err(CoreError::KdfTooWeak));
        assert_eq!(KdfParams { m_kib: 65_536, t: 1, p: 1 }.check(), Err(CoreError::KdfTooWeak));
        assert_eq!(KdfParams { m_kib: 65_536, t: 2, p: 0 }.check(), Err(CoreError::KdfTooWeak));
        assert_eq!(KdfParams { m_kib: 1_048_577, t: 3, p: 4 }.check(), Err(CoreError::KdfTooStrong));
        assert_eq!(KdfParams { m_kib: 131_072, t: 11, p: 4 }.check(), Err(CoreError::KdfTooStrong));
        assert_eq!(KdfParams { m_kib: 131_072, t: 3, p: 17 }.check(), Err(CoreError::KdfTooStrong));
    }

    #[test]
    fn ceiling_refuses_before_argon2() {
        let t0 = std::time::Instant::now();
        let r = argon2id_key(b"pw", &[0u8; 16], &KdfParams { m_kib: u32::MAX, t: u32::MAX, p: 16 });
        assert_eq!(r.unwrap_err(), CoreError::KdfTooStrong);
        assert!(t0.elapsed() < std::time::Duration::from_millis(200));
    }

    #[test]
    fn uniform_stays_in_range() {
        for n in [1u32, 2, 3, 7, 31, 7776] {
            for _ in 0..200 {
                assert!(uniform(n) < n);
            }
        }
    }
}
