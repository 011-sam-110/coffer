// Search ranking for the item list and Quick Access (SPEC 9): search covers
// title, username (subtitle), URL host and tags; rank: title prefix, word prefix,
// substring, then recent use. Archived and trashed matches are not listed; they
// are counted for the "n more in Archive or Trash" row.
import type { ItemSummary } from "./contract";

export const Tier = { TitlePrefix: 0, WordPrefix: 1, Substring: 2 } as const;
export type Tier = (typeof Tier)[keyof typeof Tier];

const WORD_SPLIT = /[^\p{L}\p{N}]+/u;

export function normalize(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
}

function words(s: string): string[] {
  return normalize(s).split(WORD_SPLIT).filter(Boolean);
}

/** The best tier at which one search term matches the item, or null. */
export function termTier(item: Pick<ItemSummary, "title" | "subtitle" | "urlHost" | "tags">, term: string): Tier | null {
  const t = normalize(term);
  if (!t) return null;
  const title = normalize(item.title);
  if (title.startsWith(t)) return Tier.TitlePrefix;
  const fields = [item.title, item.subtitle, item.urlHost ?? "", ...item.tags];
  for (const f of fields) {
    if (words(f).some((w) => w.startsWith(t))) return Tier.WordPrefix;
    // A tag like "Work/Clients" also matches its full path prefix.
    if (normalize(f).startsWith(t)) return Tier.WordPrefix;
  }
  for (const f of fields) if (normalize(f).includes(t)) return Tier.Substring;
  return null;
}

/** Tier of a whole query (every term must match; the worst term decides). */
export function queryTier(item: Pick<ItemSummary, "title" | "subtitle" | "urlHost" | "tags">, query: string): Tier | null {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return null;
  // The whole query as a title prefix ranks first even when it has spaces ("bank of").
  if (terms.length > 1 && normalize(item.title).startsWith(normalize(query.trim()))) return Tier.TitlePrefix;
  let worst: Tier = Tier.TitlePrefix;
  for (const term of terms) {
    const tier = termTier(item, term);
    if (tier === null) return null;
    if (tier > worst) worst = tier;
  }
  return worst;
}

const time = (iso: string | null): number => (iso ? Date.parse(iso) || 0 : 0);

export interface SearchResult {
  matches: ItemSummary[];
  /** Matches that are archived or trashed: shown as one row "n more in Archive or Trash". */
  hiddenCount: number;
}

export function searchItems(items: ItemSummary[], query: string): SearchResult {
  const ranked: Array<{ item: ItemSummary; tier: Tier }> = [];
  let hiddenCount = 0;
  for (const item of items) {
    const tier = queryTier(item, query);
    if (tier === null) continue;
    if (item.state !== "active") {
      hiddenCount++;
      continue;
    }
    ranked.push({ item, tier });
  }
  ranked.sort(
    (a, b) =>
      a.tier - b.tier ||
      time(b.item.lastUsedAt) - time(a.item.lastUsedAt) ||
      a.item.title.localeCompare(b.item.title, undefined, { sensitivity: "base" }),
  );
  return { matches: ranked.map((r) => r.item), hiddenCount };
}

/** Recently used active items, newest first. */
export function recentlyUsed(items: ItemSummary[], limit = 5): ItemSummary[] {
  return items
    .filter((i) => i.state === "active" && i.lastUsedAt)
    .sort((a, b) => time(b.lastUsedAt) - time(a.lastUsedAt))
    .slice(0, limit);
}

export type SortKey = "title" | "updated" | "lastUsed";

export function sortItems(items: ItemSummary[], key: SortKey): ItemSummary[] {
  const byTitle = (a: ItemSummary, b: ItemSummary) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
  const copy = [...items];
  if (key === "title") return copy.sort(byTitle);
  if (key === "updated") return copy.sort((a, b) => time(b.updatedAt) - time(a.updatedAt) || byTitle(a, b));
  return copy.sort((a, b) => time(b.lastUsedAt) - time(a.lastUsedAt) || byTitle(a, b));
}
