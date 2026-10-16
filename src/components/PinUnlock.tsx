// PIN unlock, for the main Unlock screen and the Quick Access locked state.
// One real input (digits only, paste works) under a row of boxes, one per
// digit; the last digit unlocks. A wrong PIN clears the boxes and says how
// many tries are left; when no PIN can unlock any more, the parent shows the
// master password with the reason.
import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from "react";
import type { CofferError, VaultStatus } from "../lib/contract";
import { call, isCofferError } from "../lib/ipc";
import { cx, ErrorText } from "./ui";

export interface PinUnlockHandle {
  focus: () => void;
}

export const PinUnlock = forwardRef<
  PinUnlockHandle,
  {
    status: VaultStatus;
    onUnlocked: (s: VaultStatus) => void;
    /** No PIN can unlock now (removed, days ran out, Secret Key changed): show the master password with this reason. */
    onUnavailable: (message: string) => void;
    /** Return true when the error has its own screen (tampered, olderFile in the main window). */
    onError?: (e: CofferError) => boolean;
    /** Box size: the main window is larger than Quick Access. */
    size?: "md" | "lg";
  }
>(function PinUnlock({ status, onUnlocked, onUnavailable, onError, size = "md" }, ref) {
  const length = Math.min(Math.max(status.pinLength ?? 6, 6), 12);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const id = useId();
  useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }), []);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = async (value: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      onUnlocked(await call("vault_unlock_pin", { pin: value }));
    } catch (e) {
      const err: CofferError = isCofferError(e) ? e : { code: "io", message: String(e) };
      setPin("");
      if (onError?.(err)) return;
      if (err.code === "pinUnavailable" || err.code === "needsSecretKey") onUnavailable(err.message);
      else setError(err.message || "Wrong PIN.");
      requestAnimationFrame(() => inputRef.current?.focus());
    } finally {
      setBusy(false);
    }
  };

  const box = size === "lg" ? "h-12 w-10 text-lg" : "h-10 w-8 text-base";
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        PIN
      </label>
      <div className="relative w-fit">
        <div aria-hidden className="flex gap-1.5">
          {Array.from({ length }, (_, i) => (
            <span
              key={i}
              className={cx(
                "control inline-flex items-center justify-center p-0 font-mono",
                box,
                focused && i === Math.min(pin.length, length - 1) && "pin-box-next",
              )}
              aria-invalid={!!error || undefined}
            >
              {i < pin.length ? "•" : ""}
            </span>
          ))}
        </div>
        <input
          ref={inputRef}
          id={id}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          maxLength={length}
          value={pin}
          disabled={busy}
          aria-invalid={!!error || undefined}
          aria-describedby={error ? `${id}-err` : undefined}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => {
            const digits = e.target.value.replace(/\D/g, "").slice(0, length);
            setPin(digits);
            if (error) setError(null);
            if (digits.length === length) submit(digits);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && pin.length >= 6) {
              e.preventDefault();
              submit(pin);
            }
          }}
          className="absolute inset-0 h-full w-full cursor-text opacity-0"
        />
      </div>
      {busy && <p className="text-xs text-muted-foreground">Checking the PIN...</p>}
      {error && (
        <span id={`${id}-err`}>
          <ErrorText>{error}</ErrorText>
        </span>
      )}
    </div>
  );
});
