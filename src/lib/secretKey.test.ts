import { describe, expect, it } from "vitest";
import { badSecretKeyChar, secretKeyBody, secretKeyCharMessage } from "./secretKey";

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
