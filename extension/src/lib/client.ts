// The extension's bridge client (docs/BRIDGE.md): one native port to
// coffer-bridge.exe, `hello`, the one-time Connect, and signed calls.
// It runs in the service worker; pages ask the worker (background.ts).
import {
  b64,
  bridgeKey,
  type BrowserKind,
  confirmOf,
  newKeyPair,
  sharedSecret,
  signedRequest,
  transcript,
  unb64,
  unhex,
  verifyBody,
  wordsOf,
} from "./protocol";

export class BridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function asBridgeError(e: unknown): BridgeError {
  if (e instanceof BridgeError) return e;
  return new BridgeError("io", e instanceof Error ? e.message : String(e));
}

/** Why a native port closed, from chrome.runtime.lastError. */
export function closeError(message: string): BridgeError {
  if (/not found/i.test(message)) return new BridgeError("not_installed", "This browser cannot find Coffer's bridge. Install Coffer, then reload the extension.");
  if (/forbidden/i.test(message)) return new BridgeError("not_installed", "Coffer's bridge does not accept this extension.");
  return new BridgeError("not_running", "Coffer closed the connection.");
}

type Message = Record<string, unknown>;

/** What a Session needs from a native port (a fake one in tests). */
export interface Link {
  readonly closed: boolean;
  /** Send `build(id)` and wait for the reply with that id. */
  request(build: (id: number) => Message | Promise<Message>, timeoutMs?: number): Promise<Message>;
  close(): void;
}

/** chrome.runtime.connectNative, with request ids. */
export class NativeLink implements Link {
  private port: chrome.runtime.Port | null;
  private nextId = 1;
  private waiting = new Map<number, { resolve: (m: Message) => void; reject: (e: BridgeError) => void; timer: ReturnType<typeof setTimeout> }>();
  closed = false;

  constructor(host: string) {
    this.port = chrome.runtime.connectNative(host);
    this.port.onMessage.addListener((m) => this.receive(m));
    this.port.onDisconnect.addListener(() => this.fail(closeError(chrome.runtime.lastError?.message ?? "")));
  }

  private receive(m: unknown) {
    if (!m || typeof m !== "object") return;
    const msg = m as Message;
    const id = typeof msg.id === "number" ? msg.id : null;
    // A bridge error with no id (a frame over 1 MB): the oldest call gets it.
    const key = id ?? this.waiting.keys().next().value;
    const w = key === undefined ? undefined : this.waiting.get(key);
    if (!w || key === undefined) return;
    this.waiting.delete(key);
    clearTimeout(w.timer);
    w.resolve(msg);
  }

  private fail(e: BridgeError) {
    this.closed = true;
    this.port = null;
    for (const w of this.waiting.values()) {
      clearTimeout(w.timer);
      w.reject(e);
    }
    this.waiting.clear();
  }

  async request(build: (id: number) => Message | Promise<Message>, timeoutMs = 10_000): Promise<Message> {
    if (this.closed || !this.port) throw new BridgeError("not_running", "The connection to Coffer is closed.");
    const id = this.nextId++;
    const msg = await build(id);
    return new Promise<Message>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new BridgeError("not_running", "Coffer did not answer."));
      }, timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      try {
        this.port?.postMessage(msg);
      } catch (e) {
        this.waiting.delete(id);
        clearTimeout(timer);
        reject(asBridgeError(e));
      }
    });
  }

  close() {
    const port = this.port;
    this.fail(new BridgeError("closed", "The connection was closed."));
    port?.disconnect();
  }
}

/** What the extension keeps in chrome.storage.local after Allow. */
export interface Pairing {
  client: string; // 32 hex digits, Coffer's id for this browser profile
  key: string; // base64 of the 32-byte bridge key
  browser: BrowserKind;
  pairedAt: string;
}

export interface Hello {
  protocol: number;
  version: string;
  paired: boolean;
  locked: boolean;
  nonce: string;
}

export interface Status {
  version: string;
  locked: boolean;
  offerSave: boolean;
  offerUpdate: boolean;
}

export interface SessionEnv {
  open: () => Promise<Link>;
  browser: BrowserKind;
  version: string;
  load: () => Promise<Pairing | null>;
  save: (p: Pairing | null) => Promise<void>;
  words: () => Promise<string[]>;
}

function errorOf(reply: Message): BridgeError | null {
  return typeof reply.error === "string" ? new BridgeError(reply.error, String(reply.message ?? reply.error)) : null;
}

export class Session {
  private link: Link | null = null;
  private hello: Hello | null = null;
  private seq = 0;
  private connecting: Promise<Hello> | null = null;

  constructor(private readonly env: SessionEnv) {}

  /** Open the port and say hello (once per port). */
  connect(): Promise<Hello> {
    if (this.link && !this.link.closed && this.hello) return Promise.resolve(this.hello);
    this.connecting ??= this.open().finally(() => (this.connecting = null));
    return this.connecting;
  }

  private async open(): Promise<Hello> {
    this.close();
    const link = await this.env.open();
    this.link = link;
    this.seq = 0;
    const pairing = await this.env.load();
    const reply = await link.request((id) => ({ id, call: "hello", args: { version: this.env.version, browser: this.env.browser, client: pairing?.client ?? null } }));
    const err = errorOf(reply);
    if (err) {
      this.close();
      throw err;
    }
    this.hello = reply.result as Hello;
    return this.hello;
  }

  close() {
    this.link?.close();
    this.link = null;
    this.hello = null;
  }

  /** A signed call. Rejects with a BridgeError (`locked`, `not_paired`, `bad_mac`, ...). */
  async call<T>(call: string, args: unknown = {}): Promise<T> {
    const pairing = await this.env.load();
    if (!pairing) throw new BridgeError("not_paired", "Connect this browser to Coffer first.");
    const hello = await this.connect();
    const link = this.link;
    if (!link) throw new BridgeError("not_running", "The connection to Coffer is closed.");
    const key = unb64(pairing.key);
    const seq = ++this.seq;
    const reply = await link.request((id) => signedRequest(key, pairing.client, id, call, args, hello.nonce, seq));
    const err = errorOf(reply);
    if (err) throw err;
    const body = String(reply.body ?? "");
    if (!(await verifyBody(key, "res", pairing.client, body, String(reply.mac ?? "")))) throw new BridgeError("bad_mac", "Coffer's answer did not check out.");
    const answer = JSON.parse(body) as { seq: number; nonce: string; ok?: boolean; result?: T; error?: string; message?: string };
    if (answer.seq !== seq || answer.nonce !== hello.nonce) throw new BridgeError("replay", "Coffer's answer was for another call.");
    if (answer.ok) return answer.result as T;
    throw new BridgeError(answer.error ?? "io", answer.message ?? "Coffer refused the call.");
  }

  /**
   * The one-time Connect: send a new X25519 key, show the four words with
   * `onWords`, wait for Allow in Coffer (up to 2 minutes), check Coffer's
   * confirm, then keep the key.
   */
  async pair(onWords: (words: string[]) => void): Promise<void> {
    await this.connect();
    const link = this.link;
    if (!link) throw new BridgeError("not_running", "The connection to Coffer is closed.");
    const { privateKey, pub } = await newKeyPair();
    const started = await link.request((id) => ({ id, call: "pair", args: { pub: b64(pub), browser: this.env.browser, version: this.env.version } }));
    const err = errorOf(started);
    if (err) throw err;
    const r = started.result as { pairId: string; pub: string; client: string };
    const cofferPub = unb64(r.pub);
    const t = await transcript(pub, cofferPub, unhex(r.client));
    onWords(wordsOf(t, await this.env.words()));
    const key = await bridgeKey(await sharedSecret(privateKey, cofferPub), t);
    const done = await link.request((id) => ({ id, call: "pair_result", args: { pairId: r.pairId } }), 135_000);
    const end = errorOf(done);
    if (end) throw end;
    const confirm = (done.result as { confirm?: string } | undefined)?.confirm;
    if (confirm !== (await confirmOf(key, t))) throw new BridgeError("bad_mac", "Coffer and this browser do not hold the same key. Connect again.");
    await this.env.save({ client: r.client, key: b64(key), browser: this.env.browser, pairedAt: new Date().toISOString() });
  }
}
