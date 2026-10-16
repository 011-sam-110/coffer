import { ChevronLeft, Vault } from "lucide-react";
import type { ReactNode } from "react";
import { Button, cx } from "../../components/ui";

export function Brand({ className }: { className?: string }) {
  return (
    <div className={cx("flex items-center gap-2 select-none", className)}>
      <span className="inline-flex size-7 items-center justify-center rounded-sm border border-border bg-card text-foreground">
        <Vault aria-hidden className="size-4" strokeWidth={2.25} />
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
}: {
  children: ReactNode;
  width?: number;
  onBack?: () => void;
  backLabel?: string;
  aside?: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col overflow-y-auto bg-background">
      <header className="flex h-14 shrink-0 items-center justify-between px-6">
        <Brand />
        {aside}
      </header>
      <main className="flex flex-1 justify-center px-6 pt-[4vh] pb-16">
        <div className="w-full" style={{ maxWidth: width }}>
          {onBack && (
            <Button variant="quiet" size="sm" className="-ml-2.5 mb-4" icon={<ChevronLeft className="size-4" />} onClick={onBack}>
              {backLabel}
            </Button>
          )}
          {children}
        </div>
      </main>
    </div>
  );
}

export function StepTitle({ step, title, children }: { step?: string; title: string; children?: ReactNode }) {
  return (
    <div className="mb-6">
      {step && <p className="mb-2 text-xs text-muted-foreground">{step}</p>}
      <h1 className="text-xl font-semibold">{title}</h1>
      {children && <div className="mt-2 text-base text-muted-foreground">{children}</div>}
    </div>
  );
}
