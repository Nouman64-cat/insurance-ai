"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Card, EmptyState, ErrorState, PageHeader, Skeleton } from "@/components/ui";
import { useApi } from "@/lib/api";
import { useI18n } from "@/lib/i18n/I18nProvider";
import type { WalkInPlan } from "@/lib/types";

const TABS = ["All", "Individual", "Family", "Corporate"] as const;

export default function PlansPage() {
  const { t } = useI18n();
  const plans = useApi<{ plans: WalkInPlan[] }>("walk-in/plans");
  const [tab, setTab] = useState<(typeof TABS)[number]>("All");
  const [q, setQ] = useState("");
  const list = useMemo(() => (plans.data?.plans || []).filter((p) => (tab === "All" || p.category === tab) && (!q.trim() || `${p.label} ${p.description}`.toLowerCase().includes(q.trim().toLowerCase()))), [plans.data, tab, q]);

  return (
    <>
      <PageHeader title={t("walkin.plans.title")} subtitle={t("walkin.plans.subtitle")} />
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div role="tablist" className="flex rounded-lg border border-slate-200 bg-white p-0.5">
          {TABS.map((k) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md ${tab === k ? "bg-blue-600 text-white" : "text-slate-500 hover:text-slate-900"}`}>{k === "All" ? t("common.all") : t(`walkin.category.${k}`)}</button>
          ))}
        </div>
        <input className="input max-w-xs" placeholder={t("walkin.plans.search")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("walkin.plans.search")} />
      </div>
      {plans.loading ? <div className="grid sm:grid-cols-2 gap-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-40 w-full" />)}</div>
        : plans.error ? <ErrorState error={plans.error} onRetry={plans.reload} />
        : list.length === 0 ? <EmptyState title={t("walkin.plans.none")} text={t("walkin.plans.noneText")} />
        : (
          <div className="grid sm:grid-cols-2 gap-4">
            {list.map((p) => (
              <Card key={p.id}>
                <div className="flex flex-col h-full gap-3">
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="text-sm font-bold text-slate-900">{p.label}</h3>
                    <span className="text-[10px] font-bold uppercase tracking-wide text-blue-700 bg-blue-50 ring-1 ring-blue-200 rounded-full px-2 py-0.5 whitespace-nowrap">{t(`walkin.category.${p.category}`)}</span>
                  </div>
                  <p className="text-xs text-slate-600 line-clamp-4 flex-1">{p.description}</p>
                  <dl className="grid grid-cols-2 gap-2 text-xs">
                    <div><dt className="text-slate-400">{t("walkin.plans.age")}</dt><dd className="font-semibold text-slate-800 ltr-num">{p.entry_age_min}–{p.entry_age_max}</dd></div>
                    <div><dt className="text-slate-400">{t("walkin.plans.term")}</dt><dd className="font-semibold text-slate-800 ltr-num">{t("walkin.plans.years", { min: p.term_min_years, max: p.term_max_years })}</dd></div>
                  </dl>
                  <Link href={`/walk-in/apply?plan=${p.id}`} className="btn-primary self-start">{t("walkin.plans.apply")}</Link>
                </div>
              </Card>
            ))}
          </div>
        )}
    </>
  );
}
