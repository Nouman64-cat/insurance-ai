"use client";
import { useMemo, useState } from "react";
import { EmptyState, ErrorState, PageHeader, Skeleton } from "@/components/ui";
import { PolicyCardItem } from "@/components/PolicyCardItem";
import { useApi } from "@/lib/api";
import { useI18n } from "@/lib/i18n/I18nProvider";
import type { PolicyCard } from "@/lib/types";

const FILTERS = ["all", "active", "attention", "closed"] as const;
const ATTENTION = ["grace_period", "lapsed", "pending_issuance", "issued"];
const CLOSED = ["cancelled", "expired", "matured", "surrendered"];

export default function PoliciesPage() {
  const { t } = useI18n();
  const { data, error, loading, reload } = useApi<{ items: PolicyCard[] }>("policies");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const [q, setQ] = useState("");

  const items = useMemo(() => (data?.items || []).filter((p) => {
    if (filter === "active" && !["active", "reinstated"].includes(p.status_key)) return false;
    if (filter === "attention" && !ATTENTION.includes(p.status_key)) return false;
    if (filter === "closed" && !CLOSED.includes(p.status_key)) return false;
    const needle = q.trim().toLowerCase();
    return !needle || (p.policy_number || "").toLowerCase().includes(needle) || p.product_name.toLowerCase().includes(needle);
  }), [data, filter, q]);

  return (
    <div>
      <PageHeader title={t("policies.title")} subtitle={t("policies.subtitle")} />
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div role="group" aria-label={t("policies.filter")} className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${filter === f ? "bg-blue-600 border-blue-600 text-white" : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"}`}>{t(`policies.filter.${f}`)}</button>
          ))}
        </div>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("policies.search")} aria-label={t("policies.search")} className="input max-w-xs" />
      </div>
      {error && !data ? <div className="card"><ErrorState error={error} onRetry={reload} /></div>
        : loading && !data ? <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4"><Skeleton className="h-44" /><Skeleton className="h-44" /><Skeleton className="h-44" /></div>
        : (data?.items.length ?? 0) === 0 ? <div className="card"><EmptyState title={t("policies.none")} text={t("policies.noneText")} /></div>
        : items.length === 0 ? <div className="card"><EmptyState title={t("policies.noMatch")} /></div>
        : <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">{items.map((p) => <PolicyCardItem key={p.id} p={p} />)}</div>}
    </div>
  );
}
