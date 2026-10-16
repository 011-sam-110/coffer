import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, parseTotp, totpAt } from "./totp";

const ascii = (s: string): Uint8Array => new TextEncoder().encode(s);

// RFC 6238 appendix B: one seed per hash, 8 digits, period 30.
const SEEDS = {
  SHA1: "12345678901234567890",
  SHA256: "12345678901234567890123456789012",
  SHA512: "1234567890123456789012345678901234567890123456789012345678901234",
};
const VECTORS: Array<[number, string, string, string]> = [
  [59, "94287082", "46119246", "90693936"],
  [1111111109, "07081804", "68084774", "25091201"],
  [1111111111, "14050471", "67062674", "99943326"],
  [1234567890, "89005924", "91819424", "93441116"],
  [2000000000, "69279037", "90698825", "38618901"],
  [20000000000, "65353130", "77737706", "47863826"],
];

const uri = (alg: keyof typeof SEEDS) =>
  `otpauth://totp/RFC:test?secret=${base32Encode(ascii(SEEDS[alg]))}&algorithm=${alg}&digits=8&period=30&issuer=RFC`;

describe("TOTP (RFC 6238)", () => {
  it("matches the appendix B vectors for SHA-1, SHA-256 and SHA-512", async () => {
    const p1 = parseTotp(uri("SHA1"))!;
    const p256 = parseTotp(uri("SHA256"))!;
    const p512 = parseTotp(uri("SHA512"))!;
    expect(p1.algorithm).toBe("SHA-1");
    expect(p256.algorithm).toBe("SHA-256");
    expect(p512.algorithm).toBe("SHA-512");
    for (const [t, c1, c256, c512] of VECTORS) {
      expect((await totpAt(p1, t)).code).toBe(c1);
      expect((await totpAt(p256, t)).code).toBe(c256);
      expect((await totpAt(p512, t)).code).toBe(c512);
    }
  });

  it("reports the period and the seconds left", async () => {
    const p = parseTotp(uri("SHA1"))!;
    expect(await totpAt(p, 59)).toEqual({ code: "94287082", period: 30, remaining: 1 });
    expect((await totpAt(p, 60)).remaining).toBe(30);
    const p60 = parseTotp("otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&period=60")!;
    expect((await totpAt(p60, 75)).remaining).toBe(45);
  });

  it("reads bare base32 with spaces and lower case as SHA-1, 6 digits, 30 s", async () => {
    const p = parseTotp("jbsw y3dp ehpk 3pxp")!;
    expect(p).toMatchObject({ algorithm: "SHA-1", digits: 6, period: 30, steam: false });
    expect(base32Encode(p.secret)).toBe("JBSWY3DPEHPK3PXP");
    expect((await totpAt(p, 1_700_000_000)).code).toMatch(/^\d{6}$/);
  });

  it("parses the issuer and account from an otpauth URI", () => {
    expect(parseTotp("otpauth://totp/GitHub:alex%40example.com?secret=JBSWY3DPEHPK3PXP")).toMatchObject({ issuer: "GitHub", account: "alex@example.com" });
    expect(parseTotp("otpauth://totp/alex?secret=JBSWY3DPEHPK3PXP&issuer=Acme%20Corp")).toMatchObject({ issuer: "Acme Corp", account: "alex" });
  });

  it("refuses what is not a TOTP secret", () => {
    expect(parseTotp("")).toBeNull();
    expect(parseTotp("not a secret!")).toBeNull();
    expect(parseTotp("otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP&counter=1")).toBeNull();
    expect(parseTotp("otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=9")).toBeNull();
    expect(parseTotp("otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&algorithm=MD5")).toBeNull();
    expect(base32Decode("ABC1")).toBeNull();
  });

  it("makes 5-symbol Steam codes from steam://", async () => {
    const p = parseTotp("steam://MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43U")!;
    expect(p).toMatchObject({ steam: true, digits: 5, issuer: "Steam" });
    // Independent reference: raw Web Crypto HMAC and Steam's alphabet.
    const t = 1_700_000_000;
    const msg = new Uint8Array(8);
    new DataView(msg.buffer).setUint32(4, Math.floor(t / 30));
    const keyBytes = new Uint8Array(p.secret.length);
    keyBytes.set(p.secret);
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
    const mac = new DataView(await crypto.subtle.sign("HMAC", key, msg));
    const off = mac.getUint8(19) & 0x0f;
    let bin = mac.getUint32(off) & 0x7fffffff;
    const alphabet = "23456789BCDFGHJKMNPQRTVWXY";
    let expected = "";
    for (let i = 0; i < 5; i++) {
      expected += alphabet[bin % 26];
      bin = Math.floor(bin / 26);
    }
    expect((await totpAt(p, t)).code).toBe(expected);
    expect(parseTotp("otpauth://totp/Steam:alex?secret=MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43U&encoder=steam")).toMatchObject({ steam: true, digits: 5 });
  });

  it("round-trips base32", () => {
    const b = ascii("any carnal pleas");
    expect(base32Decode(base32Encode(b))).toEqual(b);
    expect(base32Encode(ascii("foobar"))).toBe("MZXW6YTBOI");
  });
});
