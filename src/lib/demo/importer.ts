// A fake import file for the import wizard (SPEC 8). DEMO DATA.
// The Bitwarden JSON file holds 17 entries: 14 import, 2 equal items already in
// the demo vault (GitHub and Netflix: skipped as duplicates), 1 empty entry
// skipped with a reason. Duplicates are computed against the vault, so an
// empty vault imports 16. The ".coffer" source (?importCoffer=1) holds the same
// entries without the empty one.
import { BUILTIN_FIELDS, MENU_OPTIONS } from "../contract";
import type { Field, ImportPreview, ItemType } from "../contract";
import type { ItemContent, StoredItem } from "./model";
import { hostOf, valueOfRole } from "./model";
import { uuid } from "./random";
import { DEMO_LOGINS } from "./seed";

export type ImportSource = "bitwarden" | "coffer" | "conflict";

export const SOURCES: Record<ImportSource, { format: string; formatLabel: string; tag: string }> = {
  bitwarden: { format: "bitwarden-json", formatLabel: "Bitwarden (JSON)", tag: "Imported/Bitwarden" },
  coffer: { format: "coffer-vault", formatLabel: "Coffer vault", tag: "Imported/Coffer" },
  conflict: { format: "coffer-vault", formatLabel: "Coffer vault (your changes from the conflict copy)", tag: "Imported/Coffer" },
};

interface Entry {
  type: ItemType;
  title: string;
  values: Record<string, string>;
  notes?: string;
  url?: string;
  /** Bitwarden folder, imported as a tag. */
  folder?: string;
  favorite?: boolean;
}

const ENTRIES: Entry[] = [
  { type: "login", title: "GitHub", values: { username: DEMO_LOGINS.github.username, password: DEMO_LOGINS.github.password }, url: DEMO_LOGINS.github.url },
  { type: "login", title: "Netflix", values: { username: DEMO_LOGINS.netflix.username, password: DEMO_LOGINS.netflix.password }, url: DEMO_LOGINS.netflix.url },
  { type: "login", title: "Reddit", values: { username: "alex_morgan_ex", password: "Tz4!wP9#cN2@xL7v" }, url: "https://www.reddit.com/login", folder: "Social" },
  { type: "login", title: "Discord", values: { username: "alex@example.com", password: "Ry6$kM3!qB8^vD1n" }, url: "https://discord.com/login", folder: "Social" },
  { type: "login", title: "Trello", values: { username: "alex@work.example", password: "Gh2#sV7!pK4@mW9x" }, url: "https://trello.com/login", folder: "Work" },
  { type: "login", title: "Airbnb", values: { username: "alex@example.com", password: "Cx8^nJ5!tR2#yF6q" }, url: "https://www.airbnb.com/login", folder: "Travel" },
  { type: "login", title: "eBay", values: { username: "alex@example.com", password: "ebay2018" }, url: "https://signin.ebay.com", folder: "Shopping" },
  { type: "login", title: "PayPal", values: { username: "alex@example.com", password: "Lw3!bQ9#hZ5@kN7r" }, url: "https://www.paypal.com/signin", folder: "Finance", favorite: true },
  { type: "login", title: "Zoom", values: { username: "alex@work.example", password: "Vp7#dX2!mS8^gT4k" }, url: "https://zoom.us/signin", folder: "Work" },
  { type: "login", title: "Duolingo", values: { username: "alexlearns", password: "Owl-Pancake-Rocket-5" }, url: "https://www.duolingo.com" },
  { type: "login", title: "BBC Account", values: { username: "alex@example.com", password: "Nb5!rK8#wL3@pZ6c" }, url: "https://account.bbc.com/signin" },
  { type: "note", title: "Gym locker", values: {}, notes: "Locker 114, combination 3-17-29." },
  { type: "note", title: "Reading list", values: {}, notes: "- The Pragmatic Programmer\n- **Designing Data-Intensive Applications**\n- Working in Public" },
  { type: "card", title: "American Express", values: { cardholder: "Alex Morgan", number: "378282246310005", expiry: "2028-09", cvv: "1234", brand: "American Express" }, folder: "Finance" },
  { type: "identity", title: "Alex Morgan (work)", values: { firstName: "Alex", lastName: "Morgan", email: "alex@work.example", company: "Example Ltd", phone: "+44 7700 900456" }, folder: "Work" },
  {
    type: "sshKey",
    title: "Raspberry Pi key",
    values: {
      privateKey: "----- DEMO SSH KEY (NOT A REAL KEY) -----\nDEMOONLYraspberrypiDEMOONLY==\n----- END DEMO SSH KEY -----",
      publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDEMOPIDEMOPIDEMOPIDEMOPIDEMOPIDEMOPI alex@raspberrypi",
      fingerprint: "SHA256:raspberryPiDem0OnlyN0tARealK3yDem0Only",
    },
  },
];

/** "Your changes" in a conflict copy: a password changed on this PC, and a new login. */
const CONFLICT_ENTRIES: Entry[] = [
  { type: "login", title: "GitHub", values: { username: DEMO_LOGINS.github.username, password: "pX3!vN8#qT5@wL2zR7mK" }, url: DEMO_LOGINS.github.url },
  { type: "login", title: "Notion", values: { username: "alex@work.example", password: "Hy6^cB2!nM9#sV4pQ8tW" }, url: "https://www.notion.so/login", folder: "Work" },
];

const ENTRIES_OF: Record<ImportSource, Entry[]> = { bitwarden: ENTRIES, coffer: ENTRIES, conflict: CONFLICT_ENTRIES };

const SKIPPED: Record<ImportSource, Array<{ title: string; reason: string }>> = {
  bitwarden: [{ title: "(no name)", reason: "The item has no title, username, password or notes." }],
  coffer: [],
  conflict: [],
};

const WARNINGS: Record<ImportSource, string[]> = {
  bitwarden: ["2 logins hold a passkey. Coffer keeps it as data but cannot sign in with it.", 'One custom field of type "Linked" was imported as text.'],
  coffer: [],
  conflict: [],
};

function fieldsOf(e: Entry): Field[] {
  return BUILTIN_FIELDS[e.type]
    .filter((d) => e.values[d.role])
    .map((d) => ({
      id: uuid(),
      label: d.label,
      kind: d.kind,
      value: e.values[d.role],
      section: null,
      builtin: d.role,
      options: d.kind === "menu" && MENU_OPTIONS[d.role] ? [...MENU_OPTIONS[d.role]] : undefined,
    }));
}

function contentOfEntry(e: Entry): ItemContent {
  return {
    type: e.type,
    title: e.title,
    favorite: !!e.favorite,
    tags: e.folder ? [e.folder] : [],
    fields: fieldsOf(e),
    notes: e.notes ?? "",
    urls: e.url ? [{ url: e.url, label: null }] : [],
    apps: [],
    reprompt: false,
    autotypeSequence: null,
    healthExcluded: false,
  };
}

/** SPEC 8: a duplicate = same type, title, username, password and first URL host as an existing item. */
export function importSignature(i: ItemContent): string {
  const host = i.urls[0] ? (hostOf(i.urls[0].url) ?? "") : "";
  return JSON.stringify([i.type, i.title.trim().toLowerCase(), valueOfRole(i, "username"), valueOfRole(i, "password"), host]);
}

export interface PlannedImport {
  preview: ImportPreview;
  items: ItemContent[];
  skipped: number;
  tag: string;
}

/** The preview of the fake file against the items now in the vault. */
export function planImport(source: ImportSource, vaultItems: StoredItem[]): PlannedImport {
  const existing = new Set(vaultItems.filter((i) => i.state !== "trashed").map(importSignature));
  const items: ItemContent[] = [];
  let duplicates = 0;
  for (const e of ENTRIES_OF[source]) {
    const c = contentOfEntry(e);
    if (existing.has(importSignature(c))) duplicates++;
    else items.push(c);
  }
  const counts: ImportPreview["counts"] = {};
  for (const i of items) counts[i.type] = (counts[i.type] ?? 0) + 1;
  const src = SOURCES[source];
  return {
    preview: {
      previewId: uuid(),
      format: src.format,
      formatLabel: src.formatLabel,
      total: items.length,
      counts,
      duplicates,
      skipped: SKIPPED[source].map((s) => ({ ...s })),
      warnings: [...WARNINGS[source]],
      needsPassword: false,
      needsSecretKey: false,
    },
    items,
    skipped: duplicates + SKIPPED[source].length,
    tag: src.tag,
  };
}

/** The preview of a protected file before its password (and, for a .coffer file, its Secret Key) is given. */
export function lockedPreview(source: ImportSource, needsPassword: boolean, needsSecretKey: boolean): ImportPreview {
  const src = SOURCES[source];
  return { previewId: uuid(), format: src.format, formatLabel: src.formatLabel, total: 0, counts: {}, duplicates: 0, skipped: [], warnings: [], needsPassword, needsSecretKey };
}
