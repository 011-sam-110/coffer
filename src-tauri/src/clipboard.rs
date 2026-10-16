//! Copy a secret to the clipboard and clear it later (SPEC 3.9). Item copy,
//! generator copy and the tray's "Copy a new password" all go through `copy`.

use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use zeroize::Zeroizing;

use crate::contract::{ClipboardCopiedEvent, CopyResult, Empty, events};
use crate::error::{CofferError, CofferResult};
use crate::state::{AppState, LockExt, RwExt};

/// What Coffer last put on the clipboard.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ClipState {
    /// `GetClipboardSequenceNumber` right after Coffer's write, while Coffer's
    /// copy may still be there.
    pub seq: Option<u32>,
    /// +1 per copy, so an older clear timer does nothing.
    pub generation: u64,
}

/// Clear only if the clipboard still holds exactly what Coffer wrote.
pub fn should_clear(ours: Option<u32>, current: u32) -> bool {
    ours == Some(current)
}

/// Whether a clear timer from copy `timer_generation` may act now.
pub fn timer_may_clear(state: &ClipState, timer_generation: u64) -> bool {
    state.generation == timer_generation && state.seq.is_some()
}

/// Copy `value`; it is wiped when this returns. `label` is what the UI shows
/// ("Password", "Username"); it is never the value.
pub fn copy(app: &AppHandle, value: Zeroizing<String>, label: &str) -> CofferResult<CopyResult> {
    let state = app.state::<AppState>();
    let clear_after = state.settings.rd().settings.clipboard_clear_seconds;
    // The clipboard-history exclusion always applies (SPEC 9).
    let seq = crate::win::clipboard::write_text(&value, true).map_err(|e| {
        crate::log!("clipboard: write failed: {e}");
        CofferError::io("Coffer could not use the clipboard. Try again.")
    })?;
    drop(value);
    let generation = {
        let mut clip = state.clipboard.lck();
        clip.seq = Some(seq);
        clip.generation += 1;
        clip.generation
    };
    let _ = app.emit(events::CLIPBOARD_COPIED, ClipboardCopiedEvent { label: label.to_string(), clears_in_seconds: clear_after });
    crate::log!("clipboard: copied ({label}); clears in {clear_after:?} s");

    if let Some(seconds) = clear_after {
        let app = app.clone();
        let _ = std::thread::Builder::new().name("coffer-clip-timer".into()).spawn(move || {
            std::thread::sleep(Duration::from_secs(u64::from(seconds)));
            clear(&app, Some(generation));
        });
    }
    Ok(CopyResult { clears_in_seconds: clear_after })
}

/// Clear the clipboard if it still holds Coffer's copy (lock, quit, sign-out).
pub fn clear_if_ours(app: &AppHandle) -> bool {
    clear(app, None)
}

/// With `Some(generation)`, act only if no later copy happened (timer path).
fn clear(app: &AppHandle, timer_generation: Option<u64>) -> bool {
    let state = app.state::<AppState>();
    let cleared = {
        let mut clip = state.clipboard.lck();
        if let Some(g) = timer_generation {
            if !timer_may_clear(&clip, g) {
                return false;
            }
        }
        let Some(seq) = clip.seq.take() else { return false };
        match crate::win::clipboard::clear_if_sequence(seq) {
            Ok(done) => done,
            Err(e) => {
                crate::log!("clipboard: clear failed: {e}");
                false
            }
        }
    };
    if cleared {
        let _ = app.emit(events::CLIPBOARD_CLEARED, Empty {});
        crate::log!("clipboard: cleared");
    }
    cleared
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clear_decision() {
        assert!(should_clear(Some(41), 41));
        assert!(!should_clear(Some(41), 42), "someone copied something after us");
        assert!(!should_clear(None, 41), "nothing of ours");
    }

    #[test]
    fn only_the_latest_timer_acts() {
        let s = ClipState { seq: Some(7), generation: 3 };
        assert!(timer_may_clear(&s, 3));
        assert!(!timer_may_clear(&s, 2));
        let s = ClipState { seq: None, generation: 3 };
        assert!(!timer_may_clear(&s, 3), "already cleared by lock");
    }
}
