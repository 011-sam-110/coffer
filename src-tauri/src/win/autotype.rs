//! Auto-type mechanics (SPEC 10): integrity levels, bringing the target
//! window to the front, waiting for modifier keys, and `SendInput` with
//! `KEYEVENTF_UNICODE`. The input buffers are zeroed after each send.

use std::time::{Duration, Instant};

use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND};
use windows::Win32::Security::{GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TokenIntegrityLevel, TOKEN_MANDATORY_LABEL, TOKEN_QUERY};
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentProcess, GetCurrentThreadId, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, VIRTUAL_KEY, VK_CONTROL, VK_LWIN, VK_MENU,
    VK_RETURN, VK_RWIN, VK_SHIFT, VK_TAB,
};
use windows::Win32::UI::WindowsAndMessaging::{BringWindowToTop, GetForegroundWindow, GetWindowThreadProcessId, IsIconic, SetForegroundWindow, ShowWindow, SW_RESTORE};

fn hwnd(h: isize) -> HWND {
    HWND(h as *mut _)
}

/// The process id of a window's owner.
pub fn window_pid(h: isize) -> u32 {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd(h), Some(&mut pid)) };
    pid
}

/// The mandatory integrity level (the last sub-authority of the label SID,
/// 0x2000 medium, 0x3000 high) of a process token.
fn token_integrity(process: HANDLE) -> Option<u32> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(process, TOKEN_QUERY, &mut token).ok()?;
        let mut len = 0u32;
        let _ = GetTokenInformation(token, TokenIntegrityLevel, None, 0, &mut len);
        let mut buf = vec![0u8; len.max(64) as usize];
        let got = GetTokenInformation(token, TokenIntegrityLevel, Some(buf.as_mut_ptr().cast()), buf.len() as u32, &mut len);
        let _ = CloseHandle(token);
        got.ok()?;
        let label = &*(buf.as_ptr() as *const TOKEN_MANDATORY_LABEL);
        let sid = label.Label.Sid;
        let count = *GetSidSubAuthorityCount(sid);
        if count == 0 {
            return None;
        }
        Some(*GetSidSubAuthority(sid, u32::from(count) - 1))
    }
}

/// This process's integrity level.
pub fn own_integrity() -> Option<u32> {
    token_integrity(unsafe { GetCurrentProcess() })
}

/// The integrity level of process `pid`; `None` when Windows does not let
/// Coffer read it (an elevated or protected process).
pub fn integrity_of(pid: u32) -> Option<u32> {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let level = token_integrity(process);
        let _ = CloseHandle(process);
        level
    }
}

/// True when Coffer must not type into `pid`: a higher integrity level
/// (UIPI would drop the keys anyway), or a level Coffer cannot read.
pub fn runs_higher(pid: u32) -> bool {
    match (integrity_of(pid), own_integrity()) {
        (Some(theirs), Some(ours)) => theirs > ours,
        _ => true,
    }
}

pub fn foreground() -> isize {
    unsafe { GetForegroundWindow() }.0 as isize
}

/// Bring `h` to the front and check that it is there (up to 1.5 s).
pub fn bring_to_front(h: isize) -> bool {
    unsafe {
        if IsIconic(hwnd(h)).as_bool() {
            let _ = ShowWindow(hwnd(h), SW_RESTORE);
        }
        if !SetForegroundWindow(hwnd(h)).as_bool() {
            // Join the input of the window in front, then ask again.
            let fg = GetForegroundWindow();
            let fg_thread = GetWindowThreadProcessId(fg, None);
            let me = GetCurrentThreadId();
            if fg_thread != 0 && fg_thread != me {
                let _ = AttachThreadInput(me, fg_thread, true);
                let _ = BringWindowToTop(hwnd(h));
                let _ = SetForegroundWindow(hwnd(h));
                let _ = AttachThreadInput(me, fg_thread, false);
            }
        }
    }
    let end = Instant::now() + Duration::from_millis(1500);
    loop {
        if foreground() == h {
            return true;
        }
        if Instant::now() > end {
            return false;
        }
        std::thread::sleep(Duration::from_millis(30));
    }
}

fn held(vk: VIRTUAL_KEY) -> bool {
    (unsafe { GetAsyncKeyState(i32::from(vk.0)) } as u16 & 0x8000) != 0
}

/// Wait until Ctrl, Shift, Alt and Win are up (at most `timeout`).
pub fn wait_modifiers_released(timeout: Duration) -> bool {
    let end = Instant::now() + timeout;
    loop {
        if ![VK_CONTROL, VK_SHIFT, VK_MENU, VK_LWIN, VK_RWIN].into_iter().any(held) {
            return true;
        }
        if Instant::now() > end {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn key_input(vk: VIRTUAL_KEY, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } } }
}

fn send(inputs: &mut [INPUT]) -> Result<(), String> {
    let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) } as usize;
    // The buffer held the typed characters.
    for i in inputs.iter_mut() {
        unsafe { zeroize::zeroize_flat_type(i as *mut INPUT) };
    }
    if sent == inputs.len() {
        Ok(())
    } else {
        Err(format!("Windows took {sent} of {} key events", inputs.len()))
    }
}

/// The key events for `text`: a Unicode down and up per UTF-16 unit.
pub(crate) fn text_inputs(text: &str) -> Vec<INPUT> {
    let mut inputs: Vec<INPUT> = Vec::with_capacity(text.len() * 4);
    for unit in text.encode_utf16() {
        inputs.push(key_input(VIRTUAL_KEY(0), unit, KEYEVENTF_UNICODE));
        inputs.push(key_input(VIRTUAL_KEY(0), unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
    }
    inputs
}

/// Type `text` as Unicode key events (any layout, any character).
pub fn type_text(text: &str) -> Result<(), String> {
    let mut inputs = text_inputs(text);
    if inputs.is_empty() {
        return Ok(());
    }
    send(&mut inputs)
}

pub enum Key {
    Tab,
    Enter,
}

/// Press and release Tab or Enter (virtual keys: apps act on them).
pub fn press(key: Key) -> Result<(), String> {
    let vk = match key {
        Key::Tab => VK_TAB,
        Key::Enter => VK_RETURN,
    };
    send(&mut [key_input(vk, 0, KEYBD_EVENT_FLAGS(0)), key_input(vk, 0, KEYEVENTF_KEYUP)])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn own_level_is_readable_and_not_higher_than_itself() {
        let ours = own_integrity().expect("our own integrity level");
        assert!(ours >= 0x1000, "{ours:#x}");
        assert!(!runs_higher(std::process::id()));
    }

    #[test]
    fn a_process_coffer_cannot_read_counts_as_higher() {
        // PID 4 is the System process: its token cannot be opened from a
        // normal user process.
        assert!(runs_higher(4));
    }
}
