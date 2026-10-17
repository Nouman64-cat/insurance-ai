"use client";
import { Suspense, useMemo, useState } from "react";
import { SegmentTabs, useSegment } from "@/components/SegmentTabs";
import { Card, EmptyState, ErrorState, PageHeader, Skeleton, tOr } from "@/components/ui";
import { DownloadButton } from "@/components/DownloadButton";
import { useApi } from "@/lib/api";
import { date } from "@/lib/format";
import { useI18n } from "@/lib/i18n/I18nProvider";
import type { DocumentItem } from "@/lib/types";

const GROUPS: Record<string, string[]> = {
  policy: ["policy_document", "welcome_kit"],
  receipts: ["receipt"],
  changes: ["endorsement", "renewal_confirmation", "reinstatement_confirmation", "exit_confirmation"],
  claims: ["claim_checklist", "claim_confirmation", "claim_document"],
};

function DocumentsInner() {
  const { t, locale } = useI18n();
  const [segment, setSegment, hasFamily] = useSegment();
  const { data, error, loading, reload } = useApi<{ items: DocumentItem[] }>(segment === "family" ? "documents?segment=family" : "documents");
  const [group, setGroup] = useState<"all" | keyof typeof GROUPS>("all");
  const [q, setQ] = useState("");

  const items = useMemo(() => (data?.items || []).filter((d) => {
    if (group !== "all" && !GROUPS[group].includes(d.kind)) return false;
    const n = q.trim().toLowerCase();
    return !n || d.title.toLowerCase().includes(n) || (d.policy_number || "").toLowerCase().includes(n);
  }), [data, group, q]);

  return (
    <div>
      <PageHeader title={t("documents.title")} subtitle={t("documents.subtitle")} />
      {hasFamily && <SegmentTabs segment={segment} onChange={setSegment} />}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div role="group" aria-label={t("documents.filter")} className="flex flex-wrap gap-1.5">
          {(["all", ...Object.keys(GROUPS)] as const).map((g) => (
            <button key={g} type="button" aria-pressed={group === g} onClick={() => setGroup(g as typeof group)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${group === g ? "bg-blue-600 border-blue-600 text-white" : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"}`}>{t(`documents.group.${g}`)}</button>))}
        </div>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("documents.search")} aria-label={t("documents.search")} className="input max-w-xs" />
      </div>
      {error && !data ? <div className="card"><ErrorState error={error} onRetry={reload} /></div>
        : loading && !data ? <Skeleton className="h-48" />
        : (data?.items.length ?? 0) === 0 ? <div className="card"><EmptyState title={t("documents.none")} text={t("documents.noneText")} /></div>
        : items.length === 0 ? <div className="card"><EmptyState title={t("documents.noMatch")} /></div>
        : (
          <Card className="!p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px]"><thead><tr><th className="th">{t("documents.name")}</th><th className="th">{t("documents.type")}</th><th className="th">{t("pay.policy")}</th><th className="th">{t("documents.date")}</th><th className="th" /></tr></thead>
                <tbody>{items.map((d) => (
                  <tr key={d.id}><td className="td font-semibold text-slate-800">{d.title}</td><td className="td">{tOr(t, `documents.kind.${d.kind}`, d.kind)}</td><td className="td ltr-num">{d.policy_number}</td><td className="td">{date(d.date, locale)}</td>
                    <td className="td text-end"><DownloadButton handle={d.id} fallbackName={`${d.title}.pdf`} available={d.available} /></td></tr>))}</tbody></table>
            </div>
          </Card>
        )}
    </div>
  );
}

export default function DocumentsPage() { return <Suspense><DocumentsInner /></Suspense>; }
