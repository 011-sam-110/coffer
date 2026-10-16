//! `MoveFileExW` for the vault's atomic write (SPEC 3.5).

use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use windows::Win32::Storage::FileSystem::{MOVE_FILE_FLAGS, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW};
use windows::core::PCWSTR;

fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
}

/// Move `from` to `to` with `MOVEFILE_WRITE_THROUGH`; with `replace`, also
/// `MOVEFILE_REPLACE_EXISTING` (without it the move fails when `to` exists).
pub fn move_file(from: &Path, to: &Path, replace: bool) -> std::io::Result<()> {
    let (f, t) = (wide(from), wide(to));
    let flags = MOVEFILE_WRITE_THROUGH | if replace { MOVEFILE_REPLACE_EXISTING } else { MOVE_FILE_FLAGS(0) };
    unsafe { MoveFileExW(PCWSTR(f.as_ptr()), PCWSTR(t.as_ptr()), flags) }.map_err(|e| std::io::Error::from_raw_os_error(e.code().0 & 0xFFFF))
}

/// A sync tool or a scanner holds the file for a moment: worth a retry.
pub fn is_transient(e: &std::io::Error) -> bool {
    // ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION
    matches!(e.raw_os_error(), Some(5 | 32 | 33))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replace_and_no_replace() {
        let dir = std::env::temp_dir().join(format!("coffer-fs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (a, b, c) = (dir.join("a"), dir.join("b"), dir.join("c"));
        std::fs::write(&a, b"one").unwrap();
        std::fs::write(&b, b"two").unwrap();
        let err = move_file(&a, &b, false).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
        move_file(&a, &b, true).unwrap();
        assert_eq!(std::fs::read(&b).unwrap(), b"one");
        assert!(!a.exists());
        move_file(&b, &c, false).unwrap();
        assert_eq!(std::fs::read(&c).unwrap(), b"one");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
