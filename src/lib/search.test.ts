import { describe, expect, it } from "vitest";
import type { ItemSummary } from "./contract";
import { queryTier, recentlyUsed, searchItems, sortItems, Tier } from "./search";

const flags = { weak: false, reused: false, breached: false, unsecured: false, expiring: false };
let n = 0;
const item = (title: string, extra: Partial<ItemSummary> = {}): ItemSummary => ({
  id: `i${n++}`,
  type: "login",
  title,
  subtitle: "",
  favorite: false,
  tags: [],
  state: "active",
  updatedAt: "2026-10-01T00:00:00Z",
  lastUsedAt: null,
  urlHost: null,
  hasTotp: false,
  flags,
  ...extra,
});

describe("queryTier", () => {
  it("ranks a title prefix first", () => {
    expect(queryTier(item("GitHub"), "git")).toBe(Tier.TitlePrefix);
  });
  it("ranks a word prefix second, in title, username, host or tag", () => {
    expect(queryTier(item("Old GitHub"), "git")).toBe(Tier.WordPrefix);
    expect(queryTier(item("Work mail", { subtitle: "alex@example.com" }), "exam")).toBe(Tier.WordPrefix);
    expect(queryTier(item("Mail", { urlHost: "mail.google.com" }), "goo")).toBe(Tier.WordPrefix);
    expect(queryTier(item("Mail", { tags: ["Work/Clients"] }), "clie")).toBe(Tier.WordPrefix);
  });
  it("ranks a substring third", () => {
    expect(queryTier(item("Bitbucket"), "buck")).toBe(Tier.Substring);
  });
  it("needs every term to match", () => {
    expect(queryTier(item("GitHub", { subtitle: "alex@example.com" }), "git alex")).toBe(Tier.WordPrefix);
    expect(queryTier(item("GitHub"), "git zebra")).toBeNull();
  });
  it("ignores case and accents", () => {
    expect(queryTier(item("Café Nero"), "CAFE")).toBe(Tier.TitlePrefix);
  });
  it("returns null for an empty query", () => {
    expect(queryTier(item("GitHub"), "   ")).toBeNull();
  });
});

describe("searchItems", () => {
  it("orders by tier, then recent use, then title", () => {
    const a = item("Gitlab");
    const b = item("GitHub", { lastUsedAt: "2026-10-15T10:00:00Z" });
    const c = item("My git server");
    const d = item("Digital ocean");
    const e = item("Gitea", { lastUsedAt: "2026-10-10T10:00:00Z" });
    const r = searchItems([a, b, c, d, e], "git");
    expect(r.matches.map((i) => i.title)).toEqual(["GitHub", "Gitea", "Gitlab", "My git server", "Digital ocean"]);
  });
  it("counts archived and trashed matches instead of listing them", () => {
    const r = searchItems([item("GitHub"), item("Git old", { state: "archived" }), item("Git bin", { state: "trashed" })], "git");
    expect(r.matches).toHaveLength(1);
    expect(r.hiddenCount).toBe(2);
  });
});

describe("recentlyUsed and sortItems", () => {
  it("lists active items by last use", () => {
    const list = [
      item("A", { lastUsedAt: "2026-10-01T00:00:00Z" }),
      item("B", { lastUsedAt: "2026-10-03T00:00:00Z" }),
      item("C"),
      item("D", { lastUsedAt: "2026-10-04T00:00:00Z", state: "trashed" }),
    ];
    expect(recentlyUsed(list).map((i) => i.title)).toEqual(["B", "A"]);
  });
  it("sorts by title, updated and last used", () => {
    const list = [
      item("b", { updatedAt: "2026-01-01T00:00:00Z" }),
      item("A", { updatedAt: "2026-05-01T00:00:00Z", lastUsedAt: "2026-01-01T00:00:00Z" }),
    ];
    expect(sortItems(list, "title").map((i) => i.title)).toEqual(["A", "b"]);
    expect(sortItems(list, "updated").map((i) => i.title)).toEqual(["A", "b"]);
    expect(sortItems(list, "lastUsed").map((i) => i.title)).toEqual(["A", "b"]);
  });
});
