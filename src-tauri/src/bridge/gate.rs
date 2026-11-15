//! The message gate (docs/BRIDGE.md): every message from the pipe comes here.
//!
//! Three calls go without a MAC: `hello` (versions, and this connection's
//! nonce), `pair` and `pair_result`. Every other call is signed: the envelope
//! holds the client id, the body as JSON text and
//! HMAC-SHA256(bridge key, `coffer/v1/req` || 0x00 || client id || 0x00 || body).
//! The body names this connection's nonce and a sequence number that only
//! goes up, so a call cannot be sent twice or on another connection. Coffer
//! signs its answer the same way with `coffer/v1/res`. A missing, wrong or
//! replayed MAC is refused, and nothing runs.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use ring::hmac;
use serde_json::{Value, json};
use tokio::sync::watch;

use super::pairing::{self, Key};
use super::store::BrowserStore;
use crate::contract::{BrowserKind, PairRequest};
use crate::error::{CofferError, CofferResult, ErrorCode};
use crate::state::LockExt;

pub const PROTOCOL: u32 = 1;
const REQ_LABEL: &[u8] = b"coffer/v1/req";
const RES_LABEL: &[u8] = b"coffer/v1/res";
/// How long the Connect prompt waits for Allow or Deny.
pub const PAIR_TIMEOUT: Duration = Duration::from_secs(120);

/// Calls that read or write the vault (M4 and M5, docs/BRIDGE.md). A locked
/// Coffer answers each with `locked`.
pub const VAULT_CALLS: &[&str] = &["list_logins", "get_login", "copy_totp", "find_login", "save_login", "update_password", "never_for_site"];

/// What the gate needs from the app.
pub trait Host {
    fn version(&self) -> String;
    fn locked(&self) -> bool;
    /// "Offer to save new logins", "Offer to update changed passwords".
    fn offers(&self) -> (bool, bool);
    /// Show Coffer's unlock (the main window on its lock screen).
    fn open_unlock(&self);
    /// The browsers or the prompt changed. `show`: a new prompt, bring the window up.
    fn changed(&self, show: bool);
    fn now_iso(&self) -> String;
}

/// One pipe connection (one bridge process, one extension port).
pub struct Conn {
    pub id: u64,
    nonce: [u8; 16],
    last_seq: u64,
    browser: BrowserKind,
}

impl Conn {
    pub fn new(id: u64) -> Self {
        Self { id, nonce: coffer_core::crypto::random_array(), last_seq: 0, browser: BrowserKind::Other }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairEnd {
    Waiting,
    Allowed { confirm: String },
    Denied,
    Timeout,
    /// The connection closed, or storing the key failed.
    Gone,
}

struct Pending {
    id: String,
    conn: u64,
    client: String,
    browser: BrowserKind,
    words: [String; 4],
    key: Key,
    confirm: String,
    deadline: Instant,
    expires_at: String,
    tx: watch::Sender<PairEnd>,
}

#[derive(Default)]
struct PairSlot {
    pending: Option<Pending>,
    /// The last pairing that ended: (pair id, connection, end), for a
    /// `pair_result` that comes after the answer.
    finished: Option<(String, u64, PairEnd)>,
}

/// What the server does with a message.
pub enum Outcome {
    Reply(String),
    /// A new Connect prompt: send the reply, and expire `pair_id` after the timeout.
    PairStarted { reply: String, pair_id: String },
    /// `pair_result`: wait for Allow, Deny or the timeout, then send `PairWait::reply`.
    Wait(PairWait),
}

pub struct PairWait {
    pub id: Value,
    pub rx: watch::Receiver<PairEnd>,
    pub deadline: Instant,
}

impl PairWait {
    pub fn reply(&self, end: &PairEnd) -> String {
        end_reply(self.id.clone(), end)
    }
}

pub struct Core {
    pub store: BrowserStore,
    slot: Mutex<PairSlot>,
    pub timeout: Duration,
}

fn ok(id: Value, result: Value) -> String {
    json!({ "id": id, "ok": true, "result": result }).to_string()
}

fn err(id: Value, code: &str, message: &str) -> String {
    json!({ "id": id, "error": code, "message": message }).to_string()
}

fn end_reply(id: Value, end: &PairEnd) -> String {
    match end {
        PairEnd::Allowed { confirm } => ok(id, json!({ "paired": true, "confirm": confirm })),
        PairEnd::Denied => err(id, "denied", "You clicked Deny in Coffer."),
        PairEnd::Timeout | PairEnd::Waiting => err(id, "timeout", "Coffer got no answer within 2 minutes."),
        PairEnd::Gone => err(id, "timeout", "The Connect prompt closed."),
    }
}

fn mac_input(label: &[u8], client: &str, body: &str) -> Vec<u8> {
    let mut data = Vec::with_capacity(label.len() + client.len() + body.len() + 2);
    data.extend_from_slice(label);
    data.push(0);
    data.extend_from_slice(client.as_bytes());
    data.push(0);
    data.extend_from_slice(body.as_bytes());
    data
}

/// base64 MAC of a request (`req`) or a response (`res`) body.
pub fn sign(key: &[u8; 32], request: bool, client: &str, body: &str) -> String {
    let label = if request { REQ_LABEL } else { RES_LABEL };
    STANDARD.encode(hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, key), &mac_input(label, client, body)))
}

/// Constant-time check of a base64 MAC.
pub fn verify(key: &[u8; 32], request: bool, client: &str, body: &str, mac: &str) -> bool {
    let label = if request { REQ_LABEL } else { RES_LABEL };
    let Ok(tag) = STANDARD.decode(mac) else { return false };
    hmac::verify(&hmac::Key::new(hmac::HMAC_SHA256, key), &mac_input(label, client, body), &tag).is_ok()
}

impl Core {
    pub fn new(store: BrowserStore) -> Self {
        Self { store, slot: Mutex::new(PairSlot::default()), timeout: PAIR_TIMEOUT }
    }

    /// The open Connect prompt, for the main window.
    pub fn pending_request(&self) -> Option<PairRequest> {
        self.slot.lck().pending.as_ref().map(|p| PairRequest {
            pair_id: p.id.clone(),
            browser: p.browser,
            name: p.browser.name().to_string(),
            words: p.words.to_vec(),
            expires_at: p.expires_at.clone(),
        })
    }

    pub fn handle(&self, host: &dyn Host, conn: &mut Conn, raw: &[u8]) -> Outcome {
        let Ok(v) = serde_json::from_slice::<Value>(raw) else {
            return Outcome::Reply(err(Value::Null, "bad_request", "The message is not JSON."));
        };
        let id = v.get("id").cloned().unwrap_or(Value::Null);
        if ["client", "body", "mac"].iter().any(|k| v.get(*k).is_some()) {
            return Outcome::Reply(self.signed(host, conn, id, &v));
        }
        let args = v.get("args").cloned().unwrap_or_else(|| json!({}));
        match v.get("call").and_then(Value::as_str).unwrap_or("") {
            "hello" => Outcome::Reply(self.hello(host, conn, id, &args)),
            "pair" => self.pair(host, conn, id, &args),
            "pair_result" => self.pair_result(conn, id, &args),
            "" => Outcome::Reply(err(id, "bad_request", "The message names no call.")),
            _ => Outcome::Reply(err(id, "bad_mac", "This call needs a MAC: connect the browser first.")),
        }
    }

    fn hello(&self, host: &dyn Host, conn: &mut Conn, id: Value, args: &Value) -> String {
        conn.browser = BrowserKind::parse(args.get("browser").and_then(Value::as_str).unwrap_or(""));
        let paired = args.get("client").and_then(Value::as_str).is_some_and(|c| self.store.has(c));
        ok(id, json!({ "protocol": PROTOCOL, "version": host.version(), "paired": paired, "locked": host.locked(), "nonce": STANDARD.encode(conn.nonce) }))
    }

    fn pair(&self, host: &dyn Host, conn: &mut Conn, id: Value, args: &Value) -> Outcome {
        let ext_pub: Option<[u8; 32]> = args.get("pub").and_then(Value::as_str).and_then(|s| STANDARD.decode(s).ok()).and_then(|b| b.try_into().ok());
        let Some(ext_pub) = ext_pub else {
            return Outcome::Reply(err(id, "bad_request", "pair needs pub: an X25519 public key, 32 bytes in base64."));
        };
        if let Some(b) = args.get("browser").and_then(Value::as_str) {
            conn.browser = BrowserKind::parse(b);
        }
        let Ok((coffer_pub, shared)) = pairing::agree(&ext_pub) else {
            return Outcome::Reply(err(id, "bad_request", "That public key gives no usable secret."));
        };
        let mut slot = self.slot.lck();
        if slot.pending.as_ref().is_some_and(|p| Instant::now() < p.deadline) {
            return Outcome::Reply(err(id, "busy", "Coffer already shows a Connect prompt. Answer it first."));
        }
        if let Some(stale) = slot.pending.take() {
            let _ = stale.tx.send(PairEnd::Timeout);
        }
        let client_bytes: [u8; 16] = coffer_core::crypto::random_array();
        let client = pairing::hex(&client_bytes);
        let t = pairing::transcript(&ext_pub, &coffer_pub, &client_bytes);
        let key = pairing::bridge_key(&shared[..], &t);
        let confirm = pairing::confirm(&key, &t);
        let pair_id = pairing::hex(&coffer_core::crypto::random_array::<8>());
        let deadline = Instant::now() + self.timeout;
        let expires_at = crate::clock::iso_from_unix(crate::pin::now_secs() as i64 + self.timeout.as_secs() as i64);
        let (tx, _) = watch::channel(PairEnd::Waiting);
        slot.pending = Some(Pending { id: pair_id.clone(), conn: conn.id, client: client.clone(), browser: conn.browser, words: pairing::words(&t), key, confirm, deadline, expires_at, tx });
        slot.finished = None;
        drop(slot);
        crate::log!("bridge: Connect prompt for {}", conn.browser.name());
        host.changed(true);
        Outcome::PairStarted { reply: ok(id, json!({ "pairId": pair_id, "pub": STANDARD.encode(coffer_pub), "client": client })), pair_id }
    }

    fn pair_result(&self, conn: &Conn, id: Value, args: &Value) -> Outcome {
        let pair_id = args.get("pairId").and_then(Value::as_str).unwrap_or("");
        let slot = self.slot.lck();
        if let Some(p) = slot.pending.as_ref().filter(|p| p.id == pair_id && p.conn == conn.id) {
            return Outcome::Wait(PairWait { id, rx: p.tx.subscribe(), deadline: p.deadline + Duration::from_secs(2) });
        }
        if let Some((_, _, end)) = slot.finished.as_ref().filter(|(f, c, _)| f == pair_id && *c == conn.id) {
            return Outcome::Reply(end_reply(id, end));
        }
        Outcome::Reply(err(id, "not_found", "No Connect request with that id is open on this connection."))
    }

    /// Allow or Deny from the Connect prompt. Allow stores the key; Deny stores nothing.
    pub fn answer(&self, host: &dyn Host, pair_id: &str, allow: bool) -> CofferResult<()> {
        let mut slot = self.slot.lck();
        let Some(p) = slot.pending.take_if(|p| p.id == pair_id) else {
            return Err(CofferError::new(ErrorCode::NotFound, "This Connect request is no longer open."));
        };
        let (end, result) = if allow {
            match self.store.add(&p.client, p.browser, &p.key, &host.now_iso()) {
                Ok(()) => (PairEnd::Allowed { confirm: p.confirm.clone() }, Ok(())),
                Err(e) => (PairEnd::Gone, Err(e)),
            }
        } else {
            (PairEnd::Denied, Ok(()))
        };
        crate::log!("bridge: Connect {} for {}", if matches!(end, PairEnd::Allowed { .. }) { "allowed" } else { "not allowed" }, p.browser.name());
        let _ = p.tx.send(end.clone());
        slot.finished = Some((p.id, p.conn, end));
        drop(slot);
        host.changed(false);
        result
    }

    /// The prompt's 2 minutes ran out: close it, store nothing.
    pub fn expire(&self, host: &dyn Host, pair_id: &str) {
        let mut slot = self.slot.lck();
        let Some(p) = slot.pending.take_if(|p| p.id == pair_id) else { return };
        crate::log!("bridge: Connect prompt timed out");
        let _ = p.tx.send(PairEnd::Timeout);
        slot.finished = Some((p.id, p.conn, PairEnd::Timeout));
        drop(slot);
        host.changed(false);
    }

    /// A connection closed: its open prompt closes too, storing nothing.
    pub fn conn_closed(&self, host: &dyn Host, conn_id: u64) {
        let mut slot = self.slot.lck();
        if slot.finished.as_ref().is_some_and(|(_, c, _)| *c == conn_id) {
            slot.finished = None;
        }
        let Some(p) = slot.pending.take_if(|p| p.conn == conn_id) else { return };
        let _ = p.tx.send(PairEnd::Gone);
        drop(slot);
        host.changed(false);
    }

    /// Delete a browser's key (Settings, Browsers, Disconnect).
    pub fn disconnect(&self, host: &dyn Host, id: &str) -> CofferResult<()> {
        if !self.store.remove(id)? {
            return Err(CofferError::new(ErrorCode::NotFound, "That browser is not connected."));
        }
        crate::log!("bridge: a browser was disconnected in Settings");
        host.changed(false);
        Ok(())
    }

    fn signed(&self, host: &dyn Host, conn: &mut Conn, id: Value, v: &Value) -> String {
        let (Some(client), Some(body), Some(mac)) = (v.get("client").and_then(Value::as_str), v.get("body").and_then(Value::as_str), v.get("mac").and_then(Value::as_str)) else {
            return err(id, "bad_mac", "A signed call needs client, body and mac.");
        };
        let Some(key) = self.store.key(client) else {
            return err(id, "not_paired", "This browser is not connected to Coffer. Connect it again.");
        };
        if !verify(&key, true, client, body, mac) {
            crate::log!("bridge: refused a call with a wrong MAC");
            return err(id, "bad_mac", "The call's MAC is wrong.");
        }
        let Ok(b) = serde_json::from_str::<Value>(body) else {
            return err(id, "bad_request", "The body is not JSON.");
        };
        let nonce = STANDARD.encode(conn.nonce);
        let fresh = b.get("nonce").and_then(Value::as_str) == Some(nonce.as_str());
        let seq = match b.get("seq").and_then(Value::as_u64) {
            Some(s) if fresh && s > conn.last_seq => s,
            _ => {
                crate::log!("bridge: refused a replayed call");
                return err(id, "replay", "Coffer saw this call before, or it belongs to another connection. Say hello again.");
            }
        };
        conn.last_seq = seq;
        self.store.touch(client, &host.now_iso());
        let call = b.get("call").and_then(Value::as_str).unwrap_or("");
        let args = b.get("args").cloned().unwrap_or_else(|| json!({}));
        let answer = match self.dispatch(host, client, call, &args) {
            Ok(result) => json!({ "seq": seq, "nonce": nonce, "ok": true, "result": result }),
            Err((code, message)) => json!({ "seq": seq, "nonce": nonce, "error": code, "message": message }),
        }
        .to_string();
        let mac = sign(&key, false, client, &answer);
        json!({ "id": id, "body": answer, "mac": mac }).to_string()
    }

    fn dispatch(&self, host: &dyn Host, client: &str, call: &str, _args: &Value) -> Result<Value, (&'static str, String)> {
        let status = || {
            let (save, update) = host.offers();
            json!({ "version": host.version(), "locked": host.locked(), "offerSave": save, "offerUpdate": update })
        };
        match call {
            "status" => Ok(status()),
            "unlock" => {
                if host.locked() {
                    host.open_unlock();
                }
                Ok(status())
            }
            "disconnect" => {
                let _ = self.store.remove(client);
                crate::log!("bridge: a browser disconnected itself");
                host.changed(false);
                Ok(json!({ "disconnected": true }))
            }
            c if VAULT_CALLS.contains(&c) => {
                if host.locked() {
                    Err(("locked", "Coffer is locked. Unlock it first.".into()))
                } else {
                    Err(("unknown_call", format!("Coffer {} does not answer {c} yet.", host.version())))
                }
            }
            _ => Err(("unknown_call", format!("Coffer does not know the call \"{call}\"."))),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use ring::agreement;

    use super::*;

    #[derive(Default)]
    struct TestHost {
        locked: AtomicBool,
        unlock_shown: AtomicUsize,
        changes: AtomicUsize,
        shows: AtomicUsize,
    }

    impl Host for TestHost {
        fn version(&self) -> String {
            "0.3.0".into()
        }
        fn locked(&self) -> bool {
            self.locked.load(Ordering::SeqCst)
        }
        fn offers(&self) -> (bool, bool) {
            (true, false)
        }
        fn open_unlock(&self) {
            self.unlock_shown.fetch_add(1, Ordering::SeqCst);
        }
        fn changed(&self, show: bool) {
            self.changes.fetch_add(1, Ordering::SeqCst);
            if show {
                self.shows.fetch_add(1, Ordering::SeqCst);
            }
        }
        fn now_iso(&self) -> String {
            "2026-11-15T12:00:00Z".into()
        }
    }

    fn core(name: &str) -> (Core, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("coffer-gate-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        (Core::new(BrowserStore::new(&dir)), dir)
    }

    fn reply(o: Outcome) -> Value {
        match o {
            Outcome::Reply(s) | Outcome::PairStarted { reply: s, .. } => serde_json::from_str(&s).unwrap(),
            Outcome::Wait(_) => panic!("a wait, not a reply"),
        }
    }

    fn msg(v: Value) -> Vec<u8> {
        v.to_string().into_bytes()
    }

    /// The extension's side of a pairing, with ring's X25519: (client, key, words, pair id).
    fn start_pair(core: &Core, host: &TestHost, conn: &mut Conn) -> (String, Key, [String; 4], String) {
        let rng = ring::rand::SystemRandom::new();
        let private = agreement::EphemeralPrivateKey::generate(&agreement::X25519, &rng).unwrap();
        let ext_pub: [u8; 32] = private.compute_public_key().unwrap().as_ref().try_into().unwrap();
        let o = core.handle(host, conn, &msg(json!({ "id": 2, "call": "pair", "args": { "pub": STANDARD.encode(ext_pub), "browser": "chrome" } })));
        let pair_id = match &o {
            Outcome::PairStarted { pair_id, .. } => pair_id.clone(),
            _ => panic!("no prompt"),
        };
        let r = reply(o);
        let coffer_pub: [u8; 32] = STANDARD.decode(r["result"]["pub"].as_str().unwrap()).unwrap().try_into().unwrap();
        let client = r["result"]["client"].as_str().unwrap().to_string();
        let client_bytes: [u8; 16] = (0..16).map(|i| u8::from_str_radix(&client[2 * i..2 * i + 2], 16).unwrap()).collect::<Vec<_>>().try_into().unwrap();
        let shared = agreement::agree_ephemeral(private, &agreement::UnparsedPublicKey::new(&agreement::X25519, coffer_pub), |s| s.to_vec()).unwrap();
        let t = pairing::transcript(&ext_pub, &coffer_pub, &client_bytes);
        (client, pairing::bridge_key(&shared, &t), pairing::words(&t), pair_id)
    }

    fn hello(core: &Core, host: &TestHost, conn: &mut Conn, client: Option<&str>) -> Value {
        reply(core.handle(host, conn, &msg(json!({ "id": 1, "call": "hello", "args": { "version": "0.3.0", "browser": "chrome", "client": client } }))))
    }

    fn signed(key: &[u8; 32], client: &str, nonce: &str, seq: u64, call: &str) -> Value {
        let body = json!({ "call": call, "args": {}, "nonce": nonce, "seq": seq }).to_string();
        json!({ "id": 10 + seq, "client": client, "body": body, "mac": sign(key, true, client, &body) })
    }

    /// Unwrap a signed reply after checking Coffer's MAC.
    fn open_signed(key: &[u8; 32], client: &str, r: &Value) -> Value {
        let body = r["body"].as_str().unwrap_or_else(|| panic!("not signed: {r}"));
        assert!(verify(key, false, client, body, r["mac"].as_str().unwrap()), "Coffer's MAC");
        serde_json::from_str(body).unwrap()
    }

    fn paired(name: &str) -> (Core, std::path::PathBuf, TestHost, Conn, String, Key, String) {
        let (core, dir) = core(name);
        let host = TestHost::default();
        let mut conn = Conn::new(1);
        let (client, key, words, pair_id) = start_pair(&core, &host, &mut conn);
        assert_eq!(core.pending_request().unwrap().words, words.to_vec(), "Coffer's prompt shows the extension's words");
        core.answer(&host, &pair_id, true).unwrap();
        let nonce = hello(&core, &host, &mut conn, Some(&client))["result"]["nonce"].as_str().unwrap().to_string();
        (core, dir, host, conn, client, key, nonce)
    }

    #[test]
    fn hello_says_versions_and_lock_state() {
        let (core, dir) = core("hello");
        let host = TestHost::default();
        host.locked.store(true, Ordering::SeqCst);
        let mut conn = Conn::new(1);
        let r = hello(&core, &host, &mut conn, None);
        assert_eq!(r["id"], 1);
        assert_eq!(r["result"]["version"], "0.3.0");
        assert_eq!(r["result"]["paired"], false);
        assert_eq!(r["result"]["locked"], true);
        assert_eq!(r["result"]["protocol"], 1);
        assert_eq!(STANDARD.decode(r["result"]["nonce"].as_str().unwrap()).unwrap().len(), 16);
        // Another connection, another nonce.
        assert_ne!(r["result"]["nonce"], hello(&core, &host, &mut Conn::new(2), None)["result"]["nonce"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn allow_stores_the_key_and_signed_calls_work() {
        let (core, dir, host, mut conn, client, key, nonce) = paired("allow");
        assert_eq!(host.shows.load(Ordering::SeqCst), 1, "the prompt brought Coffer up once");
        assert_eq!(*core.store.key(&client).unwrap(), *key, "both sides hold the same key");
        assert!(core.pending_request().is_none());
        // pair_result after the answer still says Allowed, with a confirm the extension can check.
        let r = reply(core.pair_result(&conn, json!(3), &json!({ "pairId": core.slot.lck().finished.as_ref().unwrap().0.clone() })));
        assert_eq!(r["result"]["paired"], true);
        let s = open_signed(&key, &client, &reply(core.handle(&host, &mut conn, &msg(signed(&key, &client, &nonce, 1, "status")))));
        assert_eq!(s["ok"], true);
        assert_eq!(s["seq"], 1);
        assert_eq!(s["result"], json!({ "version": "0.3.0", "locked": false, "offerSave": true, "offerUpdate": false }));
        assert_eq!(hello(&core, &host, &mut Conn::new(5), Some(&client))["result"]["paired"], true);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_wrong_or_missing_mac_is_refused() {
        let (core, dir, host, mut conn, client, key, nonce) = paired("mac");
        let mut m = signed(&key, &client, &nonce, 1, "unlock");
        m["mac"] = json!(sign(&[1u8; 32], true, &client, m["body"].as_str().unwrap()));
        let r = reply(core.handle(&host, &mut conn, &msg(m)));
        assert_eq!(r["error"], "bad_mac");
        assert!(r.get("body").is_none(), "nothing ran, nothing signed");
        // A body changed after signing.
        let mut m = signed(&key, &client, &nonce, 2, "status");
        m["body"] = json!(m["body"].as_str().unwrap().replace("status", "unlock"));
        assert_eq!(reply(core.handle(&host, &mut conn, &msg(m)))["error"], "bad_mac");
        // No MAC at all, and a vault call without a MAC.
        let mut m = signed(&key, &client, &nonce, 3, "status");
        m.as_object_mut().unwrap().remove("mac");
        assert_eq!(reply(core.handle(&host, &mut conn, &msg(m)))["error"], "bad_mac");
        assert_eq!(reply(core.handle(&host, &mut conn, &msg(json!({ "id": 4, "call": "list_logins", "args": { "site": "example.com" } }))))["error"], "bad_mac");
        // An unknown client.
        let other = "0123456789abcdef0123456789abcdef";
        assert_eq!(reply(core.handle(&host, &mut conn, &msg(signed(&key, other, &nonce, 4, "status"))))["error"], "not_paired");
        assert_eq!(host.unlock_shown.load(Ordering::SeqCst), 0, "unlock never ran");
        // The right MAC still works after all that.
        assert_eq!(open_signed(&key, &client, &reply(core.handle(&host, &mut conn, &msg(signed(&key, &client, &nonce, 5, "status")))))["ok"], true);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_replayed_call_is_refused() {
        let (core, dir, host, mut conn, client, key, nonce) = paired("replay");
        let first = msg(signed(&key, &client, &nonce, 7, "status"));
        assert!(reply(core.handle(&host, &mut conn, &first)).get("body").is_some());
        // The same bytes again, and an older number.
        assert_eq!(reply(core.handle(&host, &mut conn, &first))["error"], "replay");
        assert_eq!(reply(core.handle(&host, &mut conn, &msg(signed(&key, &client, &nonce, 6, "status"))))["error"], "replay");
        // The same call on another connection (another nonce).
        let mut other = Conn::new(9);
        hello(&core, &host, &mut other, Some(&client));
        assert_eq!(reply(core.handle(&host, &mut other, &first))["error"], "replay");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_locked_vault_answers_locked() {
        let (core, dir, host, mut conn, client, key, nonce) = paired("locked");
        host.locked.store(true, Ordering::SeqCst);
        let s = open_signed(&key, &client, &reply(core.handle(&host, &mut conn, &msg(signed(&key, &client, &nonce, 1, "status")))));
        assert_eq!(s["result"]["locked"], true);
        for (i, call) in VAULT_CALLS.iter().enumerate() {
            let s = open_signed(&key, &client, &reply(core.handle(&host, &mut conn, &msg(signed(&key, &client, &nonce, 2 + i as u64, call)))));
            assert_eq!(s["error"], "locked", "{call}");
        }
        // unlock opens Coffer's own unlock: no password crosses the pipe.
        let s = open_signed(&key, &client, &reply(core.handle(&host, &mut conn, &msg(signed(&key, &client, &nonce, 20, "unlock")))));
        assert_eq!((s["ok"].clone(), host.unlock_shown.load(Ordering::SeqCst)), (json!(true), 1));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn deny_and_timeout_store_nothing() {
        let (core, dir) = core("deny");
        let host = TestHost::default();
        let mut conn = Conn::new(1);
        let (client, _, _, pair_id) = start_pair(&core, &host, &mut conn);
        // A second request while the prompt is open is refused.
        let rng = ring::rand::SystemRandom::new();
        let k = agreement::EphemeralPrivateKey::generate(&agreement::X25519, &rng).unwrap();
        let p = STANDARD.encode(k.compute_public_key().unwrap().as_ref());
        assert_eq!(reply(core.handle(&host, &mut Conn::new(2), &msg(json!({ "id": 2, "call": "pair", "args": { "pub": p } }))))["error"], "busy");
        let Outcome::Wait(wait) = core.handle(&host, &mut conn, &msg(json!({ "id": 3, "call": "pair_result", "args": { "pairId": pair_id } }))) else { panic!("no wait") };
        core.answer(&host, &pair_id, false).unwrap();
        assert_eq!(*wait.rx.borrow(), PairEnd::Denied);
        assert_eq!(serde_json::from_str::<Value>(&wait.reply(&PairEnd::Denied)).unwrap()["error"], "denied");
        assert!(core.store.list().is_empty() && !core.store.has(&client));
        assert!(core.answer(&host, &pair_id, true).is_err(), "a closed prompt cannot be allowed later");
        assert!(core.store.list().is_empty());

        // Timeout.
        let (client, _, _, pair_id) = start_pair(&core, &host, &mut conn);
        core.expire(&host, &pair_id);
        assert!(core.pending_request().is_none());
        assert!(core.answer(&host, &pair_id, true).is_err());
        assert!(core.store.list().is_empty() && !core.store.has(&client));
        assert_eq!(reply(core.pair_result(&conn, json!(4), &json!({ "pairId": pair_id })))["error"], "timeout");

        // The connection closed while the prompt was open.
        let (_, _, _, pair_id) = start_pair(&core, &host, &mut conn);
        core.conn_closed(&host, conn.id);
        assert!(core.pending_request().is_none() && core.answer(&host, &pair_id, true).is_err());
        assert!(core.store.list().is_empty());
        assert!(!dir.join("browsers.json").exists() || core.store.list().is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn disconnect_deletes_the_key() {
        let (core, dir, host, mut conn, client, key, nonce) = paired("disconnect");
        core.disconnect(&host, &client).unwrap();
        assert!(core.store.key(&client).is_none());
        assert_eq!(reply(core.handle(&host, &mut conn, &msg(signed(&key, &client, &nonce, 1, "status"))))["error"], "not_paired");
        assert!(core.disconnect(&host, &client).is_err());
        // The extension's own disconnect call works the same way.
        let (core, dir2, host, mut conn, client, key, nonce) = paired("disconnect2");
        let s = open_signed(&key, &client, &reply(core.handle(&host, &mut conn, &msg(signed(&key, &client, &nonce, 1, "disconnect")))));
        assert_eq!(s["result"]["disconnected"], true);
        assert!(core.store.list().is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
        std::fs::remove_dir_all(&dir2).unwrap();
    }

    #[test]
    fn junk_is_answered_not_run() {
        let (core, dir) = core("junk");
        let host = TestHost::default();
        let mut conn = Conn::new(1);
        assert_eq!(reply(core.handle(&host, &mut conn, b"not json"))["error"], "bad_request");
        assert_eq!(reply(core.handle(&host, &mut conn, &msg(json!({ "id": 1 }))))["error"], "bad_request");
        assert_eq!(reply(core.handle(&host, &mut conn, &msg(json!({ "id": 1, "call": "pair", "args": { "pub": "AAAA" } }))))["error"], "bad_request");
        assert_eq!(reply(core.handle(&host, &mut conn, &msg(json!({ "id": 1, "call": "pair_result", "args": { "pairId": "x" } }))))["error"], "not_found");
        assert_eq!(host.shows.load(Ordering::SeqCst), 0);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
