// Small display pieces: monogram tiles, the DEMO DATA badge, secret text,
// the strength meter, the one-time code with its countdown ring, type icons.
import {
  CreditCard,
  FileText,
  Globe,
  IdCard,
  KeyRound,
  Landmark,
  ScrollText,
  SquareAsterisk,
  Terminal,
  UserRound,
  Wifi,
  type LucideIcon,
} from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import type { ItemType, TotpCode as TotpCodeT } from "../lib/contract";
import { charRuns, groupCode, monogramHue, monogramLetters } from "../lib/format";
import { call } from "../lib/ipc";
import { cx } from "./ui";

export const TYPE_ICONS: Record<ItemType, LucideIcon> = {
  login: Globe,
  password: SquareAsterisk,
  note: FileText,
  card: CreditCard,
  identity: UserRound,
  bank: Landmark,
  document: IdCard,
  sshKey: Terminal,
  apiCredential: KeyRound,
  wifi: Wifi,
  license: ScrollText,
};

/** Letter tile with a hue from the title. Never a favicon (no network). */
export function Monogram({ title, size = 32, className }: { title: string; size?: number; className?: string }) {
  const hue = monogramHue(title);
  return (
    <span
      aria-hidden
      className={cx("inline-flex shrink-0 items-center justify-center rounded-sm font-semibold select-none", className)}
      style={{
        width: size,
        height: size,
        // The tile stays put; its letters follow the type knob.
        fontSize: `calc(${Math.round(size * 0.4)}px * var(--type-scale))`,
        letterSpacing: 0,
        background: `oklch(var(--mono-bg-l) var(--mono-bg-c) ${hue})`,
        color: `oklch(var(--mono-fg-l) var(--mono-fg-c) ${hue})`,
      }}
    >
      {monogramLetters(title)}
    </span>
  );
}

/** Shown on every screen while the demo backend is in use. */
export function DemoBadge({ className }: { className?: string }) {
  return (
    <span
      role="note"
      title="This window runs on the in-browser demo backend. The items are examples; nothing is saved."
      className={cx(
        "inline-flex h-5 items-center rounded-sm border border-gold/60 px-1.5 text-2xs font-semibold tracking-wider text-gold select-none",
        className,
      )}
    >
      DEMO DATA
    </span>
  );
}

/** A secret value: masked as a fixed row of dots (never leaks the length), or revealed with coloured digits and symbols. */
export function SecretText({ value, revealed, className }: { value: string | null; revealed: boolean; className?: string }) {
  if (!revealed || value === null) {
    return (
      <span className={cx("font-mono text-base tracking-[0.12em] text-foreground", className)} aria-label="Hidden">
        ••••••••••••
      </span>
    );
  }
  return <PasswordChars value={value} className={className} />;
}

export function PasswordChars({ value, className }: { value: string; className?: string }) {
  return (
    <span className={cx("font-mono break-all", className)} data-selectable>
      {charRuns(value).map((r, i) => (
        <span key={i} className={r.cls === "digit" ? "pw-digit" : r.cls === "symbol" ? "pw-symbol" : undefined}>
          {r.text}
        </span>
      ))}
    </span>
  );
}

const STRENGTH = [
  { label: "Very weak", tone: "bg-destructive", text: "text-danger-text" },
  { label: "Weak", tone: "bg-destructive", text: "text-danger-text" },
  { label: "Fair", tone: "bg-gold", text: "text-gold" },
  { label: "Good", tone: "bg-chart-2", text: "text-chart-2" },
  { label: "Strong", tone: "bg-chart-2", text: "text-chart-2" },
] as const;

/** Four segments for a zxcvbn score 0..4, with its label and crack time. */
export function StrengthMeter({
  score,
  crackTime,
  warning,
  busy,
}: {
  score: number | null;
  crackTime?: string | null;
  warning?: string | null;
  busy?: boolean;
}) {
  const s = score === null ? null : STRENGTH[score];
  return (
    <div className="flex flex-col gap-1" aria-live="polite">
      <div className="flex gap-1" aria-hidden>
        {[1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className={cx("h-1 flex-1 rounded-full transition-colors duration-200", score !== null && score >= i ? s?.tone : "bg-secondary")}
          />
        ))}
      </div>
      <p className="flex flex-wrap items-baseline gap-x-2 text-xs">
        {s ? <span className={cx("font-medium", s.text)}>{s.label}</span> : <span className="text-muted-foreground">{busy ? "Checking..." : "Type a password to see its strength."}</span>}
        {s && crackTime && <span className="text-muted-foreground">Guessing it would take {crackTime}.</span>}
      </p>
      {warning && <p className="text-xs text-muted-foreground">{warning}</p>}
    </div>
  );
}

/** The generator's label for entropy bits, coloured like the strength meter. */
export const ENTROPY_TONE: Record<string, string> = {
  weak: "text-danger-text",
  fair: "text-gold",
  good: "text-chart-2",
  strong: "text-chart-2",
  excellent: "text-chart-2",
};

/** Ring that empties as the code's period runs out. */
export function CountdownRing({ remaining, period, size = 18 }: { remaining: number; period: number; size?: number }) {
  const r = (size - 3) / 2;
  const c = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, remaining / period));
  const low = remaining <= 5;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="-rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--secondary)" strokeWidth={2.5} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={low ? "var(--primary-text)" : "var(--chart-2)"}
        strokeWidth={2.5}
        strokeDasharray={c}
        strokeDashoffset={c * (1 - frac)}
        strokeLinecap="round"
        style={{ transition: "stroke-dashoffset 1s linear" }}
      />
    </svg>
  );
}

/** Live one-time code. Fetches a code, counts down locally, refetches at the period edge. */
export function TotpCode({
  itemId,
  fieldId,
  password,
  onNeedsPassword,
  className,
}: {
  itemId: string;
  fieldId: string | null;
  password?: string | null;
  onNeedsPassword?: () => void;
  className?: string;
}) {
  const [code, setCode] = useState<TotpCodeT | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(0);
  const codeRef = useRef<TotpCodeT | null>(null);
  const fetchedAt = useRef(0);
  const needsRef = useRef(onNeedsPassword);
  needsRef.current = onNeedsPassword;
  useEffect(() => {
    let alive = true;
    const load = () => {
      call("totp_code", { id: itemId, field: fieldId, password: password ?? null })
        .then((c) => {
          if (!alive) return;
          codeRef.current = c;
          fetchedAt.current = Date.now();
          setCode(c);
          setRemaining(c.remaining);
          setError(null);
        })
        .catch((e) => {
          if (!alive) return;
          if (e.code === "repromptRequired") needsRef.current?.();
          setError(e.code === "repromptRequired" ? "Needs your master password" : e.message);
        });
    };
    load();
    const timer = window.setInterval(() => {
      const c = codeRef.current;
      if (!c || !fetchedAt.current) return;
      const left = Math.ceil(c.remaining - (Date.now() - fetchedAt.current) / 1000);
      if (left <= 0) {
        fetchedAt.current = 0;
        load();
      }
      setRemaining(Math.max(0, left));
    }, 1000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [itemId, fieldId, password]);

  if (error) return <span className="text-xs text-muted-foreground">{error}</span>;
  if (!code) return <span className="font-mono text-muted-foreground">••• •••</span>;
  return (
    <span className={cx("inline-flex items-center gap-2", className)}>
      <span className="font-mono text-base tracking-wider tabular-nums" data-selectable>
        {groupCode(code.code)}
      </span>
      <CountdownRing remaining={remaining} period={code.period} />
      <span className="sr-only">{remaining} seconds left</span>
    </span>
  );
}

/** A Windows path that wraps only after a backslash, never inside a folder name. */
export function PathText({ path, className }: { path: string; className?: string }) {
  const parts = path.split("\\");
  return (
    <span className={className} data-selectable>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {part}
          {i < parts.length - 1 && (
            <>
              {"\\"}
              <wbr />
            </>
          )}
        </Fragment>
      ))}
    </span>
  );
}
