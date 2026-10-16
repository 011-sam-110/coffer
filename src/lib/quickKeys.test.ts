import { describe, expect, it } from "vitest";
import type { Field, ItemType } from "./contract";
import { ITEM_TYPE_ORDER } from "./itemTypes";
import { enterPlan, entersFill, enterWords, groupCode, nextChainField, quickKey, resolveCopyTarget } from "./quickKeys";

type Mods = Partial<{ ctrlKey: boolean; shiftKey: boolean; altKey: boolean; caretAtEnd: boolean; hasSelection: boolean }>;
const k = (key: string, mods: Mods = {}) =>
  quickKey({ key, ctrlKey: false, shiftKey: false, altKey: false, caretAtEnd: false, ...mods });

describe("quickKey", () => {
  it("maps the SPEC 9 keys", () => {
    expect(k("ArrowUp")).toBe("up");
    expect(k("ArrowDown")).toBe("down");
    expect(k("Enter")).toBe("enter");
    expect(k("u", { ctrlKey: true })).toBe("copyUsername");
    expect(k("P", { ctrlKey: true })).toBe("copyPassword");
    expect(k("t", { ctrlKey: true })).toBe("copyTotp");
    expect(k("o", { ctrlKey: true })).toBe("openInCoffer");
    expect(k("Enter", { ctrlKey: true })).toBe("autotype");
    expect(k("Enter", { ctrlKey: true, shiftKey: true })).toBe("autotypePassword");
    expect(k("Escape")).toBe("escape");
  });
  it("copies with Ctrl+C, unless text is selected in the search", () => {
    expect(k("c", { ctrlKey: true })).toBe("copy");
    expect(k("C", { ctrlKey: true })).toBe("copy");
    expect(k("c", { ctrlKey: true, hasSelection: true })).toBeNull();
  });
  it("fills logins only, and only with a window to fill", () => {
    expect(entersFill("login", true)).toBe(true);
    expect(entersFill("login", false)).toBe(false);
    for (const t of ["password", "card", "note", "sshKey"] as ItemType[]) expect(entersFill(t, true)).toBe(false);
  });
  it("opens the action list with Right arrow only when the caret is at the end", () => {
    expect(k("ArrowRight", { caretAtEnd: true })).toBe("actions");
    expect(k("ArrowRight", { caretAtEnd: false })).toBeNull();
  });
  it("leaves typing and other chords to the field", () => {
    expect(k("a")).toBeNull();
    expect(k("u", { ctrlKey: true, shiftKey: true })).toBeNull();
    expect(k("u", { altKey: true })).toBeNull();
  });
});

describe("enterPlan (SPEC 4 table)", () => {
  const expected: Record<ItemType, string> = {
    login: "password",
    password: "password",
    note: "open",
    card: "number",
    identity: "open",
    bank: "accountNumber",
    document: "number",
    sshKey: "publicKey",
    apiCredential: "credential",
    wifi: "password",
    license: "licenseKey",
  };
  it.each(ITEM_TYPE_ORDER)("%s", (t) => {
    const p = enterPlan(t);
    expect(p.kind === "open" ? "open" : p.role).toBe(expected[t]);
  });
  it("never copies an SSH private key", () => {
    const p = enterPlan("sshKey");
    expect(p.kind === "copy" && p.role).not.toBe("privateKey");
  });
});

describe("resolveCopyTarget", () => {
  const f = (builtin: string, value: string, masked = false): Field => ({
    id: `id-${builtin}`,
    label: builtin,
    kind: "text",
    value,
    masked,
    builtin,
  });
  it("uses the role's field when it has a value", () => {
    const r = resolveCopyTarget({ fields: [f("password", "", true), f("totp", "", true)] }, "password", "totp", "password");
    expect(r).toEqual({ ok: true, fieldId: "id-password", label: "password" });
  });
  it("falls back to the one-time code when a login has no password", () => {
    const r = resolveCopyTarget({ fields: [f("password", ""), f("totp", "", true)] }, "password", "totp", "password");
    expect(r.ok && r.fieldId).toBe("id-totp");
  });
  it("says which field is missing", () => {
    const r = resolveCopyTarget({ fields: [f("username", "alex")] }, "password", null, "password");
    expect(r).toEqual({ ok: false, message: "This item has no password." });
  });
});

describe("enterWords", () => {
  it("names what Enter does on a row", () => {
    expect(enterWords("login")).toBe("Password");
    expect(enterWords("sshKey")).toBe("Public key");
    expect(enterWords("card")).toBe("Card number");
    expect(enterWords("note")).toBe("Open");
    expect(enterWords("identity")).toBe("Open");
  });
});

describe("nextChainField (one field per open: username, password, one-time code)", () => {
  const f = (builtin: string, value: string, masked = false): Field => ({ id: `id-${builtin}`, label: builtin, kind: "text", value, masked, builtin });
  const login = { fields: [f("username", "alex"), f("password", "", true), f("totp", "", true)] };
  it("goes username, then password, then the code", () => {
    expect(nextChainField(login, "username")?.role).toBe("password");
    expect(nextChainField(login, "password")?.role).toBe("totp");
    expect(nextChainField(login, "totp")).toBeNull();
  });
  it("skips a field with no value", () => {
    const noPw = { fields: [f("username", "alex"), f("password", ""), f("totp", "", true)] };
    expect(nextChainField(noPw, "username")).toEqual({ role: "totp", fieldId: "id-totp", label: "totp" });
  });
  it("starts no chain from a field outside it", () => {
    expect(nextChainField(login, null)).toBeNull();
    expect(nextChainField(login, "number")).toBeNull();
  });
});

describe("groupCode", () => {
  it("splits 6 and 8 digit codes in the middle", () => {
    expect(groupCode("261749")).toBe("261 749");
    expect(groupCode("12345678")).toBe("1234 5678");
    expect(groupCode("12345")).toBe("12345");
  });
});
