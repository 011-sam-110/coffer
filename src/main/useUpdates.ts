// The auto update state for Settings (SPEC 3.12): update_status once, then
// every update://state event. Check now and Restart now.
import { useCallback, useEffect, useState } from "react";
import type { UpdateState } from "../lib/contract";
import { call, on, toCofferError } from "../lib/ipc";

export interface Updates {
  state: UpdateState | null;
  /** Re-renders each 30 s so "Checked 5 minutes ago" stays true. */
  now: number;
  checking: boolean;
  check: () => Promise<void>;
  restarting: boolean;
  restart: () => Promise<void>;
  /** Why Restart now failed (one line). */
  restartError: string | null;
}

export function useUpdates(): Updates {
  const [state, setState] = useState<UpdateState | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [checking, setChecking] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    call("update_status")
      .then((s) => live && setState(s))
      .catch(() => undefined);
    const off = on("update://state", (s) => setState(s));
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      live = false;
      off();
      window.clearInterval(timer);
    };
  }, []);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      setState(await call("update_check"));
    } catch {
      // The state carries the error line; update://state brings it.
    } finally {
      setChecking(false);
      setNow(Date.now());
    }
  }, []);

  const restart = useCallback(async () => {
    setRestarting(true);
    setRestartError(null);
    try {
      await call("update_install");
    } catch (e) {
      setRestartError(toCofferError(e).message);
    } finally {
      setRestarting(false);
    }
  }, []);

  return { state, now, checking, check, restarting, restart, restartError };
}
