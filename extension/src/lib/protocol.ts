// The extension's half of the bridge protocol (docs/BRIDGE.md). Pure
// functions over WebCrypto, so Vitest runs them in Node with the same
// known-answer vector as src-tauri/src/bridge/pairing.rs.

/** A byte array WebCrypto takes as a BufferSource. */
export type Bytes = Uint8Array<ArrayBuffer>;

export const PROTOCOL = 1;
const TRANSCRIPT_LABEL = "coffer/v1/pair";
const KEY_INFO = "coffer/v1/bridge-key";
const CONFIRM_LABEL = "coffer/v1/pair-confirm";
const REQ_LABEL = "coffer/v1/req";
const RES_LABEL = "coffer/v1/res";

const enc = new TextEncoder();
const utf8 = (s: string): Bytes => enc.encode(s) as Bytes;

export function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function unb64(text: string): Bytes {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function unhex(text: string): Bytes {
  if (!/^(?:[0-9a-f]{2})*$/.test(text)) throw new Error("not lower-case hex");
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(2 * i, 2 * i + 2), 16);
  return out;
}

async function sha256(data: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

/** SHA-256(`coffer/v1/pair` || 0x00 || extension key || Coffer key || client id bytes). */
export function transcript(extPub: Uint8Array, cofferPub: Uint8Array, client: Uint8Array): Promise<Bytes> {
  if (extPub.length !== 32 || cofferPub.length !== 32 || client.length !== 16) throw new Error("wrong key or id length");
  return sha256(concat(utf8(TRANSCRIPT_LABEL), new Uint8Array([0]), extPub, cofferPub, client));
}

/** The EFF large word list (words.txt: one word per line, 7776 lines). */
export function parseWordList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Four words: big-endian u32 number i of the transcript, modulo the list length. */
export function wordsOf(t: Uint8Array, list: string[]): string[] {
  if (list.length !== 7776) throw new Error("the word list must have 7776 words");
  const view = new DataView(t.buffer, t.byteOffset, t.byteLength);
  return [0, 1, 2, 3].map((i) => list[view.getUint32(4 * i, false) % list.length]);
}

/** HKDF-SHA256(salt = transcript, input = the X25519 secret, info = `coffer/v1/bridge-key`), 32 bytes. */
export async function bridgeKey(shared: Bytes, t: Bytes): Promise<Bytes> {
  const ikm = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: t, info: utf8(KEY_INFO) }, ikm, 256));
}

function hmacKey(key: Bytes): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** base64 HMAC-SHA256(key, `coffer/v1/pair-confirm` || 0x00 || transcript). */
export async function confirmOf(key: Bytes, t: Bytes): Promise<string> {
  return b64(new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(key), concat(utf8(CONFIRM_LABEL), new Uint8Array([0]), t))));
}

function macInput(kind: "req" | "res", client: string, body: string): Bytes {
  return concat(utf8(kind === "req" ? REQ_LABEL : RES_LABEL), new Uint8Array([0]), utf8(client), new Uint8Array([0]), utf8(body));
}

/** base64 HMAC-SHA256(key, `coffer/v1/req` (or `res`) || 0x00 || client || 0x00 || body). */
export async function signBody(key: Bytes, kind: "req" | "res", client: string, body: string): Promise<string> {
  return b64(new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(key), macInput(kind, client, body))));
}

/** Constant-time check (WebCrypto's HMAC verify). */
export async function verifyBody(key: Bytes, kind: "req" | "res", client: string, body: string, mac: string): Promise<boolean> {
  let tag: Bytes;
  try {
    tag = unb64(mac);
  } catch {
    return false;
  }
  return crypto.subtle.verify("HMAC", await hmacKey(key), tag, macInput(kind, client, body));
}

/** A new X25519 key pair for one pairing; the private key cannot leave WebCrypto. */
export async function newKeyPair(): Promise<{ privateKey: CryptoKey; pub: Bytes }> {
  const pair = (await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"])) as CryptoKeyPair;
  return { privateKey: pair.privateKey, pub: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)) };
}

/** The X25519 shared secret with Coffer's public key. */
export async function sharedSecret(privateKey: CryptoKey, peerPub: Bytes): Promise<Bytes> {
  const peer = await crypto.subtle.importKey("raw", peerPub, { name: "X25519" }, false, []);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: peer }, privateKey, 256));
}

/** A signed request envelope: `{id, client, body, mac}`. */
export async function signedRequest(key: Bytes, client: string, id: number, call: string, args: unknown, nonce: string, seq: number) {
  const body = JSON.stringify({ call, args, nonce, seq });
  return { id, client, body, mac: await signBody(key, "req", client, body) };
}

/** True when version a is newer than version b ("0.4.0" > "0.3.9"). */
export function newerVersion(a: string, b: string): boolean {
  const parts = (v: string) => v.split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

export type BrowserKind = "chrome" | "edge" | "chromium" | "other";

/** Which browser runs the extension, from navigator.userAgentData.brands. */
export function browserKind(brands: ReadonlyArray<{ brand: string }> | undefined): BrowserKind {
  const names = (brands ?? []).map((b) => b.brand);
  if (names.includes("Microsoft Edge")) return "edge";
  if (names.includes("Google Chrome")) return "chrome";
  if (names.includes("Chromium")) return "chromium";
  return "other";
}

/** The native host name in host.json, or Coffer's own. */
export function hostName(json: unknown): string {
  const h = json && typeof json === "object" && "host" in json ? (json as { host: unknown }).host : null;
  return typeof h === "string" && /^[a-z0-9_]+(\.[a-z0-9_]+)*$/.test(h) ? h : "dev.sampo.coffer";
}
