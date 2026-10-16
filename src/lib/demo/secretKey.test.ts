import { describe, expect, it } from "vitest";
import {
  DEMO_KEY_ID,
  DEMO_SECRET_KEY,
  SECRET_KEY_ALPHABET,
  checkSymbol,
  checkWeight,
  decodeSecret,
  encodeSecret,
  formatSecretKey,
  generateSecretKey,
  parseSecretKey,
} from "./secretKey";

const A = `[${SECRET_KEY_ALPHABET}]`;
// C1-AAAAAA-XXXXXX-XXXXXX-XXXXX-XXXXX-XXXXK
const FORMAT = new RegExp(`^C1-${A}{6}-${A}{6}-${A}{6}-${A}{5}-${A}{5}-${A}{5}$`);
const symbolsOf = (key: string) => key.replace(/-/g, "").slice(2); // 33 symbols after C1

describe("Secret Key (SPEC 3.2 v4)", () => {
  it("uses the 31-symbol alphabet with no 0, 1, I, O or U", () => {
    expect(SECRET_KEY_ALPHABET).toHaveLength(31);
    expect(new Set(SECRET_KEY_ALPHABET).size).toBe(31);
    for (const ch of "01IOU") expect(SECRET_KEY_ALPHABET).not.toContain(ch);
  });

  it("generates keys in the C1-6-6-6-5-5-5 form that validate", () => {
    for (let n = 0; n < 50; n++) {
      const { keyId, secretKey } = generateSecretKey();
      expect(secretKey).toMatch(FORMAT);
      expect(symbolsOf(secretKey)).toHaveLength(33);
      expect(secretKey.slice(3, 9)).toBe(keyId);
      expect(parseSecretKey(secretKey)).toMatchObject({ valid: true, keyId, canonical: secretKey });
    }
    expect(parseSecretKey(DEMO_SECRET_KEY)).toMatchObject({ valid: true, keyId: DEMO_KEY_ID });
  });

  it("uses weights ((i - 1) mod 30) + 1 over key id and secret", () => {
    expect([1, 2, 30, 31, 32].map(checkWeight)).toEqual([1, 2, 30, 1, 2]);
    const body = "23456789ABCDEFGHJKLMNPQRSTVWXYZ2"; // 32 symbols, values 0..30 then 0
    let sum = 0;
    for (let i = 1; i <= 32; i++) sum += checkWeight(i) * SECRET_KEY_ALPHABET.indexOf(body[i - 1]);
    expect(checkSymbol(body)).toBe(SECRET_KEY_ALPHABET[sum % 31]);
    // The key id is covered: another id gives another check symbol here.
    const secret = "7Q4KM2XWPRT9HC6NBZ3VJ8FL5D";
    expect(formatSecretKey("AAAAAA", secret).slice(-1)).not.toBe(formatSecretKey("BAAAAA", secret).slice(-1));
  });

  it("ignores case, spaces and dashes but requires the C1 prefix", () => {
    const { keyId, secretKey } = generateSecretKey();
    const bare = secretKey.replace(/-/g, "");
    for (const input of [secretKey.toLowerCase(), bare, ` ${secretKey.replace(/-/g, " ")} `, `c1${bare.slice(2).toLowerCase()}`]) {
      expect(parseSecretKey(input)).toMatchObject({ valid: true, keyId });
    }
    expect(parseSecretKey(bare.slice(2))).toMatchObject({ valid: false, reason: "badPrefix" });
  });

  it("catches every one-symbol typo in the key id, the secret and the check symbol", () => {
    const { secretKey } = generateSecretKey();
    const syms = symbolsOf(secretKey);
    for (let pos = 0; pos < syms.length; pos++) {
      for (const sub of SECRET_KEY_ALPHABET) {
        if (sub === syms[pos]) continue;
        const typo = `C1${syms.slice(0, pos)}${sub}${syms.slice(pos + 1)}`;
        expect(parseSecretKey(typo).valid).toBe(false);
      }
    }
  });

  it("catches a swap of two different symbols, except positions 1 and 31, and 2 and 32", () => {
    const { secretKey } = generateSecretKey();
    const syms = symbolsOf(secretKey).slice(0, 32).split("");
    const check = symbolsOf(secretKey)[32];
    for (let i = 0; i < 32; i++) {
      for (let j = i + 1; j < 32; j++) {
        if (syms[i] === syms[j]) continue;
        const s = [...syms];
        [s[i], s[j]] = [s[j], s[i]];
        const blind = (i === 0 && j === 30) || (i === 1 && j === 31);
        const p = parseSecretKey(`C1${s.join("")}${check}`);
        if (!blind) expect(p.valid).toBe(false);
        else expect(p.reason).not.toBe("badCheck"); // same weight: the check symbol cannot see it
      }
    }
  });

  it("rejects characters outside the alphabet, wrong lengths and values of 2^128 or more", () => {
    const { secretKey } = generateSecretKey();
    expect(parseSecretKey(secretKey.slice(0, -2) + "0A")).toMatchObject({ valid: false, reason: "badCharacter" });
    expect(parseSecretKey(secretKey.slice(0, -1))).toMatchObject({ valid: false, reason: "badLength" });
    const max = "Z".repeat(26); // 31^26 - 1 > 2^128
    expect(parseSecretKey(formatSecretKey("AAAAAA", max))).toMatchObject({ valid: false, reason: "outOfRange" });
    expect(parseSecretKey("")).toMatchObject({ valid: false });
  });

  it("encodes 16 bytes as 26 base-31 symbols and back", () => {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const s = encodeSecret(bytes);
    expect(s).toHaveLength(26);
    let n = BigInt(0);
    for (const b of bytes) n = (n << BigInt(8)) | BigInt(b);
    expect(decodeSecret(s)).toBe(n);
    expect(encodeSecret(new Uint8Array(16))).toBe("2".repeat(26));
    expect(decodeSecret(encodeSecret(new Uint8Array(16).fill(255)))).toBe((BigInt(1) << BigInt(128)) - BigInt(1));
  });
});
