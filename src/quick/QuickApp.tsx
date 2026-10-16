// Quick Access (SPEC 9): a 400 x 560 frameless flyout above the clock.
// Search-first; Enter copies the item's main secret; Right arrow lists every
// action; the window closes after a copy.
import { MotionConfig } from "motion/react";
import { AppWindow, ChevronLeft, ChevronRight, Copy, CornerDownLeft, ExternalLink, Lock, Search, Star, WandSparkles, X } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DemoBadge, Monogram } from "../components/bits";
import { Generator } from "../components/Generator";
import { RepromptProvider, ToastProvider, useReprompt, useToast } from "../components/overlays";
import { Button, cx, IconButton, Kbd, Notice, PasswordInput } from "../components/ui";
import type { AppInfo, ItemSummary, ItemView, QuickContext, Settings, VaultStatus } from "../lib/contract";
import { call, isCofferError, on } from "../lib/ipc";
import { isSecretKind } from "../lib/itemForm";
import { ITEM_TYPES } from "../lib/itemTypes";
import { enterPlan, fieldHasValue, quickKey, resolveCopyTarget, SHORTCUT_WORDS } from "../lib/quickKeys";
import { recentlyUsed, searchItems } from "../lib/search";

const APP_NAMES: Record<string, string> = {
  "chrome.exe": "Chrome",
  "msedge.exe": "Edge",
  "firefox.exe": "Firefox",
  "brave.exe": "Brave",
  "opera.exe": "Opera",
  "vivaldi.exe": "Vivaldi",
  "slack.exe": "Slack",
  "teams.exe": "Teams",
  "ms-teams.exe": "Teams",
  "outlook.exe": "Outlook",
  "code.exe": "VS Code",
  "steam.exe": "Steam",
};

export function appName(process: string | null): string | null {
  if (!process) return null;
  const p = process.toLowerCase();
  if (APP_NAMES[p]) return APP_NAMES[p];
  const stem = p.replace(/\.exe$/, "");
  return stem.charAt(0).toUpperCase() + stem.slice(1);
}

type Row = { item: ItemSummary; section: string };
type Mode = { kind: "list" } | { kind: "actions"; item: ItemSummary } | { kind: "generator" };

/** The simulated flyout frame in a browser; the real window is the frame itself. */
function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full w-full items-end justify-end bg-sidebar sm:p-3">
      <div className="flex h-full max-h-[560px] w-full max-w-[400px] flex-col overflow-hidden border-border bg-background sm:rounded-window sm:border sm:shadow-pop">
        {children}
      </div>
    </div>
  );
}

function Locked({ status, onUnlocked }: { status: VaultStatus; onUnlocked: (s: VaultStatus) => void }) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fails, setFails] = useState(0);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="flex flex-1 flex-col justify-center px-8">
      <div className="mb-6 flex items-center gap-3">
        <span className="inline-flex size-9 items-center justify-center rounded-sm border border-border bg-card">
          <Lock aria-hidden className="size-4 text-muted-foreground" />
        </span>
        <div className="min-w-0">
          <h1 className="truncate text-md font-semibold">{status.vaultName ?? "Coffer"} is locked</h1>
          <p className="text-xs text-muted-foreground">Unlock to search and copy.</p>
        </div>
      </div>
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!pw) {
            ref.current?.focus();
            return;
          }
          if (busy) return;
          setBusy(true);
          setErr(null);
          try {
            onUnlocked(await call("vault_unlock", { password: pw, secretKey: null }));
          } catch (er) {
            if (isCofferError(er) && er.code === "badCredentials") {
              setFails((f) => f + 1);
              setErr("Wrong master password.");
              setPw("");
              ref.current?.focus();
            } else setErr(isCofferError(er) ? er.message : String(er));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label htmlFor="quick-pw" className="sr-only">
          Master password
        </label>
        <PasswordInput ref={ref} id="quick-pw" placeholder="Master password" value={pw} onChange={(e) => setPw(e.target.value)} invalid={!!err} disabled={busy} revealLabel="master password" />
        {err && (
          <p role="alert" className="text-xs text-danger-text">
            {err}
          </p>
        )}
        {fails >= 3 && <p className="text-xs text-gold">Coffer cannot reset a master password. Check Caps Lock and your keyboard layout.</p>}
        <Button type="submit" variant="primary" loading={busy}>
          {busy ? "Unlocking..." : "Unlock"}
        </Button>
      </form>
    </div>
  );
}

function OpenCofferOnly({ text }: { text: string }) {
  return (
    <div className="flex flex-1 flex-col items-start justify-center gap-4 px-8">
      <AppWindow aria-hidden className="size-6 text-muted-foreground" />
      <p className="text-base">{text}</p>
      <Button
        variant="primary"
        autoFocus
        onClick={async () => {
          await call("main_show", { itemId: null, view: null }).catch(() => undefined);
          await call("quick_hide").catch(() => undefined);
        }}
      >
        Open Coffer
      </Button>
    </div>
  );
}

function ItemRow({
  row,
  selected,
  onClick,
  onActions,
  id,
}: {
  row: Row;
  selected: boolean;
  onClick: () => void;
  onActions: () => void;
  id: string;
}) {
  const i = row.item;
  return (
    <li id={id} role="option" aria-selected={selected} className="group px-1.5">
      <div
        onClick={onClick}
        className={cx(
          "flex h-11 cursor-pointer items-center gap-2.5 rounded-sm pr-1 pl-2 transition-colors duration-75",
          selected ? "row-selected" : "hover:bg-muted",
        )}
      >
        <Monogram title={i.title} size={28} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{i.title}</span>
            {i.favorite && <Star aria-label="Favourite" className="size-3 shrink-0 fill-gold text-gold" />}
          </div>
          <span className="block truncate text-xs text-muted-foreground">{i.subtitle || ITEM_TYPES[i.type].label}</span>
        </div>
        {selected && (
          <span className="flex shrink-0 items-center gap-1 text-2xs text-muted-foreground">
            <CornerDownLeft aria-hidden className="size-3" />
            {enterPlan(i.type).kind === "open" ? "Open" : "Copy"}
          </span>
        )}
        <button
          type="button"
          tabIndex={-1}
          aria-label={`All actions for ${i.title}`}
          onClick={(e) => {
            e.stopPropagation();
            onActions();
          }}
          className={cx(
            "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-secondary hover:text-foreground",
            selected ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
        >
          <ChevronRight className="size-3.5" />
        </button>
      </div>
    </li>
  );
}

interface Action {
  label: string;
  hint?: string;
  icon: ReactNode;
  run: () => void;
}

function Quick() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [items, setItems] = useState<ItemSummary[]>([]);
  const [ctx, setCtx] = useState<QuickContext | null>(null);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [detail, setDetail] = useState<ItemView | null>(null);
  const [actSel, setActSel] = useState(0);
  const [hint, setHint] = useState(false);
  const [hidden, setHidden] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const { toast, error } = useToast();
  const { withReprompt } = useReprompt();

  const loadItems = useCallback(() => {
    call("items_list")
      .then(setItems)
      .catch(() => setItems([]));
  }, []);

  /** Called each time Quick Access is shown: fresh state, focused search. */
  const shown = useCallback(
    (c?: QuickContext) => {
      setHidden(false);
      setQuery("");
      setSel(0);
      setMode({ kind: "list" });
      call("vault_status").then(setStatus).catch(() => undefined);
      if (c) setCtx(c);
      else call("quick_context").then(setCtx).catch(() => setCtx(null));
      call("settings_get")
        .then((s) => {
          setSettings(s);
          if (s.quickHintsShown < 3) {
            setHint(true);
            call("quick_hint_seen").catch(() => undefined);
          } else setHint(false);
        })
        .catch(() => undefined);
      requestAnimationFrame(() => searchRef.current?.focus());
    },
    [],
  );

  useEffect(() => {
    call("app_info").then(setInfo).catch(() => undefined);
    shown();
    const offs = [
      on("quick://shown", (c) => shown(c)),
      on("vault://locked", () => {
        setItems([]);
        call("vault_status").then(setStatus).catch(() => undefined);
      }),
      on("vault://unlocked", (s) => setStatus(s)),
      on("vault://changed", () => loadItems()),
    ];
    return () => offs.forEach((o) => o());
  }, [shown, loadItems]);

  useEffect(() => {
    if (status?.state === "unlocked") loadItems();
  }, [status?.state, loadItems]);

  const hide = useCallback(async () => {
    await call("quick_hide").catch(() => undefined);
    if (info?.demo) setHidden(true);
  }, [info?.demo]);

  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const active = useMemo(() => items.filter((i) => i.state === "active"), [items]);

  const { rows, hiddenCount } = useMemo(() => {
    if (query.trim()) {
      const r = searchItems(items, query);
      return { rows: r.matches.map((item) => ({ item, section: "Results" })), hiddenCount: r.hiddenCount };
    }
    const seen = new Set<string>();
    const out: Row[] = [];
    const add = (list: ItemSummary[], section: string) =>
      list.forEach((item) => {
        if (seen.has(item.id) || item.state !== "active") return;
        seen.add(item.id);
        out.push({ item, section });
      });
    const app = appName(ctx?.process ?? null);
    add((ctx?.suggestions ?? []).map((id) => byId.get(id)).filter((x): x is ItemSummary => !!x).slice(0, 5), `Suggested for ${app ?? "this app"}`);
    add(active.filter((i) => i.favorite).sort((a, b) => a.title.localeCompare(b.title)), "Favourites");
    add(recentlyUsed(items, 6), "Recently used");
    return { rows: out, hiddenCount: 0 };
  }, [query, items, ctx, byId, active]);

  useEffect(() => setSel(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[aria-selected="true"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel, rows.length]);

  const current = rows[sel]?.item ?? null;

  const copyRole = async (item: ItemSummary, role: "username" | "password" | "totp") => {
    try {
      await withReprompt((password) => call("item_copy", { id: item.id, field: role, password }), `${item.title} asks for your master password.`);
      hide();
    } catch (e) {
      if (isCofferError(e) && e.code === "notFound") toast(`This item has no ${SHORTCUT_WORDS[role]}.`);
      else if (!(isCofferError(e) && e.message === "Cancelled.")) error(e);
    }
  };

  const copyField = async (item: ItemSummary, field: string) => {
    try {
      await withReprompt((password) => call("item_copy", { id: item.id, field, password }), `${item.title} asks for your master password.`);
      hide();
    } catch (e) {
      if (!(isCofferError(e) && e.message === "Cancelled.")) error(e);
    }
  };

  const openInCoffer = async (item: ItemSummary | null) => {
    await call("main_show", { itemId: item?.id ?? null, view: item ? "item" : null }).catch(error);
    hide();
  };

  const enter = async (item: ItemSummary) => {
    const plan = enterPlan(item.type);
    if (plan.kind === "open") return openInCoffer(item);
    try {
      const view = await call("item_get", { id: item.id });
      const target = resolveCopyTarget(view, plan.role, plan.fallbackRole, plan.words);
      if (!target.ok) return toast(target.message);
      await copyField(item, target.fieldId);
    } catch (e) {
      error(e);
    }
  };

  const openActions = async (item: ItemSummary) => {
    setMode({ kind: "actions", item });
    setActSel(0);
    setDetail(null);
    try {
      setDetail(await call("item_get", { id: item.id }));
    } catch (e) {
      error(e);
    }
  };

  const actions: Action[] = useMemo(() => {
    if (mode.kind !== "actions") return [];
    const item = mode.item;
    const list: Action[] = [];
    const fields = (detail?.fields ?? []).filter(fieldHasValue);
    const plan = enterPlan(item.type);
    const shortcut: Record<string, string> = { username: "Ctrl+U", password: "Ctrl+P", totp: "Ctrl+T" };
    for (const f of fields) {
      const isMain = plan.kind === "copy" && f.builtin === plan.role;
      list.push({
        label: `Copy ${f.label.toLowerCase()}`,
        hint: isMain ? "Enter" : f.builtin ? shortcut[f.builtin] : undefined,
        icon: <Copy className={cx(isSecretKind(f.kind) ? "text-primary-text" : "")} />,
        run: () => copyField(item, f.id),
      });
    }
    (detail?.urls ?? []).forEach((u, i) =>
      list.push({
        label: `Open ${(() => {
          try {
            return new URL(u.url).hostname;
          } catch {
            return "site";
          }
        })()}`,
        icon: <ExternalLink />,
        run: () => {
          call("item_open_url", { id: item.id, urlIndex: i })
            .then(() => hide())
            .catch(error);
        },
      }),
    );
    list.push({ label: "Open in Coffer", hint: "Ctrl+O", icon: <AppWindow />, run: () => openInCoffer(item) });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, detail]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const k = quickKey({
      key: e.key,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      metaKey: e.metaKey,
      caretAtEnd: input.selectionStart === input.value.length && input.selectionEnd === input.value.length,
    });
    if (!k) return;
    if (mode.kind === "actions") {
      e.preventDefault();
      if (k === "up") setActSel((s) => Math.max(0, s - 1));
      else if (k === "down") setActSel((s) => Math.min(actions.length - 1, s + 1));
      else if (k === "enter") actions[actSel]?.run();
      else if (k === "escape" || k === "back") setMode({ kind: "list" });
      else if (k === "openInCoffer") openInCoffer(mode.item);
      else if (k === "copyUsername" || k === "copyPassword" || k === "copyTotp")
        copyRole(mode.item, k === "copyUsername" ? "username" : k === "copyPassword" ? "password" : "totp");
      return;
    }
    if (k === "back") return; // Left arrow moves the caret in the search
    e.preventDefault();
    if (k === "up") setSel((s) => Math.max(0, s - 1));
    else if (k === "down") setSel((s) => Math.min(rows.length - 1, s + 1));
    else if (k === "escape") {
      if (query) setQuery("");
      else hide();
    } else if (!current) {
      if (k === "openInCoffer") openInCoffer(null);
    } else if (k === "enter") enter(current);
    else if (k === "copyUsername") copyRole(current, "username");
    else if (k === "copyPassword") copyRole(current, "password");
    else if (k === "copyTotp") copyRole(current, "totp");
    else if (k === "actions") openActions(current);
    else if (k === "openInCoffer") openInCoffer(current);
  };

  if (!status || !info) return <Frame>{null}</Frame>;

  let body: ReactNode;
  if (status.state === "noVault") body = <OpenCofferOnly text="No vault is set up yet." />;
  else if (status.state === "missing") body = <OpenCofferOnly text="Coffer cannot find your vault file." />;
  else if (status.state === "locked" && status.needsSecretKey) body = <OpenCofferOnly text="Open Coffer to finish setup." />;
  else if (status.state === "locked") body = <Locked status={status} onUnlocked={(s) => setStatus(s)} />;
  else if (mode.kind === "generator")
    body = (
      <>
        <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-2">
          <IconButton label="Back" onClick={() => setMode({ kind: "list" })}>
            <ChevronLeft />
          </IconButton>
          <h1 className="text-sm font-semibold">Generator</h1>
        </div>
        <div
          className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setMode({ kind: "list" });
              requestAnimationFrame(() => searchRef.current?.focus());
            }
          }}
        >
          <Generator compact autoFocusCopy onCopied={hide} />
        </div>
      </>
    );
  else
    body = (
      <>
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border pr-2 pl-3 focus-within:shadow-[inset_0_-2px_0_var(--ring)]" data-focus-ring>
          {mode.kind === "actions" ? (
            <IconButton label="Back to the list" onClick={() => setMode({ kind: "list" })}>
              <ChevronLeft />
            </IconButton>
          ) : (
            <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          )}
          <input
            ref={searchRef}
            role="combobox"
            aria-expanded
            aria-controls="quick-list"
            aria-activedescendant={mode.kind === "list" && current ? `q-${sel}` : mode.kind === "actions" ? `a-${actSel}` : undefined}
            aria-label="Search Coffer"
            placeholder={mode.kind === "actions" ? mode.item.title : "Search Coffer"}
            readOnly={mode.kind === "actions"}
            value={mode.kind === "actions" ? "" : query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            autoComplete="off"
            spellCheck={false}
            className="h-full min-w-0 flex-1 bg-transparent text-md outline-none placeholder:text-muted-foreground"
          />
          {query && mode.kind === "list" ? (
            <IconButton size="sm" label="Clear search" onClick={() => setQuery("")}>
              <X />
            </IconButton>
          ) : null}
          <IconButton label="Lock Coffer" onClick={() => call("vault_lock").catch(error)}>
            <Lock />
          </IconButton>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto py-1.5">
          {mode.kind === "actions" ? (
            <ul id="quick-list" role="listbox" aria-label={`Actions for ${mode.item.title}`}>
              {!detail && <li className="px-4 py-3 text-sm text-muted-foreground">Loading...</li>}
              {detail &&
                actions.map((a, i) => (
                  <li key={a.label + i} id={`a-${i}`} role="option" aria-selected={i === actSel} className="px-1.5">
                    <div
                      onClick={a.run}
                      onMouseEnter={() => setActSel(i)}
                      className={cx(
                        "flex h-9 cursor-pointer items-center gap-2.5 rounded-sm px-2.5 text-sm [&_svg]:size-4 [&_svg]:text-muted-foreground",
                        i === actSel ? "row-selected" : "hover:bg-muted",
                      )}
                    >
                      {a.icon}
                      <span className="flex-1 truncate">{a.label}</span>
                      {a.hint && <Kbd>{a.hint}</Kbd>}
                    </div>
                  </li>
                ))}
            </ul>
          ) : rows.length === 0 ? (
            query.trim() ? (
              <div className="px-5 pt-10 text-center">
                <p className="text-sm">No items match '{query.trim()}'</p>
                {hiddenCount > 0 && <p className="mt-1 text-xs text-muted-foreground">{hiddenCount} more in Archive or Trash</p>}
                <Button size="sm" className="mt-4" onClick={() => openInCoffer(null)}>
                  Open Coffer to add it
                </Button>
              </div>
            ) : (
              <div className="px-5 pt-10 text-center text-sm text-muted-foreground">
                {active.length === 0 ? "Your vault is empty. Open Coffer to add items." : "Type to search your vault."}
              </div>
            )
          ) : (
            <ul ref={listRef} id="quick-list" role="listbox" aria-label="Items">
              {rows.map((r, i) => (
                <Fragment key={`${r.section}-${r.item.id}`}>
                  {(i === 0 || rows[i - 1].section !== r.section) && r.section !== "Results" && (
                    <li role="presentation" className="px-4 pt-2 pb-1 text-2xs font-medium text-muted-foreground">
                      {r.section}
                    </li>
                  )}
                  <ItemRow id={`q-${i}`} row={r} selected={i === sel} onClick={() => (i === sel ? enter(r.item) : setSel(i))} onActions={() => openActions(r.item)} />
                </Fragment>
              ))}
              {hiddenCount > 0 && <li className="px-4 pt-2 pb-1 text-xs text-muted-foreground">{hiddenCount} more in Archive or Trash</li>}
            </ul>
          )}
        </div>

        {hint && mode.kind === "list" && (
          <p className="shrink-0 border-t border-border px-4 py-1.5 text-xs text-muted-foreground" role="note">
            Enter copies the password · Ctrl+U username · → more
          </p>
        )}
      </>
    );

  return (
    <Frame>
      {body}
      <footer className="flex h-10 shrink-0 items-center gap-1 border-t border-border bg-sidebar px-2">
        {status.state === "unlocked" && mode.kind !== "generator" && (
          <Button size="sm" variant="quiet" icon={<WandSparkles className="size-3.5" />} onClick={() => setMode({ kind: "generator" })}>
            Generator
          </Button>
        )}
        <Button size="sm" variant="quiet" icon={<AppWindow className="size-3.5" />} onClick={() => openInCoffer(current && mode.kind !== "generator" ? current : null)}>
          Open Coffer
        </Button>
        <span className="flex-1" />
        {info.demo && <DemoBadge />}
      </footer>
      {hidden && (
        <div className="fixed inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-scrim px-8 text-center">
          <Notice className="max-w-[320px]">
            Quick Access closed. In the app it hides until you press {settings?.hotkeyQuick ?? "Ctrl+Shift+Space"} or click the tray icon.
          </Notice>
          <Button variant="primary" onClick={() => shown()}>
            Show Quick Access
          </Button>
        </div>
      )}
    </Frame>
  );
}

export function QuickApp() {
  const setModal = useCallback((open: boolean) => {
    call("quick_set_modal", { modal: open }).catch(() => undefined);
  }, []);
  return (
    <MotionConfig reducedMotion="user">
      <ToastProvider placement="quick">
        <RepromptProvider onModal={setModal}>
          <Quick />
        </RepromptProvider>
      </ToastProvider>
    </MotionConfig>
  );
}
