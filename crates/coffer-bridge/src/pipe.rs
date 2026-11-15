//! The named pipe between coffer-bridge.exe and Coffer.
//!
//! Name: `\\.\pipe\coffer-bridge-<user SID>-<install key>`. The install key is
//! the first 16 hex digits of SHA-256 of the install folder (canonical, lower
//! case), so the bridge reaches only the Coffer in its own folder, and a QA
//! copy in another folder has a pipe of its own. The pipe's ACL lets only the
//! current Windows user connect, and no remote client.
//!
//! The bridge also checks the process that serves the pipe: its exe must be in
//! the bridge's own folder. A program that takes the name first gets nothing.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// The folder as one comparable string: no `\\?\` prefix, `\` separators,
/// lower case, no trailing `\`.
pub fn folder_key(folder: &Path) -> String {
    let s = folder.to_string_lossy().replace('/', "\\");
    let s = s.strip_prefix(r"\\?\").unwrap_or(&s);
    s.trim_end_matches('\\').to_lowercase()
}

/// `\\.\pipe\coffer-bridge-<sid>-<16 hex>`.
pub fn pipe_name(sid: &str, folder: &Path) -> String {
    let hash = Sha256::digest(folder_key(folder).as_bytes());
    let hex: String = hash.iter().take(8).map(|b| format!("{b:02x}")).collect();
    format!(r"\\.\pipe\coffer-bridge-{sid}-{hex}")
}

/// Whether `exe` is a file directly in `folder`.
pub fn exe_in_folder(exe: &Path, folder: &Path) -> bool {
    exe.parent().is_some_and(|p| folder_key(p) == folder_key(folder))
}

/// The canonical folder of the running exe (coffer.exe or coffer-bridge.exe).
pub fn own_folder() -> std::io::Result<PathBuf> {
    let exe = std::env::current_exe()?;
    let exe = std::fs::canonicalize(&exe).unwrap_or(exe);
    exe.parent().map(Path::to_path_buf).ok_or_else(|| std::io::Error::other("the exe has no folder"))
}

#[cfg(windows)]
pub use win::*;

#[cfg(windows)]
mod win {
    use std::io;
    use std::os::windows::io::RawHandle;
    use std::path::PathBuf;

    use windows::Win32::Foundation::{CloseHandle, HANDLE, HLOCAL, LocalFree};
    use windows::Win32::Security::Authorization::{ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW};
    use windows::Win32::Security::{GetTokenInformation, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser};
    use windows::Win32::System::Pipes::{GetNamedPipeClientProcessId, GetNamedPipeServerProcessId};
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW};
    use windows::core::{PCWSTR, PWSTR};

    fn err(e: windows::core::Error) -> io::Error {
        io::Error::other(e.to_string())
    }

    /// The current user's SID as text (`S-1-5-21-...`).
    pub fn current_user_sid() -> io::Result<String> {
        unsafe {
            let mut token = HANDLE::default();
            OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).map_err(err)?;
            let mut len = 0u32;
            let _ = GetTokenInformation(token, TokenUser, None, 0, &mut len);
            // u64 storage keeps TOKEN_USER aligned.
            let mut buf = vec![0u64; (len as usize).div_ceil(8).max(1)];
            let got = GetTokenInformation(token, TokenUser, Some(buf.as_mut_ptr().cast()), len, &mut len);
            let _ = CloseHandle(token);
            got.map_err(err)?;
            let user = &*(buf.as_ptr() as *const TOKEN_USER);
            let mut text = PWSTR::null();
            ConvertSidToStringSidW(user.User.Sid, &mut text).map_err(err)?;
            let sid = text.to_string().map_err(|e| io::Error::other(e.to_string()));
            let _ = LocalFree(Some(HLOCAL(text.0.cast())));
            sid
        }
    }

    /// A security descriptor that gives the user `sid` full access and no one
    /// else any (`D:P(A;;GA;;;<sid>)`: protected, so nothing is inherited).
    pub struct PipeSecurity {
        sd: PSECURITY_DESCRIPTOR,
        attrs: Box<SECURITY_ATTRIBUTES>,
    }

    // The descriptor is read-only after creation; Coffer's server task holds it.
    unsafe impl Send for PipeSecurity {}
    unsafe impl Sync for PipeSecurity {}

    impl PipeSecurity {
        pub fn for_user(sid: &str) -> io::Result<Self> {
            if !sid.starts_with("S-1-") || !sid.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
                return Err(io::Error::other("not a SID"));
            }
            let sddl: Vec<u16> = format!("D:P(A;;GA;;;{sid})").encode_utf16().chain(std::iter::once(0)).collect();
            let mut sd = PSECURITY_DESCRIPTOR::default();
            unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(PCWSTR(sddl.as_ptr()), 1, &mut sd, None).map_err(err)? };
            let attrs = Box::new(SECURITY_ATTRIBUTES { nLength: size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: sd.0, bInheritHandle: false.into() });
            Ok(Self { sd, attrs })
        }

        /// For `ServerOptions::create_with_security_attributes_raw`.
        pub fn as_ptr(&self) -> *mut core::ffi::c_void {
            (&*self.attrs as *const SECURITY_ATTRIBUTES).cast_mut().cast()
        }
    }

    impl Drop for PipeSecurity {
        fn drop(&mut self) {
            unsafe {
                let _ = LocalFree(Some(HLOCAL(self.sd.0)));
            }
        }
    }

    /// The full path of a process's exe.
    pub fn process_path(pid: u32) -> io::Result<PathBuf> {
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).map_err(err)?;
            let mut buf = vec![0u16; 32_768];
            let mut len = buf.len() as u32;
            let got = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len);
            let _ = CloseHandle(process);
            got.map_err(err)?;
            Ok(PathBuf::from(String::from_utf16_lossy(&buf[..len as usize])))
        }
    }

    /// The exe of the process that serves the pipe at `handle` (client side).
    pub fn server_exe(handle: RawHandle) -> io::Result<PathBuf> {
        let mut pid = 0u32;
        unsafe { GetNamedPipeServerProcessId(HANDLE(handle), &mut pid).map_err(err)? };
        process_path(pid)
    }

    /// The exe of the client at `handle` (server side; for the log only).
    pub fn client_exe(handle: RawHandle) -> io::Result<PathBuf> {
        let mut pid = 0u32;
        unsafe { GetNamedPipeClientProcessId(HANDLE(handle), &mut pid).map_err(err)? };
        process_path(pid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_name_depends_on_user_and_folder_only() {
        let a = pipe_name("S-1-5-21-1-2-3-1001", Path::new(r"C:\Users\sam\AppData\Local\Coffer"));
        assert!(a.starts_with(r"\\.\pipe\coffer-bridge-S-1-5-21-1-2-3-1001-"));
        assert_eq!(a.len(), r"\\.\pipe\coffer-bridge-S-1-5-21-1-2-3-1001-".len() + 16);
        // Same folder written another way: same name.
        assert_eq!(a, pipe_name("S-1-5-21-1-2-3-1001", Path::new(r"\\?\c:\users\SAM\appdata\local\coffer\")));
        assert_eq!(a, pipe_name("S-1-5-21-1-2-3-1001", Path::new("C:/Users/sam/AppData/Local/Coffer")));
        // Another folder (a QA copy) or another user: another name.
        assert_ne!(a, pipe_name("S-1-5-21-1-2-3-1001", Path::new(r"C:\Users\sam\AppData\Local\CofferQA3")));
        assert_ne!(a, pipe_name("S-1-5-21-1-2-3-1002", Path::new(r"C:\Users\sam\AppData\Local\Coffer")));
    }

    #[test]
    fn exe_in_folder_compares_the_parent() {
        let folder = Path::new(r"C:\Users\sam\AppData\Local\Coffer");
        assert!(exe_in_folder(Path::new(r"C:\Users\sam\AppData\Local\Coffer\coffer.exe"), folder));
        assert!(exe_in_folder(Path::new(r"\\?\C:\USERS\sam\AppData\Local\Coffer\coffer.exe"), folder));
        assert!(!exe_in_folder(Path::new(r"C:\Users\sam\AppData\Local\Temp\coffer.exe"), folder));
        assert!(!exe_in_folder(Path::new(r"C:\Users\sam\AppData\Local\Coffer\sub\coffer.exe"), folder));
    }

    #[cfg(windows)]
    #[test]
    fn the_user_sid_and_the_acl() {
        let sid = current_user_sid().unwrap();
        assert!(sid.starts_with("S-1-"), "{sid}");
        assert!(PipeSecurity::for_user(&sid).is_ok());
        assert!(PipeSecurity::for_user("S-1-5-21)(A;;GA;;;WD").is_err(), "no SDDL injection");
        let me = process_path(std::process::id()).unwrap();
        assert_eq!(folder_key(&me), folder_key(&std::env::current_exe().unwrap()));
    }
}
