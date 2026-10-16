// Formatting helpers: dates, relative times, sizes, codes, monograms, tags.
const DAY = 86_400_000;

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${formatDate(iso)}, ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}

/** "just now", "5 minutes ago", "yesterday", "3 days ago", or a date after 30 days. */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diff = now - t;
  if (diff < 0) return formatDate(iso);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(diff / DAY);
  if (d === 1) return "yesterday";
  if (d < 30) return `${d} days ago`;
  return formatDate(iso);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** "123456" -> "123 456"; 5-symbol Steam codes stay whole. */
export function groupCode(code: string): string {
  if (code.length === 6) return `${code.slice(0, 3)} ${code.slice(3)}`;
  if (code.length === 8) return `${code.slice(0, 4)} ${code.slice(4)}`;
  if (code.length === 7) return `${code.slice(0, 3)} ${code.slice(3)}`;
  return code;
}

/** "4242424242424242" -> "4242 4242 4242 4242". */
export function groupCard(n: string): string {
  return n.replace(/\s+/g, "").replace(/(.{4})/g, "$1 ").trim();
}

/** Split a Secret Key into its dash groups for display. */
export function secretKeyGroups(key: string): string[] {
  return key.split("-").filter(Boolean);
}

/** Monogram letters: "GitHub" -> "GH", "Netflix" -> "N", "Bank of Scotland" -> "BS". */
export function monogramLetters(title: string): string {
  const small = new Set(["of", "the", "and", "for", "a", "an", "de", "la"]);
  const words = title
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "?";
  const big = words.filter((w) => !small.has(w.toLowerCase()));
  const use = big.length > 0 ? big : words;
  if (use.length === 1) {
    const caps = use[0].match(/\p{Lu}/gu) ?? [];
    return caps.length >= 2 ? caps.slice(0, 2).join("") : use[0][0].toUpperCase();
  }
  return (use[0][0] + use[1][0]).toUpperCase();
}

/** A stable hue (0-359) from a title, so the same item keeps its colour. */
export function monogramHue(title: string): number {
  let h = 2166136261;
  for (const ch of title.toLowerCase()) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % 360;
}

export type CharClass = "letter" | "digit" | "symbol" | "space";

/** Split a password into runs by character class, for coloured display. */
export function charRuns(value: string): Array<{ cls: CharClass; text: string }> {
  const out: Array<{ cls: CharClass; text: string }> = [];
  for (const ch of value) {
    const cls: CharClass = /\p{N}/u.test(ch) ? "digit" : /\p{L}/u.test(ch) ? "letter" : /\s/.test(ch) ? "space" : "symbol";
    const last = out[out.length - 1];
    if (last && last.cls === cls) last.text += ch;
    else out.push({ cls, text: ch });
  }
  return out;
}

export interface TagNode {
  path: string;
  name: string;
  depth: number;
  count: number;
  children: TagNode[];
}

/** Build the "/"-nested tag tree with item counts (an item counts for each ancestor once). */
export function tagTree(itemTags: string[][]): TagNode[] {
  const nodes = new Map<string, TagNode>();
  const roots: TagNode[] = [];
  const ensure = (path: string): TagNode => {
    let n = nodes.get(path);
    if (n) return n;
    const parts = path.split("/");
    n = { path, name: parts[parts.length - 1], depth: parts.length - 1, count: 0, children: [] };
    nodes.set(path, n);
    if (parts.length === 1) roots.push(n);
    else ensure(parts.slice(0, -1).join("/")).children.push(n);
    return n;
  };
  for (const tags of itemTags) {
    const seen = new Set<string>();
    for (const tag of tags) {
      const parts = tag.split("/").filter(Boolean);
      for (let i = 1; i <= parts.length; i++) seen.add(parts.slice(0, i).join("/"));
    }
    for (const p of seen) ensure(p).count++;
  }
  const sort = (list: TagNode[]) => {
    list.sort((a, b) => a.name.localeCompare(b.name));
    list.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

/** Flatten a tag tree depth-first. */
export function flattenTags(nodes: TagNode[]): TagNode[] {
  return nodes.flatMap((n) => [n, ...flattenTags(n.children)]);
}

/** An item is in a tag filter when it has the tag or a tag below it. */
export function hasTag(tags: string[], path: string): boolean {
  return tags.some((t) => t === path || t.startsWith(`${path}/`));
}

export const pluralize = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The vault file stem made from a name (SPEC 3.5). Rust makes the real one; this is the preview. */
export function vaultStem(name: string): string {
  let s = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/[. ]+$/, "");
  if (!s) s = "Vault";
  s = s.slice(0, 64);
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s)) s += "_";
  return s;
}
