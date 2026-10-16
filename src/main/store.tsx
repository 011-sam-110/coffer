// Main-window state: app info, vault status, settings and the item summaries.
// The UI clears its items on vault://locked (SPEC 3.6).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AppInfo, Events, ItemSummary, Settings, VaultStatus } from "../lib/contract";
import { call, on } from "../lib/ipc";
import { useToast } from "../components/overlays";

export type Banner =
  | { kind: "missing"; path: string }
  | { kind: "conflict"; path: string; since: string }
  | { kind: "reloaded" }
  | { kind: "diskDamaged"; path: string }
  | { kind: "olderOnDisk"; fileGeneration: number; seenGeneration: number }
  | null;

interface Store {
  info: AppInfo | null;
  status: VaultStatus | null;
  settings: Settings | null;
  items: ItemSummary[];
  itemsLoaded: boolean;
  banner: Banner;
  lockedReason: Events["vault://locked"]["reason"] | null;
  /** Changes in a conflict file that are not imported yet: the sidebar keeps a notice until they are. */
  pendingConflict: { path: string; since: string } | null;
  setPendingConflict: (c: { path: string; since: string } | null) => void;
  /** The "Import my changes" dialog (opened from the banner or the sidebar notice). */
  conflictDialog: boolean;
  setConflictDialog: (open: boolean) => void;
  /** The conflict file that a keyChanged lock wrote our open changes to (SPEC 3.5); null otherwise. */
  keyChangedFile: string | null;
  /** Bumps on every vault://changed, so open views can reload. */
  changeTick: number;
  setBanner: (b: Banner) => void;
  setStatus: (s: VaultStatus) => void;
  refreshStatus: () => Promise<VaultStatus | null>;
  /** Reads app_info again (hotkeyStatus changes when another app takes or frees a shortcut). */
  refreshInfo: () => Promise<void>;
  refreshItems: () => Promise<void>;
  updateSettings: (patch: Partial<Settings>) => Promise<Settings | null>;
  lock: () => Promise<void>;
}

const Ctx = createContext<Store | null>(null);

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore outside StoreProvider");
  return s;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [items, setItems] = useState<ItemSummary[]>([]);
  const [itemsLoaded, setItemsLoaded] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);
  const [lockedReason, setLockedReason] = useState<Store["lockedReason"]>(null);
  const [keyChangedFile, setKeyChangedFile] = useState<string | null>(null);
  const [pendingConflict, setPendingConflict] = useState<Store["pendingConflict"]>(null);
  const [conflictDialog, setConflictDialog] = useState(false);
  // Rust writes the conflict file and emits vault://conflict just before a keyChanged lock.
  const lastConflict = useRef<{ path: string; at: number } | null>(null);
  // Bumps on each lock: an items_list answer that was asked for before the lock is dropped.
  const lockEpoch = useRef(0);
  const [changeTick, setChangeTick] = useState(0);
  const statusRef = useRef<VaultStatus | null>(null);
  statusRef.current = status;
  const { error: showError } = useToast();

  const refreshStatus = useCallback(async () => {
    try {
      const s = await call("vault_status");
      setStatus(s);
      return s;
    } catch {
      return null;
    }
  }, []);

  const refreshItems = useCallback(async () => {
    const epoch = lockEpoch.current;
    try {
      const list = await call("items_list");
      if (epoch !== lockEpoch.current) return; // Coffer locked meanwhile: a locked vault shows no items
      setItems(list);
      setItemsLoaded(true);
    } catch (e) {
      if ((e as { code?: string }).code === "locked") {
        setItems([]);
        setItemsLoaded(false);
      }
    }
  }, []);

  const refreshInfo = useCallback(async () => {
    try {
      setInfo(await call("app_info"));
    } catch {
      // keep the last info
    }
  }, []);

  // A failed save shows Rust's message; the controls show `settings`, which did not change, so they go back.
  const updateSettings = useCallback(
    async (patch: Partial<Settings>) => {
      try {
        const s = await call("settings_set", { patch });
        setSettings(s);
        if ("hotkeyQuick" in patch || "hotkeyLock" in patch) refreshInfo();
        return s;
      } catch (e) {
        showError(e);
        return null;
      }
    },
    [refreshInfo, showError],
  );

  const lock = useCallback(async () => {
    await call("vault_lock");
  }, []);

  useEffect(() => {
    call("app_info").then(setInfo).catch(() => undefined);
    call("settings_get").then(setSettings).catch(() => undefined);
    refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    if (status?.state === "unlocked") refreshItems();
  }, [status?.state, refreshItems]);

  useEffect(() => {
    const offs = [
      on("vault://locked", (p) => {
        lockEpoch.current += 1;
        setItems([]);
        setItemsLoaded(false);
        setLockedReason(p.reason);
        const c = lastConflict.current;
        setKeyChangedFile(p.reason === "keyChanged" && c && Date.now() - c.at < 10_000 ? c.path : null);
        setBanner(null);
        setPendingConflict(null);
        setConflictDialog(false);
        refreshStatus();
      }),
      on("vault://unlocked", (s) => {
        setStatus(s);
        setLockedReason(null);
        setKeyChangedFile(null);
      }),
      on("vault://changed", () => {
        refreshItems();
        setChangeTick((t) => t + 1);
      }),
      on("vault://reloaded", () => {
        refreshItems();
        setChangeTick((t) => t + 1);
        setBanner({ kind: "reloaded" });
      }),
      on("vault://conflict", (p) => {
        lastConflict.current = { path: p.conflictPath, at: Date.now() };
        setPendingConflict({ path: p.conflictPath, since: p.since });
        refreshItems();
        setChangeTick((t) => t + 1);
        setBanner({ kind: "conflict", path: p.conflictPath, since: p.since });
      }),
      on("vault://missing", (p) => setBanner({ kind: "missing", path: p.path })),
      on("vault://diskDamaged", (p) => setBanner({ kind: "diskDamaged", path: p.path })),
      on("vault://olderOnDisk", (p) => setBanner({ kind: "olderOnDisk", fileGeneration: p.fileGeneration, seenGeneration: p.seenGeneration })),
    ];
    return () => offs.forEach((off) => off());
  }, [refreshItems, refreshStatus]);

  const value = useMemo<Store>(
    () => ({
      info,
      status,
      settings,
      items,
      itemsLoaded,
      banner,
      lockedReason,
      keyChangedFile,
      pendingConflict,
      setPendingConflict,
      conflictDialog,
      setConflictDialog,
      changeTick,
      setBanner,
      setStatus,
      refreshStatus,
      refreshInfo,
      refreshItems,
      updateSettings,
      lock,
    }),
    [info, status, settings, items, itemsLoaded, banner, lockedReason, keyChangedFile, pendingConflict, conflictDialog, changeTick, refreshStatus, refreshInfo, refreshItems, updateSettings, lock],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
