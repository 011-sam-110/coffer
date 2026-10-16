// SSH key items (tier 2): "Generate key" makes a new Ed25519 key pair in Rust
// and fills the private key, public key and fingerprint fields of the editor.
import { KeyRound } from "lucide-react";
import { useState, type Dispatch, type SetStateAction } from "react";
import { call } from "../lib/ipc";
import type { ItemForm } from "../lib/itemForm";
import { ConfirmDialog, useToast } from "./overlays";
import { Button } from "./ui";

type KeyPair = { privateKey: string; publicKey: string; fingerprint: string };

/** True when the form already holds a key that a new one would replace. */
export function formHasSshKey(form: Pick<ItemForm, "fields">): boolean {
  return form.fields.some(
    (f) =>
      (f.builtin === "privateKey" && ((f.value ?? "").trim() !== "" || (f.value === null && f.hasStored))) ||
      ((f.builtin === "publicKey" || f.builtin === "fingerprint") && (f.value ?? "").trim() !== ""),
  );
}

/** The form with the new key pair in its three built-in fields. */
export function withSshKey(form: ItemForm, k: KeyPair): ItemForm {
  const value: Record<string, string> = { privateKey: k.privateKey, publicKey: k.publicKey, fingerprint: k.fingerprint };
  return { ...form, fields: form.fields.map((f) => (f.builtin && f.builtin in value ? { ...f, value: value[f.builtin] } : f)) };
}

export function SshGenerateButton({ form, setForm }: { form: ItemForm; setForm: Dispatch<SetStateAction<ItemForm | null>> }) {
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const { toast, error } = useToast();

  const generate = async () => {
    setConfirm(false);
    setBusy(true);
    try {
      const k = await call("ssh_generate");
      setForm((f) => (f ? withSshKey(f, k) : f));
      toast("New Ed25519 key made. Save the item to keep it.");
    } catch (e) {
      error(e);
    } finally {
      setBusy(false);
    }
  };

  // A row of the editor card, under the key fields: the value column holds the button (label column 160 px).
  return (
    <div className="px-4 py-2">
      <div className="grid grid-cols-1 items-start gap-x-3 gap-y-1 @min-[440px]:grid-cols-[160px_minmax(0,1fr)]">
        <span className="hidden @min-[440px]:block" />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Button size="sm" icon={<KeyRound className="size-3.5" />} loading={busy} onClick={() => (formHasSshKey(form) ? setConfirm(true) : generate())}>
            Generate key
          </Button>
          <p className="text-xs text-muted-foreground">Makes a new Ed25519 key pair and fills the key fields.</p>
        </div>
      </div>
      <ConfirmDialog
        open={confirm}
        title="Replace this key?"
        body="The new key replaces the private key, public key and fingerprint. Servers that know the old public key do not accept the new one until you add it there."
        confirmLabel="Replace key"
        danger
        onCancel={() => setConfirm(false)}
        onConfirm={generate}
      />
    </div>
  );
}
