// Health checks (SPEC 7), the exact rules:
// - Breached:  the password is in the demo's fixed breach list, once a check has run.
// - Reused:    the same password in 2+ active items that are not duplicates of each other.
// - Weak:      zxcvbn score 0..2 with title, username and URL host as user inputs.
// - Duplicate: same username, same password and same site in two items (not in the score).
// - Unsecured: an http:// URL that is not localhost or a private address (not in the score).
// - Old:       password unchanged for 365 days or more; an empty date never counts.
// - Expiring:  cards 60 days ahead, passports 300 days, other documents and API credentials 90 days.
// Score = floor(100 * healthy / total); total = active login and password items with a
// password, not excluded; healthy = not breached, not reused, not weak; null when total < 5.
// Archived and trashed items are not counted. Excluded items get no finding.
import type { HealthCheck, HealthFinding, HealthReport, ItemFlags } from "../contract";
import { NO_FLAGS, hostOf, urlHostOf, valueOfRole } from "./model";
import type { StoredItem } from "./model";
import { strength } from "./strength";

const DAY = 86_400_000;

/** Demo breach list: password -> times seen. No network, ever. */
export const DEMO_BREACHES: ReadonlyMap<string, number> = new Map([
  ["Blue-Harbour-73!", 1_204],
  ["password", 9_545_824],
  ["123456", 37_359_195],
  ["123456789", 16_629_796],
  ["qwerty", 10_556_095],
  ["password1", 2_418_984],
  ["password123", 2_464_659],
  ["letmein", 579_810],
  ["iloveyou", 1_995_195],
  ["admin", 41_293],
  ["welcome", 811_045],
  ["test1234", 192_283],
  ["Sunflower88", 3_116],
]);

const CHECK_ORDER: HealthCheck[] = ["breached", "reused", "weak", "duplicate", "unsecured", "old", "expiring"];

/** 1234567 -> "1,234,567" (fixed, not locale dependent). */
export const groupThousands = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** localhost, loopback, RFC 1918, link-local, IPv6 ULA and ".local" names count as private. */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (h === "::1" || /^f[cd][0-9a-f]{2}:/.test(h) || h.startsWith("fe80:")) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/** An http:// URL to a public host. */
export function isUnsecuredUrl(url: string): boolean {
  if (!/^http:\/\//i.test(url.trim())) return false;
  const host = hostOf(url);
  return !!host && !isPrivateHost(host);
}

/** End of a "YYYY-MM" month in ms (UTC). NaN when unreadable. */
function monthEnd(monthYear: string): number {
  const m = /^(\d{4})-(\d{2})$/.exec(monthYear.trim());
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]), 1) - 1;
}

function dateEnd(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59);
}

export interface HealthInput {
  items: StoredItem[];
  now: number;
  breachCheckedAt: string | null;
  breachCheck: HealthReport["breachCheck"];
}

export interface HealthResult {
  report: HealthReport;
  flags: Map<string, ItemFlags>;
}

export function computeHealth({ items, now, breachCheckedAt, breachCheck }: HealthInput): HealthResult {
  const active = items.filter((i) => i.state === "active");
  const considered = active.filter((i) => !i.healthExcluded);
  const excludedCount = active.length - considered.length;
  const findings: HealthFinding[] = [];
  const add = (item: StoredItem, check: HealthCheck, detail: string, groupId: string | null = null) =>
    findings.push({ itemId: item.id, check, detail, groupId });

  // Items whose password counts toward the score.
  const counted = considered
    .filter((i) => (i.type === "login" || i.type === "password") && valueOfRole(i, "password") !== "")
    .sort((a, b) => a.title.localeCompare(b.title));
  const pw = (i: StoredItem) => valueOfRole(i, "password");
  const user = (i: StoredItem) => valueOfRole(i, "username").trim().toLowerCase();
  // Two items are the same account when username, password and site match. No site = never a duplicate.
  const accountKey = (i: StoredItem) => {
    const host = urlHostOf(i);
    return host ? `${user(i)}\u0000${pw(i)}\u0000${host}` : `id:${i.id}`;
  };

  const breached = new Set<string>();
  const reused = new Set<string>();
  const weak = new Set<string>();

  if (breachCheckedAt) {
    for (const i of counted) {
      const seen = DEMO_BREACHES.get(pw(i));
      if (seen) {
        breached.add(i.id);
        add(i, "breached", `Found ${groupThousands(seen)} times in breaches`);
      }
    }
  }

  const byPassword = new Map<string, StoredItem[]>();
  for (const i of counted) byPassword.set(pw(i), [...(byPassword.get(pw(i)) ?? []), i]);
  let group = 0;
  for (const list of byPassword.values()) {
    const accounts = new Set(list.map(accountKey));
    if (accounts.size < 2) continue;
    const groupId = `reused-${++group}`;
    for (const i of list) {
      reused.add(i.id);
      add(i, "reused", `Used in ${list.length} items`, groupId);
    }
  }

  for (const i of counted) {
    const s = strength(pw(i), [i.title, valueOfRole(i, "username"), urlHostOf(i) ?? ""]);
    if (s.score <= 2) {
      weak.add(i.id);
      add(i, "weak", `Could be guessed in ${s.crackTime}`);
    }
  }

  const byAccount = new Map<string, StoredItem[]>();
  for (const i of counted) byAccount.set(accountKey(i), [...(byAccount.get(accountKey(i)) ?? []), i]);
  for (const list of byAccount.values()) {
    if (list.length < 2) continue;
    for (const i of list) {
      const others = list.filter((o) => o !== i).map((o) => o.title);
      add(i, "duplicate", `Same username, password and site as ${others.join(", ")}`);
    }
  }

  const unsecured = new Set<string>();
  for (const i of considered) {
    const bad = i.urls.find((u) => isUnsecuredUrl(u.url));
    if (bad) {
      unsecured.add(i.id);
      const origin = /^http:\/\/[^/?#]+/i.exec(bad.url.trim())?.[0] ?? bad.url.trim();
      add(i, "unsecured", `Uses ${origin.toLowerCase()} (not encrypted)`);
    }
  }

  for (const i of counted) {
    if (!i.passwordChangedAt) continue;
    const changed = Date.parse(i.passwordChangedAt);
    if (now - changed >= 365 * DAY) add(i, "old", `Not changed since ${isoDate(changed)}`);
  }

  const expiring = new Set<string>();
  for (const i of considered) {
    let end = NaN;
    let ahead = 0;
    let label = "";
    if (i.type === "card") {
      label = valueOfRole(i, "expiry").trim();
      end = monthEnd(label);
      ahead = 60;
    } else if (i.type === "document") {
      label = valueOfRole(i, "expires").trim();
      end = dateEnd(label);
      ahead = valueOfRole(i, "docKind") === "Passport" ? 300 : 90;
    } else if (i.type === "apiCredential") {
      label = valueOfRole(i, "expires").trim();
      end = dateEnd(label);
      ahead = 90;
    }
    if (Number.isNaN(end) || end > now + ahead * DAY) continue;
    expiring.add(i.id);
    add(i, "expiring", `${end < now ? "Expired" : "Expires"} ${label}`);
  }

  const total = counted.length;
  const healthy = counted.filter((i) => !breached.has(i.id) && !reused.has(i.id) && !weak.has(i.id)).length;
  const counts = Object.fromEntries(CHECK_ORDER.map((c) => [c, 0])) as Record<HealthCheck, number>;
  for (const f of findings) counts[f.check]++;
  const rank = new Map(items.map((i) => [i.id, i.title]));
  findings.sort(
    (a, b) =>
      CHECK_ORDER.indexOf(a.check) - CHECK_ORDER.indexOf(b.check) ||
      (a.groupId ?? "").localeCompare(b.groupId ?? "") ||
      (rank.get(a.itemId) ?? "").localeCompare(rank.get(b.itemId) ?? ""),
  );

  const flags = new Map<string, ItemFlags>();
  for (const i of items) {
    flags.set(i.id, {
      ...NO_FLAGS,
      weak: weak.has(i.id),
      reused: reused.has(i.id),
      breached: breached.has(i.id),
      unsecured: unsecured.has(i.id),
      expiring: expiring.has(i.id),
    });
  }

  return {
    report: {
      score: total >= 5 ? Math.floor((100 * healthy) / total) : null,
      total,
      healthy,
      formula: `${healthy} of ${total} ${total === 1 ? "password is" : "passwords are"} not breached, reused or weak`,
      counts,
      findings,
      excludedCount,
      breachCheck,
      breachCheckedAt,
    },
    flags,
  };
}
