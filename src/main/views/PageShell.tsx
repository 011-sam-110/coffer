// One page shell for the full views (Generator, Health, Import, Settings): left
// aligned 32 px from the sidebar, a 20 px title 24 px from the top, content at
// most 720 px wide (Health's table may take 860 px). Plus the shared tab strip.
import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "../../components/ui";

export function PageShell({
  title,
  description,
  actions,
  wide = false,
  children,
}: {
  title: string;
  description?: ReactNode;
  /** Right-aligned header actions, such as Health's "Check now". */
  actions?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="h-full overflow-y-auto">
      <div className={cx("flex flex-col gap-6 px-8 pt-6 pb-16", wide ? "max-w-[924px]" : "max-w-[784px]")}>
        <header className="flex items-start justify-between gap-6">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold">{title}</h1>
            {description && <div className="mt-1 text-sm text-muted-foreground">{description}</div>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-3">{actions}</div>}
        </header>
        {children}
      </div>
    </div>
  );
}

export interface TabDef<T extends string> {
  id: T;
  label: string;
  count?: number;
  /** Show the count in the danger colour (Breached) when it is above zero. */
  danger?: boolean;
}

/** An underline tab strip: the active tab has a 2 px foreground rule (crimson is for actions). Arrow keys move. */
export function Tabs<T extends string>({ label, tabs, value, onChange }: { label: string; tabs: TabDef<T>[]; value: T; onChange: (t: T) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const i = tabs.findIndex((t) => t.id === value);
    const next = tabs[(i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
    onChange(next.id);
    requestAnimationFrame(() => ref.current?.querySelector<HTMLButtonElement>(`[data-tab="${next.id}"]`)?.focus());
  };
  return (
    <div ref={ref} role="tablist" aria-label={label} className="flex flex-wrap gap-1 border-b border-border" onKeyDown={onKey}>
      {tabs.map((t) => {
        const on = t.id === value;
        return (
          <button
            key={t.id}
            data-tab={t.id}
            role="tab"
            type="button"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(t.id)}
            className={cx(
              "-mb-px inline-flex h-9 cursor-pointer items-center gap-1.5 border-b-2 px-3 text-sm transition-colors",
              on ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
            {t.count !== undefined && (
              <span
                className={cx(
                  "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-secondary px-1.5 text-sm leading-none tabular-nums",
                  t.danger && t.count > 0 ? "text-danger-text" : "text-muted-foreground",
                )}
              >
                {t.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
