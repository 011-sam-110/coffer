import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { Button, cx } from "../../components/ui";

export function Brand({ className }: { className?: string }) {
  return (
    <div className={cx("flex items-center gap-2 select-none", className)}>
      {/* Coffer's own monogram tile, in the same language as the item tiles. */}
      <span aria-hidden className="inline-flex size-7 items-center justify-center rounded-sm border border-border bg-card text-sm font-bold text-foreground">
        C
      </span>
      <span className="text-md font-semibold tracking-normal">Coffer</span>
    </div>
  );
}

/** Full-window layout for the screens outside the vault (welcome, setup, unlock). */
export function ScreenFrame({
  children,
  width = 420,
  onBack,
  backLabel = "Back",
  aside,
  center = false,
  steps = false,
}: {
  children: ReactNode;
  width?: number;
  onBack?: () => void;
  backLabel?: string;
  aside?: ReactNode;
  /** Centre short screens (lock, welcome) vertically; long forms start at the top. */
  center?: boolean;
  /** A setup step: one 480 px column at the top, with the Back row always there, so "Step N of 5" never moves. */
  steps?: boolean;
}) {
  if (steps) {
    width = 480;
    center = false;
  }
  return (
    <div className="flex h-full flex-col overflow-y-auto bg-background">
      <header className="flex h-14 shrink-0 items-center justify-between px-6">
        <Brand />
        {aside}
      </header>
      <main className={cx("flex flex-1 justify-center px-6", center ? "items-center pb-[12vh]" : "pt-[4vh] pb-16")}>
        <div className="w-full" style={{ maxWidth: width }}>
          {onBack ? (
            <Button variant="quiet" size="sm" className="-ml-2.5 mb-4" icon={<ChevronLeft className="size-4" />} onClick={onBack}>
              {backLabel}
            </Button>
          ) : (
            steps && <div aria-hidden className="mb-4 h-7" />
          )}
          {children}
        </div>
      </main>
    </div>
  );
}

export function StepTitle({ step, title, children }: { step?: string; title: string; children?: ReactNode }) {
  // "Step 2 of 5" also draws a 5-segment bar above the label.
  const m = step ? /Step (\d+) of (\d+)/.exec(step) : null;
  return (
    <div className="mb-6">
      {m && (
        <div aria-hidden className="mb-3 flex gap-1">
          {Array.from({ length: Number(m[2]) }, (_, i) => (
            <span key={i} className={cx("h-1 flex-1 rounded-full", i < Number(m[1]) ? "bg-foreground" : "bg-secondary")} />
          ))}
        </div>
      )}
      {step && <p className="mb-2 text-xs text-muted-foreground">{step}</p>}
      <h1 className="text-xl font-semibold text-balance">{title}</h1>
      {children && <div className="mt-2 text-base text-muted-foreground">{children}</div>}
    </div>
  );
}
