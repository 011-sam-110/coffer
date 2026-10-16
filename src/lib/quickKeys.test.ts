import { describe, expect, it } from "vitest";
import type { Field, ItemType } from "./contract";
import { ITEM_TYPE_ORDER } from "./itemTypes";
import { enterPlan, quickKey, resolveCopyTarget } from "./quickKeys";

type Mods = Partial<{ ctrlKey: boolean; shiftKey: boolean; altKey: boolean; caretAtEnd: boolean }>;
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
    expect(k("Escape")).toBe("escape");
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
