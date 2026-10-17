"use client";
import Link from "next/link";
import { EmptyState, ErrorState, Icon, PageHeader, Pill, Skeleton } from "@/components/ui";
import { MetricCard } from "@/components/MetricCard";
import { useApi } from "@/lib/api";
import { compactMoney, money } from "@/lib/format";
import { useI18n } from "@/lib/i18n/I18nProvider";
import type { FamilyGroupSummary } from "@/lib/types";

export default function FamilyListPage() {
  const { t } = useI18n();
  const { data, error, loading, reload } = useApi<{ items: FamilyGroupSummary[] }>("family");
  return (
    <div>
      <PageHeader title={t("family.title")} subtitle={t("family.subtitle")} />
      {error && !data ? <div className="card"><ErrorState error={error} onRetry={reload} /></div>
        : loading && !data ? <Skeleton className="h-48" />
        : (data?.items.length ?? 0) === 0 ? <div className="card"><EmptyState title={t("family.none")} text={t("family.noneText")} /></div>
        : (
          <div className="space-y-5">
            {data?.items.map((g) => (
              <Link key={g.id} href={`/family/${g.id}`} className="card block p-5 hover:shadow-md transition-shadow">
                <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
                  <div><p className="text-base font-bold text-slate-900">{g.name}</p>
                    <p className="text-xs text-slate-400 mt-0.5">{g.plan_types.map((p) => t(`plan.${p}`)).join(" · ")} · {t(`family.role.${g.role}`)}</p></div>
                  <Pill tone="blue">{t("family.open")}</Pill>
                </div>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  <MetricCard title={t("family.members")} value={g.members.listed} accent="blue" icon={<Icon name="family" />} subtitle={t("family.insuredCount", { count: g.members.insured })} />
                  <MetricCard title={t("family.coverage")} value={compactMoney(g.totals.coverage)} accent="emerald" icon={<Icon name="shield" />} subtitle={t("family.coverageNote")} />
                  <MetricCard title={t("dashboard.outstanding")} value={money(g.totals.outstanding)} accent={g.totals.outstanding > 0 ? "red" : "slate"} icon={<Icon name="money" />} subtitle={t("family.policiesInForce", { count: g.totals.policies_in_force })} />
                  <MetricCard title={t("dashboard.openClaims")} value={g.totals.open_claims} accent="slate" icon={<Icon name="claims" />} subtitle={t("dashboard.openClaimsNote")} />
                </div>
              </Link>
            ))}
          </div>
        )}
    </div>
  );
}
