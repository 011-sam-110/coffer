//! DPAPI for the current Windows user (`CryptProtectData`, SPEC 3.2).

use windows::Win32::Foundation::{HLOCAL, LocalFree};
use windows::Win32::Security::Cryptography::{CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData};
use windows::core::PCWSTR;
use zeroize::{Zeroize, Zeroizing};

fn blob(bytes: &[u8]) -> CRYPT_INTEGER_BLOB {
    CRYPT_INTEGER_BLOB { cbData: bytes.len() as u32, pbData: bytes.as_ptr() as *mut u8 }
}

/// Encrypt `data` for the current user, bound to `entropy`.
pub fn protect(data: &[u8], entropy: &[u8]) -> Result<Vec<u8>, String> {
    let input = blob(data);
    let extra = blob(entropy);
    let mut out = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(&input, PCWSTR::null(), Some(&extra), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out)
            .map_err(|e| format!("CryptProtectData failed: {e}"))?;
        let result = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(out.pbData as _)));
        Ok(result)
    }
}

/// Decrypt a blob made by `protect` with the same `entropy`. The plaintext
/// buffer Windows returns is wiped before it is freed.
pub fn unprotect(data: &[u8], entropy: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
    let input = blob(data);
    let extra = blob(entropy);
    let mut out = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(&input, None, Some(&extra), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out)
            .map_err(|e| format!("CryptUnprotectData failed: {e}"))?;
        let plain = std::slice::from_raw_parts_mut(out.pbData, out.cbData as usize);
        let result = Zeroizing::new(plain.to_vec());
        plain.zeroize();
        let _ = LocalFree(Some(HLOCAL(out.pbData as _)));
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_entropy_binding() {
        let secret = b"16 secret bytes!";
        let sealed = protect(secret, b"coffer/v1/device-sk\x01\x02").unwrap();
        assert!(!sealed.windows(secret.len()).any(|w| w == secret));
        assert_eq!(&*unprotect(&sealed, b"coffer/v1/device-sk\x01\x02").unwrap(), secret);
        assert!(unprotect(&sealed, b"coffer/v1/device-sk\x01\x03").is_err());
        let mut tampered = sealed.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 1;
        assert!(unprotect(&tampered, b"coffer/v1/device-sk\x01\x02").is_err());
    }
}
