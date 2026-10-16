// Settings (SPEC 9, 11): General, Security, Vault, Shortcuts, About.
import { FolderInput, KeyRound, Printer, Upload } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import { HotkeyInput } from "../../components/HotkeyInput";
import { StrengthMeter } from "../../components/bits";
import { Dialog, useToast } from "../../components/overlays";
import { Button, Checkbox, cx, FormRow, Keys, PasswordInput, Segmented, Select, Switch } from "../../components/ui";
import type { EmergencyKit, ExportKind, Settings } from "../../lib/contract";
import { call, isCofferError } from "../../lib/ipc";
import { useListDensity } from "../prefs";
import { BackupList } from "../screens/Locked";
import { KitSheet } from "../screens/Onboarding";
import { useStore } from "../store";
import type { Nav, SettingsTab } from "../vault/nav";
import { PageShell, Tabs } from "./PageShell";

export const MAIN_SHORTCUTS: Array<[string, string]> = [
  ["Ctrl+F", "Search"],
  ["Ctrl+N", "New item"],
  ["Ctrl+E", "Edit the item"],
  ["Ctrl+S", "Save"],
  ["Esc", "Cancel the edit"],
  ["Ctrl+U", "Copy the username"],
  ["Ctrl+P", "Copy the password"],
  ["Ctrl+T", "Copy the one-time code"],
  ["Ctrl+R", "Reveal the password"],
  ["Ctrl+G", "Generator"],
  ["Ctrl+L", "Lock"],
  ["Delete", "Move to Trash (Undo for 6 s)"],
  ["Ctrl+,", "Settings"],
  ["F1", "This list"],
];

export const QUICK_SHORTCUTS: Array<[string, string]> = [
  ["Up / Down", "Move"],
  ["Enter", "Copy the main secret (the password for a login)"],
  ["Ctrl+U", "Copy the username"],
  ["Ctrl+P", "Copy the password"],
  ["Ctrl+T", "Copy the one-time code"],
  ["Right", "All actions (caret at the end of the search)"],
  ["Ctrl+O", "Open in Coffer"],
  ["Esc", "Clear the search; again to close"],
];

function Row({ title, description, children, htmlFor }: { title: string; description?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="flex items-start justify-between gap-8 py-3.5">
      <div className="min-w-0">
        <label htmlFor={htmlFor} className="text-sm font-medium">
          {title}
        </label>
        {description && <p className="mt-0.5 max-w-[56ch] text-xs text-muted-foreground">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-8 flex flex-col first:mt-0">
      <h2 className="mb-1 text-2xs font-semibold tracking-[0.06em] text-muted-foreground uppercase">{title}</h2>
      <div className="divide-y divide-border">{children}</div>
    </section>
  );
}

const TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: "general", label: "General" },
  { id: "security", label: "Security" },
  { id: "vault", label: "Vault" },
  { id: "shortcuts", label: "Shortcuts" },
  { id: "about", label: "About" },
];

export function SettingsView({ tab, onTab, go }: { tab: SettingsTab; onTab: (t: SettingsTab) => void; go: (p: Partial<Nav>) => void }) {
  const { settings, updateSettings } = useStore();
  if (!settings) return null;
  const set = (patch: Partial<Settings>) => updateSettings(patch);
  return (
    <PageShell title="Settings">
      <Tabs label="Settings" tabs={TABS} value={tab} onChange={onTab} />
      <div role="tabpanel" aria-label={TABS.find((t) => t.id === tab)?.label} className="flex flex-col">
        {tab === "general" && <General settings={settings} set={set} />}
        {tab === "security" && <Security settings={settings} set={set} />}
        {tab === "vault" && <VaultTab go={go} />}
        {tab === "shortcuts" && <Shortcuts settings={settings} set={set} />}
        {tab === "about" && <About />}
      </div>
    </PageShell>
  );
}

type SetFn = (patch: Partial<Settings>) => void;

function General({ settings, set }: { settings: Settings; set: SetFn }) {
  const [density, setDensity] = useListDensity();
  return (
    <Section title="General">
      <Row title="List density" description="Compact shows each item on one 30 px line: title, username and website.">
        <Segmented
          label="List density"
          value={density}
          onChange={setDensity}
          options={[
            { value: "comfortable", label: "Comfortable" },
            { value: "compact", label: "Compact" },
          ]}
        />
      </Row>
      <Row title="Start with Windows" description="Coffer starts in the tray, locked.">
        <Switch label="Start with Windows" checked={settings.startWithWindows} onChange={(v) => set({ startWithWindows: v })} />
      </Row>
      <Row title="Start hidden in the tray" description="Off: the main window opens at start.">
        <Switch label="Start hidden in the tray" checked={settings.startHidden} onChange={(v) => set({ startHidden: v })} />
      </Row>
      <Row title="A click on the tray icon opens">
        <Segmented
          label="A click on the tray icon opens"
          value={settings.trayClick}
          onChange={(v) => set({ trayClick: v })}
          options={[
            { value: "quick", label: "Quick Access" },
            { value: "main", label: "Main window" },
          ]}
        />
      </Row>
      <Row title="The window's close button" description="Coffer keeps running in the tray either way until you quit it from the tray menu.">
        <Segmented
          label="The window's close button"
          value={settings.closeBehavior}
          onChange={(v) => set({ closeBehavior: v })}
          options={[
            { value: "hide", label: "Hides to tray" },
            { value: "quit", label: "Quits Coffer" },
          ]}
        />
      </Row>
    </Section>
  );
}

function Security({ settings, set }: { settings: Settings; set: SetFn }) {
  const { info, status, setStatus } = useStore();
  const [kitOpen, setKitOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const [hello, setHello] = useState<boolean | null>(null);
  const ids = { lock: useId(), clip: useId(), days: useId() };
  return (
    <>
      <Section title="Locking">
        <Row title="Lock after this long without use" htmlFor={ids.lock} description="Counts time with no keyboard or mouse input anywhere on the PC.">
          <Select
            id={ids.lock}
            value={settings.autoLockMinutes === null ? "never" : String(settings.autoLockMinutes)}
            onChange={(e) => set({ autoLockMinutes: e.target.value === "never" ? null : Number(e.target.value) })}
            className="w-36"
          >
            {[1, 2, 5, 10, 15, 30, 60].map((m) => (
              <option key={m} value={m}>
                {m} minute{m === 1 ? "" : "s"}
              </option>
            ))}
            <option value="never">Never</option>
          </Select>
        </Row>
        <Row title="Lock when Windows locks">
          <Switch label="Lock when Windows locks" checked={settings.lockOnSystemLock} onChange={(v) => set({ lockOnSystemLock: v })} />
        </Row>
        <Row title="Lock when the PC sleeps">
          <Switch label="Lock when the PC sleeps" checked={settings.lockOnSleep} onChange={(v) => set({ lockOnSleep: v })} />
        </Row>
        <Row
          title="Windows Hello"
          description={
            info?.helloAvailable ? (
              <>
                Unlock with your face, fingerprint or PIN after one master-password unlock. With Windows Hello on, a program running as you can open the vault without your master password.
              </>
            ) : (
              "Windows Hello is not set up on this PC."
            )
          }
        >
          <Switch
            label="Windows Hello"
            checked={status?.helloEnabled ?? false}
            disabled={!info?.helloAvailable}
            onChange={(v) => setHello(v)}
          />
        </Row>
        {info?.helloAvailable && (
          <Row title="Ask for the master password every" htmlFor={ids.days} description="Windows Hello stops working after this many days without a master-password unlock.">
            <Select id={ids.days} value={String(settings.requirePasswordDays)} onChange={(e) => set({ requirePasswordDays: Number(e.target.value) })} className="w-28">
              {[7, 14, 30].map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </Select>
          </Row>
        )}
      </Section>
      <Section title="Clipboard and screen">
        <Row title="Clear the clipboard after" htmlFor={ids.clip} description="Only when it still holds what Coffer copied. Not kept in Windows clipboard history.">
          <Select
            id={ids.clip}
            value={settings.clipboardClearSeconds === null ? "never" : String(settings.clipboardClearSeconds)}
            onChange={(e) => set({ clipboardClearSeconds: e.target.value === "never" ? null : Number(e.target.value) })}
            className="w-36"
          >
            {[10, 30, 60, 90, 120, 300].map((s) => (
              <option key={s} value={s}>
                {s < 120 ? `${s} seconds` : `${s / 60} minutes`}
              </option>
            ))}
            <option value="never">Never</option>
          </Select>
        </Row>
        <Row title="Hide Coffer from screenshots" description="Hidden from most screenshots and screen sharing.">
          <Switch label="Hide Coffer from screenshots" checked={settings.captureProtection} onChange={(v) => set({ captureProtection: v })} />
        </Row>
      </Section>
      <Section title="Breach check">
        <Row
          title="Check passwords against known breaches"
          description="Coffer sends the first 5 characters of each password's SHA-1 hash to Have I Been Pwned, never the password, and compares the rest on this PC. This is Coffer's only network call."
        >
          <Segmented
            label="Breach check"
            size="sm"
            value={settings.breachCheck}
            onChange={(v) => set({ breachCheck: v })}
            options={[
              { value: "off", label: "Off" },
              { value: "manual", label: "When I ask" },
              { value: "weekly", label: "Weekly" },
            ]}
          />
        </Row>
      </Section>
      <Section title="Master password and Secret Key">
        <Row title="Show Secret Key" description="Shows the Emergency Kit again, to set up Coffer on another PC.">
          <Button icon={<KeyRound className="size-4" />} onClick={() => setKitOpen(true)}>
            Show Secret Key
          </Button>
        </Row>
        <Row title="Change master password">
          <Button onClick={() => setPwOpen(true)}>Change master password</Button>
        </Row>
      </Section>
      <ShowKitDialog open={kitOpen} onClose={() => setKitOpen(false)} />
      <ChangePasswordDialog open={pwOpen} onClose={() => setPwOpen(false)} />
      <HelloDialog
        enable={hello}
        onClose={() => setHello(null)}
        onDone={(s) => {
          setStatus(s);
          setHello(null);
        }}
      />
    </>
  );
}

function MasterPasswordField({ value, onChange, error, id }: { value: string; onChange: (v: string) => void; error?: string | null; id: string }) {
  return (
    <FormRow label="Master password" htmlFor={id} error={error}>
      <PasswordInput id={id} autoFocus value={value} onChange={(e) => onChange(e.target.value)} invalid={!!error} revealLabel="master password" />
    </FormRow>
  );
}

function ShowKitDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [pw, setPw] = useState("");
  const [kit, setKit] = useState<EmergencyKit | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  useEffect(() => {
    if (!open) {
      setPw("");
      setKit(null);
      setErr(null);
    }
  }, [open]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={kit ? "Emergency Kit" : "Show Secret Key"}
      description={kit ? undefined : "Type your master password to see the Secret Key and print the kit again."}
      width={kit ? 620 : 400}
      footer={
        kit ? (
          <>
            <Button icon={<Printer className="size-4" />} onClick={() => window.print()}>
              Save as PDF
            </Button>
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" type="submit" form={`${id}-f`} loading={busy} disabled={!pw}>
              Show
            </Button>
          </>
        )
      }
    >
      {kit ? (
        <div className="pb-2">
          <KitSheet kit={kit} />
        </div>
      ) : (
        <form
          id={`${id}-f`}
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setErr(null);
            try {
              setKit(await call("emergency_kit", { password: pw }));
            } catch (er) {
              setErr(isCofferError(er) && er.code === "badCredentials" ? "Wrong master password." : String((er as { message?: string }).message ?? er));
            } finally {
              setBusy(false);
            }
          }}
        >
          <MasterPasswordField id={`${id}-pw`} value={pw} onChange={setPw} error={err} />
        </form>
      )}
    </Dialog>
  );
}

function ChangePasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { status } = useStore();
  const { toast } = useToast();
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [rekey, setRekey] = useState(true);
  const [strength, setStrength] = useState<{ score: number; crackTime: string; warning: string | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  useEffect(() => {
    if (!open) {
      setCur("");
      setNext("");
      setAgain("");
      setErr(null);
      setRekey(true);
    }
  }, [open]);
  useEffect(() => {
    if (!next) return setStrength(null);
    const t = window.setTimeout(() => {
      call("password_strength", { password: next, userInputs: [status?.vaultName ?? ""] }).then(setStrength).catch(() => setStrength(null));
    }, 150);
    return () => window.clearTimeout(t);
  }, [next, status?.vaultName]);
  const ok = !!cur && (strength?.score ?? 0) >= 3 && next === again;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Change master password"
      width={460}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form={`${id}-f`} loading={busy} disabled={!ok}>
            {busy ? "Changing..." : "Change password"}
          </Button>
        </>
      }
    >
      <form
        id={`${id}-f`}
        className="flex flex-col gap-4 pb-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!ok) return;
          setBusy(true);
          setErr(null);
          try {
            await call("vault_change_password", { current: cur, next, rekey });
            toast("Master password changed.");
            onClose();
          } catch (er) {
            setErr(isCofferError(er) && er.code === "badCredentials" ? "The current master password is wrong." : String((er as { message?: string }).message ?? er));
          } finally {
            setBusy(false);
          }
        }}
      >
        <FormRow label="Current master password" htmlFor={`${id}-c`} error={err}>
          <PasswordInput id={`${id}-c`} autoFocus value={cur} onChange={(e) => setCur(e.target.value)} invalid={!!err} />
        </FormRow>
        <FormRow label="New master password" htmlFor={`${id}-n`}>
          <PasswordInput id={`${id}-n`} value={next} onChange={(e) => setNext(e.target.value)} />
          <div className="mt-1">
            <StrengthMeter score={strength?.score ?? null} crackTime={strength?.crackTime} warning={strength?.warning} />
          </div>
        </FormRow>
        <FormRow label="Type it again" htmlFor={`${id}-a`} error={again && again !== next ? "The two passwords are not the same." : null}>
          <PasswordInput id={`${id}-a`} value={again} onChange={(e) => setAgain(e.target.value)} capsWarning={false} />
        </FormRow>
        <Checkbox
          label="My old password may be known"
          description="Coffer then makes a new vault key and encrypts every item again, and deletes this PC's backups made under the old key."
          checked={rekey}
          onChange={setRekey}
        />
        <p className="text-xs text-muted-foreground">Copies made before now (sync history, other backups) still open with the old password and Secret Key.</p>
      </form>
    </Dialog>
  );
}

function HelloDialog({ enable, onClose, onDone }: { enable: boolean | null; onClose: () => void; onDone: (s: import("../../lib/contract").VaultStatus) => void }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      onDone(await call("hello_set", { enabled: !!enable, password: enable ? pw : null }));
    } catch (er) {
      setErr(isCofferError(er) ? (er.code === "badCredentials" ? "Wrong master password." : er.message) : String(er));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={enable !== null}
      onClose={onClose}
      title={enable ? "Turn on Windows Hello" : "Turn off Windows Hello"}
      description={enable ? "With Windows Hello on, a program running as you can open the vault without your master password." : "Unlocking will need your master password again."}
      width={420}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!!enable && !pw} onClick={submit}>
            {enable ? "Turn on" : "Turn off"}
          </Button>
        </>
      }
    >
      {enable && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <MasterPasswordField id={id} value={pw} onChange={setPw} error={err} />
        </form>
      )}
    </Dialog>
  );
}

function VaultTab({ go }: { go: (p: Partial<Nav>) => void }) {
  const { status, setStatus } = useStore();
  const { error, toast } = useToast();
  const [exportOpen, setExportOpen] = useState(false);
  return (
    <>
      <Section title="Vault file">
        <Row title="Location" description={<span className="break-all" data-selectable>{status?.vaultPath}</span>}>
          <Button
            icon={<FolderInput className="size-4" />}
            onClick={async () => {
              try {
                const s = await call("vault_move");
                if (s) {
                  setStatus(s);
                  toast("Vault moved.");
                }
              } catch (e) {
                error(e);
              }
            }}
          >
            Move...
          </Button>
        </Row>
        <Row title="Import" description="From 1Password, Bitwarden, Dashlane, a browser or another Coffer file.">
          <Button onClick={() => go({ view: "import" })}>Import...</Button>
        </Row>
        <Row title="Export" description="An encrypted Coffer file, or a plain file to move to another password manager.">
          <Button icon={<Upload className="size-4" />} onClick={() => setExportOpen(true)}>
            Export...
          </Button>
        </Row>
      </Section>
      <section className="mt-8 flex flex-col gap-2">
        <h2 className="text-2xs font-semibold tracking-[0.06em] text-muted-foreground uppercase">Backups</h2>
        <p className="text-xs text-muted-foreground">After each save Coffer keeps an encrypted copy on this PC: the last 20 saves and one a day for 30 days.</p>
        <BackupList onRestored={setStatus} />
      </section>
      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} />
    </>
  );
}

const EXPORTS: Array<{ kind: ExportKind; label: string; detail: string; plain: boolean }> = [
  { kind: "cofferEncrypted", label: "Coffer encrypted (.cofferx)", detail: "Locked with a password you choose now. For backups and moving to another PC.", plain: false },
  { kind: "cofferJson", label: "Coffer JSON", detail: "Every field and password history, in plain text.", plain: true },
  { kind: "bitwardenJson", label: "Bitwarden JSON", detail: "Plain text that Bitwarden and most password managers import.", plain: true },
  { kind: "csv", label: "CSV", detail: "Logins and notes only, plain text, Bitwarden columns.", plain: true },
];

export function ExportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [kind, setKind] = useState<ExportKind>("cofferEncrypted");
  const [master, setMaster] = useState("");
  const [exp, setExp] = useState("");
  const [exp2, setExp2] = useState("");
  const [score, setScore] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();
  const id = useId();
  const choice = EXPORTS.find((e) => e.kind === kind)!;
  useEffect(() => {
    if (!open) {
      setMaster("");
      setExp("");
      setExp2("");
      setErr(null);
    }
  }, [open]);
  useEffect(() => {
    if (!exp) return setScore(null);
    const t = window.setTimeout(() => call("password_strength", { password: exp, userInputs: [] }).then((s) => setScore(s.score)).catch(() => setScore(null)), 150);
    return () => window.clearTimeout(t);
  }, [exp]);
  const encrypted = kind === "cofferEncrypted";
  const ok = !!master && (!encrypted || ((score ?? 0) >= 3 && exp === exp2));
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Export"
      width={500}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form={`${id}-f`} loading={busy} disabled={!ok}>
            Choose where to save
          </Button>
        </>
      }
    >
      <form
        id={`${id}-f`}
        className="flex flex-col gap-4 pb-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!ok) return;
          setBusy(true);
          setErr(null);
          try {
            const r = await call("export_vault", { kind, masterPassword: master, exportPassword: encrypted ? exp : null });
            if (r) {
              toast(`Exported to ${r.path}.`);
              onClose();
            }
          } catch (er) {
            setErr(isCofferError(er) && er.code === "badCredentials" ? "Wrong master password." : String((er as { message?: string }).message ?? er));
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1.5 text-xs font-medium text-muted-foreground">Format</legend>
          {EXPORTS.map((x) => (
            <label
              key={x.kind}
              className={cx("flex cursor-pointer items-start gap-2.5 rounded-sm px-2 py-2", kind === x.kind ? (x.plain ? "bg-accent/40" : "bg-muted") : "hover:bg-muted/60")}
            >
              <input type="radio" name={`${id}-kind`} checked={kind === x.kind} onChange={() => setKind(x.kind)} className="mt-[3px] accent-foreground" />
              <span>
                <span className="flex items-center gap-2 text-sm">
                  {x.label}
                  {x.plain && <span className="rounded-sm border border-gold/40 px-1.5 text-2xs leading-4 font-semibold text-gold">Plain text</span>}
                </span>
                <span className="block text-xs text-muted-foreground">{x.detail}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {choice.plain && (
          <p role="alert" className="rounded-sm border border-destructive bg-accent/40 px-3 py-2 text-sm">
            This file will hold your passwords in plain text. Anyone who opens it can read them.
          </p>
        )}
        {encrypted && (
          <>
            <FormRow label="Password for the export file" htmlFor={`${id}-e`}>
              <PasswordInput id={`${id}-e`} value={exp} onChange={(e) => setExp(e.target.value)} />
              <div className="mt-1">
                <StrengthMeter score={score} />
              </div>
            </FormRow>
            <FormRow label="Type it again" htmlFor={`${id}-e2`} error={exp2 && exp2 !== exp ? "The two passwords are not the same." : null}>
              <PasswordInput id={`${id}-e2`} value={exp2} onChange={(e) => setExp2(e.target.value)} capsWarning={false} />
            </FormRow>
          </>
        )}
        <FormRow label="Your master password" htmlFor={`${id}-m`} error={err} hint="Any export needs it again.">
          <PasswordInput id={`${id}-m`} value={master} onChange={(e) => setMaster(e.target.value)} invalid={!!err} revealLabel="master password" />
        </FormRow>
      </form>
    </Dialog>
  );
}

function Shortcuts({ settings, set }: { settings: Settings; set: SetFn }) {
  const { info, refreshInfo } = useStore();
  // "In use by another app" can change while Coffer runs: read it again each time this tab opens.
  useEffect(() => {
    refreshInfo();
  }, [refreshInfo]);
  return (
    <>
      <Section title="From any app">
        <Row title="Quick Access" description="Opens Coffer's search above your other windows.">
          <HotkeyInput label="Quick Access" value={settings.hotkeyQuick} onChange={(c) => set({ hotkeyQuick: c })} status={info?.hotkeyStatus.quick} />
        </Row>
        <Row title="Lock Coffer" description="Off by default: locking Windows already locks Coffer.">
          <div className="flex items-start gap-3">
            {settings.hotkeyLock !== null && <HotkeyInput label="Lock Coffer" value={settings.hotkeyLock} onChange={(c) => set({ hotkeyLock: c })} status={info?.hotkeyStatus.lock} />}
            <Switch label="Lock shortcut" checked={settings.hotkeyLock !== null} onChange={(v) => set({ hotkeyLock: v ? "Ctrl+Shift+L" : null })} />
          </div>
        </Row>
      </Section>
      <ShortcutTable title="In the Coffer window" rows={MAIN_SHORTCUTS} />
      <ShortcutTable title="In Quick Access" rows={QUICK_SHORTCUTS} />
    </>
  );
}

export function ShortcutTable({ title, rows }: { title: string; rows: Array<[string, string]> }) {
  return (
    <section className="mt-8 first:mt-0">
      <h2 className="mb-1 text-2xs font-semibold tracking-[0.06em] text-muted-foreground uppercase">{title}</h2>
      <table className="w-full text-sm">
        <tbody className="divide-y divide-border">
          {rows.map(([k, d]) => (
            <tr key={k}>
              <td className="w-40 py-2 align-top">{k.includes("/") ? <span className="text-xs">{k}</span> : <Keys combo={k} />}</td>
              <td className="py-2 text-muted-foreground">{d}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function About() {
  const { info } = useStore();
  return (
    <>
      <section className="flex flex-col gap-1">
        <h2 className="text-2xs font-semibold tracking-[0.06em] text-muted-foreground uppercase">Coffer {info?.version}</h2>
        <p className="text-sm text-muted-foreground">A password manager that keeps your vault in one encrypted file on this PC. No account, no server.</p>
      </section>
      <section className="mt-8 flex flex-col gap-2 text-sm">
        <h2 className="text-2xs font-semibold tracking-[0.06em] text-muted-foreground uppercase">How Coffer protects your data</h2>
        <p>
          Your vault opens with two secrets: your master password and a Secret Key that this PC keeps and your Emergency Kit holds. A copy of the vault file alone is not enough to read it.
        </p>
        <p>Coffer stretches your password with Argon2id (128 MiB, 3 passes), then encrypts each item with XChaCha20-Poly1305. A check over the whole file finds changes made outside Coffer.</p>
        <p>Secrets stay in Coffer's core. This window gets a secret only when you reveal it or edit it; copies go straight from the core to Windows, are kept out of clipboard history and are cleared after the time you set.</p>
        <p className="text-muted-foreground">
          Limits: a program running as you while Coffer is unlocked can read what you can read. Copies of the vault made before a password change still open with the old password.
        </p>
      </section>
      <section className="mt-8 flex flex-col gap-1.5">
        <h2 className="text-2xs font-semibold tracking-[0.06em] text-muted-foreground uppercase">Licences</h2>
        <ul className="divide-y divide-border text-sm">
          {[
            ["EFF large word list", "Electronic Frontier Foundation, CC BY 3.0 US. Used for passphrases."],
            ["Switzer", "Indian Type Foundry, ITF Free Font License."],
            ["JetBrains Mono", "JetBrains, SIL Open Font License 1.1."],
            ["Lucide icons", "ISC licence."],
            ["React, Tauri, Motion", "MIT licence (Tauri also Apache 2.0)."],
            ["zxcvbn", "Dropbox, MIT licence. Password strength estimates."],
            ["Pwned Passwords", "Have I Been Pwned, by Troy Hunt (only when you turn on breach checks)."],
          ].map(([n, d]) => (
            <li key={n} className="flex gap-4 py-2">
              <span className="w-44 shrink-0">{n}</span>
              <span className="text-muted-foreground">{d}</span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
