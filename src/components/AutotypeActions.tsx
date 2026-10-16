// Auto-type (SPEC 10, tier 2): the actions for Quick Access and the item menu,
// and the "Auto-type sequence" field of the login editor.
import { ChevronRight, Keyboard } from "lucide-react";
import { useCallback, useState } from "react";
import type { ItemView } from "../lib/contract";
import { autotypeLabel, DEFAULT_AUTOTYPE, parseAutotype } from "../lib/autotype";
import { call, isCofferError } from "../lib/ipc";
import { fieldHasValue } from "../lib/quickKeys";
import { autotypeErrorText } from "../lib/tier2Errors";
import { useReprompt, useToast } from "./overlays";
import { cx, Input } from "./ui";

export type AutotypeOnly = "password" | null;

export interface AutotypeChoice {
  only: AutotypeOnly;
  label: string;
  /** The Quick Access key. */
  shortcut: string;
}

export const AUTOTYPE_SHORTCUTS = { sequence: "Ctrl+Enter", password: "Ctrl+Shift+Enter" } as const;

/** What this item can type: its sequence (logins, or any item with a sequence of its own) and its password alone. */
export function autotypeChoices(view: Pick<ItemView, "type" | "fields" | "autotypeSequence" | "state"> | null): AutotypeChoice[] {
  if (!view || view.state !== "active") return [];
  const out: AutotypeChoice[] = [];
  if (view.type === "login" || view.autotypeSequence?.trim()) out.push({ only: null, label: autotypeLabel(view.autotypeSequence), shortcut: AUTOTYPE_SHORTCUTS.sequence });
  if (view.fields.some((f) => f.builtin === "password" && fieldHasValue(f))) out.push({ only: "password", label: "Type password", shortcut: AUTOTYPE_SHORTCUTS.password });
  return out;
}

/**
 * Run auto-type with the re-prompt flow. Rust hides Quick Access, brings back
 * the window that was in front before Coffer, and types. A refusal comes back
 * as an error whose message says why; a toast shows it.
 */
export function useAutotype() {
  const { withReprompt } = useReprompt();
  const { toast } = useToast();
  return useCallback(
    async (item: { id: string; title: string }, only: AutotypeOnly): Promise<boolean> => {
      try {
        await withReprompt((password) => call("autotype", { id: item.id, password, only }), `${item.title} asks for your master password.`);
        return true;
      } catch (e) {
        if (isCofferError(e) && e.message === "Cancelled.") return false;
        toast(isCofferError(e) ? autotypeErrorText(e) : String(e), { tone: "error", ms: 6000 });
        return false;
      }
    },
    [withReprompt, toast],
  );
}

/** The main window: after a typing, say where it went (the window Quick Access would type into). */
export async function typedIntoText(only: AutotypeOnly): Promise<string> {
  const what = only === "password" ? "the password" : "the sequence";
  try {
    const ctx = await call("quick_context");
    return ctx.title ? `Coffer typed ${what} into ${ctx.title}.` : `Coffer typed ${what} into the last app you used.`;
  } catch {
    return `Coffer typed ${what} into the last app you used.`;
  }
}

/** "Advanced" disclosure in the login editor with the auto-type sequence. */
export function AutotypeSequenceField({ id, value, onChange, error }: { id: string; value: string | null; onChange: (v: string | null) => void; error?: string | null }) {
  const v = value ?? "";
  const [open, setOpen] = useState(() => v.trim() !== "" || !!error);
  const parsed = v.trim() ? parseAutotype(v) : null;
  const problem = error ?? (parsed && !parsed.ok ? parsed.message : null);
  return (
    <section className="flex flex-col gap-1.5" data-err={error ? "autotype" : undefined}>
      <button
        type="button"
        aria-expanded={open || !!problem}
        aria-controls={`${id}-panel`}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex w-fit cursor-pointer items-center gap-1 rounded-sm px-1 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronRight aria-hidden className={cx("size-3.5 transition-transform duration-150", (open || problem) && "rotate-90")} />
        Advanced
      </button>
      {(open || !!problem) && (
        <div id={`${id}-panel`} className="flex flex-col gap-1.5 rounded-sm border border-border bg-card px-4 py-3">
          <label htmlFor={id} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Keyboard aria-hidden className="size-3.5" />
            Auto-type sequence
          </label>
          <Input id={id} mono value={v} placeholder={DEFAULT_AUTOTYPE} invalid={!!problem} onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)} />
          {problem ? (
            <p role="alert" className="text-xs text-danger-text">
              {problem}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Tokens: {"{USERNAME} {PASSWORD} {TOTP} {TAB} {ENTER} {DELAY 500} {FIELD:name}"}. Empty uses the default.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
