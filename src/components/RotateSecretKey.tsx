// Settings > Security > Rotate Secret Key (SPEC 3.3, tier 2): the master
// password and a warning, then the Emergency Kit screens from onboarding
// (save the kit, then type its last 4 symbols).
import { KeyRound, TriangleAlert } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { EmergencyKit } from "../lib/contract";
import { call, isCofferError } from "../lib/ipc";
import { rotateErrorText } from "../lib/tier2Errors";
import { ConfirmKit, KitStep } from "../main/screens/Onboarding";
import { useStore } from "../main/store";
import { Dialog, useToast } from "./overlays";
import { Button, FormRow, Notice, PasswordInput } from "./ui";

export function RotateSecretKey() {
  const { refreshStatus } = useStore();
  const { toast } = useToast();
  const [ask, setAsk] = useState(false);
  const [pw, setPw] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [kit, setKit] = useState<EmergencyKit | null>(null);
  const [step, setStep] = useState<"kit" | "confirm">("kit");
  const id = useId();

  useEffect(() => {
    if (ask) return;
    setPw("");
    setErr(null);
  }, [ask]);

  const submit = async () => {
    if (!pw || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const k = await call("secret_key_rotate", { password: pw });
      setAsk(false);
      setStep("kit");
      setKit(k);
      refreshStatus();
    } catch (e) {
      setErr(isCofferError(e) ? rotateErrorText(e) : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button icon={<KeyRound className="size-4" />} onClick={() => setAsk(true)}>
        Rotate Secret Key
      </Button>
      <Dialog
        open={ask}
        onClose={() => !busy && setAsk(false)}
        dismissible={!busy}
        title="Rotate Secret Key"
        description="Coffer makes a new Secret Key and a new vault key, and encrypts every item again."
        width={460}
        footer={
          <>
            <Button onClick={() => setAsk(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="danger" type="submit" form={`${id}-f`} loading={busy} disabled={!pw}>
              {busy ? "Rotating..." : "Rotate Secret Key"}
            </Button>
          </>
        }
      >
        <form
          id={`${id}-f`}
          className="flex flex-col gap-4 pb-1"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Notice tone="warning" icon={<TriangleAlert />}>
            <p>Your old Emergency Kits stop working. Throw them away after you save the new one.</p>
            <p className="mt-1">Coffer deletes the backups on this PC that use the old key. Other computers need the new Secret Key.</p>
          </Notice>
          <FormRow label="Master password" htmlFor={`${id}-pw`} error={err}>
            <PasswordInput id={`${id}-pw`} autoFocus value={pw} onChange={(e) => setPw(e.target.value)} invalid={!!err} disabled={busy} revealLabel="master password" />
          </FormRow>
        </form>
      </Dialog>
      {kit && (
        // The new kit fills the window, like the kit at setup. It has no skip: the old kit no longer works.
        <div className="fixed inset-0 z-40" role="region" aria-label="New Emergency Kit">
          {step === "kit" ? (
            <KitStep kit={kit} step="New Secret Key, step 1 of 2" title="Save your new Emergency Kit" onNext={() => setStep("confirm")} />
          ) : (
            <ConfirmKit
              kit={kit}
              step="New Secret Key, step 2 of 2"
              onBack={() => setStep("kit")}
              onNext={() => {
                setKit(null);
                toast("Secret Key changed. Keep the new kit somewhere safe.");
              }}
            />
          )}
        </div>
      )}
    </>
  );
}
