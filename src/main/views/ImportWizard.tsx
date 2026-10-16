// Import wizard (SPEC 8): pick (a Rust dialog), password if the file needs it,
// preview, import in one write, then Undo and "Delete it / Keep it".
import { FileCheck2, FileUp, TriangleAlert, Undo2 } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useToast } from "../../components/overlays";
import { Button, FormRow, Input, Notice, PasswordInput, Spinner } from "../../components/ui";
import type { ImportPreview, ImportResult, ItemType } from "../../lib/contract";
import { call, isCofferError } from "../../lib/ipc";
import { ITEM_TYPES } from "../../lib/itemTypes";
import { secretKeyCharMessage } from "../../lib/secretKey";

const SOURCES = [
  "1Password: .1pux or CSV",
  "Bitwarden: JSON or CSV (not encrypted)",
  "Dashlane: CSV ZIP or one CSV",
  "Chrome, Edge, Brave: CSV",
  "Firefox: CSV",
  "Coffer: .cofferx, Coffer JSON or a .coffer vault",
];

const ENCRYPTED_FORMATS = ["coffer-export", "coffer-vault", "cofferx"];

type Stage = "intro" | "loading" | "password" | "preview" | "importing" | "result";

export function ImportWizard({ source, onClose, embedded }: { source: "pick" | "conflict"; onClose: () => void; embedded?: boolean }) {
  const [stage, setStage] = useState<Stage>(source === "conflict" ? "loading" : "intro");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [pw, setPw] = useState("");
  const [sk, setSk] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [undone, setUndone] = useState<number | null>(null);
  const [sourceFile, setSourceFile] = useState<"ask" | "deleted" | "kept">("ask");
  const { error, toast } = useToast();
  const ids = { pw: useId(), sk: useId() };

  const run = async (src: "pick" | "last" | "conflict", password: string | null = null, secretKey: string | null = null) => {
    setErr(null);
    setStage("loading");
    try {
      const p = await call("import_preview", { source: src, password, secretKey });
      if (!p) return setStage(preview ? "preview" : "intro");
      setPreview(p);
      setStage(p.needsPassword || p.needsSecretKey ? "password" : "preview");
    } catch (e) {
      if (isCofferError(e) && (e.code === "badCredentials" || e.code === "badSecretKey") && src === "last") {
        setErr(e.message);
        setStage("password");
      } else {
        setStage("intro");
        error(e);
      }
    }
  };

  useEffect(() => {
    if (source === "conflict") run("conflict");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  const commit = async () => {
    if (!preview) return;
    setStage("importing");
    try {
      setResult(await call("import_commit", { previewId: preview.previewId }));
      setStage("result");
    } catch (e) {
      setStage("preview");
      error(e);
    }
  };

  const wrap = (children: React.ReactNode) =>
    embedded ? (
      <div className="flex flex-col gap-5">{children}</div>
    ) : (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto flex max-w-[640px] flex-col gap-5 px-8 pt-6 pb-16">
          <h1 className="text-lg font-semibold">Import</h1>
          {children}
        </div>
      </div>
    );

  if (stage === "intro")
    return wrap(
      <>
        <p className="text-sm text-muted-foreground">Coffer reads the export file, shows what it found, and adds everything in one step that you can undo.</p>
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">Coffer reads these exports</p>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm marker:text-muted-foreground">
            {SOURCES.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-muted-foreground">Encrypted Bitwarden JSON: export from Bitwarden as JSON (not encrypted), import it, then delete that file.</p>
        <div className="flex gap-2">
          <Button variant="primary" icon={<FileUp className="size-4" />} onClick={() => run("pick")}>
            Choose file
          </Button>
          {!embedded && (
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          )}
        </div>
      </>,
    );

  if (stage === "loading" || stage === "importing")
    return wrap(
      <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
        <Spinner /> {stage === "loading" ? "Reading the file..." : "Importing..."}
      </div>,
    );

  if (stage === "password" && preview) {
    const skMsg = preview.needsSecretKey ? secretKeyCharMessage(sk) : null;
    return wrap(
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (pw && !skMsg) run("last", pw, preview.needsSecretKey ? sk : null);
        }}
      >
        <p className="text-sm">
          {preview.formatLabel} is encrypted. Type {preview.needsSecretKey ? "its password and its Secret Key" : "its password"} to read it.
        </p>
        <FormRow label={preview.format === "coffer-vault" ? "Master password of that vault" : "Export password"} htmlFor={ids.pw} error={err}>
          <PasswordInput id={ids.pw} autoFocus value={pw} onChange={(e) => setPw(e.target.value)} invalid={!!err} />
        </FormRow>
        {preview.needsSecretKey && (
          <FormRow label="Secret Key of that vault" htmlFor={ids.sk} error={skMsg} hint="It is on that vault's Emergency Kit.">
            <Input id={ids.sk} mono value={sk} onChange={(e) => setSk(e.target.value.toUpperCase())} invalid={!!skMsg} placeholder="C1-XXXXXX-XXXXXX-XXXXXX-XXXXX-XXXXX-XXXXX" />
          </FormRow>
        )}
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={!pw || (preview.needsSecretKey && (!sk || !!skMsg))}>
            Read file
          </Button>
          <Button variant="ghost" onClick={() => setStage("intro")}>
            Back
          </Button>
        </div>
      </form>,
    );
  }

  if (stage === "preview" && preview) {
    const types = (Object.entries(preview.counts) as Array<[ItemType, number]>).filter(([, n]) => n > 0);
    const toImport = Math.max(0, preview.total - preview.duplicates - preview.skipped.length);
    return wrap(
      <>
        <div className="flex items-start gap-3">
          <FileCheck2 aria-hidden className="mt-0.5 size-5 text-chart-2" />
          <div>
            <p className="text-sm font-medium">{preview.formatLabel}</p>
            <p className="text-xs text-muted-foreground">
              {preview.total} items in the file. {toImport} will be added with an Imported tag, so you can find or undo them.
            </p>
          </div>
        </div>
        <table className="w-full text-sm">
          <caption className="sr-only">Items by type</caption>
          <tbody className="divide-y divide-border">
            {types.map(([t, n]) => (
              <tr key={t}>
                <th scope="row" className="py-1.5 text-left font-normal">
                  {ITEM_TYPES[t]?.plural ?? t}
                </th>
                <td className="py-1.5 text-right tabular-nums">{n}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {preview.duplicates > 0 && (
          <p className="text-sm text-muted-foreground">
            {preview.duplicates} item{preview.duplicates === 1 ? " is" : "s are"} already in your vault (same type, title, username, password and site). Coffer skips {preview.duplicates === 1 ? "it" : "them"}.
          </p>
        )}
        {preview.skipped.length > 0 && (
          <section className="flex flex-col gap-1.5">
            <h2 className="text-xs font-medium text-muted-foreground">Skipped</h2>
            <ul className="divide-y divide-border rounded-sm border border-border bg-card text-sm">
              {preview.skipped.map((s, i) => (
                <li key={i} className="flex justify-between gap-4 px-4 py-2">
                  <span className="truncate">{s.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{s.reason}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {preview.warnings.map((w, i) => (
          <Notice key={i} tone="warning" icon={<TriangleAlert />}>
            {w}
          </Notice>
        ))}
        <div className="flex gap-2">
          <Button variant="primary" onClick={commit} disabled={toImport === 0}>
            Import {toImport} item{toImport === 1 ? "" : "s"}
          </Button>
          <Button variant="ghost" onClick={source === "conflict" ? onClose : () => setStage("intro")}>
            Cancel
          </Button>
        </div>
      </>,
    );
  }

  if (stage === "result" && result && preview) {
    const plain = !ENCRYPTED_FORMATS.some((f) => preview.format.startsWith(f)) && source !== "conflict";
    return wrap(
      <>
        <Notice icon={<FileCheck2 />} role="status">
          {undone !== null
            ? `${undone} imported item${undone === 1 ? "" : "s"} moved to Trash.`
            : `Imported ${result.imported} item${result.imported === 1 ? "" : "s"}${result.skipped ? `, skipped ${result.skipped}` : ""}. They carry the tag ${result.tag}.`}
        </Notice>
        {undone === null && (
          <div>
            <Button
              icon={<Undo2 className="size-4" />}
              onClick={async () => {
                try {
                  setUndone(await call("import_undo", { batchId: result.batchId }));
                } catch (e) {
                  error(e);
                }
              }}
            >
              Undo this import
            </Button>
          </div>
        )}
        {plain && sourceFile === "ask" && (
          <Notice
            tone="warning"
            icon={<TriangleAlert />}
            actions={
              <>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={async () => {
                    try {
                      await call("import_delete_source", { previewId: preview.previewId });
                      setSourceFile("deleted");
                      toast("Import file deleted.");
                    } catch (e) {
                      error(e);
                    }
                  }}
                >
                  Delete it
                </Button>
                <Button size="sm" onClick={() => setSourceFile("kept")}>
                  Keep it
                </Button>
              </>
            }
          >
            This file holds your passwords in plain text.
          </Notice>
        )}
        {sourceFile === "deleted" && <p className="text-sm text-muted-foreground">The export file is deleted.</p>}
        <div>
          <Button variant={plain && sourceFile === "ask" ? "secondary" : "primary"} onClick={onClose}>
            Done
          </Button>
        </div>
      </>,
    );
  }
  return null;
}
