// Secret Key text form (SPEC 3.2, v3), the same rules the Rust core uses.
//
//   C1-AAAAAA-XXXXXX-XXXXXX-XXXXX-XXXXX-XXXXK
//
// Alphabet: 23456789ABCDEFGHJKLMNPQRSTVWXYZ (31 symbols, values 0..30 in this
// order; no 0, 1, I, O or U).
//   C1      literal format prefix (not alphabet symbols)
//   AAAAAA  key id: 6 random symbols, made with the key, NOT derived from it, not secret
//   26 secret symbols: one big-endian base-31 integer below 2^128 (16 random bytes)
//   K       check symbol: c = (sum of w_i * v_i for i = 1..32) mod 31 over the 32
//           symbols of key id and secret, with w_i = ((i - 1) mod 30) + 1 (SPEC v4:
//           no weight is 0 mod 31, so every single-symbol error is caught; swaps of
//           positions 1 and 31, and 2 and 32, are not)
// After "C1" the 33 symbols are printed in groups of 6-6-6-5-5-5.
//
// Parse: drop spaces and dashes, upper-case, require C1, then exactly 33 alphabet symbols.

export const SECRET_KEY_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTVWXYZ";
export const KEY_ID_LENGTH = 6;
export const SECRET_SYMBOLS = 26;
/** Group sizes of the 33 symbols after "C1": id, then 26 secret + 1 check. */
export const SECRET_KEY_GROUPS = [6, 6, 6, 5, 5, 5];

const BASE = BigInt(31);
const LIMIT = BigInt(1) << BigInt(128);

const valueOf = (ch: string): number => SECRET_KEY_ALPHABET.indexOf(ch);

/** Weight of the symbol at 1-based position i: ((i - 1) mod 30) + 1. */
export const checkWeight = (i: number): number => ((i - 1) % 30) + 1;

/** The check symbol over the 32 symbols of key id + secret. */
export function checkSymbol(idAndSecret: string): string {
  let sum = 0;
  for (let i = 0; i < idAndSecret.length; i++) sum += checkWeight(i + 1) * valueOf(idAndSecret[i]);
  return SECRET_KEY_ALPHABET[sum % 31];
}

/** 16 bytes -> 26 base-31 symbols, big-endian, zero-padded. */
export function encodeSecret(bytes: Uint8Array): string {
  let n = BigInt(0);
  for (const b of bytes) n = (n << BigInt(8)) | BigInt(b);
  let out = "";
  for (let i = 0; i < SECRET_SYMBOLS; i++) {
    out = SECRET_KEY_ALPHABET[Number(n % BASE)] + out;
    n /= BASE;
  }
  return out;
}

/** 26 base-31 symbols -> the integer, or null when it is 2^128 or more. */
export function decodeSecret(secret: string): bigint | null {
  let n = BigInt(0);
  for (const ch of secret) n = n * BASE + BigInt(valueOf(ch));
  return n < LIMIT ? n : null;
}

/** Print a key id and 26 secret symbols (check symbol added) in the display grouping. */
export function formatSecretKey(keyId: string, secret: string): string {
  const body = keyId + secret;
  const all = body + checkSymbol(body);
  const groups: string[] = [];
  let pos = 0;
  for (const size of SECRET_KEY_GROUPS) {
    groups.push(all.slice(pos, pos + size));
    pos += size;
  }
  return ["C1", ...groups].join("-");
}

export interface ParsedSecretKey {
  valid: boolean;
  keyId: string | null;
  /** The canonical text form when valid. */
  canonical: string | null;
  reason: "ok" | "badPrefix" | "badCharacter" | "badLength" | "badCheck" | "outOfRange";
}

/** Parse what a person typed: any case, with or without spaces and dashes. */
export function parseSecretKey(input: string): ParsedSecretKey {
  const fail = (reason: ParsedSecretKey["reason"]): ParsedSecretKey => ({ valid: false, keyId: null, canonical: null, reason });
  const s = (input ?? "").replace(/[\s\-‐-―]+/g, "").toUpperCase();
  if (!s.startsWith("C1")) return fail("badPrefix");
  const rest = s.slice(2);
  for (const ch of rest) if (valueOf(ch) < 0) return fail("badCharacter");
  if (rest.length !== KEY_ID_LENGTH + SECRET_SYMBOLS + 1) return fail("badLength");
  const body = rest.slice(0, KEY_ID_LENGTH + SECRET_SYMBOLS);
  if (checkSymbol(body) !== rest[rest.length - 1]) return fail("badCheck");
  const secret = body.slice(KEY_ID_LENGTH);
  if (decodeSecret(secret) === null) return fail("outOfRange");
  const keyId = body.slice(0, KEY_ID_LENGTH);
  return { valid: true, keyId, canonical: formatSecretKey(keyId, secret), reason: "ok" };
}

/** A new Secret Key from 16 random bytes and 6 random id symbols. */
export function generateSecretKey(): { keyId: string; secretKey: string } {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const idVals = new Uint8Array(KEY_ID_LENGTH);
  let keyId = "";
  // Rejection sampling: a byte is used only below 248 (8 x 31), so each symbol is uniform.
  while (keyId.length < KEY_ID_LENGTH) {
    crypto.getRandomValues(idVals);
    for (const v of idVals) if (v < 248 && keyId.length < KEY_ID_LENGTH) keyId += SECRET_KEY_ALPHABET[v % 31];
  }
  return { keyId, secretKey: formatSecretKey(keyId, encodeSecret(bytes)) };
}

/** The demo vault's fixed Secret Key, so a tester can type it (?needsKey=1, vault_open). DEMO ONLY. */
export const DEMO_KEY_ID = "DEMKEY";
export const DEMO_SECRET_KEY = formatSecretKey(DEMO_KEY_ID, "7Q4KM2XWPRT9HC6NBZ3VJ8FL5D");
