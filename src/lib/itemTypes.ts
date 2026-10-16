// The 11 item types and their built-in fields (SPEC section 4). One table drives
// the field form, the new-item templates, the demo data and the Quick Access
// "Enter copies" rule, so the three never disagree.
import type { FieldKind, ItemType } from "./contract";

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

const T = (
  type: ItemType,
  label: string,
  plural: string,
  fields: BuiltinFieldDef[],
  enterCopies: string | null,
  enterLabel: string | null,
  extra: Partial<ItemTypeDef> = {},
): ItemTypeDef => ({
  type,
  label,
  plural,
  fields,
  hasUrls: false,
  enterCopies,
  enterFallback: null,
  enterLabel,
  ...extra,
});

export const ITEM_TYPES: Record<ItemType, ItemTypeDef> = {
  login: T(
    "login",
    "Login",
    "Logins",
    [
      { role: "username", label: "Username", kind: "text" },
      { role: "password", label: "Password", kind: "concealed" },
      { role: "totp", label: "One-time code", kind: "totp" },
    ],
    "password",
    "password",
    { hasUrls: true, enterFallback: "totp" },
  ),
  password: T("password", "Password", "Passwords", [{ role: "password", label: "Password", kind: "concealed" }], "password", "password"),
  note: T("note", "Secure Note", "Secure Notes", [], null, null),
  card: T(
    "card",
    "Credit Card",
    "Credit Cards",
    [
      { role: "cardholder", label: "Cardholder", kind: "text" },
      { role: "number", label: "Number", kind: "cardNumber" },
      { role: "expiry", label: "Expiry", kind: "monthYear" },
      { role: "cvv", label: "CVV", kind: "pin" },
      { role: "pin", label: "PIN", kind: "pin" },
      { role: "brand", label: "Brand", kind: "menu", options: ["Visa", "Mastercard", "American Express", "Discover", "Other"] },
    ],
    "number",
    "card number",
  ),
  identity: T(
    "identity",
    "Identity",
    "Identities",
    [
      { role: "title", label: "Title", kind: "menu", options: ["Mr", "Ms", "Mrs", "Mx", "Dr"] },
      { role: "first", label: "First name", kind: "text" },
      { role: "middle", label: "Middle name", kind: "text" },
      { role: "last", label: "Last name", kind: "text" },
      { role: "birthDate", label: "Birth date", kind: "date" },
      { role: "email", label: "Email", kind: "email" },
      { role: "phone", label: "Phone", kind: "phone" },
      { role: "address1", label: "Address line 1", kind: "text" },
      { role: "address2", label: "Address line 2", kind: "text" },
      { role: "city", label: "City", kind: "text" },
      { role: "region", label: "Region", kind: "text" },
      { role: "postcode", label: "Postcode", kind: "text" },
      { role: "country", label: "Country", kind: "text" },
      { role: "company", label: "Company", kind: "text" },
    ],
    null,
    null,
  ),
  bank: T(
    "bank",
    "Bank Account",
    "Bank Accounts",
    [
      { role: "bankName", label: "Bank", kind: "text" },
      { role: "holder", label: "Account holder", kind: "text" },
      { role: "accountNumber", label: "Account number", kind: "concealed" },
      { role: "sortCode", label: "Sort code / routing", kind: "text" },
      { role: "iban", label: "IBAN", kind: "text" },
      { role: "swift", label: "SWIFT/BIC", kind: "text" },
      { role: "pin", label: "PIN", kind: "pin" },
    ],
    "accountNumber",
    "account number",
  ),
  document: T(
    "document",
    "ID Document",
    "ID Documents",
    [
      { role: "docKind", label: "Kind", kind: "menu", options: ["Passport", "Driving licence", "ID card", "Other"] },
      { role: "number", label: "Number", kind: "text" },
      { role: "fullName", label: "Full name", kind: "text" },
      { role: "issued", label: "Issued", kind: "date" },
      { role: "expires", label: "Expires", kind: "date" },
      { role: "country", label: "Country", kind: "text" },
    ],
    "number",
    "document number",
  ),
  sshKey: T(
    "sshKey",
    "SSH Key",
    "SSH Keys",
    [
      { role: "privateKey", label: "Private key", kind: "concealed" },
      { role: "publicKey", label: "Public key", kind: "multiline" },
      { role: "fingerprint", label: "Fingerprint", kind: "text" },
      { role: "passphrase", label: "Passphrase", kind: "concealed" },
    ],
    "publicKey",
    "public key",
  ),
  apiCredential: T(
    "apiCredential",
    "API Credential",
    "API Credentials",
    [
      { role: "username", label: "Username", kind: "text" },
      { role: "credential", label: "Credential", kind: "concealed" },
      { role: "host", label: "Host", kind: "text" },
      { role: "expires", label: "Expires", kind: "date" },
    ],
    "credential",
    "credential",
  ),
  wifi: T(
    "wifi",
    "Wi-Fi",
    "Wi-Fi",
    [
      { role: "ssid", label: "Network name", kind: "text" },
      { role: "password", label: "Password", kind: "concealed" },
      { role: "security", label: "Security", kind: "menu", options: ["WPA3", "WPA2", "WPA", "WEP", "None"] },
    ],
    "password",
    "password",
  ),
  license: T(
    "license",
    "Software Licence",
    "Software Licences",
    [
      { role: "product", label: "Product", kind: "text" },
      { role: "version", label: "Version", kind: "text" },
      { role: "licenseKey", label: "Licence key", kind: "concealed" },
      { role: "licensedTo", label: "Licensed to", kind: "text" },
      { role: "email", label: "Email", kind: "email" },
      { role: "purchaseDate", label: "Purchase date", kind: "date" },
    ],
    "licenseKey",
    "licence key",
  ),
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

export const typeDef = (t: ItemType): ItemTypeDef => ITEM_TYPES[t];

/** The labels of every field kind, for the "Add field" menu. */
export const FIELD_KIND_LABELS: Record<FieldKind, string> = {
  text: "Text",
  concealed: "Password",
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
