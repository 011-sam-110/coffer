// Sidebar: All items, Favourites, Health, Archive, Trash; Tags (nested, expanded);
// Types (collapsed by default, empty types hidden); footer: Generator, Import,
// Settings, Shortcuts, Lock (SPEC 11 item 7).
import { Archive, ChevronDown, ChevronRight, Download, Gauge, Keyboard, Layers, Lock, Settings, Star, Tag, Trash2, WandSparkles } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { DemoBadge, TYPE_ICONS } from "../../components/bits";
import { cx } from "../../components/ui";
import type { ItemSummary } from "../../lib/contract";
import { tagTree, type TagNode } from "../../lib/format";
import { ITEM_TYPE_ORDER, ITEM_TYPES } from "../../lib/itemTypes";
import { useStore } from "../store";
import { filterKey, type Filter, type Nav, type View } from "./nav";

function Row({
  icon,
  label,
  count,
  active,
  onClick,
  depth = 0,
  toggle,
  shortcut,
}: {
  icon?: ReactNode;
  label: string;
  count?: number;
  active?: boolean;
  onClick: () => void;
  depth?: number;
  toggle?: ReactNode;
  shortcut?: string;
}) {
  return (
    <li className="relative">
      {toggle}
      <button
        type="button"
        onClick={onClick}
        aria-current={active ? "page" : undefined}
        className={cx(
          "flex h-7 w-full cursor-pointer items-center gap-2.5 rounded-sm pr-2 text-left text-sm transition-colors duration-100",
          active ? "row-selected text-sidebar-foreground" : "text-sidebar-foreground/80 hover:bg-muted hover:text-sidebar-foreground",
          "[&_svg]:size-4 [&_svg]:shrink-0",
        )}
        style={{ paddingLeft: 8 + depth * 14 + (toggle ? 14 : 0) }}
      >
        {icon && <span className={cx(active ? "text-sidebar-foreground" : "text-muted-foreground")}>{icon}</span>}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {shortcut && <span className="text-2xs text-muted-foreground">{shortcut}</span>}
        {count !== undefined && <span className="text-xs text-muted-foreground tabular-nums">{count}</span>}
      </button>
    </li>
  );
}

function Heading({ children }: { children: ReactNode }) {
  return <h2 className="px-2 pt-4 pb-1 text-xs font-medium text-muted-foreground">{children}</h2>;
}

const TYPES_OPEN_KEY = "coffer.sidebar.typesOpen";
const readTypesOpen = (): boolean => {
  try {
    return localStorage.getItem(TYPES_OPEN_KEY) === "1";
  } catch {
    return false;
  }
};

export function Sidebar({
  nav,
  go,
  onLock,
  onShowShortcuts,
}: {
  nav: Nav;
  go: (patch: Partial<Nav>) => void;
  onLock: () => void;
  onShowShortcuts: () => void;
}) {
  const { items, status, info } = useStore();
  // Tags start expanded; a click collapses a branch.
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  // Types start collapsed (search and the type filters cover them); the choice is remembered.
  const [typesOpen, setTypesOpen] = useState(readTypesOpen);

  const active = items.filter((i) => i.state === "active");
  const counts = useMemo(() => {
    const byType = new Map<string, number>();
    for (const i of active) byType.set(i.type, (byType.get(i.type) ?? 0) + 1);
    return byType;
  }, [active]);
  const tags = useMemo(() => tagTree(active.map((i: ItemSummary) => i.tags)), [active]);
  const visibleTags = useMemo(() => {
    const out: TagNode[] = [];
    const walk = (nodes: TagNode[]) =>
      nodes.forEach((n) => {
        out.push(n);
        if (!closed[n.path]) walk(n.children);
      });
    walk(tags);
    return out;
  }, [tags, closed]);

  const isFilter = (f: Filter) => nav.view === "items" && filterKey(nav.filter) === filterKey(f);
  const pick = (f: Filter) => go({ view: "items", filter: f, itemId: null, editing: null });
  const view = (v: View) => go({ view: v, editing: null, healthTab: undefined });
  // A type filter that is on keeps the group open, so the selected row stays in view.
  const showTypes = typesOpen || (nav.view === "items" && nav.filter.kind === "type");
  const toggleTypes = () => {
    const next = !showTypes;
    setTypesOpen(next);
    try {
      localStorage.setItem(TYPES_OPEN_KEY, next ? "1" : "0");
    } catch {
      /* a convenience only */
    }
  };

  return (
    <nav aria-label="Vault" className="flex h-full w-[220px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 px-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold" title={status?.vaultPath ?? undefined}>
            {status?.vaultName ?? "Vault"}
          </p>
        </div>
        {info?.demo && <DemoBadge />}
      </div>
      <div className="relative min-h-0 flex-1">
        <div className="h-full overflow-y-auto px-2 pb-6">
          <ul>
            <Row icon={<Layers />} label="All items" count={active.length} active={isFilter({ kind: "all" })} onClick={() => pick({ kind: "all" })} />
            <Row
              icon={<Star />}
              label="Favourites"
              count={active.filter((i) => i.favorite).length}
              active={isFilter({ kind: "favorites" })}
              onClick={() => pick({ kind: "favorites" })}
            />
            <Row icon={<Gauge />} label="Health" active={nav.view === "health"} onClick={() => view("health")} />
            <Row
              icon={<Archive />}
              label="Archive"
              count={items.filter((i) => i.state === "archived").length}
              active={isFilter({ kind: "archive" })}
              onClick={() => pick({ kind: "archive" })}
            />
            <Row
              icon={<Trash2 />}
              label="Trash"
              count={items.filter((i) => i.state === "trashed").length}
              active={isFilter({ kind: "trash" })}
              onClick={() => pick({ kind: "trash" })}
            />
          </ul>
          {tags.length > 0 && (
            <>
              <Heading>Tags</Heading>
              <ul>
                {visibleTags.map((n) => (
                  <Row
                    key={n.path}
                    icon={<Tag />}
                    label={n.name}
                    count={n.count}
                    depth={n.depth}
                    active={isFilter({ kind: "tag", tag: n.path })}
                    onClick={() => pick({ kind: "tag", tag: n.path })}
                    toggle={
                      n.children.length > 0 ? (
                        <button
                          type="button"
                          aria-label={closed[n.path] ? `Expand ${n.name}` : `Collapse ${n.name}`}
                          aria-expanded={!closed[n.path]}
                          onClick={() => setClosed((o) => ({ ...o, [n.path]: !o[n.path] }))}
                          className="absolute top-1.5 z-10 inline-flex size-4 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
                          style={{ left: 4 + n.depth * 14 }}
                        >
                          {closed[n.path] ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                        </button>
                      ) : undefined
                    }
                  />
                ))}
              </ul>
            </>
          )}
          {counts.size > 0 && (
            <>
              <h2 className="pt-4 pb-1">
                <button
                  type="button"
                  aria-expanded={showTypes}
                  aria-controls="sidebar-types"
                  onClick={toggleTypes}
                  className="flex h-6 w-full cursor-pointer items-center gap-1 rounded-sm px-2 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
                >
                  {showTypes ? <ChevronDown aria-hidden className="size-3.5" /> : <ChevronRight aria-hidden className="size-3.5" />}
                  Types ({counts.size})
                </button>
              </h2>
              {showTypes && (
                <ul id="sidebar-types">
                  {ITEM_TYPE_ORDER.filter((t) => counts.has(t)).map((t) => {
                    const Icon = TYPE_ICONS[t];
                    return (
                      <Row
                        key={t}
                        icon={<Icon />}
                        label={ITEM_TYPES[t].plural}
                        count={counts.get(t)}
                        active={isFilter({ kind: "type", type: t })}
                        onClick={() => pick({ kind: "type", type: t })}
                      />
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </div>
        {/* A short fade says the list goes on under the footer. */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-4 bg-gradient-to-t from-sidebar to-transparent" />
      </div>
      <ul className="shrink-0 border-t border-sidebar-border px-2 py-2">
        <Row icon={<WandSparkles />} label="Generator" shortcut="Ctrl+G" active={nav.view === "generator"} onClick={() => view("generator")} />
        <Row icon={<Download />} label="Import" active={nav.view === "import"} onClick={() => view("import")} />
        <Row icon={<Settings />} label="Settings" shortcut="Ctrl+," active={nav.view === "settings"} onClick={() => view("settings")} />
        <Row icon={<Keyboard />} label="Shortcuts" shortcut="F1" onClick={onShowShortcuts} />
        <Row icon={<Lock />} label="Lock" shortcut="Ctrl+L" onClick={onLock} />
      </ul>
    </nav>
  );
}
