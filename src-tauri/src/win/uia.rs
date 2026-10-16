//! UI Automation reads for smart fill (SPEC 10): which box of the target
//! window has the keyboard focus, whether it is a password box, and where
//! the page's password box is. Coffer only reads the tree and moves the
//! keyboard focus to a password box; it never clicks and never reads values.
//!
//! Browsers build their accessibility tree when a UI Automation client asks,
//! so the first read on a page can take a moment; the timeouts cap it.

use std::time::Duration;

use windows::Win32::Foundation::{HWND, RPC_E_CHANGED_MODE, VARIANT_TRUE};
use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize};
use windows::Win32::System::Variant::{VARIANT, VT_BOOL};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomation2, IUIAutomationCondition, IUIAutomationElement, TreeScope_Descendants, UIA_ComboBoxControlTypeId,
    UIA_DocumentControlTypeId, UIA_EditControlTypeId, UIA_IsEnabledPropertyId, UIA_IsPasswordPropertyId, UIA_PaneControlTypeId,
};
use windows::core::Interface;

/// What has the keyboard focus in the target window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FocusKind {
    /// Not a text box, another process, or UI Automation gave no answer.
    Unknown,
    /// A text box that is not a password box (an email or username box, a code box).
    Text,
    Password,
}

/// COM for this thread, undone on drop when this guard started it.
struct Com(bool);

impl Com {
    fn init() -> Self {
        let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        // RPC_E_CHANGED_MODE: the thread is already single-threaded COM, which UI Automation also accepts.
        Com(hr.is_ok() && hr != RPC_E_CHANGED_MODE)
    }
}

impl Drop for Com {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
}

/// One read of the target window; keep it for the whole fill (the password
/// box it found is used after the username is typed). Use it on one thread.
pub struct Reader {
    automation: IUIAutomation,
    pub focus: FocusKind,
    /// The accessible name of the focused box (its label), to tell a code box.
    pub focus_name: String,
    /// A password box on the same page as a focused text box.
    password_box: Option<IUIAutomationElement>,
    // Last field: COM is undone after the interfaces above are released.
    _com: Com,
}

impl Reader {
    /// Read the focus of the window `target` (a top-level window of process `pid`).
    pub fn read(target: isize, pid: u32) -> Result<Reader, String> {
        let com = Com::init();
        let automation: IUIAutomation = unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }.map_err(|e| format!("UI Automation: {e}"))?;
        if let Ok(a2) = automation.cast::<IUIAutomation2>() {
            unsafe {
                let _ = a2.SetConnectionTimeout(1500);
                let _ = a2.SetTransactionTimeout(1500);
            }
        }
        let mut reader = Reader { automation, focus: FocusKind::Unknown, focus_name: String::new(), password_box: None, _com: com };
        // A browser that no client asked before answers with its bare window
        // pane and builds the page's tree from that question: ask again.
        let mut tries = 0;
        let (focused, kind) = loop {
            let focused = match unsafe { reader.automation.GetFocusedElement() } {
                Ok(f) => f,
                Err(e) => {
                    crate::log!("uia: no focused element ({e})");
                    return Ok(reader);
                }
            };
            let kind = unsafe { focused.CurrentControlType() }.unwrap_or_default();
            tries += 1;
            if (kind != UIA_PaneControlTypeId && kind != UIA_DocumentControlTypeId) || tries == 6 {
                break (focused, kind);
            }
            std::thread::sleep(Duration::from_millis(200));
        };
        let focused_pid = unsafe { focused.CurrentProcessId() }.ok().map(|p| p as u32);
        if focused_pid != Some(pid) {
            crate::log!("uia: the focus is in process {focused_pid:?}, not the target {pid} (control type {})", kind.0);
            return Ok(reader);
        }
        if kind != UIA_EditControlTypeId && kind != UIA_ComboBoxControlTypeId {
            crate::log!("uia: the focus is not a text box (control type {})", kind.0);
            return Ok(reader);
        }
        reader.focus_name = unsafe { focused.CurrentName() }.map(|b| b.to_string()).unwrap_or_default();
        if unsafe { focused.CurrentIsPassword() }.map(|b| b.as_bool()).unwrap_or(false) {
            reader.focus = FocusKind::Password;
            return Ok(reader);
        }
        reader.focus = FocusKind::Text;
        let root = reader.page_of(&focused).or_else(|| unsafe { reader.automation.ElementFromHandle(HWND(target as *mut _)) }.ok());
        if let Some(root) = root {
            reader.password_box = reader.find_password_box(&root);
        }
        Ok(reader)
    }

    /// The document (web page) that holds `element`, if it is in one.
    fn page_of(&self, element: &IUIAutomationElement) -> Option<IUIAutomationElement> {
        let walker = unsafe { self.automation.ControlViewWalker() }.ok()?;
        let mut at = element.clone();
        for _ in 0..60 {
            at = unsafe { walker.GetParentElement(&at) }.ok()?;
            if unsafe { at.CurrentControlType() }.ok() == Some(UIA_DocumentControlTypeId) {
                return Some(at);
            }
        }
        None
    }

    fn find_password_box(&self, root: &IUIAutomationElement) -> Option<IUIAutomationElement> {
        let cond = |id| -> Option<IUIAutomationCondition> { unsafe { self.automation.CreatePropertyCondition(id, &bool_variant(true)) }.ok() };
        let both = unsafe { self.automation.CreateAndCondition(&cond(UIA_IsPasswordPropertyId)?, &cond(UIA_IsEnabledPropertyId)?) }.ok()?;
        unsafe { root.FindFirst(TreeScope_Descendants, &both) }.ok()
    }

    pub fn page_has_password_box(&self) -> bool {
        self.password_box.is_some()
    }

    /// Put the keyboard focus in the page's password box. True when the
    /// focus is in a password box afterwards.
    pub fn focus_password_box(&self) -> bool {
        let Some(el) = &self.password_box else { return false };
        if unsafe { el.SetFocus() }.is_err() {
            return false;
        }
        std::thread::sleep(Duration::from_millis(60));
        unsafe { self.automation.GetFocusedElement() }
            .ok()
            .and_then(|f| unsafe { f.CurrentIsPassword() }.ok())
            .is_some_and(|b| b.as_bool())
    }
}

fn bool_variant(value: bool) -> VARIANT {
    let mut v = VARIANT::default();
    unsafe {
        let inner = &mut *v.Anonymous.Anonymous;
        inner.vt = VT_BOOL;
        inner.Anonymous.boolVal = if value { VARIANT_TRUE } else { Default::default() };
    }
    v
}
