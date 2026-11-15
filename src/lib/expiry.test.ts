import { describe, expect, it } from "vitest";
import type { ItemSummary } from "./contract";
import { badgeText, bannerText, daysLeft, expiryDate } from "./expiry";
import { flagChip } from "../main/vault/ItemList";

// 15 Nov 2026, mid-morning, on the PC's own clock.
const NOW = new Date(2026, 10, 15, 10, 30);

describe("days left", () => {
  it("counts whole days on the PC's calendar", () => {
    expect(daysLeft("2026-12-30", NOW)).toBe(45);
    expect(daysLeft("2026-11-16", NOW)).toBe(1);
    expect(daysLeft("2026-11-15", NOW)).toBe(0);
    expect(daysLeft("2026-11-12", NOW)).toBe(-3);
    expect(daysLeft("2026-11-16", new Date(2026, 10, 15, 23, 59))).toBe(1);
    expect(daysLeft("not a date", NOW)).toBeNaN();
  });

  it("words the list badge", () => {
    expect(badgeText(45)).toBe("45 days");
    expect(badgeText(1)).toBe("1 day");
    expect(badgeText(0)).toBe("Expires today");
    expect(badgeText(-3)).toBe("Expired");
  });

  it("words the item banner", () => {
    expect(bannerText("apiCredential", "2026-12-30", NOW)).toBe("This key expires in 45 days, on 30 Dec 2026.");
    expect(bannerText("apiCredential", "2026-11-16", NOW)).toBe("This key expires in 1 day, on 16 Nov 2026.");
    expect(bannerText("apiCredential", "2026-11-15", NOW)).toBe("This key expires today, 15 Nov 2026.");
    expect(bannerText("apiCredential", "2026-11-12", NOW)).toBe("This key expired 3 days ago, on 12 Nov 2026.");
    expect(bannerText("card", "2026-11-30", NOW)).toBe("This item expires in 15 days, on 30 Nov 2026.");
    expect(bannerText("document", "2027-01-01", NOW)).toBe("This item expires in 47 days, on 1 Jan 2027.");
  });

  it("reads each type's expiry the way Rust does", () => {
    expect(expiryDate("apiCredential", "2026-12-30")).toBe("2026-12-30");
    expect(expiryDate("document", " 2027-06-01 ")).toBe("2027-06-01");
    expect(expiryDate("card", "2027-02")).toBe("2027-02-28");
    expect(expiryDate("card", "2028-02")).toBe("2028-02-29");
    expect(expiryDate("apiCredential", "2026-02-30")).toBeNull();
    expect(expiryDate("card", "2027-13")).toBeNull();
    expect(expiryDate("apiCredential", "")).toBeNull();
  });
});

describe("the list badge of an expiring item", () => {
  const row = (expiresOn: string | null, expiring = true): ItemSummary => ({
    id: "k",
    type: "apiCredential",
    title: "Stripe",
    subtitle: "api.stripe.com",
    favorite: false,
    tags: [],
    state: "active",
    updatedAt: "2026-10-01T00:00:00Z",
    lastUsedAt: null,
    urlHost: null,
    hasTotp: false,
    expiresOn,
    flags: { weak: false, reused: false, breached: false, unsecured: false, expiring },
  });

  it("shows the days left in place of Expiring", () => {
    expect(flagChip(row("2026-12-30"), NOW)).toMatchObject({ word: "45 days", danger: false, tab: "expiring" });
    expect(flagChip(row("2026-11-15"), NOW)).toMatchObject({ word: "Expires today", danger: false });
    expect(flagChip(row("2026-11-12"), NOW)).toMatchObject({ word: "Expired", danger: true });
  });

  it("shows no badge outside the Health window, and the old word without a date", () => {
    expect(flagChip(row("2027-12-30", false), NOW)).toBeNull();
    expect(flagChip(row(null), NOW)).toMatchObject({ word: "Expiring" });
  });
});
