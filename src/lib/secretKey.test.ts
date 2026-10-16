import { describe, expect, it } from "vitest";
import { badSecretKeyChar, lastSecretKeyGroup, normalizeSecretKey, secretKeyBody, secretKeyCharMessage } from "./secretKey";

describe("secret key normalising", () => {
  const key = "C1-7HQ2KM-X4P9RA-BCDEFG-HJKLM-NPQRS-TVWX2";
  it("adds a missing C1 and the hyphens, and upper-cases", () => {
    expect(normalizeSecretKey(key)).toBe(key);
    expect(normalizeSecretKey("7hq2km x4p9ra bcdefg hjklm npqrs tvwx2")).toBe(key);
    expect(normalizeSecretKey("c17HQ2KMX4P9RABCDEFGHJKLMNPQRSTVWX2")).toBe(key);
    expect(normalizeSecretKey(" 7HQ2KM-X4P9RA-BCDEFG-HJKLM-NPQRS-TVWX2 ")).toBe(key);
  });
  it("sends a key of the wrong length with C1, so Rust counts the symbols", () => {
    expect(normalizeSecretKey("7hq2km-x4p9")).toBe("C1-7HQ2KMX4P9");
  });
  it("reads the last group: 5 symbols", () => {
    expect(lastSecretKeyGroup(key)).toBe("TVWX2");
  });
  it("a glued C1 is the prefix, not a bad 1", () => {
    expect(badSecretKeyChar("C17HQ2KM")).toBeNull();
  });
});

describe("secret key input", () => {
  it("ignores the C1 prefix, case, spaces and dashes", () => {
    expect(secretKeyBody("c1-7hq2km-x4p9r abcde")).toBe("7HQ2KMX4P9RABCDE");
    expect(badSecretKeyChar("C1-7HQ2KM-X4P9R")).toBeNull();
  });
  it("flags a character outside the alphabet at once", () => {
    expect(badSecretKeyChar("C1-7HQ2KM-X4P0R")).toBe("0");
    expect(badSecretKeyChar("7hq2km-uuuuu")).toBe("U");
    expect(secretKeyCharMessage("C1-ABCDE-1")).toMatch(/not in a Secret Key: 1/);
    expect(secretKeyCharMessage("C1-ABCDE")).toBeNull();
  });
});
