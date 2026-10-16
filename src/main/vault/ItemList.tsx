// The item list: search, sort, bulk select (tag, archive, trash), flag chips that
// link to Health, two densities, and the empty states of SPEC 11 item 12.
// Type filters live in the sidebar.
import { Archive, ArchiveRestore, Plus, Search, Star, Tag, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Monogram, TYPE_ICONS } from "../../components/bits";
import { ConfirmDialog, Dialog, Menu, useToast } from "../../components/overlays";
import { Button, cx, IconButton, Input, KeyBadge, Select } from "../../components/ui";
import type { ItemSummary, ItemType } from "../../lib/contract";
import { hasTag } from "../../lib/format";
import { call } from "../../lib/ipc";
import { ITEM_TYPE_ORDER, ITEM_TYPES } from "../../lib/itemTypes";
import { searchItems, sortItems, type SortKey } from "../../lib/search";
import { useListDensity } from "../prefs";
import { useStore } from "../store";
import { useKeyHandlers, type Filter, type HealthTab, type Nav } from "./nav";

export function filterItems(items: ItemSummary[], f: Filter): ItemSummary[] {
  switch (f.kind) {
    case "all":
      return items.filter((i) => i.state === "active");
    case "favorites":
      return items.filter((i) => i.state === "active" && i.favorite);
    case "type":
      return items.filter((i) => i.state === "active" && i.type === f.type);
    case "tag":
      return items.filter((i) => i.state === "active" && hasTag(i.tags, f.tag));
    case "archive":
      return items.filter((i) => i.state === "archived");
    case "trash":
      return items.filter((i) => i.state === "trashed");
  }
}

export function filterTitle(f: Filter): string {
  switch (f.kind) {
    case "all":
      return "All items";
    case "favorites":
      return "Favourites";
    case "type":
      return ITEM_TYPES[f.type].plural;
    case "tag":
      return f.tag;
    case "archive":
      return "Archive";
    case "trash":
      return "Trash";
  }
}

/** The one-word chip for an item's most serious health flag, and the Health tab it opens. */
function flagChip(i: ItemSummary): { word: string; label: string; tab: HealthTab; danger: boolean } | null {
  const f = i.flags;
  if (f.breached) return { word: "Breached", label: "Found in a data breach. Open Health.", tab: "breached", danger: true };
  if (f.reused) return { word: "Reused", label: "This password is in other items too. Open Health.", tab: "reused", danger: false };
  if (f.weak) return { word: "Weak", label: "Easy to guess. Open Health.", tab: "weak", danger: false };
  if (f.unsecured) return { word: "http", label: "A website address uses http://, not https://. Open Health.", tab: "unsecured", danger: false };
  if (f.expiring) return { word: "Expiring", label: "Expires soon. Open Health.", tab: "expiring", danger: false };
  return null;
}

export function NewItemMenu({ onPick, variant = "primary", label = "New" }: { onPick: (t: ItemType) => void; variant?: "primary" | "secondary"; label?: string }) {
  return (
    <Menu
      label="New item"
      items={ITEM_TYPE_ORDER.map((t) => ({ label: ITEM_TYPES[t].label, onSelect: () => onPick(t) }))}
      trigger={(p) => (
        <Button variant={variant} size="md" icon={<Plus className="size-4" />} {...p} title="New item (Ctrl+N)" aria-keyshortcuts="Control+N">
          {label}
          <KeyBadge>Ctrl+N</KeyBadge>
        </Button>
      )}
    />
  );
}

export function ItemList({
  nav,
  go,
  searchRef,
}: {
  nav: Nav;
  go: (patch: Partial<Nav>) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
}) {
  const { items, itemsLoaded, banner } = useStore();
  const { toast, error } = useToast();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("title");
  const [density] = useListDensity();
  const compact = density === "compact";
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [tagDialog, setTagDialog] = useState(false);
  const [tagText, setTagText] = useState("");
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);

  // Reset search and selection when the filter changes.
  const fkey = JSON.stringify(nav.filter);
  useEffect(() => {
    setSelected(new Set());
  }, [fkey]);

  const base = useMemo(() => filterItems(items, nav.filter), [items, nav.filter]);
  const typed = base;
  const noActive = !items.some((i) => i.state === "active");
  const { shown, hiddenCount } = useMemo(() => {
    if (!query.trim()) return { shown: sortItems(typed, sort), hiddenCount: 0 };
    if (nav.filter.kind === "archive" || nav.filter.kind === "trash") {
      const r = searchItems(typed.map((i) => ({ ...i, state: "active" as const })), query);
      return { shown: r.matches.map((m) => typed.find((t) => t.id === m.id)!), hiddenCount: 0 };
    }
    const scoped = nav.filter.kind === "all" ? items : typed;
    const r = searchItems(scoped, query);
    const allowed = new Set(typed.map((i) => i.id));
    return { shown: r.matches.filter((m) => allowed.has(m.id)), hiddenCount: nav.filter.kind === "all" ? r.hiddenCount : 0 };
  }, [typed, items, query, sort, nav.filter]);

  const bulk = selected.size > 0;
  const inTrash = nav.filter.kind === "trash";
  const inArchive = nav.filter.kind === "archive";

  const select = (id: string) => go({ itemId: id, editing: null });
  const focusRow = (id: string) => listRef.current?.querySelector<HTMLButtonElement>(`[data-id="${id}"]`)?.focus();

  const move = (dir: 1 | -1) => {
    if (shown.length === 0) return;
    const i = shown.findIndex((x) => x.id === nav.itemId);
    const next = shown[Math.max(0, Math.min(shown.length - 1, i < 0 ? 0 : i + dir))];
    select(next.id);
    requestAnimationFrame(() => focusRow(next.id));
  };

  const onRowKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === " " && nav.itemId) {
      e.preventDefault();
      toggle(nav.itemId);
    }
  };

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const clickRow = (e: React.MouseEvent, id: string) => {
    if (e.shiftKey && anchor) {
      const a = shown.findIndex((x) => x.id === anchor);
      const b = shown.findIndex((x) => x.id === id);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      setSelected(new Set(shown.slice(lo, hi + 1).map((x) => x.id)));
      return;
    }
    if (e.ctrlKey || bulk) {
      toggle(id);
      setAnchor(id);
      return;
    }
    setAnchor(id);
    select(id);
  };

  const runBulk = async (action: "archive" | "trash" | "restore" | "addTag" | "removeTag", tag: string | null = null) => {
    const ids = [...selected];
    try {
      const n = await call("items_bulk", { ids, action, tag });
      setSelected(new Set());
      const words = { archive: "archived", trash: "moved to Trash", restore: "restored", addTag: `tagged ${tag}`, removeTag: `untagged` }[action];
      toast(`${n} item${n === 1 ? "" : "s"} ${words}.`, {
        action:
          action === "trash" || action === "archive"
            ? { label: "Undo", run: () => call("items_bulk", { ids, action: "restore", tag: null }).catch(error) }
            : undefined,
        ms: 6000,
      });
    } catch (e) {
      error(e);
    }
  };

  useKeyHandlers("list", {
    search: () => {
      searchRef.current?.focus();
      searchRef.current?.select();
    },
  });

  const empty = itemsLoaded && shown.length === 0;
  const title = filterTitle(nav.filter);

  return (
    <section aria-label={title} className="flex h-full w-[340px] shrink-0 flex-col border-r border-border">
      <div className="flex shrink-0 flex-col gap-2 border-b border-border px-3 pt-3 pb-2">
        <div className="flex items-center gap-2">
          <div className="control flex h-8 flex-1 items-center gap-2">
            <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <input
              ref={searchRef}
              type="search"
              aria-label={`Search ${title}`}
              placeholder={`Search ${base.length} ${base.length === 1 ? "item" : "items"}`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  if (shown[0]) {
                    select(shown[0].id);
                    requestAnimationFrame(() => focusRow(shown[0].id));
                  }
                } else if (e.key === "Escape" && query) {
                  e.stopPropagation();
                  setQuery("");
                } else if (e.key === "Enter" && shown[0]) {
                  select(shown[0].id);
                }
              }}
              autoComplete="off"
              spellCheck={false}
              className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none [&::-webkit-search-cancel-button]:hidden"
            />
            {query ? (
              <IconButton size="sm" label="Clear search" onClick={() => setQuery("")}>
                <X />
              </IconButton>
            ) : (
              <span className="kbd">Ctrl+F</span>
            )}
          </div>
          {!inTrash && !inArchive && (
            <NewItemMenu
              // One crimson action at a time: Save while editing, the banner's action while a banner is up.
              // Grey while the vault is empty too: the empty state's Import is the main action then.
              variant={nav.editing || noActive || (banner && banner.kind !== "reloaded") ? "secondary" : "primary"}
              onPick={(t) => go({ editing: "new", newType: t, newTitle: "", itemId: null })}
            />
          )}
        </div>
        {bulk ? (
          <div className="flex h-7 items-center gap-1" role="toolbar" aria-label="Selected items">
            <span className="mr-auto text-xs font-medium whitespace-nowrap">{selected.size} selected</span>
            {inTrash || inArchive ? (
              <Button size="sm" variant="ghost" icon={<ArchiveRestore className="size-3.5" />} onClick={() => runBulk("restore")}>
                Restore
              </Button>
            ) : (
              <>
                <Button size="sm" variant="ghost" icon={<Tag className="size-3.5" />} onClick={() => setTagDialog(true)}>
                  Tag
                </Button>
                <Button size="sm" variant="ghost" icon={<Archive className="size-3.5" />} onClick={() => runBulk("archive")}>
                  Archive
                </Button>
              </>
            )}
            {!inTrash && (
              <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => runBulk("trash")}>
                Trash
              </Button>
            )}
            <IconButton size="sm" label="Clear selection" onClick={() => setSelected(new Set())}>
              <X />
            </IconButton>
          </div>
        ) : (
          <div className="flex h-7 items-center gap-2">
            <Select aria-label="Sort by" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className="!h-7 !min-h-7 text-xs">
              <option value="title">Title</option>
              <option value="updated">Last changed</option>
              <option value="lastUsed">Last used</option>
            </Select>
            {query.trim() && <span className="text-xs text-muted-foreground tabular-nums">{shown.length} found</span>}
            {inTrash && base.length > 0 && (
              <Button size="sm" variant="ghost" className="ml-auto text-danger-text" onClick={() => setConfirmEmpty(true)}>
                Empty Trash
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!itemsLoaded ? (
          <ListSkeleton />
        ) : empty ? (
          <EmptyList filter={nav.filter} query={query} vaultEmpty={items.length === 0} go={go} hiddenCount={hiddenCount} />
        ) : (
          <ul ref={listRef} role="listbox" aria-label={title} aria-multiselectable={bulk || undefined} className="py-1">
            {shown.map((i) => {
              const isSel = nav.itemId === i.id;
              const checked = selected.has(i.id);
              const flag = flagChip(i);
              const TypeIcon = TYPE_ICONS[i.type];
              return (
                <li key={i.id} role="presentation" className="group relative px-1.5">
                  <button
                    type="button"
                    role="option"
                    data-id={i.id}
                    aria-selected={isSel}
                    aria-checked={bulk ? checked : undefined}
                    tabIndex={isSel || (!nav.itemId && i === shown[0]) ? 0 : -1}
                    onClick={(e) => clickRow(e, i.id)}
                    onKeyDown={onRowKey}
                    className={cx(
                      "flex w-full cursor-pointer items-center rounded-sm pr-2 pl-2 text-left transition-colors duration-100",
                      compact ? "h-[30px] gap-2" : "h-[52px] gap-3",
                      "focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-foreground/60",
                      isSel ? "row-selected" : checked ? "bg-muted" : "hover:bg-muted",
                    )}
                  >
                    {compact ? (
                      <>
                        <TypeIcon aria-hidden className={cx("size-3.5 shrink-0 text-muted-foreground", (bulk || checked) && "opacity-0")} />
                        <span className="min-w-0 shrink truncate text-sm font-medium">{i.title}</span>
                        {i.favorite && <Star aria-label="Favourite" className="size-3 shrink-0 fill-gold text-gold" />}
                        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{i.subtitle}</span>
                        {i.urlHost && <span className="max-w-[96px] shrink-0 truncate text-right text-xs text-muted-foreground">{i.urlHost}</span>}
                      </>
                    ) : (
                      <>
                        <span className="relative">
                          <Monogram title={i.title} size={32} className={cx((bulk || checked) && "opacity-0")} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate text-sm font-medium">{i.title}</span>
                            {i.favorite && <Star aria-label="Favourite" className="size-3 shrink-0 fill-gold text-gold" />}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">{i.subtitle || ITEM_TYPES[i.type].label}</span>
                        </span>
                      </>
                    )}
                    {flag && (
                      // A mouse shortcut to the matching Health tab; the row itself stays the keyboard target.
                      <span
                        aria-label={flag.label}
                        title={flag.label}
                        onClick={(e) => {
                          e.stopPropagation();
                          go({ view: "health", healthTab: flag.tab, editing: null });
                        }}
                        className={cx(
                          "shrink-0 rounded-sm border px-1.5 text-2xs leading-4 font-medium hover:bg-secondary",
                          flag.danger ? "border-destructive text-danger-text" : "border-border text-muted-foreground",
                        )}
                      >
                        {flag.word}
                      </span>
                    )}
                  </button>
                  {/* Mouse aid only: keyboard users press Space on the row, and the row reports aria-checked. */}
                  <input
                    type="checkbox"
                    aria-hidden
                    tabIndex={-1}
                    aria-label={`Select ${i.title}`}
                    checked={checked}
                    onChange={() => toggle(i.id)}
                    className={cx(
                      "absolute top-1/2 size-3.5 -translate-y-1/2 cursor-pointer accent-foreground",
                      compact ? "left-[14px]" : "left-[22px]",
                      bulk || checked ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                    )}
                  />
                </li>
              );
            })}
            {hiddenCount > 0 && (
              <li className="px-3 py-2 text-xs text-muted-foreground">
                {hiddenCount} more in Archive or Trash
              </li>
            )}
          </ul>
        )}
      </div>

      <Dialog
        open={tagDialog}
        onClose={() => setTagDialog(false)}
        title={`Tag ${selected.size} item${selected.size === 1 ? "" : "s"}`}
        description='Use "/" to nest a tag, for example Work/Clients.'
        width={380}
        footer={
          <>
            <Button onClick={() => setTagDialog(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!tagText.trim()}
              onClick={() => {
                setTagDialog(false);
                runBulk("addTag", tagText.trim());
                setTagText("");
              }}
            >
              Add tag
            </Button>
          </>
        }
      >
        <Input aria-label="Tag" autoFocus value={tagText} onChange={(e) => setTagText(e.target.value)} placeholder="Tag name" />
      </Dialog>
      <ConfirmDialog
        open={confirmEmpty}
        title="Empty Trash?"
        body={`Coffer deletes ${base.length} item${base.length === 1 ? "" : "s"} for good. Backups made before now still hold them.`}
        confirmLabel="Delete for good"
        danger
        onCancel={() => setConfirmEmpty(false)}
        onConfirm={async () => {
          setConfirmEmpty(false);
          try {
            const n = await call("trash_empty");
            go({ itemId: null });
            toast(`${n} item${n === 1 ? "" : "s"} deleted for good.`);
          } catch (e) {
            error(e);
          }
        }}
      />
    </section>
  );
}

function ListSkeleton() {
  return (
    <ul aria-hidden className="py-1">
      {Array.from({ length: 8 }).map((_, i) => (
        <li key={i} className="flex h-[52px] items-center gap-3 px-3.5">
          <span className="size-8 rounded-sm bg-muted" />
          <span className="flex flex-1 flex-col gap-1.5">
            <span className="h-2.5 w-2/5 rounded-sm bg-muted" />
            <span className="h-2 w-3/5 rounded-sm bg-muted/60" />
          </span>
        </li>
      ))}
    </ul>
  );
}

function EmptyBlock({ title, children, actions }: { title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="px-6 pt-14 text-center">
      <p className="text-sm font-medium">{title}</p>
      {children && <p className="mx-auto mt-1.5 max-w-[34ch] text-xs text-muted-foreground">{children}</p>}
      {actions && <div className="mt-4 flex justify-center gap-2">{actions}</div>}
    </div>
  );
}

function EmptyList({
  filter,
  query,
  vaultEmpty,
  go,
  hiddenCount,
}: {
  filter: Filter;
  query: string;
  vaultEmpty: boolean;
  go: (patch: Partial<Nav>) => void;
  hiddenCount: number;
}) {
  if (query.trim())
    return (
      <EmptyBlock
        title={`No items match '${query.trim()}'`}
        actions={
          filter.kind !== "trash" && filter.kind !== "archive" ? (
            <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => go({ editing: "new", newType: "login", newTitle: query.trim(), itemId: null })}>
              Create login "{query.trim()}"
            </Button>
          ) : undefined
        }
      >
        {hiddenCount > 0 ? `${hiddenCount} more in Archive or Trash.` : "Search looks at titles, usernames, website addresses and tags."}
      </EmptyBlock>
    );
  if (vaultEmpty && filter.kind === "all")
    return (
      <EmptyBlock title="Your vault is empty">Items you add or import show here.</EmptyBlock>
    );
  switch (filter.kind) {
    case "trash":
      return <EmptyBlock title="Trash is empty">Items you delete stay here for 30 days, then Coffer removes them.</EmptyBlock>;
    case "archive":
      return <EmptyBlock title="Archive is empty">Archive an item to keep it out of lists, Quick Access and health checks without deleting it.</EmptyBlock>;
    case "favorites":
      return <EmptyBlock title="No favourites yet">Star an item to keep it here and at the top of Quick Access.</EmptyBlock>;
    default:
      return <EmptyBlock title="Nothing here">No items of this kind.</EmptyBlock>;
  }
}
