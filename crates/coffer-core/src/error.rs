//! The one error type of the core. Each variant maps to one `ErrorCode` of
//! `src/lib/contract.ts`; [`CoreError::code`] gives that string and the
//! `Display` text is a plain sentence that is safe to show to the user.
//!
//! No message ever holds a secret value.

use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

/// Errors of `coffer-core`. Serialises as the contract's `CofferError`
/// (`{ "code": "...", "message": "..." }`).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CoreError {
    /// Wrong master password or wrong Secret Key. Never says which.
    #[error("The master password or the Secret Key is wrong.")]
    BadCredentials,
    /// The Secret Key text fails its format or its check symbol.
    #[error("{0}")]
    BadSecretKey(String),
    /// The manifest MAC or a record failed to verify.
    #[error("This vault file was changed outside Coffer.")]
    Tampered,
    /// The file is not a readable Coffer vault (or export).
    #[error("{0}")]
    Corrupt(String),
    /// The header asks for KDF settings under the floor.
    #[error("This vault file asks for key-derivation settings under Coffer's minimum, so Coffer did not open it.")]
    KdfTooWeak,
    /// The header asks for KDF settings over the ceiling (refused before Argon2 runs).
    #[error("This file asks for key-derivation settings above Coffer's limit (1 GiB memory, 10 passes, 16 lanes), so Coffer did not try to open it.")]
    KdfTooStrong,
    /// The file's generation is lower than the highest this PC has seen.
    #[error("This file is older than the last version this PC saw (generation {seen}, this file {file}).")]
    OlderFile {
        /// Highest generation this PC has seen.
        seen: u64,
        /// Generation of the file.
        file: u64,
    },
    /// The target file already exists.
    #[error("A file with that name already exists.")]
    Exists,
    /// No item (or entry) with that id.
    #[error("Coffer cannot find that item.")]
    NotFound,
    /// A stale base revision, or a file that changed on disk.
    #[error("{0}")]
    Conflict(String),
    /// The item needs the master password again (re-prompt).
    #[error("This item needs your master password.")]
    RepromptRequired,
    /// A new master password scores under 3.
    #[error("{0}")]
    WeakPassword(String),
    /// An import file Coffer cannot read.
    #[error("{0}")]
    UnsupportedFormat(String),
    /// Bad input from the caller.
    #[error("{0}")]
    Invalid(String),
    /// A read or write problem (zip archive, CSV reader).
    #[error("{0}")]
    Io(String),
}

impl CoreError {
    /// The contract `ErrorCode` string for this error.
    pub fn code(&self) -> &'static str {
        match self {
            CoreError::BadCredentials => "badCredentials",
            CoreError::BadSecretKey(_) => "badSecretKey",
            CoreError::Tampered => "tampered",
            CoreError::Corrupt(_) => "corrupt",
            CoreError::KdfTooWeak => "kdfTooWeak",
            CoreError::KdfTooStrong => "kdfTooStrong",
            CoreError::OlderFile { .. } => "olderFile",
            CoreError::Exists => "exists",
            CoreError::NotFound => "notFound",
            CoreError::Conflict(_) => "conflict",
            CoreError::RepromptRequired => "repromptRequired",
            CoreError::WeakPassword(_) => "weakPassword",
            CoreError::UnsupportedFormat(_) => "unsupportedFormat",
            CoreError::Invalid(_) => "invalid",
            CoreError::Io(_) => "io",
        }
    }

    pub(crate) fn corrupt(msg: impl Into<String>) -> Self {
        CoreError::Corrupt(msg.into())
    }

    pub(crate) fn invalid(msg: impl Into<String>) -> Self {
        CoreError::Invalid(msg.into())
    }
}

impl Serialize for CoreError {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("CofferError", 2)?;
        s.serialize_field("code", self.code())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

/// Result alias of the core.
pub type Result<T> = std::result::Result<T, CoreError>;
