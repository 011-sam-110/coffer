//! Auto-type (SPEC 10, tier 2): Ctrl+Enter in Quick Access types the item
//! into the window that was in front before Quick Access opened.
//!
//! Order: resolve every value first (re-prompt errors reach Quick Access
//! while it is still open), refuse an elevated target, bring the target to
//! the front and check it, hide Quick Access, wait for the modifier keys,
//! then type. Before each step the target must still be in front.

use std::time::Duration;

use coffer_core::{CoreError, Vault};
use tauri::{AppHandle, Manager};
use zeroize::Zeroizing;

use crate::error::{CofferError, CofferResult, ErrorCode};
use crate::state::{AppState, LockExt};
use crate::win::autotype as win;

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

fn resolve(v: &mut Vault, id: &str, password: Option<&str>) -> CofferResult<Vec<Step>> {
    let view = v.item_get(id)?;
    let seq = view.autotype_sequence.as_deref().map(str::trim).filter(|s| !s.is_empty()).unwrap_or(DEFAULT_SEQUENCE);
    let tokens = parse(seq).map_err(CofferError::invalid)?;
    let mut steps = Vec::with_capacity(tokens.len());
    for t in tokens {
        steps.push(match t {
            Token::Text(s) => Step::Text(Zeroizing::new(s)),
            Token::Username => Step::Text(value(v, id, "username", "username", password)?),
            Token::Password => Step::Text(value(v, id, "password", "password", password)?),
            Token::Totp => match v.totp_code(id, None, password) {
                Ok(code) => Step::Text(Zeroizing::new(code.code)),
                Err(CoreError::NotFound) => return Err(missing("one-time code")),
                Err(e) => return Err(e.into()),
            },
            Token::Field(label) => {
                let field = view.fields.iter().find(|f| f.label.eq_ignore_ascii_case(&label)).ok_or_else(|| missing(&format!("field named \"{label}\"")))?;
                Step::Text(value(v, id, &field.id, &format!("value in \"{label}\""), password)?)
            }
            Token::Tab => Step::Tab,
            Token::Enter => Step::Enter,
            Token::Delay(ms) => Step::Delay(ms),
        });
    }
    Ok(steps)
}

/// `autotype({ id, password })`.
pub fn run(app: &AppHandle, id: &str, password: Option<&str>) -> CofferResult<()> {
    let state = app.state::<AppState>();
    if !state.is_unlocked() {
        return Err(CofferError::locked());
    }
    let target = state.foreground.lck().as_ref().map(|f| f.hwnd).filter(|h| crate::win::foreground::still_exists(*h));
    let target = target.ok_or_else(|| CofferError::invalid("The window to type into is gone. Click in it, then open Quick Access again."))?;
    if win::runs_higher(win::window_pid(target)) {
        return Err(CofferError::invalid("Coffer cannot type into an app running as administrator."));
    }
    let steps = crate::vault::with_session(app, |s| resolve(&mut s.vault, id, password))?;

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
        };
        if let Err(e) = sent {
            crate::log!("autotype: {e}");
            return fail("Windows did not take all the keys. Check what was typed.");
        }
        // Give the target time to move focus after Tab or Enter.
        std::thread::sleep(Duration::from_millis(15));
    }
    crate::log!("autotype: typed {total} steps");
    Ok(())
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
    fn bad_sequences() {
        assert!(parse("{USERNAME").is_err());
        assert!(parse("{SHIFT}").is_err());
        assert!(parse("{DELAY x}").is_err());
        assert!(parse("{DELAY 99999}").is_err());
        assert!(parse("{FIELD:}").is_err());
        assert_eq!(parse("").unwrap(), vec![]);
    }
}
