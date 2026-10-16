//! Screen-capture protection (SPEC 9): `SetWindowDisplayAffinity`.

use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{
    SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SetWindowDisplayAffinity, SetWindowPos, WDA_EXCLUDEFROMCAPTURE, WDA_NONE,
};

/// `WDA_EXCLUDEFROMCAPTURE` when `on`, else `WDA_NONE`. Call on the thread that
/// owns the window (the main thread).
pub fn set(hwnd: isize, on: bool) -> Result<(), String> {
    let affinity = if on { WDA_EXCLUDEFROMCAPTURE } else { WDA_NONE };
    unsafe { SetWindowDisplayAffinity(HWND(hwnd as *mut _), affinity) }.map_err(|e| format!("SetWindowDisplayAffinity failed: {e}"))
}

/// Make Windows recompute the frame of a hidden window (what tao does on its
/// first show), so its border sizes are right before it is placed.
pub fn refresh_frame(hwnd: isize) {
    unsafe {
        let _ = SetWindowPos(HWND(hwnd as *mut _), None, 0, 0, 0, 0, SWP_NOZORDER | SWP_NOMOVE | SWP_NOSIZE | SWP_FRAMECHANGED | SWP_NOACTIVATE);
    }
}
