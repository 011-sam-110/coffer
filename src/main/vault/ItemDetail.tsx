// Item detail: a ledger of labelled fields with copy and reveal, websites,
// notes, tags, password history and dates. Secrets stay masked until Reveal.
import {
  Archive,
  ArchiveRestore,
  Check,
  Copy,
  Ellipsis,
  ExternalLink,
  Eye,
  EyeOff,
  History,
  KeyRound,
  Pencil,
  Star,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Markdown } from "../../components/Markdown";
import { Monogram, PasswordChars, SecretText, TotpCode } from "../../components/bits";
import { ConfirmDialog, Menu, useCopy, useReprompt, useToast } from "../../components/overlays";
import { Button, cx, IconButton, KeyBadge, Notice, Spinner } from "../../components/ui";
import type { Field, ItemView, PasswordHistoryEntry } from "../../lib/contract";
import { formatDate, formatDateTime, groupCard, relativeTime } from "../../lib/format";
import { call, isCofferError } from "../../lib/ipc";
import { isSecretKind } from "../../lib/itemForm";
import { ITEM_TYPES } from "../../lib/itemTypes";
import { fieldHasValue, SHORTCUT_WORDS } from "../../lib/quickKeys";
import { useStore } from "../store";
import { useKeyHandlers, type Nav } from "./nav";

function displayValue(f: Field): ReactNode {
  switch (f.kind) {
    case "date":
      return formatDate(`${f.value}T00:00:00Z`) || f.value;
    case "monthYear": {
      const m = /^(\d{4})-(\d{2})$/.exec(f.value);
      return m ? `${m[2]}/${m[1]}` : f.value;
    }
    case "boolean":
      return f.value === "true" ? "Yes" : "No";
    case "multiline":
      return <span className={cx("whitespace-pre-wrap", f.builtin === "publicKey" && "font-mono text-xs break-all")}>{f.value}</span>;
    default:
      return f.value;
  }
}

const COPY_KEYS: Record<string, string> = { username: "Ctrl+U", password: "Ctrl+P", totp: "Ctrl+T" };

function FieldRow({
  item,
  field,
  revealed,
  onToggleReveal,
  revealKey,
}: {
  item: ItemView;
  field: Field;
  revealed: string | null;
  onToggleReveal: () => void;
  /** This field's eye answers Ctrl+R (the first secret of the item). */
  revealKey?: boolean;
}) {
  const copy = useCopy();
  const secret = isSecretKind(field.kind);
  const shown = revealed !== null;
  let value: ReactNode;
  if (field.kind === "totp") value = <TotpCode itemId={item.id} fieldId={field.id} />;
  else if (secret)
    value = shown ? (
      field.kind === "cardNumber" ? (
        <PasswordChars value={groupCard(revealed)} />
      ) : field.kind === "concealedMultiline" ? (
        <pre className="max-h-48 overflow-auto font-mono text-xs whitespace-pre-wrap" data-selectable>
          {revealed}
        </pre>
      ) : (
        <PasswordChars value={revealed} />
      )
    ) : (
      <SecretText value={null} revealed={false} />
    );
  else value = <span data-selectable>{displayValue(field)}</span>;

  return (
    <div className="group grid min-h-10 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-0.5 px-4 py-2.5 @min-[440px]:grid-cols-[160px_minmax(0,1fr)_auto]">
      <span className="col-span-2 pt-px text-xs text-muted-foreground @min-[440px]:col-span-1">{field.label}</span>
      <div className="min-w-0 text-sm break-words">{value}</div>
      <div className="flex items-center gap-0.5">
        {secret && field.kind !== "totp" && (
          <IconButton
            size="sm"
            label={shown ? `Hide ${field.label.toLowerCase()}` : `Reveal ${field.label.toLowerCase()}`}
            shortcut={revealKey ? "Ctrl+R" : undefined}
            onClick={onToggleReveal}
          >
            {shown ? <EyeOff /> : <Eye />}
          </IconButton>
        )}
        <CopyButton label={`Copy ${field.label.toLowerCase()}`} shortcut={field.builtin ? COPY_KEYS[field.builtin] : undefined} onCopy={() => copy(item.id, field.id, field.kind === "totp")} />
      </div>
    </div>
  );
}

/** A copy icon that turns into a check for 1.5 s after a copy, so the click confirms where it happened. */
function CopyButton({ label, onCopy, shortcut }: { label: string; onCopy: () => Promise<boolean>; shortcut?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = window.setTimeout(() => setDone(false), 1500);
    return () => window.clearTimeout(t);
  }, [done]);
  return (
    <IconButton size="sm" label={label} shortcut={shortcut} active={done} onClick={() => onCopy().then((ok) => ok && setDone(true))}>
      {done ? <Check /> : <Copy />}
    </IconButton>
  );
}

function Group({ title, children, action }: { title?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      {(title || action) && (
        <div className="flex items-center justify-between px-1">
          {title && <h2 className="text-xs font-medium text-muted-foreground">{title}</h2>}
          {action}
        </div>
      )}
      <div className="divide-y divide-border rounded-sm border border-border bg-card">{children}</div>
    </section>
  );
}

/** A row of the last card: label 160 px | value, the same columns as the fields. */
function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-h-10 grid-cols-1 items-center gap-x-3 gap-y-0.5 px-4 py-2 @min-[440px]:grid-cols-[160px_minmax(0,1fr)]">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="min-w-0 text-sm">{children}</div>
    </div>
  );
}

const FLAG_TEXT: Array<[keyof ItemView["flags"], string]> = [
  ["breached", "This password was found in a data breach."],
  ["reused", "This password is used in other items too."],
  ["weak", "This password is easy to guess."],
  ["unsecured", "A website address of this item uses http://, not https://."],
  ["expiring", "This item expires soon."],
];

export function ItemDetail({ itemId, go }: { itemId: string; go: (patch: Partial<Nav>) => void }) {
  const { changeTick } = useStore();
  const [item, setItem] = useState<ItemView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [history, setHistory] = useState<PasswordHistoryEntry[] | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyShown, setHistoryShown] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { toast, error } = useToast();
  const { withReprompt } = useReprompt();
  const copy = useCopy();

  useEffect(() => {
    setRevealed({});
    setHistory(null);
    setHistoryOpen(false);
    setHistoryShown({});
  }, [itemId]);

  useEffect(() => {
    let alive = true;
    call("item_get", { id: itemId })
      .then((v) => {
        if (!alive) return;
        setItem(v);
        setLoadError(null);
      })
      .catch((e) => alive && setLoadError(isCofferError(e) ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [itemId, changeTick]);

  const reveal = useCallback(
    async (f: Field) => {
      if (revealed[f.id] !== undefined) {
        setRevealed((r) => {
          const n = { ...r };
          delete n[f.id];
          return n;
        });
        return;
      }
      try {
        const v = await withReprompt((password) => call("item_reveal", { id: itemId, field: f.id, password }));
        setRevealed((r) => ({ ...r, [f.id]: v }));
      } catch (e) {
        if (!(isCofferError(e) && e.message === "Cancelled.")) error(e);
      }
    },
    [itemId, revealed, withReprompt, error],
  );

  const copyShortcut = async (role: "username" | "password" | "totp") => {
    if (!item) return;
    const has = item.fields.some((f) => f.builtin === role && fieldHasValue(f));
    if (!has) return toast(`This item has no ${SHORTCUT_WORDS[role]}.`);
    await copy(item.id, role, role === "totp");
  };

  const setState = async (state: "active" | "archived" | "trashed") => {
    if (!item) return;
    const before = item.state;
    try {
      await call("item_set_state", { id: item.id, state });
      const words = state === "trashed" ? "Moved to Trash." : state === "archived" ? "Archived." : "Restored.";
      toast(`${item.title}: ${words}`, {
        action: state !== "active" ? { label: "Undo", run: () => call("item_set_state", { id: item.id, state: before }).catch(error) } : undefined,
        ms: 6000,
      });
      if (state !== "active") go({ itemId: null });
    } catch (e) {
      error(e);
    }
  };

  useKeyHandlers("detail", {
    edit: () => item && item.state !== "trashed" && go({ editing: "edit" }),
    copyUsername: () => copyShortcut("username"),
    copyPassword: () => copyShortcut("password"),
    copyTotp: () => copyShortcut("totp"),
    reveal: () => {
      const f = item?.fields.find((x) => isSecretKind(x.kind) && x.kind !== "totp" && fieldHasValue(x));
      if (f) reveal(f);
    },
    delete: () => item && item.state !== "trashed" && setState("trashed"),
  });

  if (loadError)
    return (
      <div className="p-8">
        <Notice tone="danger" icon={<TriangleAlert />}>
          {loadError}
        </Notice>
      </div>
    );
  if (!item)
    return (
      <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
        <Spinner /> Opening...
      </div>
    );

  const def = ITEM_TYPES[item.type];
  const withValue = item.fields.filter(fieldHasValue);
  const roles = new Set(def.fields.map((f) => f.role));
  const builtins = def.fields.map((d) => withValue.find((f) => f.builtin === d.role)).filter((f): f is Field => !!f);
  const custom = withValue.filter((f) => !f.builtin || !roles.has(f.builtin));
  const sections = new Map<string, Field[]>();
  for (const f of custom) {
    const k = f.section?.trim() || "";
    sections.set(k, [...(sections.get(k) ?? []), f]);
  }
  const flags = FLAG_TEXT.filter(([k]) => item.flags[k]);
  // Ctrl+R reveals the first secret (see the key handlers above); its eye says so.
  const revealKeyId = withValue.find((x) => isSecretKind(x.kind) && x.kind !== "totp")?.id;
  const hasPassword = item.fields.some((f) => f.builtin === "password");

  const loadHistory = async () => {
    setHistoryOpen((o) => !o);
    if (history) return;
    try {
      setHistory(await withReprompt((password) => call("item_password_history", { id: item.id, password })));
    } catch (e) {
      setHistoryOpen(false);
      if (!(isCofferError(e) && e.message === "Cancelled.")) error(e);
    }
  };

  const menuItems =
    item.state === "trashed"
      ? [
          { label: "Restore", icon: <ArchiveRestore />, onSelect: () => setState("active") },
          { label: "Delete for good", icon: <Trash2 />, danger: true, onSelect: () => setConfirmDelete(true) },
        ]
      : item.state === "archived"
        ? [
            { label: "Restore to items", icon: <ArchiveRestore />, onSelect: () => setState("active") },
            { label: "Move to Trash", icon: <Trash2 />, shortcut: "Delete", danger: true, onSelect: () => setState("trashed") },
          ]
        : [
            { label: "Archive", icon: <Archive />, onSelect: () => setState("archived") },
            { label: "Move to Trash", icon: <Trash2 />, shortcut: "Delete", danger: true, onSelect: () => setState("trashed") },
          ];

  return (
    <article aria-label={item.title} className="@container flex h-full flex-col">
      <header className="flex shrink-0 items-start gap-3 px-6 pt-5 pb-4">
        <Monogram title={item.title} size={40} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold" data-selectable>
            {item.title}
          </h1>
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            <span>{def.label}</span>
            {item.reprompt && (
              <span className="inline-flex items-center gap-1" title="Showing or copying a secret asks for the master password">
                <KeyRound aria-hidden className="size-3" /> Asks for master password
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {item.state === "active" && (
            <IconButton
              label={item.favorite ? "Remove from favourites" : "Add to favourites"}
              aria-pressed={item.favorite}
              onClick={async () => {
                try {
                  await call("item_patch", { id: item.id, favorite: !item.favorite });
                  setItem({ ...item, favorite: !item.favorite });
                } catch (e) {
                  error(e);
                }
              }}
            >
              <Star className={cx(item.favorite && "fill-gold text-gold")} />
            </IconButton>
          )}
          {item.state !== "trashed" && (
            <Button size="sm" icon={<Pencil className="size-3.5" />} onClick={() => go({ editing: "edit" })} title="Edit (Ctrl+E)" aria-keyshortcuts="Control+E">
              Edit
              <KeyBadge>Ctrl+E</KeyBadge>
            </Button>
          )}
          <Menu
            label="More actions"
            items={menuItems}
            trigger={(p) => (
              <IconButton label="More actions" {...p}>
                <Ellipsis />
              </IconButton>
            )}
          />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-16">
        <div className="flex max-w-[680px] flex-col gap-5">
          {item.state === "trashed" && (
            <Notice
              icon={<Trash2 />}
              actions={
                <Button size="sm" onClick={() => setState("active")}>
                  Restore
                </Button>
              }
            >
              In Trash since {formatDate(item.trashedAt)}. Coffer deletes it for good 30 days after that.
            </Notice>
          )}
          {item.state === "archived" && (
            <Notice
              icon={<Archive />}
              actions={
                <Button size="sm" onClick={() => setState("active")}>
                  Restore
                </Button>
              }
            >
              Archived. It stays out of lists, Quick Access and health checks.
            </Notice>
          )}
          {flags.length > 0 && item.state === "active" && (
            <Notice
              tone="warning"
              icon={<TriangleAlert />}
              actions={
                hasPassword ? (
                  <Button size="sm" onClick={() => go({ editing: "edit", withGenerator: true })}>
                    Change password
                  </Button>
                ) : undefined
              }
            >
              {flags.map(([k, t]) => (
                <p key={k}>{t}</p>
              ))}
            </Notice>
          )}

          {builtins.length > 0 && (
            <Group>
              {builtins.map((f) => (
                <FieldRow key={f.id} item={item} field={f} revealed={revealed[f.id] ?? null} onToggleReveal={() => reveal(f)} revealKey={f.id === revealKeyId} />
              ))}
            </Group>
          )}

          {[...sections.entries()].map(([name, fields]) => (
            <Group key={name || "_"} title={fields.length > 1 ? name || (builtins.length ? "More fields" : undefined) : undefined}>
              {fields.map((f) => (
                <FieldRow key={f.id} item={item} field={f} revealed={revealed[f.id] ?? null} onToggleReveal={() => reveal(f)} revealKey={f.id === revealKeyId} />
              ))}
            </Group>
          ))}

          {item.urls.length > 0 && (
            <Group title={item.urls.length > 1 ? "Websites" : undefined}>
              {item.urls.map((u, i) => (
                <div key={i} className="grid min-h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-4 py-2 @min-[440px]:grid-cols-[160px_minmax(0,1fr)_auto]">
                  <span className="col-span-2 text-xs text-muted-foreground @min-[440px]:col-span-1">{u.label || "Website"}</span>
                  <span className="min-w-0 truncate text-sm" data-selectable title={u.url}>
                    {u.url}
                  </span>
                  <div className="flex items-center gap-0.5">
                    <IconButton
                      size="sm"
                      label="Open site"
                      onClick={() => call("item_open_url", { id: item.id, urlIndex: i }).catch(error)}
                    >
                      <ExternalLink />
                    </IconButton>
                    <CopyButton
                      label="Copy address"
                      onCopy={() =>
                        navigator.clipboard
                          .writeText(u.url)
                          .then(() => {
                            toast("Address copied.");
                            return true;
                          })
                          .catch(() => {
                            toast("Coffer could not copy the address.");
                            return false;
                          })
                      }
                    />
                  </div>
                </div>
              ))}
            </Group>
          )}

          {item.notes.trim() && (
            <Group>
              <div className="grid grid-cols-1 items-start gap-x-3 gap-y-0.5 px-4 py-3 @min-[440px]:grid-cols-[160px_1fr]">
                <span className="pt-px text-xs text-muted-foreground">Notes</span>
                <div className="min-w-0">
                  <Markdown text={item.notes} />
                </div>
              </div>
            </Group>
          )}

          {/* The last card: tags, old passwords and dates, on the same columns as the fields. */}
          <Group>
          {item.tags.length > 0 && (
            <MetaRow label="Tags">
              <div className="flex flex-wrap gap-1.5">
                {item.tags.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => go({ filter: { kind: "tag", tag: t }, itemId: item.id })}
                    className="inline-flex h-6 cursor-pointer items-center rounded-sm bg-secondary px-2 text-xs hover:bg-secondary-hover"
                  >
                    {t}
                  </button>
                ))}
              </div>
            </MetaRow>
          )}

          {item.passwordHistoryCount > 0 && (
            <>
              <MetaRow label="Password history">
                <button
                  type="button"
                  aria-expanded={historyOpen}
                  onClick={loadHistory}
                  className="-ml-1 inline-flex w-fit cursor-pointer items-center gap-1.5 rounded-sm px-1 text-sm hover:bg-muted"
                >
                  <History aria-hidden className="size-3.5 text-muted-foreground" />
                  {historyOpen ? "Hide" : "Show"} {item.passwordHistoryCount} old {item.passwordHistoryCount === 1 ? "password" : "passwords"}
                </button>
              </MetaRow>
              {historyOpen && (
                <>
                  {!history ? (
                    <div className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
                      <Spinner /> Loading...
                    </div>
                  ) : (
                    history.map((h) => {
                      const v = historyShown[h.id];
                      return (
                        <div key={h.id} className="grid min-h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-4 py-2 @min-[440px]:grid-cols-[160px_minmax(0,1fr)_auto]">
                          <span className="col-span-2 text-xs text-muted-foreground @min-[440px]:col-span-1">Until {formatDate(h.changedAt)}</span>
                          <span className="min-w-0 text-sm">
                            {v !== undefined ? <PasswordChars value={v} /> : <span className="text-muted-foreground">{h.length} characters, hidden</span>}
                          </span>
                          <div className="flex items-center gap-0.5">
                            <IconButton
                              size="sm"
                              label={v !== undefined ? "Hide old password" : "Reveal old password"}
                              onClick={async () => {
                                if (v !== undefined) {
                                  setHistoryShown((s) => {
                                    const n = { ...s };
                                    delete n[h.id];
                                    return n;
                                  });
                                  return;
                                }
                                try {
                                  const val = await withReprompt((password) => call("item_reveal", { id: item.id, field: `history:${h.id}`, password }));
                                  setHistoryShown((s) => ({ ...s, [h.id]: val }));
                                } catch (e) {
                                  if (!(isCofferError(e) && e.message === "Cancelled.")) error(e);
                                }
                              }}
                            >
                              {v !== undefined ? <EyeOff /> : <Eye />}
                            </IconButton>
                            <CopyButton label="Copy old password" onCopy={() => copy(item.id, `history:${h.id}`)} />
                          </div>
                        </div>
                      );
                    })
                  )}
                </>
              )}
            </>
          )}

          <MetaRow label="Created">
            <span title={formatDateTime(item.createdAt)}>{formatDate(item.createdAt)}</span>
          </MetaRow>
          <MetaRow label="Last changed">
            <span title={formatDateTime(item.updatedAt)}>{relativeTime(item.updatedAt)}</span>
          </MetaRow>
          {item.passwordChangedAt && (
            <MetaRow label="Password changed">
              <span title={formatDateTime(item.passwordChangedAt)}>{formatDate(item.passwordChangedAt)}</span>
            </MetaRow>
          )}
          </Group>
        </div>
      </div>
      <ConfirmDialog
        open={confirmDelete}
        title={`Delete ${item.title} for good?`}
        body="It leaves the vault now. Backups made before now still hold it."
        confirmLabel="Delete for good"
        danger
        onCancel={() => setConfirmDelete(false)}
        onConfirm={async () => {
          setConfirmDelete(false);
          try {
            await call("item_delete_forever", { id: item.id });
            go({ itemId: null });
            toast(`${item.title} deleted for good.`);
          } catch (e) {
            error(e);
          }
        }}
      />
    </article>
  );
}
