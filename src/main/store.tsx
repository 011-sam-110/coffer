// Main-window state: app info, vault status, settings and the item summaries.
// The UI clears its items on vault://locked (SPEC 3.6).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AppInfo, Events, ItemSummary, Settings, VaultStatus } from "../lib/contract";
import { call, on } from "../lib/ipc";

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
  /** Bumps on every vault://changed, so open views can reload. */
  changeTick: number;
  setBanner: (b: Banner) => void;
  setStatus: (s: VaultStatus) => void;
  refreshStatus: () => Promise<VaultStatus | null>;
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
  const [changeTick, setChangeTick] = useState(0);
  const statusRef = useRef<VaultStatus | null>(null);
  statusRef.current = status;

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
    try {
      const list = await call("items_list");
      setItems(list);
      setItemsLoaded(true);
    } catch (e) {
      if ((e as { code?: string }).code === "locked") {
        setItems([]);
        setItemsLoaded(false);
      }
    }
  }, []);

  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    try {
      const s = await call("settings_set", { patch });
      setSettings(s);
      return s;
    } catch {
      return null;
    }
  }, []);

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
        setItems([]);
        setItemsLoaded(false);
        setLockedReason(p.reason);
        setBanner(null);
        refreshStatus();
      }),
      on("vault://unlocked", (s) => {
        setStatus(s);
        setLockedReason(null);
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
      changeTick,
      setBanner,
      setStatus,
      refreshStatus,
      refreshItems,
      updateSettings,
      lock,
    }),
    [info, status, settings, items, itemsLoaded, banner, lockedReason, changeTick, refreshStatus, refreshItems, updateSettings, lock],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
