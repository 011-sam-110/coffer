// RFC 6238 TOTP with Web Crypto (SPEC 6). Accepts otpauth://totp URIs, bare
// base32 secrets (spaces and lower case allowed) and steam://<secret>.

export type TotpAlgorithm = "SHA-1" | "SHA-256" | "SHA-512";

export interface TotpParams {
  secret: Uint8Array;
  algorithm: TotpAlgorithm;
  digits: number; // 6..8, or 5 for Steam
  period: number; // seconds
  steam: boolean;
  issuer: string | null;
  account: string | null;
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEAM_ALPHABET = "23456789BCDFGHJKMNPQRTVWXY";

/** RFC 4648 base32 decode. Ignores spaces, dashes, padding and case. Null when invalid. */
export function base32Decode(input: string): Uint8Array | null {
  const s = input.toUpperCase().replace(/[\s-]+/g, "").replace(/=+$/, "");
  if (s.length === 0) return null;
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s) {
    const v = B32.indexOf(ch);
    if (v < 0) return null;
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  if (out.length === 0) return null;
  const bytes = new Uint8Array(out.length);
  bytes.set(out);
  return bytes;
}

/** RFC 4648 base32 encode without padding (used by tests and the importer). */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32[(value >>> bits) & 31];
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function algorithmOf(name: string | null): TotpAlgorithm | null {
  const n = (name ?? "SHA1").toUpperCase().replace("-", "");
  if (n === "SHA1") return "SHA-1";
  if (n === "SHA256") return "SHA-256";
  if (n === "SHA512") return "SHA-512";
  return null;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Parse what a person pasted. Null when it is not a usable TOTP secret. */
export function parseTotp(input: string): TotpParams | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();

  if (lower.startsWith("steam://")) {
    const secret = base32Decode(raw.slice("steam://".length));
    return secret ? { secret, algorithm: "SHA-1", digits: 5, period: 30, steam: true, issuer: "Steam", account: null } : null;
  }

  if (lower.startsWith("otpauth://")) {
    // otpauth://totp/Issuer:account?secret=...&issuer=...&algorithm=...&digits=...&period=...
    const m = /^otpauth:\/\/([^/?#]+)\/([^?#]*)(?:\?([^#]*))?/i.exec(raw);
    if (!m || m[1].toLowerCase() !== "totp") return null;
    const label = safeDecode(m[2]);
    const params = new URLSearchParams(m[3] ?? "");
    const secret = base32Decode(params.get("secret") ?? "");
    if (!secret) return null;
    const algorithm = algorithmOf(params.get("algorithm"));
    if (!algorithm) return null;
    const steam = (params.get("encoder") ?? "").toLowerCase() === "steam";
    const digits = steam ? 5 : Number(params.get("digits") ?? "6");
    if (!steam && (!Number.isInteger(digits) || digits < 6 || digits > 8)) return null;
    const period = Number(params.get("period") ?? "30");
    if (!Number.isInteger(period) || period < 1 || period > 300) return null;
    const colon = label.indexOf(":");
    const labelIssuer = colon >= 0 ? label.slice(0, colon).trim() : null;
    const account = (colon >= 0 ? label.slice(colon + 1) : label).trim() || null;
    const issuer = params.get("issuer")?.trim() || labelIssuer || (steam ? "Steam" : null);
    return { secret, algorithm, digits, period, steam, issuer, account };
  }

  const secret = base32Decode(raw);
  return secret ? { secret, algorithm: "SHA-1", digits: 6, period: 30, steam: false, issuer: null, account: null } : null;
}

/** HOTP value (RFC 4226) for one counter. */
async function hotp(p: TotpParams, counter: number): Promise<string> {
  const msg = new Uint8Array(8);
  // Counter as a 64-bit big-endian integer (safe up to 2^53).
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    msg[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  const keyBytes = new Uint8Array(p.secret.length);
  keyBytes.set(p.secret);
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: p.algorithm }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const off = mac[mac.length - 1] & 0x0f;
  let bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  if (p.steam) {
    let code = "";
    for (let i = 0; i < 5; i++) {
      code += STEAM_ALPHABET[bin % STEAM_ALPHABET.length];
      bin = Math.floor(bin / STEAM_ALPHABET.length);
    }
    return code;
  }
  return String(bin % 10 ** p.digits).padStart(p.digits, "0");
}

/** The code at a Unix time in seconds, with the seconds left in its period. */
export async function totpAt(p: TotpParams, unixSeconds: number): Promise<{ code: string; period: number; remaining: number }> {
  const t = Math.floor(unixSeconds);
  const code = await hotp(p, Math.floor(t / p.period));
  return { code, period: p.period, remaining: p.period - (t % p.period) };
}
