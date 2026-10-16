//! Auto-type and smart fill (SPEC 10, tier 2): Enter on a login in Quick
//! Access fills the window that was in front before Quick Access opened.
//!
//! Smart fill reads, with UI Automation, which box of that window has the
//! keyboard focus and types only what fits there: the email and the password
//! on a one-page sign-in, the email alone on a two-page sign-in, the password
//! in a password box, the one-time code in a code box. It returns what the
//! next Enter on the item should type (the password, then the code), and
//! Quick Access shows that as the Continue row. An item with an auto-type
//! sequence of its own types that sequence.
//!
//! Order: resolve every value first (re-prompt errors reach Quick Access
//! while it is still open), refuse an elevated target, bring the target to
//! the front and check it, hide Quick Access, wait for the modifier keys,
//! read the focus, then type. Before each step the target must still be in
//! front.

use std::time::Duration;

use coffer_core::model::ItemView;
use coffer_core::{CoreError, Vault};
use tauri::{AppHandle, Manager};
use zeroize::Zeroizing;

use crate::contract::{AutotypeNext, AutotypeOnly, AutotypeResult};
use crate::error::{CofferError, CofferResult, ErrorCode};
use crate::state::{AppState, LockExt};
use crate::win::autotype as win;
use crate::win::uia::{self, FocusKind};

pub const DEFAULT_SEQUENCE: &str = "{USERNAME}{TAB}{PASSWORD}{ENTER}";
/// The longest `{DELAY ms}`.
const MAX_DELAY_MS: u32 = 10_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Token {
    Text(String),
    Username,
    Password,
    Totp,
    Tab,
    Enter,
    Delay(u32),
    Field(String),
    /// Smart fill only (no sequence token): put the focus in the page's
    /// password box, or press Tab when UI Automation cannot.
    FocusPassword,
}

/// Parse an auto-type sequence. Text outside braces is typed as it is.
pub fn parse(seq: &str) -> Result<Vec<Token>, String> {
    let mut out = Vec::new();
    let mut text = String::new();
    let mut rest = seq;
    while let Some(open) = rest.find('{') {
        text.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let close = after.find('}').ok_or_else(|| format!("An auto-type token is not closed: {{{after}"))?;
        let name = &after[..close];
        if !text.is_empty() {
            out.push(Token::Text(std::mem::take(&mut text)));
        }
        let upper = name.trim().to_ascii_uppercase();
        let token = match upper.as_str() {
            "USERNAME" => Token::Username,
            "PASSWORD" => Token::Password,
            "TOTP" => Token::Totp,
            "TAB" => Token::Tab,
            "ENTER" => Token::Enter,
            _ if upper.starts_with("DELAY ") => {
                let ms: u32 = upper["DELAY ".len()..].trim().parse().map_err(|_| format!("{{{name}}} needs a number of milliseconds."))?;
                if ms > MAX_DELAY_MS {
                    return Err(format!("{{{name}}} is too long: at most {MAX_DELAY_MS} ms."));
                }
                Token::Delay(ms)
            }
            _ if upper.starts_with("FIELD:") => {
                let label = name.trim()["FIELD:".len()..].trim();
                if label.is_empty() {
                    return Err("{FIELD:} needs a field name.".into());
                }
                Token::Field(label.to_string())
            }
            _ => return Err(format!("Coffer does not know the auto-type token {{{name}}}.")),
        };
        out.push(token);
        rest = &after[close + 1..];
    }
    text.push_str(rest);
    if !text.is_empty() {
        out.push(Token::Text(text));
    }
    Ok(out)
}

/// What to send, with every secret resolved.
enum Step {
    Text(Zeroizing<String>),
    Tab,
    Enter,
    Delay(u32),
    FocusPassword,
}

fn missing(what: &str) -> CofferError {
    CofferError::new(ErrorCode::NotFound, format!("This item has no {what}, so Coffer typed nothing."))
}

fn value(v: &mut Vault, id: &str, field_ref: &str, what: &str, password: Option<&str>) -> CofferResult<Zeroizing<String>> {
    match v.item_copy_value(id, field_ref, password) {
        Ok(s) => Ok(s),
        Err(CoreError::NotFound) => Err(missing(what)),
        Err(CoreError::BadCredentials) => Err(CofferError::new(ErrorCode::BadCredentials, "Wrong master password.")),
        Err(e) => Err(e.into()),
    }
}

/// `Ok(None)` for a value the item does not have; other errors (re-prompt) pass.
fn optional(r: CofferResult<Zeroizing<String>>) -> CofferResult<Option<Zeroizing<String>>> {
    match r {
        Ok(s) if s.is_empty() => Ok(None),
        Ok(s) => Ok(Some(s)),
        Err(e) if e.code == ErrorCode::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// The username, or else a field named Email (logins keep the email as the username).
fn username_or_email(v: &mut Vault, view: &ItemView, id: &str, password: Option<&str>) -> CofferResult<Option<Zeroizing<String>>> {
    if let Some(u) = optional(value(v, id, "username", "username", password))? {
        return Ok(Some(u));
    }
    match view.fields.iter().find(|f| f.label.trim().eq_ignore_ascii_case("email")) {
        Some(f) => optional(value(v, id, &f.id, "email", password)),
        None => Ok(None),
    }
}

fn totp_now(v: &mut Vault, id: &str, password: Option<&str>) -> CofferResult<Option<(Zeroizing<String>, u64)>> {
    match v.totp_code(id, None, password) {
        Ok(code) => Ok(Some((Zeroizing::new(code.code), code.remaining))),
        Err(CoreError::NotFound) => Ok(None),
        Err(CoreError::BadCredentials) => Err(CofferError::new(ErrorCode::BadCredentials, "Wrong master password.")),
        Err(e) => Err(e.into()),
    }
}

/// What the item can give to smart fill.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Has {
    pub username: bool,
    pub password: bool,
    pub totp: bool,
}

/// What smart fill types and what the next Enter types.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FillPlan {
    pub tokens: Vec<Token>,
    pub next: Option<AutotypeNext>,
}

/// The label of a box that asks for a one-time code ("Enter the 6-digit
/// code", "Verification code", "Authenticator code"), not a postal or a
/// promo code.
pub fn looks_like_code_box(name: &str) -> bool {
    let n = name.to_lowercase();
    let not = ["postal", "post code", "postcode", "zip", "country", "promo", "coupon", "discount", "voucher", "area code", "gift"];
    if not.iter().any(|w| n.contains(w)) {
        return false;
    }
    ["code", "otp", "2fa", "two-factor", "two factor", "2-step", "authenticator", "verification", "one-time", "one time"].iter().any(|w| n.contains(w))
}

/// Smart fill: what to type for the box that has the focus.
pub fn smart_plan(focus: FocusKind, page_has_password: bool, code_box: bool, has: Has) -> FillPlan {
    use Token::*;
    let after_password = has.totp.then_some(AutotypeNext::Totp);
    let plan = |tokens: Vec<Token>, next: Option<AutotypeNext>| FillPlan { tokens, next };
    match focus {
        // A 2FA page: the code box has the focus.
        FocusKind::Text if code_box && has.totp => plan(vec![Totp, Enter], None),
        FocusKind::Password if has.password => plan(vec![Password, Enter], after_password),
        // One page with both boxes: the email, then the password box, then sign in.
        FocusKind::Text if page_has_password && has.password => {
            plan(if has.username { vec![Username, FocusPassword, Password, Enter] } else { vec![FocusPassword, Password, Enter] }, after_password)
        }
        // A two-page sign-in: the email now, the password at the next Enter.
        FocusKind::Text if has.username => plan(vec![Username, Enter], if has.password { Some(AutotypeNext::Password) } else { after_password }),
        FocusKind::Text if has.password => plan(vec![Password, Enter], after_password),
        // No answer from UI Automation (some apps): the default sequence.
        FocusKind::Unknown if has.username && has.password => plan(vec![Username, Tab, Password, Enter], after_password),
        FocusKind::Unknown if has.password => plan(vec![Password, Enter], after_password),
        FocusKind::Unknown if has.username => plan(vec![Username], None),
        _ => plan(vec![], None),
    }
}

/// An item's own sequence, or the password alone (`only = password`).
fn tokens_for(only: Option<AutotypeOnly>, sequence: Option<&str>) -> Result<Vec<Token>, String> {
    if only == Some(AutotypeOnly::Password) {
        return Ok(vec![Token::Password]);
    }
    parse(sequence.map(str::trim).filter(|s| !s.is_empty()).unwrap_or(DEFAULT_SEQUENCE))
}

fn fixed_steps(v: &mut Vault, view: &ItemView, id: &str, tokens: Vec<Token>, password: Option<&str>) -> CofferResult<Vec<Step>> {
    let mut steps = Vec::with_capacity(tokens.len());
    for t in tokens {
        steps.push(match t {
            Token::Text(s) => Step::Text(Zeroizing::new(s)),
            Token::Username => Step::Text(value(v, id, "username", "username", password)?),
            Token::Password => Step::Text(value(v, id, "password", "password", password)?),
            Token::Totp => match totp_now(v, id, password)? {
                Some((code, _)) => Step::Text(code),
                None => return Err(missing("one-time code")),
            },
            Token::Field(label) => {
                let field = view.fields.iter().find(|f| f.label.eq_ignore_ascii_case(&label)).ok_or_else(|| missing(&format!("field named \"{label}\"")))?;
                Step::Text(value(v, id, &field.id, &format!("value in \"{label}\""), password)?)
            }
            Token::Tab => Step::Tab,
            Token::Enter => Step::Enter,
            Token::Delay(ms) => Step::Delay(ms),
            Token::FocusPassword => Step::FocusPassword,
        });
    }
    Ok(steps)
}

/// Every value smart fill may type, resolved before the target comes to the front.
#[derive(Default)]
struct Values {
    username: Option<Zeroizing<String>>,
    password: Option<Zeroizing<String>>,
    totp: Option<(Zeroizing<String>, u64)>,
}

impl Values {
    fn has(&self) -> Has {
        Has { username: self.username.is_some(), password: self.password.is_some(), totp: self.totp.is_some() }
    }

    fn steps(&self, tokens: &[Token]) -> Vec<Step> {
        tokens
            .iter()
            .filter_map(|t| match t {
                Token::Username => self.username.clone().map(Step::Text),
                Token::Password => self.password.clone().map(Step::Text),
                Token::Totp => self.totp.as_ref().map(|(c, _)| Step::Text(c.clone())),
                Token::Tab => Some(Step::Tab),
                Token::Enter => Some(Step::Enter),
                Token::FocusPassword => Some(Step::FocusPassword),
                Token::Delay(ms) => Some(Step::Delay(*ms)),
                Token::Text(s) => Some(Step::Text(Zeroizing::new(s.clone()))),
                Token::Field(_) => None,
            })
            .collect()
    }
}

enum Prepared {
    /// A sequence, the password alone, or one step of a fill (password, code).
    Fixed(Vec<Step>, Option<AutotypeNext>),
    Smart(Values),
}

fn prepare(v: &mut Vault, id: &str, password: Option<&str>, only: Option<AutotypeOnly>) -> CofferResult<Prepared> {
    let view = v.item_get(id)?;
    let own_sequence = view.autotype_sequence.as_deref().map(str::trim).filter(|s| !s.is_empty()).is_some();
    match only {
        Some(AutotypeOnly::Password) => Ok(Prepared::Fixed(fixed_steps(v, &view, id, vec![Token::Password], password)?, None)),
        Some(AutotypeOnly::PasswordStep) => {
            let pw = value(v, id, "password", "password", password)?;
            let next = totp_now(v, id, password)?.map(|_| AutotypeNext::Totp);
            Ok(Prepared::Fixed(vec![Step::Text(pw), Step::Enter], next))
        }
        Some(AutotypeOnly::Totp) => {
            let (code, _) = totp_now(v, id, password)?.ok_or_else(|| missing("one-time code"))?;
            Ok(Prepared::Fixed(vec![Step::Text(code), Step::Enter], None))
        }
        None if own_sequence => {
            let tokens = tokens_for(None, view.autotype_sequence.as_deref()).map_err(CofferError::invalid)?;
            Ok(Prepared::Fixed(fixed_steps(v, &view, id, tokens, password)?, None))
        }
        None => Ok(Prepared::Smart(Values {
            username: username_or_email(v, &view, id, password)?,
            password: optional(value(v, id, "password", "password", password))?,
            totp: totp_now(v, id, password)?,
        })),
    }
}

/// Another Coffer (a second copy, a test build) is never a target: its
/// lock screen or search would get the keys.
fn is_coffer(target_exe: Option<&str>, own_exe: Option<&str>) -> bool {
    matches!((target_exe, own_exe), (Some(t), Some(o)) if t.eq_ignore_ascii_case(o) || t.eq_ignore_ascii_case("coffer.exe"))
}

/// `autotype({ id, password, only })`. Returns what the next Enter on this
/// item types (Quick Access's Continue row).
pub fn run(app: &AppHandle, id: &str, password: Option<&str>, only: Option<AutotypeOnly>) -> CofferResult<AutotypeResult> {
    let state = app.state::<AppState>();
    if !state.is_unlocked() {
        return Err(CofferError::locked());
    }
    let (target, target_exe) = state.foreground.lck().as_ref().map(|f| (f.hwnd, f.process.clone())).unzip();
    let target = target.filter(|h| crate::win::foreground::still_exists(*h));
    let target = target.ok_or_else(|| CofferError::invalid("The window to type into is gone. Click in it, then open Quick Access again."))?;
    let own_exe = std::env::current_exe().ok().and_then(|p| crate::win::foreground::exe_name(&p.to_string_lossy()));
    if is_coffer(target_exe.flatten().as_deref(), own_exe.as_deref()) {
        return Err(CofferError::invalid("Coffer does not type into Coffer. Click in the app you want to fill, then open Quick Access again."));
    }
    let pid = win::window_pid(target);
    if win::runs_higher(pid) {
        return Err(CofferError::invalid("Coffer cannot type into an app running as administrator."));
    }
    let mut prepared = crate::vault::with_session(app, |s| prepare(&mut s.vault, id, password, only))?;
    if let Prepared::Smart(values) = &mut prepared {
        if values.password.is_none() && values.username.is_none() && values.totp.is_none() {
            return Err(missing("username, password or one-time code"));
        }
        // A code with under 4 s left may be stale by the time the page checks it.
        if let Some((_, left)) = values.totp.as_ref().filter(|(_, left)| *left < 4) {
            std::thread::sleep(Duration::from_millis(left * 1000 + 300));
            values.totp = crate::vault::with_session(app, |s| totp_now(&mut s.vault, id, password))?;
        }
    }

    // From here Quick Access is hidden; a failure shows it again with the reason.
    let fail = |message: &str| {
        crate::shell::show_quick(app, crate::shell::QuickOrigin::Hotkey);
        Err(CofferError::invalid(message))
    };
    let in_front = win::bring_to_front(target);
    crate::shell::hide_quick(app);
    if !in_front && !win::bring_to_front(target) {
        return fail("Coffer could not bring that window to the front, so it typed nothing.");
    }
    if !win::wait_modifiers_released(Duration::from_secs(2)) {
        return fail("Let go of Ctrl, Shift, Alt and the Windows key, then try again. Coffer typed nothing.");
    }
    // The page puts the focus back in its box a moment after the window comes to the front.
    let mut reader = None;
    let (steps, next) = match prepared {
        Prepared::Fixed(steps, next) => (steps, next),
        Prepared::Smart(values) => {
            std::thread::sleep(Duration::from_millis(120));
            let read = uia::Reader::read(target, pid).map_err(|e| crate::log!("autotype: {e}")).ok();
            let focus = read.as_ref().map_or(FocusKind::Unknown, |r| r.focus);
            let page_has_password = read.as_ref().is_some_and(|r| r.page_has_password_box());
            let code_box = read.as_ref().is_some_and(|r| looks_like_code_box(&r.focus_name));
            let plan = smart_plan(focus, page_has_password, code_box, values.has());
            crate::log!("autotype: fill: focus {focus:?}, password box on the page {page_has_password}, code box {code_box}; {} steps, next {:?}", plan.tokens.len(), plan.next);
            reader = read;
            (values.steps(&plan.tokens), plan.next)
        }
    };
    if steps.is_empty() {
        return fail("This item has nothing that fits the box in front, so Coffer typed nothing.");
    }
    let total = steps.len();
    for (n, step) in steps.into_iter().enumerate() {
        if win::foreground() != target {
            crate::log!("autotype: the window changed after {n} of {total} steps");
            return fail("The window in front changed, so Coffer stopped typing.");
        }
        let sent = match step {
            Step::Text(text) => win::type_text(&text),
            Step::Tab => win::press(win::Key::Tab),
            Step::Enter => win::press(win::Key::Enter),
            Step::Delay(ms) => {
                std::thread::sleep(Duration::from_millis(u64::from(ms)));
                Ok(())
            }
            Step::FocusPassword => {
                if reader.as_ref().is_some_and(|r| r.focus_password_box()) {
                    Ok(())
                } else {
                    crate::log!("autotype: could not focus the password box; pressing Tab");
                    win::press(win::Key::Tab)
                }
            }
        };
        if let Err(e) = sent {
            crate::log!("autotype: {e}");
            return fail("Windows did not take all the keys. Check what was typed.");
        }
        // Give the target time to move focus after Tab or Enter.
        std::thread::sleep(Duration::from_millis(15));
    }
    crate::log!("autotype: typed {total} steps");
    Ok(AutotypeResult { next })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_sequence() {
        assert_eq!(parse(DEFAULT_SEQUENCE).unwrap(), vec![Token::Username, Token::Tab, Token::Password, Token::Enter]);
    }

    #[test]
    fn every_token() {
        assert_eq!(
            parse("{username}x{TAB}{Delay 250}{TOTP}{FIELD: PIN code}{ENTER} done").unwrap(),
            vec![
                Token::Username,
                Token::Text("x".into()),
                Token::Tab,
                Token::Delay(250),
                Token::Totp,
                Token::Field("PIN code".into()),
                Token::Enter,
                Token::Text(" done".into()),
            ]
        );
    }

    #[test]
    fn only_password_types_the_password_alone() {
        let seq = Some("{USERNAME}{TAB}{PASSWORD}{ENTER}");
        assert_eq!(tokens_for(Some(AutotypeOnly::Password), seq).unwrap(), vec![Token::Password]);
        assert_eq!(tokens_for(None, seq).unwrap().len(), 4);
        assert_eq!(tokens_for(None, None).unwrap(), parse(DEFAULT_SEQUENCE).unwrap());
        // The one Text step becomes Unicode key events only: a down and an up
        // per UTF-16 unit, no virtual key (so no Tab and no Enter).
        let password = "pÜ€x";
        let events = win::text_inputs(password);
        assert_eq!(events.len(), password.encode_utf16().count() * 2);
        for (i, (e, unit)) in events.iter().zip(password.encode_utf16().flat_map(|u| [u, u])).enumerate() {
            let ki = unsafe { e.Anonymous.ki };
            assert_eq!(ki.wVk.0, 0, "event {i}: no virtual key");
            assert_eq!(ki.wScan, unit, "event {i}");
            assert!(ki.dwFlags.contains(windows::Win32::UI::Input::KeyboardAndMouse::KEYEVENTF_UNICODE));
            assert_eq!(ki.dwFlags.contains(windows::Win32::UI::Input::KeyboardAndMouse::KEYEVENTF_KEYUP), i % 2 == 1);
        }
    }

    const ALL: Has = Has { username: true, password: true, totp: true };

    #[test]
    fn smart_fill_types_what_fits_the_box_in_focus() {
        use Token::*;
        let next = |p: FillPlan| p.next;
        // One page with an email box and a password box.
        let p = smart_plan(FocusKind::Text, true, false, ALL);
        assert_eq!(p.tokens, vec![Username, FocusPassword, Password, Enter]);
        assert_eq!(p.next, Some(AutotypeNext::Totp));
        // A two-page sign-in: the email first, the password at the next Enter.
        let p = smart_plan(FocusKind::Text, false, false, ALL);
        assert_eq!(p.tokens, vec![Username, Enter]);
        assert_eq!(p.next, Some(AutotypeNext::Password));
        // The password page.
        assert_eq!(smart_plan(FocusKind::Password, false, false, ALL).tokens, vec![Password, Enter]);
        // A 2FA page: the code box.
        let p = smart_plan(FocusKind::Text, false, true, ALL);
        assert_eq!(p.tokens, vec![Totp, Enter]);
        assert_eq!(p.next, None);
        // No one-time code: nothing comes after the password.
        let no_totp = Has { totp: false, ..ALL };
        assert_eq!(next(smart_plan(FocusKind::Password, false, false, no_totp)), None);
        assert_eq!(next(smart_plan(FocusKind::Text, true, false, no_totp)), None);
        // A code box but no code on the item: the email goes in, as on any text box.
        assert_eq!(smart_plan(FocusKind::Text, false, true, no_totp).tokens, vec![Username, Enter]);
        // No answer from UI Automation: the default sequence.
        assert_eq!(smart_plan(FocusKind::Unknown, false, false, ALL).tokens, parse(DEFAULT_SEQUENCE).unwrap());
        // No username: the password goes where it fits.
        let pw_only = Has { username: false, ..ALL };
        assert_eq!(smart_plan(FocusKind::Text, true, false, pw_only).tokens, vec![FocusPassword, Password, Enter]);
        assert_eq!(smart_plan(FocusKind::Unknown, false, false, pw_only).tokens, vec![Password, Enter]);
        // A password box but no password on the item: nothing.
        assert!(smart_plan(FocusKind::Password, false, false, Has { password: false, ..ALL }).tokens.is_empty());
    }

    #[test]
    fn coffer_never_types_into_coffer() {
        assert!(is_coffer(Some("coffer.exe"), Some("coffer.exe")));
        assert!(is_coffer(Some("Coffer.exe"), Some("coffer-qa.exe")));
        assert!(is_coffer(Some("coffer-qa.exe"), Some("coffer-qa.exe")));
        assert!(!is_coffer(Some("chrome.exe"), Some("coffer.exe")));
        assert!(!is_coffer(None, Some("coffer.exe")));
    }

    #[test]
    fn code_boxes_by_their_label() {
        for yes in ["Enter the 6-digit code", "Verification code", "Authenticator app code", "One-time password", "2FA code", "Security code from your app"] {
            assert!(looks_like_code_box(yes), "{yes}");
        }
        for no in ["Email or phone", "Password", "Postal code", "ZIP code", "Promo code", "Country code", ""] {
            assert!(!looks_like_code_box(no), "{no}");
        }
    }

    #[test]
    fn bad_sequences() {
        assert!(parse("{USERNAME").is_err());
        assert!(parse("{SHIFT}").is_err());
        assert!(parse("{DELAY x}").is_err());
        assert!(parse("{DELAY 99999}").is_err());
        assert!(parse("{FIELD:}").is_err());
        assert_eq!(parse("").unwrap(), vec![]);
    }
}
