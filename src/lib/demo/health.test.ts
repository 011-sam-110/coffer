import { describe, expect, it } from "vitest";
import { computeHealth, isPrivateHost, isUnsecuredUrl } from "./health";
import type { StoredItem } from "./model";
import { seedItems } from "./seed";

const NOW = Date.UTC(2026, 9, 16, 8, 0, 0);
const DAY = 86_400_000;

function report(items: StoredItem[], checked: boolean) {
  return computeHealth({ items, now: NOW, breachCheckedAt: checked ? new Date(NOW - DAY).toISOString() : null, breachCheck: "manual" });
}

const byTitle = (items: StoredItem[], title: string) => items.find((i) => i.title === title)!;

describe("health on the demo vault (SPEC 7)", () => {
  it("counts 19 passwords and shows the score with its formula", () => {
    const items = seedItems(NOW);
    const before = report(items, false).report;
    expect(before.total).toBe(19);
    expect(before.healthy).toBe(14);
    expect(before.score).toBe(Math.floor((100 * 14) / 19));
    expect(before.formula).toBe("14 of 19 passwords are not breached, reused or weak");
    expect(before.counts).toEqual({ breached: 0, reused: 3, weak: 2, duplicate: 2, unsecured: 1, old: 1, expiring: 3 });
    expect(before.excludedCount).toBe(1);

    const after = report(items, true).report;
    expect(after.counts.breached).toBe(1);
    expect(after.healthy).toBe(13);
    expect(after.score).toBe(68);
    expect(after.formula).toBe("13 of 19 passwords are not breached, reused or weak");
  });

  it("finds the right items for each check", () => {
    const items = seedItems(NOW);
    const { report: r, flags } = report(items, true);
    const titles = (check: string) =>
      r.findings
        .filter((f) => f.check === check)
        .map((f) => items.find((i) => i.id === f.itemId)!.title)
        .sort();
    expect(titles("reused")).toEqual(["Amazon", "Netflix", "Spotify"]);
    expect(titles("weak")).toEqual(["Dropbox", "Figma"]);
    expect(titles("duplicate")).toEqual(["LinkedIn", "LinkedIn (old entry)"]);
    expect(titles("unsecured")).toEqual(["Retro Computing Forum"]);
    expect(titles("old")).toEqual(["Stripe Dashboard"]);
    expect(titles("expiring")).toEqual(["Passport", "Stripe API key (test mode)", "Visa Debit"]);
    expect(titles("breached")).toEqual(["Retro Computing Forum"]);
    // One group id for the three reused items; details are words, never values.
    const reused = r.findings.filter((f) => f.check === "reused");
    expect(new Set(reused.map((f) => f.groupId)).size).toBe(1);
    expect(reused[0].detail).toBe("Used in 3 items");
    expect(r.findings.find((f) => f.check === "breached")!.detail).toMatch(/^Found [\d,]+ times in breaches$/);
    expect(r.findings.find((f) => f.check === "unsecured")!.detail).toBe("Uses http://forum.example.org (not encrypted)");
    for (const f of r.findings) {
      const item = items.find((i) => i.id === f.itemId)!;
      for (const field of item.fields) if (field.value.length >= 6 && field.kind === "concealed") expect(f.detail).not.toContain(field.value);
    }
    // Flags follow the findings; archived, trashed and excluded items have none.
    expect(flags.get(byTitle(items, "Retro Computing Forum").id)).toMatchObject({ breached: true, unsecured: true });
    expect(flags.get(byTitle(items, "Visa Debit").id)).toMatchObject({ expiring: true });
    for (const t of ["Yahoo Mail", "Dribbble", "Staging test account"]) {
      expect(Object.values(flags.get(byTitle(items, t).id)!).some(Boolean)).toBe(false);
    }
  });

  it("drops an excluded item from the total and the findings", () => {
    const items = seedItems(NOW);
    byTitle(items, "Figma").healthExcluded = true;
    const r = report(items, true).report;
    expect(r.total).toBe(18);
    expect(r.counts.weak).toBe(1);
    expect(r.excludedCount).toBe(2);
    expect(r.score).toBe(Math.floor((100 * 13) / 18));
  });

  it("shows no score under 5 passwords and an empty vault reads 0 of 0", () => {
    const items = seedItems(NOW).filter((i) => ["GitHub", "Google", "Slack", "Steam"].includes(i.title));
    expect(report(items, true).report).toMatchObject({ score: null, total: 4, healthy: 4 });
    expect(report([], false).report).toMatchObject({ score: null, total: 0, formula: "0 of 0 passwords are not breached, reused or weak" });
  });

  it("does not count reuse between duplicates, or with archived items", () => {
    const items = seedItems(NOW);
    // Archive Netflix and Spotify: Amazon's password is now in one active item only.
    byTitle(items, "Netflix").state = "archived";
    byTitle(items, "Spotify").state = "trashed";
    expect(report(items, false).report.counts.reused).toBe(0);
  });

  it("treats localhost and private addresses as not unsecured", () => {
    for (const h of ["localhost", "127.0.0.1", "10.0.0.5", "172.16.4.1", "172.31.255.255", "192.168.1.1", "169.254.1.1", "nas.local", "::1", "fd12:3456::1"]) {
      expect(isPrivateHost(h)).toBe(true);
    }
    for (const h of ["example.org", "172.32.0.1", "8.8.8.8", "192.169.0.1"]) expect(isPrivateHost(h)).toBe(false);
    expect(isUnsecuredUrl("http://forum.example.org/login")).toBe(true);
    expect(isUnsecuredUrl("https://forum.example.org")).toBe(false);
    expect(isUnsecuredUrl("http://192.168.1.1")).toBe(false);
    expect(isUnsecuredUrl("http://localhost:3000")).toBe(false);
  });

  it("marks cards 60 days, passports 300 days, other documents and API credentials 90 days ahead", () => {
    const items = seedItems(NOW);
    const ymd = (days: number) => new Date(NOW + days * DAY).toISOString().slice(0, 10);
    const set = (title: string, role: string, value: string) => (byTitle(items, title).fields.find((f) => f.builtin === role)!.value = value);
    set("Passport", "expires", ymd(310));
    set("Driving licence", "expires", ymd(80));
    set("Stripe API key (test mode)", "expires", ymd(100));
    set("Mastercard Credit", "expiry", new Date(NOW - 40 * DAY).toISOString().slice(0, 7));
    const r = report(items, false).report;
    const exp = r.findings.filter((f) => f.check === "expiring");
    const titleOf = (id: string) => items.find((i) => i.id === id)!.title;
    expect(exp.map((f) => titleOf(f.itemId)).sort()).toEqual(["Driving licence", "Mastercard Credit", "Visa Debit"]);
    expect(exp.find((f) => titleOf(f.itemId) === "Mastercard Credit")!.detail).toMatch(/^Expired \d{4}-\d{2}$/);
  });
});
