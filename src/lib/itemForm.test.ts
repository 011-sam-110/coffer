import { describe, expect, it } from "vitest";
import type { ItemView } from "./contract";
import { ITEM_TYPE_ORDER, ITEM_TYPES } from "./itemTypes";
import {
  formFromView,
  formToInput,
  formsEqual,
  luhnOk,
  newItemForm,
  normalizeUrl,
  validateForm,
  validateValue,
} from "./itemForm";

const view = (over: Partial<ItemView> = {}): ItemView => ({
  id: "x1",
  rev: 4,
  type: "login",
  title: "GitHub",
  subtitle: "alex@example.com",
  favorite: true,
  tags: ["Dev"],
  state: "active",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  trashedAt: null,
  passwordChangedAt: null,
  fields: [
    { id: "u", label: "Username", kind: "text", value: "alex@example.com", builtin: "username" },
    { id: "p", label: "Password", kind: "concealed", value: "", masked: true, builtin: "password" },
    { id: "c1", label: "Recovery email", kind: "email", value: "alex@example.net", section: "Recovery" },
  ],
  notes: "",
  urls: [{ url: "https://github.com", label: null }],
  apps: [],
  reprompt: false,
  autotypeSequence: null,
  healthExcluded: false,
  attachments: [],
  passwordHistoryCount: 0,
  flags: { weak: false, reused: false, breached: false, unsecured: false, expiring: false },
  ...over,
});

describe("newItemForm", () => {
  it.each(ITEM_TYPE_ORDER)("has every built-in field of %s", (t) => {
    const f = newItemForm(t);
    expect(f.fields.map((x) => x.builtin)).toEqual(ITEM_TYPES[t].fields.map((x) => x.role));
    expect(f.urls.length).toBe(ITEM_TYPES[t].hasUrls ? 1 : 0);
  });
});

describe("formFromView / formToInput", () => {
  it("keeps a stored secret as null so the UI never needs it", () => {
    const input = formToInput(formFromView(view()));
    const pw = input.fields.find((f) => f.builtin === "password")!;
    expect(pw.value).toBeNull();
    expect(pw.id).toBe("p");
    expect(input.baseRev).toBe(4);
  });
  it("adds missing built-in fields and keeps custom fields with sections", () => {
    const form = formFromView(view());
    expect(form.fields.map((f) => f.builtin ?? f.label)).toEqual(["username", "password", "totp", "Recovery email"]);
    expect(form.fields[3].section).toBe("Recovery");
  });
  it("normalises tags and urls", () => {
    const form = { ...newItemForm("login", " Site "), tags: ["Work/", " Work ", "/Home"], urls: [{ url: "example.com", label: null }] };
    const input = formToInput(form);
    expect(input.title).toBe("Site");
    expect(input.tags).toEqual(["Work", "Home"]);
    expect(input.urls[0].url).toBe("https://example.com");
  });
  it("sees an unchanged form as equal", () => {
    expect(formsEqual(formFromView(view()), formFromView(view()))).toBe(true);
    const changed = formFromView(view());
    changed.title = "GitHub work";
    expect(formsEqual(formFromView(view()), changed)).toBe(false);
  });
});

describe("validation", () => {
  it("needs a title", () => {
    expect(validateForm(newItemForm("note")).title).toBe("Give this item a title.");
    expect(validateForm(newItemForm("note", "Recipe")).title).toBeUndefined();
  });
  it("checks the auto-type sequence", () => {
    const f = newItemForm("login", "Bank");
    expect(validateForm({ ...f, autotypeSequence: "{USERNAME}{TAB}{PASSWORD}" }).autotype).toBeUndefined();
    expect(validateForm({ ...f, autotypeSequence: "{USER}" }).autotype).toBe("Coffer does not know the auto-type token {USER}.");
  });
  it("checks values by kind and allows empty values", () => {
    expect(validateValue("email", "")).toBeNull();
    expect(validateValue("email", "alex@example")).toMatch(/email/);
    expect(validateValue("url", "github.com")).toBeNull();
    expect(validateValue("url", "ftp://x.org")).toMatch(/http/);
    expect(validateValue("date", "2026-02-30")).toMatch(/YYYY-MM-DD/);
    expect(validateValue("date", "2026-02-28")).toBeNull();
    expect(validateValue("monthYear", "2026-13")).toMatch(/YYYY-MM/);
    expect(validateValue("cardNumber", "4242 4242 4242 4242")).toBeNull();
    expect(validateValue("cardNumber", "4242 4242 4242 4241")).toMatch(/Check/);
    expect(validateValue("pin", "12a4")).toMatch(/digits/);
    expect(validateValue("totp", "otpauth://totp/GitHub:alex?secret=JBSWY3DPEHPK3PXP")).toBeNull();
    expect(validateValue("totp", "jbsw y3dp ehpk 3pxp")).toBeNull();
    expect(validateValue("totp", "not a secret!")).toMatch(/otpauth/);
    expect(validateValue("menu", "Visa", ["Visa", "Other"])).toBeNull();
    expect(validateValue("menu", "Nope", ["Visa", "Other"])).toMatch(/Choose/);
  });
  it("keys errors by field and url", () => {
    const form = newItemForm("login", "Site");
    form.fields[0].kind = "email";
    form.fields[0].value = "nope";
    form.urls = [{ url: "ftp://x", label: null }];
    const e = validateForm(form);
    expect(Object.keys(e)).toEqual([`field:${form.fields[0].key}`, "url:0"]);
  });
  it("needs a name for a custom field with a value", () => {
    const form = newItemForm("note", "N");
    form.fields.push({ key: "k1", label: "", kind: "text", value: "x", hasStored: false, section: null, builtin: null });
    expect(validateForm(form)["label:k1"]).toBe("Give this field a name.");
  });
  it("has a correct Luhn check and url normaliser", () => {
    expect(luhnOk("5555555555554444")).toBe(true);
    expect(luhnOk("5555555555554445")).toBe(false);
    expect(normalizeUrl(" http://a.b ")).toBe("http://a.b");
  });
});
