// The three-pane vault: sidebar, list, detail (or a full view such as Health).
// Owns the main-window keyboard map (SPEC 9) and the vault-level banners.
import { CloudAlert, Download, FileWarning, History, Keyboard, Plus, SearchX } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useToast } from "../../components/overlays";
import { PathText } from "../../components/bits";
import { Button, Keys, Notice } from "../../components/ui";
import { formatDateTime } from "../../lib/format";
import { call } from "../../lib/ipc";
import { useStore } from "../store";
import { GeneratorView } from "../views/GeneratorView";
import { HealthView } from "../views/HealthView";
import { ImportWizard } from "../views/ImportWizard";
import { SettingsView } from "../views/SettingsView";
import { BackupList } from "../screens/Locked";
import { Dialog } from "../../components/overlays";
import { ItemDetail } from "./ItemDetail";
import { ItemEditor } from "./ItemEditor";
import { ItemList } from "./ItemList";
import { inTextField, KeysContext, type KeyAction, type KeyHandlers, type Nav } from "./nav";
import { Sidebar } from "./Sidebar";

function Banners() {
  const { banner, setBanner, setStatus } = useStore();
  const { error, toast } = useToast();
  const [restore, setRestore] = useState(false);
  const [importConflict, setImportConflict] = useState(false);
  if (!banner) return null;
  const saveAgain = async (saveAs: boolean) => {
    try {
      const s = await call("vault_save_again", { saveAs });
      if (s) {
        setStatus(s);
        setBanner(null);
        toast("Vault saved.");
      }
    } catch (e) {
      error(e);
    }
  };
  let body: ReactNode = null;
  if (banner.kind === "missing")
    body = (
      <Notice
        tone="danger"
        role="alert"
        icon={<SearchX />}
        actions={
          <>
            <Button size="sm" variant="strong" onClick={() => saveAgain(false)}>
              Save it here again
            </Button>
            <Button size="sm" onClick={() => saveAgain(true)}>
              Save as...
            </Button>
          </>
        }
      >
        The vault file is gone from <PathText path={banner.path} />. Your items are still open.
      </Notice>
    );
  else if (banner.kind === "diskDamaged")
    body = (
      <Notice
        tone="danger"
        role="alert"
        icon={<FileWarning />}
        actions={
          <>
            <Button size="sm" variant="strong" onClick={() => saveAgain(true)}>
              Save my open vault as...
            </Button>
            <Button size="sm" onClick={() => setRestore(true)}>
              Restore a backup
            </Button>
          </>
        }
      >
        The vault file on disk is damaged or was changed outside Coffer. Coffer stopped saving; your open items are safe in memory.
      </Notice>
    );
  else if (banner.kind === "olderOnDisk")
    body = (
      <Notice
        tone="warning"
        role="alert"
        icon={<History />}
        actions={
          <>
            <Button size="sm" variant="primary" onClick={() => saveAgain(false)}>
              Keep my open vault
            </Button>
            <Button
              size="sm"
              onClick={async () => {
                setBanner(null);
                await call("vault_lock").catch(error);
              }}
            >
              Load the older file
            </Button>
          </>
        }
      >
        An older copy of the vault file replaced the newer one, for example from a sync tool. The vault file on disk is older than the last version this PC saw (generation {banner.seenGeneration}, file {banner.fileGeneration}). Coffer stopped saving until you choose.
      </Notice>
    );
  else if (banner.kind === "conflict")
    body = (
      <Notice
        tone="warning"
        role="status"
        icon={<CloudAlert />}
        actions={
          <>
            <Button size="sm" onClick={() => setImportConflict(true)}>
              Import my changes
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setBanner(null)}>
              Dismiss
            </Button>
          </>
        }
      >
        This vault changed on another computer. Your changes since {formatDateTime(banner.since)} are in <PathText path={banner.path} />.
      </Notice>
    );
  else if (banner.kind === "reloaded")
    body = (
      <Notice
        icon={<CloudAlert />}
        actions={
          <Button size="sm" variant="ghost" onClick={() => setBanner(null)}>
            Dismiss
          </Button>
        }
      >
        Coffer loaded changes made on another computer.
      </Notice>
    );
  return (
    <div className="shrink-0 border-b border-border px-4 py-2.5">
      {body}
      <Dialog open={restore} onClose={() => setRestore(false)} title="Restore a backup" width={520}>
        <div className="pb-3">
          <BackupList
            onRestored={(s) => {
              setStatus(s);
              setRestore(false);
              setBanner(null);
            }}
          />
        </div>
      </Dialog>
      {importConflict && (
        <Dialog open onClose={() => setImportConflict(false)} title="Import my changes" width={640}>
          <div className="pb-4">
            <ImportWizard source="conflict" embedded onClose={() => {
              setImportConflict(false);
              setBanner(null);
            }} />
          </div>
        </Dialog>
      )}
    </div>
  );
}

function EmptyDetail({ go }: { go: (p: Partial<Nav>) => void }) {
  const { items, itemsLoaded } = useStore();
  if (!itemsLoaded) return null;
  if (items.length === 0)
    return (
      <div className="flex h-full items-center justify-center px-8 pb-[8vh]">
        <div className="flex max-w-[440px] flex-col items-center text-center">
          <h1 className="text-lg font-semibold">Your vault is empty</h1>
          <p className="mt-2 text-base text-muted-foreground">
            Start with what you use every day: email, bank and work. Moving from another password manager? Import tags everything it adds, so one click undoes it.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <Button variant="primary" className="h-9" icon={<Download className="size-4" />} onClick={() => go({ view: "import" })}>
              Import from another app
            </Button>
            <Button className="h-9" icon={<Plus className="size-4" />} onClick={() => go({ editing: "new", newType: "login", newTitle: "", itemId: null })}>
              New login
            </Button>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">From 1Password, Bitwarden, Dashlane, Chrome, Edge, Brave or Firefox.</p>
        </div>
      </div>
    );
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground">
      <Keyboard aria-hidden className="size-5" />
      <p>Select an item to see it.</p>
      <p className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs">
        <span className="inline-flex items-center gap-1.5">
          <Keys combo="Ctrl+F" /> search
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Keys combo="Ctrl+N" /> new item
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Keys combo="F1" /> all shortcuts
        </span>
      </p>
    </div>
  );
}

export function VaultShell({
  nav,
  go,
  onShowShortcuts,
  notice,
}: {
  nav: Nav;
  go: (patch: Partial<Nav>) => void;
  onShowShortcuts: () => void;
  /** A window-level notice shown above the panes (lock dropped an edit). */
  notice?: ReactNode;
}) {
  const { lock, items, itemsLoaded } = useStore();
  const searchRef = useRef<HTMLInputElement>(null);
  const registry = useRef(new Map<string, () => KeyHandlers>());
  const register = useCallback((owner: string, get: () => KeyHandlers) => {
    registry.current.set(owner, get);
    return () => {
      if (registry.current.get(owner) === get) registry.current.delete(owner);
    };
  }, []);
  const navRef = useRef(nav);
  navRef.current = nav;

  const run = (action: KeyAction): boolean => {
    for (const owner of ["editor", "detail", "list"]) {
      const h = registry.current.get(owner)?.()[action];
      if (h) {
        h();
        return true;
      }
    }
    return false;
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const n = navRef.current;
      const editing = !!n.editing;
      const typing = inTextField(document.activeElement);
      const modalOpen = !!document.querySelector("dialog[open]");
      if (modalOpen) return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const ctrl = e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
      const handled = (() => {
        if (k === "F1") return onShowShortcuts(), true;
        if (ctrl && k === "l") return lock(), true;
        if (ctrl && k === ",") return go({ view: "settings", editing: null }), true;
        if (ctrl && k === "g" && !editing) return go({ view: "generator" }), true;
        if (ctrl && k === "s") return editing ? run("save") : true; // never the browser's save dialog
        if (k === "Escape" && editing) return run("cancel");
        if (ctrl && k === "f") {
          if (n.view !== "items" || editing) go({ view: "items", editing: editing ? n.editing : null });
          requestAnimationFrame(() => run("search"));
          return true;
        }
        if (ctrl && k === "n") return go({ view: "items", editing: "new", newType: "login", newTitle: "", itemId: null }), true;
        if (editing) return false;
        if (ctrl && k === "e") return run("edit");
        if (ctrl && k === "u") return run("copyUsername");
        if (ctrl && k === "p") return run("copyPassword"), true; // never the print dialog
        if (ctrl && k === "t") return run("copyTotp");
        if (ctrl && k === "r") return run("reveal"), true; // never a page reload
        if (k === "Delete" && !typing) return run("delete");
        return false;
      })();
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [go, lock, onShowShortcuts]);

  // An empty vault shows one centred start block instead of an empty list and an empty detail.
  const vaultEmpty = itemsLoaded && items.length === 0;
  const showList = nav.view === "items" && !(vaultEmpty && !nav.editing);
  return (
    <KeysContext.Provider value={{ register }}>
      <div className="flex h-full">
        <Sidebar nav={nav} go={go} onLock={() => lock()} onShowShortcuts={onShowShortcuts} />
        <div className="flex min-w-0 flex-1 flex-col">
          {notice && <div className="shrink-0 border-b border-border px-4 py-2.5">{notice}</div>}
          <Banners />
          <div className="flex min-h-0 flex-1">
            {showList && <ItemList nav={nav} go={go} searchRef={searchRef} />}
            <main className="min-w-0 flex-1 bg-background" aria-live="off">
              {nav.view === "items" &&
                (nav.editing ? (
                  <ItemEditor
                    key={`${nav.editing}-${nav.itemId ?? nav.newType}`}
                    mode={nav.editing}
                    itemId={nav.itemId}
                    newType={nav.newType}
                    newTitle={nav.newTitle}
                    withGenerator={nav.withGenerator}
                    onDone={(id) => go({ editing: null, withGenerator: false, itemId: id ?? navRef.current.itemId })}
                  />
                ) : nav.itemId && items.some((i) => i.id === nav.itemId) ? (
                  <ItemDetail key={nav.itemId} itemId={nav.itemId} go={go} />
                ) : nav.itemId && !itemsLoaded ? null : (
                  <EmptyDetail go={go} />
                ))}
              {nav.view === "generator" && <GeneratorView />}
              {nav.view === "health" && <HealthView go={go} initialTab={nav.healthTab} />}
              {nav.view === "settings" && <SettingsView tab={nav.settingsTab} onTab={(t) => go({ settingsTab: t })} go={go} />}
              {nav.view === "import" && <ImportWizard source="pick" onClose={() => go({ view: "items" })} />}
            </main>
          </div>
        </div>
      </div>
    </KeysContext.Provider>
  );
}

