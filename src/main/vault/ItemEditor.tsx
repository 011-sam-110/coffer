// The ONE item form for all 11 types, driven by the contract's field tables.
// Secret fields stay null (unchanged) until the user shows, types or generates.
import { CalendarDays, Eye, EyeOff, LoaderCircle, Plus, WandSparkles, X } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Generator } from "../../components/Generator";
import { Monogram } from "../../components/bits";
import { ConfirmDialog, Menu, useReprompt, useToast } from "../../components/overlays";
import { Button, Checkbox, cx, IconButton, Input, KeyBadge, Notice, Select, Spinner, Textarea } from "../../components/ui";
import type { FieldKind, ItemType, ItemView } from "../../lib/contract";
import { call, isCofferError } from "../../lib/ipc";
import {
  formFromView,
  formsEqual,
  formToInput,
  isSecretKind,
  newItemForm,
  newKey,
  validateForm,
  type FormErrors,
  type FormField,
  type ItemForm,
} from "../../lib/itemForm";
import { FIELD_KIND_LABELS, ITEM_TYPES } from "../../lib/itemTypes";
import { useStore } from "../store";
import { editInfo, useKeyHandlers } from "./nav";

const ADDABLE: FieldKind[] = ["text", "concealed", "email", "url", "phone", "date", "monthYear", "multiline", "totp", "pin", "boolean"];

/** The generator wand of a password field: open state and toggle. */
type GenToggle = { open: boolean; toggle: () => void };

function SecretInput({
  field,
  itemId,
  onChange,
  invalid,
  id,
  gen,
}: {
  field: FormField;
  itemId?: string;
  onChange: (v: string | null) => void;
  invalid?: boolean;
  id: string;
  gen?: GenToggle;
}) {
  const { withReprompt } = useReprompt();
  const { error } = useToast();
  const [busy, setBusy] = useState(false);
  const [visible, setVisible] = useState(false);
  const unchanged = field.value === null;
  const multiline = field.kind === "concealedMultiline";

  const showStored = async () => {
    if (!itemId || !field.id) return;
    setBusy(true);
    try {
      const v = await withReprompt((password) => call("item_reveal", { id: itemId, field: field.id!, password }));
      onChange(v);
      setVisible(true);
    } catch (e) {
      if (!(isCofferError(e) && e.message === "Cancelled.")) error(e);
    } finally {
      setBusy(false);
    }
  };

  if (multiline)
    return unchanged && field.hasStored ? (
      <div className="flex items-center gap-2">
        <span className="flex-1 text-sm text-muted-foreground">Hidden. It stays as it is unless you change it.</span>
        <Button size="sm" loading={busy} icon={<Eye className="size-3.5" />} onClick={showStored}>
          Show to edit
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onChange("")}>
          Replace
        </Button>
      </div>
    ) : (
      <Textarea id={id} mono rows={5} value={field.value ?? ""} invalid={invalid} onChange={(e) => onChange(e.target.value)} placeholder="Paste the key" />
    );

  const stored = unchanged && field.hasStored;
  return (
    <div className="control flex items-center gap-1 pr-1" aria-invalid={invalid || undefined}>
      <input
        id={id}
        type={visible ? "text" : "password"}
        autoComplete="off"
        spellCheck={false}
        value={field.value ?? ""}
        placeholder={stored ? "Saved. Type to replace." : ""}
        aria-invalid={invalid || undefined}
        onChange={(e) => onChange(e.target.value === "" && field.hasStored ? null : e.target.value)}
        className="h-[1.875rem] min-w-0 flex-1 bg-transparent font-mono text-sm outline-none"
      />
      {gen && (
        <IconButton size="sm" label="Generate a password" active={gen.open} aria-expanded={gen.open} onClick={gen.toggle}>
          <WandSparkles />
        </IconButton>
      )}
      {/* The eye sits inside the field. On a saved value it fetches the value to edit it. */}
      <IconButton
        size="sm"
        label={stored ? "Show the saved value" : visible ? "Hide" : "Show"}
        aria-pressed={stored ? undefined : visible}
        disabled={busy}
        onClick={stored ? showStored : () => setVisible((v) => !v)}
      >
        {busy ? <LoaderCircle className="animate-spin" /> : visible && !stored ? <EyeOff /> : <Eye />}
      </IconButton>
    </div>
  );
}

/** A date or month: our field and calendar button; the browser's own picker icon is hidden (theme.css). */
function DateInput({ id, value, invalid, onChange, type }: { id: string; value: string; invalid?: boolean; onChange: (v: string) => void; type: "date" | "month" }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="control flex w-48 max-w-full items-center gap-1 pr-1" aria-invalid={invalid || undefined}>
      <input
        ref={ref}
        id={id}
        type={type}
        value={value}
        aria-invalid={invalid || undefined}
        onChange={(e) => onChange(e.target.value)}
        className="date-input h-[1.875rem] min-w-0 flex-1 bg-transparent text-sm outline-none"
      />
      <IconButton
        size="sm"
        label={type === "date" ? "Choose a date" : "Choose a month"}
        onClick={() => {
          try {
            ref.current?.showPicker();
          } catch {
            ref.current?.focus();
          }
        }}
      >
        <CalendarDays />
      </IconButton>
    </div>
  );
}

function ValueInput({
  field,
  itemId,
  onChange,
  invalid,
  id,
  gen,
}: {
  field: FormField;
  itemId?: string;
  onChange: (v: string | null) => void;
  invalid?: boolean;
  id: string;
  gen?: GenToggle;
}) {
  if (isSecretKind(field.kind) && field.kind !== "totp") return <SecretInput id={id} field={field} itemId={itemId} onChange={onChange} invalid={invalid} gen={gen} />;
  if (field.kind === "totp") return <TotpInput id={id} field={field} itemId={itemId} onChange={onChange} invalid={invalid} />;
  const v = field.value ?? "";
  switch (field.kind) {
    case "multiline":
      return <Textarea id={id} rows={3} mono={field.builtin === "publicKey"} value={v} invalid={invalid} onChange={(e) => onChange(e.target.value)} />;
    case "date":
      return <DateInput id={id} type="date" value={v} invalid={invalid} onChange={onChange} />;
    case "monthYear":
      return <DateInput id={id} type="month" value={v} invalid={invalid} onChange={onChange} />;
    case "boolean":
      return <Checkbox label="Yes" checked={v === "true"} onChange={(c) => onChange(c ? "true" : "false")} />;
    case "menu":
      return (
        <Select id={id} value={v} onChange={(e) => onChange(e.target.value)} className="w-56 max-w-full">
          <option value="">Not set</option>
          {(field.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
      );
    default:
      return (
        <Input
          id={id}
          type="text"
          inputMode={field.kind === "email" ? "email" : field.kind === "phone" ? "tel" : field.kind === "url" ? "url" : undefined}
          value={v}
          invalid={invalid}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

function TotpInput({ field, itemId, onChange, invalid, id }: { field: FormField; itemId?: string; onChange: (v: string | null) => void; invalid?: boolean; id: string }) {
  const [info, setInfo] = useState<string | null>(null);
  const { withReprompt } = useReprompt();
  const { error } = useToast();
  useEffect(() => {
    const v = field.value?.trim();
    if (!v) return setInfo(null);
    const t = window.setTimeout(() => {
      call("totp_parse", { input: v })
        .then((r) => setInfo(r.valid ? `Makes codes for ${[r.issuer, r.account].filter(Boolean).join(", ") || "this item"}.` : null))
        .catch(() => setInfo(null));
    }, 250);
    return () => window.clearTimeout(t);
  }, [field.value]);
  return (
    <div className="flex flex-col gap-1">
      {/* Same shape as a secret field: the eye sits inside, so the hint keeps its room in a narrow pane. */}
      <div className="control flex items-center gap-1 pr-1" aria-invalid={invalid || undefined}>
        <input
          id={id}
          autoComplete="off"
          spellCheck={false}
          value={field.value ?? ""}
          placeholder={field.value === null && field.hasStored ? "Saved. Paste to replace." : "otpauth://... or the setup key"}
          aria-invalid={invalid || undefined}
          onChange={(e) => onChange(e.target.value === "" && field.hasStored ? null : e.target.value)}
          className="h-[1.875rem] min-w-0 flex-1 bg-transparent font-mono text-sm outline-none"
        />
        {field.value === null && field.hasStored && itemId && field.id && (
          <IconButton
            size="sm"
            label="Show the saved setup key"
            onClick={async () => {
              try {
                onChange(await withReprompt((password) => call("item_reveal", { id: itemId, field: field.id!, password })));
              } catch (e) {
                if (!(isCofferError(e) && e.message === "Cancelled.")) error(e);
              }
            }}
          >
            <Eye />
          </IconButton>
        )}
      </div>
      {info && <p className="text-xs text-muted-foreground">{info}</p>}
    </div>
  );
}

function TagEditor({ tags, onChange, suggestions }: { tags: string[]; onChange: (t: string[]) => void; suggestions: string[] }) {
  const [text, setText] = useState("");
  const listId = useId();
  const add = () => {
    const t = text.trim().replace(/^\/+|\/+$/g, "");
    if (t && !tags.includes(t)) onChange([...tags, t]);
    setText("");
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="control flex min-h-8 flex-wrap items-center gap-1.5 py-1">
        {tags.map((t) => (
          <span key={t} className="inline-flex h-6 items-center gap-1 rounded-sm bg-secondary pr-0.5 pl-2 text-xs">
            {t}
            <button
              type="button"
              aria-label={`Remove tag ${t}`}
              onClick={() => onChange(tags.filter((x) => x !== t))}
              className="inline-flex size-5 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          aria-label="Add a tag"
          list={listId}
          value={text}
          autoComplete="off"
          spellCheck={false}
          placeholder={tags.length ? "" : "Add a tag"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            } else if (e.key === "Backspace" && !text && tags.length) onChange(tags.slice(0, -1));
          }}
          onBlur={add}
          className="h-6 min-w-[120px] flex-1 bg-transparent text-sm outline-none"
        />
        <datalist id={listId}>
          {suggestions.filter((s) => !tags.includes(s)).map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </div>
      <p className="text-xs text-muted-foreground">Enter adds a tag. Use "/" to nest: Work/Clients.</p>
    </div>
  );
}

export function ItemEditor({
  mode,
  itemId,
  newType,
  newTitle,
  withGenerator,
  onDone,
}: {
  mode: "new" | "edit";
  itemId: string | null;
  newType: ItemType;
  newTitle?: string;
  withGenerator?: boolean;
  onDone: (savedId: string | null) => void;
}) {
  const { items } = useStore();
  const { toast, error } = useToast();
  const { withReprompt } = useReprompt();
  const [form, setForm] = useState<ItemForm | null>(mode === "new" ? newItemForm(newType, newTitle ?? "") : null);
  const [base, setBase] = useState<ItemForm | null>(form);
  const [view, setView] = useState<ItemView | null>(null);
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);
  const [askDiscard, setAskDiscard] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [genFor, setGenFor] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const uid = useId();

  useEffect(() => {
    if (mode !== "edit" || !itemId) return;
    call("item_get", { id: itemId })
      .then((v) => {
        const f = formFromView(v);
        setView(v);
        setForm(f);
        setBase(f);
        if (withGenerator) setGenFor(f.fields.find((x) => x.builtin === "password")?.key ?? null);
      })
      .catch(error);
  }, [mode, itemId, withGenerator, error]);

  useEffect(() => {
    if (form && mode === "new") titleRef.current?.focus();
  }, [form, mode]);

  const dirty = useMemo(() => !!form && !!base && !formsEqual(form, base), [form, base]);

  // Tell Rust about the open edit (SPEC 9: lock and quit during an edit).
  // The lock and quit notices name the item as saved; an unsaved new title is not its name yet.
  const title = (mode === "edit" ? base?.title.trim() : form?.title.trim()) || (mode === "new" ? `New ${ITEM_TYPES[newType].label.toLowerCase()}` : "");
  useEffect(() => {
    editInfo.title = title || null;
    editInfo.dirty = dirty;
    call("edit_state", { title: title || null, dirty }).catch(() => undefined);
  }, [title, dirty]);
  useEffect(
    () => () => {
      editInfo.title = null;
      editInfo.dirty = false;
      call("edit_state", { title: null, dirty: false }).catch(() => undefined);
    },
    [],
  );

  const allTags = useMemo(() => [...new Set(items.flatMap((i) => i.tags))].sort(), [items]);

  const patch = (p: Partial<ItemForm>) => setForm((f) => (f ? { ...f, ...p } : f));
  const patchField = (key: string, p: Partial<FormField>) =>
    setForm((f) => (f ? { ...f, fields: f.fields.map((x) => (x.key === key ? { ...x, ...p } : x)) } : f));

  const save = useCallback(
    async (overrideRev?: number): Promise<boolean> => {
      if (!form || saving) return false;
      const errs = validateForm(form);
      setErrors(errs);
      if (Object.keys(errs).length) {
        const first = Object.keys(errs)[0];
        requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>(`[data-err="${first}"] input, [data-err="${first}"] textarea, [data-err="${first}"] select`)?.focus());
        return false;
      }
      setSaving(true);
      try {
        const input = formToInput(overrideRev !== undefined ? { ...form, baseRev: overrideRev } : form);
        const saved = await withReprompt(
          (password) => call("item_save", { item: input, password }),
          "Turning off the master password question, or changing the kind of a secret field, needs your master password.",
        );
        setBase(form);
        setConflict(false);
        toast(mode === "new" ? `${saved.title} added.` : `${saved.title} saved.`);
        editInfo.dirty = false; // saved: closing the editor must not ask "Discard changes?"
        onDone(saved.id);
        return true;
      } catch (e) {
        if (isCofferError(e) && e.code === "conflict") setConflict(true);
        else if (!(isCofferError(e) && e.message === "Cancelled.")) error(e);
        return false;
      } finally {
        setSaving(false);
      }
    },
    [form, saving, withReprompt, toast, mode, onDone, error],
  );

  const cancel = () => (dirty ? setAskDiscard(true) : onDone(mode === "edit" ? itemId : null));

  useKeyHandlers("editor", { save: () => save(), cancel });

  // Quit with an unsaved edit: the main window asked "Save"; save, then quit.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const h = () => {
      saveRef.current().then((ok) => {
        if (ok) call("app_quit").catch(() => undefined);
      });
    };
    window.addEventListener("coffer:save-then-quit", h);
    return () => window.removeEventListener("coffer:save-then-quit", h);
  }, []);

  if (!form)
    return (
      <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
        <Spinner /> Opening...
      </div>
    );

  const def = ITEM_TYPES[form.type];
  const builtinKeys = new Set(def.fields.map((f) => f.role));
  const builtins = form.fields.filter((f) => f.builtin && builtinKeys.has(f.builtin));
  const custom = form.fields.filter((f) => !f.builtin || !builtinKeys.has(f.builtin));
  const fid = (k: string) => `${uid}-${k}`;

  const canGenerate = (f: FormField) => f.kind === "concealed" || f.kind === "pin";
  // Every row: label 160 px | value, the same columns as the item view, so nothing moves on Ctrl+E.
  // The generator wand and the remove button sit inside the inputs.
  const renderRow = (f: FormField, isCustom: boolean) => {
    const err = errors[`field:${f.key}`];
    const labelErr = errors[`label:${f.key}`];
    return (
      <div key={f.key} className="flex flex-col gap-2 px-4 py-3" data-err={err ? `field:${f.key}` : labelErr ? `label:${f.key}` : undefined}>
        <div className="grid grid-cols-1 items-start gap-x-3 gap-y-1 @min-[440px]:grid-cols-[160px_minmax(0,1fr)]">
          {isCustom ? (
            <div className="flex flex-col gap-1">
              <div className="control flex items-center gap-1 pr-1" aria-invalid={!!labelErr || undefined}>
                <input
                  aria-label="Field name"
                  placeholder="Field name"
                  value={f.label}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={!!labelErr || undefined}
                  onChange={(e) => patchField(f.key, { label: e.target.value })}
                  className="h-[1.875rem] min-w-0 flex-1 bg-transparent text-xs outline-none"
                />
                <IconButton
                  size="sm"
                  label={`Remove ${f.label || "field"}`}
                  className="hover:text-danger-text"
                  onClick={() => setForm({ ...form, fields: form.fields.filter((x) => x.key !== f.key) })}
                >
                  <X />
                </IconButton>
              </div>
              <Input
                aria-label="Section"
                placeholder="Section (optional)"
                value={f.section ?? ""}
                onChange={(e) => patchField(f.key, { section: e.target.value || null })}
                className="!h-7 !min-h-7 text-xs"
              />
            </div>
          ) : (
            <label htmlFor={fid(f.key)} className="text-xs text-muted-foreground @min-[440px]:pt-2">
              {form.type === "identity" && f.builtin === "title" ? "Title (Mr, Ms, Dr)" : f.label}
            </label>
          )}
          <div className="flex min-w-0 flex-col gap-1">
            <ValueInput
              id={fid(f.key)}
              field={f}
              itemId={form.id}
              invalid={!!err}
              onChange={(v) => patchField(f.key, { value: v })}
              gen={canGenerate(f) ? { open: genFor === f.key, toggle: () => setGenFor((g) => (g === f.key ? null : f.key)) } : undefined}
            />
            {(err || labelErr) && (
              <p role="alert" className="text-xs text-danger-text">
                {err || labelErr}
              </p>
            )}
            {isCustom && <p className="text-2xs text-muted-foreground">{FIELD_KIND_LABELS[f.kind]}</p>}
          </div>
        </div>
        {genFor === f.key && (
          <div className="rounded-sm border border-border bg-muted/40 p-3">
            <Generator
              compact
              onUse={(v) => {
                patchField(f.key, { value: v });
                setGenFor(null);
              }}
              useLabel="Use this"
            />
          </div>
        )}
      </div>
    );
  };

  return (
    <form
      ref={formRef}
      aria-label={mode === "new" ? `New ${def.label}` : `Edit ${form.title}`}
      className="@container flex h-full flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <header className="flex shrink-0 flex-wrap items-start gap-3 px-6 pt-5 pb-4">
        <Monogram title={form.title || def.label} size={40} />
        <div className="min-w-[12rem] flex-1" data-err={errors.title ? "title" : undefined}>
          <input
            ref={titleRef}
            aria-label="Item name"
            value={form.title}
            placeholder={`Name this ${def.label.toLowerCase()}`}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={!!errors.title || undefined}
            onChange={(e) => patch({ title: e.target.value })}
            className={cx(
              "field-focus -mx-1.5 w-full rounded-sm border border-transparent bg-transparent px-1.5 text-lg font-semibold hover:border-input-border",
              errors.title && "border-danger-text",
            )}
          />
          {errors.title ? (
            <p role="alert" className="text-xs text-danger-text">
              {errors.title}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">{mode === "new" ? `New ${def.label.toLowerCase()}` : `Editing ${def.label.toLowerCase()}`}</p>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button onClick={cancel} title="Cancel (Esc)">
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={saving} title="Save (Ctrl+S)" aria-keyshortcuts="Control+S">
            Save
            <KeyBadge>Ctrl+S</KeyBadge>
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-16">
        <div className="flex max-w-[680px] flex-col gap-5">
          {conflict && (
            <Notice
              tone="warning"
              role="alert"
              actions={
                <>
                  <Button
                    size="sm"
                    onClick={async () => {
                      try {
                        const latest = await call("item_get", { id: form.id! });
                        await save(latest.rev);
                      } catch (e) {
                        error(e);
                      }
                    }}
                  >
                    Keep mine
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      editInfo.dirty = false;
                      onDone(form.id ?? null);
                    }}
                  >
                    Keep theirs
                  </Button>
                </>
              }
            >
              This item changed on disk.
            </Notice>
          )}

          <div className="divide-y divide-border rounded-sm border border-border bg-card">
            {builtins.map((f) => renderRow(f, false))}
            {def.hasUrls &&
              form.urls.map((u, i) => (
                <div key={`url-${i}`} className="flex flex-col gap-1 px-4 py-3" data-err={errors[`url:${i}`] ? `url:${i}` : undefined}>
                  <div className="grid grid-cols-1 items-start gap-x-3 gap-y-1 @min-[440px]:grid-cols-[160px_minmax(0,1fr)]">
                    <label htmlFor={`${uid}-url-${i}`} className="text-xs text-muted-foreground @min-[440px]:pt-2">
                      {form.urls.length > 1 ? `Website ${i + 1}` : "Website"}
                    </label>
                    <div className="flex min-w-0 flex-col gap-1">
                      <div className="control flex items-center gap-1 pr-1" aria-invalid={!!errors[`url:${i}`] || undefined}>
                        <input
                          id={`${uid}-url-${i}`}
                          value={u.url}
                          placeholder="https://example.com"
                          autoComplete="off"
                          spellCheck={false}
                          aria-invalid={!!errors[`url:${i}`] || undefined}
                          onChange={(e) => patch({ urls: form.urls.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)) })}
                          className="h-[1.875rem] min-w-0 flex-1 bg-transparent text-sm outline-none"
                        />
                        <IconButton size="sm" label={`Remove website ${i + 1}`} className="hover:text-danger-text" onClick={() => patch({ urls: form.urls.filter((_, j) => j !== i) })}>
                          <X />
                        </IconButton>
                      </div>
                      {errors[`url:${i}`] && <p className="text-xs text-danger-text">{errors[`url:${i}`]}</p>}
                    </div>
                  </div>
                </div>
              ))}
            {def.hasUrls && (
              <div className="px-4 py-2">
                <div className="grid grid-cols-1 items-start gap-x-3 gap-y-1 @min-[440px]:grid-cols-[160px_minmax(0,1fr)]">
                  <span className="hidden @min-[440px]:block" />
                  <div>
                    <Button size="sm" variant="ghost" className="-ml-2.5" icon={<Plus className="size-3.5" />} onClick={() => patch({ urls: [...form.urls, { url: "", label: null }] })}>
                      Add a website
                    </Button>
                  </div>
                </div>
              </div>
            )}
            <div className="px-4 py-3">
              <div className="grid grid-cols-1 items-start gap-x-3 gap-y-1 @min-[440px]:grid-cols-[160px_minmax(0,1fr)]">
                <label htmlFor={`${uid}-notes`} className="text-xs text-muted-foreground @min-[440px]:pt-2">
                  Notes
                </label>
                <div className="flex min-w-0 flex-col gap-1">
                  <Textarea id={`${uid}-notes`} rows={form.type === "note" ? 12 : 4} value={form.notes} onChange={(e) => patch({ notes: e.target.value })} />
                  <p className="text-xs text-muted-foreground">Formatting: # heading, - list, **bold**, *italic*, `code`.</p>
                </div>
              </div>
            </div>
          </div>

          {custom.length > 0 && (
            <section className="flex flex-col gap-1.5">
              <h2 className="px-1 text-xs font-medium text-muted-foreground">{builtins.length ? "More fields" : "Fields"}</h2>
              <div className="rounded-sm border border-border bg-card">
                <div aria-hidden className="hidden grid-cols-[160px_minmax(0,1fr)] gap-3 border-b border-border px-4 pt-2 pb-1.5 text-2xs text-muted-foreground @min-[440px]:grid">
                  <span>Name and section</span>
                  <span>Value</span>
                </div>
                <div className="divide-y divide-border">{custom.map((f) => renderRow(f, true))}</div>
              </div>
            </section>
          )}
          <div>
            <Menu
              align="start"
              label="Add a field"
              items={ADDABLE.map((k) => ({
                label: FIELD_KIND_LABELS[k],
                onSelect: () =>
                  setForm({
                    ...form,
                    fields: [...form.fields, { key: newKey(), label: "", kind: k, value: k === "boolean" ? "false" : "", hasStored: false, section: null, builtin: null }],
                  }),
              }))}
              trigger={(p) => (
                <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} {...p}>
                  Add a field
                </Button>
              )}
            />
          </div>

          <section className="flex flex-col gap-1.5">
            <h2 className="px-1 text-xs font-medium text-muted-foreground">Tags</h2>
            <TagEditor tags={form.tags} onChange={(t) => patch({ tags: t })} suggestions={allTags} />
          </section>

          {(form.type === "login" || form.type === "password" || form.type === "apiCredential") && (
            <section className="flex flex-col gap-1.5">
              <label htmlFor={`${uid}-apps`} className="px-1 text-xs font-medium text-muted-foreground">
                Suggest in these apps
              </label>
              <Input
                id={`${uid}-apps`}
                value={form.apps.join(", ")}
                placeholder="For example slack.exe, teams.exe"
                onChange={(e) => patch({ apps: e.target.value.split(",").map((s) => s.trim()) })}
              />
              <p className="px-1 text-xs text-muted-foreground">Quick Access shows this item first when one of these apps is in front.</p>
            </section>
          )}

          <section className="flex flex-col gap-2.5 rounded-sm border border-border px-4 py-3">
            <Checkbox label="Favourite" checked={form.favorite} onChange={(v) => patch({ favorite: v })} />
            <Checkbox
              label="Ask for the master password to show or copy secrets"
              description="Coffer asks again for this item, at most once a minute."
              checked={form.reprompt}
              onChange={(v) => patch({ reprompt: v })}
            />
            <Checkbox
              label="Leave out of health checks"
              description="Use it for a password you cannot change, such as a test account."
              checked={form.healthExcluded}
              onChange={(v) => patch({ healthExcluded: v })}
            />
          </section>
          {view && <p className="px-1 text-xs text-muted-foreground">Ctrl+S saves. Esc cancels.</p>}
        </div>
      </div>

      <ConfirmDialog
        open={askDiscard}
        title="Discard changes?"
        body={`Your changes to ${form.title || "this item"} are not saved.`}
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        danger
        onCancel={() => setAskDiscard(false)}
        onConfirm={() => {
          setAskDiscard(false);
          editInfo.dirty = false;
          onDone(mode === "edit" ? itemId : null);
        }}
      />
    </form>
  );
}
