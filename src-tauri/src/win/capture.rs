//! Screen-capture protection (SPEC 9): `SetWindowDisplayAffinity`.

use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_NONE};

/// `WDA_EXCLUDEFROMCAPTURE` when `on`, else `WDA_NONE`. Call on the thread that
/// owns the window (the main thread).
pub fn set(hwnd: isize, on: bool) -> Result<(), String> {
    let affinity = if on { WDA_EXCLUDEFROMCAPTURE } else { WDA_NONE };
    unsafe { SetWindowDisplayAffinity(HWND(hwnd as *mut _), affinity) }.map_err(|e| format!("SetWindowDisplayAffinity failed: {e}"))
}
