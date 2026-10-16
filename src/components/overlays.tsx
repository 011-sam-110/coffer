// Dialogs (native <dialog>: focus trap, Esc), menus, toasts with the clipboard
// countdown, and the master-password re-prompt.
import { AnimatePresence, motion } from "motion/react";
import { ClipboardCheck, X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { CofferError } from "../lib/contract";
import { call, isCofferError, on } from "../lib/ipc";
import { Button, cx, FormRow, IconButton, PasswordInput } from "./ui";

/* ---------------- dialog ---------------- */

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 440,
  dismissible = true,
  onOpenChange,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number;
  /** Esc and a click outside close it. */
  dismissible?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      onOpenChange?.(true);
    } else if (!open && d.open) {
      d.close();
      onOpenChange?.(false);
    }
  }, [open, onOpenChange]);
  if (!open) return null;
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onCancel={(e) => {
        e.preventDefault();
        if (dismissible) onClose();
      }}
      onMouseDown={(e) => {
        if (dismissible && e.target === ref.current) onClose();
      }}
      className="m-auto max-h-[85vh] max-w-[calc(100vw-32px)] overflow-visible bg-transparent p-0 backdrop:bg-scrim"
      style={{ width }}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.98, y: 4 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
        className="flex max-h-[85vh] flex-col rounded-sm border border-border bg-card text-card-foreground shadow-pop"
      >
        <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-2">
          <div>
            <h2 id={titleId} className="text-md font-semibold">
              {title}
            </h2>
            {description && (
              <p id={descId} className="mt-1 text-sm text-muted-foreground">
                {description}
              </p>
            )}
          </div>
          {dismissible && (
            <IconButton label="Close" onClick={onClose} className="-mr-1.5">
              <X />
            </IconButton>
          )}
        </div>
        {children && <div className="min-h-0 overflow-y-auto px-5 py-2">{children}</div>}
        {footer && <div className="flex items-center justify-end gap-2 px-5 pt-3 pb-4">{footer}</div>}
      </motion.div>
    </dialog>
  );
}

/** A yes/no question. */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel = "Cancel",
  danger,
  onConfirm,
  onCancel,
  extra,
}: {
  open: boolean;
  title: ReactNode;
  body?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  extra?: ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      description={body}
      width={400}
      footer={
        <>
          {extra}
          <Button onClick={onCancel}>{cancelLabel}</Button>
          <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} autoFocus>
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}

/* ---------------- menu ---------------- */

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

/** A button that opens a list of actions. Arrow keys move, Enter picks, Esc closes. */
export function Menu({
  trigger,
  items,
  align = "end",
  label,
}: {
  trigger: (props: { onClick: () => void; "aria-expanded": boolean; "aria-haspopup": "menu"; "aria-controls": string }) => ReactNode;
  items: MenuItem[];
  align?: "start" | "end";
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const id = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", down);
    requestAnimationFrame(() => list.current?.querySelector<HTMLButtonElement>("[data-active=true]")?.focus());
    return () => document.removeEventListener("mousedown", down);
  }, [open]);
  useEffect(() => {
    if (open) list.current?.querySelector<HTMLButtonElement>(`[data-index="${active}"]`)?.focus();
  }, [active, open]);
  const enabled = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);
  return (
    <div ref={wrap} className="relative">
      {trigger({
        onClick: () => {
          setActive(enabled[0] ?? 0);
          setOpen((o) => !o);
        },
        "aria-expanded": open,
        "aria-haspopup": "menu",
        "aria-controls": id,
      })}
      {open && (
        <div
          ref={list}
          id={id}
          role="menu"
          aria-label={label}
          onKeyDown={(e) => {
            const pos = enabled.indexOf(active);
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive(enabled[(pos + 1) % enabled.length]);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive(enabled[(pos - 1 + enabled.length) % enabled.length]);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
            } else if (e.key === "Tab") setOpen(false);
          }}
          className={cx(
            "absolute top-full z-30 mt-1 min-w-[200px] rounded-sm border border-border bg-popover py-1 shadow-pop",
            align === "end" ? "right-0" : "left-0",
          )}
        >
          {items.map((it, i) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              data-index={i}
              data-active={i === active}
              disabled={it.disabled}
              tabIndex={i === active ? 0 : -1}
              onMouseEnter={() => !it.disabled && setActive(i)}
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
              className={cx(
                "flex h-8 w-full cursor-pointer items-center gap-2.5 px-3 text-left text-sm outline-none disabled:cursor-not-allowed disabled:opacity-40",
                "focus-visible:bg-muted hover:bg-muted [&_svg]:size-4 [&_svg]:text-muted-foreground",
                it.danger && "text-danger-text [&_svg]:text-danger-text",
              )}
            >
              {it.icon}
              <span className="flex-1">{it.label}</span>
              {it.shortcut && <span className="text-2xs text-muted-foreground">{it.shortcut}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------- toasts ---------------- */

interface ToastItem {
  id: number;
  text: string;
  tone: "info" | "error";
  action?: { label: string; run: () => void };
  ms: number;
}

interface ClipState {
  label: string;
  clearsAt: number | null;
  cleared: boolean;
}

interface ToastApi {
  toast: (text: string, opts?: { tone?: "info" | "error"; action?: { label: string; run: () => void }; ms?: number }) => void;
  error: (e: unknown) => void;
}

const ToastContext = createContext<ToastApi>({ toast: () => undefined, error: () => undefined });
export const useToast = () => useContext(ToastContext);

/** Toasts, plus the clipboard countdown fed by clipboard://copied and clipboard://cleared. */
export function ToastProvider({ children, placement = "bottom" }: { children: ReactNode; placement?: "bottom" | "quick" }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [clip, setClip] = useState<ClipState | null>(null);
  const [now, setNow] = useState(Date.now());
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback<ToastApi["toast"]>(
    (text, opts) => {
      const id = ++seq.current;
      const ms = opts?.ms ?? (opts?.action ? 6000 : 3500);
      setToasts((t) => [...t.slice(-2), { id, text, tone: opts?.tone ?? "info", action: opts?.action, ms }]);
      window.setTimeout(() => dismiss(id), ms);
    },
    [dismiss],
  );
  const error = useCallback((e: unknown) => {
    const msg = isCofferError(e) ? (e as CofferError).message : e instanceof Error ? e.message : String(e);
    toast(msg, { tone: "error", ms: 5000 });
  }, [toast]);

  useEffect(() => {
    const a = on("clipboard://copied", (p) => {
      setClip({ label: p.label, clearsAt: p.clearsInSeconds === null ? null : Date.now() + p.clearsInSeconds * 1000, cleared: false });
      setNow(Date.now());
    });
    const b = on("clipboard://cleared", () => {
      setClip((c) => (c ? { ...c, cleared: true } : c));
    });
    return () => {
      a();
      b();
    };
  }, []);
  useEffect(() => {
    if (!clip) return;
    if (clip.cleared) {
      const t = window.setTimeout(() => setClip(null), 2200);
      return () => window.clearTimeout(t);
    }
    if (clip.clearsAt === null) {
      const t = window.setTimeout(() => setClip(null), 4000);
      return () => window.clearTimeout(t);
    }
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, [clip]);

  const api = useMemo(() => ({ toast, error }), [toast, error]);
  const left = clip?.clearsAt ? Math.max(0, Math.ceil((clip.clearsAt - now) / 1000)) : null;

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        className={cx(
          "pointer-events-none fixed z-50 flex flex-col items-center gap-2",
          placement === "bottom" ? "bottom-5 left-1/2 -translate-x-1/2" : "bottom-14 left-3 right-3",
        )}
      >
        <AnimatePresence initial={false}>
          {clip && (
            <motion.div
              key="clip"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4, transition: { duration: 0.12 } }}
              transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
              className="pointer-events-auto relative flex min-w-[260px] max-w-full items-center gap-2.5 overflow-hidden rounded-sm border border-border bg-card py-2 pr-3 pl-3 text-sm shadow-pop"
              role="status"
            >
              <ClipboardCheck aria-hidden className={cx("size-4 shrink-0", clip.cleared ? "text-muted-foreground" : "text-chart-2")} />
              <span className="flex-1">
                {clip.cleared ? (
                  "Clipboard cleared."
                ) : (
                  <>
                    {clip.label} copied.{" "}
                    <span className="text-muted-foreground">
                      {left === null ? "Clipboard clearing is off." : `Clears in ${left} s.`}
                    </span>
                  </>
                )}
              </span>
              {!clip.cleared && clip.clearsAt !== null && (
                <ClipDrain key={clip.clearsAt} clearsAt={clip.clearsAt} />
              )}
            </motion.div>
          )}
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: { duration: 0.12 } }}
              transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
              role={t.tone === "error" ? "alert" : "status"}
              className={cx(
                "pointer-events-auto flex min-w-[260px] max-w-[min(520px,100%)] items-center gap-3 rounded-sm border bg-card px-3 py-2 text-sm shadow-pop",
                t.tone === "error" ? "border-destructive" : "border-border",
              )}
            >
              <span className={cx("flex-1", t.tone === "error" && "text-danger-text")}>{t.text}</span>
              {t.action && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="-my-1 font-semibold text-primary-text"
                  onClick={() => {
                    t.action?.run();
                    dismiss(t.id);
                  }}
                >
                  {t.action.label}
                </Button>
              )}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

/** A 2 px line along the toast's bottom edge that drains until the clipboard clears. */
function ClipDrain({ clearsAt }: { clearsAt: number }) {
  const [start] = useState(() => Date.now());
  const total = Math.max(1, clearsAt - start);
  return (
    <span aria-hidden className="absolute right-0 bottom-0 left-0 h-[2px] bg-secondary">
      <span
        className="block h-full origin-left bg-primary"
        style={{ animation: `clip-drain ${total}ms linear forwards` }}
      />
    </span>
  );
}

/* ---------------- re-prompt ---------------- */

interface RepromptApi {
  /** Run fn(null); on repromptRequired ask for the master password and retry fn(password). */
  withReprompt: <T>(fn: (password: string | null) => Promise<T>, reason?: string) => Promise<T>;
}

const RepromptContext = createContext<RepromptApi>({ withReprompt: (fn) => fn(null) });
export const useReprompt = () => useContext(RepromptContext);

export function RepromptProvider({ children, onModal }: { children: ReactNode; onModal?: (open: boolean) => void }) {
  const [ask, setAsk] = useState<{
    reason: string;
    attempt: (pw: string) => Promise<void>;
    cancel: () => void;
  } | null>(null);
  const [pw, setPw] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const withReprompt = useCallback<RepromptApi["withReprompt"]>(
    async (fn, reason = "This item asks for your master password.") => {
      try {
        return await fn(null);
      } catch (e) {
        if (!isCofferError(e) || e.code !== "repromptRequired") throw e;
      }
      return new Promise((resolve, reject) => {
        setPw("");
        setErr(null);
        setAsk({
          reason,
          attempt: async (password) => {
            setBusy(true);
            try {
              const r = await fn(password);
              setAsk(null);
              resolve(r);
            } catch (e) {
              if (isCofferError(e) && (e.code === "badCredentials" || e.code === "repromptRequired")) setErr("Wrong master password.");
              else {
                setAsk(null);
                reject(e);
              }
            } finally {
              setBusy(false);
            }
          },
          cancel: () => {
            setAsk(null);
            reject({ code: "invalid", message: "Cancelled." } satisfies CofferError);
          },
        });
      });
    },
    [],
  );
  const api = useMemo(() => ({ withReprompt }), [withReprompt]);
  return (
    <RepromptContext.Provider value={api}>
      {children}
      <Dialog
        open={!!ask}
        onClose={() => ask?.cancel()}
        onOpenChange={onModal}
        title="Enter your master password"
        description={ask?.reason}
        width={380}
        footer={
          <>
            <Button onClick={() => ask?.cancel()}>Cancel</Button>
            <Button variant="primary" loading={busy} disabled={!pw} onClick={() => ask?.attempt(pw)} form="reprompt-form" type="submit">
              Continue
            </Button>
          </>
        }
      >
        <form
          id="reprompt-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (pw) ask?.attempt(pw);
          }}
        >
          <FormRow label="Master password" htmlFor="reprompt-pw" error={err}>
            <PasswordInput id="reprompt-pw" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} invalid={!!err} />
          </FormRow>
        </form>
      </Dialog>
    </RepromptContext.Provider>
  );
}

/** Copy a field with the re-prompt flow. Returns false when it failed (a toast says why). */
export function useCopy() {
  const { withReprompt } = useReprompt();
  const { error } = useToast();
  return useCallback(
    async (id: string, field: string): Promise<boolean> => {
      try {
        await withReprompt((password) => call("item_copy", { id, field, password }));
        return true;
      } catch (e) {
        if (isCofferError(e) && e.message === "Cancelled.") return false;
        error(e);
        return false;
      }
    },
    [withReprompt, error],
  );
}
