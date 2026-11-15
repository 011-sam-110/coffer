//! The browser bridge (docs/BRIDGE.md): the framing and the named pipe that
//! coffer-bridge.exe and Coffer share.
//!
//! Chrome and Edge start coffer-bridge.exe through native messaging: a 4-byte
//! little-endian length, then that many bytes of UTF-8 JSON, on stdin and
//! stdout. The bridge sends each message unchanged, in the same framing, over
//! a named pipe that only the current Windows user can open, to the Coffer
//! that runs from the same install folder.

pub mod frame;
pub mod pipe;

/// Chrome's limit for one message from a native host to the extension (1 MB).
/// The bridge and Coffer use it in both directions.
pub const MAX_MESSAGE: usize = 1024 * 1024;

/// The error codes the bridge itself answers with (docs/BRIDGE.md).
pub mod errors {
    /// No Coffer answers on the pipe, also after the bridge started one.
    pub const NOT_RUNNING: &str = "not_running";
    /// Something other than the Coffer in the bridge's own folder holds the pipe.
    pub const WRONG_SERVER: &str = "wrong_server";
    /// A message over 1 MB.
    pub const TOO_LARGE: &str = "too_large";
}

/// `{"id":<id>,"error":<code>,"message":<text>}`, with the id of `request`
/// when it has one (else null).
pub fn error_reply(request: Option<&[u8]>, code: &str, message: &str) -> Vec<u8> {
    let id = request.and_then(|r| serde_json::from_slice::<serde_json::Value>(r).ok()).and_then(|v| v.get("id").cloned()).unwrap_or(serde_json::Value::Null);
    serde_json::to_vec(&serde_json::json!({ "id": id, "error": code, "message": message })).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_reply_keeps_the_id() {
        let r = error_reply(Some(br#"{"id":7,"call":"hello"}"#), errors::NOT_RUNNING, "Coffer is not running.");
        let v: serde_json::Value = serde_json::from_slice(&r).unwrap();
        assert_eq!(v, serde_json::json!({ "id": 7, "error": "not_running", "message": "Coffer is not running." }));
        let r = error_reply(Some(b"not json"), errors::TOO_LARGE, "x");
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&r).unwrap()["id"], serde_json::Value::Null);
        let r = error_reply(None, errors::WRONG_SERVER, "x");
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&r).unwrap()["error"], "wrong_server");
    }
}
