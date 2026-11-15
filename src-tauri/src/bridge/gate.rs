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

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use ring::hmac;
use serde_json::{Value, json};
pub use coffer_core::session::LoginFill;
use coffer_core::site::{self, LoginRef, Page};
use tokio::sync::watch;
use zeroize::{Zeroize, Zeroizing};

use super::pairing::{self, Key};
use super::store::BrowserStore;
use crate::contract::{BridgeReprompt, BrowserKind, PairRequest};
use crate::error::{CofferError, CofferResult, ErrorCode};
use crate::state::LockExt;

pub const PROTOCOL: u32 = 1;
const REQ_LABEL: &[u8] = b"coffer/v1/req";
const RES_LABEL: &[u8] = b"coffer/v1/res";
/// How long the Connect prompt waits for Allow or Deny.
pub const PAIR_TIMEOUT: Duration = Duration::from_secs(120);
/// How long `get_login` waits for the master password of a re-prompt login.
pub const REPROMPT_TIMEOUT: Duration = Duration::from_secs(120);

/// Calls that read or write the vault (M4 and M5, docs/BRIDGE.md): the fill
/// and save calls. A locked Coffer answers each with `locked`.
#[cfg(test)]
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
    /// The active logins (no passwords), or `None` while Coffer is locked.
    fn logins(&self) -> Option<Vec<LoginRef>>;
    /// Item id to the time of its last use (ISO), for the order of the list.
    fn last_used(&self) -> HashMap<String, String>;
    /// The username and password of a login. Re-prompt applies (`VaultErr::Reprompt`).
    fn login_fill(&self, id: &str) -> Result<LoginFill, VaultErr>;
    /// Copy the login's current one-time code with Coffer's clipboard rules; the clear time.
    fn copy_totp(&self, id: &str) -> Result<Option<u32>, VaultErr>;
    /// A fill used this login (its "last used").
    fn used(&self, id: &str);
    /// `candidate` is this login's password (the password stays in the vault).
    fn password_is(&self, id: &str, candidate: &str) -> Result<bool, VaultErr>;
    /// Save a new login from the browser: (item id, name).
    fn save_login(&self, title: &str, website: &str, username: &str, password: &str) -> Result<(String, String), VaultErr>;
    /// Give a login a new password (the old one goes to its history and revisions).
    fn update_password(&self, id: &str, password: &str) -> Result<(), VaultErr>;
    /// The never list ("Never for this site"), or `None` while Coffer is locked.
    fn never_sites(&self) -> Option<Vec<String>>;
    /// Add a site to the never list.
    fn never_add(&self, site: &str) -> Result<(), VaultErr>;
}


/// Why the vault could not answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VaultErr {
    Locked,
    NotFound,
    /// The login asks for the master password and has no live grant.
    Reprompt,
    Failed(String),
}

impl VaultErr {
    fn answer(self) -> (&'static str, String) {
        match self {
            Self::Locked => locked(),
            Self::NotFound => ("not_found", "Coffer has no such login.".into()),
            Self::Reprompt => ("reprompt", "This login asks for your master password. Pick it in the menu first.".into()),
            Self::Failed(m) => ("io", m),
        }
    }
}

fn locked() -> (&'static str, String) {
    ("locked", "Coffer is locked. Unlock it first.".into())
}

/// Calls that fill (M4). They read the page's URL before anything else.
pub const FILL_CALLS: &[&str] = &["list_logins", "get_login", "copy_totp"];
/// Calls that save (M5). They read the page's URL first too.
pub const SAVE_CALLS: &[&str] = &["find_login", "save_login", "update_password", "never_for_site"];

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

/// The end of a master-password question for a fill.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RepromptEnd {
    Waiting,
    Confirmed,
    Cancelled,
    Timeout,
    /// The connection closed, or Coffer locked.
    Gone,
}

/// The open master-password question for a fill (one at a time).
struct RepromptPending {
    id: String,
    conn: u64,
    item_id: String,
    title: String,
    site: String,
    browser: BrowserKind,
    deadline: Instant,
    expires_at: String,
    tx: watch::Sender<RepromptEnd>,
}

/// A signed call that answers later (`get_login` on a re-prompt login).
pub struct LaterWait {
    pub rx: watch::Receiver<RepromptEnd>,
    pub deadline: Instant,
    pub ticket: Ticket,
}

/// What the late answer needs: the request's envelope and the login.
pub struct Ticket {
    id: Value,
    client: String,
    seq: u64,
    nonce: String,
    item_id: String,
    request_id: String,
}

/// What the server does with a message.
pub enum Outcome {
    Reply(String),
    /// A new Connect prompt: send the reply, and expire `pair_id` after the timeout.
    PairStarted { reply: String, pair_id: String },
    /// `pair_result`: wait for Allow, Deny or the timeout, then send `PairWait::reply`.
    Wait(PairWait),
    /// Wait for the master password, then send `Core::finish`.
    Later(LaterWait),
}

/// What `dispatch` gives back.
enum Answer {
    Now(Result<Value, (&'static str, String)>),
    Later { rx: watch::Receiver<RepromptEnd>, deadline: Instant, item_id: String, request_id: String },
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
    reprompt: Mutex<Option<RepromptPending>>,
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
        Self { store, slot: Mutex::new(PairSlot::default()), reprompt: Mutex::new(None), timeout: PAIR_TIMEOUT }
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
            return self.signed(host, conn, id, &v);
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
        if let Some(r) = self.reprompt.lck().take_if(|r| r.conn == conn_id) {
            let _ = r.tx.send(RepromptEnd::Gone);
            host.changed(false);
        }
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

    fn signed(&self, host: &dyn Host, conn: &mut Conn, id: Value, v: &Value) -> Outcome {
        let reply = Outcome::Reply;
        let (Some(client), Some(body), Some(mac)) = (v.get("client").and_then(Value::as_str), v.get("body").and_then(Value::as_str), v.get("mac").and_then(Value::as_str)) else {
            return reply(err(id, "bad_mac", "A signed call needs client, body and mac."));
        };
        let Some(key) = self.store.key(client) else {
            return reply(err(id, "not_paired", "This browser is not connected to Coffer. Connect it again."));
        };
        if !verify(&key, true, client, body, mac) {
            crate::log!("bridge: refused a call with a wrong MAC");
            return reply(err(id, "bad_mac", "The call's MAC is wrong."));
        }
        let Ok(b) = serde_json::from_str::<Value>(body) else {
            return reply(err(id, "bad_request", "The body is not JSON."));
        };
        let nonce = STANDARD.encode(conn.nonce);
        let fresh = b.get("nonce").and_then(Value::as_str) == Some(nonce.as_str());
        let seq = match b.get("seq").and_then(Value::as_u64) {
            Some(s) if fresh && s > conn.last_seq => s,
            _ => {
                crate::log!("bridge: refused a replayed call");
                return reply(err(id, "replay", "Coffer saw this call before, or it belongs to another connection. Say hello again."));
            }
        };
        conn.last_seq = seq;
        self.store.touch(client, &host.now_iso());
        let call = b.get("call").and_then(Value::as_str).unwrap_or("");
        let args = b.get("args").cloned().unwrap_or_else(|| json!({}));
        match self.dispatch(host, conn, client, call, &args) {
            Answer::Now(result) => reply(signed_answer(&key, client, id, seq, &nonce, result)),
            Answer::Later { rx, deadline, item_id, request_id } => {
                Outcome::Later(LaterWait { rx, deadline, ticket: Ticket { id, client: client.to_owned(), seq, nonce, item_id, request_id } })
            }
        }
    }

    fn dispatch(&self, host: &dyn Host, conn: &Conn, client: &str, call: &str, args: &Value) -> Answer {
        let status = || {
            let (save, update) = host.offers();
            json!({ "version": host.version(), "locked": host.locked(), "offerSave": save, "offerUpdate": update })
        };
        let now = Answer::Now;
        match call {
            "status" => now(Ok(status())),
            "unlock" => {
                if host.locked() {
                    crate::log!("bridge: the browser asked for Coffer's unlock");
                    host.open_unlock();
                }
                now(Ok(status()))
            }
            "disconnect" => {
                let _ = self.store.remove(client);
                crate::log!("bridge: a browser disconnected itself");
                host.changed(false);
                now(Ok(json!({ "disconnected": true })))
            }
            c if FILL_CALLS.contains(&c) || SAVE_CALLS.contains(&c) => {
                // The page first: a page Coffer does not fill on gets nothing, locked or not.
                let page = match page_of(args) {
                    Ok(p) => p,
                    Err(e) => return now(Err(e)),
                };
                match c {
                    "list_logins" => now(list_logins(host, &page)),
                    "get_login" => self.get_login(host, conn, &page, args),
                    "copy_totp" => now(copy_totp(host, &page, args)),
                    "find_login" => now(find_login(host, &page, args)),
                    "save_login" => now(save_login(host, &page, args)),
                    "update_password" => now(update_password(host, &page, args)),
                    _ => now(never_for_site(host, &page)),
                }
            }
            _ => now(Err(("unknown_call", format!("Coffer does not know the call \"{call}\".")))),
        }
    }

    fn get_login(&self, host: &dyn Host, conn: &Conn, page: &Page, args: &Value) -> Answer {
        let login = match login_of(host, page, args) {
            Ok(l) => l,
            Err(e) => return Answer::Now(Err(e)),
        };
        match host.login_fill(&login.id) {
            Ok(fill) => Answer::Now(Ok(filled(host, &login.id, fill))),
            Err(VaultErr::Reprompt) => self.ask_master_password(host, conn, &login, page),
            Err(e) => Answer::Now(Err(e.answer())),
        }
    }

    /// A re-prompt login: Coffer asks for the master password (its own
    /// window); the call answers after the user's answer, or after 2 minutes.
    fn ask_master_password(&self, host: &dyn Host, conn: &Conn, login: &LoginRef, page: &Page) -> Answer {
        let mut slot = self.reprompt.lck();
        if slot.as_ref().is_some_and(|r| Instant::now() < r.deadline) {
            return Answer::Now(Err(("busy", "Coffer already asks for the master password for another fill. Answer it first.".into())));
        }
        if let Some(stale) = slot.take() {
            let _ = stale.tx.send(RepromptEnd::Timeout);
        }
        let request_id = pairing::hex(&coffer_core::crypto::random_array::<8>());
        let (tx, rx) = watch::channel(RepromptEnd::Waiting);
        let deadline = Instant::now() + REPROMPT_TIMEOUT;
        *slot = Some(RepromptPending {
            id: request_id.clone(),
            conn: conn.id,
            item_id: login.id.clone(),
            title: login.title.clone(),
            site: page.site.clone(),
            browser: conn.browser,
            deadline,
            expires_at: crate::clock::iso_from_unix(crate::pin::now_secs() as i64 + REPROMPT_TIMEOUT.as_secs() as i64),
            tx,
        });
        drop(slot);
        crate::log!("bridge: a fill asks for the master password");
        host.changed(true);
        Answer::Later { rx, deadline: deadline + Duration::from_secs(2), item_id: login.id.clone(), request_id }
    }

    /// The open master-password question, for the main window.
    pub fn pending_reprompt(&self) -> Option<BridgeReprompt> {
        self.reprompt.lck().as_ref().map(|r| BridgeReprompt {
            request_id: r.id.clone(),
            browser: r.browser,
            name: r.browser.name().to_string(),
            title: r.title.clone(),
            site: r.site.clone(),
            expires_at: r.expires_at.clone(),
        })
    }

    /// The item of the open question with this id (the caller checks the master password for it).
    pub fn reprompt_item(&self, request_id: &str) -> Option<String> {
        self.reprompt.lck().as_ref().filter(|r| r.id == request_id).map(|r| r.item_id.clone())
    }

    /// The user's answer: `confirmed` after the right master password (the
    /// caller started the item's grant), or Cancel.
    pub fn reprompt_answer(&self, host: &dyn Host, request_id: &str, confirmed: bool) -> CofferResult<()> {
        let Some(r) = self.reprompt.lck().take_if(|r| r.id == request_id) else {
            return Err(CofferError::new(ErrorCode::NotFound, "This request from the browser is no longer open."));
        };
        crate::log!("bridge: master password for a fill {}", if confirmed { "confirmed" } else { "cancelled" });
        let _ = r.tx.send(if confirmed { RepromptEnd::Confirmed } else { RepromptEnd::Cancelled });
        host.changed(false);
        Ok(())
    }

    /// Coffer locked: an open question ends.
    pub fn reprompt_gone(&self, host: &dyn Host) {
        if let Some(r) = self.reprompt.lck().take() {
            let _ = r.tx.send(RepromptEnd::Gone);
            host.changed(false);
        }
    }

    /// The late answer of a `get_login` that waited for the master password.
    pub fn finish(&self, host: &dyn Host, t: &Ticket, end: &RepromptEnd) -> String {
        if let Some(r) = self.reprompt.lck().take_if(|r| r.id == t.request_id) {
            let _ = r.tx.send(RepromptEnd::Timeout);
            host.changed(false);
        }
        let result = match end {
            RepromptEnd::Confirmed => match host.login_fill(&t.item_id) {
                Ok(fill) => Ok(filled(host, &t.item_id, fill)),
                Err(e) => Err(e.answer()),
            },
            RepromptEnd::Cancelled => Err(("cancelled", "You clicked Cancel in Coffer.".into())),
            RepromptEnd::Timeout | RepromptEnd::Waiting => Err(("timeout", "Coffer got no master password within 2 minutes.".into())),
            RepromptEnd::Gone if host.locked() => Err(locked()),
            RepromptEnd::Gone => Err(("cancelled", "Coffer closed its master password question.".into())),
        };
        let Some(key) = self.store.key(&t.client) else {
            return err(t.id.clone(), "not_paired", "This browser is not connected to Coffer. Connect it again.");
        };
        signed_answer(&key, &t.client, t.id.clone(), t.seq, &t.nonce, result)
    }
}

/// The signed answer envelope. Every string in it is wiped after use (a fill carries a password).
fn signed_answer(key: &[u8; 32], client: &str, id: Value, seq: u64, nonce: &str, result: Result<Value, (&'static str, String)>) -> String {
    let mut body = match result {
        Ok(result) => json!({ "seq": seq, "nonce": nonce, "ok": true, "result": result }),
        Err((code, message)) => json!({ "seq": seq, "nonce": nonce, "error": code, "message": message }),
    };
    let mut text = Zeroizing::new(body.to_string());
    wipe(&mut body);
    let mac = sign(key, false, client, &text);
    let mut envelope = json!({ "id": id, "body": std::mem::take(&mut *text), "mac": mac });
    let out = envelope.to_string();
    wipe(&mut envelope);
    out
}

/// Zero every string in a JSON value.
fn wipe(v: &mut Value) {
    match v {
        Value::String(s) => s.zeroize(),
        Value::Array(a) => a.iter_mut().for_each(wipe),
        Value::Object(o) => o.values_mut().for_each(wipe),
        _ => {}
    }
}

/// The page of a fill call: `url` (the frame's own address), and `top` (the
/// top page) when the frame is not the top page. Both must be pages Coffer
/// fills on, of one site.
fn page_of(args: &Value) -> Result<Page, (&'static str, String)> {
    let bad = || ("bad_request", "Coffer fills only on https pages, and on http://localhost and http://127.0.0.1.".to_string());
    let url = args.get("url").and_then(Value::as_str).ok_or_else(bad)?;
    let page = site::page(url).map_err(|_| bad())?;
    if let Some(top) = args.get("top").filter(|t| !t.is_null()) {
        let top = top.as_str().and_then(|t| site::page(t).ok()).ok_or_else(bad)?;
        if !site::same_site(&page, &top) {
            return Err(("cross_site", "This frame is not of the same site as the page around it. Coffer does not fill it.".into()));
        }
    }
    Ok(page)
}

fn list_logins(host: &dyn Host, page: &Page) -> Result<Value, (&'static str, String)> {
    let logins = host.logins().ok_or_else(locked)?;
    let ranked = site::rank(page, &logins, &host.last_used());
    // Names and usernames only: never a password.
    let rows: Vec<Value> = ranked.iter().map(|l| json!({ "id": l.id, "title": l.title, "username": l.username, "hasTotp": l.has_totp })).collect();
    Ok(json!({ "site": page.site, "logins": rows }))
}

/// The login with `args.id`, when it fits the page.
fn login_of(host: &dyn Host, page: &Page, args: &Value) -> Result<LoginRef, (&'static str, String)> {
    let id = args.get("id").and_then(Value::as_str).ok_or(("bad_request", "The call needs the login's id.".to_string()))?;
    let logins = host.logins().ok_or_else(locked)?;
    let login = logins.into_iter().find(|l| l.id == id).ok_or(("not_found", "Coffer has no such login.".to_string()))?;
    if site::fit(page, &login.urls, &login.title).is_none() {
        crate::log!("bridge: refused a login for another site");
        return Err(("no_match", "That login is not for this site.".into()));
    }
    Ok(login)
}

fn filled(host: &dyn Host, id: &str, fill: LoginFill) -> Value {
    host.used(id);
    crate::log!("bridge: filled a login");
    json!({ "username": fill.username.as_str(), "password": fill.password.as_str(), "hasTotp": fill.has_totp })
}

fn copy_totp(host: &dyn Host, page: &Page, args: &Value) -> Result<Value, (&'static str, String)> {
    let login = login_of(host, page, args)?;
    if !login.has_totp {
        return Err(("no_totp", "This login has no one-time code.".into()));
    }
    let clears = host.copy_totp(&login.id).map_err(VaultErr::answer)?;
    Ok(json!({ "clearsInSeconds": clears }))
}

/// A text argument of a save call. `password` must not be empty.
fn text_arg<'a>(args: &'a Value, name: &str) -> Result<&'a str, (&'static str, String)> {
    let v = args.get(name).and_then(Value::as_str).ok_or_else(|| ("bad_request", format!("The call needs {name}.")))?;
    if name == "password" && v.is_empty() {
        return Err(("bad_request", "The call needs a password.".into()));
    }
    Ok(v)
}

/// Two usernames are the same login's: trimmed, and the case does not count
/// (`Alex@Example.com` is `alex@example.com`).
fn same_username(a: &str, b: &str) -> bool {
    a.trim().to_lowercase() == b.trim().to_lowercase()
}

/// `find_login`: does Coffer know the login the user just sent on this
/// page? `match`: `never` (the site is on the never list), `none` (no login of
/// the site has this username), `same` (one has this password too),
/// `changed` (it has another password). `offer` applies the two switches of
/// Settings, Browsers: `save`, `update` or null. The password never comes
/// back: Coffer only compares.
fn find_login(host: &dyn Host, page: &Page, args: &Value) -> Result<Value, (&'static str, String)> {
    let username = text_arg(args, "username")?;
    let password = text_arg(args, "password")?;
    let never = host.never_sites().ok_or_else(locked)?;
    if never.iter().any(|s| *s == page.site) {
        return Ok(json!({ "match": "never", "offer": null, "site": page.site }));
    }
    let logins = host.logins().ok_or_else(locked)?;
    let (offer_save, offer_update) = host.offers();
    let ranked = site::rank(page, &logins, &host.last_used());
    let known: Vec<&LoginRef> = ranked.into_iter().filter(|l| same_username(&l.username, username)).collect();
    let Some(first) = known.first() else {
        return Ok(json!({ "match": "none", "offer": offer_save.then_some("save"), "site": page.site }));
    };
    for l in &known {
        if host.password_is(&l.id, password).map_err(VaultErr::answer)? {
            return Ok(json!({ "match": "same", "id": l.id, "title": l.title, "offer": null, "site": page.site }));
        }
    }
    Ok(json!({ "match": "changed", "id": first.id, "title": first.title, "offer": offer_update.then_some("update"), "site": page.site }))
}

/// `save_login`: a new login named after the page's registered domain, with
/// Website `https://<domain>` (`http://localhost` on localhost). The
/// extension sends it only after the user's click on Save.
fn save_login(host: &dyn Host, page: &Page, args: &Value) -> Result<Value, (&'static str, String)> {
    let username = text_arg(args, "username")?;
    let password = text_arg(args, "password")?;
    if host.locked() {
        return Err(locked());
    }
    let website = format!("{}://{}", page.scheme, page.site);
    let (id, title) = host.save_login(&page.site, &website, username, password).map_err(VaultErr::answer)?;
    crate::log!("bridge: saved a new login from the browser");
    Ok(json!({ "id": id, "title": title }))
}

/// `update_password`: the picked login gets the new password, only when it
/// fits the page. The extension sends it only after the user's click on Update.
fn update_password(host: &dyn Host, page: &Page, args: &Value) -> Result<Value, (&'static str, String)> {
    let password = text_arg(args, "password")?;
    let login = login_of(host, page, args)?;
    host.update_password(&login.id, password).map_err(VaultErr::answer)?;
    crate::log!("bridge: updated a login's password from the browser");
    Ok(json!({ "id": login.id }))
}

/// `never_for_site`: Coffer offers nothing on this site again (Settings,
/// Browsers can take it off the list).
fn never_for_site(host: &dyn Host, page: &Page) -> Result<Value, (&'static str, String)> {
    if host.locked() {
        return Err(locked());
    }
    host.never_add(&page.site).map_err(VaultErr::answer)?;
    crate::log!("bridge: a site went on the never list");
    Ok(json!({ "site": page.site }))
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use ring::agreement;

    use super::*;

    #[derive(Default)]
    struct TestHost {
        locked: AtomicBool,
        unlock_shown: AtomicUsize,
        changes: AtomicUsize,
        shows: AtomicUsize,
        /// The vault: logins, and the items with a live re-prompt grant.
        logins: Vec<LoginRef>,
        granted: Mutex<HashSet<String>>,
        copies: AtomicUsize,
        used: Mutex<Vec<String>>,
        /// "Offer to save", "Offer to update" (None: on, off).
        offers: Mutex<Option<(bool, bool)>>,
        /// Saved from the browser: (title, website, username, password).
        saved: Mutex<Vec<(String, String, String, String)>>,
        /// Item id to its new password.
        passwords: Mutex<HashMap<String, String>>,
        never: Mutex<Vec<String>>,
    }

    impl Host for TestHost {
        fn version(&self) -> String {
            "0.3.0".into()
        }
        fn locked(&self) -> bool {
            self.locked.load(Ordering::SeqCst)
        }
        fn offers(&self) -> (bool, bool) {
            self.offers.lck().unwrap_or((true, false))
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
        fn logins(&self) -> Option<Vec<LoginRef>> {
            (!self.locked()).then(|| self.logins.clone())
        }
        fn last_used(&self) -> HashMap<String, String> {
            HashMap::new()
        }
        fn login_fill(&self, id: &str) -> Result<LoginFill, VaultErr> {
            if self.locked() {
                return Err(VaultErr::Locked);
            }
            let l = self.logins.iter().find(|l| l.id == id).ok_or(VaultErr::NotFound)?;
            if l.reprompt && !self.granted.lck().contains(id) {
                return Err(VaultErr::Reprompt);
            }
            Ok(LoginFill { username: Zeroizing::new(l.username.clone()), password: Zeroizing::new(format!("pw-{id}")), has_totp: l.has_totp })
        }
        fn copy_totp(&self, _id: &str) -> Result<Option<u32>, VaultErr> {
            self.copies.fetch_add(1, Ordering::SeqCst);
            Ok(Some(90))
        }
        fn used(&self, id: &str) {
            self.used.lck().push(id.to_string());
        }
        fn password_is(&self, id: &str, candidate: &str) -> Result<bool, VaultErr> {
            if self.locked() {
                return Err(VaultErr::Locked);
            }
            self.logins.iter().find(|l| l.id == id).ok_or(VaultErr::NotFound)?;
            let current = self.passwords.lck().get(id).cloned().unwrap_or_else(|| format!("pw-{id}"));
            Ok(current == candidate)
        }
        fn save_login(&self, title: &str, website: &str, username: &str, password: &str) -> Result<(String, String), VaultErr> {
            let mut saved = self.saved.lck();
            saved.push((title.into(), website.into(), username.into(), password.into()));
            Ok((format!("new{}", saved.len()), title.into()))
        }
        fn update_password(&self, id: &str, password: &str) -> Result<(), VaultErr> {
            self.passwords.lck().insert(id.into(), password.into());
            Ok(())
        }
        fn never_sites(&self) -> Option<Vec<String>> {
            (!self.locked()).then(|| self.never.lck().clone())
        }
        fn never_add(&self, site: &str) -> Result<(), VaultErr> {
            self.never.lck().push(site.into());
            Ok(())
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
            Outcome::Wait(_) | Outcome::Later(_) => panic!("a wait, not a reply"),
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
        signed_args(key, client, nonce, seq, call, json!({}))
    }

    fn signed_args(key: &[u8; 32], client: &str, nonce: &str, seq: u64, call: &str, args: Value) -> Value {
        let body = json!({ "call": call, "args": args, "nonce": nonce, "seq": seq }).to_string();
        json!({ "id": 10 + seq, "client": client, "body": body, "mac": sign(key, true, client, &body) })
    }

    /// Unwrap a signed reply after checking Coffer's MAC.
    fn open_signed(key: &[u8; 32], client: &str, r: &Value) -> Value {
        let body = r["body"].as_str().unwrap_or_else(|| panic!("not signed: {r}"));
        assert!(verify(key, false, client, body, r["mac"].as_str().unwrap()), "Coffer's MAC");
        serde_json::from_str(body).unwrap()
    }

    fn paired(name: &str) -> (Core, std::path::PathBuf, TestHost, Conn, String, Key, String) {
        paired_with(name, TestHost::default())
    }

    fn paired_with(name: &str, host: TestHost) -> (Core, std::path::PathBuf, TestHost, Conn, String, Key, String) {
        let (core, dir) = core(name);
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
        let args = json!({ "url": "https://northwind-shop.test/sign-in", "id": "ns", "username": "u", "password": "p" });
        for (i, call) in VAULT_CALLS.iter().enumerate() {
            let s = open_signed(&key, &client, &reply(core.handle(&host, &mut conn, &msg(signed_args(&key, &client, &nonce, 2 + i as u64, call, args.clone())))));
            assert_eq!(s["error"], "locked", "{call}");
        }
        // A page Coffer does not fill on is refused before the lock matters.
        let s = open_signed(&key, &client, &reply(core.handle(&host, &mut conn, &msg(signed_args(&key, &client, &nonce, 15, "list_logins", json!({ "url": "http://northwind-shop.test/" }))))));
        assert_eq!(s["error"], "bad_request");
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

    fn northwind() -> TestHost {
        let login = |id: &str, title: &str, username: &str, urls: &[&str], has_totp: bool, reprompt: bool| LoginRef {
            id: id.into(),
            title: title.into(),
            username: username.into(),
            urls: urls.iter().map(|u| u.to_string()).collect(),
            has_totp,
            reprompt,
        };
        TestHost {
            logins: vec![
                login("ns", "northwind-shop.test", "alex@example.com", &[], true, false),
                login("nw", "Northwind (work)", "alex.morgan@work.example", &["https://accounts.northwind-shop.test/sign-in"], false, true),
                login("ev", "Look-alike", "mallory@example.com", &["https://northwind-sh0p.test"], false, false),
                login("gg", "Google", "alex@gmail.com", &["https://google.com"], false, false),
            ],
            ..TestHost::default()
        }
    }

    /// One signed call on the connection: the opened answer body.
    fn call(core: &Core, host: &TestHost, conn: &mut Conn, key: &Key, client: &str, nonce: &str, seq: u64, name: &str, args: Value) -> Value {
        open_signed(key, client, &reply(core.handle(host, conn, &msg(signed_args(key, client, nonce, seq, name, args)))))
    }

    #[test]
    fn list_logins_sends_names_and_usernames_of_the_site_only() {
        let (core, dir, host, mut conn, client, key, nonce) = paired_with("list", northwind());
        let s = call(&core, &host, &mut conn, &key, &client, &nonce, 1, "list_logins", json!({ "url": "https://accounts.northwind-shop.test/sign-in?next=/" }));
        assert_eq!(s["result"]["site"], "northwind-shop.test");
        let rows = s["result"]["logins"].as_array().unwrap();
        // The same host first: the work login's Website is this host; the other matches by its name.
        assert_eq!(rows.iter().map(|r| r["id"].as_str().unwrap()).collect::<Vec<_>>(), ["nw", "ns"]);
        for r in rows {
            let mut keys: Vec<&str> = r.as_object().unwrap().keys().map(String::as_str).collect();
            keys.sort_unstable();
            assert_eq!(keys, ["hasTotp", "id", "title", "username"], "no password field");
        }
        assert_eq!(rows[1], json!({ "id": "ns", "title": "northwind-shop.test", "username": "alex@example.com", "hasTotp": true }));
        assert!(!s.to_string().contains("pw-"), "no password in the list");
        // The look-alike gets only its own login; a site with none gets an empty list.
        let s = call(&core, &host, &mut conn, &key, &client, &nonce, 2, "list_logins", json!({ "url": "https://northwind-sh0p.test/" }));
        assert_eq!(s["result"]["logins"].as_array().unwrap().iter().map(|r| r["id"].as_str().unwrap()).collect::<Vec<_>>(), ["ev"]);
        for (i, url) in ["https://g00gle.com/", "https://google.com.evil.test/", "https://evil-google.com/"].iter().enumerate() {
            let s = call(&core, &host, &mut conn, &key, &client, &nonce, 3 + i as u64, "list_logins", json!({ "url": url }));
            assert_eq!(s["result"]["logins"], json!([]), "{url}");
        }
        let s = call(&core, &host, &mut conn, &key, &client, &nonce, 6, "list_logins", json!({ "url": "https://accounts.google.com/" }));
        assert_eq!(s["result"]["logins"][0]["id"], "gg");
        // Only https (http on localhost), and a frame only of the same site as its page.
        for (i, url) in ["http://northwind-shop.test/", "file:///C:/x.html", "javascript:alert(1)"].iter().enumerate() {
            assert_eq!(call(&core, &host, &mut conn, &key, &client, &nonce, 10 + i as u64, "list_logins", json!({ "url": url }))["error"], "bad_request", "{url}");
        }
        assert_eq!(call(&core, &host, &mut conn, &key, &client, &nonce, 13, "list_logins", json!({}))["error"], "bad_request");
        let s = call(&core, &host, &mut conn, &key, &client, &nonce, 14, "list_logins", json!({ "url": "https://accounts.northwind-shop.test/", "top": "https://evil.test/" }));
        assert_eq!(s["error"], "cross_site");
        let s = call(&core, &host, &mut conn, &key, &client, &nonce, 15, "list_logins", json!({ "url": "https://accounts.northwind-shop.test/", "top": "https://www.northwind-shop.test/" }));
        assert_eq!(s["result"]["logins"].as_array().unwrap().len(), 2);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn get_login_fills_only_a_login_of_the_site() {
        let (core, dir, host, mut conn, client, key, nonce) = paired_with("get", northwind());
        let page = "https://northwind-shop.test/sign-in";
        let s = call(&core, &host, &mut conn, &key, &client, &nonce, 1, "get_login", json!({ "url": page, "id": "ns" }));
        assert_eq!(s["result"], json!({ "username": "alex@example.com", "password": "pw-ns", "hasTotp": true }));
        assert_eq!(*host.used.lck(), ["ns"], "a fill counts as a use");
        // A login of another site, an unknown id, no id, a cross-site frame.
        assert_eq!(call(&core, &host, &mut conn, &key, &client, &nonce, 2, "get_login", json!({ "url": page, "id": "ev" }))["error"], "no_match");
        assert_eq!(call(&core, &host, &mut conn, &key, &client, &nonce, 3, "get_login", json!({ "url": "https://northwind-sh0p.test/", "id": "ns" }))["error"], "no_match");
        assert_eq!(call(&core, &host, &mut conn, &key, &client, &nonce, 4, "get_login", json!({ "url": page, "id": "zz" }))["error"], "not_found");
        assert_eq!(call(&core, &host, &mut conn, &key, &client, &nonce, 5, "get_login", json!({ "url": page }))["error"], "bad_request");
        assert_eq!(call(&core, &host, &mut conn, &key, &client, &nonce, 6, "get_login", json!({ "url": page, "id": "ns", "top": "https://evil.test/" }))["error"], "cross_site");
        assert_eq!(*host.used.lck(), ["ns"]);
        // The one-time code.
        let s = call(&core, &host, &mut conn, &key, &client, &nonce, 7, "copy_totp", json!({ "url": page, "id": "ns" }));
        assert_eq!(s["result"], json!({ "clearsInSeconds": 90 }));
        assert_eq!(call(&core, &host, &mut conn, &key, &client, &nonce, 8, "copy_totp", json!({ "url": "https://northwind-sh0p.test/", "id": "ev" }))["error"], "no_totp");
        assert_eq!(call(&core, &host, &mut conn, &key, &client, &nonce, 9, "copy_totp", json!({ "url": "https://northwind-sh0p.test/", "id": "ns" }))["error"], "no_match");
        assert_eq!(host.copies.load(Ordering::SeqCst), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn later(core: &Core, host: &TestHost, conn: &mut Conn, key: &Key, client: &str, nonce: &str, seq: u64) -> LaterWait {
        let m = msg(signed_args(key, client, nonce, seq, "get_login", json!({ "url": "https://accounts.northwind-shop.test/", "id": "nw" })));
        match core.handle(host, conn, &m) {
            Outcome::Later(w) => w,
            _ => panic!("get_login on a re-prompt login answers later"),
        }
    }

    #[test]
    fn a_reprompt_login_waits_for_the_master_password() {
        let (core, dir, host, mut conn, client, key, nonce) = paired_with("reprompt", northwind());
        let shows = host.shows.load(Ordering::SeqCst);
        let wait = later(&core, &host, &mut conn, &key, &client, &nonce, 1);
        assert_eq!(host.shows.load(Ordering::SeqCst), shows + 1, "Coffer comes up with its question");
        let q = core.pending_reprompt().unwrap();
        assert_eq!((q.title.as_str(), q.site.as_str(), q.name.as_str()), ("Northwind (work)", "northwind-shop.test", "Chrome"));
        assert_eq!(core.reprompt_item(&q.request_id).as_deref(), Some("nw"));
        assert!(host.used.lck().is_empty(), "nothing filled yet");
        // One question at a time.
        let s = call(&core, &host, &mut conn, &key, &client, &nonce, 2, "get_login", json!({ "url": "https://accounts.northwind-shop.test/", "id": "nw" }));
        assert_eq!(s["error"], "busy");
        assert!(core.reprompt_answer(&host, "other", true).is_err());
        // The right master password (the shell starts the grant), then the answer.
        host.granted.lck().insert("nw".into());
        core.reprompt_answer(&host, &q.request_id, true).unwrap();
        assert_eq!(*wait.rx.borrow(), RepromptEnd::Confirmed);
        assert!(core.pending_reprompt().is_none());
        let r: Value = serde_json::from_str(&core.finish(&host, &wait.ticket, &RepromptEnd::Confirmed)).unwrap();
        assert_eq!(r["id"], 11, "the answer carries the request's id");
        let s = open_signed(&key, &client, &r);
        assert_eq!((s["seq"].clone(), s["result"]["password"].clone()), (json!(1), json!("pw-nw")));
        assert_eq!(*host.used.lck(), ["nw"]);

        // Cancel answers an error, and fills nothing.
        host.granted.lck().clear();
        let wait = later(&core, &host, &mut conn, &key, &client, &nonce, 3);
        let q = core.pending_reprompt().unwrap();
        core.reprompt_answer(&host, &q.request_id, false).unwrap();
        let s = open_signed(&key, &client, &serde_json::from_str(&core.finish(&host, &wait.ticket, &wait.rx.borrow().clone())).unwrap());
        assert_eq!(s["error"], "cancelled");
        assert!(!s.to_string().contains("pw-nw"));

        // Two minutes with no answer: the question closes.
        let wait = later(&core, &host, &mut conn, &key, &client, &nonce, 4);
        let s = open_signed(&key, &client, &serde_json::from_str(&core.finish(&host, &wait.ticket, &RepromptEnd::Timeout)).unwrap());
        assert_eq!(s["error"], "timeout");
        assert!(core.pending_reprompt().is_none());

        // The connection closed.
        let wait = later(&core, &host, &mut conn, &key, &client, &nonce, 5);
        core.conn_closed(&host, conn.id);
        assert_eq!(*wait.rx.borrow(), RepromptEnd::Gone);
        assert!(core.pending_reprompt().is_none());

        // Coffer locked while it asked.
        let mut conn = Conn::new(7);
        let nonce = hello(&core, &host, &mut conn, Some(&client))["result"]["nonce"].as_str().unwrap().to_string();
        let wait = later(&core, &host, &mut conn, &key, &client, &nonce, 1);
        host.locked.store(true, Ordering::SeqCst);
        core.reprompt_gone(&host);
        assert_eq!(*wait.rx.borrow(), RepromptEnd::Gone);
        let s = open_signed(&key, &client, &serde_json::from_str(&core.finish(&host, &wait.ticket, &RepromptEnd::Gone)).unwrap());
        assert_eq!(s["error"], "locked");
        assert_eq!(*host.used.lck(), ["nw"], "only the confirmed fill was used");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// find_login for a username and password on a page: the opened result.
    fn find(core: &Core, host: &TestHost, conn: &mut Conn, key: &Key, client: &str, nonce: &str, seq: u64, url: &str, username: &str, password: &str) -> Value {
        call(core, host, conn, key, client, nonce, seq, "find_login", json!({ "url": url, "username": username, "password": password }))["result"].clone()
    }

    #[test]
    fn find_login_tells_new_same_and_changed_apart_and_never_sends_a_password() {
        let (core, dir, host, mut conn, client, key, nonce) = paired_with("find", northwind());
        *host.offers.lck() = Some((true, true));
        let page = "https://northwind-shop.test/sign-in";
        // A username Coffer does not have on this site: offer Save.
        let r = find(&core, &host, &mut conn, &key, &client, &nonce, 1, page, "new@example.com", "Fresh-1");
        assert_eq!(r, json!({ "match": "none", "offer": "save", "site": "northwind-shop.test" }));
        // The same username and password: nothing to offer.
        let r = find(&core, &host, &mut conn, &key, &client, &nonce, 2, page, "alex@example.com", "pw-ns");
        assert_eq!(r, json!({ "match": "same", "id": "ns", "title": "northwind-shop.test", "offer": null, "site": "northwind-shop.test" }));
        // The case of the username does not count.
        assert_eq!(find(&core, &host, &mut conn, &key, &client, &nonce, 3, page, " Alex@Example.COM", "pw-ns")["match"], "same");
        // The same username, another password: offer Update, naming the login.
        let r = find(&core, &host, &mut conn, &key, &client, &nonce, 4, page, "alex@example.com", "New-pass-2");
        assert_eq!(r, json!({ "match": "changed", "id": "ns", "title": "northwind-shop.test", "offer": "update", "site": "northwind-shop.test" }));
        assert!(!r.to_string().contains("pw-ns"), "the stored password never comes back");
        // The look-alike site does not see the real site's logins: a new login there.
        assert_eq!(find(&core, &host, &mut conn, &key, &client, &nonce, 5, "https://northwind-sh0p.test/", "alex@example.com", "pw-ns")["match"], "none");
        // A subdomain is the same site.
        assert_eq!(find(&core, &host, &mut conn, &key, &client, &nonce, 6, "https://www.northwind-shop.test/", "alex@example.com", "pw-ns")["match"], "same");
        // Bad pages and bad args: refused before anything else.
        assert_eq!(call(&core, &host, &mut conn, &key, &client, &nonce, 7, "find_login", json!({ "url": "http://northwind-shop.test/", "username": "a", "password": "b" }))["error"], "bad_request");
        assert_eq!(call(&core, &host, &mut conn, &key, &client, &nonce, 8, "find_login", json!({ "url": page, "username": "a", "password": "" }))["error"], "bad_request");
        assert_eq!(call(&core, &host, &mut conn, &key, &client, &nonce, 9, "find_login", json!({ "url": page, "password": "b" }))["error"], "bad_request");
        assert_eq!(call(&core, &host, &mut conn, &key, &client, &nonce, 10, "find_login", json!({ "url": "https://northwind-shop.test/f", "top": "https://evil.test/", "username": "a", "password": "b" }))["error"], "cross_site");
        assert!(host.saved.lck().is_empty() && host.passwords.lck().is_empty(), "find_login writes nothing");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_two_switches_turn_the_offers_off() {
        let (core, dir, host, mut conn, client, key, nonce) = paired_with("switches", northwind());
        let page = "https://northwind-shop.test/";
        *host.offers.lck() = Some((false, false));
        let r = find(&core, &host, &mut conn, &key, &client, &nonce, 1, page, "new@example.com", "x");
        assert_eq!((r["match"].clone(), r["offer"].clone()), (json!("none"), Value::Null));
        let r = find(&core, &host, &mut conn, &key, &client, &nonce, 2, page, "alex@example.com", "changed");
        assert_eq!((r["match"].clone(), r["offer"].clone()), (json!("changed"), Value::Null));
        // Each switch alone.
        *host.offers.lck() = Some((true, false));
        assert_eq!(find(&core, &host, &mut conn, &key, &client, &nonce, 3, page, "new@example.com", "x")["offer"], "save");
        assert_eq!(find(&core, &host, &mut conn, &key, &client, &nonce, 4, page, "alex@example.com", "changed")["offer"], Value::Null);
        *host.offers.lck() = Some((false, true));
        assert_eq!(find(&core, &host, &mut conn, &key, &client, &nonce, 5, page, "new@example.com", "x")["offer"], Value::Null);
        assert_eq!(find(&core, &host, &mut conn, &key, &client, &nonce, 6, page, "alex@example.com", "changed")["offer"], "update");
        // status reports both, for the extension.
        assert_eq!(call(&core, &host, &mut conn, &key, &client, &nonce, 7, "status", json!({}))["result"]["offerSave"], false);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn save_login_makes_a_login_named_after_the_registered_domain() {
        let (core, dir, host, mut conn, client, key, nonce) = paired_with("save", northwind());
        let s = call(&core, &host, &mut conn, &key, &client, &nonce, 1, "save_login", json!({ "url": "https://accounts.northwind-shop.test/sign-in?next=/", "username": "new@example.com", "password": "Fresh-1" }));
        assert_eq!(s["result"], json!({ "id": "new1", "title": "northwind-shop.test" }));
        assert_eq!(*host.saved.lck(), [("northwind-shop.test".to_string(), "https://northwind-shop.test".to_string(), "new@example.com".to_string(), "Fresh-1".to_string())]);
        // localhost keeps http; a public suffix host is its own site.
        call(&core, &host, &mut conn, &key, &client, &nonce, 2, "save_login", json!({ "url": "http://localhost:3000/login", "username": "", "password": "p" }));
        call(&core, &host, &mut conn, &key, &client, &nonce, 3, "save_login", json!({ "url": "https://alex.github.io/app", "username": "a", "password": "p" }));
        let saved = host.saved.lck().clone();
        assert_eq!((saved[1].0.as_str(), saved[1].1.as_str()), ("localhost", "http://localhost"));
        assert_eq!((saved[2].0.as_str(), saved[2].1.as_str()), ("alex.github.io", "https://alex.github.io"));
        // An http page, a cross-site frame, no password: nothing saved.
        assert_eq!(call(&core, &host, &mut conn, &key, &client, &nonce, 4, "save_login", json!({ "url": "http://northwind-shop.test/", "username": "a", "password": "p" }))["error"], "bad_request");
        assert_eq!(call(&core, &host, &mut conn, &key, &client, &nonce, 5, "save_login", json!({ "url": "https://northwind-shop.test/", "top": "https://evil.test/", "username": "a", "password": "p" }))["error"], "cross_site");
        assert_eq!(call(&core, &host, &mut conn, &key, &client, &nonce, 6, "save_login", json!({ "url": "https://northwind-shop.test/", "username": "a" }))["error"], "bad_request");
        assert_eq!(host.saved.lck().len(), 3);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn update_password_changes_only_a_login_of_the_site() {
        let (core, dir, host, mut conn, client, key, nonce) = paired_with("update", northwind());
        let page = "https://northwind-shop.test/sign-in";
        let s = call(&core, &host, &mut conn, &key, &client, &nonce, 1, "update_password", json!({ "url": page, "id": "ns", "password": "New-pass-2" }));
        assert_eq!(s["result"], json!({ "id": "ns" }));
        assert_eq!(host.passwords.lck().get("ns").map(String::as_str), Some("New-pass-2"));
        // Now the same password is "same".
        assert_eq!(find(&core, &host, &mut conn, &key, &client, &nonce, 2, page, "alex@example.com", "New-pass-2")["match"], "same");
        // Another site's login, an unknown id, no password: refused, nothing changed.
        assert_eq!(call(&core, &host, &mut conn, &key, &client, &nonce, 3, "update_password", json!({ "url": page, "id": "ev", "password": "x" }))["error"], "no_match");
        assert_eq!(call(&core, &host, &mut conn, &key, &client, &nonce, 4, "update_password", json!({ "url": page, "id": "zz", "password": "x" }))["error"], "not_found");
        assert_eq!(call(&core, &host, &mut conn, &key, &client, &nonce, 5, "update_password", json!({ "url": page, "id": "ns", "password": "" }))["error"], "bad_request");
        assert_eq!(call(&core, &host, &mut conn, &key, &client, &nonce, 6, "update_password", json!({ "url": "https://northwind-sh0p.test/", "id": "ns", "password": "x" }))["error"], "no_match");
        assert_eq!(host.passwords.lck().len(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn never_for_site_then_find_login_says_never() {
        let (core, dir, host, mut conn, client, key, nonce) = paired_with("never", northwind());
        let s = call(&core, &host, &mut conn, &key, &client, &nonce, 1, "never_for_site", json!({ "url": "https://accounts.northwind-shop.test/sign-in" }));
        assert_eq!(s["result"], json!({ "site": "northwind-shop.test" }));
        assert_eq!(*host.never.lck(), ["northwind-shop.test"], "the registered domain, not the host");
        for (i, (user, pw)) in [("new@example.com", "x"), ("alex@example.com", "changed"), ("alex@example.com", "pw-ns")].iter().enumerate() {
            let r = find(&core, &host, &mut conn, &key, &client, &nonce, 2 + i as u64, "https://www.northwind-shop.test/", user, pw);
            assert_eq!(r, json!({ "match": "never", "offer": null, "site": "northwind-shop.test" }), "{user}");
        }
        // Another site is not on the list.
        assert_eq!(find(&core, &host, &mut conn, &key, &client, &nonce, 9, "https://northwind-sh0p.test/", "a", "b")["match"], "none");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn save_calls_answer_locked_and_write_nothing() {
        let (core, dir, host, mut conn, client, key, nonce) = paired_with("save-locked", northwind());
        host.locked.store(true, Ordering::SeqCst);
        let page = "https://northwind-shop.test/sign-in";
        let calls = [
            ("find_login", json!({ "url": page, "username": "alex@example.com", "password": "x" })),
            ("save_login", json!({ "url": page, "username": "new@example.com", "password": "x" })),
            ("update_password", json!({ "url": page, "id": "ns", "password": "x" })),
            ("never_for_site", json!({ "url": page })),
        ];
        for (i, (name, args)) in calls.iter().enumerate() {
            assert_eq!(call(&core, &host, &mut conn, &key, &client, &nonce, 1 + i as u64, name, args.clone())["error"], "locked", "{name}");
        }
        assert!(host.saved.lck().is_empty() && host.passwords.lck().is_empty() && host.never.lck().is_empty());
        // After the unlock, the same Save works.
        host.locked.store(false, Ordering::SeqCst);
        assert_eq!(call(&core, &host, &mut conn, &key, &client, &nonce, 9, "save_login", calls[1].1.clone())["result"]["title"], "northwind-shop.test");
        std::fs::remove_dir_all(&dir).unwrap();
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
