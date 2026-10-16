// The main window: picks the screen from the vault state, holds navigation,
// and shows the window-level notices (lock dropped an edit, close to tray,
// quit with an unsaved edit, shortcut list).
import { MotionConfig } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { DemoBadge } from "../components/bits";
import { ConfirmDialog, Dialog, RepromptProvider, ToastProvider } from "../components/overlays";
import { Button, Notice } from "../components/ui";
import { call, on } from "../lib/ipc";
import { CreateVault, OpenVault, Welcome } from "./screens/Onboarding";
import { Missing, OlderFile, Tampered, Unlock, type UnlockOutcome } from "./screens/Locked";
import { StoreProvider, useStore } from "./store";
import { editInfo, type Nav, type SettingsTab, type View } from "./vault/nav";
import { VaultShell } from "./vault/VaultShell";
import { ExportDialog, MAIN_SHORTCUTS, QUICK_SHORTCUTS, ShortcutTable } from "./views/SettingsView";
import type { ItemType } from "../lib/contract";

type Setup = null | "welcome" | "create" | "open" | { kind: "createAt"; step: "kit" | "confirm" | "prefs" | "hotkey" };

const params = typeof location === "undefined" ? new URLSearchParams() : new URLSearchParams(location.search);

function initialNav(): Nav {
  const view = (params.get("view") as View | null) ?? "items";
  return {
    view: ["items", "generator", "health", "settings", "import"].includes(view) ? view : "items",
    filter: params.get("filter") === "trash" ? { kind: "trash" } : params.get("filter") === "archive" ? { kind: "archive" } : params.get("filter") === "favorites" ? { kind: "favorites" } : { kind: "all" },
    itemId: null,
    editing: params.get("new") ? "new" : null,
    newType: (params.get("new") as ItemType | null) ?? "login",
    settingsTab: (params.get("tab") as SettingsTab | null) ?? "general",
  };
}

/** Which editor a nav shows (VaultShell keys the editor the same way); null when none is open. */
function editorKey(n: Nav): string | null {
  return n.view === "items" && n.editing ? `${n.editing}-${n.itemId ?? n.newType}` : null;
}

function Shell() {
  const { status, info, items, itemsLoaded, settings, updateSettings } = useStore();
  const [setup, setSetup] = useState<Setup>(null);
  const [outcome, setOutcome] = useState<UnlockOutcome | null>(null);
  const [nav, setNav] = useState<Nav>(initialNav);
  const [shortcuts, setShortcuts] = useState(false);
  const [lostEdit, setLostEdit] = useState<string | null>(null);
  const [closeNotice, setCloseNotice] = useState(false);
  const [quitAsk, setQuitAsk] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  /** A move away from an edit with unsaved changes waits here until the user says "Discard". */
  const [pendingNav, setPendingNav] = useState<Partial<Nav> | null>(null);
  const demoApplied = useRef(false);
  const navRef = useRef(nav);
  navRef.current = nav;

  // Every move that would close an edit with unsaved changes asks first (SPEC 9):
  // Ctrl+N, Ctrl+comma, the sidebar, another list row, a Health link, the tray menu.
  const go = useCallback((patch: Partial<Nav>) => {
    const cur = navRef.current;
    const open = editorKey(cur);
    if (open && editInfo.dirty && editorKey({ ...cur, ...patch }) !== open) {
      setPendingNav(patch);
      return;
    }
    setNav((n) => ({ ...n, ...patch }));
  }, []);

  // First close with "hide to tray": Rust keeps the window open and asks for this notice (SPEC 9).
  const closeToTray = useCallback(() => {
    setCloseNotice(false);
    updateSettings({ closeNoticeShown: true });
    call("main_hide").catch(() => undefined);
  }, [updateSettings]);

  // Demo-only screen states, for screenshots (?screen=, ?dialog=, ?item=, ?edit=).
  useEffect(() => {
    if (!info?.demo || demoApplied.current) return;
    const screen = params.get("screen");
    if (screen === "welcome" || screen === "create" || screen === "open") setSetup(screen);
    if (screen === "kit" || screen === "confirm" || screen === "prefs" || screen === "hotkey") setSetup({ kind: "createAt", step: screen });
    if (screen === "tampered") setOutcome({ kind: "tampered" });
    if (screen === "older") setOutcome({ kind: "older", message: "This file is older than the last version this PC saw (generation 41, this file 38)." });
    const dialog = params.get("dialog");
    if (dialog === "shortcuts") setShortcuts(true);
    if (dialog === "closeNotice") setCloseNotice(true);
    if (dialog === "lostEdit") setLostEdit("GitHub");
    if (dialog === "export") setExportOpen(true);
    demoApplied.current = true;
  }, [info?.demo]);

  useEffect(() => {
    const want = params.get("item");
    if (!info?.demo || !want || !itemsLoaded || nav.itemId) return;
    const match = want === "first" ? items.find((i) => i.state === "active") : items.find((i) => i.id === want || i.title.toLowerCase() === want.toLowerCase());
    if (match) go({ itemId: match.id, editing: params.get("edit") ? "edit" : null, withGenerator: params.get("edit") === "generator" });
  }, [info?.demo, itemsLoaded, items, nav.itemId, go]);

  // Rust asks the main window to show something (tray menu, Quick Access Ctrl+O).
  useEffect(
    () =>
      on("main://navigate", (p) => {
        if (p.view === "settings") go({ view: "settings", editing: null });
        else if (p.view === "generator") go({ view: "generator", editing: null });
        else if (p.view === "health") go({ view: "health", editing: null });
        else go({ view: "items", itemId: p.itemId, editing: null, filter: { kind: "all" } });
      }),
    [go],
  );

  // Lock drops an unsaved edit; say so after the next unlock (SPEC 9).
  useEffect(() => {
    const a = on("vault://locked", () => {
      if (editInfo.title && editInfo.dirty) setLostEdit(editInfo.title);
      editInfo.title = null;
      editInfo.dirty = false;
      setPendingNav(null);
      setNav((n) => ({ ...n, editing: null }));
    });
    const b = on("edit://discarded", (p) => setLostEdit(p.title));
    const d = on("main://closeNotice", () => setCloseNotice(true));
    const c = on("app://quitRequested", () => {
      if (editInfo.dirty) setQuitAsk(true);
      else call("app_quit").catch(() => undefined);
    });
    return () => {
      a();
      b();
      c();
      d();
    };
  }, []);

  if (!status || !info) return <div className="h-full bg-background" />;

  let screen: React.ReactNode;
  if (setup === "welcome" || (status.state === "noVault" && !setup)) screen = <Welcome onCreate={() => setSetup("create")} onOpen={() => setSetup("open")} />;
  else if (setup === "create" || (typeof setup === "object" && setup?.kind === "createAt"))
    screen = (
      <CreateVault
        initialStep={typeof setup === "object" && setup ? setup.step : undefined}
        onCancel={() => setSetup(status.state === "noVault" ? "welcome" : null)}
        onDone={() => setSetup(null)}
      />
    );
  else if (setup === "open") screen = <OpenVault onCancel={() => setSetup(status.state === "noVault" ? "welcome" : null)} onDone={() => setSetup(null)} />;
  else if (outcome?.kind === "tampered") screen = <Tampered onDone={() => setOutcome(null)} />;
  else if (outcome?.kind === "older") screen = <OlderFile message={outcome.message} onDone={() => setOutcome(null)} />;
  else if (status.state === "missing") screen = <Missing onCreate={() => setSetup("create")} />;
  else if (status.state === "locked") screen = <Unlock onOutcome={setOutcome} onOpenOther={() => setSetup("open")} />;
  else
    screen = (
      <VaultShell
        nav={nav}
        go={go}
        onShowShortcuts={() => setShortcuts(true)}
        notice={
          lostEdit ? (
            <Notice
              tone="warning"
              role="alert"
              actions={
                <Button size="sm" onClick={() => setLostEdit(null)}>
                  OK
                </Button>
              }
            >
              Unsaved changes to {lostEdit} were lost when Coffer locked. Generated passwords are in Generator history.
            </Notice>
          ) : null
        }
      />
    );

  const inVault = status.state === "unlocked" && !setup && !outcome;

  return (
    <>
      {screen}
      {info.demo && !inVault && <DemoBadge className="fixed right-4 bottom-4 z-40" />}
      <Dialog open={shortcuts} onClose={() => setShortcuts(false)} title="Keyboard shortcuts" width={560}>
        <div className="flex flex-col gap-6 pb-4">
          <ShortcutTable title="In the Coffer window" rows={MAIN_SHORTCUTS} />
          <ShortcutTable title="In Quick Access" rows={[[settings?.hotkeyQuick ?? "Ctrl+Shift+Space", "Open Quick Access from any app"], ...QUICK_SHORTCUTS]} />
        </div>
      </Dialog>
      <Dialog
        open={closeNotice}
        onClose={closeToTray}
        title="Coffer is still running"
        description="Coffer is still running in the tray. Drag its icon from ^ to the taskbar to keep it in view."
        width={400}
        footer={
          <Button
            variant="primary"
            autoFocus
            onClick={closeToTray}
          >
            OK
          </Button>
        }
      />
      <Dialog
        open={quitAsk}
        onClose={() => setQuitAsk(false)}
        title="Save your changes before quitting?"
        description={`Your changes to ${editInfo.title ?? "this item"} are not saved.`}
        width={420}
        footer={
          <>
            <Button onClick={() => setQuitAsk(false)}>Cancel</Button>
            <Button
              onClick={() => {
                setQuitAsk(false);
                call("app_quit").catch(() => undefined);
              }}
            >
              Discard
            </Button>
            <Button
              variant="primary"
              autoFocus
              onClick={() => {
                setQuitAsk(false);
                window.dispatchEvent(new CustomEvent("coffer:save-then-quit"));
              }}
            >
              Save
            </Button>
          </>
        }
      />
      <ConfirmDialog
        open={!!pendingNav}
        title="Discard changes?"
        body={`Your changes to ${editInfo.title ?? "this item"} are not saved.`}
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        danger
        onCancel={() => setPendingNav(null)}
        onConfirm={() => {
          const patch = pendingNav;
          setPendingNav(null);
          editInfo.dirty = false;
          if (patch) setNav((n) => ({ ...n, ...patch }));
        }}
      />
      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} />
    </>
  );
}

export function MainApp() {
  return (
    <MotionConfig reducedMotion="user">
      <ToastProvider>
        <StoreProvider>
          <RepromptProvider>
            <Shell />
          </RepromptProvider>
        </StoreProvider>
      </ToastProvider>
    </MotionConfig>
  );
}
