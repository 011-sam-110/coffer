// Days left before an item expires: the list badge and the item banner.
// Rust and the demo send the date (ItemSummary.expiresOn); Health decides
// which items are flagged (cards 60 days, passports 300, others 90).
import type { ItemType } from "./contract";
import { formatDate } from "./format";

const DAY = 86_400_000;

/** The built-in field that holds the expiry of a type, or null. */
export function expiryRole(type: ItemType): string | null {
  if (type === "card") return "expiry";
  if (type === "document" || type === "apiCredential") return "expires";
  return null;
}

/** "2026-12-30" from a Date value, "2027-02-28" from a card's "2027-02" (the last day of the month). null when it does not parse. */
export function expiryDate(type: ItemType, value: string): string | null {
  const v = value.trim();
  if (type === "card") {
    const m = /^(\d{4})-(\d{2})$/.exec(v);
    if (!m || +m[2] < 1 || +m[2] > 12) return null;
    const last = new Date(Date.UTC(+m[1], +m[2], 0)).getUTCDate();
    return `${m[1]}-${m[2]}-${String(last).padStart(2, "0")}`;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? v : null;
}

/** Whole days from today (the PC's own date) to `ymd`: 0 = today, -3 = three days ago. */
export function daysLeft(ymd: string, now: Date = new Date()): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return Number.NaN;
  const target = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - today) / DAY);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The list badge: "45 days", "1 day", "Expires today", "Expired". */
export function badgeText(days: number): string {
  if (days < 0) return "Expired";
  if (days === 0) return "Expires today";
  return plural(days, "day");
}

/** The item banner: "This key expires in 45 days, on 30 Dec 2026." */
export function bannerText(type: ItemType, ymd: string, now: Date = new Date()): string {
  const days = daysLeft(ymd, now);
  const what = type === "apiCredential" ? "This key" : "This item";
  // Noon UTC: the same calendar day in every time zone the PC may use.
  const on = formatDate(`${ymd}T12:00:00Z`);
  if (days < 0) return `${what} expired ${plural(-days, "day")} ago, on ${on}.`;
  if (days === 0) return `${what} expires today, ${on}.`;
  return `${what} expires in ${plural(days, "day")}, on ${on}.`;
}
