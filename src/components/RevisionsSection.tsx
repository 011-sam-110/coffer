// Item revisions (tier 2): earlier saved versions of an item, newest first,
// each with Restore behind a confirm step. Rows of the item's last card, under
// Password history.
import { FileClock, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import type { ItemView, Revision } from "../lib/contract";
import { formatDateTime, relativeTime } from "../lib/format";
import { call, isCofferError } from "../lib/ipc";
import { ConfirmDialog, useReprompt, useToast } from "./overlays";
import { Button, Spinner } from "./ui";

/** What the contract tells about a revision: its date and its title then. */
export function revisionSummary(r: Revision, currentTitle: string): string {
  return r.title === currentTitle ? `Version ${r.rev}` : `Version ${r.rev}, titled "${r.title}"`;
}

export function RevisionsSection({ item, onRestored }: { item: ItemView; onRestored: (v: ItemView) => void }) {
  const [list, setList] = useState<Revision[] | null>(null);
  /** null: not known yet (a re-prompt item tells its count after the master password). */
  const [count, setCount] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<Revision | null>(null);
  const [busy, setBusy] = useState(false);
  const { withReprompt } = useReprompt();
  const { toast, error } = useToast();

  // The count for the heading. A re-prompt item answers repromptRequired: its count waits for a click.
  useEffect(() => {
    let alive = true;
    call("item_revisions", { id: item.id, password: null })
      .then((r) => {
        if (!alive) return;
        setList([...r].sort((a, b) => b.rev - a.rev));
        setCount(r.length);
      })
      .catch(() => alive && setCount(null));
    return () => {
      alive = false;
    };
  }, [item.id, item.rev]);

  const toggle = async () => {
    if (open || list) return setOpen((o) => !o);
    setOpen(true);
    try {
      const r = await withReprompt((password) => call("item_revisions", { id: item.id, password }), `${item.title} asks for your master password.`);
      setList([...r].sort((a, b) => b.rev - a.rev));
      setCount(r.length);
    } catch (e) {
      setOpen(false);
      if (!(isCofferError(e) && e.message === "Cancelled.")) error(e);
    }
  };

  const restore = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      const v = await withReprompt(
        (password) => call("item_restore_revision", { id: item.id, rev: confirm.rev, password }),
        "Restoring this version turns off the master password question, or changes a secret field. Enter your master password to go on.",
      );
      toast(`Restored the version from ${formatDateTime(confirm.savedAt)}.`);
      setConfirm(null);
      onRestored(v);
    } catch (e) {
      if (!(isCofferError(e) && e.message === "Cancelled.")) error(e);
    } finally {
      setBusy(false);
    }
  };

  if (count === 0 || item.state === "trashed") return null;

  // Rows of the item's last card (tags, old passwords, dates): label 160 px | value, like the fields.
  return (
    <>
      <div className="grid min-h-10 grid-cols-1 items-center gap-x-3 gap-y-0.5 px-4 py-2 @min-[440px]:grid-cols-[160px_minmax(0,1fr)]">
        <span className="text-xs text-muted-foreground">Revisions</span>
        <div className="min-w-0 text-sm">
          <button
            type="button"
            aria-expanded={open}
            onClick={toggle}
            className="-ml-1 inline-flex w-fit cursor-pointer items-center gap-1.5 rounded-sm px-1 text-sm hover:bg-muted"
          >
            <FileClock aria-hidden className="size-3.5 text-muted-foreground" />
            {open ? "Hide" : "Show"} {count === null ? "revisions" : `${count} ${count === 1 ? "revision" : "revisions"}`}
          </button>
        </div>
      </div>
      {open &&
        (!list ? (
          <div className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
            <Spinner /> Loading...
          </div>
        ) : (
          list.map((r) => (
            <div key={r.rev} className="grid min-h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-4 py-2 @min-[440px]:grid-cols-[160px_minmax(0,1fr)_auto]">
              <span className="text-xs text-muted-foreground tabular-nums" title={relativeTime(r.savedAt)}>
                {formatDateTime(r.savedAt)}
              </span>
              <span className="col-start-1 row-start-2 min-w-0 truncate text-sm @min-[440px]:col-start-2 @min-[440px]:row-start-1" title={r.title}>
                {revisionSummary(r, item.title)}
              </span>
              <Button size="sm" className="row-span-2 @min-[440px]:row-span-1" icon={<RotateCcw className="size-3.5" />} onClick={() => setConfirm(r)}>
                Restore
              </Button>
            </div>
          ))
        ))}
      <ConfirmDialog
        open={!!confirm}
        title="Restore this version?"
        body={
          confirm
            ? `Coffer puts back the fields, notes and websites of ${item.title} as they were on ${formatDateTime(confirm.savedAt)}. The current version stays in Revisions.`
            : undefined
        }
        confirmLabel={busy ? "Restoring..." : "Restore"}
        onCancel={() => setConfirm(null)}
        onConfirm={restore}
      />
    </>
  );
}
