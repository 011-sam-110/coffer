//! `ssh_generate` (tier 2): a new Ed25519 key pair in OpenSSH format.
//!
//! The seed comes from the system random source; `ring` (already in the
//! build for TLS) derives the public key. The private key file is the
//! unencrypted `openssh-key-v1` format that `ssh-keygen -t ed25519` writes
//! with an empty passphrase; the vault encrypts it.

use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
use base64::Engine;
use ring::signature::{Ed25519KeyPair, KeyPair};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::contract::SshKeyPair;
use crate::error::{CofferError, CofferResult};

const KEY_TYPE: &[u8] = b"ssh-ed25519";

fn put_string(out: &mut Vec<u8>, s: &[u8]) {
    out.extend_from_slice(&(s.len() as u32).to_be_bytes());
    out.extend_from_slice(s);
}

/// The public key in SSH wire format: string "ssh-ed25519", string key.
fn public_blob(public: &[u8; 32]) -> Vec<u8> {
    let mut b = Vec::with_capacity(51);
    put_string(&mut b, KEY_TYPE);
    put_string(&mut b, public);
    b
}

/// The `openssh-key-v1` private key file for `seed` (unencrypted).
fn private_pem(seed: &[u8; 32], public: &[u8; 32], check: u32, comment: &str) -> Zeroizing<String> {
    let blob = public_blob(public);
    let mut private = Zeroizing::new(Vec::with_capacity(160));
    private.extend_from_slice(&check.to_be_bytes());
    private.extend_from_slice(&check.to_be_bytes());
    put_string(&mut private, KEY_TYPE);
    put_string(&mut private, public);
    let mut both = Zeroizing::new([0u8; 64]);
    both[..32].copy_from_slice(seed);
    both[32..].copy_from_slice(public);
    put_string(&mut private, &both[..]);
    put_string(&mut private, comment.as_bytes());
    // Pad to the cipher block size ("none": 8) with 1, 2, 3, ...
    let mut pad = 1u8;
    while private.len() % 8 != 0 {
        private.push(pad);
        pad += 1;
    }
    let mut file = Zeroizing::new(Vec::with_capacity(300));
    file.extend_from_slice(b"openssh-key-v1\0");
    put_string(&mut file, b"none");
    put_string(&mut file, b"none");
    put_string(&mut file, b"");
    file.extend_from_slice(&1u32.to_be_bytes());
    put_string(&mut file, &blob);
    put_string(&mut file, &private);
    let body = Zeroizing::new(STANDARD.encode(&file[..]));
    let mut pem = Zeroizing::new(String::with_capacity(body.len() + 80));
    pem.push_str("-----BEGIN OPENSSH PRIVATE KEY-----\n");
    for line in body.as_bytes().chunks(70) {
        pem.push_str(std::str::from_utf8(line).unwrap_or_default());
        pem.push('\n');
    }
    pem.push_str("-----END OPENSSH PRIVATE KEY-----\n");
    pem
}

fn pair_from_seed(seed: &[u8; 32], check: u32) -> CofferResult<SshKeyPair> {
    let kp = Ed25519KeyPair::from_seed_unchecked(seed).map_err(|e| CofferError::invalid(format!("Coffer could not make the key: {e}")))?;
    let public: [u8; 32] = kp.public_key().as_ref().try_into().map_err(|_| CofferError::invalid("Coffer could not make the key."))?;
    let blob = public_blob(&public);
    Ok(SshKeyPair {
        private_key: private_pem(seed, &public, check, ""),
        public_key: format!("ssh-ed25519 {}", STANDARD.encode(&blob)),
        fingerprint: format!("SHA256:{}", STANDARD_NO_PAD.encode(Sha256::digest(&blob))),
    })
}

/// A new Ed25519 key pair.
pub fn generate() -> CofferResult<SshKeyPair> {
    let seed = Zeroizing::new(coffer_core::crypto::random_array::<32>());
    let check = u32::from_be_bytes(coffer_core::crypto::random_array::<4>());
    pair_from_seed(&seed, check)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 8032 section 7.1, test 1: the public key of this seed.
    #[test]
    fn rfc8032_public_key() {
        let seed: [u8; 32] = hex32("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
        let pair = pair_from_seed(&seed, 1).unwrap();
        let mut blob = Vec::new();
        put_string(&mut blob, KEY_TYPE);
        put_string(&mut blob, &hex32("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"));
        assert_eq!(pair.public_key, format!("ssh-ed25519 {}", STANDARD.encode(&blob)));
        assert!(pair.private_key.starts_with("-----BEGIN OPENSSH PRIVATE KEY-----\n"));
        assert!(pair.fingerprint.starts_with("SHA256:") && pair.fingerprint.len() == 7 + 43);
    }

    fn hex32(s: &str) -> [u8; 32] {
        std::array::from_fn(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap())
    }

    /// ssh-keygen reads the private key back and derives the same public key
    /// and fingerprint. Needs the Windows OpenSSH client.
    #[test]
    #[ignore = "runs ssh-keygen.exe"]
    fn ssh_keygen_reads_the_key() {
        let pair = generate().unwrap();
        let dir = std::env::temp_dir().join(format!("coffer-ssh-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let key = dir.join("id_ed25519");
        std::fs::write(&key, pair.private_key.as_bytes()).unwrap();
        let out = std::process::Command::new("ssh-keygen").args(["-y", "-f"]).arg(&key).output().unwrap();
        let derived = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let fp = std::process::Command::new("ssh-keygen").args(["-l", "-E", "sha256", "-f"]).arg(&key).output().unwrap();
        let fp = String::from_utf8_lossy(&fp.stdout).to_string();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        assert_eq!(derived, pair.public_key);
        assert!(fp.contains(&pair.fingerprint), "{fp} vs {}", pair.fingerprint);
    }
}
