// Welcome, Create vault (details, Emergency Kit, confirm, preferences, try the
// shortcut) and Open existing vault. SPEC 11 items 1 to 3.
import { Check, CloudAlert, FileDown, FolderOpen, Printer, ShieldCheck } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { HotkeyInput } from "../../components/HotkeyInput";
import { StrengthMeter } from "../../components/bits";
import { useToast } from "../../components/overlays";
import { Button, cx, ErrorText, FormRow, Input, Keys, Notice, PasswordInput, Switch } from "../../components/ui";
import type { EmergencyKit, FolderInfo } from "../../lib/contract";
import { formatDate, vaultStem } from "../../lib/format";
import { lastSecretKeyGroup, SECRET_KEY_GROUPS } from "../../lib/secretKey";
import { call, isCofferError, on } from "../../lib/ipc";
import { useStore } from "../store";
import { ScreenFrame, StepTitle } from "./Frame";

export function Welcome({ onCreate, onOpen }: { onCreate: () => void; onOpen: () => void }) {
  return (
    <ScreenFrame center width={440}>
      <StepTitle title="Keep your passwords on this PC">
        Coffer keeps them in one encrypted file on your own disk. No account, no server. Open it from the tray or with a shortcut from any app.
      </StepTitle>
      <div className="flex flex-col gap-2">
        <Button variant="primary" size="lg" className="justify-start" onClick={onCreate}>
          Create a new vault
        </Button>
        <Button size="lg" className="justify-start" icon={<FolderOpen className="size-4" />} onClick={onOpen}>
          Open an existing vault
        </Button>
      </div>
      <p className="mt-6 text-xs text-muted-foreground">Open an existing vault when you set up Coffer on a new PC. You need its Emergency Kit.</p>
    </ScreenFrame>
  );
}

type Step = "details" | "kit" | "confirm" | "prefs" | "hotkey";
const STEPS: Step[] = ["details", "kit", "confirm", "prefs", "hotkey"];
const stepLabel = (s: Step) => `Step ${STEPS.indexOf(s) + 1} of ${STEPS.length}`;

export function CreateVault({ onCancel, onDone, initialStep }: { onCancel: () => void; onDone: () => void; initialStep?: Step }) {
  const [step, setStep] = useState<Step>(initialStep ?? "details");
  const [kit, setKit] = useState<EmergencyKit | null>(null);
  const { info } = useStore();

  // Screenshot states (demo) start later in the flow with an example kit.
  useEffect(() => {
    if (initialStep && initialStep !== "details" && !kit && info?.demo) {
      call("vault_create", { name: "Personal", password: "correct horse battery staple 42", usePickedFolder: false }).then(setKit).catch(() => undefined);
    }
  }, [initialStep, kit, info?.demo]);

  if (step === "details")
    return (
      <Details
        onCancel={onCancel}
        onCreated={(k) => {
          setKit(k);
          setStep("kit");
        }}
      />
    );
  if (!kit) return <ScreenFrame>{null}</ScreenFrame>;
  if (step === "kit") return <KitStep kit={kit} onNext={() => setStep("confirm")} />;
  if (step === "confirm") return <ConfirmKit kit={kit} onBack={() => setStep("kit")} onNext={() => setStep("prefs")} />;
  if (step === "prefs") return <Prefs onNext={() => setStep("hotkey")} />;
  return <TryHotkey onDone={onDone} />;
}

function Details({ onCancel, onCreated }: { onCancel: () => void; onCreated: (k: EmergencyKit) => void }) {
  const [name, setName] = useState("Personal");
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [confirmTouched, setConfirmTouched] = useState(false);
  const [strength, setStrength] = useState<{ score: number; crackTime: string; warning: string | null } | null>(null);
  const [checking, setChecking] = useState(false);
  const [folder, setFolder] = useState<FolderInfo | null>(null);
  const [picked, setPicked] = useState(false);
  const [kdf, setKdf] = useState<{ millis: number; mKib: number; t: number; p: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { error: toastError } = useToast();
  const ids = { name: useId(), pw: useId(), confirm: useId() };

  useEffect(() => {
    call("folder_info").then(setFolder).catch(toastError);
    call("kdf_benchmark").then(setKdf).catch(() => undefined);
  }, [toastError]);

  useEffect(() => {
    if (!pw) {
      setStrength(null);
      return;
    }
    setChecking(true);
    const t = window.setTimeout(() => {
      call("password_strength", { password: pw, userInputs: [name, "coffer"] })
        .then((s) => setStrength(s))
        .catch(() => setStrength(null))
        .finally(() => setChecking(false));
    }, 150);
    return () => window.clearTimeout(t);
  }, [pw, name]);

  const mismatch = confirmTouched && confirm !== pw ? "The two passwords are not the same." : null;
  const strongEnough = (strength?.score ?? 0) >= 3;
  const canCreate = name.trim() !== "" && strongEnough && confirm === pw && !!folder?.writable;
  // Say why Create is not available yet, next to the button.
  const blocker =
    name.trim() === ""
      ? "Enter a vault name."
      : !pw
        ? "Enter a master password."
        : !strongEnough
          ? 'The master password needs at least "Good".'
          : confirm !== pw
            ? "Type the master password again below."
            : !folder?.writable
              ? "Choose a folder Coffer can write to."
              : null;

  const pick = async () => {
    try {
      const f = await call("folder_pick");
      if (f) {
        setFolder(f);
        setPicked(true);
      }
    } catch (e) {
      toastError(e);
    }
  };

  const create = async () => {
    setConfirmTouched(true);
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    try {
      const kit = await call("vault_create", { name: name.trim(), password: pw, usePickedFolder: picked });
      onCreated(kit);
    } catch (e) {
      if (isCofferError(e) && e.code === "exists") setError(`${vaultStem(name)}.coffer is already in that folder. Coffer never overwrites a vault. Choose another name or folder.`);
      else setError(isCofferError(e) ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScreenFrame onBack={onCancel} width={460}>
      <StepTitle step={stepLabel("details")} title="Create your vault">
        Coffer cannot reset a master password. Pick one you will remember; a few unrelated words work well.
      </StepTitle>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <FormRow label="Vault name" htmlFor={ids.name} hint="Also the file name. It shows on the lock screen, so it is not secret.">
          <Input id={ids.name} value={name} onChange={(e) => setName(e.target.value)} />
        </FormRow>
        <FormRow label="Master password" htmlFor={ids.pw}>
          <PasswordInput id={ids.pw} value={pw} onChange={(e) => setPw(e.target.value)} autoFocus revealLabel="master password" />
          <div className="mt-1">
            <StrengthMeter score={strength?.score ?? null} crackTime={strength?.crackTime} warning={strength?.warning} busy={checking} />
            {strength && !strongEnough && <ErrorText alert={false} className="mt-1">Choose a stronger master password. It needs at least "Good".</ErrorText>}
          </div>
        </FormRow>
        <FormRow label="Type it again" htmlFor={ids.confirm} error={mismatch}>
          <PasswordInput
            id={ids.confirm}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            onBlur={() => setConfirmTouched(true)}
            invalid={!!mismatch}
            capsWarning={false}
            revealLabel="master password"
          />
        </FormRow>
        <FormRow label="Location" aside={<Button size="sm" variant="quiet" icon={<FolderOpen className="size-3.5" />} onClick={pick}>Choose folder</Button>}>
          <p className="truncate rounded-sm border border-border bg-card px-2.5 py-1.5 text-sm" title={folder?.path} data-selectable>
            {folder ? `${folder.path}\\${vaultStem(name)}.coffer` : "..."}
          </p>
          {folder?.synced && (
            <Notice tone="warning" icon={<CloudAlert />} className="mt-2">
              This folder syncs to the cloud{folder.provider ? ` (${folder.provider})` : ""}. The file is encrypted and useless without your Secret Key, but every copy that sync keeps can be attacked offline with it.
            </Notice>
          )}
          {folder && !folder.writable && <ErrorText alert={false}>Coffer cannot write to this folder. Choose another.</ErrorText>}
        </FormRow>
        <p className="text-xs text-muted-foreground">
          {kdf
            ? `Unlocking takes about ${(kdf.millis / 1000).toFixed(1)} s on this PC (Argon2id, ${Math.round(kdf.mKib / 1024)} MiB, ${kdf.t} passes). That cost is what slows down anyone guessing your password.`
            : "Measuring how long unlocking takes on this PC..."}
        </p>
        {error && (
          <ErrorText className="text-sm">{error}</ErrorText>
        )}
        <div className="flex items-center gap-2">
          <Button type="submit" variant="primary" loading={busy} disabled={!canCreate} aria-describedby={blocker ? `${ids.name}-why` : undefined}>
            {busy ? "Creating..." : "Create vault"}
          </Button>
          <Button variant="quiet" onClick={onCancel}>
            Cancel
          </Button>
          {blocker && !busy && (
            <p id={`${ids.name}-why`} className="ml-1 text-xs text-muted-foreground">
              {blocker}
            </p>
          )}
        </div>
      </form>
    </ScreenFrame>
  );
}

/** The printable Emergency Kit. Print styles turn it black on white. */
export function KitSheet({ kit, lossLineOnScreen = true }: { kit: EmergencyKit; /** False when the screen already says it above the sheet. */ lossLineOnScreen?: boolean }) {
  const rows: Array<[string, string]> = [
    ["Vault name", kit.vaultName],
    ["Created", formatDate(kit.createdAt)],
    ["Computer", kit.computerName],
    ["File", kit.vaultPath],
    ["Key ID (not secret)", kit.keyId],
  ];
  return (
    <article className="kit-sheet rounded-sm border border-border bg-card p-6" aria-label="Emergency Kit">
      <header className="mb-5 flex items-baseline justify-between gap-4 border-b border-border pb-3">
        <h2 className="text-lg font-semibold">Coffer Emergency Kit</h2>
        <span className="text-xs text-muted-foreground">Keep it on paper, somewhere safe</span>
      </header>
      <dl className="grid grid-cols-[148px_1fr] gap-x-4 gap-y-2 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="min-w-0 break-all" data-selectable>
              {v}
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-6">
        <p className="mb-2 text-xs font-medium text-muted-foreground">Secret Key</p>
        {/* One form everywhere: "C1" and the groups in one colour and weight, hyphens between them. */}
        <p className="font-mono text-lg font-medium tracking-[0.04em] break-all" data-selectable>
          {kit.secretKey}
        </p>
      </div>
      <div className="mt-6">
        <p className="mb-2 text-xs font-medium text-muted-foreground">Master password</p>
        <div className="flex h-12 items-center rounded-sm border border-dashed border-input-hover px-3">
          {/* On screen only: the printed box stays empty for the handwriting. */}
          <span className="screen-only text-xs text-muted-foreground">Write your master password here by hand after you print. Coffer never puts it in the kit.</span>
        </div>
      </div>
      <p className={cx("mt-5 text-sm font-medium", !lossLineOnScreen && "print-only")}>If you lose this kit and this computer, nobody can open this vault, not even Coffer.</p>
    </article>
  );
}

function KitStep({ kit, onNext }: { kit: EmergencyKit; onNext: () => void }) {
  // Continue opens once the print dialog ran (print or "Microsoft Print to PDF"); Coffer cannot see which.
  const [printed, setPrinted] = useState(false);
  const print = () => {
    window.print();
    setPrinted(true);
  };
  return (
    <ScreenFrame width={660}>
      <div className="no-print">
        <StepTitle step={stepLabel("kit")} title="Save your Emergency Kit">
          Your vault opens with your master password plus this Secret Key. If you lose this kit and this computer, nobody can open this vault, not even Coffer.
        </StepTitle>
      </div>
      <KitSheet kit={kit} lossLineOnScreen={false} />
      <div className="no-print">
        <Notice tone="warning" icon={<CloudAlert />} className="mt-4">
          Keep the kit off the cloud folder that holds your vault: together they leave only your password between an attacker and your data.
        </Notice>
      </div>
      {/* Sticky, so the step's actions stay in view at 720 px. The rule is as wide as the kit. */}
      <div className="no-print sticky bottom-0 z-10 mt-5 border-t border-border bg-background pt-4 pb-4">
        <p className="mb-3 text-xs text-muted-foreground">Keep it off this PC: print it, or put the PDF on a USB stick or your phone.</p>
        <div className="flex items-center gap-2">
          <Button size="lg" variant={printed ? "secondary" : "primary"} icon={<Printer className="size-4" />} onClick={print}>
            Print kit
          </Button>
          <Button size="lg" icon={<FileDown className="size-4" />} onClick={print} title='Opens the print dialog: choose "Microsoft Print to PDF".'>
            Save as PDF
          </Button>
          <span className="flex-1" />
          {!printed && (
            <p id="kit-why" className="text-xs text-muted-foreground">
              Print or save the kit first.
            </p>
          )}
          <Button size="lg" variant={printed ? "primary" : "secondary"} disabled={!printed} aria-describedby={printed ? undefined : "kit-why"} onClick={onNext}>
            Continue
          </Button>
        </div>
      </div>
    </ScreenFrame>
  );
}

function ConfirmKit({ kit, onBack, onNext }: { kit: EmergencyKit; onBack: () => void; onNext: () => void }) {
  const [v, setV] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const id = useId();
  const lastGroup = lastSecretKeyGroup(kit.secretKey);
  const need = SECRET_KEY_GROUPS[SECRET_KEY_GROUPS.length - 1];
  const check = () => {
    if (v.trim().toUpperCase() === lastGroup) onNext();
    else setErr("That does not match. Look at the end of the Secret Key on your kit.");
  };
  return (
    <ScreenFrame center onBack={onBack} backLabel="Back to the kit">
      <StepTitle step={stepLabel("confirm")} title="Check your kit">
        Type the last group of your Secret Key ({need} letters and digits), from the saved kit.
      </StepTitle>
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          check();
        }}
      >
        <FormRow label="Last group" htmlFor={id} error={err}>
          <Input
            id={id}
            mono
            autoFocus
            maxLength={need}
            value={v}
            invalid={!!err}
            onChange={(e) => {
              setV(e.target.value.toUpperCase());
              setErr(null);
            }}
            className="w-[9ch] text-lg tracking-[0.2em] uppercase"
          />
        </FormRow>
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" disabled={v.trim().length !== need}>
            Confirm
          </Button>
          {v.trim().length !== need && <p className="text-xs text-muted-foreground">Type all {need}.</p>}
        </div>
      </form>
    </ScreenFrame>
  );
}

function Prefs({ onNext }: { onNext: () => void }) {
  const { settings, updateSettings, info } = useStore();
  const [startWithWindows, setStart] = useState(settings?.startWithWindows ?? true);
  const [hotkey, setHotkey] = useState(settings?.hotkeyQuick ?? "Ctrl+Shift+Space");
  const [busy, setBusy] = useState(false);
  return (
    <ScreenFrame center>
      <StepTitle step={stepLabel("prefs")} title="Start-up and shortcut">
        You can change both later in Settings.
      </StepTitle>
      <div className="flex flex-col gap-5">
        <div className="flex items-start justify-between gap-6">
          <div>
            <p className="text-sm font-medium">Start with Windows</p>
            <p className="text-xs text-muted-foreground">Coffer starts hidden in the tray, locked.</p>
          </div>
          <Switch label="Start with Windows" checked={startWithWindows} onChange={setStart} />
        </div>
        <div className="flex items-start justify-between gap-6">
          <div>
            <p className="text-sm font-medium">Quick Access shortcut</p>
            <p className="text-xs text-muted-foreground">Opens Coffer's search from any app.</p>
          </div>
          <HotkeyInput label="Quick Access shortcut" value={hotkey} onChange={setHotkey} status={info?.hotkeyStatus.quick} />
        </div>
        <div>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              const saved = await updateSettings({ startWithWindows, hotkeyQuick: hotkey });
              setBusy(false);
              if (saved) onNext(); // on an error the toast says why, and this step stays
            }}
          >
            Continue
          </Button>
        </div>
      </div>
    </ScreenFrame>
  );
}

function TryHotkey({ onDone }: { onDone: () => void }) {
  const { settings } = useStore();
  const combo = settings?.hotkeyQuick ?? "Ctrl+Shift+Space";
  const [seen, setSeen] = useState(false);
  const doneRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // In the app the hotkey opens Quick Access and Rust emits quick://shown.
    const stop = on("quick://shown", () => setSeen(true));
    // In the browser demo, detect the keys in this window.
    const parts = combo.toLowerCase().split("+");
    const key = (e: KeyboardEvent) => {
      const k = e.code === "Space" ? "space" : e.key.toLowerCase();
      if (e.ctrlKey === parts.includes("ctrl") && e.shiftKey === parts.includes("shift") && e.altKey === parts.includes("alt") && k === parts[parts.length - 1]) {
        e.preventDefault();
        setSeen(true);
      }
    };
    window.addEventListener("keydown", key);
    return () => {
      stop();
      window.removeEventListener("keydown", key);
    };
  }, [combo]);
  useEffect(() => {
    if (seen) doneRef.current?.focus();
  }, [seen]);
  return (
    <ScreenFrame center>
      <StepTitle step={stepLabel("hotkey")} title={seen ? "It works" : "Try it now"} />
      {seen ? (
        <div className="flex flex-col gap-5">
          <Notice icon={<Check />} tone="neutral" role="status">
            Quick Access opens from any app with <Keys combo={combo} />. Type a few letters, press Enter, and the password is on the clipboard.
          </Notice>
          <div>
            <Button ref={doneRef} variant="primary" onClick={onDone}>
              Open my vault
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          <div className="flex items-center gap-4 rounded-sm border border-border bg-card px-5 py-6">
            <ShieldCheck aria-hidden className="size-5 text-muted-foreground" />
            <p className="text-base">
              Press <Keys combo={combo} /> now
            </p>
          </div>
          <div>
            <Button variant="quiet" onClick={onDone}>
              Skip this step
            </Button>
          </div>
        </div>
      )}
    </ScreenFrame>
  );
}

export function OpenVault({ onCancel, onDone }: { onCancel: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const { setStatus } = useStore();
  const { error } = useToast();
  return (
    <ScreenFrame center onBack={onCancel}>
      <StepTitle title="Open an existing vault">
        Choose the vault file (it ends in .coffer). Then type your master password and the Secret Key from your Emergency Kit.
      </StepTitle>
      <div className="flex flex-col gap-4">
        <div>
          <Button
            variant="primary"
            icon={<FolderOpen className="size-4" />}
            loading={busy}
            autoFocus
            onClick={async () => {
              setBusy(true);
              try {
                const s = await call("vault_open");
                if (s) {
                  setStatus(s);
                  onDone(); // the unlock form (password and, on a new PC, the Secret Key) comes next
                }
              } catch (e) {
                error(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            Choose vault file
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">No kit? On a computer where this vault opens: Settings &gt; Security &gt; Show Secret Key.</p>
      </div>
    </ScreenFrame>
  );
}
