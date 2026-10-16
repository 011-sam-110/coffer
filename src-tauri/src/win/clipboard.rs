//! Raw Win32 clipboard, exactly per SPEC 3.9.
//!
//! Write: one OpenClipboard / EmptyClipboard / SetClipboardData (x4) /
//! CloseClipboard, then GetClipboardSequenceNumber. Clear: OpenClipboard, read
//! the number again, EmptyClipboard only if unchanged, CloseClipboard.

use std::sync::atomic::{AtomicIsize, Ordering};

use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardSequenceNumber, IsClipboardFormatAvailable, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
};
use windows::Win32::System::Memory::{GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalUnlock};
use windows::core::w;
use zeroize::Zeroizing;

/// `CF_UNICODETEXT`.
const CF_UNICODETEXT: u32 = 13;

/// The clipboard owner window (the hidden signal window), set once it exists.
static OWNER: AtomicIsize = AtomicIsize::new(0);

pub fn set_owner(hwnd: HWND) {
    OWNER.store(hwnd.0 as isize, Ordering::SeqCst);
}

fn owner() -> Option<HWND> {
    let raw = OWNER.load(Ordering::SeqCst);
    (raw != 0).then(|| HWND(raw as *mut _))
}

/// Closes the clipboard when dropped (also on an early return).
struct Open;

impl Drop for Open {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseClipboard();
        }
    }
}

/// Another program may hold the clipboard for a moment: retry for about 0.5 s.
fn open() -> Result<Open, String> {
    let mut last = String::new();
    for _ in 0..25 {
        match unsafe { OpenClipboard(owner()) } {
            Ok(()) => return Ok(Open),
            Err(e) => last = e.to_string(),
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    Err(format!("The clipboard is busy ({last})."))
}

/// Copy `bytes` into a movable global block for SetClipboardData.
fn global_copy(bytes: &[u8]) -> Result<HGLOBAL, String> {
    unsafe {
        let handle = GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1)).map_err(|e| format!("GlobalAlloc failed: {e}"))?;
        let dst = GlobalLock(handle) as *mut u8;
        if dst.is_null() {
            let _ = GlobalFree(Some(handle));
            return Err("GlobalLock failed.".into());
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), dst, bytes.len());
        let _ = GlobalUnlock(handle);
        Ok(handle)
    }
}

/// Hand a global block to the clipboard. On failure the block is freed here;
/// on success the clipboard owns it.
fn set(format: u32, bytes: &[u8]) -> Result<(), String> {
    let handle = global_copy(bytes)?;
    unsafe {
        if let Err(e) = SetClipboardData(format, Some(HANDLE(handle.0))) {
            let _ = GlobalFree(Some(handle));
            return Err(format!("SetClipboardData failed: {e}"));
        }
    }
    Ok(())
}

/// Write `text` as `CF_UNICODETEXT`; with `private`, also the three formats
/// that keep it out of clipboard monitors, clipboard history and the cloud
/// clipboard. Returns the clipboard sequence number after `CloseClipboard`.
/// The UTF-16 copy of the text is wiped before return.
pub fn write_text(text: &str, private: bool) -> Result<u32, String> {
    // Exact capacity: UTF-16 never has more units than UTF-8 has bytes, so the
    // buffer does not reallocate (no stray copy of the secret on the heap).
    let mut wide: Zeroizing<Vec<u16>> = Zeroizing::new(Vec::with_capacity(text.len() + 1));
    wide.extend(text.encode_utf16());
    wide.push(0);
    let bytes = unsafe { std::slice::from_raw_parts(wide.as_ptr() as *const u8, wide.len() * 2) };

    let guard = open()?;
    unsafe { EmptyClipboard().map_err(|e| format!("EmptyClipboard failed: {e}"))? };
    set(CF_UNICODETEXT, bytes)?;
    if private {
        let zero = 0u32.to_le_bytes();
        unsafe {
            let exclude = RegisterClipboardFormatW(w!("ExcludeClipboardContentFromMonitorProcessing"));
            let history = RegisterClipboardFormatW(w!("CanIncludeInClipboardHistory"));
            let cloud = RegisterClipboardFormatW(w!("CanUploadToCloudClipboard"));
            for format in [exclude, history, cloud] {
                if format == 0 {
                    return Err("RegisterClipboardFormatW failed.".into());
                }
                set(format, &zero)?;
            }
        }
    }
    drop(guard);
    Ok(unsafe { GetClipboardSequenceNumber() })
}

/// Empty the clipboard only if its sequence number is still `expected`.
/// Returns whether it emptied it.
pub fn clear_if_sequence(expected: u32) -> Result<bool, String> {
    let _guard = open()?;
    let now = unsafe { GetClipboardSequenceNumber() };
    if !crate::clipboard::should_clear(Some(expected), now) {
        return Ok(false);
    }
    unsafe { EmptyClipboard().map_err(|e| format!("EmptyClipboard failed: {e}"))? };
    Ok(true)
}

/// The current clipboard sequence number.
#[cfg_attr(not(test), allow(dead_code))]
pub fn sequence() -> u32 {
    unsafe { GetClipboardSequenceNumber() }
}

/// Which of (text, exclude-from-monitors, history flag, cloud flag) the
/// clipboard holds now. For the self-test and tests only.
#[allow(dead_code)]
pub fn formats_present() -> [bool; 4] {
    unsafe {
        let has = |f: u32| f != 0 && IsClipboardFormatAvailable(f).is_ok();
        [
            has(CF_UNICODETEXT),
            has(RegisterClipboardFormatW(w!("ExcludeClipboardContentFromMonitorProcessing"))),
            has(RegisterClipboardFormatW(w!("CanIncludeInClipboardHistory"))),
            has(RegisterClipboardFormatW(w!("CanUploadToCloudClipboard"))),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Uses the real clipboard of this session (it overwrites and then empties
    /// it), so it runs only on request: `cargo test -p coffer -- --ignored clipboard`.
    #[test]
    #[ignore]
    fn clipboard_write_formats_and_conditional_clear() {
        let seq = write_text("coffer-test-value", true).unwrap();
        assert_eq!(sequence(), seq);
        assert_eq!(formats_present(), [true, true, true, true]);
        // A later change by someone else: the clear must not touch it.
        let other = write_text("someone else's copy", false).unwrap();
        assert_ne!(other, seq);
        assert!(!clear_if_sequence(seq).unwrap());
        assert_eq!(formats_present()[0], true);
        // Our own latest copy: cleared.
        assert!(clear_if_sequence(other).unwrap());
        assert_eq!(formats_present(), [false, false, false, false]);
    }
}
