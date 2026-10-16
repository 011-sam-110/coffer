//! Where Quick Access opens (SPEC 9). Pure maths in physical pixels.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RectI {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl RectI {
    pub fn width(&self) -> i32 {
        self.right - self.left
    }
    pub fn height(&self) -> i32 {
        self.bottom - self.top
    }
}

/// Logical size of Quick Access and its margin from the work-area edge.
pub const QUICK_SIZE: (f64, f64) = (400.0, 560.0);
pub const QUICK_MARGIN: f64 = 12.0;

/// From a tray click: in the corner of the work area nearest the tray icon,
/// `margin` in. With the taskbar at the bottom (always on Windows 11) that is
/// the bottom-right corner.
pub fn near_tray(work: RectI, icon_center: (i32, i32), size: (i32, i32), margin: i32) -> (i32, i32) {
    let mid_x = work.left + work.width() / 2;
    let mid_y = work.top + work.height() / 2;
    let x = if icon_center.0 >= mid_x { work.right - margin - size.0 } else { work.left + margin };
    let y = if icon_center.1 >= mid_y { work.bottom - margin - size.1 } else { work.top + margin };
    clamp(work, (x, y), size)
}

/// From the hotkey: centred in the work area of the target window's monitor.
pub fn centered(work: RectI, size: (i32, i32)) -> (i32, i32) {
    clamp(work, (work.left + (work.width() - size.0) / 2, work.top + (work.height() - size.1) / 2), size)
}

/// Keep the window inside the work area (top-left wins if it cannot fit).
pub fn clamp(work: RectI, pos: (i32, i32), size: (i32, i32)) -> (i32, i32) {
    let x = pos.0.min(work.right - size.0).max(work.left);
    let y = pos.1.min(work.bottom - size.1).max(work.top);
    (x, y)
}

/// The window position that puts its client area at `client`, given where the
/// window and its client area are now (the difference is the invisible border).
pub fn window_for_client(client: (i32, i32), outer_now: (i32, i32), inner_now: (i32, i32)) -> (i32, i32) {
    (client.0 - (inner_now.0 - outer_now.0), client.1 - (inner_now.1 - outer_now.1))
}

/// The physical size and margin for a monitor scale factor.
pub fn scaled(scale: f64) -> ((i32, i32), i32) {
    let s = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    (((QUICK_SIZE.0 * s).round() as i32, (QUICK_SIZE.1 * s).round() as i32), (QUICK_MARGIN * s).round() as i32)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 1920 x 1080 at 100 % with a 48 px taskbar at the bottom.
    const FHD: RectI = RectI { left: 0, top: 0, right: 1920, bottom: 1032 };

    #[test]
    fn tray_click_bottom_right_12px_in() {
        let (size, margin) = scaled(1.0);
        assert_eq!(size, (400, 560));
        assert_eq!(near_tray(FHD, (1800, 1056), size, margin), (1920 - 12 - 400, 1032 - 12 - 560));
    }

    #[test]
    fn tray_click_at_150_percent() {
        let work = RectI { left: 0, top: 0, right: 2880, bottom: 1548 };
        let (size, margin) = scaled(1.5);
        assert_eq!((size, margin), ((600, 840), 18));
        assert_eq!(near_tray(work, (2700, 1590), size, margin), (2880 - 18 - 600, 1548 - 18 - 840));
    }

    #[test]
    fn tray_click_on_a_second_monitor_left_of_the_primary() {
        let work = RectI { left: -2560, top: 0, right: 0, bottom: 1392 };
        let (size, margin) = scaled(1.0);
        assert_eq!(near_tray(work, (-100, 1420), size, margin), (-12 - 400, 1392 - 12 - 560));
    }

    #[test]
    fn top_and_left_taskbars_use_the_nearest_corner() {
        // Taskbar at the top (Windows 10): work area starts at y = 40.
        let top = RectI { left: 0, top: 40, right: 1920, bottom: 1080 };
        assert_eq!(near_tray(top, (1850, 20), (400, 560), 12), (1508, 52));
        // Taskbar on the left: tray at the bottom-left.
        let left = RectI { left: 62, top: 0, right: 1920, bottom: 1080 };
        assert_eq!(near_tray(left, (30, 1040), (400, 560), 12), (74, 508));
    }

    #[test]
    fn client_area_is_what_gets_placed() {
        // 12 px invisible border left, none at the top.
        assert_eq!(window_for_client((2135, 785), (100, 50), (112, 50)), (2123, 785));
        assert_eq!(window_for_client((10, 10), (0, 0), (0, 0)), (10, 10));
    }

    #[test]
    fn hotkey_centres_on_the_monitor() {
        assert_eq!(centered(FHD, (400, 560)), (760, 236));
        let second = RectI { left: 1920, top: -200, right: 3840, bottom: 880 };
        assert_eq!(centered(second, (400, 560)), (2680, 60));
    }

    #[test]
    fn a_window_larger_than_the_work_area_keeps_its_top_left_inside() {
        let tiny = RectI { left: 0, top: 0, right: 300, bottom: 400 };
        assert_eq!(centered(tiny, (400, 560)), (0, 0));
        assert_eq!(near_tray(tiny, (290, 420), (400, 560), 12), (0, 0));
    }
}
