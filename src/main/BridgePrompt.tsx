// The one-time Connect prompt (SPEC 3.13): a browser's Coffer extension asks
// to connect. Coffer and the extension show the same four words; Allow stores
// the browser's key, Deny (or Esc, or 2 minutes) stores nothing.
// And the master-password question of a fill: a login with "Ask for master
// password" fills in the browser only after the user enters it here.
import { useEffect, useState } from "react";
import { Dialog, useToast } from "../components/overlays";
import { Button, FormRow, PasswordInput } from "../components/ui";
import { pairWords, repromptReason } from "../lib/bridge";
import type { BridgeReprompt as RepromptRequest, PairRequest } from "../lib/contract";
import { call, isCofferError, on } from "../lib/ipc";

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

/**
 * A fill in the browser asks for the master password: the same question
 * Coffer asks for its own re-prompt items. Continue with the right password
 * lets that one login fill; Cancel (or Esc) tells the browser no.
 */
export function BridgeReprompt() {
  const [req, setReq] = useState<RepromptRequest | null>(null);
  const [pw, setPw] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { error } = useToast();

  useEffect(() => {
    let live = true;
    call("bridge_info")
      .then((i) => live && setReq(i.reprompt))
      .catch(() => undefined);
    const off = on("bridge://changed", (i) => setReq(i.reprompt));
    return () => {
      live = false;
      off();
    };
  }, []);

  const requestId = req?.requestId;
  useEffect(() => {
    setPw("");
    setErr(null);
  }, [requestId]);

  const answer = async (password: string | null) => {
    if (!req || busy) return;
    setBusy(true);
    try {
      setReq((await call("bridge_reprompt_answer", { requestId: req.requestId, password })).reprompt);
    } catch (e) {
      if (password !== null && isCofferError(e) && e.code === "badCredentials") setErr("Wrong master password.");
      else {
        setReq(null);
        if (!(isCofferError(e) && e.code === "notFound")) error(e);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={!!req}
      onClose={() => answer(null)}
      title="Enter your master password"
      description={req ? repromptReason(req) : undefined}
      width={380}
      footer={
        <>
          <Button onClick={() => answer(null)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!pw} form="bridge-reprompt-form" type="submit" data-reprompt-continue>
            Continue
          </Button>
        </>
      }
    >
      <form
        id="bridge-reprompt-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (pw) void answer(pw);
        }}
      >
        <FormRow label="Master password" htmlFor="bridge-reprompt-pw" error={err}>
          <PasswordInput
            id="bridge-reprompt-pw"
            autoFocus
            value={pw}
            onChange={(e) => {
              setPw(e.target.value);
              setErr(null);
            }}
            invalid={!!err}
          />
        </FormRow>
      </form>
    </Dialog>
  );
}
