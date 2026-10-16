import { describe, expect, it } from "vitest";
import { charRuns, groupCode, hasTag, monogramHue, monogramLetters, relativeTime, tagTree } from "./format";

describe("format", () => {
  it("makes monogram letters", () => {
    expect(monogramLetters("GitHub")).toBe("GH");
    expect(monogramLetters("Netflix")).toBe("N");
    expect(monogramLetters("Bank of Scotland")).toBe("BS");
    expect(monogramLetters("")).toBe("?");
  });
  it("gives a stable hue", () => {
    expect(monogramHue("GitHub")).toBe(monogramHue("github"));
    expect(monogramHue("GitHub")).toBeGreaterThanOrEqual(0);
    expect(monogramHue("GitHub")).toBeLessThan(360);
  });
  it("groups codes", () => {
    expect(groupCode("123456")).toBe("123 456");
    expect(groupCode("12345678")).toBe("1234 5678");
    expect(groupCode("7XK2P")).toBe("7XK2P");
  });
  it("splits a password into character classes", () => {
    expect(charRuns("ab12$x")).toEqual([
      { cls: "letter", text: "ab" },
      { cls: "digit", text: "12" },
      { cls: "symbol", text: "$" },
      { cls: "letter", text: "x" },
    ]);
  });
  it("says relative times", () => {
    const now = Date.parse("2026-10-16T12:00:00Z");
    expect(relativeTime("2026-10-16T11:59:40Z", now)).toBe("just now");
    expect(relativeTime("2026-10-16T11:00:00Z", now)).toBe("1 hour ago");
    expect(relativeTime("2026-10-15T11:00:00Z", now)).toBe("yesterday");
    expect(relativeTime("2026-10-13T11:00:00Z", now)).toBe("3 days ago");
  });
  it("builds a nested tag tree with counts", () => {
    const tree = tagTree([["Work/Clients"], ["Work"], ["Home"], ["Work/Clients", "Work"]]);
    expect(tree.map((n) => [n.path, n.count])).toEqual([
      ["Home", 1],
      ["Work", 3],
    ]);
    expect(tree[1].children.map((n) => [n.path, n.count, n.depth])).toEqual([["Work/Clients", 2, 1]]);
    expect(hasTag(["Work/Clients"], "Work")).toBe(true);
    expect(hasTag(["Workshop"], "Work")).toBe(false);
  });
});
