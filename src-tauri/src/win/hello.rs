//! Windows Hello (SPEC 3.8): is it set up, the verification prompt for one
//! of Coffer's windows, and the in-memory protection of the held vault key.
//!
//! The WinRT calls run on a short-lived thread of their own, in the
//! multi-threaded apartment, so the caller's thread state does not matter.

use windows::core::{factory, HSTRING};
use windows::Security::Credentials::UI::{UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability};
use windows::Win32::Foundation::HWND;
use windows::Win32::Security::Cryptography::{CryptProtectMemory, CryptUnprotectMemory, CRYPTPROTECTMEMORY_SAME_PROCESS};
use windows::Win32::System::WinRT::{IUserConsentVerifierInterop, RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};
use windows_future::IAsyncOperation;
use zeroize::{Zeroize, Zeroizing};

/// Run `f` on a new thread in the multi-threaded apartment.
fn on_mta<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    std::thread::Builder::new()
        .name("coffer-hello".into())
        .spawn(move || {
            let init = unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.is_ok();
            let out = f();
            if init {
                unsafe { RoUninitialize() };
            }
            out
        })
        .ok()?
        .join()
        .ok()
}

/// Why Hello cannot be used, or `Ok(())` when it can.
pub fn availability() -> Result<(), String> {
    let r = on_mta(|| -> Result<UserConsentVerifierAvailability, String> {
        UserConsentVerifier::CheckAvailabilityAsync().and_then(|op| op.join()).map_err(|e| e.message())
    })
    .unwrap_or_else(|| Err("the Hello thread did not run".into()))?;
    match r {
        UserConsentVerifierAvailability::Available => Ok(()),
        UserConsentVerifierAvailability::DeviceNotPresent => Err("no Windows Hello device".into()),
        UserConsentVerifierAvailability::NotConfiguredForUser => Err("Windows Hello is not set up for this user".into()),
        UserConsentVerifierAvailability::DisabledByPolicy => Err("Windows Hello is turned off by policy".into()),
        UserConsentVerifierAvailability::DeviceBusy => Err("the Windows Hello device is busy".into()),
        other => Err(format!("availability {}", other.0)),
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Verification {
    Verified,
    Canceled,
    /// Any other result: no unlock.
    Failed(String),
}

/// The Hello prompt over `hwnd` (one of Coffer's windows). Blocks until
/// the user answers. Only `Verified` unlocks.
pub fn verify(hwnd: isize, message: &str) -> Result<Verification, String> {
    let message = HSTRING::from(message);
    let r = on_mta(move || -> Result<UserConsentVerificationResult, String> {
        let interop = factory::<UserConsentVerifier, IUserConsentVerifierInterop>().map_err(|e| e.message())?;
        let op: IAsyncOperation<UserConsentVerificationResult> = unsafe { interop.RequestVerificationForWindowAsync(HWND(hwnd as *mut _), &message) }.map_err(|e| e.message())?;
        op.join().map_err(|e| e.message())
    })
    .unwrap_or_else(|| Err("the Hello thread did not run".into()))?;
    Ok(match r {
        UserConsentVerificationResult::Verified => Verification::Verified,
        UserConsentVerificationResult::Canceled => Verification::Canceled,
        UserConsentVerificationResult::DeviceNotPresent => Verification::Failed("no Windows Hello device".into()),
        UserConsentVerificationResult::NotConfiguredForUser => Verification::Failed("Windows Hello is not set up for this user".into()),
        UserConsentVerificationResult::DisabledByPolicy => Verification::Failed("Windows Hello is turned off by policy".into()),
        UserConsentVerificationResult::DeviceBusy => Verification::Failed("the Windows Hello device is busy".into()),
        UserConsentVerificationResult::RetriesExhausted => Verification::Failed("too many tries".into()),
        other => Verification::Failed(format!("result {}", other.0)),
    })
}

/// Debug self-test only (`COFFER_SELFTEST_HELLO_PROMPT=1`): start the real
/// prompt over `hwnd`, cancel the operation after `after`, and say what came
/// back. It shows that the interop call reaches Windows. Cancelling the
/// operation does NOT close the Windows Security dialog, and Coffer cannot
/// close it (WM_CLOSE, Esc and taskkill fail): run it only with a person at
/// the PC to press Cancel.
#[cfg(debug_assertions)]
pub fn prompt_then_cancel(hwnd: isize, after: std::time::Duration) -> String {
    on_mta(move || {
        let interop = match factory::<UserConsentVerifier, IUserConsentVerifierInterop>() {
            Ok(i) => i,
            Err(e) => return format!("factory failed: {}", e.message()),
        };
        let message = HSTRING::from("Coffer self-test: this closes by itself");
        let op: IAsyncOperation<UserConsentVerificationResult> = match unsafe { interop.RequestVerificationForWindowAsync(HWND(hwnd as *mut _), &message) } {
            Ok(op) => op,
            Err(e) => return format!("request failed: {}", e.message()),
        };
        let status = op.Status().map(|s| s.0);
        std::thread::sleep(after);
        let cancel = op.Cancel().map_err(|e| e.message());
        let result = op.join().map(|r| r.0).map_err(|e| e.message());
        format!("started (status {status:?}), cancel {cancel:?}, result {result:?}")
    })
    .unwrap_or_else(|| "the Hello thread did not run".into())
}

/// A 32-byte key kept encrypted with `CryptProtectMemory(SAME_PROCESS)`:
/// only this process can decrypt it, and it is gone when the process ends.
pub struct ProtectedKey {
    buf: Box<[u8; 32]>,
}

impl ProtectedKey {
    pub fn protect(key: &[u8; 32]) -> Result<Self, String> {
        // 32 is a multiple of CRYPTPROTECTMEMORY_BLOCK_SIZE (16).
        let mut buf = Box::new([0u8; 32]);
        buf.copy_from_slice(key);
        unsafe { CryptProtectMemory(buf.as_mut_ptr().cast(), 32, CRYPTPROTECTMEMORY_SAME_PROCESS) }.map_err(|e| {
            buf.zeroize();
            e.message()
        })?;
        Ok(Self { buf })
    }

    /// A plain copy, zeroized when dropped.
    pub fn reveal(&self) -> Result<Zeroizing<[u8; 32]>, String> {
        let mut out = Zeroizing::new([0u8; 32]);
        out.copy_from_slice(&self.buf[..]);
        unsafe { CryptUnprotectMemory(out.as_mut_ptr().cast(), 32, CRYPTPROTECTMEMORY_SAME_PROCESS) }.map_err(|e| e.message())?;
        Ok(out)
    }
}

impl Drop for ProtectedKey {
    fn drop(&mut self) {
        self.buf.zeroize();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protected_key_round_trip() {
        let key: [u8; 32] = std::array::from_fn(|i| i as u8 * 7 + 1);
        let p = ProtectedKey::protect(&key).unwrap();
        assert_ne!(&p.buf[..], &key[..], "the held bytes are encrypted");
        assert_eq!(&p.reveal().unwrap()[..], &key[..]);
    }

    /// Prints what this PC says; passes whatever the answer is (CI has no Hello).
    #[test]
    fn availability_answers() {
        let r = availability();
        eprintln!("hello availability: {r:?}");
    }
}
