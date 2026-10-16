// The 11 item types for the UI. The built-in fields, their roles, the menu
// choices and the Enter-copies role come from the contract tables
// (BUILTIN_FIELDS, MENU_OPTIONS, ENTER_COPIES), so the field form, the demo
// backend, the Rust core and Quick Access never disagree. This file adds only
// display words.
import { BUILTIN_FIELDS, ENTER_COPIES, MENU_OPTIONS, type FieldKind, type ItemType } from "./contract";

export interface BuiltinFieldDef {
  /** Built-in role, stored in Field.builtin. Unique within one item. */
  role: string;
  label: string;
  kind: FieldKind;
  options?: string[];
}

export interface ItemTypeDef {
  type: ItemType;
  label: string;
  plural: string;
  fields: BuiltinFieldDef[];
  /** The item has a list of website addresses (logins). */
  hasUrls: boolean;
  /** Built-in role that Enter copies in Quick Access; null = open the item in Coffer. */
  enterCopies: string | null;
  /** Role copied when the enterCopies field is missing or empty (login: one-time code). */
  enterFallback: string | null;
  /** Words for the Enter target, used in hints and "This item has no <field>". */
  enterLabel: string | null;
}

const WORDS: Record<ItemType, { label: string; plural: string; enterLabel: string | null }> = {
  login: { label: "Login", plural: "Logins", enterLabel: "password" },
  password: { label: "Password", plural: "Passwords", enterLabel: "password" },
  note: { label: "Secure Note", plural: "Secure Notes", enterLabel: null },
  card: { label: "Credit Card", plural: "Credit Cards", enterLabel: "card number" },
  identity: { label: "Identity", plural: "Identities", enterLabel: null },
  bank: { label: "Bank Account", plural: "Bank Accounts", enterLabel: "account number" },
  document: { label: "ID Document", plural: "ID Documents", enterLabel: "document number" },
  sshKey: { label: "SSH Key", plural: "SSH Keys", enterLabel: "public key" },
  apiCredential: { label: "API Credential", plural: "API Credentials", enterLabel: "credential" },
  wifi: { label: "Wi-Fi", plural: "Wi-Fi", enterLabel: "password" },
  license: { label: "Software Licence", plural: "Software Licences", enterLabel: "licence key" },
};

/** Sidebar and type-filter order. */
export const ITEM_TYPE_ORDER: ItemType[] = [
  "login",
  "password",
  "note",
  "card",
  "identity",
  "bank",
  "document",
  "sshKey",
  "apiCredential",
  "wifi",
  "license",
];

export const ITEM_TYPES: Record<ItemType, ItemTypeDef> = Object.fromEntries(
  ITEM_TYPE_ORDER.map((type) => [
    type,
    {
      type,
      label: WORDS[type].label,
      plural: WORDS[type].plural,
      fields: BUILTIN_FIELDS[type].map((f) => ({ ...f, options: f.kind === "menu" ? MENU_OPTIONS[f.role] : undefined })),
      hasUrls: type === "login",
      enterCopies: ENTER_COPIES[type],
      enterFallback: type === "login" ? "totp" : null,
      enterLabel: WORDS[type].enterLabel,
    } satisfies ItemTypeDef,
  ]),
) as Record<ItemType, ItemTypeDef>;

export const typeDef = (t: ItemType): ItemTypeDef => ITEM_TYPES[t];

/** The labels of every field kind, for the "Add field" menu. */
export const FIELD_KIND_LABELS: Record<FieldKind, string> = {
  text: "Text",
  concealed: "Password",
  concealedMultiline: "Long secret",
  multiline: "Long text",
  email: "Email",
  url: "Web address",
  phone: "Phone",
  date: "Date",
  monthYear: "Month and year",
  totp: "One-time code",
  boolean: "Yes or no",
  cardNumber: "Card number",
  pin: "PIN",
  menu: "Menu",
};
