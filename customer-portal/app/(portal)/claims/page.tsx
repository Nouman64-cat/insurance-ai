"use client";
import Link from "next/link";
import { Suspense, useCallback, useMemo, useRef, useState } from "react";
import { EmptyState, ErrorState, Icon, PageHeader, Skeleton, useToast } from "@/components/ui";
import { ClaimCard } from "@/components/ClaimParts";
import { SurrenderSection } from "@/components/SurrenderSection";
import { StatTile } from "@/components/DashboardParts";
import { SegmentTabs, useSegment } from "@/components/SegmentTabs";
import { useApi } from "@/lib/api";
import { compactMoney } from "@/lib/format";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { LiveBadge, useLive, type LiveEvent } from "@/lib/live";
import type { ClaimRow } from "@/lib/types";

// The customer's claims: the numbers first, then each claim with where it stands. Updates arrive live (Server-Sent Events), so a status
// change shows on its card, with a short notice, without a refresh.

const IN_PROGRESS = ["submitted", "in_review", "assessment"];
const CLOSED = ["closed", "settled", "declined"];
type Filter = "all" | "progress" | "docs" | "closed";

function ClaimsInner() {
  const { t } = useI18n();
  const toast = useToast();
  const [segment, setSegment, hasFamily] = useSegment();
  const { data, error, loading, reload } = useApi<{ items: ClaimRow[] }>(segment === "family" ? "claims?segment=family" : "claims");
  const [filter, setFilter] = useState<Filter>("all");
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const timers = useRef<number[]>([]);

  const onLive = useCallback((e: LiveEvent) => {
    if (e.type !== "claim") return;
    const d = e.data;
    reload();
    const name = d.claim_number ?? "";
    const status = t(`claimStatus.${d.status_key}`);
    toast(d.kind === "new" ? t("live.claim.new", { claim: name }) : d.kind === "status"
      ? (d.status_key === "documents_needed" ? t("live.claim.docs", { claim: name }) : d.status_key === "settled" ? t("live.claim.paid", { claim: name }) : t("live.claim.status", { claim: name, status }))
      : t("live.claim.update", { claim: name }), d.status_key === "declined" ? "error" : d.status_key === "documents_needed" ? "info" : "success");
    setFlash((s) => new Set(s).add(d.id));
    timers.current.push(window.setTimeout(() => setFlash((s) => { const n = new Set(s); n.delete(d.id); return n; }), 6000));
  }, [reload, t, toast]);
  const live = useLive(onLive);

  const items = data?.items ?? [];
  const stats = useMemo(() => ({
    total: items.length,
    progress: items.filter((c) => IN_PROGRESS.includes(c.status_key)).length,
    docs: items.filter((c) => c.status_key === "documents_needed").length,
    closed: items.filter((c) => CLOSED.includes(c.status_key)).length,
    approved: items.reduce((n, c) => n + (c.approved_amount ?? 0), 0),
  }), [items]);
  const shown = items.filter((c) => filter === "all" || (filter === "progress" ? IN_PROGRESS.includes(c.status_key) : filter === "docs" ? c.status_key === "documents_needed" : CLOSED.includes(c.status_key)));
  const wait = loading && !data;
  const chips: { k: Filter; label: string; n: number }[] = [
    { k: "all", label: t("claims.filter.all"), n: stats.total }, { k: "progress", label: t("claims.filter.progress"), n: stats.progress },
    { k: "docs", label: t("claims.filter.docs"), n: stats.docs }, { k: "closed", label: t("claims.filter.closed"), n: stats.closed },
  ];

  return (
    <div className="space-y-5">
      <PageHeader title={<span className="flex items-center gap-3">{t("claims.title")}<LiveBadge connected={live} label={t("live.on")} offLabel={t("live.off")} /></span>} subtitle={t("claims.subtitle")}
        actions={<Link href="/claims/new" className="btn-primary shadow-md shadow-blue-200">+ {t("claims.new")}</Link>} />
      {hasFamily && <SegmentTabs segment={segment} onChange={setSegment} />}

      <section aria-label={t("claims.summary")} className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile label={t("claims.stat.total")} value={stats.total} icon="claims" tone={stats.total ? "blue" : "muted"} loading={wait} unavailable={!!error && !data} />
        <StatTile label={t("claims.stat.progress")} value={stats.progress} icon="calendar" tone={stats.progress ? "blue" : "muted"} loading={wait} unavailable={!!error && !data} />
        <StatTile label={t("claims.stat.docs")} value={stats.docs} icon="alert" tone={stats.docs ? "amber" : "muted"} loading={wait} unavailable={!!error && !data} note={stats.docs ? t("claims.stat.docsNote") : undefined} />
        <StatTile label={t("claims.stat.closed")} value={stats.closed} icon="check" tone={stats.closed ? "emerald" : "muted"} loading={wait} unavailable={!!error && !data} />
        <div className="col-span-2 lg:col-span-1"><StatTile label={t("claims.stat.approved")} value={stats.approved > 0 ? compactMoney(stats.approved) : "—"} icon="money" tone={stats.approved ? "emerald" : "muted"} loading={wait} unavailable={!!error && !data} /></div>
      </section>

      <aside className="flex items-start gap-3 rounded-2xl border border-blue-100 bg-gradient-to-r from-blue-50 to-white p-4" aria-label={t("claims.death.title")}>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-100 text-blue-700" aria-hidden="true"><Icon name="shield" className="h-[18px] w-[18px]" /></span>
        <div className="min-w-0"><p className="text-sm font-bold text-slate-900">{t("claims.death.title")}</p><p className="mt-0.5 text-sm text-slate-600">{t(hasFamily && segment === "family" ? "claims.death.familyText" : "claims.death.text")}</p></div>
      </aside>

      {segment === "individual" || !hasFamily ? <SurrenderSection /> : null}

      {error && !data ? <div className="card"><ErrorState error={error} onRetry={reload} /></div>
        : wait ? <div className="space-y-4"><Skeleton className="h-52" /><Skeleton className="h-52" /></div>
        : items.length === 0 ? <div className="card"><EmptyState title={t("claims.none")} text={t("claims.noneText")} action={<Link href="/claims/new" className="btn-primary">{t("claims.new")}</Link>} /></div>
        : (
          <>
            <div role="tablist" aria-label={t("claims.filter.label")} className="flex gap-2 overflow-x-auto pb-1">
              {chips.map((c) => (
                <button key={c.k} role="tab" aria-selected={filter === c.k} type="button" onClick={() => setFilter(c.k)}
                  className={`inline-flex shrink-0 items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs font-semibold transition-colors ${filter === c.k ? "border-blue-600 bg-blue-600 text-white shadow-sm" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50"}`}>
                  {c.label}<span className={`rounded-full px-1.5 text-[10px] tabular-nums ${filter === c.k ? "bg-white/20" : "bg-slate-100 text-slate-500"}`}>{c.n}</span>
                </button>))}
            </div>
            {shown.length === 0 ? <div className="card"><EmptyState title={t("claims.filter.none")} text={t("claims.filter.noneText")} /></div>
              : <div className="space-y-4">{shown.map((c) => <ClaimCard key={c.id} c={c} flash={flash.has(c.id)} />)}</div>}
          </>
        )}
    </div>
  );
}

export default function ClaimsPage() { return <Suspense><ClaimsInner /></Suspense>; }
