//! Monitor work areas and scale factors, in physical pixels.

use windows::Win32::Foundation::{HWND, POINT};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, HMONITOR, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromPoint, MonitorFromWindow};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, GetDpiForSystem, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

use crate::placement::RectI;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MonitorArea {
    /// The work area (the monitor minus the taskbar), physical pixels.
    pub work: RectI,
    /// Effective DPI / 96.
    pub scale: f64,
}

fn area(monitor: HMONITOR) -> Option<MonitorArea> {
    if monitor.is_invalid() {
        return None;
    }
    unsafe {
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return None;
        }
        let (mut dx, mut dy) = (96u32, 96u32);
        let scale = if GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dx, &mut dy).is_ok() { dx as f64 / 96.0 } else { 1.0 };
        let r = info.rcWork;
        Some(MonitorArea { work: RectI { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, scale })
    }
}

pub fn from_point(x: i32, y: i32) -> Option<MonitorArea> {
    area(unsafe { MonitorFromPoint(POINT { x, y }, MONITOR_DEFAULTTONEAREST) })
}

pub fn from_window(hwnd: isize) -> Option<MonitorArea> {
    if hwnd == 0 {
        return None;
    }
    area(unsafe { MonitorFromWindow(HWND(hwnd as *mut _), MONITOR_DEFAULTTONEAREST) })
}

pub fn cursor() -> Option<(i32, i32)> {
    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p).ok()? };
    Some((p.x, p.y))
}

pub fn from_cursor() -> Option<MonitorArea> {
    let (x, y) = cursor()?;
    from_point(x, y)
}

/// The system DPI (96 at 100 %).
pub fn system_dpi() -> u32 {
    let dpi = unsafe { GetDpiForSystem() };
    if dpi == 0 { 96 } else { dpi }
}
