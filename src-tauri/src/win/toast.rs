//! Windows notifications (toasts) through the WinRT API of the `windows`
//! crate Coffer already uses, so no notification crate and no second copy of
//! `windows` comes in. A click on the notice runs `on_click` in Coffer.
//!
//! Windows shows a toast under an app id (AUMID). The installer's Start menu
//! shortcut carries Coffer's identifier as that id, so the notice says
//! "Coffer" with its icon. Call these from a thread in the multi-threaded
//! apartment (see [`init_thread`]).

use windows::core::{HSTRING, IInspectable};
use windows::Data::Xml::Dom::XmlDocument;
use windows::Foundation::TypedEventHandler;
use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};
use windows::Win32::System::SystemInformation::GetLocalTime;
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

/// Join the multi-threaded apartment for this thread (it stays joined:
/// the notices thread lives as long as Coffer).
pub fn init_thread() {
    let _ = unsafe { RoInitialize(RO_INIT_MULTITHREADED) };
}

/// Today on the PC's own clock: (year, month 1-12, day 1-31).
pub fn local_today() -> (i32, u8, u8) {
    let t = unsafe { GetLocalTime() };
    (i32::from(t.wYear), t.wMonth as u8, t.wDay as u8)
}

/// `&`, `<`, `>`, `"` and `'` as XML entities.
pub fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            // Control characters are not allowed in XML 1.0.
            c if (c as u32) < 0x20 && c != '\t' => out.push(' '),
            c => out.push(c),
        }
    }
    out
}

/// The toast XML: a bold first line and a second line.
pub fn toast_xml(title: &str, body: &str) -> String {
    format!(
        "<toast activationType=\"foreground\" launch=\"coffer\"><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual></toast>",
        xml_escape(title),
        xml_escape(body)
    )
}

/// Show one notice under `app_id`. Keep the returned notification alive:
/// Windows calls `on_click` only while it exists.
pub fn show(app_id: &str, title: &str, body: &str, on_click: impl Fn() + Send + 'static) -> windows::core::Result<ToastNotification> {
    let doc = XmlDocument::new()?;
    doc.LoadXml(&HSTRING::from(toast_xml(title, body)))?;
    let toast = ToastNotification::CreateToastNotification(&doc)?;
    toast.SetExpiresOnReboot(true)?;
    toast.Activated(&TypedEventHandler::<ToastNotification, IInspectable>::new(move |_, _| {
        on_click();
        Ok(())
    }))?;
    let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id))?;
    notifier.Show(&toast)?;
    Ok(toast)
}
