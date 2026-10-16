// Unlock, Missing vault, Tampered vault and Older file screens (SPEC 3.5, 11).
import { FileWarning, FolderSearch, History, Lock, SearchX } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Dialog, useToast } from "../../components/overlays";
import { Button, FormRow, Input, Notice, PasswordInput, Spinner } from "../../components/ui";
import type { BackupEntry, VaultStatus } from "../../lib/contract";
import { formatBytes, formatDateTime } from "../../lib/format";
import { call, isCofferError } from "../../lib/ipc";
import { secretKeyCharMessage } from "../../lib/secretKey";
import { useStore } from "../store";
import { ScreenFrame, StepTitle } from "./Frame";

export type UnlockOutcome = { kind: "tampered" } | { kind: "older"; message: string };

/** Unlock form, shared by the main window. Quick Access has its own compact one. */
export function Unlock({ onOutcome, onOpenOther }: { onOutcome: (o: UnlockOutcome) => void; onOpenOther: () => void }) {
  const { status, setStatus, lockedReason, info } = useStore();
  const [pw, setPw] = useState("");
  const [sk, setSk] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fails, setFails] = useState(0);
  const pwRef = useRef<HTMLInputElement>(null);
  const ids = { pw: useId(), sk: useId() };
  const needsKey = !!status?.needsSecretKey;
  const skChar = needsKey ? secretKeyCharMessage(sk) : null;

  useEffect(() => {
    pwRef.current?.focus();
  }, []);

  const submit = async () => {
    if (!pw || busy || skChar) return;
    setBusy(true);
    setError(null);
    try {
      const s = await call("vault_unlock", { password: pw, secretKey: needsKey ? sk : null });
      setStatus(s);
    } catch (e) {
      if (!isCofferError(e)) {
        setError(String(e));
      } else if (e.code === "tampered") {
        onOutcome({ kind: "tampered" });
      } else if (e.code === "olderFile") {
        onOutcome({ kind: "older", message: e.message });
      } else if (e.code === "badCredentials") {
        setFails((f) => f + 1);
        setError(needsKey ? "The master password or the Secret Key is wrong." : "Wrong master password.");
        setPw("");
        pwRef.current?.focus();
      } else {
        setError(e.message);
      }
    } finally {
      setBusy(false);
    }
  };

  const reason =
    lockedReason === "idle"
      ? "Coffer locked after a while without use."
      : lockedReason === "systemLock"
        ? "Coffer locked when Windows locked."
        : lockedReason === "sleep"
          ? "Coffer locked when the PC went to sleep."
          : lockedReason === "keyChanged"
            ? "The master password or Secret Key changed on another computer. Unlock with the new one."
            : null;

  return (
    <ScreenFrame width={380} aside={<Button variant="quiet" size="sm" onClick={onOpenOther}>Open another vault</Button>}>
      <div className="mb-7 flex items-center gap-3">
        <span className="inline-flex size-10 items-center justify-center rounded-sm border border-border bg-card">
          <Lock aria-hidden className="size-5 text-muted-foreground" />
        </span>
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold">{status?.vaultName ?? "Vault"}</h1>
          <p className="truncate text-xs text-muted-foreground" title={status?.vaultPath ?? undefined}>
            {status?.vaultPath}
          </p>
        </div>
      </div>
      {reason && <p className="mb-4 text-sm text-muted-foreground">{reason}</p>}
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <FormRow label="Master password" htmlFor={ids.pw} error={error}>
          <PasswordInput
            ref={pwRef}
            id={ids.pw}
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            invalid={!!error}
            disabled={busy}
            revealLabel="master password"
          />
        </FormRow>
        {needsKey && (
          <FormRow
            label="Secret Key"
            htmlFor={ids.sk}
            error={skChar}
            hint="No kit? On a computer where this vault opens: Settings > Security > Show Secret Key."
          >
            <Input
              id={ids.sk}
              mono
              value={sk}
              onChange={(e) => setSk(e.target.value.toUpperCase())}
              placeholder="C1-XXXXXX-XXXXXX-XXXXXX-XXXXX-XXXXX-XXXXX"
              invalid={!!skChar}
              disabled={busy}
              className="uppercase"
            />
          </FormRow>
        )}
        {fails >= 3 && (
          <Notice tone="warning" role="status">
            Coffer cannot reset a master password. Check Caps Lock and your keyboard layout.
          </Notice>
        )}
        <Button type="submit" variant="primary" size="lg" loading={busy} disabled={!pw || (needsKey && (!sk || !!skChar))}>
          {busy ? "Unlocking..." : "Unlock"}
        </Button>
        {info?.demo && <p className="text-xs text-muted-foreground">Demo backend: the master password is "demo".</p>}
      </form>
    </ScreenFrame>
  );
}

/** List of backups with Restore. Used by Missing, Tampered and Settings > Vault. */
export function BackupList({ onRestored, compact }: { onRestored?: (s: VaultStatus) => void; compact?: boolean }) {
  const [list, setList] = useState<BackupEntry[] | null>(null);
  const [confirm, setConfirm] = useState<BackupEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const { error, toast } = useToast();
  useEffect(() => {
    call("backups_list").then(setList).catch((e) => {
      setList([]);
      error(e);
    });
  }, [error]);
  if (!list)
    return (
      <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
        <Spinner /> Loading backups...
      </div>
    );
  if (list.length === 0) return <p className="py-3 text-sm text-muted-foreground">No backups yet. Coffer makes one after each save.</p>;
  return (
    <>
      <ul className="divide-y divide-border rounded-sm border border-border">
        {list.slice(0, compact ? 6 : list.length).map((b) => (
          <li key={b.index} className="flex items-center gap-3 px-3 py-2 text-sm">
            <History aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span className="flex-1 tabular-nums">{formatDateTime(b.savedAt)}</span>
            <span className="w-16 text-right text-xs text-muted-foreground tabular-nums">{formatBytes(b.size)}</span>
            <Button size="sm" onClick={() => setConfirm(b)}>
              Restore
            </Button>
          </li>
        ))}
      </ul>
      <Dialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title="Restore this backup?"
        description={confirm ? `Coffer keeps the current file as a backup, then puts the copy from ${formatDateTime(confirm.savedAt)} in its place. You unlock it with the password it had then.` : undefined}
        width={420}
        footer={
          <>
            <Button onClick={() => setConfirm(null)}>Cancel</Button>
            <Button
              variant="primary"
              loading={busy}
              onClick={async () => {
                if (!confirm) return;
                setBusy(true);
                try {
                  const s = await call("backup_restore", { index: confirm.index });
                  toast("Backup restored.");
                  setConfirm(null);
                  onRestored?.(s);
                } catch (e) {
                  error(e);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Restore
            </Button>
          </>
        }
      />
    </>
  );
}

export function Missing({ onCreate }: { onCreate: () => void }) {
  const { status, setStatus } = useStore();
  const [showBackups, setShowBackups] = useState(false);
  const { error } = useToast();
  return (
    <ScreenFrame width={480}>
      <div className="mb-5 inline-flex size-10 items-center justify-center rounded-sm border border-border bg-card">
        <SearchX aria-hidden className="size-5 text-muted-foreground" />
      </div>
      <StepTitle title="Coffer cannot find your vault">
        It is not at <span className="break-all text-foreground" data-selectable>{status?.vaultPath ?? "its saved path"}</span>. A sync tool, a renamed folder or a removed drive can do this. Coffer never makes a new file there without asking.
      </StepTitle>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          icon={<FolderSearch className="size-4" />}
          onClick={async () => {
            try {
              const s = await call("vault_open");
              if (s) setStatus(s);
            } catch (e) {
              error(e);
            }
          }}
        >
          Find vault file
        </Button>
        <Button icon={<History className="size-4" />} onClick={() => setShowBackups((v) => !v)} aria-expanded={showBackups}>
          Restore from backup
        </Button>
        <Button variant="ghost" onClick={onCreate}>
          Create a new vault
        </Button>
      </div>
      {showBackups && (
        <div className="mt-6">
          <BackupList onRestored={setStatus} />
        </div>
      )}
    </ScreenFrame>
  );
}

export function Tampered({ onDone }: { onDone: () => void }) {
  const { setStatus } = useStore();
  const [choose, setChoose] = useState(false);
  const [busy, setBusy] = useState(false);
  const { error } = useToast();
  return (
    <ScreenFrame width={480}>
      <div className="mb-5 inline-flex size-10 items-center justify-center rounded-sm border border-destructive bg-accent/40">
        <FileWarning aria-hidden className="size-5 text-danger-text" />
      </div>
      <StepTitle title="This vault file was changed outside Coffer">
        Its check does not match, so Coffer did not open it. Something other than Coffer changed, removed or added data in the file. Your backups are safe copies.
      </StepTitle>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const list = await call("backups_list");
              if (!list.length) throw { code: "notFound", message: "There is no backup of this vault yet." };
              const s = await call("backup_restore", { index: list[0].index });
              setStatus(s);
              onDone();
            } catch (e) {
              error(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          Open the newest backup
        </Button>
        <Button onClick={() => setChoose((v) => !v)} aria-expanded={choose}>
          Choose a backup
        </Button>
      </div>
      {choose && (
        <div className="mt-6">
          <BackupList
            onRestored={(s) => {
              setStatus(s);
              onDone();
            }}
          />
        </div>
      )}
    </ScreenFrame>
  );
}

export function OlderFile({ message, onDone }: { message: string; onDone: () => void }) {
  const { setStatus } = useStore();
  const [busy, setBusy] = useState(false);
  const { error } = useToast();
  return (
    <ScreenFrame width={480}>
      <div className="mb-5 inline-flex size-10 items-center justify-center rounded-sm border border-gold/50 bg-card">
        <History aria-hidden className="size-5 text-gold" />
      </div>
      <StepTitle title="This file is older than the one this PC last saw">{message}</StepTitle>
      <p className="mb-6 text-sm text-muted-foreground">
        A sync tool may have put back an old copy. Items you added or changed since then are not in it. Open it only if you expected an older copy.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={onDone}>Cancel</Button>
        <Button
          variant="primary"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              setStatus(await call("vault_open_older"));
              onDone();
            } catch (e) {
              error(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          Open the older file
        </Button>
      </div>
    </ScreenFrame>
  );
}
