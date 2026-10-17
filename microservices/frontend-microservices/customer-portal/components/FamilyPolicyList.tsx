"use client";
import Link from "next/link";
import { useApi } from "@/lib/api";
import { date, money } from "@/lib/format";
import { useFamilies } from "@/lib/family";
import { useI18n } from "@/lib/i18n/I18nProvider";
import type { Arrangement } from "@/lib/types";
import { PolicyCardItem } from "./PolicyCardItem";
import { EmptyState, ErrorState, Skeleton } from "./ui";

function Group({ id, name }: { id: string; name: string }) {
  const { t, locale } = useI18n();
  const { data, error, loading, reload } = useApi<{ arrangements: Arrangement[] }>(`family/${encodeURIComponent(id)}/policies`);
  if (error && !data) return <div className="card"><ErrorState error={error} onRetry={reload} /></div>;
  if (loading && !data) return <Skeleton className="h-44" />;
  return (
    <section className="space-y-5" aria-label={name}>
      <div className="flex items-center justify-between"><h3 className="text-sm font-bold text-slate-800">{name}</h3><Link href={`/family/${id}`} className="text-xs font-semibold text-blue-600 hover:text-blue-700">{t("family.open")} →</Link></div>
      {data?.arrangements.map((a) => (
        <div key={a.family_policy_id}>
          <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
            <p className="text-xs font-bold uppercase tracking-widest text-slate-400">{t(`plan.${a.plan_type}`)} · {t("family.since")} {date(a.effective_date, locale)}</p>
            {a.plan_type === "Floater" && a.shared_sum_insured != null && <p className="text-xs text-slate-500">{t("family.sharedPoolNote", { amount: money(a.shared_sum_insured) })}</p>}
          </div>
          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">{a.policies.map((p) => <PolicyCardItem key={p.id} p={p} />)}</div>
        </div>))}
    </section>
  );
}

/** Every family policy the customer can see (summary-level ones included, marked as such). */
export function FamilyPolicyList() {
  const { t } = useI18n();
  const { families, loading } = useFamilies();
  if (loading && families.length === 0) return <Skeleton className="h-44" />;
  if (families.length === 0) return <div className="card"><EmptyState title={t("family.none")} text={t("family.noneText")} /></div>;
  return <div className="space-y-8">{families.map((g) => <Group key={g.id} id={g.id} name={g.name} />)}</div>;
}
