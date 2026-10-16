//! Lock signals (SPEC 3.11) and the thread that pumps Win32 messages for them.
//!
//! A hidden top-level tool window (not a message-only window: those get no
//! broadcasts, so no `WM_POWERBROADCAST` or `WM_QUERYENDSESSION`) receives:
//! - `WM_WTSSESSION_CHANGE` / `WTS_SESSION_LOCK` (after `WTSRegisterSessionNotification`),
//! - `WM_POWERBROADCAST` / `PBT_APMSUSPEND` (after `RegisterSuspendResumeNotification`,
//!   needed on Modern Standby PCs),
//! - `PBT_POWERSETTINGCHANGE` for `GUID_CONSOLE_DISPLAY_STATE` (display off),
//! - `WM_QUERYENDSESSION` / `WM_ENDSESSION` (sign-out, shutdown).
//!
//! The same thread hosts the foreground WinEvent hook. A second thread polls
//! `GetLastInputInfo` every 15 s for the idle lock.

use std::time::Duration;

use windows::Win32::Foundation::{HANDLE, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Power::{POWERBROADCAST_SETTING, RegisterPowerSettingNotification, RegisterSuspendResumeNotification};
use windows::Win32::System::RemoteDesktop::{NOTIFY_FOR_THIS_SESSION, WTSRegisterSessionNotification};
use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::System::SystemServices::GUID_CONSOLE_DISPLAY_STATE;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DEVICE_NOTIFY_WINDOW_HANDLE, DefWindowProcW, DispatchMessageW, GetMessageW, MSG, PBT_APMSUSPEND, PBT_POWERSETTINGCHANGE, RegisterClassW,
    TranslateMessage, WM_ENDSESSION, WM_POWERBROADCAST, WM_QUERYENDSESSION, WM_WTSSESSION_CHANGE, WNDCLASSW, WS_EX_TOOLWINDOW, WS_OVERLAPPED, WTS_SESSION_LOCK,
};
use windows::core::w;

use crate::lock::{self, Signal};

/// How often the idle check runs (SPEC 3.11).
pub const IDLE_POLL: Duration = Duration::from_secs(15);

pub fn start() {
    let _ = std::thread::Builder::new().name("coffer-signals".into()).spawn(signal_thread);
    let _ = std::thread::Builder::new().name("coffer-idle".into()).spawn(idle_thread);
}

fn signal_thread() {
    unsafe {
        let module = GetModuleHandleW(None).ok();
        let instance = module.map(|m| HINSTANCE(m.0));
        let class = w!("CofferSignalWindow");
        let wc = WNDCLASSW { lpfnWndProc: Some(wndproc), hInstance: instance.unwrap_or_default(), lpszClassName: class, ..Default::default() };
        if RegisterClassW(&wc) == 0 {
            crate::log!("signals: RegisterClassW failed");
            return;
        }
        let hwnd = match CreateWindowExW(WS_EX_TOOLWINDOW, class, w!("Coffer signals"), WS_OVERLAPPED, 0, 0, 0, 0, None, None, instance, None) {
            Ok(h) => h,
            Err(e) => {
                crate::log!("signals: CreateWindowExW failed: {e}");
                return;
            }
        };
        super::clipboard::set_owner(hwnd);
        let wts = WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION).is_ok();
        let suspend = RegisterSuspendResumeNotification(HANDLE(hwnd.0), DEVICE_NOTIFY_WINDOW_HANDLE).is_ok();
        let display = RegisterPowerSettingNotification(HANDLE(hwnd.0), &GUID_CONSOLE_DISPLAY_STATE, DEVICE_NOTIFY_WINDOW_HANDLE).is_ok();
        let hook = super::foreground::install();
        crate::log!("signals: window ready; session={wts} suspend={suspend} display={display} foregroundHook={hook}");

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_WTSSESSION_CHANGE => {
            if wparam.0 as u32 == WTS_SESSION_LOCK {
                deliver(Signal::SessionLock);
            }
            LRESULT(0)
        }
        WM_POWERBROADCAST => {
            match wparam.0 as u32 {
                PBT_APMSUSPEND => deliver(Signal::Suspend),
                PBT_POWERSETTINGCHANGE => {
                    let setting = lparam.0 as *const POWERBROADCAST_SETTING;
                    if !setting.is_null() {
                        let s = unsafe { &*setting };
                        if s.PowerSetting == GUID_CONSOLE_DISPLAY_STATE && s.DataLength >= 4 {
                            // 0 = off, 1 = on, 2 = dimmed.
                            let state = unsafe { std::ptr::read_unaligned(s.Data.as_ptr() as *const u32) };
                            if state == 0 {
                                deliver(Signal::DisplayOff);
                            }
                        }
                    }
                }
                _ => {}
            }
            LRESULT(1)
        }
        WM_QUERYENDSESSION => {
            // Lock and clear now: after WM_ENDSESSION the process can end at any time.
            deliver(Signal::EndSession);
            LRESULT(1)
        }
        WM_ENDSESSION => {
            if wparam.0 != 0 {
                if let Some(app) = super::app() {
                    crate::log!("signals: session ends; exiting");
                    app.exit(0);
                }
            }
            LRESULT(0)
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

fn deliver(signal: Signal) {
    if let Some(app) = super::app() {
        lock::on_signal(app, signal);
    }
}

/// Milliseconds since the last keyboard or mouse input in this session.
pub fn idle_millis() -> u64 {
    unsafe {
        let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        if !GetLastInputInfo(&mut info).as_bool() {
            return 0;
        }
        GetTickCount().wrapping_sub(info.dwTime) as u64
    }
}

fn idle_thread() {
    loop {
        std::thread::sleep(IDLE_POLL);
        if let Some(app) = super::app() {
            lock::check_idle(app, idle_millis());
        }
    }
}
