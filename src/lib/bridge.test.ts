import { describe, expect, it } from "vitest";
import { browserRows, connectedLine, pairWords } from "./bridge";
import type { BridgeInfo, BrowserLink } from "./contract";

const chrome: BrowserLink = { id: "a".repeat(32), browser: "chrome", name: "Chrome", pairedAt: "2026-11-15T09:00:00Z", lastUsedAt: "2026-11-15T11:58:00Z" };
const info = (browsers: BrowserLink[]): BridgeInfo => ({ browsers, extensionFolder: "C:\\x\\extension", extensionFound: true, pending: null });

describe("Settings > Browsers", () => {
  it("lists connected browsers and a Not connected row for Chrome and Edge", () => {
    expect(browserRows(info([])).map((r) => [r.name, !!r.link])).toEqual([
      ["Chrome", false],
      ["Microsoft Edge", false],
    ]);
    expect(browserRows(info([chrome])).map((r) => [r.name, !!r.link])).toEqual([
      ["Chrome", true],
      ["Microsoft Edge", false],
    ]);
    const chromium: BrowserLink = { ...chrome, id: "b".repeat(32), browser: "chromium", name: "Chromium" };
    expect(browserRows(info([chromium])).map((r) => r.name)).toEqual(["Chromium", "Chrome", "Microsoft Edge"]);
    expect(browserRows(null)).toHaveLength(2);
  });

  it("says when a browser connected and when it was last used", () => {
    const now = Date.parse("2026-11-15T12:00:00Z");
    expect(connectedLine(chrome, now)).toBe("Connected on 15 Nov 2026. Last used 2 minutes ago.");
    expect(connectedLine({ ...chrome, lastUsedAt: null }, now)).toBe("Connected on 15 Nov 2026.");
  });

  it("shows the four words with dots", () => {
    expect(pairWords({ words: ["maple", "river", "otter", "lamp"] })).toBe("maple · river · otter · lamp");
  });
});
