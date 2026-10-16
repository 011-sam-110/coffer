// Generator panel (SPEC 5): the generator plus its history (masked; reveal or
// copy one entry at a time).
import { Copy, Eye, EyeOff } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Generator } from "../../components/Generator";
import { PasswordChars } from "../../components/bits";
import { ConfirmDialog, useToast } from "../../components/overlays";
import { Button, IconButton, Spinner } from "../../components/ui";
import type { GeneratedHistoryEntry } from "../../lib/contract";
import { formatDateTime, relativeTime } from "../../lib/format";
import { call, on } from "../../lib/ipc";

const MODE_WORD = { random: "Random", passphrase: "Passphrase", pin: "PIN" } as const;

export function GeneratorView() {
  const [history, setHistory] = useState<GeneratedHistoryEntry[] | null>(null);
  const [shown, setShown] = useState<Record<string, string>>({});
  const [confirmClear, setConfirmClear] = useState(false);
  const { error, toast } = useToast();

  const load = useCallback(() => {
    call("generator_history")
      .then(setHistory)
      .catch((e) => {
        setHistory([]);
        error(e);
      });
  }, [error]);
  useEffect(load, [load]);
  // A copy puts the value into history; show it.
  useEffect(() => on("clipboard://copied", () => window.setTimeout(load, 50)), [load]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[720px] flex-col gap-8 px-8 pt-6 pb-16">
        <header>
          <h1 className="text-lg font-semibold">Generator</h1>
          <p className="text-sm text-muted-foreground">Coffer picks each character with the system's random source. The bits count comes from the settings below.</p>
        </header>
        <Generator />
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">History</h2>
            {history && history.length > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setConfirmClear(true)}>
                Clear history
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">A password enters history when you copy it or save it into an item. Coffer keeps the last 50.</p>
          {!history ? (
            <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
              <Spinner /> Loading...
            </div>
          ) : history.length === 0 ? (
            <p className="rounded-sm border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">No generated passwords yet.</p>
          ) : (
            <ul className="divide-y divide-border rounded-sm border border-border bg-card">
              {history.map((h) => {
                const v = shown[h.id];
                return (
                  <li key={h.id} className="grid min-h-10 grid-cols-[1fr_auto] items-center gap-3 px-4 py-2">
                    <div className="min-w-0">
                      <div className="text-sm">
                        {v !== undefined ? <PasswordChars value={v} /> : <span className="text-muted-foreground">{MODE_WORD[h.mode]}, {h.length} characters</span>}
                      </div>
                      <p className="text-xs text-muted-foreground" title={formatDateTime(h.createdAt)}>
                        {relativeTime(h.createdAt)}
                      </p>
                    </div>
                    <div className="flex items-center gap-0.5">
                      <IconButton
                        size="sm"
                        label={v !== undefined ? "Hide" : "Reveal"}
                        onClick={async () => {
                          if (v !== undefined) {
                            setShown((s) => {
                              const n = { ...s };
                              delete n[h.id];
                              return n;
                            });
                            return;
                          }
                          try {
                            const val = await call("generator_history_reveal", { id: h.id });
                            setShown((s) => ({ ...s, [h.id]: val }));
                          } catch (e) {
                            error(e);
                          }
                        }}
                      >
                        {v !== undefined ? <EyeOff /> : <Eye />}
                      </IconButton>
                      <IconButton size="sm" label="Copy" onClick={() => call("generator_history_copy", { id: h.id }).catch(error)}>
                        <Copy />
                      </IconButton>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
      <ConfirmDialog
        open={confirmClear}
        title="Clear generator history?"
        body="Coffer forgets every generated password in the list. Passwords saved in items stay."
        confirmLabel="Clear history"
        danger
        onCancel={() => setConfirmClear(false)}
        onConfirm={async () => {
          setConfirmClear(false);
          try {
            await call("generator_history_clear");
            setShown({});
            load();
            toast("Generator history cleared.");
          } catch (e) {
            error(e);
          }
        }}
      />
    </div>
  );
}
