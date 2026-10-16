//! Coffer vault core. No Tauri and no Windows dependency: everything here is
//! plain Rust so it can be unit tested on any machine.
//!
//! Start at [`session::Vault`] (an unlocked vault) and [`secret_key::SecretKey`].
//! The shell owns files, DPAPI, the clipboard, dialogs and the network; this
//! crate turns bytes into an unlocked vault and back, and holds every secret
//! in zeroize-on-drop types.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod backups;
pub mod breach;
pub mod crypto;
pub mod encoding;
pub mod error;
pub mod export;
pub mod generator;
pub mod health;
pub mod import;
pub mod model;
pub mod secret_key;
pub mod session;
pub mod strength;
pub mod suggest;
pub mod templates;
pub mod time_util;
pub mod totp;
pub mod vault_file;

pub use crypto::KdfParams;
pub use error::{CoreError, Result};
pub use secret_key::SecretKey;
pub use session::Vault;
