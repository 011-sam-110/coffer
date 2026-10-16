//! `CofferError` of the contract: every command rejects with one of these.

use serde::{Deserialize, Serialize};

/// `ErrorCode` in `src/lib/contract.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    BadCredentials,
    NeedsSecretKey,
    BadSecretKey,
    VaultMissing,
    Tampered,
    Corrupt,
    KdfTooWeak,
    Locked,
    NotFound,
    Conflict,
    RepromptRequired,
    WeakPassword,
    UnsupportedFormat,
    Io,
    Invalid,
    HelloUnavailable,
    HelloFailed,
    Network,
    /// The file's generation is lower than this PC has seen.
    OlderFile,
    /// The header asks for KDF settings over the ceiling.
    KdfTooStrong,
    /// vault_create: that file already exists.
    Exists,
    /// vault_unlock_pin: no PIN can open the vault now (none set, removed, or the days ran out).
    PinUnavailable,
}

/// `CofferError` in the contract. `message` is a plain sentence, safe to show.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CofferError {
    pub code: ErrorCode,
    pub message: String,
}

pub type CofferResult<T> = Result<T, CofferError>;

impl CofferError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }

    pub fn locked() -> Self {
        Self::new(ErrorCode::Locked, "Unlock Coffer first.")
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Invalid, message)
    }

    pub fn io(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Io, message)
    }

    #[allow(dead_code)]
    pub fn network(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Network, message)
    }
}

impl std::fmt::Display for CofferError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for CofferError {}
