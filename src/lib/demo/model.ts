// The demo's stored item (it holds real values, like the decrypted record in
// Rust) and the masked views the UI receives.
import { BUILTIN_FIELDS, ENTER_COPIES, SECRET_KINDS } from "../contract";
import type {
  Attachment,
  Field,
  FieldKind,
  ItemFlags,
  ItemState,
  ItemSummary,
  ItemType,
  ItemUrl,
  ItemView,
} from "../contract";

export interface StoredHistoryEntry {
  id: string;
  value: string;
  changedAt: string;
}

/** The parts of an item that a revision keeps. */
export interface ItemContent {
  type: ItemType;
  title: string;
  favorite: boolean;
  tags: string[];
  fields: Field[];
  notes: string;
  urls: ItemUrl[];
  apps: string[];
  reprompt: boolean;
  autotypeSequence: string | null;
  healthExcluded: boolean;
}

export interface StoredItem extends ItemContent {
  id: string;
  rev: number;
  state: ItemState;
  createdAt: string;
  updatedAt: string;
  trashedAt: string | null;
  passwordChangedAt: string | null;
  attachments: Attachment[];
  passwordHistory: StoredHistoryEntry[];
  revisions: Array<{ rev: number; savedAt: string; snapshot: ItemContent }>;
  /** Usage data (SPEC 4: lives outside the vault in the real app). */
  lastUsedAt: string | null;
}

export const NO_FLAGS: ItemFlags = { weak: false, reused: false, breached: false, unsecured: false, expiring: false };

export const isSecretKind = (k: FieldKind): boolean => SECRET_KINDS.includes(k);

export const cloneField = (f: Field): Field => ({ ...f, options: f.options ? [...f.options] : undefined });

export function contentOf(item: ItemContent): ItemContent {
  return {
    type: item.type,
    title: item.title,
    favorite: item.favorite,
    tags: [...item.tags],
    fields: item.fields.map(cloneField),
    notes: item.notes,
    urls: item.urls.map((u) => ({ ...u })),
    apps: [...item.apps],
    reprompt: item.reprompt,
    autotypeSequence: item.autotypeSequence,
    healthExcluded: item.healthExcluded,
  };
}

export const fieldByRole = (item: Pick<ItemContent, "fields">, role: string): Field | undefined =>
  item.fields.find((f) => f.builtin === role);

export const valueOfRole = (item: Pick<ItemContent, "fields">, role: string): string => fieldByRole(item, role)?.value ?? "";

/** "github.com" from the first URL; "www." is dropped. */
export function hostOf(url: string): string | null {
  const raw = (url ?? "").trim();
  if (!raw) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
    return u.hostname ? u.hostname.replace(/^www\./i, "").toLowerCase() : null;
  } catch {
    return null;
  }
}

export const urlHostOf = (item: Pick<ItemContent, "urls">): string | null => (item.urls[0] ? hostOf(item.urls[0].url) : null);

export const hasTotp = (item: Pick<ItemContent, "fields">): boolean => item.fields.some((f) => f.kind === "totp" && f.value.trim() !== "");

const last4 = (s: string): string => s.replace(/\D/g, "").slice(-4);

/** One plain line under the title. Never holds a secret value. */
export function subtitleOf(item: ItemContent): string {
  const v = (role: string) => valueOfRole(item, role).trim();
  switch (item.type) {
    case "login":
      return v("username") || urlHostOf(item) || "";
    case "password":
      return urlHostOf(item) ?? "";
    case "note": {
      const line = item.notes
        .split("\n")
        .map((l) => l.replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s*)/, "").replace(/[*_`]/g, "").trim())
        .find(Boolean);
      return line ? (line.length > 80 ? `${line.slice(0, 79)}…` : line) : "";
    }
    case "card": {
      const n = last4(v("number"));
      // A re-prompt item shows no digit of a secret field without the password.
      if (!n || item.reprompt) return v("brand") || v("cardholder");
      return `•••• ${n}`;
    }
    case "identity":
      return [v("firstName"), v("lastName")].filter(Boolean).join(" ") || v("email");
    case "bank":
      return [v("bankName"), v("holder")].filter(Boolean).join(" · ");
    case "document": {
      const exp = v("expires");
      return [v("docKind"), exp ? `expires ${exp}` : ""].filter(Boolean).join(" · ");
    }
    case "sshKey": {
      const fp = v("fingerprint");
      return fp.length > 24 ? `${fp.slice(0, 23)}…` : fp;
    }
    case "apiCredential":
      return (v("host") ? (hostOf(v("host")) ?? v("host")) : "") || v("username");
    case "wifi":
      return v("ssid");
    case "license":
      return [v("product"), v("version")].filter(Boolean).join(" ") || v("licensedTo");
  }
}

export function summaryOf(item: StoredItem, flags: ItemFlags): ItemSummary {
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    subtitle: subtitleOf(item),
    favorite: item.favorite,
    tags: [...item.tags],
    state: item.state,
    updatedAt: item.updatedAt,
    lastUsedAt: item.lastUsedAt,
    urlHost: urlHostOf(item),
    hasTotp: hasTotp(item),
    flags: { ...flags },
  };
}

/** The detail view: every SECRET_KINDS value is "" with masked true. */
export function viewOf(item: StoredItem, flags: ItemFlags): ItemView {
  return {
    id: item.id,
    rev: item.rev,
    type: item.type,
    title: item.title,
    subtitle: subtitleOf(item),
    favorite: item.favorite,
    tags: [...item.tags],
    state: item.state,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    trashedAt: item.trashedAt,
    passwordChangedAt: item.passwordChangedAt,
    fields: item.fields.map((f) => {
      const secret = isSecretKind(f.kind);
      return { ...cloneField(f), value: secret ? "" : f.value, masked: secret };
    }),
    notes: item.notes,
    urls: item.urls.map((u) => ({ ...u })),
    apps: [...item.apps],
    reprompt: item.reprompt,
    autotypeSequence: item.autotypeSequence,
    healthExcluded: item.healthExcluded,
    attachments: item.attachments.map((a) => ({ ...a })),
    passwordHistoryCount: item.passwordHistory.length,
    flags: { ...flags },
  };
}

/** What a FieldRef points at. */
export type Resolved =
  | { kind: "field"; field: Field; secret: boolean; label: string }
  | { kind: "history"; entry: StoredHistoryEntry; secret: true; label: string };

const ROLE_LABEL: Record<string, string> = { username: "Username", password: "Password", totp: "One-time code" };

/** Words for the Enter-copies role per type, as in "This item has no card number." */
const ENTER_WORDS: Partial<Record<ItemType, string>> = {
  card: "card number",
  bank: "account number",
  document: "document number",
  sshKey: "public key",
  apiCredential: "credential",
  license: "licence key",
};

/** Words for "This item has no <words>." (SPEC 4). */
export function missingWords(type: ItemType, ref: string, resolved: Resolved | null): string {
  if (ref.startsWith("history:")) return "such old password";
  const role = resolved?.kind === "field" ? (resolved.field.builtin ?? "") : ref;
  if (role === "username" || role === "password") return role;
  if (role === "totp") return "one-time code";
  if (role && role === ENTER_COPIES[type] && ENTER_WORDS[type]) return ENTER_WORDS[type]!;
  if (resolved?.kind === "field") return resolved.field.label.toLowerCase();
  return BUILTIN_FIELDS[type].find((f) => f.role === ref)?.label.toLowerCase() ?? "such field";
}

/** Resolve a FieldRef: "history:<id>", else a built-in role, else a field id (SPEC 3.6). */
export function resolveRef(item: StoredItem, ref: string): Resolved | null {
  if (ref.startsWith("history:")) {
    const entry = item.passwordHistory.find((e) => e.id === ref.slice("history:".length));
    return entry ? { kind: "history", entry, secret: true, label: "Old password" } : null;
  }
  const field =
    item.fields.find((f) => f.builtin === ref) ??
    (ref === "totp" ? item.fields.find((f) => f.kind === "totp") : undefined) ??
    item.fields.find((f) => f.id === ref);
  if (!field) return null;
  const label = (field.builtin && ROLE_LABEL[field.builtin]) || field.label;
  return { kind: "field", field, secret: isSecretKind(field.kind), label };
}
