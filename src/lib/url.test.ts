import { describe, expect, it } from "vitest";
import { siteFromName, upgradeUnsecuredUrls } from "./url";

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

describe("siteFromName", () => {
  it.each([
    ["github.com", "https://github.com"],
    ["GitHub.com", "https://github.com"],
    ["https://github.com/login", "https://github.com"],
    ["http://example.org/path?q=1", "https://example.org"],
    ["accounts.google.com", "https://accounts.google.com"],
    ["www.netflix.com", "https://www.netflix.com"],
    ["bbc.co.uk", "https://bbc.co.uk"],
    ["web.dev", "https://web.dev"],
    ["  stripe.com  ", "https://stripe.com"],
    ["github.com.", "https://github.com"],
  ])("%s reads as %s", (name, site) => {
    expect(siteFromName(name)).toBe(site);
  });

  it.each(["GitHub", "Node.js", "v1.2", "Home router", "Vue.js", "1.2.3", "alex@example.com", "my site.com", "", "localhost", "intranet.corp", "-bad.com", "a..com"])(
    "%s is not a web address",
    (name) => {
      expect(siteFromName(name)).toBeNull();
    },
  );
});
