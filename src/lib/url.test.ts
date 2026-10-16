import { describe, expect, it } from "vitest";
import { upgradeUnsecuredUrls } from "./url";

describe("Use HTTPS", () => {
  it("changes only the flagged http:// URLs", () => {
    const urls = [
      { url: "http://forum.example.org/login", match: "host" },
      { url: "http://192.168.1.1", match: "host" },
      { url: "http://localhost:3000/admin", match: "host" },
      { url: "https://example.com", match: "host" },
      { url: "HTTP://shop.example.net", match: "host" },
    ];
    expect(upgradeUnsecuredUrls(urls).map((u) => u.url)).toEqual([
      "https://forum.example.org/login",
      "http://192.168.1.1",
      "http://localhost:3000/admin",
      "https://example.com",
      "https://shop.example.net",
    ]);
  });
  it("keeps the other properties of each URL", () => {
    expect(upgradeUnsecuredUrls([{ url: "http://a.example.org", match: "exact" }])[0]).toEqual({ url: "https://a.example.org", match: "exact" });
  });
});
