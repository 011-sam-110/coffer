// The one-time Connect prompt (SPEC 3.13): a browser's Coffer extension asks
// to connect. Coffer and the extension show the same four words; Allow stores
// the browser's key, Deny (or Esc, or 2 minutes) stores nothing.
import { useEffect, useState } from "react";
import { Dialog, useToast } from "../components/overlays";
import { Button } from "../components/ui";
import { pairWords } from "../lib/bridge";
import type { PairRequest } from "../lib/contract";
import { call, on } from "../lib/ipc";

/** Allow is off for this long after the prompt opens, so a click meant for another window cannot allow. */
export const ALLOW_DELAY_MS = 1000;

export function BridgePrompt() {
  const [pending, setPending] = useState<PairRequest | null>(null);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const { error } = useToast();

  useEffect(() => {
    let live = true;
    call("bridge_info")
      .then((i) => live && setPending(i.pending))
      .catch(() => undefined);
    const off = on("bridge://changed", (i) => setPending(i.pending));
    return () => {
      live = false;
      off();
    };
  }, []);

  const pairId = pending?.pairId;
  useEffect(() => {
    setArmed(false);
    if (!pairId) return;
    const t = window.setTimeout(() => setArmed(true), ALLOW_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [pairId]);

  const answer = async (allow: boolean) => {
    if (!pending || busy) return;
    setBusy(true);
    try {
      setPending((await call("bridge_pair_answer", { pairId: pending.pairId, allow })).pending);
    } catch (e) {
      setPending(null);
      error(e);
    } finally {
      setBusy(false);
    }
  };

  const name = pending?.name ?? "Chrome";
  return (
    <Dialog
      open={!!pending}
      onClose={() => answer(false)}
      dismissible={false}
      title={`Connect ${name} to Coffer?`}
      width={440}
      footer={
        <>
          <Button onClick={() => answer(false)} disabled={busy}>
            Deny
          </Button>
          <Button variant="primary" onClick={() => answer(true)} disabled={!armed || busy} data-allow>
            Allow
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 pb-1">
        <p className="text-sm text-muted-foreground">
          The Coffer extension in {name} asks to fill and save logins. Check that {name} shows the same four words, then click Allow.
        </p>
        <p data-pair-words data-selectable className="rounded-sm bg-muted px-4 py-3 text-center font-mono text-sm font-semibold tracking-normal">
          {pending ? pairWords(pending) : ""}
        </p>
      </div>
    </Dialog>
  );
}
