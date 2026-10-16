// Windows Hello unlock (SPEC 3.8, tier 2), for the main Unlock screen and the
// Quick Access locked state. Shown only while vault_status says Hello is on;
// the password field and Enter keep working while the prompt is up.
import { ScanFace } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CofferError, VaultStatus } from "../lib/contract";
import { call, isCofferError, on } from "../lib/ipc";
import { helloErrorText } from "../lib/tier2Errors";
import { Button, cx } from "./ui";

export function HelloUnlock({
  status,
  onUnlocked,
  onStatus,
  onError,
  onWaiting,
  autoStartOnShow = false,
  className,
}: {
  status: VaultStatus;
  onUnlocked: (s: VaultStatus) => void;
  /** A fresh vault_status after a failure (Hello may no longer be ready). */
  onStatus?: (s: VaultStatus) => void;
  /** Return true when the error has its own screen (tampered, olderFile in the main window). */
  onError?: (e: CofferError) => boolean;
  /** True while the Windows Security prompt is up (Quick Access stays open). */
  onWaiting?: (waiting: boolean) => void;
  /** Quick Access: start Hello each time the window is shown (quick://shown), never in a hidden window. */
  autoStartOnShow?: boolean;
  className?: string;
}) {
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    // Set again on mount: StrictMode runs the cleanup once in development.
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const ready = status.state === "locked" && !status.needsSecretKey && status.helloEnabled && status.helloReady;

  const start = useCallback(async () => {
    if (waiting) return;
    setWaiting(true);
    setError(null);
    onWaiting?.(true);
    try {
      const s = await call("vault_unlock_hello");
      if (alive.current) onUnlocked(s);
    } catch (e) {
      if (!alive.current) return;
      const err: CofferError = isCofferError(e) ? e : { code: "io", message: String(e) };
      if (!onError?.(err)) setError(helloErrorText(err));
      call("vault_status")
        .then((s) => alive.current && onStatus?.(s))
        .catch(() => undefined);
    } finally {
      if (alive.current) setWaiting(false);
      onWaiting?.(false);
    }
  }, [waiting, onUnlocked, onError, onStatus, onWaiting]);

  // Auto-start only when the user summoned the window, never after a manual lock or while hidden.
  const startRef = useRef(start);
  startRef.current = start;
  const readyRef = useRef(ready);
  readyRef.current = ready;
  useEffect(() => {
    if (!autoStartOnShow) return;
    return on("quick://shown", () => {
      if (readyRef.current) startRef.current();
    });
  }, [autoStartOnShow]);

  if (status.state !== "locked" || status.needsSecretKey || !status.helloEnabled) return null;

  if (!ready)
    return (
      <p className={cx("text-xs text-muted-foreground", className)}>
        {status.helloAvailable ? "Windows Hello works after one master-password unlock." : "Windows Hello is not available now. Use your master password."}
      </p>
    );

  return (
    <div className={cx("flex flex-col gap-1.5", className)}>
      <Button
        icon={<ScanFace className="size-4" />}
        loading={waiting}
        onClick={start}
        aria-describedby={waiting ? "hello-wait" : undefined}
        className="w-full"
      >
        {waiting ? "Waiting for Windows Hello..." : "Unlock with Windows Hello"}
      </Button>
      {waiting && (
        <p id="hello-wait" role="status" className="text-xs text-muted-foreground">
          If the Windows Security window stays open, press Cancel in it.
        </p>
      )}
      {error && !waiting && (
        <p role="alert" className="text-xs text-danger-text">
          {error}
        </p>
      )}
    </div>
  );
}
