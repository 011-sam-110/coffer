// Primitive controls. One shape language: 4 px corners, 1 px borders, filled
// controls, one crimson fill per screen (variant "primary").
import { clsx } from "clsx";
import { Eye, EyeOff, LoaderCircle } from "lucide-react";
import {
  forwardRef,
  useId,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

export const cx = clsx;

type Variant = "primary" | "secondary" | "ghost" | "danger" | "quiet";
type Size = "sm" | "md" | "lg";

const VARIANT: Record<Variant, string> = {
  primary: "bg-primary text-primary-foreground hover:bg-primary-hover font-semibold",
  secondary: "bg-secondary text-secondary-foreground hover:bg-secondary-hover",
  ghost: "text-foreground hover:bg-muted",
  danger: "bg-destructive text-destructive-foreground hover:bg-destructive-hover font-semibold",
  quiet: "text-muted-foreground hover:text-foreground hover:bg-muted",
};
const SIZE: Record<Size, string> = {
  sm: "h-7 px-2.5 text-xs gap-1.5",
  md: "h-8 px-3 text-sm gap-2",
  lg: "h-10 px-4 text-base gap-2",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading, icon, className, children, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        "inline-flex shrink-0 cursor-pointer items-center justify-center whitespace-nowrap rounded-sm font-medium transition-colors duration-150 select-none",
        "active:translate-y-px disabled:pointer-events-none disabled:opacity-50",
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...rest}
    >
      {loading ? <LoaderCircle aria-hidden className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  size?: "sm" | "md";
  active?: boolean;
}

/** A square icon-only button. `label` is its accessible name and tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = "md", active, className, children, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cx(
        "inline-flex shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground transition-colors duration-150",
        "hover:bg-muted hover:text-foreground active:translate-y-px disabled:pointer-events-none disabled:opacity-40",
        size === "sm" ? "size-6 [&_svg]:size-3.5" : "size-7 [&_svg]:size-4",
        active && "text-foreground",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});

const inputDefaults = { autoComplete: "off", spellCheck: false, autoCorrect: "off", autoCapitalize: "off" } as const;

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean; mono?: boolean }>(
  function Input({ className, invalid, mono, ...rest }, ref) {
    return (
      <input
        ref={ref}
        {...inputDefaults}
        aria-invalid={invalid || undefined}
        className={cx("control w-full min-w-0 text-sm", mono && "font-mono", className)}
        {...rest}
      />
    );
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean; mono?: boolean }>(
  function Textarea({ className, invalid, mono, ...rest }, ref) {
    return (
      <textarea
        ref={ref}
        {...inputDefaults}
        aria-invalid={invalid || undefined}
        className={cx("control block w-full min-w-0 resize-y py-1.5 text-sm", mono && "font-mono text-xs", className)}
        {...rest}
      />
    );
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...rest },
  ref,
) {
  return (
    <select ref={ref} className={cx("control cursor-pointer text-sm", className)} {...rest}>
      {children}
    </select>
  );
});

/** Caps Lock state from a key event. */
export function capsFrom(e: KeyboardEvent): boolean | null {
  return typeof e.getModifierState === "function" ? e.getModifierState("CapsLock") : null;
}

export interface PasswordInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  invalid?: boolean;
  /** Show the Caps Lock warning under the field. */
  capsWarning?: boolean;
  revealLabel?: string;
}

/** A password field with a show toggle and a Caps Lock warning. */
export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(function PasswordInput(
  { invalid, capsWarning = true, className, onKeyDown, onKeyUp, revealLabel = "password", ...rest },
  ref,
) {
  const [shown, setShown] = useState(false);
  const [caps, setCaps] = useState(false);
  return (
    <div className={className}>
      <div className="control flex items-center gap-1 pr-1 focus-within:border-ring focus-within:outline-2 focus-within:outline-ring" aria-invalid={invalid || undefined}>
        <input
          ref={ref}
          {...inputDefaults}
          type={shown ? "text" : "password"}
          aria-invalid={invalid || undefined}
          className="h-[1.875rem] min-w-0 flex-1 bg-transparent font-mono text-sm outline-none"
          onKeyDown={(e) => {
            const c = capsFrom(e);
            if (c !== null) setCaps(c);
            onKeyDown?.(e);
          }}
          onKeyUp={(e) => {
            const c = capsFrom(e);
            if (c !== null) setCaps(c);
            onKeyUp?.(e);
          }}
          {...rest}
        />
        <IconButton size="sm" label={shown ? `Hide ${revealLabel}` : `Show ${revealLabel}`} onClick={() => setShown((s) => !s)} aria-pressed={shown}>
          {shown ? <EyeOff /> : <Eye />}
        </IconButton>
      </div>
      {capsWarning && caps && (
        <p role="status" className="mt-1 text-xs text-gold">
          Caps Lock is on.
        </p>
      )}
    </div>
  );
});

export function Switch({
  checked,
  onChange,
  label,
  disabled,
  id,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full border transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "border-primary bg-primary" : "border-input-hover bg-muted",
      )}
    >
      <span
        aria-hidden
        className={cx(
          "block size-3 rounded-full transition-transform duration-150",
          checked ? "translate-x-[15px] bg-primary-foreground" : "translate-x-[2px] bg-muted-foreground",
        )}
      />
    </button>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-2.5">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-[3px] size-3.5 shrink-0 cursor-pointer accent-primary"
      />
      <div>
        <label htmlFor={id} className="cursor-pointer text-sm">
          {label}
        </label>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
    </div>
  );
}

/** Label above control, help or error below (taste: no placeholder-as-label). */
export function FormRow({
  label,
  htmlFor,
  hint,
  error,
  children,
  className,
  aside,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  className?: string;
  aside?: ReactNode;
}) {
  return (
    <div className={cx("flex flex-col gap-1.5", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">
          {label}
        </label>
        {aside}
      </div>
      {children}
      {error ? (
        <p role="alert" className="text-xs text-danger-text">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

/** Show a shortcut like "Ctrl+Shift+Space" as keycaps. */
export function Keys({ combo }: { combo: string }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {combo.split("+").map((k, i) => (
        <Kbd key={i}>{k}</Kbd>
      ))}
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <LoaderCircle aria-hidden className={cx("size-4 animate-spin text-muted-foreground", className)} />;
}

/** A small neutral label. */
export function Chip({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cx("inline-flex h-5 items-center rounded-sm bg-secondary px-1.5 text-2xs text-secondary-foreground", className)}>
      {children}
    </span>
  );
}

/** A divider with optional heading, for sections inside panes. */
export function SectionHeading({ children, action, id }: { children: ReactNode; action?: ReactNode; id?: string }) {
  return (
    <div className="flex items-center justify-between gap-2 pt-1">
      <h3 id={id} className="text-xs font-semibold text-muted-foreground">
        {children}
      </h3>
      {action}
    </div>
  );
}

/** Inline notice: neutral, warning (gold) or danger. Never a coloured side stripe. */
export function Notice({
  tone = "neutral",
  icon,
  children,
  actions,
  className,
  role,
}: {
  tone?: "neutral" | "warning" | "danger";
  icon?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
  role?: "status" | "alert";
}) {
  return (
    <div
      role={role}
      className={cx(
        "flex items-start gap-3 rounded-sm border px-3 py-2.5 text-sm",
        tone === "neutral" && "border-border bg-card",
        tone === "warning" && "border-gold/40 bg-card",
        tone === "danger" && "border-destructive bg-accent/40",
        className,
      )}
    >
      {icon && (
        <span
          aria-hidden
          className={cx(
            "mt-0.5 shrink-0 [&_svg]:size-4",
            tone === "warning" ? "text-gold" : tone === "danger" ? "text-danger-text" : "text-muted-foreground",
          )}
        >
          {icon}
        </span>
      )}
      <div className="min-w-0 flex-1">{children}</div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/** A row of mutually exclusive options (radio group). Arrow keys move. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  size = "md",
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string }>;
  label: string;
  size?: "sm" | "md";
}) {
  const move = (dir: number) => {
    const i = options.findIndex((o) => o.value === value);
    const next = options[(i + dir + options.length) % options.length];
    onChange(next.value);
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex rounded-sm border border-border bg-muted p-0.5"
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
          e.preventDefault();
          move(1);
        } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
          e.preventDefault();
          move(-1);
        }
      }}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(o.value)}
            ref={(el) => {
              if (on && el && el.ownerDocument.activeElement?.closest("[role=radiogroup]") === el.parentElement) el.focus();
            }}
            className={cx(
              "cursor-pointer rounded-[3px] font-medium transition-colors duration-150",
              size === "sm" ? "h-6 px-2 text-xs" : "h-7 px-3 text-sm",
              on ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
