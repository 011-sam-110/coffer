// Quick Access (SPEC 9): a 400 x 560 frameless flyout above the clock.
// Search-first; Enter copies the item's main secret; Right arrow lists every
// action; the window closes after a copy.
import { MotionConfig } from "motion/react";
import { AppWindow, ChevronLeft, ChevronRight, Copy, CornerDownLeft, ExternalLink, Keyboard, Lock, Search, Star, WandSparkles, X } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CountdownRing, DemoBadge, Monogram } from "../components/bits";
import { Generator } from "../components/Generator";
import { HelloUnlock } from "../components/HelloUnlock";
import { autotypeChoices, useAutotype, type AutotypeOnly } from "../components/AutotypeActions";
import { RepromptProvider, ToastProvider, useReprompt, useToast } from "../components/overlays";
import { Button, cx, IconButton, Kbd, Notice, PasswordInput } from "../components/ui";
import type { AppInfo, ItemSummary, ItemView, QuickContext, Settings, TotpCode, VaultStatus } from "../lib/contract";
import { call, isCofferError, on } from "../lib/ipc";
import { isSecretKind } from "../lib/itemForm";
import { ITEM_TYPES } from "../lib/itemTypes";
import { enterPlan, enterWords, fieldHasValue, groupCode, nextChainField, quickKey, resolveCopyTarget, SHORTCUT_WORDS, type ChainRole } from "../lib/quickKeys";
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
/** A login being copied one field per open: what Enter copies next. */
type Continuation = { itemId: string; role: ChainRole; fieldId: string; label: string };

const CONTINUE_MS = 60_000;
const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

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
      <HelloUnlock className="mt-3" status={status} onUnlocked={onUnlocked} onStatus={onUnlocked} onWaiting={(w) => call("quick_set_modal", { modal: w }).catch(() => undefined)} autoStartOnShow />
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
  enterLabel,
}: {
  row: Row;
  selected: boolean;
  onClick: () => void;
  onActions: () => void;
  id: string;
  /** The field Enter copies on this row, e.g. "Password" (on the Continue row, the next field). */
  enterLabel: string;
}) {
  const i = row.item;
  return (
    <li id={id} role="option" aria-selected={selected} className="group px-1.5">
      <div
        onClick={onClick}
        className={cx(
          "flex h-12 cursor-pointer items-center gap-2.5 rounded-sm pr-1 pl-2 transition-colors duration-75",
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
        {/* A static tag: a turning ring in a list read as loading. The ring shows next to the digits only. */}
        {i.hasTotp && (
          <span title="Has a one-time code" className="shrink-0 rounded-sm border border-border px-1.5 text-2xs leading-4 font-medium text-muted-foreground">
            2FA
          </span>
        )}
        {selected && (
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <CornerDownLeft aria-hidden className="size-3" />
            {enterLabel}
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
  /** The action's own shortcut (Ctrl+P, Ctrl+U, Ctrl+T, Ctrl+O). */
  hint?: string;
  /** Live text on the row, such as the one-time code. */
  detail?: string;
  /** The code's countdown, drawn as a ring after the code. */
  ring?: { remaining: number; period: number };
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
  /** This open still owes one count of the first-3-opens hint (SPEC 9); it is paid when the hint is in view. */
  const hintDue = useRef(false);
  const [hidden, setHidden] = useState(false);
  // Quick Access is only hidden between opens, so this survives a close.
  const lastCopy = useRef<{ itemId: string; role: string | null; at: number } | null>(null);
  const [cont, setCont] = useState<Continuation | null>(null);
  const [actCode, setActCode] = useState<TotpCode | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const { toast, error, expectCopy } = useToast();
  const { withReprompt } = useReprompt();
  const autotype = useAutotype();

  const loadItems = useCallback(() => {
    call("items_list")
      .then(setItems)
      .catch(() => setItems([]));
  }, []);

  // The hint is in view only while unlocked, so only an unlocked open counts (once per open).
  const showHint = useCallback(() => {
    if (!hintDue.current) return;
    hintDue.current = false;
    setHint(true);
    call("quick_hint_seen").catch(() => undefined);
  }, []);

  /** Called each time Quick Access is shown: fresh state, focused search. */
  const shown = useCallback(
    (c?: QuickContext) => {
      setHidden(false);
      setQuery("");
      setSel(0);
      setMode({ kind: "list" });
      setCont(null);
      const lc = lastCopy.current;
      if (lc && Date.now() - lc.at < CONTINUE_MS) {
        call("item_get", { id: lc.itemId })
          .then((view) => {
            const next = nextChainField(view, lc.role);
            if (next) setCont({ itemId: view.id, ...next });
          })
          .catch(() => undefined);
      }
      hintDue.current = false;
      const vs = call("vault_status");
      vs.then(setStatus).catch(() => undefined);
      if (c) setCtx(c);
      else call("quick_context").then(setCtx).catch(() => setCtx(null));
      Promise.all([vs, call("settings_get")])
        .then(([v, s]) => {
          setSettings(s);
          hintDue.current = s.quickHintsShown < 3;
          if (v.state === "unlocked" && hintDue.current) showHint();
          else setHint(false); // locked: an unlock in this open shows it (the effect below)
        })
        .catch(() => undefined);
      requestAnimationFrame(() => searchRef.current?.focus());
    },
    [showHint],
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
    if (status?.state !== "unlocked") return;
    loadItems();
    showHint();
    // After an unlock here, stay open with the cursor in the search.
    requestAnimationFrame(() => searchRef.current?.focus());
  }, [status?.state, loadItems, showHint]);

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
    const contItem = cont ? byId.get(cont.itemId) : undefined;
    if (contItem) add([contItem], "Continue");
    add((ctx?.suggestions ?? []).map((id) => byId.get(id)).filter((x): x is ItemSummary => !!x).slice(0, 5), `Suggested for ${app ?? "this app"}`);
    add(recentlyUsed(items, 6), "Recently used");
    add(active.filter((i) => i.favorite).sort((a, b) => a.title.localeCompare(b.title)), "Favourites");
    return { rows: out, hiddenCount: 0 };
  }, [query, items, ctx, byId, active, cont]);


  useEffect(() => setSel(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[aria-selected="true"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel, rows.length]);

  const current = rows[sel]?.item ?? null;

  const remember = (item: ItemSummary, role: string | null) => {
    lastCopy.current = { itemId: item.id, role, at: Date.now() };
  };

  /** With under 5 s left, wait for the next code so the pasted code is still good. */
  const waitForFreshCode = async (item: ItemSummary, fieldId: string | null) => {
    try {
      const c = await call("totp_code", { id: item.id, field: fieldId, password: null });
      if (c.remaining < 5) {
        toast(`Waiting ${c.remaining} s for the next code.`);
        await sleep(c.remaining * 1000 + 300);
      }
    } catch {
      /* re-prompt or no code: the copy below reports it */
    }
  };

  const copyRole = async (item: ItemSummary, role: "username" | "password" | "totp") => {
    try {
      if (role === "totp") await waitForFreshCode(item, null);
      expectCopy();
      await withReprompt((password) => call("item_copy", { id: item.id, field: role, password }), `${item.title} asks for your master password.`);
      remember(item, role);
      hide();
    } catch (e) {
      if (isCofferError(e) && e.code === "notFound") toast(`This item has no ${SHORTCUT_WORDS[role]}.`);
      else if (!(isCofferError(e) && e.message === "Cancelled.")) error(e);
    }
  };

  const copyField = async (item: ItemSummary, field: string, role: string | null = null, isTotp = false) => {
    try {
      if (isTotp) await waitForFreshCode(item, field);
      expectCopy();
      await withReprompt((password) => call("item_copy", { id: item.id, field, password }), `${item.title} asks for your master password.`);
      remember(item, role);
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
    if (cont && cont.itemId === item.id) return copyField(item, cont.fieldId, cont.role, cont.role === "totp");
    const plan = enterPlan(item.type);
    if (plan.kind === "open") return openInCoffer(item);
    try {
      const view = await call("item_get", { id: item.id });
      const target = resolveCopyTarget(view, plan.role, plan.fallbackRole, plan.words);
      if (!target.ok) return toast(target.message);
      const f = view.fields.find((x) => x.id === target.fieldId);
      await copyField(item, target.fieldId, f?.builtin ?? null, f?.kind === "totp");
    } catch (e) {
      error(e);
    }
  };

  /** Ctrl+Enter / Ctrl+Shift+Enter: Rust hides Quick Access and types into the window that was in front. */
  const typeItem = async (item: ItemSummary, only: AutotypeOnly) => {
    if (await autotype(item, only)) {
      remember(item, null);
      hide();
    }
  };

  const rowEnterLabel = (item: ItemSummary) => (cont && cont.itemId === item.id ? cont.label : enterWords(item.type));

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
    const plan = enterPlan(item.type);
    const mainRole = plan.kind === "copy" ? plan.role : null;
    // The field Enter copies comes first (it opens highlighted), then username, password, code.
    const rank = (b: string | null | undefined) => (b && b === mainRole ? 0 : b === "username" ? 1 : b === "password" ? 2 : b === "totp" ? 3 : 4);
    const fields = (detail?.fields ?? []).filter(fieldHasValue).sort((a, b) => rank(a.builtin) - rank(b.builtin));
    const shortcut: Record<string, string> = { username: "Ctrl+U", password: "Ctrl+P", totp: "Ctrl+T" };
    for (const f of fields) {
      const isTotp = f.kind === "totp";
      list.push({
        // Labels never truncate at 400 px: the code row says "Copy code" beside its digits.
        label: isTotp ? "Copy code" : `Copy ${f.label.toLowerCase()}`,
        hint: f.builtin ? shortcut[f.builtin] : undefined,
        detail: isTotp && actCode ? groupCode(actCode.code) : undefined,
        ring: isTotp && actCode ? { remaining: actCode.remaining, period: actCode.period } : undefined,
        icon: <Copy className={cx(isSecretKind(f.kind) ? "text-primary-text" : "")} />,
        run: () => copyField(item, f.id, f.builtin ?? null, isTotp),
      });
    }
    // SPEC 9 order: copy each field, auto-type, open site, open in Coffer.
    for (const c of autotypeChoices(detail)) list.push({ label: c.label, hint: c.shortcut, icon: <Keyboard />, run: () => typeItem(item, c.only) });
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
  }, [mode, detail, actCode]);

  // The live code on the action row: refetched each second while the list is open.
  const totpFieldId = mode.kind === "actions" ? (detail?.fields.find((f) => f.kind === "totp" && fieldHasValue(f))?.id ?? null) : null;
  useEffect(() => {
    setActCode(null);
    if (mode.kind !== "actions" || !totpFieldId) return;
    const id = mode.item.id;
    let stop = false;
    const tick = () =>
      call("totp_code", { id, field: totpFieldId, password: null })
        .then((c) => !stop && setActCode(c))
        .catch(() => !stop && setActCode(null));
    tick();
    const t = window.setInterval(tick, 1000);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, [mode, totpFieldId]);

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
    if (mode.kind === "actions" && !e.ctrlKey && !e.altKey && !e.metaKey && /^[1-6]$/.test(e.key)) {
      e.preventDefault();
      actions[Number(e.key) - 1]?.run();
      return;
    }
    if (!k) return;
    if (mode.kind === "actions") {
      e.preventDefault();
      if (k === "up") setActSel((s) => Math.max(0, s - 1));
      else if (k === "down") setActSel((s) => Math.min(actions.length - 1, s + 1));
      else if (k === "enter") actions[actSel]?.run();
      else if (k === "escape" || k === "back") setMode({ kind: "list" });
      else if (k === "openInCoffer") openInCoffer(mode.item);
      else if (k === "autotype" || k === "autotypePassword") typeItem(mode.item, k === "autotypePassword" ? "password" : null);
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
    else if (k === "autotype" || k === "autotypePassword") typeItem(current, k === "autotypePassword" ? "password" : null);
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
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border pr-2 pl-3 focus-within:shadow-[inset_0_-1px_0_var(--focus-field)]" data-focus-ring>
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
                      <span aria-hidden className="w-2.5 text-center text-2xs text-muted-foreground tabular-nums">
                        {i < 6 ? i + 1 : ""}
                      </span>
                      {a.icon}
                      <span className="min-w-0 flex-1 truncate" title={a.label}>
                        {a.label}
                      </span>
                      {a.detail && (
                        <span className="flex shrink-0 items-center gap-1.5 font-mono text-xs text-muted-foreground tabular-nums">
                          {a.detail}
                          {a.ring && (
                            <span role="img" aria-label={`One-time code, ${a.ring.remaining} seconds left`} className="flex items-center gap-1 font-sans">
                              <CountdownRing remaining={a.ring.remaining} period={a.ring.period} size={14} />
                              <span aria-hidden>{a.ring.remaining} s</span>
                            </span>
                          )}
                        </span>
                      )}
                      {/* Enter is shown by the selection; a row with its own key chip shows only that. */}
                      {i === actSel && !a.hint && <Kbd>↵</Kbd>}
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
                  <ItemRow
                    id={`q-${i}`}
                    row={r}
                    selected={i === sel}
                    enterLabel={rowEnterLabel(r.item)}
                    onClick={() => (i === sel ? enter(r.item) : setSel(i))}
                    onActions={() => openActions(r.item)}
                  />
                </Fragment>
              ))}
              {hiddenCount > 0 && <li className="px-4 pt-2 pb-1 text-xs text-muted-foreground">{hiddenCount} more in Archive or Trash</li>}
            </ul>
          )}
        </div>

        {hint && mode.kind === "list" && (
          <p className="shrink-0 border-t border-border px-4 py-1.5 text-xs text-muted-foreground" role="note">
            Enter copies · Ctrl+U username · → more actions
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
