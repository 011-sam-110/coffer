// In-memory DEMO backend. It follows src/lib/contract.ts (spec v3) so the UI can be
// built and screenshot-tested in a plain browser, with no Rust build. It never
// makes a network request and never touches the system clipboard.
//
// Demo master password: "demo". Demo Secret Key (needed with ?needsKey=1 and after
// vault_open): DEMO_SECRET_KEY in ./secretKey.ts, key id DEMKEY.
//
// URL flags (read from location.search; tests pass them as options):
//   ?state=noVault|locked|unlocked|missing   start state (default unlocked; read by ipc.ts)
//   ?needsKey=1          locked, and this "device" has no Secret Key (unlock needs DEMO_SECRET_KEY)
//   ?tampered=1          vault_unlock with the right password rejects "tampered"
//   ?older=1             the first right unlock rejects "olderFile"; vault_open_older completes it
//   ?empty=1             the vault has no items (empty states)
//   ?importEncrypted=1   the import file is an encrypted Bitwarden JSON: needsPassword until
//                        import_preview({ source: "last", password })
//   ?importCoffer=1      the import file is a .coffer vault (needsPassword the same way)
//   ?importCofferKey=1   a .coffer import file that also needsSecretKey until a valid key is given
//   ?diskDamaged=1       vault://diskDamaged about 300 ms after an unlock (or after start when
//                        unlocked); saves are blocked until vault_save_again
//   ?olderOnDisk=1       vault://olderOnDisk { fileGeneration: 38, seenGeneration: 41 } the same
//                        way; saves blocked; lock then unlock takes the olderFile path
//   ?conflict=1          vault://conflict the same way (a fixed conflict path, since 2 hours ago)
//   ?missingOpen=1       vault://missing { path } the same way (file gone while unlocked)
//   ?dialogs=cancel      every Rust-side file or folder dialog is "cancelled" (returns null)
//   ?latency=<ms>        fixed latency for every call (0 = none)
//
// Demo-only extra commands (not in the contract; the UI must not call them):
//   invoke("demo_clipboard")  what the simulated clipboard holds (tests only)
//   invoke("demo_simulate", { what, title? }) with what = "idleLock" | "systemLock" |
//   "sleepLock" | "quitLock" | "fileMissing" | "conflict" | "reloaded" | "quickShown" |
//   "editDiscarded" | "quitRequested" | "keyChanged" | "closeNotice". In a browser:
//   window.__cofferDemo.simulate(what).
//
// A banner event that fires before any listener exists is delivered to the first
// listener that registers for it.
import { BUILTIN_FIELDS } from "../contract";
import type {
  AppInfo,
  BackupEntry,
  Commands,
  CofferError,
  EmergencyKit,
  ErrorCode,
  Events,
  Field,
  FolderInfo,
  GeneratorMode,
  GeneratorOptions,
  HealthReport,
  ItemFlags,
  ItemState,
  QuickContext,
  Settings,
  VaultState,
  VaultStatus,
} from "../contract";
import type { Backend, DemoOptions } from "../ipc";
import { GeneratorError, generate as generateValue } from "./generator";
import { computeHealth } from "./health";
import { lockedPreview, planImport } from "./importer";
import type { ImportSource, PlannedImport } from "./importer";
import { NO_FLAGS, contentOf, isSecretKind, missingWords, resolveRef, summaryOf, valueOfRole, viewOf } from "./model";
import type { ItemContent, StoredItem } from "./model";
import { randInt, stableId, uuid } from "./random";
import { DEMO_KEY_ID, DEMO_SECRET_KEY, generateSecretKey, parseSecretKey } from "./secretKey";
import { DEMO_MASTER_PASSWORD, DEMO_VAULT_PATH, GITHUB_ID, seedItems } from "./seed";
import { strength } from "./strength";
import { parseTotp, totpAt } from "./totp";

export { DEMO_SECRET_KEY } from "./secretKey";
export { DEMO_MASTER_PASSWORD } from "./seed";

export interface DemoExtras {
  /** Fixed latency in ms for every call (tests use 0). Default: 30-120 ms, KDF-like calls about 700 ms. */
  latencyMs?: number;
  needsKey?: boolean;
  tampered?: boolean;
  older?: boolean;
  empty?: boolean;
  importEncrypted?: boolean;
  importCoffer?: boolean;
  importCofferKey?: boolean;
  diskDamaged?: boolean;
  olderOnDisk?: boolean;
  conflict?: boolean;
  missingOpen?: boolean;
  cancelDialogs?: boolean;
  /** Use this instead of location.search for the flags above (tests). */
  search?: string;
}

export type DemoBackendOptions = DemoOptions & DemoExtras;

export const DEMO_DEFAULT_FOLDER = "C:\\Users\\alex\\Coffer";
export const DEMO_PICKED_FOLDER = "C:\\Users\\alex\\OneDrive\\Coffer";
export const DEMO_CONFLICT_PATH = "C:\\Users\\alex\\Coffer\\Personal (conflict 20261016T081500Z).coffer";
const COMPUTER_NAME = "DEMO-PC";
const DAY = 86_400_000;
const GRANT_MS = 60_000;
const TRASH_DAYS = 30;
const RESERVED_HOTKEYS = ["Ctrl+Shift+Esc", "Ctrl+Alt+Delete", "Win+L"];
/** Commands that write the vault file: refused while saves are blocked. */
const WRITE_COMMANDS = new Set([
  "item_save",
  "item_patch",
  "item_set_state",
  "items_bulk",
  "item_delete_forever",
  "trash_empty",
  "item_restore_revision",
  "import_commit",
  "import_undo",
  "vault_change_password",
  "health_check_breaches",
]);

const DEFAULT_SETTINGS: Settings = {
  autoLockMinutes: 10,
  lockOnSystemLock: true,
  lockOnSleep: true,
  clipboardClearSeconds: 90,
  captureProtection: true,
  helloEnabled: false,
  requirePasswordDays: 14,
  startWithWindows: true,
  startHidden: true,
  trayClick: "quick",
  hotkeyQuick: "Ctrl+Shift+Space",
  hotkeyLock: null,
  breachCheck: "manual", // demo default; the real default is "off"
  closeNoticeShown: false,
  closeBehavior: "hide",
  quickHintsShown: 0,
};

interface Backup {
  savedAt: string;
  size: number;
  generation: number;
  /** The items as JSON, so a restore really brings them back. */
  items: string;
}

interface Vault {
  id: string;
  /** The vault name is the file stem (SPEC 3.5: not secret). */
  name: string;
  path: string;
  keyId: string;
  secretKey: string;
  password: string;
  createdAt: string;
  generation: number;
  items: Map<string, StoredItem>;
  genHistory: Array<{ id: string; value: string; createdAt: string; mode: GeneratorMode }>;
  breachCheckedAt: string | null;
  backups: Backup[];
}

/** ItemInput and ItemContent both fit: a field value null means "keep the stored value". */
type ContentInput = Omit<ItemContent, "fields"> & { fields: Array<Omit<Field, "value" | "masked"> & { value: string | null }> };

type Handlers = {
  [K in keyof Commands]: (args: Commands[K][0]) => Commands[K][1] | Promise<Commands[K][1]>;
};

const fail = (code: ErrorCode, message: string): CofferError => ({ code, message });

/** The generator's defaults before any generate (the same values as the UI's DEFAULT_GENERATOR). */
const DEMO_GENERATOR_DEFAULTS: GeneratorOptions = {
  mode: "random",
  length: 20,
  upper: true,
  lower: true,
  digits: true,
  symbols: true,
  minDigits: 1,
  minSymbols: 1,
  avoidAmbiguous: false,
  exclude: "",
  words: 5,
  separator: "-",
  capitalize: true,
  includeNumber: true,
};

export function isCofferError(e: unknown): e is CofferError {
  return !!e && typeof e === "object" && "code" in e && "message" in e;
}

/** SPEC 3.2: NFKD, then trim leading and trailing white space. */
const normalizePassword = (p: string): string => (p ?? "").normalize("NFKD").trim();

const stemOf = (path: string): string => (path.split("\\").pop() ?? path).replace(/\.coffer$/i, "");
const joinPath = (folder: string, file: string): string => `${folder.replace(/[\\/]+$/, "")}\\${file}`;

/**
 * SPEC 3.5: the file stem from a vault name. Invalid characters become "_", trailing
 * dots and spaces are cut, 1 to 64 characters, "_" after a reserved device name.
 * Null when nothing is left.
 */
export function vaultStem(name: string): string | null {
  // eslint-disable-next-line no-control-regex
  let s = (name ?? "").trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_");
  s = s.slice(0, 64).replace(/[. ]+$/, "");
  if (!s) return null;
  return s.replace(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?=\.|$)/i, "$1_");
}

function readFlags(opts: DemoBackendOptions) {
  let search = opts.search;
  if (search === undefined) {
    try {
      search = globalThis.location?.search ?? "";
    } catch {
      search = "";
    }
  }
  const q = new URLSearchParams(search);
  const on = (name: string) => q.get(name) === "1" || q.get(name) === "true";
  const latencyParam = q.get("latency");
  return {
    needsKey: opts.needsKey ?? on("needsKey"),
    tampered: opts.tampered ?? on("tampered"),
    older: opts.older ?? on("older"),
    empty: opts.empty ?? on("empty"),
    importEncrypted: opts.importEncrypted ?? on("importEncrypted"),
    importCoffer: opts.importCoffer ?? (on("importCoffer") || on("importCofferKey")),
    importCofferKey: opts.importCofferKey ?? on("importCofferKey"),
    diskDamaged: opts.diskDamaged ?? on("diskDamaged"),
    olderOnDisk: opts.olderOnDisk ?? on("olderOnDisk"),
    conflict: opts.conflict ?? on("conflict"),
    missingOpen: opts.missingOpen ?? on("missingOpen"),
    cancelDialogs: opts.cancelDialogs ?? q.get("dialogs") === "cancel",
    latencyMs: opts.latencyMs ?? (latencyParam !== null && Number.isFinite(Number(latencyParam)) ? Number(latencyParam) : undefined),
  };
}

export function createDemoBackend(opts: DemoBackendOptions): Backend {
  const flags = readFlags(opts);
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  let settings: Settings = { ...DEFAULT_SETTINGS };
  let vault: Vault | null = null;
  let state: VaultState = flags.needsKey ? "locked" : opts.startState;
  let needsSecretKey = flags.needsKey;
  let fileGone = false;
  let pickedFolder: string | null = null;
  let editState: { title: string | null; dirty: boolean } | null = null;
  /** ?older=1: the unlock that hit olderFile, held for 60 s until vault_open_older. */
  let olderPending: { until: number; typedKey: string | null } | null = null;
  /** The next unlock fails olderFile (?older=1, or a lock while the older-on-disk banner is up). */
  let olderNext = flags.older;
  /** Banners still to show (each until the user resolves it) and the save block they cause. */
  const banners = { diskDamaged: flags.diskDamaged, olderOnDisk: flags.olderOnDisk, conflict: flags.conflict, missing: flags.missingOpen };
  let blocked: "diskDamaged" | "olderOnDisk" | null = null;
  /** Events emitted while nobody listened: delivered to the first listener (banner flags at start). */
  const undelivered = new Map<string, unknown>();
  const grants = new Map<string, number>();
  const clip = { timer: null as ReturnType<typeof setTimeout> | null, held: false };
  /** What the simulated clipboard holds. Never returned by a contract command; tests read it with demo_clipboard. */
  let lastCopied: string | null = null;
  /** Generated values not yet copied or saved, with their mode (SPEC 5: only those enter history). */
  const pendingGenerated = new Map<string, GeneratorMode>();
  /** The options of the last generate (vault meta in Rust); null before the first. */
  let lastGeneratorOptions: GeneratorOptions | null = null;
  const previews = new Map<string, PlannedImport>();
  const issuedPreviews = new Set<string>();
  let lastImportFile: { source: ImportSource; locked: boolean; needsKey: boolean } | null = null;
  const batches = new Map<string, string[]>();
  let quickShownSent = false;

  // ---------- helpers ----------
  const now = (): number => Date.now();
  const iso = (ms: number = now()): string => new Date(ms).toISOString();

  const sleep = (ms: number): Promise<void> => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
  /** Simulated latency; `spentMs` of real work already done counts toward it. */
  const delay = (kind: "base" | "kdf" | "slow" | "file", spentMs = 0): Promise<void> => {
    if (flags.latencyMs !== undefined) return sleep(flags.latencyMs);
    if (kind === "kdf") return sleep(650 + randInt(110) - spentMs);
    if (kind === "slow") return sleep(1400 + randInt(200) - spentMs);
    if (kind === "file") return sleep(250 + randInt(150) - spentMs);
    return sleep(30 + randInt(91) - spentMs);
  };

  function emit<E extends keyof Events>(event: E, payload: Events[E], keepIfUnheard = false): void {
    // Events reach the UI asynchronously, as Tauri events do.
    void Promise.resolve().then(() => {
      const hs = [...(listeners.get(event) ?? [])];
      if (hs.length === 0 && keepIfUnheard) undelivered.set(event, payload);
      for (const h of hs) {
        try {
          h(payload);
        } catch (e) {
          console.error(`[demo] a "${event}" handler threw`, e);
        }
      }
    });
  }

  function backupOf(items: Iterable<StoredItem>, generation: number, savedAt: string): Backup {
    const json = JSON.stringify([...items]);
    // Encrypted records, base64 and padding to 256 bytes make the file about 1.4x the JSON.
    return { savedAt, generation, items: json, size: Math.ceil((json.length * 1.37 + 1200) / 256) * 256 };
  }

  function newVault(path: string, items: StoredItem[], password: string, generation: number, key: { keyId: string; secretKey: string }): Vault {
    const t = now();
    const backups: Backup[] = [];
    // A few saves today, then one per day.
    const agoMin = [6, 47, 180, 1440, 2 * 1440, 3 * 1440, 5 * 1440, 8 * 1440];
    const genBack = [0, 1, 3, 6, 12, 15, 20, 27];
    for (let n = 0; n < agoMin.length && generation - genBack[n] > 0; n++) {
      backups.push(backupOf(items, generation - genBack[n], iso(t - agoMin[n] * 60_000)));
    }
    return {
      id: uuid(),
      name: stemOf(path),
      path,
      keyId: key.keyId,
      secretKey: key.secretKey,
      password: normalizePassword(password),
      createdAt: iso(t - 1800 * DAY),
      generation,
      items: new Map(items.map((i) => [i.id, i])),
      genHistory: [],
      breachCheckedAt: null,
      backups,
    };
  }

  function demoVault(path: string = DEMO_VAULT_PATH): Vault {
    const v = newVault(path, flags.empty ? [] : seedItems(now()), DEMO_MASTER_PASSWORD, flags.empty ? 3 : 42, {
      keyId: DEMO_KEY_ID,
      secretKey: DEMO_SECRET_KEY,
    });
    // As agreed with the lead: the demo vault starts with a breach check already run.
    if (!flags.empty) v.breachCheckedAt = iso(now() - 3 * DAY);
    return v;
  }

  if (state !== "noVault") vault = demoVault();
  if (state === "unlocked") {
    scheduleBanners();
    // Warm the health flags (zxcvbn) once, off the path of the first items_list call.
    setTimeout(() => {
      if (vault && state === "unlocked") health(vault);
    }, 0);
  }

  function status(): VaultStatus {
    if (!vault || state === "noVault") {
      return { state: "noVault", vaultPath: null, vaultName: null, keyId: null, needsSecretKey: false, helloAvailable: false, helloEnabled: false, helloReady: false, itemCount: null };
    }
    const unlocked = state === "unlocked";
    return {
      state,
      vaultPath: vault.path,
      vaultName: vault.name,
      keyId: vault.keyId,
      needsSecretKey: state === "locked" && needsSecretKey,
      helloAvailable: false,
      helloEnabled: settings.helloEnabled,
      helloReady: false,
      itemCount: unlocked ? [...vault.items.values()].filter((i) => i.state === "active").length : null,
    };
  }

  function requireUnlocked(): Vault {
    if (!vault || state !== "unlocked") throw fail("locked", "Unlock Coffer first.");
    return vault;
  }

  function requireVault(): Vault {
    if (!vault || state === "noVault") throw fail("invalid", "There is no vault on this PC yet.");
    return vault;
  }

  function getItem(id: string): StoredItem {
    const v = requireUnlocked();
    const item = v.items.get(id);
    if (!item) throw fail("notFound", "This item is no longer in the vault.");
    return item;
  }

  function health(v: Vault) {
    return computeHealth({ items: [...v.items.values()], now: now(), breachCheckedAt: v.breachCheckedAt, breachCheck: settings.breachCheck });
  }

  const flagsOf = (v: Vault, id: string): ItemFlags => health(v).flags.get(id) ?? NO_FLAGS;

  /** One vault write: generation +1, a backup, then vault://changed. */
  function commit(ids: string[]): void {
    const v = requireVault();
    v.generation++;
    v.backups.unshift(backupOf(v.items.values(), v.generation, iso()));
    v.backups = v.backups.slice(0, 28);
    if (ids.length) emit("vault://changed", { ids });
  }

  /** SPEC 3.5: after diskDamaged / olderOnDisk, or with the file gone, saves are blocked. */
  function assertCanSave(): void {
    if (state !== "unlocked") return;
    if (fileGone) throw fail("vaultMissing", "The vault file is gone. Save it here again first.");
    if (blocked === "diskDamaged") throw fail("conflict", "Saving is paused: the vault file on disk is damaged. Save your open vault or restore a backup first.");
    if (blocked === "olderOnDisk") throw fail("conflict", "Saving is paused: the vault file on disk is older than this PC has seen. Keep your open vault or load the older file first.");
  }

  /** The banner flags fire about 300 ms after an unlock (or after start when unlocked). */
  function scheduleBanners(): void {
    if (!banners.diskDamaged && !banners.olderOnDisk && !banners.conflict && !banners.missing) return;
    setTimeout(() => {
      if (state !== "unlocked" || !vault) return;
      if (banners.diskDamaged) {
        blocked = "diskDamaged";
        emit("vault://diskDamaged", { path: vault.path }, true);
      }
      if (banners.olderOnDisk) {
        blocked = blocked ?? "olderOnDisk";
        emit("vault://olderOnDisk", { fileGeneration: 38, seenGeneration: 41 }, true);
      }
      if (banners.conflict) {
        banners.conflict = false; // one-shot: Coffer already loaded the disk file
        emit("vault://conflict", { conflictPath: DEMO_CONFLICT_PATH, since: iso(now() - 2 * 3_600_000) }, true);
      }
      if (banners.missing) {
        fileGone = true;
        emit("vault://missing", { path: vault.path }, true);
      }
    }, 300);
  }

  function clipboardCopy(label: string, value: string): { clearsInSeconds: number | null } {
    const secs = settings.clipboardClearSeconds;
    if (clip.timer) clearTimeout(clip.timer);
    clip.timer = null;
    clip.held = true;
    lastCopied = value;
    emit("clipboard://copied", { label, clearsInSeconds: secs });
    if (secs !== null && secs !== undefined) {
      clip.timer = setTimeout(() => {
        clip.timer = null;
        clip.held = false;
        lastCopied = null;
        emit("clipboard://cleared", {});
      }, secs * 1000);
    }
    return { clearsInSeconds: secs };
  }

  function clearClipboard(): void {
    if (clip.timer) clearTimeout(clip.timer);
    clip.timer = null;
    lastCopied = null;
    if (clip.held) {
      clip.held = false;
      emit("clipboard://cleared", {});
    }
  }

  function lockNow(reason: Events["vault://locked"]["reason"]): void {
    if (state !== "unlocked") return;
    // A vault whose file is gone locks into the "missing" state (SPEC 3.5).
    state = fileGone ? "missing" : "locked";
    fileGone = false;
    // "Load the older file" = lock, then the olderFile unlock path (SPEC 3.5).
    if (blocked === "olderOnDisk") {
      olderNext = true;
      banners.olderOnDisk = false;
    }
    blocked = null;
    grants.clear();
    pendingGenerated.clear();
    clearClipboard();
    // SPEC 9: lock discards an unsaved edit.
    if (editState?.dirty) emit("edit://discarded", { title: editState.title ?? "an item" });
    editState = null;
    emit("vault://locked", { reason });
  }

  /** The master password in the call, or a 60 s grant for this item id (SPEC 3.6). */
  async function requireGrant(itemId: string, password: string | null | undefined): Promise<void> {
    if ((grants.get(itemId) ?? 0) > now()) return;
    if (password === null || password === undefined || password === "") {
      throw fail("repromptRequired", "Enter your master password to use this item.");
    }
    await delay("kdf");
    if (normalizePassword(password) !== requireUnlocked().password) throw fail("badCredentials", "Wrong master password.");
    grants.set(itemId, now() + GRANT_MS);
  }

  const checkReprompt = (item: StoredItem, password: string | null | undefined): Promise<void> =>
    item.reprompt ? requireGrant(item.id, password) : Promise.resolve();

  async function checkMaster(password: string): Promise<void> {
    await delay("kdf");
    if (normalizePassword(password) !== requireUnlocked().password) throw fail("badCredentials", "Wrong master password.");
  }

  function kit(v: Vault): EmergencyKit {
    return { vaultName: v.name, vaultPath: v.path, vaultId: v.id, keyId: v.keyId, secretKey: v.secretKey, createdAt: v.createdAt, computerName: COMPUTER_NAME };
  }

  function folderInfo(folder: string): FolderInfo {
    const lower = folder.toLowerCase();
    const provider: FolderInfo["provider"] = lower.includes("onedrive")
      ? "OneDrive"
      : lower.includes("dropbox")
        ? "Dropbox"
        : lower.includes("google drive") || lower.includes("googledrive")
          ? "Google Drive"
          : null;
    return { path: folder, exists: true, writable: !/^[a-z]:\\(windows|program files)/i.test(folder), synced: provider !== null, provider };
  }

  function quickContext(): QuickContext {
    const suggestions = state === "unlocked" && vault?.items.get(GITHUB_ID)?.state === "active" ? [GITHUB_ID] : [];
    return { title: "Pull requests · GitHub - Google Chrome", process: "chrome.exe", suggestions };
  }

  function purgeOldTrash(v: Vault): void {
    const cutoff = now() - TRASH_DAYS * DAY;
    for (const [id, i] of v.items) if (i.state === "trashed" && i.trashedAt && Date.parse(i.trashedAt) < cutoff) v.items.delete(id);
  }

  function finishUnlock(v: Vault, typedKey: string | null): VaultStatus {
    if (typedKey) v.secretKey = typedKey; // this device now keeps the Secret Key
    needsSecretKey = false;
    state = "unlocked";
    purgeOldTrash(v);
    const s = status();
    emit("vault://unlocked", s);
    scheduleBanners();
    return s;
  }

  /** SPEC 3.6: a save or restore weakens re-prompt when it turns reprompt off or changes a secret field's kind. */
  function weakensReprompt(prev: StoredItem, next: ContentInput): boolean {
    if (!prev.reprompt) return false; // nothing is guarded by re-prompt on this item
    if (!next.reprompt) return true;
    return next.fields.some((f) => {
      const old = prev.fields.find((p) => p.id === f.id);
      return !!old && isSecretKind(old.kind) && old.kind !== f.kind;
    });
  }

  /** Apply new content to a stored item (or make a new one): null keeps, password history, revisions. */
  function applyContent(prev: StoredItem | null, input: ContentInput): StoredItem {
    const t = iso();
    const usedIds = new Set<string>();
    const fields: Field[] = input.fields.map((f) => {
      const old = prev?.fields.find((p) => p.id === f.id);
      let value = f.value;
      if (value === null) {
        // SPEC 3.6: null is valid only for an existing field whose kind stays the same.
        if (!old || old.kind !== f.kind) throw fail("invalid", `Enter a value for ${f.label || "this field"}.`);
        value = old.value;
      }
      let id = (f.id ?? "").trim() || uuid();
      if (usedIds.has(id)) id = uuid();
      usedIds.add(id);
      return { id, label: f.label, kind: f.kind, value, section: f.section ?? null, builtin: f.builtin ?? null, options: f.options ? [...f.options] : undefined };
    });
    const content: ItemContent = {
      type: input.type,
      title: input.title.trim(),
      favorite: !!input.favorite,
      tags: [...new Set((input.tags ?? []).map((s) => s.trim()).filter(Boolean))],
      fields,
      notes: input.notes ?? "",
      urls: (input.urls ?? []).filter((u) => u.url.trim() !== "").map((u) => ({ url: u.url.trim(), label: u.label ?? null })),
      apps: (input.apps ?? []).map((a) => a.trim()).filter(Boolean),
      reprompt: !!input.reprompt,
      autotypeSequence: input.autotypeSequence ?? null,
      healthExcluded: !!input.healthExcluded,
    };
    const newPw = valueOfRole(content, "password");
    if (!prev) {
      return {
        ...content,
        id: uuid(),
        rev: 1,
        state: "active",
        createdAt: t,
        updatedAt: t,
        trashedAt: null,
        passwordChangedAt: newPw ? t : null,
        attachments: [],
        passwordHistory: [],
        revisions: [],
        lastUsedAt: null,
      };
    }
    const oldPw = valueOfRole(prev, "password");
    const history = [...prev.passwordHistory];
    let passwordChangedAt = prev.passwordChangedAt;
    if (newPw !== oldPw) {
      if (oldPw) history.unshift({ id: uuid(), value: oldPw, changedAt: t });
      if (newPw) passwordChangedAt = t;
    }
    return {
      ...prev,
      ...content,
      rev: prev.rev + 1,
      updatedAt: t,
      passwordChangedAt,
      passwordHistory: history.slice(0, 20),
      revisions: [{ rev: prev.rev, savedAt: prev.updatedAt, snapshot: contentOf(prev) }, ...prev.revisions].slice(0, 10),
    };
  }

  /** SPEC 5: a generated value enters history when it is copied or saved into an item. */
  function keepGenerated(value: string): void {
    if (!vault || state !== "unlocked" || !value) return;
    const mode = pendingGenerated.get(value) ?? (/^\d{4,12}$/.test(value) ? "pin" : "random");
    pendingGenerated.delete(value);
    if (vault.genHistory[0]?.value === value) return;
    vault.genHistory.unshift({ id: uuid(), value, createdAt: iso(), mode });
    vault.genHistory = vault.genHistory.slice(0, 50);
  }

  function genEntry(id: string) {
    const entry = requireUnlocked().genHistory.find((g) => g.id === id);
    if (!entry) throw fail("notFound", "This password is no longer in Generator history.");
    return entry;
  }

  function hotkeyStatus(combo: string | null): "ok" | "inUse" | "off" {
    if (!combo) return "off";
    return RESERVED_HOTKEYS.some((r) => r.toLowerCase() === combo.toLowerCase()) ? "inUse" : "ok";
  }

  function setState(item: StoredItem, next: ItemState): boolean {
    if (item.state === next) return false;
    item.state = next;
    item.trashedAt = next === "trashed" ? iso() : null;
    item.rev++;
    return true;
  }

  // ---------- commands ----------
  const handlers: Handlers = {
    app_info: (): AppInfo => ({
      version: "0.1.0",
      computerName: COMPUTER_NAME,
      defaultFolder: DEMO_DEFAULT_FOLDER,
      hotkeyStatus: { quick: hotkeyStatus(settings.hotkeyQuick), lock: hotkeyStatus(settings.hotkeyLock) },
      helloAvailable: false,
      demo: true,
    }),

    folder_info: () => folderInfo(DEMO_DEFAULT_FOLDER),

    folder_pick: () => {
      if (flags.cancelDialogs) return null;
      pickedFolder = DEMO_PICKED_FOLDER;
      return folderInfo(pickedFolder);
    },

    vault_status: () => status(),

    vault_create: async ({ name, password, usePickedFolder }) => {
      const stem = vaultStem(name);
      if (!stem) throw fail("invalid", "Give the vault a name.");
      const folder = usePickedFolder ? pickedFolder : DEMO_DEFAULT_FOLDER;
      if (!folder) throw fail("invalid", "Choose a folder first.");
      const path = joinPath(folder, `${stem}.coffer`);
      const taken = stem.toLowerCase() === "existing" || (!!vault && (state === "locked" || state === "unlocked") && vault.path.toLowerCase() === path.toLowerCase());
      if (taken) throw fail("exists", `A vault file named ${stem}.coffer is already in this folder.`);
      const pw = normalizePassword(password);
      if (strength(pw, [stem]).score < 3) throw fail("weakPassword", "Choose a stronger master password.");
      await delay("kdf");
      lockNow("manual");
      vault = newVault(path, [], pw, 1, generateSecretKey());
      vault.createdAt = iso();
      state = "unlocked";
      needsSecretKey = false;
      fileGone = false;
      olderPending = null;
      return kit(vault);
    },

    secret_key_rotate: () => {
      throw fail("invalid", "Not available in this version.");
    },

    vault_open: () => {
      if (flags.cancelDialogs) return null;
      lockNow("manual");
      vault = demoVault(joinPath(DEMO_PICKED_FOLDER, "Personal.coffer"));
      state = "locked";
      needsSecretKey = true;
      fileGone = false;
      olderPending = null;
      return status();
    },

    vault_unlock: async ({ password, secretKey }) => {
      if (!vault || state === "noVault") throw fail("invalid", "There is no vault on this PC yet. Create one or open an existing vault.");
      if (state === "missing") throw fail("vaultMissing", `Coffer cannot find your vault at ${vault.path}.`);
      if (state === "unlocked") return status();
      let typed: string | null = null;
      if (needsSecretKey) {
        if (!secretKey || !secretKey.trim()) throw fail("needsSecretKey", "Enter the Secret Key from your Emergency Kit.");
        const p = parseSecretKey(secretKey);
        // Typos and a key of another vault are caught before the KDF runs (SPEC 3.2).
        if (!p.valid || !p.canonical) throw fail("badSecretKey", "This Secret Key has a typo. Check each group.");
        if (p.keyId !== vault.keyId) throw fail("badSecretKey", "This Secret Key is for another vault.");
        typed = p.canonical;
      }
      const started = now();
      const right = normalizePassword(password) === vault.password && (typed === null || typed === vault.secretKey);
      // SPEC 7: the real app computes flags at unlock on a worker thread. The demo does
      // that zxcvbn work (about 1 s for the demo vault) inside the simulated KDF wait.
      if (right) health(vault);
      await delay("kdf", now() - started);
      if (!right) {
        // SPEC 3.3: one code; the words depend on where the Secret Key came from.
        throw fail("badCredentials", typed ? "The master password or the Secret Key is wrong." : "Wrong master password.");
      }
      if (flags.tampered) throw fail("tampered", "This vault file was changed outside Coffer.");
      if (olderNext) {
        olderPending = { until: now() + 60_000, typedKey: typed };
        throw fail("olderFile", "This file is older than the last version this PC saw (generation 41, this file 38).");
      }
      return finishUnlock(vault, typed);
    },

    vault_open_older: () => {
      const v = requireVault();
      if (!olderPending || olderPending.until < now() || state !== "locked") {
        olderPending = null;
        throw fail("invalid", "Unlock the vault again first.");
      }
      const typed = olderPending.typedKey;
      olderPending = null;
      olderNext = false;
      return finishUnlock(v, typed);
    },

    vault_unlock_hello: () => {
      throw fail("invalid", "Not available in this version.");
    },

    vault_lock: () => {
      lockNow("manual");
    },

    vault_change_password: async ({ current, next, rekey }) => {
      const v = requireUnlocked();
      await checkMaster(current);
      const pw = normalizePassword(next);
      if (strength(pw, [v.name]).score < 3) throw fail("weakPassword", "Choose a stronger master password.");
      v.password = pw;
      // "My old password may be known": a new vault key, so this PC's old backups are deleted.
      if (rekey) v.backups = [];
      commit([]);
    },

    vault_move: () => {
      const v = requireVault();
      if (flags.cancelDialogs) return null;
      v.path = joinPath(DEMO_PICKED_FOLDER, `${v.name}.coffer`);
      return status();
    },

    vault_save_again: ({ saveAs }) => {
      const v = requireVault();
      if (saveAs && flags.cancelDialogs) return null;
      if (saveAs) v.path = joinPath("C:\\Users\\alex\\Desktop", `${v.name}.coffer`);
      // Rewrites the file at highest seen + 1 and clears the save block (SPEC 3.5).
      fileGone = false;
      blocked = null;
      banners.diskDamaged = banners.olderOnDisk = banners.missing = false;
      if (state === "missing") state = "locked";
      if (state === "unlocked") commit([]);
      return status();
    },

    hello_set: () => {
      throw fail("helloUnavailable", "Windows Hello is not set up on this PC.");
    },

    secret_key_validate: ({ secretKey }) => {
      const p = parseSecretKey(secretKey ?? "");
      return { valid: p.valid, keyId: p.keyId };
    },

    emergency_kit: async ({ password }) => {
      const v = requireUnlocked();
      await checkMaster(password);
      return kit(v);
    },

    kdf_benchmark: async () => {
      await delay("kdf");
      return { millis: 610 + randInt(240), mKib: 131072, t: 3, p: 4 };
    },

    // ----- items -----
    items_list: () => {
      const v = requireUnlocked();
      const h = health(v);
      return [...v.items.values()].sort((a, b) => a.title.localeCompare(b.title)).map((i) => summaryOf(i, h.flags.get(i.id) ?? NO_FLAGS));
    },

    item_get: ({ id }) => viewOf(getItem(id), flagsOf(requireUnlocked(), id)),

    item_reveal: async ({ id, field, password }) => {
      const item = getItem(id);
      const ref = String(field ?? "");
      const r = resolveRef(item, ref);
      if (!r) throw fail("notFound", `This item has no ${missingWords(item.type, ref, r)}.`);
      if (r.secret) await checkReprompt(item, password);
      item.lastUsedAt = iso(); // a reveal is a "use" (SPEC 9)
      // A totp field reveals its URI (for editing); item_copy gives the current code.
      return r.kind === "history" ? r.entry.value : r.field.value;
    },

    item_copy: async ({ id, field, password }) => {
      const item = getItem(id);
      const ref = String(field ?? "");
      const r = resolveRef(item, ref);
      const value = r ? (r.kind === "history" ? r.entry.value : r.field.value) : "";
      if (!r || value.trim() === "") throw fail("notFound", `This item has no ${missingWords(item.type, ref, r)}.`);
      if (r.secret) await checkReprompt(item, password);
      let copied = value;
      if (r.kind === "field" && r.field.kind === "totp") {
        const p = parseTotp(value);
        if (!p) throw fail("invalid", "This one-time code secret is not valid.");
        copied = (await totpAt(p, now() / 1000)).code; // the CURRENT code, not the secret
      }
      item.lastUsedAt = iso();
      return clipboardCopy(r.label, copied);
    },

    item_save: async ({ item: input, password }) => {
      const v = requireUnlocked();
      if (!input || !BUILTIN_FIELDS[input.type]) throw fail("invalid", "This item type is not known.");
      if (!(input.title ?? "").trim()) throw fail("invalid", "Add a title.");
      let prev: StoredItem | null = null;
      if (input.id) {
        prev = v.items.get(input.id) ?? null;
        if (!prev) throw fail("notFound", "This item is no longer in the vault.");
        if (input.baseRev !== prev.rev) throw fail("conflict", "This item changed since you opened it. Reload it and try again.");
        if (weakensReprompt(prev, input)) await requireGrant(prev.id, password);
      }
      const saved = applyContent(prev, input);
      v.items.set(saved.id, saved);
      for (const f of saved.fields) {
        if (isSecretKind(f.kind) && pendingGenerated.has(f.value) && prev?.fields.find((p) => p.id === f.id)?.value !== f.value) keepGenerated(f.value);
      }
      commit([saved.id]);
      return viewOf(saved, flagsOf(v, saved.id));
    },

    item_patch: ({ id, favorite, tags, healthExcluded }) => {
      const v = requireUnlocked();
      const item = getItem(id);
      if (favorite !== undefined) item.favorite = !!favorite;
      if (tags !== undefined) item.tags = [...new Set(tags.map((s) => s.trim()).filter(Boolean))];
      if (healthExcluded !== undefined) item.healthExcluded = !!healthExcluded;
      item.rev++;
      commit([id]);
      return summaryOf(item, flagsOf(v, id));
    },

    item_set_state: ({ id, state: next }) => {
      const item = getItem(id);
      if (!["active", "archived", "trashed"].includes(next)) throw fail("invalid", "This item state is not known.");
      if (setState(item, next)) commit([id]);
    },

    items_bulk: ({ ids, action, tag }) => {
      const v = requireUnlocked();
      const t = (tag ?? "").trim();
      if ((action === "addTag" || action === "removeTag") && !t) throw fail("invalid", "Choose a tag.");
      const changed: string[] = [];
      for (const id of ids ?? []) {
        const item = v.items.get(id);
        if (!item) continue;
        let did = false;
        if (action === "archive") did = setState(item, "archived");
        else if (action === "trash") did = setState(item, "trashed");
        else if (action === "restore") did = setState(item, "active");
        else if (action === "addTag" && !item.tags.includes(t)) {
          item.tags = [...item.tags, t];
          item.rev++;
          did = true;
        } else if (action === "removeTag" && item.tags.includes(t)) {
          item.tags = item.tags.filter((x) => x !== t);
          item.rev++;
          did = true;
        }
        if (did) changed.push(id);
      }
      if (changed.length) commit(changed);
      return changed.length;
    },

    item_delete_forever: ({ id }) => {
      const v = requireUnlocked();
      getItem(id);
      v.items.delete(id);
      grants.delete(id);
      commit([id]);
    },

    trash_empty: () => {
      const v = requireUnlocked();
      const ids = [...v.items.values()].filter((i) => i.state === "trashed").map((i) => i.id);
      for (const id of ids) v.items.delete(id);
      if (ids.length) commit(ids);
      return ids.length;
    },

    item_revisions: async ({ id, password }) => {
      const item = getItem(id);
      await checkReprompt(item, password);
      return item.revisions.map((r) => ({ rev: r.rev, savedAt: r.savedAt, title: r.snapshot.title }));
    },

    item_restore_revision: async ({ id, rev, password }) => {
      const v = requireUnlocked();
      const item = getItem(id);
      const r = item.revisions.find((x) => x.rev === rev);
      if (!r) throw fail("notFound", "This version is no longer kept.");
      const snapshot = contentOf(r.snapshot);
      if (weakensReprompt(item, snapshot)) await requireGrant(id, password);
      const restored = applyContent(item, snapshot);
      v.items.set(id, restored);
      commit([id]);
      return viewOf(restored, flagsOf(v, id));
    },

    item_password_history: async ({ id, password }) => {
      const item = getItem(id);
      await checkReprompt(item, password);
      return item.passwordHistory.map((e) => ({ id: e.id, changedAt: e.changedAt, length: [...e.value].length }));
    },

    item_open_url: ({ id, urlIndex }) => {
      const item = getItem(id);
      const u = item.urls[urlIndex];
      if (!u) throw fail("notFound", "This item has no such web address.");
      if (!/^https?:\/\//i.test(u.url.trim())) throw fail("invalid", "Coffer opens only http and https addresses.");
      item.lastUsedAt = iso(); // "open site" is a use; demo: nothing opens (no network, ever)
    },

    totp_code: async ({ id, field, password }) => {
      const item = getItem(id);
      const f = field
        ? (item.fields.find((x) => x.builtin === field && x.kind === "totp") ?? item.fields.find((x) => x.id === field && x.kind === "totp"))
        : (item.fields.find((x) => x.builtin === "totp" && x.value.trim()) ?? item.fields.find((x) => x.kind === "totp" && x.value.trim()));
      if (!f || !f.value.trim()) throw fail("notFound", "This item has no one-time code.");
      await checkReprompt(item, password);
      const p = parseTotp(f.value);
      if (!p) throw fail("invalid", "This one-time code secret is not valid.");
      return totpAt(p, now() / 1000);
    },

    totp_parse: ({ input }) => {
      const p = parseTotp(input ?? "");
      return { issuer: p?.issuer ?? null, account: p?.account ?? null, valid: !!p };
    },

    totp_from_image: () => {
      throw fail("invalid", "Not available in this version.");
    },

    ssh_generate: () => {
      throw fail("invalid", "Not available in this version.");
    },

    // ----- generator -----
    // Like Rust: generate stores the options it used; generator_options returns them (defaults before the first).
    generator_options: () => {
      requireUnlocked();
      return { ...(lastGeneratorOptions ?? DEMO_GENERATOR_DEFAULTS) };
    },
    generate: ({ options }) => {
      try {
        const g = generateValue(options ?? {});
        if (options) lastGeneratorOptions = { ...options };
        const mode: GeneratorMode = options?.mode === "passphrase" || options?.mode === "pin" ? options.mode : "random";
        pendingGenerated.set(g.value, mode);
        if (pendingGenerated.size > 100) pendingGenerated.delete(pendingGenerated.keys().next().value as string);
        return g;
      } catch (e) {
        if (e instanceof GeneratorError) throw fail("invalid", e.message);
        throw e;
      }
    },

    generator_copy: ({ value }) => {
      if (!value) throw fail("invalid", "There is no password to copy.");
      keepGenerated(value); // kept only while unlocked
      return clipboardCopy("Generated password", value);
    },

    generator_history: () =>
      requireUnlocked().genHistory.map((g) => ({ id: g.id, createdAt: g.createdAt, length: [...g.value].length, mode: g.mode })),

    generator_history_reveal: ({ id }) => genEntry(id).value,

    generator_history_copy: ({ id }) => clipboardCopy("Generated password", genEntry(id).value),

    generator_history_clear: () => {
      requireUnlocked().genHistory = [];
    },

    password_strength: ({ password, userInputs }) => {
      if (!password) return { score: 0, crackTime: "less than a second", warning: null };
      return strength(password, userInputs ?? []);
    },

    // ----- health -----
    health_report: (): HealthReport => health(requireUnlocked()).report,

    health_check_breaches: async () => {
      const v = requireUnlocked();
      await delay("slow"); // demo: no network, ever
      v.breachCheckedAt = iso();
      const h = health(v);
      commit([]);
      const ids = [...h.flags].filter(([, f]) => f.breached).map(([id]) => id);
      if (ids.length) emit("vault://changed", { ids });
      return h.report;
    },

    // ----- import / export -----
    import_preview: async ({ source, password, secretKey }) => {
      const v = requireUnlocked();
      let file = lastImportFile;
      if (source === "conflict") {
        // The last conflict file Coffer wrote: our own vault keys open it.
        file = { source: "conflict", locked: false, needsKey: false };
      } else if (source === "last") {
        if (!file) throw fail("invalid", "Choose the file again.");
      } else {
        if (flags.cancelDialogs) return null;
        file = lastImportFile = {
          source: flags.importCoffer ? "coffer" : "bitwarden",
          locked: flags.importCoffer || flags.importEncrypted,
          needsKey: flags.importCoffer && flags.importCofferKey,
        };
      }
      const keyOk = !file.needsKey || (!!secretKey && parseSecretKey(secretKey).valid);
      await delay(file.locked && password && keyOk ? "kdf" : "file");
      if ((file.locked && !password) || !keyOk) {
        const p = lockedPreview(file.source, file.locked && !password, !keyOk);
        issuedPreviews.add(p.previewId);
        return p;
      }
      const plan = planImport(file.source, [...v.items.values()]);
      previews.set(plan.preview.previewId, plan);
      issuedPreviews.add(plan.preview.previewId);
      return plan.preview;
    },

    import_commit: ({ previewId }) => {
      const v = requireUnlocked();
      const plan = previews.get(previewId);
      if (!plan) throw fail("notFound", "This import preview has expired. Choose the file again.");
      previews.delete(previewId);
      const ids: string[] = [];
      for (const c of plan.items) {
        // New ids for the item and its fields (SPEC 8).
        const fields = c.fields.map((f) => ({ ...f, id: uuid() }));
        const item = applyContent(null, { ...contentOf(c), fields, tags: [...c.tags, plan.tag] });
        item.passwordChangedAt = null; // the fake source carries no date: left empty (SPEC 4)
        v.items.set(item.id, item);
        ids.push(item.id);
      }
      const batchId = uuid();
      batches.set(batchId, ids);
      commit(ids); // ONE write for the whole batch
      return { batchId, imported: ids.length, skipped: plan.skipped, tag: plan.tag };
    },

    import_undo: ({ batchId }) => {
      const v = requireUnlocked();
      const changed: string[] = [];
      for (const id of batches.get(batchId) ?? []) {
        const item = v.items.get(id);
        if (item && setState(item, "trashed")) changed.push(id);
      }
      batches.delete(batchId);
      if (changed.length) commit(changed);
      return changed.length;
    },

    import_delete_source: ({ previewId }) => {
      requireUnlocked();
      if (!issuedPreviews.has(previewId)) throw fail("notFound", "Coffer no longer knows which file this was.");
      // Demo: no file is touched.
    },

    export_vault: async ({ kind, masterPassword, exportPassword }) => {
      requireUnlocked();
      await checkMaster(masterPassword);
      if (kind === "cofferEncrypted") {
        if (!exportPassword) throw fail("invalid", "Choose a password for the export file.");
        if (strength(normalizePassword(exportPassword), []).score < 3) throw fail("weakPassword", "Choose a stronger password for the export file.");
      }
      const day = iso().slice(0, 10);
      const file = {
        cofferEncrypted: `coffer-export-${day}.cofferx`,
        cofferJson: `coffer-export-${day}.json`,
        bitwardenJson: `bitwarden-export-${day}.json`,
        csv: `coffer-export-${day}.csv`,
      }[kind];
      if (!file) throw fail("invalid", "This export kind is not known.");
      if (flags.cancelDialogs) return null;
      return { path: joinPath("C:\\Users\\alex\\Downloads", file) };
    },

    // Backup commands work in every state (SPEC 3.5).
    backups_list: (): BackupEntry[] => {
      if (!vault || state === "noVault") return [];
      return vault.backups.map((b, index) => ({ index, savedAt: b.savedAt, size: b.size, generation: b.generation }));
    },

    backup_restore: async ({ index }) => {
      const v = requireVault();
      const b = v.backups[index];
      if (!b) throw fail("notFound", "This backup is no longer there.");
      await delay("file");
      const restored = new Map((JSON.parse(b.items) as StoredItem[]).map((i) => [i.id, i]));
      if (state === "unlocked") {
        // Unlocked: the backup's records under the current header, generation = highest seen + 1.
        const ids = new Set([...v.items.keys(), ...restored.keys()]);
        blocked = null; // "Restore a backup" answers the damaged-file banner
        fileGone = false;
        banners.diskDamaged = banners.olderOnDisk = banners.missing = false;
        v.backups.unshift(backupOf(v.items.values(), v.generation, iso()));
        v.items = restored;
        commit([...ids]);
        emit("vault://reloaded", {});
      } else {
        // Locked or missing: back up the current file (if any), copy the backup in.
        if (state === "locked") v.backups.unshift(backupOf(v.items.values(), v.generation, iso()));
        v.items = restored;
        v.generation = b.generation;
        state = "locked";
        fileGone = false;
        banners.missing = false;
        // The highest seen generation is now the backup's: the file is no longer "older".
        olderNext = false;
        olderPending = null;
      }
      return status();
    },

    // ----- settings -----
    settings_get: () => ({ ...settings }),

    settings_set: ({ patch }) => {
      const p: Partial<Settings> = { ...(patch ?? {}) };
      if ("helloEnabled" in p) throw fail("invalid", "Windows Hello is turned on or off with your master password.");
      const next = { ...settings };
      for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>) {
        if (key in p && p[key] !== undefined) (next as Record<keyof Settings, unknown>)[key] = p[key];
      }
      // Rust's settings::apply_patch checks this too; the UI shows the message and keeps the old value.
      if (next.hotkeyLock && next.hotkeyLock.toLowerCase() === next.hotkeyQuick.toLowerCase()) {
        throw fail("invalid", "The Lock shortcut and the Quick Access shortcut must differ.");
      }
      settings = next;
      return { ...settings };
    },

    quick_hint_seen: () => {
      settings = { ...settings, quickHintsShown: settings.quickHintsShown + 1 };
    },

    edit_state: ({ title, dirty }) => {
      editState = { title: title ?? null, dirty: !!dirty };
    },

    // ----- quick access and shell -----
    quick_context: () => quickContext(),
    quick_hide: () => undefined,
    quick_set_modal: () => undefined,
    main_show: ({ itemId, view }) => {
      if (itemId || view) emit("main://navigate", { itemId: itemId ?? null, view: view ?? null });
    },
    autotype: () => {
      throw fail("invalid", "Not available in this version.");
    },
    main_hide: () => undefined,
    app_quit: () => undefined,
  };

  // ---------- demo-only ----------
  function simulate(what: string, title?: string): boolean {
    switch (what) {
      case "idleLock":
        lockNow("idle");
        return true;
      case "systemLock":
        lockNow("systemLock");
        return true;
      case "sleepLock":
        lockNow("sleep");
        return true;
      case "quitLock":
        lockNow("quit");
        return true;
      case "fileMissing":
        if (!vault || state !== "unlocked") return false;
        fileGone = true;
        emit("vault://missing", { path: vault.path });
        return true;
      case "conflict": {
        if (!vault) return false;
        const stamp = iso().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z"); // YYYYMMDDTHHMMSSZ (SPEC 3.5)
        emit("vault://conflict", { conflictPath: vault.path.replace(/\.coffer$/i, ` (conflict ${stamp}).coffer`), since: iso(now() - 25 * 60_000) });
        return true;
      }
      case "reloaded":
        emit("vault://reloaded", {});
        return true;
      case "quickShown":
        emit("quick://shown", quickContext());
        return true;
      case "editDiscarded":
        emit("edit://discarded", { title: title ?? "GitHub" });
        return true;
      case "quitRequested":
        emit("app://quitRequested", {});
        return true;
      case "closeNotice":
        // A browser tab has no window close; this stands in for the first close with closeBehavior "hide".
        emit("main://closeNotice", {});
        return true;
      case "keyChanged": {
        // Like Rust (SPEC 3.5): write the open state to a conflict file, say so, then lock.
        if (!vault || state !== "unlocked") return false;
        const stamp = iso().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
        emit("vault://conflict", { conflictPath: vault.path.replace(/\.coffer$/i, ` (conflict ${stamp}).coffer`), since: iso() });
        lockNow("keyChanged");
        return true;
      }
      default:
        return false;
    }
  }

  try {
    if (typeof window !== "undefined") {
      (window as unknown as Record<string, unknown>).__cofferDemo = { simulate, fileGone: () => fileGone };
    }
  } catch {
    // no window (tests)
  }

  return {
    async invoke(name: string, args: Record<string, unknown>): Promise<unknown> {
      await delay("base");
      if (name === "demo_simulate") return simulate(String(args?.what ?? ""), args?.title ? String(args.title) : undefined);
      if (name === "demo_clipboard") return lastCopied;
      const h = (handlers as unknown as Record<string, ((a: unknown) => unknown) | undefined>)[name];
      if (!h) throw fail("invalid", `Unknown command: ${name}`);
      try {
        if (WRITE_COMMANDS.has(name)) assertCanSave();
        return await h(args ?? {});
      } catch (e) {
        if (isCofferError(e)) throw { code: e.code, message: e.message } satisfies CofferError;
        console.error(`[demo] ${name} failed`, e);
        throw fail("io", `The demo backend failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },

    listen(event: string, handler: (payload: unknown) => void): () => void {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(handler);
      if (undelivered.has(event)) {
        const payload = undelivered.get(event);
        undelivered.delete(event);
        emit(event as keyof Events, payload as never);
      }
      // The Quick Access page was "shown" when it opened: tell its first listener once.
      if (opts.page === "quick" && event === "quick://shown" && !quickShownSent) {
        quickShownSent = true;
        emit("quick://shown", quickContext());
      }
      return () => {
        listeners.get(event)?.delete(handler);
      };
    },
  };
}

/** The stable demo ids (tests and screenshots). */
export const demoIds = { github: GITHUB_ID, of: (key: string): string => stableId(key) };
