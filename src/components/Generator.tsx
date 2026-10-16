// The password generator form (SPEC 5). Used by the Generator panel, the item
// editor ("Change password") and, compact, by Quick Access.
import { Copy, Minus, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { Generated, GeneratorMode, GeneratorOptions } from "../lib/contract";
import { call } from "../lib/ipc";
import { ENTROPY_TONE, PasswordChars } from "./bits";
import { useToast } from "./overlays";
import { Button, Checkbox, cx, IconButton, Input, Kbd, Segmented, Select } from "./ui";

export const DEFAULT_GENERATOR: GeneratorOptions = {
  mode: "random",
  length: 20,
  upper: true,
  lower: true,
  digits: true,
  symbols: true,
  minDigits: 1,
  minSymbols: 1,
  avoidAmbiguous: false,
  exclude: "",
  words: 5,
  separator: "-",
  capitalize: true,
  includeNumber: true,
};

const MODES: Array<{ value: GeneratorMode; label: string }> = [
  { value: "random", label: "Random" },
  { value: "passphrase", label: "Passphrase" },
  { value: "pin", label: "PIN" },
];

const LIMITS: Record<GeneratorMode, [number, number]> = { random: [8, 128], passphrase: [3, 20], pin: [4, 12] };

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, Number.isFinite(n) ? Math.round(n) : lo));
}

export function Generator({
  compact = false,
  onUse,
  useLabel = "Use this password",
  onGenerated,
  autoFocusCopy,
  onCopied,
}: {
  compact?: boolean;
  /** Put the value into a field (editor). Without it the main action is Copy. */
  onUse?: (value: string) => void;
  useLabel?: string;
  onGenerated?: () => void;
  autoFocusCopy?: boolean;
  /** Called after a successful copy (Quick Access closes then). */
  onCopied?: () => void;
}) {
  const [opts, setOpts] = useState<GeneratorOptions>(DEFAULT_GENERATOR);
  const [result, setResult] = useState<Generated | null>(null);
  const [busy, setBusy] = useState(false);
  const { error, expectCopy } = useToast();
  const req = useRef(0);
  const ids = { len: useId(), sep: useId(), ex: useId(), md: useId(), ms: useId() };

  const run = useCallback(
    (o: GeneratorOptions) => {
      const n = ++req.current;
      setBusy(true);
      call("generate", { options: o })
        .then((g) => {
          if (n === req.current) {
            setResult(g);
            onGenerated?.();
          }
        })
        .catch(error)
        .finally(() => n === req.current && setBusy(false));
    },
    [error, onGenerated],
  );

  useEffect(() => {
    const t = window.setTimeout(() => run(opts), 60);
    return () => window.clearTimeout(t);
  }, [opts, run]);

  const set = (patch: Partial<GeneratorOptions>) => setOpts((o) => ({ ...o, ...patch }));
  const setMode = (mode: GeneratorMode) =>
    set({ mode, length: mode === "pin" ? 6 : mode === "random" ? DEFAULT_GENERATOR.length : opts.length });

  const sets: Array<{ key: "upper" | "lower" | "digits" | "symbols"; label: string }> = [
    { key: "upper", label: "A-Z" },
    { key: "lower", label: "a-z" },
    { key: "digits", label: "0-9" },
    { key: "symbols", label: "!@#$" },
  ];
  const onlyOne = sets.filter((s) => opts[s.key]).length === 1;

  const copy = async () => {
    if (!result) return;
    try {
      expectCopy();
      await call("generator_copy", { value: result.value });
      onCopied?.();
    } catch (e) {
      error(e);
    }
  };

  const [lo, hi] = LIMITS[opts.mode];
  const sizeValue = opts.mode === "passphrase" ? opts.words : opts.length;
  const setSize = (n: number) => (opts.mode === "passphrase" ? set({ words: clamp(n, lo, hi) }) : set({ length: clamp(n, lo, hi) }));

  // Enter does the main action (Copy, or Use in the editor); Ctrl+R makes a new password.
  // Enter on a button or in the exclude field keeps its own meaning.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (e.key.toLowerCase() === "r" && e.ctrlKey && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      run(opts);
    } else if (e.key === "Enter" && !e.ctrlKey && !e.shiftKey && !e.altKey && t.tagName !== "BUTTON" && !(t.tagName === "INPUT" && (t as HTMLInputElement).type === "text")) {
      e.preventDefault();
      e.stopPropagation();
      if (onUse) {
        if (result) onUse(result.value);
      } else copy();
    }
  };

  return (
    <div className={cx("flex flex-col", compact ? "gap-3" : "gap-4")} onKeyDown={onKeyDown}>
      <Segmented label="Kind of password" value={opts.mode} onChange={setMode} options={MODES} size={compact ? "sm" : "md"} />

      <div className="rounded-sm border border-border bg-background">
        <div className={cx("flex items-start gap-2", compact ? "px-3 pt-3 pb-2" : "px-4 pt-4 pb-3")}>
          <output
            aria-live="polite"
            aria-label="Generated password"
            className={cx("min-h-[1.75rem] flex-1 leading-relaxed", compact ? "text-sm" : "text-lg", busy && !result && "opacity-50")}
          >
            {result ? <PasswordChars value={result.value} /> : <span className="text-muted-foreground">...</span>}
          </output>
          <IconButton label="Make a new one (Ctrl+R)" onClick={() => run(opts)}>
            <RefreshCw />
          </IconButton>
        </div>
        <div className={cx("flex items-center justify-between gap-3 border-t border-border", compact ? "px-3 py-1.5" : "px-4 py-2")}>
          <p className="text-xs text-muted-foreground">
            {result ? (
              <>
                <span className={cx("font-medium capitalize", ENTROPY_TONE[result.label])}>{result.label}</span>{" "}
                {Math.round(result.entropyBits)} bits of entropy
              </>
            ) : (
              "Making a password..."
            )}
          </p>
          <div className="flex items-center gap-2">
            {!compact && (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground" aria-hidden>
                <Kbd>Ctrl+R</Kbd> new
                <Kbd>Enter</Kbd> {onUse ? "use" : "copy"}
              </span>
            )}
            {onUse ? (
              <>
                <Button size="sm" variant="ghost" icon={<Copy className="size-3.5" />} onClick={copy} disabled={!result}>
                  Copy
                </Button>
                <Button size="sm" variant="primary" onClick={() => result && onUse(result.value)} disabled={!result}>
                  {useLabel}
                </Button>
              </>
            ) : (
              <Button size="sm" variant="primary" icon={<Copy className="size-3.5" />} onClick={copy} disabled={!result} autoFocus={autoFocusCopy}>
                Copy
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className={cx("grid gap-x-6 gap-y-3", compact ? "grid-cols-1" : "grid-cols-1 md:grid-cols-2")}>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.len} className="flex items-baseline justify-between text-xs font-medium text-muted-foreground">
            <span>{opts.mode === "passphrase" ? "Words" : opts.mode === "pin" ? "Digits" : "Length"}</span>
            <span className="tabular-nums text-foreground">{sizeValue}</span>
          </label>
          <div className="flex items-center gap-3">
            <input
              id={ids.len}
              type="range"
              className="range flex-1"
              min={lo}
              max={hi}
              value={sizeValue}
              onChange={(e) => setSize(+e.target.value)}
            />
            {compact ? (
              <span className="flex items-center gap-1">
                <IconButton label={opts.mode === "passphrase" ? "One word less" : "One less"} disabled={sizeValue <= lo} onClick={() => setSize(sizeValue - 1)}>
                  <Minus />
                </IconButton>
                <IconButton label={opts.mode === "passphrase" ? "One word more" : "One more"} disabled={sizeValue >= hi} onClick={() => setSize(sizeValue + 1)}>
                  <Plus />
                </IconButton>
              </span>
            ) : (
              <Input
                aria-label={opts.mode === "passphrase" ? "Number of words" : "Length"}
                type="number"
                min={lo}
                max={hi}
                value={sizeValue}
                onChange={(e) => setSize(+e.target.value)}
                className="w-16 text-right tabular-nums"
              />
            )}
          </div>
        </div>

        {opts.mode === "random" && (
          <>
            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1.5 text-xs font-medium text-muted-foreground">Characters</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {sets.map((s) => (
                  <Checkbox
                    key={s.key}
                    label={<span className="font-mono text-xs">{s.label}</span>}
                    checked={opts[s.key]}
                    disabled={opts[s.key] && onlyOne}
                    onChange={(v) => set({ [s.key]: v } as Partial<GeneratorOptions>)}
                  />
                ))}
              </div>
            </fieldset>
            {!compact && (
              <>
                <div className="flex gap-4">
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor={ids.md} className="text-xs font-medium text-muted-foreground">
                      At least this many digits
                    </label>
                    <Input
                      id={ids.md}
                      type="number"
                      min={0}
                      max={9}
                      value={opts.minDigits}
                      disabled={!opts.digits}
                      onChange={(e) => set({ minDigits: clamp(+e.target.value, 0, 9) })}
                      className="w-20 tabular-nums"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor={ids.ms} className="text-xs font-medium text-muted-foreground">
                      At least this many symbols
                    </label>
                    <Input
                      id={ids.ms}
                      type="number"
                      min={0}
                      max={9}
                      value={opts.minSymbols}
                      disabled={!opts.symbols}
                      onChange={(e) => set({ minSymbols: clamp(+e.target.value, 0, 9) })}
                      className="w-20 tabular-nums"
                    />
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={ids.ex} className="text-xs font-medium text-muted-foreground">
                    Never use these characters
                  </label>
                  <Input id={ids.ex} mono value={opts.exclude} onChange={(e) => set({ exclude: e.target.value })} placeholder={"For example ~`'\""} />
                </div>
              </>
            )}
            <Checkbox
              label="Avoid look-alike characters"
              description={compact ? undefined : <span className="font-mono">0 O 1 l I |</span>}
              checked={opts.avoidAmbiguous}
              onChange={(v) => set({ avoidAmbiguous: v })}
            />
          </>
        )}

        {opts.mode === "passphrase" && (
          <>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={ids.sep} className="text-xs font-medium text-muted-foreground">
                Between words
              </label>
              <Select id={ids.sep} value={opts.separator} onChange={(e) => set({ separator: e.target.value })} className="w-40">
                <option value="-">Hyphen  -</option>
                <option value=" ">Space</option>
                <option value=".">Full stop  .</option>
                <option value="_">Underscore  _</option>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Checkbox label="Capitalise each word" checked={opts.capitalize} onChange={(v) => set({ capitalize: v })} />
              <Checkbox label="Add a digit" checked={opts.includeNumber} onChange={(v) => set({ includeNumber: v })} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
