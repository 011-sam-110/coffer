// Health dashboard (SPEC 7): score with a meter and its formula, breach-check
// state, a tab per check (empty minor checks hidden) and Excluded, and a fix
// action per finding.
import { ExternalLink, EyeOff, LockKeyhole, RefreshCw, ShieldCheck, WandSparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Monogram } from "../../components/bits";
import { useToast } from "../../components/overlays";
import { Button, cx, Notice, Spinner } from "../../components/ui";
import type { HealthCheck, HealthFinding, HealthReport, ItemSummary } from "../../lib/contract";
import { formatDate } from "../../lib/format";
import { call } from "../../lib/ipc";
import { formFromView, formToInput } from "../../lib/itemForm";
import { useStore } from "../store";
import type { HealthTab, Nav } from "../vault/nav";
import { PageShell, Tabs, type TabDef } from "./PageShell";

/** The tabs: the three scored checks, one tab for the other checks, Excluded. */
type Tab = "breached" | "reused" | "weak" | "other" | "excluded";
/** Checks under "Other checks"; the panel shows each with its own count (they add up to the tab's). */
const MINOR: HealthCheck[] = ["unsecured", "old", "expiring", "duplicate"];
const TAB_ORDER: Tab[] = ["breached", "reused", "weak", "other"];
const TAB_LABEL: Record<HealthCheck, string> = {
  breached: "Breached",
  reused: "Reused",
  weak: "Weak",
  unsecured: "Unsecured",
  old: "Old",
  expiring: "Expiring",
  duplicate: "Duplicates",
};
const EMPTY_TEXT: Record<HealthCheck, string> = {
  breached: "No password was found in a known breach.",
  reused: "No password is used in more than one item.",
  weak: "No weak passwords found.",
  unsecured: "No website address uses http://.",
  old: "No old passwords.",
  expiring: "Nothing expires soon.",
  duplicate: "No duplicate items.",
};

/** The meter colour for a score: chart-2 at 80 or more, gold from 50, danger below. */
const meterTone = (score: number) => (score >= 80 ? "bg-chart-2" : score >= 50 ? "bg-gold" : "bg-danger-text");
const CHECK_WORD: Record<HealthCheck, string> = {
  breached: "Breached",
  reused: "Reused",
  weak: "Weak",
  unsecured: "Unsecured website",
  old: "Old password",
  expiring: "Expiring",
  duplicate: "Duplicate",
};

export function HealthView({ go, initialTab }: { go: (p: Partial<Nav>) => void; initialTab?: HealthTab }) {
  const { items, changeTick } = useStore();
  const [report, setReport] = useState<HealthReport | null>(null);
  const toTab = (t: HealthTab): Tab => (MINOR.includes(t as HealthCheck) ? "other" : (t as Tab));
  const [tab, setTab] = useState<Tab | null>(initialTab ? toTab(initialTab) : null);
  // Inside "Other checks": one check, or null for all of them.
  const [sub, setSub] = useState<HealthCheck | null>(initialTab && MINOR.includes(initialTab as HealthCheck) ? (initialTab as HealthCheck) : null);
  // A flag chip in the list can open a given tab while Health is already shown.
  useEffect(() => {
    if (!initialTab) return;
    setTab(toTab(initialTab));
    setSub(MINOR.includes(initialTab as HealthCheck) ? (initialTab as HealthCheck) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTab]);
  const [checking, setChecking] = useState(false);
  const [excluded, setExcluded] = useState<ItemSummary[] | null>(null);
  const { error, toast } = useToast();

  const load = useCallback(() => {
    call("health_report").then(setReport).catch(error);
  }, [error]);
  useEffect(load, [load, changeTick]);

  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const counts: Record<Tab, number> | null = report
    ? {
        breached: report.counts.breached,
        reused: report.counts.reused,
        weak: report.counts.weak,
        other: MINOR.reduce((n, c) => n + report.counts[c], 0),
        excluded: report.excludedCount,
      }
    : null;
  const active: Tab = tab ?? (counts ? (TAB_ORDER.find((t) => counts[t] > 0) ?? "breached") : "breached");

  // The report counts excluded items but does not list them; read them from the items.
  useEffect(() => {
    if (active !== "excluded") return;
    let alive = true;
    const candidates = items.filter((i) => i.state === "active");
    Promise.all(candidates.map((i) => call("item_get", { id: i.id }).then((v) => (v.healthExcluded ? i : null)).catch(() => null))).then(
      (list) => alive && setExcluded(list.filter((x): x is ItemSummary => !!x)),
    );
    return () => {
      alive = false;
    };
  }, [active, items, changeTick]);

  const exclude = async (id: string, on: boolean) => {
    try {
      await call("item_patch", { id, healthExcluded: on });
      toast(on ? "Left out of health checks." : "Included in health checks again.");
      load();
    } catch (e) {
      error(e);
    }
  };

  const toHttps = async (id: string) => {
    try {
      const view = await call("item_get", { id });
      const form = formFromView(view);
      form.urls = form.urls.map((u) => ({ ...u, url: u.url.replace(/^http:\/\//i, "https://") }));
      await call("item_save", { item: formToInput(form), password: null });
      toast(`${view.title} now uses https://. Check that the site opens.`);
      load();
    } catch (e) {
      error(e);
    }
  };

  const checkNow = async () => {
    setChecking(true);
    try {
      setReport(await call("health_check_breaches"));
    } catch (e) {
      error(e);
    } finally {
      setChecking(false);
    }
  };

  if (!report || !counts)
    return (
      <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
        <Spinner /> Checking your items...
      </div>
    );

  const findings = report.findings.filter((f) => byId.get(f.itemId)?.state === "active");
  const list =
    active === "excluded"
      ? []
      : active === "other"
        ? findings.filter((f) => (sub ? f.check === sub : MINOR.includes(f.check)))
        : findings.filter((f) => f.check === active);
  const noCounted = counts.breached + counts.reused + counts.weak === 0;

  const row = (f: HealthFinding, key: string, extra?: ReactNode) => {
    const it = byId.get(f.itemId);
    if (!it) return null;
    const isLogin = it.type === "login";
    return (
      <li key={key} className="flex items-center gap-3 px-4 py-2.5">
        <Monogram title={it.title} size={28} />
        <button type="button" onClick={() => go({ view: "items", filter: { kind: "all" }, itemId: it.id, editing: null })} className="min-w-0 flex-1 cursor-pointer text-left">
          <span className="block truncate text-sm font-medium hover:underline">{it.title}</span>
          <span className="block truncate text-xs text-muted-foreground" title={CHECK_WORD[f.check]}>
            {active === "other" ? `${CHECK_WORD[f.check]}. ` : ""}
            {f.detail}
          </span>
        </button>
        {extra}
        <div className="flex shrink-0 items-center gap-1">
          {f.check === "unsecured" ? (
            <Button size="sm" onClick={() => toHttps(it.id)}>
              Use HTTPS
            </Button>
          ) : f.check === "expiring" ? null : (
            <Button size="sm" icon={<WandSparkles className="size-3.5" />} onClick={() => go({ view: "items", filter: { kind: "all" }, itemId: it.id, editing: "edit", withGenerator: true })}>
              Change password
            </Button>
          )}
          {isLogin && it.urlHost && (
            <Button size="sm" variant="ghost" icon={<ExternalLink className="size-3.5" />} onClick={() => call("item_open_url", { id: it.id, urlIndex: 0 }).catch(error)}>
              Open site
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={<EyeOff className="size-3.5" />} onClick={() => exclude(it.id, true)} title="Exclude from health">
            Exclude
          </Button>
        </div>
      </li>
    );
  };

  const groups = new Map<string, HealthFinding[]>();
  if (active === "reused") for (const f of list) groups.set(f.groupId ?? f.itemId, [...(groups.get(f.groupId ?? f.itemId) ?? []), f]);

  // Five tabs fit on one line at the 900 px window minimum with the larger type.
  const tabs: TabDef<Tab>[] = [
    ...TAB_ORDER.map((c) => ({ id: c, label: c === "other" ? "Other checks" : TAB_LABEL[c as HealthCheck], count: counts[c], danger: c === "breached" })),
    { id: "excluded", label: "Excluded", count: counts.excluded },
  ];

  const lastChecked = report.breachCheckedAt ? `Breached: checked ${formatDate(report.breachCheckedAt)}` : "Breached: not checked";

  return (
    <PageShell
      title="Health"
      wide
      actions={
        <>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <LockKeyhole aria-hidden className="size-3.5" />
            {lastChecked}
          </span>
          {report.breachCheck === "off" ? (
            <Button onClick={() => go({ view: "settings", settingsTab: "security" })}>Turn on breach checks</Button>
          ) : (
            <Button icon={<RefreshCw className={cx("size-4", checking && "animate-spin")} />} disabled={checking} onClick={checkNow}>
              {checking ? "Checking..." : "Check now"}
            </Button>
          )}
        </>
      }
    >
      {report.score === null ? (
        <p className="-mt-2 text-base text-muted-foreground">Add 5 or more logins to see a score.</p>
      ) : (
        <div className="-mt-2 flex flex-col gap-2">
          <p className="text-2xl font-semibold tabular-nums" aria-label={`Score ${report.score} out of 100`}>
            {report.score}
            <span className="text-md font-normal text-muted-foreground"> / 100</span>
          </p>
          <div
            role="meter"
            aria-label="Health score"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={report.score}
            className="h-1.5 w-[240px] overflow-hidden rounded-full bg-secondary"
          >
            <div className={cx("h-full rounded-full", meterTone(report.score))} style={{ width: `${report.score}%` }} />
          </div>
          <p className="text-xs text-muted-foreground">{report.formula}. The score is the share of those passwords, out of 100.</p>
        </div>
      )}

      {noCounted && report.score !== null && (
        <Notice icon={<ShieldCheck />} role="status">
          No weak, reused or breached passwords found.
        </Notice>
      )}

      <div>
        <Tabs label="Findings" tabs={tabs} value={active} onChange={setTab} />
        <div role="tabpanel" aria-label={tabs.find((t) => t.id === active)?.label} className="pt-4">
          {active === "other" && counts.other > 0 && (
            <div role="group" aria-label="Show" className="mb-3 flex flex-wrap gap-1.5">
              {[null, ...MINOR.filter((c) => report.counts[c] > 0)].map((c) => (
                <button
                  key={c ?? "all"}
                  type="button"
                  aria-pressed={sub === c}
                  onClick={() => setSub(c)}
                  className={cx(
                    "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-sm border px-2.5 text-xs",
                    sub === c ? "border-foreground bg-foreground font-semibold text-background" : "border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  {c ? TAB_LABEL[c] : "All"}
                  <span className="tabular-nums">{c ? report.counts[c] : counts.other}</span>
                </button>
              ))}
            </div>
          )}
          {active === "breached" && report.breachCheck !== "off" && (
            <p className="mb-3 max-w-[90ch] text-xs text-muted-foreground">
              A breach check sends the first 5 characters of each password's SHA-1 hash to Have I Been Pwned, never the password, and compares the rest on this PC.
            </p>
          )}
          {active === "excluded" ? (
            excluded === null ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner /> Loading...
              </div>
            ) : excluded.length === 0 ? (
              <p className="text-sm text-muted-foreground">No items are left out of health checks.</p>
            ) : (
              <ul className="divide-y divide-border rounded-sm border border-border bg-card">
                {excluded.map((it) => (
                  <li key={it.id} className="flex items-center gap-3 px-4 py-2.5">
                    <Monogram title={it.title} size={28} />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{it.title}</span>
                    <Button size="sm" onClick={() => exclude(it.id, false)}>
                      Include again
                    </Button>
                  </li>
                ))}
              </ul>
            )
          ) : list.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {active === "breached" && !report.breachCheckedAt
                ? "Run a breach check to fill this tab."
                : active === "other"
                  ? sub
                    ? EMPTY_TEXT[sub]
                    : "No unsecured websites, old passwords, expiring items or duplicates."
                  : EMPTY_TEXT[active as HealthCheck]}
            </p>
            ) : active === "reused" ? (
              <div className="flex flex-col gap-4">
                {[...groups.entries()].map(([g, fs]) => (
                  <section key={g} className="flex flex-col gap-1.5">
                    <h3 className="px-1 text-xs font-medium text-muted-foreground">Used in {fs.length} items</h3>
                    <ul className="divide-y divide-border rounded-sm border border-border bg-card">{fs.map((f, i) => row(f, `${g}-${i}`))}</ul>
                  </section>
                ))}
              </div>
            ) : (
              <ul className="divide-y divide-border rounded-sm border border-border bg-card">{list.map((f, i) => row(f, `${f.itemId}-${f.check}-${i}`))}</ul>
            )}
        </div>
      </div>
    </PageShell>
  );
}
