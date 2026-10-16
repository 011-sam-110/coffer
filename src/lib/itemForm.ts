// The ONE data-driven item form: the editor for all 11 types works on this
// model. It turns an ItemView into editable state, back into an ItemInput, and
// validates it. Secret fields stay null ("keep the stored value") unless the
// user types, reveals or generates a new value, so an edit that does not touch
// a password never needs it in the UI (SPEC 3.6).
import type { FieldKind, ItemInput, ItemType, ItemUrl, ItemView } from "./contract";
import { SECRET_KINDS } from "./contract";
import { ITEM_TYPES } from "./itemTypes";

export interface FormField {
  /** Stable key for React and for error messages. */
  key: string;
  /** The stored field id; undefined for a field added in this edit. */
  id?: string;
  label: string;
  kind: FieldKind;
  /** Plain value. For a secret field: null = keep the stored value. */
  value: string | null;
  /** A stored secret exists (shown as dots while value is null). */
  hasStored: boolean;
  section: string | null;
  builtin: string | null;
  options?: string[];
}

export interface ItemForm {
  id?: string;
  baseRev?: number;
  type: ItemType;
  title: string;
  favorite: boolean;
  tags: string[];
  fields: FormField[];
  notes: string;
  urls: ItemUrl[];
  apps: string[];
  reprompt: boolean;
  autotypeSequence: string | null;
  healthExcluded: boolean;
}

export const isSecretKind = (k: FieldKind): boolean => SECRET_KINDS.includes(k);

let seq = 0;
export const newKey = (prefix = "f"): string => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}`;

export function newItemForm(type: ItemType, title = ""): ItemForm {
  const def = ITEM_TYPES[type];
  return {
    type,
    title,
    favorite: false,
    tags: [],
    fields: def.fields.map((f) => ({
      key: newKey(),
      label: f.label,
      kind: f.kind,
      value: "",
      hasStored: false,
      section: null,
      builtin: f.role,
      options: f.options,
    })),
    notes: "",
    urls: def.hasUrls ? [{ url: "", label: null }] : [],
    apps: [],
    reprompt: false,
    autotypeSequence: null,
    healthExcluded: false,
  };
}

/** Edit state from a stored item. Built-in fields the item lacks are added empty, in schema order. */
export function formFromView(view: ItemView): ItemForm {
  const def = ITEM_TYPES[view.type];
  const fromView = (f: ItemView["fields"][number]): FormField => {
    const secret = isSecretKind(f.kind);
    return {
      key: newKey(),
      id: f.id,
      label: f.label,
      kind: f.kind,
      value: secret ? (f.masked ? null : f.value) : f.value,
      hasStored: secret && f.masked === true,
      section: f.section ?? null,
      builtin: f.builtin ?? null,
      options: f.options,
    };
  };
  const builtins: FormField[] = def.fields.map((b) => {
    const stored = view.fields.find((f) => f.builtin === b.role);
    return stored
      ? fromView(stored)
      : { key: newKey(), label: b.label, kind: b.kind, value: "", hasStored: false, section: null, builtin: b.role, options: b.options };
  });
  const roles = new Set(def.fields.map((b) => b.role));
  const custom = view.fields.filter((f) => !f.builtin || !roles.has(f.builtin)).map(fromView);
  return {
    id: view.id,
    baseRev: view.rev,
    type: view.type,
    title: view.title,
    favorite: view.favorite,
    tags: [...view.tags],
    fields: [...builtins, ...custom],
    notes: view.notes,
    urls: def.hasUrls && view.urls.length === 0 ? [{ url: "", label: null }] : view.urls.map((u) => ({ ...u })),
    apps: [...view.apps],
    reprompt: view.reprompt,
    autotypeSequence: view.autotypeSequence,
    healthExcluded: view.healthExcluded,
  };
}

/** Add https:// to a bare host such as "github.com". */
export function normalizeUrl(raw: string): string {
  const s = raw.trim();
  if (!s) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  return `https://${s}`;
}

export function formToInput(form: ItemForm): ItemInput {
  return {
    id: form.id,
    baseRev: form.baseRev,
    type: form.type,
    title: form.title.trim(),
    favorite: form.favorite,
    tags: [...new Set(form.tags.map((t) => t.trim().replace(/^\/+|\/+$/g, "")).filter(Boolean))],
    fields: form.fields
      // Drop empty custom fields; keep every built-in so its id stays stable.
      .filter((f) => f.builtin || f.value === null || f.value.trim() !== "" || f.label.trim() !== "")
      .map((f) => ({
        id: f.id ?? f.key,
        label: f.label.trim() || "Field",
        kind: f.kind,
        value: f.value,
        section: f.section?.trim() || null,
        builtin: f.builtin,
        options: f.options,
      })),
    notes: form.notes,
    urls: form.urls.map((u) => ({ url: normalizeUrl(u.url), label: u.label?.trim() || null })).filter((u) => u.url !== ""),
    apps: form.apps.map((a) => a.trim()).filter(Boolean),
    reprompt: form.reprompt,
    autotypeSequence: form.autotypeSequence?.trim() || null,
    healthExcluded: form.healthExcluded,
  };
}

/** Luhn check for card numbers. */
export function luhnOk(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function validDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

function validUrl(s: string): boolean {
  try {
    const u = new URL(normalizeUrl(s));
    return (u.protocol === "http:" || u.protocol === "https:") && !!u.hostname;
  } catch {
    return false;
  }
}

/** Error for one value of one kind, or null. Empty values are allowed (every field is optional). */
export function validateValue(kind: FieldKind, value: string, options?: string[]): string | null {
  const v = value.trim();
  if (!v) return null;
  switch (kind) {
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : "Enter an email address like name@example.com.";
    case "url":
      return validUrl(v) ? null : "Enter a web address that starts with http:// or https://.";
    case "phone":
      return /^[+\d][\d\s().-]{2,}$/.test(v) ? null : "A phone number has digits, spaces and + ( ) - only.";
    case "date":
      return validDate(v) ? null : "Enter a date as YYYY-MM-DD.";
    case "monthYear": {
      const m = /^(\d{4})-(\d{2})$/.exec(v);
      return m && +m[2] >= 1 && +m[2] <= 12 ? null : "Enter a month as YYYY-MM.";
    }
    case "cardNumber": {
      const digits = v.replace(/[\s-]/g, "");
      if (!/^\d{12,19}$/.test(digits)) return "A card number has 12 to 19 digits.";
      return luhnOk(digits) ? null : "Check the card number. One digit looks wrong.";
    }
    case "pin":
      return /^\d{3,12}$/.test(v) ? null : "A PIN has 3 to 12 digits.";
    case "totp":
      if (/^otpauth:\/\/totp\//i.test(v) || /^steam:\/\/[a-z2-7]+=*$/i.test(v)) return null;
      return /^[a-z2-7\s]+=*$/i.test(v) && v.replace(/[\s=]/g, "").length >= 16
        ? null
        : "Paste an otpauth:// link or the setup key from the website.";
    case "boolean":
      return v === "true" || v === "false" ? null : "Choose yes or no.";
    case "menu":
      return !options || options.includes(v) ? null : "Choose one of the listed values.";
    default:
      return null;
  }
}

export type FormErrors = Record<string, string>;

/** All errors of a form. Keys: "title", "field:<key>", "label:<key>", "url:<index>". */
export function validateForm(form: ItemForm): FormErrors {
  const errors: FormErrors = {};
  if (!form.title.trim()) errors.title = "Give this item a title.";
  for (const f of form.fields) {
    if (!f.builtin && !f.label.trim() && f.value !== null && f.value.trim() !== "") errors[`label:${f.key}`] = "Give this field a name.";
    if (f.value === null) continue;
    const e = validateValue(f.kind, f.value, f.options);
    if (e) errors[`field:${f.key}`] = e;
  }
  form.urls.forEach((u, i) => {
    if (u.url.trim() && !validUrl(u.url)) errors[`url:${i}`] = "Enter a web address that starts with http:// or https://.";
  });
  return errors;
}

/** Compare two forms by what would be saved. */
export function formsEqual(a: ItemForm, b: ItemForm): boolean {
  const strip = (f: ItemForm) => {
    const i = formToInput(f);
    return JSON.stringify({ ...i, fields: i.fields.map(({ id: _id, ...rest }) => rest) });
  };
  return strip(a) === strip(b);
}

/** User inputs for a strength check of a password in this item (SPEC 7: title, username, host). */
export function strengthInputs(form: Pick<ItemForm, "title" | "fields" | "urls">): string[] {
  const out = [form.title];
  const user = form.fields.find((f) => f.builtin === "username")?.value;
  if (user) out.push(user);
  for (const u of form.urls) {
    try {
      out.push(new URL(normalizeUrl(u.url)).hostname);
    } catch {
      /* not a URL yet */
    }
  }
  return out.filter(Boolean);
}
