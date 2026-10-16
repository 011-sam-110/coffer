import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AppInfo,
  BackupEntry,
  CofferError,
  EmergencyKit,
  GeneratedHistoryEntry,
  HealthReport,
  ImportPreview,
  ImportResult,
  ItemInput,
  ItemSummary,
  ItemView,
  PasswordHistoryEntry,
  Settings,
  TotpCode,
  VaultStatus,
} from "../contract";
import { SECRET_KINDS } from "../contract";
import type { Backend } from "../ipc";
import { DEMO_SECRET_KEY, createDemoBackend, vaultStem } from "./index";
import type { DemoBackendOptions } from "./index";
import { generateSecretKey } from "./secretKey";
import { DEMO_LOGINS, seedItems } from "./seed";

const mk = (o: Partial<DemoBackendOptions> = {}): Backend =>
  createDemoBackend({ page: "main", startState: "unlocked", latencyMs: 0, search: "", ...o });

const call = async <T = unknown>(b: Backend, name: string, args: Record<string, unknown> = {}): Promise<T> => (await b.invoke(name, args)) as T;

async function err(b: Backend, name: string, args: Record<string, unknown> = {}): Promise<CofferError> {
  try {
    await b.invoke(name, args);
  } catch (e) {
    return e as CofferError;
  }
  throw new Error(`${name} resolved but should have failed`);
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

function record(b: Backend, names: string[]): Array<[string, unknown]> {
  const events: Array<[string, unknown]> = [];
  for (const n of names) b.listen(n, (p) => events.push([n, p]));
  return events;
}

async function ids(b: Backend): Promise<(title: string) => string> {
  const list = await call<ItemSummary[]>(b, "items_list");
  return (title) => {
    const found = list.find((i) => i.title === title);
    if (!found) throw new Error(`no item ${title}`);
    return found.id;
  };
}

const toInput = (v: ItemView): ItemInput => ({
  id: v.id,
  baseRev: v.rev,
  type: v.type,
  title: v.title,
  favorite: v.favorite,
  tags: v.tags,
  fields: v.fields.map((f) => ({ id: f.id, label: f.label, kind: f.kind, section: f.section, builtin: f.builtin, options: f.options, value: f.masked ? null : f.value })),
  notes: v.notes,
  urls: v.urls,
  apps: v.apps,
  reprompt: v.reprompt,
  autotypeSequence: v.autotypeSequence,
  healthExcluded: v.healthExcluded,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("lock and unlock", () => {
  it("unlocks with the demo password only and emits the events", async () => {
    const b = mk({ startState: "locked" });
    const ev = record(b, ["vault://unlocked", "vault://locked"]);
    expect(await call<VaultStatus>(b, "vault_status")).toMatchObject({ state: "locked", vaultName: "Personal", itemCount: null, needsSecretKey: false });
    expect(await err(b, "vault_unlock", { password: "wrong", secretKey: null })).toEqual({ code: "badCredentials", message: "Wrong master password." });
    const s = await call<VaultStatus>(b, "vault_unlock", { password: "demo", secretKey: null });
    expect(s.state).toBe("unlocked");
    expect(s.itemCount).toBeGreaterThan(25);
    await call(b, "vault_lock");
    await flush();
    expect(ev.map(([n]) => n)).toEqual(["vault://unlocked", "vault://locked"]);
    expect(ev[1][1]).toEqual({ reason: "manual" });
  });

  it("rejects every item, history, health, import and export command while locked", async () => {
    const b = mk({ startState: "locked" });
    const gated: Array<[string, Record<string, unknown>]> = [
      ["items_list", {}],
      ["item_get", { id: "x" }],
      ["item_reveal", { id: "x", field: "password", password: null }],
      ["item_copy", { id: "x", field: "password", password: null }],
      ["item_save", { item: {}, password: null }],
      ["item_patch", { id: "x", favorite: true }],
      ["item_set_state", { id: "x", state: "trashed" }],
      ["items_bulk", { ids: [], action: "trash", tag: null }],
      ["item_delete_forever", { id: "x" }],
      ["trash_empty", {}],
      ["item_revisions", { id: "x", password: null }],
      ["item_password_history", { id: "x", password: null }],
      ["item_open_url", { id: "x", urlIndex: 0 }],
      ["totp_code", { id: "x", field: null, password: null }],
      ["generator_history", {}],
      ["generator_history_reveal", { id: "x" }],
      ["generator_history_copy", { id: "x" }],
      ["generator_history_clear", {}],
      ["health_report", {}],
      ["health_check_breaches", {}],
      ["import_preview", { source: "pick", password: null, secretKey: null }],
      ["import_commit", { previewId: "x" }],
      ["import_undo", { batchId: "x" }],
      ["export_vault", { kind: "csv", masterPassword: "demo", exportPassword: null }],
      ["emergency_kit", { password: "demo" }],
    ];
    for (const [name, args] of gated) expect((await err(b, name, args)).code, name).toBe("locked");
  });

  it("answers the every-state commands while locked, and keeps no history from a locked generator", async () => {
    const b = mk({ startState: "locked" });
    expect((await call<Settings>(b, "settings_get")).clipboardClearSeconds).toBe(90);
    expect((await call<AppInfo>(b, "app_info")).demo).toBe(true);
    expect((await call<{ value: string }>(b, "generate", { options: { mode: "pin", length: 6 } })).value).toMatch(/^\d{6}$/);
    expect((await call<{ score: number }>(b, "password_strength", { password: "demo", userInputs: [] })).score).toBeLessThan(3);
    expect((await call<{ valid: boolean }>(b, "secret_key_validate", { secretKey: DEMO_SECRET_KEY })).valid).toBe(true);
    expect((await call<{ path: string }>(b, "folder_info")).path).toBe("C:\\Users\\alex\\Coffer");
    expect((await call<{ mKib: number }>(b, "kdf_benchmark")).mKib).toBe(131072);
    expect(await call(b, "generator_copy", { value: "made-while-locked" })).toEqual({ clearsInSeconds: 90 });
    expect((await call<BackupEntry[]>(b, "backups_list")).length).toBeGreaterThan(0);
    expect((await call<{ suggestions: string[] }>(b, "quick_context")).suggestions).toEqual([]);
    await call(b, "vault_unlock", { password: "demo", secretKey: null });
    expect(await call(b, "generator_history")).toEqual([]);
  });

  it("asks for the Secret Key on a new PC (?needsKey=1)", async () => {
    const b = mk({ needsKey: true });
    expect(await call<VaultStatus>(b, "vault_status")).toMatchObject({ state: "locked", needsSecretKey: true, keyId: "DEMKEY" });
    expect((await err(b, "vault_unlock", { password: "demo", secretKey: null })).code).toBe("needsSecretKey");
    const typo = DEMO_SECRET_KEY.slice(0, -1) + (DEMO_SECRET_KEY.endsWith("2") ? "3" : "2");
    expect(await err(b, "vault_unlock", { password: "demo", secretKey: typo })).toEqual({ code: "badSecretKey", message: "This Secret Key has a typo. Check each group." });
    const other = generateSecretKey().secretKey;
    expect(await err(b, "vault_unlock", { password: "demo", secretKey: other })).toEqual({ code: "badSecretKey", message: "This Secret Key is for another vault." });
    expect(await err(b, "vault_unlock", { password: "nope", secretKey: DEMO_SECRET_KEY })).toEqual({ code: "badCredentials", message: "The master password or the Secret Key is wrong." });
    const s = await call<VaultStatus>(b, "vault_unlock", { password: "demo", secretKey: DEMO_SECRET_KEY.toLowerCase().replace(/-/g, " ") });
    expect(s).toMatchObject({ state: "unlocked", needsSecretKey: false });
  });

  it("rejects a tampered file and completes an older file only on confirm", async () => {
    const t = mk({ startState: "locked", tampered: true });
    expect((await err(t, "vault_unlock", { password: "wrong", secretKey: null })).code).toBe("badCredentials");
    expect((await err(t, "vault_unlock", { password: "demo", secretKey: null })).code).toBe("tampered");

    const o = mk({ startState: "locked", older: true });
    expect((await err(o, "vault_open_older")).code).toBe("invalid");
    expect(await err(o, "vault_unlock", { password: "demo", secretKey: null })).toEqual({
      code: "olderFile",
      message: "This file is older than the last version this PC saw (generation 41, this file 38).",
    });
    expect((await call<VaultStatus>(o, "vault_open_older")).state).toBe("unlocked");
    await call(o, "vault_lock");
    expect((await call<VaultStatus>(o, "vault_unlock", { password: "demo", secretKey: null })).state).toBe("unlocked");
  });

  it("creates a vault: weak password, exists, stem rules, picked folder, kit", async () => {
    const b = mk({ startState: "noVault" });
    expect((await call<VaultStatus>(b, "vault_status")).state).toBe("noVault");
    expect((await err(b, "vault_create", { name: "Personal", password: "password1", usePickedFolder: false })).code).toBe("weakPassword");
    expect((await err(b, "vault_create", { name: "Existing", password: "Velvet-Harbour-Quartz-91", usePickedFolder: false })).code).toBe("exists");
    expect((await err(b, "vault_create", { name: "Work", password: "Velvet-Harbour-Quartz-91", usePickedFolder: true })).code).toBe("invalid");
    expect((await call<{ provider: string }>(b, "folder_pick")).provider).toBe("OneDrive");
    const kit = await call<EmergencyKit>(b, "vault_create", { name: "My:Vault?", password: "Velvet-Harbour-Quartz-91", usePickedFolder: true });
    expect(kit).toMatchObject({ vaultName: "My_Vault_", vaultPath: "C:\\Users\\alex\\OneDrive\\Coffer\\My_Vault_.coffer", computerName: "DEMO-PC" });
    expect(await call(b, "secret_key_validate", { secretKey: kit.secretKey })).toEqual({ valid: true, keyId: kit.keyId });
    expect(await call<VaultStatus>(b, "vault_status")).toMatchObject({ state: "unlocked", itemCount: 0, keyId: kit.keyId });
    expect(await call(b, "items_list")).toEqual([]);
    expect((await call<HealthReport>(b, "health_report")).score).toBeNull();
    expect(vaultStem("CON")).toBe("CON_");
    expect(vaultStem("lpt1.backup")).toBe("lpt1_.backup");
    expect(vaultStem("Trail. . ")).toBe("Trail");
    expect(vaultStem("x".repeat(70))).toHaveLength(64);
    expect(vaultStem("  ")).toBeNull();
  });

  it("opens an existing vault (needs its Secret Key) and recovers a missing one", async () => {
    const b = mk();
    expect(await call<VaultStatus>(b, "vault_open")).toMatchObject({ state: "locked", needsSecretKey: true, vaultPath: "C:\\Users\\alex\\OneDrive\\Coffer\\Personal.coffer" });
    expect((await call<VaultStatus>(b, "vault_unlock", { password: "demo", secretKey: DEMO_SECRET_KEY })).state).toBe("unlocked");
    expect(await call(mk({ cancelDialogs: true }), "vault_open")).toBeNull();

    const m = mk({ startState: "missing" });
    expect(await call<VaultStatus>(m, "vault_status")).toMatchObject({ state: "missing", vaultPath: "C:\\Users\\alex\\Coffer\\Personal.coffer" });
    expect((await err(m, "vault_unlock", { password: "demo", secretKey: null })).code).toBe("vaultMissing");
    expect((await call<VaultStatus>(m, "vault_save_again", { saveAs: false })).state).toBe("locked");
    expect((await call<VaultStatus>(m, "vault_unlock", { password: "demo", secretKey: null })).state).toBe("unlocked");
  });
});

describe("items: masking, reveal, re-prompt, copy", () => {
  it("masks every secret field in item_get and leaks no secret in any list or view", async () => {
    const b = mk();
    const list = await call<ItemSummary[]>(b, "items_list");
    expect(list).toHaveLength(seedItems(Date.now()).length);
    const secrets = new Set<string>();
    for (const i of seedItems(Date.now())) {
      for (const f of i.fields) if (SECRET_KINDS.includes(f.kind) && f.value.length >= 6) secrets.add(f.value);
      for (const h of i.passwordHistory) secrets.add(h.value);
    }
    const dumps = [JSON.stringify(list)];
    for (const s of list) {
      const view = await call<ItemView>(b, "item_get", { id: s.id });
      for (const f of view.fields) {
        if (SECRET_KINDS.includes(f.kind)) expect(f).toMatchObject({ value: "", masked: true });
        else expect(f.masked).toBe(false);
      }
      dumps.push(JSON.stringify(view));
    }
    const all = dumps.join("\n");
    for (const s of secrets) expect(all.includes(s), `leaked ${s.slice(0, 4)}…`).toBe(false);
    const visa = list.find((i) => i.title === "Visa Debit")!;
    expect(visa.subtitle).toBe("•••• 4242");
    const gh = list.find((i) => i.title === "GitHub")!;
    expect(gh).toMatchObject({ subtitle: "alex@example.com", urlHost: "github.com", hasTotp: true, favorite: true });
  });

  it("resolves field refs: history, role, id; reveals a totp field as its URI", async () => {
    const b = mk();
    const id = await ids(b);
    const gh = id("GitHub");
    expect(await call(b, "item_reveal", { id: gh, field: "password", password: null })).toBe(DEMO_LOGINS.github.password);
    expect(await call(b, "item_reveal", { id: gh, field: "totp", password: null })).toMatch(/^otpauth:\/\/totp\/GitHub/);
    const view = await call<ItemView>(b, "item_get", { id: gh });
    const recovery = view.fields.find((f) => f.label === "Recovery codes")!;
    expect(recovery.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await call(b, "item_reveal", { id: gh, field: recovery.id, password: null })).toContain("a7f3");
    const history = await call<PasswordHistoryEntry[]>(b, "item_password_history", { id: gh, password: null });
    expect(history).toHaveLength(3);
    expect(Object.keys(history[0]).sort()).toEqual(["changedAt", "id", "length"]);
    expect(await call(b, "item_reveal", { id: gh, field: `history:${history[0].id}`, password: null })).toBe("Gh!Spring-Oak-2025");
    expect(history[0].length).toBe("Gh!Spring-Oak-2025".length);
    expect(await err(b, "item_reveal", { id: id("Amazon"), field: "totp", password: null })).toEqual({ code: "notFound", message: "This item has no one-time code." });
    const after = (await call<ItemSummary[]>(b, "items_list")).find((i) => i.id === gh)!;
    expect(Date.parse(after.lastUsedAt!)).toBeGreaterThan(Date.now() - 5_000);
  });

  it("re-prompt: refuses without the password, allows with it, remembers it 60 s, forgets on lock", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const b = mk();
    const bank = (await ids(b))("Northbank Current Account");
    const reveal = (password: string | null) => b.invoke("item_reveal", { id: bank, field: "accountNumber", password });
    expect(await err(b, "item_reveal", { id: bank, field: "accountNumber", password: null })).toEqual({
      code: "repromptRequired",
      message: "Enter your master password to use this item.",
    });
    expect((await err(b, "item_reveal", { id: bank, field: "accountNumber", password: "nope" })).code).toBe("badCredentials");
    expect((await err(b, "totp_code", { id: bank, field: null, password: null })).code).toBe("notFound");
    expect((await err(b, "item_password_history", { id: bank, password: null })).code).toBe("repromptRequired");
    expect((await err(b, "item_revisions", { id: bank, password: null })).code).toBe("repromptRequired");
    expect((await err(b, "item_copy", { id: bank, field: "accountNumber", password: null })).code).toBe("repromptRequired");
    // A non-secret field needs no password.
    expect(await call(b, "item_copy", { id: bank, field: "sortCode", password: null })).toEqual({ clearsInSeconds: 90 });
    expect(await reveal("demo")).toBe("41926583");
    expect(await reveal(null)).toBe("41926583"); // the grant
    expect(await call(b, "item_password_history", { id: bank, password: null })).toEqual([]);
    vi.advanceTimersByTime(61_000);
    expect((await err(b, "item_reveal", { id: bank, field: "accountNumber", password: null })).code).toBe("repromptRequired");
    expect(await reveal("demo")).toBe("41926583");
    await call(b, "vault_lock");
    await call(b, "vault_unlock", { password: "demo", secretKey: null });
    expect((await err(b, "item_reveal", { id: bank, field: "accountNumber", password: null })).code).toBe("repromptRequired");
  });

  it("copies with the right label, clears after the set time, restarts on a newer copy, clears on lock", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const b = mk();
    const id = await ids(b);
    const ev = record(b, ["clipboard://copied", "clipboard://cleared"]);
    const gh = id("GitHub");
    expect(await call(b, "item_copy", { id: gh, field: "password", password: null })).toEqual({ clearsInSeconds: 90 });
    await flush();
    expect(ev).toEqual([["clipboard://copied", { label: "Password", clearsInSeconds: 90 }]]);
    expect(await call(b, "demo_clipboard")).toBe(DEMO_LOGINS.github.password);
    await vi.advanceTimersByTimeAsync(89_000);
    await call(b, "item_copy", { id: gh, field: "username", password: null });
    await vi.advanceTimersByTimeAsync(89_000);
    expect(ev.map(([n]) => n)).toEqual(["clipboard://copied", "clipboard://copied"]);
    expect(ev[1][1]).toEqual({ label: "Username", clearsInSeconds: 90 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ev.at(-1)).toEqual(["clipboard://cleared", {}]);
    expect(await call(b, "demo_clipboard")).toBeNull();

    // A one-time code field copies the CURRENT code.
    await call(b, "item_copy", { id: gh, field: "totp", password: null });
    const code = await call<TotpCode>(b, "totp_code", { id: gh, field: null, password: null });
    expect(code.code).toMatch(/^\d{6}$/);
    expect(await call(b, "demo_clipboard")).toBe(code.code);
    await flush();
    expect(ev.at(-1)).toEqual(["clipboard://copied", { label: "One-time code", clearsInSeconds: 90 }]);
    // Steam gives 5 symbols.
    expect((await call<TotpCode>(b, "totp_code", { id: id("Steam"), field: null, password: null })).code).toMatch(/^[23456789BCDFGHJKMNPQRTVWXY]{5}$/);

    // Missing targets use the field's words.
    expect(await err(b, "item_copy", { id: id("Amazon"), field: "totp", password: null })).toEqual({ code: "notFound", message: "This item has no one-time code." });
    expect(await err(b, "item_copy", { id: id("Home server notes"), field: "password", password: null })).toEqual({ code: "notFound", message: "This item has no password." });
    expect(await err(b, "item_copy", { id: id("Home server notes"), field: "username", password: null })).toEqual({ code: "notFound", message: "This item has no username." });

    // Old password label, then lock clears.
    const hist = await call<PasswordHistoryEntry[]>(b, "item_password_history", { id: gh, password: null });
    await call(b, "item_copy", { id: gh, field: `history:${hist[0].id}`, password: null });
    await flush();
    expect(ev.at(-1)).toEqual(["clipboard://copied", { label: "Old password", clearsInSeconds: 90 }]);
    await call(b, "vault_lock");
    await flush();
    expect(ev.at(-1)).toEqual(["clipboard://cleared", {}]);

    // "Never" clears nothing.
    await call(b, "vault_unlock", { password: "demo", secretKey: null });
    await call(b, "settings_set", { patch: { clipboardClearSeconds: null } });
    expect(await call(b, "generator_copy", { value: "x1!" })).toEqual({ clearsInSeconds: null });
  });

  it("opens only http(s) URLs stored in the item", async () => {
    const b = mk();
    const id = await ids(b);
    await call(b, "item_open_url", { id: id("Retro Computing Forum"), urlIndex: 0 });
    expect((await err(b, "item_open_url", { id: id("Retro Computing Forum"), urlIndex: 3 })).code).toBe("notFound");
    const saved = await call<ItemView>(b, "item_save", {
      item: { type: "login", title: "Odd", favorite: false, tags: [], fields: [], notes: "", urls: [{ url: "file:///C:/x" }], apps: [], reprompt: false, autotypeSequence: null, healthExcluded: false },
      password: null,
    });
    expect((await err(b, "item_open_url", { id: saved.id, urlIndex: 0 })).code).toBe("invalid");
  });
});

describe("item_save", () => {
  const login = (password: string): ItemInput => ({
    type: "login",
    title: "Example shop",
    favorite: false,
    tags: ["Personal"],
    fields: [
      { id: "", label: "Username", kind: "text", value: "alex@example.com", builtin: "username", section: null },
      { id: "", label: "Password", kind: "concealed", value: password, builtin: "password", section: null },
    ],
    notes: "",
    urls: [{ url: "https://shop.example.com" }],
    apps: [],
    reprompt: false,
    autotypeSequence: null,
    healthExcluded: false,
  });

  it("creates at rev 1, updates rev + 1, and refuses a stale base rev", async () => {
    const b = mk();
    const ev = record(b, ["vault://changed"]);
    const created = await call<ItemView>(b, "item_save", { item: login("Kq8!vT3#mZ6@pW1x"), password: null });
    expect(created.rev).toBe(1);
    expect(created.passwordChangedAt).not.toBeNull();
    expect(created.fields.every((f) => /^[0-9a-f-]{36}$/.test(f.id))).toBe(true);
    await flush();
    expect(ev).toEqual([["vault://changed", { ids: [created.id] }]]);
    const updated = await call<ItemView>(b, "item_save", { item: { ...toInput(created), title: "Example shop (new)" }, password: null });
    expect(updated.rev).toBe(2);
    expect(await err(b, "item_save", { item: toInput(created), password: null })).toMatchObject({ code: "conflict" });
    expect(await call(b, "item_revisions", { id: created.id, password: null })).toEqual([{ rev: 1, savedAt: created.updatedAt, title: "Example shop" }]);
  });

  it("keeps a secret on null, refuses null for a new or changed field, and records password history", async () => {
    const b = mk();
    const v1 = await call<ItemView>(b, "item_save", { item: login("Kq8!vT3#mZ6@pW1x"), password: null });
    const v2 = await call<ItemView>(b, "item_save", { item: { ...toInput(v1), notes: "edited" }, password: null });
    expect(await call(b, "item_reveal", { id: v1.id, field: "password", password: null })).toBe("Kq8!vT3#mZ6@pW1x");
    expect(v2.passwordHistoryCount).toBe(0);

    const badNew = toInput(v2);
    badNew.fields.push({ id: "", label: "PIN", kind: "pin", value: null, builtin: null, section: null });
    expect((await err(b, "item_save", { item: badNew, password: null })).code).toBe("invalid");
    const badKind = toInput(v2);
    badKind.fields = badKind.fields.map((f) => (f.builtin === "password" ? { ...f, kind: "pin" } : f));
    expect((await err(b, "item_save", { item: badKind, password: null })).code).toBe("invalid");

    const change = toInput(v2);
    change.fields = change.fields.map((f) => (f.builtin === "password" ? { ...f, value: "Zr5^nB9!cX2#hL7q" } : f));
    // With no latency both saves can land in the same millisecond; the timestamp check needs a later clock.
    await new Promise((r) => setTimeout(r, 5));
    const v3 = await call<ItemView>(b, "item_save", { item: change, password: null });
    expect(v3.passwordHistoryCount).toBe(1);
    expect(v3.passwordChangedAt).not.toBe(v2.passwordChangedAt);
    const [h] = await call<PasswordHistoryEntry[]>(b, "item_password_history", { id: v3.id, password: null });
    expect(await call(b, "item_reveal", { id: v3.id, field: `history:${h.id}`, password: null })).toBe("Kq8!vT3#mZ6@pW1x");
  });

  it("needs the password to weaken re-prompt, and a right password starts the grant", async () => {
    const b = mk();
    const bank = (await ids(b))("Northbank Current Account");
    const view = await call<ItemView>(b, "item_get", { id: bank });
    expect((await err(b, "item_save", { item: { ...toInput(view), reprompt: false }, password: null })).code).toBe("repromptRequired");
    const kind = toInput(view);
    kind.fields = kind.fields.map((f) => (f.builtin === "accountNumber" ? { ...f, kind: "text", value: "41926583" } : f));
    expect((await err(b, "item_save", { item: kind, password: null })).code).toBe("repromptRequired");
    expect((await err(b, "item_save", { item: { ...toInput(view), reprompt: false }, password: "nope" })).code).toBe("badCredentials");
    // A save that keeps re-prompt needs nothing.
    const same = await call<ItemView>(b, "item_save", { item: { ...toInput(view), notes: "Branch: Example Street" }, password: null });
    const off = await call<ItemView>(b, "item_save", { item: { ...toInput(same), reprompt: false }, password: "demo" });
    expect(off.reprompt).toBe(false);
    expect(await call(b, "item_reveal", { id: bank, field: "accountNumber", password: null })).toBe("41926583");
    // Restoring the re-prompt revision is not a weakening; restoring "off" again would be.
    const revs = await call<Array<{ rev: number }>>(b, "item_revisions", { id: bank, password: null });
    const back = await call<ItemView>(b, "item_restore_revision", { id: bank, rev: revs[0].rev, password: null });
    expect(back.reprompt).toBe(true);
  });

  it("puts a generated password in history when it is saved into an item or copied", async () => {
    const b = mk();
    const g = await call<{ value: string }>(b, "generate", { options: { mode: "random", length: 24, upper: true, lower: true, digits: true, symbols: true, minDigits: 1, minSymbols: 1, avoidAmbiguous: false, exclude: "", words: 5, separator: "-", capitalize: false, includeNumber: false } });
    await call(b, "generate", { options: { mode: "passphrase", words: 4 } });
    expect(await call(b, "generator_history")).toEqual([]);
    await call(b, "item_save", { item: login(g.value), password: null });
    const p = await call<{ value: string }>(b, "generate", { options: { mode: "passphrase", words: 4 } });
    await call(b, "generator_copy", { value: p.value });
    const hist = await call<GeneratedHistoryEntry[]>(b, "generator_history");
    expect(hist.map((h) => [h.mode, h.length])).toEqual([
      ["passphrase", p.value.length],
      ["random", 24],
    ]);
    expect(Object.keys(hist[0]).sort()).toEqual(["createdAt", "id", "length", "mode"]);
    expect(await call(b, "generator_history_reveal", { id: hist[1].id })).toBe(g.value);
    const ev = record(b, ["clipboard://copied"]);
    await call(b, "generator_history_copy", { id: hist[1].id });
    await flush();
    expect(ev[0][1]).toEqual({ label: "Generated password", clearsInSeconds: 90 });
    await call(b, "generator_history_clear");
    expect(await call(b, "generator_history")).toEqual([]);
  });
});

describe("states, bulk and trash", () => {
  it("moves items between states and empties the trash", async () => {
    const b = mk();
    const id = await ids(b);
    const fig = id("Figma");
    await call(b, "item_set_state", { id: fig, state: "trashed" });
    expect((await call<ItemView>(b, "item_get", { id: fig })).trashedAt).not.toBeNull();
    await call(b, "item_set_state", { id: fig, state: "active" });
    expect((await call<ItemView>(b, "item_get", { id: fig })).trashedAt).toBeNull();

    const three = [id("Amazon"), id("Netflix"), id("Spotify")];
    expect(await call(b, "items_bulk", { ids: three, action: "addTag", tag: "Streaming" })).toBe(3);
    expect(await call(b, "items_bulk", { ids: three, action: "addTag", tag: "Streaming" })).toBe(0);
    expect((await err(b, "items_bulk", { ids: three, action: "addTag", tag: null })).code).toBe("invalid");
    expect(await call(b, "items_bulk", { ids: three, action: "removeTag", tag: "Streaming" })).toBe(3);
    expect(await call(b, "items_bulk", { ids: three.slice(0, 2), action: "archive", tag: null })).toBe(2);
    expect(await call(b, "items_bulk", { ids: three, action: "restore", tag: null })).toBe(2);
    expect(await call(b, "items_bulk", { ids: [fig], action: "trash", tag: null })).toBe(1);

    expect(await call(b, "trash_empty")).toBe(3); // Dribbble, Old recovery codes, Figma
    expect((await err(b, "item_get", { id: fig })).code).toBe("notFound");
    await call(b, "item_delete_forever", { id: id("Dropbox") });
    expect((await err(b, "item_get", { id: id("Dropbox") })).code).toBe("notFound");
    const patched = await call<ItemSummary>(b, "item_patch", { id: id("Steam"), favorite: true, tags: ["Personal", "Games"] });
    expect(patched).toMatchObject({ favorite: true, tags: ["Personal", "Games"] });
  });
});

describe("health through the backend", () => {
  it("starts with a breach check run, flags items and follows exclusions", async () => {
    const b = mk();
    const r = await call<HealthReport>(b, "health_report");
    expect(r).toMatchObject({ score: 68, total: 19, healthy: 13, excludedCount: 1, breachCheck: "manual" });
    expect(r.formula).toBe("13 of 19 passwords are not breached, reused or weak");
    expect(r.breachCheckedAt).not.toBeNull();
    const list = await call<ItemSummary[]>(b, "items_list");
    const flags = (t: string) => list.find((i) => i.title === t)!.flags;
    expect(flags("Retro Computing Forum")).toMatchObject({ breached: true, unsecured: true });
    expect(flags("Amazon").reused).toBe(true);
    expect(flags("Yahoo Mail")).toEqual({ weak: false, reused: false, breached: false, unsecured: false, expiring: false });
    await call(b, "item_patch", { id: list.find((i) => i.title === "Figma")!.id, healthExcluded: true });
    expect(await call<HealthReport>(b, "health_report")).toMatchObject({ total: 18, healthy: 13, excludedCount: 2, score: 72 });
    const checked = await call<HealthReport>(b, "health_check_breaches");
    expect(Date.parse(checked.breachCheckedAt!)).toBeGreaterThan(Date.now() - 5_000);
  });
});

describe("import and export", () => {
  it("previews, commits in one batch and undoes the batch", async () => {
    const b = mk();
    const before = (await call<ItemSummary[]>(b, "items_list")).length;
    const p = await call<ImportPreview>(b, "import_preview", { source: "pick", password: null, secretKey: null });
    expect(p).toMatchObject({ format: "bitwarden-json", formatLabel: "Bitwarden (JSON)", total: 14, duplicates: 2, needsPassword: false, needsSecretKey: false });
    expect(p.counts).toEqual({ login: 9, note: 2, card: 1, identity: 1, sshKey: 1 });
    expect(p.skipped).toHaveLength(1);
    expect(p.warnings.length).toBeGreaterThanOrEqual(1);
    const ev = record(b, ["vault://changed"]);
    const res = await call<ImportResult>(b, "import_commit", { previewId: p.previewId });
    expect(res).toMatchObject({ imported: 14, skipped: 3, tag: "Imported/Bitwarden" });
    await flush();
    expect(ev).toHaveLength(1); // ONE write
    const after = await call<ItemSummary[]>(b, "items_list");
    expect(after).toHaveLength(before + 14);
    expect(after.filter((i) => i.tags.includes("Imported/Bitwarden"))).toHaveLength(14);
    expect((await err(b, "import_commit", { previewId: p.previewId })).code).toBe("notFound");
    expect(await call(b, "import_undo", { batchId: res.batchId })).toBe(14);
    const undone = await call<ItemSummary[]>(b, "items_list");
    expect(undone.filter((i) => i.tags.includes("Imported/Bitwarden")).every((i) => i.state === "trashed")).toBe(true);
    await call(b, "import_delete_source", { previewId: p.previewId });
    expect((await err(b, "import_delete_source", { previewId: "nope" })).code).toBe("notFound");
  });

  it("finds no duplicates in an empty vault", async () => {
    const p = await call<ImportPreview>(mk({ empty: true }), "import_preview", { source: "pick", password: null, secretKey: null });
    expect(p).toMatchObject({ total: 16, duplicates: 0 });
  });

  it("asks for a password, and a Secret Key for a .coffer file, before the preview", async () => {
    const enc = mk({ importEncrypted: true });
    expect((await call<ImportPreview>(enc, "import_preview", { source: "pick", password: null, secretKey: null })).needsPassword).toBe(true);
    expect((await call<ImportPreview>(enc, "import_preview", { source: "last", password: "x", secretKey: null })).total).toBe(14);

    const cof = mk({ importCoffer: true, importCofferKey: true });
    expect(await call<ImportPreview>(cof, "import_preview", { source: "pick", password: null, secretKey: null })).toMatchObject({
      format: "coffer-vault",
      formatLabel: "Coffer vault",
      needsPassword: true,
      needsSecretKey: true,
    });
    expect(await call<ImportPreview>(cof, "import_preview", { source: "last", password: "x", secretKey: null })).toMatchObject({ needsPassword: false, needsSecretKey: true });
    expect(await call<ImportPreview>(cof, "import_preview", { source: "last", password: "x", secretKey: "C1-NOT-A-KEY" })).toMatchObject({ needsSecretKey: true });
    const ok = await call<ImportPreview>(cof, "import_preview", { source: "last", password: "x", secretKey: generateSecretKey().secretKey });
    expect(ok).toMatchObject({ needsPassword: false, needsSecretKey: false, total: 14 });

    const conflict = await call<ImportPreview>(mk(), "import_preview", { source: "conflict", password: null, secretKey: null });
    expect(conflict).toMatchObject({ format: "coffer-vault", formatLabel: "Coffer vault (your changes from the conflict copy)", total: 2, counts: { login: 2 } });
    expect((await err(mk(), "import_preview", { source: "last", password: null, secretKey: null })).code).toBe("invalid");
    expect(await call(mk({ cancelDialogs: true }), "import_preview", { source: "pick", password: null, secretKey: null })).toBeNull();
  });

  it("exports only with the master password and a strong export password", async () => {
    const b = mk();
    expect((await err(b, "export_vault", { kind: "csv", masterPassword: "nope", exportPassword: null })).code).toBe("badCredentials");
    expect((await err(b, "export_vault", { kind: "cofferEncrypted", masterPassword: "demo", exportPassword: null })).code).toBe("invalid");
    expect((await err(b, "export_vault", { kind: "cofferEncrypted", masterPassword: "demo", exportPassword: "abc" })).code).toBe("weakPassword");
    const r = await call<{ path: string }>(b, "export_vault", { kind: "cofferEncrypted", masterPassword: "demo", exportPassword: "Saffron-Glacier-Monk-27" });
    expect(r.path).toMatch(/^C:\\Users\\alex\\Downloads\\coffer-export-\d{4}-\d{2}-\d{2}\.cofferx$/);
    expect((await call<{ path: string }>(b, "export_vault", { kind: "cofferJson", masterPassword: "demo", exportPassword: null })).path).toMatch(/\.json$/);
  });
});

describe("backups", () => {
  it("lists believable backups and restores one, unlocked or locked", async () => {
    const b = mk();
    const list = await call<BackupEntry[]>(b, "backups_list");
    expect(list).toHaveLength(8);
    expect(list.map((x) => x.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    for (let i = 1; i < list.length; i++) {
      expect(list[i].generation).toBeLessThan(list[i - 1].generation);
      expect(Date.parse(list[i].savedAt)).toBeLessThan(Date.parse(list[i - 1].savedAt));
    }
    expect(list[0].size).toBeGreaterThan(20_000);
    const gh = (await ids(b))("GitHub");
    const view = await call<ItemView>(b, "item_get", { id: gh });
    await call(b, "item_save", { item: { ...toInput(view), title: "GitHub (renamed)" }, password: null });
    const after = await call<BackupEntry[]>(b, "backups_list");
    expect(after[0].generation).toBe(list[0].generation + 1);
    expect((await call<VaultStatus>(b, "backup_restore", { index: 1 })).state).toBe("unlocked");
    expect((await call<ItemView>(b, "item_get", { id: gh })).title).toBe("GitHub");
    await call(b, "vault_lock");
    expect((await call<VaultStatus>(b, "backup_restore", { index: 0 })).state).toBe("locked");
    expect((await err(b, "backup_restore", { index: 99 })).code).toBe("notFound");
  });
});

describe("banners and blocked saves", () => {
  it("diskDamaged: emits after unlock, blocks saves until save again", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const b = mk({ startState: "locked", diskDamaged: true });
    const ev = record(b, ["vault://diskDamaged"]);
    await call(b, "vault_unlock", { password: "demo", secretKey: null });
    await vi.advanceTimersByTimeAsync(300);
    expect(ev).toEqual([["vault://diskDamaged", { path: "C:\\Users\\alex\\Coffer\\Personal.coffer" }]]);
    const fig = (await ids(b))("Figma");
    expect((await err(b, "item_patch", { id: fig, favorite: true })).code).toBe("conflict");
    await call(b, "vault_save_again", { saveAs: false });
    expect((await call<ItemSummary>(b, "item_patch", { id: fig, favorite: true })).favorite).toBe(true);
  });

  it("olderOnDisk: delivered to a late listener; Load = lock, then the olderFile path", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const b = mk({ olderOnDisk: true });
    await vi.advanceTimersByTimeAsync(400);
    const ev = record(b, ["vault://olderOnDisk"]);
    await flush();
    expect(ev).toEqual([["vault://olderOnDisk", { fileGeneration: 38, seenGeneration: 41 }]]);
    await call(b, "vault_lock");
    expect((await err(b, "vault_unlock", { password: "demo", secretKey: null })).code).toBe("olderFile");
    expect((await call<VaultStatus>(b, "vault_open_older")).state).toBe("unlocked");
  });

  it("conflict and missingOpen emit their events; a missing file blocks saves", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const b = mk({ conflict: true, missingOpen: true });
    const ev = record(b, ["vault://conflict", "vault://missing"]);
    await vi.advanceTimersByTimeAsync(300);
    expect(ev[0]).toEqual(["vault://conflict", { conflictPath: "C:\\Users\\alex\\Coffer\\Personal (conflict 20261016T081500Z).coffer", since: expect.any(String) }]);
    expect(ev[1]).toEqual(["vault://missing", { path: "C:\\Users\\alex\\Coffer\\Personal.coffer" }]);
    expect((await err(b, "trash_empty")).code).toBe("vaultMissing");
    await call(b, "vault_save_again", { saveAs: true });
    expect(await call(b, "trash_empty")).toBe(2);
  });

  it("a lock while the file is gone gives the missing state, and save again recovers it", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const b = mk({ missingOpen: true });
    await vi.advanceTimersByTimeAsync(300);
    await call(b, "vault_lock");
    expect((await call<VaultStatus>(b, "vault_status")).state).toBe("missing");
    expect((await call<VaultStatus>(b, "vault_save_again", { saveAs: false })).state).toBe("locked");
    await call(b, "vault_unlock", { password: "demo", secretKey: null });
    await vi.advanceTimersByTimeAsync(300);
    expect(await call(b, "trash_empty")).toBe(2); // no new missing banner, saves work
  });
});

describe("settings, shell and tier 2", () => {
  it("merges settings, refuses helloEnabled, counts hints, reports hotkeys", async () => {
    const b = mk();
    const s = await call<Settings>(b, "settings_get");
    expect(s).toMatchObject({ autoLockMinutes: 10, clipboardClearSeconds: 90, breachCheck: "manual", hotkeyQuick: "Ctrl+Shift+Space", hotkeyLock: null, quickHintsShown: 0 });
    expect("excludeFromClipboardHistory" in s).toBe(false);
    expect((await call<Settings>(b, "settings_set", { patch: { autoLockMinutes: 5 } })).autoLockMinutes).toBe(5);
    expect((await err(b, "settings_set", { patch: { helloEnabled: false } })).code).toBe("invalid");
    await call(b, "quick_hint_seen");
    expect((await call<Settings>(b, "settings_get")).quickHintsShown).toBe(1);
    expect((await call<AppInfo>(b, "app_info")).hotkeyStatus).toEqual({ quick: "ok", lock: "off" });
    await call(b, "settings_set", { patch: { hotkeyLock: "Ctrl+Shift+Esc" } });
    expect((await call<AppInfo>(b, "app_info")).hotkeyStatus.lock).toBe("inUse");
    expect(await call(b, "folder_pick")).toMatchObject({ path: "C:\\Users\\alex\\OneDrive\\Coffer", synced: true, provider: "OneDrive" });
  });

  it("refuses tier-2 commands honestly and unknown commands", async () => {
    const b = mk();
    for (const name of ["autotype", "totp_from_image", "ssh_generate", "vault_unlock_hello", "secret_key_rotate"]) {
      expect(await err(b, name, { id: "x", password: null, source: "screen" })).toEqual({ code: "invalid", message: "Not available in this version." });
    }
    expect((await err(b, "hello_set", { enabled: true, password: "demo" })).code).toBe("helloUnavailable");
    expect((await err(b, "no_such_command")).code).toBe("invalid");
  });

  it("drops a dirty edit on lock, suggests GitHub for Chrome, and tells Quick Access it was shown", async () => {
    const b = mk();
    const ev = record(b, ["edit://discarded", "main://navigate"]);
    await call(b, "edit_state", { title: "GitHub", dirty: true });
    await call(b, "main_show", { itemId: null, view: "generator" });
    await call(b, "vault_lock");
    await flush();
    expect(ev).toEqual([
      ["main://navigate", { itemId: null, view: "generator" }],
      ["edit://discarded", { title: "GitHub" }],
    ]);

    const q = mk({ page: "quick" });
    const ctx = await call<{ title: string; process: string; suggestions: string[] }>(q, "quick_context");
    expect(ctx).toMatchObject({ title: "Pull requests · GitHub - Google Chrome", process: "chrome.exe" });
    expect(ctx.suggestions).toEqual([(await ids(q))("GitHub")]);
    const shown = record(q, ["quick://shown"]);
    await flush();
    expect(shown).toHaveLength(1);
    await call(q, "quick_set_modal", { modal: true });
    await call(q, "quick_hide");
  });
});

describe("demo window events", () => {
  it("emits main://closeNotice and app://quitRequested on demand, and main_hide resolves", async () => {
    const b = mk();
    const seen: string[] = [];
    b.listen("main://closeNotice", () => seen.push("closeNotice"));
    b.listen("app://quitRequested", () => seen.push("quitRequested"));
    expect(await call(b, "demo_simulate", { what: "closeNotice" })).toBe(true);
    expect(await call(b, "demo_simulate", { what: "quitRequested" })).toBe(true);
    await flush();
    expect(seen).toEqual(["closeNotice", "quitRequested"]);
    await expect(call(b, "main_hide")).resolves.toBeUndefined();
  });
});

describe("generator_options", () => {
  it("returns the defaults first, then the options of the last generate", async () => {
    const b = mk();
    const first = await call<{ mode: string; length: number }>(b, "generator_options");
    expect(first.mode).toBe("random");
    const opts = { ...first, mode: "passphrase", words: 6 };
    await call(b, "generate", { options: opts });
    expect(await call(b, "generator_options")).toEqual(opts);
  });
  it("needs an unlocked vault", async () => {
    const b = mk({ startState: "locked" });
    expect((await err(b, "generator_options")).code).toBe("locked");
  });
});
