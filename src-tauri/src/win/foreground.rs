//! Foreground tracking (SPEC 9): `SetWinEventHook(EVENT_SYSTEM_FOREGROUND)`,
//! out of context, on the signal thread (which pumps messages). Stores the last
//! foreground window that is not Coffer's and not part of the shell.

use tauri::Manager;
use windows::Win32::Foundation::{CloseHandle, HWND, MAX_PATH};
use windows::Win32::System::Threading::{GetCurrentProcessId, OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW};
use windows::Win32::UI::Accessibility::{HWINEVENTHOOK, SetWinEventHook};
use windows::Win32::UI::WindowsAndMessaging::{
    EVENT_SYSTEM_FOREGROUND, GetClassNameW, GetDesktopWindow, GetForegroundWindow, GetShellWindow, GetWindowTextW, GetWindowThreadProcessId, IsWindow, OBJID_WINDOW, WINEVENT_OUTOFCONTEXT,
    WINEVENT_SKIPOWNPROCESS,
};

use crate::state::{AppState, ForegroundInfo, LockExt};

/// Window classes that are never a target: the taskbars, the tray overflow,
/// the desktop, Start/Search and the task switchers.
const IGNORED_CLASSES: &[&str] = &[
    "Shell_TrayWnd",
    "Shell_SecondaryTrayWnd",
    "NotifyIconOverflowWindow",
    "TopLevelWindowForOverflowXamlIsland",
    "Progman",
    "WorkerW",
    "Windows.UI.Core.CoreWindow",
    "XamlExplorerHostIslandWindow",
    "MultitaskingViewFrame",
    "ForegroundStaging",
];

pub fn is_ignored_class(class: &str) -> bool {
    IGNORED_CLASSES.iter().any(|c| c.eq_ignore_ascii_case(class))
}

/// Install the hook on the calling thread (which must run a message loop), and
/// store the window in front now, so the first Quick Access has a target.
pub fn install() -> bool {
    store(unsafe { GetForegroundWindow() });
    let hook = unsafe {
        SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, None, Some(on_event), 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS)
    };
    !hook.is_invalid()
}

unsafe extern "system" fn on_event(_hook: HWINEVENTHOOK, _event: u32, hwnd: HWND, id_object: i32, _id_child: i32, _thread: u32, _time: u32) {
    if id_object != OBJID_WINDOW.0 {
        return;
    }
    store(hwnd);
}

fn store(hwnd: HWND) {
    if hwnd.is_invalid() {
        return;
    }
    if let Some(info) = describe(hwnd) {
        if let Some(app) = super::app() {
            *app.state::<AppState>().foreground.lck() = Some(info);
        }
    }
}

/// Title, process and handle of `hwnd`, or `None` when it is not a target.
fn describe(hwnd: HWND) -> Option<ForegroundInfo> {
    unsafe {
        if hwnd == GetDesktopWindow() || hwnd == GetShellWindow() {
            return None;
        }
        let mut class = [0u16; 256];
        let n = GetClassNameW(hwnd, &mut class);
        let class = String::from_utf16_lossy(&class[..n.max(0) as usize]);
        if is_ignored_class(&class) {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 || pid == GetCurrentProcessId() {
            return None;
        }
        let mut title = [0u16; 512];
        let n = GetWindowTextW(hwnd, &mut title);
        let title = String::from_utf16_lossy(&title[..n.max(0) as usize]);
        Some(ForegroundInfo { hwnd: hwnd.0 as isize, title, process: process_name(pid) })
    }
}

/// `chrome.exe` for a process id (lower case), or `None` if it cannot be read.
fn process_name(pid: u32) -> Option<String> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; MAX_PATH as usize * 2];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, windows::core::PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(handle);
        if !ok {
            return None;
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        exe_name(&path)
    }
}

/// The file name of a path, lower case: `C:\x\Chrome.EXE` to `chrome.exe`.
pub fn exe_name(path: &str) -> Option<String> {
    let name = path.rsplit(['\\', '/']).next()?.trim();
    (!name.is_empty()).then(|| name.to_lowercase())
}

/// Whether a stored handle still names a window.
pub fn still_exists(hwnd: isize) -> bool {
    hwnd != 0 && unsafe { IsWindow(Some(HWND(hwnd as *mut _))).as_bool() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_windows_are_ignored() {
        for c in ["Shell_TrayWnd", "shell_traywnd", "NotifyIconOverflowWindow", "TopLevelWindowForOverflowXamlIsland", "Progman", "WorkerW"] {
            assert!(is_ignored_class(c), "{c}");
        }
        for c in ["Chrome_WidgetWin_1", "Notepad", "CASCADIA_HOSTING_WINDOW_CLASS"] {
            assert!(!is_ignored_class(c), "{c}");
        }
    }

    #[test]
    fn exe_names() {
        assert_eq!(exe_name(r"C:\Program Files\Google\Chrome\Application\Chrome.EXE").as_deref(), Some("chrome.exe"));
        assert_eq!(exe_name("slack.exe").as_deref(), Some("slack.exe"));
        assert_eq!(exe_name(r"C:\dir\").as_deref(), None);
    }
}
