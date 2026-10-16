//! Open a web address in the default browser (SPEC 3.7: `item_open_url`
//! opens only an http or https URL stored in the item; never a `file:` or
//! `ms-*:` URL).

use tauri::Url;
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
use windows::core::{PCWSTR, w};

/// The URL to open, re-serialised, or `None` when it is not a plain http(s)
/// address with a host.
pub fn openable(url: &str) -> Option<String> {
    let parsed = Url::parse(url.trim()).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none_or(str::is_empty) {
        return None;
    }
    Some(parsed.to_string())
}

/// Open `url` (checked with `openable`) with the default browser.
#[allow(dead_code)]
pub fn open_url(url: &str) -> Result<(), String> {
    let url = openable(url).ok_or_else(|| "Coffer opens only http and https addresses.".to_string())?;
    let wide = super::wide(&url);
    let result = unsafe { ShellExecuteW(None, w!("open"), PCWSTR(wide.as_ptr()), None, None, SW_SHOWNORMAL) };
    // ShellExecuteW returns a value greater than 32 on success.
    if result.0 as isize > 32 { Ok(()) } else { Err(format!("ShellExecuteW failed ({})", result.0 as isize)) }
}

#[cfg(test)]
mod tests {
    use super::openable;

    #[test]
    fn only_http_and_https_with_a_host() {
        assert_eq!(openable("https://github.com/login").as_deref(), Some("https://github.com/login"));
        assert_eq!(openable(" http://example.com ").as_deref(), Some("http://example.com/"));
        for bad in ["file:///C:/Windows/System32/calc.exe", "ms-settings:privacy", "javascript:alert(1)", "C:\\Windows\\notepad.exe", "\\\\server\\share", "https://", "github.com", "ftp://example.com/"] {
            assert_eq!(openable(bad), None, "{bad}");
        }
    }
}
